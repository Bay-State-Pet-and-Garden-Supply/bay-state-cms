/**
 * Ticket #125 — server-owned collection projection + activation seams.
 *
 * DB-backed (file DB + migrations; bun:sqlite convention). Covers:
 * - buildCollectionByItem through the pure gate: distributor-only ready,
 *   mixed partial with exact copy, unapproved awaiting, marker-v0
 *   compatibility, retired/corrupt pins, query-all stability, pin-wins.
 * - getStageReadItems wires collectionByItem (schema-valid, bounded
 *   statements, no writes during reads).
 * - assign-brand generation guards: in_progress 409, epoch-mismatch 409,
 *   bulk skippedBrandConflicts reporting.
 * - Worker activation blockers: brand-mismatch parks, zero-identifier
 *   approved items park inside the boundary, terminal generations never
 *   replay.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb, isDbInitialized } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { startSourcingGeneration, getCurrentGenerationAttempts } from '../../db/repositories/onboarding-evidence-repo';
import { getApprovedBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { getStrategyCollectionResult } from '../../db/repositories/strategy-collection-result-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { captureGenerationStrategyBinding } from '../../db/repositories/brand-strategy-generation-repo';
import { deriveCollectionForItems } from '../../onboarding/onboarding-collection-read';
import { getStageReadItems, getStageReadCounts, buildCollectionByItem, parseStageReadQueryParams } from '../../onboarding/onboarding-stage-read';
import { getStageReadStatementCount } from '../../db/repositories/onboarding-stage-read-repo';
import { StageReadItemsResponseSchema } from '../../shared/schemas/onboarding-stage-read';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const WS = 'ws-collection-read';

// File DB path owned by the first suite's beforeAll. Bun runs
// describe-level afterAll (closeDb + rm) before later describes, so the
// follow-up suites below re-open + re-migrate the same file first.
let followupDbPath = '';

function ensureFollowupDb(): void {
  if (isDbInitialized()) return;
  if (!followupDbPath || !fs.existsSync(path.dirname(followupDbPath))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-read-followup-test-'));
    followupDbPath = path.join(dir, 'test.db');
  }
  initDb(followupDbPath);
  runMigrations();
}

function currentRevision(brand: string): number {
  try {
    const row = getDb().query('SELECT revision FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?').get(
      WS, brand.toLowerCase().trim(),
    ) as { revision: number } | undefined;
    return row?.revision ?? 0;
  } catch {
    return 0;
  }
}

function approvePhillipsBci(brand = 'Acana') {
  return saveBrandStrategy(WS, {
    brand,
    sources: [
      { kind: 'distributor_record', distributorId: 'phillips' },
      { kind: 'distributor_record', distributorId: 'bci' },
    ],
    expectedRevision: currentRevision(brand),
  });
}

function makeItem(batchId: string, overrides: { upc?: string; brandHint?: string | null; stageStatus?: string } = {}) {
  const [item] = insertItems(
    batchId,
    [{ upc: overrides.upc ?? '012345678905', name: 'Acana Food', brandHint: overrides.brandHint ?? 'Acana', rowNumber: 1, stage: 'route_sources' as never }],
    'route_sources',
    1,
  );
  if (overrides.stageStatus) updateItemStageStatus(item.id, overrides.stageStatus as never);
  return item;
}

describe('stage-one collection read', () => {
  let tempDir: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-read-test-'));
    followupDbPath = path.join(tempDir, 'test.db');
    initDb(followupDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: WS, name: 'Collection WS', workspacePath: '/tmp/coll-ws', gitPath: '/tmp/coll-ws/.git',
      createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: 'baseline-sha',
    });
    process.env.TEST_COLL_SECRET = 'test-secret';
    for (const dist of ['phillips', 'bci']) {
      try { createDistributor({ id: dist, name: dist }); } catch { /* exists */ }
      const conn = createConnection({ workspaceId: WS, distributorId: dist, connectorType: 'api', configuration: {} });
      updateConnection(conn.id, WS, { enabled: true, secretRef: 'TEST_COLL_SECRET' });
    }
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetActiveWorkerForTest();
  });

  it('approved distributor-only strategy reads Ready with available sources', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b1', fileName: 'b1.csv', totalItems: 1 });
    const item = makeItem(batch.id);
    approvePhillipsBci();
    const { projectedById } = loadProjected(batch.id);
    const out = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    const view = out[item.id];
    expect(view.path).toBe('approved_strategy');
    expect(view.readiness).toBe('ready');
    expect(view.label).toBe('Ready · 2 sources available');
    expect(view.canCollect).toBe(true);
    expect(view.explanation).toMatch(/does not guarantee a match/);
    expect(view.strategyLabel).toBe('phillips + bci');
    expect(view.effectiveRevision).toBe(1);
  });

  it('unhealthy official + two healthy distributors is partial with the website setup issue', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b2', fileName: 'b2.csv', totalItems: 1 });
    const item = makeItem(batch.id, { brandHint: 'Fromm' });
    saveBrandStrategy(WS, {
      brand: 'Fromm',
      sources: [
        { kind: 'official_page', domain: 'frommfamily.com' },
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: 0,
    });
    const { projectedById } = loadProjected(batch.id);
    const out = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    const view = out[item.id];
    expect(view.path).toBe('approved_strategy');
    expect(view.readiness).toBe('ready_partial');
    expect(view.label).toBe('Ready — partial · 2 sources available; website needs setup');
    expect(view.canCollect).toBe(true);
    expect(view.sourceAvailability.find((s) => s.kind === 'official_page')?.usable).toBe(false);
  });

  it('unapproved brands await approval — never readiness success', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b3', fileName: 'b3.csv', totalItems: 1 });
    const item = makeItem(batch.id, { brandHint: 'Unknown Brand XYZ' });
    const { projectedById } = loadProjected(batch.id);
    const out = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    const view = out[item.id];
    expect(view.path).toBe('compatibility');
    expect(view.readiness).toBe('awaiting_approval');
    expect(view.label).toBe('Awaiting approval');
    expect(view.canCollect).toBe(false);
    expect(view.explanation).toBeNull();
  });

  it('protected marker-v0 rows get compatibility, never approved readiness', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b4', fileName: 'b4.csv', totalItems: 1 });
    const [legacy] = insertItems(
      batch.id,
      [{ upc: '012345678906', name: 'Legacy', brandHint: 'Acana', rowNumber: 1, stage: 'route_sources' as never }],
      'route_sources',
      0,
    );
    approvePhillipsBci();
    const { projectedById } = loadProjected(batch.id);
    const out = buildCollectionByItem([findItemById(legacy.id)!], projectedById, WS);
    expect(out[legacy.id].path).toBe('compatibility');
    expect(out[legacy.id].canCollect).toBe(false);
  });

  it('retired and corrupt pins fail closed with explicit retry', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b5', fileName: 'b5.csv', totalItems: 1 });
    const item = makeItem(batch.id);
    approvePhillipsBci();
    const gen = startSourcingGeneration(item.id);
    captureGenerationStrategyBinding({ workspaceId: WS, itemId: item.id, generationId: gen.id });
    // Retire the pin in place (v1 legacy_advisory history).
    getDb().query(`UPDATE sourcing_generation_strategy_snapshots SET mode = 'legacy_advisory', binding_version = 'strategy-binding-v1' WHERE sourcing_generation_id = ?`).run(gen.id);
    const { projectedById } = loadProjected(batch.id);
    const retired = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    expect(retired[item.id].path).toBe('blocked');
    expect(retired[item.id].requires).toBe('explicit_retry');
    // Corrupt version fails closed the same way.
    getDb().query(`UPDATE sourcing_generation_strategy_snapshots SET mode = 'approved', binding_version = 'nope-v9' WHERE sourcing_generation_id = ?`).run(gen.id);
    const corrupt = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    expect(corrupt[item.id].path).toBe('blocked');
  });

  it('query-all pins stay query-all after a later approval; pins win over live approval', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b6', fileName: 'b6.csv', totalItems: 1 });
    const item = makeItem(batch.id, { brandHint: 'QuillBrand' });
    const gen = startSourcingGeneration(item.id);
    captureGenerationStrategyBinding({ workspaceId: WS, itemId: item.id, generationId: gen.id });
    const first = saveBrandStrategy(WS, {
      brand: 'QuillBrand',
      sources: [
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: currentRevision('QuillBrand'),
    });
    expect(first.revision).toBeGreaterThanOrEqual(1);
    const { projectedById } = loadProjected(batch.id);
    const out = buildCollectionByItem([findItemById(item.id)!], projectedById, WS);
    // Fresh generation with no approval at capture time bound query-all.
    expect(out[item.id].path).toBe('compatibility');
    expect(out[item.id].requires).toBe('pinned_resume');
  });

  it('stage-read items carry schema-valid collection decisions within budget and write nothing', () => {
    const batch = createBatch({ workspaceId: WS, name: 'b7', fileName: 'b7.csv', totalItems: 2 });
    const a = makeItem(batch.id, { upc: '012345678907', brandHint: 'Acana' });
    makeItem(batch.id, { upc: '012345678908', brandHint: 'Unknown Brand XYZ' });
    approvePhillipsBci();
    const countsBefore = countKeyTables();
    const page = getStageReadItems(batch.id, { stage: 'route_sources' }, 50, { workspaceId: WS, batchId: batch.id });
    expect(() => StageReadItemsResponseSchema.parse(page)).not.toThrow();
    expect(Object.keys(page.collectionByItem ?? {}).sort()).toEqual(
      page.items.map((i) => i.itemId).sort(),
    );
    expect(page.collectionByItem?.[a.id].label).toBe('Ready · 2 sources available');
    expect(getStageReadStatementCount()).toBeLessThanOrEqual(24);
    expect(countKeyTables()).toEqual(countsBefore);
  });

  it('server collection filters read the same facts as the table sidecar (F1)', () => {
    // Three rows, three dispositions: ready (approved 2-distributor),
    // setup_attention (approved but nothing usable), awaiting_approval.
    const batch = createBatch({ workspaceId: WS, name: 'b11', fileName: 'b11.csv', totalItems: 3 });
    const ready = makeItem(batch.id, { upc: '012345678913', brandHint: 'FiltReady' });
    const setup = makeItem(batch.id, { upc: '012345678914', brandHint: 'FiltSetup' });
    const awaiting = makeItem(batch.id, { upc: '012345678915', brandHint: 'FiltNobody' });
    // Registered distributor with no connection: approval accepts the id,
    // but the source is never usable (connection not enabled).
    try { createDistributor({ id: 'ghost', name: 'ghost' }); } catch { /* exists */ }
    saveBrandStrategy(WS, {
      brand: 'FiltReady',
      sources: [
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: currentRevision('FiltReady'),
    });
    saveBrandStrategy(WS, {
      brand: 'FiltSetup',
      sources: [{ kind: 'distributor_record', distributorId: 'ghost' }],
      expectedRevision: currentRevision('FiltSetup'),
    });
    const scope = { workspaceId: WS, batchId: batch.id };
    // Items endpoint: readiness filter narrows to the ready row, and the
    // sidecar covers exactly the matched rows (same map the matcher read).
    const readyPage = getStageReadItems(batch.id, { stage: 'route_sources', collectionReadiness: 'ready' }, 50, scope);
    expect(readyPage.items.map((i) => i.itemId)).toEqual([ready.id]);
    expect(Object.keys(readyPage.collectionByItem ?? {}).sort()).toEqual([ready.id]);
    expect(readyPage.collectionByItem?.[ready.id].label).toBe('Ready · 2 sources available');
    // Path filter: both approved-boundary rows (ready + setup_attention).
    const approvedPage = getStageReadItems(batch.id, { stage: 'route_sources', collectionPath: 'approved_strategy' }, 50, scope);
    expect(approvedPage.items.map((i) => i.itemId).sort()).toEqual([ready.id, setup.id].sort());
    expect(approvedPage.collectionByItem?.[setup.id].readiness).toBe('setup_attention');
    // Non-route rows never match a present collection filter (fail closed).
    const awaitingPage = getStageReadItems(batch.id, { collectionReadiness: 'awaiting_approval' }, 50, scope);
    expect(awaitingPage.items.map((i) => i.itemId)).toEqual([awaiting.id]);
    // Counts endpoint: the same server facts drive matchingTotal.
    const all = getStageReadCounts(batch.id, { stage: 'route_sources' }, scope);
    expect(all.matchingTotal).toBe(3);
    const readyCounts = getStageReadCounts(batch.id, { stage: 'route_sources', collectionReadiness: 'ready' }, scope);
    expect(readyCounts.matchingTotal).toBe(1);
    const setupCounts = getStageReadCounts(
      batch.id,
      { stage: 'route_sources', collectionReadiness: 'setup_attention' },
      scope,
    );
    expect(setupCounts.matchingTotal).toBe(1);
    const compatCounts = getStageReadCounts(batch.id, { stage: 'route_sources', collectionPath: 'compatibility' }, scope);
    expect(compatCounts.matchingTotal).toBe(1);
  });

  it('collection query params parse strictly; unknown readiness values are 400-shaped (F1)', () => {
    const ok = parseStageReadQueryParams({
      stage: ['route_sources'],
      collectionReadiness: ['ready'],
      collectionPath: ['approved_strategy'],
    });
    expect(ok.filters.collectionReadiness).toBe('ready');
    expect(ok.filters.collectionPath).toBe('approved_strategy');
    expect(() => parseStageReadQueryParams({ collectionReadiness: ['eventually'] })).toThrow(/Invalid collectionReadiness/);
    expect(() => parseStageReadQueryParams({ collectionPath: ['sometimes'] })).toThrow(/Invalid collectionPath/);
    expect(() => parseStageReadQueryParams({ collectionReadiness: ['ready', 'ready'] })).toThrow(/at most once/);
  });

  it('assign-brand rejects worker-held items and stale epochs with 409', async () => {
    const batch = createBatch({ workspaceId: WS, name: 'b8', fileName: 'b8.csv', totalItems: 2 });
    const held = makeItem(batch.id, { upc: '012345678909', stageStatus: 'in_progress' });
    const free = makeItem(batch.id, { upc: '012345678910', stageStatus: 'pending' });
    const heldRes = await app.request(`/api/onboarding/items/${held.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Acana' }),
    });
    expect(heldRes.status).toBe(409);
    expect(((await heldRes.json()) as { code: string }).code).toBe('brand_assignment_conflict');
    // Epoch mismatch on a free item is also 409 (never retargets).
    const staleRes = await app.request(`/api/onboarding/items/${free.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Fromm', expectedBrandHint: 'Some Other Brand' }),
    });
    expect(staleRes.status).toBe(409);
    // Matching epoch succeeds.
    const okRes = await app.request(`/api/onboarding/items/${free.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Fromm', expectedBrandHint: 'Acana' }),
    });
    expect(okRes.status).toBe(200);
    // Bulk path reports worker-held rows instead of silently skipping.
    const bulkRes = await app.request(`/api/onboarding/batches/${batch.id}/assign-brand-group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [held.id, free.id], brand: 'Acana' }),
    });
    expect(bulkRes.status).toBe(200);
    const bulkBody = (await bulkRes.json()) as { skippedBrandConflicts: Array<{ itemId: string }> };
    expect(bulkBody.skippedBrandConflicts.map((s) => s.itemId)).toEqual([held.id]);
    expect(findItemById(free.id)?.brandHint).toBe('Acana');
    expect(findItemById(held.id)?.brandHint).toBe('Acana');
  });

  it('assign/change never approves, moves, or rewrites a strategy; the read follows the new brand (F4)', async () => {
    // Route-level assign runs under the singleton workspace (findWorkspace
    // LIMIT 1): like the b8 409 test, this lives in the primary suite
    // while WS is the only workspace, with file-unique brands.
    saveBrandStrategy(WS, {
      brand: 'ReassignBrand',
      sources: [
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: currentRevision('ReassignBrand'),
    });
    const before = getApprovedBrandStrategy(WS, 'ReassignBrand');
    expect(before?.revision).toBe(1);
    const batch = createBatch({ workspaceId: WS, name: 'b12', fileName: 'b12.csv', totalItems: 1 });
    const item = makeItem(batch.id, { upc: '012345678937', brandHint: 'ReassignBrand' });
    const scope = { workspaceId: WS, batchId: batch.id };
    const first = getStageReadItems(batch.id, { stage: 'route_sources' }, 50, scope).collectionByItem?.[item.id];
    expect(first?.readiness).toBe('ready');
    // Reassign the item to a brand with no approval.
    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'OtherBrand', expectedBrandHint: 'ReassignBrand' }),
    });
    expect(res.status).toBe(200);
    // Neither brand's strategy moved: no silent approval of OtherBrand,
    // no rewrite of ReassignBrand (revision + sources byte-identical).
    const after = getApprovedBrandStrategy(WS, 'ReassignBrand');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.sources).toEqual(before?.sources);
    expect(getApprovedBrandStrategy(WS, 'OtherBrand')).toBeNull();
    // The read follows the item's new brand: awaiting approval, never
    // the old brand's Ready.
    const reread = getStageReadItems(batch.id, { stage: 'route_sources' }, 50, scope).collectionByItem?.[item.id];
    expect(reread?.readiness).toBe('awaiting_approval');
    expect(reread?.canCollect).toBe(false);
  });

  it('worker parks brand-mismatched pins instead of executing another brand boundary', async () => {
    const batch = createBatch({ workspaceId: WS, name: 'b9', fileName: 'b9.csv', totalItems: 1 });
    const item = makeItem(batch.id, { upc: '012345678911', brandHint: 'Acana' });
    approvePhillipsBci();
    const gen = startSourcingGeneration(item.id);
    captureGenerationStrategyBinding({ workspaceId: WS, itemId: item.id, generationId: gen.id });
    // Reassign after capture: the old pin stays history, never executes.
    getDb().query(`UPDATE onboarding_items SET brand_hint = 'Fromm', stage_status = 'pending' WHERE id = ?`).run(item.id);
    const { OnboardingWorker } = await import('../../onboarding/job-queue');
    const worker = new (OnboardingWorker as unknown as new (workspaceId: string, workspacePath: string) => {
      processSourcing: (item: unknown) => Promise<void>;
    })(WS, '/tmp/coll-ws');
    await (worker as unknown as { processSourcing: (item: unknown) => Promise<void> }).processSourcing(findItemById(item.id));
    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('needs_input');
    expect(['sourcing', 'route_sources']).toContain(after?.stage);
  });

  it('zero-identifier approved items park inside the boundary; terminal generations never replay', async () => {
    const batch = createBatch({ workspaceId: WS, name: 'b10', fileName: 'b10.csv', totalItems: 2 });
    approvePhillipsBci();
    const noId = makeItem(batch.id, { upc: 'not-a-gtin!!', brandHint: 'Acana' });
    const { OnboardingWorker } = await import('../../onboarding/job-queue');
    const worker = new (OnboardingWorker as unknown as new (workspaceId: string, workspacePath: string) => {
      processSourcing: (item: unknown) => Promise<void>;
    })(WS, '/tmp/coll-ws');
    const api = worker as unknown as { processSourcing: (item: unknown) => Promise<void> };
    await api.processSourcing(findItemById(noId.id));
    const parked = findItemById(noId.id);
    // Parked inside the approved boundary — never fallback_to_discovery.
    expect(parked?.stageStatus).toBe('needs_input');
    expect(['sourcing', 'route_sources']).toContain(parked?.stage);
    // Terminal generation: no replay, no new attempts.
    const done = makeItem(batch.id, { upc: '012345678912', brandHint: 'Acana' });
    const gen = startSourcingGeneration(done.id);
    getDb().query(`UPDATE sourcing_generations SET status = 'completed' WHERE id = ?`).run(gen.id);
    const attemptsBefore = (
      getDb().query('SELECT COUNT(*) AS n FROM onboarding_evidence_attempts WHERE item_id = ?').get(done.id) as { n: number }
    ).n;
    await api.processSourcing(findItemById(done.id));
    const attemptsAfter = (
      getDb().query('SELECT COUNT(*) AS n FROM onboarding_evidence_attempts WHERE item_id = ?').get(done.id) as { n: number }
    ).n;
    expect(attemptsAfter).toBe(attemptsBefore);
  });
});

