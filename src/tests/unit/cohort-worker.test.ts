import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
  updateItemCurationData,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortById,
  getCohortMembers,
} from '../../db/repositories/curation-cohort-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCurrentCohortRun,
  listCohortRunsByCohort,
  cancelFreezingRun,
  reclaimExpiredCohortRuns,
  getCohortSnapshotByHash,
  writeExecutionProductType,
  listDependenciesForProposal,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { saveClassificationConfig, loadClassificationConfig, loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { syncConfigToCache, createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { freezeCohortForExecution, verifyCohortRunFrozen } from '../../onboarding/cohort-curation/freeze';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import { MemberCommitCrashSimulationError } from '../../onboarding/cohort-curation/members';
import { observeCohortShadowTypeResolution } from '../../onboarding/cohort-curation/index';
import { buildFrozenProductLineContext } from '../../onboarding/cohort-curation/frozen-evidence';
import { computeOcrExecutionDigest } from '../../classification/runtime-snapshot';
import { executeViaSeam } from './helpers/cohort-curation-harness';
import type { PreparedCohortContext } from './helpers/transitional-prepared-member';
import { curateTransitionalPreparedMember } from './helpers/transitional-prepared-member';
import { createCohortCuration } from '../../onboarding/cohort-curation/index';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { listCandidateCohortViews } from '../../onboarding/curation-cohort-service';
import { getRun, completeRun } from '../../db/repositories/classification-run-repo';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
  getCohortCurationFlags,
} from '../../classification/flags';
import { hashCanonicalJson } from '../../shared/stable-id';
import { createHash } from 'node:crypto';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { activeCohortSemanticFindingsForItem } from '../../classification/consistency-validator';
import { promoteItems } from '../../onboarding/draft-promoter';
import { prepareItemsForPromotion } from './helpers/seed-promotion-approval';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import {
  parseExecutionEvidenceProjection,
} from '../../shared/schemas/cohorts';
import type {
  CurationCohort,
  CohortRun,
  ExecutionEvidenceProjectionV2,
  ExecutionEvidenceProjection,
} from '../../shared/schemas/cohorts';
import { CurationCohortViewSchema } from '../../shared/schemas/cohorts';
import { computeCohortTitleInputHash } from '../../onboarding/cohort-curation/titles';
import { titleExecutionTypeAuthorityFromRun } from '../../classification/cohort-decision-authority';
import {
  getCohortTitleOutputsByRun,
  insertCohortTitleOutputsOnce,
  countCohortTitleOutputs,
  getCohortPageOutputsByRun,
  insertCohortPageOutputsOnce,
  countCohortPageOutputs,
} from '../../db/repositories/classification-cohort-output-repo';
import { getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import type { OnboardingEvent } from '../../onboarding/sse-emitter';
import * as llmClient from '../../onboarding/llm-client';
import * as cohortNameCoordinator from '../../onboarding/cohort-name-coordinator';

let workspacePath: string;

beforeAll(() => {
  // P0 taxonomy freeze: this suite exercises cohort curation which persists
  // config, so the freeze is explicitly lifted for the duration of the tests.
  setTaxonomyFreezeForTests(false);
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-worker-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  setTaxonomyFreezeForTests(true);
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});

afterEach(() => resetCohortCurationFlagsOverride());

// ─── PR6 review round 1: v1-cohort title-output seeding helper ────────────────
//
// BLOCKER 3 fix: active-cohort runs over schema-v1 member snapshots (no
// frozen model-execution plan) can no longer coordinate titles at the parent
// op — the op FAILS CLOSED before any transport rather than making a
// non-audited live call. v1-harness tests that run `processCohort` on a
// multi-member cohort therefore seed the durable `curated_title` outputs
// FIRST (with the canonical v1 T-hash), so the parent op REUSES them with
// ZERO transport. Seeded titles mirror the deterministic cohort fallback
// (frozen spreadsheet identity) the v1 legacy coordinator produced.

function loadFrozenProjectionForRun(workspaceId: string, run: CohortRun): ExecutionEvidenceProjectionV2 {
  const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
  // Central adapter: V2-first; historical V1 normalizes to official-page provenance.
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
}

/** Resolve the frozen Execution Product Type authority exactly as the parent
 *  op does: the shared builder over the ordinal-0 member's frozen runtime
 *  snapshot (matched by the run's `executionProductTypeId`). */
function resolvedExecutionTypeAuthority(
  workspaceId: string,
  run: CohortRun,
  projection: ExecutionEvidenceProjection,
): ReturnType<typeof titleExecutionTypeAuthorityFromRun> {
  const ordered = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const child = getDb().query(
    'SELECT config_snapshot_hash FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
  ).get(run.id, ordered[0]?.onboardingItemId ?? '') as { config_snapshot_hash: string } | undefined;
  const snapshot = child?.config_snapshot_hash
    ? getRuntimeSnapshotByHash(workspaceId, child.config_snapshot_hash)
    : null;
  return titleExecutionTypeAuthorityFromRun(run, snapshot);
}

function seedV1TitleOutputs(workspaceId: string, run: CohortRun): void {
  const projection = loadFrozenProjectionForRun(workspaceId, run);
  // v1 member snapshots carry no model policy and no frozen plan → the parent
  // op hashes with registry-const versions (PR13 C1: NO policy digest in the
  // hash). PR6 hardening C (P1-3): the label is part of the hashed authority —
  // resolve it through the SAME shared builder the parent op uses, or a
  // resolved-type run sees write-once drift on the seeded set.
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    executionTypeAuthority: resolvedExecutionTypeAuthority(workspaceId, run, projection),
  });
  const outputs = projection.members
    .map(member => ({
      productSku: member.productSku ?? '',
      title: cohortNameCoordinator.formatDeterministicTitle(
        member.spreadsheetIdentity.name,
        member.spreadsheetIdentity.brandHint,
      ),
      source: 'cohort_fallback' as const,
    }))
    .filter(o => o.productSku.length > 0);
  if (outputs.length === 0) return;
  insertCohortTitleOutputsOnce({ workspaceId, runId: run.id, inputHash, outputs });
}

/**
 * Minimal legacy v1 classification config with EVERY curation target disabled.
 * With no enabled targets the modular pipeline emits no `reviewable_abstention`
 * (primary_product_type/attribute/category-page stages return succeeded-empty,
 * never abstained) and the name_consolidation stage always has title signals —
 * so a fully successful member run deterministically completes as `completed`
 * (parent status assertions stay exact).
 */
const V1_CONFIG: ClassificationConfig = {
  manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '2026-08-01T12:00:00.000Z', updatedAt: '2026-08-01T12:00:00.000Z', fileVersions: {} },
  productTypes: [
    { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
  ],
  attributes: [
    { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled' as const, canonicalUnit: null, allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'], valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }, { alias: 'beef', mapsTo: 'Beef' }], visualEvidenceEligibility: 'eligible' as const, isClaim: false, isCompositionAttribute: false, group: 'Food' },
  ],
  attributeProfiles: [
    { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dry Dog Food Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
  ],
  attributeMappings: [
    { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  ],
  curationTargets: [
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: false, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: false, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: false, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
  ],
  brands: [],
  guidance: [],
  modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
  dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true, retentionDays: 90 },
};

function newWorkspace(): { workspaceId: string; workspacePath: string } {
  const workspaceId = randomUUID();
  const wsPath = path.join(workspacePath, `ws-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  saveClassificationConfig(wsPath, V1_CONFIG);
  syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));
  return { workspaceId, workspacePath: wsPath };
}

function settledExtraction(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    title: 'Original Web Title',
    brand: 'Acme',
    description: 'Original description',
    bulletPoints: ['Bullet one', 'Bullet two'],
    primaryImage: 'https://img.example.com/primary.jpg',
    additionalImages: ['https://img.example.com/alt1.jpg'],
    searchKeywords: 'kibble dog',
    customFields: { Flavor: 'Chicken' },
    fieldProvenance: { title: 'json-ld' },
    packagingTitle: 'Package OCR Title',
    packagingOcrData: {
      productName: 'Package OCR Name',
      brand: 'Acme',
      species: ['dog'],
      flavorVariety: 'Chicken',
      weight: '5 lb',
      confidenceByField: { productName: 0.95, weight: 0.8 },
      metadata: {
        imageSourceUrl: 'https://img.example.com/primary.jpg',
        model: 'test-vlm',
        extractedAt: new Date().toISOString(),
        modelCallIds: ['mock-call-1'],
      },
    },
    ocrOutcome: { status: 'succeeded', localStatus: 'succeeded', model: 'test-vlm', imageCount: 1 },
    productIntelligenceEvidence: [],
    ...overrides,
  };
}

/** ocrInputHash for the same canonical input set computeOcrInputHash uses. */
function expectedOcrInputHash(sourceUrl: string, ext: Record<string, any>): string {
  return hashCanonicalJson({
    sourceUrl,
    extractionSourceUrl: sourceUrl,
    primaryImage: ext.primaryImage ?? null,
    additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
  });
}

/** Insert the batch + items, write extraction data, form cohorts, flip ready. */
function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData: InsertItemData[] = Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
  const batchId = createBatch({ workspaceId: wsId, name: 'Worker Batch', fileName: 'worker.xlsx', totalItems: itemsData.length }).id;
  const items = insertItems(batchId, itemsData);
  for (const item of items) {
    const sourceUrl = item.sourceUrl ?? `https://brand.example.com/${item.upc}`;
    const ext: Record<string, any> = { ...extByUpc[item.upc] };
    delete ext._sourceUrl;
    delete ext._name;
    delete ext._brandHint;
    if (ext.ocrInputHash === undefined) {
      ext.ocrInputHash = expectedOcrInputHash(sourceUrl, ext);
    }
    updateItemExtractionData(item.id, JSON.stringify(ext));
    insertExtraction({
      itemId: item.id,
      sourceUrl,
      extractionDataJson: JSON.stringify(ext),
      extractionMethod: 'test',
      confidence: 1,
    });
  }
  const formed = refreshCandidateCohorts(wsId, batchId, listItemsByBatch(batchId));
  for (const cohort of formed) updateCohortStatus(cohort.id, 'ready');
  return { batchId, items: listItemsByBatch(batchId), cohorts: formed };
}

/** Await all in-flight worker promises (claim dispatch is fire-and-forget). */
async function drainWorker(worker: OnboardingWorker): Promise<void> {
  await worker.drain();
}

