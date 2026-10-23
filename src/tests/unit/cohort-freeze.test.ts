import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  updateItemExtractionData,
  findItemById,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction, type ExtractionBinding } from '../../db/repositories/onboarding-extraction-repo';
import {
  refreshCandidateCohorts,
  updateCohortStatus,
  getCohortMembers,
} from '../../db/repositories/curation-cohort-repo';
import {
  claimReadyCurationCohorts,
  getCohortRunById,
  getCohortSnapshotByHash,
  cancelFreezingRun,
  supersedeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { createRun, getRun } from '../../db/repositories/classification-run-repo';
import { upsertConfigSnapshot, syncConfigToCache, getPersistedConfigSnapshotId } from '../../db/repositories/classification-config-repo';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { saveClassificationConfig, loadClassificationConfig, loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { generateCandidate, buildFocusedFiles } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { computeClassificationBundleHash } from '../../classification/config-validation';
import { buildRuntimeSnapshot, getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import { freezeCohortForExecution, captureCohortAuthorities, verifyCohortRunFrozen, runFrozenOcrPullForward } from '../../onboarding/cohort-curation/freeze';
import { buildExecutionEvidenceProjection, buildFrozenItem, buildFrozenProductLineContext, parseFreezeOcrRerunCap } from '../../onboarding/cohort-curation/frozen-evidence';
import { computeOcrExecutionDigest } from '../../classification/runtime-snapshot';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import type { PreparedCohortContext } from './helpers/transitional-prepared-member';
import { curateTransitionalPreparedMember } from './helpers/transitional-prepared-member';
import { canonicalJsonFileString, hashCanonicalJson, sha256Hex } from '../../shared/stable-id';
import {
  overrideCohortCurationFlags,
  resetCohortCurationFlagsOverride,
} from '../../classification/flags';
import {
  overrideOcrStageFlags,
  resetOcrStageFlagsOverride,
  getOcrStageFlags,
} from '../../classification/ocr-stage-flags';
import { countPackagingOcrShadowComparisons } from '../../db/repositories/packaging-ocr-shadow-repo';
import { ClassificationManifestV2Schema, ClassificationFocusedFileNames } from '../../shared/schemas/classification';
import {
  ExecutionEvidenceProjectionV1Schema,
  ExecutionEvidenceProjectionV2Schema,
  parseExecutionEvidenceProjection,
} from '../../shared/schemas/cohorts';
import type { CurationCohort, ExecutionEvidenceProjectionMemberV1, ExecutionEvidenceProjectionMemberV2, ExecutionEvidenceProjectionMemberV3, ExecutionEvidenceProjectionV2, ExecutionEvidenceProjectionV3 } from '../../shared/schemas/cohorts';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import type { ClassificationConfig, ClassificationEvidence } from '../../shared/schemas/classification';
import type { InsertItemData } from '../../db/repositories/onboarding-item-repo';
import { computeExtractionHash } from '../../db/repositories/curation-cohort-repo';
import { reclaimExpiredCohortRuns } from '../../db/repositories/classification-cohort-run-repo';
import { evidenceExtractionStage } from '../../classification/stages/evidence-extraction';
import { evidenceFromProjection, matchMemberDeterministically } from '../../classification/cohort-product-type-resolver';
import type { ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';

let workspacePath: string;

beforeAll(() => {
  // P0 taxonomy freeze: this suite persists config via cohort curation, so the
  // freeze is explicitly lifted for the duration of the tests.
  setTaxonomyFreezeForTests(false);
  workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-freeze-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
});

afterAll(() => {
  setTaxonomyFreezeForTests(true);
  closeDb();
  try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
});
beforeEach(() => {
  overrideCohortCurationFlags({ cohortCurationV2Enabled: false, cohortShadowOnly: false });
  resetOcrStageFlagsOverride();
  try { getDb().run("DELETE FROM api_keys WHERE service IN ('ollama_vlm', 'ollama')"); } catch { /* ok */ }
});
afterEach(() => {
  resetCohortCurationFlagsOverride();
  resetOcrStageFlagsOverride();
  try { getDb().run("DELETE FROM api_keys WHERE service IN ('ollama_vlm', 'ollama')"); } catch { /* ok */ }
});
const EVIDENCE: CatalogEvidence = {
  schemaVersion: 1,
  sourceTreeHash: '0'.repeat(64),
  productFileCount: 0,
  parseFailureCount: 0,
  parseFailures: [],
  fieldRegistry: { entryCount: 0, xmlFields: [] },
  fields: [],
  pages: [],
};

/** Minimal but valid legacy v1 classification config (mirrors the pipeline test). */
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
    { id: 'test-product-type', kind: 'product_type' as const, label: 'Test Product Type', enabled: true, selectionMode: 'single' as const, attributeId: null, catalogField: null, optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 0 },
    { id: 'test-pages', kind: 'page' as const, label: 'Test Pages', enabled: true, selectionMode: 'multiple' as const, attributeId: null, catalogField: null, optionSource: 'live_store' as const, required: false, mandatory: false, sortOrder: 1 },
    { id: 'test-flavor', kind: 'product_field' as const, label: 'Test Flavor', enabled: true, selectionMode: 'single' as const, attributeId: 'flavor', catalogField: 'ProductField1', optionSource: 'configured' as const, required: false, mandatory: false, sortOrder: 2 },
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
  return { workspaceId, workspacePath: wsPath };
}

function saveV1Config(wsId: string, wsPath: string): void {
  saveClassificationConfig(wsPath, V1_CONFIG);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/** Save a v1 config whose Product Type option list differs from the default. */
function saveV1ConfigWithProductTypes(
  wsId: string,
  wsPath: string,
  productTypes: Array<{ id: string; name: string }>,
): void {
  const config: ClassificationConfig = {
    ...V1_CONFIG,
    // Full product-type shape (LegacyClassificationConfigV1Schema validation):
    // both options may share the existing attribute profile for the test.
    productTypes: productTypes.map(pt => ({
      id: pt.id,
      name: pt.name,
      description: null,
      attributeProfileId: 'dry-dog-food-profile',
      oldIdAliases: [],
    })),
  };
  saveClassificationConfig(wsPath, config);
  syncConfigToCache(wsId, loadClassificationConfig(wsPath));
}

/**
 * Write a lifecycle-ACTIVE v2 bundle to disk WITHOUT the DB config-snapshot
 * row (the fail-closed seam) using the reviewed generator. Page curation
 * targets are disabled so the run-start readiness gate passes without a
 * verified Page import; `store/field-registry.json` attests the mapped Catalog
 * Fields; a real catalog-evidence artifact + git commit satisfy the active
 * catalog binding checks. `seed` defaults to the reviewed Bay State seed;
 * tests may pass a cloned/modified seed (e.g. id≠label Product Type options).
 */
function writeActiveV2Bundle(wsPath: string, seed: typeof BayStatePetGardenSeed = BayStatePetGardenSeed): { bundle: ReturnType<typeof generateCandidate>['bundle']; xmlFields: string[] } {
  const candidate = generateCandidate(seed, EVIDENCE);
  const bundle = candidate.bundle;
  const xmlFields = [...new Set(bundle.attributeMappings.map(mapping => mapping.catalogField))];
  fs.writeFileSync(
    path.join(wsPath, 'store', 'field-registry.json'),
    JSON.stringify({ entries: xmlFields.map(xmlField => ({ xmlField })) }),
  );

  // Real git commit + real catalog-evidence artifact so the active loader's
  // catalog binding checks (commit ancestry + artifact hash) pass.
  const artifactPath = path.join(wsPath, 'store', 'classification', 'catalog-evidence.json');
  const artifactContent = JSON.stringify({ schemaVersion: 1, xmlFields });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, artifactContent);
  const catalogEvidenceHash = sha256Hex(artifactContent);
  let sourceCatalogCommit: string | null;
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: wsPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'test evidence'], { cwd: wsPath, stdio: 'ignore' });
    sourceCatalogCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wsPath, encoding: 'utf-8' }).trim();
  } catch (err) {
    throw new Error(`Unable to prepare the test git workspace for the active v2 bundle: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const targets = bundle.curationTargets.map(target => (
    target.kind === 'page'
      ? { ...target, enabled: false, mandatory: false }
      : target
  ));
  const adjusted = { ...bundle, curationTargets: targets };
  const focusedFiles = buildFocusedFiles(adjusted);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifestWithoutHash = {
    ...adjusted.manifest,
    activeRevision: 'bay-state-v2',
    lifecycle: 'active' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit,
    catalogEvidenceHash,
    fileVersions,
  };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const dir = path.join(wsPath, 'store', 'classification');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), canonicalJsonFileString(manifest));
  for (const [name, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { bundle: { ...adjusted, manifest }, xmlFields };
}

/**
 * The reviewed Bay State seed CLONED with Product Type options where the id
 * differs from the label ({ value: 'dry-dog-food', label: 'Dry Dog Food' })
 * and a model policy that resolves a protected local ollama route (needed to
 * exercise a SUCCESSFUL run-bound `product_type_ranking` LLM fallback).
 * Everything else (attributes, mappings, curation targets, brands, data
 * sharing) stays from the reviewed seed so generation/validation passes.
 */

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

function makeItemsData(extByUpc: Record<string, Record<string, any>>): InsertItemData[] {
  return Object.entries(extByUpc).map(([upc, ext], index) => ({
    upc,
    // `_name` is the spreadsheet register name used for candidate grouping
    // (stable name stem); `ext.title` stays the web-extracted title.
    name: String(ext._name ?? ext.title ?? `Item ${upc}`),
    brandHint: String(ext._brandHint ?? ext.brand ?? 'Acme'),
    sourceUrl: String(ext._sourceUrl ?? `https://brand.example.com/${upc}`),
    rowNumber: index + 1,
    stage: 'curation' as const,
    stageStatus: 'pending' as const,
  }));
}

/** Insert the batch + items, write extraction_data_json + extraction rows,
 *  form cohorts, and flip them to `ready`. `ocrInputHash` is injected into
 *  each item's extraction data (matching the current input set) so the freeze
 *  sees settled OCR. */
