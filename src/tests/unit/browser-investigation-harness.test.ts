// T3 (#227) — local harness provider behavior (Vitest; fake isolation + transport).
//
// A real bounded read of an approved page returns a hashed, size-capped
// artifact and observations within budget. Missing isolation, unenforceable
// monetary ceilings, a busy slot, and empty captures all fail closed with
// stable codes. Deterministic teardown runs on every outcome.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveInvestigationBudget,
  type InvestigationBudget,
} from '../../shared/schemas/browser-investigation';
import type { InvestigationProviderRequest } from '../../onboarding/browser-investigation/provider';
import { isExtendedUsageWithinBudget } from '../../onboarding/browser-investigation/budgets';
import {
  InvestigationProviderError,
  type InvestigationProviderCompletion,
} from '../../onboarding/browser-investigation/provider';
import {
  acceptCompletion,
  requestInvestigation,
} from '../../onboarding/browser-investigation/service';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';
import {
  LocalBrowserHarnessProvider,
  type LocalHarnessDeps,
} from '../../onboarding/browser-investigation/local-harness';
import {
  releaseInvestigationSlot,
  type ContainerRunner,
} from '../../onboarding/browser-investigation/isolation';
import type { BrokerTransport } from '../../onboarding/browser-investigation/broker';

const ENV_KEY = 'BAYSTATE_INVESTIGATION_ISOLATION';
let savedEnv: string | undefined;

const PAGE_HTML = `<!doctype html><html><head>
<title>Acme All-Natural Dog Food 15 lb</title>
<meta property="og:title" content="Acme All-Natural Dog Food" />
<meta name="description" content="Grain-free kibble for active dogs." />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Dog Food","brand":{"@type":"Brand","name":"Acme"},"offers":{"price":"54.99"}}</script>
<script src="https://cdn.shopify.com/s/files/1/shop.js"></script>
</head><body><h1>Acme All-Natural Dog Food</h1>
<img src="https://brand.example/images/kibble.jpg" alt="kibble" />
<img src="https://brand.example/images/kibble-2.jpg" alt="kibble bowl" />
</body></html>`;

const PUBLIC_IP = '93.184.216.34';

function htmlTransport(
  html: string | ((url: string) => { status: number; body: string; contentType?: string }),
  calls?: string[],
): BrokerTransport {
  return async (req) => {
    calls?.push(req.url);
    const res = typeof html === 'function' ? html(req.url) : { status: 200, body: html };
    const body = Buffer.from(res.body, 'utf8');
    return {
      status: res.status,
      headers: { 'content-type': res.contentType ?? 'text/html; charset=utf-8' },
      body,
      connectedIp: req.validatedAddresses[0] ?? null,
    };
  };
}

function lookupPublic(host: string): Promise<string[]> {
  void host;
  return Promise.resolve([PUBLIC_IP]);
}

function harness(
  deps: LocalHarnessDeps = {},
  transport?: BrokerTransport,
): { provider: LocalBrowserHarnessProvider; tornDown: string[] } {
  const tornDown: string[] = [];
  const runner: ContainerRunner = { teardown: async (runId: string) => void tornDown.push(runId) };
  const provider = new LocalBrowserHarnessProvider({
    isolationProbe: { dockerReachable: async () => true },
    brokerDeps: { lookup: lookupPublic, transport: transport ?? htmlTransport(PAGE_HTML) },
    containerRunner: runner,
    ...deps,
  });
  return { provider, tornDown };
}

function requestFor(
  sampleUrls: string[],
  budget?: Partial<InvestigationBudget>,
): InvestigationProviderRequest {
  const resolved = resolveInvestigationBudget(budget);
  return {
    investigationId: 'binv_harness_1',
    workspaceId: 'ws_harness',
    domain: 'brand.example',
    mode: 'domain_onboarding',
    sampleUrls,
    inputSnapshot: {
      domain: 'brand.example',
      mode: 'domain_onboarding',
      sampleUrls,
      budget: resolved,
      modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
      knownContext: {},
      requestedAt: new Date().toISOString(),
    },
    inputHash: 'abcdef1234567890abcdef1234567890',
    budget: resolved,
    modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
    knownContext: {},
    runId: 'binvrun_harness1',
  };
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'ready';
  releaseInvestigationSlot();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  releaseInvestigationSlot();
});

