/**
 * Sourcing V2 recovery — end-to-end acceptance suite (plan Milestone 7).
 *
 * Proves the FULL chain (import → worker claim → engine → fixture
 * connectors → reconcile → route → conflict → resolve → retry) behind the
 * flag-gated architecture. No network: connector transports are injected
 * fixture servers reading src/tests/fixtures/sourcing/*.json.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import {
  insertItems,
  findItemById,
  resetItemsForRetry,
  completeSourcingWithDecision,
  updateSourcingDecision,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  startSourcingGeneration,
  supersedeCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  getCurrentSourcingGeneration,
  listGenerationsForItem,
  insertEvidenceAttempt,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  createConnection,
  listConnectionsByWorkspace,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import {
  insertConflictWithCandidates,
  listConflictsForItem,
  resolveConflict,
} from '../../db/repositories/onboarding-conflict-repo';
import { getAcceptedAttemptIdsForItem } from '../../db/repositories/onboarding-acceptance-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import { PhillipsConnector } from '../../onboarding/sourcing/connectors/phillips';
import { BCIConnector } from '../../onboarding/sourcing/connectors/bci';
import { SourcingRouteEnum, ResolveSourcingRequestSchema } from '../../shared/schemas/onboarding';
import { evaluateItemReadiness } from '../../onboarding/curation-cohort-service';
import app from '../../server/app';
import type { Workspace } from '../../shared/types';

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
 * The worker fires item promises without awaiting them, and the SAME poll
 * legitimately continues an item that just advanced (sourcing → discovery):
 * the discovery stage claims it and runs the discovery leg. Discovery runs
 * entirely against local brand-domain indexes, so offline it completes
 * deterministically (needs_input_no_candidates / needs_input_setup) without
 * any external search key.
 * Poll + drain cycles settle every promise so the terminal state is a
 * settled discovery/completed (the in_progress window is transient).
 * (requeueStaleInProgressItems runs at worker start(), not per poll — this
 * suite never relies on it.)
 */
async function settle(worker: OnboardingWorker, cycles = 1): Promise<void> {
  // Bounded poll + drain cycles. One cycle mirrors the legacy single-pass
  // contract. A second cycle is needed only when cycle 1 ends with the item
  // queued at discovery/pending (the same-poll discovery continuation is
  // skipped by the running guard): the next claim settles it at its
  // deterministic offline outcome (needs_input_no_candidates /
  // needs_input_setup). No retry escalation is possible because offline
  // discovery never throws.
  for (let cycle = 0; cycle < cycles; cycle++) {
    await worker.poll();
    await worker.drain();
  }
}

// ─── Suite ─────────────────────────────────────────────────────────────────────

