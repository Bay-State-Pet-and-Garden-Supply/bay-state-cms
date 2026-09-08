/**
 * Default-On Sourcing — full-chain end-to-end acceptance suite (plan Milestone F).
 *
 * Proves the FULL chain: import → eligibility (entry policy) → generation →
 * all-provider lookup → qualification/conflict → route → distributor
 * materialization → cohort V2 freeze → distributor-labeled classification →
 * mandatory Review gate → promotion provenance gate.
 *
 * Offline-only: connector transports are injected fixture servers reading
 * src/tests/fixtures/sourcing/*.json (same conventions as
 * sourcing-recovery-acceptance.test.ts); qualification-sensitive legs seed
 * evidence attempts directly (same convention as sourcing-pass-through.test.ts).
 *
 * IMPORTANT: this suite is registered as a SINGLE-FILE bun test invocation in
 * test:db — never group it with cohort-freeze/cohort-worker (a pre-existing
 * bun worker-mode hang).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  completeSourcingWithDecision,
  updateItemStageStatus,
  resetItemsForRetry,
} from '../../db/repositories/onboarding-item-repo';
import {
  startSourcingGeneration,
  supersedeCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  insertEvidenceAttempt,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { getAcceptedAttemptIdsForItem, recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { OnboardingWorker } from '../../onboarding/job-queue';
import {
  overrideSourcingFlags,
  resetSourcingFlagsOverride,
  getSourcingFlags,
} from '../../onboarding/flags';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import { PhillipsConnector } from '../../onboarding/sourcing/connectors/phillips';
import { BCIConnector } from '../../onboarding/sourcing/connectors/bci';
import {
  materializeDistributorRecordExtraction,
  DISTRIBUTOR_MATERIALIZATION_ERROR_CODES,
} from '../../onboarding/sourcing/distributor-record-materializer';
import { buildDistributorRecordProjection } from '../../onboarding/sourcing/distributor-record-projection';
import { refreshCandidateCohorts } from '../../onboarding/curation-cohort-service';
import {
  claimReadyCurationCohorts,
  COHORT_LEASE_TTL_MS,
  getCohortSnapshotByHash,
} from '../../db/repositories/classification-cohort-run-repo';
import { updateCohortStatus } from '../../db/repositories/curation-cohort-repo';
import { freezeCohortForExecution } from '../../onboarding/cohort-curation/freeze';
import { parseExecutionEvidenceProjection, PROJECTION_VERSION_V3, ExecutionEvidenceProjectionV3Schema } from '../../shared/schemas/cohorts';
import { hashCanonicalJson } from '../../shared/stable-id';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { curateItemWithPipeline } from '../../onboarding/product-curator';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { overrideCohortCurationFlags, resetCohortCurationFlagsOverride } from '../../classification/flags';
import { promoteItems } from '../../onboarding/draft-promoter';
import { prepareItemsForPromotion } from './helpers/seed-promotion-approval';
import type { Workspace } from '../../shared/types';
import type { ClassificationConfig } from '../../shared/schemas/classification';

// ─── Fixture transports (no network) ───────────────────────────────────────────

const phillipsPage = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'phillips-page.json'), 'utf8'),
);
const bciPage = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'bci-page.json'), 'utf8'),
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** Routes fixture URLs: OAuth token, /products (Phillips), /me/products (BCI). */
function fixtureFetchImpl(url: string): Promise<Response> {
  if (url.includes('/oauth/token')) {
    return Promise.resolve(jsonResponse({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }));
  }
  if (url.includes('/me/products')) {
    return Promise.resolve(jsonResponse(bciPage));
  }
  return Promise.resolve(jsonResponse(phillipsPage));
}

const fixtureRegistry: ConnectorRegistry = {
  createConnector(_connectorType, distributorId) {
    const did = String(distributorId ?? '').toLowerCase();
    if (did === 'bci' || did === 'ordercloud') {
      return new BCIConnector({ fetchImpl: fixtureFetchImpl as unknown as typeof fetch });
    }
    return new PhillipsConnector({ fetchImpl: fixtureFetchImpl as unknown as typeof fetch });
  },
};

function fixtureWorker(workspaceId: string, workspacePath: string): OnboardingWorker {
  return new OnboardingWorker(workspaceId, workspacePath, 10, 3, () => new DefaultSourcingEngine(fixtureRegistry));
}

/**
 * EXACTLY ONE poll + drain (same convention as sourcing-recovery-acceptance):
 * the sourcing outcome is terminal after one cycle; a second poll would
 * re-claim and escalate discovery retry counters.
 */
async function settle(worker: OnboardingWorker): Promise<void> {
  await worker.poll();
  await worker.drain();
}

// Minimal valid legacy v1 classification config (mirrors cohort-freeze suite).
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

// ─── Suite ─────────────────────────────────────────────────────────────────────

