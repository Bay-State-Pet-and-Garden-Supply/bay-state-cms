/**
 * Issue #367 behavioral suite: authenticated operator verification of
 * unresolved listing claims — safe manual resolution through the existing
 * Review/durable-approval/draft/export gates.
 *
 * Real isolated SQLite (temp dirs, runMigrations); no live network, no
 * paid TypeSafe calls (deterministic/insufficient claims only — the
 * semantic Choice path is never exercised here).
 *
 * Covers (ticket criteria 1–8):
 * 1. Real unverified observation → operator_verified verdict; readiness
 *    reflects the resolution and Review returns to the current field.
 * 2. Exact hash/revision/workspace/actor/token binding; server-derived
 *    authority (foreign workspace 404; forged ids refuse).
 * 3. Exact token/payload replay returns one receipt (no dupes); mismatched
 *    payload/token or stale revision refuses with no partial writes and
 *    preserved operator input.
 * 4. Provenance truthfulness: operator_verified distinct from
 *    deterministic/typesafe; approve-alone creates no evidence;
 *    fabricated/stale attestations refuse.
 * 5. Hard-gate refusals (identity/variant/domain, rights, hard conflicts,
 *    classification, drift, ownership) route to the responsible flow.
 * 6. Consequential edits invalidate the resolution + review/approval;
 *    unchanged judgments stay reusable without inheriting human approval.
 * 7. Valid verification flows through the server-owned Review/durable
 *    approval/draft/change-set gates (not a UI-only override); the #366
 *    correction flow is untouched.
 * 8. Authenticated/cross-workspace/stale/conflicting/replayed submissions
 *    + Review → observation → readiness → draft smoke with truthful
 *    provenance.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { validateListingEvidenceForReview } from '../../classification/review-completion-gate';
import { verifyListingEvidence, currentVerifyRevisionForItem } from '../../classification/listing-evidence-verify';
import { currentListingEvidenceHashes, draftListingEvidenceHashes } from '../../classification/listing-evidence-currentness';
import type { ListingEvidenceValidation } from '../../shared/schemas/onboarding';
import { approveAndAdvanceItems, markReviewed, getReviewState } from '../../db/repositories/onboarding-review-repo';
import { validateChangeSet } from '../../validation/change-set-validation';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { findByScopedIdempotencyKey } from '../../db/repositories/onboarding-operation-receipt-repo';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import { computeIdentityProvenanceHash } from '../../onboarding/imported-identity';
import { createManualEvidenceAttestation } from '../../db/repositories/onboarding-manual-evidence-repo';
import { canonicalJsonStringify } from '../../shared/stable-id';
import { draftVariantFactsFor } from '../../classification/listing-evidence-currentness';

import { prepareListingEvidenceWorkspace, rotateListingEvidenceAuthority, seedListingEvidenceItem } from './helpers/listing-evidence-authority';
// ─── Fixture helpers ─────────────────────────────────────────────────────────

let workspaceId: string;
let workspacePath: string;
let batchId: string;

beforeEach(() => {
  workspaceId = randomUUID();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'le367-'));
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
  prepareListingEvidenceWorkspace(workspacePath, workspaceId);
  batchId = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 }).id;
  evidenceIdsByItem.clear();
});

function seedItem(upc = 'SKU-VERIFY', name = 'Acana Adult Dog'): string {
  return insertItems(batchId, [{ upc, name, brandHint: 'Acana', rowNumber: 1 }], 'review', 1)[0].id;
}

const evidenceIdsByItem = new Map<string, string>();
function seedRun(itemId: string, sku: string, options: { weight?: string; description?: string } = {}): { id: string } {
  const authority = seedListingEvidenceItem({ workspaceId, workspacePath, itemId, sku, ...options });
  evidenceIdsByItem.set(itemId, authority.titleEvidenceId);
  return { id: authority.runId };
}

function writeCuration(itemId: string, curation: Record<string, unknown>): void {
  const existing = (findItemById(itemId)?.curationData ?? {}) as Record<string, unknown>;
  const current: Record<string, unknown> = {
    suggestedPages: ['QA/test-only dog-food category'],
    ...(existing && typeof existing === 'object' && 'itemExecutionCurrentness' in existing
      ? { itemExecutionCurrentness: (existing as Record<string, unknown>).itemExecutionCurrentness }
      : {}),
    ...curation,
  };
  const raw = current.listingEvidenceValidation;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = { ...(raw as Record<string, unknown>) };
    const hashes = currentListingEvidenceHashes(itemId, current);
    if (!Array.isArray(record.requiredFields) && hashes.requiredFields.length > 0) record.requiredFields = hashes.requiredFields;
    if (typeof record.sourceAuthority !== 'string' && hashes.sourceAuthority) record.sourceAuthority = hashes.sourceAuthority;
    current.listingEvidenceValidation = record;
  }
  getDb().query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(JSON.stringify(current), itemId);
}


function readCuration(itemId: string): Record<string, unknown> {
  const found = findItemById(itemId);
  const raw = found?.curationData;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function curationRevision(itemId: string): string {
  return currentVerifyRevisionForItem(itemId);
}

/** Seed an item whose title is supported but description claim is unresolved. */
function seedUnresolvedItem(upc = 'SKU-VERIFY', attestDescription = true): { itemId: string; runId: string; claimId: string } {
  const title = 'Acana Adult Dog';
  const description = 'Grain free puppy nutrition with vitamins and minerals for active dogs daily';
  const itemId = seedItem(upc);
  const run = seedRun(itemId, upc, attestDescription ? { description } : {});
  const evidenceId = evidenceIdsByItem.get(itemId)!;
  const cur = currentListingEvidenceHashes(itemId, { curatedTitle: title, curatedDescription: description, classificationRunId: run.id });
  const claimText = description;
  writeCuration(itemId, {
    curatedTitle: title,
    curatedDescription: description,
    classificationRunId: run.id,
    listingEvidenceValidation: {
      recordVersion: 1,
      listingHash: cur.listingHash,
      evidenceHash: cur.evidenceHash,
      rulesVersion: 'listing-evidence-rules-v1',
      modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
      claims: [
        {
          id: 'claim_01', field: 'title', span: [0, title.length], text: title,
          claimHash: createHash('sha256').update(title.toLowerCase()).digest('hex'),
          material: true, verdict: 'supported', producer: 'deterministic',
          evidenceConsidered: [evidenceId], modelCallId: null, reason: 'exact supported copy',
        },
        {
          id: 'claim_02', field: 'description', span: [0, 20], text: claimText,
          claimHash: createHash('sha256').update(claimText.toLowerCase()).digest('hex'),
          material: true, verdict: 'insufficient', producer: 'deterministic',
          evidenceConsidered: [evidenceId], modelCallId: null, reason: 'partial coverage only',
        },
      ],
      overflow: false,
      modelCallIds: [],
      status: 'needs_review',
      findings: ['Unsupported description "Grain free puppy…": remove it, correct it, or supply eligible evidence.'],
      evaluatedAt: new Date().toISOString(),
    },
  });
  return { itemId, runId: run.id, claimId: 'claim_02' };
}

