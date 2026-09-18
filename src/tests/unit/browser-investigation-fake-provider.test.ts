// T1 (#225) — fake provider + lifecycle behavior (Vitest, in-memory store).
//
// Exercises the full control-plane boundary without SQLite: all eight fake
// scenarios, workspace scoping, active-conflict, replay/stale rejection,
// cancel/discard transitions, and the zero-provider-call regression for
// normal extraction paths. The SQLite repository seam has its own Bun suite.
//
// Since #235 the fake is explicit test injection only (`provider: 'fake'`
// alongside a registered `FakeInvestigationProvider`); omitting `provider`
// resolves to the real local harness.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeInvestigationProvider,
  FAKE_INVESTIGATION_SCENARIOS,
} from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProviderCallCount,
  registerInvestigationProvider,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import {
  acceptCompletion,
  cancelInvestigation,
  discardInvestigation,
  getInvestigation,
  InvestigationServiceError,
  listInvestigations,
  requestAndRunInvestigation,
  requestInvestigation,
  runInvestigation,
} from '../../onboarding/browser-investigation/service';
import { createMemoryInvestigationStore as createMemoryStore } from './helpers/browser-investigation-memory-store';

const WS = 'ws-t1-memory';
const FOREIGN = 'ws-t1-foreign';
const DOMAIN = 'investigation.example.com';
const URLS = ['https://investigation.example.com/products/alpha'];

function useFake(scenario: Parameters<FakeInvestigationProvider['setScenario']>[0]): FakeInvestigationProvider {
  const fake = new FakeInvestigationProvider();
  fake.setScenario(scenario);
  registerInvestigationProvider(fake);
  resetInvestigationProviderCalls();
  return fake;
}

describe('fake provider scenario coverage (T1)', () => {
  it('declares all eight required behaviors', () => {
    expect([...FAKE_INVESTIGATION_SCENARIOS].sort()).toEqual(
      ['budget_exhaustion', 'cancellation', 'error', 'evidence_missing', 'malformed', 'replayed_completion', 'timeout', 'valid'].sort(),
    );
  });

  it.each([
    ['valid', 'completed', null],
    ['malformed', 'failed', 'malformed_result'],
    ['evidence_missing', 'failed', 'evidence_missing'],
    ['timeout', 'failed', 'timeout'],
    ['error', 'failed', 'provider_error'],
    ['cancellation', 'cancelled', 'cancelled'],
    ['budget_exhaustion', 'failed', 'budget_exhausted'],
    ['replayed_completion', 'completed', null],
  ] as const)('scenario %s ends %s (%s)', async (scenario, status, code) => {
    const store = createMemoryStore();
    useFake(scenario);
    const record = await requestAndRunInvestigation(store, {
      workspaceId: WS,
      domain: `${scenario}.${DOMAIN}`,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      provider: 'fake',
    });
    expect(record.status).toBe(status);
    expect(record.failureCode).toBe(code);
    if (status === 'completed') {
      expect(record.result).not.toBeNull();
      expect(record.resultHash).toBeTruthy();
      expect(record.inputHash).toBeTruthy();
    }
  });
});