/** Count parent cohort runs in the workspace. */
function cohortRunCount(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_cohort_runs WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

/** True when ANY classification run for these items was created WITHOUT cohort linkage (the legacy per-item path). */
function hasLegacyPerItemRuns(itemIds: string[]): boolean {
  const placeholders = itemIds.map(() => '?').join(', ');
  const row = getDb().query(
    `SELECT COUNT(*) AS cnt FROM classification_runs
     WHERE onboarding_item_id IN (${placeholders}) AND cohort_run_id IS NULL`,
  ).get(...itemIds) as { cnt: number };
  return Number(row.cnt) > 0;
}

/** Every classification run for these items must be a cohort-linked child. */
function assertAllRunsCohortLinked(itemIds: string[]): void {
  expect(hasLegacyPerItemRuns(itemIds)).toBe(false);
}

/** Run-scoped shared-state row counts (fix 1c race assertions). */
function tableCounts(): Record<string, number> {
  const tables = [
    'classification_model_calls',
    'classification_stage_results',
    'classification_evidence',
    'classification_proposals',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = getDb().query(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
    counts[table] = Number(row.cnt);
  }
  return counts;
}

/** Total `classification_proposal_dependencies` rows for one workspace. */
function dependencyRowCount(wsId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM classification_proposal_dependencies WHERE workspace_id = ?',
  ).get(wsId) as { cnt: number };
  return Number(row.cnt);
}

/**
 * V1_CONFIG with the product_type curation target ENABLED (PR4 C4b fixtures):
 * the member pipeline then creates `primary_product_type` proposals AND the
 * freeze can resolve a coherent Execution Product Type from 'Dry Dog Food'
 * member evidence. Page/field targets stay disabled so the member pipeline
 * deterministically completes `completed` (no reviewable abstentions).
 */
const V1_CONFIG_TYPE_ENABLED: ClassificationConfig = {
  ...V1_CONFIG,
  curationTargets: V1_CONFIG.curationTargets.map(target =>
    target.id === 'test-product-type' ? { ...target, enabled: true } : target,
  ),
};

/**
 * V1_CONFIG_TYPE_ENABLED with the `test-flavor` product_field target also
 * ENABLED (PR5 fixture): under a coherent cohort Execution Product Type the
 * member pipeline additionally emits `field_assignment` (flavor) proposals.
 */
const V1_CONFIG_TYPE_AND_FIELD_ENABLED: ClassificationConfig = {
  ...V1_CONFIG,
  curationTargets: V1_CONFIG.curationTargets.map(target =>
    target.id === 'test-product-type' || target.id === 'test-flavor' ? { ...target, enabled: true } : target,
  ),
};

/** Save + cache the type-target-enabled config for one workspace. */
function saveTypeEnabledConfig(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG_TYPE_ENABLED);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/** Save + cache the type-and-field-target-enabled config for one workspace. */
function saveTypeAndFieldEnabledConfig(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG_TYPE_AND_FIELD_ENABLED);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/**
 * PR5 acceptance fixture: the product_type + flavor + color curation targets
 * are ENABLED. `color` exists in the fixture (mapped to ProductField2) but is
 * NOT in `dry-dog-food-profile` and is NOT universal — the acceptance
 * scenario proves ONLY the profile's attributes are unlocked by the Execution
 * Type (color stays `not_applicable`).
 */
const V1_CONFIG_PR5_ACCEPTANCE: ClassificationConfig = {
  ...V1_CONFIG,
  attributes: [
    ...V1_CONFIG.attributes,
    {
      id: 'color',
      name: 'Color',
      description: null,
      valueMode: 'controlled' as const,
      canonicalUnit: null,
      allowedValues: ['Red', 'Blue'],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible' as const,
      isClaim: false,
      isCompositionAttribute: false,
      group: 'Food',
    },
  ],
  attributeMappings: [
    ...V1_CONFIG.attributeMappings,
    {
      id: 'color-mapping',
      attributeId: 'color',
      catalogField: 'ProductField2',
      serialization: { format: 'direct' as const, separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    },
  ],
  curationTargets: [
    ...V1_CONFIG.curationTargets.map(target =>
      target.id === 'test-product-type' || target.id === 'test-flavor' ? { ...target, enabled: true } : target,
    ),
    {
      id: 'test-color',
      kind: 'product_field' as const,
      label: 'Test Color',
      enabled: true,
      selectionMode: 'single' as const,
      attributeId: 'color',
      catalogField: 'ProductField2',
      optionSource: 'configured' as const,
      required: false,
      mandatory: false,
      sortOrder: 3,
    },
  ],
};

/**
 * PR5 acceptance override fixture: `V1_CONFIG_PR5_ACCEPTANCE` plus a second
 * Product Type `dog-treats` with its own profile (`color` only). A reviewed
 * override seeded to `dog-treats` must outrank the cohort Execution Product
 * Type (`dry-dog-food`) end-to-end (DECISION-H precedence).
 */
const V1_CONFIG_PR5_ACCEPTANCE_OVERRIDE: ClassificationConfig = {
  ...V1_CONFIG_PR5_ACCEPTANCE,
  productTypes: [
    ...V1_CONFIG_PR5_ACCEPTANCE.productTypes,
    { id: 'dog-treats', name: 'Dog Treats', description: null, attributeProfileId: 'dog-treats-profile', oldIdAliases: [] },
  ],
  attributeProfiles: [
    ...V1_CONFIG_PR5_ACCEPTANCE.attributeProfiles,
    {
      id: 'dog-treats-profile',
      productTypeId: 'dog-treats',
      name: 'Dog Treats Profile',
      attributes: [{ attributeId: 'color', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }],
    },
  ],
};

/** Save + cache the PR5 acceptance config for one workspace. */
function savePr5AcceptanceConfig(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG_PR5_ACCEPTANCE);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/** Save + cache the PR5 acceptance override config for one workspace. */
function savePr5AcceptanceOverrideConfig(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG_PR5_ACCEPTANCE_OVERRIDE);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/**
 * Activate a verified Page import with one page and return its verified id
 * (promotion acceptance helper).
 */
function activateVerifiedPage(wsId: string, pageName: string, suffix: string): string {
  const key = `vp-${suffix}-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
  activatePageImportFromRecords({
    workspaceId: wsId,
    sourceHash: createHash('sha256').update(key).digest('hex'),
    parserFormatVersion: 'pages-xml-1',
    records: [{
      identity: { kind: 'exported_guid', key, status: 'verified' },
      name: pageName,
      parentRef: null,
      availability: 'available',
    }],
    activatedBy: 'test',
  });
  const verified = listVerifiedPageOptions(wsId).find(p => p.name === pageName);
  if (!verified) throw new Error(`verified page not created: ${pageName}`);
  return verified.id;
}

/**
 * Seed an ACCEPTED category_page proposal + decision on a child run (the
 * promotion acceptance gate requires a verified page assignment).
 */
function seedAcceptedPageProposal(wsId: string, runId: string, sku: string, pageId: string, pageName: string): void {
  const now = new Date().toISOString();
  const proposalId = `page-proposal-${runId}`;
  getDb().run(
    `INSERT OR IGNORE INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
    [proposalId, runId, sku, pageId, JSON.stringify({ pageId, pageName }), now],
  );
  getDb().run(
    `INSERT OR IGNORE INTO classification_proposal_decisions
     (id, proposal_id, decision, decision_key, created_at)
     VALUES (?, ?, 'accepted', ?, ?)`,
    [`page-decision-${runId}`, proposalId, `page-token-${runId}`, now],
  );
}

/**
 * Seed a provenance-compatible reviewed (accepted) `primary_product_type`
 * decision on a PRIOR run for one SKU under the CURRENT config (PR5
 * reviewed-override fixture). The member's freeze-built runtime snapshot then
 * carries a reviewed type fact that outranks the cohort Execution Product
 * Type (reviewed-first, DECISION-H).
 */
function seedReviewedTypeDecision(
  wsId: string,
  wsPath: string,
  sku: string,
  itemId: string,
  typeId: string,
): void {
  const { hash } = createConfigSnapshot(wsId, loadClassificationConfig(wsPath));
  const now = new Date().toISOString();
  // Item ids are unique per test (randomUUID) — deterministic ids derived from
  // them never collide across workspaces sharing one database file.
  const runId = `prior-type-run-${itemId}`;
  const proposalId = `prior-type-proposal-${itemId}`;
  getDb().run(
    `INSERT INTO classification_runs
     (id, workspace_id, onboarding_item_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
     VALUES (?, ?, ?, ?, 'onboarding', ?, 'completed', ?)`,
    [runId, wsId, itemId, sku, hash, now],
  );
  getDb().run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'primary_product_type', ?, ?, 0.95, 'accepted', ?)`,
    [proposalId, runId, sku, typeId, JSON.stringify({ productTypeId: typeId }), now],
  );
  getDb().run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at, decision_origin)
     VALUES (?, ?, 'accepted', ?, ?, ?, NULL, 'human_review')`,
    [`prior-type-decision-${itemId}`, proposalId, JSON.stringify({ productTypeId: typeId }), typeId, now],
  );
}

describe('OnboardingWorker Curation cohort integration (issue #30, PR3 M3)', () => {
  it('flag OFF: poll claims per-item curation exactly as today — no cohort runs are ever created', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // The per-item Curation path claimed + curated each item (legacy runs,
    // no cohort linkage), and NO cohort run row exists.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stage).toBe('curation');
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
      // PR9 (issue #30, DECISION-A): the semanticValidation key is written
      // ONLY by processCohort (active cohort mode) — a flag-OFF legacy run
      // must never carry it (byte-identical curationData).
      expect((stored.curationData as Record<string, unknown>).semanticValidation).toBeUndefined();
    }
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(hasLegacyPerItemRuns(items.map(i => i.id))).toBe(true);
  });

  it('flag ON: poll claims ready cohorts (freezing rows + lease), freezes, executes, completes — zero per-item curation claims', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // PR6 review BLOCKER 3: this v1 harness has no frozen model-execution
    // plan, so the parent title op fails closed instead of making a
    // non-audited call. Seed the durable `curated_title` outputs when the
    // worker dispatches the run — the parent op then REUSES them (zero
    // transport) and the worker-driven claim/freeze/execute flow is unchanged.
    const titlesModule = await import('../../onboarding/cohort-curation/titles');
    const originalEnsureTitles = titlesModule.ensureCohortTitles;
    const titlesSpy = vi.spyOn(titlesModule, 'ensureCohortTitles').mockImplementation(async (params: any) => {
      seedV1TitleOutputs(workspaceId, params.run);
      return originalEnsureTitles(params);
    });
    try {
      const worker = new OnboardingWorker(workspaceId, wsPath);
      await worker.poll();
      await drainWorker(worker);
    } finally {
      titlesSpy.mockRestore();
    }

    // Exactly one cohort run row, terminal with a valid completion status.
    const runs = getDb().query(
      'SELECT * FROM classification_cohort_runs WHERE workspace_id = ?',
    ).all(workspaceId) as Array<Record<string, any>>;
    expect(runs.length).toBe(1);
    const run = getCohortRunById(String(runs[0].id))!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(run.status);
    expect(run.status).not.toBe('failed');
    expect(run.claimedBy).not.toBeNull();
    expect(run.claimedAt).not.toBeNull();
    expect(run.leaseExpiresAt).not.toBeNull();
    expect(run.startedAt).not.toBeNull();

    // Members were executed through the cohort path and advanced to completed.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    // The per-item Curation claim was NEVER invoked: every run for these
    // items is a cohort-linked child (freeze-created), none legacy.
    assertAllRunsCohortLinked(items.map(i => i.id));
  });

  it('flag ON + shadowOnly: no cohort claiming at all — the legacy per-item path stays in place', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Shadow observes only: no cohort run rows, items curated via the legacy
    // per-item path (runs without cohort linkage).
    expect(cohortRunCount(workspaceId)).toBe(0);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData).not.toBeNull();
    }
    expect(hasLegacyPerItemRuns(items.map(i => i.id))).toBe(true);
  });

  it('completed run is NOT re-claimed while the frozen world matches; evidence drift supersedes it and a fresh run replaces it', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(1);
    const firstRun = getCurrentCohortRun(firstCohortId(workspaceId))!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(firstRun.status);

    // A second poll with an unchanged world: the terminal run is the current
    // historical decision — reconcile keeps it, the claim is blocked.
    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(1);
    expect(getCohortRunById(firstRun.id)!.status).toBe(firstRun.status);

    // Mutate extraction evidence → the next poll reconciles drift, supersedes
    // the old run and claims a FRESH run that executes the new state.
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, brand: 'CHANGED BRAND' }));
    getDb().run("UPDATE onboarding_items SET stage = 'curation', stage_status = 'pending' WHERE id = ?", [items[0].id]);

    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(2);
    const history = listCohortRunsByCohort(firstRun.cohortId);
    expect(history.length).toBe(2);
    const oldRun = history.find(r => r.id === firstRun.id)!;
    expect(oldRun.status).toBe('superseded');
    expect(oldRun.errorMessage).toContain('pre-claim reconciliation');
    const newRun = history.find(r => r.id !== firstRun.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(newRun.status);
    // The fresh run executed against the mutated evidence.
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });

  it('reclaim in poll (match): an expired freezing lease resumes the SAME run id, then freezes + executes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // A previous (crashed) worker claimed the cohort and died mid-freeze.
    const [claimed] = claimReadyCurationCohorts(workspaceId, 10, 'crashed-worker', COHORT_LEASE_TTL_MS);
    expect(claimed.status).toBe('freezing');
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', claimed.id]);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // Reclaim resumed the SAME run (never a new claim), and it executed.
    expect(cohortRunCount(workspaceId)).toBe(1);
    const resumed = getCohortRunById(claimed.id)!;
    expect(resumed.status).toBe('completed');
    expect(resumed.claimedBy).not.toBe('crashed-worker');
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });

  it('reclaim in poll (drift): an expired lease whose frozen world changed is superseded, then a fresh run is claimed and executes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // A previous worker claimed AND froze the run, then crashed mid-execution.
    const [claimed] = claimReadyCurationCohorts(workspaceId, 10, 'crashed-worker', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(claimed, wsPath, workspaceId);
    expect(frozen.status).toBe('running');
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', frozen.id]);

    // The world moved on while the owner was down → drift.
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, title: 'MUTATED WHILE DOWN' }));
    expect(verifyCohortRunFrozen(frozen, wsPath, workspaceId)).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    const history = listCohortRunsByCohort(frozen.cohortId);
    expect(history.length).toBe(2);
    expect(history.find(r => r.id === frozen.id)!.status).toBe('superseded');
    const fresh = history.find(r => r.id !== frozen.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(fresh.status);
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });

  it('R5: a cancelled pre-freeze run is superseded on the next poll (retryable terminal) so the slot reopens', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // A previous worker claimed the cohort and cancelled the freezing run
    // (e.g. a freeze that could never finalize). The cancelled run still holds
    // the current-run slot — it is NOT a vacuous match for reclaim.
    const [claimed] = claimReadyCurationCohorts(workspaceId, 10, 'crashed-worker', COHORT_LEASE_TTL_MS);
    expect(cancelFreezingRun(claimed.id, 'Freeze could never finalize')).toBe(true);
    const cancelled = getCohortRunById(claimed.id)!;
    expect(verifyCohortRunFrozen(cancelled, wsPath, workspaceId)).toBe(false);

    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);

    // The reconcile path treated the cancelled run as retryable: superseded,
    // then a fresh run was claimed + executed.
    const history = listCohortRunsByCohort(cancelled.cohortId);
    expect(history.length).toBe(2);
    const oldRun = history.find(r => r.id === cancelled.id)!;
    expect(oldRun.status).toBe('superseded');
    expect(oldRun.errorMessage).toContain('Cancelled run retry');
    const fresh = history.find(r => r.id !== cancelled.id)!;
    expect(['completed', 'completed_with_abstentions', 'completed_with_member_failures']).toContain(fresh.status);
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
  });
});

describe('processCohort completion semantics (issue #30, PR3 M3)', () => {
  it('all members ok -> parent completes with completed; every item advances', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);
    expect(summary.memberCount).toBe(2);
    expect(summary.memberFailures).toEqual([]);

    const completed = getCohortRunById(finalized.id)!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const curationData = stored.curationData;
      expect(curationData).not.toBeNull();
      expect(curationData!.curatedTitle).not.toBeNull();
    }
  });

  it('member failure -> parent completes with completed_with_member_failures; surviving members still commit', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Sabotage ONE NON-ordinal-0 member's frozen child snapshot ref so its
    // prepared-cohort context cannot be rebuilt — a deterministic member-level
    // failure. (The ordinal-0 member's snapshot is the parent title op's
    // frozen audit authority — BLOCKER 3 — so it is never sabotaged.)
    const sabotaged = items[1].id;
    getDb().run(
      'UPDATE classification_runs SET config_snapshot_hash = ? WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ['deadbeef'.repeat(8), finalized.id, sabotaged],
    );

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(1);
    expect(summary.memberFailures.length).toBe(1);
    expect(summary.memberFailures[0].itemId).toBe(sabotaged);
    expect(summary.memberFailures[0].error).toContain('frozen member runtime snapshot');

    const completed = getCohortRunById(finalized.id)!;
    expect(completed.status).toBe('completed_with_member_failures');
    expect(completed.errorMessage).toContain('1 member(s) failed');

    // The failed member is deterministic-failed in Curation (user reset to
    // retry); the surviving member committed fully.
    expect(findItemById(sabotaged)!.stageStatus).toBe('failed');
    const survivor = findItemById(items[0].id)!;
    expect(survivor.stageStatus).toBe('completed');
    expect(survivor.curationData).not.toBeNull();
  });

  it('cohort-level unreachable state -> parent completes with failed + error_message (write-once)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // The frozen execution-evidence contract disappears → the cohort-level
    // semantic state is unreachable: parent completes `failed` with a reason.
    // (The snapshot row itself is FK-referenced, so the run's hash is repointed
    // at a snapshot that does not exist instead of deleting the row.)
    getDb().run('UPDATE classification_cohort_runs SET evidence_snapshot_hash = ? WHERE id = ?', ['f'.repeat(64), finalized.id]);
    const unreachable = getCohortRunById(finalized.id)!;
    await expect(executeViaSeam(wsPath, workspaceId, unreachable.id, 'worker-a')).rejects.toThrow(/no persisted execution-evidence snapshot/);
    const failed = getCohortRunById(finalized.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.completedAt).not.toBeNull();
    expect(failed.errorMessage).toContain('no persisted execution-evidence snapshot');

    // Write-once: the terminal failure is never overwritten by a later completion.
    const { completeCohortRun } = await import('../../db/repositories/classification-cohort-run-repo');
    expect(completeCohortRun(finalized.id, 'completed')).toBe(false);
    expect(getCohortRunById(finalized.id)!.status).toBe('failed');
  });
});