// ─── Ticket #125 follow-up tests (F2/F4/F5/F7/F9): isolated workspace ────
// These tests use their own workspace id (never the shared WS) so brand
// approvals, connections, and batches cannot interfere with the b1–b11
// sequence above (F12 hygiene).

const WS2 = 'ws-coll-read-f2';

class FoundConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  lookups = 0;
  constructor(readonly distributorId: string) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    return {
      outcome: 'found',
      record: {
        matchedIdentifier: request.upc,
        distributorUpc: request.upc,
        gtin: request.upc,
        distributorSku: `SKU_${this.distributorId}`,
        name: 'F2 Mixed Dog Food',
        description: 'F2 distributor description',
        brand: 'F2Mixed',
        manufacturerPartNumber: null,
        weight: null,
        features: [],
        category: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        attributes: {},
        imageUrls: [],
        sourceUrl: null,
        catalogVersion: null,
        observedAt: new Date().toISOString(),
        expiresAt: null,
      },
      matchedFields: ['upc'],
      warnings: [],
    };
  }
}

class StaticRegistry implements ConnectorRegistry {
  private connectors = new Map<string, DistributorConnector>();
  register(distributorId: string, connector: DistributorConnector) {
    this.connectors.set(distributorId, connector);
  }
  createConnector(_type: string, distributorId: string): DistributorConnector | null {
    return this.connectors.get(distributorId) ?? null;
  }
}

