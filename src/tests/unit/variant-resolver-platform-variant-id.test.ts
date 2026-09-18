// T4 (#228) — known platform variant ID in the normalized matcher.
//
// Identity precedence: exact GTIN, then trusted source SKU and compatible
// MPN semantics, then exact known platform variant ID, then sufficiently
// discriminating exact options, then operator receipt. Parent product ID
// alone never selects among variants; fuzzy name similarity alone never
// resolves; a store UPC in the SKU slot is not automatically a
// manufacturer SKU. Conflicting or absent identifiers fail closed.
//
// Pure `matchVariantMatrix` assertions (vitest, no DB). Matrices are built
// through the real Shopify parser so identifier/option normalization is
// exercised, not hand-constructed.

import { describe, expect, it } from 'vitest';
import { matchVariantMatrix, parseShopifyMatrix } from '../../onboarding/variant-resolver';

const PARENT_URL = 'https://example.com/products/betterbone';
const EXPECTED_GTIN_SMALL = '810001234501';

function shopifyMatrix() {
  const payload = JSON.stringify({
    id: 999001,
    title: 'BetterBone Beef',
    vendor: 'BetterBone',
    handle: 'betterbone',
    options: [{ name: 'Size', values: ['Small', 'Large'] }],
    variants: [
      { id: 111, title: 'Small', option1: 'Small', sku: 'BB-SM-001', barcode: '810001234501', available: true, price: 1999 },
      { id: 222, title: 'Large', option1: 'Large', sku: 'BB-LG-001', barcode: '810001234502', available: true, price: 2999 },
    ],
  });
  const matrix = parseShopifyMatrix(payload, PARENT_URL);
  expect(matrix).not.toBeNull();
  return matrix!;
}

describe('known platform variant ID identity precedence (T4)', () => {
  it('exact known platform variant ID resolves when no stronger identifier is supplied', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      platformVariantId: '222',
    } as any);
    expect(decision.status).toBe('resolved');
    expect(decision.matchedBy).toBe('platform_id');
    expect(decision.selectedVariantKey).toContain('222');
  });

  it('exact GTIN outranks a conflicting known platform variant ID (fail closed, not silent override)', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      gtin: '810001234501',
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      platformVariantId: '222',
    } as any);
    expect(decision.status).toBe('ambiguous');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('trusted SKU outranks a conflicting known platform variant ID (fail closed)', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      sku: 'BB-SM-001',
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      platformVariantId: '222',
    } as any);
    expect(decision.status).toBe('ambiguous');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('agreeing identifiers resolve by the strongest signal', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      gtin: '810001234502',
      sku: 'BB-LG-001',
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      platformVariantId: '222',
    } as any);
    expect(decision.status).toBe('resolved');
    expect(decision.matchedBy).toBe('gtin');
    expect(decision.selectedVariantKey).toContain('222');
  });

  it('duplicate platform IDs across candidates fail closed', () => {
    const payload = JSON.stringify({
      id: 999001,
      title: 'BetterBone Beef',
      vendor: 'BetterBone',
      handle: 'betterbone',
      options: [{ name: 'Size', values: ['Small', 'Large'] }],
      variants: [
        { id: 111, title: 'Small', option1: 'Small', sku: null, barcode: null, available: true },
        { id: 111, title: 'Large', option1: 'Large', sku: null, barcode: null, available: true },
      ],
    });
    const matrix = parseShopifyMatrix(payload, PARENT_URL);
    expect(matrix).not.toBeNull();
    const decision = matchVariantMatrix(matrix!, {
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      platformVariantId: '111',
    } as any);
    expect(decision.status).toBe('ambiguous');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('parent product ID alone never selects among variants', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      name: 'BetterBone',
      brandHint: 'BetterBone',
      platformVariantId: '999001',
    } as any);
    expect(decision.status).not.toBe('resolved');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('unknown platform variant ID with no other signal never resolves', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      name: 'BetterBone',
      brandHint: 'BetterBone',
      platformVariantId: '000000',
    } as any);
    expect(decision.status).not.toBe('resolved');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('fuzzy name similarity alone never resolves identity', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      // Close to the Small candidate title, but no identifier or option signal.
      name: 'BetterBone Beef Smallish',
      brandHint: 'BetterBone',
    });
    expect(decision.status).not.toBe('resolved');
    expect(decision.selectedVariantKey).toBeNull();
  });

  it('a store UPC in the SKU slot does not match a candidate GTIN identifier', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      // 810001234501 is variant 111's BARCODE, supplied here as a store SKU.
      // Slots stay distinct: a SKU-slot value never matches a gtin identifier.
      sku: '810001234501',
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
    });
    expect(decision.selectedVariantKey ?? '').not.toContain('111');
  });

  it('sufficiently discriminating exact options still resolve when no identifiers are known', () => {
    const decision = matchVariantMatrix(shopifyMatrix(), {
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      expectedOptions: [{ axis: 'size', value: 'Large' }],
    });
    expect(decision.status).toBe('resolved');
    expect(decision.matchedBy).toBe('options');
    expect(decision.selectedVariantKey).toContain('222');
  });

  it('reads gtin12/gtin13 barcode aliases like the legacy variant extractor', () => {
    const payload = JSON.stringify({
      id: 999001,
      title: 'BetterBone Beef',
      vendor: 'BetterBone',
      handle: 'betterbone',
      options: [{ name: 'Size', values: ['Small', 'Large'] }],
      variants: [
        { id: 111, title: 'Small', option1: 'Small', sku: null, gtin12: EXPECTED_GTIN_SMALL, available: true },
        { id: 222, title: 'Large', option1: 'Large', sku: null, gtin13: '810001234502', available: true },
      ],
    });
    const matrix = parseShopifyMatrix(payload, PARENT_URL);
    expect(matrix).not.toBeNull();
    const decision = matchVariantMatrix(matrix!, {
      gtin: EXPECTED_GTIN_SMALL,
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
    });
    expect(decision.status).toBe('resolved');
    expect(decision.matchedBy).toBe('gtin');
    expect(decision.selectedVariantKey).toContain('111');
  });
});
