/**
 * Evidence-Chosen Adapter Strategy Report Generator (Issue #192 / Audit Follow-Through T8)
 *
 * Chooses between proven platform and structure handling with small CSS exceptions
 * versus selector-led coverage per scope from measured evidence and baseline numbers
 * with uncertainty, never by fiat.
 *
 * Inputs:
 * 1. Versioned labeled corpus verdicts (#190): ground-truth, scored rows, gate arithmetic.
 * 2. Workspace flow measurements (#191): time to first working profile, manual corrections,
 *    sibling-page pass rate, wrong product/image counts, operator minutes with provenance.
 */

import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
  ContractPromotionVerdict,
  GateThresholdCheck,
  PerScopeAdapterStrategyReport,
  PerScopePromotionReport,
  ScopePromotionVerdict,
  ScopeStrategyComparison,
  StrategyMetricsComparison,
  StrategyRecommendation,
} from '../../shared/schemas/profile-audit';
import type { GateArithmeticOptions } from './types';
import { evaluateGateArithmetic } from './gate-arithmetic';
import {
  computeWilsonScoreInterval,
  sanitizeCell,
  MIN_SAMPLES_FOR_PROMOTE_DEFAULT,
} from './shared-metrics';
import type { OutputFirstInspectionResult, SiblingValidationResult } from '../profile-workspace/output-first-service';

export interface WorkspaceFlowScopeInput {
  timeToFirstWorkingProfileMs?: number;
  timeToFirstWorkingProfileProvenance?: 'measured' | 'modeled';
  manualCorrectionsPerProfile?: number;
  manualCorrectionsProvenance?: 'measured' | 'modeled';
  /** Measured selector-led effort baselines (review finding 4). Without these,
   * selector-side time/corrections stay modeled estimates and are display-only. */
  selectorTimeToFirstWorkingProfileMs?: number;
  selectorTimeToFirstWorkingProfileProvenance?: 'measured' | 'modeled';
  selectorManualCorrectionsPerProfile?: number;
  selectorManualCorrectionsProvenance?: 'measured' | 'modeled';
  siblingPassRate?: number;
  siblingPassRateUncertainty?: number;
  siblingPassRateConfidenceInterval?: { lower: number; upper: number };
  siblingPassRateProvenance?: 'measured' | 'modeled';
  wrongProductCount?: number;
  wrongImageCount?: number;
  exceptionsCount?: number;
  inspections?: OutputFirstInspectionResult[];
  siblingValidation?: SiblingValidationResult;
}

export interface StrategyReportOptions extends GateArithmeticOptions {
  workspaceFlows?: Record<string, WorkspaceFlowScopeInput>;
  defaultSelectorSetupMs?: number;
  defaultAdapterSetupMs?: number;
  defaultSelectorManualCorrections?: number;
  defaultAdapterManualCorrections?: number;
}

export function formatStrategyRecommendationBadge(rec: StrategyRecommendation): string {
  switch (rec) {
    case 'adapter_with_css_exceptions':
      return '✅ **ADAPTER (STRUCTURE + CSS EXCEPTIONS)**';
    case 'custom_selectors':
      return '🔧 **SELECTOR-LED (CUSTOM SELECTORS)**';
    case 'needs_review':
      return '⚠️ **NEEDS REVIEW**';
  }
}

/**
 * Derives strategy threshold checks strictly from baseline numbers with uncertainty.
 */
