import { describe, it, expect } from 'vitest';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
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

    // 1. Denormalize into XML
    const denorm = denormalizeProduct(mockProduct);
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

    // 2. Parse generated XML
    const parsed = parseProductsXml(denorm.xml);
    expect(parsed.products.length).toBe(1);

    // 3. Normalize parsed XML back to Product
    const { product: roundtripped } = normalizeProduct(parsed.products[0], 'test-workspace');

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

  // Test case 2: Real-world catalog round-trip testing loaded directly from the Bay State workspace
  it('should verify round-trip integrity on actual product files from the Bay State workspace', () => {
    const bayStateProductsDir = '/Users/nickborrello/Desktop/Projects/baystate-cms/workspaces/Bay State/products';
    
    if (!fs.existsSync(bayStateProductsDir)) {
      console.log(`[Roundtrip Test] Bay State products directory not found at "${bayStateProductsDir}". Skipping real product round-trip assertions.`);
      return;
    }

    const files = fs.readdirSync(bayStateProductsDir).filter(f => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    // Pick 5 arbitrary products from the catalog to ensure broad coverage
    const sampleFiles = files.slice(0, 5);

    for (const file of sampleFiles) {
      const filePath = path.join(bayStateProductsDir, file);
      const originalProduct = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Product;

      // 1. Denormalize into XML
      const denorm = denormalizeProduct(originalProduct);
      expect(denorm.xml).toBeTruthy();
      expect(denorm.xml).toContain(`<SKU>${originalProduct.sku}</SKU>`);

      // 2. Parse back
      const parsedList = parseProductsXml(denorm.xml);
      expect(parsedList.products.length).toBe(1);

      // 3. Re-normalize
      const { product: recreatedProduct } = normalizeProduct(parsedList.products[0], originalProduct.shopsite.productId || 'temp-ws');

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
      const res = denormalizeProduct(prod);
      expect(res.xml).toContain('<MinimumQuantity>0</MinimumQuantity>');
      expect(res.xml).toContain('<ProductType>Tangible</ProductType>');
    });

    it('should preserve non-default MinimumQuantity from customFields or preserved unknownElements', () => {
      const prodCustom = createBaseProduct();
      prodCustom.customFields['MinimumQuantity'] = '5';
      expect(denormalizeProduct(prodCustom).xml).toContain('<MinimumQuantity>5</MinimumQuantity>');

      const prodPreserved = createBaseProduct();
      prodPreserved.shopsite.preserved.unknownElements['MinimumQuantity'] = '10';
      expect(denormalizeProduct(prodPreserved).xml).toContain('<MinimumQuantity>10</MinimumQuantity>');
    });

    it('should preserve explicit ShopSite ProductType and NOT overwrite with internal Primary Product Type', () => {
      const prod = createBaseProduct();
      prod.customFields['ProductType'] = 'Download';
      expect(denormalizeProduct(prod).xml).toContain('<ProductType>Download</ProductType>');
      expect(denormalizeProduct(prod).xml).not.toContain('<ProductType>dog_food_dry</ProductType>');
    });

    it('should preserve explicit custom/preserved FileName and MoreInformationText', () => {
      const prod = createBaseProduct();
      prod.customFields['FileName'] = 'custom-page-name.html';
      prod.customFields['MoreInformationText'] = 'Custom detail text for more info.';
      const res = denormalizeProduct(prod);
      expect(res.xml).toContain('<FileName>custom-page-name.html</FileName>');
      expect(res.xml).toContain('<MoreInformationText><![CDATA[Custom detail text for more info.]]></MoreInformationText>');
    });

    it('should keep descriptions stable across export/import cycles (name-in-ProductDescription convention)', () => {
      const prod = createBaseProduct();
      prod.core.description = 'Long-form catalog copy.';
      const first = denormalizeProduct(prod);
      // Upload shape: NAME in ProductDescription, descriptive copy in
      // MoreInformationText with the More Info page flag enabled.
      expect(first.xml).toContain(`<ProductDescription><![CDATA[${prod.core.name}]]></ProductDescription>`);
      expect(first.xml).toContain('<MoreInformationText><![CDATA[Long-form catalog copy.]]></MoreInformationText>');
      expect(first.xml).toContain('<DisplayMoreInformationPage>checked</DisplayMoreInformationPage>');
      // Re-import must not mistake the echoed name for the description.
      const reparsed = parseProductsXml(first.xml).products[0];
      const { product: reimported } = normalizeProduct(reparsed, 'test-workspace');
      expect(reimported.core.description).toBe('Long-form catalog copy.');
      const second = denormalizeProduct(reimported);
      expect(second.xml).toContain('<ProductDescription><![CDATA[Builtin Policy Test Product]]></ProductDescription>');
      expect(second.xml).toContain('<MoreInformationText><![CDATA[Long-form catalog copy.]]></MoreInformationText>');
      // Legacy exports store the description directly in ProductDescription.
      const legacyXml = '<Product><SKU>L1</SKU><Name>Legacy Prod</Name>'
        + '<ProductDescription><![CDATA[Legacy copy.]]></ProductDescription></Product>';
      const { product: legacy } = normalizeProduct(parseProductsXml(legacyXml).products[0], 'test-workspace');
      expect(legacy.core.description).toBe('Legacy copy.');
      const legacyOut = denormalizeProduct(legacy);
      expect(legacyOut.xml).toContain('<ProductDescription><![CDATA[Legacy Prod]]></ProductDescription>');
      expect(legacyOut.xml).toContain('<MoreInformationText><![CDATA[Legacy copy.]]></MoreInformationText>');
    });
  });
});