function createReadyCohort(
  wsId: string,
  extByUpc: Record<string, Record<string, any>>,
): { batchId: string; items: OnboardingItem[]; cohorts: CurationCohort[] } {
  const itemsData = makeItemsData(extByUpc);
  const batchId = createBatch({ workspaceId: wsId, name: 'Freeze Batch', fileName: 'freeze.xlsx', totalItems: itemsData.length }).id;
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

/**
 * Seed a provenance-compatible reviewed (accepted) `primary_product_type`
 * decision on a PRIOR run for one SKU under the CURRENT config (PR5
 * reviewed-fact fixture). The member's freeze-built runtime snapshot then
 * carries a compatible reviewed type fact that participates in the cohort
 * coherence rules at freeze time (PR5 hardening P1-2). Item ids are unique
 * per test (randomUUID) — deterministic ids derived from them never collide
 * across workspaces sharing one database file.
 */

describe('execution-evidence projection builder (PR3 M2)', () => {
  it('builds a complete execution-evidence-v1 projection, members sorted by onboardingItemId', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);

    expect(projection.version).toBe('execution-evidence-v2');
    expect(projection.cohortId).toBe(cohort.id);
    expect(projection.batchId).toBe(cohort.batchId);
    expect(projection.groupingVersion).toBe('product-family-v1');
    // Sorted by onboardingItemId (deterministic hashing).
    const ids = projection.members.map(m => m.onboardingItemId);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(projection.members).toHaveLength(items.length);

    const byItem = new Map(items.map(item => [item.id, item]));
    for (const member of projection.members) {
      const item = byItem.get(member.onboardingItemId)!;
      expect(member.extractionComplete).toBe(true);
      expect(member.ordinal).toBeTypeOf('number');
      expect(member.productSku).toBe(item.upc);
      expect(member.sourceUrl ?? null).toBe(item.sourceUrl ?? null);
      expect(member.extractionSourceUrl).toBe(item.sourceUrl ?? null);
      expect(member.spreadsheetIdentity.name).toBe(item.name);
      expect(member.spreadsheetIdentity.brandHint).toBe(item.brandHint);
      expect(member.spreadsheetIdentity.rowNumber).toBe(item.rowNumber);
      expect(member.spreadsheetIdentity.upc).toBe(item.upc);
      expect(member.extraction.title).toBe('Original Web Title');
      expect(member.extraction.description).toBe('Original description');
      expect(member.extraction.brand).toBe('Acme');
      expect(member.extraction.bulletPoints).toEqual(['Bullet one', 'Bullet two']);
      expect(member.extraction.primaryImage).toBe('https://img.example.com/primary.jpg');
      expect(member.extraction.additionalImages).toEqual(['https://img.example.com/alt1.jpg']);
      expect(member.extraction.customFields).toEqual({ Flavor: 'Chicken' });
      expect(member.extraction.fieldProvenance).toEqual({ title: 'json-ld' });
      expect(member.extraction.packagingTitle).toBe('Package OCR Title');
      expect(member.extraction.ocr.outcome?.status).toBe('succeeded');
      expect(member.extraction.ocr.packagingOcrData?.productName).toBe('Package OCR Name');
      expect(member.extraction.ocr.ocrInputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(member.extraction.piEvidence).toEqual([]);
      expect(member.extraction.piImportComplete).toBe(true);
      expect(member.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // The projection round-trips through the versioned schema.
    expect(ExecutionEvidenceProjectionV2Schema.safeParse(projection).success).toBe(true);
  });

  it('accepts null-valued fieldProvenance from distributor materializations', () => {
    // Strategy-collection/distributor extractions record null attribution
    // for unattributed fields; the freeze must not crash the cohort run.
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({
        _name: 'Dist Brand Dist Product 5 LB',
        fieldProvenance: { title: 'phillips', description: 'imported_evidence', brand: 'phillips', weight: null, distributorSku: 'phillips' },
      }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: null, sourceType: 'distributor_record' as const, extractionMethod: 'strategy_collection_v1', sourcingGenerationId: 'gen-1', acceptedEvidenceAttemptIds: [], evidenceHash: 'a'.repeat(64) }]));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    expect(projection.members).toHaveLength(1);
    expect(projection.members[0].extraction.fieldProvenance).toEqual({ title: 'phillips', description: 'imported_evidence', brand: 'phillips', weight: null, distributorSku: 'phillips' });
    expect(ExecutionEvidenceProjectionV2Schema.safeParse(projection).success).toBe(true);
  });

  it('ocrInputHash is stable for the same input set and changes when the image set changes', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    const a = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    const b = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    expect(a.members[0].extraction.ocr.ocrInputHash).toBe(b.members[0].extraction.ocr.ocrInputHash);

    // Image set change ⇒ input hash changes (the OCR belongs to different inputs).
    const mutated = findItemById(items[0].id)!;
    const ext = JSON.parse(JSON.stringify(mutated.extractionData));
    ext.primaryImage = 'https://img.example.com/CHANGED.jpg';
    updateItemExtractionData(items[0].id, JSON.stringify(ext));
    const item2 = findItemById(items[0].id)!;
    const c = buildExecutionEvidenceProjection(workspaceId, cohort, members, [item2], sources);
    expect(c.members[0].extraction.ocr.ocrInputHash).not.toBe(a.members[0].extraction.ocr.ocrInputHash);
    // And the member evidence hash changes with the extraction data too.
    expect(c.members[0].evidenceHash).not.toBe(a.members[0].evidenceHash);
  });

  it('evidenceHash is per-member and equals computeExtractionHash', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    for (const member of projection.members) {
      const item = items.find(i => i.id === member.onboardingItemId)!;
      expect(computeExtractionHash(item)).toBe(member.evidenceHash);
    }
    const hashes = new Set(projection.members.map(m => m.evidenceHash));
    expect(hashes.size).toBe(2);
  });

  it('V2 member carries Amendment A source provenance and distributor identity fields', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    // Simulate a distributor-record materialization: item source type,
    // payload provenance, and a distributor extraction binding.
    const item = items[0];
    // A distributor item carries NO source URL (no fake official URL).
    getDb().query('UPDATE onboarding_items SET source_url = NULL WHERE id = ?').run(item.id);
    const prov = {
      sourcingGenerationId: 'gen-dist-1',
      evidenceHash: 'a'.repeat(64),
      acceptedEvidenceAttemptIds: ['a1', 'a2'],
      providerIds: ['phillips', 'bci'],
      catalogVersions: ['v2026.3'],
    };
    getDb().query('UPDATE onboarding_items SET source_type = ? WHERE id = ?').run('distributor_record', item.id);
    const payload = {
      ...item.extractionData,
      distributorSku: 'DSKU-1',
      manufacturerPartNumber: 'MPN-1',
      variantAttributes: { flavor: 'Chicken' },
      sourceType: 'distributor_record',
      distributorRecordProvenance: prov,
    };
    updateItemExtractionData(item.id, JSON.stringify(payload));
    const sources = new Map<string, ExtractionBinding>([
      [item.id, {
        sourceUrl: null,
        sourceType: 'distributor_record',
        extractionMethod: 'distributor_record_v1',
        sourcingGenerationId: 'gen-dist-1',
        acceptedEvidenceAttemptIds: ['a2', 'a1'],
        evidenceHash: 'a'.repeat(64),
      }],
    ]);
    const updatedItem = findItemById(item.id)!;
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, [updatedItem], sources);
    const member = projection.members[0];
    expect(member.itemSourceType).toBe('distributor_record');
    expect(member.extractionSourceType).toBe('distributor_record');
    expect(member.extractionMethod).toBe('distributor_record_v1');
    expect(member.sourcingGenerationId).toBe('gen-dist-1');
    // Sorted-unique accepted ids + provider ids.
    expect(member.acceptedEvidenceAttemptIds).toEqual(['a1', 'a2']);
    expect(member.acceptedProviderIds).toEqual(['bci', 'phillips']);
    expect(member.distributorEvidenceHash).toBe('a'.repeat(64));
    expect(member.sourceUrl).toBeNull();
    expect(member.extractionSourceUrl).toBeNull();
    expect(member.extraction.distributorSku).toBe('DSKU-1');
    expect(member.extraction.manufacturerPartNumber).toBe('MPN-1');
    expect(member.extraction.variantAttributes).toEqual({ flavor: 'Chicken' });

    // buildFrozenItem restores source type + accepted provenance from the
    // frozen member (never hardcoded, never live post-freeze).
    const frozen = buildFrozenItem(member, updatedItem);
    expect(frozen.sourceType).toBe('distributor_record');
    expect(frozen.sourceUrl).toBeNull();
    expect(frozen.acceptedEvidenceAttemptIds).toEqual(['a1', 'a2']);
    expect(frozen.extractionData?.distributorSku).toBe('DSKU-1');
  });

  it('historical V1 snapshots normalize to V2 official-page provenance (parse-only, never rewritten)', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    // Build a V2 projection, then re-encode its core as a V1 payload.
    const v2 = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    const v1Payload = {
      version: 'execution-evidence-v1',
      cohortId: v2.cohortId,
      batchId: v2.batchId,
      groupingVersion: v2.groupingVersion,
      members: v2.members.map(m => ({
        onboardingItemId: m.onboardingItemId,
        ordinal: m.ordinal,
        productSku: m.productSku,
        extractionComplete: m.extractionComplete,
        sourceUrl: m.sourceUrl,
        extractionSourceUrl: m.extractionSourceUrl,
        sourcingDecision: m.sourcingDecision,
        spreadsheetIdentity: m.spreadsheetIdentity,
        extraction: m.extraction,
        evidenceHash: m.evidenceHash,
      })),
    };
    // V1 schema parse-only: it must parse the V1 payload and NOT the V2 one.
    expect(ExecutionEvidenceProjectionV1Schema.safeParse(v1Payload).success).toBe(true);
    expect(ExecutionEvidenceProjectionV1Schema.safeParse(v2).success).toBe(false);
    // The adapter normalizes V1 → V2 with official-page provenance.
    const normalized = parseExecutionEvidenceProjection(v1Payload);
    expect(normalized.version).toBe('execution-evidence-v2');
    expect(normalized.members[0].itemSourceType).toBe('official_page');
    expect(normalized.members[0].extractionSourceType).toBe('official_page');
    expect(normalized.members[0].acceptedEvidenceAttemptIds).toEqual([]);
    expect(normalized.members[0].distributorEvidenceHash).toBeNull();
    expect(normalized.members[0].extraction.distributorSku).toBeNull();
    expect(normalized.members[0].extraction.variantAttributes).toEqual({});
  });

  it('V2 members self-version AND preserve the full V2 sourcing decision through the freeze parse', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    // Seed a V2 distributor decision directly on the item row (V2-only
    // authority: schemaVersion/evidenceHash/sourceType/target must survive).
    const v2Decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: ['att-1'],
      providerIds: ['phillips'],
      sourcingGenerationId: 'gen-1',
      evidenceHash: 'b'.repeat(64),
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: '2026-08-14T00:00:00.000Z',
    };
    getDb().run('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?', [
      JSON.stringify(v2Decision),
      items[0].id,
    ]);
    const binding = {
      sourceUrl: null,
      sourceType: 'distributor_record' as const,
      extractionMethod: 'distributor_record_v1',
      sourcingGenerationId: 'gen-1',
      acceptedEvidenceAttemptIds: ['att-1'],
      evidenceHash: 'b'.repeat(64),
    };
    const sources = new Map([[items[0].id, binding]]);
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, [findItemById(items[0].id)!], sources);

    expect(projection.members[0].version).toBe('execution-evidence-v2');
    // The V2-only decision authority is preserved verbatim (Milestone E
    // review): schemaVersion, evidenceHash, sourceType, target, generation.
    const frozenDecision = projection.members[0].sourcingDecision as Record<string, unknown>;
    expect(frozenDecision.schemaVersion).toBe(2);
    expect(frozenDecision.route).toBe('distributor_record_to_extraction');
    expect(frozenDecision.evidenceHash).toBe('b'.repeat(64));
    expect(frozenDecision.sourceType).toBe('distributor_record');
    expect(frozenDecision.target).toBe('extraction');
    expect(frozenDecision.sourcingGenerationId).toBe('gen-1');
    // The whole projection still round-trips the V2 schema.
    expect(ExecutionEvidenceProjectionV2Schema.safeParse(projection).success).toBe(true);
  });

  it('V1 normalization yields self-versioned V2 members with the legacy decision intact', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    // Legacy (pre-Amendment-A) decision shape — no schemaVersion.
    const legacyDecision = {
      route: 'evidence_to_discovery',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: '2026-08-14T00:00:00.000Z',
    };
    getDb().run('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?', [
      JSON.stringify(legacyDecision),
      items[0].id,
    ]);
    // A V2-built projection with a legacy decision must parse and normalize
    // identically: build V2, strip the V2-only keys to a V1 payload, then
    // re-parse through the adapter and verify the legacy decision survived.
    const officialBinding = {
      sourceUrl: items[0].sourceUrl ?? 'https://brand.example.com/1',
      sourceType: 'official_page' as const,
      extractionMethod: 'test',
      sourcingGenerationId: null,
      acceptedEvidenceAttemptIds: [],
      evidenceHash: null,
    };
    const sources = new Map([[items[0].id, officialBinding]]);
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, [findItemById(items[0].id)!], sources);
    const member = projection.members[0];
    expect(member.version).toBe('execution-evidence-v2');
    // Legacy decision stays readable (the read union accepts it) and the
    // member round-trips the V2 member schema.
    expect((member.sourcingDecision as Record<string, unknown>).schemaVersion).toBeUndefined();
    expect((member.sourcingDecision as Record<string, unknown>).route).toBe('evidence_to_discovery');
    expect(ExecutionEvidenceProjectionV2Schema.safeParse(projection).success).toBe(true);
  });
});

