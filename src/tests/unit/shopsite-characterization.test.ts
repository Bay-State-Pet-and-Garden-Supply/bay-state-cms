import { describe, it, expect } from 'vitest';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
import { buildProductsXml } from '../../shopsite/xml-builder';
import type { Product } from '../../shared/types';
import fs from 'fs';
import path from 'path';

const sampleFixturePath = path.resolve(import.meta.dirname, '../fixtures/shopsite-products-sample.xml');
const sampleFixtureXml = fs.readFileSync(sampleFixturePath, 'utf-8');

describe('ShopSite Product XML Characterization & Baseline Parity Suite (Ticket #137)', () => {
  describe('Fixture 1: Sample Products XML Decoding & Field Extraction', () => {
    it('decodes the version and product count accurately', () => {
      const parsed = parseProductsXml(sampleFixtureXml);
      expect(parsed.productXmlVersion).toBe('15.0');
      expect(parsed.products.length).toBe(2);
    });

    it('pins exact decoded product structure for single-item product (Dog Food)', () => {
      const parsed = parseProductsXml(sampleFixtureXml);
      const dogFoodParsed = parsed.products[0];
      const { product, registryObserved } = normalizeProduct(dogFoodParsed, 'test-workspace');

      // Core properties
      expect(product.sku).toBe('ABC-123');
      expect(product.status).toBe('active');
      expect(product.core.name).toBe('Premium Dog Food');
      expect(product.core.price).toBe('49.99');
      expect(product.core.salePrice).toBe(''); // Empty <SaleAmount></SaleAmount> is parsed as empty string ""
      // ProductDescription differs from Name, so it is extracted as description
      expect(product.core.description).toBe('High-quality premium dog food for all breeds.');
      expect(product.core.taxable).toBe(true);
      expect(product.core.weight).toBe('30');
      expect(product.core.availability).toBe('in_stock');
      expect(product.core.inventory.quantityOnHand).toBe(150);
      expect(product.core.media.primary).toBe('media/dog-food.jpg');
      expect(product.core.media.additional).toEqual([]);
      expect(product.core.seo.searchKeywords).toBe('dog food, premium, dry food');
      expect(product.core.seo.googleProductCategory).toBe('GTIN:1234567890123');

      // Custom fields
      expect(product.customFields['ProductField1']).toBe('new060624');
      expect(product.customFields['ProductField16']).toBe('Premium Brands');
      expect(product.customFields['ProductField24']).toBe('Dog Food');
      expect(product.customFields['ProductField25']).toBe('Dry Food');
      expect(product.customFields['GoogleGTIN']).toBe('1234567890123');

      // Registry observations
      expect(registryObserved.length).toBeGreaterThan(0);
      const skuObs = registryObserved.find(r => r.xmlField === 'SKU');
      expect(skuObs).toBeDefined();
      expect(skuObs?.kind).toBe('core');
      expect(skuObs?.required).toBe(true);

      const pf1Obs = registryObserved.find(r => r.xmlField === 'ProductField1');
      expect(pf1Obs).toBeDefined();
      expect(pf1Obs?.kind).toBe('custom');
      expect(pf1Obs?.dataType).toBe('string');
    });

    it('pins exact decoded product structure for complex product with images and subproducts (Cat Toy)', () => {
      const parsed = parseProductsXml(sampleFixtureXml);
      const catToyParsed = parsed.products[1];
      const { product } = normalizeProduct(catToyParsed, 'test-workspace');

      expect(product.sku).toBe('XYZ-789');
      expect(product.core.name).toBe('Cat Toy Deluxe');
      expect(product.core.price).toBe('12.99');
      expect(product.core.salePrice).toBe('9.99');
      expect(product.core.description).toBe('A fun toy for your feline friend.');
      expect(product.core.inventory.quantityOnHand).toBe(42);
      expect(product.core.media.primary).toBe('media/cat-toy.jpg');
      expect(product.core.media.additional).toEqual([
        'media/cat-toy-2.jpg',
        'media/cat-toy-3.jpg',
      ]);

      // Advanced blocks preserved
      expect(catToyParsed.hasAdvanced).toBe(true);
      expect(catToyParsed.advancedBlocks['Subproducts']).toContain('<Subproduct>');
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toBe(catToyParsed.advancedBlocks['Subproducts']);
    });
  });

  describe('Fixture 2: Serialized XML Byte Emission & Tag Ordering', () => {
    it('pins exact XML emission order and DTD defaults for minimal product', () => {
      const minimalProduct: Product = {
        schemaVersion: 1,
        id: 'min-1',
        sku: 'MIN-SKU-1',
        status: 'active',
        core: {
          name: 'Minimal Test Item',
          price: '5.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const { xml, warnings } = denormalizeProduct(minimalProduct);
      expect(warnings).toEqual([]);

      // Verify exact line presence and DTD defaults
      const lines = xml.split('\n');
      expect(lines[0]).toBe('<Product>');
      expect(lines[1]).toBe('  <Name>Minimal Test Item</Name>');
      expect(lines[2]).toBe('  <Price>5.00</Price>');
      // SaleAmount omitted because null
      expect(lines[3]).toBe('  <ProductDisabled>uncheck</ProductDisabled>');
      expect(lines[4]).toBe('  <MinimumQuantity>0</MinimumQuantity>'); // DTD default
      expect(lines[5]).toBe('  <Taxable>checked</Taxable>');
      expect(lines[6]).toBe('  <SKU>MIN-SKU-1</SKU>');
      expect(lines[7]).toBe('  <Graphic>none</Graphic>'); // DTD default
      // SearchKeywords omitted because null
      expect(lines[8]).toBe('  <ProductDescription><![CDATA[Minimal Test Item]]></ProductDescription>');
      // Weight omitted because null
      expect(lines[9]).toBe('  <ProductType>Tangible</ProductType>'); // DTD default
      // QuantityOnHand omitted because null
      // GTIN omitted because SKU is not purely numeric (8-14 digits)
      // Availability omitted
      // MoreInformationText & DisplayMoreInformationPage omitted because description is null
      expect(lines[10]).toBe('  <MoreInformationGraphic>none</MoreInformationGraphic>'); // DTD default
      // Additional images omitted
      expect(lines[11]).toBe('  <FileName>minimal-test-item.html</FileName>');
      expect(lines[12]).toBe('</Product>');
    });

    it('pins full XML document wrapping with DOCTYPE in buildProductsXml', () => {
      const minimalProduct: Product = {
        schemaVersion: 1,
        id: 'doc-1',
        sku: 'DOC-1',
        status: 'active',
        core: {
          name: 'Doc Test',
          price: '1.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const fullXml = buildProductsXml([minimalProduct], { xmlVersion: '15.0', uniquifyFileNames: false });
      expect(fullXml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(fullXml).toContain('<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">');
      expect(fullXml).toContain('<ShopSiteProducts version="15.0">');
      expect(fullXml).toContain('<Products>');
      expect(fullXml).toContain('</Products>');
      expect(fullXml).toContain('</ShopSiteProducts>');
    });
  });

  describe('Fixture 3: Custom Fields ProductField1..32 Numeric Ordering', () => {
    it('pins canonical numeric sorting for ProductField1 through ProductField32', () => {
      const customFields: Record<string, string> = {};
      // Insert in reverse order to test sorting
      for (let i = 32; i >= 1; i--) {
        customFields[`ProductField${i}`] = `value-${i}`;
      }

      const product: Product = {
        schemaVersion: 1,
        id: 'pf-sort',
        sku: 'PF-SORT-1',
        status: 'active',
        core: {
          name: 'Custom Field Sort Test',
          price: '10.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
        },
        customFields,
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const { xml } = denormalizeProduct(product);

      // Verify that ProductField1 precedes ProductField2 precedes ProductField10 (natural numeric sort)
      const matches = Array.from(xml.matchAll(/<ProductField(\d+)>/g)).map(m => parseInt(m[1], 10));
      expect(matches.length).toBe(32);
      for (let i = 0; i < 32; i++) {
        expect(matches[i]).toBe(i + 1);
      }
    });

    it('emits structured warnings for invalid XML tag names in custom fields', () => {
      const product: Product = {
        schemaVersion: 1,
        id: 'invalid-tag-1',
        sku: 'INV-1',
        status: 'active',
        core: {
          name: 'Invalid Tag Test',
          price: '1.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
        },
        customFields: {
          'ProductField 1 with spaces': 'bad-tag-val',
          'ProductField1': 'valid-val',
        },
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const { xml, warnings } = denormalizeProduct(product);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Skipping custom field "ProductField 1 with spaces"');
      expect(xml).toContain('<ProductField1>valid-val</ProductField1>');
      expect(xml).not.toContain('bad-tag-val');
    });
  });

  describe('Fixture 4: CDATA Wrapping, Escaping & Special Characters', () => {
    it('pins CDATA formatting and termination escaping in descriptive fields', () => {
      const product: Product = {
        schemaVersion: 1,
        id: 'cdata-1',
        sku: 'CDATA-1',
        status: 'active',
        core: {
          name: 'Dog & Cat Bowl <Special> "Quotes"',
          price: '15.00',
          salePrice: null,
          description: 'Long HTML description with <p>tags</p>, ampersand & co, and CDATA end marker ]]> in text.',
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: {
            fileName: null,
            searchKeywords: 'keywords & tags, special <chars>, ]]> inside',
            googleProductCategory: null,
          },
          productOnPages: [],
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const { xml } = denormalizeProduct(product);

      // Name is escaped in text
      expect(xml).toContain('<Name>Dog &amp; Cat Bowl &lt;Special&gt; &quot;Quotes&quot;</Name>');

      // ProductDescription wraps Name in CDATA, and sanitizeXml normalizes & to &amp;
      expect(xml).toContain('<ProductDescription><![CDATA[Dog &amp; Cat Bowl <Special> "Quotes"]]></ProductDescription>');

      // MoreInformationText escapes nested CDATA terminators (]]> becomes ]]]]><![CDATA[>) and unencoded ampersands
      expect(xml).toContain('<MoreInformationText><![CDATA[Long HTML description with <p>tags</p>, ampersand &amp; co, and CDATA end marker ]]]]><![CDATA[> in text.]]></MoreInformationText>');

      // SearchKeywords wraps in CDATA, escapes nested terminators and unencoded ampersands
      expect(xml).toContain('<SearchKeywords><![CDATA[keywords &amp; tags, special <chars>, ]]]]><![CDATA[> inside]]></SearchKeywords>');
    });
  });

  describe('Fixture 5: Category Page Assignments (<ProductOnPages>)', () => {
    it('decodes and serializes Category Page assignments in modern <PageLink><Name> format', () => {
      const xmlWithPages = `<Product>
  <SKU>PAGES-1</SKU>
  <Name>Page Test Item</Name>
  <ProductOnPages>
    <PageLink>
      <Name>Dogs &amp; Puppies</Name>
    </PageLink>
    <PageLink>
      <Name>Natural Pet Care</Name>
    </PageLink>
  </ProductOnPages>
</Product>`;

      const parsed = parseProductsXml(xmlWithPages);
      expect(parsed.products.length).toBe(1);
      const prodParsed = parsed.products[0];
      expect(prodParsed.advancedBlocks['ProductOnPages']).toContain('<PageLink>');

      const { product } = normalizeProduct(prodParsed, 'test-workspace');
      const denorm = denormalizeProduct(product);

      // Verified output format
      expect(denorm.xml).toContain('<ProductOnPages>');
      expect(denorm.xml).toContain('    <PageLink>\n      <Name>Dogs &amp; Puppies</Name>\n    </PageLink>');
      expect(denorm.xml).toContain('    <PageLink>\n      <Name>Natural Pet Care</Name>\n    </PageLink>');
      expect(denorm.xml).toContain('  </ProductOnPages>');
    });

    it('decodes and serializes legacy <ProductOnPages><Name> format into canonical <PageLink><Name>', () => {
      const xmlWithLegacyPages = `<Product>
  <SKU>LEGACY-PAGES-1</SKU>
  <Name>Legacy Page Item</Name>
  <ProductOnPages>
    <Name>Cat Supplies</Name>
    <Name>Dry Food</Name>
  </ProductOnPages>
</Product>`;

      const parsed = parseProductsXml(xmlWithLegacyPages);
      const { product } = normalizeProduct(parsed.products[0], 'test-workspace');
      const denorm = denormalizeProduct(product);

      // Denormalizer emits DTD-compliant PageLink tags even if source was legacy flat Name tags
      expect(denorm.xml).toContain('<ProductOnPages>');
      expect(denorm.xml).toContain('<PageLink>\n      <Name>Cat Supplies</Name>\n    </PageLink>');
      expect(denorm.xml).toContain('<PageLink>\n      <Name>Dry Food</Name>\n    </PageLink>');
    });
  });

  describe('Fixture 6: Advanced Blocks & Unknown Element Preservation', () => {
    it('preserves Subproducts, Options, and unknown XML tags across round-trip', () => {
      const complexXml = `<Product>
  <SKU>ADV-ROUNDTRIP-1</SKU>
  <Name>Advanced Roundtrip Product</Name>
  <DimensionOptions>1</DimensionOptions>
  <Template>BB-Product.sst</Template>
  <DisplayAddToCart>All Pages</DisplayAddToCart>
  <CustomStoreNotes>Handle with care</CustomStoreNotes>
  <ProductOptions>
    <Option name="Size">
      <Value>Small</Value>
      <Value>Large</Value>
    </Option>
  </ProductOptions>
  <Subproducts>
    <Subproduct>
      <SKU>ADV-SUB-1</SKU>
      <Name>Adv Sub 1</Name>
    </Subproduct>
  </Subproducts>
</Product>`;

      const parsed = parseProductsXml(complexXml);
      expect(parsed.products.length).toBe(1);
      const { product } = normalizeProduct(parsed.products[0], 'test-workspace');

      // Preserved unknown elements
      expect(product.shopsite.preserved.unknownElements['DimensionOptions']).toBe('1');
      expect(product.shopsite.preserved.unknownElements['Template']).toBe('BB-Product.sst');
      expect(product.shopsite.preserved.unknownElements['DisplayAddToCart']).toBe('All Pages');
      expect(product.shopsite.preserved.unknownElements['CustomStoreNotes']).toBe('Handle with care');

      // Preserved advanced blocks
      expect(product.shopsite.preserved.advancedBlocks['ProductOptions']).toContain('<Option name="Size">');
      expect(product.shopsite.preserved.advancedBlocks['Subproducts']).toContain('<SKU>ADV-SUB-1</SKU>');

      // Denormalize and verify presence
      const denorm = denormalizeProduct(product);
      expect(denorm.xml).toContain('  <DimensionOptions>1</DimensionOptions>');
      expect(denorm.xml).toContain('  <Template>BB-Product.sst</Template>');
      expect(denorm.xml).toContain('  <DisplayAddToCart>All Pages</DisplayAddToCart>');
      expect(denorm.xml).toContain('  <CustomStoreNotes>Handle with care</CustomStoreNotes>');
      expect(denorm.xml).toContain('<Option name="Size">');
      expect(denorm.xml).toContain('<SKU>ADV-SUB-1</SKU>');
    });
  });

  describe('Fixture 7: Real Export Round-Trip Characterization', () => {
    it('verifies round-trip integrity on sample live store export fixture', () => {
      const exportFixturePath = path.resolve(
        import.meta.dirname,
        '../../../storage/catalog/exports/1389f6a5-9bc1-45b9-9b86-bba35d2e437a/shopsite-products.xml',
      );
      if (!fs.existsSync(exportFixturePath)) {
        return;
      }
      const exportXml = fs.readFileSync(exportFixturePath, 'utf-8');
      const parsed = parseProductsXml(exportXml);
      expect(parsed.products.length).toBe(12);

      for (const p of parsed.products) {
        const { product } = normalizeProduct(p, 'test-workspace');
        const denorm = denormalizeProduct(product);
        // Verify XML serialization contains the SKU and XML-escaped Name
        expect(denorm.xml).toContain(`<SKU>${product.sku}</SKU>`);

        // Re-parse and re-normalize to verify true mathematical round-trip parity
        const reparsed = parseProductsXml(denorm.xml).products[0];
        const { product: reloaded } = normalizeProduct(reparsed, 'test-workspace');

        expect(reloaded.sku).toBe(product.sku);
        expect(reloaded.core.name).toBe(product.core.name);
        expect(reloaded.core.price).toBe(product.core.price);

        // If product had GTIN, verify preservation
        if (product.customFields['GTIN']) {
          expect(reloaded.customFields['GTIN']).toBe(product.customFields['GTIN']);
        }
        // If product had Brand (ProductField16), verify preservation
        if (product.customFields['ProductField16']) {
          expect(reloaded.customFields['ProductField16']).toBe(product.customFields['ProductField16']);
        }
      }
    });

    it('verifies round-trip integrity on actual catalog files from storage/catalog/products', () => {
      const catalogProductsDir = path.resolve(import.meta.dirname, '../../../storage/catalog/products');
      if (!fs.existsSync(catalogProductsDir)) {
        return;
      }
      const files = fs.readdirSync(catalogProductsDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      // Sample 10 real products
      const sampleFiles = files.slice(0, 10);
      for (const file of sampleFiles) {
        const filePath = path.join(catalogProductsDir, file);
        const originalProduct = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Product;

        const denorm = denormalizeProduct(originalProduct);
        expect(denorm.xml).toContain(`<SKU>${originalProduct.sku}</SKU>`);

        const parsed = parseProductsXml(denorm.xml);
        expect(parsed.products.length).toBe(1);

        const { product: reloaded } = normalizeProduct(parsed.products[0], originalProduct.shopsite.productId || 'temp-ws');
        expect(reloaded.sku).toBe(originalProduct.sku);
        expect(reloaded.core.name).toBe(originalProduct.core.name);
        expect(reloaded.core.price).toBe(originalProduct.core.price);
        expect(reloaded.core.weight).toBe(originalProduct.core.weight);
        expect(reloaded.core.taxable).toBe(originalProduct.core.taxable);

        for (const [key, val] of Object.entries(originalProduct.customFields)) {
          if (key.startsWith('ProductField') && val) {
            expect(reloaded.customFields[key]).toBe(val);
          }
        }
      }
    });
  });

  describe('Fixture 8: Boolean Representations and Opt-Out Logic', () => {
    it('pins boolean representation for active vs draft and taxable vs non-taxable', () => {
      const activeTaxable: Product = {
        schemaVersion: 1,
        id: 'bool-1',
        sku: 'BOOL-1',
        status: 'active',
        core: {
          name: 'Active Taxable',
          price: '1.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: [],
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
        metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
      };

      const draftNonTaxable: Product = {
        ...activeTaxable,
        id: 'bool-2',
        sku: 'BOOL-2',
        status: 'draft',
        core: { ...activeTaxable.core, taxable: false },
      };

      const denorm1 = denormalizeProduct(activeTaxable);
      expect(denorm1.xml).toContain('<ProductDisabled>uncheck</ProductDisabled>');
      expect(denorm1.xml).toContain('<Taxable>checked</Taxable>');

      const denorm2 = denormalizeProduct(draftNonTaxable);
      expect(denorm2.xml).toContain('<ProductDisabled>checked</ProductDisabled>');
      expect(denorm2.xml).toContain('<Taxable>uncheck</Taxable>');
    });

    it('pins DisplayMoreInformationPage opt-out variations', () => {
      const optOutValues = ['uncheck', 'unchecked', 'no', '0', 'false'];
      for (const optOut of optOutValues) {
        const prod: Product = {
          schemaVersion: 1,
          id: `opt-${optOut}`,
          sku: `OPT-${optOut}`,
          status: 'active',
          core: {
            name: 'Opt Out Product',
            price: '1.00',
            salePrice: null,
            description: 'Product copy here',
            inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
            availability: null,
            weight: null,
            taxable: true,
            media: { primary: null, additional: [] },
            seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
            productOnPages: [],
          },
          customFields: {
            DisplayMoreInformationPage: optOut,
          },
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
          metadata: { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archivedAt: null },
        };

        const { xml } = denormalizeProduct(prod);
        expect(xml).toContain('<DisplayMoreInformationPage>uncheck</DisplayMoreInformationPage>');
        expect(xml).toContain('<MoreInformationText><![CDATA[Product copy here]]></MoreInformationText>');
      }
    });
  });
});
