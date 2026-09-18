// Tier 0 (#233) — deterministic identity extraction (Vitest).
//
// Pins the #233 acceptance criteria against the containerized Tier 0 seam:
// - Recorded Shopify payload in → populated identity requirements out
//   (GTIN/SKU/MPN, platform variant IDs, option axes as present).
// - Identity-carrying static results compile through the existing compiler
//   gate; identity-absent results still refuse with a typed gap.
// - Every extracted identifier carries an artifact evidence reference.
// - Conflicting identifiers defer to ambiguity downstream, never resolve silently.
// - No new network calls, no model calls, no relaxation of the identity gate.
//
// Identity is derived in-container by tier0-analyzer.mjs over the same
// broker-approved captures as the read plan (page bytes are never parsed
// host-side). Pure section drives the analyzer directly; harness section
// runs the full provider through the labeled in-process double.
//
// No DB, no network, no Docker daemon — the in-process double executes the
// same analyzer code production runs in-container.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  INVESTIGATION_RESULT_VERSION,
  resolveInvestigationBudget,
  type InvestigationBudget,
  type InvestigationResult,
} from '../../shared/schemas/browser-investigation';
import type {
  Tier0AnalysisRequest,
  Tier0ContainerRunner,
} from '../../onboarding/browser-investigation/container-runner';
import { compileInvestigationResult } from '../../onboarding/browser-investigation/compiler';
import type { InvestigationProviderRequest } from '../../onboarding/browser-investigation/provider';
import {
  LocalBrowserHarnessProvider,
  type LocalHarnessDeps,
} from '../../onboarding/browser-investigation/local-harness';
import { releaseInvestigationSlot } from '../../onboarding/browser-investigation/isolation';
import type { BrokerTransport } from '../../onboarding/browser-investigation/broker';
import { analyzeTier0Captures } from '../../onboarding/browser-investigation/tier0-analyzer.mjs';

const ENV_KEY = 'BAYSTATE_INVESTIGATION_ISOLATION';
let savedEnv: string | undefined;

const SHOPIFY_JS = JSON.stringify({
  id: 12345678,
  title: 'Acme All-Natural Dog Food',
  vendor: 'Acme',
  handle: 'acme-dog-food',
  variants: [
    {
      id: 111,
      title: 'Small',
      sku: 'ACME-SM',
      barcode: '012345678905',
      available: true,
      price: '5499',
      option1: 'Small',
      option2: null,
      option3: null,
    },
    {
      id: 222,
      title: 'Large',
      sku: 'ACME-LG',
      barcode: '012345678912',
      available: false,
      price: '6499',
      option1: 'Large',
      option2: null,
      option3: null,
    },
  ],
  images: [],
  options: [{ name: 'Size', values: ['Small', 'Large'] }],
});

const JSON_LD_SINGLE_HTML = `<!doctype html><html><head>
<title>Acme Dog Food</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Dog Food","sku":"ACME-SM","mpn":"ACME-MPN-1","brand":{"@type":"Brand","name":"Acme"}}</script>
</head><body><h1>Acme Dog Food</h1></body></html>`;

const SHOPIFY_EMBEDDED_HTML = `<!doctype html><html><head><title>Embedded</title></head><body>
<script id="ProductJson-999">{"id":999,"title":"Embedded Product","variants":[{"id":555,"title":"Default","sku":"EMB-1","available":true}]}</script>
</body></html>`;

const BARE_HTML = '<html><head></head><body><div id="app"></div></body></html>';

const ANALYSIS_BUDGET = {
  maxSelectorLength: 512,
  maxSelectorMatches: 100,
  maxObservationBytesPerOperation: 32 * 1024,
  maxJsonNodesVisited: 10_000,
  maxJsonPointerDepth: 32,
  maxResponseBytesPerResponse: 5 * 1024 * 1024,
  maxReads: 20,
};

const ARTIFACT_HASH = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function analyze(
  captures: Array<{ body: string; artifactRef: string; contentType?: string; pageUrl?: string }>,
  investigationId = 'binv_t0_1',
): ReturnType<typeof analyzeTier0Captures> {
  const request: Tier0AnalysisRequest = {
    investigationId,
    budget: { ...ANALYSIS_BUDGET },
    captures: captures.map((capture, pageIndex) => ({
      pageIndex,
      bodyBase64: Buffer.from(capture.body, 'utf8').toString('base64'),
      contentType: capture.contentType ?? 'text/html; charset=utf-8',
      pageUrl: capture.pageUrl ?? 'https://brand.example/products/alpha',
      artifactHash: ARTIFACT_HASH,
      artifactRef: capture.artifactRef,
      responseRef: `response:${investigationId}:p${pageIndex}`,
    })),
  };
  return analyzeTier0Captures(request);
}

