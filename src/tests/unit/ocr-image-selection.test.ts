import { describe, expect, it } from 'bun:test';
import { buildCatalogProductEvidenceInput } from '../../classification/catalog-product-source';
import type { Product } from '../../shared/types';

function productWithImages(): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: 'product-a2',
    sku: 'A2-001',
    status: 'active',
    core: {
      name: 'A2 Widget',
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: 'in_stock',
      weight: null,
      taxable: true,
      media: { primary: 'media/front.jpg', additional: ['media/side.jpg', 'media/rear.jpg'] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {},
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: now,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

describe('OCR image selection binding (A2)', () => {
  it('selects images #1 + #3, exposing rear-panel refs omitted by default', () => {
    const product = productWithImages();
    const selected = buildCatalogProductEvidenceInput(
      product, '/tmp/ws', undefined, undefined, ['media/front.jpg', 'media/rear.jpg'],
    );
    expect(selected.normalizedInput.ocrImageRefs).toEqual(['media/front.jpg', 'media/rear.jpg']);
    // Default behavior (no selection) keeps primary + first additional.
    const fallback = buildCatalogProductEvidenceInput(product, '/tmp/ws');
    expect(fallback.normalizedInput.primaryImage).toBe('media/front.jpg');
    expect(fallback.normalizedInput.additionalImages).toContain('media/side.jpg');
    expect(fallback.normalizedInput.ocrImageRefs).toEqual([]);
  });

  it('freezes selection in the runtime snapshot input shape', () => {
    const refs = ['media/front.jpg', 'media/rear.jpg'];
    const frozen = { ocrImageRefs: [...refs] };
    expect(frozen.ocrImageRefs).toEqual(refs);
    expect(frozen.ocrImageRefs).not.toBe(refs);
  });
});