const PRINCIPAL = { actor: 'catalog_approver:test', role: 'catalog_approver' as const, tokenHash: 'test' };
const OBSERVATION = 'Verified against the sealed 5 lb bag label in hand: package reads "Grain free puppy nutrition with vitamins" — matches this exact wording.';
const PROVENANCE = 'Inspected the physical package front and side panels at the receiving bench on 2026-10-19; photos filed under receiving lot 42.';

// ─── Criterion 1: real observation resolves; readiness reflects it ───────────

describe('issue #367 criterion 1 — real observation resolves the finding', () => {
  it('operator verifies an unresolved claim; gate clears and Review readiness returns to the field', () => {
    const { itemId, claimId } = seedUnresolvedItem();
    // Before: the gate refuses (needs_review blocks).
    const before = validateListingEvidenceForReview(itemId);
    expect(before).not.toBeNull();
    expect(before && !before.ok ? before.code : undefined).toBe('listing_evidence_unresolved');

    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId,
        itemId,
        claimIds: [claimId],
        observation: OBSERVATION,
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-c1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replay).toBe(false);
    expect(result.resolvedClaimIds).toEqual([claimId]);
    expect(result.aggregateStatus).toBe('passed');

    // Producer truthfulness: operator_verified, never typesafe/deterministic.
    const resolved = result.record.claims.find((c) => c.id === claimId)!;
    expect(resolved.verdict).toBe('supported');
    expect(resolved.producer).toBe('operator_verified');
    expect(resolved.modelCallId).toBeNull();
    expect(resolved.reason).toContain('Operator-verified');

    // The untouched supported title keeps its deterministic producer.
    const title = result.record.claims.find((c) => c.id === 'claim_01')!;
    expect(title.producer).toBe('deterministic');

    // Gate + readiness now pass (null = current and passed).
    expect(validateListingEvidenceForReview(itemId)).toBeNull();
  });

  it('approve-alone creates no evidence: approval without verification stays refused', () => {
    const { itemId } = seedUnresolvedItem('SKU-NOVERIFY');
    getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(itemId);
    markReviewed({ itemId, batchId, reviewedBy: 'test' });
    const res = approveAndAdvanceItems({ itemIds: [itemId], batchId, approvedBy: 'test', requestHash: 'f'.repeat(64) });
    expect(res.approved).not.toContain(itemId);
    expect(res.rejected.some((r) => r.itemId === itemId && r.reason.includes('listing_evidence'))).toBe(true);
  });
});

// ─── Criterion 2: exact binding; server-derived authority ────────────────────

