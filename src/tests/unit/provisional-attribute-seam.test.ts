/**
 * Issue #352 — provisional classification drives attribute proposals in one pass (TDD).
 *
 * The provisional (pending, unreviewed) canonical pair proposal produced by
 * the type stage must unlock type-gated attribute proposals in the SAME
 * pipeline pass: flavor (explicit fact, applicable profile) proposes while
 * a missing pair withholds — without waiting for a reviewer to accept the
 * pair first. A member with NO pair (pending or accepted) still withholds
 * type-gated attributes (fail closed on truly unknown).
 *
 * Public seam only (runPipeline with real stages over a lifecycle-ACTIVE v2
 * bundle built from a minimal seed; isolated persistence, deterministic
 * adapters); no live ShopSite mutation.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { runPipeline } from '../../classification/pipeline-runner';
import { primaryProductTypeStage } from '../../classification/stages/primary-product-type';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { generateCandidate, buildFocusedFiles, type BayStateSeed } from '../../classification/config-generator';
import { ClassificationFocusedFileNames, ClassificationManifestV2Schema } from '../../shared/schemas/classification';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { canonicalJsonFileString, sha256Hex } from '../../shared/stable-id';
import { createRun as createRepositoryRun } from '../../db/repositories/classification-run-repo';
import { createRuntimeActivationContext, loadRuntimeConfigAuthority } from '../../classification/config-loader';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import type { ClassificationEvidence } from '../../shared/types';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

const WS_ID = 'ws-provisional-attr-seam';

const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 1, xmlFields: ['ProductField23'] },
  fields: [{ xmlField: 'ProductField23' } as any],
  pages: [],
};

function seedFixture(): BayStateSeed {
  return {
    name: 'Provisional Seam Seed',
    revision: 'test-v1',
    createdAt: '2026-08-01T12:00:00.000Z',
    categories: [
      { id: 'dog-food', name: 'Dog Food', description: null },
    ],
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: 'Dry dog food (kibble).', categoryId: 'dog-food' },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food', isUniversal: false },
    ],
    profileTemplates: [
      { id: 'dog-profile', name: 'Dog', productTypeIds: ['dog-food-dry'], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'single' }] },
    ],
    mappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
    ],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: 'test-model', providerLocalities: { ollama: 'local' }, stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only', mlFeatures: { productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null }, productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null } } },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  } as unknown as BayStateSeed;
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'provisional-attr-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  // Lifecycle-ACTIVE v2 bundle from the minimal seed (same helper shape as
  // pr9-acceptance writeActiveV2Bundle, trimmed to this seam's needs).
  const candidate = generateCandidate(seedFixture(), EVIDENCE);
  const bundle: any = candidate.bundle;
  const focusedFiles = buildFocusedFiles(bundle);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const xmlFields = [...new Set(bundle.attributeMappings.map((mapping: any) => mapping.catalogField))];
  fs.writeFileSync(path.join(workspacePath, 'store', 'field-registry.json'), JSON.stringify({ entries: xmlFields.map(xmlField => ({ xmlField })) }));
  const artifactContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.writeFileSync(path.join(workspacePath, 'store', 'classification', 'catalog-evidence.json'), artifactContent);
  // Git-anchored workspace so sourceCatalogCommit verifies.
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'test evidence'], { cwd: workspacePath, stdio: 'ignore' });
  const sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' }).trim();
  const manifestWithoutHash: any = {
    ...bundle.manifest,
    activeRevision: 'test-v1',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash: sha256Hex(artifactContent),
    fileVersions,
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const dir = path.join(workspacePath, 'store', 'classification');
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(manifest));
  for (const [name, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  upsertConfigSnapshot(WS_ID, { ...bundle, manifest });
});

function evidence(id: string, runId: string, sku: string, field: string | null, value: string): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'official_product_page', reliability: 'high', sourceUrl: null,
    sourceField: field, snippet: value, value,
    metadata: {}, capturedAt: new Date().toISOString(),
  } as ClassificationEvidence;
}

async function runAttrPass(sku: string, texts: string[]) {
  const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
  if (authority.kind !== 'v2') throw new Error('expected active v2 authority');
  const bundle: any = authority.bundle;
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: sku,
    authority,
    configSnapshotRef: { id: 'test-ref', hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: new Date().toISOString() },
    sourceProductHash: null,
  });
  const persisted = persistRuntimeSnapshot(snapshot);
  const run = createRepositoryRun(WS_ID, sku, persisted.id, snapshot.snapshotHash, { sourceKind: 'onboarding' });
  const runId = run.id;
  const ev = texts.map((text, i) => evidence(`ev-${sku}-${i}`, runId, sku, 'description', text));
  // Seed input evidence under the run so fail-closed linkage passes.
  {
    const { getDb } = await import('../../db/connection');
    const db = getDb();
    const now = new Date().toISOString();
    for (const e of ev) {
      db.run(
        `INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_url, source_field, snippet, value_json, metadata_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        [e.id, runId, sku, e.stageName, e.source, e.reliability, e.sourceField, e.snippet, JSON.stringify(e.value ?? null), JSON.stringify((e as any).metadata ?? {}), now],
      );
    }
  }
  const context: any = {
    workspacePath, workspaceId: WS_ID, runId,
    configSnapshotRef: snapshot.configSnapshotRef,
    snapshot,
  };
  return runPipeline(
    [primaryProductTypeStage, attributeApplicabilityStage, productAttributeProposalsStage],
    context,
    { sku, evidence: ev, acceptedProposals: [], allProposals: [] },
  );
}

describe('provisional classification drives attributes in one pass (issue #352)', () => {
  it('pending pair proposal unlocks the applicable flavor attribute in the same pass', async () => {
    const result = await runAttrPass('SKU-FLAVOR', ['Dry Dog Food chicken kibble, flavor Chicken']);
    const pair = result.proposals.find(p => p.proposalType === 'product_classification');
    expect(pair).toBeDefined();
    expect(pair!.status).toBe('pending');
    const flavor = result.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor');
    expect(flavor).toBeDefined();
  });

  it('no pair at all withholds type-gated attributes (fail closed)', async () => {
    const result = await runAttrPass('SKU-NONE', []);
    expect(result.proposals.find(p => p.proposalType === 'product_classification')).toBeUndefined();
    expect(result.proposals.filter(p => p.proposalType === 'field_assignment')).toHaveLength(0);
  });
});

describe('provisional first pass flows without a redundant second decision (issues #352 + #354)', () => {
  it('accepting the unchanged provisional pair needs no second pair decision; rejecting it stales first-pass dependents', async () => {
    const sku = 'SKU-FIRST-PASS';
    const { getDb } = await import('../../db/connection');
    const { submitProposalDecisions } = await import('../../classification/proposal-review-service');
    const { getProposalsByRun } = await import('../../db/repositories/classification-run-repo');
    const { getPendingRefreshCount } = await import('../../db/repositories/classification-refresh-repo');
    const db = getDb();

    // First pass: provisional pair + dependent flavor proposal, same run, persisted.
    const pass = await runAttrPass(sku, ['Dry Dog Food chicken kibble, flavor Chicken']);
    const pair = pass.proposals.find(p => p.proposalType === 'product_classification');
    if (!pair) throw new Error('first pass produced no provisional pair');
    const flavor = pass.proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor');
    if (!flavor) throw new Error('first pass produced no dependent flavor proposal');
    const runId = (pair as { runId: string }).runId;
    db.run(`UPDATE classification_runs SET status = 'completed', source_kind = 'catalog_product' WHERE id = ?`, [runId]);

    // Accept the UNCHANGED provisional pair plus its first-pass dependent in
    // one request: no redundant second pair decision is forced.
    const accept = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: pair.id, decision: 'accepted' },
        { proposalId: flavor.id, decision: 'accepted' },
      ],
    });
    if (!accept.ok) throw new Error(`unchanged accept failed: ${accept.reason ?? accept.code}`);
    expect(accept.refreshRequired).toBe(false);
    const afterAccept = getProposalsByRun(runId);
    expect(afterAccept.find(p => p.id === flavor.id)?.status).toBe('accepted');
    expect(getPendingRefreshCount(WS_ID)).toBe(0);

    // Reject the pair: the first-pass dependent stales and a refresh is
    // queued for new review — invalidation before application (#354). (A
    // same-value re-accept is correctly a no-op and would not stale.)
    const pairDecisionId = accept.decisions.find(d => d.proposalId === pair.id)?.id;
    if (!pairDecisionId) throw new Error('pair decision id missing');
    const correct = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId, sourceKind: 'catalog_product',
      decisions: [{ proposalId: pair.id, decision: 'rejected', expectedRevisionId: pairDecisionId }],
    });
    expect(correct.ok).toBe(true);
    const afterCorrect = getProposalsByRun(runId);
    expect(afterCorrect.find(p => p.id === flavor.id)?.status).toBe('stale');
    // A rejection clears the pair (no corrected pair to refresh from), so no
    // dependent refresh is queued; a CHANGED pair (different type) would queue
    // one — covered by the #354 readiness-invalidation seam.
    expect(getPendingRefreshCount(WS_ID)).toBe(0);
  });
});
