import { describe, expect, it } from 'vitest';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { reconcileBackfillImport } from '../../shopsite/backfill-reconcile';
import type { Product } from '../../shared/types';

function product(sku: string, flavor: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `product-${sku}`,
    sku,
    status: 'active',
    core: {
      name: `Item ${sku}`,
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: 'in_stock',
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: { ProductField1: 'instock060526', ProductField23: flavor },
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

const doc = (products: Product[]): string => ShopSiteProductCodec.encodeMany(products).xml;

describe('backfill import reconciliation (P0 #4)', () => {
  it('marks 12/12 reconciled when live matches the approved upload', () => {
    const skus = Array.from({ length: 12 }, (_, i) => `SKU-${String(i + 1).padStart(2, '0')}`);
    const approved = skus.map(sku => product(sku, 'Salmon'));
    const result = reconcileBackfillImport({
      attemptedSkus: skus,
      outgoingXml: doc(approved),
      freshLiveXml: doc(approved.map(p => ({ ...p }))),
    });
    expect(result.ok).toBe(true);
    expect(result.imported).toEqual(skus);
    expect(result.skipped).toEqual([]);
  });

  it('reports 12 requested/11 present as one unambiguous skip', () => {
    const skus = Array.from({ length: 12 }, (_, i) => `SKU-${String(i + 1).padStart(2, '0')}`);
    const approved = skus.map(sku => product(sku, 'Salmon'));
    const live = approved.slice(0, 11);
    const result = reconcileBackfillImport({
      attemptedSkus: skus,
      outgoingXml: doc(approved),
      freshLiveXml: doc(live),
    });
    expect(result.ok).toBe(false);
    expect(result.imported).toHaveLength(11);
    expect(result.skipped).toEqual(['SKU-12']);
    expect(result.duplicate).toEqual([]);
  });

  it('flags duplicates and value mismatches without leaking values', () => {
    const approved = [product('SKU-01', 'Salmon'), product('SKU-02', 'Salmon')];
    const twin = product('SKU-01', 'Salmon');
    const changed = product('SKU-02', 'Venison');
    const result = reconcileBackfillImport({
      attemptedSkus: ['SKU-01', 'SKU-02'],
      outgoingXml: doc(approved),
      freshLiveXml: doc([twin, product('SKU-01', 'Salmon'), changed]),
    });
    expect(result.ok).toBe(false);
    expect(result.duplicate).toEqual(['SKU-01']);
    expect(result.mismatched.map(m => m.sku)).toEqual(['SKU-02']);
    for (const entry of result.mismatched) {
      expect(entry.fields).toContain('ProductField23');
      expect(JSON.stringify(entry)).not.toContain('Venison');
      expect(JSON.stringify(entry)).not.toContain('Salmon');
    }
  });
});
