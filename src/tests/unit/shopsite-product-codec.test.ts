import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ShopSiteProductCodec,
  extractPageNamesFromBlock,
} from '../../shopsite/product-codec';
import type { Product } from '../../shared/types';

const sampleFixturePath = path.resolve(import.meta.dirname, '../fixtures/shopsite-products-sample.xml');
const sampleXml = fs.readFileSync(sampleFixturePath, 'utf-8');

describe('ShopSiteProductCodec (Ticket #140)', () => {
  describe('decode', () => {
    it('handles empty or blank XML gracefully', () => {
      const res = ShopSiteProductCodec.decode('');
      expect(res.products).toHaveLength(0);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain('Empty XML');
    });

    it('decodes xmlVersion and products from complete document', () => {
      const res = ShopSiteProductCodec.decode(sampleXml, { workspaceId: 'ws-codec-test' });
      expect(res.xmlVersion).toBe('15.0');
      expect(res.products).toHaveLength(2);
      expect(res.warnings).toHaveLength(0);

      const dogFood = res.products[0];
      expect(dogFood.sku).toBe('ABC-123');
      expect(dogFood.core.name).toBe('Premium Dog Food');
      expect(dogFood.core.price).toBe('49.99');
      expect(dogFood.customFields['ProductField1']).toBe('new060624');
      expect(dogFood.customFields['ProductField16']).toBe('Premium Brands');
      expect(dogFood.customFields['ProductField24']).toBe('Dog Food');
      expect(dogFood.customFields['ProductField25']).toBe('Dry Food');

      // Registry observations generated
      expect(res.registryObserved.length).toBeGreaterThan(0);
      const skuObs = res.registryObserved.find(r => r.xmlField === 'SKU');
      expect(skuObs).toBeDefined();
      expect(skuObs?.required).toBe(true);
      expect(skuObs?.kind).toBe('core');
    });

    it('populates product.core.productOnPages from modern <PageLink><Name>', () => {
      const xml = `<Product>
  <SKU>MODERN-PAGES-1</SKU>
  <Name>Modern Pages Item</Name>
  <ProductOnPages>
    <PageLink>
      <Name>Cat Supplies</Name>
    </PageLink>
    <PageLink>
      <Name>Toys &amp; Fun</Name>
    </PageLink>
  </ProductOnPages>
</Product>`;

      const res = ShopSiteProductCodec.decode(xml);
      expect(res.products).toHaveLength(1);
      expect(res.products[0].core.productOnPages).toEqual(['Cat Supplies', 'Toys & Fun']);
      expect(res.products[0].shopsite.preserved.advancedBlocks['ProductOnPages']).toContain('<PageLink>');
    });

    it('populates product.core.productOnPages from legacy flat <Name>', () => {
      const xml = `<Product>
  <SKU>LEGACY-PAGES-1</SKU>
  <Name>Legacy Pages Item</Name>
  <ProductOnPages>
    <Name>Dog Collars</Name>
    <Name>Accessories</Name>
  </ProductOnPages>
</Product>`;

      const res = ShopSiteProductCodec.decode(xml);
      expect(res.products).toHaveLength(1);
      expect(res.products[0].core.productOnPages).toEqual(['Dog Collars', 'Accessories']);
    });

    it('preserves advanced blocks (Subproducts, ProductOptions)', () => {
      const res = ShopSiteProductCodec.decode(sampleXml);
      const catToy = res.products[1];
      expect(catToy.shopsite.preserved.advancedBlocks['Subproducts']).toContain('<Subproduct>');
      expect(catToy.shopsite.preserved.advancedBlocks['Subproducts']).toContain('XYZ-789-RED');
    });

    it('preserves unknown XML tags in preserved.unknownElements', () => {
      const xml = `<Product>
  <SKU>UNKNOWN-TAGS-1</SKU>
  <Name>Unknown Tags Item</Name>
  <CustomStoreNotes>Fragile glass</CustomStoreNotes>
  <Template>Custom-V2.sst</Template>
</Product>`;

      const res = ShopSiteProductCodec.decode(xml);
      expect(res.products).toHaveLength(1);
      expect(res.products[0].shopsite.preserved.unknownElements['CustomStoreNotes']).toBe('Fragile glass');
      expect(res.products[0].shopsite.preserved.unknownElements['Template']).toBe('Custom-V2.sst');
    });

    it('decodeOne helper extracts a single product cleanly', () => {
      const xml = `<Product><SKU>ONE-1</SKU><Name>Single Product</Name></Product>`;
      const single = ShopSiteProductCodec.decodeOne(xml);
      expect(single).not.toBeNull();
      expect(single?.product.sku).toBe('ONE-1');
      expect(single?.product.core.name).toBe('Single Product');
    });
  });

  describe('encode', () => {
    it('encodes minimal product with exact DTD order and defaults', () => {
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

      const { xml, warnings } = ShopSiteProductCodec.encode(minimalProduct);
      expect(warnings).toEqual([]);

      const lines = xml.split('\n');
      expect(lines[0]).toBe('<Product>');
      expect(lines[1]).toBe('  <Name>Minimal Test Item</Name>');
      expect(lines[2]).toBe('  <Price>5.00</Price>');
      expect(lines[3]).toBe('  <ProductDisabled>uncheck</ProductDisabled>');
      expect(lines[4]).toBe('  <MinimumQuantity>0</MinimumQuantity>');
      expect(lines[5]).toBe('  <Taxable>checked</Taxable>');
      expect(lines[6]).toBe('  <SKU>MIN-SKU-1</SKU>');
      expect(lines[7]).toBe('  <Graphic>none</Graphic>');
      expect(lines[8]).toBe('  <ProductDescription><![CDATA[Minimal Test Item]]></ProductDescription>');
      expect(lines[9]).toBe('  <ProductType>Tangible</ProductType>');
      expect(lines[10]).toBe('  <MoreInformationGraphic>none</MoreInformationGraphic>');
      expect(lines[11]).toBe('  <FileName>minimal-test-item.html</FileName>');
      expect(lines[12]).toBe('</Product>');
    });

    it('serializes product.core.productOnPages as modern <PageLink><Name>', () => {
      const product: Product = {
        schemaVersion: 1,
        id: 'pages-enc-1',
        sku: 'PAGES-ENC-1',
        status: 'active',
        core: {
          name: 'Pages Enc Item',
          price: '1.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: ['Dog Treats', 'Healthy Snacks & Chews'],
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

      const { xml } = ShopSiteProductCodec.encode(product);
      expect(xml).toContain('  <ProductOnPages>\n    <PageLink>\n      <Name>Dog Treats</Name>\n    </PageLink>\n    <PageLink>\n      <Name>Healthy Snacks &amp; Chews</Name>\n    </PageLink>\n  </ProductOnPages>');
    });

    it('orders custom fields ProductField1..32 with natural numeric sort', () => {
      const customFields: Record<string, string> = {};
      for (let i = 32; i >= 1; i--) {
        customFields[`ProductField${i}`] = `val-${i}`;
      }

      const product: Product = {
        schemaVersion: 1,
        id: 'pf-sort',
        sku: 'PF-SORT',
        status: 'active',
        core: {
          name: 'Sort Test',
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

      const { xml } = ShopSiteProductCodec.encode(product);
      const matches = Array.from(xml.matchAll(/<ProductField(\d+)>/g)).map(m => parseInt(m[1], 10));
      expect(matches.length).toBe(32);
      for (let i = 0; i < 32; i++) {
        expect(matches[i]).toBe(i + 1);
      }
    });

    it('escapes CDATA terminators and sanitizes ampersands properly', () => {
      const product: Product = {
        schemaVersion: 1,
        id: 'cdata-1',
        sku: 'CDATA-1',
        status: 'active',
        core: {
          name: 'Item with CDATA ]]> inside & ampersand',
          price: '2.00',
          salePrice: null,
          description: 'Description with <p>HTML</p> and ]]> marker',
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: 'tags ]]> with ampersand & co', googleProductCategory: null },
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

      const { xml } = ShopSiteProductCodec.encode(product);
      expect(xml).toContain('<![CDATA[Item with CDATA ]]]]><![CDATA[> inside &amp; ampersand]]>');
      expect(xml).toContain('<![CDATA[tags ]]]]><![CDATA[> with ampersand &amp; co]]>');
    });

    it('reports warnings for invalid XML tag names in custom fields', () => {
      const product: Product = {
        schemaVersion: 1,
        id: 'inv-tag',
        sku: 'INV-TAG',
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
          'ProductField 1 with spaces': 'bad-tag',
          'ProductField1': 'good-tag',
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

      const { xml, warnings } = ShopSiteProductCodec.encode(product);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Skipping custom field "ProductField 1 with spaces"');
      expect(xml).toContain('<ProductField1>good-tag</ProductField1>');
      expect(xml).not.toContain('bad-tag');
    });
  });

  describe('encodeMany', () => {
    it('wraps multiple products in complete ShopSiteProducts document', () => {
      const decoded = ShopSiteProductCodec.decode(sampleXml);
      const encoded = ShopSiteProductCodec.encodeMany(decoded.products, { uniquifyFileNames: false });

      expect(encoded.xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(encoded.xml).toContain('<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">');
      expect(encoded.xml).toContain('<ShopSiteProducts version="15.0">');
      expect(encoded.xml).toContain('<Products>');
      expect(encoded.xml).toContain('</Products>');
      expect(encoded.xml).toContain('</ShopSiteProducts>');

      // Verify that both products are included
      expect(encoded.xml).toContain('<SKU>ABC-123</SKU>');
      expect(encoded.xml).toContain('<SKU>XYZ-789</SKU>');
    });
  });

  describe('extractPageNamesFromBlock helper', () => {
    it('parses diverse <ProductOnPages> formats accurately', () => {
      const modernXml = `<ProductOnPages><PageLink><Name>Page One</Name></PageLink><PageLink><Name>Page Two</Name></PageLink></ProductOnPages>`;
      expect(extractPageNamesFromBlock(modernXml)).toEqual(['Page One', 'Page Two']);

      const legacyXml = `<ProductOnPages><Name>Page One</Name><Name>Page Two</Name></ProductOnPages>`;
      expect(extractPageNamesFromBlock(legacyXml)).toEqual(['Page One', 'Page Two']);

      const pageNameXml = `<ProductOnPages><PageName>Page One</PageName></ProductOnPages>`;
      expect(extractPageNamesFromBlock(pageNameXml)).toEqual(['Page One']);

      const textXml = `Page Alpha\nPage Beta`;
      expect(extractPageNamesFromBlock(textXml)).toEqual(['Page Alpha', 'Page Beta']);
    });
  });

  describe('Round-Trip Parity Against Sample Fixture', () => {
    it('round-trips the sample XML fixture with perfect data preservation', () => {
      const decode1 = ShopSiteProductCodec.decode(sampleXml);
      expect(decode1.products).toHaveLength(2);

      const encode1 = ShopSiteProductCodec.encodeMany(decode1.products, { uniquifyFileNames: false });
      const decode2 = ShopSiteProductCodec.decode(encode1.xml);
      expect(decode2.products).toHaveLength(2);

      for (let i = 0; i < decode1.products.length; i++) {
        const p1 = decode1.products[i];
        const p2 = decode2.products[i];
        expect(p2.sku).toBe(p1.sku);
        expect(p2.core.name).toBe(p1.core.name);
        expect(p2.core.price).toBe(p1.core.price);
        if (p1.core.salePrice) {
          expect(p2.core.salePrice).toBe(p1.core.salePrice);
        }
        expect(p2.core.taxable).toBe(p1.core.taxable);
        expect(p2.core.media.primary).toBe(p1.core.media.primary);
        expect(p2.customFields['ProductField16']).toBe(p1.customFields['ProductField16']);
        expect(p2.customFields['GoogleGTIN']).toBe(p1.customFields['GoogleGTIN']);
        expect(p2.shopsite.preserved.advancedBlocks).toEqual(p1.shopsite.preserved.advancedBlocks);
      }
    });
  });
});
