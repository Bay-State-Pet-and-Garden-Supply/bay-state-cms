// #237 — Tier 1 rendered investigation + bounded model reasoning (Vitest).
//
// Acceptance pins (externally visible behavior only — never prompt text,
// model output, or audit internals):
// - render container egress restricted to the validating forward proxy;
//   denial proven at container level (argv shape + live probe);
// - model context holds no holdout material (URLs, artifacts, failure
//   context, reports, metadata) — enforced by construction, adversarially
//   tested; prompts/keys/page bodies/knownContext values have no channel;
// - usage reports actual calls + acting model (0/app-authored-read-plan for
//   Tier 0 alone, 1/stub identity after the bounded call);
// - real harness returns non-empty identity requirements on Shopify
//   material and the result compiles — even with a junk reasoner;
// - budget exhaustion (calls, tokens, images, time) fails closed.
//
// Deterministic sections stay daemon-free (labeled doubles); the live
// denial section gates on a daemon and skips loudly otherwise.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INVESTIGATION_NETWORK_SHAPE,
  RENDER_CONTAINER_IMAGE,
  RENDER_CONTAINER_NETWORK,
  RENDER_WORKER_CONTAINER_ENTRYPOINT,
  TIER1_RENDER_CONTAINER_STATUS,
  assertContainerPosture,
  assertRenderContainerPosture,
  buildRenderContainerSpec,
  renderContainerDockerArgs,
  releaseInvestigationSlot,
  type RenderContainerSpec,
} from '../../onboarding/browser-investigation/isolation';
import {
  BudgetLedger,
  InvestigationBudgetError,
} from '../../onboarding/browser-investigation/budgets';
import {
  resolveInvestigationBudget,
  type InvestigationBudget,
} from '../../shared/schemas/browser-investigation';
import { compileInvestigationResult } from '../../onboarding/browser-investigation/compiler';
import type { InvestigationProviderRequest } from '../../onboarding/browser-investigation/provider';
import {
  LocalBrowserHarnessProvider,
  type LocalHarnessDeps,
} from '../../onboarding/browser-investigation/local-harness';
import type { Tier0ContainerRunner } from '../../onboarding/browser-investigation/container-runner';
import type { Tier1RenderRunner, Tier1RenderedObservation } from '../../onboarding/browser-investigation/render-runner';
import { RenderRunnerError } from '../../onboarding/browser-investigation/render-runner';
import { startRenderProxy } from '../../onboarding/browser-investigation/render-proxy';
import {
  buildTier1ModelContext,
  exclusionCommitmentOf,
  reasonWithBudget,
  type Tier1ModelContext,
  type Tier1ModelReasoner,
} from '../../onboarding/browser-investigation/model-context';
import type { BrokerTransport } from '../../onboarding/browser-investigation/broker';

const execFileAsync = promisify(execFile);
const ENV_KEY = 'BAYSTATE_INVESTIGATION_ISOLATION';
let savedEnv: string | undefined;

const PUBLIC_IP = '93.184.216.34';
const HOLDOUT_URL = 'https://brand.example/holdout/blind-page';
const HOLDOUT_ARTIFACT = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

const SHOPIFY_JS = JSON.stringify({
  id: 12345678,
  title: 'Acme All-Natural Dog Food',
  vendor: 'Acme',
  handle: 'acme-dog-food',
  variants: [
    { id: 111, title: 'Small', sku: 'ACME-SM', barcode: '012345678905', available: true, price: '5499', option1: 'Small', option2: null, option3: null },
    { id: 222, title: 'Large', sku: 'ACME-LG', barcode: '012345678912', available: false, price: '6499', option1: 'Large', option2: null, option3: null },
  ],
  images: [],
  options: [{ name: 'Size', values: ['Small', 'Large'] }],
});

const BARE_HTML = '<html><head></head><body><div id="app"></div></body></html>';
const DOM_HTML = `<!doctype html><html><head>
<title>Acme All-Natural Dog Food 15 lb</title>
<meta name="description" content="Grain-free kibble for active dogs." />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Dog Food","brand":{"@type":"Brand","name":"Acme"}}</script>
</head><body><h1>Acme All-Natural Dog Food</h1>
<img src="https://brand.example/images/kibble.jpg" alt="kibble" />
</body></html>`;
const ARTIFACT_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function htmlTransport(
  html: string | ((url: string) => { status: number; body: string; contentType?: string }),
  calls?: string[],
): BrokerTransport {
  return async (req) => {
    calls?.push(req.url);
    const res = typeof html === 'function' ? html(req.url) : { status: 200, body: html };
    return {
      status: res.status,
      headers: { 'content-type': res.contentType ?? 'text/html; charset=utf-8' },
      body: Buffer.from(res.body, 'utf8'),
      connectedIp: req.validatedAddresses[0] ?? null,
    };
  };
}

function lookupPublic(host: string): Promise<string[]> {
  void host;
  return Promise.resolve([PUBLIC_IP]);
}

// Labeled in-process Tier 0 double (same pattern as the harness suite:
// production always executes in-container).
function inProcessTier0Runner(tornDown: string[]): Tier0ContainerRunner {
  return {
    start: async (spec) => void assertContainerPosture(spec),
    runAnalysis: async (_spec, request) => {
      const { analyzeTier0Captures } = await import(
        '../../onboarding/browser-investigation/tier0-analyzer.mjs'
      );
      return analyzeTier0Captures(request);
    },
    teardown: async (runId: string) => void tornDown.push(runId),
  };
}

