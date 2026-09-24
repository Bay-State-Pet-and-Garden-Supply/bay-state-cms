/**
 * Benchmark Evaluator
 *
 * The evaluator is PURE over a frozen Gold dataset plus a persisted prediction
 * bundle. It never queries current runs or decisions, so evaluations are
 * repeatable and replayable. All run/decision access happens at bundle build
 * time (benchmark-prediction.ts); evaluation reads only frozen examples and
 * the immutable bundle.
 */

import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import { loadPredictionBundle } from './benchmark-prediction';
import {
  buildQualificationReceiptDigest,
  buildQualificationReceiptPayload,
  createQualificationReceiptId,
  evaluateQualificationGate,
  type QualificationGateOptions,
  type QualificationResult,
} from './benchmark-qualification';
import type {
  BenchmarkGoldLabels,
  BenchmarkPredictionEntry,
  EvalMetrics,
} from '../shared/schemas/classification';

// ─── Pure metric core ──────────────────────────────────────────────────────────

export interface GoldExampleForEvaluation {
  id: string;
  productSku: string;
  goldLabels: BenchmarkGoldLabels;
  /** Lowercased concatenated evidence text (for species heuristics). */
  evidenceText: string;
  /**
   * Adjudicated gold state (`productTypeState` in goldLabelsJson).
   * Null = legacy gold without a marker; label presence decides scoring.
   */
  goldState?: EvaluatorGoldState | null;
  /**
   * Adjudicated gold states for product field targets (`fieldStates` in goldLabelsJson).
   */
  fieldGoldStates?: Record<string, EvaluatorFieldGoldState> | null;
  /** Product family id (split-leakage detection). */
  familyId?: string | null;
  /** Split the example belongs to. */
  splitGroup?: string | null;
  /** Frozen source provenance (snapshot-mismatch attribution only). */
  sourceRunId?: string | null;
  sourceConfigHash?: string | null;
  sourceProductHash?: string | null;
}

// ─── Gold-state contract (issue #294) ───────────────────────────────────────
// Mirrors the adjudicated fixture states persisted by benchmark-exporter.ts
// (`goldLabelsJson[productTypeState]`) without importing that module — the
// evaluator reads the marker defensively so legacy gold keeps working.
export const EVALUATOR_GOLD_STATE_KNOWN = 'known' as const;
export const EVALUATOR_GOLD_STATE_NO_FIT = 'no-fit' as const;
export const EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
export const EVALUATOR_GOLD_STATE_UNLABELED = 'unlabeled' as const;
export const EVALUATOR_GOLD_STATES = [
  EVALUATOR_GOLD_STATE_KNOWN,
  EVALUATOR_GOLD_STATE_NO_FIT,
  EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  EVALUATOR_GOLD_STATE_UNLABELED,
] as const;
export type EvaluatorGoldState = (typeof EVALUATOR_GOLD_STATES)[number];
/** Gold-labels JSON field carrying the adjudicated gold state. */
export const EVALUATOR_GOLD_STATE_FIELD = 'productTypeState' as const;

/**
 * Normalize adjudicated state spellings. Accepts the canonical exporter
 * spellings (`known`, `no-fit`, `insufficient-evidence`, `unlabeled`) plus
 * the ticket aliases (`known-type`, `no-fitting-type`); unknown values and
 * non-strings yield null (legacy handling).
 */
export function normalizeEvaluatorGoldState(value: unknown): EvaluatorGoldState | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/_/g, '-');
  if (v === 'known' || v === 'known-type') return EVALUATOR_GOLD_STATE_KNOWN;
  if (v === 'no-fit' || v === 'no-fitting-type' || v === 'no-fit-type' || v === 'nofit') return EVALUATOR_GOLD_STATE_NO_FIT;
  if (v === 'insufficient-evidence' || v === 'insufficientevidence') return EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE;
  if (v === 'unlabeled' || v === 'unlabelled') return EVALUATOR_GOLD_STATE_UNLABELED;
  return null;
}

/** Read the adjudicated gold state; null for legacy gold without a marker. */
export function readEvaluatorGoldState(goldLabelsJson: string): EvaluatorGoldState | null {
  try {
    const parsed = JSON.parse(goldLabelsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeEvaluatorGoldState(parsed[EVALUATOR_GOLD_STATE_FIELD]);
  } catch {
    return null;
  }
}

// ─── Field Gold-state contract (issue #298 / AC 8) ───────────────────────────
export const EVALUATOR_FIELD_GOLD_STATE_KNOWN = 'known' as const;
export const EVALUATOR_FIELD_GOLD_STATE_NO_FIT = 'no-fit' as const;
export const EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
export const EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE = 'inapplicable' as const;
export const EVALUATOR_FIELD_GOLD_STATE_UNLABELED = 'unlabeled' as const;
export const EVALUATOR_FIELD_GOLD_STATES = [
  EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE,
  EVALUATOR_FIELD_GOLD_STATE_UNLABELED,
] as const;
export type EvaluatorFieldGoldState = (typeof EVALUATOR_FIELD_GOLD_STATES)[number];
export const EVALUATOR_FIELD_GOLD_STATES_FIELD = 'fieldStates' as const;

export function normalizeEvaluatorFieldGoldState(value: unknown): EvaluatorFieldGoldState | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/_/g, '-');
  if (v === 'known' || v === 'known-type' || v === 'known-value') return EVALUATOR_FIELD_GOLD_STATE_KNOWN;
  if (v === 'no-fit' || v === 'no-fitting-type' || v === 'no-fit-type' || v === 'nofit' || v === 'no-fitting') return EVALUATOR_FIELD_GOLD_STATE_NO_FIT;
  if (v === 'insufficient-evidence' || v === 'insufficientevidence') return EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE;
  if (v === 'inapplicable' || v === 'not-applicable' || v === 'na') return EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE;
  if (v === 'unlabeled' || v === 'unlabelled') return EVALUATOR_FIELD_GOLD_STATE_UNLABELED;
  return null;
}