describe('two-phase freeze service (PR3 M2)', () => {
  it('matching state -> freezing→running with H1–H5 written + evidence_snapshot_id set', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(run.status).toBe('freezing');

    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.startedAt).not.toBeNull();
    expect(finalized.evidenceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.evidenceSnapshotId).not.toBeNull();
    // H1 — membership identity.
    expect(finalized.candidateMembershipHash).toBe(cohort.membershipHash);
    // H3 — v1 config snapshot ref is a real persisted row.
    expect(finalized.configSnapshotId).not.toBeNull();
    expect(finalized.configSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    // H4 — no verified Page import in this workspace.
    expect(finalized.pageImportId).toBeNull();
    expect(finalized.pageImportHash).toBeNull();
    // H5 — v1 authority carries no model-execution digest.
    expect(finalized.modelPolicyDigest).toBeNull();

    // The content-addressed snapshot row exists; H2 = digest over the payload.
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    expect(snap).not.toBeNull();
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    expect(projection.version).toBe('execution-evidence-v3');
    expect(projection.members).toHaveLength(2);
    expect(hashCanonicalJson(projection)).toBe(finalized.evidenceSnapshotHash!);

    // Child runs exist (eager, freeze-created) + linked + persisted snapshot refs.
    for (const item of items) {
      const child = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ).get(run.id, item.id) as Record<string, any> | undefined;
      expect(child).toBeTruthy();
      expect(String(child!.status)).toBe('running');
      expect(child!.config_snapshot_id).not.toBeNull();
      expect(child!.config_snapshot_hash).not.toBeNull();
    }

    // A second freeze of a run that already left `freezing` fails fast —
    // execution is never re-frozen.
    expect(() => freezeCohortForExecution(finalized, wsPath, workspaceId)).toThrow(/not in 'freezing' state/);
  });

  it('two-phase CAS: freeze-window mutation -> run superseded, never transitions to running; fresh claim re-freezes on the mutated state', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    let mutated = false;
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId, {
      beforeFinalCas: () => {
        if (mutated) return;
        mutated = true;
        const live = findItemById(items[0].id)!;
        updateItemExtractionData(
          items[0].id,
          JSON.stringify({ ...live.extractionData, title: 'MUTATED IN WINDOW' }),
        );
      },
    });
    expect(mutated).toBe(true);
    expect(finalized.status).toBe('superseded');
    expect(finalized.errorMessage).toContain('Freeze CAS drift');
    expect(getCohortRunById(run.id)!.status).toBe('superseded');
    // Linked running children are failed so a retry is never blocked.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ?',
    ).all(run.id) as Array<Record<string, any>>;
    expect(child.length).toBe(1);
    expect(String(child[0].status)).toBe('failed');

    // The cohort stays READY; the next claim + freeze succeeds and the new
    // snapshot reflects the mutation (never the stale pre-mutation evidence).
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(run.id);
    const rerun = await freezeCohortForExecution(retried[0], wsPath, workspaceId);
    expect(rerun.status).toBe('running');
    const snap = getCohortSnapshotByHash(workspaceId, rerun.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    expect(projection.members[0].extraction.title).toBe('MUTATED IN WINDOW');
  });

  it('frozen-means-frozen: member executes on the frozen projection only — a post-freeze mutation is never visible', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    // The fixture's stored OCR predates the execution-authority binding (no
    // ocrExecutionDigest), so the freeze re-runs it under the CURRENT
    // authority. With the VLM disabled the re-run settles as `disabled` with
    // NO usable OCR — the unbound stored OCR is CLEARED (fix 2a: never
    // preserved and re-stamped), and the frozen evidence stage materializes no
    // packaging-OCR evidence from it (fail-closed on the authority digest).
    const { items } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction(),
    });
    const item = items[0];
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // MUTATE extraction_data_json + source_url AFTER freeze.
    const live = findItemById(item.id)!;
    const mutatedExt = JSON.parse(JSON.stringify(live.extractionData));
    mutatedExt.title = 'MUTATED AFTER FREEZE';
    mutatedExt.description = 'MUTATED DESC AFTER FREEZE';
    updateItemExtractionData(item.id, JSON.stringify(mutatedExt));
    getDb().run('UPDATE onboarding_items SET source_url = ? WHERE id = ?', ['https://brand.example.com/mutated', item.id]);
    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://brand.example.com/mutated',
      extractionDataJson: JSON.stringify(mutatedExt),
      extractionMethod: 'test',
      confidence: 1,
    });

    // Build the prepared-cohort context from the frozen run + snapshot.
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    const memberProjection = projection.members.find(m => m.onboardingItemId === item.id)!;
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, item.id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    const prepared: PreparedCohortContext = {
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
        modelPolicyView: memberSnapshot.modelPolicy
          ? modelPolicyViewFromConfig(memberSnapshot.modelPolicy as never, memberSnapshot.snapshotHash)
          : null,
      },
    };

    const mutatedLiveItem = findItemById(item.id)!;
    const curationData = await curateTransitionalPreparedMember(mutatedLiveItem, wsPath, workspaceId, prepared);

    // Evidence was built ONLY from the frozen projection: the mutation is
    // absent, the frozen web + OCR evidence is present, and the frozen child
    // run completed (no second run created).
    const evidence = curationData.classificationEvidence;
    const nameValues = evidence.filter(e => e.sourceField === 'name').map(e => String(e.value));
    expect(nameValues.some(v => v.includes('MUTATED AFTER FREEZE'))).toBe(false);
    expect(nameValues.some(v => v === 'Original Web Title')).toBe(true);
    expect(evidence.some(e => e.sourceField === 'description' && String(e.value).includes('MUTATED DESC'))).toBe(false);
    expect(evidence.some(e => e.sourceField === 'description' && String(e.value) === 'Original description')).toBe(true);
    // Frozen OCR evidence: the unbound stored OCR was re-run under the
    // current authority and settled as `disabled` with no usable data — the
    // frozen stage materializes NO packaging-OCR evidence from it (fix 2a
    // fail-closed; the stale 'Package OCR Name' from the fixture is gone).
    const ocrEvidence = evidence.filter(e => e.metadata && (e.metadata as any).provenance === 'packaging_ocr');
    expect(ocrEvidence.length).toBe(0);
    expect(ocrEvidence.some(e => String(e.value) === 'Package OCR Name')).toBe(false);
    // The frozen child run STAYS RUNNING (PR3 hardening, Commit B / R3): the
    // prepared pipeline no longer completes the child — the terminal child
    // write is part of the atomic member-projection commit in processCohort
    // (curation_data_json + item stage + child terminal in ONE transaction).
    // Exactly ONE child (the freeze-created run) exists; no second run was
    // created.
    const childStatus = getRun(String(child.id))!.status;
    expect(childStatus).toBe('running');
    const runningChildren = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_runs WHERE cohort_run_id = ? AND status = 'running'",
    ).get(run.id) as { cnt: number };
    expect(Number(runningChildren.cnt)).toBe(1);
  });

  it('verifyCohortRunFrozen: NULL-hash freezing run resumes vacuously; a frozen run drifts when evidence changed', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

    // Crash mid-freeze (NULL hashes) → vacuous match, same run resumes.
    expect(verifyCohortRunFrozen(run, wsPath, workspaceId)).toBe(true);

    // Complete a freeze → the frozen world still matches.
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(verifyCohortRunFrozen(finalized, wsPath, workspaceId)).toBe(true);

    // Mutate evidence after freeze → drift (supersede + new run).
    const live = findItemById(items[0].id)!;
    updateItemExtractionData(items[0].id, JSON.stringify({ ...live.extractionData, brand: 'CHANGED BRAND' }));
    expect(verifyCohortRunFrozen(finalized, wsPath, workspaceId)).toBe(false);

    // A reclaim path (simulated) supersedes on drift; the next claim creates a
    // fresh run — the mutation is never silently consumed.
    getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', finalized.id]);
    const reclaim = reclaimExpiredCohortRuns(workspaceId, new Date().toISOString(), () => verifyCohortRunFrozen(finalized, wsPath, workspaceId) ? 'match' : 'drift', 'worker-b', COHORT_LEASE_TTL_MS);
    expect(reclaim.resumed.length).toBe(0);
    expect(reclaim.superseded.length).toBe(1);
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(finalized.id);
    const rerun = await freezeCohortForExecution(retried[0], wsPath, workspaceId);
    expect(rerun.status).toBe('running');
    const snap = getCohortSnapshotByHash(workspaceId, rerun.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    expect(projection.members[0].extraction.brand).toBe('CHANGED BRAND');
  });

  it('fieldOptions injected at freeze: buildRuntimeSnapshot uses the frozen override, never the live store', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const config: ClassificationConfig = {
      ...V1_CONFIG,
      attributes: [
        { ...V1_CONFIG.attributes[0], allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'] },
      ],
    };
    void wsPath;
    const authority = { kind: 'v1' as const, config };
    const frozenOptions = { 'test-flavor': [{ value: 'Chicken', label: 'Chicken' }] };

    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: wsPath,
      productSku: 'SKU-FZ',
      authority,
      configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
      fieldOptions: frozenOptions,
    });
    expect(snapshot.fieldOptions['test-flavor']).toEqual(frozenOptions['test-flavor']);

    // Without the override the same config would compute the FULL allowed list —
    // proving the injected options were frozen, not re-resolved.
    const withoutOverride = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: wsPath,
      productSku: 'SKU-FZ',
      authority,
      configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
    });
    expect(withoutOverride.fieldOptions['test-flavor'].length).toBeGreaterThan(frozenOptions['test-flavor'].length);

    // The snapshot is deep-frozen — a post-freeze store mutation cannot change it.
    expect(() => {
      (snapshot.fieldOptions as Record<string, unknown>)['test-flavor'] = [];
    }).toThrow();
  });

  it('active v2 without an existing persisted config snapshot row -> capture automatically persists snapshot row; freeze succeeds with H5', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);

    const activationContext = createRuntimeActivationContext(wsPath, workspaceId);
    const authority = loadRuntimeConfigAuthority(wsPath, activationContext);
    expect(authority.kind).toBe('v2');

    // No persisted classification_config_snapshots row for the bundle hash yet before capture.
    expect(getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash)).toBeNull();

    // Capture automatically persists the snapshot row and succeeds with H5.
    const captured = captureCohortAuthorities(wsPath, workspaceId);
    expect(captured.configSnapshotRef.hash).toBe(bundle.manifest.bundleHash);
    expect(captured.configSnapshotRef.id).not.toBeNull();
    expect(captured.modelExecutionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash)).toBe(captured.configSnapshotRef.id);

    // Full v2 freeze: ready cohort + persisted config snapshot → running with H5.
    createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.configSnapshotHash).toBe(bundle.manifest.bundleHash);
    expect(finalized.modelPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.evidenceSnapshotId).not.toBeNull();
  });
});

