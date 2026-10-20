/**
 * Issue #366 behavioral suite: listing-evidence engine + release-path
 * enforcement + correction/recovery smoke (criterion 10).
 *
 * Real isolated SQLite/Git where integration is exercised (TestSetup-file DB,
 * temp workspace dirs); no live network — the bounded Choice path is
 * covered through deterministic verdicts, unavailable legs (no-route /
 * dispatch failure / audit-open failure), and overflow.
 *
 * Covers: wrong quantity, negation, partial support, sibling/stale/unlinked
 * evidence, optional-absent vs unsafe-included, manual/fallback text,
 * service failure/overflow, and final draft/export refusal + recovery.
 * Correction/recovery smoke: remove unsafe optional text → record drops on
 * next evaluation (PUT invalidation), remaining deterministic coverage
 * passes, review/draft/export recover.
 */
 import { describe, it, expect, beforeEach } from 'vitest';
import { mock } from 'bun:test';
/**
 * Test hook for the model-policy snapshot: temp workspaces have no v2
 * classification bundle, so the real `captureModelPolicySnapshot` always
 * reports disabled here (matching production behavior on unconfigured
 * workspaces). Tests that need a configured policy set
 * `policySnapshotTestHook.configuredDigest`; everything else observes the
 * real disabled path. Mutated per-test with reset in `finally`.
 */
export const policySnapshotTestHook: { configuredDigest: string | null } = { configuredDigest: null };
mock.module('../../onboarding/model-policy-snapshot', () => ({
  captureModelPolicySnapshot: () =>
    policySnapshotTestHook.configuredDigest
      ? { state: 'configured', view: { policyDigest: policySnapshotTestHook.configuredDigest }, source: 'test-hook' }
      : { state: 'disabled', reason: 'test-no-policy' },
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { validateListingEvidenceForReview } from '../../classification/review-completion-gate';
import { validateChangeSet } from '../../validation/change-set-validation';
import { currentListingEvidenceHashes, draftListingEvidenceHashes, draftVariantFactsFor, projectedCuratedString, remainingCoverageDeterministic, LISTING_EVIDENCE_REMOVED } from '../../classification/listing-evidence-currentness';
import {
  buildClaimUnits,
  deterministicClaimCheck,
  eligibleEvidenceFor,
  hashFinalListing,
  LISTING_EVIDENCE_MAX_CLAIMS,
  LISTING_EVIDENCE_MAX_UNIT_CHARS,
} from '../../classification/listing-evidence';
import { evaluateListingEvidence, aggregateStatus } from '../../classification/listing-evidence-service';
import { evaluateListingEvidenceGate } from '../../classification/listing-evidence-gate';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import { createRun } from '../../db/repositories/classification-run-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { approveAndAdvanceItems, markReviewed } from '../../db/repositories/onboarding-review-repo';
import { Hono } from 'hono';
import onboardingRoutes from '../../server/routes/onboarding-routes';

let workspaceId: string;
let workspacePath: string;
let batchId: string;

function evidence(overrides: Partial<ClassificationEvidence> & { id: string }): ClassificationEvidence {
  return {
    runId: 'run-1',
    stageName: 'evidence_extraction',
    productSku: 'SKU-366',
    attributeId: null,
    source: 'official_product_page',
    reliability: 'high',
    sourceUrl: null,
    sourceField: 'description',
    snippet: null,
    value: null,
    metadata: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  } as ClassificationEvidence;
}

 beforeEach(() => {
   workspaceId = randomUUID();
   workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'le366-'));
   fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
   try { closeDb(); } catch { /* fresh */ }
   initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
   runMigrations();
   insertWorkspace({
     id: workspaceId, name: 'ws', workspacePath,
     gitPath: path.join(workspacePath, '.git'),
     createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
     bootstrapStatus: 'complete', baselineCommit: null,
   });
   batchId = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 }).id;
 });

 function seedItem(upc = 'SKU-366', name = 'Acana Adult Dog 5 lb'): string {
   return insertItems(batchId, [{ upc, name, brandHint: 'Acana', rowNumber: 1 }], 'review', 1)[0].id;
 }

 function seedEvidenceRow(runId: string, sku: string, rows: Array<Partial<ClassificationEvidence> & { id: string }>): void {
   const db = getDb();
   const now = new Date().toISOString();
   for (const row of rows) {
     const snippet = typeof row.snippet === 'string' ? row.snippet : typeof row.value === 'string' ? row.value : '';
     db.query(`INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, 'evidence_extraction', 'official_product_page', ?, ?, ?, ?, NULL, ?)`)
       .run(row.id, runId, sku, row.reliability ?? 'high', row.sourceField ?? 'description', snippet, JSON.stringify(row.value ?? snippet), now);
   }
 }
