import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scoreShopifyVariant,
  resolveVariantsFromHtml,
  resolveVariantsForCandidates,
  __resetVariantDomainRateStateForTests,
  __getVariantDomainRateStateForTests,
} from '../../onboarding/variant-url-resolver';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';
import type { InsertSourceData } from '../../db/repositories/onboarding-source-repo';

// DNS for variant discovery — strictly fail-closed via shared assertSafeVariantDestination.
// Mock node:dns/promises lookup to return public for test allowlisted hosts, private for adversarial hosts.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const h = String(host).toLowerCase();
    if (h.includes('private') || h === '127.0.0.1' || h === '10.0.0.1' || h === '192.168.1.1' || h.includes('169.254') || h.includes('::1') || h.includes('fc00') || h.includes('fd00')) {
      return [{ address: '10.0.0.1', family: 4 } as any];
    }
    if (h.includes('honestchew.com') || h.includes('betterbone.com') || h.includes('example.com')) {
      return [{ address: '8.8.8.8', family: 4 } as any];
    }
    return [{ address: '8.8.8.8', family: 4 } as any];
  }),
}));

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  overrideVariantFlags({ mode: 'active' });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetVariantFlagsOverride();
  __resetVariantDomainRateStateForTests();
  vi.restoreAllMocks();
});

function stubHtmlFetch(html: string, status = 200): void {
  globalThis.fetch = vi.fn(async () => new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as any;
}

const SHOPIFY_HTML_VARIANTS = `
<!doctype html>
<html>
  <head>
    <script>
      window.productJSON = {
        "id": 12345,
        "title": "HonestChew Antler",
        "options": ["Color", "Size"],
        "variants": [
          { "id": 451635, "title": "Lavender / Small", "option1": "Lavender", "option2": "Small", "sku": "HC-LAV-SM", "barcode": "111111111111", "price": 1999, "available": true },
          { "id": 451636, "title": "Lavender / Large", "option1": "Lavender", "option2": "Large", "sku": "HC-LAV-LG", "barcode": "222222222222", "price": 2499, "available": true },
          { "id": 451637, "title": "Green / Small", "option1": "Green", "option2": "Small", "sku": "HC-GRN-SM", "barcode": "333333333333", "price": 1999, "available": true }
        ]
      };
    </script>
  </head>
  <body></body>
</html>
`;

describe('Shopify variant url resolver scoring', () => {
  it('assigns high score for barcode/UPC exact match', () => {
    const v = {
      id: '451635',
      title: 'Lavender / Small',
      option1: 'Lavender',
      option2: 'Small',
      sku: 'HC-LAV-SM',
      barcode: '111111111111',
      price: 19.99,
    };
    const context = {
      upc: '111111111111',
      rawName: 'HonestChew Antler Dog Toy',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
    };
    const hints = new Set<string>();
    const varNameTokens = new Set<string>();

    const { score, matchedSignals } = scoreShopifyVariant(v, context, hints, varNameTokens);
    expect(score).toBeGreaterThanOrEqual(1000);
    expect(matchedSignals).toContain('barcode-exact');
  });

  it('matches expected name tokens and exact option values', () => {
    const v = {
      id: '451635',
      title: 'Lavender / Small',
      option1: 'Lavender',
      option2: 'Small',
      sku: 'HC-LAV-SM',
      barcode: null,
      price: 19.99,
    };
    const context = {
      upc: '',
      rawName: 'HonestChew Antler Lavender Small',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      price: 999.99,
    };
    const hints = new Set(['lavender', 'small']);
    const varNameTokens = new Set(['lavender', 'small']);

    const { score, matchedSignals } = scoreShopifyVariant(v, context, hints, varNameTokens);
    // score should include option exact (60 * 2) + name/hint matches
    expect(score).toBeGreaterThan(120);
    expect(matchedSignals).toContain('option-exact:lavender');
    expect(matchedSignals).toContain('option-exact:small');
    expect(matchedSignals.some((signal) => signal.startsWith('price-'))).toBe(false);
  });
});

describe('resolveVariantsFromHtml', () => {
  it('resolves exactly to the matching variant when barcode matches', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '222222222222',
        rawName: 'HonestChew Antler',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.variant.id).toBe('451636');
      expect(result.variant.title).toBe('Lavender / Large');
      expect(result.variant.url).toBe('https://honestchew.com/products/antler?variant=451636');
    }
  });

  it('resolves using option names when barcode is missing', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '',
        rawName: 'HonestChew Antler Green Small',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.variant.id).toBe('451637');
      expect(result.variant.title).toBe('Green / Small');
    }
  });

  it('marks as ambiguous if multiple variants are close match', () => {
    const result = resolveVariantsFromHtml(
      'https://honestchew.com/products/antler',
      SHOPIFY_HTML_VARIANTS,
      {
        upc: '',
        rawName: 'HonestChew Antler Lavender',
        expectedName: 'HonestChew Antler',
        brandHint: 'HonestChew',
      }
    );

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.variants.length).toBe(3); // Lavender Small and Lavender Large are both matches
    }
  });
});