export function readEvaluatorFieldStates(goldLabelsJson: string): Record<string, EvaluatorFieldGoldState> | null {
  try {
    const parsed = JSON.parse(goldLabelsJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const raw = (parsed[EVALUATOR_FIELD_GOLD_STATES_FIELD] ?? (parsed as any).fieldGoldStates) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const result: Record<string, EvaluatorFieldGoldState> = {};
    for (const [key, val] of Object.entries(raw)) {
      const normalized = normalizeEvaluatorFieldGoldState(val);
      if (normalized) result[key] = normalized;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ─── Prediction-outcome contract (issue #294) ───────────────────────────────
// Explicit semantic abstention is tracked separately from service/validation
// failure: failures earn no abstention credit. Classification is structural so
// both legacy bundles (abstained flag only) and pre-review bundles
// (`outcome` + `failureCode`) are handled.
export const EVALUATOR_OUTCOME_PREDICTED = 'predicted' as const;
export const EVALUATOR_OUTCOME_ABSTAINED = 'abstained-semantic' as const;
export const EVALUATOR_OUTCOME_FAILED = 'failed' as const;
export const EVALUATOR_OUTCOME_MISSING = 'missing' as const;
export type EvaluatorPredictionOutcome =
  | typeof EVALUATOR_OUTCOME_PREDICTED
  | typeof EVALUATOR_OUTCOME_ABSTAINED
  | typeof EVALUATOR_OUTCOME_FAILED
  | typeof EVALUATOR_OUTCOME_MISSING;


/** Classify one bundle entry; undefined (no entry for the gold id) is missing. */
export function classifyEvaluatorPredictionOutcome(
  entry: BenchmarkPredictionEntry | undefined | null,
): EvaluatorPredictionOutcome {
  if (!entry) return EVALUATOR_OUTCOME_MISSING;
  const raw = entry as unknown as Record<string, unknown>;
  // A failure marker always wins: a failed call earns no abstention credit,
  // even when the entry also carries an abstention flag or outcome.
  const failureCode = raw.failureCode;
  if (typeof failureCode === 'string' && failureCode.trim() !== '') {
    return EVALUATOR_OUTCOME_FAILED;
  }
  const outcome = typeof raw.outcome === 'string' ? raw.outcome : null;
  // Explicit pre-review outcomes are authoritative when present.
  if (outcome === 'failed') return EVALUATOR_OUTCOME_FAILED;
  if (outcome === 'abstained') return EVALUATOR_OUTCOME_ABSTAINED;
  if (outcome === 'predicted') return EVALUATOR_OUTCOME_PREDICTED;
  if (entry.abstained === true) return EVALUATOR_OUTCOME_ABSTAINED;
  // Legacy parity: a null type with no abstention flag is "no answer", not an
  // error — legacy metrics count exactly this shape as abstained.
  if (entry.productType === null || entry.productType === undefined) return EVALUATOR_OUTCOME_ABSTAINED;
  return EVALUATOR_OUTCOME_PREDICTED;
}

// ─── Bundle source/version contract (issue #294) ────────────────────────────
// New raw bundles carry `source: 'prereview_raw'` + version 1; legacy
// reviewed-outcome bundles are plain arrays (version 0). Values mirror
// benchmark-prediction.ts without importing it (parallel ownership).
export const EVALUATOR_PRE_REVIEW_SOURCE = 'prereview_raw' as const;
export const EVALUATOR_REVIEWED_OUTCOME_SOURCE = 'reviewed_outcome' as const;
export const EVALUATOR_PRE_REVIEW_BUNDLE_VERSION = 1 as const;
export const EVALUATOR_LEGACY_BUNDLE_VERSION = 0 as const;
export type EvaluatorPredictionSource =
  | typeof EVALUATOR_PRE_REVIEW_SOURCE
  | typeof EVALUATOR_REVIEWED_OUTCOME_SOURCE
  | 'unknown';

export interface EvaluatorBundleProvenance {
  source: EvaluatorPredictionSource;
  bundleVersion: number;
  /** False for legacy reviewed-outcome artifacts (reviewer-corrected answers). */
  eligibleForRawAccuracyQualification: boolean;
  eligibilityReason: string;
}

function evaluatorProvenanceFor(
  source: EvaluatorPredictionSource,
  bundleVersion: number,
): EvaluatorBundleProvenance {
  if (source === EVALUATOR_PRE_REVIEW_SOURCE) {
    return {
      source,
      bundleVersion,
      eligibleForRawAccuracyQualification: true,
      eligibilityReason: 'pre-review raw outputs: uncorrected model predictions eligible for raw-accuracy qualification (subject to gates).',
    };
  }
  if (source === EVALUATOR_REVIEWED_OUTCOME_SOURCE) {
    return {
      source,
      bundleVersion,
      eligibleForRawAccuracyQualification: false,
      eligibilityReason: 'legacy reviewed-outcome artifact: incorporates accepted reviewer revisions; readable for history but ineligible to qualify raw model accuracy.',
    };
  }
  return {
    source: 'unknown',
    bundleVersion,
    eligibleForRawAccuracyQualification: false,
    eligibilityReason: 'unknown bundle source/version envelope: fail closed, ineligible for raw-accuracy qualification.',
  };
}

/**
 * Resolve per-bundle source provenance. Prefers the loader-provided
 * source/version hint (new `loadPredictionBundle` shape) and falls back to
 * structural detection of the persisted JSON (array = legacy
 * reviewed-outcome; `{ source: 'prereview_raw', version: 1, predictions }`
 * = pre-review). Anything else resolves to `unknown` (fail closed downstream).
 */
export function describeEvaluatorBundleProvenance(
  persistedJson: unknown,
  loaderHint?: { source?: unknown; bundleVersion?: unknown },
): EvaluatorBundleProvenance {
  const hintSource = loaderHint?.source;
  const hintVersion = loaderHint?.bundleVersion;
  if (hintSource === EVALUATOR_PRE_REVIEW_SOURCE || hintSource === EVALUATOR_REVIEWED_OUTCOME_SOURCE) {
    const version = typeof hintVersion === 'number' && Number.isFinite(hintVersion)
      ? hintVersion
      : hintSource === EVALUATOR_PRE_REVIEW_SOURCE
        ? EVALUATOR_PRE_REVIEW_BUNDLE_VERSION
        : EVALUATOR_LEGACY_BUNDLE_VERSION;
    return evaluatorProvenanceFor(hintSource, version);
  }
  let parsed = persistedJson;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return evaluatorProvenanceFor('unknown', -1);
    }
  }
  if (Array.isArray(parsed)) {
    return evaluatorProvenanceFor(EVALUATOR_REVIEWED_OUTCOME_SOURCE, EVALUATOR_LEGACY_BUNDLE_VERSION);
  }
  if (parsed && typeof parsed === 'object') {
    const envelope = parsed as Record<string, unknown>;
    if (
      envelope.source === EVALUATOR_PRE_REVIEW_SOURCE &&
      envelope.version === EVALUATOR_PRE_REVIEW_BUNDLE_VERSION &&
      Array.isArray(envelope.predictions)
    ) {
      return evaluatorProvenanceFor(EVALUATOR_PRE_REVIEW_SOURCE, EVALUATOR_PRE_REVIEW_BUNDLE_VERSION);
    }
  }
  return evaluatorProvenanceFor('unknown', -1);
}

export interface ControlledValues {
  /** targetId -> allowed values (empty = free-form). */
  [targetId: string]: string[];
}

export interface ComputeMetricsOptions {
  /** Controlled vocabulary per field target; violations counted against it. */
  controlledValues?: ControlledValues;
  /** Deterministic seed digest for the paired bootstrap (e.g. bundleHash). */
  pairedSeedDigest?: string;
  /** Baseline predictions for the paired delta (default: abstention baseline). */
  baselinePredictions?: BenchmarkPredictionEntry[];
  primaryMetric?: string;
  /** Number of holdout examples in the dataset (gate input). */
  holdoutSize?: number;
  bootstrapRuns?: number;
}

function defaultMetrics(): EvalMetrics {
  return {
    productType: {
      top1Accuracy: 0,
      macroF1: 0,
      confusionPairs: [],
      support: 0,
      coverage: 0,
      perClassSupport: {},
    },
    pages: {
      precisionAtK: 0,
      recallAtK: 0,
      exactSetAccuracy: 0,
      blocked: false,
      blockedReason: null,
    },
    fields: {
      targetAccuracy: {},
      targetSupport: {},
    },
    safety: {
      crossSpeciesCount: 0,
      crossSpeciesExamples: [],
      claimSafetyViolations: 0,
      controlledValueViolations: 0,
    },
    abstention: {
      abstainedPercent: 0,
      accuracyOfNonAbstained: 0,
    },
    operations: {
      correctionsPerHundred: 0,
    },
    calibration: {
      ece: 0,
      bins: [],
    },
    pairedDelta: {
      primaryMetric: 'productType.top1Accuracy',
      deltaMean: 0,
      deltaLower95: 0,
      deltaUpper95: 0,
      bootstrapRuns: 0,
    },
  };
}

function predictionForExample(predictions: BenchmarkPredictionEntry[], exampleId: string): BenchmarkPredictionEntry | undefined {
  return predictions.find(p => p.exampleId === exampleId);
}

function speciesOfType(productType: string | null): { dog: boolean; cat: boolean } {
  const text = (productType ?? '').toLowerCase();
  return {
    dog: /\bdog\b|\bcanine\b|\bpuppy\b/.test(text),
    cat: /\bcat\b|\bfeline\b|\bkitten\b/.test(text),
  };
}

/** Deterministic PRNG (mulberry32) seeded from a hex digest. */
function seededRandom(seedDigest: string): () => number {
  const seed = parseInt(seedDigest.replace(/[^0-9a-f]/gi, '').slice(0, 8) || '0', 16) >>> 0;
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PerExamplePrimaryMetric {
  exampleId: string;
  candidate: number; // 1 = correct / 0 = incorrect (abstained excluded)
  baseline: number;
}

/** Per-example paired values for the primary metric (product type accuracy). */
function computePerExamplePrimaryMetric(
  gold: GoldExampleForEvaluation[],
  candidate: BenchmarkPredictionEntry[],
  baseline: BenchmarkPredictionEntry[] | null,
): PerExamplePrimaryMetric[] {
  const result: PerExamplePrimaryMetric[] = [];
  for (const example of gold) {
    if (!example.goldLabels.productType) continue;
    const cand = predictionForExample(candidate, example.id);
    if (!cand || cand.abstained || cand.productType === null) continue;
    const base = baseline ? predictionForExample(baseline, example.id) : null;
    if (baseline && (!base || base.abstained)) continue;
    const candCorrect = cand.productType === example.goldLabels.productType ? 1 : 0;
    const baseCorrect = baseline ? (base!.productType === example.goldLabels.productType ? 1 : 0) : 0;
    result.push({ exampleId: example.id, candidate: candCorrect, baseline: baseCorrect });
  }
  return result;
}

/**
 * Deterministic 95% paired bootstrap interval. Seeded from the candidate
 * bundle digest (plus an optional extra digest) so identical inputs produce
 * identical intervals.
 */
function computePairedBootstrap(
  pairs: PerExamplePrimaryMetric[],
  seedDigest: string,
  bootstrapRuns = 2000,
): { deltaMean: number; deltaLower95: number; deltaUpper95: number; bootstrapRuns: number } {
  if (pairs.length === 0) {
    return { deltaMean: 0, deltaLower95: 0, deltaUpper95: 0, bootstrapRuns: 0 };
  }
  const random = seededRandom(seedDigest);
  const deltas: number[] = [];
  for (let run = 0; run < bootstrapRuns; run++) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) {
      const idx = Math.floor(random() * pairs.length);
      sum += pairs[idx].candidate - pairs[idx].baseline;
    }
    deltas.push(sum / pairs.length);
  }
  deltas.sort((a, b) => a - b);
  const lower = deltas[Math.floor(deltas.length * 0.025)];
  const upper = deltas[Math.floor(deltas.length * 0.975)];
  const deltaMean = deltas.reduce((acc, d) => acc + d, 0) / deltas.length;
  return { deltaMean, deltaLower95: lower, deltaUpper95: upper, bootstrapRuns };
}

function computeEce(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): { ece: number; bins: EvalMetrics['calibration']['bins'] } {
  const binCount = 10;
  const bins = Array.from({ length: binCount }, () => ({ count: 0, correct: 0, confSum: 0 }));
  for (const example of gold) {
    if (!example.goldLabels.productType) continue;
    const pred = predictionForExample(predictions, example.id);
    if (!pred || pred.abstained || pred.productType === null || pred.confidence === null || pred.confidence === undefined) continue;
    const bin = Math.min(binCount - 1, Math.floor(pred.confidence * binCount));
    bins[bin].count++;
    if (pred.productType === example.goldLabels.productType) bins[bin].correct++;
    bins[bin].confSum += pred.confidence;
  }
  const total = bins.reduce((acc, b) => acc + b.count, 0);
  if (total === 0) return { ece: 0, bins: [] };
  let ece = 0;
  const outBins = bins
    .filter(b => b.count > 0)
    .map(b => {
      const accuracy = b.correct / b.count;
      const avgConfidence = b.confSum / b.count;
      ece += (b.count / total) * Math.abs(accuracy - avgConfidence);
      return { bin: bins.indexOf(b), count: b.count, accuracy, avgConfidence };
    });
  return { ece, bins: outBins };
}

// ─── Attribution detail (issue #294) ─────────────────────────────────────────
// Additive, pure reporting over the same frozen gold + immutable bundle that
// feeds `computeMetrics`. Legacy `EvalMetrics` values are untouched; this
// layer adds honest fixed-population attribution:
// - adjudicated gold states (known / no-fit / insufficient-evidence /
//   unlabeled; legacy gold without a marker scores by label presence),
// - semantic abstention tracked separately from service/validation failure
//   (failures earn no abstention credit) and from missing bundle entries
//   (legacy metrics count both shapes as abstained; this layer splits failures
//   and missing entries out so coverage stays honest),
// - fixed-population correctness/errors/coverage plus conditional accuracy
//   (the overlap-only paired bootstrap in `metrics.pairedDelta` stays as the
//   legacy interval; `baselineComparison.fixedDeltaMean` is its fixed-pop
//   companion and never drops dual-abstained examples),
// - family leakage across splits, snapshot-mismatch and duplicate/missing
//   entry attribution, and per-class labeled-support status.

export type EvaluatorExampleVerdict = 'correct' | 'incorrect' | 'abstained' | 'failed' | 'missing' | 'excluded';

/**
 * Score one example under its adjudicated gold state. `known` covers both the
 * explicit marker and legacy gold carrying a type; legacy gold without a type
 * scores as `unlabeled` (excluded, matching legacy metrics which skip it).
 * No-fit / insufficient-evidence gold expects semantic abstention: abstaining
 * is correct, any concrete prediction is a forced-guess error, and failures
 * or missing entries earn no abstention credit. A `known` marker with no
 * label is contradictory fixture data and scores as excluded.
 */
export function scoreEvaluatorExample(args: {
  goldState: EvaluatorGoldState | null;
  goldType: string | null;
  outcome: EvaluatorPredictionOutcome;
  predictedType: string | null | undefined;
}): EvaluatorExampleVerdict {
  const goldType = typeof args.goldType === 'string' ? args.goldType : null;
  if (args.goldState === EVALUATOR_GOLD_STATE_UNLABELED) return 'excluded';
  if (args.goldState === null && goldType === null) return 'excluded';
  if (
    args.goldState === EVALUATOR_GOLD_STATE_NO_FIT ||
    args.goldState === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE
  ) {
    if (args.outcome === EVALUATOR_OUTCOME_ABSTAINED) return 'correct';
    if (args.outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
    if (args.outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';
    return 'incorrect';
  }
  if (goldType === null) return 'excluded';
  if (args.outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
  if (args.outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';
  if (args.outcome === EVALUATOR_OUTCOME_ABSTAINED) return 'abstained';
  return args.predictedType === goldType ? 'correct' : 'incorrect';
}

/**
 * Score one field target under its adjudicated gold state (issue #298 / AC 8).
 *
 * States:
 * - `known`: expected to predict the gold value. Concrete match -> correct,
 *   different concrete value -> incorrect, abstained -> abstained.
 * - `no-fit` / `insufficient-evidence`: expected to abstain. Abstained -> correct,
 *   any concrete prediction -> incorrect (forced-guess error).
 * - `inapplicable` / `unlabeled`: excluded from the eligible denominator.
 *   Legacy gold with null value and no state marker also scores as excluded.
 */
export function scoreEvaluatorFieldExample(args: {
  goldState: EvaluatorFieldGoldState | null;
  goldValue: string | null | undefined;
  predictedValue: string | null | undefined;
  outcome?: EvaluatorPredictionOutcome;
}): EvaluatorExampleVerdict {
  const goldValue = typeof args.goldValue === 'string' && args.goldValue.trim() !== '' ? args.goldValue.trim() : null;
  const predValue = typeof args.predictedValue === 'string' && args.predictedValue.trim() !== '' ? args.predictedValue.trim() : null;

  if (args.goldState === EVALUATOR_FIELD_GOLD_STATE_UNLABELED || args.goldState === EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE) {
    return 'excluded';
  }
  if (args.goldState === null && goldValue === null) {
    return 'excluded';
  }
  if (args.outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
  if (args.outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';

  if (
    args.goldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT ||
    args.goldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE
  ) {
    if (predValue === null || args.outcome === EVALUATOR_OUTCOME_ABSTAINED) {
      return 'correct';
    }
    return 'incorrect';
  }

  // goldState === known or legacy gold with non-null goldValue
  if (predValue === null || args.outcome === EVALUATOR_OUTCOME_ABSTAINED) {
    return 'abstained';
  }
  return predValue === goldValue ? 'correct' : 'incorrect';
}

export interface EvaluatorFailedPrediction {
  exampleId: string;
  productSku: string;
  /** Trimmed failure code, or null when the entry failed without a code. */
  failureCode: string | null;
}

export interface EvaluatorSnapshotMismatch {
  exampleId: string;
  productSku: string;
  field: 'sourceProductHash' | 'configSnapshotHash';
  goldValue: string;
  predictionValue: string;
}

export interface EvaluatorFixedPopulation {
  /** Eligible examples: known + no-fit + insufficient-evidence (unlabeled excluded). */
  eligible: number;
  correct: number;
  /** Correct abstentions on no-fit / insufficient-evidence gold (subset of correct). */
  correctAbstentions: number;
  incorrect: number;
  /** Honest abstentions on known-type gold (neither correct nor error). */
  abstainedSemantic: number;
  failed: number;
  missing: number;
  /** correct / eligible. Failures lower correctness via the fixed denominator. */
  correctness: number;
  /** incorrect / eligible (failures lower correctness/coverage instead). */
  errorRate: number;
  abstentionRate: number;
  /** Share of eligible with a semantic answer (correct, incorrect, or abstained). */
  coverage: number;
  /** correct / (correct + incorrect + abstainedSemantic). */
  conditionalAccuracy: number;
}

export interface EvaluatorBaselineComparison {
  eligible: number;
  candidateCorrect: number;
  baselineCorrect: number;
  candidateCoverage: number;
  baselineCoverage: number;
  /** candidateCoverage - baselineCoverage (overlap-only deltas cannot conceal coverage shifts). */
  coverageShift: number;
  /** Mean(candidateCorrect - baselineCorrect) over the fixed eligible population. */
  fixedDeltaMean: number;
  /** Baseline abstained, candidate correct. */
  recoveredBaselineAbstentions: number;
  recoveredExampleIds: string[];
  /** Baseline correct, candidate not correct. */
  harmedBaselineSuccesses: number;
  harmedExampleIds: string[];
  retainedSuccesses: number;
  /** Both sides abstained (kept visible; overlap-only deltas drop these). */
  dualAbstentions: number;
  dualAbstainedExampleIds: string[];
}

export interface EvaluatorSupportStatus {
  eligibleExamples: number;
  labeledClasses: number;
  /** Standard gold-class counts over eligible known-type examples. */
  perClassGoldSupport: Record<string, number>;
  minClassSupport: number;
  requiredClassSupport: number;
  sufficient: boolean;
  reasons: string[];
}

export interface EvaluatorFamilyLeakageFinding {
  familyId: string;
  splits: string[];
}

export interface EvaluatorFamilyLeakage {
  leaked: boolean;
  findings: EvaluatorFamilyLeakageFinding[];
  /** Examples without a family id (ungrouped; cannot leak by construction). */
  ungroupedExamples: number;
}

export interface EvaluatorFieldAttributionReport {
  targetId: string;
  goldStates: {
    known: number;
    noFit: number;
    insufficientEvidence: number;
    inapplicable: number;
    unlabeled: number;
    legacy: number;
  };
  fixedPopulation: EvaluatorFixedPopulation;
  baselineComparison: EvaluatorBaselineComparison | null;
}

export interface EvaluatorAttributionReport {
  evaluatedSplit: 'test' | 'holdout';
  goldTotal: number;
  goldStates: {
    known: number;
    noFit: number;
    insufficientEvidence: number;
    unlabeled: number;
    /** Legacy gold without a state marker (scores by label presence). */
    legacy: number;
  };
  /** Candidate outcomes over the eligible fixed population. */
  predictionOutcomes: {
    predicted: number;
    abstainedSemantic: number;
    failed: number;
    missing: number;
  };
  failedPredictions: EvaluatorFailedPrediction[];
  missingExampleIds: string[];
  duplicateExampleIds: string[];
  unknownExampleIds: string[];
  snapshotMismatches: EvaluatorSnapshotMismatch[];
  fixedPopulation: EvaluatorFixedPopulation;
  /** Null when no baseline bundle was provided. */
  baselineComparison: EvaluatorBaselineComparison | null;
  support: EvaluatorSupportStatus;
  familyLeakage: EvaluatorFamilyLeakage;
  /** Field attribution reports keyed by field targetId (issue #298 / AC 8). */
  fieldReports?: Record<string, EvaluatorFieldAttributionReport>;
}

export interface ComputeAttributionOptions {
  splitGroup?: 'test' | 'holdout';
  /** Baseline predictions for the fixed-population comparison (null = none). */
  baselinePredictions?: BenchmarkPredictionEntry[] | null;
  /** Per-class labeled-support threshold (default 20, mirrors the gate default). */
  requiredClassSupport?: number;
  /**
   * Dataset-wide examples for leakage detection. Without it no leakage is
   * reported: a single split cannot show cross-split family sharing.
   */
  allSplitExamples?: Array<{ familyId: string | null; splitGroup: string | null }>;
}

/**
 * Pure fixed-population attribution. No database, no runs, no decisions:
 * everything needed rides in `gold` (frozen examples incl. state/family/
 * provenance) plus the immutable candidate/baseline bundles, so re-evaluating
 * an identical bundle after later review revisions yields identical output.
 */
export function computeEvaluatorAttribution(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  options: ComputeAttributionOptions = {},
): EvaluatorAttributionReport {
  const splitGroup = options.splitGroup ?? 'test';
  const goldIds = new Set(gold.map(example => example.id));
  const entriesById = new Map<string, BenchmarkPredictionEntry[]>();
  for (const entry of predictions) {
    const existing = entriesById.get(entry.exampleId);
    if (existing) existing.push(entry);
    else entriesById.set(entry.exampleId, [entry]);
  }
  const baselineById = new Map<string, BenchmarkPredictionEntry[]>();
  for (const entry of options.baselinePredictions ?? []) {
    const existing = baselineById.get(entry.exampleId);
    if (existing) existing.push(entry);
    else baselineById.set(entry.exampleId, [entry]);
  }

  const duplicateExampleIds = [...entriesById.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([id]) => id)
    .sort();
  const unknownExampleIds = [...entriesById.keys()].filter(id => !goldIds.has(id)).sort();

  let known = 0;
  let noFit = 0;
  let insufficientEvidence = 0;
  let unlabeled = 0;
  let legacy = 0;
  let predicted = 0;
  let abstainedSemantic = 0;
  let failed = 0;
  let missing = 0;
  let correct = 0;
  let correctAbstentions = 0;
  let incorrect = 0;
  let abstainedCount = 0;
  let failedCount = 0;
  let missingCount = 0;
  const failedPredictions: EvaluatorFailedPrediction[] = [];
  const missingExampleIds: string[] = [];
  const snapshotMismatches: EvaluatorSnapshotMismatch[] = [];
  const perClassGoldSupport: Record<string, number> = {};

  let candidateCorrect = 0;
  let baselineCorrect = 0;
  let candidateCoveredCount = 0;
  let baselineCoveredCount = 0;
  let deltaSum = 0;
  let comparisonEligible = 0;
  let recoveredBaselineAbstentions = 0;
  const recoveredExampleIds: string[] = [];
  let harmedBaselineSuccesses = 0;
  const harmedExampleIds: string[] = [];
  let retainedSuccesses = 0;
  let dualAbstentions = 0;
  const dualAbstainedExampleIds: string[] = [];
  const hasBaseline = options.baselinePredictions !== null && options.baselinePredictions !== undefined;

  for (const example of gold) {
    const state = example.goldState ?? null;
    if (state === null) legacy++;
    else if (state === EVALUATOR_GOLD_STATE_KNOWN) known++;
    else if (state === EVALUATOR_GOLD_STATE_NO_FIT) noFit++;
    else if (state === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE) insufficientEvidence++;
    else unlabeled++;

    const goldType = typeof example.goldLabels.productType === 'string' ? example.goldLabels.productType : null;
    const list = entriesById.get(example.id) ?? [];
    const entry = list.length > 0 ? list[0] : undefined;
    const outcome = classifyEvaluatorPredictionOutcome(entry);
    const verdict = scoreEvaluatorExample({ goldState: state, goldType, outcome, predictedType: entry?.productType });
    if (verdict === 'excluded') continue;

    if (outcome === EVALUATOR_OUTCOME_PREDICTED) predicted++;
    else if (outcome === EVALUATOR_OUTCOME_ABSTAINED) abstainedSemantic++;
    else if (outcome === EVALUATOR_OUTCOME_FAILED) failed++;
    else missing++;

    if (verdict === 'correct') {
      correct++;
      if (state === EVALUATOR_GOLD_STATE_NO_FIT || state === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE) {
        correctAbstentions++;
      }
    } else if (verdict === 'incorrect') {
      incorrect++;
    } else if (verdict === 'abstained') {
      abstainedCount++;
    } else if (verdict === 'failed') {
      failedCount++;
      let failureCode: string | null = null;
      const rawFailure = (entry as unknown as Record<string, unknown> | undefined)?.failureCode;
      if (typeof rawFailure === 'string' && rawFailure.trim() !== '') failureCode = rawFailure.trim();
      failedPredictions.push({ exampleId: example.id, productSku: example.productSku, failureCode });
    } else {
      missingCount++;
      missingExampleIds.push(example.id);
    }

    if (entry) {
      const rawProvenance = (entry as unknown as Record<string, unknown>).provenance;
      const provenanceRecord = rawProvenance !== null && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance)
        ? (rawProvenance as Record<string, unknown>)
        : null;
      const provenanceSourceProductHash = provenanceRecord !== null ? provenanceRecord.sourceProductHash : null;
      if (
        typeof provenanceSourceProductHash === 'string' && provenanceSourceProductHash !== '' &&
        typeof example.sourceProductHash === 'string' && example.sourceProductHash !== '' &&
        provenanceSourceProductHash !== example.sourceProductHash
      ) {
        snapshotMismatches.push({
          exampleId: example.id,
          productSku: example.productSku,
          field: 'sourceProductHash',
          goldValue: example.sourceProductHash,
          predictionValue: provenanceSourceProductHash,
        });
      }
      const provenanceConfigHash = provenanceRecord !== null ? provenanceRecord.configSnapshotHash : null;
      if (
        typeof provenanceConfigHash === 'string' && provenanceConfigHash !== '' &&
        typeof example.sourceConfigHash === 'string' && example.sourceConfigHash !== '' &&
        provenanceConfigHash !== example.sourceConfigHash
      ) {
        snapshotMismatches.push({
          exampleId: example.id,
          productSku: example.productSku,
          field: 'configSnapshotHash',
          goldValue: example.sourceConfigHash,
          predictionValue: provenanceConfigHash,
        });
      }
    }

    const isKnown = state === EVALUATOR_GOLD_STATE_KNOWN || (state === null && goldType !== null);
    if (isKnown && goldType !== null) {
      perClassGoldSupport[goldType] = (perClassGoldSupport[goldType] ?? 0) + 1;
    }

    if (hasBaseline) {
      const baseList = baselineById.get(example.id) ?? [];
      const baseEntry = baseList.length > 0 ? baseList[0] : undefined;
      const baseOutcome = classifyEvaluatorPredictionOutcome(baseEntry);
      const baseVerdict = scoreEvaluatorExample({
        goldState: state,
        goldType,
        outcome: baseOutcome,
        predictedType: baseEntry?.productType,
      });
      const candidateScore = verdict === 'correct' ? 1 : 0;
      const baselineScore = baseVerdict === 'correct' ? 1 : 0;
      const candCovered = verdict === 'correct' || verdict === 'incorrect' || verdict === 'abstained';
      const baseCovered = baseVerdict === 'correct' || baseVerdict === 'incorrect' || baseVerdict === 'abstained';
      if (candCovered) candidateCoveredCount++;
      if (baseCovered) baselineCoveredCount++;
      comparisonEligible++;
      candidateCorrect += candidateScore;
      baselineCorrect += baselineScore;
      deltaSum += candidateScore - baselineScore;
      if (baseVerdict === 'abstained' && verdict === 'correct') {
        recoveredBaselineAbstentions++;
        recoveredExampleIds.push(example.id);
      }
      if (baseVerdict === 'correct' && verdict !== 'correct') {
        harmedBaselineSuccesses++;
        harmedExampleIds.push(example.id);
      }
      if (baseVerdict === 'correct' && verdict === 'correct') retainedSuccesses++;
      if (baseVerdict === 'abstained' && verdict === 'abstained') {
        dualAbstentions++;
        dualAbstainedExampleIds.push(example.id);
      }
    }
  }

  const eligible = correct + incorrect + abstainedCount + failedCount + missingCount;
  const covered = correct + incorrect + abstainedCount;
  const fixedPopulation: EvaluatorFixedPopulation = {
    eligible,
    correct,
    correctAbstentions,
    incorrect,
    abstainedSemantic: abstainedCount,
    failed: failedCount,
    missing: missingCount,
    correctness: eligible > 0 ? correct / eligible : 0,
    errorRate: eligible > 0 ? incorrect / eligible : 0,
    abstentionRate: eligible > 0 ? abstainedCount / eligible : 0,
    coverage: eligible > 0 ? covered / eligible : 0,
    conditionalAccuracy: covered > 0 ? correct / covered : 0,
  };

  const candidateCoverage = comparisonEligible > 0 ? candidateCoveredCount / comparisonEligible : 0;
  const baselineCoverage = comparisonEligible > 0 ? baselineCoveredCount / comparisonEligible : 0;
  const baselineComparison: EvaluatorBaselineComparison | null = hasBaseline
    ? {
        eligible: comparisonEligible,
        candidateCorrect,
        baselineCorrect,
        candidateCoverage,
        baselineCoverage,
        coverageShift: candidateCoverage - baselineCoverage,
        fixedDeltaMean: comparisonEligible > 0 ? deltaSum / comparisonEligible : 0,
        recoveredBaselineAbstentions,
        recoveredExampleIds: recoveredExampleIds.sort(),
        harmedBaselineSuccesses,
        harmedExampleIds: harmedExampleIds.sort(),
        retainedSuccesses,
        dualAbstentions,
        dualAbstainedExampleIds: dualAbstainedExampleIds.sort(),
      }
    : null;

  const labeledClasses = Object.keys(perClassGoldSupport).sort();
  const orderedPerClassGoldSupport: Record<string, number> = {};
  for (const className of labeledClasses) {
    orderedPerClassGoldSupport[className] = perClassGoldSupport[className] ?? 0;
  }
  const minClassSupport = labeledClasses.length > 0
    ? Math.min(...labeledClasses.map(className => orderedPerClassGoldSupport[className] ?? 0))
    : 0;
  const requiredClassSupport = options.requiredClassSupport ?? 20;
  const supportReasons: string[] = [];
  if (eligible === 0) {
    supportReasons.push('no_eligible_examples: no labeled gold in the evaluated split');
  } else if (labeledClasses.length === 0) {
    supportReasons.push('no_labeled_classes: eligible examples carry no known-type labels');
  } else if (minClassSupport < requiredClassSupport) {
    supportReasons.push(
      `insufficient_class_support: min support ${minClassSupport} < ${requiredClassSupport} over ${labeledClasses.length} class(es)`,
    );
  }
  const support: EvaluatorSupportStatus = {
    eligibleExamples: eligible,
    labeledClasses: labeledClasses.length,
    perClassGoldSupport: orderedPerClassGoldSupport,
    minClassSupport,
    requiredClassSupport,
    sufficient: supportReasons.length === 0,
    reasons: supportReasons,
  };

  const familySplits = new Map<string, Set<string>>();
  let ungroupedExamples = 0;
  for (const splitExample of options.allSplitExamples ?? []) {
    const familyId = typeof splitExample.familyId === 'string' && splitExample.familyId.trim() !== ''
      ? splitExample.familyId
      : null;
    if (familyId === null) {
      ungroupedExamples++;
      continue;
    }
    const splitName = typeof splitExample.splitGroup === 'string' && splitExample.splitGroup !== ''
      ? splitExample.splitGroup
      : 'unknown';
    const splits = familySplits.get(familyId);
    if (splits) splits.add(splitName);
    else familySplits.set(familyId, new Set([splitName]));
  }
  const leakageFindings: EvaluatorFamilyLeakageFinding[] = [...familySplits.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([familyId, splits]) => ({ familyId, splits: [...splits].sort() }))
    .sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
  const familyLeakage: EvaluatorFamilyLeakage = {
    leaked: leakageFindings.length > 0,
    findings: leakageFindings,
    ungroupedExamples,
  };

  // ── Field fixed-population attribution & baseline comparison (issue #298 / AC 8)
  const allFieldTargetIds = new Set<string>();
  for (const example of gold) {
    for (const f of example.goldLabels.fieldAssignments ?? []) {
      if (f.targetId) allFieldTargetIds.add(f.targetId);
    }
    if (example.fieldGoldStates) {
      for (const tid of Object.keys(example.fieldGoldStates)) {
        allFieldTargetIds.add(tid);
      }
    }
  }
  for (const p of predictions) {
    for (const f of p.fieldAssignments ?? []) {
      if (f.targetId) allFieldTargetIds.add(f.targetId);
    }
  }
  for (const b of options.baselinePredictions ?? []) {
    for (const f of b.fieldAssignments ?? []) {
      if (f.targetId) allFieldTargetIds.add(f.targetId);
    }
  }

  const fieldReports: Record<string, EvaluatorFieldAttributionReport> = {};

  for (const targetId of [...allFieldTargetIds].sort()) {
    let fKnown = 0;
    let fNoFit = 0;
    let fInsufficientEvidence = 0;
    let fInapplicable = 0;
    let fUnlabeled = 0;
    let fLegacy = 0;

    let fCorrect = 0;
    let fCorrectAbstentions = 0;
    let fIncorrect = 0;
    let fAbstainedCount = 0;
    let fFailedCount = 0;
    let fMissingCount = 0;

    let fComparisonEligible = 0;
    let fCandidateCorrect = 0;
    let fBaselineCorrect = 0;
    let fCandidateCoveredCount = 0;
    let fBaselineCoveredCount = 0;
    let fDeltaSum = 0;
    let fRecoveredBaselineAbstentions = 0;
    const fRecoveredExampleIds: string[] = [];
    let fHarmedBaselineSuccesses = 0;
    const fHarmedExampleIds: string[] = [];
    let fRetainedSuccesses = 0;
    let fDualAbstentions = 0;
    const fDualAbstainedExampleIds: string[] = [];

    for (const example of gold) {
      const fieldState = example.fieldGoldStates?.[targetId] ?? null;
      const goldField = example.goldLabels.fieldAssignments?.find(f => f.targetId === targetId);
      const goldVal = goldField ? goldField.value : null;

      if (fieldState === null) {
        if (goldVal !== null && goldVal !== undefined) fLegacy++;
        else fUnlabeled++;
      } else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_KNOWN) fKnown++;
      else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT) fNoFit++;
      else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE) fInsufficientEvidence++;
      else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE) fInapplicable++;
      else fUnlabeled++;

      const predList = entriesById.get(example.id) ?? [];
      const predEntry = predList.length > 0 ? predList[0] : undefined;
      const predField = predEntry?.fieldAssignments?.find(f => f.targetId === targetId);
      const predVal = predField ? predField.value : null;

      let outcome: EvaluatorPredictionOutcome;
      if (!predEntry) {
        outcome = EVALUATOR_OUTCOME_MISSING;
      } else {
        const raw = predEntry as unknown as Record<string, unknown>;
        if (typeof raw.failureCode === 'string' && raw.failureCode.trim() !== '') {
          outcome = EVALUATOR_OUTCOME_FAILED;
        } else if (raw.outcome === 'failed') {
          outcome = EVALUATOR_OUTCOME_FAILED;
        } else if (predVal === null) {
          outcome = EVALUATOR_OUTCOME_ABSTAINED;
        } else {
          outcome = EVALUATOR_OUTCOME_PREDICTED;
        }
      }

      const verdict = scoreEvaluatorFieldExample({
        goldState: fieldState,
        goldValue: goldVal,
        predictedValue: predVal,
        outcome,
      });

      if (verdict === 'excluded') continue;

      if (verdict === 'correct') {
        fCorrect++;
        if (fieldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT || fieldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE) {
          fCorrectAbstentions++;
        }
      } else if (verdict === 'incorrect') {
        fIncorrect++;
      } else if (verdict === 'abstained') {
        fAbstainedCount++;
      } else if (verdict === 'failed') {
        fFailedCount++;
      } else if (verdict === 'missing') {
        fMissingCount++;
      }

      if (hasBaseline) {
        const baseList = baselineById.get(example.id) ?? [];
        const baseEntry = baseList.length > 0 ? baseList[0] : undefined;
        const baseField = baseEntry?.fieldAssignments?.find(f => f.targetId === targetId);
        const baseVal = baseField ? baseField.value : null;

        let baseOutcome: EvaluatorPredictionOutcome;
        if (!baseEntry) {
          baseOutcome = EVALUATOR_OUTCOME_MISSING;
        } else {
          const rawBase = baseEntry as unknown as Record<string, unknown>;
          if (typeof rawBase.failureCode === 'string' && rawBase.failureCode.trim() !== '') {
            baseOutcome = EVALUATOR_OUTCOME_FAILED;
          } else if (rawBase.outcome === 'failed') {
            baseOutcome = EVALUATOR_OUTCOME_FAILED;
          } else if (baseVal === null) {
            baseOutcome = EVALUATOR_OUTCOME_ABSTAINED;
          } else {
            baseOutcome = EVALUATOR_OUTCOME_PREDICTED;
          }
        }

        const baseVerdict = scoreEvaluatorFieldExample({
          goldState: fieldState,
          goldValue: goldVal,
          predictedValue: baseVal,
          outcome: baseOutcome,
        });

        const candidateScore = verdict === 'correct' ? 1 : 0;
        const baselineScore = baseVerdict === 'correct' ? 1 : 0;
        const candCovered = verdict === 'correct' || verdict === 'incorrect' || verdict === 'abstained';
        const baseCovered = baseVerdict === 'correct' || baseVerdict === 'incorrect' || baseVerdict === 'abstained';
        if (candCovered) fCandidateCoveredCount++;
        if (baseCovered) fBaselineCoveredCount++;
        fComparisonEligible++;
        fCandidateCorrect += candidateScore;
        fBaselineCorrect += baselineScore;
        fDeltaSum += candidateScore - baselineScore;
        if (baseVerdict === 'abstained' && verdict === 'correct') {
          fRecoveredBaselineAbstentions++;
          fRecoveredExampleIds.push(example.id);
        }
        if (baseVerdict === 'correct' && verdict !== 'correct') {
          fHarmedBaselineSuccesses++;
          fHarmedExampleIds.push(example.id);
        }
        if (baseVerdict === 'correct' && verdict === 'correct') fRetainedSuccesses++;
        if (baseVerdict === 'abstained' && verdict === 'abstained') {
          fDualAbstentions++;
          fDualAbstainedExampleIds.push(example.id);
        }
      }
    }

    const fEligible = fCorrect + fIncorrect + fAbstainedCount + fFailedCount + fMissingCount;
    const fCovered = fCorrect + fIncorrect + fAbstainedCount;
    const fixedPopulation: EvaluatorFixedPopulation = {
      eligible: fEligible,
      correct: fCorrect,
      correctAbstentions: fCorrectAbstentions,
      incorrect: fIncorrect,
      abstainedSemantic: fAbstainedCount,
      failed: fFailedCount,
      missing: fMissingCount,
      correctness: fEligible > 0 ? fCorrect / fEligible : 0,
      errorRate: fEligible > 0 ? fIncorrect / fEligible : 0,
      abstentionRate: fEligible > 0 ? fAbstainedCount / fEligible : 0,
      coverage: fEligible > 0 ? fCovered / fEligible : 0,
      conditionalAccuracy: fCovered > 0 ? fCorrect / fCovered : 0,
    };

    const candidateCoverage = fComparisonEligible > 0 ? fCandidateCoveredCount / fComparisonEligible : 0;
    const baselineCoverage = fComparisonEligible > 0 ? fBaselineCoveredCount / fComparisonEligible : 0;
    const baselineComparison: EvaluatorBaselineComparison | null = hasBaseline
      ? {
          eligible: fComparisonEligible,
          candidateCorrect: fCandidateCorrect,
          baselineCorrect: fBaselineCorrect,
          candidateCoverage,
          baselineCoverage,
          coverageShift: candidateCoverage - baselineCoverage,
          fixedDeltaMean: fComparisonEligible > 0 ? fDeltaSum / fComparisonEligible : 0,
          recoveredBaselineAbstentions: fRecoveredBaselineAbstentions,
          recoveredExampleIds: fRecoveredExampleIds.sort(),
          harmedBaselineSuccesses: fHarmedBaselineSuccesses,
          harmedExampleIds: fHarmedExampleIds.sort(),
          retainedSuccesses: fRetainedSuccesses,
          dualAbstentions: fDualAbstentions,
          dualAbstainedExampleIds: fDualAbstainedExampleIds.sort(),
        }
      : null;

    fieldReports[targetId] = {
      targetId,
      goldStates: {
        known: fKnown,
        noFit: fNoFit,
        insufficientEvidence: fInsufficientEvidence,
        inapplicable: fInapplicable,
        unlabeled: fUnlabeled,
        legacy: fLegacy,
      },
      fixedPopulation,
      baselineComparison,
    };
  }

  return {
    evaluatedSplit: splitGroup,
    goldTotal: gold.length,
    goldStates: { known, noFit, insufficientEvidence, unlabeled, legacy },
    predictionOutcomes: { predicted, abstainedSemantic, failed, missing },
    failedPredictions: failedPredictions.sort((a, b) => (a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : 0)),
    missingExampleIds: missingExampleIds.sort(),
    duplicateExampleIds,
    unknownExampleIds,
    snapshotMismatches: snapshotMismatches.sort((a, b) => (
      a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : a.field < b.field ? -1 : 1
    )),
    fixedPopulation,
    baselineComparison,
    support,
    familyLeakage,
    fieldReports,
  };
}

/**
 * Pure metrics computation. No database, no runs, no decisions.
 */
function computeMetrics(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  options: ComputeMetricsOptions = {},
): EvalMetrics {
  const metrics = defaultMetrics();
  const controlledValues = options.controlledValues ?? {};
  const primaryMetric = options.primaryMetric ?? 'productType.top1Accuracy';
  const bootstrapRuns = options.bootstrapRuns ?? 2000;

  // ── Product Type ───────────────────────────────────────────────────────────
  let eligible = 0;
  let evaluated = 0;
  let correct = 0;
  const classStats: Record<string, { gold: number; correct: number; predicted: number }> = {};
  const confusionMap: Record<string, number> = {};
  let abstained = 0;

  for (const example of gold) {
    const goldType = example.goldLabels.productType;
    const pred = predictionForExample(predictions, example.id);

    if (pred?.abstained || pred?.productType === null || pred?.productType === undefined) {
      if (goldType) {
        eligible++;
        abstained++;
      }
      continue;
    }
    if (!goldType) continue;

    eligible++;
    evaluated++;
    classStats[goldType] = classStats[goldType] ?? { gold: 0, correct: 0, predicted: 0 };
    classStats[goldType].gold++;
    if (pred.productType === goldType) {
      correct++;
      classStats[goldType].correct++;
    }
    if (pred.productType) {
      classStats[pred.productType] = classStats[pred.productType] ?? { gold: 0, correct: 0, predicted: 0 };
      classStats[pred.productType].predicted++;
      if (pred.productType !== goldType) {
        const pairKey = `${goldType} -> ${pred.productType}`;
        confusionMap[pairKey] = (confusionMap[pairKey] ?? 0) + 1;
      }
    }
  }

  metrics.productType.support = evaluated;
  metrics.productType.coverage = eligible > 0 ? evaluated / eligible : 0;
  metrics.productType.top1Accuracy = evaluated > 0 ? correct / evaluated : 0;
  // INTENTIONAL (M9 review note): per-class support is reported conservatively
  // as min(gold, predicted) rather than the standard gold-class count. This
  // UNDER-reports support for under-predicted classes, which makes the
  // qualification gate reject those classes more aggressively — a fail-closed
  // bias, never a license to pass. Standard "support = gold count" consumers
  // should use the classStats breakdown when a non-conservative reading is
  // required.
  metrics.productType.perClassSupport = Object.fromEntries(
    Object.entries(classStats).map(([cls, s]) => [cls, Math.min(s.gold, s.correct + (s.predicted - Math.min(s.gold, s.correct)))]),
  );

  // Macro F1 from class-level precision/recall.
  let macroF1Sum = 0;
  let classCount = 0;
  for (const stats of Object.values(classStats)) {
    const precision = stats.predicted > 0 ? stats.correct / stats.predicted : 0;
    const recall = stats.gold > 0 ? stats.correct / stats.gold : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    macroF1Sum += f1;
    classCount++;
  }
  metrics.productType.macroF1 = classCount > 0 ? macroF1Sum / classCount : 0;
  metrics.productType.confusionPairs = Object.entries(confusionMap).map(([key, count]) => {
    const [g, p] = key.split(' -> ');
    return [g, p, count] as [string, string, number];
  });

  // ── Abstention ─────────────────────────────────────────────────────────────
  metrics.abstention.abstainedPercent = gold.length > 0 ? (abstained / gold.length) * 100 : 0;
  const nonAbstained = evaluated;
  metrics.abstention.accuracyOfNonAbstained = nonAbstained > 0 ? correct / nonAbstained : 0;

  // ── Pages ──────────────────────────────────────────────────────────────────
  const goldPagesExist = gold.some(example => example.goldLabels.pageAssignments.length > 0);
  let pagePrecisionSum = 0;
  let pageRecallSum = 0;
  let exactMatches = 0;
  let pageEvaluated = 0;

  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const goldPages = new Set(example.goldLabels.pageAssignments.map(p => p.pageName));
    const predPages = new Set((pred?.pageAssignments ?? []).filter((v): v is string => Boolean(v)));
    if (goldPages.size === 0 && predPages.size === 0) continue;
    pageEvaluated++;
    let hits = 0;
    for (const page of predPages) if (goldPages.has(page)) hits++;
    pagePrecisionSum += predPages.size > 0 ? hits / predPages.size : 0;
    pageRecallSum += goldPages.size > 0 ? hits / goldPages.size : 0;
    if (goldPages.size === predPages.size && [...goldPages].every(p => predPages.has(p))) exactMatches++;
  }

  metrics.pages.precisionAtK = pageEvaluated > 0 ? pagePrecisionSum / pageEvaluated : 0;
  metrics.pages.recallAtK = pageEvaluated > 0 ? pageRecallSum / pageEvaluated : 0;
  metrics.pages.exactSetAccuracy = pageEvaluated > 0 ? exactMatches / pageEvaluated : 0;
  metrics.pages.blocked = goldPagesExist;
  metrics.pages.blockedReason = goldPagesExist ? 'blocked_missing_verified_page_gold' : null;

  // ── Fields ─────────────────────────────────────────────────────────────────
  const fieldStats: Record<string, { support: number; correct: number }> = {};
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const predFields = new Map((pred?.fieldAssignments ?? []).map(f => [f.targetId, f.value]));
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      fieldStats[goldField.targetId] = fieldStats[goldField.targetId] ?? { support: 0, correct: 0 };
      fieldStats[goldField.targetId].support++;
      const predicted = predFields.get(goldField.targetId);
      if (predicted === goldField.value) fieldStats[goldField.targetId].correct++;
    }
  }
  metrics.fields.targetSupport = Object.fromEntries(Object.entries(fieldStats).map(([t, s]) => [t, s.support]));
  metrics.fields.targetAccuracy = Object.fromEntries(
    Object.entries(fieldStats).map(([t, s]) => [t, s.support > 0 ? s.correct / s.support : 0]),
  );

  // ── Operations: corrections per hundred ────────────────────────────────────
  let totalCorrections = 0;
  let totalFieldProposals = 0;
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const predFields = new Map((pred?.fieldAssignments ?? []).map(f => [f.targetId, f.value]));
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      totalFieldProposals++;
      const predicted = predFields.get(goldField.targetId);
      if (predicted !== null && predicted !== undefined && predicted !== goldField.value) {
        totalCorrections++;
      }
    }
  }
  metrics.operations.correctionsPerHundred = totalFieldProposals > 0 ? (totalCorrections / totalFieldProposals) * 100 : 0;

  // ── Safety ─────────────────────────────────────────────────────────────────
  const crossSpeciesExamples: string[] = [];
  for (const example of gold) {
    const goldSpecies = speciesOfType(example.goldLabels.productType);
    const pred = predictionForExample(predictions, example.id);
    for (const page of pred?.pageAssignments ?? []) {
      const lower = page.toLowerCase();
      if (goldSpecies.dog && /\bcat\b/.test(lower) && !/\bdog\b/.test(lower)) {
        metrics.safety.crossSpeciesCount++;
        crossSpeciesExamples.push(`${example.productSku}: Dog product on page '${page}'`);
      } else if (goldSpecies.cat && /\bdog\b/.test(lower) && !/\bcat\b/.test(lower)) {
        metrics.safety.crossSpeciesCount++;
        crossSpeciesExamples.push(`${example.productSku}: Cat product on page '${page}'`);
      }
    }

    // Claim-safety: asserting a value for a claim-sensitive target without
    // linked evidence in the bundle is a violation.
    for (const claimTarget of pred?.claimTargets ?? []) {
      const asserted = (pred?.fieldAssignments ?? []).some(f => f.targetId === claimTarget && f.value !== null && f.value !== undefined);
      if (asserted) metrics.safety.claimSafetyViolations++;
    }

    // Controlled-value: a predicted value outside the declared vocabulary.
    for (const field of pred?.fieldAssignments ?? []) {
      const allowed = controlledValues[field.targetId];
      if (field.value !== null && field.value !== undefined && allowed && allowed.length > 0 && !allowed.includes(field.value)) {
        metrics.safety.controlledValueViolations++;
      }
    }
  }
  metrics.safety.crossSpeciesExamples = crossSpeciesExamples;

  // ── Calibration (ECE over non-abstained product-type predictions) ─────────
  metrics.calibration = computeEce(gold, predictions);

  // ── Paired delta (candidate vs baseline; default abstention baseline) ─────
  const pairs = computePerExamplePrimaryMetric(gold, predictions, options.baselinePredictions ?? null);
  const seedDigest = options.pairedSeedDigest ?? '0000000000000000000000000000000000000000000000000000000000000000';
  const bootstrap = computePairedBootstrap(pairs, seedDigest, bootstrapRuns);
  metrics.pairedDelta = {
    primaryMetric,
    deltaMean: bootstrap.deltaMean,
    deltaLower95: bootstrap.deltaLower95,
    deltaUpper95: bootstrap.deltaUpper95,
    bootstrapRuns: bootstrap.bootstrapRuns,
  };

  return metrics;
}

