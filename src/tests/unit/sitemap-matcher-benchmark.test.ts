import { describe, it, expect } from 'bun:test';
import { matchSitemapUrls } from '../../onboarding/sitemap-matcher';

describe('sitemap-matcher benchmark', () => {
  it('benchmark findUpcExactHit and matchSitemapUrls performance on 30k URLs', async () => {
    const sitemapUrls: string[] = [];
    for (let i = 0; i < 30000; i++) {
      sitemapUrls.push(`https://example-pet-store.com/products/brand-product-title-slug-${i}`);
    }
    // Add one exact UPC match in the middle
    sitemapUrls[15000] = 'https://example-pet-store.com/products/special-item-810001234567-pack';

    const upcs = Array.from({ length: 50 }, (_, i) => `8100012345${(i + 10).toString().padStart(2, '0')}`);

    const start = performance.now();
    for (const upc of upcs) {
      await matchSitemapUrls(sitemapUrls, 'Brand Product Title', null, upc, 'example-pet-store.com');
    }
    const elapsed = performance.now() - start;
    console.log(`[BENCHMARK] 50 UPCs x 30,000 URLs matchSitemapUrls elapsed time: ${elapsed.toFixed(2)}ms`);

    expect(elapsed).toBeGreaterThan(0);
  });
});
