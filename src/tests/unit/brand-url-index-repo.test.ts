import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  reconcileSitemapUrls,
  findUrlsByDomain,
  lookupByUpc,
  lookupBySku,
  searchUrlsLexical,
  enrichUrlMetadata,
  getDomainUrlCounts,
  getActiveUrlsForDomain,
  deleteBrandUrlById,
  deleteBrandUrlsByIds,
  deleteBrandUrlsByDomain,
  indexVariantUrls,
} from '../../db/repositories/brand-url-index-repo';
import {
  recordRefreshRun,
  getLatestRefreshRun,
  listRefreshHistory,
  recordDiscoveryEvent,
  getDiscoveryEconomics,
} from '../../db/repositories/sitemap-telemetry-repo';

describe('Brand URL Index & Sitemap Telemetry Repositories', () => {
  const testDbPath = '/tmp/baystate-cms-brand-url-index-test.db';

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
    db.query('DELETE FROM brand_url_index').run();
    db.query('DELETE FROM brand_url_fts').run();
    db.query('DELETE FROM sitemap_refresh_history').run();
    db.query('DELETE FROM sitemap_discovery_events').run();
  });

  describe('reconcileSitemapUrls', () => {
    it('should insert new URLs as active=1 and track counts', () => {
      const result = reconcileSitemapUrls(
        'purina.com',
        [
          { url: 'https://purina.com/pro-plan/dog-food-chicken-rice-123456789012' },
          { url: 'https://purina.com/pro-plan/cat-food-salmon' },
        ],
        'https://purina.com/sitemap.xml',
      );

      expect(result.addedCount).toBe(2);
      expect(result.updatedCount).toBe(0);
      expect(result.inactivatedCount).toBe(0);
      expect(result.totalActiveCount).toBe(2);

      const activeUrls = getActiveUrlsForDomain('purina.com');
      expect(activeUrls).toHaveLength(2);
    });

    it('should reconcile existing URLs and inactivate removed URLs', () => {
      // 1. Initial sitemap run with 3 URLs
      reconcileSitemapUrls(
        'acmepet.com',
        [
          { url: 'https://acmepet.com/products/item1' },
          { url: 'https://acmepet.com/products/item2' },
          { url: 'https://acmepet.com/products/item3' },
        ],
        'https://acmepet.com/sitemap.xml',
      );

      // 2. Subsequent sitemap run where item2 is kept, item4 is added, item1 & item3 are missing
      const result = reconcileSitemapUrls(
        'acmepet.com',
        [
          { url: 'https://acmepet.com/products/item2' },
          { url: 'https://acmepet.com/products/item4' },
        ],
        'https://acmepet.com/sitemap.xml',
      );

      expect(result.addedCount).toBe(1); // item4
      expect(result.updatedCount).toBe(1); // item2
      expect(result.inactivatedCount).toBe(2); // item1, item3
      expect(result.totalActiveCount).toBe(2); // item2, item4

      const counts = getDomainUrlCounts('acmepet.com');
      expect(counts.totalCount).toBe(4);
      expect(counts.activeCount).toBe(2);
      expect(counts.inactiveCount).toBe(2);
    });
  });

  describe('lookupByUpc & lookupBySku', () => {
    it('should find candidate by UPC substring in URL slug', () => {
      reconcileSitemapUrls(
        'kongcompany.com',
        [
          { url: 'https://www.kongcompany.com/products/classic-dog-toy-035585111116' },
          { url: 'https://www.kongcompany.com/products/wubba-toy-035585222222' },
        ],
        'https://www.kongcompany.com/sitemap.xml',
      );

      const match = lookupByUpc('kongcompany.com', '035585111116');
      expect(match).not.toBeNull();
      expect(match?.url).toBe('https://www.kongcompany.com/products/classic-dog-toy-035585111116');
    });

    it('should find candidate by enriched UPC column after enrichment', () => {
      reconcileSitemapUrls(
        'kongcompany.com',
        [{ url: 'https://www.kongcompany.com/products/classic-red-medium' }],
        'https://www.kongcompany.com/sitemap.xml',
      );

      enrichUrlMetadata('https://www.kongcompany.com/products/classic-red-medium', {
        title: 'KONG Classic Dog Toy Medium',
        upc: '035585111116',
        sku: 'T1',
        brand: 'KONG',
      });

      const upcMatch = lookupByUpc('kongcompany.com', '035585111116');
      expect(upcMatch).not.toBeNull();
      expect(upcMatch?.title).toBe('KONG Classic Dog Toy Medium');

      const skuMatch = lookupBySku('kongcompany.com', 't1');
      expect(skuMatch).not.toBeNull();
      expect(skuMatch?.url).toBe('https://www.kongcompany.com/products/classic-red-medium');
    });
  });

  describe('searchUrlsLexical with FTS5', () => {
    it('should match terms against URL slug and enriched title', () => {
      reconcileSitemapUrls(
        'wellnesspet.com',
        [
          { url: 'https://wellnesspet.com/products/core-rawrev-ocean-whitefish-dry-dog-food' },
          { url: 'https://wellnesspet.com/products/complete-health-chicken-dry-cat-food' },
          { url: 'https://wellnesspet.com/products/complete-health-lamb-dry-dog-food' },
        ],
        'https://wellnesspet.com/sitemap.xml',
      );

      enrichUrlMetadata('https://wellnesspet.com/products/core-rawrev-ocean-whitefish-dry-dog-food', {
        title: 'CORE RawRev Ocean Deboned Whitefish Grain-Free Recipe',
      });

      const results = searchUrlsLexical('wellnesspet.com', 'whitefish dog food');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].url).toContain('whitefish');
    });
  });

  describe('findUrlsByDomain (pagination & filters)', () => {
    it('should paginate and filter by search term', () => {
      reconcileSitemapUrls(
        'acme.com',
        [
          { url: 'https://acme.com/products/alpha' },
          { url: 'https://acme.com/products/beta' },
          { url: 'https://acme.com/products/gamma' },
        ],
        'https://acme.com/sitemap.xml',
      );

      const page1 = findUrlsByDomain('acme.com', { limit: 2, offset: 0 });
      expect(page1.urls).toHaveLength(2);
      expect(page1.total).toBe(3);

      const searchRes = findUrlsByDomain('acme.com', { search: 'gamma' });
      expect(searchRes.urls).toHaveLength(1);
      expect(searchRes.urls[0].url).toBe('https://acme.com/products/gamma');
    });
  });

  describe('deleteBrandUrlById & deleteBrandUrlsByIds', () => {
    it('should delete a single URL by ID and remove it from search/listing', () => {
      reconcileSitemapUrls(
        'delete-test.com',
        [
          { url: 'https://delete-test.com/products/keep-me' },
          { url: 'https://delete-test.com/products/remove-me' },
        ],
        'https://delete-test.com/sitemap.xml',
      );

      const before = findUrlsByDomain('delete-test.com');
      expect(before.urls).toHaveLength(2);
      const toRemove = before.urls.find((u) => u.url.includes('remove-me'))!;

      const success = deleteBrandUrlById(toRemove.id);
      expect(success).toBe(true);

      const after = findUrlsByDomain('delete-test.com');
      expect(after.urls).toHaveLength(1);
      expect(after.urls[0].url).toBe('https://delete-test.com/products/keep-me');
      expect(after.total).toBe(1);

      // FTS search should not find the deleted URL
      const searchRes = searchUrlsLexical('delete-test.com', 'remove');
      expect(searchRes).toHaveLength(0);
    });

    it('should batch delete multiple URLs by IDs', () => {
      reconcileSitemapUrls(
        'batch-delete.com',
        [
          { url: 'https://batch-delete.com/products/item1' },
          { url: 'https://batch-delete.com/products/item2' },
          { url: 'https://batch-delete.com/products/item3' },
          { url: 'https://batch-delete.com/products/item4' },
        ],
        'https://batch-delete.com/sitemap.xml',
      );

      const all = findUrlsByDomain('batch-delete.com');
      expect(all.urls).toHaveLength(4);

      const idsToDelete = all.urls.filter((u) => u.url.includes('item1') || u.url.includes('item3')).map((u) => u.id);
      const count = deleteBrandUrlsByIds(idsToDelete);
      expect(count).toBe(2);

      const remaining = findUrlsByDomain('batch-delete.com');
      expect(remaining.urls).toHaveLength(2);
      expect(remaining.total).toBe(2);
      expect(remaining.urls.map((u) => u.url).sort()).toEqual([
        'https://batch-delete.com/products/item2',
        'https://batch-delete.com/products/item4',
      ]);
    });

    it('should delete all URLs by domain', () => {
      reconcileSitemapUrls(
        'wipe-domain.com',
        [
          { url: 'https://wipe-domain.com/p1' },
          { url: 'https://wipe-domain.com/p2' },
        ],
        'https://wipe-domain.com/sitemap.xml',
      );

      const count = deleteBrandUrlsByDomain('wipe-domain.com');
      expect(count).toBe(2);

      const remaining = findUrlsByDomain('wipe-domain.com');
      expect(remaining.urls).toHaveLength(0);
      expect(remaining.total).toBe(0);
    });
  });


  describe('Sitemap Telemetry Repository', () => {
    it('should record and retrieve refresh history runs', () => {
      recordRefreshRun({
        domain: 'purina.com',
        started_at: '2026-08-18T10:00:00Z',
        completed_at: '2026-08-18T10:00:02Z',
        status: 'success',
        source_url: 'https://purina.com/sitemap.xml',
        total_urls_observed: 500,
        product_urls_eligible: 450,
        added_count: 20,
        updated_count: 480,
        inactivated_count: 5,
        duration_ms: 2000,
        error_message: null,
        http_status: 200,
      });

      const latest = getLatestRefreshRun('purina.com');
      expect(latest).not.toBeNull();
      expect(latest?.status).toBe('success');
      expect(latest?.total_urls_observed).toBe(500);
      expect(latest?.added_count).toBe(20);

      const list = listRefreshHistory('purina.com');
      expect(list).toHaveLength(1);
    });

    it('should record discovery events and calculate discovery economics', () => {
      // Event 1: Satisfied locally
      recordDiscoveryEvent({
        item_id: 'item_1',
        upc: '012345678901',
        domain: 'brand1.com',
        satisfied_locally: 1,
        candidate_url: 'https://brand1.com/product/1',
        confidence: 0.95,
        source_method: 'local_upc',
      });

      // Event 2: Satisfied locally
      recordDiscoveryEvent({
        item_id: 'item_2',
        upc: '012345678902',
        domain: 'brand1.com',
        satisfied_locally: 1,
        candidate_url: 'https://brand1.com/product/2',
        confidence: 0.90,
        source_method: 'local_token_match',
      });

      // Event 3: Not satisfied locally (sitemap-only candidates)
      recordDiscoveryEvent({
        item_id: 'item_3',
        upc: '012345678903',
        domain: 'brand1.com',
        satisfied_locally: 0,
        candidate_url: 'https://brand1.com/product/3',
        confidence: 0.80,
        source_method: 'sitemap_token_overlap',
      });

      const economics = getDiscoveryEconomics('brand1.com', 30);
      expect(economics.totalLookups).toBe(3);
      expect(economics.localHitCount).toBe(2);
      expect(economics.localHitRate).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('indexVariantUrls', () => {
    it('should index multiple variant URLs with distinct barcodes and enable lookupByUpc', () => {
      const variants = [
        {
          url: 'https://kongcompany.com/products/classic-red?variant=1001',
          baseUrl: 'https://kongcompany.com/products/classic-red',
          title: 'KONG Classic - Small',
          upc: '035585111018',
          sku: 'KONG-SM',
          brand: 'KONG',
          variantTokens: ['Small', 'Red'],
          price: 9.99,
        },
        {
          url: 'https://kongcompany.com/products/classic-red?variant=1002',
          baseUrl: 'https://kongcompany.com/products/classic-red',
          title: 'KONG Classic - Medium',
          upc: '035585111025',
          sku: 'KONG-MD',
          brand: 'KONG',
          variantTokens: ['Medium', 'Red'],
          price: 12.99,
        },
      ];

      const affected = indexVariantUrls('kongcompany.com', variants);
      expect(affected).toBe(2);

      // Verify Tier 1 exact UPC lookup returns the exact variant URL
      const matchSm = lookupByUpc('kongcompany.com', '035585111018');
      expect(matchSm).not.toBeNull();
      expect(matchSm?.url).toBe('https://kongcompany.com/products/classic-red?variant=1001');
      expect(matchSm?.title).toBe('KONG Classic - Small');
      expect(matchSm?.upc).toBe('035585111018');

      const matchMd = lookupByUpc('kongcompany.com', '035585111025');
      expect(matchMd).not.toBeNull();
      expect(matchMd?.url).toBe('https://kongcompany.com/products/classic-red?variant=1002');
      expect(matchMd?.sku).toBe('KONG-MD');

      // Verify Tier 2 exact SKU lookup
      const skuHit = lookupBySku('kongcompany.com', 'kong-md');
      expect(skuHit).not.toBeNull();
      expect(skuHit?.url).toBe('https://kongcompany.com/products/classic-red?variant=1002');
    });

    it('should update existing variant records when re-indexed', () => {
      indexVariantUrls('acme.com', [
        {
          url: 'https://acme.com/p/toy?variant=1',
          title: 'Toy V1',
          upc: '111111111111',
        },
      ]);

      const initial = lookupByUpc('acme.com', '111111111111');
      expect(initial?.title).toBe('Toy V1');

      indexVariantUrls('acme.com', [
        {
          url: 'https://acme.com/p/toy?variant=1',
          title: 'Toy V1 Updated',
          upc: '111111111111',
          sku: 'ACME-1',
        },
      ]);

      const updated = lookupByUpc('acme.com', '111111111111');
      expect(updated?.title).toBe('Toy V1 Updated');
      expect(updated?.sku).toBe('ACME-1');
    });
  });
});

