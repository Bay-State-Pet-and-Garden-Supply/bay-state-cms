// T4 (#228) — Shopify endpoint-backed policy execution in the production worker.
//
// A profile carrying `extractionPolicy` (platform `shopify`, per-field
// source order) executes the Shopify `.js` endpoint through the EXISTING
// normalized variant-identity matcher — no second matcher — and binds
// variant-specific fields (SKU, barcode/GTIN, options, variant image,
// price, availability) plus parent and variant IDs. Conflicting or absent
// identifiers fail closed; legacy profiles without policy keep current
// semantics exactly.
//
// Worker-level assertions via `doStaticExtract` with injected transport
// (vitest, no DB, no network).

import { describe, expect, it } from 'vitest';
import { expectEndpointGtinResolved, publicTestLookup, routingTestTransport } from './helpers/shopify-worker-test-transport';
import { doStaticExtract } from '../../extraction-worker/routes/extract';
import { resetVariantFlagsOverride } from '../../onboarding/variant-flags';
import { hashCanonicalJson } from '../../shared/stable-id';

const SOURCE_URL = 'https://example.com/products/betterbone';
const EXPECTED_GTIN = '810001234501';

const POLICY = {
  version: 1,
  platform: 'shopify',
  structures: [{ id: 'single-structure', sampleUrls: [SOURCE_URL] }],
  fields: [
    { field: 'title', sources: ['shopify_product_json'] },
    { field: 'brand', sources: ['shopify_product_json'] },
    { field: 'description', sources: ['shopify_product_json'] },
    { field: 'price', sources: ['shopify_product_json'] },
    { field: 'images', sources: ['shopify_product_json'] },
    { field: 'sku', sources: ['shopify_product_json'] },
    { field: 'gtin', sources: ['shopify_product_json'] },
    { field: 'variants', sources: ['shopify_product_json'] },
    { field: 'availability', sources: ['shopify_product_json'] },
  ],
  identity: {
    productIdentity: ['gtin_exact'],
    variantIdentity: ['gtin_exact', 'sku_exact', 'platform_id_exact', 'options_exact_tuple', 'operator_selected'],
    optionAxes: ['size'],
  },
  renderedBrowserRequired: false,
};

function policyProfile(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'prof-policy',
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
    selectors: {
      titleSelector: 'h1',
      priceSelector: null,
      descriptionSelector: null,
      brandSelector: null,
      imagesSelector: null,
    },
    extractionPolicy: POLICY,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function pageHtml(): string {
  return `
  <html><head><title>BetterBone</title></head><body>
  <h1>BetterBone Beef</h1>
  </body></html>`;
}

function endpointJs() {
  return JSON.stringify({
    id: 999001,
    title: 'BetterBone Beef',
    vendor: 'BetterBone',
    handle: 'betterbone',
    body_html: '<p>Grass-fed beef chew.</p>',
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: 'BB-SM-001', barcode: EXPECTED_GTIN, available: true, price: 1999, featured_image: { src: 'https://example.com/cdn/small.jpg' } },
      { id: 222, title: 'Large', option1: 'Large', sku: 'BB-LG-001', barcode: '810001234502', available: false, price: 2999, featured_image: { src: 'https://example.com/cdn/large.jpg' } },
    ],
    images: [{ src: 'https://example.com/cdn/small.jpg', variant_ids: [111] }],
  });
}

function policyRequest(expected: Record<string, unknown>, profile: any): any {
  return {
    profileId: 'prof-policy',
    profileVersion: 1,
    sourceUrl: SOURCE_URL,
    expected: { name: 'BetterBone Beef', brandHint: 'BetterBone', price: null, spreadsheetHints: {}, ...expected },
    profile,
  };
}

/** Run one policy case through the worker with deterministic transport (shared harness). */
async function runPolicyCase(
  expected: Record<string, unknown>,
  profile: any,
  js: string = endpointJs(),
): Promise<{ result: any; calls: string[] }> {
  resetVariantFlagsOverride();
  const calls: string[] = [];
  const result: any = await doStaticExtract(policyRequest(expected, profile), {
    lookupFn: publicTestLookup() as any,
    fetchFn: routingTestTransport(pageHtml(), js, calls) as any,
  });
  return { result, calls };
}

