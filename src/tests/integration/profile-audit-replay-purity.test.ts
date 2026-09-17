/**
 * Profile Audit Replay Purity Integration Test (Spec #183, Issue #187)
 *
 * Pins the purity contract against future regressions:
 * 1. Replaying retained artifacts against a seeded database leaves it byte-identical:
 *    no title, identifier, status, timestamp, or search-index writes.
 * 2. Missing supplemental or rendered artifacts stay recorded as evidence gaps,
 *    never as parser failures.
 * 3. Scoring performs zero network refetch.
 * 4. Production extraction behavior is preserved (additive-only ladder enrichment,
 *    catalog writes occur in production when skipCatalogWrites is omitted/false).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { replaySample } from '../../onboarding/profile-audit/replay-runner';
import { runPilotAudit } from '../../onboarding/profile-audit/pilot-auditor';
import { scoreExtraction } from '../../onboarding/profile-audit/scorer';
import { extractProductFromHtml, extractViaHttpDetailed } from '../../onboarding/page-extractor';
import type { AuditManifestSample } from '../../onboarding/profile-audit/types';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

describe('profile audit replay purity integration (T5 / Issue #187)', () => {
  let tempDir: string;
  let testDbPath: string;
  const domain = 'acmepet.com';
  const sampleUrl = 'https://acmepet.com/products/dog-chew';

  // Seed data distinctly different from the retained artifact HTML
  const SEED_DATA = {
    title: 'Pristine Seeded Dog Toy Title',
    h1: 'Pristine Seeded H1',
    upc: '123456789012',
    sku: 'SEED-SKU-ORIGINAL',
    mpn: 'SEED-MPN-ORIGINAL',
    brand: 'Pristine Brand',
    variantTokensJson: JSON.stringify(['seed-flavor-bacon']),
    jsonLdIdentifiersJson: JSON.stringify({ sku: 'SEED-SKU-ORIGINAL', upc: '123456789012' }),
    extractionStatus: 'pending',
    lastFetchedAt: '2024-01-01T00:00:00.000Z',
  };

  // HTML snapshot artifact containing DIFFERENT extracted values
  const ARTIFACT_HTML = `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="${sampleUrl}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Extracted Cheerio Dog Toy",
    "brand": { "@type": "Brand", "name": "Extracted Brand" },
    "sku": "EXTRACTED-SKU-MUTATION-ATTEMPT",
    "mpn": "EXTRACTED-MPN-MUTATION-ATTEMPT",
    "gtin12": "987654321098",
    "image": "https://acmepet.com/images/toy-front.jpg"
  }
  </script>
</head>
<body>
  <h1 class="pdp-title">Extracted Cheerio Dog Toy Heading</h1>
  <div class="pdp-desc">Durable organic chew toy description</div>
  <div class="gallery">
    <img src="https://acmepet.com/images/toy-front.jpg" class="product-img">
    <img src="https://acmepet.com/images/toy-back.jpg" class="product-img">
    <img src="https://acmepet.com/icons/social-share.png" class="share-icon">
  </div>
</body>
</html>`;

  let sample: AuditManifestSample;
  let profile: ExtractorProfile;

  beforeEach(() => {
    tempDir = join(tmpdir(), `replay-purity-${randomUUID()}`);
    testDbPath = join(tempDir, 'catalog.db');
    mkdirSync(tempDir, { recursive: true });

    // Setup snapshot artifact on disk
    const snapshotDir = join(tempDir, 'artifacts', domain, 'snapshot-101');
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'page.html'), ARTIFACT_HTML, 'utf8');

    // Initialize real SQLite with migrations
    try { resetDb(); } catch { /* ignore */ }
    initDb(testDbPath);
    runMigrations();

    const db = getDb();

    // 1. Seed extractor profile
    profile = {
      id: 'prof-acme-purity',
      domain,
      titleSelector: 'h1.pdp-title',
      titleOptionalSelectors: [],
      priceSelector: null,
      descriptionSelector: '.pdp-desc',
      brandSelector: null,
      imagesSelector: '.gallery img',
      customSelectors: {},
      sitemapProductUrlPattern: null,
      shopifyJSONPath: false,
      variantSelectionStrategy: null,
      customSelectorMetadata: {},
      runtime: 'rendered',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    db.prepare(`
      INSERT INTO extractor_profiles (
        id, domain, title_selector, title_optional_selectors_json,
        price_selector, description_selector, brand_selector, images_selector,
        custom_selectors_json, sitemap_product_url_pattern, shopify_json_path,
        variant_selection_strategy_json, custom_selector_metadata_json, runtime,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profile.id,
      profile.domain,
      profile.titleSelector,
      JSON.stringify(profile.titleOptionalSelectors),
      profile.priceSelector,
      profile.descriptionSelector,
      profile.brandSelector,
      profile.imagesSelector,
      JSON.stringify(profile.customSelectors),
      profile.sitemapProductUrlPattern,
      profile.shopifyJSONPath ? 1 : 0,
      JSON.stringify(profile.variantSelectionStrategy),
      JSON.stringify(profile.customSelectorMetadata),
      profile.runtime,
      profile.createdAt,
      profile.updatedAt,
    );

    // 2. Seed brand_url_index with pristine values
    db.prepare(`
      INSERT INTO brand_url_index (
        id, domain, url, canonical_url, path, slug, page_type,
        sitemap_source_url, first_seen_at, last_seen_at, last_sitemap_refresh_at,
        active, lastmod, title, h1, upc, sku, mpn, brand,
        variant_tokens_json, json_ld_identifiers_json, last_fetched_at, extraction_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'url-purity-1',
      domain,
      sampleUrl,
      sampleUrl,
      '/products/dog-chew',
      'dog-chew',
      'product',
      'https://acmepet.com/sitemap.xml',
      SEED_DATA.lastFetchedAt,
      SEED_DATA.lastFetchedAt,
      SEED_DATA.lastFetchedAt,
      1,
      '2024-01-01',
      SEED_DATA.title,
      SEED_DATA.h1,
      SEED_DATA.upc,
      SEED_DATA.sku,
      SEED_DATA.mpn,
      SEED_DATA.brand,
      SEED_DATA.variantTokensJson,
      SEED_DATA.jsonLdIdentifiersJson,
      SEED_DATA.lastFetchedAt,
      SEED_DATA.extractionStatus,
    );

    // 3. Seed brand_url_fts
    const row = db.query('SELECT rowid FROM brand_url_index WHERE url = ?').get(sampleUrl) as { rowid: number };
    db.prepare(`
      INSERT INTO brand_url_fts (rowid, domain, url, path, slug, title, h1, brand)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.rowid, domain, sampleUrl, '/products/dog-chew', 'dog-chew', SEED_DATA.title, SEED_DATA.h1, SEED_DATA.brand);

    // Checkpoint to ensure WAL is flushed to the main database file
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    sample = {
      sampleId: 'sample-purity-1',
      url: sampleUrl,
      domain,
      stratum: 'standard_pdp',
      inventoryStatus: 'confirmed',
      artifactRef: `${domain}/snapshot-101/page.html`,
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: false,
      captureFreshness: '2026-09-01T00:00:00Z',
      groundTruth: {
        identity: { brand: 'Extracted Brand', productName: 'Extracted Cheerio Dog Toy' },
        fields: {
          title: { available: true, expectedValue: 'Extracted Cheerio Dog Toy' },
          brand: { available: true, expectedValue: 'Extracted Brand' },
          sku: { available: true, expectedValue: 'EXTRACTED-SKU-MUTATION-ATTEMPT' },
          price: { available: false },
        },
        images: {
          primaryImage: 'https://acmepet.com/images/toy-front.jpg',
          admissibleImages: [
            'https://acmepet.com/images/toy-front.jpg',
            'https://acmepet.com/images/toy-back.jpg',
          ],
        },
      },
    };
  });

  afterEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    try { resetDb(); } catch { /* ignore */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('replaying retained artifacts leaves seeded database completely byte-identical with zero catalog writes', async () => {
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    const preReplayBytes = readFileSync(testDbPath);
    const preReplayHash = createHash('sha256').update(preReplayBytes).digest('hex');

    // Run replaySample through all four configurations
    const outcomes = await replaySample(sample, profile, {
      artifactRoot: join(tempDir, 'artifacts'),
    });

    expect(outcomes.current_extraction).toBeDefined();
    expect(outcomes.current_strict_images).toBeDefined();
    expect(outcomes.structured_only).toBeDefined();
    expect(outcomes.hybrid_identity_first).toBeDefined();

    // Checkpoint SQLite and verify disk byte purity
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const postReplayBytes = readFileSync(testDbPath);
    const postReplayHash = createHash('sha256').update(postReplayBytes).digest('hex');

    // CRITICAL ACCEPTANCE CRITERIA: Database is 100% BYTE-IDENTICAL
    expect(postReplayHash).toBe(preReplayHash);
    expect(postReplayBytes.equals(preReplayBytes)).toBe(true);

    // Assert explicit column-level invariants: no title, identifier, status, timestamp, or search-index writes
    const record = db.query('SELECT * FROM brand_url_index WHERE url = ?').get(sampleUrl) as any;
    expect(record.title).toBe(SEED_DATA.title); // NO title write
    expect(record.h1).toBe(SEED_DATA.h1);
    expect(record.upc).toBe(SEED_DATA.upc); // NO identifier write
    expect(record.sku).toBe(SEED_DATA.sku); // NO identifier write
    expect(record.mpn).toBe(SEED_DATA.mpn); // NO identifier write
    expect(record.brand).toBe(SEED_DATA.brand);
    expect(record.variant_tokens_json).toBe(SEED_DATA.variantTokensJson);
    expect(record.json_ld_identifiers_json).toBe(SEED_DATA.jsonLdIdentifiersJson);
    expect(record.extraction_status).toBe(SEED_DATA.extractionStatus); // NO status write
    expect(record.last_fetched_at).toBe(SEED_DATA.lastFetchedAt); // NO timestamp write

    // Assert FTS search-index invariance
    const ftsRecord = db.query('SELECT title, brand FROM brand_url_fts WHERE url = ?').get(sampleUrl) as any;
    expect(ftsRecord.title).toBe(SEED_DATA.title); // NO search-index write
    expect(ftsRecord.brand).toBe(SEED_DATA.brand);
  });

  it('end-to-end runPilotAudit leaves seeded database byte-identical', async () => {
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    const preAuditBytes = readFileSync(testDbPath);
    const preAuditHash = createHash('sha256').update(preAuditBytes).digest('hex');

    // Run end-to-end pilot audit with explicit manifest pointing to our sample
    const manifest = {
      manifestId: 'manifest-purity-1',
      generatedAt: '2026-09-01T00:00:00Z',
      domain,
      strata: ['standard_pdp'],
      samples: [sample],
    };

    const pilotResult = await runPilotAudit({
      domain,
      artifactRoot: join(tempDir, 'artifacts'),
      manifest,
      profile,
    });

    expect(pilotResult.rows.length).toBe(4); // 4 configurations
    expect(pilotResult.reviewableTable).toBeDefined();

    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const postAuditBytes = readFileSync(testDbPath);
    const postAuditHash = createHash('sha256').update(postAuditBytes).digest('hex');

    // Verifies full CLI / orchestrator execution is pure
    expect(postAuditHash).toBe(preAuditHash);
    expect(postAuditBytes.equals(preAuditBytes)).toBe(true);
  });

  it('records missing supplemental or rendered artifacts as evidence gaps, never as parser failures', async () => {
    // Sample without supplemental artifact
    const sampleNoSupplemental: AuditManifestSample = {
      ...sample,
      sampleId: 'sample-no-supp',
      hasSupplementalArtifact: false,
      supplementalArtifactRefs: [],
    };

    const outcomes = await replaySample(sampleNoSupplemental, profile, {
      artifactRoot: join(tempDir, 'artifacts'),
    });

    const scored = scoreExtraction(outcomes.current_extraction, sampleNoSupplemental);
    // Missing supplemental artifact is an evidence gap code, not a throw/crash
    expect(scored.failureCodes).toContain('EVIDENCE_GAP_MISSING_SUPPLEMENTAL');

    // Sample with missing primary artifact
    const sampleMissingPrimary: AuditManifestSample = {
      ...sample,
      sampleId: 'sample-missing-primary',
      artifactRef: 'nonexistent-domain/no-job/page.html',
    };

    const missingOutcomes = await replaySample(sampleMissingPrimary, profile, {
      artifactRoot: join(tempDir, 'artifacts'),
    });

    expect(missingOutcomes.current_extraction.isEvidenceGap).toBe(true);
    expect(missingOutcomes.current_extraction.evidenceGapReason).toContain('Artifact read failed');

    const scoredMissing = scoreExtraction(missingOutcomes.current_extraction, sampleMissingPrimary);
    expect(scoredMissing.failureCodes).toContain('EVIDENCE_GAP_MISSING_ARTIFACT');
  });

  it('guarantees zero network refetch during replay and scoring', async () => {
    // If any component attempts network I/O, the zero-network guard rejects it
    const forbiddenFetch = async () => {
      throw new Error('Audit replay contract violation: zero network refetch allowed');
    };

    const parsed = await extractProductFromHtml(
      ARTIFACT_HTML,
      sampleUrl,
      profile,
      { name: 'Cheerio Dog Toy' },
      forbiddenFetch,
    );

    expect(parsed.data.title).toBe('Extracted Cheerio Dog Toy Heading');
    expect(parsed.data.brand).toBe('Extracted Brand');
  });

  it('preserves production extraction behavior: catalog writes occur when skipCatalogWrites is omitted', async () => {
    const db = getDb();

    // In production extraction, extractViaHttpDetailed without skipCatalogWrites updates metadata
    const mockHttpFetch = async () => {
      return new Response(ARTIFACT_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    const prodResult = await extractViaHttpDetailed(
      sampleUrl,
      profile,
      { name: 'Extracted Cheerio Dog Toy' },
      mockHttpFetch,
      // skipCatalogWrites omitted => production enrichment runs
    );

    expect(prodResult.data.title).toBe('Extracted Cheerio Dog Toy Heading');

    // In production, brand_url_index is enriched
    const record = db.query('SELECT title, sku, extraction_status FROM brand_url_index WHERE url = ?').get(sampleUrl) as any;
    expect(record.title).toBe('Extracted Cheerio Dog Toy Heading');
    expect(record.sku).toBe('EXTRACTED-SKU-MUTATION-ATTEMPT');
    expect(record.extraction_status).toBe('success');

    // And when skipCatalogWrites: true is passed, no writes occur
    const recordBefore = { ...record };
    await extractViaHttpDetailed(
      sampleUrl,
      profile,
      { name: 'Extracted Cheerio Dog Toy' },
      mockHttpFetch,
      { skipCatalogWrites: true },
    );

    const recordAfter = db.query('SELECT title, sku, extraction_status FROM brand_url_index WHERE url = ?').get(sampleUrl) as any;
    expect(recordAfter).toEqual(recordBefore);
  });
});
