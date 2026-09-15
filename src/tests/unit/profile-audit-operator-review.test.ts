import { describe, it, expect } from 'vitest';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
  HybridConflict,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome } from '../../onboarding/profile-audit/types';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';
import {
  computeWilsonScoreInterval,
  explainMissingField,
  buildSideBySideFieldEvidence,
  buildImageContactSheet,
  computeScopeSummaries,
  formatPerScopeSummaryTable,
  formatSideBySideFieldEvidenceTable,
  formatMissingFieldsSummary,
  formatImageContactSheetMarkdown,
  formatHtmlContactSheet,
  generateOperatorReviewReport,
} from '../../onboarding/profile-audit/operator-review';
import { scoreExtraction } from '../../onboarding/profile-audit/scorer';

describe('Profile Audit Gate T4: Operator Review Surface (Issue #177)', () => {
  // ── Test Fixture Helpers ──────────────────────────────────────────────────
  function createSample(overrides: Partial<AuditManifestSample> = {}): AuditManifestSample {
    return {
      sampleId: 'sample-1',
      url: 'https://example.com/products/organic-dog-shampoo-16oz',
      domain: 'example.com',
      stratum: 'example.com:shopify:standard_pdp:single_variant',
      inventoryStatus: 'confirmed',
      // Independent, reviewed, versioned provenance satisfies the
      // per-observation label contract; gap/provenance behavior is covered
      // by dedicated tests that override these flags.
      groundTruthSource: 'independent',
      isReviewed: true,
      labelVersion: '1.0.0',
      artifactRef: 'snapshots/sample-1.html',
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: true,
      captureFreshness: '2026-09-01T12:00:00Z',
      pageStructureScope: 'standard_pdp',
      platform: 'Shopify',
      productFamily: 'dog-shampoo',
      variantShape: 'single_variant',
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: 'Organic Dog Shampoo 16oz',
          gtin: '012345678901',
          sku: 'EB-DOG-16',
        },
        fields: {
          title: { available: true, expectedValue: 'Organic Dog Shampoo 16oz' },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '14.99' },
          sku: { available: true, expectedValue: 'EB-DOG-16' },
          gtin: { available: false, notes: 'Not displayed on PDP' },
          variant_flavor: { available: false, inapplicable: true, notes: 'Not applicable for single-variant shampoo' },
        },
        images: {
          primaryImage: 'https://example.com/images/hero-1200.jpg',
          admissibleImages: [
            'https://example.com/images/hero-1200.jpg',
            'https://example.com/images/back-label.jpg',
            'https://example.com/images/action-dog.jpg',
          ],
          inadmissibleImages: [
            'https://example.com/icons/facebook.svg',
            'https://example.com/images/hero-300.jpg', // duplicate resolution
          ],
        },
      },
      ...overrides,
    };
  }

  function createRowsForSample(sample: AuditManifestSample): AuditScoredRow[] {
    const baselineRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'current_extraction',
      identityVerdict: 'correct_match',
      fieldCorrectnessScore: 0.75, // missed sku
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: 'Organic Dog Shampoo 16oz',
          expectedValue: 'Organic Dog Shampoo 16oz',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: '14.99',
          expectedValue: '14.99',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        sku: {
          field: 'sku',
          available: true,
          extractedValue: null,
          expectedValue: 'EB-DOG-16',
          provenance: 'none',
          status: 'missing',
          correct: false,
          missingReason: 'failed',
          missingExplanation: 'Field is present on page but extraction failed',
        },
        gtin: {
          field: 'gtin',
          available: false,
          extractedValue: null,
          expectedValue: null,
          provenance: 'none',
          status: 'unavailable',
          correct: true,
          missingReason: 'absent',
          missingExplanation: 'Field is absent from source page (unavailable)',
        },
        variant_flavor: {
          field: 'variant_flavor',
          available: false,
          inapplicable: true,
          extractedValue: null,
          expectedValue: null,
          provenance: 'none',
          status: 'inapplicable',
          correct: true,
          missingReason: 'inapplicable',
          missingExplanation: 'Not applicable for single-variant shampoo',
        },
      },
      imageScores: {
        extractedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        admittedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        rejectedImages: [],
        primaryImage: 'https://example.com/images/hero-1200.jpg',
        primaryAccuracy: 1,
        precision: 0.5, // flooded with icon + duplicate
        recall: 0.67,
      },
      failureCodes: ['LOW_IMAGE_PRECISION', 'MISSING_AVAILABLE_FIELD'],
      isEvidenceGap: false,
      extractedProductPreview: {
        title: 'Organic Dog Shampoo 16oz',
        brand: 'Earthbath',
      },
    };

    const strictImagesRow: AuditScoredRow = {
      ...baselineRow,
      configuration: 'current_strict_images',
      imageScores: {
        extractedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        admittedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
        ],
        rejectedImages: [
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        primaryImage: 'https://example.com/images/hero-1200.jpg',
        primaryAccuracy: 1,
        precision: 1.0,
        recall: 0.67,
      },
      failureCodes: ['MISSING_AVAILABLE_FIELD'],
    };

    const structuredRow: AuditScoredRow = {
      ...baselineRow,
      configuration: 'structured_only',
      fieldCorrectnessScore: 0.75,
      fieldScores: {
        ...baselineRow.fieldScores,
        title: {
          field: 'title',
          available: true,
          extractedValue: 'Earthbath Pet Shampoo All Natural', // Structured name differs
          expectedValue: 'Organic Dog Shampoo 16oz',
          provenance: 'json-ld',
          status: 'incorrect',
          correct: false,
        },
        sku: {
          field: 'sku',
          available: true,
          extractedValue: 'EB-DOG-16',
          expectedValue: 'EB-DOG-16',
          provenance: 'json-ld',
          status: 'correct',
          correct: true,
        },
      },
    };

    const hybridRow: AuditScoredRow = {
      ...baselineRow,
      configuration: 'hybrid_identity_first',
      fieldCorrectnessScore: 1.0, // all available correct
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: 'Organic Dog Shampoo 16oz',
          expectedValue: 'Organic Dog Shampoo 16oz',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: '14.99',
          expectedValue: '14.99',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        },
        sku: {
          field: 'sku',
          available: true,
          extractedValue: 'EB-DOG-16',
          expectedValue: 'EB-DOG-16',
          provenance: 'json-ld', // hybrid filled SKU from structured!
          status: 'correct',
          correct: true,
        },
        gtin: {
          field: 'gtin',
          available: false,
          extractedValue: null,
          expectedValue: null,
          provenance: 'none',
          status: 'unavailable',
          correct: true,
          missingReason: 'absent',
          missingExplanation: 'Field is absent from source page (unavailable)',
        },
        variant_flavor: {
          field: 'variant_flavor',
          available: false,
          inapplicable: true,
          extractedValue: null,
          expectedValue: null,
          provenance: 'none',
          status: 'inapplicable',
          correct: true,
          missingReason: 'inapplicable',
          missingExplanation: 'Not applicable for single-variant shampoo',
        },
      },
      imageScores: {
        extractedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        admittedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
        ],
        rejectedImages: [
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        primaryImage: 'https://example.com/images/hero-1200.jpg',
        primaryAccuracy: 1,
        precision: 1.0,
        recall: 0.67,
      },
      failureCodes: ['NONE'],
    };

    return [baselineRow, strictImagesRow, structuredRow, hybridRow];
  }

  // ── Acceptance Criterion 1: Side-by-side Field Evidence ───────────────────
  describe('Acceptance Criterion 1: Side-by-side field evidence per sample across all four configurations', () => {
    it('constructs side-by-side field evidence showing values, provenance, and match status across all 4 configurations', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);

      const evidence = buildSideBySideFieldEvidence(sample, rows);

      expect(evidence.sampleId).toBe('sample-1');
      expect(evidence.url).toBe(sample.url);
      expect(evidence.scope).toBe('standard_pdp');
      expect(evidence.identityVerdicts.current_extraction).toBe('correct_match');
      expect(evidence.identityVerdicts.hybrid_identity_first).toBe('correct_match');

      // Check fields present
      const fieldNames = evidence.fields.map(f => f.field);
      expect(fieldNames).toContain('title');
      expect(fieldNames).toContain('brand');
      expect(fieldNames).toContain('price');
      expect(fieldNames).toContain('sku');
      expect(fieldNames).toContain('gtin');

      // Check SKU field: Baseline had missing/none, hybrid filled from json-ld
      const skuRow = evidence.fields.find(f => f.field === 'sku');
      expect(skuRow).toBeDefined();
      expect(skuRow?.cells.current_extraction.value).toBeNull();
      expect(skuRow?.cells.current_extraction.provenance).toBe('none');
      expect(skuRow?.cells.current_extraction.isCorrect).toBe(false);

      expect(skuRow?.cells.hybrid_identity_first.value).toBe('EB-DOG-16');
      expect(skuRow?.cells.hybrid_identity_first.provenance).toBe('json-ld');
      expect(skuRow?.cells.hybrid_identity_first.isCorrect).toBe(true);

      // Check Title field: Structured had disagreement
      const titleRow = evidence.fields.find(f => f.field === 'title');
      expect(titleRow?.cells.current_extraction.provenance).toBe('custom-selector');
      expect(titleRow?.cells.structured_only.provenance).toBe('json-ld');
      expect(titleRow?.disagreementDetected).toBe(true);
      expect(titleRow?.winnerConfiguration).toBe('hybrid_identity_first');
    });

    it('formats a reviewable side-by-side field evidence markdown table with provenance and match badges', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);
      const evidence = buildSideBySideFieldEvidence(sample, rows);

      const tableMd = formatSideBySideFieldEvidenceTable(evidence);

      expect(tableMd).toContain('### Sample: `sample-1` — Side-by-Side Field Evidence');
      expect(tableMd).toContain('| Field | Ground Truth | 1. Baseline | 2. Current + Strict | 3. Structured Only | 4. Hybrid (Identity-First) | Disagreement? |');
      expect(tableMd).toContain('custom-selector');
      expect(tableMd).toContain('json-ld');
      expect(tableMd).toContain('Organic Dog Shampoo 16oz');
      expect(tableMd).toContain('`[FAILED]`');
      expect(tableMd).toContain('`[ABSENT]`');
    });
  });

  // ── Acceptance Criterion 2: Missing-Field Explanations ─────────────────────
  describe('Acceptance Criterion 2: Every missing field explained as absent, inapplicable, conflicted, or failed', () => {
    it('explains absent field when field is unavailable on page', () => {
      const exp = explainMissingField('gtin', { available: false, extractedValue: null }, { available: false });
      expect(exp.reason).toBe('absent');
      expect(exp.explanation).toContain('Absent from page');
    });

    it('explains inapplicable field when field does not apply to product scope', () => {
      const exp = explainMissingField('variant_flavor', { available: false, extractedValue: null }, { available: false, inapplicable: true, notes: 'Single-variant product' });
      expect(exp.reason).toBe('inapplicable');
      expect(exp.explanation).toContain('Single-variant product');
    });

    it('explains conflicted field when selector and structured sources disagree', () => {
      const conflict: HybridConflict = {
        field: 'price',
        selectorValue: '14.99',
        structuredValue: '19.99',
        selectorSource: 'custom-selector',
        structuredSource: 'json-ld',
        resolution: 'flagged_conflict',
        disagreementReason: 'Selector: 14.99 vs Structured: 19.99',
      };
      const exp = explainMissingField('price', { available: true, status: 'conflict', conflictDetails: 'Selector: 14.99 vs Structured: 19.99' }, { available: true }, conflict);
      expect(exp.reason).toBe('conflicted');
      expect(exp.explanation).toContain('Selector: 14.99 vs Structured: 19.99');
    });

    it('explains failed field when field is available on page but extraction captured nothing', () => {
      const exp = explainMissingField('sku', { available: true, extractedValue: null }, { available: true });
      expect(exp.reason).toBe('failed');
      expect(exp.explanation).toContain('Extraction failed');
    });

    it('scoreExtraction sets missingReason and missingExplanation directly on FieldScoreDetail', () => {
      const sample = createSample();
      const outcome: ExtractionOutcome = {
        configuration: 'current_extraction',
        data: ExtractionDataSchema.parse({
          title: 'Organic Dog Shampoo 16oz',
          brand: 'Earthbath',
          description: null,
          price: null, // failed
          primaryImage: null,
          additionalImages: [],
          bulletPoints: [],
          confidence: 0.8,
          fieldProvenance: { title: 'custom-selector', brand: 'custom-selector' },
        }),
        admittedImages: [],
        rejectedImages: [],
        primaryImage: null,
        isEvidenceGap: false,
      };

      const scored = scoreExtraction(outcome, sample);

      // Available price missed -> failed
      expect(scored.fieldScores.price.missingReason).toBe('failed');
      expect(scored.fieldScores.price.missingExplanation).toContain('failed');

      // Unavailable GTIN -> absent
      expect(scored.fieldScores.gtin.missingReason).toBe('absent');
      expect(scored.fieldScores.gtin.missingExplanation?.toLowerCase()).toContain('absent');

      // Inapplicable variant flavor -> inapplicable
      expect(scored.fieldScores.variant_flavor.missingReason).toBe('inapplicable');
      expect(scored.fieldScores.variant_flavor.missingExplanation).toContain('Not applicable');
    });

    it('formats a structured Missing Fields Truth Table with counts and sample examples', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);
      const evidence = buildSideBySideFieldEvidence(sample, rows);

      const summaryMd = formatMissingFieldsSummary([evidence]);

      expect(summaryMd).toContain('## Missing Fields Truth Table');
      expect(summaryMd).toContain('Absent (Unavailable)');
      expect(summaryMd).toContain('Inapplicable');
      expect(summaryMd).toContain('Conflicted');
      expect(summaryMd).toContain('Extraction Failed');
      expect(summaryMd).toContain('sample-1:gtin');
    });
  });

  // ── Acceptance Criterion 3: Image Contact Sheets ──────────────────────────
  describe('Acceptance Criterion 3: Accepted and rejected image contact sheets per sample with primary flagged', () => {
    it('builds image contact sheet with primary flagged at index 0 and rejected reasons cataloged', () => {
      const sample = createSample();
      const outcome: ExtractionOutcome = {
        configuration: 'hybrid_identity_first',
        data: ExtractionDataSchema.parse({
          title: 'Organic Dog Shampoo 16oz',
          brand: 'Earthbath',
          description: 'Soothing shampoo',
          price: '14.99',
          primaryImage: 'https://example.com/images/hero-1200.jpg',
          additionalImages: ['https://example.com/images/back-label.jpg'],
          bulletPoints: [],
          confidence: 0.9,
        }),
        admittedImages: [
          'https://example.com/images/hero-1200.jpg',
          'https://example.com/images/back-label.jpg',
        ],
        rejectedImages: [
          'https://example.com/icons/facebook.svg',
          'https://example.com/images/hero-300.jpg',
        ],
        primaryImage: 'https://example.com/images/hero-1200.jpg',
        imageRejectionReasons: {
          'https://example.com/icons/facebook.svg': 'non_product_role: SVG social icon',
          'https://example.com/images/hero-300.jpg': 'resolution_duplicate: Duplicate of hero-1200.jpg',
        },
        isEvidenceGap: false,
      };

      const sheet = buildImageContactSheet(sample, outcome);

      expect(sheet.sampleId).toBe('sample-1');
      expect(sheet.totalDiscovered).toBe(4);
      expect(sheet.admittedCount).toBe(2);
      expect(sheet.rejectedCount).toBe(2);
      expect(sheet.primaryImage).toBe('https://example.com/images/hero-1200.jpg');
      expect(sheet.primaryAccuracy).toBe(1);

      // Primary flagged on acceptedImages[0]
      expect(sheet.acceptedImages[0].isPrimary).toBe(true);
      expect(sheet.acceptedImages[0].url).toBe('https://example.com/images/hero-1200.jpg');
      expect(sheet.acceptedImages[0].isExpectedPrimary).toBe(true);

      // Non-primary accepted
      expect(sheet.acceptedImages[1].isPrimary).toBe(false);
      expect(sheet.acceptedImages[1].role).toBe('gallery');

      // Rejected images with reasons
      expect(sheet.rejectedImages[0].url).toBe('https://example.com/icons/facebook.svg');
      expect(sheet.rejectedImages[0].rejectionReason).toContain('SVG social icon');
      expect(sheet.rejectedImages[1].rejectionReason).toContain('resolution_duplicate');
    });

    it('formats clean Markdown contact sheet with ⭐ PRIMARY badge and rejection reasons', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);
      const hybridRow = rows.find(r => r.configuration === 'hybrid_identity_first')!;
      const sheet = buildImageContactSheet(sample, hybridRow);

      const sheetMd = formatImageContactSheetMarkdown(sheet);

      expect(sheetMd).toContain('### Image Contact Sheet: `sample-1`');
      expect(sheetMd).toContain('⭐ **[PRIMARY]**');
      expect(sheetMd).toContain('🖼️ `[GALLERY]`');
      expect(sheetMd).toContain('#### Accepted Images');
      expect(sheetMd).toContain('#### Rejected Images');
      expect(sheetMd).toContain('https://example.com/icons/facebook.svg');
    });

    it('formats HTML contact sheet with visual cards, primary badges, and preview images', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);
      const hybridRow = rows.find(r => r.configuration === 'hybrid_identity_first')!;
      const sheet = buildImageContactSheet(sample, hybridRow);

      const html = formatHtmlContactSheet(sheet);

      expect(html).toContain('Contact Sheet: sample-1');
      expect(html).toContain('⭐ PRIMARY');
      expect(html).toContain('REJECTED');
      expect(html).toContain('<img src=');
    });
  });

  // ── Acceptance Criterion 4: Per-Scope Served-Rate Summary ─────────────────
  describe('Acceptance Criterion 4: Per-scope summary a store owner can read without opening every cell', () => {
    it('computes per-scope served-rate summary with baseline comparison, uncertainty, and promotability verdict', () => {
      const sample1 = createSample({ sampleId: 's1', pageStructureScope: 'standard_pdp', groundTruthSource: 'independent' });
      const sample2 = createSample({ sampleId: 's2', pageStructureScope: 'standard_pdp', groundTruthSource: 'independent' });
      const sample3 = createSample({ sampleId: 's3', pageStructureScope: 'standard_pdp', groundTruthSource: 'independent' });

      const allRows: AuditScoredRow[] = [
        ...createRowsForSample(sample1),
        ...createRowsForSample(sample2),
        ...createRowsForSample(sample3),
      ];

      // Strict-improvement shaping (finding 1): baseline trails hybrid on
      // primary accuracy and served rate so the summary can reach PROMOTABLE.
      const baselineRows = allRows.filter(r => r.configuration === 'current_extraction');
      baselineRows[0].imageScores.primaryAccuracy = 0;
      baselineRows[1].imageScores.primaryAccuracy = 0;
      baselineRows[1].identityVerdict = 'wrong_variant';
      baselineRows[2].identityVerdict = 'wrong_variant';

      const summaries = computeScopeSummaries([sample1, sample2, sample3], allRows);

      expect(summaries['standard_pdp']).toBeDefined();
      const s = summaries['standard_pdp'];

      expect(s.sampleCount).toBe(3);
      expect(s.scope).toBe('standard_pdp');

      // Baseline missed SKU on all samples, but critical fields (title, brand, price) were present, so baseline served
      expect(s.baselineServedRate).toBeGreaterThanOrEqual(0);
      expect(s.servedRate).toBe(1.0); // Hybrid served 100%
      expect(s.servedRateDelta).toBeGreaterThanOrEqual(0);

      // Uncertainty reported with 95% Wilson confidence interval
      expect(s.uncertainty).toBeGreaterThan(0);
      expect(s.confidenceInterval.lower).toBeGreaterThan(0);
      expect(s.confidenceInterval.upper).toBeLessThanOrEqual(1.0);

      // Quality metrics
      expect(s.identityAccuracy).toBe(1.0);
      expect(s.acceptedIdentityErrors).toBe(0);
      expect(s.criticalFieldRegressionCount).toBe(0);
      expect(s.meanImagePrecision).toBe(1.0);

      // Promotability verdict
      expect(s.isPromotable).toBe(true);
      expect(s.promotabilityVerdict).toBe('PROMOTABLE');
      expect(s.promotabilityReasons.some(r => r.includes('Zero observed identity errors'))).toBe(true);
      expect(s.promotabilityReasons.some(r => r.includes('Zero critical-field regressions'))).toBe(true);
    });

    it('blocks scope promotability when critical-field regression occurs', () => {
      const sample = createSample({ sampleId: 's1', pageStructureScope: 'tabbed_pdp' });
      const rows = createRowsForSample(sample);

      // Inject regression: hybrid fails on title where baseline succeeded
      const hybridRow = rows.find(r => r.configuration === 'hybrid_identity_first')!;
      hybridRow.fieldScores.title.correct = false;
      hybridRow.fieldScores.title.status = 'incorrect';

      const summaries = computeScopeSummaries([sample], rows, { minSamplesForPromote: 1 });
      const s = summaries['tabbed_pdp'];

      expect(s.criticalFieldRegressionCount).toBe(1);
      expect(s.isPromotable).toBe(false);
      expect(s.promotabilityVerdict).toBe('BLOCKED');
      expect(s.promotabilityReasons.some(r => r.includes('critical field regressions'))).toBe(true);
    });

    it('blocks scope promotability when identity error (wrong variant or confusion) occurs', () => {
      const sample = createSample({ sampleId: 's1', pageStructureScope: 'accordion_pdp' });
      const rows = createRowsForSample(sample);

      // Inject identity error in hybrid row
      const hybridRow = rows.find(r => r.configuration === 'hybrid_identity_first')!;
      hybridRow.identityVerdict = 'wrong_variant';

      const summaries = computeScopeSummaries([sample], rows, { minSamplesForPromote: 1 });
      const s = summaries['accordion_pdp'];

      expect(s.acceptedIdentityErrors).toBe(1);
      expect(s.isPromotable).toBe(false);
      expect(s.promotabilityVerdict).toBe('BLOCKED');
      expect(s.promotabilityReasons.some(r => r.includes('identity errors'))).toBe(true);
    });

    it('marks scope as NEEDS_REVIEW when sample size is below standard gate threshold (<3)', () => {
      const sample = createSample({ sampleId: 's1', pageStructureScope: 'sparse_pdp', groundTruthSource: 'independent' });
      const rows = createRowsForSample(sample);

      // Only 1 sample, minSamples defaults to 3
      const summaries = computeScopeSummaries([sample], rows);
      const s = summaries['sparse_pdp'];

      expect(s.isPromotable).toBe(false);
      expect(s.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(s.promotabilityReasons.some(r => r.includes('below standard gate threshold'))).toBe(true);
    });

    it('formats a single executive table that a store owner can read without opening individual cells', () => {
      const sample1 = createSample({ sampleId: 's1', pageStructureScope: 'standard_pdp', groundTruthSource: 'independent' });
      const sample2 = createSample({ sampleId: 's2', pageStructureScope: 'tabbed_pdp', groundTruthSource: 'independent' });
      const allRows = [...createRowsForSample(sample1), ...createRowsForSample(sample2)];

      // Strict-improvement shaping (finding 1) per scope.
      for (const r of allRows.filter(r => r.configuration === 'current_extraction')) {
        r.imageScores.primaryAccuracy = 0;
        r.identityVerdict = 'wrong_variant';
      }

      const summaries = computeScopeSummaries([sample1, sample2], allRows, { minSamplesForPromote: 1 });
      const tableMd = formatPerScopeSummaryTable(summaries);

      expect(tableMd).toContain('## Per-Scope Served-Rate Summary');
      expect(tableMd).toContain('| Scope | Platform | Samples | Baseline Served Rate | Hybrid Served Rate | Delta | 95% CI | Identity Acc | Field Correctness | Regressions | Img Precision | Primary Acc | Promotability Verdict |');
      expect(tableMd).toContain('`standard_pdp`');
      expect(tableMd).toContain('`tabbed_pdp`');
      expect(tableMd).toContain('PROMOTABLE');
      expect(tableMd).toContain('Shopify');
    });
  });

  // ── Full Operator Review Surface Report Generator ────────────────────────
  describe('Full Operator Review Surface Report Generator', () => {
    it('assembles the comprehensive Operator Review Surface report with all 4 pillars', () => {
      const sample1 = createSample({ sampleId: 's1', pageStructureScope: 'standard_pdp' });
      const sample2 = createSample({ sampleId: 's2', pageStructureScope: 'standard_pdp' });
      const allRows = [...createRowsForSample(sample1), ...createRowsForSample(sample2)];

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-13T20:00:00Z',
        samples: [sample1, sample2],
      };

      const report = generateOperatorReviewReport({
        manifest,
        rows: allRows,
      });

      expect(report.domain).toBe('example.com');
      expect(report.totalSamples).toBe(2);
      expect(report.totalScopes).toBe(1);
      expect(report.fieldEvidences).toHaveLength(2);
      expect(report.contactSheets).toHaveLength(2);

      // Verify Markdown includes all 4 pillars
      expect(report.markdown).toContain('# Profile Extraction Audit Gate: Operator Review Surface');
      expect(report.markdown).toContain('## Per-Scope Served-Rate Summary'); // Pillar 4
      expect(report.markdown).toContain('## Missing Fields Truth Table'); // Pillar 2
      expect(report.markdown).toContain('## Side-by-Side Field Evidence per Sample'); // Pillar 1
      expect(report.markdown).toContain('## Image Contact Sheets'); // Pillar 3

      // Verify HTML report
      expect(report.html).toContain('<h1>Operator Review: example.com</h1>');
      expect(report.html).toContain('⭐ PRIMARY');
    });
  });

  // ── Statistical Uncertainty Helpers ───────────────────────────────────────
  describe('Wilson Score Interval Calculation', () => {
    it('handles boundary values (0 successes, total successes) cleanly without NaN', () => {
      const zero = computeWilsonScoreInterval(0, 10);
      expect(zero.rate).toBe(0);
      expect(zero.lower).toBe(0);
      expect(zero.upper).toBeGreaterThan(0);
      expect(zero.upper).toBeLessThan(1);

      const all = computeWilsonScoreInterval(10, 10);
      expect(all.rate).toBe(1);
      expect(all.upper).toBe(1);
      expect(all.lower).toBeGreaterThan(0);

      const empty = computeWilsonScoreInterval(0, 0);
      expect(empty.rate).toBe(0);
      expect(empty.marginOfError).toBe(0);

      // Boundary clamp: successes > total does not produce NaN
      const over = computeWilsonScoreInterval(15, 10);
      expect(over.rate).toBe(1);
      expect(Number.isNaN(over.marginOfError)).toBe(false);
    });
  });

  // ── Edge Case & Robustness Suite (Step 2/Step 3 Verifications) ───────────
  describe('Robustness & Edge Cases', () => {
    it('does not count evidence gaps as accepted identity errors in scope promotability', () => {
      const sample1 = createSample({ sampleId: 's1', pageStructureScope: 'standard_pdp' });
      const sample2 = createSample({ sampleId: 's2', pageStructureScope: 'standard_pdp' });
      const sample3 = createSample({ sampleId: 's3', pageStructureScope: 'standard_pdp', hasSupplementalArtifact: false });

      const rows1 = createRowsForSample(sample1);
      const rows2 = createRowsForSample(sample2);
      const rows3 = createRowsForSample(sample3);

      // Mark sample 3 as an evidence gap in both baseline and hybrid
      const hybridRow3 = rows3.find(r => r.configuration === 'hybrid_identity_first')!;
      hybridRow3.isEvidenceGap = true;
      hybridRow3.evidenceGapReason = 'Missing snapshot artifact';
      hybridRow3.identityVerdict = 'unidentified';

      const baselineRow3 = rows3.find(r => r.configuration === 'current_extraction')!;
      baselineRow3.isEvidenceGap = true;
      baselineRow3.evidenceGapReason = 'Missing snapshot artifact';
      baselineRow3.identityVerdict = 'unidentified';

      const allRows = [...rows1, ...rows2, ...rows3];
      const summaries = computeScopeSummaries([sample1, sample2, sample3], allRows);
      const s = summaries['standard_pdp'];

      // Crucial: evidence gap must NOT increment acceptedIdentityErrors (not BLOCKED),
      // but gapped evidence receives NEEDS_REVIEW (Issue #188 / T2).
      expect(s.acceptedIdentityErrors).toBe(0);
      expect(s.evidenceGapCount).toBe(1);
      expect(s.isPromotable).toBe(false);
      expect(s.promotabilityVerdict).toBe('NEEDS_REVIEW');
    });

    it('preserves machine-readable rejection reasons when contact sheet is built from an AuditScoredRow', () => {
      const sample = createSample();
      const outcome: ExtractionOutcome = {
        configuration: 'hybrid_identity_first',
        data: ExtractionDataSchema.parse({
          title: 'Organic Dog Shampoo 16oz',
          brand: 'Earthbath',
          description: null,
          price: '14.99',
          primaryImage: 'https://example.com/hero.jpg',
          additionalImages: [],
          bulletPoints: [],
          confidence: 0.9,
        }),
        admittedImages: ['https://example.com/hero.jpg'],
        rejectedImages: ['https://example.com/icons/social.svg', 'https://example.com/hero-thumb.jpg'],
        primaryImage: 'https://example.com/hero.jpg',
        imageRejectionReasons: {
          'https://example.com/icons/social.svg': 'non_product_role: SVG social icon',
          'https://example.com/hero-thumb.jpg': 'resolution_duplicate: Duplicate hero thumbnail',
        },
        isEvidenceGap: false,
      };

      // Score the outcome (producing an AuditScoredRow)
      const scoredRow = scoreExtraction(outcome, sample);
      expect(scoredRow.imageScores.rejectionReasons).toBeDefined();

      // Build contact sheet directly from AuditScoredRow
      const sheet = buildImageContactSheet(sample, scoredRow);
      expect(sheet.rejectedImages).toHaveLength(2);
      expect(sheet.rejectedImages[0].rejectionReason).toBe('non_product_role: SVG social icon');
      expect(sheet.rejectedImages[0].role).toBe('icon');
      expect(sheet.rejectedImages[1].rejectionReason).toBe('resolution_duplicate: Duplicate hero thumbnail');
      expect(sheet.rejectedImages[1].role).toBe('duplicate');
    });

    it('flags exactly one primary image when primaryImage is at non-zero index in admittedImages', () => {
      const sample = createSample();
      const scoredRow = createRowsForSample(sample)[0];
      scoredRow.imageScores.admittedImages = [
        'https://example.com/images/gallery-1.jpg',
        'https://example.com/images/hero-1200.jpg', // primary is at index 1!
        'https://example.com/images/gallery-2.jpg',
      ];
      scoredRow.imageScores.primaryImage = 'https://example.com/images/hero-1200.jpg';

      const sheet = buildImageContactSheet(sample, scoredRow);
      const primaryItems = sheet.acceptedImages.filter(img => img.isPrimary);

      // Exactly ONE image flagged as primary
      expect(primaryItems).toHaveLength(1);
      expect(primaryItems[0].url).toBe('https://example.com/images/hero-1200.jpg');
      expect(sheet.acceptedImages[0].isPrimary).toBe(false);
      expect(sheet.acceptedImages[1].isPrimary).toBe(true);
      expect(sheet.acceptedImages[2].isPrimary).toBe(false);
    });

    it('formats HTML contact sheet safely with invalid URLs and special characters without throwing', () => {
      const sample = createSample({ url: 'invalid-url' });
      const scoredRow = createRowsForSample(sample)[0];
      scoredRow.imageScores.admittedImages = ['image-with-"quotes"&<tags>.jpg'];
      scoredRow.imageScores.primaryImage = 'image-with-"quotes"&<tags>.jpg';
      scoredRow.imageScores.rejectedImages = ['rejected-"xss".jpg'];

      const sheet = buildImageContactSheet(sample, scoredRow);

      // Must not throw TypeError: Invalid URL
      expect(() => formatHtmlContactSheet(sheet)).not.toThrow();

      const html = formatHtmlContactSheet(sheet);
      expect(html).toContain('&quot;');
      expect(html).not.toContain('<script>');
    });

    it('accumulates all failure reasons when multiple blocking conditions occur simultaneously', () => {
      const sample = createSample({ sampleId: 's1', pageStructureScope: 'multi_fail_pdp' });
      const rows = createRowsForSample(sample);

      const hybridRow = rows.find(r => r.configuration === 'hybrid_identity_first')!;
      // Failure 1: Identity error
      hybridRow.identityVerdict = 'wrong_product';
      // Failure 2: Critical field regression
      hybridRow.fieldScores.title.correct = false;
      hybridRow.fieldScores.title.status = 'incorrect';
      // Failure 3: Image precision regression
      hybridRow.imageScores.precision = 0.1;

      const summaries = computeScopeSummaries([sample], rows, { minSamplesForPromote: 1 });
      const s = summaries['multi_fail_pdp'];

      expect(s.promotabilityVerdict).toBe('BLOCKED');
      // All 3 failures should be articulated in the reasons array, not just the first one!
      expect(s.promotabilityReasons.some(r => r.includes('identity errors'))).toBe(true);
      expect(s.promotabilityReasons.some(r => r.includes('critical field regressions'))).toBe(true);
      expect(s.promotabilityReasons.some(r => r.includes('image precision'))).toBe(true);
    });

    it('applies targetConfidence option to computeScopeSummaries properly', () => {
      const sample = createSample({ sampleId: 's1' });
      const rows = createRowsForSample(sample);

      const summary95 = computeScopeSummaries([sample], rows, { targetConfidence: 0.95 });
      const summary99 = computeScopeSummaries([sample], rows, { targetConfidence: 0.99 });
      const summary90 = computeScopeSummaries([sample], rows, { targetConfidence: 0.90 });

      // 99% confidence interval is wider than 95%, which is wider than 90%
      expect(summary99['standard_pdp'].uncertainty).toBeGreaterThan(summary95['standard_pdp'].uncertainty);
      expect(summary95['standard_pdp'].uncertainty).toBeGreaterThan(summary90['standard_pdp'].uncertainty);
    });

    it('handles samples with missing rows or outcomes gracefully without throwing', () => {
      const sample = createSample({ sampleId: 's-empty' });
      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-13T20:00:00Z',
        samples: [sample],
      };

      // Rows array has NO rows for s-empty
      expect(() => generateOperatorReviewReport({ manifest, rows: [] })).not.toThrow();

      const report = generateOperatorReviewReport({ manifest, rows: [] });
      expect(report.fieldEvidences).toHaveLength(1);
      expect(report.contactSheets).toHaveLength(1);
      expect(report.contactSheets[0].admittedCount).toBe(0);
    });

    it('does not assign a winnerConfiguration when all configurations agree (zero disagreement)', () => {
      const sample = createSample();
      const rows = createRowsForSample(sample);

      // Force all configurations to agree on brand
      for (const r of rows) {
        r.fieldScores.brand = {
          field: 'brand',
          available: true,
          extractedValue: 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'custom-selector',
          status: 'correct',
          correct: true,
        };
      }

      const evidence = buildSideBySideFieldEvidence(sample, rows);
      const brandField = evidence.fields.find(f => f.field === 'brand')!;

      expect(brandField.disagreementDetected).toBe(false);
      expect(brandField.winnerConfiguration).toBeUndefined();
    });
  });

  describe('Round-2 fix-pass: missing configuration yields an empty gap sheet, never a mislabeled row', () => {
    it('emits an empty hybrid sheet when the hybrid row is absent (no baseline leak)', () => {
      const sample = createSample();
      const baselineOnly = createRowsForSample(sample).filter(
        r => r.configuration === 'current_extraction',
      );
      expect(baselineOnly).toHaveLength(1);
      expect(baselineOnly[0].imageScores.admittedImages.length).toBeGreaterThan(0);

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-13T20:00:00Z',
        samples: [sample],
      };
      const report = generateOperatorReviewReport({ manifest, rows: baselineOnly });
      const hybridSheets = report.contactSheetsByConfiguration!.hybrid_identity_first;
      expect(hybridSheets).toHaveLength(1);
      // Explicit gap: no images carried over from the baseline row.
      expect(hybridSheets[0].configuration).toBe('hybrid_identity_first');
      expect(hybridSheets[0].totalDiscovered).toBe(0);
      expect(hybridSheets[0].admittedCount).toBe(0);
    });
  });

  describe('Audit follow-through T3 (#186): positive-membership contact sheets and no cross-configuration mislabeling', () => {
    it('builds contact sheet showing accepted and rejected sets with machine-readable reasons and primary flagged', () => {
      const sample = createSample({
        groundTruth: {
          ...createSample().groundTruth,
          images: {
            primaryImage: 'https://example.com/images/primary-hero.jpg',
            admissibleImages: [
              'https://example.com/images/primary-hero.jpg',
              'https://example.com/images/shared-gallery.jpg',
            ],
            inadmissibleImages: [
              'https://example.com/images/other-variant.jpg',
              'https://example.com/images/unrelated-probe.jpg',
            ],
          },
        },
      });

      const outcome: ExtractionOutcome = {
        configuration: 'current_strict_images',
        data: ExtractionDataSchema.parse({
          title: 'Sample Product',
          brand: 'Brand',
          description: 'Description',
          price: '19.99',
          primaryImage: 'https://example.com/images/primary-hero.jpg',
          additionalImages: ['https://example.com/images/shared-gallery.jpg'],
          bulletPoints: [],
          confidence: 0.95,
        }),
        admittedImages: [
          'https://example.com/images/primary-hero.jpg',
          'https://example.com/images/shared-gallery.jpg',
        ],
        rejectedImages: [
          'https://example.com/images/other-variant.jpg',
          'https://example.com/images/unrelated-probe.jpg',
          'https://example.com/icons/social.svg',
          'https://example.com/images/thumb-dup.jpg',
          'https://example.com/images/overflow-cap.jpg',
        ],
        primaryImage: 'https://example.com/images/primary-hero.jpg',
        imageRejectionReasons: {
          'https://example.com/images/other-variant.jpg': 'other_variant',
          'https://example.com/images/unrelated-probe.jpg': 'unknown_membership',
          'https://example.com/icons/social.svg': 'role_rejected',
          'https://example.com/images/thumb-dup.jpg': 'resolution_duplicate',
          'https://example.com/images/overflow-cap.jpg': 'cap_exceeded',
        },
        isEvidenceGap: false,
      };

      const sheet = buildImageContactSheet(sample, outcome);

      expect(sheet.sampleId).toBe(sample.sampleId);
      expect(sheet.configuration).toBe('current_strict_images');
      expect(sheet.admittedCount).toBe(2);
      expect(sheet.rejectedCount).toBe(5);

      // Primary flagged on accepted list
      expect(sheet.acceptedImages[0].isPrimary).toBe(true);
      expect(sheet.acceptedImages[0].url).toBe('https://example.com/images/primary-hero.jpg');
      expect(sheet.acceptedImages[0].role).toBe('primary hero');

      // Gallery accepted
      expect(sheet.acceptedImages[1].isPrimary).toBe(false);
      expect(sheet.acceptedImages[1].url).toBe('https://example.com/images/shared-gallery.jpg');
      expect(sheet.acceptedImages[1].role).toBe('gallery');

      // Rejected list item roles and machine-readable reasons
      const rejOther = sheet.rejectedImages.find(img => img.url.includes('other-variant'))!;
      expect(rejOther.rejectionReason).toBe('other_variant');
      expect(rejOther.role).toBe('other_variant');

      const rejUnknown = sheet.rejectedImages.find(img => img.url.includes('unrelated-probe'))!;
      expect(rejUnknown.rejectionReason).toBe('unknown_membership');
      expect(rejUnknown.role).toBe('unknown_membership');

      const rejRole = sheet.rejectedImages.find(img => img.url.includes('social.svg'))!;
      expect(rejRole.rejectionReason).toBe('role_rejected');
      expect(rejRole.role).toBe('icon');

      const rejDup = sheet.rejectedImages.find(img => img.url.includes('thumb-dup'))!;
      expect(rejDup.rejectionReason).toBe('resolution_duplicate');
      expect(rejDup.role).toBe('duplicate');

      const rejCap = sheet.rejectedImages.find(img => img.url.includes('overflow-cap'))!;
      expect(rejCap.rejectionReason).toBe('cap_exceeded');
      expect(rejCap.role).toBe('cap_exceeded');
    });

    it('preserves configuration identity and eliminates cross-configuration mislabeling across all 4 configurations', () => {
      const sample = createSample({ sampleId: 'sample-x' });
      const rows = createRowsForSample(sample);

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-14T00:00:00Z',
        samples: [sample],
      };

      const report = generateOperatorReviewReport({ manifest, rows });

      // All 4 configurations must have contact sheets with exact matching configuration
      for (const cfg of ['current_extraction', 'current_strict_images', 'structured_only', 'hybrid_identity_first'] as const) {
        const sheets = report.contactSheetsByConfiguration![cfg];
        expect(sheets).toHaveLength(1);
        expect(sheets[0].configuration).toBe(cfg);
        expect(sheets[0].sampleId).toBe('sample-x');
      }

      // Markdown report includes configuration labels
      const md = report.markdown;
      expect(md).toContain('Image Contact Sheet: `sample-x`');
      expect(md).toContain('Per-Configuration Image Evidence');

      // HTML report includes configuration attributes
      const html = report.html;
      expect(html).toContain('Contact Sheet: sample-x');
    });
  });
});