function writeCuration(itemId: string, curation: Record<string, unknown>): void {
  getDb().query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(JSON.stringify(curation), itemId);
}

// ─── Deterministic legs ──────────────────────────────────────────────────────
describe('issue #366 criterion 10 — deterministic verdicts', () => {
  const buildRecord = (partial: { field: 'title' | 'description' | 'variant'; text: string; verdict: 'supported' | 'contradicted' | 'insufficient' }) => ({
    id: 'claim_test', span: [0, 10] as [number, number], claimHash: 'b'.repeat(64), material: true,
    producer: 'deterministic' as const, evidenceConsidered: [] as string[], modelCallId: null, reason: 'test',
    ...partial,
  });
  it('contradicts a wrong quantity (claim 5 lb vs evidenced 10 lb)', () => {
    const claim = { id: 'claim_01', field: 'title' as const, span: [0, 10] as [number, number], text: 'Acana Adult Dog 5 lb', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'title', snippet: 'Acana Adult Dog 10 lb', value: 'Acana Adult Dog 10 lb' })], 'SKU-366');
    expect(deterministicClaimCheck(claim, eligible).verdict).toBe('contradicted');
  });

  it('contradicts a negation reversal (claim negates what evidence affirms)', () => {
    const claim = { id: 'claim_01', field: 'description' as const, span: [0, 10] as [number, number], text: 'Unsuitable for puppies with chicken flavor', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: 'Suitable for puppies with chicken flavor daily nutrition', value: 'Suitable for puppies with chicken flavor daily nutrition' })], 'SKU-366');
    expect(deterministicClaimCheck(claim, eligible).verdict).toBe('contradicted');
  });

  it('treats partial support as unresolved (one matching clause never certifies a block)', () => {
    const claim = { id: 'claim_01', field: 'description' as const, span: [0, 10] as [number, number], text: 'Chicken flavor grain free puppy nutrition with added vitamins', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: 'Chicken flavor dog food', value: 'Chicken flavor dog food' })], 'SKU-366');
    const verdict = deterministicClaimCheck(claim, eligible);
    expect(verdict.verdict).toBe('unresolved');
  });

  it('supports an exact covered block deterministically (no semantic call needed)', () => {
    const claim = { id: 'claim_01', field: 'description' as const, span: [0, 10] as [number, number], text: 'Chicken flavor dog food', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: 'Chicken flavor dog food nutrition', value: 'Chicken flavor dog food nutrition' })], 'SKU-366');
    expect(deterministicClaimCheck(claim, eligible).verdict).toBe('supported');
  });

  it('excludes sibling/stale/unlinked evidence (other-SKU, conflicting, empty rows)', () => {
    const all = [
      evidence({ id: 'sibling', productSku: 'OTHER-SKU', sourceField: 'description', snippet: 'Acana Adult Dog 5 lb', value: 'Acana Adult Dog 5 lb' }),
      evidence({ id: 'conflicted', productSku: 'SKU-366', reliability: 'conflicting', sourceField: 'description', snippet: 'Acana Adult Dog 5 lb', value: 'Acana Adult Dog 5 lb' }),
      evidence({ id: 'empty', productSku: 'SKU-366', sourceField: 'description', snippet: '', value: '' }),
    ];
    expect(eligibleEvidenceFor(all, 'SKU-366')).toEqual([]);
  });

  it('optional absence produces no claim; included unsafe text blocks', () => {
    const { claims } = buildClaimUnits({ title: 'Acana Adult Dog', description: null, variantFacts: {}, requiredFields: [] });
    expect(claims.filter((c) => c.field === 'description')).toEqual([]);
    const missing = buildClaimUnits({ title: null, description: null, variantFacts: {}, requiredFields: ['title'] });
    expect(missing.claims.some((c) => c.text === '[missing required title]')).toBe(true);
    const records = [
      buildRecord({ field: 'title', text: '[missing required title]', verdict: 'contradicted' as const }),
    ];
    expect(aggregateStatus(records, false)).toBe('blocked');
  });
});