describe('resolveVariantsForCandidates integration', () => {
  it('replaces base candidate with resolved variant url', async () => {
    stubHtmlFetch(SHOPIFY_HTML_VARIANTS);

    const candidates: InsertSourceData[] = [
      {
        url: 'https://honestchew.com/products/antler',
        title: 'HonestChew Antler',
        domain: 'honestchew.com',
        confidence: 0.9,
        sourceMethod: 'sitemap_token_overlap',
      },
    ];

    const { candidates: result, resolution } = await resolveVariantsForCandidates({
      candidates,
      upc: '',
      rawName: 'HonestChew Antler Green Small',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
      fetchFn: globalThis.fetch as any,
    });

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://honestchew.com/products/antler?variant=451637');
    expect(result[0].title).toBe('HonestChew Antler - Green / Small');
    expect(result[0].sourceMethod).toBe('shopify_variant');
    expect(result[0].metadataJson).toBeDefined();
    expect(resolution.status).toBe('resolved');
    expect(resolution.selectedKey).toBeDefined();

    const meta = JSON.parse(result[0].metadataJson!);
    expect(meta.variantResolution.status).toBe('resolved');
    expect(meta.variantResolution.variantId).toBe('451637');
  });

  it('duplicates candidates when variant resolution is ambiguous', async () => {
    stubHtmlFetch(SHOPIFY_HTML_VARIANTS);

    const candidates: InsertSourceData[] = [
      {
        url: 'https://honestchew.com/products/antler',
        title: 'HonestChew Antler',
        domain: 'honestchew.com',
        confidence: 0.9,
        sourceMethod: 'sitemap_token_overlap',
      },
    ];

    const { candidates: result, resolution } = await resolveVariantsForCandidates({
      candidates,
      upc: '',
      rawName: 'HonestChew Antler Lavender',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
      fetchFn: globalThis.fetch as any,
    });

    // It should expand into all Shopify variants as candidates
    expect(result.length).toBe(3);
    expect(result[0].url).toContain('?variant=');
    expect(result[0].sourceMethod).toBe('shopify_variant');
    expect(resolution.status).toBe('ambiguous');
    expect(resolution.candidatesCount).toBe(3);

    const meta = JSON.parse(result[0].metadataJson!);
    expect(meta.variantResolution.status).toBe('ambiguous');
    expect(meta.variantResolution.baseUrl).toBe('https://honestchew.com/products/antler');
  });

  it('malformed URL not fetch-eligible even when domain field spoofed', async () => {
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML_VARIANTS, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [
      { url: ':::not a url:::', title: null, domain: 'honestchew.com', confidence: 0.99, sourceMethod: 'sitemap_name' as const },
    ];
    await resolveVariantsForCandidates({ candidates, upc: '111111111111', rawName: 'HonestChew Antler Lavender Small', expectedName: 'HonestChew Antler', brandHint: 'HonestChew', brandDomains: ['honestchew.com'], fetchFn: fetchSpy });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('overflow true when matrix warnings include too_many_variants even though candidates capped to 250', async () => {
    // Build a payload with 300 variants to trigger truncation + warnings
    const manyVariants = Array.from({ length: 300 }, (_, i) => ({ id: 5000000 + i, title: `Variant ${i}`, option1: `Opt${i}`, sku: `SKU-${i}`, barcode: String(810000000000 + i), price: 1000, available: true }));
    const payload = { id: 1, title: 'Big', options: [{ name: 'Option' }], variants: manyVariants, images: [] };
    const html = `<html><head><script>window.productJSON=${JSON.stringify(payload)};</script></head><body></body></html>`;
    const fetchSpy = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [{ url: 'https://honestchew.com/products/big', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const }];
    const { resolution } = await resolveVariantsForCandidates({ candidates, upc: '810000000001', rawName: 'HonestChew Antler', expectedName: 'HonestChew Antler', brandHint: 'HonestChew', brandDomains: ['honestchew.com'], fetchFn: fetchSpy });
    expect(resolution.overflow).toBe(true);
    expect(resolution.warnings.some(w => w.includes('too_many'))).toBe(true);
  });

  it('throttles 429 Retry-After per domain and skips second fetch within retry window', async () => {
    __resetVariantDomainRateStateForTests();
    const fetchSpy = vi.fn(async () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } })) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://honestchew.com/products/antler', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
    ];
    const opts = { candidates, upc: '111111111111', rawName: 'HonestChew Antler Lavender Small', expectedName: 'HonestChew Antler', brandHint: 'HonestChew', brandDomains: ['honestchew.com'], fetchFn: fetchSpy };
    const first = await resolveVariantsForCandidates(opts);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.resolution.status === 'no_variants' || first.resolution.status === 'ambiguous' || first.resolution.status === 'resolved').toBe(true);
    const state = __getVariantDomainRateStateForTests('honestchew.com');
    expect(state).not.toBeNull();
    expect(state!.retryUntil).toBeGreaterThan(Date.now());
    // Second call within retry window should be throttled (no network)
    fetchSpy.mockClear();
    const second = await resolveVariantsForCandidates(opts);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(second.candidates.length).toBe(1);
    expect(second.candidates[0].url).toBe('https://honestchew.com/products/antler');
  });

  it('concurrent same-domain 429 throttles to 1 fetch, independent domain still fetches', async () => {
    __resetVariantDomainRateStateForTests();
    let callCount = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      callCount++;
      const u = String(url);
      if (u.includes('honestchew.com')) return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } }) as any;
      return new Response(SHOPIFY_HTML_VARIANTS, { status: 200, headers: { 'content-type': 'text/html' } }) as any;
    });
    const candidates: InsertSourceData[] = [
      { url: 'https://honestchew.com/products/a', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
      { url: 'https://honestchew.com/products/b', title: null, domain: 'honestchew.com', confidence: 0.89, sourceMethod: 'sitemap_name' as const },
      { url: 'https://otherbrand.com/products/x', title: null, domain: 'otherbrand.com', confidence: 0.87, sourceMethod: 'sitemap_name' as const },
    ];
    const { candidates: result } = await resolveVariantsForCandidates({
      candidates,
      upc: '111111111111',
      rawName: 'HonestChew Antler',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com', 'otherbrand.com'],
      fetchFn: fetchSpy as any,
    });
    // First honestchew fetch is 429, same-domain concurrent sibling should be throttled, otherbrand still fetches (cap 3, so 2 honestchew + 1 otherbrand = all 3 eligible, but throttling reduces honestchew to 1)
    expect(fetchSpy.mock.calls.some((c: any) => String(c[0]).includes('otherbrand.com'))).toBe(true);
    expect(callCount).toBe(2);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('aborts streaming body without Content-Length when exceeds 5MB', async () => {
    __resetVariantDomainRateStateForTests();
    // Create a stream that yields 6MB without Content-Length
    const chunk = new Uint8Array(1024 * 1024); // 1MB
    chunk.fill(65);
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const fetchSpy = vi.fn(async () => new Response(stream as any, { status: 200, headers: {} })) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://honestchew.com/products/antler', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
    ];
    const { candidates: result, resolution } = await resolveVariantsForCandidates({
      candidates,
      upc: '111111111111',
      rawName: 'HonestChew Antler',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
      fetchFn: fetchSpy,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Aborted before parse, so no variant expansion
    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://honestchew.com/products/antler');
    expect(resolution.status === 'no_variants' || resolution.status === 'skipped_no_fetch').toBeTruthy();
  });

  it('rejects allowlisted hostname resolving private via DNS (fail-closed)', async () => {
    __resetVariantDomainRateStateForTests();
    const fetchSpy = vi.fn(async () => new Response(SHOPIFY_HTML_VARIANTS, { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://private-betterbone.com/products/antler', title: null, domain: 'private-betterbone.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
    ];
    const { candidates: result } = await resolveVariantsForCandidates({
      candidates,
      upc: '111111111111',
      rawName: 'BetterBone Antler',
      expectedName: 'BetterBone Antler',
      brandHint: 'BetterBone',
      brandDomains: ['private-betterbone.com'],
      fetchFn: fetchSpy,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result[0].url).toBe('https://private-betterbone.com/products/antler');
  });

  it('per-hop DNS private on redirect is blocked (hostname allowed but resolves private)', async () => {
    __resetVariantDomainRateStateForTests();
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      if (u === 'https://honestchew.com/products/antler') {
        return new Response('', { status: 302, headers: { location: 'https://private-honestchew.com/products/antler2' } }) as any;
      }
      return new Response(SHOPIFY_HTML_VARIANTS, { status: 200, headers: { 'content-type': 'text/html' } }) as any;
    }) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://honestchew.com/products/antler', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
    ];
    const { candidates: result } = await resolveVariantsForCandidates({
      candidates,
      upc: '111111111111',
      rawName: 'HonestChew Antler',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com', 'private-honestchew.com'],
      fetchFn: fetchSpy,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result[0].url).toBe('https://honestchew.com/products/antler');
  });

  it('two-hop redirect observes both hops separately for rate limit', async () => {
    __resetVariantDomainRateStateForTests();
    const calls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      calls.push(String(url));
      const u = String(url);
      if (u === 'https://honestchew.com/products/antler') {
        return new Response('', { status: 302, headers: { location: 'https://honestchew.com/products/antler2' } }) as any;
      }
      return new Response(SHOPIFY_HTML_VARIANTS, { status: 200, headers: { 'content-type': 'text/html' } }) as any;
    }) as any;
    const candidates: InsertSourceData[] = [
      { url: 'https://honestchew.com/products/antler', title: null, domain: 'honestchew.com', confidence: 0.9, sourceMethod: 'sitemap_name' as const },
    ];
    const start = Date.now();
    await resolveVariantsForCandidates({
      candidates,
      upc: '111111111111',
      rawName: 'HonestChew Antler',
      expectedName: 'HonestChew Antler',
      brandHint: 'HonestChew',
      brandDomains: ['honestchew.com'],
      fetchFn: fetchSpy,
    });
    const elapsed = Date.now() - start;
    expect(calls).toEqual(['https://honestchew.com/products/antler', 'https://honestchew.com/products/antler2']);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});