describe('OCR pull-forward exactly-once (PR3 M2)', () => {
  it('A2 fail-closed OCR authority: stored OCR with NO execution digest is NEVER reused — the freeze re-runs under the v1 legacy authority and persists the digest', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const before = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };

    // The stored OCR is terminal + input-hash matched but predates the
    // execution-authority binding (no ocrExecutionDigest). Under Commit A's
    // null==null acceptance this legacy OCR was reusable; under the A2
    // fail-closed semantics reuse requires BOTH digests non-null AND equal,
    // so the freeze re-runs OCR under the CURRENT v1 legacy authority.
    const pre = JSON.parse(
      String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
    ) as Record<string, any>;
    expect(pre.ocrOutcome.status).toBe('succeeded');
    expect(pre.ocrExecutionDigest).toBeUndefined();

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    const after = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    // VLM disabled in the test env → the re-run settles as `disabled` WITHOUT
    // a transport (zero model calls, exactly-once by guard).
    expect(Number(after.cnt)).toBe(Number(before.cnt));
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as Record<string, any>;
    // The old unbound OCR was NOT accepted: the re-run overwrote the outcome
    // and bound the result to the current v1 legacy authority digest.
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.ocrExecutionDigest).toMatch(/^[a-f0-9]{64}$/);
    // The persisted digest is the deterministic v1 legacy authority digest of
    // the member's frozen runtime snapshot.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(memberSnapshot));
  });

  it('freeze runs ONE attempt for an unresolved member, writes the terminal outcome + ocrInputHash back, and the frozen stage materializes OCR without a call', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    // No OCR outcome at all (unresolved) → the freeze must settle it.
    const unresolved = settledExtraction();
    delete unresolved.ocrOutcome;
    delete unresolved.packagingOcrData;
    delete unresolved.packagingTitle;
    delete unresolved.ocrInputHash;
    const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
    const before = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // VLM disabled in the test env → the attempt settles as `disabled` with a
    // write-back (no transport ⇒ no model-call rows, exactly-once by guard).
    const after = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(after.cnt)).toBe(Number(before.cnt));
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as any;
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.ocrInputHash).toMatch(/^[a-f0-9]{64}$/);

    // Frozen-mode evidence stage materializes from the frozen stored OCR with
    // NO model call (the projection ocrInputHash matches its own input set).
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    const memberProjection = projection.members[0];
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;

    const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
    const result = await evidenceExtractionStage.execute(
      { sku: items[0].upc, onboardingItemId: items[0].id, evidence: [], acceptedProposals: [], allProposals: [] },
      {
        workspacePath: wsPath,
        workspaceId,
        runId: String(child.id),
        configSnapshotRef: memberSnapshot.configSnapshotRef,
        snapshot: memberSnapshot,
        cohortFrozenEvidence: memberProjection,
      } as never,
    );
    expect(result.status).toBe('succeeded');
    const output = (result as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
    expect(output.evidence.some(e => e.sourceField === 'name' && e.source === 'spreadsheet')).toBe(true);
    expect(output.evidence.some(e => e.sourceField === 'name' && e.source === 'official_product_page' && e.value === 'Original Web Title')).toBe(true);
    // No model calls were created by the frozen stage.
    const afterStage = getDb().query('SELECT COUNT(*) AS cnt FROM classification_model_calls').get() as { cnt: number };
    expect(Number(afterStage.cnt)).toBe(Number(after.cnt));
  });

  it('run-bound OCR pull-forward makes EXACTLY ONE model call with start-before-transport provenance on the child run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // Enable the local VLM with a loopback test route captured at snapshot build.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Frozen Pkg Title', brand: 'FrozenBrand' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'test-vlm');
      // In-memory v2 snapshot with a frozen local-VLM route.
      const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
      const bundle = candidate.bundle;
      const authority = { kind: 'v2' as const, bundle };
      const snapshot = buildRuntimeSnapshot({
        workspaceId,
        workspacePath: wsPath,
        productSku: 'SKU-OCR',
        authority,
        configSnapshotRef: { id: bundle.manifest.bundleHash, hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: new Date().toISOString() },
        sourceProductHash: '',
      });
      expect(snapshot.schemaVersion).toBe(2);
      const entry = snapshot.modelExecutionPlan!.entries.find(e => e.operation === 'evidence_extraction')!;
      expect(entry.localVlmBaseUrl).toBe(`http://127.0.0.1:${server.port}`);

      const run = createRun(workspaceId, 'SKU-OCR', null, null, { sourceKind: 'onboarding' });
      const item = {
        upc: 'SKU-OCR',
        extractionData: {
          primaryImage: `http://127.0.0.1:${server.port}/img.png`,
          additionalImages: [],
        },
      } as never;

      const result = await runFrozenOcrPullForward({ snapshot, childRunId: run.id, item, workspacePath: wsPath });
      expect(result.ocrOutcome.status).toBe('succeeded');
      expect(result.packagingOcrData?.productName).toBe('Frozen Pkg Title');
      expect(result.packagingOcrData?.metadata?.modelCallIds?.length).toBe(1);

      // Exactly ONE model-call row on the child run (the `started` row is
      // updated in place to its terminal status — start-before-transport).
      const calls = getDb().query(
        'SELECT operation, status FROM classification_model_calls WHERE run_id = ?',
      ).all(run.id) as Array<{ operation: string; status: string }>;
      expect(calls.length).toBe(1);
      expect(calls[0].operation).toBe('evidence_extraction');
      expect(calls[0].status).toBe('success');
    } finally {
      server.stop(true);
    }
  });

  it('run-bound OCR pull-forward persists a coded localFailureReason + attempts on an ordinary transport failure (post-review fixup 6)', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    // VLM route answers images fine but the model endpoint fails with HTTP
    // 500 — a coded transport-class failure that must surface in ocrOutcome.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        return Response.json({ error: 'model exploded' }, { status: 500 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'test-vlm');
      const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
      const bundle = candidate.bundle;
      const snapshot = buildRuntimeSnapshot({
        workspaceId,
        workspacePath: wsPath,
        productSku: 'SKU-OCR-FAIL',
        authority: { kind: 'v2' as const, bundle },
        configSnapshotRef: { id: bundle.manifest.bundleHash, hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: new Date().toISOString() },
        sourceProductHash: '',
      });
      const run = createRun(workspaceId, 'SKU-OCR-FAIL', null, null, { sourceKind: 'onboarding' });
      const item = {
        upc: 'SKU-OCR-FAIL',
        extractionData: {
          primaryImage: `http://127.0.0.1:${server.port}/img.png`,
          additionalImages: [],
        },
      } as never;

      const result = await runFrozenOcrPullForward({ snapshot, childRunId: run.id, item, workspacePath: wsPath });
      expect(result.packagingOcrData).toBeNull();
      expect(result.ocrOutcome.status).toBe('failed');
      expect(result.ocrOutcome.localStatus).toBe('failed');
      expect(result.ocrOutcome.localFailureReason).toBe('http_error');
      expect(result.ocrOutcome.attempts).toBeGreaterThanOrEqual(1);
    } finally {
      server.stop(true);
    }
  });
});

// Reference the projection member type so the type-level contract is exercised.
export type { ExecutionEvidenceProjectionMemberV1 };

describe('PR3 hardening — Commit B (R2 frozen execution purity)', () => {
  it('R2 buildFrozenItem: constructs from the frozen projection only — identity from live, semantics from projection, authoritative null sourceUrl stays null', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    const sources = new Map(items.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, items, sources);
    const member = projection.members[0];

    // MUTATE the live item after freeze: name/brand_hint/source_url/extraction
    // PLUS live semantic fields (sourcing decision, accepted attempt IDs,
    // prior curation data, source type) that must never leak into the
    // executed member.
    const live = findItemById(items[0].id)!;
    const mutatedExt = JSON.parse(JSON.stringify(live.extractionData));
    mutatedExt.title = 'MUTATED TITLE';
    mutatedExt.description = 'MUTATED DESC';
    mutatedExt.distributorEvidenceAttemptIds = ['att-mutated'];
    const mutatedLive: OnboardingItem = {
      ...live,
      name: 'MUTATED NAME',
      brandHint: 'MUTATED BRAND',
      sourceUrl: 'https://brand.example.com/mutated',
      extractionData: mutatedExt,
      sourcingDecision: {
        route: 'fallback_to_discovery',
        origin: 'operator_override',
        acceptedEvidenceAttemptIds: ['att-mutated-live'],
        providerIds: ['provider-mutated'],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      },
      acceptedEvidenceAttemptIds: ['att-mutated-live'],
      curationData: { curatedTitle: 'MUTATED CURATION' } as never,
      sourceType: 'distributor_record',
    };

    const frozen = buildFrozenItem(member, mutatedLive);

    // Identity is pipeline state from the live item.
    expect(frozen.id).toBe(mutatedLive.id);
    expect(frozen.upc).toBe(mutatedLive.upc);
    expect(frozen.batchId).toBe(mutatedLive.batchId);
    expect(frozen.rowNumber).toBe(mutatedLive.rowNumber);
    expect(frozen.stage).toBe(mutatedLive.stage);
    expect(frozen.stageStatus).toBe(mutatedLive.stageStatus);
    // Semantic fields come from the frozen projection, never the live mutation.
    expect(frozen.name).toBe(member.spreadsheetIdentity.name);
    expect(frozen.expectedName).toBe(member.spreadsheetIdentity.expectedName);
    expect(frozen.brandHint).toBe(member.spreadsheetIdentity.brandHint);
    expect(frozen.price).toBe(member.spreadsheetIdentity.price);
    expect(frozen.quantity).toBe(member.spreadsheetIdentity.quantity);
    expect(frozen.sourceUrl).toBe(member.sourceUrl);
    // extractionData is built PURELY from projection fields — no live spread.
    expect(frozen.extractionData?.title).toBe(member.extraction.title);
    expect(frozen.extractionData?.description).toBe(member.extraction.description);
    expect(frozen.extractionData?.brand).toBe(member.extraction.brand);
    expect(frozen.extractionData?.packagingOcrData?.productName).toBe(member.extraction.ocr.packagingOcrData?.productName);
    expect((frozen.extractionData as any).distributorEvidenceAttemptIds).toBeUndefined();
    expect((frozen.extractionData as any).ocrInputHash).toBe(member.extraction.ocr.ocrInputHash);
    expect((frozen.extractionData as any).ocrExecutionDigest).toBe(member.extraction.ocr.ocrExecutionDigest ?? null);
    // The frozen extraction view carries the projection's member evidence
    // identity (the execution contract's H2 input).
    expect((frozen.extractionData as any).evidenceHash).toBe(member.evidenceHash);
    // Live semantic fields never leak: sourcingDecision comes from the
    // projection (null here), attempt IDs are cleared, curation data is null,
    // and the source type is the neutral official-page value.
    expect(frozen.sourcingDecision).toBe(member.sourcingDecision);
    expect(frozen.acceptedEvidenceAttemptIds).toEqual([]);
    expect(frozen.acceptedEvidenceAttemptId).toBeNull();
    expect(frozen.curationData).toBeNull();
    expect(frozen.sourceType).toBe('official_page');
    expect(frozen.coordinatedTitle).toBeNull();

    // Authoritative null sourceUrl STAYS null even when the live value is set
    // post-freeze — never `?? item.sourceUrl`.
    const nullSource = { ...member, sourceUrl: null };
    const frozenNull = buildFrozenItem(nullSource, { ...mutatedLive, sourceUrl: 'https://brand.example.com/post-freeze' });
    expect(frozenNull.sourceUrl).toBeNull();
  });

  it('R2 buildFrozenProductLineContext: sibling context derived purely from the persisted cohort + frozen projections — a post-freeze sibling mutation is invisible', () => {
    const { workspaceId } = newWorkspace();
    const { items, cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dog Food Beef 10 lb' }),
    });
    const cohort = cohorts[0];
    const members = getCohortMembers(cohort.id);
    // Give member 2 a distinct spreadsheet brand hint AFTER cohort formation
    // (the family is still grouped on the original 'Acme' hint): the frozen
    // sibling brand must come from spreadsheetIdentity, never the
    // web-extracted brand 'Acme'.
    const siblingItem = items.find(i => i.upc === '100000000002')!;
    getDb().run('UPDATE onboarding_items SET brand_hint = ? WHERE id = ?', ['Spreadsheet Brand', siblingItem.id]);
    const updatedItems = items.map(item => findItemById(item.id)!);
    const sources = new Map(updatedItems.map(item => [item.id, { sourceUrl: item.sourceUrl ?? null, sourceType: 'official_page' as const, extractionMethod: 'test', sourcingGenerationId: null, acceptedEvidenceAttemptIds: [], evidenceHash: null }]));
    const projection = buildExecutionEvidenceProjection(workspaceId, cohort, members, updatedItems, sources);

    const ctx = buildFrozenProductLineContext(cohort, members, projection.members);
    expect(ctx.productLineContext.groupId).toBe(cohort.groupKey);
    expect(ctx.productLineContext.groupLabel).toBe(cohort.groupLabel);
    expect(ctx.productLineContext.siblingNames).toHaveLength(2);
    expect(ctx.productLineContext.siblingSkus).toHaveLength(2);
    // Ordinal order (insertion), while projection.members are sorted by item id —
    // compare as sets.
    expect([...ctx.productLineContext.siblingSkus].sort()).toEqual(
      projection.members.map(m => m.productSku).filter((sku): sku is string => sku !== null).sort(),
    );
    // webTitles from projection titles, ocrTitles from projection OCR.
    for (const m of projection.members) {
      expect(ctx.productLineContext.siblingWebTitles).toContain(m.extraction.title ?? '');
    }
    for (const m of projection.members) {
      const ocrName = m.extraction.ocr.packagingOcrData?.productName?.trim();
      if (ocrName) expect(ctx.productLineContext.siblingOcrTitles).toContain(ocrName);
    }
    expect(ctx.productLineItems).toHaveLength(2);
    for (const line of ctx.productLineItems) {
      const m = projection.members.find(member => member.productSku === line.sku)!;
      expect(line.webTitle).toBe(m.extraction.title);
      expect(line.description).toBe(m.extraction.description ?? '');
      // Frozen sibling brand is sourced from spreadsheetIdentity (PR3
      // hardening C / R2) — never the web-extracted extraction brand.
      expect(line.brand).toBe(m.spreadsheetIdentity.brandHint);
    }
    // Item 2 proves the precedence: its web-extracted brand is 'Acme' but the
    // frozen sibling brand is the spreadsheet hint 'Spreadsheet Brand'.
    const beefLine = ctx.productLineItems.find(line => line.sku === '100000000002')!;
    const beefProjection = projection.members.find(m => m.productSku === '100000000002')!;
    expect(beefProjection.extraction.brand).toBe('Acme');
    expect(beefLine.brand).toBe('Spreadsheet Brand');
    // Frozen member views carry frozen web/OCR titles (title-coordination input).
    for (const frozenItem of ctx.frozenBatchItems) {
      expect(frozenItem.extractionData?.title).toBe('Original Web Title');
      expect(frozenItem.extractionData?.packagingOcrData?.productName).toBe('Package OCR Name');
    }

    // MUTATE a sibling's live extraction_data_json AFTER the freeze — the
    // projection-derived context is byte-identical (a pure function of the
    // persisted cohort + projections; no live reads at all).
    const sibling = items.find(i => i.upc === '100000000002')!;
    const live = findItemById(sibling.id)!;
    const mutatedSibling = JSON.parse(JSON.stringify(live.extractionData));
    mutatedSibling.title = 'MUTATED SIBLING TITLE';
    mutatedSibling.packagingOcrData = { ...mutatedSibling.packagingOcrData, productName: 'MUTATED SIBLING OCR' };
    updateItemExtractionData(sibling.id, JSON.stringify(mutatedSibling));

    const ctxAfter = buildFrozenProductLineContext(cohort, getCohortMembers(cohort.id), projection.members);
    expect(ctxAfter.productLineContext.siblingWebTitles).toEqual(ctx.productLineContext.siblingWebTitles);
    expect(ctxAfter.productLineContext.siblingOcrTitles).toEqual(ctx.productLineContext.siblingOcrTitles);
    expect(ctxAfter.productLineItems.map(l => l.webTitle)).toEqual(ctx.productLineItems.map(l => l.webTitle));
    expect(ctxAfter.productLineContext.siblingWebTitles).not.toContain('MUTATED SIBLING TITLE');
    expect(ctxAfter.productLineContext.siblingOcrTitles).not.toContain('MUTATED SIBLING OCR');
  });
});