function ensureWs2(): void {
  ensureFollowupDb();
  const now = new Date().toISOString();
  try {
    insertWorkspace({
      id: WS2, name: 'Coll F2', workspacePath: '/tmp/coll-ws-f2', gitPath: '/tmp/coll-ws-f2/.git',
      createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: 'baseline-sha',
    });
  } catch {
    // exists
  }
  for (const dist of ['phillips', 'bci']) {
    try { createDistributor({ id: dist, name: dist }); } catch { /* exists */ }
    const existing = getDb().query(
      'SELECT id FROM distributor_connections WHERE workspace_id = ? AND distributor_id = ?',
    ).get(WS2, dist) as { id: string } | undefined;
    if (!existing) {
      const conn = createConnection({ workspaceId: WS2, distributorId: dist, connectorType: 'api', configuration: {} });
      updateConnection(conn.id, WS2, { enabled: true, secretRef: 'TEST_COLL_SECRET' });
    }
  }
}

function ws2Revision(brand: string): number {
  try {
    const row = getDb().query(
      'SELECT revision FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
    ).get(WS2, brand.toLowerCase().trim()) as { revision: number } | undefined;
    return row?.revision ?? 0;
  } catch {
    return 0;
  }
}

type SourcingWorkerCtor = new (
  workspaceId: string,
  workspacePath: string,
  maxConcurrency: number,
  maxExtractionConcurrency: number,
  engineFactory: () => unknown,
) => { processSourcing: (item: unknown) => Promise<void> };