describe('processCohort heartbeat hardening (issue #30, PR3 hardening Commit A)', () => {
  it('A2: ownership lost MID-FLIGHT (sibling reclaim while the member pipeline is in flight) aborts with HeartbeatLostError, NO post-loss writes, and the new owner\'s run stays active', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Ownership changes MID-FLIGHT: the member pipeline is a long-awaited op
    // and the seam fires INSIDE it (the pipeline is actually in flight) — the
    // lease is expired and a sibling worker reclaims the run, exactly like a
    // real slow-call concurrent reclaim.
    let reclaimed = false;
    // Run-scoped shared state snapshot AT the reclaim instant (fix 1c): after
    // the abort the stale owner must not have added/updated a single row in
    // the pipeline's persistence tables.
    let tablesAtReclaim: Record<string, number> = {};
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      onPipelineInFlight: () => {
        if (reclaimed) return;
        reclaimed = true;
        getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
        const reclaim = reclaimExpiredCohortRuns(
          workspaceId,
          new Date().toISOString(),
          () => 'match',
          'sibling-worker',
          COHORT_LEASE_TTL_MS,
        );
        expect(reclaim.resumed.length).toBe(1);
        expect(reclaim.resumed[0].id).toBe(finalized.id);
        // Snapshot the persistence tables the moment ownership moved.
        tablesAtReclaim = tableCounts();
      },
    })).rejects.toBeInstanceOf(HeartbeatLostError);
    expect(reclaimed).toBe(true);

    // Fix 1c: the stale owner never persisted run-scoped shared state after
    // the reclaim — model calls / stage results / evidence / proposals are
    // row-count-identical to the reclaim instant.
    expect(tableCounts()).toEqual(tablesAtReclaim);

    // The new owner's run remains ACTIVE (status running, claimed_by the
    // sibling): the stale abort path wrote NO terminal state onto it.
    const parent = getCohortRunById(finalized.id)!;
    expect(parent.status).toBe('running');
    expect(parent.claimedBy).toBe('sibling-worker');
    expect(parent.completedAt).toBeNull();

    // No post-loss writes by the stale owner: the item was not completed and
    // carries no curation data; the child run was left untouched (still
    // running — never failed/completed by the stale owner).
    const item = findItemById(items[0].id)!;
    expect(item.stageStatus).not.toBe('completed');
    expect(item.curationData).toBeNull();
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
    ).get(finalized.id, items[0].id, 'running') as Record<string, any> | undefined;
    expect(child).toBeTruthy();
  });
});

/** The single cohort formed for the (singleton) batch. */
function firstCohortId(workspaceId: string): string {
  const row = getDb().query(
    'SELECT id FROM curation_cohorts WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
  ).get(workspaceId) as { id: string } | undefined;
  if (!row) throw new Error('no cohort formed');
  return row.id;
}

describe('PR3 hardening — Commit B (R2 frozen execution purity, end-to-end)', () => {
  it('R2: post-freeze mutations of name, brand_hint, product_pages and evidence attempts do not affect cohort execution', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // The frozen spreadsheet names contain 'chew' — in legacy mode the live
    // product_pages fallback would suggest the matching store page. Cohort
    // mode must NEVER consult the mutable page_index after freeze.
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Chew Treats Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Chew Treats Beef 10 lb' }),
    });

    // Fix 6: a REAL linked evidence attempt — created and LINKED to member A
    // BEFORE the freeze (item.sourcingDecision.acceptedEvidenceAttemptIds
    // references it), so the frozen projection carries the reference and the
    // live-attempt gates have a genuinely consumable attempt if they regress.
    const attemptId = randomUUID();
    getDb().run(
      `INSERT INTO onboarding_evidence_attempts (id, item_id, provider_id, lookup_upc, outcome, confidence, matched_fields_json, identity_json, created_at)
       VALUES (?, ?, 'provider-x', ?, 'found', 0.9, '[]', ?, ?)`,
      [attemptId, items[0].id, items[0].upc, JSON.stringify({ description: 'SENTINEL DISTRIBUTOR COPY', images: ['https://sentinel.example.com/primary.png'] }), new Date().toISOString()],
    );
    getDb().run(
      'UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?',
      [JSON.stringify({
        route: 'bundle_to_curation',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: [attemptId],
        providerIds: ['provider-x'],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      }), items[0].id],
    );

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // MUTATE the live world AFTER the freeze:
    const a = findItemById(items[0].id)!;
    getDb().run(
      'UPDATE onboarding_items SET name = ?, brand_hint = ?, source_url = ? WHERE id = ?',
      ['MUTATED NAME A', 'MUTATED BRAND', 'https://brand.example.com/mutated-a', a.id],
    );
    const b = findItemById(items[1].id)!;
    const mutatedSibling = JSON.parse(JSON.stringify(b.extractionData));
    mutatedSibling.title = 'MUTATED SIBLING TITLE';
    mutatedSibling.description = 'MUTATED SIBLING DESC';
    mutatedSibling.brand = 'MUTATED SIBLING BRAND';
    mutatedSibling.packagingOcrData = { ...mutatedSibling.packagingOcrData, productName: 'MUTATED SIBLING OCR' };
    updateItemExtractionData(b.id, JSON.stringify(mutatedSibling));
    // A live store page matching the frozen name pattern ('chew').
    getDb().run(
      "INSERT OR REPLACE INTO product_pages (product_sku, page_name, created_at) VALUES (?, ?, ?)",
      ['999999999999', 'Dog Treats Bones Bully Sticks & Natural Chews', new Date().toISOString()],
    );
    // Live distributor evidence attempts for member A (never consulted in
    // cohort mode). The LINKED attempt is mutated AFTER the freeze — its
    // sentinel copy/images must never reach curation output (fix 6).
    getDb().run(
      'UPDATE onboarding_evidence_attempts SET identity_json = ? WHERE id = ?',
      [JSON.stringify({
        description: 'POST-FREEZE SENTINEL COPY',
        images: ['https://sentinel.example.com/post-freeze.png'],
      }), attemptId],
    );

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const storedA = findItemById(a.id)!;
    expect(storedA.stageStatus).toBe('completed');
    // Title from FROZEN spreadsheet identity (deterministic cohort fallback —
    // no LLM configured in the fixture) — never the mutated live name/brand.
    expect(storedA.curationData!.curatedTitle).not.toContain('MUTATED NAME');
    expect(storedA.curationData!.curatedTitle).not.toContain('MUTATED BRAND');
    expect(storedA.curationData!.curatedTitle).toContain('Chew Treats');
    // Evidence built from the frozen projection only (frozen spreadsheet name
    // + frozen web title) — the live mutations are absent.
    const nameValues = storedA.curationData!.classificationEvidence
      .filter(e => e.sourceField === 'name')
      .map(e => String(e.value));
    expect(nameValues.some(v => v.includes('MUTATED'))).toBe(false);
    expect(nameValues.some(v => v === 'Original Web Title')).toBe(true);
    // The live product_pages fallback was NOT consulted: the frozen names
    // contain 'chew' and the page exists, but cohort mode uses ONLY the frozen
    // verifiedPageIds (none in this fixture).
    expect(storedA.curationData!.suggestedPages).not.toContain('Dog Treats Bones Bully Sticks & Natural Chews');
    // The LINKED distributor-attempt rows were never consulted: no distributor
    // copy consolidation in cohort mode → curatedDescription stays null and
    // the sentinel copy/images (mutated AFTER the freeze) never reach any
    // curation output.
    expect(storedA.curationData!.curatedDescription).toBeNull();
    const curationJsonA = JSON.stringify(storedA.curationData);
    expect(curationJsonA).not.toContain('SENTINEL');
    expect(curationJsonA).not.toContain('sentinel.example.com');
    // The frozen member's extraction view keeps the projection's primaryImage
    // — a post-freeze attempt-image mutation can never backfill it.
    expect(storedA.extractionData?.primaryImage).toBe('https://img.example.com/primary.jpg');
    expect(JSON.stringify(storedA.extractionData)).not.toContain('sentinel.example.com');
    // The frozen projection captured the linked attempt id (the gate has a
    // real attempt to consume — the test is NOT vacuous).
    const snapA = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projectionA = parseExecutionEvidenceProjection(JSON.parse(snapA.payloadJson));
    const memberA = projectionA.members.find(m => m.onboardingItemId === items[0].id)!;
    expect(memberA.sourcingDecision?.acceptedEvidenceAttemptIds).toContain(attemptId);

    // Sibling B's title also comes from its own frozen identity — the mutated
    // sibling extraction never fed title coordination.
    const storedB = findItemById(b.id)!;
    expect(storedB.stageStatus).toBe('completed');
    expect(storedB.curationData!.curatedTitle).not.toContain('MUTATED');
    const bNameValues = storedB.curationData!.classificationEvidence
      .filter(e => e.sourceField === 'name')
      .map(e => String(e.value));
    expect(bNameValues.some(v => v.includes('MUTATED'))).toBe(false);
    expect(bNameValues.some(v => v === 'Original Web Title')).toBe(true);
  });
});

describe('PR3 hardening — Commit B (R3 member-projection atomic commit)', () => {
  it('R3: crash exactly between pipeline completion and member commit → reclaim re-executes the member and commits the projection atomically', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Crash EXACTLY between pipeline completion and item persistence (test
    // seam, documented test-only like beforeFinalCas).
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      afterMemberPipeline: () => {
        throw new MemberCommitCrashSimulationError('simulated crash between pipeline completion and member commit');
      },
    })).rejects.toThrow('simulated crash between pipeline completion and member commit');

    // The crash left NO projection commit and NO member-failure write: the
    // item is untouched, the child stays running, the parent stays running.
    const item = findItemById(items[0].id)!;
    expect(item.stageStatus).toBe('pending');
    expect(item.curationData).toBeNull();
    const parentAfterCrash = getCohortRunById(finalized.id)!;
    expect(parentAfterCrash.status).toBe('running');
    expect(parentAfterCrash.completedAt).toBeNull();
    const childAfterCrash = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
    ).get(finalized.id, items[0].id, 'running') as Record<string, any> | undefined;
    expect(childAfterCrash).toBeTruthy();

    // Reclaim (frozen world unchanged → match) resumes the SAME run, and the
    // re-executed member commits its projection atomically.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    expect(reclaim.resumed[0].id).toBe(finalized.id);

    const resumed = getCohortRunById(finalized.id)!;
    const summary = await executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(1);

    // The projection committed: curation data + item completed + child
    // terminal-success together, all referencing the same child run.
    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
    const childId = stored.curationData!.classificationRunId!;
    expect(childId).toBe(String(childAfterCrash!.id));
    expect(getRun(childId)!.status).toBe('completed');
    expect(getCohortRunById(finalized.id)!.status).toBe('completed');
  });

  it('R3 recovery skip rule: a terminal-success child WITHOUT a committed projection is re-executed and committed atomically', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Simulate the PRE-Commit-B crash: the old prepared mode completed the
    // child immediately after the pipeline but crashed BEFORE writing
    // curation_data_json / completing the item.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(finalized.id, items[0].id) as Record<string, any>;
    completeRun(String(child.id), 'completed');

    // Resume: the child is terminal-success BUT no committed projection exists
    // (no curation data referencing it, item not completed) → the recovery skip
    // rule does NOT apply → the member is re-executed and committed atomically
    // under a NEW child (inheriting the freeze-persisted snapshot refs).
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(1);

    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData).not.toBeNull();
    // The committed projection references a NEW child (the old terminal child
    // was never re-used for execution).
    expect(stored.curationData!.classificationRunId).not.toBe(String(child.id));
    const committedChild = getRun(stored.curationData!.classificationRunId!)!;
    expect(committedChild.status).toBe('completed');
    expect(String(committedChild.cohortRunId)).toBe(finalized.id);
    const children = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at ASC',
    ).all(finalized.id, items[0].id) as Array<Record<string, any>>;
    expect(children.length).toBe(2);
  });

  it('R3 recovery skip rule: a fully committed member (child terminal-success + matching curation data + item completed) is skipped on resume', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // Execute member 1 fully, then crash before member 2's commit (simulated
    // via the member-crash seam firing on the SECOND member's pipeline
    // completion — member 1's atomic commit already landed).
    seedV1TitleOutputs(workspaceId, finalized);
    let memberPipelines = 0;
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      afterMemberPipeline: () => {
        memberPipelines++;
        if (memberPipelines >= 2) {
          throw new MemberCommitCrashSimulationError('simulated crash after member 1 commit');
        }
      },
    })).rejects.toThrow('simulated crash after member 1 commit');
    expect(memberPipelines).toBe(2);

    // Member 1 committed fully; member 2 has no committed projection.
    const first = findItemById(items[0].id)!;
    const second = findItemById(items[1].id)!;
    expect(first.stageStatus).toBe('completed');
    expect(first.curationData).not.toBeNull();
    expect(second.stageStatus).toBe('pending');
    expect(second.curationData).toBeNull();

    // Resume the same run: member 1 is skipped by the recovery skip rule (its
    // child is terminal-success + curation data references it + item completed);
    // member 2 is re-executed and committed atomically.
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);
    const firstAfter = findItemById(items[0].id)!;
    expect(firstAfter.stageStatus).toBe('completed');
    const committed = getRun(first.curationData!.classificationRunId!)!;
    expect(['completed', 'completed_with_abstentions']).toContain(committed.status);
    expect(committed.status).not.toBe('failed');
    const secondAfter = findItemById(items[1].id)!;
    expect(secondAfter.stageStatus).toBe('completed');
    expect(secondAfter.curationData).not.toBeNull();
    // The child run for member 2 was never completed before its commit.
    const secondChild = getRun(secondAfter.curationData!.classificationRunId!)!;
    expect(['completed', 'completed_with_abstentions']).toContain(secondChild.status);
  });
});