// ─── DB-backed wrapper ─────────────────────────────────────────────────────────

export interface EvaluateBenchmarkOptions {
  runLabel: string;
  splitGroup?: 'test' | 'holdout';
  predictionBundleId?: string;
  baselineBundleId?: string;
  qualification?: QualificationGateOptions;
  controlledValues?: ControlledValues;
  bootstrapRuns?: number;
}

export interface EvaluateBenchmarkResult {
  evalRunId: string;
  metrics: EvalMetrics;
  qualification: QualificationResult;
  holdoutSize: number;
  predictionBundleId: string;
  bundleHash: string;
  receiptDigest: string;
  receiptId: string;
  /**
   * Per-bundle source provenance (additive, issue #294). Candidate bundle
   * provenance; legacy reviewed-outcome artifacts resolve as
   * `reviewed_outcome`/0 and are labeled ineligible for raw-accuracy
   * qualification via `eligibleForRawAccuracyQualification`.
   */
  bundleProvenance: EvaluatorBundleProvenance;
  /** Baseline bundle provenance; null when no baseline bundle was provided. */
  baselineBundleProvenance: EvaluatorBundleProvenance | null;
  /** Fixed-population attribution over the same frozen gold + bundle. */
  attribution: EvaluatorAttributionReport;
}

/** Structural shape of a loaded bundle incl. in-flight additive source fields. */
interface LoadedBundleShape {
  bundleId: string;
  predictions: BenchmarkPredictionEntry[];
  bundleHash: string;
  source?: unknown;
  bundleVersion?: unknown;
}

