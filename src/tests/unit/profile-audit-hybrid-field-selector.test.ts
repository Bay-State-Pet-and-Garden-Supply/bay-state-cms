import { describe, it, expect } from 'vitest';
import { selectHybridFields } from '../../onboarding/profile-audit/hybrid-field-selector';
import { scoreExtraction } from '../../onboarding/profile-audit/scorer';
import type { AuditManifestSample } from '../../shared/schemas/profile-audit';

describe('profile audit gate T3: hybrid field selector and strict image filter', () => {
  const url = 'https://example.com/products/puppy-shampoo';
  const html = '<html><body><h1>Puppy Shampoo</h1></body></html>';

  // ──────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 1: Identity resolved before field selection;
  // parent-page versus variant confusion visible in output
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 1: Identity resolution and parent-page vs variant confusion', () => {
    it('resolves variant identity first from variant matrix and attaches decision & selected candidate', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-16oz',
            title: 'Puppy Shampoo 16oz',
            price: '14.99',
            available: true,
            identifiers: [{ kind: 'sku', value: 'SKU-16', normalizedValue: 'sku-16' }],
            options: [{ axis: 'Size', value: '16oz', normalizedAxis: 'size', normalizedValue: '16oz' }],
            images: [{ url: 'https://example.com/img-16.jpg', role: 'primary' }],
          },
          {
            variantKey: 'var-32oz',
            title: 'Puppy Shampoo 32oz',
            price: '24.99',
            available: true,
            identifiers: [{ kind: 'sku', value: 'SKU-32', normalizedValue: 'sku-32' }],
            options: [{ axis: 'Size', value: '32oz', normalizedAxis: 'size', normalizedValue: '32oz' }],
            images: [{ url: 'https://example.com/img-32.jpg', role: 'primary' }],
          },
        ],
      };

      const raw: any = {
        custom: { title: 'Puppy Shampoo 16oz' },
        jsonLd: { name: 'Puppy Shampoo' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: ['https://example.com/img-16.jpg', 'https://example.com/img-32.jpg'],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Puppy Shampoo 16oz', sku: 'SKU-16' },
      });

      expect(result.variantDecision).toBeTruthy();
      expect(result.variantDecision?.selectedVariantKey).toBe('var-16oz');
      expect(result.selectedCandidate?.variantKey).toBe('var-16oz');
      expect(result.identityResolution.status).toBe('resolved_variant');
      expect(result.identityResolution.totalCandidates).toBe(2);
      expect(result.identityResolution.selectedVariantKey).toBe('var-16oz');
      expect(result.data.sku).toBe('SKU-16');
      expect(result.data.price).toBe('14.99');
    });

    it('surfaces parent-page versus variant confusion when selector extracts generic parent title', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-16oz',
            title: 'Puppy Shampoo 16oz Vanilla',
            price: '14.99',
            available: true,
            identifiers: [{ kind: 'sku', value: 'SKU-16', normalizedValue: 'sku-16' }],
            options: [],
            images: [],
          },
          {
            variantKey: 'var-32oz',
            title: 'Puppy Shampoo 32oz Vanilla',
            price: '24.99',
            available: true,
            identifiers: [{ kind: 'sku', value: 'SKU-32', normalizedValue: 'sku-32' }],
            options: [],
            images: [],
          },
        ],
      };

      const raw: any = {
        // Selector picked the generic parent title from page h1
        custom: { title: 'Puppy Shampoo' },
        jsonLd: { name: 'Puppy Shampoo' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Puppy Shampoo 16oz Vanilla', sku: 'SKU-16' },
      });

      expect(result.identityResolution.confusionDetected).toBe(true);
      expect(result.identityResolution.confusionType).toBe('parent_vs_variant');
      expect(result.identityResolution.confusionDetails).toContain('Selector extracted parent-page title');
      expect(result.identityResolution.confusionDetails).toContain('Puppy Shampoo 16oz Vanilla');
    });

    it('surfaces parent-page versus variant confusion when selector extracts parent/container SKU', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-small',
            title: 'Collar - Small',
            identifiers: [{ kind: 'sku', value: 'SKU-COLLAR-SM', normalizedValue: 'sku-collar-sm' }],
            options: [],
            images: [],
          },
          {
            variantKey: 'var-large',
            title: 'Collar - Large',
            identifiers: [{ kind: 'sku', value: 'SKU-COLLAR-LG', normalizedValue: 'sku-collar-lg' }],
            options: [],
            images: [],
          },
        ],
      };

      const raw: any = {
        custom: {
          title: 'Collar - Small',
          sku: 'PARENT-COLLAR-MAIN', // Parent container SKU
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Collar - Small', sku: 'SKU-COLLAR-SM' },
      });

      expect(result.identityResolution.confusionDetected).toBe(true);
      expect(result.identityResolution.confusionType).toBe('parent_vs_variant');
      expect(result.identityResolution.confusionDetails).toContain('PARENT-COLLAR-MAIN');
      expect(result.identityResolution.confusionDetails).toContain('SKU-COLLAR-SM');
    });

    it('surfaces parent-page versus variant confusion when selector extracts container/parent GTIN', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-1',
            title: 'Shampoo 16oz',
            identifiers: [{ kind: 'gtin', value: '012345678901', normalizedValue: '012345678901' }],
            options: [],
            images: [],
          },
          {
            variantKey: 'var-2',
            title: 'Shampoo 32oz',
            identifiers: [{ kind: 'gtin', value: '098765432109', normalizedValue: '098765432109' }],
            options: [],
            images: [],
          },
        ],
      };

      const raw: any = {
        custom: {
          title: 'Shampoo 16oz',
          gtin: '999999999999', // Contradicts resolved variant's GTIN
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Shampoo 16oz', gtin: '012345678901' },
      });

      expect(result.identityResolution.confusionDetected).toBe(true);
      expect(result.identityResolution.confusionType).toBe('parent_vs_variant');
      expect(result.identityResolution.confusionDetails).toContain('999999999999');
      expect(result.identityResolution.confusionDetails).toContain('012345678901');
    });

    it('surfaces parent-page versus variant confusion when multi-variant matching is ambiguous', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-1',
            title: 'Widget A',
            identifiers: [],
            options: [],
            images: [],
          },
          {
            variantKey: 'var-2',
            title: 'Widget B',
            identifiers: [],
            options: [],
            images: [],
          },
        ],
      };

      const raw: any = {
        custom: { title: 'Generic Widget' },
        jsonLd: { name: 'Generic Widget' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      // Mock an ambiguous decision
      const ambiguousDecision: any = {
        status: 'ambiguous',
        selectedVariantKey: null,
        reasonCodes: ['multiple_options_match'],
        matchedBy: 'none',
        diagnostics: ['Equal score between var-1 and var-2'],
        rankedKeys: ['var-1', 'var-2'],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        variantDecision: ambiguousDecision,
      });

      expect(result.identityResolution.confusionDetected).toBe(true);
      expect(result.identityResolution.confusionType).toBe('ambiguous_variant');
      expect(result.identityResolution.status).toBe('ambiguous_variant');
      expect(result.selectedCandidate).toBeNull();
    });

    it('propagates PARENT_PAGE_VARIANT_CONFUSION to scorer failureCodes', () => {
      const sample: AuditManifestSample = {
        sampleId: 'sample-confused',
        url,
        domain: 'example.com',
        stratum: 'standard_pdp',
        inventoryStatus: 'confirmed',
        artifactRef: 'example.com/snapshot-1/page.html',
        supplementalArtifactRefs: [],
        hasSupplementalArtifact: true,
        captureFreshness: '2026-09-01T00:00:00Z',
        groundTruth: {
          identity: {
            brand: 'Earthbath',
            productName: 'Puppy Shampoo',
            variantName: '16oz',
          },
          fields: {
            title: { available: true, expectedValue: 'Puppy Shampoo 16oz' },
          },
          images: {
            primaryImage: null,
            admissibleImages: [],
          },
        },
      };

      const outcome: any = {
        configuration: 'hybrid_identity_first',
        data: {
          title: 'Puppy Shampoo', // Generic parent title, missing variant
          brand: 'Earthbath',
          confidence: 1,
        },
        identityResolution: {
          status: 'resolved_variant',
          totalCandidates: 2,
          selectedVariantKey: 'var-16oz',
          selectedCandidateTitle: 'Puppy Shampoo 16oz',
          parentTitle: 'Puppy Shampoo',
          confusionDetected: true,
          confusionType: 'parent_vs_variant',
          confusionDetails: 'Parent title lacks variant details',
        },
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, sample);
      expect(scored.failureCodes).toContain('PARENT_PAGE_VARIANT_CONFUSION');
      expect(scored.identityVerdict).toBe('wrong_variant');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 2: JSON-LD versus selector disagreements surfaced
  // as conflicts with provenance, never silently resolved
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 2: JSON-LD versus selector disagreements surfaced as conflicts', () => {
    it('surfaces title conflict with provenance when selector and JSON-LD disagree', () => {
      const raw: any = {
        custom: {
          title: 'Selector Puppy Shampoo 16oz',
          brand: 'Earthbath',
        },
        jsonLd: {
          name: 'JSON-LD Gentle Puppy Shampoo Formula',
          brand: { name: 'Earthbath' },
        },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      const c = result.conflicts[0];
      expect(c.field).toBe('title');
      expect(c.selectorValue).toBe('Selector Puppy Shampoo 16oz');
      expect(c.structuredValue).toBe('JSON-LD Gentle Puppy Shampoo Formula');
      expect(c.selectorSource).toBe('custom-selector');
      expect(c.structuredSource).toBe('json-ld');
      expect(c.resolution).toBe('selector_preferred_with_conflict');
      expect(result.fieldProvenance.title).toBe('custom-selector');
      expect(result.data.title).toBe('Selector Puppy Shampoo 16oz');
    });

    it('surfaces price conflict when selector and structured price disagree numerically', () => {
      const raw: any = {
        custom: { price: '$14.99' },
        jsonLd: {
          offers: { price: '19.99' },
        },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      const c = result.conflicts[0];
      expect(c.field).toBe('price');
      expect(c.selectorValue).toBe('$14.99');
      expect(c.structuredValue).toBe('19.99');
      expect(c.severity).toBe('critical');
    });

    it('surfaces SKU conflict when selector and structured SKU disagree', () => {
      const raw: any = {
        custom: { sku: 'SKU-SELECTOR-123' },
        jsonLd: { sku: 'SKU-JSONLD-456' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      const c = result.conflicts[0];
      expect(c.field).toBe('sku');
      expect(c.selectorValue).toBe('SKU-SELECTOR-123');
      expect(c.structuredValue).toBe('SKU-JSONLD-456');
    });

    it('surfaces GTIN conflict when selector and structured GTIN disagree', () => {
      const raw: any = {
        custom: { gtin: '012345678901' },
        jsonLd: { gtin12: '098765432109' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      const c = result.conflicts[0];
      expect(c.field).toBe('gtin');
      expect(c.selectorValue).toBe('012345678901');
      expect(c.structuredValue).toBe('098765432109');
    });

    it('surfaces brand conflict when selector and structured brand disagree', () => {
      const raw: any = {
        custom: { brand: 'Earthbath Grooming' },
        jsonLd: { brand: 'Earthbath' },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe('brand');
    });

    it('surfaces description conflict when substantive content diverges', () => {
      const raw: any = {
        custom: {
          description: '<p>Organic oatmeal and aloe formula designed to calm sensitive itchy skin.</p>',
        },
        jsonLd: {
          description: 'Puppy teething gel infused with chamomile and peppermint.',
        },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].field).toBe('description');
    });

    it('produces NO conflict when values agree normalized or only one source exists', () => {
      const raw: any = {
        custom: {
          title: 'Earthbath Oatmeal & Aloe Shampoo',
          price: '$18.99',
        },
        jsonLd: {
          name: 'Earthbath - Oatmeal & Aloe Shampoo', // Punctuation/spacing only
          offers: { price: '18.99' },
          description: 'Soothing organic dog shampoo', // Only in JSON-LD
        },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.conflicts).toHaveLength(0);
      expect(result.data.title).toBe('Earthbath Oatmeal & Aloe Shampoo');
      expect(result.fieldProvenance.title).toBe('custom-selector');
      expect(result.data.description).toBe('Soothing organic dog shampoo');
      expect(result.fieldProvenance.description).toBe('json-ld');
    });

    it('scorer marks FIELD_CONFLICT in failureCodes and fieldScores when conflict exists', () => {
      const sample: AuditManifestSample = {
        sampleId: 'sample-conflict',
        url,
        domain: 'example.com',
        stratum: 'standard_pdp',
        inventoryStatus: 'confirmed',
        artifactRef: 'example.com/snapshot-1/page.html',
        supplementalArtifactRefs: [],
        hasSupplementalArtifact: true,
        captureFreshness: '2026-09-01T00:00:00Z',
        groundTruth: {
          identity: { brand: 'Earthbath', productName: 'Puppy Shampoo' },
          fields: {
            title: { available: true, expectedValue: 'Puppy Shampoo 16oz' },
            price: { available: true, expectedValue: '14.99' },
          },
          images: { primaryImage: null, admissibleImages: [] },
        },
      };

      const outcome: any = {
        configuration: 'hybrid_identity_first',
        data: {
          title: 'Puppy Shampoo 16oz',
          brand: 'Earthbath',
          price: '14.99',
          fieldProvenance: { title: 'custom-selector', price: 'custom-selector' },
        },
        conflicts: [
          {
            field: 'price',
            selectorValue: '14.99',
            structuredValue: '19.99',
            selectorSource: 'custom-selector',
            structuredSource: 'json-ld',
            resolution: 'selector_preferred_with_conflict',
          },
        ],
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, sample);
      expect(scored.failureCodes).toContain('FIELD_CONFLICT');
      expect(scored.fieldScores.price.status).toBe('conflict');
      expect(scored.fieldScores.price.conflictDetails).toContain('Selector (custom-selector): "14.99"');
      expect(scored.fieldScores.price.conflictDetails).toContain('Structured (json-ld): "19.99"');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 3: No gallery unioned blindly; admitted and rejected
  // image sets recorded with the primary flagged
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 3: Strict image filtering across all contributed sources', () => {
    it('gathers images from all sources (variant, custom, JSON-LD, meta, gallery) before filtering', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-1',
            title: 'Var 1',
            images: [{ url: 'https://example.com/cdn/products/variant-primary.jpg', role: 'primary' }],
          },
        ],
      };

      const raw: any = {
        custom: {
          images: ['https://example.com/cdn/products/custom-selector.jpg'],
        },
        jsonLd: {
          image: ['https://example.com/cdn/products/jsonld-image.jpg'],
        },
        metaTags: {
          'og:image': 'https://example.com/cdn/products/og-image.jpg',
        },
        microdata: {
          image: 'https://example.com/cdn/products/microdata-image.jpg',
        },
        images: [
          'https://example.com/cdn/products/gallery-image.jpg',
          'https://example.com/assets/facebook-icon.png', // role-rejected non-product
        ],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Var 1' },
      });

      // All legitimate sources contributed and were admitted
      expect(result.admittedImages).toContain('https://example.com/cdn/products/variant-primary.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/custom-selector.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/jsonld-image.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/og-image.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/microdata-image.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/gallery-image.jpg');

      // Primary image is correctly flagged from the variant candidate
      expect(result.primaryImage).toBe('https://example.com/cdn/products/variant-primary.jpg');
      expect(result.admittedImages[0]).toBe('https://example.com/cdn/products/variant-primary.jpg');

      // Non-product role image was rejected with machine-readable reason
      expect(result.rejectedImages).toContain('https://example.com/assets/facebook-icon.png');
      expect(result.imageRejectionReasons['https://example.com/assets/facebook-icon.png']).toBe('role_rejected');
    });

    it('admits selected variant + proven shared product images, and rejects other-variant images', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'blue',
            title: 'Blue Toy',
            available: true,
            identifiers: [{ kind: 'sku', value: 'TOY-BLUE', normalizedValue: 'toy-blue' }],
            options: [{ axis: 'Color', value: 'Blue', normalizedAxis: 'color', normalizedValue: 'blue' }],
            images: [
              { url: 'https://example.com/cdn/products/toy-blue.jpg', role: 'primary' },
              { url: 'https://example.com/cdn/products/shared-dimensions.jpg', role: 'gallery' },
            ],
          },
          {
            variantKey: 'red',
            title: 'Red Toy',
            available: true,
            identifiers: [{ kind: 'sku', value: 'TOY-RED', normalizedValue: 'toy-red' }],
            options: [{ axis: 'Color', value: 'Red', normalizedAxis: 'color', normalizedValue: 'red' }],
            images: [
              { url: 'https://example.com/cdn/products/toy-red.jpg', role: 'primary' },
              { url: 'https://example.com/cdn/products/shared-dimensions.jpg', role: 'gallery' },
            ],
          },
        ],
      };

      const raw: any = {
        custom: {
          images: [
            'https://example.com/cdn/products/toy-blue.jpg',
            'https://example.com/cdn/products/toy-red.jpg',
            'https://example.com/cdn/products/shared-dimensions.jpg',
          ],
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Blue Toy' },
      });

      expect(result.admittedImages).toContain('https://example.com/cdn/products/toy-blue.jpg');
      expect(result.admittedImages).toContain('https://example.com/cdn/products/shared-dimensions.jpg');
      expect(result.admittedImages).not.toContain('https://example.com/cdn/products/toy-red.jpg');

      expect(result.rejectedImages).toContain('https://example.com/cdn/products/toy-red.jpg');
      expect(result.imageRejectionReasons['https://example.com/cdn/products/toy-red.jpg']).toBe('other_variant');
    });

    it('rejects unrelated-product images with no membership evidence as unknown_membership in hybrid selection', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'blue',
            title: 'Blue Toy',
            available: true,
            identifiers: [{ kind: 'sku', value: 'TOY-BLUE', normalizedValue: 'toy-blue' }],
            images: [
              { url: 'https://example.com/cdn/products/toy-blue.jpg', role: 'primary' },
            ],
          },
          {
            variantKey: 'red',
            title: 'Red Toy',
            available: true,
            identifiers: [{ kind: 'sku', value: 'TOY-RED', normalizedValue: 'toy-red' }],
            images: [
              { url: 'https://example.com/cdn/products/toy-red.jpg', role: 'primary' },
            ],
          },
        ],
      };

      const raw: any = {
        custom: {
          images: [
            'https://example.com/cdn/products/toy-blue.jpg',
            'https://example.com/cdn/products/toy-red.jpg',
          ],
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [
          'https://example.com/cdn/products/cross-sell-cat-litter.jpg', // Unrelated probe from page heuristics
        ],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Blue Toy' },
      });

      expect(result.admittedImages).toEqual(['https://example.com/cdn/products/toy-blue.jpg']);
      expect(result.rejectedImages).toContain('https://example.com/cdn/products/toy-red.jpg');
      expect(result.imageRejectionReasons['https://example.com/cdn/products/toy-red.jpg']).toBe('other_variant');

      expect(result.rejectedImages).toContain('https://example.com/cdn/products/cross-sell-cat-litter.jpg');
      expect(result.imageRejectionReasons['https://example.com/cdn/products/cross-sell-cat-litter.jpg']).toBe('unknown_membership');
    });

    it('rejects swatches, badges, and marketing banners with role_rejected', () => {
      const raw: any = {
        custom: {
          images: [
            'https://example.com/cdn/products/toy-main.jpg',
            'https://example.com/cdn/products/blue-color-swatch.png',
            'https://example.com/assets/free-shipping-badge.png',
            'https://example.com/assets/promo-banner.jpg',
            'https://example.com/assets/visa-logo.png',
          ],
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      expect(result.admittedImages).toEqual(['https://example.com/cdn/products/toy-main.jpg']);
      expect(result.rejectedImages).toContain('https://example.com/cdn/products/blue-color-swatch.png');
      expect(result.rejectedImages).toContain('https://example.com/assets/free-shipping-badge.png');
      expect(result.rejectedImages).toContain('https://example.com/assets/promo-banner.jpg');
      expect(result.rejectedImages).toContain('https://example.com/assets/visa-logo.png');
    });

    it('records dropped resolution variations with resolution_duplicate', () => {
      const raw: any = {
        custom: {
          images: [
            'https://earthbath.com/cdn/shop/files/shampoo_400x.png?v=123',
            'https://earthbath.com/cdn/shop/files/shampoo_800x.png?v=123',
            'https://earthbath.com/cdn/shop/files/shampoo_1800x.png?v=123',
          ],
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      // Only 1 canonical high-res image admitted
      expect(result.admittedImages).toHaveLength(1);
      expect(result.primaryImage).toBe(result.admittedImages[0]);

      // Dropped resolution duplicates recorded in rejectedImages
      expect(result.rejectedImages.length).toBeGreaterThanOrEqual(2);
      expect(result.imageRejectionReasons['https://earthbath.com/cdn/shop/files/shampoo_800x.png?v=123']).toBe('resolution_duplicate');
      expect(result.imageRejectionReasons['https://earthbath.com/cdn/shop/files/shampoo_1800x.png?v=123']).toBe('resolution_duplicate');
    });

    it('enforces safety caps and marks excess images with cap_exceeded', () => {
      const manyImages = Array.from({ length: 20 }, (_, i) => `https://example.com/cdn/products/photo-${i}.jpg`);
      const raw: any = {
        custom: { images: manyImages },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });

      // Default cap is 12
      expect(result.admittedImages).toHaveLength(12);
      expect(result.rejectedImages).toHaveLength(8);
      expect(result.imageRejectionReasons['https://example.com/cdn/products/photo-12.jpg']).toBe('cap_exceeded');
    });

    it('prioritizes variant candidate primary image over custom primaryImage selector', () => {
      const fakeMatrix: any = {
        platform: 'shopify',
        canonicalParentUrl: url,
        warnings: [],
        candidates: [
          {
            variantKey: 'var-blue',
            title: 'Blue Collar',
            images: [
              { url: 'https://example.com/cdn/products/blue-collar-variant-primary.jpg', role: 'primary' },
              { url: 'https://example.com/cdn/products/blue-collar-side.jpg', role: 'gallery' },
            ],
          },
        ],
      };

      const raw: any = {
        custom: {
          primaryImage: 'https://example.com/cdn/products/parent-page-hero.jpg', // Page hero selector
          images: ['https://example.com/cdn/products/parent-page-hero.jpg'],
        },
        jsonLd: {},
        metaTags: {},
        microdata: {},
        images: [],
      };

      const result = selectHybridFields({
        raw,
        url,
        html,
        variantMatrix: fakeMatrix,
        expected: { name: 'Blue Collar' },
      });

      // Variant candidate primary MUST beat custom hero primary
      expect(result.primaryImage).toBe('https://example.com/cdn/products/blue-collar-variant-primary.jpg');
      expect(result.admittedImages[0]).toBe('https://example.com/cdn/products/blue-collar-variant-primary.jpg');
    });

    it('does not trigger conflict when GTINs are equivalent under GS1 0-padding (12 vs 13 digits)', () => {
      const raw: any = {
        custom: { gtin: '012345678901' }, // 12-digit UPC
        jsonLd: { gtin13: '0012345678901' }, // 13-digit EAN
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });
      expect(result.conflicts).toHaveLength(0);
    });

    it('does not trigger description conflict when differences are only HTML entity encoding', () => {
      const raw: any = {
        custom: {
          description: '<p>Earthbath&#39;s &amp; puppies &quot;gentle&quot; wash formula</p>',
        },
        jsonLd: {
          description: "Earthbath's & puppies \"gentle\" wash formula",
        },
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };

      const result = selectHybridFields({ raw, url, html });
      expect(result.conflicts).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 4: Image-rights verification unchanged and out of this arm
  // ──────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 4: Image-rights verification unchanged and out of this arm', () => {
    it('does not import or invoke image-verification modules in hybrid arm', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');

      const hybridCode = fs.readFileSync(
        path.resolve(process.cwd(), 'src/onboarding/profile-audit/hybrid-field-selector.ts'),
        'utf8',
      );
      const strictCode = fs.readFileSync(
        path.resolve(process.cwd(), 'src/onboarding/profile-audit/strict-image-filter.ts'),
        'utf8',
      );

      // Must not reference image-verification
      expect(hybridCode).not.toContain('image-verification');
      expect(strictCode).not.toContain('image-verification');
    });
  });
});