// Issue #351: execution stamping is removed — no proposal carries an
// execution_product_type row. The commit-transaction atomicity below is
// preserved: crash-then-resume commits reviewed rows with the projection,
// and the resume path stays atomic. Reviewed stamping needs a reviewed fact,
// so the atomicity test seeds one; the rest assert zero execution rows.
describe('PR4 C4b — no execution_product_type rows; commit atomicity preserved (issue #351)', () => {
  it('coherent cohort, type target only: pair/type proposals carry ZERO type dependency rows', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'XYZPDQ Unmatchable Product Widget 99 lb' }),
      '100000000002': settledExtraction({ _name: 'XYZPDQ Unmatchable Product Widget 88 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.
    expect(finalized.productTypeOutcome).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);

    let totalProposals = 0;
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const proposals = stored.curationData!.classificationProposals;
      expect(proposals.length).toBeGreaterThan(0);
      totalProposals += proposals.length;
      for (const proposal of proposals) {
        for (const dep of listDependenciesForProposal(proposal.id)) {
          expect(dep.dependencyKind).not.toBe('execution_product_type');
        }
      }
    }
    expect(totalProposals).toBeGreaterThan(0);
  });

  it('atomicity: a crash before the member-projection commit leaves ZERO dependency rows; the resume commits the projection', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.

    // Crash EXACTLY between pipeline completion and the atomic member commit.
    await expect(executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a', {
      afterMemberPipeline: () => {
        throw new MemberCommitCrashSimulationError('simulated crash between pipeline completion and member commit');
      },
    })).rejects.toThrow('simulated crash between pipeline completion and member commit');

    expect(dependencyRowCount(workspaceId)).toBe(0);
    const item = findItemById(items[0].id)!;
    expect(item.stageStatus).toBe('pending');
    expect(item.curationData).toBeNull();

    // Reclaim + resume the same run: the re-executed member commits its
    // projection atomically (no execution rows anywhere).
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    const resumed = getCohortRunById(finalized.id)!;
    const summary = await executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const stored = findItemById(items[0].id)!;
    expect(stored.stageStatus).toBe('completed');
    expect(stored.curationData!.classificationProposals.length).toBeGreaterThan(0);
    for (const proposal of stored.curationData!.classificationProposals) {
      for (const dep of listDependenciesForProposal(proposal.id)) {
        expect(dep.dependencyKind).not.toBe('execution_product_type');
      }
    }
  });

  it('flag OFF: member runs record ZERO dependency rows even though proposals are created (byte-identical)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      const proposals = stored.curationData!.classificationProposals;
      expect(proposals.length).toBeGreaterThan(0);
      for (const proposal of proposals) {
        for (const dep of listDependenciesForProposal(proposal.id)) {
          expect(dep.dependencyKind).not.toBe('execution_product_type');
        }
      }
    }
    expect(dependencyRowCount(workspaceId)).toBe(0);
  });

  it('abstained cohort: no execution type -> no dependency rows and no execution rows anywhere', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'XYZPDQ Unmatchable Product Widget 99 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      for (const proposal of stored.curationData!.classificationProposals) {
        for (const dep of listDependenciesForProposal(proposal.id)) {
          expect(dep.dependencyKind).not.toBe('execution_product_type');
        }
      }
    }
    expect(dependencyRowCount(workspaceId)).toBe(0);
  });
});

// PR5 (issue #30): executor-side effective type + execution-source-only
// dependency stamping (DECISION-H) + effectiveProductType in curation data
// (DECISION-J).
describe('PR5 C3 — executor-side effective type + dependency-stamping refinement (issue #30)', () => {
  // Issue #351: no execution-type fallback exists. Members resolve from
  // their OWN reviewed pair or to none; no proposal carries an execution
  // row anywhere. Type-gated attributes propose only under a reviewed pair.
  it('SKU-local cohort: no proposal carries an execution_product_type row', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      for (const proposal of stored.curationData!.classificationProposals) {
        for (const dep of listDependenciesForProposal(proposal.id)) {
          expect(dep.dependencyKind).not.toBe('execution_product_type');
        }
      }
    }
  });

  it('reviewed-override member: field_assignment proposals carry reviewed_product_type rows; the sibling without reviewed facts carries no execution rows', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    // Member 1 gets a provenance-compatible reviewed type fact — reviewed-first
    // precedence applies at the member; the freeze itself writes no type.
    seedReviewedTypeDecision(workspaceId, wsPath, items[0].upc, items[0].id, 'dry-dog-food');
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    const reviewedMember = findItemById(items[0].id)!;
    expect(reviewedMember.stageStatus).toBe('completed');
    expect(reviewedMember.curationData!.effectiveProductType).toEqual({ id: 'dry-dog-food', source: 'reviewed' });
    const reviewedProposals = reviewedMember.curationData!.classificationProposals;
    expect(reviewedProposals.length).toBeGreaterThan(0);
    const reviewedFieldAssignments = reviewedProposals.filter(p => p.proposalType === 'field_assignment');
    expect(reviewedFieldAssignments.length).toBeGreaterThan(0);
    // PR5 hardening (P2): the reviewed-driven member's field_assignment
    // proposals carry a reviewed_product_type row — target = the reviewed id
    // (reviewed-first resolution, so the effective id IS the reviewed id),
    // value hash = hashCanonicalJson({reviewedProductTypeId}) — and NEVER an
    // execution_product_type row; primary_product_type proposals stay
    // unstamped in both cases.
    const reviewedHash = hashCanonicalJson({ reviewedProductTypeId: 'dry-dog-food' });
    for (const proposal of reviewedProposals) {
      const deps = listDependenciesForProposal(proposal.id);
      const executionDeps = deps.filter(d => d.dependencyKind === 'execution_product_type');
      expect(executionDeps).toHaveLength(0);
      if (proposal.proposalType === 'field_assignment') {
        expect(deps).toHaveLength(1);
        expect(deps[0].dependencyKind).toBe('reviewed_product_type');
        expect(deps[0].dependencyTargetId).toBe('dry-dog-food');
        expect(deps[0].dependencyValueHash).toBe(reviewedHash);
      } else {
        expect(deps).toHaveLength(0);
      }
    }

    const siblingMember = findItemById(items[1].id)!;
    expect(siblingMember.stageStatus).toBe('completed');
    // The sibling carries no reviewed fact and inherits nothing — its
    // effective type is none and its proposals carry no execution rows.
    for (const proposal of siblingMember.curationData!.classificationProposals) {
      for (const dep of listDependenciesForProposal(proposal.id)) {
        expect(dep.dependencyKind).not.toBe('execution_product_type');
      }
    }
    // Rows exist only for the reviewed member's field_assignment proposals —
    // one per field_assignment proposal, never per all-proposal.
    expect(dependencyRowCount(workspaceId)).toBe(reviewedFieldAssignments.length);
  });

  it('flag OFF: no execution authority, no execution dependency rows, flavor unknown, effective source none', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const proposals = stored.curationData!.classificationProposals;
      // The enabled type target still produced proposals, but the flavor field
      // target stays blocked: effective type is none → flavor unknown.
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
      // DECISION-J: cohort members expose the effective type even without an
      // execution type — here a `none` source (id null).
      expect(stored.curationData!.effectiveProductType).toEqual({ id: null, source: 'none' });
    }
    expect(dependencyRowCount(workspaceId)).toBe(0);
  });

  it('unmatchable members: no execution type -> no dependency rows, no flavor proposals, effective source none (issue #351)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.productTypeOutcome).toBeNull();
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeConfidence).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const proposals = stored.curationData!.classificationProposals;
      // Deterministic abstention, not "all fields": no flavor proposals.
      expect(proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
      expect(stored.curationData!.effectiveProductType).toEqual({ id: null, source: 'none' });
    }
    expect(dependencyRowCount(workspaceId)).toBe(0);
  });
});

