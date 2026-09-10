import { describe, it, expect } from 'vitest';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { sanitizeXml } from '../../shopsite/xml-sanitizer';
import type { Product } from '../../shared/types';
import fs from 'fs';
import path from 'path';

describe('ShopSite XML Round-trip & Compatibility', () => {
  // Test case 1: Standard mock round-trip verifying no loss on custom fields and preserved tags
  it('should round-trip a complex mock product with zero data loss', () => {
    const mockProduct: Product = {
      schemaVersion: 1,
      id: 'test-id-123',
      sku: 'SKU-COMPAT-99',
      status: 'active',
      core: {
        name: 'Compat Test Product & Accessories <Escaped>',
        price: '99.99',
        salePrice: '79.99',
        description: 'Rigorous CDATA description.',
        inventory: {
          quantityOnHand: 150,
          lowStockThreshold: 10,
          outOfStockLimit: 0,
        },
        availability: 'In Stock',
        weight: '1.2',
        taxable: true,
        media: {
          primary: 'images/primary.jpg',
          additional: ['images/add1.jpg', 'images/add2.jpg'],
        },
        seo: {
          fileName: 'compat-test-product-accessories-escaped.html',
          searchKeywords: 'compat, test, escaping, xml',
          googleProductCategory: 'Pet Supplies',
        },
        productOnPages: [],
      },
      customFields: {
        ProductField1: 'custom-val-1',
        ProductField16: 'Brand Name',
        ProductField24: 'Dog Treats',
        GTIN: '1234567890123',
        GoogleGTIN: '1234567890123',
      },
      shopsite: {
        productId: '99999',
        productGuid: 'guid-99999-uuid',
        xmlVersion: '15.0',
        lastPulledAt: null,
        lastRemoteHash: null,
        lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: {
          unknownElements: {
            AddToPages: '',
            DimensionOptions: '1',
            Template: 'BB-Product.sst',
            DisplayAddToCart: 'All Pages',
          },
          advancedBlocks: {
            ProductOptions: '<ProductOptions><Option>Red</Option><Option>Blue</Option></ProductOptions>',
            ProductOnPages: '<ProductOnPages><PageLink><Name>Dog Treats Shop All</Name></PageLink></ProductOnPages>',
          },
          rawAttributes: {},
        },
      },
      metadata: {
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
        archivedAt: null,
      },
    };

    // 1. Encode into XML through the codec
    const denorm = ShopSiteProductCodec.encode(mockProduct);
    expect(denorm.xml).toBeTruthy();
    expect(denorm.xml).toContain('<SKU>SKU-COMPAT-99</SKU>');
    expect(denorm.xml).toContain('<Price>99.99</Price>');
    expect(denorm.xml).toContain('<SaleAmount>79.99</SaleAmount>');
    expect(denorm.xml).toContain('<Graphic>images/primary.jpg</Graphic>');
    expect(denorm.xml).toContain('<MoreInfoImage1>images/add1.jpg</MoreInfoImage1>');
    expect(denorm.xml).toContain('<MoreInfoImage2>images/add2.jpg</MoreInfoImage2>');
    expect(denorm.xml).toContain('<ProductOptions>');
    expect(denorm.xml).toContain('<ProductOnPages>');
    expect(denorm.xml).toContain('<Name>Dog Treats Shop All</Name>');

    // 2. Decode generated XML back through the codec
    const parsed = ShopSiteProductCodec.decode(denorm.xml);
    expect(parsed.products.length).toBe(1);

    // 3. The decoded domain Product is the round-tripped value
    const roundtripped = parsed.products[0];
    // Legacy advanced-block page assignments decode to first-class pages.
    expect(roundtripped.core.productOnPages).toEqual(['Dog Treats Shop All']);

    // 4. Assert core identities and values match exactly
    expect(roundtripped.sku).toBe(mockProduct.sku);
    expect(roundtripped.core.name).toBe(mockProduct.core.name);
    expect(roundtripped.core.price).toBe(mockProduct.core.price);
    expect(roundtripped.core.salePrice).toBe(mockProduct.core.salePrice);
    expect(roundtripped.core.description).toBe(mockProduct.core.description);
    expect(roundtripped.core.weight).toBe(mockProduct.core.weight);
    expect(roundtripped.core.taxable).toBe(mockProduct.core.taxable);
    expect(roundtripped.core.availability).toBe(mockProduct.core.availability);
    expect(roundtripped.core.media.primary).toBe(mockProduct.core.media.primary);
    expect(roundtripped.core.media.additional).toEqual(mockProduct.core.media.additional);

    // 5. Assert custom fields match exactly
    expect(roundtripped.customFields['ProductField1']).toBe(mockProduct.customFields['ProductField1']);
    expect(roundtripped.customFields['ProductField16']).toBe(mockProduct.customFields['ProductField16']);
    expect(roundtripped.customFields['ProductField24']).toBe(mockProduct.customFields['ProductField24']);
    expect(roundtripped.customFields['GTIN']).toBe(mockProduct.customFields['GTIN']);
    expect(roundtripped.customFields['GoogleGTIN']).toBe(mockProduct.customFields['GoogleGTIN']);

    // 6. Assert preserved unknown elements match exactly
    expect(roundtripped.shopsite.preserved.unknownElements['Template']).toBe('BB-Product.sst');
    expect(roundtripped.shopsite.preserved.unknownElements['DimensionOptions']).toBe('1');
    expect(roundtripped.shopsite.preserved.unknownElements['DisplayAddToCart']).toBe('All Pages');

    // 7. Assert preserved advanced blocks match exactly
    expect(roundtripped.shopsite.preserved.advancedBlocks['ProductOptions']).toContain('<Option>Red</Option>');
  });

  // Test case 1b (#142): multi-page first-class productOnPages round-trip
  it('should round-trip MULTIPLE first-class productOnPages in order with dedup', () => {
    const multiPageProduct: Product = {
      schemaVersion: 1,
      id: 'test-multi-pages',
      sku: 'SKU-MULTI-PAGES',
      status: 'active',
      core: {
        name: 'Multi Page Product',
        price: '29.99',
        salePrice: null,
        description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null,
        weight: null,
        taxable: true,
        media: { primary: null, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: ['Alpha Page', 'Beta Page', 'Alpha Page'],
      },
      customFields: {},
      shopsite: {
        productId: null,
        productGuid: null,
        xmlVersion: '15.0',
        lastPulledAt: null,
        lastRemoteHash: null,
        lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: {
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
        archivedAt: null,
      },
    };

    const encoded = ShopSiteProductCodec.encode(multiPageProduct);
    expect(encoded.xml).toContain('<ProductOnPages>');
    expect(encoded.xml).toContain('<Name>Alpha Page</Name>');
    expect(encoded.xml).toContain('<Name>Beta Page</Name>');

    const decoded = ShopSiteProductCodec.decode(encoded.xml);
    expect(decoded.products.length).toBe(1);
    // Order preserved, duplicates collapsed — the promoter → export contract.
    expect(decoded.products[0].core.productOnPages).toEqual(['Alpha Page', 'Beta Page']);
  });

  // Test case 2 (#143 FIX 5): committed-fixture catalog round-trip. The old
  // machine-local workspace path silently skipped every assertion on CI;
  // this exercises real catalog-shaped data on every machine with zero
  // filesystem assumptions beyond the repo itself — fail-open, never a
  // silent return.
  it('should verify round-trip integrity on the committed ShopSite fixture catalog', () => {
    const fixtureCatalogPath = path.resolve(import.meta.dirname, '../fixtures/shopsite-products-sample.xml');
    expect(fs.existsSync(fixtureCatalogPath)).toBe(true);
    const fixtureCatalogXml = fs.readFileSync(fixtureCatalogPath, 'utf-8');
    const catalogDecoded = ShopSiteProductCodec.decode(fixtureCatalogXml);
    expect(catalogDecoded.products.length).toBeGreaterThan(0);

    // Every decoded fixture product must survive an encode→decode cycle.
    const sampleFiles = catalogDecoded.products;

    for (const originalProduct of sampleFiles) {

      // 1. Encode into XML through the codec
      const denorm = ShopSiteProductCodec.encode(originalProduct);
      expect(denorm.xml).toBeTruthy();
      expect(denorm.xml).toContain(`<SKU>${originalProduct.sku}</SKU>`);

      // 2. Decode back through the codec
      const parsedList = ShopSiteProductCodec.decode(denorm.xml);
      expect(parsedList.products.length).toBe(1);

      // 3. The decoded domain Product is the recreated value
      const recreatedProduct = parsedList.products[0];

      // 4. Audit round-trip accuracy
      expect(recreatedProduct.sku).toBe(originalProduct.sku);
      expect(recreatedProduct.core.name).toBe(originalProduct.core.name);
      expect(recreatedProduct.core.price).toBe(originalProduct.core.price);
      expect(recreatedProduct.core.weight).toBe(originalProduct.core.weight);
      expect(recreatedProduct.core.taxable).toBe(originalProduct.core.taxable);

      // Media checks
      expect(recreatedProduct.core.media.primary).toBe(originalProduct.core.media.primary);
      
      // Compare custom fields
      for (const [key, val] of Object.entries(originalProduct.customFields)) {
        if (key.startsWith('ProductField') && val) {
          expect(recreatedProduct.customFields[key]).toBe(val);
        }
      }

      // Preserved unknown elements check
      for (const [key, val] of Object.entries(originalProduct.shopsite.preserved.unknownElements)) {
        // Skip keys that are normalized/handled dynamically
        if (key === 'ProductOnPages' || key === 'MoreInfoImageExtraSize' || key.startsWith('MoreInfoImageDesc')) {
          continue;
        }
        if (val) {
          expect(recreatedProduct.shopsite.preserved.unknownElements[key]).toBe(val);
        }
      }

      // Preserved advanced blocks checks
      for (const [key, val] of Object.entries(originalProduct.shopsite.preserved.advancedBlocks)) {
        if (key === 'ProductOnPages' || key === 'productOnPages') {
          continue;
        }
        if (val) {
          expect(recreatedProduct.shopsite.preserved.advancedBlocks[key]).toBe(val);
        }
      }
    }
  });

  describe('Explicit Built-in Output Policy & Preservation (Issue #15)', () => {
    const createBaseProduct = (): Product => ({
      schemaVersion: 1,
      id: 'test-builtins-1',
      sku: 'SKU-BUILTIN-1',
      status: 'active',
      core: {
        name: 'Builtin Policy Test Product',
        price: '19.99',
        salePrice: null,
        description: 'Standard product description text.',
        inventory: { quantityOnHand: 10, lowStockThreshold: 2, outOfStockLimit: 0 },
        availability: 'In Stock',
        weight: '0.5',
        taxable: true,
        media: { primary: 'img.jpg', additional: [] },
        seo: { fileName: '', searchKeywords: '', googleProductCategory: '' },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: '100',
        productGuid: 'guid-100',
        xmlVersion: '15.0',
        lastPulledAt: null,
        lastRemoteHash: null,
        lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: {
          unknownElements: {},
          advancedBlocks: {},
          rawAttributes: {},
        },
      },
      metadata: { createdAt: '2026-08-04T00:00:00Z', updatedAt: '2026-08-04T00:00:00Z', archivedAt: null },
    });

    it('should default MinimumQuantity to 0 and ProductType to Tangible when omitted', () => {
      const prod = createBaseProduct();
      const res = ShopSiteProductCodec.encode(prod);
      expect(res.xml).toContain('<MinimumQuantity>0</MinimumQuantity>');
      expect(res.xml).toContain('<ProductType>Tangible</ProductType>');
    });

    it('should preserve non-default MinimumQuantity from customFields or preserved unknownElements', () => {
      const prodCustom = createBaseProduct();
      prodCustom.customFields['MinimumQuantity'] = '5';
      expect(ShopSiteProductCodec.encode(prodCustom).xml).toContain('<MinimumQuantity>5</MinimumQuantity>');

      const prodPreserved = createBaseProduct();
      prodPreserved.shopsite.preserved.unknownElements['MinimumQuantity'] = '10';
      expect(ShopSiteProductCodec.encode(prodPreserved).xml).toContain('<MinimumQuantity>10</MinimumQuantity>');
    });

    it('should preserve explicit ShopSite ProductType and NOT overwrite with internal Primary Product Type', () => {
      const prod = createBaseProduct();
      prod.customFields['ProductType'] = 'Download';
      expect(ShopSiteProductCodec.encode(prod).xml).toContain('<ProductType>Download</ProductType>');
      expect(ShopSiteProductCodec.encode(prod).xml).not.toContain('<ProductType>dog_food_dry</ProductType>');
    });

    it('should preserve explicit custom/preserved FileName and MoreInformationText', () => {
      const prod = createBaseProduct();
      prod.customFields['FileName'] = 'custom-page-name.html';
      prod.customFields['MoreInformationText'] = 'Custom detail text for more info.';
      const res = ShopSiteProductCodec.encode(prod);
      expect(res.xml).toContain('<FileName>custom-page-name.html</FileName>');
      expect(res.xml).toContain('<MoreInformationText><![CDATA[Custom detail text for more info.]]></MoreInformationText>');
    });

    it('should keep descriptions stable across export/import cycles (name-in-ProductDescription convention)', () => {
      const prod = createBaseProduct();
      prod.core.description = 'Long-form catalog copy.';
      const first = ShopSiteProductCodec.encode(prod);
      // Upload shape: NAME in ProductDescription, descriptive copy in
      // MoreInformationText with the More Info page flag enabled.
      expect(first.xml).toContain(`<ProductDescription><![CDATA[${prod.core.name}]]></ProductDescription>`);
      expect(first.xml).toContain('<MoreInformationText><![CDATA[Long-form catalog copy.]]></MoreInformationText>');
      expect(first.xml).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
      // Re-import must not mistake the echoed name for the description.
      const reimported = ShopSiteProductCodec.decode(first.xml).products[0];
      expect(reimported.core.description).toBe('Long-form catalog copy.');
      const second = ShopSiteProductCodec.encode(reimported);
      expect(second.xml).toContain('<ProductDescription><![CDATA[Builtin Policy Test Product]]></ProductDescription>');
      expect(second.xml).toContain('<MoreInformationText><![CDATA[Long-form catalog copy.]]></MoreInformationText>');
      // Legacy exports store the description directly in ProductDescription.
      const legacyXml = '<Product><SKU>L1</SKU><Name>Legacy Prod</Name>'
        + '<ProductDescription><![CDATA[Legacy copy.]]></ProductDescription></Product>';
      const legacy = ShopSiteProductCodec.decode(legacyXml).products[0];
      expect(legacy.core.description).toBe('Legacy copy.');
      const legacyOut = ShopSiteProductCodec.encode(legacy);
      expect(legacyOut.xml).toContain('<ProductDescription><![CDATA[Legacy Prod]]></ProductDescription>');
      expect(legacyOut.xml).toContain('<MoreInformationText><![CDATA[Legacy copy.]]></MoreInformationText>');
    });
  });
});

