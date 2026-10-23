import { describe, it, expect } from 'vitest';
import { materializeSelectedVariant } from '../../onboarding/selected-variant-materializer';
import type { ExtractionData } from '../../shared/schemas/onboarding';
import type { NormalizedVariantCandidate } from '../../shared/schemas/variant-resolution';

function baseData(): ExtractionData {
  return {
    title: 'BetterBone Beef',
    brand: 'BetterBone',
    description: 'Parent description',
    bulletPoints: [],
    primaryImage: 'https://example.com/og.jpg',
    additionalImages: ['https://example.com/gallery.jpg'],
    price: '9.99',
    weight: null,
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    sourceUrl: 'https://example.com/products/betterbone',
    confidence: 1,
    fieldProvenance: { title: 'html', primaryImage: 'html' },
    identityStatus: null,
    identityReasons: [],
    packagingTitle: null,
    packagingOcrData: null,
    customFields: {},
    productIntelligenceEvidence: [],
  } as any;
}

function candidate(over: Partial<NormalizedVariantCandidate> = {}): NormalizedVariantCandidate {
  return {
    variantKey: 'shopify:1:Small',
    platformId: '1',
    title: 'BetterBone Small',
    identifiers: [{ kind: 'sku', value: 'SM-001', normalizedValue: 'sm-001', sourcePath: 'shopify.variants[0].sku' }],
    options: [{ axis: 'size', value: 'Small', normalizedAxis: 'size', normalizedValue: 'small', sourcePath: 'shopify.variants[0].options' }],
    available: true,
    price: '9.99',
    currency: 'USD',
    weight: '100g',
    dimensions: null,
    images: [{ url: 'https://example.com/sm.jpg', role: 'primary', sourcePath: 'shopify.variants[0].image' }],
    deepLink: 'https://example.com/products/betterbone?variant=1',
    sourcePaths: { shopify: 'shopify.variants[0]' },
    ...over,
  } as any;
}