// PR4 C5 (issue #30): shadow-mode deterministic-only resolution (DECISION-E),
// additive read-only Execution Product Type view fields, and the env-tunable
// confidence floor.
describe('PR4 C5 — shadow mode + additive view fields (issue #30)', () => {
  it('shadow: resolver computes + logs the outcome; run row, PR4 columns, deps and model calls stay untouched (no writes)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    // A run already exists (claimed + frozen under shadow flags — the C4a
    // gate skips the resolver in shadow): the observer must leave it untouched.
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const frozen = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(frozen.status).toBe('running');
    expect(frozen.executionProductTypeId).toBeNull();
    expect(frozen.productTypeConfidence).toBeNull();
    expect(frozen.productTypeOutcome).toBeNull();
    // Issue #351: membership finalizes at freeze without any type conclusion.
    expect(frozen.finalMembershipHash).toBe(run.candidateMembershipHash);

    // Issue #351: deterministic per-member SKU-local matches only — no
    // cross-member aggregation, so the cohort outcome is abstained
    // (no family conclusion) — but writes nothing.
    // PR4 review fix (SHOULD-FIX 6): the COMPLETE raw run row is captured
    // before the observation and deep-equal'd after — every column (status,
    // lease, authority hashes, timestamps, error state) is untouched, not just
    // the PR4 fields.
    const rawBefore = getDb().query(
      'SELECT * FROM classification_cohort_runs WHERE id = ?',
    ).get(run.id) as Record<string, unknown>;
    // Model-call writes are workspace/owner-agnostic rows: sibling tests in
    // this file legitimately persist audited calls, so assert a delta of zero
    // (shadow writes nothing) rather than a global zero.
    const modelCallsBefore = (getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt;
    const observations = observeCohortShadowTypeResolution(workspaceId, wsPath);
    expect(observations).toHaveLength(1);
    const observation = observations[0];
    expect(observation.cohortId).toBe(frozen.cohortId);
    expect(observation.outcome).toBe('abstained');
    expect(observation.perMember).toHaveLength(2);
    expect(observation.perMember.map(m => m.onboardingItemId).sort())
      .toEqual(items.map(i => i.id).sort());
    for (const member of observation.perMember) {
      expect(member.productTypeId).toBe('dry-dog-food');
      expect(member.source).toBe('keyword');
    }

    // Write NOTHING: the run row is untouched (ALL columns — complete raw row
    // deep-equal, not just the PR4 columns), zero dependency rows, zero model
    // calls.
    const rawAfter = getDb().query(
      'SELECT * FROM classification_cohort_runs WHERE id = ?',
    ).get(run.id) as Record<string, unknown>;
    expect(rawAfter).toEqual(rawBefore);
    const after = getCohortRunById(run.id)!;
    expect(after.executionProductTypeId).toBeNull();
    expect(after.productTypeConfidence).toBeNull();
    expect(after.productTypeOutcome).toBeNull();
    // Issue #351: membership finalizes at freeze (no type conclusion needed).
    expect(after.finalMembershipHash).toBe(run.candidateMembershipHash);
    expect(dependencyRowCount(workspaceId)).toBe(0);
    const modelCalls = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(modelCalls.cnt)).toBe(Number(modelCallsBefore));
  });

  it('shadow: worker poll runs the deterministic-only observer and logs one cohort_product_type_shadow line (no runs, no deps, no model calls)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeEnabledConfig(workspaceId, wsPath);
    createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    // Same delta rationale as the resolver test above: sibling tests persist
    // audited model calls, so the shadow's no-write property is a delta.
    const modelCallsBefore = (getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capturedLogs: string[] = [];
    try {
      const worker = new OnboardingWorker(workspaceId, wsPath);
      await worker.poll();
      await drainWorker(worker);
      // Read the mock call history BEFORE mockRestore() clears it.
      for (const args of logSpy.mock.calls) capturedLogs.push(String(args[0]));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // Exactly one structured shadow line: cohort id + outcome + per-member
    // ids/sources. (Deduped per cohort — a second poll emits nothing new.)
    const shadowLines = capturedLogs.filter(line => line.includes('cohort_product_type_shadow:'));
    expect(shadowLines).toHaveLength(1);
    expect(shadowLines[0]).toContain('cohort=');
    // Issue #351: per-member matches without family aggregation → abstained outcome.
    expect(shadowLines[0]).toContain('outcome=abstained');
    expect(shadowLines[0]).toContain('members=[');
    expect(shadowLines[0]).toContain('dry-dog-food@keyword');

    // Shadow still writes NOTHING and PR3 semantics hold: no cohort run rows
    // are created, the legacy per-item path stays in place (deps only ever
    // come from cohort execution with a written type — none here), and the
    // deterministic pipeline made zero model calls.
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(dependencyRowCount(workspaceId)).toBe(0);
    const modelCalls = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(modelCalls.cnt)).toBe(Number(modelCallsBefore));
  });

  it('PR12 R1: shadow REJECTS stale persisted OCR — a non-null OLD execution digest never influences the shadow resolution (read-only, byte-equivalent extraction); a MATCHING digest may participate read-only', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Config with BOTH dog + cat types so OCR species can change the outcome.
    const twoTypeConfig: ClassificationConfig = {
      ...V1_CONFIG,
      productTypes: [
        { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
        { id: 'dry-cat-food', name: 'Dry Cat Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
      ],
      curationTargets: V1_CONFIG.curationTargets.map(target =>
        target.id === 'test-product-type' ? { ...target, enabled: true } : target,
      ),
    };
    saveClassificationConfig(wsPath, twoTypeConfig);
    syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));

    // Member name implies DOG; its persisted OCR species ['cat'] implies CAT
    // — but the OCR carries a NON-NULL STALE execution digest (computed under
    // an older authority). `createReadyCohort` auto-fills `ocrInputHash` to
    // match the current images, so the ONLY thing standing between this OCR
    // and the shadow evidence is the execution-authority digest.
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({
        _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb',
        packagingOcrData: {
          ...settledExtraction().packagingOcrData,
          productName: 'Purina Cat Chow',
          species: ['cat'],
        },
        ocrExecutionDigest: 'old-authority-digest',
      }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });

    const before = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const modelCallsBefore = (getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number }).cnt;
    const observations = observeCohortShadowTypeResolution(workspaceId, wsPath);

    // The stale OCR must NOT influence the shadow resolution: the member's
    // non-OCR evidence (name 'Dry Dog Food') resolves DOG.
    expect(observations.length).toBeGreaterThan(0);
    const memberObs = observations[0].perMember.find(m => m.onboardingItemId === items[0].id)!;
    expect(memberObs.productTypeId).toBe('dry-dog-food');

    // READ-ONLY: extraction_data_json byte-equivalent; zero model calls.
    const after = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    expect(after.extraction_data_json).toBe(before.extraction_data_json);
    const modelCalls = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(modelCalls.cnt)).toBe(Number(modelCallsBefore));

    // CONTROL: the SAME OCR with a MATCHING execution digest may participate
    // READ-ONLY — the shadow resolution then sees the cat OCR evidence.
    const activationContext = createRuntimeActivationContext(wsPath, workspaceId);
    const authority = loadRuntimeConfigAuthority(wsPath, activationContext);
    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: wsPath,
      productSku: items[0].upc ?? '',
      authority,
      configSnapshotRef: { id: '', hash: '', sourceCommit: null, createdAt: '' },
      sourceProductHash: '',
    });
    const currentDigest = computeOcrExecutionDigest(snapshot);
    expect(currentDigest).not.toBeNull();
    expect(currentDigest).not.toBe('old-authority-digest');
    const parsed = JSON.parse(before.extraction_data_json) as Record<string, unknown>;
    parsed.ocrExecutionDigest = currentDigest;
    getDb().run('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?', [JSON.stringify(parsed), items[0].id]);

    const withMatching = observeCohortShadowTypeResolution(workspaceId, wsPath);
    const memberWithOcr = withMatching[0].perMember.find(m => m.onboardingItemId === items[0].id)!;
    // With the OCR evidence present the species token 'cat' drives the match
    // away from dog (either cat or an abstention — never dog-only coherence).
    expect(memberWithOcr.productTypeId).not.toBe('dry-dog-food');
    // Still read-only: extraction byte-equivalent to the seeded control state.
    const afterControl = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    expect(afterControl.extraction_data_json).toBe(JSON.stringify(parsed));
  });

  it('cohort views carry additive Execution Product Type fields: null-safe without a run; freeze writes no execution type (issue #351)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeEnabledConfig(workspaceId, wsPath);
    const { cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // No run yet → the additive fields are present-but-null (absent-safe).
    const viewBefore = listCandidateCohortViews(cohort.batchId).find(v => v.cohort.id === cohort.id)!;
    expect(viewBefore.executionProductTypeId).toBeNull();
    expect(viewBefore.productTypeConfidence).toBeNull();
    expect(viewBefore.productTypeOutcome).toBeNull();
    expect(viewBefore.finalMembershipHash).toBeNull();

    // Freeze in active mode → the current run carries NO execution type
    // (issue #351); the view fields stay null-safe.
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();

    // The cohort view reflects the current run's additive fields (null-safe).
    const viewAfter = listCandidateCohortViews(cohort.batchId).find(v => v.cohort.id === cohort.id)!;
    expect(viewAfter.executionProductTypeId).toBeNull();
    expect(viewAfter.productTypeOutcome).toBeNull();
    expect(viewAfter.finalMembershipHash).toBe(run.candidateMembershipHash);
    expect(viewAfter.productTypeConfidence).toBeNull();

    // Schema-level backward compatibility: the additive fields are optional —
    // a legacy-shaped view (fields absent) still parses to undefined, and
    // present-but-null values parse to null.
    const legacyShaped = CurationCohortViewSchema.parse({
      cohort,
      members: [],
      status: 'ready',
      state: 'ready',
      blockedReason: null,
      memberCount: 1,
      readyCount: 1,
      waitingOn: [],
    });
    expect(legacyShaped.executionProductTypeId).toBeUndefined();
    expect(legacyShaped.productTypeOutcome).toBeUndefined();
    expect(legacyShaped.finalMembershipHash).toBeUndefined();
    const parsedWithNulls = CurationCohortViewSchema.parse({
      ...viewAfter,
      executionProductTypeId: null,
      productTypeOutcome: null,
      productTypeConfidence: null,
      finalMembershipHash: null,
    });
    expect(parsedWithNulls.executionProductTypeId).toBeNull();
    expect(parsedWithNulls.productTypeOutcome).toBeNull();
  });
});