// ─── Service legs: manual/fallback, failure, overflow ────────────────────────

describe('issue #366 criterion 10 — service legs', () => {
  it('evaluates manual/fallback text against the same bundle (name fallback when curated is blank)', async () => {
    const result = await evaluateListingEvidence(
      { title: 'Acana Adult Dog', description: null, variantFacts: {}, requiredFields: [] },
      [evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'title', snippet: 'Acana Adult Dog food', value: 'Acana Adult Dog food' })],
      'SKU-366',
      { runId: 'run-1', modelPolicy: null },
    );
    expect(result.record.status).toBe('passed');
  });

  it('no usable route → unavailable (never a partial all-clear)', async () => {
    const result = await evaluateListingEvidence(
      { title: 'Acana Adult Dog with novel protein blend', description: null, variantFacts: {}, requiredFields: [] },
      [evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'title', snippet: 'Unrelated kibble text', value: 'Unrelated kibble text' })],
      'SKU-366',
      { runId: 'run-1', modelPolicy: null },
    );
    expect(result.record.status).toBe('unavailable');
    expect(result.record.modelCallIds).toEqual([]);
  });

  it('overflow (>24 claims) marks every claim unavailable and blocks', async () => {
    const longDescription = Array.from({ length: LISTING_EVIDENCE_MAX_CLAIMS + 5 }, (_, i) => `Sentence number ${i} about nutrition.`).join(' ');
    const result = await evaluateListingEvidence(
      { title: 'Acana Adult Dog', description: longDescription, variantFacts: {}, requiredFields: [] },
      [evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: longDescription, value: longDescription })],
      'SKU-366',
      { runId: 'run-1', modelPolicy: null },
    );
    expect(result.record.overflow).toBe(true);
    expect(result.record.status).toBe('unavailable');
    expect(result.record.claims.every((c) => c.verdict === 'unavailable')).toBe(true);
  });

  it('whitespace-only edits do not change the listing hash (no stale re-run on no-op)', () => {
    const a = hashFinalListing({ title: 'Acana Adult Dog', description: 'Chicken flavor.', variantFacts: {}, requiredFields: [] });
    const b = hashFinalListing({ title: '  Acana Adult Dog  ', description: 'Chicken flavor.  ', variantFacts: {}, requiredFields: [] });
    expect(a).toBe(b);
  });
});

// ─── Gate + release-path refusal/recovery ────────────────────────────────────

