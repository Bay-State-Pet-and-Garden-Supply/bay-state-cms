/**
 * ADR-0031: extraction-ladder wiring tests.
 *
 * Covers BOTH production entry points:
 *  - the Bun-server fast HTTP path (`extractViaHttpDetailed`), and
 *  - the extraction-worker profile seams (`doStaticExtract` AND
 *    `doRenderedExtract` — the latter being the DEFAULT profile runtime).
 *
 * Contract under test: additive-only enrichment (profile values always win),
 * deterministic identity classification fed by forwarded UPC/GTIN, failure
 * isolation (never-throws, frozen-target safe), spreadsheet price precedence
 * without nulling ladder prices, zero extra network traffic, and final-
 * redirected-URL provenance.
 *
 * Runs under `bun test` (registered in package.json test:db) alongside the
 * other page-extractor DB suites.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

// ── Module mocks (must precede imports of consumers) ─────────────────────

let runnerCalls: Array<Record<string, unknown>> = [];
let runnerResponse: { ok: true; data: ExtractionData; warnings: string[]; fieldProvenance: Record<string, string> } | { ok: false; error: string; warnings: string[] } = {
  ok: false,
  error: 'mocked-worker-down',
  warnings: [],
};
mock.module('../../onboarding/profile-runner-client', () => ({
  runProfileExtraction: async (options: Record<string, unknown>) => {
    runnerCalls.push(options);
    return runnerResponse;
  },
}));
const resolveExecutableProfile = mock((domain: string): ExtractorProfile => {
  if (domain !== 'forwarding.example') {
    throw new Error(`No extractor profile for ${domain} — profile required (no_active_version)`);
  }
  return makeProfile({ id: 'prof-fwd-1', domain, version: 7 });
});
mock.module('../../onboarding/domain-version-health', () => ({
  resolveExecutableProfile,
}));
mock.module('../../db/repositories/brand-site-repo', () => ({
  findBrandSites: () => [],
}));
mock.module('../../db/repositories/domain-status-repo', () => ({
  recordDomainStatus: () => {},
}));

// Rendered runner mock: executes the route's extraction callback against a
// fake Playwright page so the SEAM is exercised without launching a browser.
const RENDERED_SOURCE_URL = 'https://brand.example.com/products/exact-widget';
const RENDERED_FINAL_URL = 'https://cdn.brand.example.com/products/exact-widget-final';
let renderedRunCalls = 0;
mock.module('../../extraction-worker/browser/rendered-page-runner', () => ({
  // Real signature: runRenderedPage(input, extractor, config?) — the second
  // argument is the route's extraction callback.
  runRenderedPage: async (input: { url?: string }, extractor: (ctx: { page: any }, dwellMs: number) => Promise<unknown>, _config: unknown) => {
    renderedRunCalls += 1;
    const SELECTOR_TEXT: Record<string, string> = {
      '.pdp-title': 'Selector Title',
    };
    const RENDERED_HTML = `<!doctype html>
      <html>
        <head></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","gtin":"0012345678905","variants":[{"id":"only-one"}],"images":["/img/g.png"]}}}}</script>
        </body>
      </html>`;
    const page = {
      waitForTimeout: async () => {},
      goto: async () => {},
      title: async () => 'Rendered Widget PDP',
      url: () => RENDERED_FINAL_URL,
      content: async () => RENDERED_HTML,
      evaluate: async (expr: unknown) => {
        if (typeof expr !== 'string') return []; // function/object evaluators → empty
        if (expr.includes('application/ld+json')) return [];
        if (expr.includes("querySelectorAll('meta')")) return {};
        if (expr.includes("getAttribute('content')")) return '';
        if (expr.includes('currentSrc')) return []; // DOM image walker
        // makeTextSelectorEvaluator sources embed the selector as JSON:
        const m = expr.match(/document\.querySelector\((".*?")\)/);
        if (m && expr.includes('textContent')) {
          const selector = JSON.parse(m[1]) as string;
          return SELECTOR_TEXT[selector] ?? '';
        }
        return '';
      },
    };
    const data = await extractor({ page }, 0);
    return { ok: true as const, url: input?.url ?? '', data };
  },
}));

import { extractViaHttpDetailed, extractProductData } from '../../onboarding/page-extractor';
import { applyLadderEnrichment } from '../../onboarding/extraction-ladder/enrich';
import { doStaticExtract, doRenderedExtract } from '../../extraction-worker/routes/extract';
import { ExtractionDataSchema, type ExtractionData } from '../../shared/schemas/onboarding';

/** Fully-typed profile fixture (reviewer round-2, MINOR C2). */
function makeProfile(overrides: Partial<ExtractorProfile> = {}): ExtractorProfile {
  return {
    id: 'prof-test-1',
    domain: 'example.com',
    titleSelector: '.pdp-title',
    titleOptionalSelectors: [],
    priceSelector: null,
    descriptionSelector: null,
    brandSelector: null,
    imagesSelector: null,
    customSelectors: {},
    sitemapProductUrlPattern: null,
    shopifyJSONPath: false,
    variantSelectionStrategy: null,
    customSelectorMetadata: {},
    runtime: 'static',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  } satisfies ExtractorProfile;
}

