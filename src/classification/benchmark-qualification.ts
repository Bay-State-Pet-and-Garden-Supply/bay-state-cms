/**
 * Conservative Benchmark Qualification
 *
 * Qualification receipts encode the approved gate. A receipt is NEVER a
 * permission to enable a feature: feature-policy still requires the receipt
 * digest plus an explicit activation audit. Nothing here auto-enables or
 * auto-accepts anything.
 *
 * Approved gate (docs/plans/classification-system-implementation-plan.md):
 * - holdout ≥ 200;
 * - support ≥ 20 per evaluated class;
 * - coverage ≥ 0.80;
 * - zero cross-species, claim-safety, and controlled-value violations;
 * - lower 95% confidence bound for the predeclared paired primary-metric delta
 *   above zero;
 * - task-specific non-regression floors.
 *
 * Raw-accuracy gating (issue #294): a bundle only qualifies raw model accuracy
 * from the immutable pre-review source (`prereview_raw`, version 1) with
 * sufficient labeled support, matched snapshots, and zero service/validation
 * failures. Legacy reviewed-outcome artifacts stay readable for history and
 * calibration but are explicitly ineligible — reviewer corrections are
 * answers, not predictions. Callers that omit the source contract keep the
 * legacy gate outcome byte-for-byte; raw-accuracy claims MUST pass the
 * source explicitly.
 */
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';
import type { EvalMetrics } from '../shared/schemas/classification';
export const QUALIFIED_RAW_PREDICTION_SOURCE = 'prereview_raw' as const;
export const LEGACY_REVIEWED_OUTCOME_SOURCE = 'reviewed_outcome' as const;
const QUALIFIED_RAW_BUNDLE_VERSION = 1 as const;
export interface SourceEligibility {
  eligible: boolean;
  reasons: string[];
  source: string | null;
  bundleVersion: number | null;
}
/**
 * Assess whether a prediction bundle source may qualify raw model accuracy.
 * Legacy reviewed-outcome bundles (and unknown envelopes) stay readable but
 * are never eligible: reviewer corrections are answers, not predictions.
 * Historical bundle bytes/hashes are never rewritten by this check.
 */
export function assessPredictionSourceEligibility(
  source: string | null | undefined,
  bundleVersion: number | null | undefined,
): SourceEligibility {
  if (source === null || source === undefined) {
    return {
      eligible: false,
      reasons: ['unknown_prediction_source_ineligible: no prediction source contract; raw accuracy requires prereview_raw'],
      source: null,
      bundleVersion: bundleVersion ?? null,
    };
  }
  if (source !== QUALIFIED_RAW_PREDICTION_SOURCE) {
    if (source === LEGACY_REVIEWED_OUTCOME_SOURCE) {
      return {
        eligible: false,
        reasons: ['legacy_reviewed_outcome_ineligible: reviewed-outcome artifacts stay readable but cannot qualify raw model accuracy'],
        source,
        bundleVersion: bundleVersion ?? null,
      };
    }
    return {
      eligible: false,
      reasons: [`unknown_prediction_source_ineligible: source "${source}" cannot qualify raw model accuracy`],
      source,
      bundleVersion: bundleVersion ?? null,
    };
  }
  if (bundleVersion !== null && bundleVersion !== undefined && bundleVersion !== QUALIFIED_RAW_BUNDLE_VERSION) {
    return {
      eligible: false,
      reasons: [`prediction_bundle_version_mismatch: prereview_raw requires version ${QUALIFIED_RAW_BUNDLE_VERSION}, got ${bundleVersion}`],
      source,
      bundleVersion,
    };
  }
  return { eligible: true, reasons: [], source, bundleVersion: bundleVersion ?? null };
}
export interface QualificationGateOptions {
  requiredHoldout?: number;
  requiredClassSupport?: number;
  requiredCoverage?: number;
  /** Predeclared paired primary metric (e.g. productType.top1Accuracy). */
  primaryMetric?: string;
  /** Task-specific non-regression floors, e.g. top1Accuracy ≥ 0.5. */
  nonRegressionFloors?: Array<{ metric: string; floor: number; actual: number }>;
  /**
   * Prediction-source contract for raw-accuracy claims. Omit to keep the
   * legacy gate outcome byte-for-byte; pass the stored bundle source (and
   * version) to enforce pre-review eligibility.
   */
  predictionSource?: string | null;
  bundleVersion?: number | null;
  /**
   * Labeled examples behind the metrics (excludes unlabeled gold). Gated
   * only when provided; inadequate labeled support stays unqualified.
   */
  labeledSupport?: number | null;
  requiredLabeledSupport?: number;
  /**
   * Snapshot consistency between the frozen dataset and the captured bundle.
   * `false` (with optional `snapshotDetail`) fails closed; `null`/omitted
   * leaves the legacy outcome untouched.
   */
  snapshotMatched?: boolean | null;
  snapshotDetail?: string | null;
  /**
   * Service/validation failures behind the bundle. Any failure stays
   * unqualified with an explicit reason — a failed call never earns
   * abstention correctness.
   */
  failureCount?: number | null;
}
export interface QualificationResult {
  qualified: boolean;
  reasons: string[];
  gate: {
    holdoutSize: number;
    coverage: number;
    minClassSupport: number;
    violations: { crossSpecies: number; claimSafety: number; controlledValue: number };
    deltaLower95: number;
    primaryMetric: string;
    nonRegressionFloorsMet: boolean;
    predictionSource: string | null;
    bundleVersion: number | null;
    sourceEligible: boolean;
    labeledSupport: number | null;
    snapshotMatched: boolean | null;
    failureCount: number;
  };
}
interface GateCheckState {
  reasons: string[];
  requiredHoldout: number;
  requiredClassSupport: number;
  requiredCoverage: number;
  primaryMetric: string;
}