// Issue #351 acceptance: SKU-local first pass without reviewed truth —
// with no execution fallback, a member without its OWN reviewed pair
// withholds type-gated attributes (fail closed); review and promotion
// authority stay on the member's own reviewed values.
describe('PR5 C4 — acceptance integration: SKU-local first pass, reviewed authority (issue #351)', () => {
  it('freeze writes no execution type; member without reviewed pair withholds flavor (fail closed); gate blocks; promotion writes no field value', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    savePr5AcceptanceConfig(workspaceId, wsPath);
    const { batchId, items } = createReadyCohort(workspaceId, {
      // Member A is used for the review-completion gate; member B carries a
      // relative primary image + price so the promotion acceptance path can
      // complete without network access.
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({
        _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb',
        price: '$24.99',
        primaryImage: 'products/images/acme/beef.jpg',
        additionalImages: [],
      }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    // (1) Freeze: no execution type is written (issue #351).
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    // Issue #351: withheld type-gated attributes surface as abstentions —
    // the parent completes with abstentions, never a silent success.
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);

    // (2) First-pass member Curation WITHOUT any reviewed type: type-gated
    // flavor withholds (fail closed) — no execution fallback fills it.
    const memberA = findItemById(items[0].id)!;
    expect(memberA.stageStatus).toBe('completed');
    const proposalsA = memberA.curationData!.classificationProposals;
    expect(proposalsA.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
    expect(proposalsA.some(p => p.proposalType === 'primary_product_type' && p.status === 'accepted')).toBe(false);
    expect(memberA.curationData!.effectiveProductType).toEqual({ id: null, source: 'none' });

    // (3) color (in the fixture, NOT universal) produces NO proposal either.
    // The applicability stage metadata records the none source.
    expect(proposalsA.some(p => p.proposalType === 'field_assignment' && p.targetId === 'color')).toBe(false);
    const applicabilityEvent = memberA.curationData!.classificationHistory.find(h => h.eventType === 'stage_attribute_applicability');
    expect(applicabilityEvent).toBeDefined();
    const applicabilityOutput = JSON.parse(String(applicabilityEvent!.eventJson.output)) as {
      metadata: { effectiveTypeSource?: string; applicability?: Array<{ attributeId: string; state: string }> };
    };
    expect(applicabilityOutput.metadata.effectiveTypeSource).toBe('none');

    // (4) Review completion gate: with no reviewed pair and no flavor
    // proposal (withheld SKU-locally), the gate blocks — the member has no
    // reviewed truth to complete on.
    const childRunIdA = memberA.curationData!.classificationRunId!;
    const gate = validateReviewCompletionGate({
      workspaceId,
      onboardingItemId: items[0].id,
      productSku: items[0].upc,
      activeRunId: childRunIdA,
    });
    expect(gate.ok).toBe(false);

    // (5) Draft promotion of the sibling:
    // 5a. Without a reviewed product type: promotion is refused (PR11 review R2 reviewed_product_type_required).
    const memberB = findItemById(items[1].id)!;
    expect(memberB.stageStatus).toBe('completed');
    const childRunIdB = memberB.curationData!.classificationRunId!;
    expect(['completed', 'completed_with_abstentions']).toContain(getRun(childRunIdB)!.status);
    const pageId = activateVerifiedPage(workspaceId, 'Dog Food', 'pr5-acceptance');
    seedAcceptedPageProposal(workspaceId, childRunIdB, items[1].upc, pageId, 'Dog Food');
    // Epic #46 review round-2: promotion requires durable approval at the final
    // authority; move the sibling into the real post-approval state so these
    // checks hit their intended Reviewed-Product-Type gate.
    prepareItemsForPromotion([{ id: items[1].id, batchId }]);
    const blockedPromote = await promoteItems(workspaceId, wsPath, batchId, [items[1].id]);
    expect(blockedPromote.failures).toHaveLength(1);
    expect(blockedPromote.failures[0].error).toContain('Reviewed Product Type');

    // 5b. With an accepted product type decision (its pending flavor proposal was never
    // accepted): flavor ProductField1 value is NOT written.
    const ptProposalB = getDb().query(
      "SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type IN ('product_classification', 'primary_product_type')",
    ).get(childRunIdB) as { id: string } | undefined;
    // Issue #351: the pair proposal exists only when the member's own evidence
    // supports one. If this member abstained on the pair, there is nothing to
    // accept and promotion stays refused (assert that instead).
    if (!ptProposalB) {
      prepareItemsForPromotion([{ id: items[1].id, batchId }]);
      const stillBlocked = await promoteItems(workspaceId, wsPath, batchId, [items[1].id]);
      expect(stillBlocked.failures).toHaveLength(1);
      return;
    }
    getDb().run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-type-${childRunIdB}`, ptProposalB.id, `token-type-${childRunIdB}`, new Date().toISOString()],
    );
    getDb().run("UPDATE classification_proposals SET status = 'accepted' WHERE id = ?", [ptProposalB.id]);

    prepareItemsForPromotion([{ id: items[1].id, batchId }]);
    const promoteResult = await promoteItems(workspaceId, wsPath, batchId, [items[1].id]);
    expect(promoteResult.failures).toEqual([]);
    expect(promoteResult.count).toBe(1);
    const changeSetItems = listChangeSetItems(promoteResult.changeSetId!);
    const drafted = JSON.parse(changeSetItems[0].draftJson) as { customFields: Record<string, string> };
    expect(drafted.customFields.ProductField1).toBeDefined();
    expect(drafted.customFields.ProductField1).not.toBe('Beef');
    expect(drafted.customFields.ProductField1).not.toBe('Chicken');
    expect(drafted.customFields.ProductField2).toBeUndefined();
    const promoHistory = getDb().query(
      `SELECT event_json FROM classification_history_events
       WHERE product_sku = ? AND event_type = 'promotion'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(items[1].upc) as { event_json: string } | undefined;
    expect(promoHistory).toBeDefined();
    expect(JSON.parse(promoHistory!.event_json).acceptedProductType).toBe('dry-dog-food');
  });

  // Issue #351: no family type invariant exists at freeze — a reviewed
  // override differing from a sibling's inference is NOT a freeze
  // conflict. Each member executes from its own evidence; the reviewed
  // member resolves under its reviewed type, siblings under their own.
  it('acceptance (issue #351): a reviewed override differing from sibling inference is not a freeze conflict — run proceeds, members execute', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    savePr5AcceptanceOverrideConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    // Member A carries a reviewed type fact for a DIFFERENT type (dog-treats)
    // while the sibling's evidence infers dry-dog-food. Under SKU-local
    // evidence this is not a conflict — each SKU stands on its own facts.
    seedReviewedTypeDecision(workspaceId, wsPath, items[0].upc, items[0].id, 'dog-treats');
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    // Both members execute — no freeze conflict blocks anyone.
    expect(summary.completedMembers).toBe(2);
  });

  it('acceptance: flag OFF + shadow variants stay byte-identical legacy (no flavor proposals, no dependency rows, no effective-type metadata)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    // Flag OFF: the worker uses the legacy per-item path — no cohort runs, no
    // flavor proposals (type-gated without a reviewed type), zero dependency
    // rows, and NO effective-type metadata in curation_data_json.
    const worker = new OnboardingWorker(workspaceId, wsPath);
    await worker.poll();
    await drainWorker(worker);
    expect(cohortRunCount(workspaceId)).toBe(0);
    expect(hasLegacyPerItemRuns(items.map(i => i.id))).toBe(true);
    expect(dependencyRowCount(workspaceId)).toBe(0);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const rawRow = getDb().query(
        'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
      ).get(item.id) as { curation_data_json: string | null };
      const raw = JSON.parse(rawRow.curation_data_json ?? '{}') as Record<string, unknown>;
      expect(raw.effectiveProductType).toBeUndefined();
      const proposals = stored.curationData!.classificationProposals;
      expect(proposals.some(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor')).toBe(false);
      expect(proposals.some(p => p.proposalType === 'field_assignment')).toBe(false);
    }

    // Shadow variant in a second workspace: same byte-identical legacy path.
    const { workspaceId: shadowWs, workspacePath: shadowPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(shadowWs, shadowPath);
    createReadyCohort(shadowWs, {
      '100000000003': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Salmon 5 lb' }),
      '100000000004': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Lamb 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });
    const shadowWorker = new OnboardingWorker(shadowWs, shadowPath);
    await shadowWorker.poll();
    await drainWorker(shadowWorker);
    expect(cohortRunCount(shadowWs)).toBe(0);
    expect(dependencyRowCount(shadowWs)).toBe(0);
    const shadowItems = getDb().query(
      `SELECT i.id, i.curation_data_json FROM onboarding_items i
       JOIN onboarding_batches b ON b.id = i.batch_id
       WHERE b.workspace_id = ?`,
    ).all(shadowWs) as Array<{ id: string; curation_data_json: string | null }>;
    expect(shadowItems.length).toBe(2);
    for (const row of shadowItems) {
      const raw = JSON.parse(row.curation_data_json ?? '{}') as Record<string, unknown>;
      expect(raw.effectiveProductType).toBeUndefined();
      const parsed = findItemById(row.id)!;
      expect(parsed.curationData!.classificationProposals.some(p => p.proposalType === 'field_assignment')).toBe(false);
    }
  });
});

describe('PR6 C5 — prepared members consume the durable parent title outputs (issue #30)', () => {
  /** Replicate the parent op's T-hash inputs in this v1 harness: v1 member
   *  snapshots carry NO modelPolicy and NO frozen model-execution plan, so the
   *  parent op hashes with `modelPolicyDigest: null` + registry-const plan
   *  versions — exactly what the seeded output rows must hash to. PR6 hardening
   *  C (P1-3): the label participates, resolved via the shared builder. */
  function expectedTitleInputHash(workspaceId: string, run: CohortRun, projection: ExecutionEvidenceProjection): string {
    return computeCohortTitleInputHash({
      run,
      projection,
      executionTypeAuthority: resolvedExecutionTypeAuthority(workspaceId, run, projection),
    });
  }

  function loadFrozenProjection(workspaceId: string, run: CohortRun): ExecutionEvidenceProjectionV2 {
    const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
    return parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
  }

  const SEEDED_TITLES = [
    ['100000000001', 'Acme Purina Pro Plan Dog Food Chicken 5 lb'],
    ['100000000002', 'Acme Purina Pro Plan Dog Food Beef 10 lb'],
  ] as const;

  /** Seed `curated_title` outputs exactly as a prior processCohort entry
   *  would have persisted them (llm_cohort + the canonical T-hash). The
   *  freshly frozen run has zero output rows, so the write-once insert
   *  succeeds (PR6 hardening A). */
  function seedCohortTitleOutputs(workspaceId: string, run: CohortRun, inputHash: string): void {
    insertCohortTitleOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash,
      outputs: SEEDED_TITLES.map(([productSku, title]) => ({
        productSku,
        title,
        source: 'llm_cohort' as const,
      })),
    });
  }

  /** Number of `callLlmForTask` invocations carrying the cohort title op. */
  function titleCallInvocationCount(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter(([, , , options]: any[]) =>
      (options as Record<string, any> | undefined)?.protectedOperation === 'cohort_title_consolidation',
    ).length;
  }

  function countTitleAuditRows(): number {
    const row = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE operation = 'cohort_title_consolidation'",
    ).get() as { cnt: number };
    return Number(row.cnt);
  }

  /** Build a prepared-cohort context for one member from the frozen run
   *  (mirrors `buildPreparedCohortContextForMember`'s inputs).
   *  `coordinatedTitles` defaults to the run's persisted durable outputs. */
  function buildPreparedContext(
    workspaceId: string,
    run: CohortRun,
    item: OnboardingItem,
    frozenLineContext: ReturnType<typeof buildFrozenProductLineContext>,
    coordinatedTitles?: Map<string, { title: string; source: 'llm_cohort' | 'cohort_fallback' }>,
  ): PreparedCohortContext {
    const snap = getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash!)!;
    // Milestone E: the persisted snapshot may be v1 (historical) or v2;
    // `parseExecutionEvidenceProjection` normalizes v1 to official-page v2.
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    const memberProjection = projection.members.find(m => m.onboardingItemId === item.id)!;
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, item.id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    return {
      memberProjection,
      parentRunId: run.id,
      memberSnapshotId: String(child.config_snapshot_id),
      memberSnapshotHash: String(child.config_snapshot_hash),
      sharedAuthorities: {
        configSnapshotRef: memberSnapshot.configSnapshotRef,
        pages: memberSnapshot.pages,
        pageImportId: memberSnapshot.pageImportId,
        pageImportHash: memberSnapshot.pageImportHash,
        fieldOptions: memberSnapshot.fieldOptions,
        focusedFileHashes: memberSnapshot.focusedFileHashes,
        catalogEvidenceHash: memberSnapshot.catalogEvidenceHash,
        // v1 harness: the frozen snapshot carries no model policy.
        modelPolicyView: null,
      },
      productLineContext: frozenLineContext.productLineContext,
      productLineItems: frozenLineContext.productLineItems,
      frozenBatchItems: frozenLineContext.frozenBatchItems,
      coordinatedTitles: coordinatedTitles ?? new Map(
        getCohortTitleOutputsByRun(run.id).map(row => [
          row.productSku,
          JSON.parse(row.outputValueJson) as { title: string; source: 'llm_cohort' | 'cohort_fallback' },
        ]),
      ),
    };
  }

  /** Freeze a ready two-member cohort under active flags (v1 harness). */
  async function freezeTwoMemberCohort(): Promise<{
    workspaceId: string;
    workspacePath: string;
    run: CohortRun;
    items: OnboardingItem[];
    projection: ExecutionEvidenceProjectionV2;
    frozenLineContext: ReturnType<typeof buildFrozenProductLineContext>;
  }> {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    const projection = loadFrozenProjection(workspaceId, finalized);
    const cohort = getCohortById(finalized.cohortId)!;
    const members = getCohortMembers(cohort.id);
    const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);
    return { workspaceId, workspacePath: wsPath, run: finalized, items, projection, frozenLineContext };
  }

  it('prepared member consumes the persisted parent title output (curatedTitle === persisted value, titleSource === llm_cohort, ZERO title LLM calls)', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, projection } = await freezeTwoMemberCohort();

    // Seed the durable outputs (complete set + matching T-hash). The parent op
    // must REUSE with zero calls; members consume the persisted titles.
    const inputHash = expectedTitleInputHash(workspaceId, run, projection);
    seedCohortTitleOutputs(workspaceId, run, inputHash);
    expect(countCohortTitleOutputs(run.id)).toBe(2);

    const titleCallSpy = vi.spyOn(llmClient, 'callLlmForTask');
    try {
      const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
      expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
      expect(summary.completedMembers).toBe(2);
    } finally {
      titleCallSpy.mockRestore();
    }

    // Both members consumed the persisted titles byte-for-byte.
    const titleByUpc = new Map<string, string>(SEEDED_TITLES.map(([upc, title]) => [upc, title]));
    for (const item of items) {
      const stored = findItemById(item.id)!;
      const expected = titleByUpc.get(item.upc)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).toBe(expected);
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
    }
    // ZERO title calls: the reuse path made no LLM invocation and the
    // short-circuited name_consolidation consumed the persisted title.
    expect(titleCallInvocationCount(titleCallSpy)).toBe(0);
    expect(countTitleAuditRows()).toBe(0);
    // The durable rows are untouched (reuse is read-only).
    expect(countCohortTitleOutputs(run.id)).toBe(2);
  });

  it('member retry via crash-recovery re-executes against the SAME persisted title with ZERO new title calls', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeTwoMemberCohort();
    const projection = loadFrozenProjection(workspaceId, run);
    const inputHash = expectedTitleInputHash(workspaceId, run, projection);
    seedCohortTitleOutputs(workspaceId, run, inputHash);

    const titleCallSpy = vi.spyOn(llmClient, 'callLlmForTask');
    try {
      // Crash EXACTLY after the SECOND member's pipeline completes (before its
      // atomic projection commit): member 1 commits, member 2 does not, and
      // the parent stays running — the durable outputs were already written by
      // the parent op before the member loop.
      let pipelineCount = 0;
      await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a', {
        afterMemberPipeline: () => {
          pipelineCount++;
          if (pipelineCount === 2) {
            throw new MemberCommitCrashSimulationError('simulated crash between pipeline completion and member commit');
          }
        },
      })).rejects.toThrow('simulated crash between pipeline completion and member commit');

      // Member 1 committed with the persisted title; member 2 untouched.
      const memberOne = findItemById(items[0].id)!;
      const memberTwo = findItemById(items[1].id)!;
      expect(memberOne.stageStatus).toBe('completed');
      expect(memberOne.curationData!.curatedTitle).toBe('Acme Purina Pro Plan Dog Food Chicken 5 lb');
      expect(memberTwo.stageStatus).toBe('pending');
      expect(memberTwo.curationData).toBeNull();

      // Kill/restart: clear the coordinator cache (prove DB authority), expire
      // the lease, reclaim with a NEW worker id — resume the SAME run via the
      // verifyCohortRunFrozen match.
      cohortNameCoordinator.clearCohortCoordinationCache();
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift',
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      expect(reclaim.resumed[0].id).toBe(run.id);

      // Resume: the parent op REUSES the durable set (zero calls). PR6 review
      // BLOCKER 2 fix: the parent op is PURE READ — it never creates a
      // replacement ordinal-0 child — so the resume guard finds the SAME
      // committed child for member 1 and SKIPS it (no re-execution, no new
      // child run). Member 2 re-executes via its still-running child. Both
      // members consume the SAME persisted titles byte-for-byte.
      const resumed = getCohortRunById(run.id)!;
      const summary = await executeViaSeam(wsPath, workspaceId, resumed.id, 'worker-b');
      expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
      expect(summary.completedMembers).toBe(2);
      const memberTwoAfter = findItemById(items[1].id)!;
      expect(memberTwoAfter.stageStatus).toBe('completed');
      expect(memberTwoAfter.curationData!.curatedTitle).toBe('Acme Purina Pro Plan Dog Food Beef 10 lb');
      expect(memberTwoAfter.curationData!.titleSource).toBe('llm_cohort');
      // ZERO new title calls across BOTH processCohort entries (the durable set
      // was complete + hash-matched on every re-entry; members never fall to a
      // per-item title LLM).
      expect(titleCallInvocationCount(titleCallSpy)).toBe(0);
      expect(countTitleAuditRows()).toBe(0);

      // Crash-recovery retry pattern on a committed member: reset it to
      // pending + clear its curation data, then re-run its pipeline in prepared
      // mode — the re-executed member consumes the SAME persisted title
      // byte-for-byte with ZERO title calls.
      updateItemStageStatus(items[1].id, 'pending');
      updateItemCurationData(items[1].id, '');
      const prepared = buildPreparedContext(workspaceId, resumed, items[1], frozenLineContext);
      const rerun = await curateTransitionalPreparedMember(findItemById(items[1].id)!, wsPath, workspaceId, prepared);
      expect(rerun.curatedTitle).toBe('Acme Purina Pro Plan Dog Food Beef 10 lb');
      expect(rerun.titleSource).toBe('llm_cohort');
      expect(titleCallInvocationCount(titleCallSpy)).toBe(0);
    } finally {
      titleCallSpy.mockRestore();
    }
  });

  it('member fails closed with a parent-defect error on a brandless durable title against author-visible brand', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, projection } = await freezeTwoMemberCohort();
    // Invalid parent output: brandless durable titles while members carry
    // Acme spreadsheet brand evidence (the pre-#108 authorship shape).
    // The member must NOT mutate the durable title to heal it — it fails
    // closed with a legible parent-defect error instead.
    insertCohortTitleOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash: expectedTitleInputHash(workspaceId, run, projection),
      outputs: [
        { productSku: '100000000001', title: 'Purina Pro Plan Dog Food Chicken 5 lb', source: 'llm_cohort' as const },
        { productSku: '100000000002', title: 'Purina Pro Plan Dog Food Beef 10 lb', source: 'llm_cohort' as const },
      ],
    });

    const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(0);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('failed');
      expect(stored.curationData).toBeNull();
    }
    const failedChild = getDb().query(
      "SELECT error_message FROM classification_runs WHERE cohort_run_id = ? AND status = 'failed' LIMIT 1",
    ).get(run.id) as { error_message: string | null };
    expect(failedChild.error_message).toMatch(/parent_defect_stale_title/);
  });

  it('PR6 hardening A+E: a committed title set under a mismatched authority SUPERSEDES the parent run, terminalizes its running children, and reopens the claim slot (drift → superseded, no re-coordination)', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeTwoMemberCohort();
    const projection = loadFrozenProjection(workspaceId, run);
    const inputHash = expectedTitleInputHash(workspaceId, run, projection);

    // A NONEMPTY committed set whose rows do NOT match the freshly computed
    // T-hash simulates the dangerous split: members would have completed under
    // outputs A while the authority changed. WRITE-ONCE means the set can never
    // be replaced — the parent op must SUPERSEDE the run (hardening E) so a
    // NEW revision can be claimed immediately, terminalizing the freeze-created
    // running children atomically.
    insertCohortTitleOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash: 'a'.repeat(64), // stale authority hash
      outputs: SEEDED_TITLES.map(([productSku, title]) => ({ productSku, title, source: 'cohort_fallback' as const })),
    });
    expect(countCohortTitleOutputs(run.id)).toBe(2);
    const seededBefore = getCohortTitleOutputsByRun(run.id);

    // The freeze created running children before the parent op — capture them.
    const childrenBefore = getDb().query(
      'SELECT id, status FROM classification_runs WHERE cohort_run_id = ?',
    ).all(run.id) as Array<{ id: string; status: string }>;
    expect(childrenBefore.length).toBeGreaterThan(0);
    expect(childrenBefore.every(c => c.status === 'running')).toBe(true);

    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a')).rejects.toThrow(/CohortTitleAuthorityDrift/);

    // The parent is SUPERSEDED (not failed) with the deterministic drift
    // message — the historical decision stays immutable.
    const terminal = getCohortRunById(run.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.supersededAt).not.toBeNull();
    expect(terminal.errorMessage).toContain('write-once');
    expect(terminal.errorMessage).toContain(inputHash);
    expect(terminal.errorMessage).toContain(run.id);

    // EVERY formerly-running child is terminal with the deterministic reason.
    for (const child of childrenBefore) {
      const after = getDb().query(
        'SELECT status, completed_at, error_message FROM classification_runs WHERE id = ?',
      ).get(child.id) as { status: string; completed_at: string | null; error_message: string | null };
      expect(after.status).toBe('failed');
      expect(after.completed_at).not.toBeNull();
      expect(after.error_message).toBe('Cohort output authority drift superseded parent run');
    }

    // Onboarding members were NOT executed — no member writes happened.
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('pending');
      expect(stored.curationData).toBeNull();
    }
    // The committed set is untouched (never replaced, never extended).
    expect(getCohortTitleOutputsByRun(run.id)).toEqual(seededBefore);

    // The claim slot REOPENED: a NEW parent revision can be claimed immediately.
    const nextRun = claimReadyCurationCohorts(workspaceId, 10, 'worker-next', COHORT_LEASE_TTL_MS);
    expect(nextRun.length).toBe(1);
    expect(nextRun[0].id).not.toBe(run.id);
  });

  it('legacy flag-OFF: coordinateCohortItemsOnce is still invoked and the cohortCache dedups the batch (spy assertions)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(getCohortCurationFlags().cohortCurationV2Enabled).toBe(false);

    const onceSpy = vi.spyOn(cohortNameCoordinator, 'coordinateCohortItemsOnce');
    const uncachedSpy = vi.spyOn(cohortNameCoordinator, 'coordinateCohortItems');
    const captured = { onceCalls: 0, uncachedCalls: 0 };
    try {
      const worker = new OnboardingWorker(workspaceId, wsPath);
      await worker.poll();
      await drainWorker(worker);
      // Capture BEFORE mockRestore() clears the mock call history.
      captured.onceCalls = onceSpy.mock.calls.length;
      captured.uncachedCalls = uncachedSpy.mock.calls.length;
    } finally {
      onceSpy.mockRestore();
      uncachedSpy.mockRestore();
    }

    // The legacy per-item path invoked the CACHED coordinator once per member…
    expect(captured.onceCalls).toBe(2);
    // …but the in-memory cohortCache deduped the underlying uncached pass:
    // exactly ONE `coordinateCohortItems` execution for the shared batch.
    expect(captured.uncachedCalls).toBe(1);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.curatedTitle).not.toBeNull();
      // The coordinator's per-group outcome (llm_cohort vs cohort_fallback)
      // depends on whether the llm-client mock from cohort-title-coordinator
      // is active in this process — the assertion that matters here is the
      // spy-based proof that the legacy coordinator + cache path ran.
      expect(['llm_cohort', 'cohort_fallback']).toContain(stored.curationData!.titleSource);
    }
    // Flag OFF: no cohort run, zero durable output rows, byte-identical legacy.
    expect(cohortRunCount(workspaceId)).toBe(0);
    const outputRows = getDb().query(
      'SELECT COUNT(*) AS cnt FROM classification_cohort_outputs WHERE workspace_id = ?',
    ).get(workspaceId) as { cnt: number };
    expect(Number(outputRows.cnt)).toBe(0);
  });

  // ─── PR7 C4/C5 (issue #30): durable parent PAGE outputs over the v1
  // harness (page target DISABLED in V1_CONFIG → the parent page op is
  // EXPECTED-EMPTY per DECISION-C: no verified pages / target disabled is NOT
  // an output; the child stage stays succeeded-empty with ZERO Page calls).

  it('PR7 C4: active cohort with the page target disabled is expected-empty — zero page rows, zero page calls, members complete with zero category_page proposals', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeTwoMemberCohort();
    const projection = loadFrozenProjection(workspaceId, run);
    // v1 snapshots carry no frozen model-execution plan → seed the durable
    // title set FIRST so the title op reuses it with zero transport (the page
    // op does NOT require a plan for the expected-empty path).
    seedCohortTitleOutputs(workspaceId, run, expectedTitleInputHash(workspaceId, run, projection));

    const titleCallSpy = vi.spyOn(llmClient, 'callLlmForTask');
    try {
      const summary = await executeViaSeam(wsPath, workspaceId, run.id, 'worker-a');
      expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
      expect(summary.completedMembers).toBe(2);
    } finally {
      titleCallSpy.mockRestore();
    }

    // DECISION-C: config-level absence is NOT an output — zero page rows.
    expect(countCohortPageOutputs(run.id)).toBe(0);
    expect(getCohortPageOutputsByRun(run.id)).toEqual([]);
    // No audited page transport rows (no group / singleton page call ran).
    const pageAuditRows = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE operation IN ('cohort_page_assignment', 'page_assignment')",
    ).get() as { cnt: number };
    expect(Number(pageAuditRows.cnt)).toBe(0);
    // Members completed with the persisted titles and NO category_page
    // proposals (the disabled target returns succeeded-empty).
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      expect(stored.curationData!.titleSource).toBe('llm_cohort');
      const pageProposals = stored.curationData!.classificationProposals.filter(
        proposal => proposal.proposalType === 'category_page',
      );
      expect(pageProposals).toHaveLength(0);
    }
  });

  it('PR7 C4 hardening: a committed page set under config-level absence is write-once corruption — the parent op throws CohortPageAuthorityDrift and the run is SUPERSEDED (no re-coordination, no page calls)', async () => {
    const { workspaceId, workspacePath: wsPath, run, items } = await freezeTwoMemberCohort();
    const projection = loadFrozenProjection(workspaceId, run);
    seedCohortTitleOutputs(workspaceId, run, expectedTitleInputHash(workspaceId, run, projection));

    // Seed `coordinated_page` rows even though the page target is disabled —
    // the expected-empty rule fails closed on ANY persisted rows (write-once
    // corruption, never silently ignored).
    const seededOutputs = projection.members
      .map(member => ({
        productSku: member.productSku ?? '',
        output: { status: 'abstained' as const, reason: 'seeded stale page output' },
      }))
      .filter(output => output.productSku.length > 0);
    insertCohortPageOutputsOnce({
      workspaceId,
      runId: run.id,
      inputHash: 'a'.repeat(64), // stale authority hash
      outputs: seededOutputs,
    });
    expect(countCohortPageOutputs(run.id)).toBe(2);

    const childrenBefore = getDb().query(
      'SELECT id, status FROM classification_runs WHERE cohort_run_id = ?',
    ).all(run.id) as Array<{ id: string; status: string }>;
    expect(childrenBefore.length).toBeGreaterThan(0);

    await expect(executeViaSeam(wsPath, workspaceId, run.id, 'worker-a')).rejects.toThrow(/CohortPageAuthorityDrift/);

    // The parent is SUPERSEDED (not failed) via the EXISTING drift primitive;
    // every running child is terminalized; no member writes happened.
    const terminal = getCohortRunById(run.id)!;
    expect(terminal.status).toBe('superseded');
    expect(terminal.errorMessage).toContain('write-once');
    expect(terminal.errorMessage).toContain(run.id);
    for (const child of childrenBefore) {
      const after = getDb().query(
        'SELECT status FROM classification_runs WHERE id = ?',
      ).get(child.id) as { status: string };
      expect(after.status).toBe('failed');
    }
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('pending');
      expect(stored.curationData).toBeNull();
    }
    // The committed page set is untouched (immutable historical truth).
    expect(getCohortPageOutputsByRun(run.id)).toHaveLength(2);
    // No audited page transport rows ran during the drift path.
    const pageAuditRows = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_model_calls WHERE operation IN ('cohort_page_assignment', 'page_assignment')",
    ).get() as { cnt: number };
    expect(Number(pageAuditRows.cnt)).toBe(0);
  });

  it('PR8 DECISION-B: a missing title output for a multi-item group member FAILS CLOSED — no deterministic fallback, no invented title, no per-item title LLM call', async () => {
    const { workspaceId, workspacePath: wsPath, run, items, frozenLineContext } = await freezeTwoMemberCohort();

    // Simulate the parent-op contract violation: the durable map is EMPTY for
    // a member that is part of a >=2-sibling group (the all-or-nothing
    // transaction makes this unreachable in the normal flow). PR8 DECISION-B:
    // the member fails instead of inventing a deterministic fallback title
    // (DECISION-R fallback is parent-op-only in active cohort mode).
    const prepared = buildPreparedContext(workspaceId, run, items[0], frozenLineContext);
    // A genuine active-cohort context carries the FROZEN per-member group
    // sizes (processCohort attaches them) — the fail-closed guard keys on
    // memberGroupSizes presence + group size >= 2.
    prepared.memberGroupSizes = frozenLineContext.memberGroupSizes;
    prepared.coordinatedTitles = new Map();

    // Invocation-based title-call counter: in a combined `bun test` run the
    // `cohort-name-coordinator` suite's llm-client mock can leak into this
    // file's module graph, so `spy.mock.calls` may inherit prior history.
    // Counting inside the implementation only tallies calls made during THIS
    // member materialization.
    let titleCallsDuringTest = 0;
    const titleCallSpy = vi.spyOn(llmClient, 'callLlmForTask').mockImplementation(((...args: any[]) => {
      const options = args[3] as Record<string, any> | undefined;
      if (options?.protectedOperation === 'cohort_title_consolidation') titleCallsDuringTest++;
      return null;
    }) as any);
    try {
      await expect(
        curateTransitionalPreparedMember(findItemById(items[0].id)!, wsPath, workspaceId, prepared),
      ).rejects.toThrow(/missing a persisted cohort title output in active cohort mode/);
      // No invented fallback title and no per-item title LLM call.
      expect(titleCallsDuringTest).toBe(0);
      const live = findItemById(items[0].id)!;
      expect(live.curationData).toBeNull();
    } finally {
      titleCallSpy.mockRestore();
    }
  });
});

