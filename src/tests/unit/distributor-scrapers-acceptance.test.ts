/**
 * Distributor Scrapers offline acceptance (M7, ADR 0014 Amendment B).
 *
 * Proves the full engine-to-Curation boundary for ALL FIVE html_scraper
 * providers (bradley, central_pet, orgill, pet_food_experts,
 * phillips_storefront) plus the REST flavors (phillips, bci) using ONLY
 * fixture-injected transports and a temporary in-memory/disk SQLite DB:
 *
 *   1. A workspace-scoped connection creates disabled (never enabled).
 *   2. Enabling in the test DB runs the exact registered connector/provider ID.
 *   3. A fixture `found` attempt persists the full normalized v2 evidence and
 *      the accurate evidence URL; no raw HTML/credentials persist.
 *   4. Exact-match qualification routes to `extraction/pending`, never Curation.
 *   5. Materialization writes URL-null `distributor_record_v2` merchandising
 *      depth and completes Extraction.
 *   6. Cohort freeze/classification retains distributor source/provenance and
 *      merchandising with image/price/inventory boundaries intact.
 *   7. Observe mode writes only generation/attempt rows even with v2 data.
 *   8. REST API and scraper flavors both produce attempts in one generation
 *      and retain distinct provider IDs.
 *   9. Injected wrong variant, auth failure, source error, and cross-provider
 *      identity conflict follow the existing route table.
 *
 * Offline-only: connectors are constructed with injected `fetchPage` /
 * `fetchImpl` deps that serve fixture HTML/JSON — no network, no browser, no
 * Crawlee storage. Runs under `bun test` (bun:sqlite); excluded from vitest
 * and registered in package.json `test:db`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { getCurrentGenerationAttempts } from '../../db/repositories/onboarding-evidence-repo';
import { createConnection, updateConnection } from '../../db/repositories/distributor-repo';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import { PhillipsConnector } from '../../onboarding/sourcing/connectors/phillips';
import { BCIConnector } from '../../onboarding/sourcing/connectors/bci';
import { BradleyConnector } from '../../onboarding/sourcing/connectors/bradley';
import { CentralPetConnector } from '../../onboarding/sourcing/connectors/central-pet';
import { OrgillConnector } from '../../onboarding/sourcing/connectors/orgill';
import { PetFoodExpertsConnector } from '../../onboarding/sourcing/connectors/pet-food-experts';
import { PhillipsStorefrontConnector } from '../../onboarding/sourcing/connectors/phillips-storefront';
import type { ScraperFetchPage } from '../../onboarding/sourcing/html-scraper/contracts';
import { overrideCohortCurationFlags, resetCohortCurationFlagsOverride } from '../../classification/flags';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
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
import type { ClassificationConfig } from '../../shared/schemas/classification';
import type { Workspace } from '../../shared/types';

// ─── Fixture loading ───────────────────────────────────────────────────────────

const FIXTURE_ROOT = path.join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers');

function loadProviderFixtures(provider: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = fs.readFileSync(path.join(FIXTURE_ROOT, provider, name), 'utf8');
  }
  return out;
}

const REST_FIXTURES = {
  phillips: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'phillips-page.json'), 'utf8')),
  bci: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'bci-page.json'), 'utf8')),
};

// ─── Provider parameters (mirror the connector unit fixtures) ─────────────────

interface ScraperProviderParam {
  distributorId: string;
  providerId: string;
  requiresSecret: boolean;
  fixtureDir: string;
  foundUpc: string;
  expectedName: string;
  expectedBrand: string;
  /** Prefix of the search URL built by the connector. */
  searchPrefix: string;
  /** Recognizes the found PDP URL (exact match or predicate). */
  foundPdpUrl: string;
  pdpMatches: (url: string) => boolean;
  /** Fixtures loaded for the happy path. */
  fixtureNames: string[];
}

