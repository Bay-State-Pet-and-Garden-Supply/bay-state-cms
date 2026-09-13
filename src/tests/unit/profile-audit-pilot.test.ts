import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runPilotAudit } from '../../onboarding/profile-audit/pilot-auditor';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';
import type { AuditManifest } from '../../onboarding/profile-audit/types';

describe('profile extraction audit gate T1: pilot replay and scoring', () => {
  let tempDir: string;
  const domain = 'pilot-brand.com';
  let profile: ExtractorProfile;
  let manifest: AuditManifest;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pilot-audit-test-${randomUUID()}`);
    const domainDir = join(tempDir, domain);
    mkdirSync(domainDir, { recursive: true });

    // Snapshot 1: Complete artifact (has page.html + page.min.html + screenshot.png)
    const snap1 = join(domainDir, 'snapshot-101-aaa');
    mkdirSync(snap1);
    writeFileSync(
      join(snap1, 'page.html'),
      `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://pilot-brand.com/products/organic-shampoo">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Organic Herbal Shampoo 16oz",
    "brand": { "@type": "Brand", "name": "PilotBrand" },
    "sku": "SHAMP-16",
    "image": "https://pilot-brand.com/images/shampoo-front.jpg"
  }
  </script>
</head>
<body>
  <h1 class="pdp-title">Organic Herbal Shampoo 16oz</h1>
  <div class="desc">Gentle and cleansing</div>
  <div class="media">
    <img src="https://pilot-brand.com/images/shampoo-front.jpg" class="pdp-img">
    <img src="https://pilot-brand.com/images/shampoo-back.jpg" class="pdp-img">
    <img src="https://pilot-brand.com/icons/social-share.png" class="share-icon">
  </div>
</body>
</html>`,
    );
    writeFileSync(join(snap1, 'page.min.html'), '<html><body>shampoo</body></html>');
    writeFileSync(join(snap1, 'screenshot.png'), 'fake-screenshot-bytes');

    // Snapshot 2: Missing supplemental artifact (only page.html, NO min.html or screenshot)
    const snap2 = join(domainDir, 'snapshot-102-bbb');
    mkdirSync(snap2);
    writeFileSync(
      join(snap2, 'page.html'),
      `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://pilot-brand.com/products/puppy-wipes">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Soothing Puppy Wipes 100ct",
    "brand": "PilotBrand",
    "sku": "WIPE-100",
    "image": "https://pilot-brand.com/images/wipes-front.jpg"
  }
  </script>
</head>
<body>
  <h1 class="pdp-title">Puppy Wipes 100ct</h1>
  <div class="desc">Gentle puppy wipes</div>
  <div class="media">
    <img src="https://pilot-brand.com/images/wipes-front.jpg">
  </div>
