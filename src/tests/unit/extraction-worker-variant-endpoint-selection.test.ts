import { describe, it, expect, vi, beforeEach } from 'vitest';
import { doStaticExtract } from '../../extraction-worker/routes/extract';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';

/**
 * Issue #216 repro: multi-candidate embedded variant matrix lacking barcodes
 * alongside endpoint (.js) data containing them.
 *
 * Suspect: worker fetches .js only when embedded candidates <= 1, so richer
 * endpoint identifiers are never consulted on multi-candidate pages.
 *
 * - WITH endpoint barcodes: exact GTIN must resolve without manual selection
 *   (fails before fix: variant_selection_required, .js never fetched).
 * - WITHOUT endpoint barcodes: genuine ambiguity must still fail closed.
 * - Provenance must record the endpoint source through the existing carrier.
 */

const baseProfile: any = {
  id: 'prof-216',
  domain: 'example.com',
  titleSelector: 'h1',
  titleOptionalSelectors: [],
  priceSelector: null,
  descriptionSelector: null,
  brandSelector: null,
  imagesSelector: null,
  customSelectors: {},
  variantSelectionStrategy: null,
  customSelectorMetadata: {},
  runtime: 'static' as const,
  allowedSourceDomains: ['example.com'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const SOURCE_URL = 'https://example.com/products/betterbone';
const EXPECTED_GTIN = '810001234501';

/** Multi-candidate embedded Shopify matrix WITHOUT barcodes (no gtin identifiers). */
function embeddedHtmlWithoutBarcodes(): string {
  return `
  <html><head><title>BetterBone</title>
  <link rel="stylesheet" href="https://example.com/cdn/shop/files/app.css" />
  <script>window.Shopify = {};</script>
  </head><body>
  <h1>BetterBone Beef</h1>
  <script id="ProductJson-123" type="application/json">{"title":"BetterBone","handle":"betterbone","variants":[
    {"id":111,"title":"Small","option1":"Small","sku":null,"barcode":null,"available":true},
    {"id":222,"title":"Large","option1":"Large","sku":null,"barcode":null,"available":true},
    {"id":333,"title":"Mini","option1":"Mini","sku":null,"barcode":null,"available":true}
  ]}</script>
  </body></html>`;
}

/** Endpoint .js payload WITH barcodes (one exact match for EXPECTED_GTIN). */
function endpointJsWithBarcodes(): string {
  return JSON.stringify({
    title: 'BetterBone',
    handle: 'betterbone',
    options: [{ name: 'Size', values: ['Small', 'Large', 'Mini'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: 'BB-SM-001', barcode: EXPECTED_GTIN, available: true, price: 1999 },
      { id: 222, title: 'Large', option1: 'Large', sku: 'BB-LG-001', barcode: '810001234502', available: true, price: 2999 },
      { id: 333, title: 'Mini', option1: 'Mini', sku: 'BB-MINI-001', barcode: '810001234503', available: true, price: 1499 },
    ],
  });
}

/** Endpoint .js payload WITHOUT barcodes (no exact-identifier signal). */
function endpointJsWithoutBarcodes(): string {
  return JSON.stringify({
    title: 'BetterBone',
    handle: 'betterbone',
    options: [{ name: 'Size', values: ['Small', 'Large', 'Mini'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: null, barcode: null, available: true },
      { id: 222, title: 'Large', option1: 'Large', sku: null, barcode: null, available: true },
      { id: 333, title: 'Mini', option1: 'Mini', sku: null, barcode: null, available: true },
    ],
  });
}

/** Endpoint .js payload with a DUPLICATE GTIN (genuine ambiguity, must fail closed). */
function endpointJsWithDuplicateGtin(): string {
  return JSON.stringify({
    title: 'BetterBone',
    handle: 'betterbone',
    options: [{ name: 'Size', values: ['Small', 'Large', 'Mini'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: null, barcode: EXPECTED_GTIN, available: true },
      { id: 222, title: 'Large', option1: 'Large', sku: null, barcode: EXPECTED_GTIN, available: true },
      { id: 333, title: 'Mini', option1: 'Mini', sku: null, barcode: '810001234503', available: true },
    ],
  });
}

function publicLookup() {
  return async () => [{ address: '93.184.215.14' }];
}

function makeRequest(): any {
  return {
    profileId: 'prof-216',
    profileVersion: 1,
    sourceUrl: SOURCE_URL,
    // Generic name carries no size token, so the embedded matrix alone cannot
    // resolve via options — only an exact GTIN from the endpoint can.
    expected: { name: 'BetterBone', brandHint: null, price: null, spreadsheetHints: {}, upc: EXPECTED_GTIN },
    profile: baseProfile,
  };
}

describe('issue #216: endpoint variant evidence selection', () => {
  beforeEach(() => resetVariantFlagsOverride());

  it('WITH endpoint barcodes: exact GTIN resolves without manual selection', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = embeddedHtmlWithoutBarcodes();
    const js = endpointJsWithBarcodes();
    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('.js')) return new Response(js, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const result: any = await doStaticExtract(makeRequest(), {
      lookupFn: publicLookup() as any,
      fetchFn: fetchFn as any,
    });

    // Endpoint must have been consulted (page + .js).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((u) => u.endsWith('.js'))).toBe(true);
    // Exact-identifier match resolves without manual selection.
    expect(result.failureCode).toBeFalsy();
    expect(result.selectedReceipt).toBeDefined();
    expect(result.selectedReceipt?.matchedBy).toBe('gtin');
    // Provenance records the endpoint source through the existing carrier.
    const vp = (result.data as any)?.variantProvenance ?? {};
    const fpd = result.fieldProvenanceDetails ?? {};
    const provenanceText = JSON.stringify({ vp, fpd, fp: (result.data as any)?.fieldProvenance ?? {} });
    expect(provenanceText).toMatch(/shopify_js/);
    // No parallel provenance system.
    expect((result as any).endpointProvenance).toBeUndefined();
  });

  it('WITHOUT endpoint barcodes: genuine ambiguity still fails closed', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = embeddedHtmlWithoutBarcodes();
    const js = endpointJsWithoutBarcodes();
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('.js')) return new Response(js, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const result: any = await doStaticExtract(makeRequest(), {
      lookupFn: publicLookup() as any,
      fetchFn: fetchFn as any,
    });
    expect(result.failureCode).toBe('variant_selection_required');
    expect(result.selectedReceipt).toBeFalsy();
  });

  it('WITH duplicate endpoint GTIN: genuine ambiguity still fails closed', async () => {
    overrideVariantFlags({ mode: 'active' });
    const html = embeddedHtmlWithoutBarcodes();
    const js = endpointJsWithDuplicateGtin();
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('.js')) return new Response(js, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const result: any = await doStaticExtract(makeRequest(), {
      lookupFn: publicLookup() as any,
      fetchFn: fetchFn as any,
    });
    // Duplicate GTIN can never resolve alone via the existing matcher.
    expect(result.failureCode).toBe('variant_selection_required');
    expect(result.selectedReceipt).toBeFalsy();
  });
});