function stubRenderRunner(
  outcome: {
    observations?: Tier1RenderedObservation[];
    gaps?: string[];
    reads?: number;
    startError?: Error;
    runError?: Error;
  } = {},
  tornDown: string[] = [],
): Tier1RenderRunner {
  return {
    start: async (spec) => {
      void assertRenderContainerPosture(spec);
      if (outcome.startError) throw outcome.startError;
    },
    runRender: async () => {
      if (outcome.runError) throw outcome.runError;
      return {
        observations: outcome.observations ?? [],
        gaps: outcome.gaps ?? [],
        readsPerformed: outcome.reads ?? 2,
      };
    },
    teardown: async (runId: string) => void tornDown.push(runId),
  };
}

function stubReasoner(
  result: Record<string, unknown> = {},
  seen: Tier1ModelContext[] = [],
): Tier1ModelReasoner {
  return {
    reason: async (context) => {
      seen.push(context);
      return {
        strategy: 'stub-advisory-strategy',
        gaps: ['stub model gap'],
        outputTokens: 12,
        model: { provider: 'stub', model: 'stub-reasoner-v1' },
        ...result,
      } as unknown as Awaited<ReturnType<Tier1ModelReasoner['reason']>>;
    },
  };
}

function harness(
  deps: LocalHarnessDeps = {},
  transport?: BrokerTransport,
): { provider: LocalBrowserHarnessProvider; tornDown: string[] } {
  const tornDown: string[] = [];
  const provider = new LocalBrowserHarnessProvider({
    isolationProbe: { dockerReachable: async () => true },
    brokerDeps: { lookup: lookupPublic, transport: transport ?? htmlTransport(BARE_HTML) },
    containerRunner: inProcessTier0Runner(tornDown),
    ...deps,
  });
  return { provider, tornDown };
}

function requestFor(
  sampleUrls: string[],
  overrides: {
    budget?: Partial<InvestigationBudget>;
    modelPolicy?: { allowCloudTextAnalysis?: boolean; allowImageSharing?: boolean };
    knownContext?: Record<string, unknown>;
  } = {},
): InvestigationProviderRequest {
  const resolved = resolveInvestigationBudget(overrides.budget);
  const modelPolicy = {
    allowCloudTextAnalysis: false,
    allowImageSharing: false,
    ...overrides.modelPolicy,
  };
  return {
    investigationId: 'binv_tier1_1',
    workspaceId: 'ws_tier1',
    domain: 'brand.example',
    mode: 'domain_onboarding',
    sampleUrls,
    inputSnapshot: {
      domain: 'brand.example',
      mode: 'domain_onboarding',
      sampleUrls,
      budget: resolved,
      modelPolicy,
      knownContext: overrides.knownContext ?? {},
      requestedAt: new Date().toISOString(),
    },
    inputHash: 'abcdef1234567890abcdef1234567890',
    budget: resolved,
    modelPolicy,
    knownContext: overrides.knownContext ?? {},
    runId: 'binvrun_tier1a',
  };
}

