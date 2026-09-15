/**
 * Profile Extraction Audit Gate Arithmetic (Issue #178 / Gate T5)
 *
 * Implements the rigorous gate arithmetic for per-scope promotion verdicts:
 * 1. Computes per-scope verdicts from scored rows with uncertainty reported.
 * 2. Derives promotion thresholds from baseline numbers (grounded in observed coverage,
 *    never by fiat): zero accepted identity errors, zero critical-field regressions,
 *    improved image and completeness quality without abstention gaming, bounded maintenance.
 * 3. Detects abstention gaming (quality gains that hide failures fail the gate).
 * 4. Computes execution cost columns: latency, request counts, and operator minutes per domain.
 *
 * Delivers the authoritative go or no-go per scope for contract work.
 */

import type {
  AuditManifestSample,
  AuditScoredRow,
  ContractPromotionVerdict,
  DomainCostMetrics,
  GateThresholdCheck,
  AbstentionGamingCheck,
  PromotionMetricUncertainty,
  ReplayConfiguration,
  ScopeCostMetrics,
  ScopePromotionVerdict,
  ConfigurationCostMetrics,
  CostMeasurementProvenance,
  OperatorMinutesProvenance,
} from '../../shared/schemas/profile-audit';
import type { GateArithmeticOptions } from './types';
import {
  REPLAY_CONFIGURATIONS,
  CRITICAL_FIELDS as SHARED_CRITICAL_FIELDS,
  computeWilsonScoreInterval as sharedWilsonScoreInterval,
  resolveZForConfidence,
  isSampleServed,
  OPERATOR_MINUTE_COEFFICIENTS,
  MIN_SAMPLES_FOR_PROMOTE_DEFAULT,
  IMAGE_RECALL_FLOOR_FACTOR,
} from './shared-metrics';

import {
  resolveUsableObservations,
  inspectLabelProvenance,
  evaluatePromotionEligibility,
  buildBlockedReasons,
  formatPromotionRecommendation,
} from './promotion-eligibility';

/** Re-exported promotion eligibility helpers (Issue #185 / T1 Prefactor). */
export {
  resolveUsableObservations,
  inspectLabelProvenance,
  evaluatePromotionEligibility,
  buildBlockedReasons,
  formatPromotionRecommendation,
};

/** Critical fields (re-exported single source of truth from shared-metrics). */
export const CRITICAL_FIELDS: string[] = SHARED_CRITICAL_FIELDS;
/** Wilson interval (re-exported single source of truth from shared-metrics). */
export const computeWilsonScoreInterval = sharedWilsonScoreInterval;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Uncertainty Calculations (Wilson interval lives in shared-metrics.ts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes mean and standard error confidence interval for continuous metrics
 * bounded in [0, 1] (e.g. field correctness score, image precision, image recall).
 */
export function computeContinuousMetricInterval(
  values: number[],
  z: number = 1.96,
): {
  mean: number;
  lower: number;
  upper: number;
  marginOfError: number;
  standardError: number;
  stdDev: number;
  sampleCount: number;
} {
  const n = values.length;
  if (n === 0) {
    return { mean: 0, lower: 0, upper: 0, marginOfError: 0, standardError: 0, stdDev: 0, sampleCount: 0 };
  }
  if (n === 1) {
    return {
      mean: values[0],
      lower: values[0],
      upper: values[0],
      marginOfError: 0,
      standardError: 0,
      stdDev: 0,
      sampleCount: 1,
    };
  }

  const mean = values.reduce((acc, v) => acc + v, 0) / n;
  const variance = values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);
  const marginOfError = z * standardError;
  const lower = Math.max(0, mean - marginOfError);
  const upper = Math.min(1, mean + marginOfError);

  return {
    mean,
    lower,
    upper,
    marginOfError,
    standardError,
    stdDev,
    sampleCount: n,
  };
}

