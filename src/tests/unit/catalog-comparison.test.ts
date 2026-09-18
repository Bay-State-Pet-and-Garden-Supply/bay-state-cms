import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import {
  buildComparisonProjection,
  buildComparisonContext,
  isComparisonContextStale,
  hashComparisonProjection,
  diffComparisonProjections,
  ensureCatalogComparisonProjectionVersion,
  CATALOG_COMPARISON_PROJECTION_VERSION,
} from '../../shopsite/catalog-comparison';
import { GitClient } from '../../git/git-client';
import { writeProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import type { Product } from '../../shared/types';

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id: 'test-id',
    sku: 'TEST-001',
    status: 'active',
    core: {
      name: 'Test Product',
      price: '19.99',
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
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    ...overrides,
  } as Product;
}

describe('Catalog comparison projection (#252)', () => {
  it('treats missing DTD defaults as equal to explicit defaults across encodings', () => {
    const baselineXml =
      `<Product><SKU>E-001</SKU><Name>Fish &amp; Chips</Name><Price>19.99</Price>` +
      `<ProductDescription><![CDATA[Fish & Chips]]></ProductDescription></Product>`;
    const remoteXml =
      `<Product>\n  <SKU>E-001</SKU>\n  <Name>Fish & Chips</Name>\n  <Price>19.990</Price>\n` +
      `  <MinimumQuantity>0</MinimumQuantity>\n  <ProductType>Tangible</ProductType>\n` +
      `  <Graphic>none</Graphic>\n  <MoreInformationGraphic>none</MoreInformationGraphic>\n` +
      `  <ProductDescription><![CDATA[Fish & Chips]]></ProductDescription>\n</Product>`;
    const baseline = ShopSiteProductCodec.decode(baselineXml).products[0];
    const remote = ShopSiteProductCodec.decode(remoteXml).products[0];
    const bProj = buildComparisonProjection(baseline, { resolvePageIdentity: () => null });
    const rProj = buildComparisonProjection(remote, { resolvePageIdentity: () => null });
    expect(hashComparisonProjection(bProj)).toBe(hashComparisonProjection(rProj));
    expect(diffComparisonProjections(bProj, rProj)).toEqual([]);
  });

  it('produces exactly one hunk for a genuine price change', () => {
    const baseline = makeProduct();
    const remote = makeProduct({ core: { ...makeProduct().core, price: '24.99' } });
    const bProj = buildComparisonProjection(baseline, { resolvePageIdentity: () => null });
    const rProj = buildComparisonProjection(remote, { resolvePageIdentity: () => null });
    const hunks = diffComparisonProjections(bProj, rProj);
    expect(hunks).toEqual([{ field: 'core.price', baselineValue: '19.99', remoteValue: '24.99' }]);
  });

  it('resolves a reviewed alias to canonical but fails closed on ambiguous values', () => {
    const controlledByField = {
      'custom.ProductField16': {
        allowedValues: ['Acme', 'Premium Brands'],
        aliases: [
          { alias: 'premium brands', mapsTo: 'Premium Brands' },
          { alias: 'pb', mapsTo: 'Premium Brands' },
          { alias: 'pb', mapsTo: 'Acme' },
        ],
      },
    };
    const baseline = makeProduct({ customFields: { ProductField16: 'Premium Brands' } });
    const aliasRemote = makeProduct({ customFields: { ProductField16: '  premium BRANDS ' } });
    const bProj = buildComparisonProjection(baseline, { controlledByField, resolvePageIdentity: () => null });
    const aProj = buildComparisonProjection(aliasRemote, { controlledByField, resolvePageIdentity: () => null });
    expect(hashComparisonProjection(bProj)).toBe(hashComparisonProjection(aProj));
    expect(diffComparisonProjections(bProj, aProj)).toEqual([]);

    const ambiguousRemote = makeProduct({ customFields: { ProductField16: 'pb' } });
    const ambProj = buildComparisonProjection(ambiguousRemote, { controlledByField, resolvePageIdentity: () => null });
    const hunks = diffComparisonProjections(bProj, ambProj);
    expect(hunks.length).toBe(1);
    expect(hunks[0].field).toBe('custom.ProductField16');
    expect(hunks[0].baselineValue).toBe('Premium Brands');
  });

  it('treats a page rename as equal with stable identity but drifted without it', () => {
    const baseline = makeProduct({ core: { ...makeProduct().core, productOnPages: ['Old Page'] } });
    const remote = makeProduct({ core: { ...makeProduct().core, productOnPages: ['New Page'] } });
    const stableResolver = (name: string) => {
      if (name === 'Old Page' || name === 'New Page') return 'page-123';
      return null;
    };
    const bStable = buildComparisonProjection(baseline, { resolvePageIdentity: stableResolver });
    const rStable = buildComparisonProjection(remote, { resolvePageIdentity: stableResolver });
    expect(diffComparisonProjections(bStable, rStable)).toEqual([]);

    const bMissing = buildComparisonProjection(baseline, { resolvePageIdentity: () => null });
    const rMissing = buildComparisonProjection(remote, { resolvePageIdentity: () => null });
    const hunks = diffComparisonProjections(bMissing, rMissing);
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.every(h => h.field === 'core.productOnPages')).toBe(true);
  });

  it('preserves unknown data: equal encodings compare equal, changed content hunks', () => {
    const baseline = makeProduct({
      shopsite: {
        ...makeProduct().shopsite,
        preserved: { unknownElements: { CustomTag: 'foo & bar' }, advancedBlocks: {}, rawAttributes: {} },
      },
    });
    const sameEncoding = makeProduct({
      shopsite: {
        ...makeProduct().shopsite,
        preserved: { unknownElements: { CustomTag: 'foo & bar' }, advancedBlocks: {}, rawAttributes: {} },
      },
    });
    const bProj = buildComparisonProjection(baseline, { resolvePageIdentity: () => null });
    const sProj = buildComparisonProjection(sameEncoding, { resolvePageIdentity: () => null });
    expect(hashComparisonProjection(bProj)).toBe(hashComparisonProjection(sProj));

    const changed = makeProduct({
      shopsite: {
        ...makeProduct().shopsite,
        preserved: { unknownElements: { CustomTag: 'different' }, advancedBlocks: {}, rawAttributes: {} },
      },
    });
    const cProj = buildComparisonProjection(changed, { resolvePageIdentity: () => null });
    const hunks = diffComparisonProjections(bProj, cProj);
    expect(hunks.some(h => h.field === 'preserved.unknown:CustomTag')).toBe(true);
  });

  it('pins the baseline to approved Git HEAD, not the dirty working tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-252-'));
    try {
      const git = new GitClient(dir);
      git.init();
      const v1 = makeProduct({ sku: 'PIN-001', core: { ...makeProduct().core, price: '10.00' } });
      v1.sku = 'PIN-001';
      writeProductFile(dir, v1);
      git.add([skuToProductFilePath('PIN-001')]);
      git.commit('v1 approved');
      const head1 = git.getHeadHash();
      expect(head1).toBeTruthy();

      const v2 = makeProduct({ sku: 'PIN-001', core: { ...makeProduct().core, price: '20.00' } });
      v2.sku = 'PIN-001';
      writeProductFile(dir, v2);
      git.add([skuToProductFilePath('PIN-001')]);
      git.commit('v2 approved (unpushed)');
      const head2 = git.getHeadHash();
      expect(head2).not.toBe(head1);

      const headContent = git.readFileAtHead(skuToProductFilePath('PIN-001'));
      expect(headContent).toBeTruthy();
      const headProduct = JSON.parse(headContent!) as Product;
      expect(headProduct.core.price).toBe('20.00');

      fs.writeFileSync(
        path.join(dir, skuToProductFilePath('PIN-001')),
        JSON.stringify({ ...headProduct, core: { ...headProduct.core, price: '99.99' } }),
      );
      expect(git.status().length).toBeGreaterThan(0);
      const stillHead = JSON.parse(git.readFileAtHead(skuToProductFilePath('PIN-001'))!) as Product;
      expect(stillHead.core.price).toBe('20.00');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invalidates stale comparisons via recorded context, not manufactured drift', () => {
    const current = buildComparisonContext('import-hash-a');
    const same = buildComparisonContext('import-hash-a');
    expect(isComparisonContextStale(same, current)).toBe(false);
    const stalePage = buildComparisonContext('import-hash-b');
    expect(isComparisonContextStale(stalePage, current)).toBe(true);
    expect(current.projectionVersion).toBe(CATALOG_COMPARISON_PROJECTION_VERSION);
  });

  it('coordinates projection-version migration without touching dedup keys', () => {
    const touchedKeys: string[] = [];
    const fakeDb = {
      query: (_sql: string) => ({
        get: (...params: unknown[]) => {
          const key = String(params[0] ?? '');
          touchedKeys.push(`read:${key}`);
          if (key === CATALOG_COMPARISON_PROJECTION_VERSION) return undefined;
          return { value: CATALOG_COMPARISON_PROJECTION_VERSION };
        },
      }),
      run: (sql: string, params?: unknown[]) => {
        const key = String(params?.[0] ?? sql);
        touchedKeys.push(`write:${key}`);
      },
    };
    const v1 = ensureCatalogComparisonProjectionVersion(fakeDb as never);
    const v2 = ensureCatalogComparisonProjectionVersion(fakeDb as never);
    expect(v1).toBe(CATALOG_COMPARISON_PROJECTION_VERSION);
    expect(v2).toBe(CATALOG_COMPARISON_PROJECTION_VERSION);
    expect(touchedKeys.some(k => k.toLowerCase().includes('dedup'))).toBe(false);
    expect(touchedKeys.some(k => k.includes('catalog_comparison_projection_version'))).toBe(true);
  });
});