function renderedObs(pageUrl: string, artifactRef: string): Tier1RenderedObservation {
  return {
    kind: 'page_rendered',
    sourceUrl: pageUrl,
    artifactHash: ARTIFACT_HASH,
    detail: 'rendered title: Acme; meta: present; json-ld blocks: 1; images: 2',
    incomplete: false,
    artifactRef,
    pageIndex: 0,
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

describe('Tier 1 network shape lives in code and docs', () => {
  it('marks the proxy-only render container implemented, never implied', () => {
    expect(INVESTIGATION_NETWORK_SHAPE.tier1.implemented).toBe(true);
    expect(INVESTIGATION_NETWORK_SHAPE.tier1.egress).toBe('proxy_only');
    expect(TIER1_RENDER_CONTAINER_STATUS).toMatch(/proxy-only egress/);
    expect(TIER1_RENDER_CONTAINER_STATUS).not.toMatch(/deferred/i);
  });

  it('records the Tier 1 shape in docs', () => {
    const design = readFileSync(
      new URL('../../../docs/plans/browser-investigation-design.md', import.meta.url),
      'utf8',
    );
    expect(design).toMatch(/Tier 1.*implemented/s);
    expect(design).toMatch(/proxy-only/);
    const context = readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8');
    expect(context).toMatch(/Tier 1 Rendered Investigation/);
    expect(context).toMatch(/render_deferred/);
  });
});

describe('render container posture: proxy-only egress', () => {
  const PROXY = 'http://host.docker.internal:3128';

  it('builds a proxy-only spec with the exact proxy declaration and retained sandboxes', () => {
    const spec = buildRenderContainerSpec('binvrun_r1', PROXY);
    expect(spec.networkMode).toBe('proxy-only');
    expect(spec.networkName).toBe(RENDER_CONTAINER_NETWORK);
    expect(spec.image).toBe(RENDER_CONTAINER_IMAGE);
    expect(spec.proxyUrl).toBe(PROXY);
    // Exact proxy declaration: standard vars + worker-stack knob + empty NO_PROXY.
    expect(spec.env).toEqual({
      HTTP_PROXY: PROXY,
      HTTPS_PROXY: PROXY,
      http_proxy: PROXY,
      https_proxy: PROXY,
      BAYSTATE_CMS_WORKER_PROXY_URLS: PROXY,
      NO_PROXY: '',
      no_proxy: '',
    });
    expect(spec.privileged).toBe(false);
    expect(spec.user).not.toBe('root');
    expect(spec.teardown).toBe('always-remove');
    expect(spec.browserArgs).not.toContain('--no-sandbox');
    expect(() => assertRenderContainerPosture(spec)).not.toThrow();
  });

  it('rejects posture drift: network, image, env, credentials, sandbox', () => {
    const good = buildRenderContainerSpec('binvrun_r2', PROXY);
    const bad: Array<[string, (s: RenderContainerSpec) => void]> = [
      ['host network', (s) => { s.networkMode = 'host'; }],
      ['wrong network name', (s) => { s.networkName = 'bridge'; }],
      ['substitute image', (s) => { s.image = 'evil/image:latest'; }],
      ['extra env var', (s) => { s.env = { ...s.env, EXTRA: '1' }; }],
      ['missing proxy var', (s) => { const { HTTP_PROXY: _d, ...rest } = s.env; s.env = rest; }],
      ['credentialed proxy', (s) => { s.proxyUrl = 'http://user:pass@host:3128'; s.env = { ...s.env }; }],
      ['privileged', (s) => { s.privileged = true; }],
      ['no-sandbox', (s) => { s.browserArgs = [...s.browserArgs, '--no-sandbox']; }],
      ['host mount', (s) => { s.mounts = ['/var/run/docker.sock:/sock']; }],
    ];
    for (const [label, mutate] of bad) {
      const spec = { ...good, env: { ...good.env }, browserArgs: [...good.browserArgs], mounts: [...good.mounts] };
      mutate(spec);
      expect(() => assertRenderContainerPosture(spec), label).toThrowError(/isolation_unavailable/);
    }
    // Credentialed proxy URL rejected at build time too.
    expect(() => buildRenderContainerSpec('binvrun_r3', 'http://user:pass@host:3128')).toThrowError(
      /isolation_unavailable/,
    );
  });

  it('builds proxy-only argv: isolated network, host-gateway alias, bun worker, no direct egress', () => {
    const spec = buildRenderContainerSpec('binvrun_r4', PROXY);
    const argv = renderContainerDockerArgs(spec);
    const joined = argv.join(' ');
    expect(argv[0]).toBe('run');
    expect(argv).toContain('--rm');
    expect(argv).toContain('-i');
    expect(joined).toContain(`--network=${RENDER_CONTAINER_NETWORK}`);
    expect(joined).not.toContain('--network=host');
    expect(joined).not.toContain('--network=bridge');
    // The ONLY host route: the validating proxy via the host-gateway alias.
    expect(argv).toContain('--add-host=host.docker.internal:host-gateway');
    expect(joined).toContain(`HTTP_PROXY=${PROXY}`);
    expect(joined).toContain(`BAYSTATE_CMS_WORKER_PROXY_URLS=${PROXY}`);
    // Pinned render image + bun worker entrypoint (reuses the rendered-page stack).
    expect(argv.slice(-3)).toEqual([RENDER_CONTAINER_IMAGE, 'bun', RENDER_WORKER_CONTAINER_ENTRYPOINT]);
  });
});

describe('validating forward proxy: broker policy per request', () => {
  function proxyWith(
    transport: BrokerTransport,
    sampleUrls = ['https://brand.example/products/alpha'],
  ) {
    const budget = resolveInvestigationBudget({});
    const ledger = new BudgetLedger(budget);
    return startRenderProxy({
      investigationId: 'binv_proxy_1',
      workspaceId: 'ws_proxy',
      sampleUrls,
      budget,
      ledger,
      brokerDeps: { lookup: lookupPublic, transport },
    }).then((proxy) => ({ proxy, ledger }));
  }

  async function getViaProxy(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
    const { default: http } = await import('node:http');
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: proxy.hostname, port: Number(proxy.port), path: target, timeout: 10_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    });
  }

  it('relays broker-approved GETs and charges the shared ledger', async () => {
    const { proxy, ledger } = await proxyWith(htmlTransport('<html>proxied</html>'));
    try {
      const res = await getViaProxy(proxy.url, 'https://brand.example/products/alpha');
      expect(res.status).toBe(200);
      expect(res.body).toBe('<html>proxied</html>');
      expect(ledger.snapshot().requestAttempts).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it('refuses CONNECT tunnels, non-GET methods, and non-absolute targets', async () => {
    const { default: http } = await import('node:http');
    const { proxy } = await proxyWith(htmlTransport('<html>x</html>'));
    try {
      const proxyUrl = new URL(proxy.url);
      const raw = (method: string, path: string): Promise<number | 'refused'> =>
        new Promise((resolve) => {
          const req = http.request(
            { host: proxyUrl.hostname, port: Number(proxyUrl.port), method, path, timeout: 10_000 },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode ?? 0));
            },
          );
          // A refused tunnel surfaces as a connection error on some
          // clients (no tunnel established either way — that is the point).
          req.on('error', () => resolve('refused'));
          req.on('timeout', () => req.destroy(new Error('timeout')));
          req.end();
        });
      const connectVerdict = await raw('CONNECT', 'https://brand.example/products/alpha');
      expect(connectVerdict === 405 || connectVerdict === 'refused').toBe(true);
      await expect(raw('POST', 'https://brand.example/products/alpha')).resolves.toBe(405);
      const originForm = await getViaProxy(proxy.url, '/products/alpha').then(
        (r) => r.status,
        () => 0,
      );
      expect(originForm).toBe(400);
    } finally {
      await proxy.close();
    }
  });

  it('denies off-scope hosts and forbidden paths with broker codes only', async () => {
    const { proxy } = await proxyWith(htmlTransport('<html>x</html>'));
    try {
      const evil = await getViaProxy(proxy.url, 'https://evil.example/phish');
      expect(evil.status).toBe(502);
      expect(evil.body).toMatch(/host_not_approved/);
      const cart = await getViaProxy(proxy.url, 'https://brand.example/cart/add');
      expect(cart.status).toBe(502);
      expect(cart.body).toMatch(/path_forbidden/);
    } finally {
      await proxy.close();
    }
  });
});