export function buildPromotionUncertainty(
  metric: string,
  stat: { rate?: number; mean?: number; lower: number; upper: number; marginOfError: number },
  method: 'wilson_score' | 'normal_approximation' | 'standard_error',
  confidenceLevel: number = 0.95,
): PromotionMetricUncertainty {
  const value = stat.mean !== undefined ? stat.mean : (stat.rate ?? 0);
  return {
    metric,
    value,
    uncertainty: stat.marginOfError,
    confidenceInterval: {
      lower: stat.lower,
      upper: stat.upper,
    },
    confidenceLevel,
    method,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Abstention Gaming Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface AbstentionGamingInput {
  baselineRows: AuditScoredRow[];
  hybridRows: AuditScoredRow[];
  baselineServedRate: number;
  hybridServedRate: number;
  baselineMeanFieldCorrectness: number;
  hybridMeanFieldCorrectness: number;
  baselineMeanImagePrecision: number;
  hybridMeanImagePrecision: number;
}

/**
 * Detects whether candidate quality gains are achieved by gaming abstention
 * (e.g. refusing hard or failing items, inflating evidence gaps, or dropping
 * served rate to artificially elevate precision on surviving items).
 */
export function detectAbstentionGaming(input: AbstentionGamingInput): AbstentionGamingCheck {
  const {
    baselineRows,
    hybridRows,
    baselineServedRate,
    hybridServedRate,
    baselineMeanFieldCorrectness,
    hybridMeanFieldCorrectness,
    baselineMeanImagePrecision,
    hybridMeanImagePrecision,
  } = input;

  const baselineEvidenceGaps = baselineRows.filter(r => r.isEvidenceGap).length;
  const hybridEvidenceGaps = hybridRows.filter(r => r.isEvidenceGap).length;

  const baselineAttemptedCount = baselineRows.filter(r => !r.isEvidenceGap).length;
  const hybridAttemptedCount = hybridRows.filter(r => !r.isEvidenceGap).length;

  const reasons: string[] = [];
  let evidenceGapInflated = false;
  let servedRateDropDetected = false;
  let sampleRefusalDetected = false;

  // 1. Evidence Gap Inflation: hybrid claims more evidence gaps than baseline
  if (hybridEvidenceGaps > baselineEvidenceGaps) {
    evidenceGapInflated = true;
    reasons.push(
      `Evidence gap count inflated: hybrid reported ${hybridEvidenceGaps} evidence gaps vs baseline ${baselineEvidenceGaps}`,
    );
  }

  // 2. Selective Refusal / Dropped Attempted Samples
  if (hybridAttemptedCount < baselineAttemptedCount) {
    sampleRefusalDetected = true;
    reasons.push(
      `Sample refusal detected: hybrid attempted only ${hybridAttemptedCount} samples vs baseline ${baselineAttemptedCount}`,
    );
  }

  // 3. Inverse Coverage vs Quality Trade-off:
  // Precision or Field Correctness rose, but served rate fell below baseline
  const qualityRose = (hybridMeanFieldCorrectness > baselineMeanFieldCorrectness + 1e-6) ||
                      (hybridMeanImagePrecision > baselineMeanImagePrecision + 1e-6);
  const servedRateRegressed = hybridServedRate < baselineServedRate - 1e-6;

  if (qualityRose && servedRateRegressed) {
    servedRateDropDetected = true;
    reasons.push(
      `Abstention gaming detected: quality metrics increased while served rate regressed from ${(baselineServedRate * 100).toFixed(1)}% to ${(hybridServedRate * 100).toFixed(1)}% (refusing failing items to inflate score)`,
    );
  } else if (servedRateRegressed) {
    reasons.push(
      `Served rate regressed below baseline from ${(baselineServedRate * 100).toFixed(1)}% to ${(hybridServedRate * 100).toFixed(1)}%`,
    );
  }

  const gamingDetected = evidenceGapInflated || sampleRefusalDetected || servedRateDropDetected;

  return {
    gamingDetected,
    evidenceGapInflated,
    baselineEvidenceGaps,
    hybridEvidenceGaps,
    servedRateDropDetected,
    baselineServedRate,
    hybridServedRate,
    sampleRefusalDetected,
    baselineAttemptedCount,
    hybridAttemptedCount,
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Execution Cost & Operator Minutes Calculations
// ─────────────────────────────────────────────────────────────────────────────

export interface ComputeCostOptions {
  operatorMinutesOverride?: Record<string, Record<ReplayConfiguration, number>>;
  baseOperatorMinutes?: number;
}

export function computeScopeCostMetrics(
  scope: string,
  domain: string | undefined,
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: ComputeCostOptions = {},
): ScopeCostMetrics {
  const sampleCount = samples.length;
  const sampleIdSet = new Set(samples.map(s => s.sampleId));
  const scopeRows = rows.filter(r => sampleIdSet.has(r.sampleId));

  const configs: ReplayConfiguration[] = [...REPLAY_CONFIGURATIONS];

  const byConfiguration: Record<ReplayConfiguration, ConfigurationCostMetrics> = {} as any;

  // Base upkeep for domain profile maintenance (selector-drift upkeep for
  // selector-led configs; see OPERATOR_MINUTE_COEFFICIENTS).
  const baseMins = options.baseOperatorMinutes ?? OPERATOR_MINUTE_COEFFICIENTS.BASE_MAINTENANCE_MINUTES;
  const C = OPERATOR_MINUTE_COEFFICIENTS;

  for (const cfg of configs) {
    const cfgRows = scopeRows.filter(r => r.configuration === cfg);

    // Latency (fix #5): measured values ONLY. Evidence-gap rows record
    // absence, not timing, and rows replayed with recordLatency:false carry
    // no wall-clock data — both are excluded. When nothing was measured the
    // columns are marked unmeasured (numeric 0 placeholder) instead of
    // backfilling fiat estimates; renderers must print "unmeasured".
    const measuredLatencies = cfgRows
      .filter(r => !r.isEvidenceGap && typeof r.latencyMs === 'number' && !isNaN(r.latencyMs))
      .map(r => r.latencyMs as number);
    const latencyProvenance: CostMeasurementProvenance =
      measuredLatencies.length > 0 ? 'measured' : 'unmeasured';

    const totalLatency = measuredLatencies.reduce((a, b) => a + b, 0);
    const meanLatency = measuredLatencies.length > 0
      ? Math.round((totalLatency / measuredLatencies.length) * 10) / 10
      : 0;
    const sortedLatencies = [...measuredLatencies].sort((a, b) => a - b);
    const p95Latency = sortedLatencies.length > 0
      ? Math.round(sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))] * 10) / 10
      : 0;

    // Requests: recorded requestCount values only (evidence-gap 0s are
    // factual — no fetch happened). Rows with no recorded count leave the
    // column unmeasured instead of assuming 1.0/sample.
    const measuredReqCounts = cfgRows
      .filter(r => typeof r.requestCount === 'number' && !isNaN(r.requestCount))
      .map(r => r.requestCount as number);
    const requestsProvenance: CostMeasurementProvenance =
      measuredReqCounts.length > 0 ? 'measured' : 'unmeasured';
    const totalRequests = measuredReqCounts.reduce((a, b) => a + b, 0);
    const requestsPerSample = sampleCount > 0 && measuredReqCounts.length > 0
      ? Math.round((totalRequests / sampleCount) * 10) / 10
      : 0;

    // Operator Maintenance Minutes (fix #6): the formula below is a MODEL
    // (coefficients in OPERATOR_MINUTE_COEFFICIENTS). Provenance is
    // 'measured' only when a measured override was supplied for this
    // domain+configuration via options.operatorMinutesOverride.
    let operatorMins: number;
    let operatorMinutesProvenance: OperatorMinutesProvenance = 'modeled';
    if (domain && options.operatorMinutesOverride?.[domain]?.[cfg] !== undefined) {
      operatorMins = options.operatorMinutesOverride[domain][cfg];
      operatorMinutesProvenance = 'measured';
    } else {
      switch (cfg) {
        case 'current_extraction': {
          // Selector-led: base upkeep for selector drift + repair per defect.
          const defects = cfgRows.filter(
            r => r.identityVerdict !== 'correct_match' || r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD'),
          ).length;
          operatorMins = Math.round((baseMins + defects * C.DEFECT_REPAIR_MINUTES) * 10) / 10;
          break;
        }
        case 'current_strict_images': {
          const defects = cfgRows.filter(
            r => r.identityVerdict !== 'correct_match' || r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD'),
          ).length;
          operatorMins = Math.round((baseMins * C.STRICT_BASE_FACTOR + defects * C.DEFECT_REPAIR_MINUTES_STRICT) * 10) / 10;
          break;
        }
        case 'structured_only': {
          // Zero selector upkeep, but missing-field review per gap.
          const missingCount = cfgRows.filter(r => r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD')).length;
          operatorMins = Math.round((C.STRUCTURED_BASE_MINUTES + missingCount * C.STRUCTURED_MISSING_FIELD_MINUTES) * 10) / 10;
          break;
        }
        case 'hybrid_identity_first': {
          // Bounded maintenance: structured data first, conflict triage only.
          // Modeled as base triage + per-conflict + per-unresolved-variant
          // + per-identity-error triage (coefficients in shared-metrics).
          const conflictsCount = cfgRows.reduce((acc, r) => acc + (r.conflicts?.length || 0), 0);
          const identityErrors = cfgRows.filter(r => r.identityVerdict !== 'correct_match').length;
          const unresolved = cfgRows.filter(
            r => r.identityResolution?.status === 'no_variant_match' || r.identityResolution?.status === 'ambiguous_variant',
          ).length;
          operatorMins = Math.round((C.HYBRID_BASE_TRIAGE_MINUTES + conflictsCount * C.HYBRID_CONFLICT_MINUTES + unresolved * C.HYBRID_UNRESOLVED_VARIANT_MINUTES + identityErrors * C.HYBRID_IDENTITY_ERROR_MINUTES) * 10) / 10;
          break;
        }
      }
    }

    byConfiguration[cfg] = {
      configuration: cfg,
      meanLatencyMs: meanLatency,
      p95LatencyMs: p95Latency,
      totalLatencyMs: Math.round(totalLatency * 10) / 10,
      totalRequests,
      requestsPerSample,
      operatorMinutes: operatorMins!,
      latencyProvenance,
      requestsProvenance,
      operatorMinutesProvenance,
    };
  }

  const baselineCfg = byConfiguration.current_extraction;
  const hybridCfg = byConfiguration.hybrid_identity_first;

  const baselineLatencyMs = baselineCfg.meanLatencyMs;
  const hybridLatencyMs = hybridCfg.meanLatencyMs;
  const latencyDeltaMs = Math.round((hybridLatencyMs - baselineLatencyMs) * 10) / 10;

  const baselineRequestsPerSample = baselineCfg.requestsPerSample;
  const hybridRequestsPerSample = hybridCfg.requestsPerSample;
  const baselineTotalRequests = baselineCfg.totalRequests;
  const hybridTotalRequests = hybridCfg.totalRequests;

  const baselineOperatorMinutes = baselineCfg.operatorMinutes;
  const hybridOperatorMinutes = hybridCfg.operatorMinutes;
  const operatorMinutesSaved = Math.round((baselineOperatorMinutes - hybridOperatorMinutes) * 10) / 10;

  // Bounded maintenance requirement (fix #6): hybrid maintenance cost must be
  // <= baseline, compared LIKE-FOR-LIKE. The comparison basis is recorded so
  // reviewers can tell modeled-vs-modeled (formula both sides) apart from
  // measured-vs-measured (override both sides) or mixed comparisons.
  const isMaintenanceBounded = hybridOperatorMinutes <= baselineOperatorMinutes;
  const baselineOpProv = baselineCfg.operatorMinutesProvenance ?? 'modeled';
  const hybridOpProv = hybridCfg.operatorMinutesProvenance ?? 'modeled';
  const operatorMinutesProvenance: 'measured' | 'modeled' | 'mixed' =
    baselineOpProv === hybridOpProv ? baselineOpProv : 'mixed';
  const maintenanceComparisonNote =
    `like-for-like ${baselineOpProv}-vs-${hybridOpProv} operator-minutes comparison`;

  // Scope roll-up provenance: latency/requests are 'measured' only when at
  // least one side measured; operator minutes roll up per above.
  const latencyProvenance: CostMeasurementProvenance =
    baselineCfg.latencyProvenance === 'measured' || hybridCfg.latencyProvenance === 'measured'
      ? 'measured'
      : 'unmeasured';
  const requestsProvenance: CostMeasurementProvenance =
    baselineCfg.requestsProvenance === 'measured' || hybridCfg.requestsProvenance === 'measured'
      ? 'measured'
      : 'unmeasured';

  return {
    scope,
    domain,
    sampleCount,
    baselineLatencyMs,
    hybridLatencyMs,
    latencyDeltaMs,
    baselineRequestsPerSample,
    hybridRequestsPerSample,
    baselineTotalRequests,
    hybridTotalRequests,
    baselineOperatorMinutes,
    hybridOperatorMinutes,
    operatorMinutesSaved,
    isMaintenanceBounded,
    byConfiguration,
    latencyProvenance,
    requestsProvenance,
    operatorMinutesProvenance,
    maintenanceComparisonNote,
  };
}

export function computeDomainCostMetrics(
  domain: string,
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: ComputeCostOptions = {},
): DomainCostMetrics {
  const totalSamples = samples.length;
  const scopeKeys = Array.from(new Set(samples.map(s => s.pageStructureScope || 'standard_pdp')));
  const byScope: Record<string, ScopeCostMetrics> = {};

  let sumBaselineLatency = 0;
  let sumHybridLatency = 0;
  let totalBaselineRequests = 0;
  let totalHybridRequests = 0;
  let totalBaselineOperatorMins = 0;
  let totalHybridOperatorMins = 0;

  for (const sk of scopeKeys) {
    const scopeSamples = samples.filter(s => (s.pageStructureScope || 'standard_pdp') === sk);
    const cost = computeScopeCostMetrics(sk, domain, scopeSamples, rows, options);
    byScope[sk] = cost;

    sumBaselineLatency += cost.baselineLatencyMs * cost.sampleCount;
    sumHybridLatency += cost.hybridLatencyMs * cost.sampleCount;
    totalBaselineRequests += cost.baselineTotalRequests;
    totalHybridRequests += cost.hybridTotalRequests;
    totalBaselineOperatorMins += cost.baselineOperatorMinutes;
    totalHybridOperatorMins += cost.hybridOperatorMinutes;
  }

  const baselineLatencyMs = totalSamples > 0 ? Math.round((sumBaselineLatency / totalSamples) * 10) / 10 : 0;
  const hybridLatencyMs = totalSamples > 0 ? Math.round((sumHybridLatency / totalSamples) * 10) / 10 : 0;
  const baselineOperatorMinutes = Math.round(totalBaselineOperatorMins * 10) / 10;
  const hybridOperatorMinutes = Math.round(totalHybridOperatorMins * 10) / 10;
  const operatorMinutesSaved = Math.round((baselineOperatorMinutes - hybridOperatorMinutes) * 10) / 10;
  const isMaintenanceBounded = hybridOperatorMinutes <= baselineOperatorMinutes;

  // Domain roll-up basis (fix #6): like-for-like across scopes.
  const scopeProvenances = Object.values(byScope).map(s => s.operatorMinutesProvenance ?? 'modeled');
  const domainBasis = scopeProvenances.length === 0
    ? 'modeled'
    : (scopeProvenances.every(p => p === scopeProvenances[0]) ? scopeProvenances[0] : 'mixed');

  return {
    domain,
    totalSamples,
    baselineLatencyMs,
    hybridLatencyMs,
    baselineTotalRequests: totalBaselineRequests,
    hybridTotalRequests: totalHybridRequests,
    baselineOperatorMinutes,
    hybridOperatorMinutes,
    operatorMinutesSaved,
    isMaintenanceBounded,
    byScope,
    maintenanceComparisonNote: `like-for-like domain roll-up (${domainBasis} basis across scopes)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Derived Baseline Thresholds Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface BaselineThresholdInput {
  baselineIdentityErrors: number;
  hybridIdentityErrors: number;
  criticalFieldRegressions: number;
  baselineMeanFieldCorrectness: number;
  hybridMeanFieldCorrectness: number;
  hybridFieldCorrectnessUncertainty?: number;
  baselineMeanImagePrecision: number;
  hybridMeanImagePrecision: number;
  hybridImagePrecisionUncertainty?: number;
  baselineMeanImageRecall: number;
  hybridMeanImageRecall: number;
  hybridImageRecallUncertainty?: number;
  baselinePrimaryAccuracy: number;
  hybridPrimaryAccuracy: number;
  hybridPrimaryAccuracyUncertainty?: number;
  hybridIdentityAccuracyUncertainty?: number;
  baselineServedRate: number;
  hybridServedRate: number;
  hybridServedRateUncertainty?: number;
  baselineEvidenceGaps: number;
  hybridEvidenceGaps: number;
  baselineOperatorMinutes: number;
  hybridOperatorMinutes: number;
}

/**
 * Derives promotion thresholds strictly from baseline numbers (grounded in
 * observed coverage, never by fiat) and checks candidate performance.
 */
export function deriveBaselineThresholds(input: BaselineThresholdInput): GateThresholdCheck[] {
  const checks: GateThresholdCheck[] = [];

  // 1. Identity Integrity: Zero accepted identity errors
  const idPassed = input.hybridIdentityErrors === 0;
  checks.push({
    name: 'Zero Accepted Identity Errors',
    dimension: 'identity_integrity',
    baselineValue: input.baselineIdentityErrors,
    thresholdValue: 0,
    actualValue: input.hybridIdentityErrors,
    actualUncertainty: input.hybridIdentityAccuracyUncertainty,
    unit: 'errors',
    rule: 'actual <= 0',
    passed: idPassed,
    reason: idPassed
      ? '✓ Zero observed identity errors (100% correct identity match)'
      : `Blocked: ${input.hybridIdentityErrors} identity errors (wrong product or variant confusion) detected`,
  });

  // 2. Critical Field Regressions: No regressions on title/brand/price vs baseline
  const crPassed = input.criticalFieldRegressions === 0;
  checks.push({
    name: 'No Critical Field Regressions',
    dimension: 'critical_field_regression',
    baselineValue: 0,
    thresholdValue: 0,
    actualValue: input.criticalFieldRegressions,
    unit: 'regressions',
    rule: 'actual <= 0',
    passed: crPassed,
    reason: crPassed
      ? '✓ Zero critical-field regressions on title, brand, or price'
      : `Blocked: ${input.criticalFieldRegressions} critical field regressions versus baseline on title/brand/price`,
  });

  // 3. Field Completeness & Correctness: Match or exceed baseline coverage
  const fcZeroEquality = input.baselineMeanFieldCorrectness === 0 && input.hybridMeanFieldCorrectness === 0;
  const fcPassed = !fcZeroEquality && input.hybridMeanFieldCorrectness >= input.baselineMeanFieldCorrectness - 1e-9;
  checks.push({
    name: 'Field Completeness & Correctness',
    dimension: 'field_completeness',
    baselineValue: input.baselineMeanFieldCorrectness,
    thresholdValue: input.baselineMeanFieldCorrectness,
    actualValue: input.hybridMeanFieldCorrectness,
    actualUncertainty: input.hybridFieldCorrectnessUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: fcPassed,
    reason: fcZeroEquality
      ? `Blocked: Equality with zero-quality baseline on field correctness (0.0% vs 0.0% baseline); promotion requires demonstrated quality and improvement`
      : (fcPassed
          ? `✓ Maintained or improved field completeness (${(input.hybridMeanFieldCorrectness * 100).toFixed(1)}%)`
          : `Blocked: Mean field correctness regressed below baseline (${(input.hybridMeanFieldCorrectness * 100).toFixed(1)}% vs ${(input.baselineMeanFieldCorrectness * 100).toFixed(1)}%)`),
  });

  // 4. Image Precision: Match or exceed baseline precision
  const ipZeroEquality = input.baselineMeanImagePrecision === 0 && input.hybridMeanImagePrecision === 0;
  const ipPassed = !ipZeroEquality && input.hybridMeanImagePrecision >= input.baselineMeanImagePrecision - 1e-9;
  checks.push({
    name: 'Image Precision',
    dimension: 'image_precision',
    baselineValue: input.baselineMeanImagePrecision,
    thresholdValue: input.baselineMeanImagePrecision,
    actualValue: input.hybridMeanImagePrecision,
    actualUncertainty: input.hybridImagePrecisionUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: ipPassed,
    reason: ipZeroEquality
      ? `Blocked: Equality with zero-quality baseline on image precision (0.0% vs 0.0% baseline); promotion requires demonstrated quality and improvement`
      : (ipPassed
          ? `✓ Improved image precision (${(input.hybridMeanImagePrecision * 100).toFixed(1)}% vs ${(input.baselineMeanImagePrecision * 100).toFixed(1)}% baseline)`
          : `Blocked: Mean image precision regressed below baseline (${(input.hybridMeanImagePrecision * 100).toFixed(1)}% vs ${(input.baselineMeanImagePrecision * 100).toFixed(1)}%)`),
  });

  // 5. Image Recall: Bounded drop allowed (e.g. dedupe of thumbnails/icons).
  // The floor is DERIVED from the measured baseline recall
  // (IMAGE_RECALL_FLOOR_FACTOR of baseline) — never a fiat absolute.
  const recallThreshold = Math.max(0, input.baselineMeanImageRecall * IMAGE_RECALL_FLOOR_FACTOR);
  const irPassed = input.hybridMeanImageRecall >= recallThreshold - 1e-9;
  checks.push({
    name: 'Image Recall',
    dimension: 'image_recall',
    baselineValue: input.baselineMeanImageRecall,
    thresholdValue: recallThreshold,
    actualValue: input.hybridMeanImageRecall,
    actualUncertainty: input.hybridImageRecallUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: irPassed,
    reason: irPassed
      ? `✓ Image recall (${(input.hybridMeanImageRecall * 100).toFixed(1)}%) satisfied derived baseline bound (${(recallThreshold * 100).toFixed(1)}%)`
      : `Blocked: Image recall (${(input.hybridMeanImageRecall * 100).toFixed(1)}%) dropped excessively below baseline bound (${(recallThreshold * 100).toFixed(1)}%)`,
  });

  // 6. Primary Image Accuracy: Match or exceed baseline primary accuracy
  const paZeroEquality = input.baselinePrimaryAccuracy === 0 && input.hybridPrimaryAccuracy === 0;
  const paPassed = !paZeroEquality && input.hybridPrimaryAccuracy >= input.baselinePrimaryAccuracy - 1e-9;
  checks.push({
    name: 'Primary Image Accuracy',
    dimension: 'primary_image_accuracy',
    baselineValue: input.baselinePrimaryAccuracy,
    thresholdValue: input.baselinePrimaryAccuracy,
    actualValue: input.hybridPrimaryAccuracy,
    actualUncertainty: input.hybridPrimaryAccuracyUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: paPassed,
    reason: paZeroEquality
      ? `Blocked: Equality with zero-quality baseline on primary image accuracy (0.0% vs 0.0% baseline); promotion requires demonstrated quality and improvement`
      : (paPassed
          ? `✓ Primary image accuracy (${(input.hybridPrimaryAccuracy * 100).toFixed(1)}%) met or exceeded baseline threshold (${(input.baselinePrimaryAccuracy * 100).toFixed(1)}%)`
          : `Blocked: Primary image accuracy (${(input.hybridPrimaryAccuracy * 100).toFixed(1)}%) regressed below baseline threshold (${(input.baselinePrimaryAccuracy * 100).toFixed(1)}%)`),
  });

  // 7. Served Rate: Match or exceed baseline served rate
  const srZeroEquality = input.baselineServedRate === 0 && input.hybridServedRate === 0;
  const srPassed = !srZeroEquality && input.hybridServedRate >= input.baselineServedRate - 1e-9;
  checks.push({
    name: 'Served Rate',
    dimension: 'served_rate',
    baselineValue: input.baselineServedRate,
    thresholdValue: input.baselineServedRate,
    actualValue: input.hybridServedRate,
    actualUncertainty: input.hybridServedRateUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: srPassed,
    reason: srZeroEquality
      ? `Blocked: Equality with zero-quality baseline on served rate (0.0% vs 0.0% baseline); promotion requires demonstrated quality and improvement`
      : (srPassed
          ? `✓ Served rate (${(input.hybridServedRate * 100).toFixed(1)}%) met or exceeded baseline threshold (${(input.baselineServedRate * 100).toFixed(1)}%)`
          : `Blocked: Hybrid served rate regressed below baseline (${(input.hybridServedRate * 100).toFixed(1)}% vs ${(input.baselineServedRate * 100).toFixed(1)}%)`),
  });

  // 8. Abstention Bound (Evidence Gaps): Cannot exceed baseline evidence gaps
  const egPassed = input.hybridEvidenceGaps <= input.baselineEvidenceGaps;
  checks.push({
    name: 'Evidence Gap Bound (Abstention)',
    dimension: 'abstention_bound',
    baselineValue: input.baselineEvidenceGaps,
    thresholdValue: input.baselineEvidenceGaps,
    actualValue: input.hybridEvidenceGaps,
    unit: 'gaps',
    rule: 'actual <= threshold',
    passed: egPassed,
    reason: egPassed
      ? '✓ Zero evidence-gap inflation / no abstention gaming'
      : `Blocked: Evidence gaps exceeded baseline (abstention gaming detected: ${input.hybridEvidenceGaps} vs ${input.baselineEvidenceGaps})`,
  });

  // 9. Bounded Maintenance: Hybrid operator minutes must be <= baseline
  const bmPassed = input.hybridOperatorMinutes <= input.baselineOperatorMinutes;
  checks.push({
    name: 'Bounded Maintenance',
    dimension: 'bounded_maintenance',
    baselineValue: input.baselineOperatorMinutes,
    thresholdValue: input.baselineOperatorMinutes,
    actualValue: input.hybridOperatorMinutes,
    unit: 'minutes',
    rule: 'actual <= threshold',
    passed: bmPassed,
    reason: bmPassed
      ? `✓ Operator maintenance (${input.hybridOperatorMinutes.toFixed(1)} mins) is bounded within baseline threshold (${input.baselineOperatorMinutes.toFixed(1)} mins)`
      : `Blocked: Operator maintenance (${input.hybridOperatorMinutes.toFixed(1)} mins) exceeded baseline threshold (${input.baselineOperatorMinutes.toFixed(1)} mins)`,
  });

  return checks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Per-Scope Gate Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateScopeGate(
  scope: string,
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: GateArithmeticOptions = {},
): ScopePromotionVerdict {
  const minSamples = options.minSamplesForPromote ?? MIN_SAMPLES_FOR_PROMOTE_DEFAULT;
  const z = resolveZForConfidence(options.targetConfidence);

  const usableObs = resolveUsableObservations(samples, rows, minSamples);
  const { sampleCount, baselineRows, hybridRows } = usableObs;
  const labelProvenance = inspectLabelProvenance(samples);

  // Served predicate: single source of truth in shared-metrics.ts (fix #13).
  // (Local isSampleServed removed — use the shared isSampleServed.)

  let baselineServedCount = 0;
  for (const b of baselineRows) {
    const s = samples.find(sample => sample.sampleId === b.sampleId);
    if (s && isSampleServed(b, s)) baselineServedCount++;
  }

  let hybridServedCount = 0;
  let acceptedIdentityErrors = 0;
  let criticalFieldRegressions = 0;
  const hybridFieldScores: number[] = [];
  const baselineFieldScores: number[] = [];
  const hybridPrecisionScores: number[] = [];
  const baselinePrecisionScores: number[] = [];
  const hybridRecallScores: number[] = [];
  const baselineRecallScores: number[] = [];
  let hybridPrimaryAccSum = 0;
  let baselinePrimaryAccSum = 0;
  let hybridEvidenceGaps = 0;
  let baselineEvidenceGaps = 0;

  for (const r of hybridRows) {
    const s = samples.find(sample => sample.sampleId === r.sampleId);
    if (s && isSampleServed(r, s)) hybridServedCount++;

    if (r.isEvidenceGap) {
      hybridEvidenceGaps++;
    } else {
      if (r.identityVerdict !== 'correct_match' || r.identityResolution?.confusionDetected) {
        acceptedIdentityErrors++;
      }
    }

    hybridFieldScores.push(r.fieldCorrectnessScore);
    hybridPrecisionScores.push(r.imageScores.precision);
    hybridRecallScores.push(r.imageScores.recall);
    hybridPrimaryAccSum += r.imageScores.primaryAccuracy;

    // Check critical field regressions against baseline
    const b = baselineRows.find(row => row.sampleId === r.sampleId);
    if (b) {
      for (const cf of CRITICAL_FIELDS) {
        const bScore = b.fieldScores[cf];
        const hScore = r.fieldScores[cf];
        if (bScore?.correct === true && hScore?.correct !== true) {
          criticalFieldRegressions++;
        }
      }
    }
  }

  for (const b of baselineRows) {
    if (b.isEvidenceGap) {
      baselineEvidenceGaps++;
    }
    baselineFieldScores.push(b.fieldCorrectnessScore);
    baselinePrecisionScores.push(b.imageScores.precision);
    baselineRecallScores.push(b.imageScores.recall);
    baselinePrimaryAccSum += b.imageScores.primaryAccuracy;
  }

  const baselineServedRate = sampleCount > 0 ? baselineServedCount / sampleCount : 0;
  const hybridServedStats = computeWilsonScoreInterval(hybridServedCount, sampleCount, z);
  const servedRateDelta = hybridServedStats.rate - baselineServedRate;

  const baselineMeanFieldCorrectness = baselineFieldScores.length > 0
    ? baselineFieldScores.reduce((a, b) => a + b, 0) / baselineFieldScores.length
    : 0;
  const hybridFieldStats = computeContinuousMetricInterval(hybridFieldScores, z);

  const baselineMeanImagePrecision = baselinePrecisionScores.length > 0
    ? baselinePrecisionScores.reduce((a, b) => a + b, 0) / baselinePrecisionScores.length
    : 0;
  const hybridPrecisionStats = computeContinuousMetricInterval(hybridPrecisionScores, z);

  const baselineMeanImageRecall = baselineRecallScores.length > 0
    ? baselineRecallScores.reduce((a, b) => a + b, 0) / baselineRecallScores.length
    : 0;
  const hybridRecallStats = computeContinuousMetricInterval(hybridRecallScores, z);

  const baselinePrimaryAccuracy = baselineRows.length > 0 ? baselinePrimaryAccSum / baselineRows.length : 0;
  const hybridPrimaryStats = computeWilsonScoreInterval(hybridPrimaryAccSum, hybridRows.length, z);

  const nonGapHybridCount = hybridRows.filter(r => !r.isEvidenceGap).length;
  const identitySuccesses = Math.max(0, nonGapHybridCount - acceptedIdentityErrors);
  const identityStats = computeWilsonScoreInterval(identitySuccesses, nonGapHybridCount, z);

  // Cost Metrics
  const domain = samples[0]?.domain;
  const platform = samples[0]?.platform;
  const costMetrics = computeScopeCostMetrics(scope, domain, samples, rows, options);

  // Abstention Gaming Check
  const abstentionGaming = detectAbstentionGaming({
    baselineRows,
    hybridRows,
    baselineServedRate,
    hybridServedRate: hybridServedStats.rate,
    baselineMeanFieldCorrectness,
    hybridMeanFieldCorrectness: hybridFieldStats.mean,
    baselineMeanImagePrecision,
    hybridMeanImagePrecision: hybridPrecisionStats.mean,
  });

  // Derived Baseline Thresholds Check
  const baselineIdentityErrors = baselineRows.filter(
    b => !b.isEvidenceGap && (b.identityVerdict !== 'correct_match' || b.identityResolution?.confusionDetected),
  ).length;

  const thresholds = deriveBaselineThresholds({
    baselineIdentityErrors,
    hybridIdentityErrors: acceptedIdentityErrors,
    criticalFieldRegressions,
    baselineMeanFieldCorrectness,
    hybridMeanFieldCorrectness: hybridFieldStats.mean,
    hybridFieldCorrectnessUncertainty: hybridFieldStats.marginOfError,
    baselineMeanImagePrecision,
    hybridMeanImagePrecision: hybridPrecisionStats.mean,
    hybridImagePrecisionUncertainty: hybridPrecisionStats.marginOfError,
    baselineMeanImageRecall,
    hybridMeanImageRecall: hybridRecallStats.mean,
    hybridImageRecallUncertainty: hybridRecallStats.marginOfError,
    baselinePrimaryAccuracy,
    hybridPrimaryAccuracy: hybridPrimaryStats.rate,
    hybridPrimaryAccuracyUncertainty: hybridPrimaryStats.marginOfError,
    hybridIdentityAccuracyUncertainty: identityStats.marginOfError,
    baselineServedRate,
    hybridServedRate: hybridServedStats.rate,
    hybridServedRateUncertainty: hybridServedStats.marginOfError,
    baselineEvidenceGaps,
    hybridEvidenceGaps,
    baselineOperatorMinutes: costMetrics.baselineOperatorMinutes,
    hybridOperatorMinutes: costMetrics.hybridOperatorMinutes,
  });

  const allThresholdsPassed = thresholds.every(t => t.passed);

  // Unified Promotion Eligibility Determination (Issue #185 / T1 Prefactor)
  const eligibility = evaluatePromotionEligibility({
    scope,
    sampleCount,
    minSamples,
    allThresholdsPassed,
    thresholds,
    abstentionGaming,
    costMetrics,
    hybridPrecisionMean: hybridPrecisionStats.mean,
    baselineMeanImagePrecision,
    hybridFieldStatsMean: hybridFieldStats.mean,
    usableObservations: usableObs,
    labelProvenance,
    baselineServedRate,
    hybridServedRate: hybridServedStats.rate,
  });

  const { verdict, isPromotable, promotabilityVerdict, promotabilityReasons } = eligibility;

  // Metric Uncertainties
  const servedRate = buildPromotionUncertainty('servedRate', hybridServedStats, 'wilson_score');
  const identityAccuracy = buildPromotionUncertainty('identityAccuracy', identityStats, 'wilson_score');
  const fieldCorrectness = buildPromotionUncertainty('fieldCorrectness', hybridFieldStats, 'standard_error');
  const imagePrecision = buildPromotionUncertainty('imagePrecision', hybridPrecisionStats, 'standard_error');
  const imageRecall = buildPromotionUncertainty('imageRecall', hybridRecallStats, 'standard_error');
  const primaryImageAccuracy = buildPromotionUncertainty('primaryImageAccuracy', hybridPrimaryStats, 'wilson_score');

  const labelVersion = samples.find(s => !!s.labelVersion)?.labelVersion ?? options.labelVersion ?? '1.0.0';
  const partition = options.partition ?? 'all';

  return {
    scope,
    domain,
    platform,
    labelVersion,
    partition,
    sampleCount,
    usableObservationCount: usableObs.usableObservationCount,
    evidenceGapCount: usableObs.evidenceGapCount,
    samples,
    verdict,
    isPromotable,
    promotabilityVerdict,
    promotabilityReasons,
    thresholds,
    allThresholdsPassed,
    abstentionGaming,
    servedRate,
    baselineServedRate,
    servedRateDelta,
    identityAccuracy,
    acceptedIdentityErrors,
    criticalFieldRegressions,
    fieldCorrectness,
    baselineFieldCorrectness: baselineMeanFieldCorrectness,
    imagePrecision,
    baselineImagePrecision: baselineMeanImagePrecision,
    imageRecall,
    baselineImageRecall: baselineMeanImageRecall,
    primaryImageAccuracy,
    baselinePrimaryImageAccuracy: baselinePrimaryAccuracy,
    costMetrics,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Full Gate Arithmetic Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export interface FullGateArithmeticResult {
  domain: string;
  verdictsByScope: Record<string, ScopePromotionVerdict>;
  tuningVerdictsByScope: Record<string, ScopePromotionVerdict>;
  holdoutVerdictsByScope: Record<string, ScopePromotionVerdict>;
  domainCostMetrics: DomainCostMetrics;
  overallContractVerdict: ContractPromotionVerdict;
  labelVersion: string;
}

export function evaluateGateArithmetic(
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: GateArithmeticOptions = {},
): FullGateArithmeticResult {
  const domain = samples[0]?.domain || 'unknown';
  const labelVersion = samples.find(s => !!s.labelVersion)?.labelVersion ?? options.labelVersion ?? '1.0.0';
  const scopeKeys = Array.from(new Set(samples.map(s => s.pageStructureScope || 'standard_pdp')));

  const verdictsByScope: Record<string, ScopePromotionVerdict> = {};
  const tuningVerdictsByScope: Record<string, ScopePromotionVerdict> = {};
  const holdoutVerdictsByScope: Record<string, ScopePromotionVerdict> = {};

  for (const sk of scopeKeys) {
    const scopeSamples = samples.filter(s => (s.pageStructureScope || 'standard_pdp') === sk);
    verdictsByScope[sk] = evaluateScopeGate(sk, scopeSamples, rows, { ...options, labelVersion, partition: 'all' });

    const tuningSamples = scopeSamples.filter(s => !s.isHoldout);
    if (tuningSamples.length > 0) {
      tuningVerdictsByScope[sk] = evaluateScopeGate(sk, tuningSamples, rows, { ...options, labelVersion, partition: 'tuning' });
    }

    const holdoutSamples = scopeSamples.filter(s => s.isHoldout);
    if (holdoutSamples.length > 0) {
      holdoutVerdictsByScope[sk] = evaluateScopeGate(sk, holdoutSamples, rows, { ...options, labelVersion, partition: 'holdout' });
    }
  }

  const domainCostMetrics = computeDomainCostMetrics(domain, samples, rows, options);

  // Overall Contract Verdict:
  // GO only if at least 1 scope evaluated and all scopes are GO.
  // NO_GO if any scope has NO_GO.
  // Otherwise NEEDS_REVIEW.
  const scopeVerdictValues = Object.values(verdictsByScope);
  let overallContractVerdict: ContractPromotionVerdict;

  if (scopeVerdictValues.length === 0) {
    overallContractVerdict = 'NEEDS_REVIEW';
  } else if (scopeVerdictValues.some(v => v.verdict === 'NO_GO')) {
    overallContractVerdict = 'NO_GO';
  } else if (scopeVerdictValues.every(v => v.verdict === 'GO')) {
    overallContractVerdict = 'GO';
  } else {
    overallContractVerdict = 'NEEDS_REVIEW';
  }

  return {
    domain,
    verdictsByScope,
    tuningVerdictsByScope,
    holdoutVerdictsByScope,
    domainCostMetrics,
    overallContractVerdict,
    labelVersion,
  };
}
