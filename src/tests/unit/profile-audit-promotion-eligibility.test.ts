import { describe, it, expect } from 'vitest';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
} from '../../shared/schemas/profile-audit';
import {
  resolveUsableObservations,
  inspectLabelProvenance,
  buildBlockedReasons,
  buildPromotabilityReasons,
  formatPromotionRecommendation,
  evaluatePromotionEligibility,
} from '../../onboarding/profile-audit/promotion-eligibility';
import {
  evaluateScopeGate,
  evaluateGateArithmetic,
} from '../../onboarding/profile-audit/gate-arithmetic';
import {
  generatePromotionReport,
} from '../../onboarding/profile-audit/promotion-report';

describe('Profile Audit: Shared Promotion Eligibility Helper (Issue #185 / T1 Prefactor)', () => {
  function createSample(
    id: string,
    scope: string = 'standard_pdp',
    provenance?: 'independent' | 'auto-derived',
  ): AuditManifestSample {
    return {
      sampleId: id,
      url: `https://example.com/products/${id}`,
      domain: 'example.com',
      stratum: `example.com:shopify:${scope}:single_variant`,
      inventoryStatus: 'confirmed',
      artifactRef: `snapshots/${id}.html`,
      supplementalArtifactRefs: [],
      hasSupplementalArtifact: true,
      captureFreshness: '2026-09-01T12:00:00Z',
      pageStructureScope: scope,
      platform: 'Shopify',
      productFamily: 'dog-shampoo',
      variantShape: 'single_variant',
      groundTruthSource: provenance,
      isHoldout: false,
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
      baselineCorrect?: boolean;
      hybridCorrect?: boolean;
      baselinePrecision?: number;
      hybridPrecision?: number;
      baselineIdentityVerdict?: 'correct_match' | 'wrong_variant' | 'wrong_product';
      hybridIdentityVerdict?: 'correct_match' | 'wrong_variant' | 'wrong_product';
      baselineEvidenceGap?: boolean;
      hybridEvidenceGap?: boolean;
      baselineCriticalCorrect?: boolean;
      hybridCriticalCorrect?: boolean;
    } = {},
  ): AuditScoredRow[] {
    const isBaselineGap = Boolean(overrides.baselineEvidenceGap);
    const isHybridGap = Boolean(overrides.hybridEvidenceGap);

    const baseCriticalCorrect = overrides.baselineCriticalCorrect ?? (overrides.baselineCorrect ?? true);
    const hybCriticalCorrect = overrides.hybridCriticalCorrect ?? (overrides.hybridCorrect ?? true);

    const baselineRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'current_extraction',
      identityVerdict: overrides.baselineIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: isBaselineGap ? 0 : (baseCriticalCorrect ? 0.75 : 0.25),
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: baseCriticalCorrect ? sample.groundTruth.identity.productName : 'Wrong Title',
          expectedValue: sample.groundTruth.identity.productName,
          provenance: 'custom-selector',
          status: baseCriticalCorrect ? 'correct' : 'incorrect',
          correct: baseCriticalCorrect,
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
      },
      imageScores: {
        extractedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: 1,
        precision: overrides.baselinePrecision ?? 0.6,
        recall: 0.8,
      },
      failureCodes: isBaselineGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : [],
      isEvidenceGap: isBaselineGap,
      evidenceGapReason: isBaselineGap ? 'Missing snapshot artifact' : null,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
    };

    const hybridRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'hybrid_identity_first',
      identityVerdict: overrides.hybridIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: isHybridGap ? 0 : (hybCriticalCorrect ? 0.9 : 0.2),
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: hybCriticalCorrect ? sample.groundTruth.identity.productName : 'Wrong Title',
          expectedValue: sample.groundTruth.identity.productName,
          provenance: 'structured',
          status: hybCriticalCorrect ? 'correct' : 'incorrect',
          correct: hybCriticalCorrect,
        },
        brand: {
          field: 'brand',
          available: true,
          extractedValue: 'Earthbath',
          expectedValue: 'Earthbath',
          provenance: 'structured',
          status: 'correct',
          correct: true,
        },
        price: {
          field: 'price',
          available: true,
          extractedValue: '14.99',
          expectedValue: '14.99',
          provenance: 'structured',
          status: 'correct',
          correct: true,
        },
      },
      imageScores: {
        extractedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        admittedImages: [`https://example.com/images/${sample.sampleId}-primary.jpg`],
        rejectedImages: [],
        primaryImage: `https://example.com/images/${sample.sampleId}-primary.jpg`,
        primaryAccuracy: 1,
        precision: overrides.hybridPrecision ?? 0.9,
        recall: 0.85,
      },
      failureCodes: isHybridGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : [],
      isEvidenceGap: isHybridGap,
      evidenceGapReason: isHybridGap ? 'Missing snapshot artifact' : null,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
    };

    return [baselineRow, hybridRow];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Seam 1: Usable-observation counting
  // ───────────────────────────────────────────────────────────────────────────
  describe('Usable-observation counting', () => {
    it('counts total manifest samples and resolves baseline and candidate rows', () => {
      const s1 = createSample('s1');
      const s2 = createSample('s2');
      const s3 = createSample('s3', 'other_scope');
      const rows = [
        ...createRowsForSample(s1),
        ...createRowsForSample(s2),
        ...createRowsForSample(s3),
      ];

      const obs = resolveUsableObservations([s1, s2], rows, 2);
      expect(obs.totalSampleCount).toBe(2);
      expect(obs.usableObservationCount).toBe(2);
      expect(obs.baselineRows).toHaveLength(2);
      expect(obs.hybridRows).toHaveLength(2);
      expect(obs.isSufficientSample).toBe(true);
      expect(obs.sampleIdSet.has('s1')).toBe(true);
      expect(obs.sampleIdSet.has('s2')).toBe(true);
      expect(obs.sampleIdSet.has('s3')).toBe(false);
    });

    it('flags insufficient sample count when below threshold', () => {
      const s1 = createSample('s1');
      const rows = createRowsForSample(s1);

      const obs = resolveUsableObservations([s1], rows, 5);
      expect(obs.totalSampleCount).toBe(1);
      expect(obs.usableObservationCount).toBe(1);
      expect(obs.isSufficientSample).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Seam 2: Provenance inspection
  // ───────────────────────────────────────────────────────────────────────────
  describe('Provenance inspection', () => {
    it('summarizes label provenance across samples', () => {
      const s1 = createSample('s1', 'standard_pdp', 'independent');
      const s2 = createSample('s2', 'standard_pdp', 'auto-derived');
      const s3 = createSample('s3', 'standard_pdp'); // unspecified

      const inspection = inspectLabelProvenance([s1, s2, s3]);
      expect(inspection.totalCount).toBe(3);
      expect(inspection.independentCount).toBe(1);
      expect(inspection.autoDerivedCount).toBe(1);
      expect(inspection.unspecifiedCount).toBe(1);
      expect(inspection.hasIndependentLabels).toBe(true);
      expect(inspection.isAllAutoDerived).toBe(false);
      // In T1 prefactor, provenance does not block promotion yet
      expect(inspection.isProvenanceValidForPromotion).toBe(true);
    });

    it('detects auto-derived only sample sets', () => {
      const s1 = createSample('s1', 'standard_pdp', 'auto-derived');
      const s2 = createSample('s2', 'standard_pdp', 'auto-derived');

      const inspection = inspectLabelProvenance([s1, s2]);
      expect(inspection.isAllAutoDerived).toBe(true);
      expect(inspection.hasIndependentLabels).toBe(false);
      expect(inspection.autoDerivedCount).toBe(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Seam 3: Blocked-reason construction & recommendation formatting
  // ───────────────────────────────────────────────────────────────────────────
  describe('Blocked-reason construction & recommendation formatting', () => {
    it('formats recommendation strings identically for each verdict', () => {
      expect(formatPromotionRecommendation('GO')).toBe(
        '**PROCEED TO CONTRACT WORK.** This scope has proven superior quality, zero identity errors, improved image filtering, and bounded maintenance. Ready for ladder-wiring ADR revision.',
      );
      expect(formatPromotionRecommendation('NO_GO')).toBe(
        '**REMAIN SELECTOR-LED WITH SCOPED EXCEPTIONS.** Do not force into hybrid arm until blocking regressions and errors are resolved.',
      );
      expect(formatPromotionRecommendation('NEEDS_REVIEW')).toBe(
        '**EXPAND STRATIFIED SAMPLE.** Increase sample size to achieve sufficient statistical confidence before triggering contract work.',
      );
    });

    it('builds blocked reasons when thresholds fail and deduplicates abstention reasons', () => {
      const reasons = buildBlockedReasons(
        [
          {
            name: 'Zero Accepted Identity Errors',
            dimension: 'identity_integrity',
            baselineValue: 0,
            thresholdValue: 0,
            actualValue: 1,
            unit: 'errors',
            rule: 'actual <= 0',
            passed: false,
            reason: 'Blocked: 1 identity errors detected',
          },
        ],
        {
          gamingDetected: true,
          evidenceGapInflated: true,
          baselineEvidenceGaps: 0,
          hybridEvidenceGaps: 1,
          servedRateDropDetected: false,
          baselineServedRate: 1,
          hybridServedRate: 1,
          sampleRefusalDetected: false,
          baselineAttemptedCount: 1,
          hybridAttemptedCount: 1,
          reasons: ['Evidence gaps inflated by 1', '1 identity errors detected'],
        },
      );

      expect(reasons).toContain('Blocked: 1 identity errors detected');
      expect(reasons).toContain('Blocked: Evidence gaps inflated by 1');
      // Verify deduplication
      const identityErrorMatches = reasons.filter(r => r.includes('identity errors detected'));
      expect(identityErrorMatches).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Seam 4: Promotion eligibility evaluation
  // ───────────────────────────────────────────────────────────────────────────
  describe('evaluatePromotionEligibility helper', () => {
    it('produces GO verdict with passing bullet points when criteria pass', () => {
      const res = evaluatePromotionEligibility({
        scope: 'standard_pdp',
        sampleCount: 5,
        minSamples: 5,
        allThresholdsPassed: true,
        thresholds: [],
        abstentionGaming: {
          gamingDetected: false,
          evidenceGapInflated: false,
          baselineEvidenceGaps: 0,
          hybridEvidenceGaps: 0,
          servedRateDropDetected: false,
          baselineServedRate: 1,
          hybridServedRate: 1,
          sampleRefusalDetected: false,
          baselineAttemptedCount: 5,
          hybridAttemptedCount: 5,
          reasons: [],
        },
        costMetrics: {
          scope: 'standard_pdp',
          sampleCount: 5,
          baselineLatencyMs: 100,
          hybridLatencyMs: 100,
          latencyDeltaMs: 0,
          baselineRequestsPerSample: 1,
          hybridRequestsPerSample: 1,
          baselineTotalRequests: 5,
          hybridTotalRequests: 5,
          baselineOperatorMinutes: 10,
          hybridOperatorMinutes: 5,
          operatorMinutesSaved: 5,
          isMaintenanceBounded: true,
        },
        hybridPrecisionMean: 0.95,
        baselineMeanImagePrecision: 0.8,
        hybridFieldStatsMean: 0.9,
      });

      expect(res.verdict).toBe('GO');
      expect(res.isPromotable).toBe(true);
      expect(res.promotabilityVerdict).toBe('PROMOTABLE');
      expect(res.promotabilityReasons).toContain('✓ Zero observed identity errors (100% correct identity match)');
      expect(res.promotabilityReasons).toContain('✓ Zero critical-field regressions on title, brand, or price');
      expect(res.recommendation).toContain('PROCEED TO CONTRACT WORK');
    });

    it('produces NEEDS_REVIEW when sample size is insufficient', () => {
      const res = evaluatePromotionEligibility({
        scope: 'standard_pdp',
        sampleCount: 2,
        minSamples: 5,
        allThresholdsPassed: true,
        thresholds: [],
        abstentionGaming: {
          gamingDetected: false,
          evidenceGapInflated: false,
          baselineEvidenceGaps: 0,
          hybridEvidenceGaps: 0,
          servedRateDropDetected: false,
          baselineServedRate: 1,
          hybridServedRate: 1,
          sampleRefusalDetected: false,
          baselineAttemptedCount: 2,
          hybridAttemptedCount: 2,
          reasons: [],
        },
        costMetrics: {
          scope: 'standard_pdp',
          sampleCount: 2,
          baselineLatencyMs: 100,
          hybridLatencyMs: 100,
          latencyDeltaMs: 0,
          baselineRequestsPerSample: 1,
          hybridRequestsPerSample: 1,
          baselineTotalRequests: 2,
          hybridTotalRequests: 2,
          baselineOperatorMinutes: 10,
          hybridOperatorMinutes: 5,
          operatorMinutesSaved: 5,
          isMaintenanceBounded: true,
        },
        hybridPrecisionMean: 0.95,
        baselineMeanImagePrecision: 0.8,
        hybridFieldStatsMean: 0.9,
      });

      expect(res.verdict).toBe('NEEDS_REVIEW');
      expect(res.isPromotable).toBe(false);
      expect(res.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(res.promotabilityReasons[0]).toContain('Needs Review: Sample count (2) is below standard gate threshold (minimum 5 required)');
      expect(res.recommendation).toContain('EXPAND STRATIFIED SAMPLE');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Byte-identical contract pinning
  // ───────────────────────────────────────────────────────────────────────────
  describe('Byte-identical contract pinning', () => {
    it('produces identical gate verdicts and promotion report before and after extraction', () => {
      const samples = [
        createSample('s1'),
        createSample('s2'),
        createSample('s3'),
        createSample('s4'),
        createSample('s5'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));
      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-01T12:00:00Z',
        samples,
      };

      const scopeVerdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 5 });
      expect(scopeVerdict.verdict).toBe('GO');
      expect(scopeVerdict.isPromotable).toBe(true);

      const gateResult = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 5 });
      expect(gateResult.overallContractVerdict).toBe('GO');
      expect(gateResult.verdictsByScope['standard_pdp'].verdict).toBe('GO');

      const report = generatePromotionReport({ manifest, rows, gateOptions: { minSamplesForPromote: 5 } });
      expect(report.overallContractVerdict).toBe('GO');
      expect(report.verdictsByScope['standard_pdp'].verdict).toBe('GO');
      expect(report.markdown).toContain('PROCEED TO CONTRACT WORK');
      expect(report.markdown).toContain('✓ Zero observed identity errors (100% correct identity match)');
    });

    it('buildPromotabilityReasons delegates reasons and status correctly', () => {
      const reasonsObj = buildPromotabilityReasons({
        scope: 'standard_pdp',
        sampleCount: 1,
        minSamples: 3,
        allThresholdsPassed: true,
        thresholds: [],
        abstentionGaming: {
          gamingDetected: false,
          evidenceGapInflated: false,
          baselineEvidenceGaps: 0,
          hybridEvidenceGaps: 0,
          servedRateDropDetected: false,
          baselineServedRate: 1,
          hybridServedRate: 1,
          sampleRefusalDetected: false,
          baselineAttemptedCount: 1,
          hybridAttemptedCount: 1,
          reasons: [],
        },
        costMetrics: {
          scope: 'standard_pdp',
          sampleCount: 1,
          baselineLatencyMs: 100,
          hybridLatencyMs: 100,
          latencyDeltaMs: 0,
          baselineRequestsPerSample: 1,
          hybridRequestsPerSample: 1,
          baselineTotalRequests: 1,
          hybridTotalRequests: 1,
          baselineOperatorMinutes: 10,
          hybridOperatorMinutes: 5,
          operatorMinutesSaved: 5,
          isMaintenanceBounded: true,
        },
        hybridPrecisionMean: 0.9,
        baselineMeanImagePrecision: 0.8,
        hybridFieldStatsMean: 0.9,
      });

      expect(reasonsObj.verdict).toBe('NEEDS_REVIEW');
      expect(reasonsObj.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(reasonsObj.isPromotable).toBe(false);
      expect(reasonsObj.promotabilityReasons[0]).toContain('Needs Review: Sample count (1)');
    });
  });
});