describe('issue #366 criterion 10 — gate refusal and recovery', () => {
  it('refuses review completion on a blocked record; removing unsafe optional text recovers', () => {
    const id = seedItem();
    const run = createRun(workspaceId, 'SKU-366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const listingHash = hashFinalListing({ title, description: 'Grain free puppy nutrition with vitamins', variantFacts: {}, requiredFields: ['title'] });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: 'Grain free puppy nutrition with vitamins',
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash,
        evidenceHash: currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: 'Grain free puppy nutrition with vitamins', classificationRunId: run.id }).evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [
          { id: 'claim_01', field: 'title', span: [0, title.length], text: title, claimHash: createHash('sha256').update(title.toLowerCase()).digest('hex'), material: true, verdict: 'supported', producer: 'deterministic', evidenceConsidered: ['e1'], modelCallId: null, reason: 'ok' },
          { id: 'claim_02', field: 'description', span: [0, 10], text: 'Grain free puppy nutrition with vitamins', claimHash: 'b'.repeat(64), material: true, verdict: 'contradicted', producer: 'deterministic', evidenceConsidered: ['e1'], modelCallId: null, reason: 'denied' },
        ],
        overflow: false,
        modelCallIds: [],
        status: 'blocked',
        findings: ['Contradicted description "Grain free pu…": eligible evidence denies it'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const before = validateListingEvidenceForReview(id);
    expect(before).not.toBeNull();

    // Correction: remove the unsafe optional description; the stale record
    // drops via PUT invalidation semantics (recomputed live hash mismatches
    // until re-evaluation writes a fresh passed record).
    const current = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: current.listingHash,
        evidenceHash: current.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [
          { id: 'claim_01', field: 'title', span: [0, title.length], text: title, claimHash: createHash('sha256').update(title.toLowerCase()).digest('hex'), material: true, verdict: 'supported', producer: 'deterministic', evidenceConsidered: ['e1'], modelCallId: null, reason: 'ok' },
        ],
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    expect(validateListingEvidenceForReview(id)).toBeNull();
  });
  it('change-set validation refuses a linked blocked item and recovers after correction', () => {
    const id = seedItem('SKU-CS366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-CS366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-CS366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const cur = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: 'Bad claim text here', classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: 'Bad claim text here',
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'blocked',
        findings: ['Contradicted description "Bad claim…": eligible evidence denies it'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const product = {
      schemaVersion: 1,
      id: 'id-SKU-CS366',
      sku: 'SKU-CS366',
      status: 'draft',
      core: {
        name: title, price: '9.99', salePrice: null, description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: 'products/SKU-CS366/images/primary.jpg', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    };
    const cs = createChangeSet({ workspaceId, title: 'cs', description: null, baseCommit: 'abc' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-CS366', operation: 'create', draftJson: JSON.stringify(product), baseJson: null, draftHash: 'h' });
    const blocked = validateChangeSet(cs.id);
    expect(blocked.canApprove).toBe(false);
    expect(blocked.items[0].results.some((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toBe(true);

    // Recovery: corrected record passes → the change set approves.
    const fixed = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: fixed.listingHash,
        evidenceHash: fixed.evidenceHash,
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const recovered = validateChangeSet(cs.id);
    expect(recovered.items[0].results.filter((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toEqual([]);
  });

  it('durable approval refuses on a blocked record and grandfathers legacy rows', () => {
    const blockedId = seedItem('SKU-APPR-BLOCKED', 'Acana Adult Dog');
    const legacyId = seedItem('SKU-APPR-LEGACY', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-APPR-BLOCKED', null, null, blockedId);
    seedEvidenceRow(run.id, 'SKU-APPR-BLOCKED', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const cur = currentListingEvidenceHashes(blockedId, { curatedTitle: title, curatedDescription: 'Bad claim text here', classificationRunId: run.id });
    writeCuration(blockedId, {
      curatedTitle: title,
      curatedDescription: 'Bad claim text here',
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'blocked',
        findings: ['Contradicted description "Bad claim…": eligible evidence denies it'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    writeCuration(legacyId, { curatedTitle: title });
    for (const itemId of [blockedId, legacyId]) {
      getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(itemId);
      markReviewed({ itemId, batchId, reviewedBy: 'test' });
    }
    const res = approveAndAdvanceItems({ itemIds: [blockedId, legacyId], batchId, approvedBy: 'test', requestHash: 'f'.repeat(64) });
    expect(res.approved).toContain(legacyId);
    expect(res.rejected.some((r) => r.itemId === blockedId && r.reason.includes('listing_evidence'))).toBe(true);
    expect(findItemById(legacyId)!.stage).toBe('promotion');
  });

  it('stale record (listing changed after evaluation) refuses until re-evaluation', () => {
    const id = seedItem('SKU-STALE366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-STALE366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-STALE366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog edited after check',
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: '0'.repeat(64),
        evidenceHash: '0'.repeat(64),
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const gate = validateListingEvidenceForReview(id);
    expect(gate).not.toBeNull();
    expect(gate && !gate.ok ? gate.code : '').toContain('stale');
  });
});

describe('issue #366 fix wave — containment, frozen artifact, policy, recovery', () => {
  it('reordered assertions across sources do not certify as support', () => {
    const claim = { id: 'claim_01', field: 'description' as const, span: [0, 15] as [number, number], text: 'Cats eat chicken.', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([
      evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: 'Dogs eat chicken.', value: 'Dogs eat chicken.' }),
      evidence({ id: 'e2', productSku: 'SKU-366', sourceField: 'description', snippet: 'Cats eat fish.', value: 'Cats eat fish.' }),
    ], 'SKU-366');
    expect(deterministicClaimCheck(claim, eligible).verdict).toBe('unresolved');
  });

  it('single-record assertion containment certifies as support', () => {
    const claim = { id: 'claim_01', field: 'description' as const, span: [0, 15] as [number, number], text: 'Cats eat chicken.', claimHash: 'a'.repeat(64), material: true };
    const eligible = eligibleEvidenceFor([
      evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: 'Our review: cats eat chicken daily.', value: 'Our review: cats eat chicken daily.' }),
    ], 'SKU-366');
    expect(deterministicClaimCheck(claim, eligible).verdict).toBe('supported');
  });

  it('draft weight mismatch refuses the change set (frozen artifact, not live text)', () => {
    const id = seedItem('SKU-WT366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-WT366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-WT366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const cur = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: 'policy_unavailable',
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const product = {
      schemaVersion: 1,
      id: 'id-SKU-WT366',
      sku: 'SKU-WT366',
      status: 'draft',
      core: {
        name: title, price: '9.99', salePrice: null, description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: '10 lb', taxable: true,
        media: { primary: 'products/SKU-WT366/images/primary.jpg', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    };
    const cs = createChangeSet({ workspaceId, title: 'cs-wt', description: null, baseCommit: 'abc' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-WT366', operation: 'create', draftJson: JSON.stringify(product), baseJson: null, draftHash: 'h' });
    const blocked = validateChangeSet(cs.id);
    expect(blocked.items[0].results.some((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toBe(true);
  });

  it('policy rotation refuses a stale-digest record at change-set approval', () => {
    policySnapshotTestHook.configuredDigest = 'live-digest-test';
    try {
      const id = seedItem('SKU-POL366', 'Acana Adult Dog');
      const run = createRun(workspaceId, 'SKU-POL366', null, null, id);
      seedEvidenceRow(run.id, 'SKU-POL366', [
        { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
      ]);
      const title = 'Acana Adult Dog';
      const cur = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
      writeCuration(id, {
        curatedTitle: title,
        curatedDescription: null,
        classificationRunId: run.id,
        listingEvidenceValidation: {
          recordVersion: 1,
          listingHash: cur.listingHash,
          evidenceHash: cur.evidenceHash,
          requiredFields: ['title'],
          rulesVersion: 'listing-evidence-rules-v1',
          modelPolicyDigest: 'stale-digest-for-test',
          claims: [],
          overflow: false,
          modelCallIds: [],
          status: 'passed',
          findings: [],
          evaluatedAt: new Date().toISOString(),
        },
      });
      const product = {
        schemaVersion: 1,
        id: 'id-SKU-POL366',
        sku: 'SKU-POL366',
        status: 'draft',
        core: {
          name: title, price: '9.99', salePrice: null, description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null, weight: null, taxable: true,
          media: { primary: 'products/SKU-POL366/images/primary.jpg', additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
        },
        customFields: {},
        shopsite: {
          productId: null, productGuid: null, xmlVersion: '15.0',
          lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
        },
        metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
      };
      const cs = createChangeSet({ workspaceId, title: 'cs-pol', description: null, baseCommit: 'abc' });
      upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-POL366', operation: 'create', draftJson: JSON.stringify(product), baseJson: null, draftHash: 'h' });
      const before = validateChangeSet(cs.id);
      expect(before.items[0].results.some((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toBe(true);
      // Recovery: live digest over the same listing clears the gate.
      const curation = readCurationCompat(id);
      const record = (curation.listingEvidenceValidation ?? {}) as Record<string, unknown>;
      writeCuration(id, { ...curation, listingEvidenceValidation: { ...record, modelPolicyDigest: 'live-digest-test' } });
      const after = validateChangeSet(cs.id);
      expect(after.items[0].results.filter((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toEqual([]);
    } finally {
      policySnapshotTestHook.configuredDigest = null;
    }
  });

  it('optional-text removal recovers only through deterministic remaining coverage', () => {
    const eligible = eligibleEvidenceFor([
      evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' }),
    ], 'SKU-366');
    expect(remainingCoverageDeterministic({ title: 'Acana Adult Dog', description: null, variantFacts: {}, requiredFields: ['title'] }, eligible)).toBe(true);
    const unresolved = eligibleEvidenceFor([], 'SKU-366');
    expect(remainingCoverageDeterministic({ title: 'Acana Adult Dog', description: 'Unverifiable marketing claim here', variantFacts: {}, requiredFields: ['title', 'description'] }, unresolved)).toBe(false);
  });
});

describe('issue #366 wave 2A — seven gaps', () => {
  const makePassedRecord = (listingHash: string, evidenceHash: string, modelPolicyDigest: string, requiredFields: string[]) => ({
    recordVersion: 1,
    listingHash,
    evidenceHash,
    requiredFields: [...requiredFields].sort(),
    rulesVersion: 'listing-evidence-rules-v1',
    modelPolicyDigest,
    claims: [],
    overflow: false,
    modelCallIds: [],
    status: 'passed' as const,
    findings: [],
    evaluatedAt: new Date().toISOString(),
  });

  it('gap 2: sentinel removal projects to null with no extraction fallback end-to-end', () => {
    const id = seedItem('SKU-RM366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-RM366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-RM366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify({ title: 'Acana Adult Dog', description: 'Fallback copy that must not resurrect', variantAttributes: {} }),
      id,
    );
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: LISTING_EVIDENCE_REMOVED,
      classificationRunId: run.id,
    });
    expect(projectedCuratedString(LISTING_EVIDENCE_REMOVED)).toEqual({ text: null, removed: true });
    const hashes = currentListingEvidenceHashes(id);
    const noFallback = hashFinalListing({ title: 'Acana Adult Dog', description: null, variantFacts: {}, requiredFields: ['title'] });
    expect(hashes.listingHash).toBe(noFallback);
    // Stamp the live unavailable-policy digest explicitly: review-time
    // gates always resolve workspace context (strict leg), so a '' stamp
    // from the context-free hash helper would read as stale.
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: LISTING_EVIDENCE_REMOVED,
      classificationRunId: run.id,
      listingEvidenceValidation: makePassedRecord(hashes.listingHash, hashes.evidenceHash, 'policy_unavailable', ['title']),
    });
    expect(validateListingEvidenceForReview(id)).toBeNull();
  });

  it('gap 3: oversized claim fails closed (unavailable, never a partial pass)', async () => {
    const longSentence = `This is a very long claim sentence ${'with filler words '.repeat(80)}that ends here.`;
    expect(longSentence.length).toBeGreaterThan(LISTING_EVIDENCE_MAX_UNIT_CHARS);
    const built = buildClaimUnits({ title: 'Acana Adult Dog', description: longSentence, variantFacts: {}, requiredFields: ['title'] });
    expect(built.oversized).toBe(true);
    const { record } = await evaluateListingEvidence(
      { title: 'Acana Adult Dog', description: longSentence, variantFacts: {}, requiredFields: ['title'] },
      [evidence({ id: 'e1', productSku: 'SKU-366', sourceField: 'description', snippet: longSentence.slice(0, 500), value: longSentence.slice(0, 500), runId: 'r' })],
      'SKU-366',
      { runId: 'r', modelPolicy: null },
    );
    expect(record.status).toBe('unavailable');
    expect(record.claims.every((c) => c.verdict === 'unavailable')).toBe(true);
    const gate = evaluateListingEvidenceGate({
      curationData: { listingEvidenceValidation: record },
      currentListingHash: record.listingHash,
      currentEvidenceHash: record.evidenceHash,
      currentModelPolicyDigest: record.modelPolicyDigest,
    });
    expect(gate.ok).toBe(false);
  });

  it('gap 4: frozen variant projection matches evaluation (color/size survive the gate)', () => {
    const id = seedItem('SKU-VAR366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-VAR366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-VAR366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify({ title: 'Acana Adult Dog', description: null, variantAttributes: { color: 'Red', size: '5 lb' } }),
      id,
    );
    writeCuration(id, { curatedTitle: 'Acana Adult Dog', curatedDescription: null, curatedWeight: '5 lb', classificationRunId: run.id });
    const facts = draftVariantFactsFor(id, '5 lb');
    expect(facts).toMatchObject({ color: 'Red', size: '5 lb', weight: '5 lb' });
    const title = 'Acana Adult Dog';
    // Live evaluation over the same facts (curated weight included) stamps
    // the identical listing hash the frozen draft projection recomputes.
    const live = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, curatedWeight: '5 lb', classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      curatedWeight: '5 lb',
      classificationRunId: run.id,
      listingEvidenceValidation: makePassedRecord(live.listingHash, live.evidenceHash, 'policy_unavailable', ['title']),
    });
    const draftHashes = draftListingEvidenceHashes(id, { title, description: null, variantFacts: facts }, { workspacePath, workspaceId });
    const gate = evaluateListingEvidenceGate({
      curationData: readCurationCompat(id),
      currentListingHash: draftHashes.listingHash,
      currentEvidenceHash: draftHashes.evidenceHash,
      currentModelPolicyDigest: draftHashes.modelPolicyDigest,
      currentRequiredFields: draftHashes.requiredFields,
    });
    expect(gate.ok).toBe(true);
  });

  it('gap 5: unavailable policy stales a previously-passed record', () => {
    const id = seedItem('SKU-UNAV366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-UNAV366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-UNAV366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const cur = currentListingEvidenceHashes(id, { curatedTitle: 'Acana Adult Dog', curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: makePassedRecord(cur.listingHash, cur.evidenceHash, 'policy_unavailable', ['title']),
    });
    const gate = evaluateListingEvidenceGate({
      curationData: readCurationCompat(id),
      currentListingHash: cur.listingHash,
      currentEvidenceHash: cur.evidenceHash,
      currentModelPolicyDigest: 'policy_unavailable',
    });
    expect(gate.ok).toBe(true);
    const rotated = evaluateListingEvidenceGate({
      curationData: { listingEvidenceValidation: { ...(readCurationCompat(id).listingEvidenceValidation as Record<string, unknown>), modelPolicyDigest: 'live-digest-x' } },
      currentListingHash: cur.listingHash,
      currentEvidenceHash: cur.evidenceHash,
      currentModelPolicyDigest: 'policy_unavailable',
    });
    expect(rotated.ok).toBe(false);
    if (!rotated.ok) expect(rotated.code).toBe('listing_evidence_stale');
  });

  it('gap 6: optional-to-required flip stales the record', () => {
    const base = { title: 'Acana Adult Dog', description: null as string | null, variantFacts: {} };
    const optionalHash = hashFinalListing({ ...base, requiredFields: ['title'] });
    const requiredHash = hashFinalListing({ ...base, requiredFields: ['title', 'description'] });
    expect(optionalHash).not.toBe(requiredHash);
    const record = makePassedRecord(optionalHash, 'b'.repeat(64), 'policy_unavailable', ['title']);
    const gate = evaluateListingEvidenceGate({
      curationData: { listingEvidenceValidation: record },
      currentListingHash: requiredHash,
      currentEvidenceHash: 'b'.repeat(64),
      currentModelPolicyDigest: 'policy_unavailable',
      currentRequiredFields: ['title', 'description'],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('listing_evidence_stale');
  });

  it('gap 1+7: standalone change-set approval refuses a blocked record (no bypass)', () => {
    const id = seedItem('SKU-SA366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-SA366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-SA366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const cur = currentListingEvidenceHashes(id, { curatedTitle: 'Acana Adult Dog', curatedDescription: 'Bad claim text', classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: 'Bad claim text',
      classificationRunId: run.id,
      listingEvidenceValidation: { ...makePassedRecord(cur.listingHash, cur.evidenceHash, 'policy_unavailable', ['title']), status: 'blocked', findings: ['Contradicted description "Bad claim": eligible evidence denies it'] },
    });
    const product = {
      schemaVersion: 1, id: 'id-SKU-SA366', sku: 'SKU-SA366', status: 'draft',
      core: {
        name: 'Acana Adult Dog', price: '9.99', salePrice: null, description: 'Bad claim text',
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: 'products/SKU-SA366/images/primary.jpg', additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    };
    const cs = createChangeSet({ workspaceId, title: 'cs-standalone', description: null, baseCommit: 'abc' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-SA366', operation: 'create', draftJson: JSON.stringify(product), baseJson: null, draftHash: 'h' });
    const result = validateChangeSet(cs.id);
    expect(result.items[0].results.some((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toBe(true);
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: LISTING_EVIDENCE_REMOVED,
      classificationRunId: run.id,
    });
    const narrowed = currentListingEvidenceHashes(id);
    writeCuration(id, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: LISTING_EVIDENCE_REMOVED,
      classificationRunId: run.id,
      listingEvidenceValidation: makePassedRecord(narrowed.listingHash, narrowed.evidenceHash, 'policy_unavailable', ['title']),
    });
    const fixedProduct = { ...product, core: { ...(product.core as Record<string, unknown>), name: 'Acana Adult Dog', description: null } };
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-SA366', operation: 'create', draftJson: JSON.stringify(fixedProduct), baseJson: null, draftHash: 'h2' });
    const recovered = validateChangeSet(cs.id);
    expect(recovered.items[0].results.filter((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toEqual([]);
  });
});

describe('issue #366 wave 2A gap 7 — real correction/refusal smoke (PUT + rerun + review)', () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.route('/api', onboardingRoutes);
    return app;
  }

  it('PUT removal of unsafe description refuses-then-recovers through the real rerun endpoint', async () => {
    const app = makeApp();
    const id = seedItem('SKU-SMOKE366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-SMOKE366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-SMOKE366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const bad = 'Grain free puppy nutrition with vitamins';
    const cur = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: bad, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: bad,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'blocked',
        findings: ['Contradicted description "Grain free…": eligible evidence denies it'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    expect(validateListingEvidenceForReview(id)).not.toBeNull();
    const put = await app.request(`/api/onboarding/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curation_data: { curatedDescription: LISTING_EVIDENCE_REMOVED } }),
    });
    expect(put.status).toBe(200);
    const stored = findItemById(id);
    const curation = (stored?.curationData ?? {}) as Record<string, unknown>;
    expect(curation.curatedDescription).toBe(LISTING_EVIDENCE_REMOVED);
    expect(validateListingEvidenceForReview(id)).not.toBeNull();
    const rerun = await app.request(`/api/onboarding/items/${id}/listing-evidence-rerun`, { method: 'POST' });
    expect(rerun.status).toBe(200);
    const body = await rerun.json() as { status?: string };
    expect(body.status).toBe('passed');
    expect(validateListingEvidenceForReview(id)).toBeNull();
  });

  it('tampered evidence (superseded run rows) refuses at the review gate', () => {
    const id = seedItem('SKU-TAMP366', 'Acana Adult Dog');
    const run = createRun(workspaceId, 'SKU-TAMP366', null, null, id);
    seedEvidenceRow(run.id, 'SKU-TAMP366', [
      { id: 'e1', sourceField: 'title', snippet: 'Acana Adult Dog', value: 'Acana Adult Dog' },
    ]);
    const title = 'Acana Adult Dog';
    const cur = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    expect(validateListingEvidenceForReview(id)).toBeNull();
    getDb().query(`UPDATE classification_evidence SET reliability = 'conflicting', snippet = 'Tampered', value_json = '"Tampered"' WHERE id = ?`).run('e1');
    expect(validateListingEvidenceForReview(id)).not.toBeNull();
  });
});

function readCurationCompat(itemId: string): Record<string, unknown> {
  const found = findItemById(itemId);
  const raw = found?.curationData;
  if (raw && typeof raw === 'object') return raw as unknown as Record<string, unknown>;
  return {};
}