describe('stage-one activation follow-ups (isolated workspace)', () => {
  beforeAll(() => {
    ensureFollowupDb();
  });

  it('gate-to-worker: unhealthy official + usable distributors proceed through the #125 path (F2)', async () => {
    ensureWs2();
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    try {
      upsertBrandSite('F2Mixed', 'f2mixed.example.com');
      saveBrandStrategy(WS2, {
        brand: 'F2Mixed',
        sources: [
          { kind: 'official_page', domain: 'f2mixed.example.com' },
          { kind: 'distributor_record', distributorId: 'phillips' },
          { kind: 'distributor_record', distributorId: 'bci' },
        ],
        expectedRevision: ws2Revision('F2Mixed'),
      });
      const batch = createBatch({ workspaceId: WS2, name: 'f2', fileName: 'f2.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: '012345678920', name: 'F2 Food', brandHint: 'F2Mixed', rowNumber: 1, stage: 'route_sources' as never }],
        'route_sources',
        1,
      );
      // The #125 activation decision agrees first: partial with the
      // website setup issue, collection allowed on usable distributors.
      const projected = getStageReadItems(batch.id, { stage: 'route_sources' }, 50, { workspaceId: WS2, batchId: batch.id });
      const view = projected.collectionByItem?.[item.id];
      expect(view?.readiness).toBe('ready_partial');
      expect(view?.canCollect).toBe(true);
      expect(view?.sourceAvailability.find((s) => s.kind === 'official_page')?.usable).toBe(false);
      // No extractor profile for the domain: the official leg is
      // unhealthy. The injected engine proves zero network on that leg
      // while the distributor legs run for real (in-memory fakes).
      const guard = { discoverCalls: 0, extractCalls: 0 };
      const registry = new StaticRegistry();
      registry.register('phillips', new FoundConnector('phillips'));
      registry.register('bci', new FoundConnector('bci'));
      const { OnboardingWorker } = await import('../../onboarding/job-queue');
      const worker = new (OnboardingWorker as unknown as SourcingWorkerCtor)(
        WS2, '/tmp/coll-ws-f2', 3, 3, () => new DefaultSourcingEngine(registry, 3, {
        findProfile: (() => null) as never,
        isProfileHealthy: (() => false) as never,
        discover: (async () => {
          guard.discoverCalls += 1;
          return { candidates: [], consolidatedName: null };
        }) as never,
        verify: (async () => []) as never,
        extract: (async () => {
          guard.extractCalls += 1;
          throw new Error('must not extract without a profile');
        }) as never,
      }));
      await (worker as unknown as { processSourcing: (item: unknown) => Promise<void> }).processSourcing(findItemById(item.id));
      expect(guard.discoverCalls).toBe(0);
      expect(guard.extractCalls).toBe(0);
      const attempts = getCurrentGenerationAttempts(item.id);
      const distributorAttempts = attempts.filter((a) => a.outcome === 'found');
      expect(distributorAttempts.length).toBeGreaterThanOrEqual(1);
      const official = attempts.find((a) => (a.providerId ?? '').startsWith('official_page:'));
      // Attempt-level terminal outcome is the typed source_error (with a
      // bounded code, never a raw message); the envelope contribution
      // reads unavailable with the same typed reason.
      expect(official?.outcome).toBe('source_error');
      expect(typeof official?.errorCode === 'string' && (official?.errorCode?.length ?? 0) > 0).toBe(true);
      // Typed terminal official outcome persisted in the envelope, and
      // the item continued toward preparation inside the boundary.
      const generation = getDb().query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1').get(item.id) as { id: string };
      const result = getStrategyCollectionResult(generation.id);
      const contribution = result.envelope.contributions.find((c) => c.kind === 'official_page');
      expect(contribution?.outcome).toBe('unavailable');
      expect(typeof contribution?.reasonCode === 'string' && contribution.reasonCode.length > 0).toBe(true);
      const after = findItemById(item.id);
      expect((after?.sourcingDecision as { route?: string } | null)?.route).toBe('completed_strategy_collection');
      // Sourcing completed inside the boundary and the item continued
      // toward preparation (the worker chains extraction inline, so the
      // recorded stage may already be extraction — never a fallback).
      expect(['collect_details', 'extraction']).toContain(after?.stage);
    } finally {
      resetSourcingFlagsOverride();
    }
  });
});

// ─── Ticket #125 follow-ups II (F4/F5/F6/F7/F9): isolated workspace ───
// Same isolation rule as above: WS3 only, never the shared WS.

// ─── helpers ────────────────────────────────────────────────────────────────

function loadProjected(batchId: string) {
  const page = getStageReadItems(batchId, { stage: 'route_sources' }, 50, { workspaceId: WS, batchId });
  const projectedById = new Map(page.items.map((state) => [state.itemId, { state, canonicalStage: 'route_sources' as const }]));
  return { projectedById };
}

function countKeyTables(): Record<string, number> {
  const tables = [
    'onboarding_items',
    'sourcing_generations',
    'onboarding_evidence_attempts',
    'sourcing_generation_strategy_snapshots',
    'brand_sourcing_strategies',
    'onboarding_evidence_conflicts',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      out[t] = (getDb().query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    } catch {
      out[t] = -1;
    }
  }
  return out;
}

// Referenced for tree-shaking honesty: the pure multi-item derivation.
void deriveCollectionForItems;

// ─── Ticket #125 follow-ups II (F4/F5/F6/F7/F9): isolated workspace ───
// Same isolation rule as the F2 block above: WS3 only, never the shared WS
// (F12 hygiene).

const WS3 = 'ws-coll-read-followups';

class NamedConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  constructor(readonly distributorId: string, private readonly name: string, private readonly weight: string | null = null) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    return {
      outcome: 'found',
      record: {
        matchedIdentifier: request.upc,
        distributorUpc: request.upc,
        gtin: request.upc,
        distributorSku: `SKU_${this.distributorId}`,
        name: this.name,
        description: `${this.name} description`,
        brand: 'WS3Brand',
        manufacturerPartNumber: null,
        weight: this.weight,
        features: [],
        category: null,
        dimensions: null,
        casePack: null,
        unitOfMeasure: null,
        ingredients: null,
        attributes: {},
        imageUrls: [],
        sourceUrl: null,
        catalogVersion: null,
        observedAt: new Date().toISOString(),
        expiresAt: null,
      },
      matchedFields: ['upc'],
      warnings: [],
    };
  }
}