function gateCheckDefaults(options: QualificationGateOptions): GateCheckState {
  return {
    reasons: [],
    requiredHoldout: options.requiredHoldout ?? 200,
    requiredClassSupport: options.requiredClassSupport ?? 20,
    requiredCoverage: options.requiredCoverage ?? 0.8,
    primaryMetric: options.primaryMetric ?? 'productType.top1Accuracy',
  };
}

/** Holdout-sample gate: frozen holdout must meet the required size. */
function checkHoldoutGate(state: GateCheckState, holdoutSize: number): void {
  if (holdoutSize < state.requiredHoldout) {
    state.reasons.push(`insufficient_sample: holdout ${holdoutSize} < ${state.requiredHoldout}`);
  }
}

/** Coverage gate: evaluated product-type coverage must meet the floor. */
function checkCoverageGate(state: GateCheckState, coverage: number): void {
  if (coverage < state.requiredCoverage) {
    state.reasons.push(`coverage ${coverage.toFixed(3)} < ${state.requiredCoverage}`);
  }
}

/** Class-support gate: every evaluated class needs labeled support. */
function checkClassSupportGate(
  state: GateCheckState,
  perClassSupport: Record<string, number>,
): number {
  const supportValues = Object.values(perClassSupport);
  const minClassSupport = supportValues.length > 0 ? Math.min(...supportValues) : 0;
  if (supportValues.length === 0 || minClassSupport < state.requiredClassSupport) {
    state.reasons.push(
      `insufficient_class_support: min support ${minClassSupport} < ${state.requiredClassSupport} over ${supportValues.length} class(es)`,
    );
  }
  return minClassSupport;
}

/** Safety gate: zero cross-species, claim-safety, and controlled-value violations. */
function checkSafetyGate(
  state: GateCheckState,
  metrics: EvalMetrics,
): { crossSpecies: number; claimSafety: number; controlledValue: number } {
  const violations = {
    crossSpecies: metrics.safety.crossSpeciesCount,
    claimSafety: metrics.safety.claimSafetyViolations,
    controlledValue: metrics.safety.controlledValueViolations,
  };
  if (violations.crossSpecies + violations.claimSafety + violations.controlledValue > 0) {
    state.reasons.push(
      `safety_violations: ${JSON.stringify(violations)}`,
    );
  }
  return violations;
}

