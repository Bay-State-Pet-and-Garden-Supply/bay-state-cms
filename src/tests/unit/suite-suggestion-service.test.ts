// story: e07s02
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/onboarding/sitemap-health-evaluator', () => ({
  getDomainSitemapHealth: vi.fn(() => ({ status: 'healthy' })),
}));

vi.mock('@/db/repositories/brand-url-index-repo', () => ({
  findUrlsByDomain: vi.fn(),
  normalizeDomain: (d: string) => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim(),
}));

import { findUrlsByDomain } from '../../db/repositories/brand-url-index-repo';
import { getSuiteSuggestion } from '../../onboarding/suite-suggestion-service';

describe('getSuiteSuggestion — verifier-filtered (e07s02t02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes identical-length spam (acmepet 75799) and keeps first', () => {
    const mockFind = vi.mocked(findUrlsByDomain);
    mockFind.mockReturnValue({
      urls: [
        { url: 'https://acmepet.com/products/a', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T10:00:00Z' } as any,
        { url: 'https://acmepet.com/products/b', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T11:00:00Z' } as any,
        { url: 'https://example.com/products/c', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
      ],
      total: 3,
    });
    const htmlLengths = new Map<string, number>([
      ['https://acmepet.com/products/a', 75799],
      ['https://acmepet.com/products/b', 75799],
      ['https://example.com/products/c', 12345],
    ]);
    const s = getSuiteSuggestion('acmepet.com', { htmlLengths });
    // identical length b should be filtered as spam
    expect(s.filteredCount).toBe(1);
    expect(s.filteredReasons['identical_length_75799']).toBe(1);
    // remaining suggested should include one acmepet and the example product => at least 1 per remaining prefix
    expect(s.suggested).toContain('https://acmepet.com/products/a');
    expect(s.suggested).not.toContain('https://acmepet.com/products/b');
  });

  it('suggests at least one per cluster', () => {
    const mockFind = vi.mocked(findUrlsByDomain);
    mockFind.mockReturnValue({
      urls: [
        { url: 'https://example.com/products/a', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T10:00:00Z' } as any,
        { url: 'https://example.com/products/b', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T11:00:00Z' } as any,
        { url: 'https://example.com/product/1', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
      ],
      total: 3,
    });
    const s = getSuiteSuggestion('example.com');
    // two clusters: /products (2) and /product (1) => at least 2 suggested
    expect(s.clusters.length).toBe(2);
    expect(s.suggested.length).toBeGreaterThanOrEqual(2);
    expect(s.suggested).toEqual(expect.arrayContaining(['https://example.com/products/a', 'https://example.com/product/1']));
  });

  it('filters failed extraction (404/spam) via extraction_status', () => {
    const mockFind = vi.mocked(findUrlsByDomain);
    mockFind.mockReturnValue({
      urls: [
        { url: 'https://example.com/products/good', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T10:00:00Z' } as any,
        { url: 'https://example.com/products/bad', extraction_status: 'failed', last_sitemap_refresh_at: '2026-08-19T10:00:00Z' } as any,
      ],
      total: 2,
    });
    const s = getSuiteSuggestion('example.com');
    expect(s.filteredCount).toBe(1);
    expect(s.filteredReasons['failed_extraction']).toBe(1);
    expect(s.suggested).not.toContain('https://example.com/products/bad');
  });

  it('filters non-product paths like root /, /agents.md, /cart and static files', () => {
    const mockFind = vi.mocked(findUrlsByDomain);
    mockFind.mockReturnValue({
      urls: [
        { url: 'https://earthbath.com/products/no-chew-spray', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T10:00:00Z' } as any,
        { url: 'https://earthbath.com/products/hypo-shampoo', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T11:00:00Z' } as any,
        { url: 'https://earthbath.com/products/ear-wipes', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
        { url: 'https://earthbath.com/agents.md', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
        { url: 'https://earthbath.com/', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
        { url: 'https://earthbath.com/cart', extraction_status: null, last_sitemap_refresh_at: '2026-08-19T12:00:00Z' } as any,
      ],
      total: 6,
    });
    const s = getSuiteSuggestion('earthbath.com');
    // Non-product URLs filtered out
    expect(s.filteredReasons['non_product_path']).toBe(3);
    expect(s.clusters.length).toBe(1);
    expect(s.clusters[0].prefix).toBe('/products');
    // Fills up to 3 distinct product URLs from /products
    expect(s.suggested.length).toBe(3);
    expect(s.suggested).toContain('https://earthbath.com/products/no-chew-spray');
    expect(s.suggested).toContain('https://earthbath.com/products/hypo-shampoo');
    expect(s.suggested).toContain('https://earthbath.com/products/ear-wipes');
    expect(s.suggested).not.toContain('https://earthbath.com/agents.md');
    expect(s.suggested).not.toContain('https://earthbath.com/');
    expect(s.suggested).not.toContain('https://earthbath.com/cart');
  });
});

