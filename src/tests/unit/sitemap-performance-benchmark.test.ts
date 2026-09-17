import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { matchSitemapUrls } from '../../onboarding/sitemap-matcher';
import {
  reconcileSitemapUrls,
  indexVariantUrls,
  lookupByUpc,
  type VariantUrlInput,
} from '../../db/repositories/brand-url-index-repo';

describe('Sitemap & Brand URL Index Performance Benchmark', () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-benchmark-'));
    dbPath = path.join(tempDir, 'bench.db');
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('benchmark matchSitemapUrls on 20,000 URLs workload', async () => {
    // Generate 20,000 sitemap URLs with realistic product path slugs
    const sitemapUrls = Array.from(
      { length: 20000 },
      (_, i) => `https://example.com/products/kibble-formula-item-${i}-spec-v${i % 10}`,
    );
    const upc = '0850067859598';
    const itemName = 'Super Kibble Premium Formula 15lb';
    const domain = 'example.com';

    // Warm-up run
    await matchSitemapUrls(sitemapUrls, itemName, null, upc, domain, null, null);

    const runs = 20;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      const results = await matchSitemapUrls(sitemapUrls, itemName, null, upc, domain, null, null);
      expect(Array.isArray(results)).toBe(true);
    }
    const totalMs = performance.now() - start;
    const avgMsPerCall = totalMs / runs;

    console.log(
      `[Benchmark] matchSitemapUrls (${runs} runs over 20,000 URLs): ` +
        `total ${totalMs.toFixed(2)} ms, avg ${avgMsPerCall.toFixed(2)} ms/call`,
    );

    expect(avgMsPerCall).toBeGreaterThan(0);
  });

  it('benchmark reconcileSitemapUrls on 5,000 new URLs workload', () => {
    const domain = 'benchmark-brand.com';
    const observedUrls = Array.from({ length: 5000 }, (_, i) => ({
      url: `https://benchmark-brand.com/products/product-item-${i}-page`,
      lastmod: '2025-01-01T00:00:00Z',
    }));

    const start = performance.now();
    const result = reconcileSitemapUrls(
      domain,
      observedUrls,
      'https://benchmark-brand.com/sitemap.xml',
    );
    const elapsedMs = performance.now() - start;

    expect(result.addedCount).toBe(5000);
    expect(result.totalActiveCount).toBe(5000);

    // Verify DB integrity
    const countRow = getDb()
      .query('SELECT COUNT(*) as count FROM brand_url_index WHERE domain = ?')
      .get('benchmark-brand.com') as { count: number };
    expect(countRow.count).toBe(5000);

    const ftsRow = getDb()
      .query('SELECT COUNT(*) as count FROM brand_url_fts WHERE domain = ?')
      .get('benchmark-brand.com') as { count: number };
    expect(ftsRow.count).toBe(5000);

    console.log(
      `[Benchmark] reconcileSitemapUrls (5,000 new URLs): ` +
        `elapsed ${elapsedMs.toFixed(2)} ms (${(elapsedMs / 5000).toFixed(4)} ms/url)`,
    );
  });

  it('benchmark indexVariantUrls on 1,000 variant URLs workload', () => {
    const domain = 'benchmark-variant.com';
    const variants: VariantUrlInput[] = Array.from({ length: 1000 }, (_, i) => ({
      url: `https://benchmark-variant.com/products/kibble?variant=${100000 + i}`,
      baseUrl: 'https://benchmark-variant.com/products/kibble',
      title: `Kibble Bag - ${i + 1} lb`,
      upc: `0850067${10000 + i}`,
      sku: `SKU-${10000 + i}`,
      brand: 'BenchmarkVariantBrand',
      variantTokens: [`${i + 1}lb`],
      price: 19.99 + i,
    }));

    const start = performance.now();
    const affected = indexVariantUrls(domain, variants);
    const elapsedMs = performance.now() - start;

    expect(affected).toBe(1000);

    // Verify lookup by UPC works
    const hit = lookupByUpc(domain, '085006710005');
    expect(hit).not.toBeNull();
    expect(hit?.sku).toBe('SKU-10005');

    console.log(
      `[Benchmark] indexVariantUrls (1,000 variants): ` +
        `elapsed ${elapsedMs.toFixed(2)} ms (${(elapsedMs / 1000).toFixed(4)} ms/variant)`,
    );
  });
});