/** Paired-delta gate: predeclared metric with a lower 95% bound above zero. */
function checkPairedDeltaGate(state: GateCheckState, metrics: EvalMetrics): number {
  const deltaLower95 = metrics.pairedDelta.deltaLower95;
  if (metrics.pairedDelta.primaryMetric !== state.primaryMetric) {
    state.reasons.push(
      `paired_metric_mismatch: evaluated "${metrics.pairedDelta.primaryMetric}", predeclared "${state.primaryMetric}"`,
    );
  } else if (deltaLower95 <= 0) {
    state.reasons.push(`paired_delta_not_significant: lower 95% CI ${deltaLower95.toFixed(4)} <= 0`);
  }
  return deltaLower95;
}

/** Non-regression floors gate: task-specific metric floors must all hold. */
function checkNonRegressionFloorsGate(
  state: GateCheckState,
  floors: QualificationGateOptions['nonRegressionFloors'],
): boolean {
  let floorsMet = true;
  for (const floor of floors ?? []) {
    if (floor.actual < floor.floor) {
      floorsMet = false;
      state.reasons.push(`non_regression_floor: ${floor.metric} ${floor.actual.toFixed(3)} < ${floor.floor}`);
    }
  }
  return floorsMet;
}

/** Failure gate: any service/validation failure stays unqualified. */
function checkFailureGate(state: GateCheckState, failureCount: number | null | undefined): number {
  const count = failureCount ?? 0;
  if (count > 0) {
    state.reasons.push(`prediction_failures: ${count} service/validation failure(s); failed calls cannot earn abstention correctness`);
  }
  return count;
}

/** Labeled-support gate: gated only when the labeled count is provided. */
function checkLabeledSupportGate(
  state: GateCheckState,
  labeledSupport: number | null | undefined,
  requiredLabeledSupport: number | undefined,
): number | null {
  const support = labeledSupport ?? null;
  if (support !== null) {
    const required = requiredLabeledSupport ?? state.requiredHoldout;
    if (support < required) {
      state.reasons.push(`insufficient_labeled_support: labeled ${support} < ${required}`);
    }
  }
  return support;
}

/** Snapshot gate: an explicit mismatch fails closed with its detail. */
function checkSnapshotGate(
  state: GateCheckState,
  snapshotMatched: boolean | null | undefined,
  snapshotDetail: string | null | undefined,
): boolean | null {
  const matched = snapshotMatched ?? null;
  if (matched === false) {
    const detail = snapshotDetail ? `: ${snapshotDetail}` : '';
    state.reasons.push(`snapshot_mismatch: frozen dataset and captured bundle snapshots differ${detail}`);
  }
  return matched;
}

/** Source-eligibility gate: raw-accuracy claims must pass the stored source. */
function checkSourceEligibilityGate(
  state: GateCheckState,
  predictionSource: string | null | undefined,
  bundleVersion: number | null | undefined,
): { predictionSource: string | null; bundleVersion: number | null; sourceEligible: boolean } {
  const sourceProvided = predictionSource !== undefined || bundleVersion !== undefined;
  const source = predictionSource ?? null;
  const version = bundleVersion ?? null;
  if (!sourceProvided) return { predictionSource: source, bundleVersion: version, sourceEligible: false };
  const eligibility = assessPredictionSourceEligibility(source, version);
  state.reasons.push(...eligibility.reasons);
  return { predictionSource: source, bundleVersion: version, sourceEligible: eligibility.eligible };
}