export function deriveStrategyThresholds(input: {
  selectorMetrics: StrategyMetricsComparison;
  adapterMetrics: StrategyMetricsComparison;
  gateVerdict?: ContractPromotionVerdict;
  allGateThresholdsPassed: boolean;
  isReviewed: boolean;
  groundTruthSource: string;
  usableObservations: number;
  minSamples: number;
  hasSufficientEvidence: boolean;
  missingEvidenceDimensions: string[];
}): {
  thresholds: GateThresholdCheck[];
  allPassed: boolean;
  recommendation: StrategyRecommendation;
  rationale: string[];
} {
  const checks: GateThresholdCheck[] = [];
  const rationale: string[] = [];

  const {
    selectorMetrics,
    adapterMetrics,
    gateVerdict,
    allGateThresholdsPassed,
    isReviewed,
    groundTruthSource,
    usableObservations,
    minSamples,
    hasSufficientEvidence,
    missingEvidenceDimensions,
  } = input;

  // 1. Reviewed Label Provenance (Gate Hard Invariant)
  const isProvValid = isReviewed && groundTruthSource === 'independent';
  checks.push({
    name: 'Reviewed Independent Label Provenance',
    dimension: 'label_provenance',
    baselineValue: 1,
    thresholdValue: 1,
    actualValue: isProvValid ? 1 : 0,
    unit: 'bool',
    rule: 'actual == 1',
    passed: isProvValid,
    reason: isProvValid
      ? '✓ Ground truth labels are independent and reviewed'
      : 'Blocked: Labels are unreviewed or auto-derived; strategy choice requires reviewed independent ground truth',
  });

  // 2. Usable Scored Observations Count
  const samplePassed = usableObservations >= minSamples;
  checks.push({
    name: 'Sufficient Usable Observations',
    dimension: 'sample_size',
    baselineValue: minSamples,
    thresholdValue: minSamples,
    actualValue: usableObservations,
    unit: 'samples',
    rule: 'actual >= threshold',
    passed: samplePassed,
    reason: samplePassed
      ? `✓ Scored observation count (${usableObservations}) satisfies minimum threshold (${minSamples})`
      : `Blocked: Only ${usableObservations} usable observations (minimum ${minSamples} required)`,
  });

  // 2b. Strategy Evidence Sufficiency (Issue #192 / T8). Modeled fallbacks
  // are displayed with 'modeled' provenance but cannot decide: without
  // measured or gate-derived evidence the comparison would reproduce fiat.
  const evidencePassed = hasSufficientEvidence;
  checks.push({
    name: 'Sufficient Strategy Evidence',
    dimension: 'strategy_evidence',
    baselineValue: 0,
    thresholdValue: 0,
    actualValue: evidencePassed ? 0 : missingEvidenceDimensions.length,
    unit: 'missing dimensions',
    rule: 'actual == 0',
    passed: evidencePassed,
    reason: evidencePassed
      ? '✓ Strategy dimensions grounded in measured or gate-derived evidence'
      : `Blocked: Strategy evidence incomplete (${missingEvidenceDimensions.join(', ')} unmeasured and underived); modeled fallbacks cannot decide — record workspace measurements or attach a gate verdict`,
  });

  // 3. Identity Integrity / Wrong Product Count
  const wrongProductPassed = adapterMetrics.wrongProductCount === 0;
  checks.push({
    name: 'Zero Wrong-Product Errors',
    dimension: 'wrong_product',
    baselineValue: selectorMetrics.wrongProductCount,
    thresholdValue: 0,
    actualValue: adapterMetrics.wrongProductCount,
    unit: 'errors',
    rule: 'actual <= 0',
    passed: wrongProductPassed,
    reason: wrongProductPassed
      ? '✓ Zero wrong-product errors under adapter extraction'
      : `Blocked: ${adapterMetrics.wrongProductCount} wrong-product errors detected under adapter`,
  });

  // 4. Wrong Image Error Count (Bounded by baseline)
  const wrongImagePassed = adapterMetrics.wrongImageCount <= selectorMetrics.wrongImageCount;
  checks.push({
    name: 'Bounded Wrong-Image Errors',
    dimension: 'wrong_image',
    baselineValue: selectorMetrics.wrongImageCount,
    thresholdValue: selectorMetrics.wrongImageCount,
    actualValue: adapterMetrics.wrongImageCount,
    unit: 'errors',
    rule: 'actual <= threshold',
    passed: wrongImagePassed,
    reason: wrongImagePassed
      ? `✓ Wrong-image defects (${adapterMetrics.wrongImageCount}) within baseline bound (${selectorMetrics.wrongImageCount})`
      : `Blocked: Wrong-image defects (${adapterMetrics.wrongImageCount}) exceeded baseline (${selectorMetrics.wrongImageCount})`,
  });

  // 5. Sibling-Page Pass Rate (Match or exceed the measured baseline with
  // uncertainty — derived from baseline numbers only, never a fiat floor.)
  const baselineSiblingPass = selectorMetrics.siblingPassRate;
  const derivedSiblingThreshold = baselineSiblingPass;
  const siblingPassed = adapterMetrics.siblingPassRate >= derivedSiblingThreshold - 1e-9;
  checks.push({
    name: 'Sibling-Page Pass Rate',
    dimension: 'sibling_pass_rate',
    baselineValue: baselineSiblingPass,
    thresholdValue: derivedSiblingThreshold,
    actualValue: adapterMetrics.siblingPassRate,
    actualUncertainty: adapterMetrics.siblingPassRateUncertainty,
    unit: 'rate',
    rule: 'actual >= threshold',
    passed: siblingPassed,
    reason: siblingPassed
      ? `✓ Sibling-page pass rate (${(adapterMetrics.siblingPassRate * 100).toFixed(1)}% ±${(adapterMetrics.siblingPassRateUncertainty * 100).toFixed(1)}%) met or exceeded derived target (${(derivedSiblingThreshold * 100).toFixed(1)}%)`
      : `Blocked: Sibling-page pass rate (${(adapterMetrics.siblingPassRate * 100).toFixed(1)}%) regressed below derived target (${(derivedSiblingThreshold * 100).toFixed(1)}%)`,
  });

  // 6. Manual Corrections Per Profile — decision-driving only with a measured
  // selector baseline (review finding 4); a modeled baseline is display-only.
  const correctionsDecisionDriving = selectorMetrics.manualCorrectionsProvenance === 'measured';
  const manualPassed = adapterMetrics.manualCorrectionsPerProfile <= selectorMetrics.manualCorrectionsPerProfile;
  checks.push({
    name: 'Bounded Manual Corrections Per Profile',
    dimension: 'manual_corrections',
    baselineValue: selectorMetrics.manualCorrectionsPerProfile,
    thresholdValue: selectorMetrics.manualCorrectionsPerProfile,
    actualValue: adapterMetrics.manualCorrectionsPerProfile,
    unit: 'corrections',
    rule: correctionsDecisionDriving ? 'actual <= threshold' : 'display-only (selector baseline unmeasured)',
    passed: correctionsDecisionDriving ? manualPassed : true,
    reason: correctionsDecisionDriving
      ? (manualPassed
        ? `✓ Manual corrections per profile (${adapterMetrics.manualCorrectionsPerProfile}) bounded by measured selector baseline (${selectorMetrics.manualCorrectionsPerProfile})`
        : `Blocked: Manual corrections per profile (${adapterMetrics.manualCorrectionsPerProfile}) exceeded measured selector baseline (${selectorMetrics.manualCorrectionsPerProfile})`)
      : `ℹ Manual corrections per profile (${adapterMetrics.manualCorrectionsPerProfile} vs ${selectorMetrics.manualCorrectionsPerProfile} modeled selector baseline) shown for context — unmeasured selector baselines are display-only and excluded from the promotion decision`,
  });
  if (!correctionsDecisionDriving) {
    rationale.push('Manual-corrections comparison is display-only: record a measured selector baseline to make it decision-driving.');
  }

  // 7. Time to First Working Profile — decision-driving only with a measured
  // selector baseline (review finding 4); a modeled baseline is display-only.
  const timeDecisionDriving = selectorMetrics.timeToFirstWorkingProfileProvenance === 'measured';
  const timePassed = adapterMetrics.timeToFirstWorkingProfileMs <= selectorMetrics.timeToFirstWorkingProfileMs;
  checks.push({
    name: 'Time to First Working Profile',
    dimension: 'time_to_first_profile',
    baselineValue: selectorMetrics.timeToFirstWorkingProfileMs,
    thresholdValue: selectorMetrics.timeToFirstWorkingProfileMs,
    actualValue: adapterMetrics.timeToFirstWorkingProfileMs,
    unit: 'ms',
    rule: timeDecisionDriving ? 'actual <= threshold' : 'display-only (selector baseline unmeasured)',
    passed: timeDecisionDriving ? timePassed : true,
    reason: timeDecisionDriving
      ? (timePassed
        ? `✓ Time to first working profile (${(adapterMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s) faster than or equal to measured selector setup (${(selectorMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s)`
        : `Blocked: Time to first working profile (${(adapterMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s) slower than measured selector setup (${(selectorMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s)`)
      : `ℹ Time to first working profile (${(adapterMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s vs ${(selectorMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(1)}s modeled selector baseline) shown for context — unmeasured selector baselines are display-only and excluded from the promotion decision`,
  });
  if (!timeDecisionDriving) {
    rationale.push('Time-to-first-profile comparison is display-only: record a measured selector baseline to make it decision-driving.');
  }

  // 8. Bounded Operator Maintenance Minutes
  const minsPassed = adapterMetrics.operatorMinutes <= selectorMetrics.operatorMinutes;
  checks.push({
    name: 'Bounded Operator Maintenance Minutes',
    dimension: 'operator_minutes',
    baselineValue: selectorMetrics.operatorMinutes,
    thresholdValue: selectorMetrics.operatorMinutes,
    actualValue: adapterMetrics.operatorMinutes,
    unit: 'minutes',
    rule: 'actual <= threshold',
    passed: minsPassed,
    reason: minsPassed
      ? `✓ Operator maintenance (${adapterMetrics.operatorMinutes.toFixed(1)}m) satisfies bounded requirement vs selector baseline (${selectorMetrics.operatorMinutes.toFixed(1)}m)`
      : `Blocked: Operator maintenance (${adapterMetrics.operatorMinutes.toFixed(1)}m) exceeds selector baseline (${selectorMetrics.operatorMinutes.toFixed(1)}m)`,
  });

  // 9. Promotion Gate Verdict Compatibility
  const gatePassed = gateVerdict === 'GO' || allGateThresholdsPassed;
  checks.push({
    name: 'Audit Gate Arithmetic Verdict',
    dimension: 'promotion_gate',
    baselineValue: 0,
    thresholdValue: 0,
    actualValue: gatePassed ? 0 : 1,
    unit: 'verdict',
    rule: 'actual == 0',
    passed: gatePassed,
    reason: gatePassed
      ? '✓ All underlying promotion gate thresholds passed'
      : `Blocked: Promotion gate verdict is ${gateVerdict ?? 'NO_GO'}`,
  });

  const allPassed = checks.every(c => c.passed);

  // Derive Recommendation
  let recommendation: StrategyRecommendation;
  if (!isProvValid) {
    recommendation = 'needs_review';
    rationale.push('Labels are unreviewed or auto-derived; an evidence-backed recommendation requires independent reviewed ground truth.');
  } else if (!samplePassed) {
    recommendation = 'needs_review';
    rationale.push(`Sample size (${usableObservations}) is below the required minimum (${minSamples}) for statistical confidence.`);
  } else if (!hasSufficientEvidence) {
    recommendation = 'needs_review';
    rationale.push(`Strategy evidence incomplete (${missingEvidenceDimensions.join(', ')} unmeasured and underived); modeled fallbacks are display-only — record workspace measurements or attach a gate verdict before a strategy can be recommended.`);
  } else if (allPassed) {
    recommendation = 'adapter_with_css_exceptions';
    rationale.push('Proven platform and structure handling with small CSS exceptions outperforms custom selectors across all metrics.');
    rationale.push(`Sibling pass rate of ${(adapterMetrics.siblingPassRate * 100).toFixed(1)}% (±${(adapterMetrics.siblingPassRateUncertainty * 100).toFixed(1)}%) confirms robust generalization across variants.`);
    rationale.push(`Zero wrong-product identity errors and ${adapterMetrics.wrongImageCount} wrong-image defects vs ${selectorMetrics.wrongProductCount} and ${selectorMetrics.wrongImageCount} in baseline.`);
    const savedMins = Math.round((selectorMetrics.operatorMinutes - adapterMetrics.operatorMinutes) * 10) / 10;
    rationale.push(`Saves ${savedMins.toFixed(1)} operator minutes/domain (${adapterMetrics.operatorMinutes.toFixed(1)}m vs ${selectorMetrics.operatorMinutes.toFixed(1)}m).`);
  } else if (
    selectorMetrics.wrongProductCount === 0 &&
    selectorMetrics.siblingPassRate >= 0.5 &&
    (!gatePassed || !wrongProductPassed || !siblingPassed)
  ) {
    recommendation = 'custom_selectors';
    rationale.push('Platform/structured data regressed or failed critical identity/generalization checks on this scope, while custom selectors achieve verified coverage.');
  } else {
    recommendation = 'needs_review';
    rationale.push('Neither strategy cleanly passed all derived baseline threshold checks; operator inspection of exception queue and sibling validation is required.');
  }

  return {
    thresholds: checks,
    allPassed,
    recommendation,
    rationale,
  };
}