describe('Tier 1 model context: holdout blindness + redaction by construction', () => {
  const BUDGET = resolveInvestigationBudget({});
  const HOLDOUTS = [{ url: HOLDOUT_URL, artifactRef: HOLDOUT_ARTIFACT }];

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      investigationId: 'binv_ctx_1',
      domain: 'brand.example',
      observations: [
        { kind: 'page_title', sourceUrl: 'https://brand.example/products/alpha', artifactHash: ARTIFACT_HASH, detail: 'Acme Dog Food', incomplete: false },
      ],
      evidenceRefs: ['artifact:binv_ctx_1:p0'],
      analysisGaps: [],
      knownContextKeys: ['flavor'],
      excludedHoldouts: HOLDOUTS,
      budget: BUDGET,
      ...overrides,
    };
  }

  it('builds a bounded context with a stable exclusion commitment', () => {
    const ctx = buildTier1ModelContext(baseInput());
    expect(ctx.version).toBe(1);
    expect(ctx.inputBytes).toBeGreaterThan(0);
    expect(ctx.inputBytes).toBeLessThanOrEqual(BUDGET.maxModelInputBytesPerCall);
    expect(ctx.exclusionCommitment).toBe(exclusionCommitmentOf(HOLDOUTS));
    expect(ctx.exclusionCommitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects holdout URLs smuggled into any context surface', () => {
    const surfaces: Array<[string, Record<string, unknown>]> = [
      ['detail', { observations: [{ kind: 'page_title', sourceUrl: 'https://brand.example/products/alpha', artifactHash: ARTIFACT_HASH, detail: `see ${HOLDOUT_URL} for more`, incomplete: false }] }],
      ['sourceUrl', { observations: [{ kind: 'page_title', sourceUrl: HOLDOUT_URL, artifactHash: ARTIFACT_HASH, incomplete: false }] }],
      ['evidenceRef', { evidenceRefs: ['artifact:binv_ctx_1:p0', `see ${HOLDOUT_URL}`] }],
      ['gap', { analysisGaps: [`render ${HOLDOUT_URL} next`] }],
      ['slash variant', { analysisGaps: [`render ${HOLDOUT_URL}/ next`] }],
      ['knownContextKey', { knownContextKeys: [`flavor of ${HOLDOUT_URL}`] }],
    ];
    for (const [label, override] of surfaces) {
      expect(() => buildTier1ModelContext(baseInput(override)), label).toThrowError(/holdout_exposed/);
    }
  });

  it('rejects holdout artifacts smuggled into observation text', () => {
    expect(() =>
      buildTier1ModelContext(
        baseInput({
          observations: [{ kind: 'page_meta', sourceUrl: 'https://brand.example/products/alpha', artifactHash: ARTIFACT_HASH, detail: `bytes ${HOLDOUT_ARTIFACT}`, incomplete: false }],
        }),
      ),
    ).toThrowError(/holdout_exposed/);
  });

  it('carries knownContext key names only — values have no channel', () => {
    const ctx = buildTier1ModelContext(baseInput({ knownContextKeys: ['flavor', 'retailer'] }));
    const serialized = JSON.stringify(ctx);
    expect(serialized).toContain('flavor');
    // The canary value lives in workspace tables only; the builder never
    // even receives it (signature takes keys, not values).
    expect(serialized).not.toContain('canary-value-peanut-butter');
    expect(serialized).not.toContain('base64');
    expect(serialized).not.toMatch(/"body"/);
  });

  it('fails closed when the redacted input overruns the per-call cap', () => {
    const tiny = resolveInvestigationBudget({ maxModelInputBytesPerCall: 1024 });
    const bigDetail = 'x'.repeat(3000);
    expect(() =>
      buildTier1ModelContext(
        baseInput({
          budget: tiny,
          observations: [{ kind: 'page_title', sourceUrl: 'https://brand.example/products/alpha', artifactHash: ARTIFACT_HASH, detail: bigDetail, incomplete: false }],
        }),
      ),
    ).toThrowError(/budget_exhausted/);
  });
});

describe('one bounded model call: budgets enforced, output advisory', () => {
  const BUDGET = resolveInvestigationBudget({});

  function contextFor(overrides: Record<string, unknown> = {}): Tier1ModelContext {
    return buildTier1ModelContext({
      investigationId: 'binv_call_1',
      domain: 'brand.example',
      observations: [{ kind: 'page_title', sourceUrl: 'https://brand.example/products/alpha', artifactHash: ARTIFACT_HASH, incomplete: false }],
      evidenceRefs: [],
      analysisGaps: [],
      knownContextKeys: [],
      excludedHoldouts: [],
      budget: BUDGET,
      ...overrides,
    });
  }

  it('charges input + output to the ledger and reports the acting model', async () => {
    const ledger = new BudgetLedger(BUDGET);
    const seen: Tier1ModelContext[] = [];
    const out = await reasonWithBudget(stubReasoner({}, seen), contextFor(), ledger, BUDGET, { timeoutMs: 5_000 });
    expect(out.strategy).toBe('stub-advisory-strategy');
    expect(out.gaps).toEqual(['stub model gap']);
    expect(out.model).toEqual({ provider: 'stub', model: 'stub-reasoner-v1' });
    expect(seen).toHaveLength(1);
    const snap = ledger.snapshot();
    expect(snap.modelInputBytesTotal).toBeGreaterThan(0);
    expect(snap.modelOutputTokensTotal).toBe(12);
  });

  it('fails closed on token overrun, timeout, and faceless output', async () => {
    const ledger = new BudgetLedger(BUDGET);
    await expect(
      reasonWithBudget(stubReasoner({ outputTokens: BUDGET.maxModelOutputTokensPerCall + 1 }), contextFor(), ledger, BUDGET, { timeoutMs: 5_000 }),
    ).rejects.toThrowError(/budget_exhausted/);

    const hanging: Tier1ModelReasoner = { reason: () => new Promise(() => {}) };
    await expect(
      reasonWithBudget(hanging, contextFor(), new BudgetLedger(BUDGET), BUDGET, { timeoutMs: 20 }),
    ).rejects.toThrowError(/timeout/);

    const faceless: Tier1ModelReasoner = {
      reason: async () => ({ gaps: [], outputTokens: 1 }) as unknown as Awaited<ReturnType<Tier1ModelReasoner['reason']>>,
    };
    await expect(
      reasonWithBudget(faceless, contextFor(), new BudgetLedger(BUDGET), BUDGET, { timeoutMs: 5_000 }),
    ).rejects.toThrowError(/provider_error/);
  });

  it('denies image attachments without image-sharing permission (ledger gate)', () => {
    const ledger = new BudgetLedger(BUDGET);
    expect(ledger.effectiveImageCap()).toBe(0);
    expect(() => ledger.chargeImageAttachment(100, 100)).toThrowError(InvestigationBudgetError);
  });
});