const SCRAPER_PROVIDERS: ScraperProviderParam[] = [
  {
    distributorId: 'bradley',
    providerId: 'bradley',
    requiresSecret: false,
    fixtureDir: 'bradley',
    foundUpc: '018653299524',
    expectedName: 'E-Z HANG SCALE',
    expectedBrand: 'KERBL',
    searchPrefix: 'https://www.bradleycaldwell.com/search?term=',
    foundPdpUrl: 'https://www.bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135',
    pdpMatches: (url) => url === 'https://www.bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135',
    fixtureNames: ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html'],
  },
  {
    distributorId: 'central_pet',
    providerId: 'central_pet',
    requiresSecret: false,
    fixtureDir: 'central_pet',
    foundUpc: '035585775210',
    expectedName: 'KONG Air Dog Squeaker Tennis Ball Dog Toy',
    expectedBrand: 'KONG',
    searchPrefix: 'https://www.centralpet.com/Search?criteria=',
    foundPdpUrl: 'https://www.centralpet.com/Search?criteria=035585775210',
    pdpMatches: (url) => url.includes('option=PDCM38777521'),
    fixtureNames: ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html'],
  },
  {
    distributorId: 'orgill',
    providerId: 'orgill',
    requiresSecret: true,
    fixtureDir: 'orgill',
    foundUpc: '755625321923',
    expectedName: 'Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle',
    expectedBrand: 'LANDSCAPERS SELECT',
    searchPrefix: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=',
    foundPdpUrl: 'https://www.orgill.com/ProductDetail.aspx?itemNumber=204711',
    pdpMatches: (url) => url === 'https://www.orgill.com/ProductDetail.aspx?itemNumber=204711',
    fixtureNames: ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html', 'auth-required.html'],
  },
  {
    distributorId: 'pet_food_experts',
    providerId: 'pet_food_experts',
    requiresSecret: true,
    fixtureDir: 'pet_food_experts',
    foundUpc: '33011808',
    expectedName: 'Wellness CORE Grain Free',
    expectedBrand: 'Wellness',
    searchPrefix: 'https://orders.petfoodexperts.com/Search?query=',
    foundPdpUrl: 'https://orders.petfoodexperts.com/product/wellness-core-grain-free',
    pdpMatches: (url) => url === 'https://orders.petfoodexperts.com/product/wellness-core-grain-free',
    fixtureNames: ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html', 'auth-required.html'],
  },
  {
    distributorId: 'phillips_storefront',
    providerId: 'phillips_storefront',
    requiresSecret: true,
    fixtureDir: 'phillips_storefront',
    foundUpc: '072705115310',
    expectedName: 'Fromm Gold Large Breed Dog 30 lb',
    expectedBrand: 'FROMM FAMILY FOODS LLC',
    searchPrefix: 'https://shop.phillipspet.com/ccrz__ProductList?cartID=&operation=quickSearch&searchText=',
    foundPdpUrl: 'https://shop.phillipspet.com/ccrz__ProductDetails?sku=FROMM-GOLD-30',
    pdpMatches: (url) => url === 'https://shop.phillipspet.com/ccrz__ProductDetails?sku=FROMM-GOLD-30',
    fixtureNames: ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html', 'auth-required.html'],
  },
];

const SCRAPER_BY_ID = new Map(SCRAPER_PROVIDERS.map((p) => [p.distributorId, p]));