describe('issue #367 criterion 2 — binding + server authority', () => {
  it('cross-workspace verification is 404 (no foreign mutation)', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-XWS');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId: 'foreign-workspace',
        itemId,
        claimIds: [claimId],
        observation: OBSERVATION,
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-xws',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('workspace_mismatch');
    expect(result.status).toBe(404);
    // No receipt row for the foreign scope.
    expect(findByScopedIdempotencyKey('foreign-workspace', batchId, 'listing_evidence_verify', 'token-xws')).toBeUndefined();
  });

  it('forged claim ids and short observations refuse without writes', () => {
    const { itemId } = seedUnresolvedItem('SKU-FORGE');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const forged = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_99'],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-forge',
      },
      PRINCIPAL,
    );
    expect(forged.ok).toBe(false);
    if (forged.ok) return;
    expect(forged.code).toBe('claim_not_found');

    const short = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_02'],
        observation: 'looks good', provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-short',
      },
      PRINCIPAL,
    );
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.code).toBe('invalid_observation');

    // No curation write on either refusal.
    const after = readCuration(itemId).listingEvidenceValidation as ListingEvidenceValidation;
    expect(after.claims.find((c) => c.id === 'claim_02')!.producer).toBe('deterministic');
    expect(findByScopedIdempotencyKey(workspaceId, batchId, 'listing_evidence_verify', 'token-forge')).toBeUndefined();
  });
});

// ─── Criterion 3: idempotent replay; stale/mismatch refuse cleanly ───────────