describe('harness Tier 1: Shopify identity compiles, usage truthful', () => {
  function shopifyTransport(): BrokerTransport {
    return htmlTransport((url) =>
      url.endsWith('.js')
        ? { status: 200, body: SHOPIFY_JS, contentType: 'application/json' }
        : { status: 200, body: SHOPIFY_JS, contentType: 'application/json' },
    );
  }

  it('returns non-empty identity that compiles, with Tier 0 usage when no model is configured', async () => {
    // #246 opt-in: Shopify JSON carries no DOM signals, so the default path
    // would defer; this Tier 0 identity test exercises the #237 gap path.
    const { provider } = harness({ allowTier1Render: true }, shopifyTransport());
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha.js']));
    const result = completion.result as unknown as {
      identityRequirements?: { productIdentity: string[]; variantIdentity: string[]; optionAxes: string[] };
      gaps: string[];
    };
    expect(result.identityRequirements?.productIdentity.length).toBeGreaterThan(0);
    expect(result.identityRequirements?.variantIdentity.length).toBeGreaterThan(0);
    const compiled = compileInvestigationResult(
      completion.result as unknown as Parameters<typeof compileInvestigationResult>[0],
      {
        domain: 'brand.example',
        investigationId: 'binv_tier1_1',
        runId: 'binvrun_tier1a',
        inputHash: 'abcdef1234567890abcdef1234567890',
        resultHash: 'result-hash-tier1-1',
      },
    );
    // Shopify endpoint identity compiles through the unchanged gate.
    expect(compiled.status).toBe('proposal');
    // Truthful Tier 0 usage: zero calls actually made, app-authored plan acted.
    expect(completion.usage!.modelCalls).toBe(0);
    expect(completion.actualModel).toEqual({ provider: 'local_browser_harness', model: 'app-authored-read-plan-v1' });
    expect(result.gaps.join('\n')).toMatch(/Tier 1 model reasoning not requested/);
  });

  it('reports one counted call and the acting model after bounded reasoning', async () => {
    const seen: Tier1ModelContext[] = [];
    const { provider } = harness(
      // #246 opt-in (Shopify JSON has no DOM; default would defer).
      { allowTier1Render: true, modelReasoner: stubReasoner({}, seen) },
      shopifyTransport(),
    );
    const req = requestFor(['https://brand.example/products/alpha.js'], {
      modelPolicy: { allowCloudTextAnalysis: true, allowImageSharing: true },
      knownContext: { flavor: 'canary-value-peanut-butter' },
    });
    const completion = await provider.invoke(req);
    expect(completion.usage!.modelCalls).toBe(1);
    expect(completion.actualModel).toEqual({ provider: 'stub', model: 'stub-reasoner-v1' });
    expect(completion.usage!.modelInputBytesTotal).toBeGreaterThan(0);
    // Tier 1 reasoning is text-only by construction: no image channel
    // exists, so even a permitted image budget stays untouched.
    expect(completion.usage!.imageAttachmentsTotal).toBe(0);
    const result = completion.result as unknown as {
      recommendedStrategy?: string;
      gaps: string[];
      identityRequirements?: { productIdentity: string[]; variantIdentity: string[] };
    };
    expect(result.recommendedStrategy).toBe('stub-advisory-strategy');
    expect(result.gaps).toContain('stub model gap');
    // Identity still Tier 0 deterministic and still compiles.
    expect(result.identityRequirements?.productIdentity.length).toBeGreaterThan(0);
    expect(
      compileInvestigationResult(completion.result as unknown as Parameters<typeof compileInvestigationResult>[0], {
        domain: 'brand.example',
        investigationId: 'binv_tier1_1',
        runId: 'binvrun_tier1a',
        inputHash: 'abcdef1234567890abcdef1234567890',
        resultHash: 'result-hash-tier1-2',
      }).status,
    ).toBe('proposal');
    // knownContext values never reached the model: keys only.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.knownContextKeys).toEqual(['flavor']);
    expect(JSON.stringify(seen[0])).not.toContain('canary-value-peanut-butter');
  });

  it('still compiles when the reasoner returns junk (advisory-only output)', async () => {
    const { provider } = harness(
      // #246 opt-in (Shopify JSON has no DOM; default would defer).
      { allowTier1Render: true, modelReasoner: stubReasoner({ strategy: 'x'.repeat(5000), gaps: Array.from({ length: 25 }, (_, i) => `junk-${i}`) }) },
      shopifyTransport(),
    );
    const completion = await provider.invoke(
      requestFor(['https://brand.example/products/alpha.js'], { modelPolicy: { allowCloudTextAnalysis: true } }),
    );
    const result = completion.result as unknown as {
      recommendedStrategy?: string;
      gaps: string[];
      identityRequirements?: { productIdentity: string[]; variantIdentity: string[] };
    };
    // Junk is bounded (strategy truncated, gaps capped) and identity untouched.
    expect(result.recommendedStrategy!.length).toBeLessThanOrEqual(2000);
    expect(result.gaps.filter((g) => g.startsWith('junk-')).length).toBeLessThanOrEqual(10);
    expect(result.identityRequirements?.productIdentity).toContain('sku_exact');
    expect(
      compileInvestigationResult(completion.result as unknown as Parameters<typeof compileInvestigationResult>[0], {
        domain: 'brand.example',
        investigationId: 'binv_tier1_1',
        runId: 'binvrun_tier1a',
        inputHash: 'abcdef1234567890abcdef1234567890',
        resultHash: 'result-hash-tier1-3',
      }).status,
    ).toBe('proposal');
    expect(completion.usage!.modelCalls).toBe(1);
  });

  it('records a gap (not a call) when the operator opts in but no model is configured', async () => {
    // #246 opt-in: preserves the #237 no-model gap path for Shopify JSON.
    const { provider } = harness({ allowTier1Render: true }, shopifyTransport());
    const completion = await provider.invoke(
      requestFor(['https://brand.example/products/alpha.js'], { modelPolicy: { allowCloudTextAnalysis: true } }),
    );
    const result = completion.result as unknown as { gaps: string[] };
    expect(result.gaps.join('\n')).toMatch(/no model configured/);
    expect(completion.usage!.modelCalls).toBe(0);
    expect(completion.actualModel).toEqual({ provider: 'local_browser_harness', model: 'app-authored-read-plan-v1' });
  });

  it('fails closed with holdout_exposed when Tier 0 evidence carries holdout material', async () => {
    const tornDown: string[] = [];
    const contaminated: Tier0ContainerRunner = {
      start: async (spec) => void assertContainerPosture(spec),
      runAnalysis: async (_spec, _request) => ({
        observations: [
          {
            kind: 'page_title',
            sourceUrl: 'https://brand.example/products/alpha',
            artifactHash: ARTIFACT_HASH,
            detail: `see also ${HOLDOUT_URL}`,
            incomplete: false,
            artifactRef: 'artifact:binv_tier1_1:p0',
          },
        ],
        gaps: [],
        platformSignals: [],
        domSignals: { title: true, meta: false, jsonLd: false, images: false },
        readsPerformed: 2,
        identity: { productIdentity: [], variantIdentity: [], optionAxes: [], fields: [], conflicts: [], contributingArtifacts: [] },
      }),
      teardown: async (runId: string) => void tornDown.push(runId),
    };
    const { provider } = harness(
      {
        containerRunner: contaminated,
        modelReasoner: stubReasoner(),
        excludedHoldouts: [{ url: HOLDOUT_URL, artifactRef: null }],
      },
      shopifyTransport(),
    );
    await expect(
      provider.invoke(
        requestFor(['https://brand.example/products/alpha.js'], { modelPolicy: { allowCloudTextAnalysis: true } }),
      ),
    ).rejects.toThrowError(/holdout_exposed/);
  });

  it('fails closed when the engaged model call exhausts tokens or time', async () => {
    const tokenHog = harness(
      {
        // #246 opt-in (Shopify JSON has no DOM; default would defer).
        allowTier1Render: true,
        modelReasoner: stubReasoner({
          outputTokens: resolveInvestigationBudget({}).maxModelOutputTokensPerCall + 1,
        }),
      },
      shopifyTransport(),
    );
    await expect(
      tokenHog.provider.invoke(
        requestFor(['https://brand.example/products/alpha.js'], { modelPolicy: { allowCloudTextAnalysis: true } }),
      ),
    ).rejects.toThrowError(/budget_exhausted/);

    const hanging: Tier1ModelReasoner = { reason: () => new Promise(() => {}) };
    // #246 opt-in for the same Shopify-JSON reason as above.
    const slow = harness({ allowTier1Render: true, modelReasoner: hanging }, shopifyTransport());
    await expect(
      slow.provider.invoke(
        requestFor(['https://brand.example/products/alpha.js'], {
          modelPolicy: { allowCloudTextAnalysis: true },
          budget: { timeoutMs: 1000 },
        }),
      ),
    ).rejects.toThrowError(/timeout/);
  });
});