describe('PR3 hardening — Commit A (recovery/atomicity)', () => {
  it('R5: a cancelled pre-freeze run is NOT a vacuous match — reclaim supersedes it so the slot reopens', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    createReadyCohort(workspaceId, { '100000000001': settledExtraction() });
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(cancelFreezingRun(run.id, 'Freeze could never finalize')).toBe(true);
    const cancelled = getCohortRunById(run.id)!;

    // A cancelled pre-freeze run carries no frozen evidence AND is not a live
    // freezing claim — it is never a vacuous match.
    expect(cancelled.evidenceSnapshotHash).toBeNull();
    expect(verifyCohortRunFrozen(cancelled, wsPath, workspaceId)).toBe(false);

    // Retry semantics (Commit A / R5): the reconcile path treats a `cancelled`
    // current run as retryable — it is superseded before claiming (a cancelled
    // run is TERMINAL, so lease reclaim never selects it), which reopens the
    // slot for a fresh claim.
    expect(supersedeCohortRun(cancelled.id, 'Cancelled run retry (slot reopen)')).toBe(true);
    expect(getCohortRunById(cancelled.id)!.status).toBe('superseded');

    // A fresh claim creates a NEW run.
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-b', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    expect(retried[0].id).not.toBe(cancelled.id);
  });

  it('R4: OCR runs under a changed execution authority after a crash-before-final-CAS — old OCR is never accepted and a side-effect child is retired + recreated', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Authority A: local VLM route A (loopback mock). BOTH servers stay alive
    // — the primary image URL stays bound to server A while the VLM route
    // moves to server B, so the OCR re-run under B can still load the image.
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under B', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // Unsettled OCR extraction (no outcome, no input hash): the freeze must
      // run OCR under authority A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR runs under authority A, then the worker crashes
      // BEFORE the final CAS (the test seam hook throws). The run stays
      // `freezing` with NULL hashes and the OCR write-back persists.
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      expect(crashed).toBe(true);
      expect(getCohortRunById(run.id)!.status).toBe('freezing');
      expect(getCohortRunById(run.id)!.evidenceSnapshotHash).toBeNull();

      const readStoredExt = (): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
      );
      const storedA = readStoredExt();
      expect(storedA.ocrOutcome.status).toBe('succeeded');
      expect(storedA.packagingOcrData.productName).toBe('Pkg Under A');
      const digestA = storedA.ocrExecutionDigest;
      expect(digestA).toMatch(/^[a-f0-9]{64}$/);

      // The first child run recorded ONE model call under route A (side effect).
      const childA = getDb().query(
        `SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = 'running'`,
      ).get(run.id, items[0].id) as Record<string, any>;
      expect(childA).toBeTruthy();
      const callsA = getDb().query('SELECT * FROM classification_model_calls WHERE run_id = ?').all(String(childA.id)) as Array<Record<string, any>>;
      expect(callsA.length).toBe(1);
      expect(String(callsA[0].model)).toBe('vlm-model-a');

      // The world moved on: the local VLM route changes to authority B.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');

      // Reclaim the SAME parent (crash mid-freeze → vacuous match).
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      expect(reclaim.resumed[0].id).toBe(run.id);
      const resumed = getCohortRunById(run.id)!;
      expect(resumed.claimedBy).toBe('worker-b');

      // Re-freeze under authority B: the old OCR is NOT accepted (execution
      // digest mismatch) — it re-runs with NEW provenance; the running child
      // that accumulated side effects under A is retired and recreated.
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');

      // Child retirement: old child failed, a NEW child under the same parent
      // carries the new snapshot.
      expect(getRun(String(childA.id))!.status).toBe('failed');
      expect(getRun(String(childA.id))!.errorMessage).toBe('snapshot changed during resume');
      const children = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at ASC',
      ).all(run.id, items[0].id) as Array<Record<string, any>>;
      expect(children.length).toBe(2);
      expect(String(children[0].id)).toBe(String(childA.id));
      const childB = children[1];
      expect(String(childB.status)).toBe('running');
      expect(String(childB.cohort_run_id)).toBe(run.id);

      // OCR re-ran under authority B with new provenance.
      const storedB = readStoredExt();
      expect(storedB.packagingOcrData.productName).toBe('Pkg Under B');
      expect(storedB.ocrExecutionDigest).not.toBe(digestA);
      const snapshotB = getRuntimeSnapshotByHash(workspaceId, String(childB.config_snapshot_hash))!;
      expect(storedB.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshotB));
      const callsB = getDb().query('SELECT * FROM classification_model_calls WHERE run_id = ?').all(String(childB.id)) as Array<Record<string, any>>;
      expect(callsB.length).toBe(1);
      expect(String(callsB[0].model)).toBe('vlm-model-b');

      // Positive path of the digest guard (fix 2b): the digest-bound OCR
      // (stored digest === snapshot B's plan/rule digest) materializes through
      // the frozen evidence stage with NO additional model call.
      const snapB = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
      const projectionB = parseExecutionEvidenceProjection(JSON.parse(snapB.payloadJson));
      const memberProjectionB = projectionB.members[0];
      const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
      const stageContext = {
        workspacePath: wsPath,
        workspaceId,
        runId: String(childB.id),
        configSnapshotRef: snapshotB.configSnapshotRef,
        snapshot: snapshotB,
        cohortFrozenEvidence: memberProjectionB,
      };
      const stageInput = { sku: items[0].upc, onboardingItemId: items[0].id, evidence: [], acceptedProposals: [], allProposals: [] };
      const stageResult = await evidenceExtractionStage.execute(stageInput, stageContext as never);
      expect(stageResult.status).toBe('succeeded');
      const stageOut = (stageResult as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
      expect(stageOut.evidence.some(e => e.metadata?.provenance === 'packaging_ocr' && String(e.value) === 'Pkg Under B')).toBe(true);
      // And the SAME projection with a MISMATCHED stored digest never
      // materializes the OCR (fail-closed on the execution authority, not just
      // the input hash).
      const tamperedProjection = {
        ...memberProjectionB,
        extraction: {
          ...memberProjectionB.extraction,
          ocr: { ...memberProjectionB.extraction.ocr, ocrExecutionDigest: 'f'.repeat(64) },
        },
      } as never;
      const tamperedResult = await evidenceExtractionStage.execute(
        stageInput,
        { ...stageContext, cohortFrozenEvidence: tamperedProjection } as never,
      );
      const tamperedOut = (tamperedResult as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output;
      expect(tamperedOut.evidence.some(e => e.metadata?.provenance === 'packaging_ocr')).toBe(false);
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('R4 fail-closed rerun: authority B FAILS (HTTP 500) → A\'s OCR is cleared from extraction_data_json and the terminal outcome is B\'s, never A\'s values', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Authority A: loopback VLM succeeds. Authority B: image loads but the
    // VLM route returns HTTP 500 — the re-run produces NO usable OCR.
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return new Response('VLM exploded', { status: 500 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // Unsettled OCR: the first freeze must run a real transport under A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
      const readStoredExt = (): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR runs under authority A, then crash before the
      // final CAS. A's OCR + digest persist in extraction_data_json.
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      const storedA = readStoredExt();
      expect(storedA.ocrOutcome.status).toBe('succeeded');
      expect(storedA.packagingOcrData.productName).toBe('Pkg Under A');
      const digestA = storedA.ocrExecutionDigest;
      expect(digestA).toMatch(/^[a-f0-9]{64}$/);

      // The world moved on: the local VLM route changes to authority B.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');

      // Reclaim the SAME parent (crash mid-freeze → vacuous match).
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      const resumed = getCohortRunById(run.id)!;
      expect(resumed.claimedBy).toBe('worker-b');

      // Re-freeze under B: the digest mismatch re-runs OCR under B; B's
      // transport FAILS → no usable OCR. Fix 2a: A's OCR data/title are
      // UNCONDITIONALLY cleared — never preserved and re-stamped with B's
      // digest.
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');

      const storedB = readStoredExt();
      expect(storedB.packagingOcrData).toBeNull();
      expect(storedB.packagingTitle).toBeNull();
      expect(storedB.ocrOutcome.status).toBe('failed');
      expect(storedB.ocrOutcome.model).toBe('vlm-model-b');
      expect(storedB.ocrExecutionDigest).not.toBe(digestA);
      const childB = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
      ).get(run.id, items[0].id, 'running') as Record<string, any>;
      const snapshotB = getRuntimeSnapshotByHash(workspaceId, String(childB.config_snapshot_hash))!;
      expect(storedB.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshotB));
      // The frozen projection reflects B's terminal outcome — A's OCR is gone.
      const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
      const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
      expect(projection.members[0].extraction.ocr.packagingOcrData).toBeNull();
      expect(projection.members[0].extraction.ocr.ocrExecutionDigest).toBe(storedB.ocrExecutionDigest);
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('P1-T3 digest-staleness: freeze INVALIDATES mismatched-authority OCR with a plan_incompatible/stale marker, then re-runs under the new authority binding a fresh digest', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Authority A succeeds; authority B's transport is GATED so the test can
    // deterministically observe extraction_data_json while the re-run is in
    // flight (after the invalidation-marker write, before the final bind).
    let releaseB: (() => void) | null = null;
    const gateB = new Promise<void>(resolve => { releaseB = resolve; });
    let bChatCalls = 0;
    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          bChatCalls += 1;
          return gateB.then(() => Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under B', brand: 'Acme' }) } }));
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // Unsettled OCR: the first freeze runs OCR under authority A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
      const readStoredExt = (): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json),
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR binds to authority A, then the worker crashes
      // BEFORE the final CAS (the run stays `freezing`, OCR + digest persist).
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      const storedA = readStoredExt();
      expect(storedA.packagingOcrData.productName).toBe('Pkg Under A');
      const digestA = storedA.ocrExecutionDigest;
      expect(digestA).toMatch(/^[a-f0-9]{64}$/);

      // The world moved on: the local VLM route changes to authority B.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');

      // Reclaim the SAME parent (crash mid-freeze → vacuous match).
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      const reclaim = reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      expect(reclaim.resumed.length).toBe(1);
      const resumed = getCohortRunById(run.id)!;

      // Re-freeze under B: while B's transport sits gated in flight, the
      // stale copy must ALREADY be invalidated with the visible marker AND
      // the prior data fields preserved intact (nothing is lost).
      let observedMidFlight: Record<string, any> | null = null;
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId, {
        onOcrInFlight: () => {
          observedMidFlight = readStoredExt();
          releaseB!();
        },
      });
      expect(finalized.status).toBe('running');
      expect(bChatCalls).toBe(1);

      expect(observedMidFlight).toBeTruthy();
      const mid = observedMidFlight as unknown as Record<string, any>;
      expect(mid.packagingOcrData.productName).toBe('Pkg Under A');
      expect(mid.packagingTitle).toBe('Pkg Under A');
      expect(mid.ocrOutcome.status).toBe('failed');
      expect(mid.ocrOutcome.localFailureReason).toBe('plan_incompatible');
      expect(mid.ocrOutcome.stale).toBe(true);
      expect(mid.ocrExecutionDigest).toBe(digestA);

      // Final state: B's OCR + B's digest bound atomically at the existing
      // write site; no stale-marker residue.
      const storedB = readStoredExt();
      expect(storedB.packagingOcrData.productName).toBe('Pkg Under B');
      expect(storedB.ocrExecutionDigest).not.toBe(digestA);
      const childB = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
      ).get(run.id, items[0].id, 'running') as Record<string, any>;
      const snapshotB = getRuntimeSnapshotByHash(workspaceId, String(childB.config_snapshot_hash))!;
      expect(storedB.ocrExecutionDigest).toBe(computeOcrExecutionDigest(snapshotB));
      expect(storedB.ocrOutcome.status).toBe('succeeded');
      expect(storedB.ocrOutcome.model).toBe('vlm-model-b');
      expect(storedB.ocrOutcome.stale ?? false).toBe(false);
      expect(storedB.ocrOutcome.localFailureReason ?? null).toBeNull();

      // The persisted projection carries B's digest — the member is settled
      // again under the new authority.
      const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
      const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
      expect(projection.members[0].extraction.ocr.ocrExecutionDigest).toBe(storedB.ocrExecutionDigest);
      expect((projection.members[0].extraction.ocr.outcome as Record<string, any>).stale ?? false).toBe(false);
    } finally {
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('P1-T3 positive: matching execution digest stays byte-identical — no invalidation marker, no re-run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    let chatCalls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          chatCalls += 1;
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'vlm-model-a');
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${server.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });
      const readRawExt = (): string =>
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json);

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // Freeze attempt 1: OCR runs under authority A, then crash before CAS.
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      expect(chatCalls).toBe(1);
      const rawBefore = readRawExt();

      // Reclaim WITHOUT changing any authority: the stored digest still
      // matches the freshly computed one.
      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      const resumed = getCohortRunById(run.id)!;

      // Re-freeze: matching digest ⇒ byte-identical behavior as before the
      // P1-T3 change — NO invalidation marker, NO re-run.
      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');
      expect(chatCalls).toBe(1);
      expect(readRawExt()).toBe(rawBefore);
      const stored = JSON.parse(readRawExt());
      expect(stored.packagingOcrData.productName).toBe('Pkg Under A');
      expect(stored.ocrOutcome.status).toBe('succeeded');
      expect(stored.ocrOutcome.stale ?? false).toBe(false);
      expect(stored.ocrOutcome.localFailureReason ?? null).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  it('P1-T3 rerun cap: members beyond BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP keep their stale marker and remain unsettled without VLM calls', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    const serverA = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under A', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    let bChatCalls = 0;
    const serverB = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          bChatCalls += 1;
          return Response.json({ message: { content: JSON.stringify({ productName: 'Pkg Under B', brand: 'Acme' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    const prevCap = process.env.BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP;
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverA.port}`, 'vlm-model-a');

      // TWO members in ONE cohort, both unsettled: the first freeze binds
      // each to authority A (uncapped legacy pull-forward).
      const makeUnresolved = (variety: string): Record<string, any> => {
        const ext = settledExtraction({
          _name: `Purina Pro Plan Dog Food ${variety}`,
          primaryImage: `http://127.0.0.1:${serverA.port}/img.png`,
          additionalImages: [],
        });
        delete ext.ocrOutcome;
        delete ext.packagingOcrData;
        delete ext.packagingTitle;
        delete ext.ocrInputHash;
        return ext;
      };
      const { items } = createReadyCohort(workspaceId, {
        '100000000001': makeUnresolved('Chicken 5 lb'),
        '100000000002': makeUnresolved('Beef 10 lb'),
      });
      const readExt = (itemId: string): Record<string, any> => JSON.parse(
        String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(itemId) as { extraction_data_json: string }).extraction_data_json),
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
      let crashed = false;
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        beforeFinalCas: () => {
          if (crashed) return;
          crashed = true;
          throw new Error('simulated crash before final CAS');
        },
      })).rejects.toThrow('simulated crash before final CAS');
      const digestA1 = readExt(items[0].id).ocrExecutionDigest;
      const digestA2 = readExt(items[1].id).ocrExecutionDigest;
      expect(digestA1).toMatch(/^[a-f0-9]{64}$/);
      expect(digestA2).toMatch(/^[a-f0-9]{64}$/);

      // Authority moves to B; cap allows only ONE staleness re-run.
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${serverB.port}`, 'vlm-model-b');
      process.env.BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP = '1';

      getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
      reclaimExpiredCohortRuns(
        workspaceId,
        new Date().toISOString(),
        () => (verifyCohortRunFrozen(getCohortRunById(run.id)!, wsPath, workspaceId) ? 'match' : 'drift'),
        'worker-b',
        COHORT_LEASE_TTL_MS,
      );
      const resumed = getCohortRunById(run.id)!;

      const finalized = await freezeCohortForExecution(resumed, wsPath, workspaceId);
      expect(finalized.status).toBe('running');

      // EXACTLY one member actually re-ran under B.
      expect(bChatCalls).toBe(1);
      const exts = [readExt(items[0].id), readExt(items[1].id)];
      const reran = exts.filter(e => e.ocrOutcome?.model === 'vlm-model-b' && e.ocrOutcome?.stale !== true && e.ocrExecutionDigest !== digestA1);
      const stale = exts.filter(e => e.ocrOutcome?.stale === true);
      expect(reran.length).toBe(1);
      expect(stale.length).toBe(1);

      // The beyond-cap member keeps its stale marker + intact prior data and
      // stays VISIBLY unsettled (readiness mirror), picking up on a later pass.
      const staleExt = stale[0];
      expect(staleExt.packagingOcrData.productName).toBe('Pkg Under A');
      expect(staleExt.ocrOutcome.status).toBe('failed');
      expect(staleExt.ocrOutcome.localFailureReason).toBe('plan_incompatible');
      const { evaluateItemReadiness } = await import('../../onboarding/curation-cohort-service');
      const staleItemRow = items.map(i => findItemById(i.id)!).find(it => (it.extractionData as Record<string, any>)?.ocrOutcome?.stale === true)!;
      const reranItemRow = items.map(i => findItemById(i.id)!).find(it => (it.extractionData as Record<string, any>)?.ocrOutcome?.model === 'vlm-model-b')!;
      expect(evaluateItemReadiness(staleItemRow).ocrSettled).toBe(false);
      expect(evaluateItemReadiness(reranItemRow).ocrSettled).toBe(true);
    } finally {
      if (prevCap === undefined) delete process.env.BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP;
      else process.env.BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP = prevCap;
      serverA.stop(true);
      serverB.stop(true);
    }
  });

  it('P1-T3 rerun-cap parsing: missing/unparseable/negative → default 12; valid integers pass through', async () => {
    expect(parseFreezeOcrRerunCap(undefined)).toBe(12);
    expect(parseFreezeOcrRerunCap(null)).toBe(12);
    expect(parseFreezeOcrRerunCap('')).toBe(12);
    expect(parseFreezeOcrRerunCap('   ')).toBe(12);
    expect(parseFreezeOcrRerunCap('abc')).toBe(12);
    expect(parseFreezeOcrRerunCap('12x')).toBe(12);
    expect(parseFreezeOcrRerunCap('-3')).toBe(12);
    expect(parseFreezeOcrRerunCap('0')).toBe(0);
    expect(parseFreezeOcrRerunCap('1')).toBe(1);
    expect(parseFreezeOcrRerunCap('12')).toBe(12);
  });

  it('A2 heartbeat: a sibling reclaim during an in-flight freeze OCR aborts the freeze with NO post-loss writes; the new owner keeps the run', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);

    // Loopback VLM + image source: the member's freeze OCR transport is
    // genuinely in flight while the test seam fires.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Frozen Pkg Title', brand: 'FrozenBrand' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'vlm-model-a');

      // Unresolved OCR extraction (no outcome, no input hash, no digest): the
      // freeze MUST run a transport under authority A.
      const unresolved = settledExtraction({
        _name: 'Purina Pro Plan Dog Food Chicken 5 lb',
        primaryImage: `http://127.0.0.1:${server.port}/img.png`,
        additionalImages: [],
      });
      delete unresolved.ocrOutcome;
      delete unresolved.packagingOcrData;
      delete unresolved.packagingTitle;
      delete unresolved.ocrInputHash;
      const { items } = createReadyCohort(workspaceId, { '100000000001': unresolved });

      // Snapshot the extraction JSON BEFORE the freeze: the aborted freeze
      // must leave it byte-identical (no write-back at all).
      const extractionBefore = String(
        (getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json,
      );

      const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);

      // The seam fires while the member's OCR transport is IN FLIGHT (inside
      // the awaited op): the lease is expired and a sibling worker reclaims
      // the run. The transport completes, the keeper's post-await ownership
      // assertion fails, and the freeze aborts with NO extraction_data_json
      // write-back and NO terminal write.
      let reclaimed = false;
      // Run-scoped shared state snapshot AT the reclaim instant: after the
      // abort the stale owner must not have added/updated a single row in
      // these tables (fix 1c). Model-call rows are scoped to THIS freeze's
      // child run (start-before-transport provenance already inserted).
      let tablesAtReclaim: Record<string, number> = {};
      let modelCallsAtReclaim: Array<{ id: string; status: string }> = [];
      const childRunIdForCalls = (): string | null => {
        const row = getDb().query(
          'SELECT id FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? ORDER BY started_at DESC LIMIT 1',
        ).get(run.id, items[0].id) as { id: string } | undefined;
        return row ? String(row.id) : null;
      };
      await expect(freezeCohortForExecution(run, wsPath, workspaceId, {
        onOcrInFlight: () => {
          if (reclaimed) return;
          reclaimed = true;
          getDb().run('UPDATE classification_cohort_runs SET lease_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', run.id]);
          const reclaim = reclaimExpiredCohortRuns(
            workspaceId,
            new Date().toISOString(),
            () => 'match',
            'worker-b',
            COHORT_LEASE_TTL_MS,
          );
          expect(reclaim.resumed.length).toBe(1);
          expect(reclaim.resumed[0].id).toBe(run.id);
          // Snapshot run-scoped tables + the in-flight model-call row state
          // at the moment ownership moved — no NEW or UPDATED rows may appear
          // afterwards.
          tablesAtReclaim = tableCounts();
          const childId = childRunIdForCalls();
          modelCallsAtReclaim = childId
            ? (getDb().query('SELECT id, status FROM classification_model_calls WHERE run_id = ?').all(childId) as Array<{ id: string; status: string }>)
              .map(r => ({ id: String(r.id), status: String(r.status) }))
            : [];
        },
      })).rejects.toBeInstanceOf(HeartbeatLostError);
      expect(reclaimed).toBe(true);

      // Fix 1c: the stale owner never persisted run-scoped shared state after
      // ownership moved — model calls / stage results / evidence / proposals
      // are row-count-identical, and the in-flight OCR model call on THIS
      // freeze's child was NEVER terminalized (still `started`, never
      // `success`/`failed`).
      expect(tableCounts()).toEqual(tablesAtReclaim);
      const childIdAfter = childRunIdForCalls();
      const modelCallsAfter = childIdAfter
        ? (getDb().query('SELECT id, status FROM classification_model_calls WHERE run_id = ?').all(childIdAfter) as Array<{ id: string; status: string }>)
          .map(r => ({ id: String(r.id), status: String(r.status) }))
        : [];
      expect(modelCallsAfter).toEqual(modelCallsAtReclaim);
      expect(modelCallsAfter.every(call => call.status === 'started')).toBe(true);

      // The new owner's run is INTACT: still `freezing` (no supersede, no
      // terminal write), claimed by worker-b, nothing finalized.
      const after = getCohortRunById(run.id)!;
      expect(after.status).toBe('freezing');
      expect(after.claimedBy).toBe('worker-b');
      expect(after.evidenceSnapshotHash).toBeNull();
      expect(after.supersededAt).toBeNull();

      // No post-loss write-back: extraction_data_json is byte-identical to
      // the pre-freeze state (the OCR outcome/digest never landed).
      const extractionAfter = String(
        (getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string }).extraction_data_json,
      );
      expect(extractionAfter).toBe(extractionBefore);
      const stored = JSON.parse(extractionAfter) as Record<string, any>;
      expect(stored.ocrOutcome).toBeUndefined();
      expect(stored.ocrExecutionDigest).toBeUndefined();

      // The freeze-created child run is untouched — the abort path failed or
      // retired nothing.
      const child = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = ?',
      ).get(run.id, items[0].id, 'running') as Record<string, any> | undefined;
      expect(child).toBeTruthy();
    } finally {
      server.stop(true);
    }
  });
});

