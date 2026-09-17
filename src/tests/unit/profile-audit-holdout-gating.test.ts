import { describe, it, expect } from 'vitest';
import type {
  AuditManifestSample,
  AuditScoredRow,
} from '../../shared/schemas/profile-audit';
import { evaluateGateArithmetic } from '../../onboarding/profile-audit/gate-arithmetic';
import { generatePromotionReport } from '../../onboarding/profile-audit/promotion-report';

/**
 * Holdout gating for contract promotion (Issue #196).
 *
 * Decision: YES — a future contract-promotion GO requires an explicit
 * holdout GO on every evaluated scope, so strong tuning performance can
 * never mask weak generalization.
 *
 * - Any holdout NO_GO → overall NO_GO (demonstrated generalization failure).
 * - Any holdout NEEDS_REVIEW, or any scope with no holdout coverage at all →
 *   overall NEEDS_REVIEW (fail-closed: generalization cannot be claimed
 *   without sufficient holdout evidence).
 * - Overall GO only when every combined verdict AND every holdout verdict
 *   is GO.
 */
describe('Profile Audit Holdout Gating (Issue #196)', () => {
  function createSample(
    id: string,
    scope: string = 'standard_pdp',
    isHoldout: boolean = false,
  ): AuditManifestSample {
    return {
      sampleId: id,
      url: `https://example.com/products/${id}`,
      domain: 'example.com',
      stratum: `example.com:shopify:${scope}:single_variant`,
      inventoryStatus: 'confirmed',
      groundTruthSource: 'independent',
      isReviewed: true,
      labelVersion: '1.0.0',
      artifactRef: `snapshots/${id}.html`,
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: true,
      captureFreshness: '2026-09-01T12:00:00Z',
      pageStructureScope: scope,
      platform: 'Shopify',
      productFamily: isHoldout ? 'holdout-family' : 'tuning-family',
      variantShape: 'single_variant',
      isHoldout,
      holdoutFamilyName: isHoldout ? 'holdout-family' : null,
      groundTruth: {
        identity: {
          brand: 'Earthbath',
          productName: `Product ${id}`,
          gtin: '012345678901',
          sku: `SKU-${id}`,
        },
        fields: {
          title: { available: true, expectedValue: `Product ${id}` },
          brand: { available: true, expectedValue: 'Earthbath' },
          price: { available: true, expectedValue: '14.99' },
          sku: { available: true, expectedValue: `SKU-${id}` },
          gtin: { available: false, notes: 'Not on PDP' },
        },
        images: {
          primaryImage: `https://example.com/images/${id}-primary.jpg`,
          admissibleImages: [
            `https://example.com/images/${id}-primary.jpg`,
            `https://example.com/images/${id}-label.jpg`,
          ],
        },
      },
    };
  }

  function createRowsForSample(
    sample: AuditManifestSample,
    overrides: {
      baselinePrecision?: number;
      hybridPrecision?: number;
      baselinePrimaryAccuracy?: number;
      hybridPrimaryAccuracy?: number;
      baselineIdentityVerdict?: 'correct_match' | 'wrong_variant' | 'wrong_product';
      hybridIdentityVerdict?: 'correct_match' | 'wrong_variant' | 'wrong_product';
    } = {},
  ): AuditScoredRow[] {
    const baselineRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'current_extraction',
      identityVerdict: overrides.baselineIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: 0.75,
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: sample.groundTruth.identity.productName,
          expectedValue: sample.groundTruth.identity.productName,
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
          expectedValue: `SKU-${sample.sampleId}`,
          provenance: 'none',
          status: 'missing',
          correct: false,
        },
      },
      imageScores: {
        extractedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: overrides.baselinePrimaryAccuracy ?? 1,
        precision: overrides.baselinePrecision ?? 0.5,
        recall: 0.8,
      },
      failureCodes: ['NONE'],
      isEvidenceGap: false,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
      latencyMs: 110,
      requestCount: 1,
    };

    const hybridRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'hybrid_identity_first',
      identityVerdict: overrides.hybridIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: 1.0,
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: sample.groundTruth.identity.productName,
          expectedValue: sample.groundTruth.identity.productName,
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
          extractedValue: `SKU-${sample.sampleId}`,
          expectedValue: `SKU-${sample.sampleId}`,
          provenance: 'json-ld',
          status: 'correct',
          correct: true,
        },
      },
      imageScores: {
        extractedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: overrides.hybridPrimaryAccuracy ?? 1,
        precision: overrides.hybridPrecision ?? 0.95,
        recall: 0.8,
      },
      failureCodes: ['NONE'],
      isEvidenceGap: false,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
      latencyMs: 140,
      requestCount: 1,
    };

    return [baselineRow, hybridRow];
  }

  /** Tuning subset shaped for a clear GO: baseline trails hybrid everywhere. */
  function tuningRows(sample: AuditManifestSample, badBaseline: boolean): AuditScoredRow[] {
    return createRowsForSample(
      sample,
      badBaseline
        ? { baselinePrimaryAccuracy: 0, baselineIdentityVerdict: 'wrong_variant' }
        : {},
    );
  }

  it('strong tuning with weak holdout must not promote: holdout NO_GO forces overall NO_GO', () => {
    // 6 tuning samples shaped for GO, 3 holdout samples whose hybrid image
    // precision regresses below baseline (generalization failure on a mean
    // dimension the tuning majority would otherwise carry).
    const tuning = [
      createSample('t1', 'standard_pdp', false),
      createSample('t2', 'standard_pdp', false),
      createSample('t3', 'standard_pdp', false),
      createSample('t4', 'standard_pdp', false),
      createSample('t5', 'standard_pdp', false),
      createSample('t6', 'standard_pdp', false),
    ];
    const holdout = [
      createSample('h1', 'standard_pdp', true),
      createSample('h2', 'standard_pdp', true),
      createSample('h3', 'standard_pdp', true),
    ];
    const samples = [...tuning, ...holdout];

    const rows = [
      ...tuningRows(tuning[0], false),
      ...tuningRows(tuning[1], true),
      ...tuningRows(tuning[2], true),
      ...tuningRows(tuning[3], true),
      ...tuningRows(tuning[4], true),
      ...tuningRows(tuning[5], true),
      // Holdout: identity and fields fine, but hybrid precision regresses —
      // the candidate does not generalize to the held-out family.
      ...createRowsForSample(holdout[0], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(holdout[1], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(holdout[2], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
    ];

    const result = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

    expect(result.tuningVerdictsByScope['standard_pdp'].verdict).toBe('GO');
    expect(result.holdoutVerdictsByScope['standard_pdp'].verdict).toBe('NO_GO');
    expect(result.verdictsByScope['standard_pdp'].verdict).toBe('GO');
    // The regression: without holdout gating the overall verdict is GO.
    expect(result.overallContractVerdict).toBe('NO_GO');
  });

  it('insufficient holdout evidence blocks promotion: holdout NEEDS_REVIEW forces overall NEEDS_REVIEW', () => {
    const tuning = [
      createSample('t1', 'standard_pdp', false),
      createSample('t2', 'standard_pdp', false),
      createSample('t3', 'standard_pdp', false),
      createSample('t4', 'standard_pdp', false),
    ];
    // Only 2 holdout samples: below the quorum of 3, so the holdout
    // partition reports NEEDS_REVIEW rather than a verdict on quality.
    const holdout = [
      createSample('h1', 'standard_pdp', true),
      createSample('h2', 'standard_pdp', true),
    ];
    const samples = [...tuning, ...holdout];

    const rows = [
      ...tuningRows(tuning[0], false),
      ...tuningRows(tuning[1], true),
      ...tuningRows(tuning[2], true),
      ...tuningRows(tuning[3], true),
      ...createRowsForSample(holdout[0]),
      ...createRowsForSample(holdout[1]),
    ];

    const result = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

    expect(result.holdoutVerdictsByScope['standard_pdp'].verdict).toBe('NEEDS_REVIEW');
    expect(result.overallContractVerdict).toBe('NEEDS_REVIEW');
  });

  it('missing holdout coverage blocks promotion: no holdout samples forces overall NEEDS_REVIEW', () => {
    const samples = [
      createSample('t1', 'standard_pdp', false),
      createSample('t2', 'standard_pdp', false),
      createSample('t3', 'standard_pdp', false),
      createSample('t4', 'standard_pdp', false),
    ];
    const rows = [
      ...tuningRows(samples[0], false),
      ...tuningRows(samples[1], true),
      ...tuningRows(samples[2], true),
      ...tuningRows(samples[3], true),
    ];

    const result = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

    // The combined scope still evaluates GO on its own merits...
    expect(result.verdictsByScope['standard_pdp'].verdict).toBe('GO');
    // ...but generalization was never measured, so the contract verdict
    // stays fail-closed.
    expect(Object.keys(result.holdoutVerdictsByScope).length).toBe(0);
    expect(result.overallContractVerdict).toBe('NEEDS_REVIEW');
  });

  it('a holdout NO_GO in any one scope blocks the overall contract verdict', () => {
    const goodScope = [
      createSample('a1', 'standard_pdp', false),
      createSample('a2', 'standard_pdp', false),
      createSample('a3', 'standard_pdp', false),
      createSample('ah1', 'standard_pdp', true),
      createSample('ah2', 'standard_pdp', true),
      createSample('ah3', 'standard_pdp', true),
    ];
    // Bad scope reuses the proven masking shape (6 tuning carry the combined
    // mean while the 3-sample holdout regresses), so the combined verdict is
    // GO and only the holdout partition blocks promotion.
    const badScope = [
      createSample('b1', 'tabbed_pdp', false),
      createSample('b2', 'tabbed_pdp', false),
      createSample('b3', 'tabbed_pdp', false),
      createSample('b4', 'tabbed_pdp', false),
      createSample('b5', 'tabbed_pdp', false),
      createSample('b6', 'tabbed_pdp', false),
      createSample('bh1', 'tabbed_pdp', true),
      createSample('bh2', 'tabbed_pdp', true),
      createSample('bh3', 'tabbed_pdp', true),
    ];
    const samples = [...goodScope, ...badScope];

    const rows = [
      ...tuningRows(goodScope[0], false),
      ...tuningRows(goodScope[1], true),
      ...tuningRows(goodScope[2], true),
      ...tuningRows(goodScope[3], false),
      ...tuningRows(goodScope[4], true),
      ...tuningRows(goodScope[5], true),
      ...tuningRows(badScope[0], false),
      ...tuningRows(badScope[1], true),
      ...tuningRows(badScope[2], true),
      ...tuningRows(badScope[3], true),
      ...tuningRows(badScope[4], true),
      ...tuningRows(badScope[5], true),
      ...createRowsForSample(badScope[6], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(badScope[7], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(badScope[8], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
    ];

    const result = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

    expect(result.holdoutVerdictsByScope['standard_pdp'].verdict).toBe('GO');
    expect(result.holdoutVerdictsByScope['tabbed_pdp'].verdict).toBe('NO_GO');
    expect(result.overallContractVerdict).toBe('NO_GO');
  });

  it('tuning GO plus holdout GO still promotes: the gate does not over-block', () => {
    const tuning = [
      createSample('t1', 'standard_pdp', false),
      createSample('t2', 'standard_pdp', false),
      createSample('t3', 'standard_pdp', false),
    ];
    const holdout = [
      createSample('h1', 'standard_pdp', true),
      createSample('h2', 'standard_pdp', true),
      createSample('h3', 'standard_pdp', true),
    ];
    const samples = [...tuning, ...holdout];

    const rows = [
      ...tuningRows(tuning[0], false),
      ...tuningRows(tuning[1], true),
      ...tuningRows(tuning[2], true),
      ...tuningRows(holdout[0], false),
      ...tuningRows(holdout[1], true),
      ...tuningRows(holdout[2], true),
    ];

    const result = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

    expect(result.tuningVerdictsByScope['standard_pdp'].verdict).toBe('GO');
    expect(result.holdoutVerdictsByScope['standard_pdp'].verdict).toBe('GO');
    expect(result.verdictsByScope['standard_pdp'].verdict).toBe('GO');
    expect(result.overallContractVerdict).toBe('GO');
  });

  it('the promotion report explains when holdout evidence gates the overall verdict', () => {
    const tuning = [
      createSample('t1', 'standard_pdp', false),
      createSample('t2', 'standard_pdp', false),
      createSample('t3', 'standard_pdp', false),
      createSample('t4', 'standard_pdp', false),
      createSample('t5', 'standard_pdp', false),
      createSample('t6', 'standard_pdp', false),
    ];
    const holdout = [
      createSample('h1', 'standard_pdp', true),
      createSample('h2', 'standard_pdp', true),
      createSample('h3', 'standard_pdp', true),
    ];
    const samples = [...tuning, ...holdout];
    const rows = [
      ...tuningRows(tuning[0], false),
      ...tuningRows(tuning[1], true),
      ...tuningRows(tuning[2], true),
      ...tuningRows(tuning[3], true),
      ...tuningRows(tuning[4], true),
      ...tuningRows(tuning[5], true),
      ...createRowsForSample(holdout[0], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(holdout[1], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
      ...createRowsForSample(holdout[2], { baselinePrecision: 0.5, hybridPrecision: 0.45 }),
    ];

    const report = generatePromotionReport({
      manifest: { domain: 'example.com', generatedAt: '2026-09-15T00:00:00Z', samples },
      rows,
      gateOptions: { minSamplesForPromote: 3 },
    });

    expect(report.overallContractVerdict).toBe('NO_GO');
    expect(report.markdown).toContain('Holdout Gating');
  });
});
