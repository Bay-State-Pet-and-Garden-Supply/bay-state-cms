import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { replaySample } from '../../onboarding/profile-audit/replay-runner';
import type { AuditManifestSample } from '../../onboarding/profile-audit/types';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

describe('profile audit replay runner', () => {
  let tempDir: string;
  const domain = 'acmepet.com';
  let sample: AuditManifestSample;
  let profile: ExtractorProfile;

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <link rel="canonical" href="https://acmepet.com/products/dog-chew">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": "Acme Dog Chew Toy",
    "brand": { "@type": "Brand", "name": "Acme" },
    "sku": "ACME-100",
    "image": "https://acmepet.com/images/chew-front.jpg"
  }
  </script>
</head>
<body>
  <h1 class="pdp-title">Acme All-Natural Dog Chew Toy</h1>
  <div class="pdp-desc">Durable organic chew toy</div>
  <div class="gallery">
    <img src="https://acmepet.com/images/chew-front.jpg" class="product-img">
    <img src="https://acmepet.com/images/chew-back.jpg" class="product-img">
    <img src="https://acmepet.com/icons/social-share.png" class="share-icon">
  </div>
</body>
</html>`;

  beforeEach(() => {
    tempDir = join(tmpdir(), `replay-test-${randomUUID()}`);
    const domainDir = join(tempDir, domain, 'snapshot-101');
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, 'page.html'), htmlContent);

    sample = {
      sampleId: 'sample-chew-1',
      url: 'https://acmepet.com/products/dog-chew',
      domain,
      stratum: 'standard_pdp',
      inventoryStatus: 'confirmed',
      artifactRef: `${domain}/snapshot-101/page.html`,
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: false,
      captureFreshness: '2026-09-01T00:00:00Z',
      groundTruth: {
        identity: { brand: 'Acme', productName: 'Acme All-Natural Dog Chew Toy' },
        fields: {
          title: { available: true, expectedValue: 'Acme All-Natural Dog Chew Toy' },
          brand: { available: true, expectedValue: 'Acme' },
          sku: { available: true, expectedValue: 'ACME-100' },
          price: { available: false },
        },
        images: {
          primaryImage: 'https://acmepet.com/images/chew-front.jpg',
          admissibleImages: [
            'https://acmepet.com/images/chew-front.jpg',
            'https://acmepet.com/images/chew-back.jpg',
          ],
        },
      },
    };

    profile = {
      id: 'prof-acme-1',
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
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('replays all four configurations with no network calls', async () => {
    const outcomes = await replaySample(sample, profile, {
      artifactRoot: tempDir,
    });

    expect(outcomes.current_extraction).toBeDefined();
    expect(outcomes.current_strict_images).toBeDefined();
    expect(outcomes.structured_only).toBeDefined();
    expect(outcomes.hybrid_identity_first).toBeDefined();

    // Baseline uses custom selector
    expect(outcomes.current_extraction.data.title).toBe('Acme All-Natural Dog Chew Toy');
    expect(outcomes.current_extraction.data.fieldProvenance?.title).toBe('custom-selector');

    // Structured only ignores custom selector and uses JSON-LD name
    expect(outcomes.structured_only.data.title).toBe('Acme Dog Chew Toy');
    expect(outcomes.structured_only.data.fieldProvenance?.title).toBe('json-ld');

    // Strict images filters out social-share.png
    expect(outcomes.current_strict_images.admittedImages).toContain('https://acmepet.com/images/chew-front.jpg');
    expect(outcomes.current_strict_images.admittedImages).toContain('https://acmepet.com/images/chew-back.jpg');
    expect(outcomes.current_strict_images.admittedImages).not.toContain('https://acmepet.com/icons/social-share.png');

    // Hybrid surfaces title conflict between selector ("Acme All-Natural...") and JSON-LD ("Acme Dog Chew Toy")
    expect(outcomes.hybrid_identity_first.conflicts).toBeDefined();
    const titleConflict = outcomes.hybrid_identity_first.conflicts?.find(c => c.field === 'title');
    expect(titleConflict).toBeDefined();
  });

  it('records missing artifact as evidence gap without parser crash', async () => {
    const missingSample: AuditManifestSample = {
      ...sample,
      sampleId: 'sample-missing',
      artifactRef: null, // no retained snapshot!
    };

    const outcomes = await replaySample(missingSample, profile, {
      artifactRoot: tempDir,
    });

    expect(outcomes.current_extraction.isEvidenceGap).toBe(true);
    expect(outcomes.current_strict_images.isEvidenceGap).toBe(true);
    expect(outcomes.structured_only.isEvidenceGap).toBe(true);
    expect(outcomes.hybrid_identity_first.isEvidenceGap).toBe(true);
  });
});