/**
 * Evaluates strategy recommendation for a single page-structure scope.
 */
export function evaluateScopeStrategyComparison(args: {
  scope: string;
  domain: string;
  platform?: string;
  labelVersion: string;
  samples: AuditManifestSample[];
  rows: AuditScoredRow[];
  gateVerdict?: ScopePromotionVerdict;
  workspaceFlow?: WorkspaceFlowScopeInput;
  options?: StrategyReportOptions;
}): ScopeStrategyComparison {
  const {
    scope,
    domain,
    platform = 'generic',
    labelVersion,
    samples,
    rows,
    gateVerdict,
    workspaceFlow,
    options = {},
  } = args;

  const minSamples = options.minSamplesForPromote ?? MIN_SAMPLES_FOR_PROMOTE_DEFAULT;
  const scopeSamples = samples.filter(s => (s.pageStructureScope || 'standard_pdp') === scope);
  const sampleCount = scopeSamples.length;

  // Filter rows for this scope
  const scopeSampleIds = new Set(scopeSamples.map(s => s.sampleId));
  const scopeRows = rows.filter(r => scopeSampleIds.has(r.sampleId));

  const baselineRows = scopeRows.filter(r => r.configuration === 'current_extraction');
  const hybridRows = scopeRows.filter(r => r.configuration === 'hybrid_identity_first');

  // Ground truth source & reviewed check
  const isReviewed = scopeSamples.length > 0 && scopeSamples.every(s => s.isReviewed ?? false);
  const hasAutoDerived = scopeSamples.some(s => s.groundTruthSource === 'auto-derived');
  const groundTruthSource = hasAutoDerived ? 'auto-derived' : 'independent';

  // Usable observation count
  const usableObservationCount = gateVerdict?.usableObservationCount ??
    scopeSamples.filter(s => !scopeRows.filter(r => r.sampleId === s.sampleId).some(r => r.isEvidenceGap)).length;

  // Evidence sufficiency (Issue #192 / T8): each strategy dimension needs a
  // measured or gate-derived value; otherwise the modeled fallbacks below are
  // display-only and the recommendation stays needs_review.
  const missingEvidenceDimensions: string[] = [];
  if (!workspaceFlow?.siblingValidation && workspaceFlow?.siblingPassRate === undefined && !gateVerdict) {
    missingEvidenceDimensions.push('sibling-page pass rate');
  }
  if (workspaceFlow?.timeToFirstWorkingProfileMs === undefined && !(workspaceFlow?.inspections && workspaceFlow.inspections.length > 0)) {
    missingEvidenceDimensions.push('time to first working profile');
  }
  if (workspaceFlow?.manualCorrectionsPerProfile === undefined && !(workspaceFlow?.inspections && workspaceFlow.inspections.length > 0)) {
    missingEvidenceDimensions.push('manual corrections per profile');
  }
  if (!gateVerdict) {
    missingEvidenceDimensions.push('gate-derived operator maintenance');
  }
  const hasSufficientEvidence = missingEvidenceDimensions.length === 0;

  // 1. Wrong product and wrong image counts from rows
  const baselineWrongProduct = baselineRows.filter(r => r.identityVerdict !== 'correct_match').length;
  const hybridWrongProduct = hybridRows.filter(r => r.identityVerdict !== 'correct_match').length;

  const baselineWrongImage = baselineRows.filter(
    r => r.imageScores.primaryAccuracy === 0 || r.failureCodes.includes('LOW_IMAGE_PRECISION') || r.failureCodes.includes('PRIMARY_IMAGE_MISMATCH'),
  ).length;
  const hybridWrongImage = hybridRows.filter(
    r => r.imageScores.primaryAccuracy === 0 || r.failureCodes.includes('LOW_IMAGE_PRECISION') || r.failureCodes.includes('PRIMARY_IMAGE_MISMATCH'),
  ).length;

  // 2. Sibling Pass Rate
  let adapterSiblingPass = 0.95;
  let adapterSiblingUncertainty = 0.05;
  let adapterSiblingCI = { lower: 0.85, upper: 0.99 };
  let adapterSiblingProv: 'measured' | 'modeled' = 'modeled';

  let selectorSiblingPass = 0.50;
  let selectorSiblingUncertainty = 0.15;
  let selectorSiblingCI = { lower: 0.30, upper: 0.70 };
  const selectorSiblingProv: 'measured' | 'modeled' = 'modeled';

  if (workspaceFlow?.siblingValidation) {
    const sv = workspaceFlow.siblingValidation;
    adapterSiblingPass = sv.passRate;
    const interval = computeWilsonScoreInterval(sv.passedCount, sv.totalSiblings);
    adapterSiblingUncertainty = interval.marginOfError;
    adapterSiblingCI = { lower: interval.lower, upper: interval.upper };
    adapterSiblingProv = 'measured';
  } else if (workspaceFlow?.siblingPassRate !== undefined) {
    adapterSiblingPass = workspaceFlow.siblingPassRate;
    adapterSiblingUncertainty = workspaceFlow.siblingPassRateUncertainty ?? 0.05;
    adapterSiblingCI = workspaceFlow.siblingPassRateConfidenceInterval ?? {
      lower: Math.max(0, adapterSiblingPass - adapterSiblingUncertainty),
      upper: Math.min(1, adapterSiblingPass + adapterSiblingUncertainty),
    };
    adapterSiblingProv = workspaceFlow.siblingPassRateProvenance ?? 'measured';
  } else if (gateVerdict) {
    // Grounded in gate arithmetic served rate
    adapterSiblingPass = gateVerdict.servedRate.value;
    adapterSiblingUncertainty = gateVerdict.servedRate.uncertainty;
    adapterSiblingCI = gateVerdict.servedRate.confidenceInterval;
    adapterSiblingProv = 'modeled';

    selectorSiblingPass = gateVerdict.baselineServedRate;
    const baseInterval = computeWilsonScoreInterval(
      Math.round(gateVerdict.baselineServedRate * sampleCount),
      sampleCount,
    );
    selectorSiblingUncertainty = baseInterval.marginOfError;
    selectorSiblingCI = { lower: baseInterval.lower, upper: baseInterval.upper };
  }

  // 3. Time to First Working Profile
  const defaultSelectorTime = options.defaultSelectorSetupMs ?? 900000; // 15 minutes modeled
  const defaultAdapterTime = options.defaultAdapterSetupMs ?? 90000; // 1.5 minutes modeled

  let adapterTimeMs = defaultAdapterTime;
  let adapterTimeProv: 'measured' | 'modeled' = 'modeled';

  const selectorTimeMs = defaultSelectorTime;
  const selectorTimeProv: 'measured' | 'modeled' = 'modeled';

  if (workspaceFlow?.timeToFirstWorkingProfileMs !== undefined) {
    adapterTimeMs = workspaceFlow.timeToFirstWorkingProfileMs;
    adapterTimeProv = workspaceFlow.timeToFirstWorkingProfileProvenance ?? 'measured';
  } else if (workspaceFlow?.inspections && workspaceFlow.inspections.length > 0) {
    adapterTimeMs = workspaceFlow.inspections[0].metrics.timeToFirstWorkingProfileMs;
    adapterTimeProv = 'measured';
  }

  // 4. Manual Corrections Per Profile
  const defaultSelectorCorrections = options.defaultSelectorManualCorrections ?? 5; // 5 selector rules modeled
  const defaultAdapterCorrections = options.defaultAdapterManualCorrections ?? 1; // 1 small CSS exception modeled

  let adapterCorrections = defaultAdapterCorrections;
  let adapterCorrectionsProv: 'measured' | 'modeled' = 'modeled';

  const selectorCorrections = defaultSelectorCorrections;
  const selectorCorrectionsProv: 'measured' | 'modeled' = 'modeled';

  if (workspaceFlow?.manualCorrectionsPerProfile !== undefined) {
    adapterCorrections = workspaceFlow.manualCorrectionsPerProfile;
    adapterCorrectionsProv = workspaceFlow.manualCorrectionsProvenance ?? 'measured';
  } else if (workspaceFlow?.inspections && workspaceFlow.inspections.length > 0) {
    adapterCorrections = workspaceFlow.inspections.reduce(
      (acc, ins) => acc + ins.metrics.manualCorrectionsCount,
      0,
    ) / workspaceFlow.inspections.length;
    adapterCorrectionsProv = 'measured';
  }

  // 5. Operator Maintenance Minutes
  let selectorOperatorMinutes = 15.0;
  let selectorOperatorProv: 'measured' | 'modeled' | 'mixed' = 'modeled';

  let adapterOperatorMinutes = 2.0;
  let adapterOperatorProv: 'measured' | 'modeled' | 'mixed' = 'modeled';

  if (gateVerdict) {
    selectorOperatorMinutes = gateVerdict.costMetrics.baselineOperatorMinutes;
    selectorOperatorProv =
      gateVerdict.costMetrics.byConfiguration?.current_extraction?.operatorMinutesProvenance ??
      gateVerdict.costMetrics.operatorMinutesProvenance ??
      'modeled';

    adapterOperatorMinutes = gateVerdict.costMetrics.hybridOperatorMinutes;
    adapterOperatorProv =
      gateVerdict.costMetrics.byConfiguration?.hybrid_identity_first?.operatorMinutesProvenance ??
      gateVerdict.costMetrics.operatorMinutesProvenance ??
      'modeled';
  }

  // Assemble Strategy Metrics
  // Measured selector baselines (review finding 4): operator-recorded
  // selector effort replaces the modeled estimates when present; otherwise
  // the modeled values stay display-only (see the checks below).
  const hasMeasuredSelectorTime = workspaceFlow?.selectorTimeToFirstWorkingProfileMs !== undefined;
  const hasMeasuredSelectorCorrections = workspaceFlow?.selectorManualCorrectionsPerProfile !== undefined;
  const selectorMetrics: StrategyMetricsComparison = {
    timeToFirstWorkingProfileMs: workspaceFlow?.selectorTimeToFirstWorkingProfileMs ?? selectorTimeMs,
    timeToFirstWorkingProfileProvenance: hasMeasuredSelectorTime
      ? (workspaceFlow?.selectorTimeToFirstWorkingProfileProvenance ?? 'measured')
      : selectorTimeProv,
    manualCorrectionsPerProfile: workspaceFlow?.selectorManualCorrectionsPerProfile ?? selectorCorrections,
    manualCorrectionsProvenance: hasMeasuredSelectorCorrections
      ? (workspaceFlow?.selectorManualCorrectionsProvenance ?? 'measured')
      : selectorCorrectionsProv,
    siblingPassRate: selectorSiblingPass,
    siblingPassRateUncertainty: selectorSiblingUncertainty,
    siblingPassRateConfidenceInterval: selectorSiblingCI,
    siblingPassRateProvenance: selectorSiblingProv,
    wrongProductCount: baselineWrongProduct,
    wrongImageCount: baselineWrongImage,
    operatorMinutes: selectorOperatorMinutes,
    operatorMinutesProvenance: selectorOperatorProv,
  };

  const adapterMetrics: StrategyMetricsComparison = {
    timeToFirstWorkingProfileMs: adapterTimeMs,
    timeToFirstWorkingProfileProvenance: adapterTimeProv,
    manualCorrectionsPerProfile: adapterCorrections,
    manualCorrectionsProvenance: adapterCorrectionsProv,
    siblingPassRate: adapterSiblingPass,
    siblingPassRateUncertainty: adapterSiblingUncertainty,
    siblingPassRateConfidenceInterval: adapterSiblingCI,
    siblingPassRateProvenance: adapterSiblingProv,
    wrongProductCount: workspaceFlow?.wrongProductCount ?? hybridWrongProduct,
    wrongImageCount: workspaceFlow?.wrongImageCount ?? hybridWrongImage,
    operatorMinutes: adapterOperatorMinutes,
    operatorMinutesProvenance: adapterOperatorProv,
  };

  // Derive Strategy Thresholds & Recommendation
  const { thresholds, allPassed, recommendation, rationale } = deriveStrategyThresholds({
    selectorMetrics,
    adapterMetrics,
    gateVerdict: gateVerdict?.verdict,
    allGateThresholdsPassed: gateVerdict ? gateVerdict.allThresholdsPassed : true,
    isReviewed,
    groundTruthSource,
    usableObservations: usableObservationCount,
    minSamples,
    hasSufficientEvidence,
    missingEvidenceDimensions,
  });

  const recommendationBadge = formatStrategyRecommendationBadge(recommendation);

  const workspaceFlowSummary = workspaceFlow ? {
    timeToFirstWorkingProfileMs: adapterMetrics.timeToFirstWorkingProfileMs,
    manualCorrectionsCount: adapterMetrics.manualCorrectionsPerProfile,
    siblingPassRate: adapterMetrics.siblingPassRate,
    siblingPassRateConfidenceInterval: adapterMetrics.siblingPassRateConfidenceInterval,
    wrongProductCount: adapterMetrics.wrongProductCount,
    wrongImageCount: adapterMetrics.wrongImageCount,
    exceptionsCount: workspaceFlow.exceptionsCount ?? 0,
  } : undefined;

  return {
    scope,
    domain,
    platform,
    labelVersion,
    sampleCount,
    usableObservationCount,
    recommendation,
    recommendationBadge,
    recommendationRationale: rationale,
    adapterMetrics,
    selectorMetrics,
    thresholds,
    allThresholdsPassed: allPassed,
    gateVerdict: gateVerdict?.verdict,
    workspaceFlowSummary,
  };
}