const originalFetch = globalThis.fetch;

function stubHtml(html: string): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as any;
  return { calls };
}

beforeEach(() => {
  resolveExecutableProfile.mockClear();
  runnerCalls = [];
  renderedRunCalls = 0;
  runnerResponse = { ok: false, error: 'mocked-worker-down', warnings: [] };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('extraction ladder wiring — HTTP fast path (ADR-0031)', () => {
  test('never overwrites values produced by earlier layers — REAL profile wins over ladder', async () => {
    // Profile selector yields "Selector Title"; a Next.js payload offers
    // "Next Title". The custom-selector value must win and keep its
    // custom-selector provenance.
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:title" content="OG Title">
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","sku":"SKU-1","variants":[{"id":1}]}}}}</script>
        </head>
        <body><h1 class="pdp-title">Selector Title</h1></body>
      </html>`);
    const profile = makeProfile();
    const result = await extractViaHttpDetailed('https://example.com/products/widget', profile);
    expect(result.data.title).toBe('Selector Title');
    expect(result.data.fieldProvenance.title).toBe('custom-selector');
    expect(result.data.identityStatus).toBe('probable_match'); // SKU present via ladder signals
    expect(result.data.identityReasons?.join(' ')).toContain('SKU present');
  });

  test('fills an empty title from an embedded Next.js product payload', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next-Only Title","vendor":"Acme","variants":[{"id":1},{"id":2}]}}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.title).toBe('Next-Only Title');
    expect(result.data.fieldProvenance.title).toBe('ladder-nextjs');
    expect(result.data.brand).toBe('Acme');
    expect(result.data.fieldProvenance.brand).toBe('ladder-nextjs');
    // Two variants reported by the platform = parent product page signal.
    expect(result.data.identityStatus).toBe('parent_product_only');
  });

  test('fills brand from structured JSON-LD, including nested WebPage.mainEntity graphs', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","mainEntity":{"@type":"Product","name":"Nested Widget","brand":{"@type":"Brand","name":"Nested Brand"}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/nested-widget', null);
    expect(result.data.title).toBe('Nested Widget');
    expect(result.data.brand).toBe('Nested Brand');
    expect(result.data.fieldProvenance.brand).toBe('ladder-json-ld');
  });

  test('appends Nuxt gallery images to additionalImages without touching primaryImage', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:image" content="https://example.com/og.png">
        </head>
        <body>
          <script>window.__NUXT__={"product":{"title":"Nuxt Widget","images":["/img/a.png","https://example.com/og.png"],"variants":[]}};</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.primaryImage).toContain('/og.png');
    expect(result.data.additionalImages).toEqual(['https://example.com/img/a.png']);
    expect(result.data.fieldProvenance.additionalImages).toBe('ladder-nuxt');
  });

  test('enrichment append dedupes an embedded image that matches og:image while adding the distinct one', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head>
          <meta property="og:image" content="https://example.com/og.png">
        </head>
        <body>
          <script>window.__NUXT__={"product":{"title":"Nuxt Widget","images":["https://example.com/og.png","/img/distinct.png"],"variants":[]}};</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/widget', null);
    expect(result.data.primaryImage).toBe('https://example.com/og.png');
    expect(result.data.additionalImages).toEqual(['https://example.com/img/distinct.png']);
  });

  test('fills price/description from an embedded WooCommerce Store API payload', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head><script src="/wp-content/plugins/woocommerce/assets/js/frontend/woocommerce.min.js"></script></head>
        <body>
          <script type="application/json">{"id":9,"name":"Woo Widget","sku":"WOO-1","prices":{"price":"1299"},"description":"Long woo description","images":["https://example.com/woo.png"]}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/product/widget', null);
    expect(result.data.title).toBe('Woo Widget');
    expect(result.data.price).toBe('1299');
    expect(result.data.description).toBe('Long woo description');
    expect(result.data.fieldProvenance.title).toBe('ladder-woocommerce');
  });

  test('attaches exact_match identity when the requested GTIN is affirmatively proven single-variant', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Exact Widget","gtin":"0012345678905","variants":[{"id":"only-one"}]}}}}</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed(
      'https://example.com/products/exact-widget',
      null,
      { name: 'Exact Widget', gtin: '0012345678905' },
    );
    expect(result.data.identityStatus).toBe('exact_match');
    expect(result.data.identityReasons?.length).toBeGreaterThan(0);
  });

  test('degrades gracefully when embedded payloads are malformed (internal parser guards)', async () => {
    stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Resilient Title"></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">{definitely-not-json</script>
        </body>
      </html>`);
    const result = await extractViaHttpDetailed('https://example.com/products/broken', null);
    expect(result.data.title).toBe('Resilient Title'); // base layers unaffected
    expect(result.data.identityStatus).toBeTruthy();   // classification still attached
  });

  test('never throws when the target object rejects mutation (frozen ExtractionData)', async () => {
    const frozen = Object.freeze(ExtractionDataSchema.parse({})) as ExtractionData;
    const outcome = await applyLadderEnrichment({
      html: '<html><head><meta property="og:title" content="Frozen Probe"></head><body></body></html>',
      url: 'https://example.com/products/frozen',
      data: frozen,
      expected: { name: 'Unrelated Product Name' },
    });
    // Resolves normally; the AUTHORITATIVE outcome is fully populated even
    // though every mutation of the frozen target was dropped.
    expect(outcome.identityStatus).toBe('insufficient_evidence');
    expect(Array.isArray(outcome.identityReasons)).toBe(true);
    expect(outcome.identityReasons.length).toBeGreaterThan(0);
    expect(outcome.layersUsed.length).toBeGreaterThan(0);
    expect(frozen.title).toBeNull();       // unchanged — mutation guarded away
    expect(frozen.identityStatus).toBeNull(); // ditto for the identity fields
  });

  test('makes zero extra network requests on Shopify pages by default (dead productJSON path stays dead)', async () => {
    const { calls } = stubHtml(`<!doctype html>
      <html>
        <head><meta property="og:title" content="Shop Thing"></head>
        <body><div class="cdn/shop/marker"></div><script>Shopify.theme = {"name":"dawn"};</script></body>
      </html>`);
    const result = await extractViaHttpDetailed('https://shop.example.com/products/thing', null);
    expect(calls.length).toBe(1); // exactly one request: the original HTML fetch
    expect(result.data.title).toBe('Shop Thing');
  });
});

describe('extraction ladder wiring — production profile/worker seam (ADR-0031)', () => {
  test('doStaticExtract enriches with embedded signals and classifies identity from expected.upc (exactly one fetch)', async () => {
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls += 1;
      return new Response(`<!doctype html>
        <html>
          <head></head>
          <body>
            <h1 class="pdp-title">Selector Title</h1>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"title":"Next Title","gtin":"0012345678905","variants":[{"id":"only-one"}]}}}}</script>
          </body>
        </html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }) as any;

    const request = {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://brand.example.com/products/exact-widget',
      expected: { name: 'Exact Widget', brandHint: null, price: null, upc: '0012345678905', spreadsheetHints: {} },
      profile: {
        runtime: 'static' as const,
        selectors: { titleSelector: '.pdp-title' },
        titleOptionalSelectors: [],
        customSelectors: {},
        imageRules: {},
        variantSelectionStrategy: null,
        allowedSourceDomains: [],
      },
    };
    const result = await doStaticExtract(request as any, {
      fetchFn,
      // SSRF floor performs DNS resolution on the destination — resolve it
      // deterministically for the test (no real network).
      lookupFn: (async () => [{ address: '93.184.216.34' }]) as any,
    });
    expect(fetchCalls).toBe(1);                       // exactly one fetch — no refetch
    expect(result.data.title).toBe('Selector Title'); // profile-primary preserved
    expect(result.data.fieldProvenance.title).toBe('profile-selector');
    // UPC was consumed by the enrichment → real exact_match classification.
    expect(result.data.identityStatus).toBe('exact_match');
    expect(result.data.identityReasons?.length).toBeGreaterThan(0);
  });

  test('doRenderedExtract (DEFAULT profile runtime) enriches from in-memory renderedHtml with zero refetch and final-URL provenance', async () => {
    let networkFetches = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      networkFetches += 1;
      throw new Error(`unexpected network fetch: ${typeof input === 'string' ? input : String(input)}`);
    }) as any;

    const request = {
      profileId: 'prof-rendered-1',
      profileVersion: 1,
      sourceUrl: RENDERED_SOURCE_URL,
      expected: { name: 'Exact Widget', brandHint: null, price: null, upc: '0012345678905', spreadsheetHints: {} },
      profile: {
        runtime: 'rendered' as const,
        selectors: { titleSelector: '.pdp-title' },
        titleOptionalSelectors: [],
        customSelectors: {},
        imageRules: {},
        variantSelectionStrategy: null,
        allowedSourceDomains: ['brand.example.com'],
      },
    };
    const result = await doRenderedExtract(request as any, {
      // SSRF pre-flight performs DNS resolution — resolve deterministically
      // for the test (no real network).
      lookupFn: (async () => [{ address: '93.184.216.34' }]) as any,
    });

    expect(renderedRunCalls).toBe(1);                 // runner invoked once
    expect(networkFetches).toBe(0);                   // ZERO refetches — renderedHtml reused
    expect(result.warnings.join(' ')).not.toContain('Ladder enrichment failed');
    expect(result.data.title).toBe('Selector Title'); // profile-primary preserved
    expect(result.data.fieldProvenance.title).toBe('profile-selector');
    // UPC + single-variant platform state → real exact_match classification.
    expect(result.data.identityStatus).toBe('exact_match');
    // Relative gallery image resolved against the FINAL REDIRECTED URL,
    // proving the captured URL propagated into enrichment (MINOR B).
    expect(result.data.additionalImages).toContain('https://cdn.brand.example.com/img/g.png');
    expect(result.data.additionalImages.some((u) => u.startsWith(RENDERED_SOURCE_URL))).toBe(false);
  });

  test.each(['no_active_version', 'executable_content_changed', 'health_check_failed'])(
    'extractProductData fails closed before fetching when resolution rejects: %s',
    async (reason) => {
      const { calls } = stubHtml('<html><h1>Generic fallback title</h1></html>');
      const error = new Error(`No extractor profile for forwarding.example — profile required (${reason})`);
      resolveExecutableProfile.mockImplementationOnce(() => { throw error; });

      await expect(extractProductData('https://www.forwarding.example/products/widget', {
        name: 'Forwarded Widget',
      })).rejects.toThrow(error.message);

      expect(resolveExecutableProfile).toHaveBeenCalledWith('forwarding.example');
      expect(runnerCalls).toHaveLength(0);
      expect(renderedRunCalls).toBe(0);
      expect(calls).toHaveLength(0);
    },
  );

  test('extractProductData without expected data still resolves and uses the profile runner', async () => {
    const { calls } = stubHtml('<html><h1>Generic fallback title</h1></html>');

    await expect(extractProductData('https://forwarding.example/products/widget'))
      .rejects.toThrow('mocked-worker-down');

    expect(resolveExecutableProfile).toHaveBeenCalledWith('forwarding.example');
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].profile).toEqual(makeProfile({
      id: 'prof-fwd-1', domain: 'forwarding.example', version: 7,
    }));
    expect(calls).toHaveLength(0);
  });

  test('extractProductData rejects a missing profile without expected data or generic fallback', async () => {
    const { calls } = stubHtml('<html><h1>Generic fallback title</h1></html>');

    await expect(extractProductData('https://missing.example/products/widget'))
      .rejects.toThrow('No extractor profile for missing.example — profile required (no_active_version)');

    expect(runnerCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('extractProductData forwards expected.gtin as upc to the profile runner', async () => {
    const { calls } = stubHtml('<html></html>');
    await expect(
      extractProductData('https://forwarding.example/products/widget', {
        name: 'Forwarded Widget',
        gtin: '0012345678905',
      }),
    ).rejects.toThrow('mocked-worker-down');
    expect(resolveExecutableProfile).toHaveBeenCalledWith('forwarding.example');
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0].profile).toEqual(makeProfile({
      id: 'prof-fwd-1', domain: 'forwarding.example', version: 7,
    }));
    expect(calls).toHaveLength(0);
    const expectedArg = (runnerCalls[0] as { expected?: { upc?: string } }).expected;
    expect(expectedArg?.upc).toBe('0012345678905');
  });

  test('worker-branch spreadsheet override: ladder price survives without a spreadsheet price, is overridden when present', async () => {
    // Successful worker extraction carrying a ladder-enriched price.
    runnerResponse = {
      ok: true,
      data: ExtractionDataSchema.parse({
        title: 'Worker Widget',
        price: '12.99',
        fieldProvenance: { title: 'profile-selector', price: 'ladder-shopify' },
      }),
      warnings: [],
      fieldProvenance: {},
    } as any;

    // No spreadsheet price → ladder price AND its provenance survive (MAJOR A).
    const survived = await extractProductData('https://forwarding.example/products/worker-widget', {
      name: 'Worker Widget',
    });
    expect(survived.price).toBe('12.99');
    expect(survived.fieldProvenance.price).toBe('ladder-shopify');

    // Spreadsheet price present → spreadsheet wins, provenance flips.
    const overridden = await extractProductData('https://forwarding.example/products/worker-widget', {
      name: 'Worker Widget',
      price: '19.99',
    });
    expect(overridden.price).toBe('19.99');
    expect(overridden.fieldProvenance.price).toBe('spreadsheet-import');
  });
});
