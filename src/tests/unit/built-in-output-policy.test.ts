import { describe, expect, it } from 'vitest';
import { parseProductsXml } from '../../shopsite/product-parser';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
import {
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1,
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
  builtInDefaultValue,
  getBuiltInOutputRule,
  isBuiltInOutputField,
} from '../../shopsite/built-in-output-policy';
import type { Product } from '../../shared/types';

function createRichProduct(): Product {
  return {
    schemaVersion: 1,
    id: 'builtin-policy-1',
    sku: 'SKU-BUILTIN-POLICY',
    status: 'active',
    core: {
      name: 'Builtin Policy Product',
      price: '12.34',
      salePrice: '9.99',
      description: 'A description with <brackets> and ]]>.',
      inventory: { quantityOnHand: 5, lowStockThreshold: 1, outOfStockLimit: 0 },
      availability: 'In Stock',
      weight: '2.5',
      taxable: true,
      media: {
        primary: 'img/primary.jpg',
        additional: [
          'img/add1.jpg', 'img/add2.jpg', 'img/add3.jpg', 'img/add4.jpg', 'img/add5.jpg',
          'img/add6.jpg', 'img/add7.jpg', 'img/add8.jpg', 'img/add9.jpg', 'img/add10.jpg',
          'img/add11.jpg', 'img/add12.jpg', 'img/add13.jpg', 'img/add14.jpg', 'img/add15.jpg',
          'img/add16.jpg', 'img/add17.jpg', 'img/add18.jpg', 'img/add19.jpg', 'img/add20.jpg',
        ],
      },
      seo: { fileName: '', searchKeywords: 'policy, builtin', googleProductCategory: '' },
      productOnPages: [],
    },
    customFields: {
      ProductField1: 'custom-a',
      ProductField24: 'custom-b',
    },
    shopsite: {
      productId: '42',
      productGuid: 'guid-42',
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z', archivedAt: null },
  };
}

function emittedElements(xml: string): string[] {
  const parsed = parseProductsXml(xml);
  if (parsed.products.length === 0) return [];
  const raw = parsed.products[0].rawXml ?? xml;
  const names = new Set<string>();
  const regex = /<([A-Za-z_][A-Za-z0-9_]*)[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    // Exclude XML prolog/declaration and closing tags.
    if (m[1].startsWith('?') || m[1] === 'Product') continue;
    names.add(m[1]);
  }
  return [...names];
}

describe('ShopSite built-in output policy (issue #17 J)', () => {
  it('is versioned and immutable', () => {
    expect(SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION).toBe('shopsite-built-in-output-policy-v1');
    // The policy array AND every rule object must be runtime-frozen: an
    // in-process mutation could otherwise change defaults/membership while
    // provenance records only the version string.
    expect(Object.isFrozen(SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1)).toBe(true);
    for (const rule of SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1) {
      expect(Object.isFrozen(rule)).toBe(true);
    }
  });

  it('enumerates every governed built-in field with a rule', () => {
    const elements = SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1.map(rule => rule.element);
    expect(elements).toEqual(expect.arrayContaining([
      'Name', 'FileName', 'Price', 'SaleAmount', 'ProductDescription',
      'MinimumQuantity', 'ProductType', 'Weight', 'Graphic', 'SearchKeywords',
    ]));
    expect(elements).toContain('MoreInfoImage1');
    expect(elements).toContain('MoreInfoImage20');
    expect(elements).not.toContain('MoreInfoImage21');
    for (const rule of SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1) {
      expect(['text', 'cdata']).toContain(rule.encoding);
      expect(['always', 'omit-empty']).toContain(rule.omission);
      expect(['one', 'zero-or-one']).toContain(rule.cardinality);
    }
  });

  it('captures the ShopSite DTD defaults', () => {
    expect(builtInDefaultValue('MinimumQuantity')).toBe('0');
    expect(builtInDefaultValue('ProductType')).toBe('Tangible');
    expect(builtInDefaultValue('Graphic')).toBe('none');
    expect(builtInDefaultValue('MoreInformationGraphic')).toBe('none');
    expect(builtInDefaultValue('Name')).toBeNull();
    expect(builtInDefaultValue('UnknownField')).toBeNull();
  });

  it('resolves rules and membership exactly', () => {
    expect(getBuiltInOutputRule('Price')?.omission).toBe('omit-empty');
    expect(getBuiltInOutputRule('ProductDescription')?.encoding).toBe('cdata');
    expect(getBuiltInOutputRule('MoreInfoImage7')?.cardinality).toBe('zero-or-one');
    expect(getBuiltInOutputRule('DoesNotExist')).toBeNull();
    expect(isBuiltInOutputField('SearchKeywords')).toBe(true);
    expect(isBuiltInOutputField('ProductField1')).toBe(false);
    expect(isBuiltInOutputField('UnknownField')).toBe(false);
  });

  it('proves every built-in emitted by the denormalizer is declared and no custom ProductField is in the policy', () => {
    const { xml } = denormalizeProduct(createRichProduct());
    // All twenty image slots + core fields populated → every governed built-in
    // appears in the emitted XML.
    for (const element of SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1) {
      if (element.omission === 'omit-empty') continue;
      expect(xml).toContain(`<${element.element}>`);
    }
    const emitted = emittedElements(xml);
    for (const element of SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1) {
      expect(isBuiltInOutputField(element.element)).toBe(true);
    }
    // No ProductField element is governed by the built-in policy.
    for (const element of emitted) {
      if (element.startsWith('ProductField')) {
        expect(isBuiltInOutputField(element)).toBe(false);
      }
    }
    expect(xml).toContain('<MoreInfoImage1>img/add1.jpg</MoreInfoImage1>');
    expect(xml).toContain('<MoreInfoImage20>img/add20.jpg</MoreInfoImage20>');
    expect(xml).not.toContain('<MoreInfoImage21>');
  });

  it('applies omission rules for empty values', () => {
    const product = createRichProduct();
    product.core.salePrice = null;
    product.core.description = '';
    product.core.weight = '';
    product.core.media.primary = '';
    product.core.media.additional = [];
    product.core.seo.searchKeywords = '';
    const { xml } = denormalizeProduct(product);
    expect(xml).not.toContain('<SaleAmount>');
    expect(xml).not.toContain('<Weight>');
    expect(xml).not.toContain('<SearchKeywords>');
    expect(xml).not.toContain('<MoreInfoImage1>');
    // Description is empty → no More Information text or More Info page flag.
    expect(xml).not.toContain('<MoreInformationText>');
    expect(xml).not.toContain('<DisplayMoreInformationPage_>');
    // ProductDescription carries the product NAME per the upload convention.
    expect(xml).toContain('<ProductDescription><![CDATA[Builtin Policy Product]]></ProductDescription>');
    // Always-emitted fields keep their DTD defaults.
    expect(xml).toContain('<MinimumQuantity>0</MinimumQuantity>');
    expect(xml).toContain('<ProductType>Tangible</ProductType>');
    expect(xml).toContain('<Graphic>none</Graphic>');
    expect(xml).toContain('<Name>Builtin Policy Product</Name>');
  });
});