/**
 * Formats the Executive Strategy Comparison Table.
 */
export function formatStrategyComparisonTable(
  scopes: Record<string, ScopeStrategyComparison>,
  title = 'Per-Scope Adapter vs Selector Comparison & Recommendation',
): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(
    '> **Strategy Recommendation Principle:** Evaluates proven platform and structure handling with small CSS exceptions versus selector-led coverage per scope. Derived strictly from baseline numbers with uncertainty, never by fiat.',
  );
  lines.push('');
  lines.push(
    '| Scope | Platform | Recommendation | Time to 1st Profile (Sel → Adp) | Manual Corrections (Sel → Adp) | Sibling Pass Rate (Sel → Adp) | Wrong Product (Sel → Adp) | Wrong Image (Sel → Adp) | Operator Mins (Sel → Adp) |',
  );
  lines.push(
    '| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |',
  );

  for (const s of Object.values(scopes)) {
    const sel = s.selectorMetrics;
    const adp = s.adapterMetrics;

    const timeStr = `${(sel.timeToFirstWorkingProfileMs / 1000).toFixed(0)}s (${sel.timeToFirstWorkingProfileProvenance}) → ${(adp.timeToFirstWorkingProfileMs / 1000).toFixed(0)}s (${adp.timeToFirstWorkingProfileProvenance})`;
    const corrStr = `${sel.manualCorrectionsPerProfile} (${sel.manualCorrectionsProvenance}) → ${adp.manualCorrectionsPerProfile} (${adp.manualCorrectionsProvenance})`;
    const siblingStr = `${(sel.siblingPassRate * 100).toFixed(1)}% → **${(adp.siblingPassRate * 100).toFixed(1)}%** (±${(adp.siblingPassRateUncertainty * 100).toFixed(1)}%)`;
    const wpStr = `${sel.wrongProductCount} → **${adp.wrongProductCount}**`;
    const wiStr = `${sel.wrongImageCount} → **${adp.wrongImageCount}**`;
    const opStr = `${sel.operatorMinutes.toFixed(1)}m (${sel.operatorMinutesProvenance}) → **${adp.operatorMinutes.toFixed(1)}m** (${adp.operatorMinutesProvenance})`;

    lines.push(
      `| **\`${s.scope}\`** | ${s.platform ?? 'generic'} | ${s.recommendationBadge} | ${timeStr} | ${corrStr} | ${siblingStr} | ${wpStr} | ${wiStr} | ${opStr} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Formats the Strategy Thresholds & Uncertainty Audit Table.
 */
export function formatStrategyThresholdsTable(scopes: Record<string, ScopeStrategyComparison>): string {
  const lines: string[] = [];
  lines.push('## Derived Strategy Thresholds & Uncertainty Audit');
  lines.push('');
  lines.push(
    '> **Audit Principle:** Recommendation thresholds are derived from observed baseline measurements and recorded with label versions to guarantee exact reproducibility.',
  );
  lines.push('');
  lines.push(
    '| Scope | Dimension | Baseline Measured | Derived Target Threshold | Observed Adapter | Uncertainty | Gate Rule | Status |',
  );
  lines.push(
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const [scopeKey, s] of Object.entries(scopes)) {
    for (const t of s.thresholds) {
      const formatVal = (num: number, unit: string): string => {
        if (unit === 'rate') return `${(num * 100).toFixed(1)}%`;
        if (unit === 'minutes') return `${num.toFixed(1)}m`;
        if (unit === 'ms') return `${(num / 1000).toFixed(1)}s`;
        return `${num}`;
      };

      const baseStr = formatVal(t.baselineValue, t.unit);
      const targetStr = formatVal(t.thresholdValue, t.unit);
      const actualStr = `**${formatVal(t.actualValue, t.unit)}**`;
      const uncStr =
        t.actualUncertainty !== undefined
          ? `±${(t.actualUncertainty * (t.unit === 'rate' ? 100 : 1)).toFixed(1)}${t.unit === 'rate' ? '%' : ''}`
          : '—';
      const statusBadge = t.passed ? '✅ PASS' : '⛔ FAIL';

      lines.push(
        `| \`${scopeKey}\` | ${sanitizeCell(t.name)} | ${baseStr} | ${targetStr} | ${actualStr} | ${uncStr} | \`${t.rule}\` | ${statusBadge} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generates the full Per-Scope Evidence-Chosen Adapter Strategy Report.
 */
export function generateAdapterStrategyReport(args: {
  manifest: AuditManifest;
  rows: AuditScoredRow[];
  gateReport?: PerScopePromotionReport;
  options?: StrategyReportOptions;
}): PerScopeAdapterStrategyReport {
  const { manifest, rows, options = {} } = args;

  const labelVersion = manifest.labelVersion ?? '1.0.0';
  const gateReport =
    args.gateReport ??
    evaluateGateArithmetic(manifest.samples, rows, {
      ...options,
      labelVersion,
    });

  // Extract scopes
  const scopeSet = new Set<string>();
  for (const s of manifest.samples) {
    scopeSet.add(s.pageStructureScope || 'standard_pdp');
  }
  const scopes = Array.from(scopeSet);

  const recommendationsByScope: Record<string, ScopeStrategyComparison> = {};

  for (const sc of scopes) {
    const gateVerdict = gateReport.verdictsByScope[sc];
    const wfInput = options.workspaceFlows?.[sc];

    recommendationsByScope[sc] = evaluateScopeStrategyComparison({
      scope: sc,
      domain: manifest.domain,
      platform: gateVerdict?.platform ?? manifest.samples.find(s => (s.pageStructureScope || 'standard_pdp') === sc)?.platform,
      labelVersion,
      samples: manifest.samples,
      rows,
      gateVerdict,
      workspaceFlow: wfInput,
      options,
    });
  }

  // Determine overall recommendation across active (non-profile-blocked) scopes
  const activeScopes = scopes.filter(sc => {
    const scopeSamples = manifest.samples.filter(s => (s.pageStructureScope || 'standard_pdp') === sc);
    return !scopeSamples.every(s => s.isProfileBlocked || s.sampleType === 'profile_blocked');
  });
  const targetScopes = activeScopes.length > 0 ? activeScopes : scopes;
  const targetRecs = targetScopes.map(sc => recommendationsByScope[sc]?.recommendation);

  let overallRecommendation: StrategyRecommendation = 'needs_review';
  if (targetRecs.length > 0 && targetRecs.every(r => r === 'adapter_with_css_exceptions')) {
    overallRecommendation = 'adapter_with_css_exceptions';
  } else if (targetRecs.length > 0 && targetRecs.every(r => r === 'custom_selectors')) {
    overallRecommendation = 'custom_selectors';
  }

  // Build Markdown
  const mdParts: string[] = [];
  mdParts.push('# Evidence-Chosen Adapter Strategy Report');
  mdParts.push(
    `**Domain:** \`${manifest.domain}\` | **Generated At:** ${new Date().toISOString()} | **Label Version:** \`${labelVersion}\` | **Samples:** ${manifest.samples.length} | **Scopes:** ${scopes.length}`,
  );
  mdParts.push(`**Overall Strategy Recommendation:** ${formatStrategyRecommendationBadge(overallRecommendation)}`);
  mdParts.push('');

  // 1. Comparison Table
  mdParts.push(formatStrategyComparisonTable(recommendationsByScope));

  // 2. Thresholds & Uncertainty Audit Table
  mdParts.push(formatStrategyThresholdsTable(recommendationsByScope));

  // 3. Actionable Next Steps
  mdParts.push('## Actionable Scope Recommendations & Rationale');
  mdParts.push('');
  for (const [scopeKey, s] of Object.entries(recommendationsByScope)) {
    mdParts.push(`### Scope: \`${scopeKey}\` — Recommendation: ${s.recommendationBadge}`);
    mdParts.push(
      `- **Platform:** ${s.platform ?? 'generic'} | **Label Version:** \`${s.labelVersion}\` | **Samples Evaluated:** ${s.sampleCount}`,
    );
    mdParts.push(
      `- **Time to 1st Working Profile:** ${(s.adapterMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(0)}s (${s.adapterMetrics.timeToFirstWorkingProfileProvenance}) vs ${(s.selectorMetrics.timeToFirstWorkingProfileMs / 1000).toFixed(0)}s (${s.selectorMetrics.timeToFirstWorkingProfileProvenance}) selector baseline`,
    );
    mdParts.push(
      `- **Manual Corrections Per Profile:** ${s.adapterMetrics.manualCorrectionsPerProfile} (${s.adapterMetrics.manualCorrectionsProvenance}) vs ${s.selectorMetrics.manualCorrectionsPerProfile} (${s.selectorMetrics.manualCorrectionsProvenance}) selector baseline`,
    );
    const ciStr = s.adapterMetrics.siblingPassRateConfidenceInterval
      ? ` [${(s.adapterMetrics.siblingPassRateConfidenceInterval.lower * 100).toFixed(1)}%, ${(s.adapterMetrics.siblingPassRateConfidenceInterval.upper * 100).toFixed(1)}%]`
      : '';
    mdParts.push(
      `- **Sibling-Page Pass Rate:** ${(s.adapterMetrics.siblingPassRate * 100).toFixed(1)}% (±${(s.adapterMetrics.siblingPassRateUncertainty * 100).toFixed(1)}%)${ciStr} vs ${(s.selectorMetrics.siblingPassRate * 100).toFixed(1)}% selector baseline`,
    );
    mdParts.push(
      `- **Defect Counts:** ${s.adapterMetrics.wrongProductCount} wrong-product, ${s.adapterMetrics.wrongImageCount} wrong-image (vs ${s.selectorMetrics.wrongProductCount} and ${s.selectorMetrics.wrongImageCount} selector baseline)`,
    );
    mdParts.push(
      `- **Operator Maintenance:** ${s.adapterMetrics.operatorMinutes.toFixed(1)}m (${s.adapterMetrics.operatorMinutesProvenance}) vs ${s.selectorMetrics.operatorMinutes.toFixed(1)}m (${s.selectorMetrics.operatorMinutesProvenance}) selector baseline`,
    );
    mdParts.push('- **Rationale:**');
    for (const r of s.recommendationRationale) {
      mdParts.push(`  - ${r}`);
    }
    mdParts.push('');
  }

  const markdown = mdParts.join('\n');

  return {
    domain: manifest.domain,
    generatedAt: new Date().toISOString(),
    labelVersion,
    totalSamples: manifest.samples.length,
    totalScopes: scopes.length,
    overallRecommendation,
    recommendationsByScope,
    markdown,
  };
}