// ─── PR7 C6 (issue #30): `execution_product_type` dependency stamped on
// materialized `category_page` proposals (DECISION-E). The parent Page op
// consumes the cohort Execution Product Type as page context, so the
// materialized page decision IS downstream of the type — but ONLY under
// execution-driven active cohort mode. Reviewed-driven (legacy/non-cohort)
// runs keep today's behavior: `field_assignment` stamped
// `reviewed_product_type`, `category_page` UNSTAMPED (Category Page
// authority remains review-only there).
// Issue #351: execution stamping is removed — materialized page proposals
// carry NO execution_product_type rows. Page authority is title/page
// coordination (Slice C), never execution inheritance. This block locks in
// the no-execution-row invariant on both reviewed-driven and plain members.
describe('PR7 C6 — no execution_product_type on materialized page proposals (issue #351)', () => {
  it('materialized category_page proposals carry zero execution rows', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();

    seedV1TitleOutputs(workspaceId, finalized);
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      for (const proposal of stored.curationData!.classificationProposals) {
        if (proposal.proposalType !== 'category_page') continue;
        for (const dep of listDependenciesForProposal(proposal.id)) {
          expect(dep.dependencyKind).not.toBe('execution_product_type');
        }
      }
    }
  });
});

// ─── PR9 C2 (issue #30): per-member semantic validation at the projection
//      commit + post-loop mutual Brand coherence (DECISION-A) ────────────────

/** V1_CONFIG_TYPE_AND_FIELD_ENABLED + a second Product Type ('dog-treats',
 *  SAME flavor profile) — lets a test force the parent Execution Product Type
 *  authority to a DIFFERENT type than the members' own proposals. */
const V1_CONFIG_TWO_TYPES: ClassificationConfig = {
  ...V1_CONFIG_TYPE_AND_FIELD_ENABLED,
  productTypes: [
    ...V1_CONFIG_TYPE_AND_FIELD_ENABLED.productTypes,
    { id: 'dog-treats', name: 'Dog Treats', description: null, attributeProfileId: 'dog-treats-profile', oldIdAliases: [] },
  ],
  attributeProfiles: [
    ...V1_CONFIG_TYPE_AND_FIELD_ENABLED.attributeProfiles,
    {
      id: 'dog-treats-profile',
      productTypeId: 'dog-treats',
      name: 'Dog Treats Profile',
      attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' as const, applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }],
    },
  ],
};

/** Save + cache the two-type config for one workspace. */
function saveTwoTypesConfig(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG_TWO_TYPES);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

