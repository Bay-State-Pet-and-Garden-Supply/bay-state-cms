import { describe, it, expect } from 'vitest';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
} from '../../shared/schemas/profile-audit';
import { evaluateScopeGate } from '../../onboarding/profile-audit/gate-arithmetic';
import {
  resolveUsableObservations,
  inspectLabelProvenance,
} from '../../onboarding/profile-audit/promotion-eligibility';
import { generatePromotionReport } from '../../onboarding/profile-audit/promotion-report';

describe('Profile Audit Trustworthy Promotion (Issue #188 / T2)', () => {
  function createSample(
    id: string,
    scope: string = 'standard_pdp',
    provenance?: 'independent' | 'auto-derived',
    options: {
      isHoldout?: boolean;
      holdoutFamilyName?: string;
      inventoryStatus?: 'confirmed' | 'candidate';
      artifactRef?: string | null;
    } = {},
  ): AuditManifestSample {
    return {
      sampleId: id,
      url: `https://example.com/products/${id}`,
      domain: 'example.com',
      stratum: `example.com:shopify:${scope}:single_variant`,
      inventoryStatus: options.inventoryStatus ?? 'confirmed',
      artifactRef: options.artifactRef !== undefined ? options.artifactRef : `snapshots/${id}.html`,
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: true,
      captureFreshness: '2026-09-01T12:00:00Z',
      pageStructureScope: scope,
      platform: 'Shopify',
      productFamily: 'dog-shampoo',
      variantShape: 'single_variant',
      groundTruthSource: provenance,
      isHoldout: options.isHoldout ?? false,
      holdoutFamilyName: options.holdoutFamilyName ?? (options.isHoldout ? 'shampoo-family' : null),
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
      isHybridGap?: boolean;
      isBaselineGap?: boolean;
      hybridPrecision?: number;
      baselinePrecision?: number;
      hybridFieldScore?: number;
      baselineFieldScore?: number;
      hybridServed?: boolean;
      baselineServed?: boolean;
      hybridIdentityVerdict?: 'correct_match' | 'wrong_product' | 'wrong_variant' | 'ambiguous' | 'unidentified';
      baselineIdentityVerdict?: 'correct_match' | 'wrong_product' | 'wrong_variant' | 'ambiguous' | 'unidentified';
      identicalOutput?: boolean;
    } = {},
  ): [AuditScoredRow, AuditScoredRow] {
    const isBaselineGap = overrides.isBaselineGap ?? false;
    const isHybridGap = overrides.isHybridGap ?? false;
    const baselinePrecision = overrides.baselinePrecision ?? 0.8;
    const hybridPrecision = overrides.identicalOutput ? baselinePrecision : (overrides.hybridPrecision ?? 0.95);
    const baselineFieldScore = overrides.baselineFieldScore ?? 0.8;
    const hybridFieldScore = overrides.identicalOutput ? baselineFieldScore : (overrides.hybridFieldScore ?? 0.9);

    const titleExtracted = overrides.identicalOutput
      ? sample.groundTruth.identity.productName
      : sample.groundTruth.identity.productName;

    const baselineRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'current_extraction',
      identityVerdict: overrides.baselineIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: isBaselineGap ? 0 : baselineFieldScore,
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: isBaselineGap ? null : titleExtracted,
          expectedValue: sample.groundTruth.identity.productName,
          provenance: 'custom-selector',
          status: isBaselineGap ? 'missing' : 'correct',
          correct: !isBaselineGap,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: isBaselineGap ? null : 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'custom-selector',
          status: isBaselineGap ? 'missing' : 'correct',
          correct: !isBaselineGap,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: isBaselineGap ? null : '14.99',
          expectedValue: '14.99',
          provenance: 'custom-selector',
          status: isBaselineGap ? 'missing' : 'correct',
          correct: !isBaselineGap,
        },
      },
      imageScores: {
        extractedImages: isBaselineGap ? [] : [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: isBaselineGap ? [] : [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: isBaselineGap ? null : `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: isBaselineGap ? 0 : 1,
        precision: isBaselineGap ? 0 : baselinePrecision,
        recall: isBaselineGap ? 0 : 0.8,
      },
      failureCodes: isBaselineGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : [],
      isEvidenceGap: isBaselineGap,
      evidenceGapReason: isBaselineGap ? 'Missing snapshot artifact' : null,
      extractedProductPreview: {
        title: isBaselineGap ? null : sample.groundTruth.identity.productName,
        brand: isBaselineGap ? null : 'Earthbath',
      },
    };

    const hybridRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'hybrid_identity_first',
      identityVerdict: overrides.hybridIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: isHybridGap ? 0 : hybridFieldScore,
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: isHybridGap ? null : titleExtracted,
          expectedValue: sample.groundTruth.identity.productName,
          provenance: 'structured',
          status: isHybridGap ? 'missing' : 'correct',
          correct: !isHybridGap,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: isHybridGap ? null : 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'structured',
          status: isHybridGap ? 'missing' : 'correct',
          correct: !isHybridGap,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: isHybridGap ? null : '14.99',
          expectedValue: '14.99',
          provenance: 'structured',
          status: isHybridGap ? 'missing' : 'correct',
          correct: !isHybridGap,
        },
      },
      imageScores: {
        extractedImages: isHybridGap ? [] : [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: isHybridGap ? [] : [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: isHybridGap ? null : `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: isHybridGap ? 0 : 1,
        precision: isHybridGap ? 0 : hybridPrecision,
        recall: isHybridGap ? 0 : 0.85,
      },
      failureCodes: isHybridGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : [],
      isEvidenceGap: isHybridGap,
      evidenceGapReason: isHybridGap ? 'Missing snapshot artifact' : null,
      extractedProductPreview: {
        title: isHybridGap ? null : sample.groundTruth.identity.productName,
        brand: isHybridGap ? null : 'Earthbath',
      },
    };

    return [baselineRow, hybridRow];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 1: Missing / Gapped Page Evidence Receives NEEDS_REVIEW
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 1: missing/gapped page evidence never promotes', () => {
    it('a scope whose page artifacts are all missing receives NEEDS_REVIEW with evidence-gap reasons, never GO', () => {
      // 5 samples where page artifacts are missing, minSamples = 5
      const samples = [
        createSample('s1', 'standard_pdp', 'independent', { artifactRef: null }),
        createSample('s2', 'standard_pdp', 'independent', { artifactRef: null }),
        createSample('s3', 'standard_pdp', 'independent', { artifactRef: null }),
        createSample('s4', 'standard_pdp', 'independent', { artifactRef: null }),
        createSample('s5', 'standard_pdp', 'independent', { artifactRef: null }),
      ];

      // All rows are evidence gaps
      const rows = samples.flatMap(s =>
        createRowsForSample(s, { isBaselineGap: true, isHybridGap: true }),
      );

      const usable = resolveUsableObservations(samples, rows, 5);
      expect(usable.usableObservationCount).toBe(0);
      expect(usable.isSufficientSample).toBe(false);

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 5 });

      expect(verdict.verdict).toBe('NEEDS_REVIEW');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(verdict.promotabilityReasons.some(r => r.toLowerCase().includes('evidence-gap') || r.toLowerCase().includes('missing or gapped') || r.toLowerCase().includes('usable scored observation'))).toBe(true);
    });

    it('a scope with partial evidence gaps below minSamples usable receives NEEDS_REVIEW with gap details', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'independent'),
        createSample('s2', 'standard_pdp', 'independent'),
        createSample('s3', 'standard_pdp', 'independent'),
        createSample('s4', 'standard_pdp', 'independent', { artifactRef: null }),
        createSample('s5', 'standard_pdp', 'independent', { artifactRef: null }),
      ];

      const rows = [
        ...createRowsForSample(samples[0]),
        ...createRowsForSample(samples[1]),
        ...createRowsForSample(samples[2]),
        ...createRowsForSample(samples[3], { isBaselineGap: true, isHybridGap: true }),
        ...createRowsForSample(samples[4], { isBaselineGap: true, isHybridGap: true }),
      ];

      const usable = resolveUsableObservations(samples, rows, 5);
      expect(usable.usableObservationCount).toBe(3);
      expect(usable.isSufficientSample).toBe(false);

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 5 });
      expect(verdict.verdict).toBe('NEEDS_REVIEW');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityReasons.some(r => r.toLowerCase().includes('usable') || r.toLowerCase().includes('evidence gap'))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 2: Auto-Derived Labels & Identical Outputs Receive NEEDS_REVIEW
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 2: auto-derived labels & identical outputs', () => {
    it('a scope with only auto-derived labels and identical baseline and candidate outputs receives NEEDS_REVIEW', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'auto-derived'),
        createSample('s2', 'standard_pdp', 'auto-derived'),
        createSample('s3', 'standard_pdp', 'auto-derived'),
        createSample('s4', 'standard_pdp', 'auto-derived'),
        createSample('s5', 'standard_pdp', 'auto-derived'),
      ];

      // Identical outputs between baseline and candidate
      const rows = samples.flatMap(s => createRowsForSample(s, { identicalOutput: true }));

      const provenance = inspectLabelProvenance(samples);
      expect(provenance.isAllAutoDerived).toBe(true);
      expect(provenance.hasIndependentLabels).toBe(false);
      expect(provenance.isProvenanceValidForPromotion).toBe(false);

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 5 });

      expect(verdict.verdict).toBe('NEEDS_REVIEW');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(verdict.promotabilityReasons.some(r => r.toLowerCase().includes('auto-derived'))).toBe(true);
    });

    it('exploratory rows are marked as such in the promotion report', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'auto-derived', { isHoldout: false }),
        createSample('s2', 'standard_pdp', 'auto-derived', { isHoldout: true, holdoutFamilyName: 'holdout-a' }),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s, { identicalOutput: true }));

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-15T00:00:00Z',
        samples,
      };

      const report = generatePromotionReport({ manifest, rows, gateOptions: { minSamplesForPromote: 2 } });
      expect(report.markdown).toContain('auto-derived');
      expect(report.markdown.toLowerCase()).toContain('exploratory');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 3: Zero-Quality Baseline Equality & Uncertainty Reporting
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 3: equality with zero-quality baseline & metric uncertainty', () => {
    it('equality with a zero-quality baseline cannot produce GO', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'independent'),
        createSample('s2', 'standard_pdp', 'independent'),
        createSample('s3', 'standard_pdp', 'independent'),
      ];

      // Baseline and hybrid both have 0 field correctness and 0 precision (zero quality)
      const rows = samples.flatMap(s =>
        createRowsForSample(s, {
          baselineFieldScore: 0,
          hybridFieldScore: 0,
          baselinePrecision: 0,
          hybridPrecision: 0,
        }),
      );

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).not.toBe('GO');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityReasons.some(r => r.toLowerCase().includes('zero-quality') || r.toLowerCase().includes('blocked'))).toBe(true);
    });

    it('every metric reports its uncertainty in gate threshold checks and verdicts', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'independent'),
        createSample('s2', 'standard_pdp', 'independent'),
        createSample('s3', 'standard_pdp', 'independent'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      // Scope-level metric uncertainties
      expect(verdict.servedRate.uncertainty).toBeDefined();
      expect(verdict.identityAccuracy.uncertainty).toBeDefined();
      expect(verdict.fieldCorrectness.uncertainty).toBeDefined();
      expect(verdict.imagePrecision.uncertainty).toBeDefined();
      expect(verdict.imageRecall.uncertainty).toBeDefined();
      expect(verdict.primaryImageAccuracy.uncertainty).toBeDefined();

      // Threshold checks report uncertainty
      for (const t of verdict.thresholds) {
        if (t.unit === 'rate') {
          expect(t.actualUncertainty).toBeDefined();
        }
      }
    });

    it('quality gains that hide failures behind evidence gaps keep failing the gate', () => {
      const samples = [
        createSample('s1', 'standard_pdp', 'independent'),
        createSample('s2', 'standard_pdp', 'independent'),
        createSample('s3', 'standard_pdp', 'independent'),
      ];

      // Hybrid drops s2 and s3 into evidence gaps, claiming 100% precision on s1 alone
      const rows = [
        ...createRowsForSample(samples[0], { baselinePrecision: 0.5, hybridPrecision: 1.0 }),
        ...createRowsForSample(samples[1], { baselinePrecision: 0.5, isHybridGap: true }),
        ...createRowsForSample(samples[2], { baselinePrecision: 0.5, isHybridGap: true }),
      ];

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });
      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.abstentionGaming.gamingDetected).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 4: Promotion Report Renders Per-Sample Provenance & Holdout
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 4: promotion report renders provenance & holdout', () => {
    it('the promotion report renders per-sample label provenance and holdout partition next to each per-scope verdict', () => {
      const sample1 = createSample('s1', 'standard_pdp', 'independent', { isHoldout: false });
      const sample2 = createSample('s2', 'standard_pdp', 'auto-derived', { isHoldout: true, holdoutFamilyName: 'family-alpha' });
      const samples = [sample1, sample2];
      const rows = samples.flatMap(s => createRowsForSample(s));

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-15T00:00:00Z',
        samples,
      };

      const report = generatePromotionReport({ manifest, rows, gateOptions: { minSamplesForPromote: 2 } });

      // Verifies per-sample label provenance is rendered next to the scope verdict
      expect(report.markdown).toContain('independent');
      expect(report.markdown).toContain('auto-derived');
      // Verifies holdout partition is rendered
      expect(report.markdown).toContain('Holdout');
      expect(report.markdown).toContain('family-alpha');
      expect(report.markdown).toContain('Tuning');
    });
  });
});