export async function evaluateBenchmark(
  datasetId: string,
  options: EvaluateBenchmarkOptions,
  workspaceId?: string,
): Promise<EvaluateBenchmarkResult> {
  const splitGroup = options.splitGroup ?? 'test';

  // Workspace-scoped lookup (M9 review note): a direct caller cannot evaluate
  // a foreign workspace's frozen dataset. The routes pre-check ownership too.
  const dataset = workspaceId
    ? benchmarkRepo.getDatasetForWorkspace(datasetId, workspaceId)
    : benchmarkRepo.getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Evaluation requires a frozen dataset; dataset is ${dataset.status}.`);
  }
  const effectiveWorkspaceId = dataset.workspace_id;

  // Frozen gold + persisted bundle only — no current-run access. Later review
  // revisions cannot alter this evaluation: labels come from the frozen
  // examples and predictions from the immutable bundle, so re-evaluating an
  // identical bundle yields identical metrics and attribution.
  const goldExamples = benchmarkRepo.getExamples(datasetId, splitGroup);
  const gold: GoldExampleForEvaluation[] = goldExamples.map(example => {
    const goldLabels = JSON.parse(example.gold_labels_json) as BenchmarkGoldLabels;
    let evidenceText = '';
    try {
      const snapshot = JSON.parse(example.input_snapshot_json || '{}') as { evidence?: Array<{ snippet?: string }> };
      evidenceText = (snapshot.evidence ?? []).map(e => e.snippet ?? '').join(' ').toLowerCase();
    } catch { /* evidence text is best-effort for heuristics only */ }
    return {
      id: example.id,
      productSku: example.product_sku,
      goldLabels,
      evidenceText,
      goldState: readEvaluatorGoldState(example.gold_labels_json),
      familyId: example.product_family_id ?? null,
      splitGroup: example.split_group ?? null,
      sourceRunId: example.source_run_id ?? null,
      sourceConfigHash: example.source_config_hash ?? null,
      sourceProductHash: example.source_product_hash ?? null,
    };
  });

  const loaded = loadPredictionBundle(effectiveWorkspaceId, datasetId, options.predictionBundleId, splitGroup) as LoadedBundleShape;
  const bundleId = loaded.bundleId;
  const predictions = loaded.predictions;
  const bundleHash = loaded.bundleHash;
  // Structural fallback: the persisted JSON distinguishes legacy arrays
  // (reviewed_outcome) from pre-review envelopes without trusting callers.
  const bundleProvenance = describeEvaluatorBundleProvenance(
    benchmarkRepo.getPredictionBundle(bundleId)?.predictions_json,
    { source: loaded.source, bundleVersion: loaded.bundleVersion },
  );


  let baselinePredictions: BenchmarkPredictionEntry[] | undefined;
  let baselineBundleProvenance: EvaluatorBundleProvenance | null = null;
  if (options.baselineBundleId) {
    const baselineLoaded = loadPredictionBundle(effectiveWorkspaceId, datasetId, options.baselineBundleId, splitGroup) as LoadedBundleShape;
    baselinePredictions = baselineLoaded.predictions;
    baselineBundleProvenance = describeEvaluatorBundleProvenance(
      benchmarkRepo.getPredictionBundle(baselineLoaded.bundleId)?.predictions_json,
      { source: baselineLoaded.source, bundleVersion: baselineLoaded.bundleVersion },
    );
  }

  const metrics = computeMetrics(gold, predictions, {
    controlledValues: options.controlledValues,
    pairedSeedDigest: bundleHash + (options.baselineBundleId ?? ''),
    baselinePredictions,
    primaryMetric: 'productType.top1Accuracy',
    bootstrapRuns: options.bootstrapRuns ?? 2000,
  });

  const holdoutSize = benchmarkRepo.getExamples(datasetId, 'holdout').length;
  const qualification = evaluateQualificationGate(metrics, holdoutSize, options.qualification);

  // Persist the content-addressed receipt.
  const datasetHash = dataset.dataset_hash ?? '';
  const payload = buildQualificationReceiptPayload({
    datasetId,
    datasetHash,
    predictionBundleId: bundleId,
    bundleHash,
    holdoutSize,
    metrics,
    qualification,
  });
  const receiptDigest = buildQualificationReceiptDigest(payload);
  const receiptId = createQualificationReceiptId();
  benchmarkRepo.insertQualificationReceipt({
    datasetId,
    datasetHash,
    predictionBundleId: bundleId,
    bundleHash,
    holdoutSize,
    coverage: metrics.productType.coverage,
    minClassSupport: Object.values(metrics.productType.perClassSupport).length > 0
      ? Math.min(...Object.values(metrics.productType.perClassSupport))
      : 0,
    violations: {
      crossSpecies: metrics.safety.crossSpeciesCount,
      claimSafety: metrics.safety.claimSafetyViolations,
      controlledValue: metrics.safety.controlledValueViolations,
    },
    primaryMetric: metrics.pairedDelta.primaryMetric,
    deltaLower95: metrics.pairedDelta.deltaLower95,
    nonRegressionFloorsMet: qualification.gate.nonRegressionFloorsMet,
    qualified: qualification.qualified,
    reasons: qualification.reasons,
    digest: receiptDigest,
    generatedBy: null,
  });

  const evalRunId = benchmarkRepo.insertEvalRun(
    datasetId,
    options.runLabel,
    null,
    JSON.stringify(metrics),
    bundleId,
  );

  // Attribution reads the same frozen rows, so family leakage sees every
  // split while scoring stays scoped to the evaluated split.
  const allSplitExamples = benchmarkRepo.getExamples(datasetId).map(row => ({
    familyId: row.product_family_id ?? null,
    splitGroup: row.split_group ?? null,
  }));
  const attribution = computeEvaluatorAttribution(gold, predictions, {
    splitGroup,
    baselinePredictions: baselinePredictions ?? null,
    allSplitExamples,
  });

  return {
    evalRunId,
    metrics,
    qualification,
    holdoutSize,
    predictionBundleId: bundleId,
    bundleHash,
    receiptDigest,
    receiptId,
    bundleProvenance,
    baselineBundleProvenance,
    attribution,
  };
}