describe('PR9 C2 — per-member semantic validation + post-loop brand coherence (issue #30, DECISION-A)', () => {
  it('coherent cohort: every member commits with semanticValidation.status=passed and the parent completes', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.
    seedV1TitleOutputs(workspaceId, finalized);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(['completed', 'completed_with_abstentions']).toContain(summary.parentStatus);
    expect(summary.completedMembers).toBe(2);
    expect(summary.memberFailures).toEqual([]);
    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const sv = stored.curationData!.semanticValidation!;
      expect(sv.status).toBe('passed');
      expect(sv.findings).toEqual([]);
    }
  });

  it('conflicting parent execution conclusion never blocks members (issue #351 SKU-local evidence)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTwoTypesConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.

    // Issue #351: there is no parent execution conclusion to mutate — each
    // member stands on its own facts and no family Product Type finding may
    // block them.
    seedV1TitleOutputs(workspaceId, finalized);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.completedMembers).toBe(2);

    for (const item of items) {
      const stored = findItemById(item.id)!;
      expect(stored.stageStatus).toBe('completed');
      const curationData = stored.curationData!;
      const sv = curationData.semanticValidation!;
      expect(sv.findings.map(f => String(f.code))).not.toContain('family_product_type');
      // CurationData + proposals preserved for the Review UX (PR10).
      expect(curationData.curatedTitle).not.toBeNull();
      expect(curationData.classificationProposals.length).toBeGreaterThan(0);
      // The pair proposal (when the member's own evidence supports one)
      // drives the suggestion; members without one suggest nothing (never
      // a family guess).
      const pair = curationData.classificationProposals.find(
        proposal => proposal.proposalType === 'product_classification' || proposal.proposalType === 'primary_product_type',
      );
      expect(curationData.suggestedProductType).toBe(pair?.targetId ?? null);
    }
  });

  it('post-loop brand coherence: a member whose FROZEN extraction brand conflicts with the canonical cohort Brand is blocked after the loop (family_brand)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    // Member 2 shares the cohort brandHint (Acme → same candidate cohort) but
    // its FROZEN extraction brand conflicts with the canonical cohort Brand.
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', brand: 'Generic' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.
    seedV1TitleOutputs(workspaceId, finalized);

    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.memberFailures).toHaveLength(1);
    expect(summary.memberFailures[0].productSku).toBe('100000000002');

    // Member 1 stays PASSED (canonical brand).
    const memberOne = findItemById(items[0].id)!;
    expect(memberOne.curationData!.semanticValidation!.status).toBe('passed');
    // Member 2 was owner-guarded-UPDATED after the loop to blocked.
    const memberTwo = findItemById(items[1].id)!;
    expect(memberTwo.stageStatus).toBe('completed');
    const sv = memberTwo.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    const finding = sv.findings.find(f => f.code === 'family_brand')!;
    expect(finding.memberSku).toBe('100000000002');
    expect(finding.message).toContain('generic');
    expect(finding.message).toContain('acme');
    // curationData + proposals intact.
    expect(memberTwo.curationData!.curatedTitle).not.toBeNull();
    expect(memberTwo.curationData!.classificationProposals.length).toBeGreaterThan(0);
  });

  it('crash between a member commit and the post-loop brand check: a reclaim re-enters and re-runs the brand check over the committed members', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', brand: 'Generic' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    seedV1TitleOutputs(workspaceId, finalized);

    // Crash AFTER member 2's projection commit (test-only seam) — the brand
    // check never runs in this attempt; the committed members survive.
    let commitCount = 0;
    const curation = createCohortCuration({ workspacePath: wsPath, workspaceId });
    await expect(curation.executeClaim(finalized.id, 'worker-a', {
      afterMemberCommit: () => {
        commitCount++;
        if (commitCount === 2) {
          throw new MemberCommitCrashSimulationError('simulated crash between member commit and post-loop brand check');
        }
      },
    })).rejects.toThrow('simulated crash between member commit and post-loop brand check');
    expect(findItemById(items[0].id)!.stageStatus).toBe('completed');
    expect(findItemById(items[1].id)!.stageStatus).toBe('completed');
    expect(getCohortRunById(finalized.id)!.status).toBe('running');

    // Reclaim + re-enter: both committed members are skipped by the resume
    // guard, the post-loop brand check re-runs over the committed evidence.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    const resumed = getCohortRunById(finalized.id)!;
    const resumedResult = await curation.executeClaim(resumed.id, 'worker-b');
    expect(resumedResult.executed).toBe(true);
    if (!resumedResult.executed) throw new Error('expected execution through the public seam');
    const summary = resumedResult.summary;
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    expect(summary.completedMembers).toBe(2);

    const memberTwo = findItemById(items[1].id)!;
    const sv = memberTwo.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    expect(sv.findings.some(f => f.code === 'family_brand')).toBe(true);
  });

  it('B3 (PR9 review R1): a crash after a committed member-local block → reclaim → the resume guard restores the committed member failure (issue #351: blocks are member-local, never family type)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTwoTypesConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.
    seedV1TitleOutputs(workspaceId, finalized);

    // Crash AFTER member 1's projection commit — its BLOCKED semanticValidation
    // commits, the parent stays `running`.
    // Inject a member-local block: a non-universal 'size' assignment outside
    // the profile → member_attribute_applicability. Production callers never
    // pass this seam; it deterministically stands in for any real local block.
    let injected = false;
    const blockSeam = (curationData: { classificationProposals: Array<Record<string, unknown>> }) => {
      if (injected) return;
      injected = true;
      curationData.classificationProposals.push({
        id: 'injected-size-1', runId: 'injected-child-run', productSku: 'injected-sku',
        proposalType: 'field_assignment', targetId: 'size', proposedValue: 'Large',
        confidence: 0.9, evidenceIds: [], status: 'pending',
        isBulkAcceptable: false, isStale: false, stalenessReason: null,
        createdAt: new Date().toISOString(),
      } as unknown as Record<string, unknown> as never);
    };
    let commitCount = 0;
    const curation = createCohortCuration({ workspacePath: wsPath, workspaceId });
    await expect(curation.executeClaim(finalized.id, 'worker-a', {
      beforeSemanticValidation: blockSeam,
      afterMemberCommit: () => {
        commitCount++;
        if (commitCount === 1) throw new MemberCommitCrashSimulationError('simulated crash after member 1 commit');
      },
    })).rejects.toThrow('simulated crash after member 1 commit');
    expect(findItemById(items[0].id)!.stageStatus).toBe('completed');
    expect(findItemById(items[0].id)!.curationData!.semanticValidation!.status).toBe('blocked');
    expect(getCohortRunById(finalized.id)!.status).toBe('running');

    // Reclaim + re-enter: member 1 is skipped by the resume guard, but its
    // committed semantic block MUST be reconstructed in the parent summary.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(
      workspaceId,
      new Date().toISOString(),
      () => verifyCohortRunFrozen(getCohortRunById(finalized.id)!, wsPath, workspaceId) ? 'match' : 'drift',
      'worker-b',
      COHORT_LEASE_TTL_MS,
    );
    expect(reclaim.resumed.length).toBe(1);
    const resumed = getCohortRunById(finalized.id)!;
    const resumedResult = await curation.executeClaim(resumed.id, 'worker-b');
    expect(resumedResult.executed).toBe(true);
    if (!resumedResult.executed) throw new Error('expected execution through the public seam');
    const summary = resumedResult.summary;
    expect(summary.parentStatus).toBe('completed_with_member_failures');
    // The committed member-1 block was restored (deduplicated to ONE entry);
    // member 2 passes SKU-locally and never appears.
    const skuCounts = new Map<string, number>();
    for (const failure of summary.memberFailures) {
      skuCounts.set(failure.productSku ?? '', (skuCounts.get(failure.productSku ?? '') ?? 0) + 1);
    }
    expect(skuCounts.get('100000000001')).toBe(1);
    expect(skuCounts.get('100000000002')).toBeUndefined();
    expect(summary.memberFailures.map(f => f.productSku).sort()).toEqual(['100000000001']);
  });

  it('B7 (PR9 review R1): member with BOTH a per-member hard finding and a post-loop Brand finding keeps BOTH, one parent failure, and a follow-up SSE event carries the FINAL semanticValidation', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTwoTypesConfig(workspaceId, wsPath);
    const { items, batchId } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb', _brandHint: 'Acme', brand: 'Generic' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.executionProductTypeId).toBeNull(); // Issue #351: freeze writes no execution type.
    // Issue #351: no family Product Type finding exists anymore
    // (SKU-local evidence) — only the post-loop Brand finding blocks member two.
    seedV1TitleOutputs(workspaceId, finalized);

    const events: OnboardingEvent[] = [];
    const unsubscribe = onboardingEvents.subscribe(batchId, event => {
      events.push(event);
    });
    const summary = await executeViaSeam(wsPath, workspaceId, finalized.id, 'worker-a');
    unsubscribe();

    expect(summary.parentStatus).toBe('completed_with_member_failures');
    // Exactly ONE parent member-failure entry for the brand-conflicted member.
    const skuCounts = new Map<string, number>();
    for (const failure of summary.memberFailures) {
      skuCounts.set(failure.productSku ?? '', (skuCounts.get(failure.productSku ?? '') ?? 0) + 1);
    }
    expect(skuCounts.get('100000000002')).toBe(1);

    // Only the Brand finding survives: no family_product_type finding exists.
    const memberTwo = findItemById(items[1].id)!;
    const sv = memberTwo.curationData!.semanticValidation!;
    expect(sv.status).toBe('blocked');
    expect(sv.findings.map(f => String(f.code))).not.toContain('family_product_type');
    expect(sv.findings.filter(f => f.code === 'family_brand')).toHaveLength(1);

    // SSE: the member-completed event was emitted before the post-loop Brand
    // check — the follow-up event for the affected member carries the FINAL
    // semanticValidation (brand code), truthfully surfacing the block.
    const memberTwoEvents = events.filter(
      e => e.itemId === items[1].id && (e.data as { curationData?: { semanticValidation?: unknown } })?.curationData?.semanticValidation,
    );
    expect(memberTwoEvents.length).toBeGreaterThanOrEqual(2);
    const finalEvent = memberTwoEvents[memberTwoEvents.length - 1];
    const finalSv = (finalEvent.data as { curationData: { semanticValidation: { status: string; findings: Array<{ code: string }> } } }).curationData.semanticValidation;
    expect(finalSv.status).toBe('blocked');
    expect(finalSv.findings.map(f => f.code)).toEqual(['family_brand']);
  });
});

// Reference the exported execution types so the module graph is exercised.
export type { OnboardingItem };

// ─── PR9 C3 (issue #30, DECISION-C): active-cohort surface detection ────────

describe('PR9 C3 — active-cohort semantic surface (issue #30, DECISION-C)', () => {
  it('surfaces the semantic findings for an active-cohort child item; legacy/shadow/flag-OFF stay null (legacy surface byte-identical)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // A committed member item under the active cohort run carries the semantic
    // validation — the surface must present it.
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({
        curatedTitle: 'Acme Purina Pro Plan Dry Dog Food Chicken 5 lb',
        classificationRunId: 'child-run-xyz',
        semanticValidation: {
          status: 'blocked',
          findings: [{ code: 'family_brand', memberSku: '100000000001', message: 'Brand conflict.' }],
        },
      }), items[0].id],
    );
    // The fake child run must be a cohort child for the surface to fire.
    getDb().run(
      `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, cohort_run_id, status, started_at)
       VALUES ('child-run-xyz', ?, ?, ?, ?, 'completed', ?)`,
      [workspaceId, items[0].id, '100000000001', finalized.id, new Date().toISOString()],
    );

    const stored = findItemById(items[0].id)!;
    const surface = activeCohortSemanticFindingsForItem(stored);
    expect(surface.mode).toBe('active');
    if (surface.mode === 'active') {
      expect(surface.semanticValidation.status).toBe('blocked');
      expect(surface.semanticValidation.findings[0].code).toBe('family_brand');
      expect(surface.semanticValidation.findings[0].message).toBe('Brand conflict.');
    }

    // Legacy surface byte-identical: flag OFF and shadow both return legacy
    // mode (never the active surface, never a blocked payload).
    overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: true });
    expect(activeCohortSemanticFindingsForItem(stored)).toEqual({ mode: 'legacy' });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: true });
    expect(activeCohortSemanticFindingsForItem(stored)).toEqual({ mode: 'legacy' });
    resetCohortCurationFlagsOverride();

    // A NON-cohort item (run without a cohort_run_id) in active mode stays
    // legacy too — only cohort children switch the surface.
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    getDb().run(
      `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES ('legacy-run-xyz', ?, ?, ?, 'completed', ?)`,
      [workspaceId, items[1].id, '100000000002', new Date().toISOString()],
    );
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({
        curatedTitle: 'Acme Purina Pro Plan Dry Dog Food Beef 10 lb',
        classificationRunId: 'legacy-run-xyz',
        semanticValidation: { status: 'blocked', findings: [] },
      }), items[1].id],
    );
    const legacyItem = findItemById(items[1].id)!;
    expect(activeCohortSemanticFindingsForItem(legacyItem)).toEqual({ mode: 'legacy' });
  });

  it('B6: an active-cohort child with MISSING semantic data fails closed with a blocked surface (never the legacy validator)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);

    // Owned cohort child run, but curation data WITHOUT the semanticValidation
    // key (data loss / never validated).
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({ curatedTitle: 'Title', classificationRunId: 'child-missing' }), items[0].id],
    );
    getDb().run(
      `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, cohort_run_id, status, started_at)
       VALUES ('child-missing', ?, ?, ?, ?, 'completed', ?)`,
      [workspaceId, items[0].id, '100000000001', finalized.id, new Date().toISOString()],
    );

    const surface = activeCohortSemanticFindingsForItem(findItemById(items[0].id)!);
    expect(surface.mode).toBe('active');
    if (surface.mode === 'active') {
      expect(surface.semanticValidation.status).toBe('blocked');
      expect(surface.semanticValidation.findings[0].code).toBe('semantic_validation_unavailable');
    }
  });

  it('B6: an active-cohort child with MALFORMED semantic data fails closed with a blocked surface (never the legacy validator)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);

    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({ curatedTitle: 'Title', classificationRunId: 'child-malformed', semanticValidation: { status: 'weird-status', findings: 'not-an-array' } }), items[0].id],
    );
    getDb().run(
      `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, cohort_run_id, status, started_at)
       VALUES ('child-malformed', ?, ?, ?, ?, 'completed', ?)`,
      [workspaceId, items[0].id, '100000000001', finalized.id, new Date().toISOString()],
    );

    const surface = activeCohortSemanticFindingsForItem(findItemById(items[0].id)!);
    expect(surface.mode).toBe('active');
    if (surface.mode === 'active') {
      expect(surface.semanticValidation.status).toBe('blocked');
      expect(surface.semanticValidation.findings[0].code).toBe('semantic_validation_unavailable');
    }
  });

  it('B6: a FOREIGN child-run pointer never switches the surface (ownership dimensions must match)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveTypeAndFieldEnabledConfig(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);

    // The run pointer belongs to ANOTHER onboarding item (foreign ownership) —
    // the item's curation data points at it, but the ownership dimensions do
    // not agree, so the surface stays legacy.
    getDb().run(
      `UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?`,
      [JSON.stringify({ curatedTitle: 'Title', classificationRunId: 'foreign-child' }), items[0].id],
    );
    getDb().run(
      `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, product_sku, cohort_run_id, status, started_at)
       VALUES ('foreign-child', ?, ?, ?, ?, 'completed', ?)`,
      [workspaceId, items[1].id, '100000000002', finalized.id, new Date().toISOString()],
    );

    expect(activeCohortSemanticFindingsForItem(findItemById(items[0].id)!)).toEqual({ mode: 'legacy' });
  });
});
