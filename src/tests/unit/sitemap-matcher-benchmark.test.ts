import { describe, test, expect } from 'vitest';
import { findUpcExactHit } from '../../onboarding/sitemap-matcher';

describe('findUpcExactHit Benchmark', () => {
  test('benchmark 10,000 sitemap URLs lookup', () => {
    // Construct a synthetic 10,000 URL sitemap
    const sitemapUrls: string[] = [];
    for (let i = 0; i < 9999; i++) {
      sitemapUrls.push(`https://example.com/products/item-catalog-number-${i}-description-and-details`);
    }
    // Target URL at index 9995 with UPC embedded
    sitemapUrls.push('https://example.com/products/special-item-0850067859598-details');

    const upc = '850067859598';

    // Warmup
    for (let i = 0; i < 5; i++) {
      findUpcExactHit(sitemapUrls, upc);
    }

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const hit = findUpcExactHit(sitemapUrls, upc);
      expect(hit).toBe('https://example.com/products/special-item-0850067859598-details');
    }
    const elapsedMs = performance.now() - start;
    const avgMs = elapsedMs / iterations;

    console.log(`[Benchmark Baseline] findUpcExactHit over 10,000 URLs: total=${elapsedMs.toFixed(2)}ms, avg=${avgMs.toFixed(3)}ms per call`);
  });
});