describe('freeze persists authorities without family type resolution (issue #351 SKU-local evidence)', () => {
  it('active mode: freeze persists membership + authorities and transitions running — no execution type, no outcome, no conflict terminal', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Beef 10 lb' }),
    });
    expect(cohorts).toHaveLength(1);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    expect(finalized.startedAt).not.toBeNull();
    // Issue #351: the freeze writes NO family Product Type conclusion —
    // members classify from their own evidence in their own pipeline runs.
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeConfidence).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();
    expect(finalized.finalMembershipHash).toBe(run.candidateMembershipHash);
    // The persisted projection carries the same 2-member membership.
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    expect(projection.members).toHaveLength(2);
  });

  it('divergent members do not fail the freeze — each SKU stands on its own facts', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1ConfigWithProductTypes(workspaceId, wsPath, [
      { id: 'dry-dog-food', name: 'Dry Dog Food' },
      { id: 'dry-cat-food', name: 'Dry Cat Food' },
    ]);
    const { cohorts } = createReadyCohort(workspaceId, {
      '100000000001': settledExtraction({ _name: 'Purina Pro Plan Food Chicken 5 lb', title: 'Purina Pro Plan Dry Dog Food 5 lb' }),
      '100000000002': settledExtraction({ _name: 'Purina Pro Plan Food Beef 10 lb', title: 'Purina Pro Plan Dry Cat Food 10 lb' }),
    });
    expect(cohorts).toHaveLength(1);
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    // No conflict terminal: divergent family evidence is not a freeze
    // failure — sibling divergence stays a read-only advisory.
    expect(finalized.status).toBe('running');
    expect(finalized.executionProductTypeId).toBeNull();
    expect(finalized.productTypeOutcome).toBeNull();
    expect(finalized.finalMembershipHash).toBe(run.candidateMembershipHash);
  });
});

