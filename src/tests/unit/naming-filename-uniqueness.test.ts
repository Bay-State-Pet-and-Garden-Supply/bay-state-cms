import { describe, it, expect } from 'vitest';
import {
  resolveBaseFileName,
  uniquifyFileNames,
  findDuplicateFileNames,
  slugifyFileName,
  normalizeFileName,
} from '../../shopsite/file-name';
import { denormalizeProduct } from '../../shopsite/product-denormalizer';
import { buildProductsXml } from '../../shopsite/xml-builder';
import { parseProductsXml } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import type { Product } from '../../shared/types';

function makeProduct(overrides: {
  sku?: string;
  name?: string;
  customFileName?: string | null;
  preservedFileName?: string | null;
  seoFileName?: string | null;
} = {}): Product {
  const customFields: Record<string, string> = {};
  if (overrides.customFileName != null) customFields['FileName'] = overrides.customFileName;
  const unknownElements: Record<string, unknown> = {};
  if (overrides.preservedFileName != null) unknownElements['FileName'] = overrides.preservedFileName;
  return {
    schemaVersion: 1,
    id: `id-${overrides.sku ?? 'x'}`,
    sku: overrides.sku ?? 'SKU-X',
    status: 'draft',
    core: {
      name: overrides.name ?? 'Test Product',
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: {
        fileName: overrides.seoFileName ?? null,
        searchKeywords: null,
        googleProductCategory: null,
      },
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
      preserved: { unknownElements, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      archivedAt: null,
    },
  };
}

function fileNameOf(xml: string): string {
  const m = xml.match(/<FileName>([^<]*)<\/FileName>/);
  if (!m) throw new Error('no <FileName> in xml');
  return m[1];
}

describe('resolveBaseFileName precedence (issue #107)', () => {
  it('prefers an explicit customFields FileName', () => {
    const p = makeProduct({
      name: 'Same Name',
      customFileName: 'custom-page.html',
      preservedFileName: 'preserved.html',
      seoFileName: 'seo-slug',
    });
    expect(resolveBaseFileName(p)).toBe('custom-page.html');
  });

  it('falls back to the preserved import value', () => {
    const p = makeProduct({ name: 'Same Name', preservedFileName: 'preserved.html', seoFileName: 'seo-slug' });
    expect(resolveBaseFileName(p)).toBe('preserved.html');
  });

  it('uses the persisted per-source-URL slug before name-slugging', () => {
    const p = makeProduct({ name: 'Brand Product Title', seoFileName: 'brand-product-12345' });
    expect(resolveBaseFileName(p)).toBe('brand-product-12345.html');
  });

  it('slugifies the draft name as the last resort', () => {
    const p = makeProduct({ name: 'Brand Product Title!' });
    expect(resolveBaseFileName(p)).toBe('brand-product-title.html');
    expect(slugifyFileName('Brand Product Title!')).toBe('brand-product-title.html');
  });

  it('falls back to the SKU when the name has no slug content', () => {
    expect(resolveBaseFileName(makeProduct({ sku: 'SKU-1', name: '!!!' }))).toBe('sku-1.html');
    expect(normalizeFileName('.html')).toBeNull();
    expect(normalizeFileName('  ')).toBeNull();
  });

  it('denormalizer ignores blank or extensionless stored values consistently', () => {
    const blank = makeProduct({ name: 'Real Name', customFileName: '   ' });
    expect(fileNameOf(denormalizeProduct(blank).xml)).toBe('real-name.html');
    const noExt = makeProduct({ name: 'Real Name', preservedFileName: 'custom-page' });
    expect(fileNameOf(denormalizeProduct(noExt).xml)).toBe('custom-page.html');
    const upper = makeProduct({ name: 'Real Name', preservedFileName: 'Custom-Page.HTML' });
    expect(fileNameOf(denormalizeProduct(upper).xml)).toBe('Custom-Page.HTML');
  });
});

describe('uniquifyFileNames (issue #107)', () => {
  it('gives N identical names N distinct file names, deterministically', () => {
    const entries = [
      { key: 'UPC-C', fileName: 'same-product.html' },
      { key: 'UPC-A', fileName: 'same-product.html' },
      { key: 'UPC-B', fileName: 'same-product.html' },
    ];
    const first = uniquifyFileNames(entries);
    const second = uniquifyFileNames([...entries].reverse());
    expect([...first.values()].sort()).toEqual(['same-product-2.html', 'same-product-3.html', 'same-product.html']);
    // Order-independent: same assignment regardless of input order
    expect([...second.values()].sort()).toEqual([...first.values()].sort());
    expect(second.get('UPC-A')).toBe(first.get('UPC-A'));
  });

  it('keeps distinct names untouched', () => {
    const out = uniquifyFileNames([
      { key: 'A', fileName: 'alpha.html' },
      { key: 'B', fileName: 'beta.html' },
    ]);
    expect(out.get('A')).toBe('alpha.html');
    expect(out.get('B')).toBe('beta.html');
  });

  it('treats case-folded collisions as duplicates', () => {
    const out = uniquifyFileNames([
      { key: 'A', fileName: 'Foo-Bar.html' },
      { key: 'B', fileName: 'foo-bar.html' },
    ]);
    const values = [...out.values()];
    expect(new Set(values.map(v => v.toLowerCase())).size).toBe(2);
  });

  it('keeps truncation-collapsed names distinct within the stem limit', () => {
    const longA = 'x'.repeat(100) + '-variant-a';
    const longB = 'x'.repeat(100) + '-variant-b';
    const fa = slugifyFileName(longA);
    const fb = slugifyFileName(longB);
    // Precondition: both slug identically (truncation collapse)
    expect(fa).toBe(fb);
    const out = uniquifyFileNames([
      { key: 'A', fileName: fa },
      { key: 'B', fileName: fb },
    ]);
    const values = [...out.values()];
    expect(new Set(values).size).toBe(2);
    for (const v of values) {
      expect(v.endsWith('.html')).toBe(true);
      expect(v.replace(/\.html$/, '').length).toBeLessThanOrEqual(80);
    }
  });

  it('respects already-taken catalog names', () => {
    const out = uniquifyFileNames(
      [{ key: 'NEW', fileName: 'live-product.html' }],
      ['live-product.html'],
    );
    expect(out.get('NEW')).not.toBe('live-product.html');
    expect(out.get('NEW')).toBe('live-product-2.html');
  });
});

describe('findDuplicateFileNames (issue #107)', () => {
  it('reports collision groups with member keys', () => {
    const groups = findDuplicateFileNames([
      { key: 'A', fileName: 'same.html' },
      { key: 'B', fileName: 'SAME.html' },
      { key: 'C', fileName: 'other.html' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fileName.toLowerCase()).toBe('same.html');
    expect([...groups[0].keys].sort()).toEqual(['A', 'B']);
  });

  it('returns no groups when all names are unique', () => {
    expect(findDuplicateFileNames([
      { key: 'A', fileName: 'a.html' },
      { key: 'B', fileName: 'b.html' },
    ])).toEqual([]);
  });
});

describe('buildProductsXml batch uniqueness (issue #107)', () => {
  it('exports distinct FileNames for same-named products', () => {
    const products = ['UPC-1', 'UPC-2', 'UPC-3'].map(sku =>
      makeProduct({ sku, name: 'Identical Product Name' }),
    );
    const xml = buildProductsXml(products);
    const names = [...xml.matchAll(/<FileName>([^<]*)<\/FileName>/g)].map(m => m[1]);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it('leaves a single product filename unchanged', () => {
    const xml = buildProductsXml([makeProduct({ sku: 'UPC-1', name: 'Lone Product' })]);
    expect(fileNameOf(xml)).toBe('lone-product.html');
  });

  it('keeps even duplicate-SKU products distinct (fails closed downstream)', () => {
    const xml = buildProductsXml([
      makeProduct({ sku: 'SAME-SKU', name: 'Dup Name' }),
      makeProduct({ sku: 'SAME-SKU', name: 'Dup Name' }),
    ]);
    const names = [...xml.matchAll(/<FileName>([^<]*)<\/FileName>/g)].map(m => m[1]);
    expect(new Set(names).size).toBe(2);
  });
});

describe('healed FileName round-trip (issue #107)', () => {
  it('preserves a healed FileName across export and re-import', () => {
    const healed = makeProduct({ sku: 'UPC-9', name: 'Same Name', customFileName: 'same-name-2.html' });
    const first = denormalizeProduct(healed);
    expect(fileNameOf(first.xml)).toBe('same-name-2.html');

    const parsed = parseProductsXml(first.xml);
    expect(parsed.products).toHaveLength(1);
    const { product: reimported } = normalizeProduct(parsed.products[0], 'ws-test');
    const second = denormalizeProduct(reimported);
    expect(fileNameOf(second.xml)).toBe('same-name-2.html');
  });
});