/** Single-variant endpoint payload (no alternative to choose among). */
function singleVariantJs(): string {
  return JSON.stringify({
    id: 999001,
    title: 'BetterBone Beef',
    vendor: 'BetterBone',
    handle: 'betterbone',
    options: [{ name: 'Size', values: ['Small'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: 'BB-SM-001', barcode: EXPECTED_GTIN, available: true, price: 1999 },
    ],
    images: [],
  });
}

/** Variant-bound merchandising truth from the SELECTED endpoint variant (111). */
function expectVariantBoundFields(result: any): void {
  const data = result.data;
  expect(data.title).toContain('BetterBone');
  expect((data.fieldProvenance as Record<string, string>).title).toBe('shopify_product_json');
  expect(data.price).toContain('19.99');
  expect(data.primaryImage).toContain('small.jpg');
  expect(data.primaryImage).not.toContain('large.jpg');
  expect((data as any).customFields?.sku).toBe('BB-SM-001');
  expect((data as any).customFields?.gtin).toBe(EXPECTED_GTIN);
  expect((data as any).customFields?.availability).toBe('in_stock');
  expect((data as any).customFields?.variants).toContain('Small');
  const provenanceText = JSON.stringify({
    vp: (data as any).variantProvenance ?? {},
    fp: data.fieldProvenance ?? {},
    fpd: result.fieldProvenanceDetails ?? {},
    custom: (data as any).customFields ?? {},
  });
  expect(provenanceText).toMatch(/bb-sm-001/);
  expect(provenanceText).toMatch(/810001234501/);
  expect(provenanceText).toMatch(/111/);
}

/** Shared fail-closed assertions for ambiguous policy identity. */
function expectAmbiguousFailure(result: any): void {
  expect(result.failureCode).toBe('variant_selection_required');
  expect(result.selectedReceipt).toBeFalsy();
  expect(result.matrixDecision?.status).toBe('ambiguous');
}

describe('shopify policy execution in the production worker (T4)', () => {
  it('resolves via endpoint GTIN and preserves variant-bound fields and IDs', async () => {
    const { result, calls } = await runPolicyCase({ upc: EXPECTED_GTIN }, policyProfile());
    expectEndpointGtinResolved(expect, result, calls);
    expect(result.matrixDecision?.status).toBe('resolved');
    expectVariantBoundFields(result);
    // Parent product ID preserved alongside the variant ID.
    expect(String(result.parentProductId ?? '')).toBe('999001');
    expect(result.identityMatrixHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('conflicting identifiers fail closed to ambiguity', async () => {
    const { result } = await runPolicyCase({ upc: EXPECTED_GTIN, platformVariantId: '222' }, policyProfile());
    expectAmbiguousFailure(result);
  });

  it('absent identifiers fail closed instead of resolving by fuzzy name similarity', async () => {
    const { result } = await runPolicyCase({}, policyProfile());
    expect(result.failureCode).toBe('variant_selection_required');
    expect(result.selectedReceipt).toBeFalsy();
  });

  it('honors per-field source order (selector first wins when present)', async () => {
    const orderPolicy = {
      ...POLICY,
      fields: POLICY.fields.map((f) =>
        f.field === 'title' ? { field: 'title', sources: ['selector', 'shopify_product_json'], selector: 'h1' } : f,
      ),
    };
    const { result } = await runPolicyCase({ upc: EXPECTED_GTIN }, policyProfile({ extractionPolicy: orderPolicy }));
    expect(result.failureCode).toBeFalsy();
    expect(result.data.title).toBe('BetterBone Beef');
    expect((result.data.fieldProvenance as Record<string, string>).title).toBe('profile-selector');
  });

  it('legacy profiles without policy keep current semantics (no endpoint fetch on plain pages)', async () => {
    const legacy = policyProfile();
    delete legacy.extractionPolicy;
    const { result, calls } = await runPolicyCase({ upc: EXPECTED_GTIN }, legacy);
    // Plain page: no Shopify markers, single embedded matrix at most — the
    // legacy gate must not consult the endpoint, and title still extracts.
    expect(calls.some((u) => u.endsWith('.js'))).toBe(false);
    expect(result.data?.title).toBe('BetterBone Beef');
  });

  it('single-variant evidence binds when trusted identifiers agree', async () => {
    const { result } = await runPolicyCase({ upc: EXPECTED_GTIN }, policyProfile(), singleVariantJs());
    expect(result.failureCode).toBeFalsy();
    expect((result.data as any).customFields?.sku).toBe('BB-SM-001');
  });

  it('single-variant evidence fails closed when a trusted identifier contradicts it', async () => {
    const { result } = await runPolicyCase({ upc: '810001234502' }, policyProfile(), singleVariantJs());
    expectAmbiguousFailure(result);
  });

  it('stale operator receipts fail closed without binding', async () => {
    const request = policyRequest({ upc: EXPECTED_GTIN }, policyProfile());
    (request as any).variantSelection = {
      resolutionId: 'res-stale',
      identityMatrixHash: '0'.repeat(64),
      variantKey: 'stale-key',
    };
    resetVariantFlagsOverride();
    const calls: string[] = [];
    const stale: any = await doStaticExtract(request, {
      lookupFn: publicTestLookup() as any,
      fetchFn: routingTestTransport(pageHtml(), endpointJs(), calls) as any,
    });
    expect(stale.failureCode).toBe('variant_selection_stale');
    expect(stale.selectedReceipt).toBeFalsy();
  });

  it('policy content hash binds execution to the compiled proposal', async () => {
    const content = {
      platform: (POLICY as any).platform,
      structures: (POLICY as any).structures,
      fields: (POLICY as any).fields,
      identity: (POLICY as any).identity,
      renderedBrowserRequired: (POLICY as any).renderedBrowserRequired,
    };
    expect(hashCanonicalJson(content)).toMatch(/^[a-f0-9]{64}$/);
  });
});