describe('local harness bounded read', () => {
  it('returns hashed, size-capped artifacts and observations within budget', async () => {
    const fetched: string[] = [];
    const { provider, tornDown } = harness({}, htmlTransport(PAGE_HTML, fetched));
    const req = requestFor(['https://brand.example/products/alpha', 'https://brand.example/products/beta']);
    const completion = await provider.invoke(req);

    expect(completion.provider).toBe('local_browser_harness');
    expect(completion.investigationId).toBe(req.investigationId);
    expect(completion.runId).toBe(req.runId);
    expect(completion.inputHash).toBe(req.inputHash);
    expect(fetched).toHaveLength(2);

    const result = completion.result as unknown as {
      version: number;
      observations: Array<{ kind: string; sourceUrl: string; artifactHash: string; incomplete: boolean }>;
      evidenceRefs: string[];
      gaps: string[];
      platform?: string;
      renderedBrowserRequired: boolean;
    };
    expect(result.version).toBe(1);
    expect(result.observations.length).toBeGreaterThanOrEqual(8);
    const kinds = new Set(result.observations.map((o) => o.kind));
    for (const kind of ['network_response', 'page_title', 'page_meta', 'page_json_ld', 'page_images']) {
      expect(kinds, kind).toContain(kind);
    }
    for (const obs of result.observations) {
      expect(obs.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      expect(obs.sourceUrl).toMatch(/^https:\/\/brand\.example\//);
      expect(typeof obs.incomplete).toBe('boolean');
    }
    expect(result.platform).toBe('shopify');
    expect(result.evidenceRefs.length).toBe(2);
    expect(result.renderedBrowserRequired).toBe(false);

    const usage = completion.usage!;
    expect(usage.pagesVisited).toBe(2);
    expect(usage.readsPerformed).toBeGreaterThan(0);
    expect(usage.readsPerformed).toBeLessThanOrEqual(req.budget.maxReads);
    expect(usage.modelCalls).toBe(0);
    expect(usage.costBasis).toBe('unavailable');
    expect(usage.requestAttempts).toBe(2);
    expect(isExtendedUsageWithinBudget(usage, req.budget)).toBe(true);

    // Deterministic teardown ran for the run.
    expect(tornDown).toEqual(['binvrun_harness1']);
  });

  it('reports a rendering need when static reads yield no DOM evidence', async () => {
    const bare = '<html><head></head><body><div id="app"></div></body></html>';
    const { provider } = harness({}, htmlTransport(bare));
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha']));
    const result = completion.result as unknown as {
      observations: Array<{ kind: string }>;
      renderedBrowserRequired: boolean;
      renderedBrowserReason: string;
    };
    // Static reads honestly report their limit instead of claiming sufficiency.
    expect(result.renderedBrowserRequired).toBe(true);
    expect(result.renderedBrowserReason).toMatch(/rendered browser may be required/);
    expect(result.observations.map((o) => o.kind)).toContain('network_response');
  });

  it('tightens op bounds from lowered budgets (gate, not documentation)', async () => {
    const { provider } = harness({}, htmlTransport(PAGE_HTML));
    const completion = await provider.invoke(
      requestFor(['https://brand.example/products/alpha'], { maxSelectorMatches: 1 }),
    );
    const result = completion.result as unknown as {
      observations: Array<{ kind: string; detail?: string }>;
    };
    // Two image elements exist; the lowered match cap clamps the query to one.
    const images = result.observations.find((o) => o.kind === 'page_images');
    expect(images?.detail).toMatch(/image elements observed: 1/);
  });

  it('stops the read plan when read operations exhaust the budget', async () => {
    const { provider, tornDown } = harness({}, htmlTransport(PAGE_HTML));
    await expect(
      provider.invoke(requestFor(['https://brand.example/products/alpha'], { maxReads: 3 })),
    ).rejects.toThrowError(/budget_exhausted/);
    expect(tornDown).toEqual(['binvrun_harness1']);
  });

  it('records gaps for denied pages but completes from the rest', async () => {
    const { provider } = harness(
      {},
      htmlTransport((url) =>
        url.includes('beta')
          ? { status: 302, body: '' }
          : { status: 200, body: PAGE_HTML },
      ),
    );
    // Beta redirects to itself; the fake loops within hop cap then stops.
    const completion = await provider.invoke(
      requestFor(['https://brand.example/products/alpha', 'https://brand.example/products/beta']),
    );
    const result = completion.result as unknown as { observations: unknown[]; gaps: string[] };
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.gaps.length).toBeGreaterThanOrEqual(1);
  });

  it('fails closed when every page is denied (no observations)', async () => {
    const { provider, tornDown } = harness(
      {},
      async () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nope'), connectedIp: null }),
    );
    await expect(provider.invoke(requestFor(['https://brand.example/products/alpha']))).rejects.toThrowError(
      InvestigationProviderError,
    );
    expect(tornDown).toEqual(['binvrun_harness1']);
  });

  it('fails closed without isolation (missing enablement or runtime)', async () => {
    delete process.env[ENV_KEY];
    const { provider } = harness();
    await expect(provider.invoke(requestFor(['https://brand.example/products/alpha']))).rejects.toThrowError(
      /isolation_unavailable/,
    );
    process.env[ENV_KEY] = 'ready';
    const { provider: unreachable } = harness({
      isolationProbe: { dockerReachable: async () => false },
    });
    await expect(unreachable.invoke(requestFor(['https://brand.example/products/alpha']))).rejects.toThrowError(
      /isolation_unavailable/,
    );
  });

  it('fails closed on unenforceable monetary ceilings before any fetch', async () => {
    const fetched: string[] = [];
    const { provider } = harness({}, htmlTransport(PAGE_HTML, fetched));
    await expect(
      provider.invoke(requestFor(['https://brand.example/products/alpha'], { maxCostUsd: 5 })),
    ).rejects.toThrowError(/budget_not_enforceable/);
    expect(fetched).toHaveLength(0);
  });

  it('serializes runs: a busy slot fails without fetching', async () => {
    const fetched: string[] = [];
    const { provider } = harness({}, htmlTransport(PAGE_HTML, fetched));
    const { tryAcquireInvestigationSlot } = await import(
      '../../onboarding/browser-investigation/isolation'
    );
    expect(tryAcquireInvestigationSlot()).toBe(true);
    try {
      await expect(provider.invoke(requestFor(['https://brand.example/products/alpha']))).rejects.toThrowError(
        /another local investigation is running/,
      );
      expect(fetched).toHaveLength(0);
    } finally {
      releaseInvestigationSlot();
    }
  });

  it('stops oversized downloads: no observations, no prefix hash masquerading as full', async () => {
    const big = `<html><head><title>${'y'.repeat(4000)}</title></head><body>${'z'.repeat(200_000)}</body></html>`;
    const { provider, tornDown } = harness({}, htmlTransport(big));
    // Body exceeds the per-response cap → broker stops the download → gap →
    // zero observations → harness fails closed (never a clipped fake success).
    await expect(
      provider.invoke(
        requestFor(['https://brand.example/products/big'], { maxResponseBytesPerResponse: 4096 }),
      ),
    ).rejects.toThrowError(/no observations captured/);
    expect(tornDown).toEqual(['binvrun_harness1']);
  });

  it('marks clipped observations incomplete; absence stays uncertifiable', async () => {
    // A long meta description overflows the 1024 B observation cap → the
    // observation is marked incomplete instead of silently truncated.
    const longMeta = PAGE_HTML.replace(
      'Grain-free kibble for active dogs.',
      `Grain-free kibble for active dogs. ${'Nutritious and delicious. '.repeat(120)}`,
    );
    const { provider } = harness({}, htmlTransport(longMeta));
    const completion = await provider.invoke(
      requestFor(['https://brand.example/products/alpha'], { maxObservationBytesPerOperation: 1024 }),
    );
    const result = completion.result as unknown as {
      observations: Array<{ incomplete: boolean }>;
      gaps: string[];
    };
    expect(result.observations.some((o) => o.incomplete)).toBe(true);
  });
});

describe('harness usage is re-checked at the service seam', () => {
  it('rejects completions whose extended counters overrun budget', () => {
    const store = createMemoryInvestigationStore();
    const queued = requestInvestigation(store, {
      workspaceId: 'ws_harness',
      domain: 'brand.example',
      mode: 'domain_onboarding',
      sampleUrls: ['https://brand.example/products/alpha'],
      budget: { maxRequestAttempts: 5 },
    });
    store.update('ws_harness', queued.id, {
      status: 'running',
      startedAt: queued.createdAt,
      updatedAt: queued.createdAt,
    });
    const completion: InvestigationProviderCompletion = {
      investigationId: queued.id,
      runId: queued.runId,
      provider: 'fake',
      inputHash: queued.inputHash,
      result: {
        version: 1,
        summary: 'overrun fixture',
        observations: [{ kind: 'k', sourceUrl: 'https://brand.example/products/alpha', artifactHash: 'abcdef1234567890' }],
      },
      usage: { requestAttempts: 999, costBasis: 'unavailable' },
    };
    expect(() => acceptCompletion(store, 'ws_harness', queued.id, completion)).toThrowError(/budget_exhausted/);
  });
});