describe('Sourcing V2 recovery end-to-end acceptance (M7)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-acceptance-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    process.env.FIXTURE_PHILLIPS_KEY = 'fixture-phillips-key';
    process.env.FIXTURE_BCI_KEY = 'fixture-bci-id:fixture-bci-secret';

    workspaceId = 'ws-acceptance';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: tempDir,
      gitPath: path.join(tempDir, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeItem(upc: string, name: string, stage: 'sourcing' | 'discovery' = 'sourcing', brandHint: string | null = null) {
    const batch = createBatch({ workspaceId, name: `Batch ${upc}`, fileName: `${upc}.csv`, totalItems: 1 });
    // Post-Amendment-A (Milestone B): worker-claimable sourcing fixtures carry
    // the current entry-policy version (1). The flag-OFF sentinel below stays
    // version 0 (legacy stranded semantics).
    const [item] = insertItems(
      batch.id,
      [{ upc, name, brandHint, rowNumber: 1, stage }],
      stage,
      SOURCING_ENTRY_POLICY_VERSION,
    );
    return { batch, item };
  }

  function seedFound(itemId: string, upc: string, generationId: string, providerId: string, identity: Record<string, unknown>) {
    return insertEvidenceAttempt({
      itemId,
      providerId,
      sourcingGenerationId: generationId,
      lookupUpc: upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify(identity),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });
  }

  test('1. flag OFF: import enters Discovery and the worker performs zero sourcing claims/writes', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    const { item } = makeItem('012345678901', 'Off Item', 'discovery');
    // Stranded Sourcing sentinel: if the worker ever claimed the sourcing
    // stage while disabled, THIS item would move. It must stay untouched.
    const stranded = insertItems(
      createBatch({ workspaceId, name: 'Sentinel', fileName: 'sent.csv', totalItems: 1 }).id,
      [{ upc: '012345678903', name: 'Sentinel Stranded', rowNumber: 1, stage: 'sourcing' }],
    )[0];

    // Invocation counter: the engine factory must never be called while OFF.
    let engineCalls = 0;
    const countingWorker = new OnboardingWorker(
      workspaceId,
      tempDir,
      10,
      3,
      () => {
        engineCalls++;
        return new DefaultSourcingEngine();
      },
    );
    await settle(countingWorker);

    // Discovery completes deterministically offline: no brand domain mapped
    // or indexed → needs_input_no_candidates.
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    // The sentinel proves zero sourcing claims: still sourcing/pending.
    const sentinel = findItemById(stranded.id);
    expect(sentinel?.stage).toBe('sourcing');
    expect(sentinel?.stageStatus).toBe('pending');
    expect(sentinel?.sourcingDecision).toBeNull();
    // Zero engine invocations and zero sourcing artifacts.
    expect(engineCalls).toBe(0);
    const db = getDb();
    const generations = db.query('SELECT COUNT(*) as c FROM sourcing_generations').get() as { c: number };
    const attempts = db.query('SELECT COUNT(*) as c FROM onboarding_evidence_attempts').get() as { c: number };
    expect(generations.c).toBe(0);
    expect(attempts.c).toBe(0);
  });

  test('2. flag ON: new import enters Sourcing; zero enabled connections passes to Discovery with an audited decision', async () => {
    const { item } = makeItem('012345678902', 'Zero Conn');

    await settle(new OnboardingWorker(workspaceId, tempDir), 2);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('automatic_policy');
    expect(after?.sourcingDecision?.warnings).toContain('No enabled distributor connections');
  });

  test('3. fixture lookup persists a current-generation attempt; coherent exact product yields evidence_to_discovery + relational acceptance', async () => {
    const { item } = makeItem('012345678905', 'Fixture Found');
    const conn = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });

    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('found');
    expect(attempts[0].providerId).toBe('phillips');

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(getAcceptedAttemptIdsForItem(item.id)).toContain(attempts[0].id);
  });

  test('4. exact UPC with a variant disagreement auto-resolves and routes without blocking', async () => {
    const { item } = makeItem('012345678903', 'Variant Disagreement');
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedFound(item.id, item.upc, gen.id, 'phillips', { upc: item.upc, attributes: { size: '10 lb' } });
    seedFound(item.id, item.upc, gen.id, 'bci', { upc: item.upc, attributes: { size: '20 lb' } });

    await settle(new OnboardingWorker(workspaceId, tempDir), 2);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(after?.sourcingDecision?.warnings?.some((w) => w.includes('auto-resolved'))).toBe(true);
  });

  test('5. two hard conflicts: first resolution stays needs_input; last resolution atomically completes to discovery/pending', async () => {
    const { item } = makeItem('012345678904', 'Two Conflicts');
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');
    const gen = startSourcingGeneration(item.id, 'automatic');
    const a1 = seedFound(item.id, item.upc, gen.id, 'phillips', { weight: '10 lbs' });
    const a2 = seedFound(item.id, item.upc, gen.id, 'bci', { weight: '20 lbs' });
    const a3 = seedFound(item.id, item.upc, gen.id, 'phillips', { size: 'small' });
    const a4 = seedFound(item.id, item.upc, gen.id, 'bci', { size: 'large' });
    const weightConflict = insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: a1.id, valueJson: '"10 lbs"' },
      { evidenceAttemptId: a2.id, valueJson: '"20 lbs"' },
    ], gen.id);
    const sizeConflict = insertConflictWithCandidates(item.id, 'size', 'hard', [
      { evidenceAttemptId: a3.id, valueJson: '"small"' },
      { evidenceAttemptId: a4.id, valueJson: '"large"' },
    ], gen.id);

    resolveConflict(weightConflict.id, { action: 'dismiss' });
    const afterFirst = findItemById(item.id);
    expect(afterFirst?.stage).toBe('sourcing');
    expect(afterFirst?.stageStatus).toBe('needs_input');

    resolveConflict(sizeConflict.id, { action: 'dismiss' });
    const afterLast = findItemById(item.id);
    expect(afterLast?.stage).toBe('discovery');
    expect(afterLast?.stageStatus).toBe('pending');
    expect(afterLast?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(afterLast?.sourcingDecision?.origin).toBe('operator_override');
  });

  test('6. retry supersedes the generation; stale attempts/conflicts stay visible but never affect the new decision', async () => {
    overrideSourcingFlags({ mode: 'manual' });
    const { item } = makeItem('012345678905', 'Retry Supersede');
    const g1 = startSourcingGeneration(item.id, 'manual');
    seedFound(item.id, item.upc, g1.id, 'phillips', { upc: item.upc, attributes: { size: '10 lb' } });

    // First run in manual mode → needs_input.
    await settle(new OnboardingWorker(workspaceId, tempDir));
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');

    // Engine-ON retry supersedes the generation and resets in place.
    const reset = resetItemsForRetry([item.id], { sourcingEngineEnabled: true });
    expect(reset.reset).toContain(item.id);
    const generations = listGenerationsForItem(item.id);
    expect(generations.length).toBe(2);
    expect(generations[0].status).toBe('superseded');
    expect(findItemById(item.id)?.stageStatus).toBe('pending');

    // New current generation with COHERENT evidence → completes to Discovery
    overrideSourcingFlags({ mode: 'automatic' });
    const current = listGenerationsForItem(item.id)[1];
    seedFound(item.id, item.upc, current.id, 'phillips', { upc: item.upc, attributes: { size: '10 lb' } });
    seedFound(item.id, item.upc, current.id, 'bci', { upc: item.upc, attributes: { size: '10 lb' } });

    await settle(new OnboardingWorker(workspaceId, tempDir), 2);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
  });

  test('7. no-brand and unknown-brand scenarios query ALL enabled providers (issue #150)', async () => {
    const { item } = makeItem('012345678905', 'All Providers');
    const conn2 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn2.id, conn2.workspaceId, { enabled: true });
    const conn3 = createConnection({ workspaceId, distributorId: 'bci', connectorType: 'api', secretRef: 'FIXTURE_BCI_KEY'});
    updateConnection(conn3.id, conn3.workspaceId, { enabled: true });

    await settle(fixtureWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(2);
    expect(new Set(attempts.map((a) => a.providerId))).toEqual(new Set(['phillips', 'bci']));

    // An unrelated/unknown brand hint cannot suppress or reorder the query
    // set: both providers are still invoked (query-all). Brand hints remain
    // non-authoritative identity evidence, never distributor stock filters.
    const { item: item2 } = makeItem('012345678999', 'Fall Open', 'sourcing', 'UnrelatedBrand');
    await settle(fixtureWorker(workspaceId, tempDir));
    const attempts2 = getCurrentGenerationAttempts(item2.id);
    expect(attempts2.length).toBe(2);
    expect(new Set(attempts2.map((a) => a.providerId))).toEqual(new Set(['phillips', 'bci']));
  });

  test('8. missing/redacted credentials and connector failures produce bounded durable errors with NO secret leakage', async () => {
    // (a) Masked secret → durable secret_missing attempt, item still completes.
    process.env.BAD_MASKED_KEY = '•'.repeat(8) + 'abcd';
    const { item } = makeItem('012345678906', 'Masked Secret');
    const conn4 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'BAD_MASKED_KEY'});
    updateConnection(conn4.id, conn4.workspaceId, { enabled: true });

    await settle(new OnboardingWorker(workspaceId, tempDir));

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('source_error');
    expect(attempts[0].errorCode).toBe('secret_missing');
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    const serialized = JSON.stringify({ item: after, attempts });
    expect(serialized).not.toContain('••••');
    expect(serialized).not.toContain('abcd');

    // (b) Unregistered connector type → durable connector_not_registered,
    // item completes to Discovery, never stranded.
    const { item: item2 } = makeItem('012345678907', 'Unknown Connector');
    const conn5 = createConnection({ workspaceId, distributorId: 'orgill', connectorType: 'ftp_catalog', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn5.id, conn5.workspaceId, { enabled: true });

    await settle(new OnboardingWorker(workspaceId, tempDir));

    const attempts2 = getCurrentGenerationAttempts(item2.id);
    // BOTH enabled workspace connections are queried: the masked phillips
    // connection (secret_missing) and the unregistered ftp_catalog type
    // (connector_not_registered) — two durable bounded errors, no stranding.
    expect(attempts2.length).toBe(2);
    expect(attempts2.map((a) => a.errorCode)).toEqual(
      expect.arrayContaining(['secret_missing', 'connector_not_registered']),
    );
    const after2 = findItemById(item2.id);
    expect(after2?.stage).toBe('discovery');

    // (c) Provider TIMEOUT end-to-end: a fixture connector that never
    // resolves (deadline aborts it) → durable timeout attempt, item completes
    // via degraded fallback, never stranded.
    const { item: item3 } = makeItem('012345678908', 'Timeout Provider');
    const conn6 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn6.id, conn6.workspaceId, { enabled: true });
    const timeoutRegistry: ConnectorRegistry = {
      createConnector(_type, distributorId) {
        const did = String(distributorId ?? '');
        if (did !== 'phillips') return null;
        return new PhillipsConnector({
          timeoutMs: 20,
          fetchImpl: (async (_url: string, init: RequestInit) => {
            await new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
            return new Response('{}');
          }) as unknown as typeof fetch,
        });
      },
    };
    await settle(new OnboardingWorker(workspaceId, tempDir, 10, 3, () => new DefaultSourcingEngine(timeoutRegistry)));

    const attempts3 = getCurrentGenerationAttempts(item3.id);
    // Earlier parts' connections stay enabled in the shared suite DB, so the
    // run also records their durable outcomes; the NEW connection's outcome
    // must be exactly one bounded 'timeout'.
    expect(attempts3.filter((a) => a.errorCode === 'timeout').length).toBe(1);
    expect(attempts3.filter((a) => a.errorCode === 'timeout')[0]?.outcome).toBe('source_error');
    const after3 = findItemById(item3.id);
    expect(after3?.stage).toBe('discovery');
    expect(after3?.sourcingDecision?.route).toBe('degraded_fallback_to_discovery');

    // (d) MALFORMED response end-to-end → durable bad_json attempt, item
    // completes via degraded fallback.
    const { item: item4 } = makeItem('012345678909', 'Malformed Provider');
    const newConn = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(newConn.id, newConn.workspaceId, { enabled: true });
    // Disable every earlier phillips connection so part (d) exercises ONLY
    // its own connection (the malformed-response registry would otherwise
    // also serve them).
    for (const conn of listConnectionsByWorkspace(workspaceId, true)) {
      if (conn.distributorId === 'phillips' && conn.id !== newConn.id) {
        updateConnection(conn.id, workspaceId, { enabled: false });
      }
    }
    const malformedRegistry: ConnectorRegistry = {
      createConnector(_type, distributorId) {
        const did = String(distributorId ?? '');
        if (did !== 'phillips') return null;
        return new PhillipsConnector({
          fetchImpl: (async () =>
            new Response('{not valid json', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
        });
      },
    };
    await settle(new OnboardingWorker(workspaceId, tempDir, 10, 3, () => new DefaultSourcingEngine(malformedRegistry)));

    const attempts4 = getCurrentGenerationAttempts(item4.id);
    expect(attempts4.filter((a) => a.errorCode === 'bad_json').length).toBe(1);
    const after4 = findItemById(item4.id);
    expect(after4?.stage).toBe('discovery');
    expect(after4?.sourcingDecision?.route).toBe('degraded_fallback_to_discovery');
    // (Cancellation is exercised at the transport layer by
    // sourcing-bounded-fetch.test.ts — the worker has no cancel path.)
  });

  test('9. migration safety holds: fresh install, idempotent rerun, catalog_version column present', () => {
    closeDb();
    const dbPath2 = path.join(tempDir, 'migration.db');
    initDb(dbPath2);
    runMigrations();
    runMigrations(); // idempotent second run must not throw
    const db = getDb();
    const marker = db.query("SELECT value FROM app_meta WHERE key = 'distributor_v2_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
    const cols = (db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('catalog_version');
    expect(cols).toContain('sourcing_generation_id');
  });

  test('10. legacy bundle_to_curation is audit-readable but unactionable everywhere', async () => {
    // Readable as a persisted audit value…
    expect(SourcingRouteEnum.safeParse('bundle_to_curation').success).toBe(true);
    // …but not expressible through any request/transition surface.
    expect(ResolveSourcingRequestSchema.safeParse({ action: 'use_selected_bundle' }).success).toBe(false);

    const { item } = makeItem('012345678908', 'Bundled');
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');
    const gen = startSourcingGeneration(item.id, 'automatic');
    const a1 = seedFound(item.id, item.upc, gen.id, 'phillips', { weight: '1 lb' });
    const a2 = seedFound(item.id, item.upc, gen.id, 'bci', { weight: '2 lb' });
    insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: a1.id, valueJson: '"1 lb"' },
      { evidenceAttemptId: a2.id, valueJson: '"2 lb"' },
    ], gen.id);

    // The guarded transition helper rejects the legacy route outright.
    expect(
      completeSourcingWithDecision(
        item.id,
        { route: 'bundle_to_curation', origin: 'operator_override', acceptedEvidenceAttemptIds: [], providerIds: [], conflicts: [], warnings: [], decidedAt: new Date().toISOString() },
        'find_product_page',
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('prohibited') });

    // The generic decision writer refuses the legacy route too.
    expect(
      updateSourcingDecision(item.id, {
        route: 'bundle_to_curation',
        origin: 'operator_override',
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      }),
    ).toBe(false);
    expect(findItemById(item.id)?.sourcingDecision?.route).not.toBe('bundle_to_curation');

    // A direct operator fallback against an open hard conflict is refused (400).
    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fallback_to_discovery' }),
    });
    expect(res.status).toBe(400);
    expect(findItemById(item.id)?.stage).toBe('sourcing');
  });

  test('11. distributor images never enter extraction/classification/draft payloads', async () => {
    const { item } = makeItem('012345678905', 'Images Stay Out');
    const conn8 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn8.id, conn8.workspaceId, { enabled: true });

    await settle(fixtureWorker(workspaceId, tempDir));

    // Evidence carries the image URL (display-only contract)…
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts[0].identityJson).toContain('cdn.example.com/ph/012345678905-front.jpg');
    // …but no item payload (extraction/classification/draft) carries it.
    const after = findItemById(item.id);
    expect(after?.extractionData).toBeNull();
    expect(after?.curationData).toBeNull();
    const row = getDb()
      .query('SELECT extraction_data_json, curation_data_json FROM onboarding_items WHERE id = ?')
      .get(item.id) as { extraction_data_json: string | null; curation_data_json: string | null };
    expect(row.extraction_data_json).toBeNull();
    expect(row.curation_data_json).toBeNull();
  });

  test('12. Discovery receives identity evidence WITHOUT a fake URL; source_url stays null until discovery', async () => {
    const { item } = makeItem('012345678905', 'No Fake URL');
    const conn9 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn9.id, conn9.workspaceId, { enabled: true });

    await settle(fixtureWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.sourceUrl).toBeNull();
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts[0].evidenceUrl).toBeNull();
    // Official-site discovery is still required before extraction.
    expect(getDb().query('SELECT COUNT(*) as c FROM onboarding_sources WHERE item_id = ?').get(item.id)).toMatchObject({ c: 0 });
  });

  test('13. cohort readiness recognizes the sourcing decision (source-finalized) without regression', () => {
    const item = {
      id: 'item-readiness',
      batchId: 'batch-1',
      upc: '012345678905',
      name: 'Readiness',
      price: null,
      quantity: null,
      brandHint: null,
      departmentHint: null,
      sourceUrl: null,
      sourceType: 'official_page' as const,
      acceptedEvidenceAttemptIds: ['att-1'],
      acceptedEvidenceAttemptId: null,
      sourcingDecision: {
        route: 'evidence_to_discovery',
        origin: 'automatic_policy' as const,
        acceptedEvidenceAttemptIds: ['att-1'],
        providerIds: ['phillips'],
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      },
      stage: 'discovery',
      stageStatus: 'completed',
      status: 'imported' as const,
      errorMessage: null,
      retryCount: 0,
      isDuplicate: false,
      existingSku: null,
      extractionData: null,
      curationData: null,
      rowNumber: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Parameters<typeof evaluateItemReadiness>[0];

    const readiness = evaluateItemReadiness(item);
    // Amendment A: an arbitrary non-null sourcing decision alone does NOT
    // finalize source — official source finalization requires the Discovery
    // URL; distributor source requires a valid distributor extraction binding.
    expect(readiness.sourceFinalized).toBe(false);
    expect(readiness.ready).toBe(false);

    // With the Discovery URL completed, the same decision-bearing item IS
    // finalized (official path).
    const withUrl = { ...item, sourceUrl: 'https://brand.example.com/products/012345678905' };
    expect(evaluateItemReadiness(withUrl).sourceFinalized).toBe(true);
  });

  test('14. a retry that supersedes the generation mid-run never lets the stale worker route the item', async () => {
    const { item } = makeItem('012345678905', 'Stale Worker Race');
    const conn10 = createConnection({ workspaceId, distributorId: 'phillips', connectorType: 'api', secretRef: 'FIXTURE_PHILLIPS_KEY'});
    updateConnection(conn10.id, conn10.workspaceId, { enabled: true });

    // The engine BLOCKS until we supersede the generation, then returns a
    // coherent found result — simulating a delayed old worker.
    let releaseEngine: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseEngine = resolve; });
    let engineRunStarted = false;
    const gatedRegistry: ConnectorRegistry = {
      createConnector() {
        return new PhillipsConnector({
          fetchImpl: (async () => {
            engineRunStarted = true;
            await gate;
            return JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'fixtures', 'sourcing', 'phillips-page.json'), 'utf8'));
          }) as unknown as typeof fetch,
        });
      },
    };

    const staleWorker = new OnboardingWorker(
      workspaceId,
      tempDir,
      10,
      3,
      () => new DefaultSourcingEngine(gatedRegistry),
    );
    const pollPromise = staleWorker.poll().then(() => staleWorker.drain());

    // Wait for the engine to be mid-flight, then supersede the generation
    // (an operator retry), then release the engine.
    const start = Date.now();
    while (!engineRunStarted && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(engineRunStarted).toBe(true);
    const staleGeneration = getCurrentSourcingGeneration(item.id);
    expect(staleGeneration).not.toBeNull();
    supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    releaseEngine();
    await pollPromise;

    // The stale worker must NOT have routed the item: it stays
    // sourcing/pending for the NEW generation's worker.
    const afterStale = findItemById(item.id);
    expect(afterStale?.stage).toBe('sourcing');
    expect(afterStale?.stageStatus).toBe('pending');
    expect(afterStale?.sourcingDecision).toBeNull();

    // A fresh worker run over the new generation completes the item normally.
    const freshWorker = new OnboardingWorker(workspaceId, tempDir, 10, 3, () => new DefaultSourcingEngine(fixtureRegistry));
    await settle(freshWorker);
    const afterFresh = findItemById(item.id);
    expect(afterFresh?.stage).toBe('extraction');
    expect(afterFresh?.stageStatus).toBe('pending');
    expect(afterFresh?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
  });

  test('15. malformed serialized sourcing decision → extraction/failed with a stable code and zero partial materialization', async () => {
    // Route a valid V2 distributor decision to Extraction first, then corrupt
    // the serialized decision authority directly (Milestone D round-8: the
    // row mapper must hydrate malformed JSON as null, the materializer must
    // fail closed with `malformed_decision`, and the worker must NOT strand
    // the claimed item at extraction/in_progress).
    const { item } = makeItem('012345678915', 'Malformed Decision');
    const gen = startSourcingGeneration(item.id, 'automatic');
    const routed = completeSourcingWithDecision(
      item.id,
      {
        schemaVersion: 2,
        route: 'distributor_record_to_extraction',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: ['a1'],
        providerIds: ['phillips'],
        sourcingGenerationId: gen.id,
        evidenceHash: 'a'.repeat(64),
        sourceType: 'distributor_record',
        target: 'extraction',
        conflicts: [],
        warnings: [],
        decidedAt: new Date().toISOString(),
      } as const,
      'collect_details',
    );
    expect(routed.ok).toBe(true);
    expect(findItemById(item.id)?.stage).toBe('extraction');
    expect(findItemById(item.id)?.sourceType).toBe('distributor_record');

    getDb()
      .query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?')
      .run('{not-valid-json', item.id);

    await settle(new OnboardingWorker(workspaceId, tempDir));

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('failed');
    expect(after?.errorMessage).toBe('distributor_materialization:malformed_decision');
    // Zero partial materialization: no extraction row, no item payload write.
    const rows = getDb()
      .query('SELECT COUNT(*) AS c FROM onboarding_extractions WHERE item_id = ?')
      .get(item.id) as { c: number };
    expect(rows.c).toBe(0);
    expect(after?.extractionData).toBeNull();
  });
});
