import { unlinkSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { reconcileSitemapUrls, enrichUrlMetadata } from '../../db/repositories/brand-url-index-repo';
import { findLocalBrandCandidates, tokenizeProductName, computeTokenOverlapScore } from '../../onboarding/local-brand-url-finder';

describe('Local Brand URL Finder (Tiered Retrieval Ladder)', () => {
  const testDbPath = '/tmp/baystate-cms-local-finder-test.db';

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

  it('should tokenize product names correctly and remove stop words', () => {
    const tokens = tokenizeProductName('KONG Classic Dog Toy Medium Red', 'kongcompany.com');
    expect(tokens).toContain('classic');
    expect(tokens).toContain('medium');
    expect(tokens).toContain('red');
    expect(tokens).not.toContain('dog');
    expect(tokens).not.toContain('toy');
    expect(tokens).not.toContain('kong');
  });

  it('should compute token overlap score accurately', () => {
    const tokens = ['ocean', 'whitefish', 'dry', 'recipe'];
    const score = computeTokenOverlapScore(
      'https://wellnesspet.com/products/core-ocean-whitefish-recipe',
      tokens,
      'CORE Ocean Whitefish Grain Free Recipe',
    );
    expect(score.ratio).toBe(0.75); // 3 of 4 tokens matched
    expect(score.matchedTokens).toContain('ocean');
    expect(score.matchedTokens).toContain('whitefish');
    expect(score.matchedTokens).toContain('recipe');
  });

  it('Tier 1: should find exact UPC match with 0.95+ confidence and short-circuit', async () => {
    reconcileSitemapUrls(
      'purina.com',
      [
        { url: 'https://purina.com/pro-plan/puppy-chicken-rice-038100130839' },
        { url: 'https://purina.com/pro-plan/adult-salmon-rice' },
      ],
      'https://purina.com/sitemap.xml',
    );

    const matches = await findLocalBrandCandidates('purina.com', {
      upc: '038100130839',
      name: 'Purina Pro Plan Puppy Chicken & Rice',
      brandHint: 'Purina',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://purina.com/pro-plan/puppy-chicken-rice-038100130839');
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.95);
    expect(matches[0].sourceMethod).toBe('local_upc');
    expect(matches[0].matchType).toBe('upc_exact');
    expect(matches[0].signals.upcMatched).toBe(true);
  });

  it('Tier 2: should find exact SKU match with 0.92 confidence', async () => {
    reconcileSitemapUrls(
      'kongcompany.com',
      [{ url: 'https://www.kongcompany.com/products/classic-red' }],
      'https://www.kongcompany.com/sitemap.xml',
    );

    enrichUrlMetadata('https://www.kongcompany.com/products/classic-red', {
      title: 'KONG Classic',
      sku: 'KONG-T1',
    });

    const matches = await findLocalBrandCandidates('kongcompany.com', {
      sku: 'kong-t1',
      name: 'KONG Classic Rubber Toy',
      brandHint: 'KONG',
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('https://www.kongcompany.com/products/classic-red');
    expect(matches[0].confidence).toBe(0.92);
    expect(matches[0].matchType).toBe('sku_exact');
    expect(matches[0].signals.skuMatched).toBe(true);
  });

  it('Tier 3: should rank candidates by token overlap against URL and enriched title', async () => {
    reconcileSitemapUrls(
      'wellnesspet.com',
      [
        { url: 'https://wellnesspet.com/products/core-rawrev-ocean-whitefish-dry-dog-food' },
        { url: 'https://wellnesspet.com/products/complete-health-chicken-dry-cat-food' },
        { url: 'https://wellnesspet.com/products/core-lamb-dry-dog-food' },
      ],
      'https://wellnesspet.com/sitemap.xml',
    );

    enrichUrlMetadata('https://wellnesspet.com/products/core-rawrev-ocean-whitefish-dry-dog-food', {
      title: 'CORE RawRev Ocean Whitefish Recipe',
    });

    const matches = await findLocalBrandCandidates('wellnesspet.com', {
      name: 'Wellness CORE RawRev Ocean Whitefish',
      brandHint: 'Wellness',
    });

    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].url).toContain('whitefish');
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.80);
    expect(matches[0].matchType).toBe('token_overlap');
    expect(matches[0].signals.tokenOverlapRatio).toBeGreaterThan(0.5);
  });
});