</body>
</html>`,
    );

    profile = {
      id: 'prof-pilot-1',
      domain,
      titleSelector: 'h1.pdp-title',
      titleOptionalSelectors: [],
      priceSelector: null,
      descriptionSelector: '.desc',
      brandSelector: null,
      imagesSelector: '.media img',
      customSelectors: {},
      sitemapProductUrlPattern: null,
      shopifyJSONPath: false,
      variantSelectionStrategy: null,
      customSelectorMetadata: {},
      runtime: 'rendered',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    };

    manifest = {
      domain,
      generatedAt: '2026-09-13T12:00:00Z',
      samples: [
        {
          sampleId: 'sample-1',
          url: 'https://pilot-brand.com/products/organic-shampoo',
          domain,
          stratum: 'standard_pdp',
          inventoryStatus: 'confirmed',
          artifactRef: `${domain}/snapshot-101-aaa/page.html`,
          supplementalArtifactRefs: [
            `${domain}/snapshot-101-aaa/page.min.html`,
            `${domain}/snapshot-101-aaa/screenshot.png`,
          ],
          hasSupplementalArtifact: true,
          captureFreshness: '2026-09-01T12:00:00Z',
          groundTruth: {
            identity: { brand: 'PilotBrand', productName: 'Organic Herbal Shampoo 16oz' },
            fields: {
              title: { available: true, expectedValue: 'Organic Herbal Shampoo 16oz' },
              brand: { available: true, expectedValue: 'PilotBrand' },
              description: { available: true },
              price: { available: false }, // price not available on brand site
              gtin: { available: false },  // gtin not available on page
              sku: { available: true, expectedValue: 'SHAMP-16' },
            },
            images: {
              primaryImage: 'https://pilot-brand.com/images/shampoo-front.jpg',
              admissibleImages: [
                'https://pilot-brand.com/images/shampoo-front.jpg',
                'https://pilot-brand.com/images/shampoo-back.jpg',
              ],
              inadmissibleImages: [
                'https://pilot-brand.com/icons/social-share.png',
              ],
            },
          },
        },
        {
          sampleId: 'sample-2',
          url: 'https://pilot-brand.com/products/puppy-wipes',
          domain,
          stratum: 'standard_pdp',
          inventoryStatus: 'confirmed',
          artifactRef: `${domain}/snapshot-102-bbb/page.html`,
          supplementalArtifactRefs: [],
          hasSupplementalArtifact: false, // missing supplemental artifact
          captureFreshness: '2026-09-01T12:00:00Z',
          groundTruth: {
            identity: { brand: 'PilotBrand', productName: 'Puppy Wipes 100ct' },
            fields: {
              title: { available: true, expectedValue: 'Puppy Wipes 100ct' },
              brand: { available: true, expectedValue: 'PilotBrand' },
              price: { available: false },
              sku: { available: true, expectedValue: 'WIPE-100' },
            },
            images: {
              primaryImage: 'https://pilot-brand.com/images/wipes-front.jpg',
              admissibleImages: ['https://pilot-brand.com/images/wipes-front.jpg'],
            },
          },
        },
        {
          sampleId: 'sample-3',
          url: 'https://pilot-brand.com/products/missing-artifact-item',
          domain,
          stratum: 'standard_pdp',
          inventoryStatus: 'candidate',
          artifactRef: null, // missing primary artifact
          supplementalArtifactRefs: [],
          hasSupplementalArtifact: false,
          captureFreshness: null,
          groundTruth: {
            identity: { brand: 'PilotBrand', productName: 'Missing Item' },
            fields: {
              title: { available: true, expectedValue: 'Missing Item' },
            },
            images: {
              primaryImage: null,
              admissibleImages: [],
            },
          },
        },
      ],
    };
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('acceptance criterion 1: replays all four configurations with zero network refetch', async () => {
    // Spy on global fetch to ensure zero network requests are made during scoring
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    // Verify 0 calls to global network fetch
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    // 3 samples * 4 configurations = 12 scored rows
    expect(result.rows).toHaveLength(12);

    const configs = new Set(result.rows.map(r => r.configuration));
    expect(configs.has('current_extraction')).toBe(true);
    expect(configs.has('current_strict_images')).toBe(true);
    expect(configs.has('structured_only')).toBe(true);
    expect(configs.has('hybrid_identity_first')).toBe(true);
  });

  it('acceptance criterion 2: scored rows show per-field correctness against available fields, image P/R + primary accuracy, and identity verdicts', async () => {
    const result = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    const s1Baseline = result.rows.find(
      r => r.sampleId === 'sample-1' && r.configuration === 'current_extraction',
    );
    expect(s1Baseline).toBeDefined();
    expect(s1Baseline?.identityVerdict).toBe('correct_match');
    expect(s1Baseline?.fieldScores.title.correct).toBe(true);
    expect(s1Baseline?.fieldScores.brand.correct).toBe(true);
    expect(s1Baseline?.fieldScores.price.status).toBe('unavailable');
    expect(s1Baseline?.fieldScores.price.correct).toBe(true);
    expect(s1Baseline?.fieldScores.gtin.status).toBe('unavailable');
    expect(s1Baseline?.fieldScores.gtin.correct).toBe(true);
    expect(s1Baseline?.fieldCorrectnessScore).toBe(1.0);

    // Baseline image has unadulterated gallery with social-share icon
    expect(s1Baseline?.imageScores.primaryAccuracy).toBe(1);
    expect(s1Baseline?.imageScores.extractedImages).toContain('https://pilot-brand.com/icons/social-share.png');

    const s1Strict = result.rows.find(
      r => r.sampleId === 'sample-1' && r.configuration === 'current_strict_images',
    );
    // Strict image filtering dropped the social-share icon!
    expect(s1Strict?.imageScores.rejectedImages).toContain('https://pilot-brand.com/icons/social-share.png');
    expect(s1Strict?.imageScores.admittedImages).not.toContain('https://pilot-brand.com/icons/social-share.png');
    expect(s1Strict?.imageScores.precision).toBe(1.0);
    expect(s1Strict?.imageScores.recall).toBe(1.0);
  });

  it('acceptance criterion 3: missing supplemental or rendered artifacts recorded as evidence gaps, never as parser failures', async () => {
    const result = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    // Sample 2 has rendered page.html but missing supplemental artifact
    const s2Rows = result.rows.filter(r => r.sampleId === 'sample-2');
    for (const r of s2Rows) {
      expect(r.failureCodes).toContain('EVIDENCE_GAP_MISSING_SUPPLEMENTAL');
      // But it is NOT an unhandled parser crash:
      expect(r.fieldScores.title.correct).toBe(true);
    }

    // Sample 3 is completely missing its snapshot artifact
    const s3Rows = result.rows.filter(r => r.sampleId === 'sample-3');
    for (const r of s3Rows) {
      expect(r.isEvidenceGap).toBe(true);
      expect(r.failureCodes).toContain('EVIDENCE_GAP_MISSING_ARTIFACT');
      // Gracefully scored as unidentified, not thrown
      expect(r.identityVerdict).toBe('unidentified');
    }
  });

  it('acceptance criterion 4: deterministic (same artifact in, same scored row out)', async () => {
    const run1 = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    const run2 = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    expect(run1.rows).toEqual(run2.rows);
    expect(run1.summaryByConfiguration).toEqual(run2.summaryByConfiguration);
  });

  it('generates a reviewable markdown table comparing all four configurations', async () => {
    const result = await runPilotAudit({
      domain,
      artifactRoot: tempDir,
      manifest,
      profile,
    });

    expect(result.reviewableTable).toContain('# Profile Extraction Audit Gate: Pilot Replay & Scoring');
    expect(result.reviewableTable).toContain('1. Baseline (Current)');
    expect(result.reviewableTable).toContain('2. Current + Strict Images');
    expect(result.reviewableTable).toContain('3. Structured Signals Only');
    expect(result.reviewableTable).toContain('4. Hybrid (Identity-First + Strict)');
    expect(result.reviewableTable).toContain('sample-1');
    expect(result.reviewableTable).toContain('sample-2');
    expect(result.reviewableTable).toContain('sample-3');
  });

  it('proves audit seams on earthbath.com live retained artifacts if available on disk', async () => {
    const earthbathArtifactPath = '.baystate-cms/artifacts/profile-builder/earthbath.com';
    if (!existsSync(earthbathArtifactPath)) {
      return; // skip if running in environment without local artifact directory
    }

    const result = await runPilotAudit({
      domain: 'earthbath.com',
      sampleLimit: 3,
    });

    expect(result.domain).toBe('earthbath.com');
    expect(result.rows.length).toBeGreaterThanOrEqual(4);
    expect(result.reviewableTable).toBeTruthy();
  });
});