function ensureWs3(): void {
  ensureFollowupDb();
  const now = new Date().toISOString();
  try {
    insertWorkspace({
      id: WS3, name: 'Coll F3', workspacePath: '/tmp/coll-ws-f3', gitPath: '/tmp/coll-ws-f3/.git',
      createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: 'baseline-sha',
    });
  } catch {
    // exists
  }
  for (const dist of ['phillips', 'bci']) {
    try { createDistributor({ id: dist, name: dist }); } catch { /* exists */ }
    const existing = getDb().query(
      'SELECT id FROM distributor_connections WHERE workspace_id = ? AND distributor_id = ?',
    ).get(WS3, dist) as { id: string } | undefined;
    if (!existing) {
      const conn = createConnection({ workspaceId: WS3, distributorId: dist, connectorType: 'api', configuration: {} });
      updateConnection(conn.id, WS3, { enabled: true, secretRef: 'TEST_COLL_SECRET' });
    }
  }
}

function ws3Revision(brand: string): number {
  try {
    const row = getDb().query(
      'SELECT revision FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
    ).get(WS3, brand.toLowerCase().trim()) as { revision: number } | undefined;
    return row?.revision ?? 0;
  } catch {
    return 0;
  }
}

function ws3ConnectionId(distributorId: string): string {
  const row = getDb().query(
    'SELECT id FROM distributor_connections WHERE workspace_id = ? AND distributor_id = ?',
  ).get(WS3, distributorId) as { id: string } | undefined;
  if (!row) throw new Error(`missing WS3 connection for ${distributorId}`);
  return row.id;
}