function shopifyJsonCapture(body: string, artifactRef: string): { body: string; artifactRef: string; contentType: string; pageUrl: string } {
  return { body, artifactRef, contentType: 'application/json', pageUrl: 'https://brand.example/products/alpha.js' };
}

describe('Tier 0 static identity extractors (#233)', () => {
  it('populates identity requirements from a recorded Shopify endpoint payload', () => {
    const result = analyze([shopifyJsonCapture(SHOPIFY_JS, 'artifact:binv_t0_1:p0')]);
    const { identity } = result;

    expect(identity.productIdentity).toEqual(['gtin_exact', 'sku_exact', 'platform_product_id']);
    expect(identity.variantIdentity).toEqual([
      'gtin_exact',
      'sku_exact',
      'platform_variant_id_exact',
      'options_exact_tuple',
      'operator_selection',
    ]);
    expect(identity.optionAxes).toEqual(['size']);
    expect(identity.conflicts).toEqual([]);
    // Shopify endpoint evidence marks the platform for the host gate.
    expect(result.platformSignals).toContain('shopify');

    // Every extracted identifier carries an artifact evidence reference.
    expect(identity.contributingArtifacts).toEqual(['artifact:binv_t0_1:p0']);
    const byField = new Map(identity.fields.map((f) => [f.field, f]));
    expect(byField.get('sku')?.sources).toContain('shopify_product_json');
    expect(byField.get('gtin')?.sources).toContain('shopify_product_json');
    expect(byField.get('variants')?.sources).toContain('shopify_product_json');
    for (const field of identity.fields) {
      expect(field.evidenceRef).toBe('artifact:binv_t0_1:p0');
      expect(identity.contributingArtifacts).toContain(field.evidenceRef);
    }
  });

  it('extracts MPN identity from single-product structured data', () => {
    const result = analyze([{ body: JSON_LD_SINGLE_HTML, artifactRef: 'artifact:binv_t0_2:p0' }], 'binv_t0_2');
    const { identity } = result;

    expect(identity.productIdentity).toEqual(['sku_exact', 'mpn_exact']);
    expect(identity.variantIdentity).toEqual(['sku_exact', 'mpn_exact', 'operator_selection']);
    expect(identity.optionAxes).toEqual([]);
    // MPN has no policy field slot; its provenance rides the contributing
    // artifacts every requirement is backed by.
    expect(identity.contributingArtifacts).toEqual(['artifact:binv_t0_2:p0']);
    expect(identity.fields.map((f) => f.field)).toContain('sku');
    for (const field of identity.fields) {
      expect(field.sources).toContain('json_ld');
      expect(field.evidenceRef).toBe('artifact:binv_t0_2:p0');
    }
  });

  it('extracts identity from Shopify state embedded in page HTML', () => {
    const result = analyze([{ body: SHOPIFY_EMBEDDED_HTML, artifactRef: 'artifact:binv_t0_3:p0' }], 'binv_t0_3');
    const { identity } = result;

    expect(identity.productIdentity).toContain('sku_exact');
    expect(identity.productIdentity).toContain('platform_product_id');
    expect(identity.variantIdentity).toContain('sku_exact');
    expect(identity.variantIdentity).toContain('platform_variant_id_exact');
    expect(result.platformSignals).toContain('shopify');
    expect(identity.fields.map((f) => f.field)).toContain('variants');
  });

  it('extracts variant identity from ProductGroup hasVariant (group sku never leaks as product identity)', () => {
    const groupHtml = `<!doctype html><html><head><title>Runner</title>
<script type="application/ld+json">{"@context":"https://schema.org/","@type":"ProductGroup","productGroupID":"RUNNERS","name":"Runner","brand":{"@type":"Brand","name":"Acme"},"sku":"RUNNERS-GROUP","hasVariant":[{"@type":"Product","sku":"RUN-050","size":"5"},{"@type":"Product","sku":"RUN-060","size":"6"}]}</script>
</head><body><h1>Runner</h1></body></html>`;
    const result = analyze([{ body: groupHtml, artifactRef: 'artifact:binv_t0_3g:p0' }], 'binv_t0_3g');
    const { identity } = result;
    expect(identity.productIdentity).toContain('sku_exact');
    expect(identity.variantIdentity).toContain('sku_exact');
    expect(identity.variantIdentity).toContain('platform_variant_id_exact');
    expect(identity.contributingArtifacts).toEqual(['artifact:binv_t0_3g:p0']);
    for (const field of identity.fields) {
      expect(field.evidenceRef).toBe('artifact:binv_t0_3g:p0');
    }
  });

  it('defers conflicting identifiers to downstream ambiguity instead of resolving', () => {
    const variant = (id: number, sku: string): string =>
      JSON.stringify({
        id: 9999,
        title: 'Conflicted',
        variants: [{ id, title: 'One', sku, available: true, price: '100', option1: null, option2: null, option3: null }],
        images: [],
        options: [],
      });
    const result = analyze(
      [
        shopifyJsonCapture(variant(111, 'AAA'), 'artifact:binv_t0_4:p0'),
        shopifyJsonCapture(variant(111, 'BBB'), 'artifact:binv_t0_4:p1'),
      ],
      'binv_t0_4',
    );
    const { identity } = result;

    // Signals are kept (not resolved away) and the conflict is reported.
    expect(identity.productIdentity).toContain('sku_exact');
    expect(identity.variantIdentity).toContain('sku_exact');
    expect(identity.variantIdentity).toContain('platform_variant_id_exact');
    expect(identity.conflicts).toHaveLength(1);
    expect(identity.conflicts[0]).toMatch(/ambiguous/);
    expect(identity.contributingArtifacts).toEqual(['artifact:binv_t0_4:p0', 'artifact:binv_t0_4:p1']);
  });

  it('returns empty requirements when captured evidence carries no identity', () => {
    const result = analyze(
      [
        { body: BARE_HTML, artifactRef: 'artifact:binv_t0_5:p0' },
        shopifyJsonCapture(JSON.stringify({ foo: 'bar' }), 'artifact:binv_t0_5:p1'),
      ],
      'binv_t0_5',
    );
    expect(result.identity.productIdentity).toEqual([]);
    expect(result.identity.variantIdentity).toEqual([]);
    expect(result.identity.optionAxes).toEqual([]);
    expect(result.identity.fields).toEqual([]);
    expect(result.identity.conflicts).toEqual([]);
    expect(result.identity.contributingArtifacts).toEqual([]);
    expect(analyze([], 'binv_t0_5').identity).toMatchObject({
      productIdentity: [],
      variantIdentity: [],
      optionAxes: [],
      fields: [],
      conflicts: [],
    });
  });

  it('skips foreign refs and oversized bodies without failing the run', () => {
    // A capture bound to another investigation contributes no signals.
    const foreign = analyze(
      [{ body: SHOPIFY_EMBEDDED_HTML, artifactRef: 'artifact:other_investigation:p0' }],
      'binv_t0_6',
    );
    expect(foreign.identity.productIdentity).toEqual([]);
    // An oversized body is skipped for identity (broker caps already bind it).
    const tiny = analyze(
      [
        {
          body: SHOPIFY_JS,
          artifactRef: 'artifact:binv_t0_6:p0',
          contentType: 'application/json',
          pageUrl: 'https://brand.example/products/alpha.js',
        },
      ],
      'binv_t0_6',
    );
    expect(tiny.identity.productIdentity).toContain('gtin_exact');
    const request: Tier0AnalysisRequest = {
      investigationId: 'binv_t0_6',
      budget: { ...ANALYSIS_BUDGET, maxResponseBytesPerResponse: 10 },
      captures: [
        {
          pageIndex: 0,
          bodyBase64: Buffer.from(SHOPIFY_JS, 'utf8').toString('base64'),
          contentType: 'application/json',
          pageUrl: 'https://brand.example/products/alpha.js',
          artifactHash: ARTIFACT_HASH,
          artifactRef: 'artifact:binv_t0_6:p0',
          responseRef: 'response:binv_t0_6:p0',
        },
      ],
    };
    expect(analyzeTier0Captures(request).identity.productIdentity).toEqual([]);
  });

  it('is deterministic (no network, no model, no clock)', () => {
    const captures = [shopifyJsonCapture(SHOPIFY_JS, 'artifact:binv_t0_7:p0')];
    expect(analyze(captures, 'binv_t0_7').identity).toEqual(analyze(captures, 'binv_t0_7').identity);
  });
});