describe('Default-On Sourcing full-chain E2E (MF)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;
  let wsPath: string;

  beforeEach(() => {
    // Absent-flag default (Amendment A): delete both env keys so the
    // default-on test observes the missing-flag → enabled+automatic default.
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    resetSourcingFlagsOverride();
    // P0 taxonomy freeze: this suite writes a legacy config, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-e2e-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    wsPath = path.join(tempDir, 'ws-e2e');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    process.env.FIXTURE_PHILLIPS_KEY = 'fixture-phillips-key';
    process.env.FIXTURE_BCI_KEY = 'fixture-bci-id:fixture-bci-secret';

    workspaceId = 'ws-e2e';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    resetCohortCurationFlagsOverride();
    setTaxonomyFreezeForTests(true);
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeItem(upc: string, name: string, stage: 'sourcing' | 'discovery' = 'sourcing', version = SOURCING_ENTRY_POLICY_VERSION) {
    const batch = createBatch({ workspaceId, name: `Batch ${upc}`, fileName: `${upc}.csv`, totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc, name, rowNumber: 1, stage }], stage, version);
    return { batch, item };
  }

  function enableConnection(distributorId: string): void {
    const conn = createConnection({ workspaceId, distributorId, connectorType: 'api', secretRef: `FIXTURE_${distributorId.toUpperCase()}_KEY` });
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
  }

  /** Directly seed a QUALIFIED found attempt (full projection provenance floor). */
  function seedQualified(
    itemId: string,
    upc: string,
    generationId: string,
    providerId: string,
    identity: Record<string, unknown> = {},
    extra: Partial<Parameters<typeof insertEvidenceAttempt>[0]> = {},
  ) {
    const conn = createConnection({ workspaceId, distributorId: providerId === 'bci' ? 'bci' : 'phillips', connectorType: 'api', secretRef: `FIXTURE_${providerId.toUpperCase()}_KEY` });
    return insertEvidenceAttempt({
      itemId,
      providerId,
      distributorConnectionId: conn.id,
      lookupUpc: upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc', 'name'],
      identityJson: JSON.stringify({ upc, name: 'Pet Kibble 5lb', brand: 'Brand A', weight: '10 lbs', ...identity }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: generationId,
      ...extra,
    });
  }

  /** Directly seed a non-qualifying attempt (found/not_stocked/source_error). */
  function seedAttempt(
    itemId: string,
    upc: string,
    generationId: string,
    outcome: 'found' | 'not_stocked' | 'source_error',
    identityJson: string | null,
    providerId = 'p1',
    extra: Partial<Parameters<typeof insertEvidenceAttempt>[0]> = {},
  ) {
    const conn = createConnection({ workspaceId, distributorId: providerId === 'bci' ? 'bci' : 'phillips', connectorType: 'api', secretRef: `FIXTURE_${providerId.toUpperCase()}_KEY` });
    return insertEvidenceAttempt({
      itemId,
      providerId,
      distributorConnectionId: conn.id,
      lookupUpc: upc,
      outcome,
      confidence: outcome === 'found' ? 0.9 : 0,
      evidenceUrl: null,
      matchedFields: outcome === 'found' ? ['upc'] : [],
      identityJson,
      warningsJson: null,
      errorCode: outcome === 'source_error' ? 'timeout' : null,
      errorMessage: outcome === 'source_error' ? 'provider timed out' : null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: generationId,
      ...extra,
    });
  }

  function extractionCount(itemId: string): number {
    const r = getDb().query('SELECT COUNT(*) as c FROM onboarding_extractions WHERE item_id = ?').get(itemId) as { c: number };
    return r.c;
  }

  // 1. Absent flag / automatic / default-on new import enters Sourcing.
  test('1. absent flag (default-on): new import enters Sourcing and the worker routes it (automatic)', async () => {
    const flags = getSourcingFlags();
    expect(flags.effectiveEnabled).toBe(true);
    expect(flags.mode).toBe('automatic');
    expect(flags.reason).toBe('default_on');

    const { item } = makeItem('012345678905', 'Default On');
    const genBefore = getDb().query('SELECT COUNT(*) as c FROM sourcing_generations').get() as { c: number };

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    // The sourcing leg RAN under the default (generation created, route applied).
    const genAfter = getDb().query('SELECT COUNT(*) as c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(genAfter.c).toBe(genBefore.c + 1);
    expect(after?.sourcingDecision?.route).toBeDefined();
    expect((after?.sourcingDecision as { schemaVersion?: number } | null)?.schemaVersion).toBe(2);
  });

  // 2. Explicit false → Discovery + fail-closed reason.
  test('2. explicit false: kill switch — import enters Discovery with fail-closed reason', async () => {
    process.env.BAYSTATE_CMS_SOURCING_ENABLED = 'false';
    const flags = getSourcingFlags();
    expect(flags.effectiveEnabled).toBe(false);
    expect(flags.reason).toBe('env_disabled');

    const { item } = makeItem('012345678901', 'Off Item', 'discovery');
    let engineCalls = 0;
    const countingWorker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => {
      engineCalls++;
      return new DefaultSourcingEngine();
    });
    await settle(countingWorker);
    expect(findItemById(item.id)?.stage).toBe('discovery');
    expect(engineCalls).toBe(0);
    const generations = getDb().query('SELECT COUNT(*) as c FROM sourcing_generations').get() as { c: number };
    expect(generations.c).toBe(0);
  });

  // 3. Malformed configuration → fail-closed disabled.
  test('3. malformed configuration: fail-closed disabled with stable reason', async () => {
    process.env.BAYSTATE_CMS_SOURCING_ENABLED = 'banana';
    const flags = getSourcingFlags();
    expect(flags.effectiveEnabled).toBe(false);
    expect(flags.reason).toBe('malformed_config');

    const { item } = makeItem('012345678901', 'Malformed Item', 'discovery');
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(findItemById(item.id)?.stage).toBe('discovery');
    // SERP retirement: offline discovery is deterministic — zero candidates
    // settles the row at discovery/completed with a needsManualReview flag
    // instead of the legacy failed-attempt → pending path.
    expect(findItemById(item.id)?.stageStatus).toBe('completed');
  });

  // 4. Observe mutation isolation (found/conflict/error/timeout/repeat polling).
  test('4. observe mode: generations+attempts only — zero decisions/acceptances/conflicts/extractions, repeat poll idempotent', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    enableConnection('phillips');
    const { item } = makeItem('012345678905', 'Observe Item', 'discovery');

    // First poll: the observation hook runs at the top of processDiscovery
    // (mode=observe + marker-v1) and persists ONLY a generation + attempts.
    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBeGreaterThan(0);
    // Zero authoritative writes. Discovery settles completed offline (no
    // brand domain indexed → needs_input_no_candidates).
    const after = findItemById(item.id);
    expect(after?.sourcingDecision).toBeNull();
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([]);
    expect(getDb().query('SELECT COUNT(*) as c FROM onboarding_evidence_conflicts WHERE item_id = ?').get(item.id)).toMatchObject({ c: 0 });
    expect(extractionCount(item.id)).toBe(0);

    // Repeat polling is generation-idempotent: a second observation cycle
    // reuses the existing generation (no new rows) and adds no attempts.
    // NOTE: discovery runs entirely against local brand-domain indexes, so
    // offline it completes deterministically (needs_input_no_candidates) and
    // the item settles at discovery/completed after the first poll.
    const attemptsBeforeRepeat = getCurrentGenerationAttempts(item.id).length;
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(attemptsBeforeRepeat).toBe(getCurrentGenerationAttempts(item.id).length);
    const gens = getDb().query('SELECT COUNT(*) as c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(gens.c).toBe(1);
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([]);
    expect(extractionCount(item.id)).toBe(0);
  });

  // 5. Manual explicit route: hold → qualification view → use_distributor_record → extraction.
  test('5. manual mode: qualification hold with relational acceptances; explicit operator route to Extraction; materialization completes', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const { item } = makeItem('012345678905', 'Manual Item');
    const gen = startSourcingGeneration(item.id, 'operator_override');
    const att = seedQualified(item.id, item.upc, gen.id, 'phillips');

    await settle(fixtureWorker(workspaceId, tempDir));

    // Manual hold: item at sourcing/needs_input; accepted evidence persisted
    // RELATIONALLY (the qualification view authority).
    const held = findItemById(item.id);
    expect(held?.stage).toBe('sourcing');
    expect(held?.stageStatus).toBe('needs_input');
    expect(held?.sourcingDecision?.route).toBe('needs_input_conflict');
    expect(getAcceptedAttemptIdsForItem(item.id)).toContain(att.id);

    // Server-side qualification recompute (the same authority the
    // use_distributor_record route applies; the HTTP route is covered in
    // sourcing-safety-routes.test.ts).
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: item.upc,
      sourcingGenerationId: gen.id,
      attempts: getCurrentGenerationAttempts(item.id),
      acceptedAttemptIds: getAcceptedAttemptIdsForItem(item.id),
    });
    expect(projection.qualified).toBe(true);
    if (!projection.qualified) return;
    const hash = projection.evidenceHash;

    const decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: getAcceptedAttemptIdsForItem(item.id),
      providerIds: ['phillips'],
      sourcingGenerationId: gen.id,
      evidenceHash: hash,
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    const res = completeSourcingWithDecision(item.id, decision as never, 'collect_details');
    expect(res.ok).toBe(true);

    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');
    expect(routed?.sourceType).toBe('distributor_record');
    expect(routed?.sourceUrl).toBeNull();

    updateItemStageStatus(item.id, 'in_progress');
    const mat = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(mat.ok).toBe(true);
    const done = findItemById(item.id);
    expect(done?.stage).toBe('extraction');
    expect(done?.stageStatus).toBe('completed');
    expect(done?.extractionData?.sourceType).toBe('distributor_record');
    expect(done?.extractionData?.title).toBe('Pet Kibble 5lb');
    expect(done?.extractionData?.description).toBeNull();
    expect(done?.extractionData?.price).toBeNull();
    expect(done?.extractionData?.primaryImage).toBeNull();
    expect(extractionCount(item.id)).toBe(1);
  });

  // 6. Automatic single-provider qualified → extraction → materialize (provenance + idempotent retry).
  test('6. automatic: qualified single-provider routes to Extraction; materialization is provenance-bound and retry-idempotent', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678905', 'Auto Item');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips');

    const worker = fixtureWorker(workspaceId, tempDir);
    await settle(worker); // Sourcing routes to extraction/pending
    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');
    expect(routed?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(routed?.sourceType).toBe('distributor_record');
    expect(routed?.sourceUrl).toBeNull();
    expect(extractionCount(item.id)).toBe(0);

    await settle(worker); // Extraction claims + materializes
    const done = findItemById(item.id);
    expect(done?.stageStatus).toBe('completed');
    expect(done?.extractionData?.title).toBe('Pet Kibble 5lb');
    expect(done?.extractionData?.sourceType).toBe('distributor_record');

    const row = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').get(item.id) as Record<string, unknown>;
    expect(row.extraction_method).toBe('distributor_record_v2');
    expect(row.source_type).toBe('distributor_record');
    expect(row.source_url).toBeNull();
    expect(row.sourcing_generation_id).toBe(gen.id);
    expect(String(row.evidence_hash)).toMatch(/^[0-9a-f]{64}$/);

    // Retry idempotency: same generation/hash → completed, NO second row.
    updateItemStageStatus(item.id, 'in_progress');
    const retry = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(retry.ok).toBe(true);
    expect(extractionCount(item.id)).toBe(1);
    expect(findItemById(item.id)?.stageStatus).toBe('completed');
  });

  // 7b. Equivalent weight formatting/units across providers → NO conflict
  // (operator weight rule + GPT plan): the item qualifies, the structured
  // weight materializes as canonical pounds (2dp), and the NAME keeps its
  // original units.
  test('7b. equivalent weights (16 oz vs 1.0000 lb) → no conflict, canonical weight, name untouched', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678906', "Butcher's Pup 16 oz");
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips', { name: "Butcher's Pup 16 oz", weight: '16 oz' });
    seedQualified(item.id, item.upc, gen.id, 'bci', { name: "Butcher's Pup 16 oz", weight: '1.0000 lb' });

    const worker = fixtureWorker(workspaceId, tempDir);
    await settle(worker); // Sourcing: qualified — formatting disagreement is NOT a conflict
    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');
    expect(routed?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(routed?.sourcingDecision?.conflicts).toEqual([]);

    await settle(worker); // Extraction materializes
    const done = findItemById(item.id);
    expect(done?.stageStatus).toBe('completed');
    expect(done?.extractionData?.weight).toBe('1.00');
    // The operator rule: NEVER normalize the name/title.
    expect(done?.extractionData?.title).toBe("Butcher's Pup 16 oz");
  });

  // 7. Two agreeing providers → both accepted → extraction.
  test('7. two agreeing providers: both accepted, qualified, route to Extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678905', 'Agree Item');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips');
    seedQualified(item.id, item.upc, gen.id, 'bci');

    await settle(fixtureWorker(workspaceId, tempDir));

    const accepted = getAcceptedAttemptIdsForItem(item.id);
    expect(accepted.length).toBe(2);
    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');
    expect(routed?.sourcingDecision?.providerIds).toEqual(expect.arrayContaining(['phillips', 'bci']));
  });

  // 8. Flavor/formula/custom-axis auto-resolution in automatic mode.
  test('8. flavor disagreement auto-resolves to primary distributor → routes to Extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678903', 'Flavor Conflict');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips', { attributes: { flavor: 'chicken' } });
    seedQualified(item.id, item.upc, gen.id, 'bci', { attributes: { flavor: 'beef' } });

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    const warnings = (after?.sourcingDecision?.warnings ?? []) as string[];
    expect(warnings.some((w) => w.includes("Identity field 'flavor' auto-resolved"))).toBe(true);
  });

  // 8b. Formula disagreement auto-resolves.
  test('8b. formula disagreement auto-resolves to primary distributor → routes to Extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678903', 'Formula Conflict');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips', { attributes: { formula: 'A' } });
    seedQualified(item.id, item.upc, gen.id, 'bci', { attributes: { formula: 'B' } });

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
  });

  // 8c. Connector-declared custom-axis disagreement auto-resolves.
  test('8c. custom-axis (connector-declared) disagreement auto-resolves → routes to Extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678903', 'Custom Axis Conflict');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    const declarations = [{ rawField: 'scent', normalizedAxis: 'scent' }];
    const withDeclarations = { variantAxisDeclarations: declarations } as unknown as Partial<Parameters<typeof insertEvidenceAttempt>[0]>;
    seedQualified(item.id, item.upc, gen.id, 'phillips', { attributes: { scent: 'peach' } }, withDeclarations);
    seedQualified(item.id, item.upc, gen.id, 'bci', { attributes: { scent: 'cedar' } }, withDeclarations);

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
  });

  // 9. Unknown variant axis / no-name insufficiency → evidence_to_discovery.
  test('9. unknown variant axis and missing-name evidence stay insufficient → evidence_to_discovery', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678903', 'Insufficient');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    // Unknown variant axis (scent is not built-in and not declared).
    seedQualified(item.id, item.upc, gen.id, 'phillips', { attributes: { scent: 'peach' } });

    await settle(fixtureWorker(workspaceId, tempDir));
    const afterUnknown = findItemById(item.id);
    expect(afterUnknown?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(afterUnknown?.stage).toBe('discovery');

    // Missing name → insufficient.
    const item2 = makeItem('012345678904', 'No Name');
    const gen2 = startSourcingGeneration(item2.item.id, 'automatic_policy');
    seedQualified(item2.item.id, item2.item.upc, gen2.id, 'phillips', { name: '' });
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(findItemById(item2.item.id)?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(findItemById(item2.item.id)?.stage).toBe('discovery');
  });

  // 10. Found + provider timeout → qualified route with the error warning retained.
  test('10. qualified found + provider timeout: routes to Extraction with the provider-error warning retained', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678905', 'Found Plus Timeout');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips');
    seedAttempt(item.id, item.upc, gen.id, 'source_error', null, 'bci');

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    const warnings = (after?.sourcingDecision?.warnings ?? []) as string[];
    expect(warnings.some((w) => /bci/i.test(w) || /timed out/i.test(w))).toBe(true);
  });

  // 11. All-not-stocked → fallback; provider-only errors → degraded.
  test('11. all not_stocked → fallback_to_discovery; provider-only errors → degraded_fallback_to_discovery', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678904', 'Not Stocked');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedAttempt(item.id, item.upc, gen.id, 'not_stocked', null, 'phillips');
    seedAttempt(item.id, item.upc, gen.id, 'not_stocked', null, 'bci');
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(findItemById(item.id)?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(findItemById(item.id)?.stage).toBe('discovery');

    const item2 = makeItem('012345678906', 'Only Errors');
    const gen2 = startSourcingGeneration(item2.item.id, 'automatic_policy');
    seedAttempt(item2.item.id, item2.item.upc, gen2.id, 'source_error', null, 'phillips');
    seedAttempt(item2.item.id, item2.item.upc, gen2.id, 'source_error', null, 'bci');
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(findItemById(item2.item.id)?.sourcingDecision?.route).toBe('degraded_fallback_to_discovery');
    expect(findItemById(item2.item.id)?.stage).toBe('discovery');
  });

  // 12. 148 marker-v0 rows: zero claims/observations/connector calls.
  test('12. 148 legacy marker-v0 sourcing rows: zero claims, zero observations, zero connector calls', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    let engineCalls = 0;
    const batch = createBatch({ workspaceId, name: 'Legacy', fileName: 'legacy.csv', totalItems: 149 });
    // 148 version-0 stranded rows.
    for (let i = 0; i < 148; i++) {
      insertItems(batch.id, [{ upc: `010000000${String(100 + i)}`, name: `Legacy ${i}`, rowNumber: i + 1, stage: 'sourcing' }]);
    }
    // 1 version-1 eligible row (claimable).
    const [eligible] = insertItems(
      batch.id,
      [{ upc: '012345678905', name: 'Eligible', rowNumber: 149, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    enableConnection('phillips');

    const countingWorker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => {
      engineCalls++;
      return new DefaultSourcingEngine(fixtureRegistry);
    });
    await settle(countingWorker);

    // Version-0 rows untouched.
    const v0rows = getDb().query(
      "SELECT COUNT(*) as c FROM onboarding_items WHERE batch_id = ? AND sourcing_entry_policy_version = 0 AND stage = 'sourcing' AND stage_status = 'pending'",
    ).get(batch.id) as { c: number };
    expect(v0rows.c).toBe(148);
    // The version-1 row was claimed and routed.
    const routed = findItemById(eligible.id);
    expect(routed?.stage).toBe('extraction');
    // Zero observations on v0 rows: generations/attempts only for the v1 item.
    const genRows = getDb().query(
      'SELECT DISTINCT item_id FROM sourcing_generations',
    ).all() as Array<{ item_id: string }>;
    expect(genRows.length).toBe(1);
    expect(genRows[0].item_id).toBe(eligible.id);
    // Engine ran for exactly one item (the v1 row).
    expect(engineCalls).toBe(1);
  });

  // 12b. Manual mode holds every non-conflict outcome at sourcing/needs_input.
  test('12b. manual mode holds every non-conflict outcome at sourcing/needs_input', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const { item } = makeItem('012345678905', 'Manual Hold');
    const gen = startSourcingGeneration(item.id, 'manual_policy');
    seedQualified(item.id, item.upc, gen.id, 'phillips');

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
  });

  // 13. Retry supersession / stale generation never routes.
  test('13. retry supersedes the generation; stale attempts never influence the new decision', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const { item } = makeItem('012345678903', 'Retry Supersede');
    const gen1 = startSourcingGeneration(item.id, 'manual_policy');
    seedQualified(item.id, item.upc, gen1.id, 'phillips', { attributes: { size: '10 lb' } });
    await settle(fixtureWorker(workspaceId, tempDir));
    expect(findItemById(item.id)?.stage).toBe('sourcing');
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');

    // Operator retry supersedes generation 1 and runs in automatic mode
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    seedQualified(item.id, item.upc, gen2.id, 'phillips');
    updateItemStageStatus(item.id, 'pending');
    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    // The stale generation's attempts remain audit-visible but inert.
    expect(getDb().query('SELECT COUNT(*) as c FROM sourcing_generations WHERE item_id = ?').get(item.id)).toMatchObject({ c: 2 });
  });

  // 14. Materialization authority failures → extraction/failed stable codes, zero rows.
  test('14. hash mismatch and superseded generation fail closed with stable codes and zero partial materialization', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678905', 'Hash Fail');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    const att = seedQualified(item.id, item.upc, gen.id, 'phillips');

    // Route with a CORRUPTED hash (decision hash does not match the recomputed projection).
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: item.upc,
      sourcingGenerationId: gen.id,
      attempts: getCurrentGenerationAttempts(item.id),
      acceptedAttemptIds: [att.id],
    });
    if (!projection.qualified) throw new Error('fixture must qualify');
    const badHash = '0'.repeat(64);
    const decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [att.id],
      providerIds: ['phillips'],
      sourcingGenerationId: gen.id,
      evidenceHash: badHash,
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    const res = completeSourcingWithDecision(item.id, decision as never, 'collect_details');
    expect(res.ok).toBe(true);
    // The worker records relational acceptances before routing; mirror it so
    // the materializer's acceptance-equality check passes and the corrupted
    // HASH is the invariant that fires (hash_mismatch, not acceptance_mismatch).
    recordAcceptances(item.id, [att.id], 'system', 'qualified distributor record (hash-mismatch scenario)');
    updateItemStageStatus(item.id, 'in_progress');
    const failed = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch);
    expect(extractionCount(item.id)).toBe(0);
    expect(findItemById(item.id)?.stage).toBe('extraction');
    expect(findItemById(item.id)?.stageStatus).toBe('in_progress');

    // Superseded generation → stable code. supersedeCurrentSourcingGeneration
    // creates a FRESH current generation, so the decision's generation is now
    // STALE (not current) → stale_generation is the accurate code.
    supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    const failedGen = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(failedGen.ok).toBe(false);
    if (!failedGen.ok) expect(failedGen.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stale_generation);
    expect(extractionCount(item.id)).toBe(0);

    // A generation marked superseded WITHOUT a successor (cancelled mid-run)
    // is the distinct superseded_generation code. Fresh item so the decision
    // references the generation that is later marked superseded (still the
    // latest row — no successor).
    const item2 = makeItem('012345678907', 'Superseded Gen');
    const gen2row = startSourcingGeneration(item2.item.id, 'automatic_policy');
    const att2 = seedQualified(item2.item.id, item2.item.upc, gen2row.id, 'phillips');
    const proj2 = buildDistributorRecordProjection({
      itemId: item2.item.id,
      itemUpc: item2.item.upc,
      sourcingGenerationId: gen2row.id,
      attempts: getCurrentGenerationAttempts(item2.item.id),
      acceptedAttemptIds: [att2.id],
    });
    if (!proj2.qualified) throw new Error('fixture must qualify');
    const res2 = completeSourcingWithDecision(
      item2.item.id,
      {
        schemaVersion: 2,
        route: 'distributor_record_to_extraction',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: [att2.id],
        providerIds: ['phillips'],
        sourcingGenerationId: gen2row.id,
        evidenceHash: proj2.evidenceHash,
        sourceType: 'distributor_record',
        target: 'extraction',
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      } as never,
      'collect_details',
    );
    expect(res2.ok).toBe(true);
    recordAcceptances(item2.item.id, [att2.id], 'system', 'qualified distributor record (superseded-gen scenario)');
    updateItemStageStatus(item2.item.id, 'in_progress');
    getDb().query("UPDATE sourcing_generations SET status = 'superseded' WHERE id = ?").run(gen2row.id);
    const failedSuperseded = materializeDistributorRecordExtraction(item2.item.id, workspaceId);
    expect(failedSuperseded.ok).toBe(false);
    if (!failedSuperseded.ok) expect(failedSuperseded.code).toBe(DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.superseded_generation);
    expect(extractionCount(item2.item.id)).toBe(0);
  });

  // 15. V2 cohort freeze → distributor provenance + distributor_record classification source.
  test('15. materialized distributor item freezes as execution-evidence-v2 with distributor provenance and identity-only extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    saveClassificationConfig(wsPath, V1_CONFIG);
    syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));

    const { batch, item } = makeItem('012345678905', 'Freeze Item');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    const att = seedQualified(item.id, item.upc, gen.id, 'phillips');
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: item.upc,
      sourcingGenerationId: gen.id,
      attempts: getCurrentGenerationAttempts(item.id),
      acceptedAttemptIds: [att.id],
    });
    if (!projection.qualified) throw new Error('fixture must qualify');
    const decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [att.id],
      providerIds: ['phillips'],
      sourcingGenerationId: gen.id,
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    expect(completeSourcingWithDecision(item.id, decision as never, 'collect_details').ok).toBe(true);
    // The worker records relational acceptances before routing; mirror it so
    // the materializer's acceptance-equality check passes (E2E repo-direct
    // routes bypass the worker).
    recordAcceptances(item.id, [att.id], 'system', 'qualified distributor record (freeze scenario)');
    updateItemStageStatus(item.id, 'in_progress');
    const mat = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(mat.ok).toBe(true);

    // Form a ready cohort from the materialized item.
    const formed = refreshCandidateCohorts(workspaceId, batch.id);
    expect(formed.length).toBeGreaterThan(0);
    const cohort = formed[0];
    updateCohortStatus(cohort.id, 'ready');

    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(run).toBeDefined();
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.evidenceSnapshotHash).not.toBeNull();

    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    expect(snap).not.toBeNull();
    const frozenV3 = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson)) as any;
    expect(frozenV3.version).toBe(PROJECTION_VERSION_V3);
    expect(ExecutionEvidenceProjectionV3Schema.safeParse(frozenV3).success).toBe(true);
    expect(hashCanonicalJson(frozenV3)).toBe(finalized.evidenceSnapshotHash!);
    const member = frozenV3.members[0];
    expect(member.importedIdentity).toBeDefined();
    if (member.importedIdentity.provenanceHash !== null) {
      expect(member.importedIdentity.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect([null, 0, 1].includes(member.importedIdentity.version as any)).toBe(true);
    expect(member.onboardingItemId).toBe(item.id);
    expect(member.itemSourceType).toBe('distributor_record');
    expect(member.extractionSourceType).toBe('distributor_record');
    expect(member.sourcingGenerationId).toBe(gen.id);
    expect(member.acceptedEvidenceAttemptIds).toEqual([att.id]);
    expect(member.distributorEvidenceHash).toBe(projection.evidenceHash);
    expect(member.extraction.title).toBe('Pet Kibble 5lb');
    expect(member.extraction.description).toBeNull();
    expect(member.extraction.primaryImage).toBeNull();
    // Per-distributor reference values are frozen into the curation input so
    // Curation/classification can consume every accepted attempt's values.
    expect(member.extraction.distributorReferenceValues).toMatchObject({
      name: ['Pet Kibble 5lb'],
    });

    // EXECUTE distributor-labeled classification: run the classification
    // evidence-extraction stage over the frozen V2 member and assert every
    // evidence record truthfully carries source='distributor_record' with a
    // NULL classification URL and identity-only fields — never elevated to
    // official_product_page and never emitting copy/images/claims.
    const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
    const result = await evidenceExtractionStage.execute(
      { sku: item.upc, onboardingItemId: item.id, evidence: [], acceptedProposals: [], allProposals: [] },
      {
        workspacePath: wsPath,
        workspaceId,
        runId: 'run-dist-e2e',
        configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
        snapshot: undefined,
        cohortFrozenEvidence: member as never,
      } as never,
    );
    expect(result.status).toBe('succeeded');
    const evidence = (result as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output.evidence;
    expect(evidence.length).toBeGreaterThan(0);
    // Distributor identity entries are labeled distributor_record with a NULL
    // classification URL (spreadsheet-identity entries may legitimately coexist).
    const distEntries = evidence.filter((e) => e.source === 'distributor_record');
    expect(distEntries.length).toBeGreaterThan(0);
    for (const entry of distEntries) {
      expect(entry.source).toBe('distributor_record');
      expect(entry.sourceUrl).toBeNull();
    }
    expect(evidence.some((e) => e.source === 'official_product_page')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'description')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'bullet_point')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'search_keywords')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'primaryImage')).toBe(false);
    // Provenance metadata rides the identity fields.
    const nameEntry = evidence.find((e) => e.sourceField === 'name' && e.source === 'distributor_record');
    expect(nameEntry).toBeDefined();
    expect(nameEntry!.metadata.sourcingGenerationId).toBe(gen.id);
    expect(nameEntry!.metadata.distributorEvidenceHash).toBe(projection.evidenceHash);
  });

  // 16. Raw image non-flow + promotion provenance gate (no draft on tamper).
  test('16. raw distributor images never flow; promotion requires reviewed authority and blocks tampered provenance', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { batch, item } = makeItem('012345678905', 'Promo Gate');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    const att = seedQualified(item.id, item.upc, gen.id, 'phillips');
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: item.upc,
      sourcingGenerationId: gen.id,
      attempts: getCurrentGenerationAttempts(item.id),
      acceptedAttemptIds: [att.id],
    });
    if (!projection.qualified) throw new Error('fixture must qualify');
    const decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [att.id],
      providerIds: ['phillips'],
      sourcingGenerationId: gen.id,
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    expect(completeSourcingWithDecision(item.id, decision as never, 'collect_details').ok).toBe(true);
    recordAcceptances(item.id, [att.id], 'system', 'qualified distributor record (image-boundary scenario)');
    updateItemStageStatus(item.id, 'in_progress');
    expect(materializeDistributorRecordExtraction(item.id, workspaceId).ok).toBe(true);

    // Image non-flow: the extraction row + payload carry zero image fields.
    const row = getDb().query('SELECT images_json FROM onboarding_extractions WHERE item_id = ?').get(item.id) as { images_json: string | null };
    expect(row.images_json).toBeNull();
    const done = findItemById(item.id);
    expect(done?.extractionData?.primaryImage).toBeNull();
    expect(done?.extractionData?.additionalImages ?? []).toEqual([]);

    // Defense in depth: even if a tampered payload ACQUIRED a raw image URL,
    // the distributor downloader boundary must never fetch it. Spy the global
    // fetch used by downloadAndProcessImages and assert zero invocations.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls++;
      return originalFetch(...args);
    }) as unknown as typeof fetch;
    try {
      getDb().run(
        `UPDATE onboarding_items SET extraction_data_json = json_set(extraction_data_json, '$.primaryImage', ?) WHERE id = ?`,
        ['http://127.0.0.1:9/raw-distributor-image.jpg', item.id],
      );
      // Epic #46 review round-2: promotion requires durable approval at the
      // final authority; move the distributor item into the real post-approval
      // state so the intended provenance gate fires.
      prepareItemsForPromotion([{ id: item.id, batchId: batch.id }]);
      const promoteTampered = await promoteItems(workspaceId, wsPath, batch.id, [item.id]);
      expect(promoteTampered.failures.length).toBeGreaterThan(0);
      expect(promoteTampered.count).toBe(0);
      // Zero raw distributor image downloads — the payload URL never reaches
      // the downloader (gate refusal AND distributor-source null image args).
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Promotion without a reviewed type is blocked (Review stays mandatory —
    // the Execution Product Type is never promotion authority).
    prepareItemsForPromotion([{ id: item.id, batchId: batch.id }]);
    const promote1 = await promoteItems(workspaceId, wsPath, batch.id, [item.id]);
    expect(promote1.failures.length).toBeGreaterThan(0);
    expect(promote1.count).toBe(0);

    // Tampered materialization provenance can never draft either: corrupt the
    // durable extraction row's evidence hash → still blocked (fail closed).
    getDb().run(
      'UPDATE onboarding_extractions SET evidence_hash = ? WHERE item_id = ?',
      ['f'.repeat(64), item.id],
    );
    prepareItemsForPromotion([{ id: item.id, batchId: batch.id }]);
    const promote2 = await promoteItems(workspaceId, wsPath, batch.id, [item.id]);
    expect(promote2.failures.length).toBeGreaterThan(0);
    expect(promote2.count).toBe(0);
  });

  // 16b. (M5b-2) Curation consumes VERIFIED v2 merchandising copy.
  test('16b. verified v2 distributor materialization feeds curatedDescription + keyword synthesis; tampered stays blocked', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    saveClassificationConfig(wsPath, V1_CONFIG);
    syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));

    const { item } = makeItem('012345678906', 'Curate V2');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    const att = seedQualified(item.id, item.upc, gen.id, 'phillips', {
      description: 'Verified v2 merchandising description.',
      features: ['Feature Alpha', 'Feature Beta'],
      category: 'Dog Food',
    });
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: item.upc,
      sourcingGenerationId: gen.id,
      attempts: getCurrentGenerationAttempts(item.id),
      acceptedAttemptIds: [att.id],
    });
    if (!projection.qualified) throw new Error('fixture must qualify');
    const decision = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [att.id],
      providerIds: ['phillips'],
      sourcingGenerationId: gen.id,
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    };
    expect(completeSourcingWithDecision(item.id, decision as never, 'collect_details').ok).toBe(true);
    recordAcceptances(item.id, [att.id], 'system', 'qualified distributor record (curate v2)');
    updateItemStageStatus(item.id, 'in_progress');
    const mat = materializeDistributorRecordExtraction(item.id, workspaceId);
    expect(mat.ok).toBe(true);

    // The verified v2 payload carries the merchandising copy + provenance.
    const hydrated = findItemById(item.id)!;
    const payload = hydrated.extractionData as Record<string, any>;
    expect(payload.distributorRecordProvenance.extractionMethod).toBe('distributor_record_v2');
    expect(payload.description).toBe('Verified v2 merchandising description.');

    // Run the deterministic curation pipeline directly (legacy per-SKU path,
    // v1 config): the curator consumes verified v2 copy for keywords + the
    // reviewed description, with the source attempt provenance.
    const curationData = await curateItemWithPipeline(hydrated, wsPath, workspaceId);
    expect(curationData.curatedDescription).toBe('Verified v2 merchandising description.');
    expect(curationData.curatedDescriptionSourceAttemptIds).toEqual([att.id]);
    // Keyword synthesis tokenizes the verified description into keywords
    // (lowercased, punctuation-stripped) — description-derived terms appear.
    expect(curationData.searchKeywords).toContain('Verified');
    expect(curationData.searchKeywords).toContain('merchandising');

    // Negative (tamper): break the item-payload provenance evidence hash so
    // it no longer matches the persisted sourcing decision → the copy must
    // stay suppressed (v1 fail-closed), even though the materialization is
    // otherwise intact.
    const tamperedPayload = JSON.parse(JSON.stringify(hydrated.extractionData)) as Record<string, any>;
    tamperedPayload.distributorRecordProvenance.evidenceHash = '0'.repeat(64);
    getDb().run('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?', [
      JSON.stringify(tamperedPayload),
      item.id,
    ]);
    const tamperedItem = findItemById(item.id)!;
    const tamperedCuration = await curateItemWithPipeline(tamperedItem, wsPath, workspaceId);
    expect(tamperedCuration.curatedDescription).toBeNull();
  });

  // 17. Kill switch behavior.
  test('17. kill switch: new imports enter Discovery; pending items Continue; history preserved', async () => {
    process.env.BAYSTATE_CMS_SOURCING_ENABLED = 'false';
    // A pending sourcing item from an earlier ON phase (simulated): the
    // operator retry action (resetItemsForRetry) performs the audited
    // fallback_to_discovery; the worker never claims sourcing items while OFF.
    const { item } = makeItem('012345678903', 'Quarantine');
    const gen = startSourcingGeneration(item.id, 'automatic_policy');
    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ upc: item.upc, name: 'X' }), 'phillips');

    await settle(fixtureWorker(workspaceId, tempDir));
    // Worker did NOT claim the sourcing item while the engine is OFF.
    expect(findItemById(item.id)?.stage).toBe('sourcing');
    expect(findItemById(item.id)?.stageStatus).toBe('pending');

    const retry = resetItemsForRetry([item.id], { sourcingEngineEnabled: false });
    expect(retry.moved).toEqual([item.id]);

    const after = findItemById(item.id);
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.stage).toBe('discovery');
    // History preserved: generation + attempts remain audit-visible.
    expect(getDb().query('SELECT COUNT(*) as c FROM sourcing_generations WHERE item_id = ?').get(item.id)).toMatchObject({ c: 1 });
    expect(getCurrentGenerationAttempts(item.id).length).toBe(1);
  });

  // 18. No route/action reaches Curation; bundle_to_curation unactionable.
  test('18. bundle_to_curation is rejected by every writer; no path reaches Curation or bypasses Review', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { item } = makeItem('012345678903', 'No Curation');
    const res = completeSourcingWithDecision(
      item.id,
      { route: 'bundle_to_curation', origin: 'automatic_policy', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: new Date().toISOString() } as never,
      'find_product_page',
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('prohibited');

    // The V2 decision union has no creatable bundle variant (schema-level).
    // classification_evidence.source CHECK admits distributor_record (the
    // Amendment-A classification source) alongside the official label.
    const evidenceSql = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='classification_evidence'")
      .get() as { sql: string } | undefined;
    expect(evidenceSql).toBeDefined();
    expect(evidenceSql!.sql).toContain('distributor_record');
    expect(evidenceSql!.sql).toContain('official_product_page');
    // The onboarding_items route enum also admits both source labels.
    const itemsSql = getDb()
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='onboarding_items'")
      .get() as { sql: string } | undefined;
    expect(itemsSql).toBeDefined();
    expect(itemsSql!.sql).toContain('distributor_record');
  });
});