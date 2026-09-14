import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  buildFullStratifiedManifest,
  formatReviewableManifest,
  detectPlatformFromHtmlOrUrl,
  detectPageStructureScope,
  detectVariantShape,
  deriveProductFamily,
  normalizeFreshness,
  isNonProductPath,
} from '../../onboarding/profile-audit';
import { replaySample } from '../../onboarding/profile-audit/replay-runner';

describe('profile audit gate T2: full stratified sampling manifest', () => {
  let tempDir: string;
  const domain = 'auditbrand.com';

  beforeEach(() => {
    tempDir = join(tmpdir(), `stratified-manifest-test-${randomUUID()}`);
    const domainDir = join(tempDir, domain);
    mkdirSync(domainDir, { recursive: true });

    // Snapshot 1: Shopify standard single-variant PDP
    const snap1 = join(domainDir, 'snap-shopify-single');
    mkdirSync(snap1);
    writeFileSync(
      join(snap1, 'page.html'),
      `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://auditbrand.com/products/classic-collar">
  <script src="https://cdn.shopify.com/s/files/test.js"></script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Classic Dog Collar Red SM",
    "brand": { "@type": "Brand", "name": "AuditBrand" },
    "sku": "COLLAR-RED-SM",
    "image": "https://auditbrand.com/images/collar-red.jpg"
  }
  </script>
</head>
<body>
  <h1>Classic Dog Collar Red SM</h1>
  <div class="price">$15.99</div>
  <form action="/cart/add" method="post">
    <button type="submit">Add to Cart</button>
  </form>
</body>
</html>`,
    );
    writeFileSync(join(snap1, 'page.min.html'), '<html><body>Collar</body></html>');
    writeFileSync(join(snap1, 'screenshot.png'), 'fake-screenshot');

    // Snapshot 2: WooCommerce multi-variant matrix PDP
    const snap2 = join(domainDir, 'snap-woo-matrix');
    mkdirSync(snap2);
    writeFileSync(
      join(snap2, 'page.html'),
      `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://auditbrand.com/products/chew-toy">
  <link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/style.css">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Durable Bone Chew Toy",
    "brand": "AuditBrand"
  }
  </script>
</head>
<body>
  <h1>Durable Bone Chew Toy</h1>
  <form class="variations_form" data-product_variations='[
    {"variation_id": 101, "attributes": {"attribute_pa_size": "small", "attribute_pa_flavor": "chicken"}, "display_price": 9.99},
    {"variation_id": 102, "attributes": {"attribute_pa_size": "large", "attribute_pa_flavor": "chicken"}, "display_price": 14.99}
  ]'>
    <select name="attribute_pa_size">
      <option value="small">Small</option>
      <option value="large">Large</option>
    </select>
  </form>
</body>
</html>`,
    );

    // Snapshot 3: Long-tail / alternate template PDP
    const snap3 = join(domainDir, 'snap-longtail');
    mkdirSync(snap3);
    writeFileSync(
      join(snap3, 'page.html'),
      `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://auditbrand.com/bundles/holiday-gift-pack">
</head>
<body>
  <h1>Holiday Gift Pack</h1>
  <div class="bundle-items">Bundle of assorted treats</div>
</body>
</html>`,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('Acceptance Criterion 1: Every claimed stratum present with freshness recorded per sample', () => {
    it('stratifies candidates by domain, scope, platform, product family, and variant shape with freshness', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: [
          'https://auditbrand.com/products/classic-collar',
        ],
        candidateUrls: [
          'https://auditbrand.com/products/chew-toy',
          'https://auditbrand.com/bundles/holiday-gift-pack',
          'https://auditbrand.com/products/organic-treats',
        ],
      });

      expect(manifest.domain).toBe(domain);
      expect(manifest.samples.length).toBeGreaterThanOrEqual(3);

      const metadata = manifest.metadata as Record<string, any>;
      const claimedStrata = metadata.claimedStrata as string[];
      expect(claimedStrata).toBeDefined();
      expect(claimedStrata.length).toBeGreaterThanOrEqual(2);

      // Verify EVERY claimed stratum has at least 1 sample present in manifest.samples
      for (const stratum of claimedStrata) {
        const stratumSamples = manifest.samples.filter(s => s.stratum === stratum);
        expect(stratumSamples.length).toBeGreaterThanOrEqual(1);

        // Verify summary contains valid stratum metadata
        const summary = metadata.strataSummary[stratum];
        expect(summary).toBeDefined();
        expect(summary.sampleCount).toBe(stratumSamples.length);
        expect(summary.freshnessRange.min).toBeDefined();
        expect(summary.freshnessRange.max).toBeDefined();
      }

      // Verify freshness is non-null and valid ISO timestamp for EVERY sample
      for (const sample of manifest.samples) {
        expect(sample.captureFreshness).not.toBeNull();
        expect(typeof sample.captureFreshness).toBe('string');
        const parsed = Date.parse(sample.captureFreshness!);
        expect(isNaN(parsed)).toBe(false);
      }
    });

    it('records freshness accurately from snapshot file modification time and sitemap lastmod', async () => {
      const sitemapTimestamp = '2026-07-15T14:30:00.000Z';
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: ['https://auditbrand.com/products/classic-collar'],
        candidateUrls: [
          'https://auditbrand.com/products/unfetched-candidate',
          {
            url: 'https://auditbrand.com/products/candidate-with-meta',
            lastmod: '2026-06-10T12:00:00.000Z',
            title: 'Candidate With Rich Metadata',
            brand: 'AuditBrand',
          },
        ],
        sitemapLastmods: {
          'https://auditbrand.com/products/unfetched-candidate': sitemapTimestamp,
        },
        samplesPerStratum: 3,
      });

      const snapSample = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/classic-collar');
      expect(snapSample).toBeDefined();
      expect(snapSample?.artifactRef).not.toBeNull();
      expect(snapSample?.captureFreshness).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const unfetchedSample = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/unfetched-candidate');
      expect(unfetchedSample).toBeDefined();
      expect(unfetchedSample?.artifactRef).toBeNull();
      expect(unfetchedSample?.captureFreshness).toBe(sitemapTimestamp);

      const metaSample = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/candidate-with-meta');
      expect(metaSample).toBeDefined();
      expect(metaSample?.captureFreshness).toBe('2026-06-10T12:00:00.000Z');
      expect(metaSample?.groundTruth.identity.productName).toBe('Candidate With Rich Metadata');
    });

    it('filters out non-product paths like root, markdown files, and cart URLs', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        candidateUrls: [
          'https://auditbrand.com/',
          'https://auditbrand.com/agents.md',
          'https://auditbrand.com/cart',
          'https://auditbrand.com/robots.txt',
          'https://auditbrand.com/products/real-pdp',
        ],
      });

      expect(manifest.samples.length).toBe(1);
      expect(manifest.samples[0].url).toBe('https://auditbrand.com/products/real-pdp');
      expect(manifest.samples.some(s => s.url.includes('agents.md'))).toBe(false);
      expect(manifest.samples.some(s => s.url === 'https://auditbrand.com/')).toBe(false);
    });

    it('respects candidateLimit option to cap candidate pool size', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        candidateUrls: [
          'https://auditbrand.com/products/item-1',
          'https://auditbrand.com/products/item-2',
          'https://auditbrand.com/products/item-3',
          'https://auditbrand.com/products/item-4',
        ],
        candidateLimit: 2,
        samplesPerStratum: 10,
      });

      expect(manifest.samples.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Acceptance Criterion 2: Holdout families named and untouched by tuning', () => {
    it('groups products into product families using brand normalization and name stem', () => {
      const fam1 = deriveProductFamily('Classic Dog Collar Red SM', 'AuditBrand Co.', 'https://test.com/collar-red-sm');
      const fam2 = deriveProductFamily('Classic Dog Collar Blue LG', 'AuditBrand LLC', 'https://test.com/collar-blue-lg');
      const fam3 = deriveProductFamily('Durable Bone Chew Toy Chicken', 'AuditBrand', 'https://test.com/bone-toy');

      // Collar variants belong to the same product family
      expect(fam1).toBe(fam2);
      expect(fam1).not.toBe(fam3);
    });

    it('holds out entire product families and verifies holdout families are disjoint from tuning families', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: [
          'https://auditbrand.com/products/classic-collar-red-sm',
          'https://auditbrand.com/products/classic-collar-blue-lg',
          'https://auditbrand.com/products/durable-bone-small',
          'https://auditbrand.com/products/durable-bone-large',
          'https://auditbrand.com/products/puppy-shampoo-8oz',
          'https://auditbrand.com/products/puppy-shampoo-16oz',
        ],
        groundTruthOverrides: {
          'https://auditbrand.com/products/classic-collar-red-sm': {
            identity: { brand: 'AuditBrand', productName: 'Classic Dog Collar Red SM' },
          },
          'https://auditbrand.com/products/classic-collar-blue-lg': {
            identity: { brand: 'AuditBrand', productName: 'Classic Dog Collar Blue LG' },
          },
          'https://auditbrand.com/products/durable-bone-small': {
            identity: { brand: 'AuditBrand', productName: 'Durable Bone Chew Toy SM' },
          },
          'https://auditbrand.com/products/durable-bone-large': {
            identity: { brand: 'AuditBrand', productName: 'Durable Bone Chew Toy LG' },
          },
          'https://auditbrand.com/products/puppy-shampoo-8oz': {
            identity: { brand: 'AuditBrand', productName: 'Gentle Puppy Shampoo 8oz' },
          },
          'https://auditbrand.com/products/puppy-shampoo-16oz': {
            identity: { brand: 'AuditBrand', productName: 'Gentle Puppy Shampoo 16oz' },
          },
        },
      });

      const meta = manifest.metadata as Record<string, any>;
      const holdoutFamilies = meta.holdoutFamilies as string[];
      const tuningFamilies = meta.tuningFamilies as string[];

      expect(holdoutFamilies).toBeDefined();
      expect(tuningFamilies).toBeDefined();
      expect(holdoutFamilies.length).toBeGreaterThan(0);
      expect(tuningFamilies.length).toBeGreaterThan(0);

      // Verify holdout and tuning families are STRICTLY disjoint
      expect(meta.holdoutUntouched).toBe(true);
      for (const fam of holdoutFamilies) {
        expect(tuningFamilies).not.toContain(fam);
      }

      // Verify ENTIRE families are held out together
      for (const sample of manifest.samples) {
        const isFamilyHoldout = holdoutFamilies.includes(sample.productFamily!);
        expect(sample.isHoldout).toBe(isFamilyHoldout);
        if (isFamilyHoldout) {
          expect(sample.holdoutFamilyName).toBe(sample.productFamily);
        } else {
          expect(sample.holdoutFamilyName).toBeNull();
        }
      }

      // Verify all siblings in the collar family have the exact same holdout decision
      const collarSamples = manifest.samples.filter(s => s.productFamily?.includes('Collar'));
      if (collarSamples.length >= 2) {
        const firstHoldout = collarSamples[0].isHoldout;
        expect(collarSamples.every(s => s.isHoldout === firstHoldout)).toBe(true);
      }
    });

    it('respects explicitly named holdout families if provided in options', async () => {
      const explicitHoldout = 'auditbrand - gentle shampoo';
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: [
          'https://auditbrand.com/products/collar-1',
          'https://auditbrand.com/products/shampoo-1',
        ],
        holdoutFamilies: [explicitHoldout],
        groundTruthOverrides: {
          'https://auditbrand.com/products/collar-1': {
            identity: { brand: 'AuditBrand', productName: 'Classic Collar SM' },
          },
          'https://auditbrand.com/products/shampoo-1': {
            identity: { brand: 'AuditBrand', productName: 'Gentle Puppy Shampoo 8oz' },
          },
        },
      });

      const meta = manifest.metadata as Record<string, any>;
      expect(meta.holdoutFamilies).toContain(explicitHoldout);

      const shampooSample = manifest.samples.find(s => s.url.includes('shampoo'));
      expect(shampooSample?.isHoldout).toBe(true);
      expect(shampooSample?.holdoutFamilyName).toBe(explicitHoldout);
    });

    it('handles a domain with a single product family cleanly without crash or overlap', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        candidateUrls: [
          'https://auditbrand.com/products/single-fam-1',
          'https://auditbrand.com/products/single-fam-2',
        ],
        groundTruthOverrides: {
          'https://auditbrand.com/products/single-fam-1': {
            identity: { brand: 'AuditBrand', productName: 'Solo Dog Shampoo 8oz' },
          },
          'https://auditbrand.com/products/single-fam-2': {
            identity: { brand: 'AuditBrand', productName: 'Solo Dog Shampoo 16oz' },
          },
        },
      });

      const meta = manifest.metadata as Record<string, any>;
      expect(meta.holdoutUntouched).toBe(true);
      expect(manifest.samples.length).toBe(2);
      // Both samples belong to the exact same holdout decision
      const firstHoldout = manifest.samples[0].isHoldout;
      expect(manifest.samples.every(s => s.isHoldout === firstHoldout)).toBe(true);
    });

    it('ensures holdout families are represented in stratum samples and not crowded out by tuning', async () => {
      // Stratum with 2 confirmed tuning samples + 2 unreviewed holdout samples
      const explicitHoldout = 'auditbrand - holdout chew bone';
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: [
          'https://auditbrand.com/products/collar-a',
          'https://auditbrand.com/products/collar-b',
        ],
        candidateUrls: [
          'https://auditbrand.com/products/chew-x',
          'https://auditbrand.com/products/chew-y',
        ],
        holdoutFamilies: [explicitHoldout],
        groundTruthOverrides: {
          'https://auditbrand.com/products/collar-a': {
            identity: { brand: 'AuditBrand', productName: 'Tuning Dog Collar 8oz' },
          },
          'https://auditbrand.com/products/collar-b': {
            identity: { brand: 'AuditBrand', productName: 'Tuning Dog Collar 16oz' },
          },
          'https://auditbrand.com/products/chew-x': {
            identity: { brand: 'AuditBrand', productName: 'Holdout Chew Bone 8oz' },
          },
          'https://auditbrand.com/products/chew-y': {
            identity: { brand: 'AuditBrand', productName: 'Holdout Chew Bone 16oz' },
          },
        },
        samplesPerStratum: 2,
      });

      // Stratum should have 1 tuning and 1 holdout sample
      const holdoutSample = manifest.samples.find(s => s.isHoldout);
      const tuningSample = manifest.samples.find(s => !s.isHoldout);

      expect(holdoutSample).toBeDefined();
      expect(tuningSample).toBeDefined();
      expect(holdoutSample?.productFamily).toBe(explicitHoldout);
    });
  });

  describe('Acceptance Criterion 3: Distributor-record items excluded; blocked items included', () => {
    it('strictly excludes distributor-record items and includes profile-blocked items', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: ['https://auditbrand.com/products/classic-collar'],
        onboardingItems: [
          // Item 1: Normal official page item
          {
            id: 'item-official-1',
            sourceUrl: 'https://auditbrand.com/products/official-pdp-1',
            name: 'Official Dog Leash 6ft',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'completed',
          },
          // Item 2: Distributor record item (null URL) - MUST BE EXCLUDED
          {
            id: 'item-dist-1',
            sourceUrl: null,
            name: 'Distributor Dog Food 30lb',
            sourceType: 'distributor_record',
            stage: 'collect_details',
            stageStatus: 'completed',
          },
          // Item 3: Distributor record item (accidental URL present) - MUST BE EXCLUDED
          {
            id: 'item-dist-2',
            sourceUrl: 'https://auditbrand.com/products/distributor-item',
            name: 'Distributor Dog Chews',
            sourceType: 'distributor_record',
            stage: 'collect_details',
            stageStatus: 'completed',
          },
          // Item 4: Profile-blocked item - MUST BE INCLUDED to measure fail-closed behavior
          {
            id: 'item-blocked-1',
            sourceUrl: 'https://auditbrand.com/products/profile-blocked-item',
            name: 'Profile Blocked Product 100ct',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'failed',
            errorMessage: 'No extractor profile for auditbrand.com',
          },
          // Item 5: Another profile-blocked item with needs_input status
          {
            id: 'item-blocked-2',
            sourceUrl: 'https://auditbrand.com/products/no-healthy-profile-item',
            name: 'No Healthy Profile Gadget',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'needs_input',
            errorMessage: 'profile_blocked: no healthy profile matches scope',
          },
        ],
      });

      const meta = manifest.metadata as Record<string, any>;

      // Verify distributor records were filtered out
      expect(meta.totalExcludedDistributorRecords).toBe(2);
      expect(manifest.samples.some(s => s.url.includes('distributor-item'))).toBe(false);
      expect(manifest.samples.some(s => s.url.includes('distributor-dog-food'))).toBe(false);

      // Verify Profile-Blocked items ARE included
      const blocked1 = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/profile-blocked-item');
      expect(blocked1).toBeDefined();
      expect(blocked1?.isProfileBlocked).toBe(true);
      expect(blocked1?.isFailureSample).toBe(true);
      expect(blocked1?.sampleType).toBe('profile_blocked');
      expect(blocked1?.pageStructureScope).toBe('profile_blocked_pdp');
      expect(blocked1?.stratum).toContain('profile_blocked_pdp');

      const blocked2 = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/no-healthy-profile-item');
      expect(blocked2).toBeDefined();
      expect(blocked2?.isProfileBlocked).toBe(true);
      expect(blocked2?.sampleType).toBe('profile_blocked');

      expect(meta.totalBlocked).toBe(2);
    });
  });

  describe('Acceptance Criterion 4: Confirmed Profile Samples distinguished from unreviewed candidates', () => {
    it('distinguishes confirmed profile samples from unreviewed candidates and blocked items', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: [
          'https://auditbrand.com/products/classic-collar',
        ],
        candidateUrls: [
          'https://auditbrand.com/products/chew-toy',
        ],
        onboardingItems: [
          {
            id: 'item-blocked-1',
            sourceUrl: 'https://auditbrand.com/products/blocked-shampoo',
            name: 'Blocked Shampoo',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'failed',
            errorMessage: 'No extractor profile for auditbrand.com',
          },
        ],
      });

      const meta = manifest.metadata as Record<string, any>;
      expect(meta.totalConfirmed).toBe(1);
      expect(meta.totalCandidates).toBe(1);
      expect(meta.totalBlocked).toBe(1);

      const confirmed = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/classic-collar');
      expect(confirmed).toBeDefined();
      expect(confirmed?.inventoryStatus).toBe('confirmed');
      expect(confirmed?.sampleType).toBe('confirmed_profile_sample');

      const candidate = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/chew-toy');
      expect(candidate).toBeDefined();
      expect(candidate?.inventoryStatus).toBe('candidate');
      expect(candidate?.sampleType).toBe('unreviewed_candidate');

      const blocked = manifest.samples.find(s => s.url === 'https://auditbrand.com/products/blocked-shampoo');
      expect(blocked).toBeDefined();
      expect(blocked?.inventoryStatus).toBe('candidate');
      expect(blocked?.sampleType).toBe('profile_blocked');
      expect(blocked?.isProfileBlocked).toBe(true);
    });
  });

  describe('Reviewable Table and Replay Harness Direct Consumption', () => {
    it('formats a reviewable markdown manifest table with all required sections', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: ['https://auditbrand.com/products/classic-collar'],
        candidateUrls: ['https://auditbrand.com/products/chew-toy'],
        onboardingItems: [
          {
            id: 'item-blocked',
            sourceUrl: 'https://auditbrand.com/products/blocked-leash',
            name: 'Blocked Leash',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'failed',
            errorMessage: 'No extractor profile for auditbrand.com',
          },
        ],
      });

      const markdown = formatReviewableManifest(manifest);

      expect(markdown).toContain('# Profile Extraction Audit Gate: Stratified Sampling Manifest');
      expect(markdown).toContain('## Manifest Overview');
      expect(markdown).toContain(`- **Domain:** \`${domain}\``);
      expect(markdown).toContain('- **Total Samples:** 3');
      expect(markdown).toContain('- **Confirmed Profile Samples:** 1');
      expect(markdown).toContain('- **Unreviewed Candidates:** 1');
      expect(markdown).toContain('- **Profile-Blocked Items:** 1');
      expect(markdown).toContain('## Claimed Strata');
      expect(markdown).toContain('## Product Family Partition');
      expect(markdown).toContain('## Stratified Samples Inventory');
      expect(markdown).toContain('★ Confirmed');
      expect(markdown).toContain('⛔ Blocked');
      expect(markdown).toContain('Candidate');
    });

    it('can be directly consumed by the replay harness (replaySample)', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        suiteUrls: ['https://auditbrand.com/products/classic-collar'],
        candidateUrls: ['https://auditbrand.com/products/chew-toy'],
      });

      expect(manifest.samples.length).toBeGreaterThan(0);

      // Replay first sample through all four configurations with zero network calls
      const sample1 = manifest.samples[0];
      const outcomes = await replaySample(sample1, null, {
        artifactRoot: tempDir,
      });

      expect(outcomes.current_extraction).toBeDefined();
      expect(outcomes.current_strict_images).toBeDefined();
      expect(outcomes.structured_only).toBeDefined();
      expect(outcomes.hybrid_identity_first).toBeDefined();

      // Profile-null replay proves fail-closed / structured-only behavior
      expect(outcomes.structured_only.isEvidenceGap).toBe(false);
      expect(outcomes.structured_only.data.title).not.toBeNull();
    });

    it('measures fail-closed behavior when replaying profile-blocked items', async () => {
      const manifest = await buildFullStratifiedManifest({
        domain,
        artifactRoot: tempDir,
        onboardingItems: [
          {
            id: 'item-blocked-no-snap',
            sourceUrl: 'https://auditbrand.com/products/blocked-missing-snap',
            name: 'Blocked Item Missing Snapshot',
            sourceType: 'official_page',
            stage: 'collect_details',
            stageStatus: 'failed',
            errorMessage: 'No extractor profile for auditbrand.com',
          },
        ],
      });

      const blockedSample = manifest.samples.find(s => s.isProfileBlocked);
      expect(blockedSample).toBeDefined();
      expect(blockedSample?.artifactRef).toBeNull();

      // Replay through harness
      const outcomes = await replaySample(blockedSample!, null, {
        artifactRoot: tempDir,
      });

      // Missing artifact is recorded cleanly as evidence gap, not parser failure
      expect(outcomes.current_extraction.isEvidenceGap).toBe(true);
      expect(outcomes.current_extraction.evidenceGapReason).toContain('Snapshot artifact not found');
    });
  });

  describe('Classification and detection helper units', () => {
    it('detects platforms accurately from html and url', () => {
      expect(detectPlatformFromHtmlOrUrl('<script src="https://cdn.shopify.com/s/f.js"></script>', 'https://x.com/p')).toBe('shopify');
      expect(detectPlatformFromHtmlOrUrl('<link rel="stylesheet" href="/wp-content/plugins/woocommerce/style.css">', 'https://x.com/p')).toBe('woocommerce');
      expect(detectPlatformFromHtmlOrUrl('<script>window.bcvariants = [{"id":1}];</script>', 'https://x.com/p')).toBe('bigcommerce');
      expect(detectPlatformFromHtmlOrUrl('<script>var jsonConfig = {};</script>', 'https://x.com/p')).toBe('magento');
      expect(detectPlatformFromHtmlOrUrl(null, 'https://x.com/products/collar')).toBe('shopify');
      expect(detectPlatformFromHtmlOrUrl(null, 'https://x.com/product/collar')).toBe('woocommerce');
      expect(detectPlatformFromHtmlOrUrl(null, 'https://x.com/unknown/collar')).toBe('generic');
    });

    it('detects page-structure scope accurately', () => {
      expect(detectPageStructureScope('https://x.com/p', null, true, false)).toBe('profile_blocked_pdp');
      expect(detectPageStructureScope('https://x.com/p', null, false, true)).toBe('failure_pdp');
      expect(detectPageStructureScope('https://x.com/bundles/holiday-pack', '<html></html>', false, false)).toBe('long_tail_pdp');
      expect(detectPageStructureScope('https://x.com/products/item?variant=123', '<html></html>', false, false)).toBe('long_tail_pdp');
      expect(detectPageStructureScope('https://x.com/products/gift-set', '<div class="gift-set-wrapper">Pack</div>', false, false)).toBe('long_tail_pdp');
      expect(detectPageStructureScope('https://x.com/p', '<form class="variations_form"></form>', false, false)).toBe('variant_matrix_pdp');
      expect(detectPageStructureScope('https://x.com/p', '<h1>Title</h1>', false, false)).toBe('standard_pdp');
    });

    it('identifies non-product paths correctly', () => {
      expect(isNonProductPath('https://brand.com/')).toBe(true);
      expect(isNonProductPath('https://brand.com/agents.md')).toBe(true);
      expect(isNonProductPath('https://brand.com/robots.txt')).toBe(true);
      expect(isNonProductPath('https://brand.com/cart')).toBe(true);
      expect(isNonProductPath('https://brand.com/sitemap.xml')).toBe(true);
      expect(isNonProductPath('https://brand.com/image.png')).toBe(true);
      expect(isNonProductPath('https://brand.com/products/dog-shampoo')).toBe(false);
      expect(isNonProductPath('https://brand.com/bundles/holiday-pack')).toBe(false);
    });

    it('derives product family using domain fallback when brand is omitted', () => {
      const fam = deriveProductFamily('Soothing Lavender Shampoo 16oz', null, 'https://earthbath.com/p', 'earthbath.com');
      expect(fam).toBe('earthbath - soothing shampoo');
    });

    it('detects variant shapes accurately', () => {
      const matrixHtml = `<form class="variations_form" data-product_variations='[
        {"variation_id": 1, "attributes": {"size": "S", "color": "Red"}},
        {"variation_id": 2, "attributes": {"size": "M", "color": "Blue"}}
      ]'></form>`;
      expect(detectVariantShape(matrixHtml, 'https://x.com/p')).toBe('multi_axis_variant');
      expect(detectVariantShape('<select><option>Size 1</option><option>Size 2</option></select>', 'https://x.com/p')).toBe('multi_variant');
      expect(detectVariantShape('<h1>Plain</h1>', 'https://x.com/p')).toBe('single_variant');
      expect(detectVariantShape(null, 'https://x.com/p?variant=123')).toBe('multi_variant');
      expect(detectVariantShape(null, 'https://x.com/p')).toBe('single_variant');
    });

    it('normalizes freshness timestamps into valid ISO 8601 strings', () => {
      const now = new Date();
      expect(normalizeFreshness(now.toISOString())).toBe(now.toISOString());
      expect(normalizeFreshness('2026-08-20 12:00:00')).toMatch(/^2026-08-20T/);
      expect(normalizeFreshness(null)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(normalizeFreshness('invalid-date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