// ─── P2-T6 (packaging-OCR overhaul): consumer migration at the freeze ────────

/** An extraction fixture with NO OCR settled — forces the freeze's OCR
 *  pull-forward moment (the delegation seam under test). */
function unresolvedOcrExtraction(): Record<string, any> {
  const ext = settledExtraction();
  delete ext.ocrOutcome;
  delete ext.packagingOcrData;
  delete ext.packagingTitle;
  delete ext.ocrInputHash;
  return ext;
}

describe('packaging-OCR stage consumer migration (P2-T6)', () => {
  it('flag OFF (default): the freeze settles OCR through the LEGACY pull-forward — legacy write-back shape, no packaging_ocr stage rows, no shadow keys', async () => {
    expect(getOcrStageFlags().packagingOcrStageEnabled).toBe(false);
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, { '100000000421': unresolvedOcrExtraction() });
    const before = tableCounts();

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-flagoff', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // VLM disabled in the test env → the legacy pull-forward settles the OCR
    // as `disabled` with a full binding write-back and ZERO transports.
    expect(Number((tableCounts().classification_model_calls))).toBe(Number(before.classification_model_calls));
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as Record<string, any>;
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.packagingOcrData).toBeNull();
    expect(stored.packagingTitle).toBeNull();
    expect(stored.ocrInputHash).toMatch(/^[a-f0-9]{64}$/);

    // The digest binding semantics are untouched: the persisted execution
    // digest equals the member's own frozen runtime snapshot digest.
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(memberSnapshot));

    // Flag-off inertness: the stage NEVER wrote its namespaced shadow key and
    // NO packaging_ocr stage result exists anywhere.
    expect('shadowPackagingOcrData' in stored).toBe(false);
    const stageRows = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_stage_results WHERE stage_name = 'packaging_ocr'",
    ).get() as { cnt: number };
    expect(Number(stageRows.cnt)).toBe(0);
  });

  it('flag ON + shadow-only OFF: the freeze DELEGATES its OCR moment to the packaging_ocr stage while binding IDENTICAL hash/digest semantics', async () => {
    // Master flag ON + shadow-only OFF (delegation precondition) + dual-run
    // compare ON. Fixture mirrors the A2 fail-closed authority test: settled
    // OCR WITHOUT an execution digest is never reused, so the freeze MUST
    // re-run its OCR moment — which, under the flag, is delegated to the
    // stage.
    overrideOcrStageFlags({
      packagingOcrStageEnabled: true,
      packagingOcrStageShadowOnly: false,
      packagingOcrDualRunCompare: true,
    });
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const sourceUrl = 'https://brand.example.com/100000000431';
    const extFixture = settledExtraction(); // terminal OCR, no ocrExecutionDigest → forced re-run
    const { items } = createReadyCohort(workspaceId, { '100000000431': extFixture });
    const before = tableCounts();

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-flagon', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // PROOF of delegation: the DUAL-RUN COMPARISON ROW — written ONLY by the
    // packaging_ocr stage (the legacy pull-forward never touches this table).
    // The stage saw the stored legacy OCR (succeeded) and produced its own
    // coded result (disabled — VLM unavailable in the test env).
    const comparisons = getDb().query(
      'SELECT * FROM packaging_ocr_shadow_comparisons WHERE item_id = ?',
    ).all(items[0].id) as Array<Record<string, any>>;
    expect(comparisons.length).toBe(1);
    expect(comparisons[0].legacy_status).toBe('succeeded');
    expect(comparisons[0].stage_status).toBe('disabled');
    expect(comparisons[0].batch_id).toBe(items[0].batchId);

    // The freeze write-back still owns the LIVE keys with identical binding
    // semantics: unconditional overwrite, input hash over the SAME canonical
    // set, and the digest of the member's OWN frozen runtime snapshot.
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as Record<string, any>;
    expect(stored.ocrOutcome.status).toBe('disabled');
    expect(stored.ocrInputHash).toBe(expectedOcrInputHash(sourceUrl, extFixture));
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(memberSnapshot));

    // Zero transports under the disabled VLM; no pipeline ran → no
    // packaging_ocr stage RESULTS rows from the delegated freeze either.
    expect(Number(tableCounts().classification_model_calls)).toBe(Number(before.classification_model_calls));
    const stageRows = getDb().query(
      "SELECT COUNT(*) AS cnt FROM classification_stage_results WHERE stage_name = 'packaging_ocr'",
    ).get() as { cnt: number };
    expect(Number(stageRows.cnt)).toBe(0);
  });

  it('flag ON + shadow-only TRUE (default): the freeze stays on the LEGACY pull-forward — NO delegation, no comparison row, live keys from legacy only', async () => {
    // Post-review fixup 1: delegation additionally requires shadow-only OFF.
    // Under master ON + shadowOnly true (the defaults) the stage output can
    // never become authoritative, so the freeze must NOT delegate — otherwise
    // flipping just the master flag would silently make the stage live-
    // authority. The pipeline-level stage still runs in shadow via
    // composeCurationPipelineStages; THIS seam keeps legacy behavior.
    overrideOcrStageFlags({ packagingOcrStageEnabled: true });
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const sourceUrl = 'https://brand.example.com/100000000441';
    const extFixture = settledExtraction(); // terminal OCR, no ocrExecutionDigest → forced re-run
    const { items } = createReadyCohort(workspaceId, { '100000000441': extFixture });

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-shadow-default', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');

    // PROOF of non-delegation: ZERO comparison rows (the delegated path writes
    // one whenever a legacy baseline exists and dual-run is on).
    const comparisons = getDb().query(
      'SELECT COUNT(*) AS cnt FROM packaging_ocr_shadow_comparisons WHERE item_id = ?',
    ).get(items[0].id) as { cnt: number };
    expect(Number(comparisons.cnt)).toBe(0);

    // Live keys were written by the LEGACY pull-forward: identical binding
    // semantics, no namespaced shadow key.
    const storedRow = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as { extraction_data_json: string };
    const stored = JSON.parse(storedRow.extraction_data_json) as Record<string, any>;
    expect(stored.ocrOutcome.status).toBe('disabled'); // VLM unavailable in the test env → legacy coded outcome
    expect(stored.packagingOcrData).toBeNull();
    expect(stored.ocrInputHash).toBe(expectedOcrInputHash(sourceUrl, extFixture));
    const child = getDb().query(
      'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
    ).get(run.id, items[0].id) as Record<string, any>;
    const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, String(child.config_snapshot_hash))!;
    expect(stored.ocrExecutionDigest).toBe(computeOcrExecutionDigest(memberSnapshot));
    expect('shadowPackagingOcrData' in stored).toBe(false);
  });
});

// ─── Post-review fixup 2: freeze-delegated distributor_record convergence ─────

describe('freeze-delegated distributor_record OCR settles (post-review fixup 2)', () => {
  it('flag-ON non-shadow freeze of a distributor_record item binds a terminal no_image outcome, and a second pass does NOT re-run (at most ONE comparison row across two passes)', async () => {
    overrideOcrStageFlags({
      packagingOcrStageEnabled: true,
      packagingOcrStageShadowOnly: false,
      packagingOcrDualRunCompare: true,
    });
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    // Legacy inline OCR stored but bound to a STALE input hash → the freeze
    // must re-run its OCR moment (forced delegation), and a legacy baseline
    // exists so a comparison row CAN be written.
    const extFixture = { ...settledExtraction(), ocrInputHash: 'stale-hash' };
    const { items } = createReadyCohort(workspaceId, { '100000000451': extFixture });
    getDb().query('UPDATE onboarding_items SET source_type = ? WHERE id = ?')
      .run('distributor_record', items[0].id);

    // PASS 1 — freeze with an in-window CAS mutation so the run supersedes
    // (the pull-forward + write-back already happened; the cohort returns to
    // READY for a second claim, mirroring the two-phase CAS test above).
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-dist-1', COHORT_LEASE_TTL_MS);
    let mutated = false;
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId, {
      beforeFinalCas: () => {
        if (mutated) return;
        mutated = true;
        const live = findItemById(items[0].id)!;
        updateItemExtractionData(
          items[0].id,
          JSON.stringify({ ...live.extractionData, title: 'MUTATED IN WINDOW' }),
        );
      },
    });
    expect(finalized.status).toBe('superseded');

    // The delegated stage emitted 'skipped' for the distributor record, which
    // the freeze delegation maps to TERMINAL 'no_image' before write-back.
    const afterPass1 = JSON.parse(
      String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as any).extraction_data_json),
    ) as Record<string, any>;
    expect(afterPass1.ocrOutcome.status).toBe('no_image');
    // "At most ONE" comparison row: the stage's distributor branch returns
    // before its dual-run writer (no OCR transport happens), so a fresh
    // distributor item writes ZERO rows here — the invariant under test is
    // that the count NEVER grows across passes (no unbounded churn).
    const comparisonsAfterPass1 = countPackagingOcrShadowComparisons(items[0].id);
    expect(comparisonsAfterPass1).toBeLessThanOrEqual(1);

    // PASS 2 — fresh claim re-freezes; OCR is now SETTLED (no_image is
    // terminal) so the pull-forward never re-runs: the comparison-row count
    // is unchanged, outcome unchanged.
    const retried = claimReadyCurationCohorts(workspaceId, 10, 'worker-dist-2', COHORT_LEASE_TTL_MS);
    expect(retried.length).toBe(1);
    const rerun = await freezeCohortForExecution(retried[0], wsPath, workspaceId);
    expect(rerun.status).toBe('running');

    const afterPass2 = JSON.parse(
      String((getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(items[0].id) as any).extraction_data_json),
    ) as Record<string, any>;
    expect(afterPass2.ocrOutcome.status).toBe('no_image');
    expect(countPackagingOcrShadowComparisons(items[0].id)).toBe(comparisonsAfterPass1);
  });
});

// ─── Issue #361: frozen scan and member execution share one semantic mapping ─
// The freeze scan (`evidenceFromProjection`, read-only) and the persisted
// member execution (the frozen evidence stage) interpret the same supplied
// facts identically. These tests observe downstream supported proposals,
// provenance, and OCR eligibility at the existing freeze-scan and
// frozen-member execution seams — never exact copied record arrays,
// call wiring, or incidental counts.

