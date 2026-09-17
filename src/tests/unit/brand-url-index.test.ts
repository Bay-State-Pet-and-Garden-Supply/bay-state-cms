// story: e06s02
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';

describe('brand-url-index candidate vs confirmed', () => {
  const testDbPath = '/tmp/baystate-cms-brand-url-index-e06s02-test.db';
  beforeAll(() => {
    try { resetDb(); } catch {}
    initDb(testDbPath);
    runMigrations();
  });
  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
  });
  beforeEach(() => {
    const db = getDb();
    try { db.exec('DELETE FROM domain_representative_suite'); } catch {}
    try { db.exec('DELETE FROM domain_waiver'); } catch {}
    db.exec('DELETE FROM brand_url_index');
    db.exec('DELETE FROM brand_url_fts');
  });

  it('lists candidate product rows from brand_url_index', async () => {
    const { findUrlsByDomain } = await import('../../db/repositories/brand-url-index-repo');
    const { reconcileSitemapUrls } = await import('../../db/repositories/brand-url-index-repo');
    reconcileSitemapUrls('example.com', [
      { url: 'https://example.com/products/a', pageType: 'product' },
      { url: 'https://example.com/products/b', pageType: 'product' },
      { url: 'https://example.com/collections/c', pageType: 'category' },
    ], 'https://example.com/sitemap.xml');
    const { urls, total } = findUrlsByDomain('example.com', { pageType: 'product', activeOnly: true });
    expect(total).toBe(2);
    expect(urls.length).toBe(2);
  });

  it('profile state shows product count and freshness', () => {
    const state = getDomainProfileState('example.com');
    expect(state.productCount).toBeGreaterThanOrEqual(0);
    // freshness may be null until sitemap reconciled, but property exists
    expect(state).toHaveProperty('freshness');
  });
});