/** URL → fixture fetcher for a scraper provider (records every call). */
function makeScraperFetcher(
  p: ScraperProviderParam,
  opts: { mode?: 'found' | 'not-found' | 'auth-required' | 'auth-failed' | 'source-error'; fixtureReplace?: Array<[string, string]> } = {},
) {
  const FIXTURES = loadProviderFixtures(p.fixtureDir, p.fixtureNames);
  const calls: string[] = [];
  const applyReplace = (html: string): string => {
    for (const [from, to] of opts.fixtureReplace ?? []) html = html.split(from).join(to);
    return html;
  };
  const fetchPage: ScraperFetchPage = async (url, _fopts) => {
    calls.push(url);
    const mode = opts.mode ?? 'found';
    const isSearch = url.startsWith(p.searchPrefix);
    if (mode === 'auth-required' && isSearch) {
      return { ok: true, html: applyReplace(FIXTURES['auth-required.html']), finalUrl: url };
    }
    if (mode === 'auth-failed' && isSearch) {
      return { ok: false, code: 'auth_failed', message: 'login could not establish an authenticated session' };
    }
    if (mode === 'source-error' && isSearch) {
      return { ok: false, code: 'timeout', message: 'transport timed out' };
    }
    if (isSearch && url.startsWith(p.searchPrefix + '000000000000')) {
      return { ok: true, html: applyReplace(FIXTURES['not-found.html']), finalUrl: url };
    }
    // The search fixtures are static HTML that does not embed the lookup
    // identifier, so ANY other search URL (found UPC, wrong-variant UPC,
    // cross-provider rewritten UPC) serves the same found-search page — the
    // connector decides found/wrong-variant from the PDP's exact UPC.
    if (isSearch) {
      return { ok: true, html: applyReplace(FIXTURES['found-search.html']), finalUrl: url };
    }
    if (p.pdpMatches(url)) {
      return { ok: true, html: applyReplace(FIXTURES['found-pdp.html']), finalUrl: url };
    }
    return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
  };
  return { fetchPage, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

/** REST fixture transport for Phillips/BCI (token + catalog pages). */
function restFetchImpl(url: string): Promise<Response> {
  if (url.includes('/oauth/token')) {
    return Promise.resolve(jsonResponse({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 }));
  }
  if (url.includes('/me/products')) {
    return Promise.resolve(jsonResponse(REST_FIXTURES.bci));
  }
  return Promise.resolve(jsonResponse(REST_FIXTURES.phillips));
}

/** Deterministic registry: exact (connectorType, distributorId) → fixture connector. */
const fixtureRegistry: ConnectorRegistry = {
  createConnector(connectorType, distributorId, _configuration) {
    const did = String(distributorId ?? '').toLowerCase();
    if (connectorType === 'api') {
      if (did === 'bci' || did === 'ordercloud') {
        return new BCIConnector({ fetchImpl: restFetchImpl as unknown as typeof fetch });
      }
      if (did === 'phillips' || did === 'endless_aisles') {
        return new PhillipsConnector({ fetchImpl: restFetchImpl as unknown as typeof fetch });
      }
      return null;
    }
    if (connectorType === 'html_scraper') {
      const p = SCRAPER_BY_ID.get(did);
      if (!p) return null;
      const { fetchPage } = makeScraperFetcher(p);
      switch (did) {
        case 'bradley':
          return new BradleyConnector({ fetchPage });
        case 'central_pet':
          return new CentralPetConnector({ fetchPage });
        case 'orgill':
          return new OrgillConnector({ fetchPage });
        case 'pet_food_experts':
          return new PetFoodExpertsConnector({ fetchPage });
        case 'phillips_storefront':
          return new PhillipsStorefrontConnector({ fetchPage });
        default:
          return null;
      }
    }
    return null;
  },
};

function fixtureWorker(workspaceId: string, workspacePath: string, registry: ConnectorRegistry = fixtureRegistry): OnboardingWorker {
  return new OnboardingWorker(workspaceId, workspacePath, 10, 3, () => new DefaultSourcingEngine(registry));
}

/** EXACTLY ONE poll + drain (sourcing outcome is terminal after one cycle). */
async function settle(worker: OnboardingWorker): Promise<void> {
  await worker.poll();
  await worker.drain();
}

// Minimal valid legacy v1 classification config (mirrors sourcing-default-on-e2e).
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

const VALID_SECRET = JSON.stringify({ username: 'ops-user', password: 's3cret-pass' });

// ─── Suite ─────────────────────────────────────────────────────────────────────

describe('Distributor Scrapers offline acceptance (M7, Amendment B)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;
  let wsPath: string;

  beforeEach(() => {
    delete process.env.BAYSTATE_CMS_SOURCING_ENABLED;
    delete process.env.BAYSTATE_CMS_SOURCING_MODE;
    resetSourcingFlagsOverride();
    resetCohortCurationFlagsOverride();
    // P0 taxonomy freeze: this suite writes a legacy config, so the freeze is
    // explicitly lifted for the duration of the tests.
    setTaxonomyFreezeForTests(false);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapers-acceptance-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    process.env.FIXTURE_PHILLIPS_KEY = 'fixture-phillips-key';
    process.env.FIXTURE_BCI_KEY = 'fixture-bci-id:fixture-bci-secret';

    workspaceId = 'ws-scrapers';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Scrapers Workspace',
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

  function makeItem(upc: string, name: string) {
    const batch = createBatch({ workspaceId, name: `Batch ${upc}`, fileName: `${upc}.csv`, totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc, name, rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
    return { batch, item };
  }

  function enableHtmlScraperConnection(p: ScraperProviderParam): void {
    if (p.requiresSecret) {
      upsertApiKey(p.distributorId, VALID_SECRET);
    }
    const conn = createConnection({
      workspaceId,
      distributorId: p.distributorId,
      connectorType: 'html_scraper',
      secretRef: p.requiresSecret ? p.distributorId : null,
      configuration: {},
    });
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
  }

  // 1. Five html_scraper connections create DISABLED.
  test('1. all five scraper connections create disabled with empty code-owned configuration', async () => {
    for (const p of SCRAPER_PROVIDERS) {
      const conn = createConnection({
        workspaceId,
        distributorId: p.distributorId,
        connectorType: 'html_scraper',
        secretRef: p.requiresSecret ? p.distributorId : null,
        configuration: {},
      });
      const row = getDb().query('SELECT enabled, configuration_json, connector_type FROM distributor_connections WHERE id = ?').get(conn.id) as {
        enabled: number;
        configuration_json: string;
        connector_type: string;
      };
      expect(row.enabled).toBe(0);
      expect(row.connector_type).toBe('html_scraper');
      const config = JSON.parse(row.configuration_json) as Record<string, unknown>;
      // No selector/login URL/proxy/credential may be stored in configuration.
      const blob = JSON.stringify(config);
      expect(blob).not.toMatch(/selector|login|proxy|username|password|secret|href|url/i);
    }
  });

  // 2+3+5. Per-provider found chain: exact connector runs → v2 evidence with
  //        evidence URL → extraction/pending → v2 merchandising materialization.
  for (const p of SCRAPER_PROVIDERS) {
    test(`[${p.distributorId}] found chain: exact provider runs, v2 evidence persists, routes to extraction, v2 materialization completes`, async () => {
      overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
      enableHtmlScraperConnection(p);
      const { item } = makeItem(p.foundUpc, 'Test Item');

      const worker = fixtureWorker(workspaceId, tempDir);
      await settle(worker); // Sourcing leg: lookup + reconcile + route
      const routed = findItemById(item.id);
      expect(routed?.stage).toBe('extraction');
      expect(routed?.stageStatus).toBe('pending');
      expect(routed?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
      expect(routed?.sourceType).toBe('distributor_record');
      expect(routed?.sourceUrl).toBeNull();

      // Evidence attempt: exact provider ID, merchandising v2 identity, real
      // evidence URL, and NO raw HTML/credentials anywhere in the row.
      const attempts = getCurrentGenerationAttempts(item.id);
      const found = attempts.filter((a) => a.outcome === 'found' && a.providerId === p.providerId);
      expect(found.length).toBe(1);
      const attempt = found[0];
      expect(attempt.evidenceUrl).toBe(p.foundPdpUrl);
      const identity = JSON.parse(attempt.identityJson ?? '{}') as Record<string, unknown>;
      expect(identity.name).toBe(p.expectedName);
      expect(identity.brand).toBe(p.expectedBrand);
      // Merchandising-depth persisted through the shared schema.
      expect(typeof identity.description).toBe('string');
      expect(String(identity.description ?? '').length).toBeGreaterThan(0);
      expect(Array.isArray(identity.features)).toBe(true);
      const all = JSON.stringify({ identity, attempt });
      expect(all).not.toMatch(/<html|<!doctype|<!DOCTYPE|password|username/i);

      await settle(worker); // Extraction leg: materialize distributor_record_v2
      const done = findItemById(item.id);
      expect(done?.stageStatus).toBe('completed');
      const data = done?.extractionData as Record<string, unknown>;
      expect(data?.sourceType).toBe('distributor_record');
      expect(data?.sourceUrl).toBeNull();
      expect(data?.title).toBe(p.expectedName);
      expect(typeof data?.description).toBe('string');
      expect(String(data?.description ?? '').length).toBeGreaterThan(0);
      // Boundaries: price/commerce OCR stay absent; candidates carry
      // store-owner opt-in approvals (Amendment B addendum 3).
      expect(data?.price).toBeNull();
      expect(data?.primaryImage).toBeNull();
      expect(Array.isArray(data?.additionalImages)).toBe(true);
      expect((data?.additionalImages as unknown[]).length).toBe(0);
      expect(Array.isArray(data?.distributorImageCandidates)).toBe(true);
      expect(Array.isArray(data?.distributorImageApprovals)).toBe(true);
      const approvals = (data?.distributorImageApprovals ?? []) as Array<Record<string, unknown>>;
      expect(approvals.length).toBe((data?.distributorImageCandidates as unknown[]).length);
      for (const a of approvals) {
        expect(a.rightsAttested).toBe(true);
        expect(a.approvalOrigin).toBe('distributor_channel_opt_in');
      }

      const row = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').get(item.id) as Record<string, unknown>;
      expect(row.extraction_method).toBe('distributor_record_v2');
      expect(row.source_type).toBe('distributor_record');
      expect(row.source_url).toBeNull();
      expect(row.images_json).toBeNull();
      expect(String(row.evidence_hash)).toMatch(/^[0-9a-f]{64}$/);
      // No raw HTML in the durable extraction JSON.
      expect(JSON.stringify(row)).not.toMatch(/<html|<!doctype|<!DOCTYPE/i);
    });
  }

  // 6. Cohort freeze + classification retain distributor provenance and v2
  //    merchandising with image/price/inventory boundaries.
  test('6. cohort freeze/classification retain distributor source/provenance + merchandising; image/price boundaries intact', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    overrideCohortCurationFlags({ cohortCurationV2Enabled: true, cohortShadowOnly: false });
    saveClassificationConfig(wsPath, V1_CONFIG);
    syncConfigToCache(workspaceId, loadClassificationConfig(wsPath));

    const p = SCRAPER_BY_ID.get('bradley')!;
    enableHtmlScraperConnection(p);
    const { batch, item } = makeItem(p.foundUpc, 'Freeze Item');
    const worker = fixtureWorker(workspaceId, tempDir);
    await settle(worker); // sourcing → extraction/pending
    await settle(worker); // extraction → v2 materialization
    expect(findItemById(item.id)?.stageStatus).toBe('completed');

    const formed = refreshCandidateCohorts(workspaceId, batch.id);
    expect(formed.length).toBeGreaterThan(0);
    const cohort = formed[0];
    updateCohortStatus(cohort.id, 'ready');
    const [run] = claimReadyCurationCohorts(workspaceId, 10, 'worker-a', COHORT_LEASE_TTL_MS);
    expect(run).toBeDefined();
    const finalized = await freezeCohortForExecution(run, wsPath, workspaceId);
    expect(finalized.evidenceSnapshotHash).not.toBeNull();

    const snap = getCohortSnapshotByHash(workspaceId, finalized.evidenceSnapshotHash!)!;
    const frozenV3 = parseExecutionEvidenceProjection(JSON.parse(snap.payloadJson)) as any;
    // New freezes must be V3 with importedIdentity provenance (Milestone 5)
    expect(frozenV3.version).toBe(PROJECTION_VERSION_V3);
    expect(ExecutionEvidenceProjectionV3Schema.safeParse(frozenV3).success).toBe(true);
    expect(hashCanonicalJson(frozenV3)).toBe(finalized.evidenceSnapshotHash!);
    const member = frozenV3.members[0];
    expect(member.importedIdentity).toBeDefined();
    if (member.importedIdentity.provenanceHash !== null) {
      expect(member.importedIdentity.provenanceHash).toMatch(/^[a-f0-9]{64}$/);
    }
    // Lossy legacy items have null raw but version 0 with truthful hash; fresh items without spreadsheet have null version/hash which is valid fail-closed tuple
    expect([null, 0, 1].includes(member.importedIdentity.version as any)).toBe(true);
    expect(member.itemSourceType).toBe('distributor_record');
    expect(member.extractionSourceType).toBe('distributor_record');
    expect(member.extraction.title).toBe('E-Z HANG SCALE');
    // V2 merchandising survives the freeze; commerce boundaries stay intact.
    expect(member.extraction.description).not.toBeNull();
    expect(member.extraction.primaryImage).toBeNull();
    expect(Array.isArray(member.extraction.additionalImages) ? member.extraction.additionalImages.length : 0).toBe(0);
    // Price never even exists in the frozen member projection.
    expect((member.extraction as Record<string, unknown>).price).toBeUndefined();

    // Frozen classification: distributor evidence with merchandising, never
    // official, never images/price/inventory.
    const { evidenceExtractionStage } = await import('../../classification/stages/evidence-extraction');
    const result = await evidenceExtractionStage.execute(
      { sku: item.upc, onboardingItemId: item.id, evidence: [], acceptedProposals: [], allProposals: [] },
      {
        workspacePath: wsPath,
        workspaceId,
        runId: 'run-scrapers-acceptance',
        configSnapshotRef: { id: 'cfg', hash: 'h'.repeat(64), sourceCommit: null, createdAt: new Date().toISOString() },
        snapshot: undefined,
        cohortFrozenEvidence: member as never,
      } as never,
    );
    expect(result.status).toBe('succeeded');
    const evidence = (result as { status: 'succeeded'; output: { evidence: Array<Record<string, any>> } }).output.evidence;
    const distEntries = evidence.filter((e) => e.source === 'distributor_record');
    expect(distEntries.length).toBeGreaterThan(0);
    for (const entry of distEntries) {
      expect(entry.sourceUrl).toBeNull();
    }
    // V2 merchandising IS emitted as distributor classification evidence
    // (the bradley fixture carries description/case-pack/ingredients; its
    // reviewed feature list is legitimately empty, so no bullet_point).
    expect(distEntries.some((e) => e.sourceField === 'description')).toBe(true);
    expect(distEntries.some((e) => e.sourceField === 'case_pack')).toBe(true);
    expect(distEntries.some((e) => e.sourceField === 'ingredients')).toBe(true);
    // …and the boundaries hold: no official label, no price/inventory/images.
    expect(evidence.some((e) => e.source === 'official_product_page')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'price')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'primaryImage')).toBe(false);
    expect(evidence.some((e) => e.sourceField === 'search_keywords')).toBe(false);
  });

  // 7. Observe mode: only generations + attempts, even with v2 merchandising data.
  test('7. observe mode writes only generation/attempt rows with v2 data — zero decisions/transitions/extractions', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    const p = SCRAPER_BY_ID.get('bradley')!;
    enableHtmlScraperConnection(p);
    const batch = createBatch({ workspaceId, name: 'Observe Batch', fileName: 'observe.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: p.foundUpc, name: 'Observe Item', rowNumber: 1, stage: 'discovery' }], 'discovery', SOURCING_ENTRY_POLICY_VERSION);

    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBeGreaterThan(0);
    const found = attempts.find((a) => a.outcome === 'found' && a.providerId === 'bradley');
    expect(found).toBeDefined();
    const identity = JSON.parse(found!.identityJson ?? '{}') as Record<string, unknown>;
    expect(identity.description).toBeTruthy(); // v2 merchandising observable in shadow mode

    const after = findItemById(item.id);
    // Observe mode itself performs zero transitions — the item then flows
    // through discovery, which deterministically parks it as needs-review
    // (no brand hint → no mapped domain → no candidates) instead of failing
    // offline like the old Serper-key path did.
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.errorMessage ?? '').toContain('No matching product pages found');
    expect(after?.sourcingDecision).toBeNull();
    const acceptanceRows = getDb().query('SELECT COUNT(*) AS c FROM onboarding_item_evidence_acceptances WHERE item_id = ?').get(item.id) as { c: number };
    expect(acceptanceRows.c).toBe(0);
    const conflictRows = getDb().query('SELECT COUNT(*) AS c FROM onboarding_evidence_conflicts WHERE item_id = ?').get(item.id) as { c: number };
    expect(conflictRows.c).toBe(0);
    const extractionRows = getDb().query('SELECT COUNT(*) AS c FROM onboarding_extractions WHERE item_id = ?').get(item.id) as { c: number };
    expect(extractionRows.c).toBe(0);
    const generationRows = getDb().query('SELECT COUNT(*) AS c FROM sourcing_generations WHERE item_id = ?').get(item.id) as { c: number };
    expect(generationRows.c).toBe(1);
  });

  // 8. REST API and scraper flavors coexist in one generation with distinct provider IDs.
  test('8. api+phillips and html_scraper+phillips_storefront both produce attempts in one generation with distinct provider IDs', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    // Phillips REST (fixture catalog UPC 012345678905) + Phillips Storefront scraper.
    const connApi = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY' });
    updateConnection(connApi.id, connApi.workspaceId, { enabled: true });
    const ps = SCRAPER_BY_ID.get('phillips_storefront')!;
    enableHtmlScraperConnection(ps);

    const { item } = makeItem(ps.foundUpc, 'Dual Flavor');
    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    const providerIds = [...new Set(attempts.map((a) => a.providerId))].sort();
    expect(providerIds).toContain('phillips');
    expect(providerIds).toContain('phillips_storefront');
    expect(providerIds.length).toBe(2);
    const storefront = attempts.find((a) => a.providerId === 'phillips_storefront');
    expect(storefront?.outcome).toBe('found');
    expect(storefront?.evidenceUrl).toBe(ps.foundPdpUrl);
  });

  test('8b. api+bci and html_scraper+bradley both produce attempts in one generation with distinct provider IDs', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const connApi = createConnection({ workspaceId, distributorId: 'bci', connectorType: 'api', secretRef: 'FIXTURE_BCI_KEY' });
    updateConnection(connApi.id, connApi.workspaceId, { enabled: true });
    const bradley = SCRAPER_BY_ID.get('bradley')!;
    enableHtmlScraperConnection(bradley);

    const { item } = makeItem(bradley.foundUpc, 'Dual Flavor BCI');
    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    const providerIds = [...new Set(attempts.map((a) => a.providerId))].sort();
    expect(providerIds).toContain('bci');
    expect(providerIds).toContain('bradley');
    expect(providerIds.length).toBe(2);
  });

  // 9. Route-table outcomes: wrong variant, auth failure, source error,
  //    and a cross-provider identity conflict.
  test('9a. wrong variant → not_stocked → fallback_to_discovery (never found by name/brand similarity)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const p = SCRAPER_BY_ID.get('bradley')!;
    // Look up a synthetic nearby UPC; the PDP carries a different exact UPC.
    const wrongUpc = '018653299520';
    const fetcher = makeScraperFetcher(p, { mode: 'found' });
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () =>
      new DefaultSourcingEngine({
        createConnector(type, id) {
          if (type === 'html_scraper' && id === 'bradley') return new BradleyConnector({ fetchPage: fetcher.fetchPage });
          return null;
        },
      }),
    );
    enableHtmlScraperConnection(p);
    const { item } = makeItem(wrongUpc, 'Wrong Variant');
    await settle(worker);

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.some((a) => a.outcome === 'not_stocked' && a.providerId === 'bradley')).toBe(true);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
  });

  test('9b. auth failure → source_error:auth_failed → degraded_fallback_to_discovery', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const p = SCRAPER_BY_ID.get('orgill')!;
    const fetcher = makeScraperFetcher(p, { mode: 'auth-failed' });
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () =>
      new DefaultSourcingEngine({
        createConnector(type, id) {
          if (type === 'html_scraper' && id === 'orgill') return new OrgillConnector({ fetchPage: fetcher.fetchPage });
          return null;
        },
      }),
    );
    enableHtmlScraperConnection(p);
    const { item } = makeItem(p.foundUpc, 'Auth Failure');
    await settle(worker);

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.some((a) => a.outcome === 'source_error' && a.errorCode === 'auth_failed')).toBe(true);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('degraded_fallback_to_discovery');
  });

  test('9c. provider transport error → source_error → degraded_fallback_to_discovery', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const p = SCRAPER_BY_ID.get('pet_food_experts')!;
    const fetcher = makeScraperFetcher(p, { mode: 'source-error' });
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () =>
      new DefaultSourcingEngine({
        createConnector(type, id) {
          if (type === 'html_scraper' && id === 'pet_food_experts') return new PetFoodExpertsConnector({ fetchPage: fetcher.fetchPage });
          return null;
        },
      }),
    );
    enableHtmlScraperConnection(p);
    const { item } = makeItem(p.foundUpc, 'Provider Error');
    await settle(worker);

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.some((a) => a.outcome === 'source_error' && a.errorCode === 'timeout')).toBe(true);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('degraded_fallback_to_discovery');
  });

  test('9d. cross-provider identity disagreement (weight/brand) auto-resolves and qualifies to extraction', async () => {
    const bradley = SCRAPER_BY_ID.get('bradley')!;
    const central = SCRAPER_BY_ID.get('central_pet')!;
    const bradleyFetcher = makeScraperFetcher(bradley, { mode: 'found' });
    // Point central_pet's found fixture at bradley's UPC to produce a cross-provider
    // lookup collision with differing brand/weight strings.
    const centralFetcher = makeScraperFetcher(central, {
      mode: 'found',
      fixtureReplace: [['035585775210', '018653299524']],
    });
    const worker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () =>
      new DefaultSourcingEngine({
        createConnector(type, id) {
          if (type === 'html_scraper' && id === 'bradley') return new BradleyConnector({ fetchPage: bradleyFetcher.fetchPage });
          if (type === 'html_scraper' && id === 'central_pet') return new CentralPetConnector({ fetchPage: centralFetcher.fetchPage });
          return null;
        },
      }),
    );
    enableHtmlScraperConnection(bradley);
    enableHtmlScraperConnection(central);
    const { item } = makeItem(bradley.foundUpc, 'Cross Conflict');
    await settle(worker);

    const attempts = getCurrentGenerationAttempts(item.id);
    const foundIds = attempts.filter((a) => a.outcome === 'found').map((a) => a.providerId).sort();
    expect(foundIds).toEqual(['bradley', 'central_pet']);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(after?.sourcingDecision?.warnings?.some((w) => w.includes('auto-resolved'))).toBe(true);
  });
});