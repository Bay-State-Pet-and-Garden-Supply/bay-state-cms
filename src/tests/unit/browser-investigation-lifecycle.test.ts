// T1 (#225) + #235 production hardening — lifecycle over SQLite + routes.
//
// Bun suite (bun:sqlite via the repository layer; run under `bun test` via
// test:db, excluded from Vitest per the dual-runner gate). Proves the
// workspace-scoped persistence contract end to end plus the #235 production
// provider gate: omitting `provider` runs the real harness (fails closed
// without isolation), `fake`/unknown ids are rejected with `invalid_input`,
// and the legacy `scenario` knob is ignored. The deterministic fake survives
// only as explicit service-level injection in the replay test below.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getJson,
  initInvestigationDb,
  postJson,
  teardownInvestigationDb,
  waitForInvestigationRecord,
  waitForInvestigationTerminal,
} from './helpers/browser-investigation-route-suite';
import {
  findActiveInvestigation,
  findInvestigationById,
  insertInvestigation,
} from '../../db/repositories/browser-investigation-repo';
import { createSqliteInvestigationStore } from '../../onboarding/browser-investigation/store';
import { fakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import { getDomainDiagnosticsResponse } from '../../onboarding/domain-diagnostics-service';
import {
  getInvestigationProviderCallCount,
  getInvestigationProvider,
  registerInvestigationProvider,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import { acceptCompletion,
  getInvestigation,
  requestInvestigation,
} from '../../onboarding/browser-investigation/service';
import { createInvestigationWorker } from '../../onboarding/browser-investigation/worker';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';
const WS_MAIN = 'ws-binv-lifecycle-main';
const WS_FOREIGN = 'ws-binv-lifecycle-foreign';

let tempDir: string;

describe('browser investigation lifecycle over SQLite (T1)', () => {
  beforeAll(() => {
    tempDir = initInvestigationDb('binv-lifecycle-test-', [
      { id: WS_MAIN, name: 'Investigation Lifecycle Workspace' },
      { id: WS_FOREIGN, name: 'Foreign Workspace' },
    ]);
  });

  function ensureFakeForDirectService(): void {
    try {
      getInvestigationProvider('fake');
    } catch {
      registerInvestigationProvider(fakeInvestigationProvider);
    }
    fakeInvestigationProvider.setScenario('valid');
  }

  afterAll(() => {
    fakeInvestigationProvider.setScenario('valid');
    teardownInvestigationDb(tempDir);
  });

  beforeEach(() => {
    fakeInvestigationProvider.setScenario('valid');
    resetInvestigationProviderCalls();
  });

  it('omitting provider runs the real harness with the full envelope (#235)', async () => {
    const domain = `investigate-${Date.now()}.example.com`;
    const { status, json } = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(status).toBe(201);
    // #243 async launch: the operator gets the queued row immediately.
    expect(json.investigation.status).toBe('queued');
    const id = json.investigation.id as string;
    const terminal = await waitForInvestigationTerminal(domain, id);
    expect(terminal.status).toBe('failed');
    expect(terminal.failureCode).toBe('isolation_unavailable');
    const inv = await waitForInvestigationRecord(domain, id);
    expect(inv.workspaceId).toBe(WS_MAIN);
    expect(inv.domain).toBe(domain);
    expect(inv.mode).toBe('domain_onboarding');
    // No isolation in test env: the real harness fails closed — never fabricates.
    expect(inv.provider).toBe('local_browser_harness');
    expect(inv.status).toBe('failed');
    expect(inv.failureCode).toBe('isolation_unavailable');
    expect(inv.runId).toBeTruthy();
    expect(inv.inputHash).toBeTruthy();
    expect(inv.inputSnapshot.sampleUrls).toEqual([`https://${domain}/products/alpha`]);
    expect(inv.budget.maxPages).toBe(5);
    // Read-back is workspace-scoped and intact.
    const reread = findInvestigationById(WS_MAIN, inv.id);
    expect(reread?.id).toBe(inv.id);
    expect(reread?.provider).toBe('local_browser_harness');
  });

  it('drift-repair route persists mode drift_repair', async () => {
    const domain = `drift-${Date.now()}.example.com`;
    const { status, json } = await postJson(`/api/domains/${domain}/investigations/drift-repair`, {
      sampleUrls: [`https://${domain}/products/beta`],
      knownContext: { failureCodes: ['extraction_failed'] },
    });
    expect(status).toBe(201);
    expect(json.investigation.mode).toBe('drift_repair');
    expect(json.investigation.provider).toBe('local_browser_harness');
    // #243 async launch: queued immediately, terminal off the request path.
    expect(json.investigation.status).toBe('queued');
    const terminal = await waitForInvestigationTerminal(domain, json.investigation.id as string);
    expect(terminal.status).toBe('failed');
    expect(terminal.failureCode).toBe('isolation_unavailable');
  });

  it('diagnostics reads make zero provider calls; only an explicit launch dispatches (negative invariant)', async () => {
    resetInvestigationProviderCalls();
    // Read-only diagnostics aggregation must never touch the provider seam.
    getDomainDiagnosticsResponse(new Date());
    expect(getInvestigationProviderCallCount()).toBe(0);
    const domain = `regression-${Date.now()}.example.com`;
    const launched = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(launched.status).toBe(201);
    expect(launched.json.investigation.provider).toBe('local_browser_harness');
    // #243 async launch: queued immediately; the background worker dispatches once.
    expect(launched.json.investigation.status).toBe('queued');
    await waitForInvestigationTerminal(domain, launched.json.investigation.id as string);
    // Exactly one provider dispatch per explicit investigation run.
    expect(getInvestigationProviderCallCount()).toBe(1);
  });

  it('second active investigation for the same domain conflicts (409)', async () => {
    const domain = `conflict-${Date.now()}.example.com`;
    const first = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(first.status).toBe(201);
    expect(first.json.investigation.status).toBe('queued');
    const second = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(second.status).toBe(409);
    expect(String(second.json.error)).toMatch(/conflict_active_investigation/);
    // Cleanup: cancel the queued row so later tests stay isolated.
    const store = createSqliteInvestigationStore();
    const active = findActiveInvestigation(WS_MAIN, domain);
    expect(active).not.toBeNull();
    const cancel = await postJson(`/api/domains/${domain}/investigations/${first.json.investigation.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    void store;
  });

  it('concurrent launches for the same domain keep exactly one active investigation (#243)', async () => {
    const domain = `concurrent-${Date.now()}.example.com`;
    const body = {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    };
    const [first, second] = await Promise.all([
      postJson(`/api/domains/${domain}/investigations`, body),
      postJson(`/api/domains/${domain}/investigations`, body),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    const loser = first.status === 409 ? first : second;
    expect(winner.json.investigation.status).toBe('queued');
    expect(String(loser.json.error)).toMatch(/conflict_active_investigation/);
    const cancel = await postJson(`/api/domains/${domain}/investigations/${winner.json.investigation.id}/cancel`, {});
    expect(cancel.status).toBe(200);
  });

  it('foreign-workspace reads are rejected without leaking state', async () => {
    const domain = `foreign-${Date.now()}.example.com`;
    const created = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
    });
    expect(created.status).toBe(201);
    const id = created.json.investigation.id as string;
    // #243 settle the async run before later tests: the launch above
    // dispatches off the request path, so await its terminal state instead
    // of leaving it in flight.
    await waitForInvestigationTerminal(domain, id);
    // Same row under a foreign workspace id is invisible at the repo seam.
    expect(findInvestigationById(WS_FOREIGN, id)).toBeNull();
    // Service seam rejects with workspace_mismatch.
    const store = createSqliteInvestigationStore();
    expect(() => getInvestigation(store, WS_FOREIGN, id)).toThrowError(/workspace_mismatch/);
  });

  it('status, cancel, and discard routes enforce lifecycle transitions', async () => {
    const domain = `transitions-${Date.now()}.example.com`;
    const queued = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      queueOnly: true,
    });
    expect(queued.status).toBe(201);
    const id = queued.json.investigation.id as string;
    const status = await getJson(`/api/domains/${domain}/investigations/${id}/status`);
    expect(status.status).toBe(200);
    expect(status.json.status.status).toBe('queued');
    // Active investigations cannot be discarded.
    const badDiscard = await postJson(`/api/domains/${domain}/investigations/${id}/discard`, { actor: 'op' });
    expect(badDiscard.status).toBe(400);
    const cancel = await postJson(`/api/domains/${domain}/investigations/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.json.investigation.status).toBe('cancelled');
    const discard = await postJson(`/api/domains/${domain}/investigations/${id}/discard`, { actor: 'op' });
    expect(discard.status).toBe(200);
    expect(discard.json.investigation.status).toBe('discarded');
  });

  it('requesting the fake provider is rejected with a stable code (#235)', async () => {
    const domain = `fake-rejected-${Date.now()}.example.com`;
    const res = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'fake',
    });
    expect(res.status).toBe(400);
    expect(String(res.json.code ?? res.json.error)).toMatch(/invalid_input/);
    // No row was created for the rejected launch.
    expect(findActiveInvestigation(WS_MAIN, domain)).toBeNull();
  });

  it('requesting an unknown provider is rejected with a stable code (#235)', async () => {
    const domain = `unknown-rejected-${Date.now()}.example.com`;
    const res = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'browser_use_cloud',
    });
    expect(res.status).toBe(400);
    expect(String(res.json.code ?? res.json.error)).toMatch(/invalid_input/);
    expect(findActiveInvestigation(WS_MAIN, domain)).toBeNull();
  });

  it('legacy scenario knob carries no control in production (#235)', async () => {
    const domain = `scenario-ignored-${Date.now()}.example.com`;
    const res = await postJson(`/api/domains/${domain}/investigations`, {
      sampleUrls: [`https://${domain}/products/alpha`],
      scenario: 'malformed',
    });
    expect(res.status).toBe(201);
    // Stripped, never honored: still the real harness, not a fake failure.
    expect(res.json.investigation.provider).toBe('local_browser_harness');
    // #243 async launch: queued immediately, terminal off the request path.
    expect(res.json.investigation.status).toBe('queued');
    const terminal = await waitForInvestigationTerminal(domain, res.json.investigation.id as string);
    expect(terminal.status).toBe('failed');
    expect(terminal.failureCode).toBe('isolation_unavailable');
  });

  it('replayed completions against terminal investigations are rejected', async () => {
    ensureFakeForDirectService();
    const store = createSqliteInvestigationStore();
    const domain = `replay-${Date.now()}.example.com`;
    const created = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'fake',
    });
    // Drive to running, then accept a valid completion via the explicitly
    // injected fake (test-only; never reachable from production launches).
    const { runInvestigation } = await import('../../onboarding/browser-investigation/service');
    fakeInvestigationProvider.setScenario('valid');
    const completed = await runInvestigation(store, 'fake', WS_MAIN, created.id);
    expect(completed.status).toBe('completed');
    const replayed = fakeInvestigationProvider.replay();
    expect(() => acceptCompletion(store, WS_MAIN, created.id, replayed)).toThrowError(/replay_rejected/);
    expect(findInvestigationById(WS_MAIN, created.id)?.status).toBe('completed');
  });

  it('seeded foreign-workspace rows stay invisible to the requesting workspace', () => {
    const seeded = insertInvestigation({
      workspaceId: WS_FOREIGN,
      domain: 'seeded-foreign.example.com',
      mode: 'domain_onboarding',
      status: 'completed',
      provider: 'fake',
      runId: 'binvrun_seeded',
      requestedModelJson: null,
      actualModelJson: null,
      inputSnapshotJson: JSON.stringify({
        domain: 'seeded-foreign.example.com',
        mode: 'domain_onboarding',
        sampleUrls: ['https://seeded-foreign.example.com/p'],
        budget: { maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 },
        modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
        knownContext: {},
        requestedAt: new Date().toISOString(),
      }),
      inputHash: 'seeded-hash',
      budgetJson: JSON.stringify({ maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(findInvestigationById(WS_MAIN, seeded.id)).toBeNull();
    expect(findInvestigationById(WS_FOREIGN, seeded.id)?.id).toBe(seeded.id);
  });
});

describe('#243 worker orphan reconciliation and dispatch fallback (memory store)', () => {
  const silentLog = { error: () => {}, warn: () => {}, log: () => {} };

  async function waitForStoreStatus(
    store: ReturnType<typeof createMemoryInvestigationStore>,
    workspaceId: string,
    id: string,
    status: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      const row = store.find(workspaceId, id);
      if (row?.status === status) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${id} to reach ${status} (last=${row?.status})`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('marks an unexpected dispatch throw failed with provider_error (fallback, no service marking)', async () => {
    const store = createMemoryInvestigationStore();
    const domain = `dispatch-fallback-${Date.now()}.example.com`;
    const created = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'fake',
    });
    expect(store.find(WS_MAIN, created.id)?.status).toBe('queued');
    // Injected dispatch throws without touching the row: the service never
    // marks anything, so the worker fallback must fail the row itself.
    const worker = createInvestigationWorker({
      storeFactory: () => store,
      workspaceIds: [WS_MAIN],
      run: async () => {
        throw new Error('boom-dispatch');
      },
      log: silentLog,
    });
    const processed = await worker.tick();
    expect(processed).toBe(1);
    const after = store.find(WS_MAIN, created.id);
    expect(after?.status).toBe('failed');
    expect(after?.failureCode).toBe('provider_error');
    expect(String(after?.failureDetail)).toMatch(/provider_error/);
    worker.stop();
  });

  it('reconciles a pre-existing running row on first start and never touches live runs', async () => {
    const store = createMemoryInvestigationStore();
    const domain = `orphan-${Date.now()}.example.com`;
    const created = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${domain}/products/alpha`],
      provider: 'fake',
    });
    // Simulate a previous-process orphan: queued -> running with no terminal outcome.
    const at = new Date().toISOString();
    store.update(WS_MAIN, created.id, { status: 'running', startedAt: at, updatedAt: at });
    expect(store.find(WS_MAIN, created.id)?.status).toBe('running');
    let dispatchCalls = 0;
    const worker = createInvestigationWorker({
      storeFactory: () => store,
      workspaceIds: [WS_MAIN],
      run: async () => {
        dispatchCalls += 1;
        throw new Error('should not dispatch: no queued rows');
      },
      log: silentLog,
    });
    worker.start();
    try {
      await waitForStoreStatus(store, WS_MAIN, created.id, 'failed');
    } finally {
      worker.stop();
    }
    const orphan = store.find(WS_MAIN, created.id);
    expect(orphan?.status).toBe('failed');
    expect(orphan?.failureCode).toBe('provider_error');
    expect(String(orphan?.failureDetail)).toMatch(/orphaned/);
    expect(dispatchCalls).toBe(0);
    // Live runs in the current process are never reconciled: a running row
    // created after startup survives later ticks (tick never reconciles).
    const liveDomain = `live-${Date.now()}.example.com`;
    const live = requestInvestigation(store, {
      workspaceId: WS_MAIN,
      domain: liveDomain,
      mode: 'domain_onboarding',
      sampleUrls: [`https://${liveDomain}/products/alpha`],
      provider: 'fake',
    });
    store.update(WS_MAIN, live.id, { status: 'running', startedAt: at, updatedAt: at });
    expect(await worker.tick()).toBe(0);
    expect(store.find(WS_MAIN, live.id)?.status).toBe('running');
    worker.stop();
  });
});