function ws3Item(batchId: string, brandHint: string, upc: string) {
  const [item] = insertItems(
    batchId,
    [{ upc, name: `${brandHint} Food`, brandHint, rowNumber: 1, stage: 'route_sources' as never }],
    'route_sources',
    1,
  );
  return item;
}

function ws3Read(batchId: string) {
  return getStageReadItems(batchId, { stage: 'route_sources' }, 50, { workspaceId: WS3, batchId });
}

describe('stage-one activation follow-ups II (isolated workspace)', () => {
  beforeAll(() => {
    ensureFollowupDb();
  });

  it('connection repair flips setup_attention to ready with zero new collection work (F5)', () => {
    ensureWs3();
    saveBrandStrategy(WS3, {
      brand: 'RepairBrand',
      sources: [{ kind: 'distributor_record', distributorId: 'bci' }],
      expectedRevision: ws3Revision('RepairBrand'),
    });
    const batch = createBatch({ workspaceId: WS3, name: 'f5', fileName: 'f5.csv', totalItems: 1 });
    const item = ws3Item(batch.id, 'RepairBrand', '012345678932');
    // Break the only leg: the row needs operator setup, not collection.
    updateConnection(ws3ConnectionId('bci'), WS3, { enabled: false });
    const broken = ws3Read(batch.id).collectionByItem?.[item.id];
    expect(broken?.readiness).toBe('setup_attention');
    expect(broken?.canCollect).toBe(false);
    startSourcingGeneration(item.id);
    const countsBefore = {
      generations: (getDb().query('SELECT COUNT(*) AS n FROM sourcing_generations WHERE item_id = ?').get(item.id) as { n: number }).n,
      attempts: (getDb().query('SELECT COUNT(*) AS n FROM onboarding_evidence_attempts WHERE item_id = ?').get(item.id) as { n: number }).n,
    };
    // Repair: enabling the connection flips readiness without recollecting
    // history, auto-applying a proposal, or touching the approval.
    updateConnection(ws3ConnectionId('bci'), WS3, { enabled: true });
    const fixed = ws3Read(batch.id).collectionByItem?.[item.id];
    expect(fixed?.readiness).toBe('ready');
    expect(fixed?.canCollect).toBe(true);
    expect(fixed?.label).toBe('Ready · 1 source available');
    const countsAfter = {
      generations: (getDb().query('SELECT COUNT(*) AS n FROM sourcing_generations WHERE item_id = ?').get(item.id) as { n: number }).n,
      attempts: (getDb().query('SELECT COUNT(*) AS n FROM onboarding_evidence_attempts WHERE item_id = ?').get(item.id) as { n: number }).n,
    };
    expect(countsAfter).toEqual(countsBefore);
    expect(getApprovedBrandStrategy(WS3, 'RepairBrand')?.revision).toBe(1);
  });

  it('single approved distributor reads Ready with singular copy (F7)', () => {
    ensureWs3();
    saveBrandStrategy(WS3, {
      brand: 'SoloBrand',
      sources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
      expectedRevision: ws3Revision('SoloBrand'),
    });
    const batch = createBatch({ workspaceId: WS3, name: 'f7a', fileName: 'f7a.csv', totalItems: 1 });
    const item = ws3Item(batch.id, 'SoloBrand', '012345678933');
    const view = ws3Read(batch.id).collectionByItem?.[item.id];
    expect(view?.path).toBe('approved_strategy');
    expect(view?.readiness).toBe('ready');
    expect(view?.label).toBe('Ready · 1 source available');
    expect(view?.canCollect).toBe(true);
  });

  it('kill switch blocks approved work: unavailable, never ready (F6/F7)', () => {
    ensureWs3();
    saveBrandStrategy(WS3, {
      brand: 'KillBrand',
      sources: [
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: ws3Revision('KillBrand'),
    });
    const batch = createBatch({ workspaceId: WS3, name: 'f7b', fileName: 'f7b.csv', totalItems: 1 });
    const item = ws3Item(batch.id, 'KillBrand', '012345678934');
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    try {
      const view = ws3Read(batch.id).collectionByItem?.[item.id];
      expect(view?.readiness).toBe('unavailable');
      expect(view?.canCollect).toBe(false);
      expect(view?.label).not.toMatch(/^Ready/);
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('capability matrix through the read: observe unavailable, manual ready-but-not-now (F9)', () => {
    ensureWs3();
    saveBrandStrategy(WS3, {
      brand: 'MatrixBrand',
      sources: [
        { kind: 'distributor_record', distributorId: 'phillips' },
        { kind: 'distributor_record', distributorId: 'bci' },
      ],
      expectedRevision: ws3Revision('MatrixBrand'),
    });
    const batch = createBatch({ workspaceId: WS3, name: 'f9m', fileName: 'f9m.csv', totalItems: 1 });
    const item = ws3Item(batch.id, 'MatrixBrand', '012345678935');
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    try {
      const observed = ws3Read(batch.id).collectionByItem?.[item.id];
      expect(observed?.readiness).toBe('unavailable');
      expect(observed?.canCollect).toBe(false);
    } finally {
      resetSourcingFlagsOverride();
    }
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    try {
      const manual = ws3Read(batch.id).collectionByItem?.[item.id];
      expect(manual?.readiness).toBe('ready');
      expect(manual?.canCollect).toBe(true);
      expect(manual?.canExecuteNow).toBe(false);
      expect(manual?.reasons.join(' ')).toMatch(/Manual mode/);
    } finally {
      resetSourcingFlagsOverride();
    }
    // Unreleased batches never schedule: unknown, never Ready.
    getDb().query('UPDATE onboarding_items SET is_held = 1 WHERE id = ?').run(item.id);
    const held = ws3Read(batch.id).collectionByItem?.[item.id];
    expect(held?.readiness).toBe('unknown');
    expect(held?.canCollect).toBe(false);
    getDb().query('UPDATE onboarding_items SET is_held = 0 WHERE id = ?').run(item.id);
  });

  it('identity conflict holds inside the activation path: no blending, no fallback (F9)', async () => {
    ensureWs3();
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    try {
      // Official + distributor weight disagreement is identity-critical
      // (same-kind distributor differences auto-resolve by consensus, so
      // the conflict leg must span authorities — see the #123 tracer).
      upsertBrandSite('ConflictBrand', 'conflict.example.com');
      saveBrandStrategy(WS3, {
        brand: 'ConflictBrand',
        sources: [
          { kind: 'official_page', domain: 'conflict.example.com' },
          { kind: 'distributor_record', distributorId: 'phillips' },
          { kind: 'distributor_record', distributorId: 'bci' },
        ],
        expectedRevision: ws3Revision('ConflictBrand'),
      });
      const batch = createBatch({ workspaceId: WS3, name: 'f9c', fileName: 'f9c.csv', totalItems: 1 });
      const item = ws3Item(batch.id, 'ConflictBrand', '012345678936');
      // The gate agrees first: collection can run inside the boundary.
      const pre = ws3Read(batch.id).collectionByItem?.[item.id];
      expect(pre?.readiness).toBe('ready_partial');
      expect(pre?.canCollect).toBe(true);
      // Official says 10lb, distributors say 25lb: the worker must park
      // visibly (needs_input_conflict) instead of blending or falling
      // back outside the approved boundary.
      const registry = new StaticRegistry();
      registry.register('phillips', new NamedConnector('phillips', 'ConflictBrand Food', '25lb'));
      registry.register('bci', new NamedConnector('bci', 'ConflictBrand Food', '25lb'));
      const { OnboardingWorker } = await import('../../onboarding/job-queue');
      const worker = new (OnboardingWorker as unknown as SourcingWorkerCtor)(
        WS3, '/tmp/coll-ws-f3', 3, 3, () => new DefaultSourcingEngine(registry, 3, {
        findProfile: (() => ({ id: 'prof-conflict', domain: 'conflict.example.com' })) as never,
        isProfileHealthy: (() => true) as never,
        discover: (async () => ({
          candidates: [{ url: 'https://conflict.example.com/p/1', title: 'ConflictBrand Food', snippet: null, domain: 'conflict.example.com', confidence: 0.95 }],
          consolidatedName: null,
        })) as never,
        verify: (async (candidates: Array<{ url: string }>) => candidates.map((c) => ({
          candidate: c,
          verificationScore: 100,
          signals: {},
          proofClass: 'gtin',
          hasStrongProof: true,
          extractedGtins: ['012345678936'],
          decisionReason: 'verified',
        }))) as never,
        extract: (async () => ({
          ok: true,
          data: { title: 'ConflictBrand Food', description: 'Official description', brand: 'ConflictBrand', weight: '10lb' },
          warnings: [],
          fieldProvenance: {},
        })) as never,
      }));
      await (worker as unknown as { processSourcing: (item: unknown) => Promise<void> }).processSourcing(findItemById(item.id));
      const after = findItemById(item.id);
      expect((after?.sourcingDecision as { route?: string } | null)?.route).toBe('needs_input_conflict');
      expect(after?.stageStatus).toBe('needs_input');
      expect(['sourcing', 'route_sources']).toContain(after?.stage);
    } finally {
      resetSourcingFlagsOverride();
    }
  });
});
