import { describe, expect, it } from 'vitest';
import type { Product } from '../../shared/types';
import { buildCatalogProductEvidenceInput, computeProductHash } from '../../classification/catalog-product-source';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    schemaVersion: 1,
    id: `id-${overrides.sku ?? 'sku'}`,
    sku: 'SKU-001',
    status: 'active',
    core: {
      name: 'Kaytee Bermuda Grass 16 oz.',
      price: null,
      salePrice: null,
      description: 'Natural Bermuda grass seed for small pets.',
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: '1 lb',
      taxable: true,
      media: {
        primary: 'kaytee/grass.jpg',
        additional: ['kaytee/grass-2.jpg'],
      },
      seo: {
        fileName: 'kaytee-bermuda-grass',
        searchKeywords: 'bermuda grass, pet grass',
        googleProductCategory: null,
      },
      productOnPages: [],
    },
    customFields: {
      ProductField16: 'Kaytee',
      ProductField24: 'Bird Supplies',
    },
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: {
        unknownElements: {
          ProductOnPages: '\n    <Name>Small Animal Habitat</Name>\n    <Name>Pet Grass</Name>\n  ',
        },
        advancedBlocks: {},
        rawAttributes: {},
      },
    },
    metadata: {
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      archivedAt: null,
    },
    ...overrides,
  };
}

describe('catalog-product-source', () => {
  it('builds evidence input from the product’s OWN ProductOnPages only', () => {
    const productA = makeProduct();
    const productB = makeProduct({
      sku: 'SKU-002',
      id: 'id-SKU-002',
      shopsite: {
        ...productA.shopsite,
        preserved: {
          ...productA.shopsite!.preserved,
          unknownElements: {
            ProductOnPages: '\n    <Name>Dog Healthcare</Name>\n  ',
          },
        },
      },
    });

    const sourceA = buildCatalogProductEvidenceInput(productA, '/tmp/ws');
    const sourceB = buildCatalogProductEvidenceInput(productB, '/tmp/ws');

    expect(sourceA.normalizedInput.existingPageNames).toEqual(['Small Animal Habitat', 'Pet Grass']);
    expect(sourceB.normalizedInput.existingPageNames).toEqual(['Dog Healthcare']);

    // Product A never receives Product B's page names, even when the
    // store-wide page list (the legacy `pages` parameter) is supplied.
    const sourceAWithAllPages = buildCatalogProductEvidenceInput(productA, '/tmp/ws', [
      {
        id: 'p-b', name: 'Dog Healthcare', fileName: null, parentId: null, pageHash: 'h',
        workspaceId: null, importId: null, identityKind: 'unverified_name_only', identityKey: null,
        identityStatus: 'unverified', sourceHash: null, availability: 'unavailable', reviewStatus: 'pending',
        lastSyncedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(sourceAWithAllPages.normalizedInput.existingPageNames).toEqual(['Small Animal Habitat', 'Pet Grass']);
  });

  it('includes search keywords and product-side page names in the source hash', () => {
    const base = makeProduct();
    const hashBase = computeProductHash(base);

    const withDifferentKeywords = makeProduct({
      core: {
        ...base.core,
        seo: { fileName: 'k', searchKeywords: 'other keyword', googleProductCategory: null },
      },
    });
    expect(computeProductHash(withDifferentKeywords)).not.toBe(hashBase);

    const withDifferentPages = makeProduct({
      shopsite: {
        ...base.shopsite,
        preserved: {
          ...base.shopsite!.preserved,
          unknownElements: { ProductOnPages: '\n    <Name>Different Page</Name>\n  ' },
        },
      },
    });
    expect(computeProductHash(withDifferentPages)).not.toBe(hashBase);
  });

  it('detects source-hash drift when classification-relevant fields change', () => {
    const product = makeProduct();
    const original = computeProductHash(product);

    const drifted = makeProduct({
      customFields: { ...product.customFields, ProductField25: 'Seeds' },
    });
    expect(computeProductHash(drifted)).not.toBe(original);

    // Identical products hash identically (determinism).
    expect(computeProductHash(makeProduct())).toBe(computeProductHash(makeProduct()));
  });
});
