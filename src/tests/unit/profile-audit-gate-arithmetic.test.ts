import { describe, it, expect } from 'vitest';
import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
} from '../../shared/schemas/profile-audit';
import {
  computeWilsonScoreInterval,
  computeContinuousMetricInterval,
  buildPromotionUncertainty,
  detectAbstentionGaming,
  computeScopeCostMetrics,
  computeDomainCostMetrics,
  deriveBaselineThresholds,
  evaluateScopeGate,
  evaluateGateArithmetic,
} from '../../onboarding/profile-audit/gate-arithmetic';
import {
  generatePromotionReport,
  formatScopePromotionTable,
  formatGateArithmeticThresholdsTable,
  formatAbstentionGamingAuditTable,
  formatCostAnalysisTable,
  formatPromotionVerdictBadge,
} from '../../onboarding/profile-audit/promotion-report';


describe('Profile Audit Gate T5: Gate Arithmetic & Per-Scope Promotion Report (Issue #178)', () => {
  // ── Test Fixture Helpers ──────────────────────────────────────────────────
  function createSample(id: string, scope: string = 'standard_pdp'): AuditManifestSample {
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
      hybridConflictsCount?: number;
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
        primaryAccuracy: 1,
        precision: overrides.baselinePrecision ?? 0.6,
        recall: 0.8,
      },
      failureCodes: isBaselineGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : ['NONE'],
      isEvidenceGap: isBaselineGap,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
      latencyMs: 110,
      requestCount: 1,
    };

    const conflicts = overrides.hybridConflictsCount
      ? Array.from({ length: overrides.hybridConflictsCount }).map((_, i) => ({
          field: `field_${i}`,
          selectorValue: 'val_a',
          structuredValue: 'val_b',
          structuredSource: 'json-ld',
          selectorSource: 'custom-selector',
          resolution: 'conflict',
        }))
      : [];

    const hybridRow: AuditScoredRow = {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration: 'hybrid_identity_first',
      identityVerdict: overrides.hybridIdentityVerdict ?? 'correct_match',
      fieldCorrectnessScore: isHybridGap ? 0 : (hybCriticalCorrect ? 1.0 : 0.25),
      fieldScores: {
        title: {
          field: 'title',
          available: true,
          extractedValue: hybCriticalCorrect ? sample.groundTruth.identity.productName : 'Wrong Title',
          expectedValue: sample.groundTruth.identity.productName,
          provenance: 'custom-selector',
          status: hybCriticalCorrect ? 'correct' : 'incorrect',
          correct: hybCriticalCorrect,
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
        primaryAccuracy: 1,
        precision: overrides.hybridPrecision ?? 0.95,
        recall: 0.8,
      },
      failureCodes: isHybridGap ? ['EVIDENCE_GAP_MISSING_ARTIFACT'] : ['NONE'],
      isEvidenceGap: isHybridGap,
      conflicts,
      extractedProductPreview: {
        title: sample.groundTruth.identity.productName,
        brand: 'Earthbath',
      },
      latencyMs: 140,
      requestCount: 1,
    };

    return [baselineRow, hybridRow];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 1: Per-scope verdicts computed with uncertainty shown
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 1: Per-scope verdicts computed from scored rows with uncertainty shown', () => {
    it('computes GO verdict when a scope satisfies all gate criteria with statistical significance', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
        createSample('s4', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).toBe('GO');
      expect(verdict.isPromotable).toBe(true);
      expect(verdict.promotabilityVerdict).toBe('PROMOTABLE');
      expect(verdict.sampleCount).toBe(4);
      expect(verdict.allThresholdsPassed).toBe(true);

      // Uncertainty is explicitly shown for key dimensions
      expect(verdict.servedRate.value).toBe(1.0);
      expect(verdict.servedRate.uncertainty).toBeGreaterThan(0);
      expect(verdict.servedRate.confidenceInterval.lower).toBeGreaterThan(0);
      expect(verdict.servedRate.confidenceInterval.upper).toBe(1.0);

      expect(verdict.identityAccuracy.value).toBe(1.0);
      expect(verdict.identityAccuracy.uncertainty).toBeGreaterThan(0);

      expect(verdict.fieldCorrectness.value).toBe(1.0);
      expect(verdict.imagePrecision.value).toBe(0.95);
    });

    it('computes NO_GO verdict when gate criteria fail (e.g. identity mismatch)', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      // s2 has wrong variant identity error in hybrid
      const rows = [
        ...createRowsForSample(samples[0]),
        ...createRowsForSample(samples[1], { hybridIdentityVerdict: 'wrong_variant' }),
        ...createRowsForSample(samples[2]),
      ];

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityVerdict).toBe('BLOCKED');
      expect(verdict.acceptedIdentityErrors).toBe(1);
      expect(verdict.promotabilityReasons.some(r => r.includes('identity errors'))).toBe(true);
    });

    it('computes NEEDS_REVIEW verdict when sample size is below minimum threshold to prove superiority', () => {
      // Only 2 samples (min is 3)
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).toBe('NEEDS_REVIEW');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityVerdict).toBe('NEEDS_REVIEW');
      expect(verdict.promotabilityReasons.some(r => r.includes('below standard gate threshold'))).toBe(true);
    });

    it('computes Wilson Score and continuous metric intervals with uncertainty margins correctly', () => {
      const wilson = computeWilsonScoreInterval(9, 10, 1.96);
      expect(wilson.rate).toBe(0.9);
      expect(wilson.lower).toBeGreaterThan(0.5);
      expect(wilson.upper).toBeLessThanOrEqual(1.0);
      expect(wilson.marginOfError).toBeGreaterThan(0);

      const cont = computeContinuousMetricInterval([0.8, 0.9, 0.85, 0.95], 1.96);
      expect(cont.mean).toBeCloseTo(0.875, 3);
      expect(cont.sampleCount).toBe(4);
      expect(cont.standardError).toBeGreaterThan(0);
      expect(cont.marginOfError).toBeGreaterThan(0);
      expect(cont.lower).toBeLessThan(cont.mean);
      expect(cont.upper).toBeGreaterThan(cont.mean);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 2: Thresholds derived from baseline numbers
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 2: Thresholds derived from baseline numbers, recorded alongside the verdicts', () => {
    it('derives promotion thresholds directly from baseline numbers rather than arbitrary fiat', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s, {
        baselinePrecision: 0.65,
        hybridPrecision: 0.90,
      }));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      // Thresholds list must be recorded alongside the verdict
      expect(verdict.thresholds).toBeDefined();
      expect(verdict.thresholds.length).toBeGreaterThanOrEqual(8);

      // Verify that thresholds match measured baseline numbers
      const precisionCheck = verdict.thresholds.find(t => t.dimension === 'image_precision');
      expect(precisionCheck).toBeDefined();
      expect(precisionCheck!.baselineValue).toBeCloseTo(0.65, 2);
      expect(precisionCheck!.thresholdValue).toBeCloseTo(0.65, 2); // Derived from baseline!
      expect(precisionCheck!.actualValue).toBeCloseTo(0.90, 2);
      expect(precisionCheck!.passed).toBe(true);

      const fieldCheck = verdict.thresholds.find(t => t.dimension === 'field_completeness');
      expect(fieldCheck).toBeDefined();
      expect(fieldCheck!.baselineValue).toBeCloseTo(0.75, 2);
      expect(fieldCheck!.thresholdValue).toBeCloseTo(0.75, 2); // Derived from baseline!
      expect(fieldCheck!.actualValue).toBeCloseTo(1.0, 2);
      expect(fieldCheck!.passed).toBe(true);

      const identityCheck = verdict.thresholds.find(t => t.dimension === 'identity_integrity');
      expect(identityCheck).toBeDefined();
      expect(identityCheck!.thresholdValue).toBe(0);
      expect(identityCheck!.actualValue).toBe(0);
      expect(identityCheck!.passed).toBe(true);

      const regressionCheck = verdict.thresholds.find(t => t.dimension === 'critical_field_regression');
      expect(regressionCheck).toBeDefined();
      expect(regressionCheck!.thresholdValue).toBe(0);
      expect(regressionCheck!.actualValue).toBe(0);
      expect(regressionCheck!.passed).toBe(true);
    });

    it('fails the gate when hybrid regresses below any baseline-derived threshold', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      // Hybrid has lower image precision (0.50) than baseline (0.75)
      const rows = samples.flatMap(s => createRowsForSample(s, {
        baselinePrecision: 0.75,
        hybridPrecision: 0.50,
      }));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.allThresholdsPassed).toBe(false);

      const precisionCheck = verdict.thresholds.find(t => t.dimension === 'image_precision');
      expect(precisionCheck!.passed).toBe(false);
      expect(precisionCheck!.reason).toContain('regressed below baseline');
      expect(verdict.promotabilityReasons.some(r => r.includes('image precision'))).toBe(true);
    });

    it('fails the gate when a critical field regression occurs versus baseline', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      // Sample 1: Baseline had correct critical field, hybrid broke it!
      const rows = [
        ...createRowsForSample(samples[0], { baselineCriticalCorrect: true, hybridCriticalCorrect: false }),
        ...createRowsForSample(samples[1]),
        ...createRowsForSample(samples[2]),
      ];

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.criticalFieldRegressions).toBe(1);
      const regressionCheck = verdict.thresholds.find(t => t.dimension === 'critical_field_regression');
      expect(regressionCheck!.passed).toBe(false);
      expect(verdict.promotabilityReasons.some(r => r.includes('critical field regressions'))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 3: Abstention gaming detectable
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 3: Abstention gaming detectable: quality gains that hide failures fail the gate', () => {
    it('detects evidence gap inflation where candidate refuses difficult samples to boost precision', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
        createSample('s4', 'standard_pdp'),
      ];
      // Baseline attempted all 4 samples (0 gaps).
      // Hybrid drops sample 3 and 4 as "evidence gaps", claiming 100% precision on s1 and s2!
      const rows = [
        ...createRowsForSample(samples[0], { baselineEvidenceGap: false, hybridEvidenceGap: false, hybridPrecision: 1.0 }),
        ...createRowsForSample(samples[1], { baselineEvidenceGap: false, hybridEvidenceGap: false, hybridPrecision: 1.0 }),
        ...createRowsForSample(samples[2], { baselineEvidenceGap: false, hybridEvidenceGap: true }),
        ...createRowsForSample(samples[3], { baselineEvidenceGap: false, hybridEvidenceGap: true }),
      ];

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.abstentionGaming.gamingDetected).toBe(true);
      expect(verdict.abstentionGaming.evidenceGapInflated).toBe(true);
      expect(verdict.abstentionGaming.baselineEvidenceGaps).toBe(0);
      expect(verdict.abstentionGaming.hybridEvidenceGaps).toBe(2);
      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.isPromotable).toBe(false);
      expect(verdict.promotabilityReasons.some(r => r.toLowerCase().includes('evidence gap'))).toBe(true);
    });

    it('detects served rate regression paired with artificial quality gain', () => {
      // Unit test detectAbstentionGaming directly
      const dummyBaselineRow = { isEvidenceGap: false } as AuditScoredRow;
      const dummyHybridRow = { isEvidenceGap: false } as AuditScoredRow;

      const result = detectAbstentionGaming({
        baselineRows: [dummyBaselineRow, dummyBaselineRow, dummyBaselineRow, dummyBaselineRow],
        hybridRows: [dummyHybridRow, dummyHybridRow, dummyHybridRow, dummyHybridRow],
        baselineServedRate: 0.80,
        hybridServedRate: 0.50, // dropped served rate!
        baselineMeanFieldCorrectness: 0.70,
        hybridMeanFieldCorrectness: 0.95, // claimed quality rise!
        baselineMeanImagePrecision: 0.60,
        hybridMeanImagePrecision: 0.90,
      });

      expect(result.gamingDetected).toBe(true);
      expect(result.servedRateDropDetected).toBe(true);
      expect(result.reasons.some(r => r.includes('Abstention gaming detected'))).toBe(true);
    });

    it('passes the gate when quality gains are genuine and evidence gaps do not exceed baseline', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s, {
        baselineEvidenceGap: false,
        hybridEvidenceGap: false,
        baselinePrecision: 0.65,
        hybridPrecision: 0.95,
      }));

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, { minSamplesForPromote: 3 });

      expect(verdict.abstentionGaming.gamingDetected).toBe(false);
      expect(verdict.abstentionGaming.evidenceGapInflated).toBe(false);
      expect(verdict.abstentionGaming.servedRateDropDetected).toBe(false);
      expect(verdict.verdict).toBe('GO');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Acceptance Criterion 4: Cost columns present
  // ───────────────────────────────────────────────────────────────────────────
  describe('Acceptance Criterion 4: Cost columns present: latency, request counts, operator minutes per domain', () => {
    it('computes latency, request counts, and operator maintenance minutes per scope and domain', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));

      const scopeCost = computeScopeCostMetrics('standard_pdp', 'example.com', samples, rows);

      expect(scopeCost.sampleCount).toBe(3);
      expect(scopeCost.baselineLatencyMs).toBeGreaterThan(0);
      expect(scopeCost.hybridLatencyMs).toBeGreaterThan(0);
      expect(scopeCost.latencyDeltaMs).toBeDefined();

      expect(scopeCost.baselineTotalRequests).toBe(3);
      expect(scopeCost.hybridTotalRequests).toBe(3);
      expect(scopeCost.hybridRequestsPerSample).toBe(1.0);

      expect(scopeCost.baselineOperatorMinutes).toBeGreaterThan(0);
      expect(scopeCost.hybridOperatorMinutes).toBeGreaterThan(0);
      expect(scopeCost.operatorMinutesSaved).toBeGreaterThan(0);
      expect(scopeCost.isMaintenanceBounded).toBe(true);

      const domainCost = computeDomainCostMetrics('example.com', samples, rows);
      expect(domainCost.domain).toBe('example.com');
      expect(domainCost.totalSamples).toBe(3);
      expect(domainCost.baselineOperatorMinutes).toBeGreaterThan(0);
      expect(domainCost.hybridOperatorMinutes).toBeGreaterThan(0);
      expect(domainCost.operatorMinutesSaved).toBeGreaterThan(0);
      expect(domainCost.isMaintenanceBounded).toBe(true);
    });

    it('fails the bounded maintenance check when hybrid maintenance cost exceeds baseline', () => {
      const samples = [createSample('s1', 'standard_pdp')];
      const rows = createRowsForSample(samples[0], {
        hybridConflictsCount: 20, // 20 conflicts * 2 mins = 40 mins maintenance!
      });

      const cost = computeScopeCostMetrics('standard_pdp', 'example.com', samples, rows, {
        baseOperatorMinutes: 5.0, // baseline is only 5 mins
      });

      expect(cost.isMaintenanceBounded).toBe(false);
      expect(cost.operatorMinutesSaved).toBeLessThan(0);

      const verdict = evaluateScopeGate('standard_pdp', samples, rows, {
        minSamplesForPromote: 1,
        baseOperatorMinutes: 5.0,
      });

      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.costMetrics.isMaintenanceBounded).toBe(false);
      const maintCheck = verdict.thresholds.find(t => t.dimension === 'bounded_maintenance');
      expect(maintCheck!.passed).toBe(false);
      expect(verdict.promotabilityReasons.some(r => r.includes('Operator maintenance'))).toBe(true);
    });

    it('renders cost columns in promotion tables and reports', () => {
      const samples = [
        createSample('s1', 'standard_pdp'),
        createSample('s2', 'standard_pdp'),
        createSample('s3', 'standard_pdp'),
      ];
      const rows = samples.flatMap(s => createRowsForSample(s));
      const gateResult = evaluateGateArithmetic(samples, rows, { minSamplesForPromote: 3 });

      const tableMd = formatScopePromotionTable(gateResult.verdictsByScope);
      expect(tableMd).toContain('| Latency (Base → Hyb) | Requests | Operator Mins (Base → Hyb) | Contract Verdict |');
      expect(tableMd).toContain('ms');
      expect(tableMd).toContain('/sample');
      expect(tableMd).toContain('m');
      expect(tableMd).toContain('GO (PROMOTABLE)');

      const costTableMd = formatCostAnalysisTable(gateResult.domainCostMetrics, gateResult.verdictsByScope);
      expect(costTableMd).toContain('## Execution Cost & Operator Maintenance Analysis');
      expect(costTableMd).toContain('| Domain / Scope | Baseline Latency | Hybrid Latency | Latency Delta | Baseline Requests | Hybrid Requests | Baseline Operator Mins | Hybrid Operator Mins | Minutes Saved | Bounded? |');
      expect(costTableMd).toContain('DOMAIN TOTAL');
      expect(costTableMd).toContain('Bounded');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Full Per-Scope Promotion Report Generator
  // ───────────────────────────────────────────────────────────────────────────
  describe('Full Per-Scope Promotion Report Generator', () => {
    it('assembles comprehensive per-scope promotion report with all required sections', () => {
      const sample1 = createSample('s1', 'standard_pdp');
      const sample2 = createSample('s2', 'standard_pdp');
      const sample3 = createSample('s3', 'standard_pdp');
      const sample4 = createSample('s4', 'tabbed_pdp');
      const sample5 = createSample('s5', 'tabbed_pdp');
      const sample6 = createSample('s6', 'tabbed_pdp');

      const manifest: AuditManifest = {
        domain: 'example.com',
        generatedAt: '2026-09-13T21:00:00Z',
        samples: [sample1, sample2, sample3, sample4, sample5, sample6],
      };

      const rows = [
        ...createRowsForSample(sample1),
        ...createRowsForSample(sample2),
        ...createRowsForSample(sample3),
        ...createRowsForSample(sample4),
        ...createRowsForSample(sample5),
        ...createRowsForSample(sample6),
      ];

      const report = generatePromotionReport({ manifest, rows });

      expect(report.domain).toBe('example.com');
      expect(report.totalSamples).toBe(6);
      expect(report.totalScopes).toBe(2);
      expect(report.overallContractVerdict).toBe('GO');
      expect(report.verdictsByScope['standard_pdp'].verdict).toBe('GO');
      expect(report.verdictsByScope['tabbed_pdp'].verdict).toBe('GO');

      const md = report.markdown;
      expect(md).toContain('# Profile Extraction Audit Gate: Per-Scope Promotion Report');
      expect(md).toContain('## Per-Scope Promotion Verdicts & Contract Recommendation');
      expect(md).toContain('## Derived Baseline Thresholds & Gate Arithmetic Audit');
      expect(md).toContain('## Abstention Gaming Audit');
      expect(md).toContain('## Execution Cost & Operator Maintenance Analysis');
      expect(md).toContain('## Actionable Scope Verdicts & Next Steps');
      expect(md).toContain('PROCEED TO CONTRACT WORK');
    });
  });
  // ───────────────────────────────────────────────────────────────────────────
  // Robustness & Edge Cases
  // ───────────────────────────────────────────────────────────────────────────
  describe('Robustness & Edge Cases', () => {
    it('handles empty samples and rows cleanly without NaN or throwing', () => {
      expect(() => evaluateGateArithmetic([], [])).not.toThrow();
      const emptyResult = evaluateGateArithmetic([], []);
      expect(emptyResult.overallContractVerdict).toBe('NEEDS_REVIEW');
      expect(Object.keys(emptyResult.verdictsByScope).length).toBe(0);
    });

    it('handles single-sample scopes without crashing on variance calculation', () => {
      const sample = createSample('s1', 'rare_pdp');
      const rows = createRowsForSample(sample);

      const verdict = evaluateScopeGate('rare_pdp', [sample], rows, { minSamplesForPromote: 1 });
      expect(verdict.fieldCorrectness.uncertainty).toBe(0);
      expect(verdict.verdict).toBe('GO');
    });

    it('accumulates multiple failure reasons when multiple thresholds fail', () => {
      const sample = createSample('s1', 'standard_pdp');
      const rows = createRowsForSample(sample, {
        hybridIdentityVerdict: 'wrong_product',
        hybridCriticalCorrect: false,
        baselinePrecision: 0.8,
        hybridPrecision: 0.2,
      });

      const verdict = evaluateScopeGate('standard_pdp', [sample], rows, { minSamplesForPromote: 1 });
      expect(verdict.verdict).toBe('NO_GO');
      expect(verdict.promotabilityReasons.some(r => r.includes('identity errors'))).toBe(true);
      expect(verdict.promotabilityReasons.some(r => r.includes('critical field regressions'))).toBe(true);
      expect(verdict.promotabilityReasons.some(r => r.includes('image precision'))).toBe(true);
    });

    it('formats badges correctly for all verdict states', () => {
      expect(formatPromotionVerdictBadge('GO')).toContain('GO (PROMOTABLE)');
      expect(formatPromotionVerdictBadge('NO_GO')).toContain('NO-GO (BLOCKED)');
      expect(formatPromotionVerdictBadge('NEEDS_REVIEW')).toContain('NEEDS REVIEW');
    });

    it('builds promotion metric uncertainty objects correctly', () => {
      const u = buildPromotionUncertainty(
        'servedRate',
        { rate: 0.85, lower: 0.70, upper: 0.95, marginOfError: 0.12 },
        'wilson_score',
      );
      expect(u.metric).toBe('servedRate');
      expect(u.value).toBe(0.85);
      expect(u.uncertainty).toBe(0.12);
      expect(u.confidenceInterval.lower).toBe(0.70);
      expect(u.confidenceInterval.upper).toBe(0.95);
      expect(u.method).toBe('wilson_score');
    });

    it('derives baseline thresholds directly for custom metrics', () => {
      const thresholds = deriveBaselineThresholds({
        baselineIdentityErrors: 0,
        hybridIdentityErrors: 0,
        criticalFieldRegressions: 0,
        baselineMeanFieldCorrectness: 0.82,
        hybridMeanFieldCorrectness: 0.88,
        baselineMeanImagePrecision: 0.71,
        hybridMeanImagePrecision: 0.93,
        baselineMeanImageRecall: 0.80,
        hybridMeanImageRecall: 0.78,
        baselinePrimaryAccuracy: 1.0,
        hybridPrimaryAccuracy: 1.0,
        baselineServedRate: 0.75,
        hybridServedRate: 0.80,
        baselineEvidenceGaps: 1,
        hybridEvidenceGaps: 1,
        baselineOperatorMinutes: 20.0,
        hybridOperatorMinutes: 10.0,
      });

      expect(thresholds.length).toBe(9);
      expect(thresholds.every(t => t.passed)).toBe(true);
    });

    it('formats threshold and abstention audit tables cleanly', () => {
      const sample = createSample('s1', 'standard_pdp');
      const rows = createRowsForSample(sample);
      const gateResult = evaluateGateArithmetic([sample], rows, { minSamplesForPromote: 1 });

      const threshTable = formatGateArithmeticThresholdsTable(gateResult.verdictsByScope);
      expect(threshTable).toContain('## Derived Baseline Thresholds & Gate Arithmetic Audit');
      expect(threshTable).toContain('| Scope | Dimension | Baseline Measured | Derived Target Threshold | Observed Hybrid | Uncertainty | Gate Rule | Status |');

      const abstTable = formatAbstentionGamingAuditTable(gateResult.verdictsByScope);
      expect(abstTable).toContain('## Abstention Gaming Audit');
      expect(abstTable).toContain('| Scope | Evidence Gaps (Base → Hyb) | Attempted (Base → Hyb) | Served Rate (Base → Hyb) | Gaming Detected? | Audit Details |');
    });
  });
});
