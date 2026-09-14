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
} from '../../shared/schemas/profile-audit';
import type { GateArithmeticOptions } from './types';

export const CRITICAL_FIELDS = ['title', 'brand', 'price'];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Uncertainty Calculations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes Wilson Score interval for binomial proportions (e.g. served rate,
 * identity accuracy, primary image accuracy).
 */
export function computeWilsonScoreInterval(
  successes: number,
  total: number,
  z: number = 1.96,
): { rate: number; lower: number; upper: number; marginOfError: number } {
  if (total <= 0) {
    return { rate: 0, lower: 0, upper: 0, marginOfError: 0 };
  }
  const clampedSuccesses = Math.max(0, Math.min(total, successes));
  const p = clampedSuccesses / total;
  const z2 = z * z;
  const n = total;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;

  const lower = Math.max(0, center - spread);
  const upper = Math.min(1, center + spread);
  const marginOfError = spread;

  return {
    rate: p,
    lower,
    upper,
    marginOfError,
  };
}

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

  const configs: ReplayConfiguration[] = [
    'current_extraction',
    'current_strict_images',
    'structured_only',
    'hybrid_identity_first',
  ];

  const byConfiguration: Record<ReplayConfiguration, ConfigurationCostMetrics> = {} as any;

  // Base overhead for domain profile maintenance (default 15 mins for CSS selector drift)
  const baseMins = options.baseOperatorMinutes ?? 15.0;

  for (const cfg of configs) {
    const cfgRows = scopeRows.filter(r => r.configuration === cfg);
    const n = cfgRows.length || 1;

    // Latency: read recorded latencyMs or supply deterministic benchmark default
    const latencies = cfgRows.map(r => {
      if (typeof r.latencyMs === 'number' && !isNaN(r.latencyMs)) return r.latencyMs;
      // Default deterministic estimates per configuration
      switch (cfg) {
        case 'current_extraction': return 120.0;
        case 'current_strict_images': return 135.0;
        case 'structured_only': return 95.0;
        case 'hybrid_identity_first': return 150.0;
      }
    });

    const totalLatency = latencies.reduce((a, b) => a + b, 0);
    const meanLatency = Math.round((totalLatency / n) * 10) / 10;
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p95Idx = Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95));
    const p95Latency = Math.round(sortedLatencies[p95Idx] * 10) / 10;

    // Requests: read recorded requestCount or 1.0 per sample
    const reqCounts = cfgRows.map(r => (typeof r.requestCount === 'number' ? r.requestCount : 1));
    const totalRequests = reqCounts.reduce((a, b) => a + b, 0) ?? sampleCount;
    const requestsPerSample = Math.round((totalRequests / Math.max(1, sampleCount)) * 10) / 10;

    // Operator Maintenance Minutes:
    // Modeled from maintenance overhead, selector repair time, defect rate, and conflict triage
    let operatorMins: number;
    if (domain && options.operatorMinutesOverride?.[domain]?.[cfg] !== undefined) {
      operatorMins = options.operatorMinutesOverride[domain][cfg];
    } else {
      switch (cfg) {
        case 'current_extraction': {
          // Selector-led: high base maintenance for selector drift + repair time for defects
          const defects = cfgRows.filter(
            r => r.identityVerdict !== 'correct_match' || r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD'),
          ).length;
          operatorMins = Math.round((baseMins + defects * 3.0) * 10) / 10;
          break;
        }
        case 'current_strict_images': {
          const defects = cfgRows.filter(
            r => r.identityVerdict !== 'correct_match' || r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD'),
          ).length;
          operatorMins = Math.round((baseMins * 0.8 + defects * 2.5) * 10) / 10;
          break;
        }
        case 'structured_only': {
          // Zero selector maintenance, but high missing-field review
          const missingCount = cfgRows.filter(r => r.failureCodes.some(c => c === 'MISSING_AVAILABLE_FIELD')).length;
          operatorMins = Math.round((3.0 + missingCount * 1.0) * 10) / 10;
          break;
        }
        case 'hybrid_identity_first': {
          // Bounded maintenance: structured data first, conflict triage only
          const conflictsCount = cfgRows.reduce((acc, r) => acc + (r.conflicts?.length || 0), 0);
          const identityErrors = cfgRows.filter(r => r.identityVerdict !== 'correct_match').length;
          const unresolved = cfgRows.filter(
            r => r.identityResolution?.status === 'no_variant_match' || r.identityResolution?.status === 'ambiguous_variant',
          ).length;
          // Base triage (2 mins) + 2 mins per conflict + 3 mins per unresolved variant + 5 mins per identity error
          operatorMins = Math.round((2.0 + conflictsCount * 2.0 + unresolved * 3.0 + identityErrors * 5.0) * 10) / 10;
          break;
        }
      }
    }

    byConfiguration[cfg] = {
      configuration: cfg,
      meanLatencyMs: meanLatency,
      p95LatencyMs: p95Latency,
      totalLatencyMs: totalLatency,
      totalRequests,
      requestsPerSample,
      operatorMinutes: operatorMins,
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

  // Bounded maintenance requirement: hybrid maintenance cost must be <= baseline
  const isMaintenanceBounded = hybridOperatorMinutes <= baselineOperatorMinutes;

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
  const fcPassed = input.hybridMeanFieldCorrectness >= input.baselineMeanFieldCorrectness - 1e-9;
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
    reason: fcPassed
      ? `✓ Maintained or improved field completeness (${(input.hybridMeanFieldCorrectness * 100).toFixed(1)}%)`
      : `Blocked: Mean field correctness regressed below baseline (${(input.hybridMeanFieldCorrectness * 100).toFixed(1)}% vs ${(input.baselineMeanFieldCorrectness * 100).toFixed(1)}%)`,
  });

  // 4. Image Precision: Match or exceed baseline precision
  const ipPassed = input.hybridMeanImagePrecision >= input.baselineMeanImagePrecision - 1e-9;
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
    reason: ipPassed
      ? `✓ Improved image precision (${(input.hybridMeanImagePrecision * 100).toFixed(1)}% vs ${(input.baselineMeanImagePrecision * 100).toFixed(1)}% baseline)`
      : `Blocked: Mean image precision regressed below baseline (${(input.hybridMeanImagePrecision * 100).toFixed(1)}% vs ${(input.baselineMeanImagePrecision * 100).toFixed(1)}%)`,
  });

  // 5. Image Recall: Bounded drop allowed (e.g. dedupe of thumbnails/icons), minimum 90% of baseline
  const recallThreshold = Math.max(0, input.baselineMeanImageRecall * 0.9);
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
  const paPassed = input.hybridPrimaryAccuracy >= input.baselinePrimaryAccuracy - 1e-9;
  checks.push({
    name: 'Primary Image Accuracy',
    dimension: 'primary_image_accuracy',
    baselineValue: input.baselinePrimaryAccuracy,
    thresholdValue: input.baselinePrimaryAccuracy,
    actualValue: input.hybridPrimaryAccuracy,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: paPassed,
    reason: paPassed
      ? `✓ Primary image accuracy (${(input.hybridPrimaryAccuracy * 100).toFixed(1)}%) met or exceeded baseline threshold (${(input.baselinePrimaryAccuracy * 100).toFixed(1)}%)`
      : `Blocked: Primary image accuracy (${(input.hybridPrimaryAccuracy * 100).toFixed(1)}%) regressed below baseline threshold (${(input.baselinePrimaryAccuracy * 100).toFixed(1)}%)`,
  });

  // 7. Served Rate: Match or exceed baseline served rate
  const srPassed = input.hybridServedRate >= input.baselineServedRate - 1e-9;
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
    reason: srPassed
      ? `✓ Served rate (${(input.hybridServedRate * 100).toFixed(1)}%) met or exceeded baseline threshold (${(input.baselineServedRate * 100).toFixed(1)}%)`
      : `Blocked: Hybrid served rate regressed below baseline (${(input.hybridServedRate * 100).toFixed(1)}% vs ${(input.baselineServedRate * 100).toFixed(1)}%)`,
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
  const minSamples = options.minSamplesForPromote ?? 3;
  let z = 1.96;
  if (options.targetConfidence !== undefined) {
    if (options.targetConfidence > 1) {
      z = options.targetConfidence;
    } else if (options.targetConfidence >= 0.99) {
      z = 2.576;
    } else if (options.targetConfidence >= 0.95) {
      z = 1.96;
    } else if (options.targetConfidence >= 0.90) {
      z = 1.645;
    } else if (options.targetConfidence >= 0.80) {
      z = 1.282;
    }
  }

  const sampleCount = samples.length;
  const sampleIdSet = new Set(samples.map(s => s.sampleId));

  const baselineRows = rows.filter(r => sampleIdSet.has(r.sampleId) && r.configuration === 'current_extraction');
  const hybridRows = rows.filter(r => sampleIdSet.has(r.sampleId) && r.configuration === 'hybrid_identity_first');

  // Helper: check if a sample is served (correct identity, not an evidence gap, all critical fields correct)
  const isSampleServed = (r: AuditScoredRow, sample: AuditManifestSample): boolean => {
    if (r.identityVerdict !== 'correct_match' || r.isEvidenceGap) return false;
    for (const field of CRITICAL_FIELDS) {
      const spec = sample.groundTruth.fields[field];
      if (spec?.available && !spec.inapplicable) {
        const fScore = r.fieldScores[field];
        if (!fScore || !fScore.correct) return false;
      }
    }
    return true;
  };

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
    baselineServedRate,
    hybridServedRate: hybridServedStats.rate,
    hybridServedRateUncertainty: hybridServedStats.marginOfError,
    baselineEvidenceGaps,
    hybridEvidenceGaps,
    baselineOperatorMinutes: costMetrics.baselineOperatorMinutes,
    hybridOperatorMinutes: costMetrics.hybridOperatorMinutes,
  });

  const allThresholdsPassed = thresholds.every(t => t.passed);

  // Verdict Determination
  let verdict: ContractPromotionVerdict;
  let isPromotable: boolean;
  let promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
  const promotabilityReasons: string[] = [];

  const isSufficientSample = sampleCount >= minSamples;

  if (!allThresholdsPassed || abstentionGaming.gamingDetected) {
    verdict = 'NO_GO';
    promotabilityVerdict = 'BLOCKED';
    isPromotable = false;

    // Collate blocking reasons
    for (const t of thresholds) {
      if (!t.passed) promotabilityReasons.push(t.reason);
    }
    for (const r of abstentionGaming.reasons) {
      if (!promotabilityReasons.includes(r)) promotabilityReasons.push(`Blocked: ${r}`);
    }
  } else if (!isSufficientSample) {
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    promotabilityReasons.push(
      `Needs Review: Sample count (${sampleCount}) is below standard gate threshold (minimum ${minSamples} required) to prove superiority within confidence margin`,
    );
  } else {
    verdict = 'GO';
    promotabilityVerdict = 'PROMOTABLE';
    isPromotable = true;
    promotabilityReasons.push('✓ Zero observed identity errors (100% correct identity match)');
    promotabilityReasons.push('✓ Zero critical-field regressions on title, brand, or price');
    promotabilityReasons.push(`✓ Improved image precision (${(hybridPrecisionStats.mean * 100).toFixed(1)}% vs ${(baselineMeanImagePrecision * 100).toFixed(1)}% baseline)`);
    promotabilityReasons.push(`✓ Maintained or improved field completeness (${(hybridFieldStats.mean * 100).toFixed(1)}%)`);
    promotabilityReasons.push('✓ Zero evidence-gap inflation / no abstention gaming');
    promotabilityReasons.push(`✓ Bounded maintenance: ${costMetrics.hybridOperatorMinutes.toFixed(1)} mins vs ${costMetrics.baselineOperatorMinutes.toFixed(1)} mins baseline`);
  }

  // Metric Uncertainties
  const servedRate = buildPromotionUncertainty('servedRate', hybridServedStats, 'wilson_score');
  const identityAccuracy = buildPromotionUncertainty('identityAccuracy', identityStats, 'wilson_score');
  const fieldCorrectness = buildPromotionUncertainty('fieldCorrectness', hybridFieldStats, 'standard_error');
  const imagePrecision = buildPromotionUncertainty('imagePrecision', hybridPrecisionStats, 'standard_error');
  const imageRecall = buildPromotionUncertainty('imageRecall', hybridRecallStats, 'standard_error');
  const primaryImageAccuracy = buildPromotionUncertainty('primaryImageAccuracy', hybridPrimaryStats, 'wilson_score');

  return {
    scope,
    domain,
    platform,
    sampleCount,
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
  domainCostMetrics: DomainCostMetrics;
  overallContractVerdict: ContractPromotionVerdict;
}

export function evaluateGateArithmetic(
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: GateArithmeticOptions = {},
): FullGateArithmeticResult {
  const domain = samples[0]?.domain || 'unknown';
  const scopeKeys = Array.from(new Set(samples.map(s => s.pageStructureScope || 'standard_pdp')));

  const verdictsByScope: Record<string, ScopePromotionVerdict> = {};

  for (const sk of scopeKeys) {
    const scopeSamples = samples.filter(s => (s.pageStructureScope || 'standard_pdp') === sk);
    verdictsByScope[sk] = evaluateScopeGate(sk, scopeSamples, rows, options);
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
    domainCostMetrics,
    overallContractVerdict,
  };
}