// ─── Harness + compiler seam ───────────────────────────────────────────────

const PUBLIC_IP = '93.184.216.34';

function lookupPublic(host: string): Promise<string[]> {
  void host;
  return Promise.resolve([PUBLIC_IP]);
}

function jsonTransport(calls: string[]): BrokerTransport {
  return async (req) => {
    calls.push(req.url);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(SHOPIFY_JS, 'utf8'),
      connectedIp: req.validatedAddresses[0] ?? null,
    };
  };
}

function htmlTransport(html: string, calls?: string[]): BrokerTransport {
  return async (req) => {
    calls?.push(req.url);
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from(html, 'utf8'),
      connectedIp: req.validatedAddresses[0] ?? null,
    };
  };
}

// NOTE (#236 seam): the harness executes analysis in-container and fails
// closed when the runner cannot. This double runs the same analyzer code
// in-process (test-only); production always uses the Docker runner.
function harness(deps: LocalHarnessDeps = {}, transport?: BrokerTransport): LocalBrowserHarnessProvider {
  const runner: Tier0ContainerRunner = {
    start: async () => undefined,
    runAnalysis: async (_spec, request) => analyzeTier0Captures(request),
    teardown: async () => undefined,
  };
  return new LocalBrowserHarnessProvider({
    isolationProbe: { dockerReachable: async () => true },
    brokerDeps: { lookup: lookupPublic, transport: transport ?? htmlTransport(BARE_HTML) },
    containerRunner: runner,
    ...deps,
  });
}