export function evaluateQualificationGate(
  metrics: EvalMetrics,
  holdoutSize: number,
  options: QualificationGateOptions = {},
): QualificationResult {
  const state = gateCheckDefaults(options);
  checkHoldoutGate(state, holdoutSize);
  const coverage = metrics.productType.coverage;
  checkCoverageGate(state, coverage);
  const minClassSupport = checkClassSupportGate(state, metrics.productType.perClassSupport);
  const violations = checkSafetyGate(state, metrics);
  const deltaLower95 = checkPairedDeltaGate(state, metrics);
  const nonRegressionFloorsMet = checkNonRegressionFloorsGate(state, options.nonRegressionFloors);
  const failureCount = checkFailureGate(state, options.failureCount);
  const labeledSupport = checkLabeledSupportGate(state, options.labeledSupport, options.requiredLabeledSupport);
  const snapshotMatched = checkSnapshotGate(state, options.snapshotMatched, options.snapshotDetail);
  const source = checkSourceEligibilityGate(state, options.predictionSource, options.bundleVersion);
  const qualified = state.reasons.length === 0;
  return {
    qualified,
    reasons: state.reasons,
    gate: {
      holdoutSize,
      coverage,
      minClassSupport,
      violations,
      deltaLower95,
      primaryMetric: state.primaryMetric,
      nonRegressionFloorsMet,
      predictionSource: source.predictionSource,
      bundleVersion: source.bundleVersion,
      sourceEligible: source.sourceEligible,
      labeledSupport,
      snapshotMatched,
      failureCount,
    },
  };
}

export interface BuildQualificationReceiptOptions {
  datasetId: string;
  datasetHash: string;
  predictionBundleId: string;
  bundleHash: string;
  holdoutSize: number;
  metrics: EvalMetrics;
  qualification: QualificationResult;
  generatedBy?: string | null;
}
export interface RawAccuracyQualificationReportInput {
  datasetId: string;
  datasetHash: string;
  predictionBundleId: string;
  bundleHash: string;
  holdoutSize: number;
  labeledSupport?: number | null;
  metrics: EvalMetrics;
  qualification: QualificationResult;
  source?: string | null;
  bundleVersion?: number | null;
  generatedBy?: string | null;
}
export interface RawAccuracyQualificationReport {
  eligible: boolean;
  qualified: boolean;
  status: 'qualified' | 'unqualified' | 'ineligible_source';
  reasons: string[];
  source: string | null;
  bundleVersion: number | null;
}
/**
 * Maintainer-facing raw-accuracy report. Legacy reviewed-outcome bundles are
 * explicitly `ineligible_source` (readable, never qualifying); inadequate
 * labeled support, snapshot mismatch, and failures stay `unqualified`.
 */
export function reportRawAccuracyQualification(
  input: RawAccuracyQualificationReportInput,
): RawAccuracyQualificationReport {
  const source = input.source ?? input.qualification.gate.predictionSource;
  const bundleVersion = input.bundleVersion ?? input.qualification.gate.bundleVersion;
  const eligibility = assessPredictionSourceEligibility(source, bundleVersion);
  const qualified = input.qualification.qualified && eligibility.eligible;
  const status = !eligibility.eligible ? 'ineligible_source' : qualified ? 'qualified' : 'unqualified';
  const reasons = [...input.qualification.reasons, ...eligibility.reasons];
  return { eligible: eligibility.eligible, qualified, status, reasons, source, bundleVersion };
}

/**
 * Build the content-addressed qualification receipt payload. The digest binds
 * the dataset hash, bundle hash, holdout size, metrics-derived gate values, and
 * the qualification outcome so a receipt cannot be replayed against a different
 * dataset/bundle.
 */
export function buildQualificationReceiptPayload(options: BuildQualificationReceiptOptions): Record<string, unknown> {
  const { qualification, metrics } = options;
  return {
    datasetId: options.datasetId,
    datasetHash: options.datasetHash,
    predictionBundleId: options.predictionBundleId,
    bundleHash: options.bundleHash,
    holdoutSize: options.holdoutSize,
    gate: qualification.gate,
    qualified: qualification.qualified,
    reasons: qualification.reasons,
    calibrationEce: metrics.calibration.ece,
  };
}

export function buildQualificationReceiptDigest(payload: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(payload));
}

export function createQualificationReceiptId(): string {
  return randomUUID();
}