describe('harness Tier 1 render: need-gated, merged, fail-closed', () => {
  it('merges rendered observations and clears the rendering need', async () => {
    const renderTornDown: string[] = [];
    const { provider } = harness(
      {
        // #246: explicit non-default opt-in — render machinery is
        // diagnostics/tests only, not production-valid until #237 lands.
        allowTier1Render: true,
        renderRunner: stubRenderRunner({
          observations: [renderedObs('https://brand.example/products/alpha', 'artifact:binv_tier1_1:p0')],
          gaps: ['render note'],
          reads: 3,
        }, renderTornDown),
      },
      htmlTransport(BARE_HTML),
    );
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha']));
    const result = completion.result as unknown as {
      observations: Array<{ kind: string; artifactHash: string }>;
      evidenceRefs: string[];
      gaps: string[];
      renderedBrowserRequired: boolean;
    };
    expect(result.observations.map((o) => o.kind)).toContain('page_rendered');
    for (const obs of result.observations) {
      expect(obs.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.renderedBrowserRequired).toBe(false);
    // Each evidence ref denotes exactly one retained artifact: the broker
    // capture ref plus the rendered record's own minted ref (no orphans,
    // no hash/ref divergence).
    expect(result.evidenceRefs).toContain('artifact:binv_tier1_1:p0');
    expect(result.evidenceRefs).toContain('artifact:binv_tier1_1:render-p0');
    expect(result.gaps).toContain('render note');
    expect(completion.usage!.readsPerformed).toBeGreaterThan(0);
    // Deterministic teardown ran for the render container too.
    expect(renderTornDown).toEqual(['binvrun_tier1a-tier1']);
  });

  it('records a gap (Tier 0 verdict stands) when the render container is unavailable', async () => {
    const { provider } = harness(
      {
        // #246 opt-in: exercises the #237 unavailable-container gap behind
        // the explicit switch (default path defers instead — see below).
        allowTier1Render: true,
        renderRunner: stubRenderRunner({
          startError: new RenderRunnerError('isolation_unavailable', 'isolation_unavailable: no image'),
        }),
      },
      htmlTransport(BARE_HTML),
    );
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha']));
    const result = completion.result as unknown as { renderedBrowserRequired: boolean; gaps: string[] };
    expect(result.renderedBrowserRequired).toBe(true);
    expect(result.gaps.join('\n')).toMatch(/rendered investigation unavailable/);
  });

  it('fails the run closed when the engaged render exhausts budget', async () => {
    const { provider } = harness(
      {
        // #246 opt-in: engaged-render failure stays fail-closed behind the switch.
        allowTier1Render: true,
        renderRunner: stubRenderRunner({
          runError: new RenderRunnerError('budget_exhausted', 'budget_exhausted: render reads overran'),
        }),
      },
      htmlTransport(BARE_HTML),
    );
    await expect(provider.invoke(requestFor(['https://brand.example/products/alpha']))).rejects.toThrowError(
      /budget_exhausted/,
    );
  });

  it('skips render entirely when Tier 0 found DOM evidence', async () => {
    let renderCalls = 0;
    const counting: Tier1RenderRunner = {
      start: async () => { renderCalls += 1; },
      runRender: async () => { renderCalls += 1; return { observations: [], gaps: [], readsPerformed: 0 }; },
      teardown: async () => {},
    };
    const { provider } = harness({ renderRunner: counting }, htmlTransport(DOM_HTML));
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha.js']));
    expect(renderCalls).toBe(0);
    const result = completion.result as unknown as { renderedBrowserRequired: boolean };
    expect(result.renderedBrowserRequired).toBe(false);
  });
});

describe('#246 Tier 1 rendered deferral: default path refuses honestly', () => {
  it('refuses rendered-required work with render_deferred and performs no render attempt', async () => {
    let renderCalls = 0;
    const counting: Tier1RenderRunner = {
      start: async () => { renderCalls += 1; },
      runRender: async () => {
        renderCalls += 1;
        return { observations: [], gaps: [], readsPerformed: 0 };
      },
      teardown: async () => { renderCalls += 1; },
    };
    // Default path: no allowTier1Render switch, even with a render runner
    // injected — the harness must refuse before touching the machinery.
    const { provider } = harness({ renderRunner: counting }, htmlTransport(BARE_HTML));
    await expect(
      provider.invoke(requestFor(['https://brand.example/products/alpha'])),
    ).rejects.toThrowError(/render_deferred/);
    // No render attempt occurred: no start/run/teardown calls, hence no
    // rendered observations and no rendered-coverage claims to assert.
    expect(renderCalls).toBe(0);
  });

  it('still completes static-sufficient work without the switch (only render-need defers)', async () => {
    // DOM evidence means no rendering need: Tier 0 completes on the default
    // path with no deferred code and no render attempt.
    const { provider } = harness({}, htmlTransport(DOM_HTML));
    const completion = await provider.invoke(requestFor(['https://brand.example/products/alpha.js']));
    const result = completion.result as unknown as {
      renderedBrowserRequired: boolean;
      observations: Array<{ kind: string }>;
    };
    expect(result.renderedBrowserRequired).toBe(false);
    expect(result.observations.map((o) => o.kind)).not.toContain('page_rendered');
  });
});

describe('containment: Tier 1 network surface stays authorized', () => {
  const REPO = process.cwd();

  it('the in-container render worker loads with its protocol version', async () => {
    // Host code never imports this module (pinned above); this dynamic
    // import proves the container entrypoint loads error-free. The import
    // pulls the whole rendered-page stack, so give it a realistic budget
    // under a fully parallel suite instead of the 5s default.
    const worker = await import('../../onboarding/browser-investigation/render-worker');
    expect(worker.RENDER_WORKER_PROTOCOL_VERSION).toBe(1);
  }, 60_000);

  it('host modules other than broker/proxy have no network surface', () => {
    const modules = [
      'src/onboarding/browser-investigation/model-context.ts',
      'src/onboarding/browser-investigation/render-runner.ts',
    ];
    const patterns = [
      /http\.request\s*\(/, /https\.request\s*\(/, /https\.get\s*\(/, /http\.get\s*\(/,
      /http\.createServer\s*\(/, /new\s+WebSocket\s*\(/, /playwright|puppeteer|camoufox/i,
    ];
    for (const rel of modules) {
      const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const pattern of patterns) {
        expect(source, `${rel} :: ${pattern}`).not.toMatch(pattern);
      }
      for (const match of source.matchAll(/(\b[a-zA-Z_][\w]*)?\.fetch\s*\(|(?<![\w.])fetch\s*\(/g)) {
        expect(match[0], `${rel} :: non-broker fetch`).toBe('broker.fetch(');
      }
    }
  });

  it('the proxy delegates every upstream fetch to the broker', () => {
    const source = readFileSync(
      new URL('../../onboarding/browser-investigation/render-proxy.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/broker\.fetch\(/);
    expect(source).not.toMatch(/http\.request\s*\(/);
    expect(source).not.toMatch(/http\.get\s*\(/);
    // Every `.fetch(` call site is the broker-mediated one.
    for (const match of source.matchAll(/(\b[a-zA-Z_][\w]*)?\.fetch\s*\(|(?<![\w.])fetch\s*\(/g)) {
      expect(match[0]).toBe('broker.fetch(');
    }
  });

  it('host code never imports the in-container render worker', () => {
    const hostModules = [
      '../../onboarding/browser-investigation/local-harness.ts',
      '../../onboarding/browser-investigation/render-runner.ts',
      '../../onboarding/browser-investigation/container-runner.ts',
      '../../onboarding/browser-investigation/service.ts',
    ];
    for (const rel of hostModules) {
      const source = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(source, rel).not.toMatch(/render-worker/);
    }
  });
});

describe('Tier 1 container-level egress denial (live, daemon-gated)', () => {
  const DOCKER_TIMEOUT = 120_000;

  async function dockerAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 15_000 });
      await execFileAsync('docker', ['run', '--rm', 'node:22-bookworm', 'node', '-e', 'void 0'], { timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureRenderNetwork(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['network', 'inspect', RENDER_CONTAINER_NETWORK], { timeout: 15_000 });
      return true;
    } catch {
      try {
        await execFileAsync(
          'docker',
          ['network', 'create', '--internal', '--label', 'binv=tier1-test', RENDER_CONTAINER_NETWORK],
          { timeout: 30_000 },
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Egress-relevant flags of the REAL render argv (everything before the
   * image token). The image token alone is swapped for the local probe
   * image — the network/egress posture under test is byte-identical.
   */
  function probeFlags(proxyUrl: string | null): string[] {
    const spec = buildRenderContainerSpec('binvrun_live_deny', proxyUrl ?? 'http://host.docker.internal:3128');
    const argv = renderContainerDockerArgs(spec);
    const imageIndex = argv.indexOf(spec.image);
    expect(imageIndex).toBeGreaterThan(0);
    const flags = argv.slice(0, imageIndex);
    expect(flags.join(' ')).toContain(`--network=${RENDER_CONTAINER_NETWORK}`);
    expect(flags).toContain('--add-host=host.docker.internal:host-gateway');
    // '-i' attaches the render task on stdin; probes use -e (no stdin),
    // so it is asserted here and dropped for execution only.
    expect(flags).toContain('-i');
    return flags.filter((f) => f !== '-i');
  }

  async function runProbe(flags: string[], extraEnv: string[], probe: string): Promise<unknown> {
    const { stdout } = await execFileAsync(
      'docker',
      [...flags, ...extraEnv, 'node:22-bookworm', 'node', '-e', probe],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim());
  }

  const DIRECT_PROBE = `
    const http = require('node:http');
    const direct = () => new Promise((resolve) => {
      const req = http.get('http://brand.example/', (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
      req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    });
    (async () => { console.log(JSON.stringify({ direct: await direct() })); })();
  `;

  it('denies direct egress at container level on the isolated render network', async () => {
    if (!(await dockerAvailable())) {
      console.warn('SKIP: no Docker daemon — container-level egress denial skipped');
      return;
    }
    if (!(await ensureRenderNetwork())) {
      console.warn('SKIP: render network unavailable — container-level egress denial skipped');
      return;
    }
    // flags[0] is the 'run' subcommand; the probe carries no proxy env —
    // pure denial: nothing on the internal network has an external route.
    const out = (await runProbe(probeFlags(null), [], DIRECT_PROBE)) as {
      direct: { status?: number; error?: string };
    };
    expect(out.direct.error).toMatch(/timeout|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/i);
    expect(out.direct.status).toBeUndefined();
  }, DOCKER_TIMEOUT);

  it('relays validated pages through the proxy channel when the platform routes container-to-host', async () => {
    if (!(await dockerAvailable())) {
      console.warn('SKIP: no Docker daemon — proxy-channel relay skipped');
      return;
    }
    if (!(await ensureRenderNetwork())) {
      console.warn('SKIP: render network unavailable — proxy-channel relay skipped');
      return;
    }
    const budget = resolveInvestigationBudget({});
    const ledger = new BudgetLedger(budget);
    const proxy = await startRenderProxy({
      investigationId: 'binv_live_deny',
      workspaceId: 'ws_live',
      sampleUrls: ['https://brand.example/products/alpha'],
      budget,
      ledger,
      brokerDeps: {
        lookup: lookupPublic,
        transport: async (req) => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: Buffer.from('<html>proxied</html>', 'utf8'),
          connectedIp: req.validatedAddresses[0] ?? null,
        }),
      },
      bindHost: '0.0.0.0',
      advertiseHost: 'host.docker.internal',
    });
    try {
      const channelProbe = `
        const http = require('node:http');
        const proxyUrl = new URL(process.env.PROXY_URL);
        const direct = () => new Promise((resolve) => {
          const req = http.get('http://brand.example/', (res) => {
            res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
          });
          req.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
          req.setTimeout(12000, () => req.destroy(new Error('timeout')));
        });
        const viaProxy = () => new Promise((resolve) => {
          const req = http.get(
            { host: proxyUrl.hostname, port: Number(proxyUrl.port), path: 'https://brand.example/products/alpha' },
            (res) => {
              let b = ''; res.on('data', (c) => { b += c; });
              res.on('end', () => resolve({ status: res.statusCode, body: b }));
            },
          );
          req.on('error', (e) => resolve({ error: String((e && e.message) || e) }));
          req.setTimeout(12000, () => req.destroy(new Error('timeout')));
        });
        (async () => {
          const out = { direct: await direct(), proxied: await viaProxy() };
          console.log(JSON.stringify(out));
        })();
      `;
      const out = (await runProbe(probeFlags(proxy.url), ['--env=PROXY_URL=' + proxy.url], channelProbe)) as {
        direct: { status?: number; error?: string };
        proxied: { status?: number; body?: string; error?: string };
      };
      // Denial half must hold wherever the channel half is judged.
      expect(out.direct.status).toBeUndefined();
      if (out.proxied.error && /ENETUNREACH|EHOSTUNREACH/.test(out.proxied.error)) {
        // Docker Desktop macOS cannot route internal-network containers to
        // the host gateway, so the host-side proxy is unreachable from the
        // container there. Denial (above) is proven; the relay leg is
        // proven host-side plus on Linux, where the route exists.
        console.warn(`SKIP: platform cannot route internal-network containers to the host gateway (${out.proxied.error}) — proxy-channel relay skipped`);
        return;
      }
      expect(out.proxied.error).toBeUndefined();
      expect(out.proxied.status).toBe(200);
      expect(out.proxied.body).toBe('<html>proxied</html>');
    } finally {
      await proxy.close();
    }
  }, DOCKER_TIMEOUT);
});
