import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { lookupByUpc, getActiveUrlsForDomain } from '../../db/repositories/brand-url-index-repo';
import {
  ingestShopifyCatalog,
  prewarmBrandDomain,
  syncAllBrandSitemaps,
} from '../../onboarding/sitemap-sync-service';

describe('Sitemap & Catalog Sync Service', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-sync-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    const db = getDb();
    db.query('DELETE FROM brand_sites').run();
    db.query('DELETE FROM brand_url_index').run();
    db.query('DELETE FROM brand_url_fts').run();
    db.query('DELETE FROM sitemap_refresh_history').run();
  });

  it('should ingest Shopify /products.json catalog and index all variant barcodes', async () => {
    const mockProductsJson = {
      products: [
        {
          id: 101,
          title: 'Woof Poomergency Chew Bone',
          handle: 'poomergency-chew-bone',
          vendor: 'Woof',
          variants: [
            {
              id: 2001,
              title: 'Small / Bacon',
              compare_at_price: '24.99',
              sku: 'WOOF-SM-BAC',
              barcode: '850067859598',
              option1: 'Small',
              option2: 'Bacon',
              option3: null,
            },
            {
              id: 2002,
              title: 'Large / Bacon',
              price: '19.99',
              sku: 'WOOF-LG-BAC',
              barcode: '850067859604',
              option1: 'Large',
              option2: 'Bacon',
              option3: null,
            },
          ],
        },
      ],
    };

    const mockFetch: any = async (url: string) => {
      if (url.includes('/products.json')) {
        return new Response(JSON.stringify(mockProductsJson), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await ingestShopifyCatalog('mywoof.com', mockFetch, 1);
    expect(result.success).toBe(true);
    expect(result.productsFound).toBe(1);
    expect(result.variantsIndexed).toBe(2);

    // Verify both variants are instantly findable via UPC lookup
    const smallHit = lookupByUpc('mywoof.com', '850067859598');
    expect(smallHit).not.toBeNull();
    expect(smallHit?.url).toBe('https://mywoof.com/products/poomergency-chew-bone?variant=2001');
    expect(smallHit?.sku).toBe('WOOF-SM-BAC');

    const largeHit = lookupByUpc('mywoof.com', '850067859604');
    expect(largeHit).not.toBeNull();
    expect(largeHit?.url).toBe('https://mywoof.com/products/poomergency-chew-bone?variant=2002');

    const indexedPrices = getDb().query(
      'SELECT price FROM brand_url_index WHERE domain = ? AND url LIKE ?',
    ).all('mywoof.com', '%variant=%') as Array<{ price: number | null }>;
    expect(indexedPrices).toHaveLength(2);
    expect(indexedPrices.map((row) => row.price)).toEqual([null, null]);
  });

  it('should prewarm brand domain by fetching sitemap and catalog variants', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://brand.com/products/toy-1</loc></url>
        <url><loc>https://brand.com/products/toy-2</loc></url>
      </urlset>`;

    const mockFetch: any = async (url: string) => {
      if (url.includes('/sitemap.xml')) {
        return new Response(sitemapXml, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        });
      }
      if (url.includes('/products.json')) {
        return new Response(
          JSON.stringify({
            products: [
              {
                id: 1,
                title: 'Toy 1',
                handle: 'toy-1',
                variants: [{ id: 10, title: 'Default', barcode: '123456789012', sku: 'T1' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const res = await prewarmBrandDomain('brand.com', { fetchFn: mockFetch });
    expect(res.status).toBe('synced');
    expect(res.sitemapUrlsCount).toBe(2);
    expect(res.variantsIndexedCount).toBe(1);

    const activeUrls = getActiveUrlsForDomain('brand.com');
    expect(activeUrls).toContain('https://brand.com/products/toy-1');
    expect(activeUrls).toContain('https://brand.com/products/toy-2');
  });

  it('should batch sync all configured brand sites', async () => {
    upsertBrandSite('Kong', 'kongcompany.com');
    upsertBrandSite('Woof', 'mywoof.com');

    const mockFetch: any = async (url: string) => {
      if (url.includes('/sitemap.xml')) {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
           <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
             <url><loc>https://example.com/products/item</loc></url>
           </urlset>`,
          { status: 200, headers: { 'Content-Type': 'application/xml' } },
        );
      }
      return new Response(JSON.stringify({ products: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const batch = await syncAllBrandSitemaps({
      concurrency: 2,
      force: true,
      fetchFn: mockFetch,
    });

    expect(batch.totalDomains).toBe(2);
    expect(batch.syncedCount).toBe(2);
    expect(batch.failedCount).toBe(0);
  });
});