describe('selected-variant-materializer (M4)', () => {
  it('keeps the onboarding price when selected third-party variant prices disagree', () => {
    const base = baseData();
    const sm = candidate({ variantKey: 'shopify:4123456001:Small', title: 'BetterBone Small', identifiers: [{ kind: 'gtin', value: '810001234501', normalizedValue: '810001234501', sourcePath: 'shopify.variants[0].gtin' } as any, { kind: 'sku', value: 'BB-SM-001', normalizedValue: 'bb-sm-001', sourcePath: 'shopify.variants[0].sku' } as any, { kind: 'platform_id', value: '4123456001', normalizedValue: '4123456001', sourcePath: 'shopify.variants[0].platform_id' } as any], options: [{ axis: 'size', value: 'Small', normalizedAxis: 'size', normalizedValue: 'small', sourcePath: 'shopify.variants[0].options' } as any], price: '111.11', images: [{ url: 'https://example.com/sm.jpg', role: 'primary', sourcePath: 'shopify.variants[0].image' }] });
    const lg = candidate({ variantKey: 'shopify:4123456002:Large', title: 'BetterBone Large', identifiers: [{ kind: 'gtin', value: '810001234502', normalizedValue: '810001234502', sourcePath: 'shopify.variants[1].gtin' } as any, { kind: 'sku', value: 'BB-LG-001', normalizedValue: 'bb-lg-001', sourcePath: 'shopify.variants[1].sku' } as any, { kind: 'platform_id', value: '4123456002', normalizedValue: '4123456002', sourcePath: 'shopify.variants[1].platform_id' } as any], options: [{ axis: 'size', value: 'Large', normalizedAxis: 'size', normalizedValue: 'large', sourcePath: 'shopify.variants[1].options' } as any], price: '222.22', images: [{ url: 'https://example.com/lg.jpg', role: 'primary', sourcePath: 'shopify.variants[1].image' }] });
    const mini = candidate({ variantKey: 'shopify:4123456003:Mini', title: 'BetterBone Mini', identifiers: [{ kind: 'gtin', value: '810001234503', normalizedValue: '810001234503', sourcePath: 'shopify.variants[2].gtin' } as any, { kind: 'sku', value: 'BB-MINI-001', normalizedValue: 'bb-mini-001', sourcePath: 'shopify.variants[2].sku' } as any, { kind: 'platform_id', value: '4123456003', normalizedValue: '4123456003', sourcePath: 'shopify.variants[2].platform_id' } as any], options: [{ axis: 'size', value: 'Mini', normalizedAxis: 'size', normalizedValue: 'mini', sourcePath: 'shopify.variants[2].options' } as any], price: '333.33', images: [{ url: 'https://example.com/mini.jpg', role: 'primary', sourcePath: 'shopify.variants[2].image' }] });
    const outSm = materializeSelectedVariant({ base, selected: sm, receipt: { variantKey: sm.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    const outLg = materializeSelectedVariant({ base: { ...baseData(), price: '29.99' }, selected: lg, receipt: { variantKey: lg.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    const outMini = materializeSelectedVariant({ base: { ...baseData(), price: '14.99' }, selected: mini, receipt: { variantKey: mini.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    expect(outSm.title).toBe('BetterBone Small');
    expect(outLg.title).toBe('BetterBone Large');
    expect(outMini.title).toBe('BetterBone Mini');
    expect([outSm.price, outLg.price, outMini.price]).toEqual(['9.99', '29.99', '14.99']);
    expect(outSm.primaryImage).toBe('https://example.com/sm.jpg');
    expect(outLg.primaryImage).toBe('https://example.com/lg.jpg');
    expect(outMini.primaryImage).toBe('https://example.com/mini.jpg');
    // distinct identifiers per sibling (P1-4: stored in variantProvenance, not nested under selectedVariant which lacks schema field)
    expect((outSm as any).variantProvenance['identifiers.gtin:810001234501']).toBe('shopify.variants[0].gtin');
    expect((outLg as any).variantProvenance['identifiers.gtin:810001234502']).toBe('shopify.variants[1].gtin');
    expect((outMini as any).variantProvenance['identifiers.gtin:810001234503']).toBe('shopify.variants[2].gtin');
    // variantProvenance per-field sourcePaths — only chosen candidate, never sibling
    expect((outSm as any).variantProvenance['variantAttributes.size']).toBe('shopify.variants[0].options');
    expect((outLg as any).variantProvenance['variantAttributes.size']).toBe('shopify.variants[1].options');
    expect((outSm as any).selectedVariant.variantKey).toBe(sm.variantKey);
    expect((outLg as any).selectedVariant.selectedVariantKey).toBe(lg.variantKey);
  });

  it('large image map variant_ids: selected variant image is primary, sibling excluded', () => {
    const base = baseData();
    const cand = candidate({ images: [{ url: 'https://example.com/sm.jpg', role: 'primary', sourcePath: 'x' }, { url: 'https://example.com/gallery.jpg', role: 'gallery', sourcePath: 'x' }] });
    const out = materializeSelectedVariant({ base, selected: cand, receipt: { variantKey: cand.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    expect(out.primaryImage).toBe('https://example.com/sm.jpg');
    // sibling lg image should not be primary
    expect(out.primaryImage).not.toBe('https://example.com/lg.jpg');
  });

  it('missing variant field leaves base unchanged not copy sibling', () => {
    const base = baseData();
    base.weight = '200g';
    const cand = candidate({ weight: null } as any);
    const out = materializeSelectedVariant({ base, selected: cand, receipt: { variantKey: cand.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    // weight should remain base since candidate has no weight
    expect((out as any).weight).toBe('200g');
  });

  it('base description remains when variant has no description', () => {
    const base = baseData();
    base.description = 'Parent description';
    const cand = candidate();
    const out = materializeSelectedVariant({ base, selected: cand, receipt: { variantKey: cand.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    expect(out.description).toBe('Parent description');
  });

  it('variant weight/dimensions/currency materialized when present', () => {
    const base = baseData();
    const cand = candidate({ weight: '150g', dimensions: '10x5', currency: 'USD', price: '12.34' });
    const out = materializeSelectedVariant({ base, selected: cand, receipt: { variantKey: cand.variantKey, identityMatrixHash: 'a'.repeat(64), parserVersion: 1 } });
    expect((out as any).weight).toBe('150g');
    expect((out as any).dimensions).toBe('10x5');
    expect(out.price).toBe('9.99');
  });
});