describe('issue #361 — frozen scan/member semantic agreement (freeze + member execution)', () => {
  const TYPE_OPTIONS: ResolvedTargetOption[] = [
    { value: 'dry-dog-food', label: 'Dry Dog Food' },
    { value: 'dry-cat-food', label: 'Dry Cat Food' },
  ];

  type FrozenMember = ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2 | ExecutionEvidenceProjectionMemberV3;

  /** Run the persisted member execution for one frozen projection member. */
  async function executeMember(
    wsPath: string,
    workspaceId: string,
    memberProjection: FrozenMember,
    runId: string,
    childSnapshot: RuntimeClassificationSnapshot,
  ): Promise<{ status: string; evidence: ClassificationEvidence[] }> {
    const result = await evidenceExtractionStage.execute(
      { sku: memberProjection.productSku ?? '', onboardingItemId: memberProjection.onboardingItemId, evidence: [], acceptedProposals: [], allProposals: [] },
      {
        workspacePath: wsPath,
        workspaceId,
        runId,
        configSnapshotRef: childSnapshot.configSnapshotRef,
        snapshot: childSnapshot,
        cohortFrozenEvidence: memberProjection,
      } as never,
    );
    if (result.status !== 'succeeded') return { status: result.status, evidence: [] };
    return {
      status: result.status,
      evidence: (result as { status: 'succeeded'; output: { evidence: ClassificationEvidence[] } }).output.evidence,
    };
  }

  /** Freeze one ready cohort and return the persisted projection + member snapshots. */
  async function freezeOne(workspaceId: string, wsPath: string): Promise<{
    projection: ExecutionEvidenceProjectionV2 | ExecutionEvidenceProjectionV3;
    snapshotsByItem: Record<string, RuntimeClassificationSnapshot>;
    runIdsByItem: Record<string, string>;
  }> {
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-361', COHORT_LEASE_TTL_MS);
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.status).toBe('running');
    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const projection = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson));
    const snapshotsByItem: Record<string, RuntimeClassificationSnapshot> = {};
    const runIdsByItem: Record<string, string> = {};
    for (const member of projection.members) {
      const row = getDb().query(
        'SELECT * FROM classification_runs WHERE cohort_run_id = ? AND onboarding_item_id = ?',
      ).get(run.id, member.onboardingItemId) as { id: unknown; config_snapshot_hash: unknown };
      runIdsByItem[member.onboardingItemId] = String(row.id);
      snapshotsByItem[member.onboardingItemId] = getRuntimeSnapshotByHash(workspaceId, String(row.config_snapshot_hash))!;
    }
    return { projection, snapshotsByItem, runIdsByItem };
  }

  it('official-page facts: scan and member execution agree on supported proposal + provenance', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1ConfigWithProductTypes(workspaceId, wsPath, [
      { id: 'dry-dog-food', name: 'Dry Dog Food' },
      { id: 'dry-cat-food', name: 'Dry Cat Food' },
    ]);
    createReadyCohort(workspaceId, {
      '100000000361': settledExtraction({ _name: 'Purina Pro Plan Dry Dog Food Chicken 5 lb', title: 'Purina Pro Plan Dry Dog Food Chicken 5 lb' }),
    });
    const { projection, snapshotsByItem, runIdsByItem } = await freezeOne(workspaceId, wsPath);
    const member = projection.members[0];
    const scanEvidence = evidenceFromProjection(member, {
      expectedOcrExecutionDigest: computeOcrExecutionDigest(snapshotsByItem[member.onboardingItemId]),
    });
    const scanMatch = matchMemberDeterministically(scanEvidence, TYPE_OPTIONS);
    expect(scanMatch.productTypeId).toBe('dry-dog-food');
    expect(scanMatch.source).toBe('keyword');
    expect(scanEvidence.some(e => e.source === 'official_product_page' && e.sourceField === 'name')).toBe(true);
    const executed = await executeMember(wsPath, workspaceId, member, runIdsByItem[member.onboardingItemId], snapshotsByItem[member.onboardingItemId]);
    expect(executed.status).toBe('succeeded');
    // Same meaning downstream: the member execution supports the same proposal with the same provenance.
    const memberMatch = matchMemberDeterministically(executed.evidence, TYPE_OPTIONS);
    expect(memberMatch.productTypeId).toBe(scanMatch.productTypeId);
    expect(executed.evidence.some(e => e.source === 'official_product_page' && e.sourceField === 'name')).toBe(true);
  });

  it('distributor facts: both consumers keep distributor (never official) provenance and identity-only meaning', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1Config(workspaceId, wsPath);
    const { items } = createReadyCohort(workspaceId, {
      '300000000361': settledExtraction({
        _name: 'Phillips Dry Dog Food Chicken 20 lb',
        title: 'Phillips Dry Dog Food Chicken 20 lb',
        description: 'THIS COPY MUST NEVER BE EMITTED',
        bulletPoints: ['Copy that must not appear'],
        distributorSku: 'DSKU-361',
      }),
    });
    getDb().query('UPDATE onboarding_items SET source_type = ? WHERE id = ?').run('distributor_record', items[0].id);
    const { projection, snapshotsByItem, runIdsByItem } = await freezeOne(workspaceId, wsPath);
    const member = projection.members[0];
    const scanEvidence = evidenceFromProjection(member, {
      expectedOcrExecutionDigest: computeOcrExecutionDigest(snapshotsByItem[member.onboardingItemId]),
    });
    expect(scanEvidence.some(e => e.source === 'official_product_page')).toBe(false);
    expect(scanEvidence.some(e => e.source === 'distributor_record' && e.sourceField === 'distributor_sku')).toBe(true);
    expect(scanEvidence.some(e => e.sourceField === 'description')).toBe(false);
    const executed = await executeMember(wsPath, workspaceId, member, runIdsByItem[member.onboardingItemId], snapshotsByItem[member.onboardingItemId]);
    expect(executed.evidence.some(e => e.source === 'official_product_page')).toBe(false);
    expect(executed.evidence.some(e => e.source === 'distributor_record' && e.sourceField === 'distributor_sku' && e.sourceUrl === null)).toBe(true);
    expect(executed.evidence.some(e => e.sourceField === 'description')).toBe(false);
  });

  it('missing facts: both consumers abstain downstream instead of inferring', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1ConfigWithProductTypes(workspaceId, wsPath, [
      { id: 'dry-dog-food', name: 'Dry Dog Food' },
      { id: 'dry-cat-food', name: 'Dry Cat Food' },
    ]);
    createReadyCohort(workspaceId, {
      '100000000362': settledExtraction({
        _name: 'Generic Pet Product 25 lb',
        title: null,
        description: null,
        brand: null,
        weight: null,
        bulletPoints: [],
        searchKeywords: null,
        customFields: {},
      }),
    });
    const { projection, snapshotsByItem, runIdsByItem } = await freezeOne(workspaceId, wsPath);
    const member = projection.members[0];
    const scanMatch = matchMemberDeterministically(evidenceFromProjection(member, {
      expectedOcrExecutionDigest: computeOcrExecutionDigest(snapshotsByItem[member.onboardingItemId]),
    }), TYPE_OPTIONS);
    expect(scanMatch).toEqual({ productTypeId: null, confidence: null, source: null });
    const executed = await executeMember(wsPath, workspaceId, member, runIdsByItem[member.onboardingItemId], snapshotsByItem[member.onboardingItemId]);
    const memberMatch = matchMemberDeterministically(executed.evidence, TYPE_OPTIONS);
    expect(memberMatch).toEqual({ productTypeId: null, confidence: null, source: null });
  });

  it('eligible explicit package wording supports both consumers while changed inputs or authority exclude it', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    const { bundle } = writeActiveV2Bundle(wsPath);
    upsertConfigSnapshot(workspaceId, bundle);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/img.png') {
          return new Response(Buffer.alloc(2048, 7), { headers: { 'Content-Type': 'image/png' } });
        }
        if (url.pathname === '/api/chat') {
          return Response.json({ message: { content: JSON.stringify({ productName: 'Package Dry Dog Food', flavorVariety: 'Chicken' }) } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    try {
      upsertApiKey('ollama_vlm', 'enabled', `http://127.0.0.1:${server.port}`, 'vlm-model-361');
      createReadyCohort(workspaceId, {
        '100000000363': settledExtraction({
          _name: 'Generic Pet Product 25 lb',
          title: null,
          description: null,
          bulletPoints: [],
          searchKeywords: null,
          customFields: {},
          primaryImage: `http://127.0.0.1:${server.port}/img.png`,
          additionalImages: [],
          ocrOutcome: null,
          packagingOcrData: null,
          packagingTitle: null,
        }),
      });
      const { projection, snapshotsByItem, runIdsByItem } = await freezeOne(workspaceId, wsPath);
      const member = projection.members[0];
      const snapshot = snapshotsByItem[member.onboardingItemId];
      const runId = runIdsByItem[member.onboardingItemId];
      const expectedOcrExecutionDigest = computeOcrExecutionDigest(snapshot);
      const scanEvidence = evidenceFromProjection(member, { expectedOcrExecutionDigest });
      const executed = await executeMember(wsPath, workspaceId, member, runId, snapshot);
      expect(executed.status).toBe('succeeded');
      for (const evidence of [scanEvidence, executed.evidence]) {
        expect(matchMemberDeterministically(evidence, TYPE_OPTIONS).productTypeId).toBe('dry-dog-food');
        expect(evidence.find(e => e.sourceField === 'name' && e.metadata?.provenance === 'packaging_ocr')).toMatchObject({
          source: 'visual_product_evidence',
          value: 'Package Dry Dog Food',
          metadata: { model: 'vlm-model-361' },
        });
        expect(evidence.find(e => e.sourceField === 'flavor' && e.metadata?.provenance === 'packaging_ocr')).toMatchObject({
          source: 'visual_product_evidence',
          attributeId: 'flavor',
          value: 'Chicken',
        });
      }
      const ineligibleMembers: FrozenMember[] = [
        { ...member, extraction: { ...member.extraction, primaryImage: 'https://img.example.com/tampered-361.jpg' } },
        { ...member, extraction: { ...member.extraction, ocr: { ...member.extraction.ocr, ocrExecutionDigest: 'f'.repeat(64) } } },
        { ...member, extraction: { ...member.extraction, ocr: { ...member.extraction.ocr, ocrExecutionDigest: null } } },
      ];
      for (const ineligible of ineligibleMembers) {
        const scan = evidenceFromProjection(ineligible, { expectedOcrExecutionDigest });
        const execution = await executeMember(wsPath, workspaceId, ineligible, runId, snapshot);
        expect(execution.status).toBe('succeeded');
        for (const evidence of [scan, execution.evidence]) {
          expect(evidence.some(e => e.metadata?.provenance === 'packaging_ocr')).toBe(false);
          expect(matchMemberDeterministically(evidence, TYPE_OPTIONS).productTypeId).toBeNull();
        }
      }
      expect(evidenceFromProjection(member, { expectedOcrExecutionDigest: null }).some(e => e.metadata?.provenance === 'packaging_ocr')).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it('separate siblings: each SKU stands on its own facts in both consumers', async () => {
    const { workspaceId, workspacePath: wsPath } = newWorkspace();
    saveV1ConfigWithProductTypes(workspaceId, wsPath, [
      { id: 'dry-dog-food', name: 'Dry Dog Food' },
      { id: 'dry-cat-food', name: 'Dry Cat Food' },
    ]);
    createReadyCohort(workspaceId, {
      '100000000364': settledExtraction({ _name: 'Purina Pro Plan Food Chicken 5 lb', title: 'Purina Pro Plan Dry Dog Food 5 lb' }),
      '100000000365': settledExtraction({ _name: 'Purina Pro Plan Food Salmon 3 lb', title: 'Purina Pro Plan Dry Cat Food 3 lb' }),
    });
    const { projection, snapshotsByItem, runIdsByItem } = await freezeOne(workspaceId, wsPath);
    const expectedTypesBySku: Record<string, string> = {
      '100000000364': 'dry-dog-food',
      '100000000365': 'dry-cat-food',
    };
    // Member execution preserves the same per-SKU divergence (no inheritance).
    for (const [sku, expectedType] of Object.entries(expectedTypesBySku)) {
      const member = projection.members.find(candidate => candidate.productSku === sku)!;
      const executed = await executeMember(wsPath, workspaceId, member, runIdsByItem[member.onboardingItemId], snapshotsByItem[member.onboardingItemId]);
      const memberMatch = matchMemberDeterministically(executed.evidence, TYPE_OPTIONS);
      const scanMatch = matchMemberDeterministically(evidenceFromProjection(member, {
        expectedOcrExecutionDigest: computeOcrExecutionDigest(snapshotsByItem[member.onboardingItemId]),
      }), TYPE_OPTIONS);
      expect(scanMatch.productTypeId).toBe(expectedType);
      expect(memberMatch.productTypeId).toBe(expectedType);
    }
  });
});