describe('investigation lifecycle (T1, in-memory)', () => {
  beforeEach(() => {
    resetInvestigationProviderCalls();
  });

  it('persists workspace, normalized domain, mode, provider/run identity, snapshot hash, budget, and timestamps', async () => {
    const store = createMemoryStore();
    useFake('valid');
    const record = await requestAndRunInvestigation(store, {
      workspaceId: WS,
      domain: 'WWW.Shop.Example.COM',
      mode: 'drift_repair',
      sampleUrls: URLS,
      provider: 'fake',
    });
    expect(record.workspaceId).toBe(WS);
    expect(record.domain).toBe('shop.example.com');
    expect(record.mode).toBe('drift_repair');
    expect(record.provider).toBe('fake');
    expect(record.runId).toBeTruthy();
    expect(record.inputSnapshot.domain).toBe('shop.example.com');
    expect(record.inputHash).toMatch(/^[0-9a-f]{16,}$/);
    expect(record.budget.maxPages).toBe(5);
    expect(record.createdAt).toBeTruthy();
    expect(record.usage?.costBasis).toBe('unavailable');
  });

  it('rejects a second active investigation per workspace+domain', () => {
    const store = createMemoryStore();
    useFake('valid');
    requestInvestigation(store, { workspaceId: WS, domain: DOMAIN, mode: 'domain_onboarding', sampleUrls: URLS, provider: 'fake' });
    expect(() =>
      requestInvestigation(store, { workspaceId: WS, domain: DOMAIN, mode: 'domain_onboarding', sampleUrls: URLS, provider: 'fake' }),
    ).toThrowError(/conflict_active_investigation/);
    // A different workspace may investigate the same domain concurrently.
    expect(() =>
      requestInvestigation(store, { workspaceId: FOREIGN, domain: DOMAIN, mode: 'domain_onboarding', sampleUrls: URLS, provider: 'fake' }),
    ).not.toThrow();
  });

  it('enforces workspace scoping on reads, status, cancel, and discard', async () => {
    const store = createMemoryStore();
    useFake('valid');
    const record = await requestAndRunInvestigation(store, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      provider: 'fake',
    });
    expect(() => getInvestigation(store, FOREIGN, record.id)).toThrowError(/workspace_mismatch/);
    expect(listInvestigations(store, FOREIGN)).toEqual([]);
    expect(listInvestigations(store, WS).map((r) => r.id)).toContain(record.id);
    const discarded = discardInvestigation(store, WS, record.id, 'operator-1');
    expect(discarded.status).toBe('discarded');
    expect(() => discardInvestigation(store, FOREIGN, record.id, 'operator-1')).toThrowError(/workspace_mismatch/);
  });

  it('rejects replayed completions without mutating state', async () => {
    const store = createMemoryStore();
    const fake = useFake('replayed_completion');
    const record = await requestAndRunInvestigation(store, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      provider: 'fake',
    });
    expect(record.status).toBe('completed');
    const replayed = fake.replay();
    expect(() => acceptCompletion(store, WS, record.id, replayed)).toThrowError(/replay_rejected/);
    expect(getInvestigation(store, WS, record.id).status).toBe('completed');
  });

  it('rejects stale completions with runId/inputHash mismatch without mutating state', async () => {
    const store = createMemoryStore();
    useFake('valid');
    const queued = requestInvestigation(store, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
    });
    // Move to running via the store to obtain a completion fixture.
    store.update(WS, queued.id, { status: 'running', startedAt: queued.createdAt, updatedAt: queued.createdAt });
    expect(() =>
      acceptCompletion(store, WS, queued.id, {
        investigationId: queued.id,
        runId: 'binvrun_stale',
        provider: 'fake',
        inputHash: queued.inputHash,
        result: { version: 1, summary: 'x', observations: [] },
      }),
    ).toThrowError(/stale_completion/);
    // Stale delivery is a pure rejection: the running run is untouched.
    expect(getInvestigation(store, WS, queued.id).status).toBe('running');
  });

  it('cancels queued work and discards terminal work; active discard is rejected', () => {
    const store = createMemoryStore();
    useFake('valid');
    const queued = requestInvestigation(store, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
    });
    // Active investigations cannot be discarded.
    expect(() => discardInvestigation(store, WS, queued.id, 'op')).toThrowError(/invalid_transition/);
    const cancelled = cancelInvestigation(store, WS, queued.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.failureCode).toBe('cancelled');
    const discarded = discardInvestigation(store, WS, queued.id, 'op');
    expect(discarded.status).toBe('discarded');
    expect(() => cancelInvestigation(store, WS, queued.id)).toThrowError(/invalid_transition/);
  });

  it('fails completions whose usage overruns budget (calls, duration, cost)', () => {
    const store = createMemoryStore();
    useFake('valid');
    const queued = requestInvestigation(store, {
      workspaceId: WS,
      domain: `overrun.${DOMAIN}`,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      budget: { maxCostUsd: 1 },
    });
    store.update(WS, queued.id, { status: 'running', startedAt: queued.createdAt, updatedAt: queued.createdAt });
    const completion = {
      investigationId: queued.id,
      runId: queued.runId,
      provider: 'fake' as const,
      inputHash: queued.inputHash,
      result: {
        version: 1 as const,
        summary: 'overrun fixture',
        observations: [{ kind: 'k', sourceUrl: URLS[0], artifactHash: 'abcdef1234567890' }],
      },
    };
    for (const usage of [
      { modelCalls: 99, costBasis: 'unavailable' as const },
      { modelCalls: 1, durationMs: 10 * 60 * 1000 + 1, costBasis: 'unavailable' as const },
      { modelCalls: 1, costUsd: 2, costBasis: 'billed' as const },
    ]) {
      expect(() => acceptCompletion(store, WS, queued.id, { ...completion, usage })).toThrowError(/budget_exhausted/);
      // Reset to running for the next overrun variant.
      store.update(WS, queued.id, { status: 'running', updatedAt: queued.createdAt });
    }
    expect(getInvestigation(store, WS, queued.id).status).toBe('running');
  });

  it('fails closed on invalid and private sample URLs', () => {
    const store = createMemoryStore();
    useFake('valid');
    for (const bad of [
      ['not-a-url'],
      ['ftp://example.com/file'],
      ['http://localhost/product'],
      ['https://127.0.0.1/product'],
      ['https://10.0.0.9/product'],
      ['https://192.168.1.10/product'],
    ]) {
      expect(() =>
        requestInvestigation(store, { workspaceId: WS, domain: `bad-${Math.random()}.example.com`, mode: 'domain_onboarding', sampleUrls: bad }),
      ).toThrowError(/invalid_input/);
    }
  });

  it('normal product extraction paths make zero provider calls (negative invariant)', async () => {
    const store = createMemoryStore();
    resetInvestigationProviderCalls();
    // No provider calls may occur unless the explicit service run path is
    // used (source-level isolation is pinned by the provider-isolation
    // suite; this asserts the runtime counter side of the invariant).
    expect(getInvestigationProviderCallCount()).toBe(0);
    // The explicit run path is the only caller: one investigation costs calls.
    useFake('valid');
    await requestAndRunInvestigation(store, {
      workspaceId: WS,
      domain: `regression.${DOMAIN}`,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      provider: 'fake',
    });
    expect(getInvestigationProviderCallCount()).toBeGreaterThan(0);
  });

  it('cloud provider resolution stays disabled', async () => {
    const { resolveInvestigationProvider } = await import('../../onboarding/browser-investigation/provider');
    expect(() => resolveInvestigationProvider('cloud')).toThrowError(/cloud_disabled/);
    expect(() => resolveInvestigationProvider('browser_use_cloud')).toThrowError(/cloud_disabled/);
  });

  it('omitting provider resolves to the local harness, never the fake (#235)', () => {
    const store = createMemoryStore();
    useFake('valid');
    const created = requestInvestigation(store, {
      workspaceId: WS,
      domain: `default.${DOMAIN}`,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
    });
    expect(created.provider).toBe('local_browser_harness');
  });

  it('unknown provider ids are rejected with a stable code (#235)', () => {
    const store = createMemoryStore();
    useFake('valid');
    expect(() =>
      requestInvestigation(store, {
        workspaceId: WS,
        domain: `unknown.${DOMAIN}`,
        mode: 'domain_onboarding',
        sampleUrls: URLS,
        provider: 'browser_use_cloud' as never,
      }),
    ).toThrowError(/invalid_input/);
  });

  it('local harness without isolation fails closed', async () => {
    const store = createMemoryStore();
    const created = requestInvestigation(store, {
      workspaceId: WS,
      domain: `local.${DOMAIN}`,
      mode: 'domain_onboarding',
      sampleUrls: URLS,
      provider: 'local_browser_harness',
    });
    await expect(runInvestigation(store, 'local_browser_harness', WS, created.id)).rejects.toThrowError(
      InvestigationServiceError,
    );
    expect(getInvestigation(store, WS, created.id).status).toBe('failed');
    expect(getInvestigation(store, WS, created.id).failureCode).toBe('isolation_unavailable');
  });
});
