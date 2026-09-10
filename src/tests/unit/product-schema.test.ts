import { describe, it, expect } from 'vitest';
import {
  ProductSchema,
  CoreProductSchema,
  getProductPages,
  addProductPages,
  removeProductPages,
  setProductPages,
  hasProductPage,
  type Product,
} from '../../shared/schemas/product';
import fs from 'fs';
import path from 'path';

describe('Product Schema & productOnPages First-Class Support (Ticket #139)', () => {
  describe('Schema Definition & Parsing', () => {
    it('defaults productOnPages to empty array in CoreProductSchema', () => {
      const parsed = CoreProductSchema.parse({
        name: 'Basic Item',
      });
      expect(parsed.productOnPages).toEqual([]);
    });

    it('defaults productOnPages to empty array in ProductSchema when omitted', () => {
      const rawProduct = {
        schemaVersion: 1,
        id: 'test-omit-pages',
        sku: 'SKU-OMIT-1',
        status: 'active' as const,
        core: {
          name: 'Item without pages',
        },
        customFields: {},
        shopsite: {
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
        },
        metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      };

      const product = ProductSchema.parse(rawProduct);
      expect(product.core.productOnPages).toEqual([]);
    });

    it('preserves explicitly provided productOnPages in schema validation', () => {
      const rawProduct = {
        schemaVersion: 1,
        id: 'test-with-pages',
        sku: 'SKU-PAGES-1',
        status: 'active' as const,
        core: {
          name: 'Item with pages',
          productOnPages: ['Dog Food Dry', 'Puppy Supplies'],
        },
        customFields: {},
        shopsite: {
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
        },
        metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      };

      const product = ProductSchema.parse(rawProduct);
      expect(product.core.productOnPages).toEqual(['Dog Food Dry', 'Puppy Supplies']);
    });

    it('cleanly parses existing real product fixtures from storage/catalog/products without migration friction', () => {
      const catalogProductsDir = path.resolve(import.meta.dirname, '../../../storage/catalog/products');
      if (!fs.existsSync(catalogProductsDir)) {
        return;
      }

      const files = fs.readdirSync(catalogProductsDir).filter(f => f.endsWith('.json')).slice(0, 10);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const filePath = path.join(catalogProductsDir, file);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const validated = ProductSchema.parse(raw);

        expect(validated.sku).toBe(raw.sku);
        expect(validated.core.name).toBe(raw.core.name);
        // Validated productOnPages defaults to array even if absent in raw file
        expect(Array.isArray(validated.core.productOnPages)).toBe(true);
      }
    });
  });

  describe('Helper Utilities: Immutability & Deduplication', () => {
    function createMockProduct(pages: string[] = []): Product {
      return {
        schemaVersion: 1,
        id: 'helper-test',
        sku: 'SKU-HELP',
        status: 'active',
        core: {
          name: 'Helper Test Product',
          price: '10.00',
          salePrice: null,
          description: null,
          inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
          availability: null,
          weight: null,
          taxable: true,
          media: { primary: null, additional: [] },
          seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
          productOnPages: pages,
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
    }

    it('getProductPages returns frozen, deduplicated, trimmed array', () => {
      const prod = createMockProduct(['  Dogs  ', 'Cats', 'Dogs', '']);
      const pages = getProductPages(prod);

      expect(pages).toEqual(['Dogs', 'Cats']);
      expect(Object.isFrozen(pages)).toBe(true);

      // Works with bare core object too
      const fromCore = getProductPages(prod.core);
      expect(fromCore).toEqual(['Dogs', 'Cats']);
    });

    it('addProductPages immutably appends new pages without duplicates', () => {
      const initial = createMockProduct(['Page A', 'Page B']);
      const updated = addProductPages(initial, ['Page B', 'Page C', '  Page D  ']);

      expect(updated).not.toBe(initial);
      expect(updated.core).not.toBe(initial.core);
      expect(initial.core.productOnPages).toEqual(['Page A', 'Page B']); // Original unmodified
      expect(updated.core.productOnPages).toEqual(['Page A', 'Page B', 'Page C', 'Page D']);
    });

    it('removeProductPages immutably removes pages (case-insensitive)', () => {
      const initial = createMockProduct(['Page A', 'Page B', 'Page C']);
      const updated = removeProductPages(initial, ['page b', 'NonExistent']);

      expect(updated).not.toBe(initial);
      expect(initial.core.productOnPages).toEqual(['Page A', 'Page B', 'Page C']); // Original unmodified
      expect(updated.core.productOnPages).toEqual(['Page A', 'Page C']);
    });

    it('setProductPages immutably sets and normalizes pages', () => {
      const initial = createMockProduct(['Old Page']);
      const updated = setProductPages(initial, ['  New 1  ', 'New 2', 'New 1', '']);

      expect(updated).not.toBe(initial);
      expect(initial.core.productOnPages).toEqual(['Old Page']);
      expect(updated.core.productOnPages).toEqual(['New 1', 'New 2']);
    });

    it('hasProductPage performs case-insensitive containment check', () => {
      const prod = createMockProduct(['Dog Treats & Chews', 'Puppy Care']);

      expect(hasProductPage(prod, 'Dog Treats & Chews')).toBe(true);
      expect(hasProductPage(prod, 'dog treats & chews')).toBe(true);
      expect(hasProductPage(prod, 'PUPPY CARE')).toBe(true);
      expect(hasProductPage(prod, 'Cat Food')).toBe(false);
      expect(hasProductPage(prod, '')).toBe(false);
    });
  });
});