function requestFor(sampleUrls: string[], budget?: Partial<InvestigationBudget>): InvestigationProviderRequest {
  const resolved = resolveInvestigationBudget(budget);
  return {
    investigationId: 'binv_tier0_1',
    workspaceId: 'ws_tier0',
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
    runId: 'binvrun_tier01',
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

describe('Tier 0 harness identity (#233)', () => {
  it('compiles a Shopify static result through the existing gate with no new network or model calls', async () => {
    const fetched: string[] = [];
    // #246 opt-in: Shopify JSON has no DOM signals, so the default path
    // defers; this Tier 0 identity test exercises the #237 gap path.
    const provider = harness({ allowTier1Render: true }, jsonTransport(fetched));
    const req = requestFor(['https://brand.example/products/alpha.js']);
    const completion = await provider.invoke(req);

    // No new network calls: exactly one broker fetch per sample URL.
    expect(fetched).toHaveLength(1);
    // No model calls.
    expect(completion.usage!.modelCalls).toBe(0);

    const result = completion.result as unknown as InvestigationResult;
    expect(result.version).toBe(INVESTIGATION_RESULT_VERSION);
    expect(result.platform).toBe('shopify');
    expect(result.identityRequirements?.productIdentity).toContain('gtin_exact');
    expect(result.identityRequirements?.variantIdentity).toContain('platform_variant_id_exact');
    expect(result.identityRequirements?.optionAxes).toEqual(['size']);
    // Provenance: every identifier field recommendation points at a retained artifact.
    const evidence = new Set(result.evidenceRefs);
    expect(evidence.size).toBeGreaterThan(0);
    for (const rec of result.fieldRecommendations.filter((r) => ['sku', 'gtin', 'variants'].includes(r.field))) {
      expect(rec.evidenceRef).toBeDefined();
      expect(evidence.has(rec.evidenceRef!)).toBe(true);
    }

    const outcome = compileInvestigationResult(result, {
      domain: 'brand.example',
      investigationId: req.investigationId,
      runId: req.runId,
      inputHash: req.inputHash,
      resultHash: 'result-hash-tier0-1',
    });
    expect(outcome.status).toBe('proposal');
  });

  it('refuses identity-absent static results with the typed compiler gap', async () => {
    // #246: opt into the #237 render machinery so this Tier 0 identity test
    // sees the static verdict (default path defers rendered-need instead).
    const provider = harness({ allowTier1Render: true }, htmlTransport(BARE_HTML));
    const req = requestFor(['https://brand.example/products/alpha']);
    const completion = await provider.invoke(req);

    const result = completion.result as unknown as InvestigationResult;
    expect(result.identityRequirements).toBeUndefined();

    const outcome = compileInvestigationResult(result, {
      domain: 'brand.example',
      investigationId: req.investigationId,
      runId: req.runId,
      inputHash: req.inputHash,
      resultHash: 'result-hash-tier0-2',
    });
    expect(outcome.status).toBe('unresolved');
    if (outcome.status !== 'unresolved') throw new Error('expected an unresolved outcome');
    expect(outcome.gaps.some((g) => g.kind === 'missing_identity')).toBe(true);
  });
});
