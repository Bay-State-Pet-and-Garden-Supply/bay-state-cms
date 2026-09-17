import { describe, it, expect } from 'vitest';
import {
  inspectProfileUrl,
  applyExceptionResolution,
  validateSiblingUrls,
  type OutputFirstInspectionResult,
  type ExceptionQueueItem,
} from '../../onboarding/profile-workspace/output-first-service';
import {
  getProfileWorkspacePath,
  parseWorkspaceParams,
} from '../../client/components/profile-workspace/route';
import { deriveReadinessState } from '../../onboarding/profile-readiness';

describe('Output-First Workspace Flow (#191)', () => {
  const sampleHtmlSingleVariant = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Earthbath Oatmeal &amp; Aloe Dog Shampoo 16oz</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Earthbath Oatmeal & Aloe Dog Shampoo 16oz",
          "image": [
            "https://example.com/images/earthbath-shampoo-front.jpg",
            "https://example.com/images/earthbath-shampoo-back.jpg",
            "https://example.com/icons/social-facebook.png"
          ],
          "description": "Natural shampoo for dry, itchy skin.",
          "brand": {
            "@type": "Brand",
            "name": "Earthbath"
          },
          "sku": "EB-OAT-16",
          "gtin12": "748405001018",
          "offers": {
            "@type": "Offer",
            "price": "14.99",
            "priceCurrency": "USD"
          }
        }
        </script>
      </head>
      <body>
        <h1>Earthbath Oatmeal &amp; Aloe Dog Shampoo 16oz</h1>
      </body>
    </html>
  `;

  const sampleHtmlMultiVariant = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Earthbath Shampoo</title>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "ProductGroup",
          "name": "Earthbath Shampoo",
          "brand": "Earthbath",
          "hasVariant": [
            {
              "@type": "Product",
              "name": "Oatmeal & Aloe 16oz",
              "sku": "EB-OAT-16",
              "image": ["https://example.com/images/variant-oatmeal.jpg"]
            },
            {
              "@type": "Product",
              "name": "Tea Tree Oil 16oz",
              "sku": "EB-TEA-16",
              "image": ["https://example.com/images/variant-teatree.jpg"]
            }
          ]
        }
        </script>
      </head>
      <body>
        <h1>Earthbath Shampoo</h1>
        <div class="gallery">
          <img src="https://example.com/images/unrelated-accessory.jpg" />
        </div>
      </body>
    </html>
  `;

  const sampleHtmlMissingAndVague = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Shampoo</title>
      </head>
      <body>
        <h1>Shampoo</h1>
        <!-- Missing brand, price, sku, description -->
        <img src="https://example.com/images/shampoo.jpg" />
      </body>
    </html>
  `;

  describe('Acceptance Criterion 1: URL ingest without authoring selectors first', () => {
    it('renders resolved product and variant, per-field values with sources, and gallery with primary flagged', async () => {
      const result = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/earthbath-oatmeal-shampoo',
        html: sampleHtmlSingleVariant,
        profile: null, // Zero custom selectors authored!
      });

      // Resolved product and variant
      expect(result.identity.status).toBe('single_variant');
      expect(result.identity.selectedCandidateTitle || result.fields.title.value).toContain('Earthbath Oatmeal & Aloe Dog Shampoo');
      expect(result.identity.isVague).toBe(false);

      // Per-field values with sources
      expect(result.fields.title.value).toBe('Earthbath Oatmeal & Aloe Dog Shampoo 16oz');
      expect(result.fields.title.source).toBe('json-ld');
      expect(result.fields.title.status).toBe('extracted');

      expect(result.fields.brand.value).toBe('Earthbath');
      expect(result.fields.brand.source).toBe('json-ld');

      expect(result.fields.price.value).toBe('14.99');
      expect(result.fields.price.source).toBe('json-ld');

      expect(result.fields.sku.value).toBe('EB-OAT-16');
      expect(result.fields.sku.source).toBe('json-ld');

      expect(result.fields.gtin.value).toBe('748405001018');
      expect(result.fields.gtin.source).toBe('json-ld');

      // Gallery with primary flagged
      expect(result.gallery.primaryImage).toBe('https://example.com/images/earthbath-shampoo-front.jpg');
      expect(result.gallery.admittedImages).toContain('https://example.com/images/earthbath-shampoo-front.jpg');
      expect(result.gallery.admittedImages).toContain('https://example.com/images/earthbath-shampoo-back.jpg');

      // Decorative role-rejected image is filtered out
      expect(result.gallery.rejectedImages.some((r) => r.url.includes('social-facebook'))).toBe(true);

      // Clean single-variant page has no blocking exceptions
      expect(result.exceptionQueue).toHaveLength(0);
    });
  });

  describe('Acceptance Criterion 2: Exception queue and deep resolution', () => {
    it('holds ONLY missing, conflicted, unknown-membership, and vague-identity items', async () => {
      // 1. Missing fields + vague identity sample
      const vagueResult = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/shampoo',
        html: sampleHtmlMissingAndVague,
        profile: null,
        expected: { name: 'Earthbath Oatmeal Shampoo 16oz' },
      });

      const categories = new Set(vagueResult.exceptionQueue.map((item) => item.category));
      for (const cat of categories) {
        expect(['missing', 'conflicted', 'unknown-membership', 'vague-identity']).toContain(cat);
      }

      // Should have vague-identity because "Shampoo" is a generic fragment of the full product name
      expect(categories.has('vague-identity')).toBe(true);
      // Should have missing fields because price and brand are missing
      expect(categories.has('missing')).toBe(true);
    });

    it('populates conflicted items when selector and structured sources disagree', async () => {
      const mockProfile: any = {
        id: 'prof-1',
        domain: 'example.com',
        priceSelector: '.custom-price',
        customSelectors: {},
      };

      const htmlWithSelectorConflict = `
        <!DOCTYPE html>
        <html>
          <head>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Product",
              "name": "Earthbath Oatmeal Dog Shampoo 16oz",
              "brand": "Earthbath",
              "offers": { "@type": "Offer", "price": "14.99" }
            }
            </script>
          </head>
          <body>
            <h1>Earthbath Oatmeal Dog Shampoo 16oz</h1>
            <div class="custom-price">$19.99</div>
          </body>
        </html>
      `;

      const result = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/shampoo',
        html: htmlWithSelectorConflict,
        profile: mockProfile,
      });

      const conflictItem = result.exceptionQueue.find((item) => item.category === 'conflicted');
      expect(conflictItem).toBeDefined();
      expect(conflictItem?.field).toBe('price');
      expect(conflictItem?.currentValue).toContain('19.99');
      expect(conflictItem?.conflictingValue).toBe('14.99');
      expect(conflictItem?.resolutions.length).toBeGreaterThanOrEqual(2);
    });

    it('populates unknown-membership items for unverified images on multi-variant pages', async () => {
      const result = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/earthbath-shampoo',
        html: sampleHtmlMultiVariant,
        profile: null,
        expected: { name: 'Oatmeal & Aloe 16oz', sku: 'EB-OAT-16' },
      });

      const unknownMembershipItems = result.exceptionQueue.filter((item) => item.category === 'unknown-membership');
      // The unrelated image has no positive membership evidence for the selected variant
      expect(unknownMembershipItems.length).toBeGreaterThan(0);
      expect(unknownMembershipItems[0].imageUrl).toContain('unrelated-accessory.jpg');
      expect(unknownMembershipItems[0].resolutions.some((r) => r.action === 'admit_variant_image')).toBe(true);
    });

    it('deep-resolves exception queue items with manual pick, source selection, or variant pick', async () => {
      const initial = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/shampoo',
        html: sampleHtmlMissingAndVague,
        profile: null,
      });

      const missingPrice = initial.exceptionQueue.find((e) => e.category === 'missing' && e.field === 'price');
      expect(missingPrice).toBeDefined();

      // Deep resolve missing price with manual value override or picker
      const updatedAfterPrice = applyExceptionResolution(initial, missingPrice!.id, {
        action: 'manual_value',
        value: '12.99',
      });

      expect(updatedAfterPrice.fields.price.value).toBe('12.99');
      expect(updatedAfterPrice.fields.price.source).toBe('manual-override');
      expect(updatedAfterPrice.exceptionQueue.some((e) => e.category === 'missing' && e.field === 'price')).toBe(false);
    });

    it('deep-links item-level failures into workspace as seed samples via query params', () => {
      const path = getProfileWorkspacePath('example.com', {
        seedUrl: 'https://example.com/products/failed-item-42',
        failureReason: 'vague_identity',
        returnPath: '/onboarding?stage=extraction',
      });

      expect(path).toContain('/settings/domains/example.com/profile');
      expect(path).toContain('seedUrl=https%3A%2F%2Fexample.com%2Fproducts%2Ffailed-item-42');
      expect(path).toContain('failureReason=vague_identity');
      expect(path).toContain('return=%2Fonboarding%3Fstage%3Dextraction');

      const parsed = parseWorkspaceParams(path.split('?')[1]);
      expect(parsed.seedUrl).toBe('https://example.com/products/failed-item-42');
      expect(parsed.failureReason).toBe('vague_identity');
      expect(parsed.returnPath).toBe('/onboarding?stage=extraction');
    });
  });

  describe('Acceptance Criterion 3: Sibling-URL validation and fail-closed approval', () => {
    it('requires sibling-URL validation before approval and keeps drafting proposal-only until approved', async () => {
      const siblingHtmlPass = `
        <!DOCTYPE html>
        <html>
          <head>
            <script type="application/ld+json">
            {
              "@context": "https://schema.org/",
              "@type": "Product",
              "name": "Earthbath Oatmeal Dog Shampoo 16oz",
              "brand": "Earthbath",
              "offers": { "@type": "Offer", "price": "14.99" }
            }
            </script>
          </head>
          <body><h1>Earthbath Oatmeal Dog Shampoo 16oz</h1></body>
        </html>
      `;

      const siblingHtmlFail = `
        <!DOCTYPE html>
        <html>
          <head><title>Empty</title></head>
          <body><h1>Broken Page</h1></body>
        </html>
      `;

      // 1. Validation fails when a sibling URL has missing required fields
      const failingValidation = await validateSiblingUrls({
        domain: 'example.com',
        siblingPages: [
          { url: 'https://example.com/p1', html: siblingHtmlPass },
          { url: 'https://example.com/p2', html: siblingHtmlPass },
          { url: 'https://example.com/p3', html: siblingHtmlFail }, // Fails!
        ],
        profile: null,
      });

      expect(failingValidation.ok).toBe(false);
      expect(failingValidation.passedCount).toBe(2);
      expect(failingValidation.totalSiblings).toBe(3);
      expect(failingValidation.canApprove).toBe(false);

      // 2. Validation passes when all siblings succeed
      const passingValidation = await validateSiblingUrls({
        domain: 'example.com',
        siblingPages: [
          { url: 'https://example.com/p1', html: siblingHtmlPass },
          { url: 'https://example.com/p2', html: siblingHtmlPass },
          { url: 'https://example.com/p3', html: siblingHtmlPass },
        ],
        profile: null,
      });

      expect(passingValidation.ok).toBe(true);
      expect(passingValidation.passedCount).toBe(3);
      expect(passingValidation.totalSiblings).toBe(3);
      expect(passingValidation.passRate).toBe(1.0);
      expect(passingValidation.canApprove).toBe(true);
    });

    it('preserves fail-closed extraction behavior and existing readiness vocabulary', () => {
      // Sibling-URL validation and reviewer approval have not been executed
      const unapprovedReadiness = deriveReadinessState({
        hasProfile: false,
        hasIndex: true,
        hasDraft: true, // Draft exists as proposal-only
        confirmedCount: 3,
        testsPass: false, // Sibling tests not passed
        isActive: false,
        needsRevalidation: true, // Fails closed
        productCount: 15,
      });

      expect(unapprovedReadiness.overall).toBe('Needs testing');
      expect(unapprovedReadiness.overall).not.toBe('Active');

      // Approved after passing sibling validation
      const approvedReadiness = deriveReadinessState({
        hasProfile: true,
        hasIndex: true,
        hasDraft: true,
        confirmedCount: 3,
        testsPass: true,
        isActive: true,
        needsRevalidation: false,
        productCount: 15,
      });

      expect(approvedReadiness.overall).toBe('Active');
    });

    it('records workspace metrics: time to first working profile, corrections, sibling pass rate', async () => {
      const initial = await inspectProfileUrl({
        domain: 'example.com',
        url: 'https://example.com/products/shampoo',
        html: sampleHtmlMissingAndVague,
        profile: null,
        startTime: Date.now() - 1500,
      });

      expect(initial.metrics.timeToFirstWorkingProfileMs).toBeGreaterThan(0);
      expect(initial.metrics.exceptionsCount).toBeGreaterThan(0);
      expect(initial.metrics.manualCorrectionsCount).toBe(0);

      const afterCorrection = applyExceptionResolution(initial, initial.exceptionQueue[0].id, {
        action: 'manual_value',
        value: 'Corrected Brand',
      });

      expect(afterCorrection.metrics.manualCorrectionsCount).toBe(1);
    });
  });
});
