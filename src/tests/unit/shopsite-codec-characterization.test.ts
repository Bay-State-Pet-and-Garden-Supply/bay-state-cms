/**
 * Characterization Tests — ShopSite Product XML Codec
 *
 * Issue #137: Pin characterization fixtures & parity tests for ShopSite
 * product XML. These tests capture the EXACT behavior of the current
 * parse → normalize → denormalize pipeline against the repository fixture
 * (`shopsite-products-sample.xml`). Every assertion here is a parity
 * contract that the replacement ShopSiteProductCodec (#140) must satisfy.
 *
 * This file intentionally tests PRODUCTION code with NO modifications.
 */
import { describe, it, expect } from 'vitest';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
import fs from 'fs';
import path from 'path';

// ─── Fixture Loading ────────────────────────────────────────────────────
const fixturePath = path.resolve(import.meta.dirname, '../fixtures/shopsite-products-sample.xml');
const fixtureXml = fs.readFileSync(fixturePath, 'utf-8');

// ─── Helpers ────────────────────────────────────────────────────────────
/**
 * Normalize a parsed product for stable comparison by stripping volatile
 * fields (id, timestamps) that change on every invocation.
 */
function stableProduct(p: ReturnType<typeof normalizeProduct>['product']) {
  return {
    sku: p.sku,
    status: p.status,
    core: p.core,
    customFields: p.customFields,
    shopsite: {
      productId: p.shopsite.productId,
      productGuid: p.shopsite.productGuid,
      xmlVersion: p.shopsite.xmlVersion,
      source: p.shopsite.source,
      preserved: p.shopsite.preserved,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  1. FIXTURE DECODE — Pinned Product objects
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Fixture Decode', () => {
  const parsed = parseProductsXml(fixtureXml);

  it('should detect XML version 15.0', () => {
    expect(parsed.productXmlVersion).toBe('15.0');
  });

  it('should parse exactly 2 products', () => {
    expect(parsed.products.length).toBe(2);
  });

  // ── Dog Food (Product 1) ──
  describe('Dog Food (ABC-123)', () => {
    const { product } = normalizeProduct(parsed.products[0], 'test-workspace');

    it('should decode core identity fields', () => {
      expect(product.sku).toBe('ABC-123');
      expect(product.core.name).toBe('Premium Dog Food');
      expect(product.core.price).toBe('49.99');
      expect(product.status).toBe('active');
    });

    it('should decode salePrice as empty string (empty SaleAmount tag)', () => {
      expect(product.core.salePrice).toBe('');
    });

    it('should decode description from ProductDescription (no MoreInformationText present)', () => {
      expect(product.core.description).toBe('High-quality premium dog food for all breeds.');
    });

    it('should decode inventory', () => {
      expect(product.core.inventory.quantityOnHand).toBe(150);
      expect(product.core.inventory.lowStockThreshold).toBeNull();
      expect(product.core.inventory.outOfStockLimit).toBeNull();
    });

    it('should decode availability', () => {
      expect(product.core.availability).toBe('in_stock');
    });

    it('should decode weight', () => {
      expect(product.core.weight).toBe('30');
    });

    it('should decode taxable as boolean (checked → true)', () => {
      expect(product.core.taxable).toBe(true);
    });

    it('should decode media', () => {
      expect(product.core.media.primary).toBe('media/dog-food.jpg');
      expect(product.core.media.additional).toEqual([]);
    });

    it('should decode SEO fields', () => {
      expect(product.core.seo.fileName).toBeNull();
      expect(product.core.seo.searchKeywords).toBe('dog food, premium, dry food');
      expect(product.core.seo.googleProductCategory).toBe('GTIN:1234567890123');
    });

    it('should decode productOnPages as empty array', () => {
      expect(product.core.productOnPages).toEqual([]);
    });

    it('should decode ProductField* into customFields', () => {
      expect(product.customFields).toEqual({
        ProductField1: 'new060624',
        ProductField16: 'Premium Brands',
        ProductField24: 'Dog Food',
        ProductField25: 'Dry Food',
        GoogleGTIN: '1234567890123',
      });
    });

    it('should have no ShopSite system IDs (not in fixture)', () => {
      expect(product.shopsite.productId).toBeNull();
      expect(product.shopsite.productGuid).toBeNull();
    });

    it('should have empty preserved unknownElements and advancedBlocks', () => {
      expect(product.shopsite.preserved.unknownElements).toEqual({});
      expect(product.shopsite.preserved.advancedBlocks).toEqual({});
    });

    it('should set hasAdvanced = false on parsed product', () => {
      expect(parsed.products[0].hasAdvanced).toBe(false);
    });
  });

  // ── Cat Toy (Product 2) ──
  describe('Cat Toy (XYZ-789)', () => {
    const { product } = normalizeProduct(parsed.products[1], 'test-workspace');

    it('should decode core identity fields', () => {
      expect(product.sku).toBe('XYZ-789');
      expect(product.core.name).toBe('Cat Toy Deluxe');
      expect(product.core.price).toBe('12.99');
      expect(product.core.salePrice).toBe('9.99');
      expect(product.status).toBe('active');
    });

    it('should decode description from ProductDescription (no MoreInformationText present)', () => {
      expect(product.core.description).toBe('A fun toy for your feline friend.');
    });

    it('should decode inventory', () => {
      expect(product.core.inventory.quantityOnHand).toBe(42);
    });

    it('should decode null availability (not in fixture)', () => {
      expect(product.core.availability).toBeNull();
    });

    it('should decode null weight (not in fixture)', () => {
      expect(product.core.weight).toBeNull();
    });

    it('should decode media with additional images (MoreInfoImage1/2)', () => {
      expect(product.core.media.primary).toBe('media/cat-toy.jpg');
      expect(product.core.media.additional).toEqual([
        'media/cat-toy-2.jpg',
        'media/cat-toy-3.jpg',
      ]);
    });

    it('should filter MoreInfoImage* out of unknownElements', () => {
      expect(product.shopsite.preserved.unknownElements['MoreInfoImage1']).toBeUndefined();
      expect(product.shopsite.preserved.unknownElements['MoreInfoImage2']).toBeUndefined();
    });

    it('should decode ProductField* into customFields (no GTIN for this product)', () => {
      expect(product.customFields).toEqual({
        ProductField1: 'new060624',
        ProductField16: 'Fun Pet Co',
        ProductField19: 'Small',
        ProductField24: 'Cat Toys',
      });
    });

    it('should preserve Subproducts as an advanced block', () => {
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toBeDefined();
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toContain('<Subproduct>');
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toContain('XYZ-789-RED');
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toContain('XYZ-789-BLUE');
    });

    it('should set hasAdvanced = true on parsed product', () => {
      expect(parsed.products[1].hasAdvanced).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  2. FIXTURE ENCODE — Pinned XML output strings
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Fixture Encode', () => {
  const parsed = parseProductsXml(fixtureXml);

  describe('Dog Food XML output', () => {
    const { product } = normalizeProduct(parsed.products[0], 'test-workspace');
    const { xml, warnings } = denormalizeProduct(product);

    it('should produce zero warnings', () => {
      expect(warnings).toEqual([]);
    });

    // Pin element-by-element appearance and order
    it('should emit Name (text encoding)', () => {
      expect(xml).toContain('<Name>Premium Dog Food</Name>');
    });

    it('should emit Price (text encoding)', () => {
      expect(xml).toContain('<Price>49.99</Price>');
    });

    it('should NOT emit SaleAmount (omit-empty: salePrice is empty string)', () => {
      expect(xml).not.toContain('<SaleAmount>');
    });

    it('should emit ProductDisabled = uncheck (active status)', () => {
      expect(xml).toContain('<ProductDisabled>uncheck</ProductDisabled>');
    });

    it('should emit MinimumQuantity = 0 (DTD default)', () => {
      expect(xml).toContain('<MinimumQuantity>0</MinimumQuantity>');
    });

    it('should emit Taxable = checked (boolean true)', () => {
      expect(xml).toContain('<Taxable>checked</Taxable>');
    });

    it('should emit SKU (text encoding)', () => {
      expect(xml).toContain('<SKU>ABC-123</SKU>');
    });

    it('should emit Graphic (primary image)', () => {
      expect(xml).toContain('<Graphic>media/dog-food.jpg</Graphic>');
    });

    it('should emit SearchKeywords in CDATA', () => {
      expect(xml).toContain('<SearchKeywords><![CDATA[dog food, premium, dry food]]></SearchKeywords>');
    });

    it('should emit ProductDescription with NAME in CDATA (upload convention)', () => {
      expect(xml).toContain('<ProductDescription><![CDATA[Premium Dog Food]]></ProductDescription>');
    });

    it('should emit Weight (text encoding)', () => {
      expect(xml).toContain('<Weight>30</Weight>');
    });

    it('should emit ProductType = Tangible (DTD default)', () => {
      expect(xml).toContain('<ProductType>Tangible</ProductType>');
    });

    it('should emit QuantityOnHand (numeric as-is)', () => {
      expect(xml).toContain('<QuantityOnHand>150</QuantityOnHand>');
    });

    it('should emit GTIN (derived from GoogleGTIN)', () => {
      expect(xml).toContain('<GTIN>1234567890123</GTIN>');
    });

    it('should emit GoogleGTIN', () => {
      expect(xml).toContain('<GoogleGTIN>1234567890123</GoogleGTIN>');
    });

    it('should emit Availability', () => {
      expect(xml).toContain('<Availability>in_stock</Availability>');
    });

    it('should emit DisplayMoreInformationPage = checked (description present)', () => {
      expect(xml).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
    });

    it('should emit MoreInformationText with description in CDATA', () => {
      expect(xml).toContain('<MoreInformationText><![CDATA[High-quality premium dog food for all breeds.]]></MoreInformationText>');
    });

    it('should emit MoreInformationGraphic (fallback to primary)', () => {
      expect(xml).toContain('<MoreInformationGraphic>media/dog-food.jpg</MoreInformationGraphic>');
    });

    it('should emit FileName (auto-slugged)', () => {
      expect(xml).toContain('<FileName>premium-dog-food.html</FileName>');
    });

    it('should emit ProductField* in numeric sort order', () => {
      expect(xml).toContain('<ProductField1>new060624</ProductField1>');
      expect(xml).toContain('<ProductField16>Premium Brands</ProductField16>');
      expect(xml).toContain('<ProductField24>Dog Food</ProductField24>');
      expect(xml).toContain('<ProductField25>Dry Food</ProductField25>');

      // Verify ordering: PF1 before PF16 before PF24 before PF25
      const pf1Idx = xml.indexOf('<ProductField1>');
      const pf16Idx = xml.indexOf('<ProductField16>');
      const pf24Idx = xml.indexOf('<ProductField24>');
      const pf25Idx = xml.indexOf('<ProductField25>');
      expect(pf1Idx).toBeLessThan(pf16Idx);
      expect(pf16Idx).toBeLessThan(pf24Idx);
      expect(pf24Idx).toBeLessThan(pf25Idx);
    });

    it('should NOT emit any MoreInfoImage slots (no additional images)', () => {
      expect(xml).not.toContain('<MoreInfoImage1>');
      expect(xml).not.toContain('<MoreInfoImage20>');
    });

    it('should NOT emit Subproducts (none on this product)', () => {
      expect(xml).not.toContain('<Subproducts>');
    });
  });

  describe('Cat Toy XML output', () => {
    const { product } = normalizeProduct(parsed.products[1], 'test-workspace');
    const { xml, warnings } = denormalizeProduct(product);

    it('should produce zero warnings', () => {
      expect(warnings).toEqual([]);
    });

    it('should emit Name, Price, SaleAmount', () => {
      expect(xml).toContain('<Name>Cat Toy Deluxe</Name>');
      expect(xml).toContain('<Price>12.99</Price>');
      expect(xml).toContain('<SaleAmount>9.99</SaleAmount>');
    });

    it('should emit ProductDescription with NAME in CDATA', () => {
      expect(xml).toContain('<ProductDescription><![CDATA[Cat Toy Deluxe]]></ProductDescription>');
    });

    it('should emit MoreInformationText with description in CDATA', () => {
      expect(xml).toContain('<MoreInformationText><![CDATA[A fun toy for your feline friend.]]></MoreInformationText>');
    });

    it('should emit MoreInfoImage1 and MoreInfoImage2 (populated additional slots)', () => {
      expect(xml).toContain('<MoreInfoImage1>media/cat-toy-2.jpg</MoreInfoImage1>');
      expect(xml).toContain('<MoreInfoImage2>media/cat-toy-3.jpg</MoreInfoImage2>');
    });

    it('should NOT emit MoreInfoImage3+ (only 2 additional images)', () => {
      expect(xml).not.toContain('<MoreInfoImage3>');
    });

    it('should emit Subproducts advanced block (byte-level preservation)', () => {
      expect(xml).toContain('<Subproducts>');
      expect(xml).toContain('<SKU>XYZ-789-RED</SKU>');
      expect(xml).toContain('<Name>Cat Toy Deluxe Red</Name>');
      expect(xml).toContain('<Price>12.99</Price>');
      expect(xml).toContain('<SKU>XYZ-789-BLUE</SKU>');
      expect(xml).toContain('<Name>Cat Toy Deluxe Blue</Name>');
    });

    it('should NOT emit Availability or Weight (null for this product)', () => {
      expect(xml).not.toContain('<Availability>');
      expect(xml).not.toContain('<Weight>');
    });

    it('should NOT emit SearchKeywords (null for this product)', () => {
      expect(xml).not.toContain('<SearchKeywords>');
    });

    it('should emit FileName (auto-slugged)', () => {
      expect(xml).toContain('<FileName>cat-toy-deluxe.html</FileName>');
    });

    it('should emit ProductField* in numeric sort order', () => {
      expect(xml).toContain('<ProductField1>new060624</ProductField1>');
      expect(xml).toContain('<ProductField16>Fun Pet Co</ProductField16>');
      expect(xml).toContain('<ProductField19>Small</ProductField19>');
      expect(xml).toContain('<ProductField24>Cat Toys</ProductField24>');

      const pf1Idx = xml.indexOf('<ProductField1>');
      const pf16Idx = xml.indexOf('<ProductField16>');
      const pf19Idx = xml.indexOf('<ProductField19>');
      const pf24Idx = xml.indexOf('<ProductField24>');
      expect(pf1Idx).toBeLessThan(pf16Idx);
      expect(pf16Idx).toBeLessThan(pf19Idx);
      expect(pf19Idx).toBeLessThan(pf24Idx);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  3. ROUND-TRIP STABILITY — decode → encode → decode must be idempotent
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Round-trip Stability', () => {
  const parsed = parseProductsXml(fixtureXml);

  // ── Dog Food: known round-trip quirks ──
  describe('Dog Food', () => {
    const { product: first } = normalizeProduct(parsed.products[0], 'test-workspace');
    const { xml: firstXml } = denormalizeProduct(first);

    const reparsed = parseProductsXml(firstXml);
    const { product: second } = normalizeProduct(reparsed.products[0], 'test-workspace');
    const { xml: secondXml } = denormalizeProduct(second);

    it('should produce the same SKU, name, price', () => {
      expect(second.sku).toBe(first.sku);
      expect(second.core.name).toBe(first.core.name);
      expect(second.core.price).toBe(first.core.price);
    });

    // KNOWN QUIRK: empty SaleAmount ("") is omitted on encode, so on re-import
    // the normalizer sees no SaleAmount tag and sets salePrice to null.
    it('should normalize salePrice from "" to null on second pass (known quirk)', () => {
      expect(first.core.salePrice).toBe('');
      expect(second.core.salePrice).toBeNull();
    });

    it('should produce the same description', () => {
      expect(second.core.description).toBe(first.core.description);
    });

    it('should produce the same taxable, weight, availability', () => {
      expect(second.core.taxable).toBe(first.core.taxable);
      expect(second.core.weight).toBe(first.core.weight);
      expect(second.core.availability).toBe(first.core.availability);
    });

    it('should produce the same media', () => {
      expect(second.core.media.primary).toBe(first.core.media.primary);
      expect(second.core.media.additional).toEqual(first.core.media.additional);
    });

    // KNOWN QUIRK: The denormalizer emits both <GTIN> and <GoogleGTIN>.
    // On re-import, the normalizer captures the <GTIN> tag into customFields
    // as a separate key, so second pass has both GTIN and GoogleGTIN.
    it('should add GTIN key to customFields on second pass (known quirk)', () => {
      expect(first.customFields['GTIN']).toBeUndefined();
      expect(second.customFields['GTIN']).toBe('1234567890123');
      // GoogleGTIN stays the same
      expect(second.customFields['GoogleGTIN']).toBe(first.customFields['GoogleGTIN']);
    });

    // KNOWN QUIRK: ProductType accumulates on every round-trip pass because
    // it's not in the parser's coreFields or the denormalizer's blacklist.
    // Each pass adds a duplicate <ProductType> from unknownElements,
    // and fast-xml-parser concatenates them: "Tangible" → "Tangible,Tangible".
    it('should accumulate ProductType on repeated round-trips (known quirk — never stabilizes)', () => {
      const reparsed2 = parseProductsXml(secondXml);
      const { product: third } = normalizeProduct(reparsed2.products[0], 'test-workspace');
      const { xml: thirdXml } = denormalizeProduct(third);
      // Third pass has "Tangible,Tangible" because secondXml already has
      // ProductType emitted from both DTD default and unknownElements
      expect(thirdXml).toContain('<ProductType>Tangible,Tangible</ProductType>');
    });
  });

  // ── Cat Toy: known round-trip quirks ──
  describe('Cat Toy', () => {
    const { product: first } = normalizeProduct(parsed.products[1], 'test-workspace');
    const { xml: firstXml } = denormalizeProduct(first);

    const reparsed = parseProductsXml(firstXml);
    const { product: second } = normalizeProduct(reparsed.products[0], 'test-workspace');
    const { xml: secondXml } = denormalizeProduct(second);

    it('should produce the same SKU, name, price, salePrice', () => {
      expect(second.sku).toBe(first.sku);
      expect(second.core.name).toBe(first.core.name);
      expect(second.core.price).toBe(first.core.price);
      expect(second.core.salePrice).toBe(first.core.salePrice);
    });

    it('should produce the same description', () => {
      expect(second.core.description).toBe(first.core.description);
    });

    it('should produce the same taxable, weight, availability', () => {
      expect(second.core.taxable).toBe(first.core.taxable);
      expect(second.core.weight).toBe(first.core.weight);
      expect(second.core.availability).toBe(first.core.availability);
    });

    it('should produce the same media', () => {
      expect(second.core.media.primary).toBe(first.core.media.primary);
      expect(second.core.media.additional).toEqual(first.core.media.additional);
    });

    it('should produce the same customFields', () => {
      expect(second.customFields).toEqual(first.customFields);
    });

    // KNOWN QUIRK: ProductType is not in the parser's coreFields set,
    // so it's treated as unknown. On re-import after denormalize, it
    // appears in preserved.unknownElements AND is emitted again by
    // the DTD default logic, producing a duplicate <ProductType> tag.
    it('should add ProductType to preserved.unknownElements on second pass (known quirk)', () => {
      expect(first.shopsite.preserved.unknownElements['ProductType']).toBeUndefined();
      expect(second.shopsite.preserved.unknownElements['ProductType']).toBe('Tangible');
    });

    // KNOWN QUIRK: Same ProductType accumulation as Dog Food (see above).
    it('should accumulate ProductType on repeated round-trips (known quirk — never stabilizes)', () => {
      const reparsed2 = parseProductsXml(secondXml);
      const { product: third } = normalizeProduct(reparsed2.products[0], 'test-workspace');
      const { xml: thirdXml } = denormalizeProduct(third);
      expect(thirdXml).toContain('<ProductType>Tangible,Tangible</ProductType>');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  4. UNKNOWN ELEMENT PRESERVATION
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Unknown Element Preservation', () => {
  it('should round-trip arbitrary unknown tags through preserved.unknownElements', () => {
    const xml = `<Product>
      <SKU>UNK-001</SKU>
      <Name>Unknown Tag Test</Name>
      <Template>BB-Product.sst</Template>
      <DimensionOptions>1</DimensionOptions>
      <DisplayAddToCart>All Pages</DisplayAddToCart>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.shopsite.preserved.unknownElements['Template']).toBe('BB-Product.sst');
    expect(product.shopsite.preserved.unknownElements['DimensionOptions']).toBe('1');
    expect(product.shopsite.preserved.unknownElements['DisplayAddToCart']).toBe('All Pages');

    const { xml: roundTripped } = denormalizeProduct(product);
    expect(roundTripped).toContain('<Template>BB-Product.sst</Template>');
    expect(roundTripped).toContain('<DimensionOptions>1</DimensionOptions>');
    expect(roundTripped).toContain('<DisplayAddToCart>All Pages</DisplayAddToCart>');
  });

  it('should NOT emit governed tags from unknownElements (blacklist enforcement)', () => {
    const xml = `<Product>
      <SKU>GOV-001</SKU>
      <Name>Governed Tags</Name>
      <ProductDisabled>uncheck</ProductDisabled>
      <MinimumQuantity>5</MinimumQuantity>
      <Availability>in_stock</Availability>
      <MoreInformationGraphic>img.jpg</MoreInformationGraphic>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);

    // These tags are governed by the denormalizer — they should appear exactly once
    // even though they exist in preserved.unknownElements
    const disabledCount = (output.match(/<ProductDisabled>/g) || []).length;
    expect(disabledCount).toBe(1);
    const minQtyCount = (output.match(/<MinimumQuantity>/g) || []).length;
    expect(minQtyCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  5. ADVANCED BLOCK PRESERVATION
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Advanced Block Preservation', () => {
  it('should preserve Subproducts block through round-trip', () => {
    const parsed = parseProductsXml(fixtureXml);
    const catToyParsed = parsed.products[1];
    expect(catToyParsed.hasAdvanced).toBe(true);
    expect(catToyParsed.advancedBlocks['Subproducts']).toContain('<Subproduct>');

    const { product } = normalizeProduct(catToyParsed, 'test-workspace');
    const { xml } = denormalizeProduct(product);
    expect(xml).toContain('<Subproducts>');
    expect(xml).toContain('XYZ-789-RED');
    expect(xml).toContain('XYZ-789-BLUE');
  });

  it('should preserve ProductOptions block through round-trip', () => {
    const xml = `<Product>
      <SKU>OPT-001</SKU>
      <Name>Options Test</Name>
      <ProductOptions><Option>Red</Option><Option>Blue</Option></ProductOptions>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.shopsite.preserved.advancedBlocks['ProductOptions']).toContain('<Option>Red</Option>');

    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<ProductOptions>');
    expect(output).toContain('<Option>Red</Option>');
    expect(output).toContain('<Option>Blue</Option>');
  });

  it('should extract page names from ProductOnPages advanced block and emit as DTD-compliant PageLink/Name structure', () => {
    const xml = `<Product>
      <SKU>POP-001</SKU>
      <Name>Pages Test</Name>
      <ProductOnPages><PageLink><Name>Dog Treats Shop All</Name></PageLink><PageLink><Name>New Arrivals</Name></PageLink></ProductOnPages>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');

    // ProductOnPages is captured as an advancedBlock
    expect(product.shopsite.preserved.advancedBlocks['ProductOnPages']).toBeDefined();

    const { xml: output } = denormalizeProduct(product);
    // Denormalizer rebuilds with proper PageLink/Name structure
    expect(output).toContain('<ProductOnPages>');
    expect(output).toContain('<PageLink>');
    expect(output).toContain('<Name>Dog Treats Shop All</Name>');
    expect(output).toContain('<Name>New Arrivals</Name>');
    expect(output).toContain('</PageLink>');
    expect(output).toContain('</ProductOnPages>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  6. CDATA WRAPPING
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: CDATA Wrapping', () => {
  it('should wrap ProductDescription in CDATA', () => {
    const xml = `<Product><SKU>CD-01</SKU><Name>CDATA Test</Name></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<ProductDescription><![CDATA[CDATA Test]]></ProductDescription>');
  });

  it('should wrap MoreInformationText in CDATA', () => {
    const xml = `<Product><SKU>CD-02</SKU><Name>MI Test</Name><ProductDescription><![CDATA[Descriptive copy.]]></ProductDescription></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<MoreInformationText><![CDATA[Descriptive copy.]]></MoreInformationText>');
  });

  it('should wrap SearchKeywords in CDATA', () => {
    const xml = `<Product><SKU>CD-03</SKU><Name>KW Test</Name><SearchKeywords><![CDATA[keyword1, keyword2]]></SearchKeywords></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<SearchKeywords><![CDATA[keyword1, keyword2]]></SearchKeywords>');
  });

  it('should NOT use CDATA for text-encoded fields (Name, SKU, Price)', () => {
    const xml = `<Product><SKU>CD-04</SKU><Name>No CDATA</Name><Price>9.99</Price></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<Name>No CDATA</Name>');
    expect(output).toContain('<SKU>CD-04</SKU>');
    expect(output).toContain('<Price>9.99</Price>');
    expect(output).not.toMatch(/<Name><!\[CDATA\[/);
    expect(output).not.toMatch(/<SKU><!\[CDATA\[/);
    expect(output).not.toMatch(/<Price><!\[CDATA\[/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  7. BOOLEAN REPRESENTATIONS
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Boolean Representations', () => {
  it('should use checked/uncheck for Taxable', () => {
    const xmlChecked = `<Product><SKU>BOOL-01</SKU><Name>Taxed</Name><Taxable>checked</Taxable></Product>`;
    const { product: p1 } = normalizeProduct(parseProductsXml(xmlChecked).products[0], 'test-workspace');
    expect(p1.core.taxable).toBe(true);
    expect(denormalizeProduct(p1).xml).toContain('<Taxable>checked</Taxable>');

    const xmlUnchecked = `<Product><SKU>BOOL-02</SKU><Name>Not Taxed</Name><Taxable>uncheck</Taxable></Product>`;
    const { product: p2 } = normalizeProduct(parseProductsXml(xmlUnchecked).products[0], 'test-workspace');
    expect(p2.core.taxable).toBe(false);
    expect(denormalizeProduct(p2).xml).toContain('<Taxable>uncheck</Taxable>');
  });

  it('should use checked/uncheck for ProductDisabled', () => {
    const xmlActive = `<Product><SKU>BOOL-03</SKU><Name>Active</Name><ProductDisabled>uncheck</ProductDisabled></Product>`;
    const { product: p1 } = normalizeProduct(parseProductsXml(xmlActive).products[0], 'test-workspace');
    expect(p1.status).toBe('active');
    expect(denormalizeProduct(p1).xml).toContain('<ProductDisabled>uncheck</ProductDisabled>');

    const xmlDisabled = `<Product><SKU>BOOL-04</SKU><Name>Disabled</Name><ProductDisabled>checked</ProductDisabled></Product>`;
    const { product: p2 } = normalizeProduct(parseProductsXml(xmlDisabled).products[0], 'test-workspace');
    expect(p2.status).toBe('draft');
    expect(denormalizeProduct(p2).xml).toContain('<ProductDisabled>checked</ProductDisabled>');
  });

  it('should use checked/uncheck for DisplayMoreInformationPage', () => {
    const xml = `<Product>
      <SKU>BOOL-05</SKU>
      <Name>Display Flag</Name>
      <MoreInformationText><![CDATA[Some copy.]]></MoreInformationText>
      <DisplayMoreInformationPage>uncheck</DisplayMoreInformationPage>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<DisplayMoreInformationPage>uncheck</DisplayMoreInformationPage>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  8. DTD DEFAULT EMISSIONS
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: DTD Default Emissions', () => {
  const xml = `<Product><SKU>DTD-01</SKU><Name>Minimal Product</Name></Product>`;
  const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
  const { xml: output } = denormalizeProduct(product);

  it('should emit MinimumQuantity = 0 by default', () => {
    expect(output).toContain('<MinimumQuantity>0</MinimumQuantity>');
  });

  it('should emit ProductType = Tangible by default', () => {
    expect(output).toContain('<ProductType>Tangible</ProductType>');
  });

  it('should emit Graphic = none by default (no primary image)', () => {
    expect(output).toContain('<Graphic>none</Graphic>');
  });

  it('should emit MoreInformationGraphic = none by default (no primary image)', () => {
    expect(output).toContain('<MoreInformationGraphic>none</MoreInformationGraphic>');
  });

  // KNOWN QUIRK: MinimumQuantity is in the parser's coreFields set (so it
  // goes to fields, not unknownElements), but the normalizer does NOT extract
  // it into customFields or preserved.unknownElements. The denormalizer then
  // falls back to the DTD default of 0, losing non-default values.
  it('should lose non-default MinimumQuantity from XML on round-trip (known quirk)', () => {
    const xml2 = `<Product><SKU>DTD-02</SKU><Name>MQ Test</Name><MinimumQuantity>5</MinimumQuantity></Product>`;
    const mqParsed = parseProductsXml(xml2).products[0];
    // Parser puts it in fields (coreFields member) but NOT in unknownElements
    expect(mqParsed.fields['MinimumQuantity']).toBe('5');
    expect(mqParsed.unknownElements['MinimumQuantity']).toBeUndefined();

    const { product: p2 } = normalizeProduct(mqParsed, 'test-workspace');
    // Normalizer doesn't capture it anywhere
    expect(p2.customFields['MinimumQuantity']).toBeUndefined();
    expect(p2.shopsite.preserved.unknownElements['MinimumQuantity']).toBeUndefined();

    // Denormalizer falls back to DTD default 0
    const { xml: out2 } = denormalizeProduct(p2);
    expect(out2).toContain('<MinimumQuantity>0</MinimumQuantity>');
  });

  it('should preserve non-default ProductType from customFields', () => {
    const xml2 = `<Product><SKU>DTD-03</SKU><Name>PT Test</Name></Product>`;
    const { product: p2 } = normalizeProduct(parseProductsXml(xml2).products[0], 'test-workspace');
    p2.customFields['ProductType'] = 'Download';
    const { xml: out2 } = denormalizeProduct(p2);
    expect(out2).toContain('<ProductType>Download</ProductType>');
    expect(out2).not.toContain('<ProductType>Tangible</ProductType>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  9. XML ESCAPING
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: XML Escaping', () => {
  it('should escape ampersands in text-encoded fields', () => {
    const xml = `<Product><SKU>ESC-01</SKU><Name>Dog &amp; Cat Supplies</Name><Price>5.99</Price></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.name).toBe('Dog & Cat Supplies');

    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<Name>Dog &amp; Cat Supplies</Name>');
  });

  it('should escape angle brackets in text-encoded fields', () => {
    const xml = `<Product><SKU>ESC-02</SKU><Name>Size 10&lt;12</Name></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('&lt;');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  10. DESCRIPTION CONVENTION (name-in-ProductDescription)
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: Name-in-ProductDescription Convention', () => {
  it('should put product name in ProductDescription, descriptive copy in MoreInformationText', () => {
    const xml = `<Product><SKU>NC-01</SKU><Name>Test Prod</Name>
      <ProductDescription><![CDATA[Test description]]></ProductDescription></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.description).toBe('Test description');

    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<ProductDescription><![CDATA[Test Prod]]></ProductDescription>');
    expect(output).toContain('<MoreInformationText><![CDATA[Test description]]></MoreInformationText>');
    expect(output).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
  });

  it('should treat ProductDescription=Name as no-description on import', () => {
    const xml = `<Product><SKU>NC-02</SKU><Name>Echo Name</Name>
      <ProductDescription><![CDATA[Echo Name]]></ProductDescription></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.description).toBeNull();
  });

  it('should prefer MoreInformationText over ProductDescription for description', () => {
    const xml = `<Product><SKU>NC-03</SKU><Name>Pref Test</Name>
      <ProductDescription><![CDATA[Pref Test]]></ProductDescription>
      <MoreInformationText><![CDATA[The real description.]]></MoreInformationText></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.description).toBe('The real description.');
  });

  it('should omit MoreInformationText when there is no description', () => {
    const xml = `<Product><SKU>NC-04</SKU><Name>No Desc</Name></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.description).toBeNull();

    const { xml: output } = denormalizeProduct(product);
    expect(output).not.toContain('<MoreInformationText>');
    expect(output).not.toContain('<DisplayMoreInformationPage>');
    // ProductDescription still carries the name
    expect(output).toContain('<ProductDescription><![CDATA[No Desc]]></ProductDescription>');
  });

  it('should emit MoreInformationText exactly once (no double-emission)', () => {
    const xml = `<Product><SKU>NC-05</SKU><Name>Single Emit</Name>
      <ProductDescription><![CDATA[Legacy copy]]></ProductDescription>
      <MoreInformationText><![CDATA[Legacy copy]]></MoreInformationText></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect((output.match(/<MoreInformationText>/g) || []).length).toBe(1);
    expect((output.match(/<DisplayMoreInformationPage>/g) || []).length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  11. NUMERIC SKU → GTIN DERIVATION
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: GTIN Derivation', () => {
  it('should derive GTIN from 13-digit numeric SKU', () => {
    const xml = `<Product><SKU>0123456789012</SKU><Name>UPC Product</Name></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<GTIN>0123456789012</GTIN>');
  });

  it('should NOT derive GTIN from non-numeric SKU', () => {
    const xml = `<Product><SKU>ABC-123</SKU><Name>Text SKU</Name></Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    const { xml: output } = denormalizeProduct(product);
    expect(output).not.toContain('<GTIN>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  12. MoreInformationGraphic PRESERVATION
// ═══════════════════════════════════════════════════════════════════════
describe('Characterization: MoreInformationGraphic', () => {
  it('should preserve a distinct MoreInformationGraphic (not same as Graphic)', () => {
    const xml = `<Product>
      <SKU>MIG-01</SKU>
      <Name>Graphic Diff</Name>
      <Graphic>media/thumb.jpg</Graphic>
      <MoreInformationGraphic>media/detail.jpg</MoreInformationGraphic>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    expect(product.core.media.primary).toBe('media/thumb.jpg');
    expect(product.shopsite.preserved.unknownElements['MoreInformationGraphic']).toBe('media/detail.jpg');

    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<Graphic>media/thumb.jpg</Graphic>');
    expect(output).toContain('<MoreInformationGraphic>media/detail.jpg</MoreInformationGraphic>');
  });

  it('should use primary image as MoreInformationGraphic fallback when identical', () => {
    const xml = `<Product>
      <SKU>MIG-02</SKU>
      <Name>Same Graphic</Name>
      <Graphic>media/same.jpg</Graphic>
      <MoreInformationGraphic>media/same.jpg</MoreInformationGraphic>
    </Product>`;
    const { product } = normalizeProduct(parseProductsXml(xml).products[0], 'test-workspace');
    // When same, normalizer does NOT preserve in unknownElements
    expect(product.shopsite.preserved.unknownElements['MoreInformationGraphic']).toBeUndefined();

    // Denormalizer falls back to primary image
    const { xml: output } = denormalizeProduct(product);
    expect(output).toContain('<MoreInformationGraphic>media/same.jpg</MoreInformationGraphic>');
  });
});
