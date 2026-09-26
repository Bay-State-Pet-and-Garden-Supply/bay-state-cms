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
export const QUALIFIED_RAW_BUNDLE_VERSION = 1 as const;
export type RawAccuracySourceKind = typeof QUALIFIED_RAW_PREDICTION_SOURCE | typeof LEGACY_REVIEWED_OUTCOME_SOURCE;
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
export function evaluateQualificationGate(
  metrics: EvalMetrics,
  holdoutSize: number,
  options: QualificationGateOptions = {},
): QualificationResult {
  const requiredHoldout = options.requiredHoldout ?? 200;
  const requiredClassSupport = options.requiredClassSupport ?? 20;
  const requiredCoverage = options.requiredCoverage ?? 0.8;
  const primaryMetric = options.primaryMetric ?? 'productType.top1Accuracy';

  const reasons: string[] = [];

  if (holdoutSize < requiredHoldout) {
    reasons.push(`insufficient_sample: holdout ${holdoutSize} < ${requiredHoldout}`);
  }

  const coverage = metrics.productType.coverage;
  if (coverage < requiredCoverage) {
    reasons.push(`coverage ${coverage.toFixed(3)} < ${requiredCoverage}`);
  }

  const perClassSupport = metrics.productType.perClassSupport;
  const supportValues = Object.values(perClassSupport);
  const minClassSupport = supportValues.length > 0 ? Math.min(...supportValues) : 0;
  if (supportValues.length === 0 || minClassSupport < requiredClassSupport) {
    reasons.push(
      `insufficient_class_support: min support ${minClassSupport} < ${requiredClassSupport} over ${supportValues.length} class(es)`,
    );
  }

  const violations = {
    crossSpecies: metrics.safety.crossSpeciesCount,
    claimSafety: metrics.safety.claimSafetyViolations,
    controlledValue: metrics.safety.controlledValueViolations,
  };
  if (violations.crossSpecies + violations.claimSafety + violations.controlledValue > 0) {
    reasons.push(
      `safety_violations: ${JSON.stringify(violations)}`,
    );
  }

  const deltaLower95 = metrics.pairedDelta.deltaLower95;
  if (metrics.pairedDelta.primaryMetric !== primaryMetric) {
    reasons.push(
      `paired_metric_mismatch: evaluated "${metrics.pairedDelta.primaryMetric}", predeclared "${primaryMetric}"`,
    );
  } else if (deltaLower95 <= 0) {
    reasons.push(`paired_delta_not_significant: lower 95% CI ${deltaLower95.toFixed(4)} <= 0`);
  }

  let nonRegressionFloorsMet = true;
  for (const floor of options.nonRegressionFloors ?? []) {
    if (floor.actual < floor.floor) {
      nonRegressionFloorsMet = false;
      reasons.push(`non_regression_floor: ${floor.metric} ${floor.actual.toFixed(3)} < ${floor.floor}`);
    }
  }

  const failureCount = options.failureCount ?? 0;
  if (failureCount > 0) {
    reasons.push(`prediction_failures: ${failureCount} service/validation failure(s); failed calls cannot earn abstention correctness`);
  }
  const labeledSupport = options.labeledSupport ?? null;
  if (labeledSupport !== null) {
    const requiredLabeledSupport = options.requiredLabeledSupport ?? requiredHoldout;
    if (labeledSupport < requiredLabeledSupport) {
      reasons.push(`insufficient_labeled_support: labeled ${labeledSupport} < ${requiredLabeledSupport}`);
    }
  }
  const snapshotMatched = options.snapshotMatched ?? null;
  if (snapshotMatched === false) {
    const detail = options.snapshotDetail ? `: ${options.snapshotDetail}` : '';
    reasons.push(`snapshot_mismatch: frozen dataset and captured bundle snapshots differ${detail}`);
  }
  const sourceProvided = options.predictionSource !== undefined || options.bundleVersion !== undefined;
  const predictionSource = options.predictionSource ?? null;
  const bundleVersion = options.bundleVersion ?? null;
  let sourceEligible: boolean;
  if (sourceProvided) {
    const eligibility = assessPredictionSourceEligibility(predictionSource, bundleVersion);
    sourceEligible = eligibility.eligible;
    reasons.push(...eligibility.reasons);
  } else {
    sourceEligible = false;
  }
  const qualified = reasons.length === 0;
  return {
    qualified,
    reasons,
    gate: {
      holdoutSize,
      coverage,
      minClassSupport,
      violations,
      deltaLower95,
      primaryMetric,
      nonRegressionFloorsMet,
      predictionSource,
      bundleVersion,
      sourceEligible,
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
