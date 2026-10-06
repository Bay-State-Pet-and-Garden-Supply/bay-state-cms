import { describe, it, expect } from 'vitest';
import {
  ShopSiteProductCodec,
  assertNoPreservedCorruption,
  findPreservedCorruption,
} from '../../shopsite/product-codec';
import type { Product } from '../../shared/types';

/**
 * Regression seams for the live-store corruption class: nested blocks that are
 * not leaf scalars must be preserved as RAW XML (never stringified to
 * "[object Object]") and must survive decode → encode byte-for-byte.
 */

const NESTED_PRODUCT = `<Product>
<SKU>SKU-NESTED-1</SKU>
<Name>Nested Block Widget</Name>
<Price>12.99</Price>
<ProductDisabled>uncheck</ProductDisabled>
<ProductType>Tangible</ProductType>
<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>
<QuantityPricing>
<Enabled>uncheck</Enabled>
<NumberPriceBreaks>2</NumberPriceBreaks>
<Comment>Buy more, save more</Comment>
<BackgroundColors>
<QuantityColor>#F6F6F6</QuantityColor>
</BackgroundColors>
<PriceBreaks>
<PriceBreak>
<StartingQuantity>1</StartingQuantity>
<UnitPrice>12.99</UnitPrice>
</PriceBreak>
<PriceBreak>
<StartingQuantity/>
<UnitPrice/>
</PriceBreak>
</PriceBreaks>
</QuantityPricing>
<CrossSell>
<CrossSellItem>
<SKU>SKU-CROSS-1</SKU>
</CrossSellItem>
</CrossSell>
<AddToPages>
<Page>
<Name>Dog Food</Name>
</Page>
</AddToPages>
<OptionMenus>
<OptionMenu>
<Name>Size</Name>
</OptionMenu>
</OptionMenus>
<MoreInfoTitle><![CDATA[Tom & Jerry <b>special</b>]]></MoreInfoTitle>
<ProductID>4242</ProductID>
<ProductGUID>9f1d6b3a-2763-11e1-8033-000347315335</ProductGUID>
</Product>`;

function decodeOne(block: string): Product {
  const doc = `<ShopSiteProducts version="15.0"><Products>${block}</Products></ShopSiteProducts>`;
  const { products } = ShopSiteProductCodec.decode(doc);
  expect(products).toHaveLength(1);
  return products[0];
}

describe('nested block preservation (live-store corruption class)', () => {
  it('captures nested containers as raw blocks, not "[object Object]"', () => {
    const product = decodeOne(NESTED_PRODUCT);
    const blocks = product.shopsite.preserved.advancedBlocks;
    for (const tag of ['QuantityPricing', 'CrossSell', 'AddToPages', 'OptionMenus']) {
      expect(blocks[tag], `${tag} captured raw`).toBeTypeOf('string');
      expect(blocks[tag]).not.toContain('[object Object]');
    }
    expect(product.shopsite.preserved.unknownElements['QuantityPricing']).toBeUndefined();
    expect(findPreservedCorruption(product)).toEqual([]);
  });

  it('raw slices are byte-identical to the source (CDATA, nesting, self-closing children)', () => {
    const product = decodeOne(NESTED_PRODUCT);
    const raw = product.shopsite.preserved.advancedBlocks['QuantityPricing'];
    const expected = NESTED_PRODUCT.match(/<QuantityPricing>[\s\S]*?<\/QuantityPricing>/)![0];
    expect(raw).toBe(expected);
    expect(raw).toContain('<StartingQuantity/>');
    const menus = product.shopsite.preserved.advancedBlocks['OptionMenus'];
    expect(menus).toContain('<OptionMenu>');
  });

  it('re-emits every preserved block verbatim on encode', () => {
    const product = decodeOne(NESTED_PRODUCT);
    const { xml, warnings } = ShopSiteProductCodec.encode(product);
    expect(warnings.filter(w => w.includes('[object Object]'))).toEqual([]);
    expect(xml).not.toContain('[object Object]');
    for (const tag of ['QuantityPricing', 'CrossSell', 'AddToPages', 'OptionMenus']) {
      expect(xml, `${tag} re-emitted`).toContain(`<${tag}>`);
    }
    // Nested structure survives intact (price breaks + empty child).
    expect((xml.match(/<PriceBreak>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<StartingQuantity/>');
    expect(xml).toContain('Buy more, save more');
  });

  it('decode → encode → decode is stable on the domain model', () => {
    const first = decodeOne(NESTED_PRODUCT);
    const second = decodeOne(ShopSiteProductCodec.encode(first).xml);
    expect(second.sku).toBe(first.sku);
    expect(second.core.name).toBe(first.core.name);
    expect(second.shopsite.preserved.advancedBlocks['QuantityPricing'])
      .toBe(first.shopsite.preserved.advancedBlocks['QuantityPricing']);
  });

  it('emits exactly one top-level <ProductType> (no dedicated-emitter duplicate)', () => {
    const product = decodeOne(NESTED_PRODUCT);
    const { xml } = ShopSiteProductCodec.encode(product);
    expect((xml.match(/^  <ProductType>/gm) ?? []).length).toBe(1);
  });

  it('round-trips ShopSite record identity (ProductID / ProductGUID)', () => {
    const product = decodeOne(NESTED_PRODUCT);
    expect(product.shopsite.productId).toBe('4242');
    const { xml } = ShopSiteProductCodec.encode(product);
    expect(xml).toContain('<ProductID>4242</ProductID>');
    expect(xml).toContain('<ProductGUID>9f1d6b3a-2763-11e1-8033-000347315335</ProductGUID>');
  });

  it('emits DisplayMoreInformationPage even without MoreInformationText', () => {
    const bare = decodeOne(`<Product><SKU>S2</SKU><Name>Bare</Name><Price>1.00</Price></Product>`);
    const { xml } = ShopSiteProductCodec.encode(bare);
    expect(xml).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
    expect(xml).not.toContain('<MoreInformationText>');
  });
});

describe('preserved-corruption guard', () => {
  const corrupt = () => {
    const product = decodeOne(NESTED_PRODUCT);
    product.shopsite.preserved.unknownElements['QuantityPricing'] = '[object Object]';
    delete product.shopsite.preserved.advancedBlocks['QuantityPricing'];
    return product;
  };

  it('findPreservedCorruption names the sentinel-bearing bucket', () => {
    expect(findPreservedCorruption(corrupt())).toEqual(['unknownElements:QuantityPricing']);
  });

  it('assertNoPreservedCorruption fails closed with the SKU and tag', () => {
    expect(() => assertNoPreservedCorruption([corrupt()]))
      .toThrow(/preserved_data_corrupted:[\s\S]*SKU-NESTED-1[\s\S]*unknownElements:QuantityPricing/);
    expect(() => assertNoPreservedCorruption([decodeOne(NESTED_PRODUCT)])).not.toThrow();
  });

  it('encode refuses to emit a corrupted preserved value (warns instead)', () => {
    const { xml, warnings } = ShopSiteProductCodec.encode(corrupt());
    expect(xml).not.toContain('[object Object]');
    expect(warnings.some(w => w.includes('QuantityPricing'))).toBe(true);
  });
});
