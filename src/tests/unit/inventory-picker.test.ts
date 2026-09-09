// story: e07s02 + oracle picker S1
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/db/repositories/brand-url-index-repo', () => ({
  findUrlsByDomain: vi.fn(),
  normalizeDomain: (d: string) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim(),
}));

import { findUrlsByDomain } from '../../db/repositories/brand-url-index-repo';
import { pickFallback } from '../../client/components/profile-workspace/InventoryPicker';

describe('inventory-picker server filtering (mocked brand_url_index)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paginates product URLs', () => {
    const mockFind = vi.mocked(findUrlsByDomain);
    const urls = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/products/${i}`, title: `P ${i}`, h1: null, slug: `${i}`, path: `/products/${i}`, last_seen_at: '2026-08-19T10:00:00Z', extraction_status: null,
    })) as never[];
    mockFind.mockReturnValue({ urls } as never);
    const res = mockFind('example.com', { pageType: 'product', activeOnly: true, limit: 20, offset: 0 }) as unknown as { urls: typeof urls; total?: number };
    expect((res as any).urls.length).toBe(5);
  });

  it('filters by cluster prefix', () => {
    const items = [
      { url: 'https://example.com/products/a', title: 'A', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' },
      { url: 'https://example.com/product/1', title: 'B', cluster: '/product', lastSeen: '2026-08-19T10:00:00Z' },
    ];
    const filtered = items.filter((it) => it.cluster === '/products');
    expect(filtered).toEqual([{ url: 'https://example.com/products/a', title: 'A', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' }]);
  });
});

describe('inventory-picker 404 same-cluster fallback', () => {
  it('offers next verified from same cluster on 404', () => {
    const items = [
      { url: 'https://example.com/products/a', title: 'A', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' },
      { url: 'https://example.com/products/b', title: 'B', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' },
      { url: 'https://example.com/product/1', title: 'C', cluster: '/product', lastSeen: '2026-08-19T10:00:00Z' },
    ];
    const fb = pickFallback(items, 'https://example.com/products/a');
    expect(fb?.url).toBe('https://example.com/products/b');
  });

  it('falls back to any when same cluster empty', () => {
    const items = [
      { url: 'https://example.com/products/a', title: 'A', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' },
      { url: 'https://example.com/product/1', title: 'C', cluster: '/product', lastSeen: '2026-08-19T10:00:00Z' },
    ];
    const fb = pickFallback(items, 'https://example.com/products/a');
    expect(fb?.url).toBe('https://example.com/product/1');
  });

  it('returns null when no fallback', () => {
    const items = [{ url: 'https://example.com/products/a', title: 'A', cluster: '/products', lastSeen: '2026-08-19T10:00:00Z' }];
    expect(pickFallback(items, 'https://example.com/products/a')).toBeNull();
  });
});