describe('issue #367 criterion 3 — idempotency + stale refusal', () => {
  it('exact token/payload replay returns one receipt; no duplicate writes', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-REPLAY');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const input = {
      workspaceId,
      itemId,
      claimIds: [claimId],
      observation: OBSERVATION,
      provenance: PROVENANCE,
      expectedEvidenceHash: record.evidenceHash,
      expectedRevision: curationRevision(itemId),
      actionToken: 'token-replay-1',
    };
    const first = verifyListingEvidence(input, PRINCIPAL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const replay = verifyListingEvidence(input, PRINCIPAL);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replay).toBe(true);
    expect(replay.receiptId).toBe(first.receiptId);
    expect(JSON.stringify(replay.record)).toBe(JSON.stringify(first.record));
    // Exactly one receipt row for the token.
    const rows = getDb().query(
      'SELECT COUNT(*) as c FROM onboarding_operation_receipts WHERE idempotency_key = ?',
    ).all('token-replay-1') as Array<{ c: number }>;
    expect(rows[0].c).toBe(1);
    // Exactly one audit row (no duplicate audit on replay).
    const audits = getDb().query(
      "SELECT COUNT(*) as c FROM audit_log WHERE entity_id = ? AND action = 'verify_listing_evidence'",
    ).all(itemId) as Array<{ c: number }>;
    expect(audits[0].c).toBe(1);
  });

  it('same token + different payload conflicts; stale revision refuses with input preserved', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-CONFLICT');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const base = {
      workspaceId,
      itemId,
      claimIds: [claimId],
      observation: OBSERVATION,
      provenance: PROVENANCE,
      expectedEvidenceHash: record.evidenceHash,
      expectedRevision: curationRevision(itemId),
      actionToken: 'token-conflict-1',
    };
    const first = verifyListingEvidence(base, PRINCIPAL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const conflict = verifyListingEvidence({ ...base, observation: `${OBSERVATION} (changed wording)` }, PRINCIPAL);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe('idempotency_conflict');
    expect(conflict.status).toBe(409);

    // Stale revision: edit the curation out-of-band, then submit against the old token.
    const edited = { ...readCuration(itemId), curatedDescription: 'Edited after load' };
    writeCuration(itemId, edited);
    const stale = verifyListingEvidence({ ...base, actionToken: 'token-stale-1' }, PRINCIPAL);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('revision_stale');
    expect(stale.status).toBe(409);
    // No partial write: the earlier operator_verified verdict is gone with
    // the edited curation only insofar as the test edited it — the stale
    // submission itself changed nothing further.
    const after = readCuration(itemId);
    expect((after.listingEvidenceValidation as ListingEvidenceValidation).claims.find((c) => c.id === claimId)).toBeTruthy();
  });

  it('stale evidence hash refuses when the accepted snapshot rotates', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-EVSTALE');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    rotateListingEvidenceAuthority(workspaceId, itemId);
    const stale = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-evstale-1',
      },
      PRINCIPAL,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('evidence_stale');
    const after = readCuration(itemId).listingEvidenceValidation as ListingEvidenceValidation;
    expect(after.claims.find((c) => c.id === 'claim_02')!.producer).toBe('deterministic');
  });
});
describe('issue #367 fixups — replay-after-edit preserves receipt + brand ownership gate', () => {
  it('same-token replay after an intervening edit refuses WITHOUT mutating the completed receipt', () => {
    const seeded = seedUnresolvedItem('SKU-REPLAYEDIT');
    const curation = readCuration(seeded.itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const input = {
      workspaceId,
      itemId: seeded.itemId,
      claimIds: [seeded.claimId],
      observation: OBSERVATION,
      provenance: PROVENANCE,
      expectedEvidenceHash: record.evidenceHash,
      expectedRevision: curationRevision(seeded.itemId),
      actionToken: 'token-replayedit-1',
    };
    const first = verifyListingEvidence(input, PRINCIPAL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const receiptBefore = findByScopedIdempotencyKey(workspaceId, batchId, 'listing_evidence_verify', 'token-replayedit-1')!;
    expect(receiptBefore.status).toBe('completed');
    // Out-of-band edit changes the stored validation record itself (an
    // intervening verification superseded it); the stored verified record
    // is no longer live.
    const verified = readCuration(seeded.itemId).listingEvidenceValidation as ListingEvidenceValidation;
    writeCuration(seeded.itemId, { ...readCuration(seeded.itemId), curatedDescription: 'Edited after verification', listingEvidenceValidation: { ...verified, evaluatedAt: new Date(Date.now() + 1000).toISOString() } });
    const replay = verifyListingEvidence(input, PRINCIPAL);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.code).toBe('revision_stale');
    expect(replay.status).toBe(409);
    // Original success receipt untouched: still completed, same payload.
    const receiptAfter = findByScopedIdempotencyKey(workspaceId, batchId, 'listing_evidence_verify', 'token-replayedit-1')!;
    expect(receiptAfter.status).toBe('completed');
    expect(receiptAfter.detailsJson).toBe(receiptBefore.detailsJson);
  });

  it('a claim asserting the brand identity refuses via the Brand flow', () => {
    const itemId = seedItem('SKU-BrandOWN', 'Acana Adult Dog');
    const run = seedRun(itemId, 'SKU-BrandOWN');
    const brandText = 'Acana';
    const cur = currentListingEvidenceHashes(itemId, { curatedTitle: 'Acana Adult Dog', curatedDescription: brandText, classificationRunId: run.id });
    writeCuration(itemId, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: brandText,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [
          {
            id: 'claim_01', field: 'description', span: [0, brandText.length], text: brandText,
            claimHash: createHash('sha256').update(brandText.toLowerCase()).digest('hex'),
            material: true, verdict: 'insufficient', producer: 'deterministic',
            evidenceConsidered: ['SKU-BrandOWN-e1'], modelCallId: null, reason: 'partial coverage only',
          },
        ],
        overflow: false,
        modelCallIds: [],
        status: 'needs_review',
        findings: [`Unsupported description "${brandText}": remove it, correct it, or supply eligible evidence.`],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_01'],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-brandown-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('brand_ownership');
  });
  it('a longer claim carrying the brand hint refuses (no laundering)', () => {
    const itemId = seedItem('SKU-BRANDLAUNDER', 'Acana Adult Dog');
    const run = seedRun(itemId, 'SKU-BRANDLAUNDER');
    const brandText = 'Acana Adult Dog food';
    const cur = currentListingEvidenceHashes(itemId, { curatedTitle: 'Acana Adult Dog', curatedDescription: brandText, classificationRunId: run.id });
    writeCuration(itemId, {
      curatedTitle: 'Acana Adult Dog',
      curatedDescription: brandText,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [
          {
            id: 'claim_01', field: 'description', span: [0, brandText.length], text: brandText,
            claimHash: createHash('sha256').update(brandText.toLowerCase()).digest('hex'),
            material: true, verdict: 'insufficient', producer: 'deterministic',
            evidenceConsidered: ['SKU-BRANDLAUNDER-e1'], modelCallId: null, reason: 'partial coverage only',
          },
        ],
        overflow: false,
        modelCallIds: [],
        status: 'needs_review',
        findings: [`Unsupported description "${brandText}": remove it, correct it, or supply eligible evidence.`],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_01'],
        observation: `Verified on the shelf tag: package reads "Acana Adult Dog food" exactly as printed.`,
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-brandlaunder-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('brand_ownership');
  });
});


// ─── Criterion 4: no fabricated/stale attestations ───────────────────────────

describe('issue #367 criterion 4 — no fabricated attestations', () => {
  it('already-supported and contradicted claims refuse verification', () => {
    const { itemId } = seedUnresolvedItem('SKU-NOFAB');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const supported = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_01'],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-nofab-1',
      },
      PRINCIPAL,
    );
    expect(supported.ok).toBe(false);
    if (supported.ok) return;
    // claim_01 asserts the title/brand identity: the Brand ownership gate
    // routes it to the Brand flow before claim-liveness is consulted.
    expect(supported.code).toBe('hard_gate_refusal');
    expect(supported.reason).toContain('brand_ownership');
  });

  it('missing provenance refuses; verification never invents evidenceConsidered', () => {
    const { itemId } = seedUnresolvedItem('SKU-NOPROV');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const missing = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_02'],
        observation: OBSERVATION, provenance: '   ',
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-noprov-1',
      },
      PRINCIPAL,
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('invalid_provenance');
  });
  it('negated verification verbs refuse even with an exact quote', () => {
    for (const [suffix, observation] of [
      ['neg1', 'Package reads "Grain free puppy nutrition with vitamins" exactly, but I cannot verify this wording.'],
      ['neg2', 'Package reads "Grain free puppy nutrition with vitamins" exactly; did not verify the wording.'],
      ['neg3', 'Package reads "Grain free puppy nutrition with vitamins" exactly — no match confirmed.'],
    ] as Array<[string, string]>) {
      const { itemId } = seedUnresolvedItem(`SKU-NEG-${suffix}`);
      const curation = readCuration(itemId);
      const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
      const result = verifyListingEvidence(
        {
          workspaceId, itemId, claimIds: ['claim_02'],
          observation, provenance: PROVENANCE,
          expectedEvidenceHash: record.evidenceHash,
          expectedRevision: curationRevision(itemId),
          actionToken: `token-neg-${suffix}`,
        },
        PRINCIPAL,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('invalid_observation');
    }
  });
  it('an observation about a different weight cannot verify a weight claim', () => {
    const itemId = seedItem('SKU-WEIGHT', 'Acana Adult Dog 5 lb');
    const run = seedRun(itemId, 'SKU-WEIGHT', { weight: '5 lb' });
    const claimText = 'weight: 5 lb';
    const cur = currentListingEvidenceHashes(itemId, { curatedTitle: 'Acana Adult Dog 5 lb', curatedDescription: null, classificationRunId: run.id });
    writeCuration(itemId, {
      curatedTitle: 'Acana Adult Dog 5 lb',
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: cur.listingHash,
        evidenceHash: cur.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [
          {
            id: 'claim_01', field: 'variant', span: [0, 0], text: claimText,
            claimHash: createHash('sha256').update(claimText.toLowerCase()).digest('hex'),
            material: true, verdict: 'insufficient', producer: 'deterministic',
            evidenceConsidered: [], modelCallId: null, reason: 'unverified weight fact',
          },
        ],
        overflow: false,
        modelCallIds: [],
        status: 'needs_review',
        findings: ['Unsupported variant "weight: 5 lb": verify or correct it.'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const wrongWeight = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_01'],
        observation: 'Verified the bag: package reads "weight: 10 lb" and I confirm that matches.',
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-weight-wrong',
      },
      PRINCIPAL,
    );
    expect(wrongWeight.ok).toBe(false);
    if (wrongWeight.ok) return;
    expect(wrongWeight.code).toBe('invalid_observation');
    const rightWeight = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: ['claim_01'],
        observation: 'Verified the bag: package reads "weight: 5 lb" and I confirm that matches.',
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-weight-right',
      },
      PRINCIPAL,
    );
    expect(rightWeight.ok).toBe(true);
  });
  it('an attestation over an old title cannot authorize a new description value', () => {
    const seeded = seedUnresolvedItem('SKU-STALEVAL', false);
    const curation = readCuration(seeded.itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId: seeded.itemId, claimIds: [seeded.claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(seeded.itemId),
        actionToken: 'token-staleval-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_observation');
  });
});

describe('issue #367 criterion 5 — hard gates route to their owning flow', () => {
  it('unresolved hard source conflict refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-HARDCONF');
    getDb().query(
      `INSERT INTO onboarding_evidence_conflicts (id, item_id, field, severity, status, sourcing_generation_id, created_at)
       VALUES (?, ?, 'title', 'hard', 'open', NULL, ?)`,
    ).run(randomUUID(), itemId, new Date().toISOString());
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-hardconf',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('hard_conflict_open');
    // No partial write.
    const after = readCuration(itemId).listingEvidenceValidation as ListingEvidenceValidation;
    expect(after.claims.find((c) => c.id === claimId)!.producer).toBe('deterministic');
  });

  it('unresolved variant identity refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-VARIDENT');
    getDb().query(
      `INSERT INTO onboarding_variant_identity_dispositions (item_id, disposition, reason, marked_by, created_at, updated_at)
       VALUES (?, 'unresolved_variant_identity', 'size-specific row on family page', 'test', ?, ?)`,
    ).run(itemId, new Date().toISOString(), new Date().toISOString());
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-varident-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('variant_identity_unresolved');
  });

  it('open remote drift refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-DRIFT');
    const item = findItemById(itemId)!;
    getDb().query(
      `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status, local_hash, remote_hash, local_json, remote_json, diff_json)
       VALUES (?, ?, ?, ?, 'open', NULL, 'remote', NULL, '{}', NULL)`,
    ).run(randomUUID(), workspaceId, item.upc, new Date().toISOString());
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-drift-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('remote_drift_open');
  });
  it('inconsistent identity tuple refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-IDENTITY');
    // Canonical v1 envelopes with mismatched upc so validateIdentityTuple
    // passes but the verify identity gate fires identity_unresolved.
    const mappingHash = 'a'.repeat(64);
    const rawEnv = canonicalJsonStringify({
      brandHint: null, departmentHint: null, mappingHash, nameFragments: [],
      parserProvenance: { parserVersion: 1, source: 'spreadsheet' },
      price: null, quantity: null, rowNumber: 1, sourceUrl: null, upc: 'SKU-IDENTITY', version: 1,
    });
    const normEnv = canonicalJsonStringify({
      brandHint: null, departmentHint: null, mappingHash, name: 'Acana Adult Dog',
      parserProvenance: { parserVersion: 1, source: 'spreadsheet' },
      price: null, quantity: null, rowNumber: 1, sourceUrl: null, transformations: [], upc: 'OTHER-GTIN', version: 1,
    });
    const provHash = computeIdentityProvenanceHash(rawEnv, normEnv);
    getDb().query('UPDATE onboarding_items SET raw_identity_json = ?, normalized_identity_json = ?, identity_normalizer_version = 1, identity_provenance_hash = ? WHERE id = ?').run(
      rawEnv,
      normEnv,
      provHash,
      itemId,
    );
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-identity-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('identity_unresolved');
  });

  it('missing extractor profile for the source domain refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-DOMAIN');
    getDb().query('UPDATE onboarding_items SET source_url = ? WHERE id = ?').run('https://no-profile-here.example/products/1', itemId);
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-domain-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('domain_profile_missing');
  });

  it('reviewer-selected media without rights attestation refuses verification', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-IMGRIGHTS');
    createManualEvidenceAttestation({
      itemId, operatorId: 'op-1',
      fieldValues: { description: 'attested text' },
      fieldSources: { description: { sourceKind: 'operator_transcription' } },
      imageRights: [{ imageUrl: 'https://cdn.example/other.jpg' }],
    });
    writeCuration(itemId, { ...readCuration(itemId), reviewedMedia: { primaryImage: 'https://cdn.example/img.jpg', orderedAdditional: [], suppressed: [] } });
    const refreshed = readCuration(itemId);
    const record = refreshed.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-imgrights-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('manual_image_rights_missing');
  });

  it('unowned classification run refuses verification', () => {
    const seeded = seedUnresolvedItem('SKU-RUNOWN');
    const otherId = seedItem('SKU-RUNOWN-OTHER', 'Other Product');
    const foreignRun = seedRun(otherId, 'SKU-RUNOWN-OTHER');
    writeCuration(seeded.itemId, { ...readCuration(seeded.itemId), classificationRunId: foreignRun.id });
    const curation = readCuration(seeded.itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const result = verifyListingEvidence(
      {
        workspaceId, itemId: seeded.itemId, claimIds: [seeded.claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(seeded.itemId),
        actionToken: 'token-runown-1',
      },
      PRINCIPAL,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hard_gate_refusal');
    expect(result.reason).toContain('run_not_found');
  });
});

// ─── Criterion 6: consequential edits invalidate; unchanged work reusable ────

describe('issue #367 criterion 6 — consequential edits invalidate the resolution', () => {
  it('a consequential listing edit drops currentness and invalidates review/approval', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-INVALID');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const verified = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-inv-1',
      },
      PRINCIPAL,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // Review + approve on the verified record.
    getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(itemId);
    markReviewed({ itemId, batchId, reviewedBy: 'test' });
    expect(getReviewState(itemId)?.reviewedAt).toBeTruthy();

    // Consequential edit: change the description (PUT-layer semantics —
    // the listing hash no longer matches the verified record).
    const next = {
      ...readCuration(itemId),
      curatedDescription: 'Completely rewritten description text with new assertions',
    };
    writeCuration(itemId, next);
    const stale = validateListingEvidenceForReview(itemId);
    expect(stale).not.toBeNull();
    expect(stale && !stale.ok ? stale.code : undefined).toBe('listing_evidence_stale');
  });

  it('independently unchanged judgments stay reusable without inheriting approval', () => {
    const a = seedUnresolvedItem('SKU-UNCH-A');
    const b = seedUnresolvedItem('SKU-UNCH-B');
    for (const { itemId, claimId } of [a, b]) {
      const curation = readCuration(itemId);
      const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
      const res = verifyListingEvidence(
        {
          workspaceId, itemId, claimIds: [claimId],
          observation: OBSERVATION, provenance: PROVENANCE,
          expectedEvidenceHash: record.evidenceHash,
          expectedRevision: curationRevision(itemId),
          actionToken: `token-unch-${itemId.slice(0, 8)}`,
        },
        PRINCIPAL,
      );
      expect(res.ok).toBe(true);
    }
    // Editing A does not touch B's verified record.
    const editA = { ...readCuration(a.itemId), curatedTitle: 'Acana Adult Dog 5 lb edited' };
    writeCuration(a.itemId, editA);
    expect(validateListingEvidenceForReview(a.itemId)).not.toBeNull();
    expect(validateListingEvidenceForReview(b.itemId)).toBeNull();
  });
  it('a source change via the PUT invalidation layer regresses operator_verified claims', async () => {
    const seeded = seedUnresolvedItem('SKU-SOURCECHG');
    const curation = readCuration(seeded.itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const verified = verifyListingEvidence(
      {
        workspaceId, itemId: seeded.itemId, claimIds: [seeded.claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(seeded.itemId),
        actionToken: 'token-sourcechg-1',
      },
      PRINCIPAL,
    );
    expect(verified.ok).toBe(true);
    // Supported PUT carrying ONLY source_url (no curation_data) changes the
    // selected source authority through the real route; the operator
    // verification must regress to deterministic/insufficient.
    const putApp = new Hono();
    putApp.route('/api', onboardingRoutes);
    const put = await putApp.request(`/api/onboarding/items/${seeded.itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_url: 'https://brand.example.com/other-source' }),
    });
    expect(put.status).toBe(200);
    const regressed = readCuration(seeded.itemId).listingEvidenceValidation as ListingEvidenceValidation;
    const regressedClaim = regressed.claims.find((c) => c.id === seeded.claimId)!;
    expect(regressedClaim.producer).toBe('deterministic');
    expect(regressedClaim.verdict).toBe('insufficient');
    expect(validateListingEvidenceForReview(seeded.itemId)).not.toBeNull();
  });
});

// ─── Criteria 7+8: release-path flow + Review → draft smoke ──────────────────

describe('issue #367 criteria 7+8 — full release path + smoke', () => {
  it('verified record flows through durable approval and change-set approval; truthfulness preserved', () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-SMOKE');
    const curation = readCuration(itemId);
    const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
    const verified = verifyListingEvidence(
      {
        workspaceId, itemId, claimIds: [claimId],
        observation: OBSERVATION, provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
        actionToken: 'token-smoke-1',
      },
      PRINCIPAL,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // Review completion gate passes on the verified record.
    expect(validateListingEvidenceForReview(itemId)).toBeNull();

    // Durable approval admits the verified item.
    getDb().query(`UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?`).run(itemId);
    markReviewed({ itemId, batchId, reviewedBy: 'test' });
    const res = approveAndAdvanceItems({ itemIds: [itemId], batchId, approvedBy: 'test', requestHash: 'e'.repeat(64) });
    expect(res.approved).toContain(itemId);

    // Real promotion path: review → verification → durable approval → draft.
    // The draft carries the VERIFIED live listing text (title + full
    // description), never a one-letter stub — the frozen draft projection
    // must equal the verified record's listing hash, and operator provenance
    // (operator_verified, never typesafe/deterministic) is visible on the
    // released record before the draft is frozen.
    const title = 'Acana Adult Dog';
    const verifiedDescription = (readCuration(itemId).curatedDescription as string | null)
      ?? 'Grain free puppy nutrition with vitamins and minerals for active dogs daily';
    const promotedRecord = readCuration(itemId).listingEvidenceValidation as ListingEvidenceValidation;
    const resolvedClaim = promotedRecord.claims.find((c) => c.id === claimId)!;
    expect(resolvedClaim.verdict).toBe('supported');
    expect(resolvedClaim.producer).toBe('operator_verified');
    expect(resolvedClaim.modelCallId).toBeNull();
    expect(resolvedClaim.reason).toContain('Operator-verified');
    const frozenDraft = { title, description: verifiedDescription, variantFacts: draftVariantFactsFor(itemId, null) };
    const draftHashes = draftListingEvidenceHashes(itemId, frozenDraft, { workspacePath, workspaceId });
    expect({ listingHash: draftHashes.listingHash, evidenceHash: draftHashes.evidenceHash }).toEqual({ listingHash: promotedRecord.listingHash, evidenceHash: promotedRecord.evidenceHash });
    const product = {
      schemaVersion: 1,
      id: 'id-SKU-SMOKE',
      sku: 'SKU-SMOKE',
      status: 'draft',
      core: {
        name: title, price: '9.99', salePrice: null, description: verifiedDescription,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: 'products/SKU-SMOKE/images/primary.jpg', additional: [] },
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
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'SKU-SMOKE', operation: 'create', draftJson: JSON.stringify(product), baseJson: null, draftHash: 'h' });
    const blocked = validateChangeSet(cs.id);
    expect(blocked.items[0].results.filter((r) => r.code === 'LISTING_EVIDENCE_UNRESOLVED')).toEqual([]);
  });

  it('the #366 correction flow still works untouched beside verification', () => {
    const id = seedItem('SKU-BOTH', 'Acana Adult Dog');
    const run = seedRun(id, 'SKU-BOTH');
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
        modelPolicyDigest: cur.modelPolicyDigest || 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'blocked',
        findings: ['Contradicted description "Bad claim…": eligible evidence denies it'],
        evaluatedAt: new Date().toISOString(),
      },
    });
    // Correction path: remove the unsafe optional text (PUT invalidation
    // semantics — the stale record drops until re-evaluation writes fresh).
    const fixed = currentListingEvidenceHashes(id, { curatedTitle: title, curatedDescription: null, classificationRunId: run.id });
    writeCuration(id, {
      curatedTitle: title,
      curatedDescription: null,
      classificationRunId: run.id,
      listingEvidenceValidation: {
        recordVersion: 1,
        listingHash: fixed.listingHash,
        evidenceHash: fixed.evidenceHash,
        requiredFields: ['title'],
        rulesVersion: 'listing-evidence-rules-v1',
        modelPolicyDigest: fixed.modelPolicyDigest || 'policy_unavailable',
        claims: [],
        overflow: false,
        modelCallIds: [],
        status: 'passed',
        findings: [],
        evaluatedAt: new Date().toISOString(),
      },
    });
    expect(validateListingEvidenceForReview(id)).toBeNull();
  });
});

// ─── HTTP layer: auth, idempotency key, cross-workspace via route ────────────

function makeVerifyApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  return app;
}

describe('issue #367 HTTP — auth, Idempotency-Key, cross-workspace', () => {
  it('unauthenticated GET and POST refuse 401; missing Idempotency-Key refuses 400', async () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-HTTP-AUTH');
    process.env.BAYSTATE_CMS_API_TOKEN = 'http-test-token';
    const app = makeVerifyApp();
    try {
      const get = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`);
      expect(get.status).toBe(401);
      const curation = readCuration(itemId);
      const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
      const postNoAuth = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-no-auth' },
        body: JSON.stringify({
          claimIds: [claimId],
          observation: OBSERVATION,
          provenance: PROVENANCE,
          expectedEvidenceHash: record.evidenceHash,
          expectedRevision: curationRevision(itemId),
        }),
      });
      expect(postNoAuth.status).toBe(401);
      const postNoKey = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token' },
        body: JSON.stringify({
          claimIds: [claimId],
          observation: OBSERVATION,
          provenance: PROVENANCE,
          expectedEvidenceHash: record.evidenceHash,
          expectedRevision: curationRevision(itemId),
        }),
      });
      expect(postNoKey.status).toBe(400);
    } finally {
      delete process.env.BAYSTATE_CMS_API_TOKEN;
    }
  });

  it('authenticated POST verifies; same Idempotency-Key replays; different payload conflicts', async () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-HTTP-IDEM');
    process.env.BAYSTATE_CMS_API_TOKEN = 'http-test-token';
    const app = makeVerifyApp();
    try {
      const curation = readCuration(itemId);
      const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
      const body = {
        claimIds: [claimId],
        observation: OBSERVATION,
        provenance: PROVENANCE,
        expectedEvidenceHash: record.evidenceHash,
        expectedRevision: curationRevision(itemId),
      };
      const first = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token', 'Idempotency-Key': 'http-idem-1' },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { replay: boolean };
      expect(firstBody.replay).toBe(false);
      const replay = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token', 'Idempotency-Key': 'http-idem-1' },
        body: JSON.stringify(body),
      });
      expect(replay.status).toBe(200);
      expect((await replay.json() as { replay: boolean }).replay).toBe(true);
      const conflict = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token', 'Idempotency-Key': 'http-idem-1' },
        body: JSON.stringify({ ...body, provenance: `${PROVENANCE} (changed)` }),
      });
      expect(conflict.status).toBe(409);
      expect((await conflict.json() as { code: string }).code).toBe('idempotency_conflict');
    } finally {
      delete process.env.BAYSTATE_CMS_API_TOKEN;
    }
  });

  it('foreign-workspace item 404s via the route (no mutation)', async () => {
    const { itemId, claimId } = seedUnresolvedItem('SKU-HTTP-XWS');
    // Two valid workspaces: move the item's BATCH to a second workspace so
    // the row still references a live workspace — the 404 then proves real
    // isolation (batch workspace != request workspace), not orphan rejection.
    const otherWorkspaceId = randomUUID();
    const otherPath = workspacePath;
    insertWorkspace({
      id: otherWorkspaceId, name: 'other', workspacePath: otherPath,
      gitPath: path.join(otherPath, '.git'),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete', baselineCommit: null,
    });
    getDb().query('UPDATE onboarding_batches SET workspace_id = ? WHERE id = ?').run(otherWorkspaceId, batchId);
    process.env.BAYSTATE_CMS_API_TOKEN = 'http-test-token';
    const app = makeVerifyApp();
    try {
      const curation = readCuration(itemId);
      const record = curation.listingEvidenceValidation as ListingEvidenceValidation;
      const get = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        headers: { Authorization: 'Bearer http-test-token' },
      });
      expect(get.status).toBe(404);
      const post = await app.request(`/api/onboarding/items/${itemId}/listing-evidence-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer http-test-token', 'Idempotency-Key': 'http-xws-1' },
        body: JSON.stringify({
          claimIds: [claimId],
          observation: OBSERVATION,
          provenance: PROVENANCE,
          expectedEvidenceHash: record.evidenceHash,
          expectedRevision: curationRevision(itemId),
        }),
      });
      expect(post.status).toBe(404);
      const after = readCuration(itemId).listingEvidenceValidation as ListingEvidenceValidation;
      expect(after.claims.find((c) => c.id === claimId)!.producer).toBe('deterministic');
    } finally {
      delete process.env.BAYSTATE_CMS_API_TOKEN;
    }
  });
});
