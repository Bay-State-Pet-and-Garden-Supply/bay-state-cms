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
import {
  classifyPredictionOutcome,
  deriveBaselineComparison,
  deriveFixedPopulation,
  deriveSupportStatus,
  detectSharedFamilyLeakage,
  emptyBaselineComparisonAccumulator,
  emptyFixedPopulationCounts,
  emptyPageComparisonCounters,
  extractFailureCode,
  finalizePageComparisonSummary,
  goldPageIdsOf,
  goldPageNamesOf,
  groupPredictionsByExampleId,
  indexPredictionsByExampleId,
  lookupStateAlias,
  pageItemsOf,
  pageProvenanceOf,
  recordBaselinePair,
  resolvePageIdentityCapability,
  scorePageSet,
  sortedIds,
  supportReasonsFor,
  type BaselineComparisonAccumulator,
  type FixedPopulationCounts,
  type PageComparisonCounters,
  type SharedPageComparisonSummary,
} from './benchmark-scoring-helpers';

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
const EVALUATOR_GOLD_STATES = [
  EVALUATOR_GOLD_STATE_KNOWN,
  EVALUATOR_GOLD_STATE_NO_FIT,
  EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  EVALUATOR_GOLD_STATE_UNLABELED,
] as const;
export type EvaluatorGoldState = (typeof EVALUATOR_GOLD_STATES)[number];
/** Gold-labels JSON field carrying the adjudicated gold state. */
const EVALUATOR_GOLD_STATE_FIELD = 'productTypeState' as const;

/**
 * Alias table for adjudicated product-type gold states. Accepts the canonical
 * exporter spellings (`known`, `no-fit`, `insufficient-evidence`, `unlabeled`)
 * plus the ticket aliases (`known-type`, `no-fitting-type`); unknown values
 * and non-strings yield null (legacy handling).
 */
const EVALUATOR_GOLD_STATE_ALIASES: Record<string, EvaluatorGoldState> = {
  known: EVALUATOR_GOLD_STATE_KNOWN,
  'known-type': EVALUATOR_GOLD_STATE_KNOWN,
  'no-fit': EVALUATOR_GOLD_STATE_NO_FIT,
  'no-fitting-type': EVALUATOR_GOLD_STATE_NO_FIT,
  'no-fit-type': EVALUATOR_GOLD_STATE_NO_FIT,
  nofit: EVALUATOR_GOLD_STATE_NO_FIT,
  'insufficient-evidence': EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  insufficientevidence: EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  unlabeled: EVALUATOR_GOLD_STATE_UNLABELED,
  unlabelled: EVALUATOR_GOLD_STATE_UNLABELED,
};

/** Normalize adjudicated state spellings via the shared alias table. */
function normalizeEvaluatorGoldState(value: unknown): EvaluatorGoldState | null {
  return lookupStateAlias(value, EVALUATOR_GOLD_STATE_ALIASES);
}

/** Read the adjudicated gold state; null for legacy gold without a marker. */
function readEvaluatorGoldState(goldLabelsJson: string): EvaluatorGoldState | null {
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
const EVALUATOR_FIELD_GOLD_STATE_NO_FIT = 'no-fit' as const;
const EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
const EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE = 'inapplicable' as const;
const EVALUATOR_FIELD_GOLD_STATE_UNLABELED = 'unlabeled' as const;
const EVALUATOR_FIELD_GOLD_STATES = [
  EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE,
  EVALUATOR_FIELD_GOLD_STATE_UNLABELED,
] as const;
export type EvaluatorFieldGoldState = (typeof EVALUATOR_FIELD_GOLD_STATES)[number];
const EVALUATOR_FIELD_GOLD_STATES_FIELD = 'fieldStates' as const;

const EVALUATOR_FIELD_GOLD_STATE_ALIASES: Record<string, EvaluatorFieldGoldState> = {
  known: EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  'known-type': EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  'known-value': EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  'no-fit': EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  'no-fitting-type': EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  'no-fit-type': EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  nofit: EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  'no-fitting': EVALUATOR_FIELD_GOLD_STATE_NO_FIT,
  'insufficient-evidence': EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  insufficientevidence: EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  inapplicable: EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE,
  'not-applicable': EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE,
  na: EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE,
  unlabeled: EVALUATOR_FIELD_GOLD_STATE_UNLABELED,
  unlabelled: EVALUATOR_FIELD_GOLD_STATE_UNLABELED,
};

function normalizeEvaluatorFieldGoldState(value: unknown): EvaluatorFieldGoldState | null {
  return lookupStateAlias(value, EVALUATOR_FIELD_GOLD_STATE_ALIASES);
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
const EVALUATOR_OUTCOME_ABSTAINED = 'abstained-semantic' as const;
const EVALUATOR_OUTCOME_FAILED = 'failed' as const;
const EVALUATOR_OUTCOME_MISSING = 'missing' as const;
export type EvaluatorPredictionOutcome =
  | typeof EVALUATOR_OUTCOME_PREDICTED
  | typeof EVALUATOR_OUTCOME_ABSTAINED
  | typeof EVALUATOR_OUTCOME_FAILED
  | typeof EVALUATOR_OUTCOME_MISSING;


/** Classify one bundle entry; undefined (no entry for the gold id) is missing. */
function classifyEvaluatorPredictionOutcome(
  entry: BenchmarkPredictionEntry | undefined | null,
): EvaluatorPredictionOutcome {
  return classifyPredictionOutcome(entry);
}

// ─── Bundle source/version contract (issue #294) ────────────────────────────
// New raw bundles carry `source: 'prereview_raw'` + version 1; legacy
// reviewed-outcome bundles are plain arrays (version 0). Values mirror
// benchmark-prediction.ts without importing it (parallel ownership).
const EVALUATOR_PRE_REVIEW_SOURCE = 'prereview_raw' as const;
const EVALUATOR_REVIEWED_OUTCOME_SOURCE = 'reviewed_outcome' as const;
const EVALUATOR_PRE_REVIEW_BUNDLE_VERSION = 1 as const;
const EVALUATOR_LEGACY_BUNDLE_VERSION = 0 as const;
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

/** Resolve provenance from the loader-provided source/version hint, if usable. */
function provenanceFromLoaderHint(
  loaderHint?: { source?: unknown; bundleVersion?: unknown },
): EvaluatorBundleProvenance | null {
  const hintSource = loaderHint?.source;
  const hintVersion = loaderHint?.bundleVersion;
  if (hintSource !== EVALUATOR_PRE_REVIEW_SOURCE && hintSource !== EVALUATOR_REVIEWED_OUTCOME_SOURCE) {
    return null;
  }
  const version = typeof hintVersion === 'number' && Number.isFinite(hintVersion)
    ? hintVersion
    : hintSource === EVALUATOR_PRE_REVIEW_SOURCE
      ? EVALUATOR_PRE_REVIEW_BUNDLE_VERSION
      : EVALUATOR_LEGACY_BUNDLE_VERSION;
  return evaluatorProvenanceFor(hintSource, version);
}

/** Parse a persisted bundle payload; null when it is not parseable JSON. */
function parsePersistedBundleJson(persistedJson: unknown): unknown | null {
  if (typeof persistedJson !== 'string') return persistedJson;
  try {
    return JSON.parse(persistedJson) as unknown;
  } catch {
    return null;
  }
}

/** Resolve provenance by structural detection of the persisted JSON. */
function provenanceFromPersistedJson(persistedJson: unknown): EvaluatorBundleProvenance {
  const parsed = parsePersistedBundleJson(persistedJson);
  if (parsed === null && typeof persistedJson === 'string') {
    return evaluatorProvenanceFor('unknown', -1);
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

/**
 * Resolve per-bundle source provenance. Prefers the loader-provided
 * source/version hint (new `loadPredictionBundle` shape) and falls back to
 * structural detection of the persisted JSON (array = legacy
 * reviewed-outcome; `{ source: 'prereview_raw', version: 1, predictions }`
 * = pre-review). Anything else resolves to `unknown` (fail closed downstream).
 */
function describeEvaluatorBundleProvenance(
  persistedJson: unknown,
  loaderHint?: { source?: unknown; bundleVersion?: unknown },
): EvaluatorBundleProvenance {
  return provenanceFromLoaderHint(loaderHint) ?? provenanceFromPersistedJson(persistedJson);
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

/** Candidate correctness for the paired metric (null when unpaired). */
function pairedCandidateCorrectness(
  example: GoldExampleForEvaluation,
  candidate: BenchmarkPredictionEntry[],
): number | null {
  if (!example.goldLabels.productType) return null;
  const cand = predictionForExample(candidate, example.id);
  if (!cand || cand.abstained || cand.productType === null) return null;
  return cand.productType === example.goldLabels.productType ? 1 : 0;
}

/** Baseline correctness for the paired metric (null when unpaired; 0 when none). */
function pairedBaselineCorrectness(
  example: GoldExampleForEvaluation,
  baseline: BenchmarkPredictionEntry[] | null,
): number | null {
  if (!baseline) return 0;
  const base = predictionForExample(baseline, example.id);
  if (!base || base.abstained) return null;
  return base.productType === example.goldLabels.productType ? 1 : 0;
}

/** Per-example paired value for one labeled example (null when unpaired). */
function pairedPrimaryMetricForExample(
  example: GoldExampleForEvaluation,
  candidate: BenchmarkPredictionEntry[],
  baseline: BenchmarkPredictionEntry[] | null,
): PerExamplePrimaryMetric | null {
  const candidateScore = pairedCandidateCorrectness(example, candidate);
  if (candidateScore === null) return null;
  const baselineScore = pairedBaselineCorrectness(example, baseline);
  if (baselineScore === null) return null;
  return { exampleId: example.id, candidate: candidateScore, baseline: baselineScore };
}

/** Per-example paired values for the primary metric (product type accuracy). */
function computePerExamplePrimaryMetric(
  gold: GoldExampleForEvaluation[],
  candidate: BenchmarkPredictionEntry[],
  baseline: BenchmarkPredictionEntry[] | null,
): PerExamplePrimaryMetric[] {
  const result: PerExamplePrimaryMetric[] = [];
  for (const example of gold) {
    const pair = pairedPrimaryMetricForExample(example, candidate, baseline);
    if (pair) result.push(pair);
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

interface EceBin {
  count: number;
  correct: number;
  confSum: number;
}

/** Accumulate one confident non-abstained prediction into its confidence bin. */
function accumulateEceExample(
  bins: EceBin[],
  binCount: number,
  example: GoldExampleForEvaluation,
  predictions: BenchmarkPredictionEntry[],
): void {
  if (!example.goldLabels.productType) return;
  const pred = predictionForExample(predictions, example.id);
  if (!pred || pred.abstained || pred.productType === null || pred.confidence === null || pred.confidence === undefined) {
    return;
  }
  const bin = Math.min(binCount - 1, Math.floor(pred.confidence * binCount));
  bins[bin].count++;
  if (pred.productType === example.goldLabels.productType) bins[bin].correct++;
  bins[bin].confSum += pred.confidence;
}

/** Finalize populated bins into ECE + per-bin accuracy/confidence. */
function finalizeEceBins(
  bins: EceBin[],
  total: number,
): { ece: number; bins: EvalMetrics['calibration']['bins'] } {
  let ece = 0;
  const outBins = bins
    .filter(bin => bin.count > 0)
    .map(bin => {
      const accuracy = bin.correct / bin.count;
      const avgConfidence = bin.confSum / bin.count;
      ece += (bin.count / total) * Math.abs(accuracy - avgConfidence);
      return { bin: bins.indexOf(bin), count: bin.count, accuracy, avgConfidence };
    });
  return { ece, bins: outBins };
}

function computeEce(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): { ece: number; bins: EvalMetrics['calibration']['bins'] } {
  const binCount = 10;
  const bins: EceBin[] = Array.from({ length: binCount }, () => ({ count: 0, correct: 0, confSum: 0 }));
  for (const example of gold) {
    accumulateEceExample(bins, binCount, example, predictions);
  }
  const total = bins.reduce((acc, bin) => acc + bin.count, 0);
  if (total === 0) return { ece: 0, bins: [] };
  return finalizeEceBins(bins, total);
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

/** True for gold states that expect semantic abstention (no-fit family). */
function expectsAbstentionForGoldState(goldState: EvaluatorGoldState | null): boolean {
  return (
    goldState === EVALUATOR_GOLD_STATE_NO_FIT ||
    goldState === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE
  );
}

/** Score an unlabeled/legacy-unlabeled example: always excluded. */
function scoreUnlabeledGoldExample(): EvaluatorExampleVerdict {
  return 'excluded';
}

/**
 * Score no-fit / insufficient-evidence gold: abstaining is correct, any
 * concrete prediction is a forced-guess error, and failures or missing
 * entries earn no abstention credit.
 */
function scoreNoFitGoldExample(outcome: EvaluatorPredictionOutcome): EvaluatorExampleVerdict {
  if (outcome === EVALUATOR_OUTCOME_ABSTAINED) return 'correct';
  if (outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
  if (outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';
  return 'incorrect';
}

/** Score known-type gold: match is correct, abstention is honest, else error. */
function scoreKnownGoldExample(
  outcome: EvaluatorPredictionOutcome,
  predictedType: string | null | undefined,
  goldType: string,
): EvaluatorExampleVerdict {
  if (outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
  if (outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';
  if (outcome === EVALUATOR_OUTCOME_ABSTAINED) return 'abstained';
  return predictedType === goldType ? 'correct' : 'incorrect';
}

/**
 * Score one example under its adjudicated gold state. `known` covers both the
 * explicit marker and legacy gold carrying a type; legacy gold without a type
 * scores as `unlabeled` (excluded, matching legacy metrics which skip it).
 * No-fit / insufficient-evidence gold expects semantic abstention: abstaining
 * is correct, any concrete prediction is a forced-guess error, and failures
 * or missing entries earn no abstention credit. A `known` marker with no
 * label is contradictory fixture data and scores as excluded.
 */
function scoreEvaluatorExample(args: {
  goldState: EvaluatorGoldState | null;
  goldType: string | null;
  outcome: EvaluatorPredictionOutcome;
  predictedType: string | null | undefined;
}): EvaluatorExampleVerdict {
  const goldType = typeof args.goldType === 'string' ? args.goldType : null;
  if (args.goldState === EVALUATOR_GOLD_STATE_UNLABELED) return scoreUnlabeledGoldExample();
  if (args.goldState === null && goldType === null) return scoreUnlabeledGoldExample();
  if (expectsAbstentionForGoldState(args.goldState)) {
    return scoreNoFitGoldExample(args.outcome);
  }
  if (goldType === null) return scoreUnlabeledGoldExample();
  return scoreKnownGoldExample(args.outcome, args.predictedType, goldType);
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
export interface ScoreEvaluatorFieldExampleArgs {
  goldState: EvaluatorFieldGoldState | null;
  goldValue?: string | null | undefined;
  goldValues?: string[] | null | undefined;
  predictedValue?: string | null | undefined;
  predictedValues?: string[] | null | undefined;
  outcome?: EvaluatorPredictionOutcome;
}

export function parseValueSet(val: string | string[] | null | undefined): Set<string> {
  if (!val) return new Set();
  if (Array.isArray(val)) {
    return new Set(val.map(s => String(s).trim()).filter(Boolean));
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return new Set();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return new Set(parsed.map(s => String(s).trim()).filter(Boolean));
      } catch {}
    }
    return new Set(trimmed.split(',').map(s => s.trim()).filter(Boolean));
  }
  return new Set();
}

export function computeSetMetrics(
  goldSet: Set<string>,
  predictedSet: Set<string>,
): { precision: number; recall: number; f1: number; exactMatch: boolean } {
  if (goldSet.size === 0 && predictedSet.size === 0) {
    return { precision: 1, recall: 1, f1: 1, exactMatch: true };
  }
  if (predictedSet.size === 0) {
    return { precision: 0, recall: 0, f1: 0, exactMatch: false };
  }
  if (goldSet.size === 0) {
    return { precision: 0, recall: 0, f1: 0, exactMatch: false };
  }
  let intersection = 0;
  for (const item of predictedSet) {
    if (goldSet.has(item)) intersection++;
  }
  const precision = intersection / predictedSet.size;
  const recall = intersection / goldSet.size;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const exactMatch = intersection === goldSet.size && intersection === predictedSet.size;
  return { precision, recall, f1, exactMatch };
}

/** True for field gold excluded from the eligible denominator. */
function isExcludedFieldGold(
  goldState: EvaluatorFieldGoldState | null,
  goldValue: string | null,
  goldSetSize: number,
): boolean {
  if (
    goldState === EVALUATOR_FIELD_GOLD_STATE_UNLABELED ||
    goldState === EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE
  ) {
    return true;
  }
  return goldState === null && goldValue === null && goldSetSize === 0;
}

/** True for no-fit / insufficient-evidence field gold (abstention expected). */
function expectsFieldAbstention(goldState: EvaluatorFieldGoldState | null): boolean {
  return (
    goldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT ||
    goldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE
  );
}

/** True when the prediction side abstained (no values and no concrete outcome). */
function isFieldPredictionAbstained(
  predValue: string | null,
  predSetSize: number,
  outcome: EvaluatorPredictionOutcome | undefined,
): boolean {
  return (
    (predValue === null && predSetSize === 0) || outcome === EVALUATOR_OUTCOME_ABSTAINED
  );
}

/**
 * Score no-fit / insufficient-evidence field gold: abstaining is correct,
 * any concrete prediction is a forced-guess error.
 */
function scoreNoFitFieldExample(
  predValue: string | null,
  predSetSize: number,
  outcome: EvaluatorPredictionOutcome | undefined,
): EvaluatorExampleVerdict {
  if (isFieldPredictionAbstained(predValue, predSetSize, outcome)) return 'correct';
  return 'incorrect';
}

/** Exact set match used when either side carries multiple values. */
function fieldValueSetsMatch(goldSet: Set<string>, predSet: Set<string>): boolean {
  return goldSet.size === predSet.size && [...goldSet].every(v => predSet.has(v));
}

/** True when set-based comparison applies to this field example. */
function usesFieldSetComparison(
  args: ScoreEvaluatorFieldExampleArgs,
  goldSetSize: number,
  predSetSize: number,
): boolean {
  return (
    args.goldValues !== undefined ||
    args.predictedValues !== undefined ||
    goldSetSize > 1 ||
    predSetSize > 1
  );
}

/** Score known (or legacy-valued) field gold: match, mismatch, or abstention. */
function scoreKnownFieldExample(
  args: ScoreEvaluatorFieldExampleArgs,
  goldSet: Set<string>,
  predSet: Set<string>,
  goldValue: string | null,
  predValue: string | null,
): EvaluatorExampleVerdict {
  if (usesFieldSetComparison(args, goldSet.size, predSet.size)) {
    return fieldValueSetsMatch(goldSet, predSet) ? 'correct' : 'incorrect';
  }
  return predValue === goldValue ? 'correct' : 'incorrect';
}

/**
 * Score one field target under its adjudicated gold state (issue #298 / #300).
 *
 * Supports both single-value exact matching and multi-value set-based matching.
 *
 * States:
 * - `known`: expected to predict the gold value / set. Match -> correct,
 *   mismatch -> incorrect, abstained -> abstained.
 * - `no-fit` / `insufficient-evidence`: expected to abstain. Abstained -> correct,
 *   any concrete prediction -> incorrect (forced-guess error).
 * - `inapplicable` / `unlabeled`: excluded from the eligible denominator.
 *   Legacy gold with null value and no state marker also scores as excluded.
 */
export function scoreEvaluatorFieldExample(args: ScoreEvaluatorFieldExampleArgs): EvaluatorExampleVerdict {
  const goldSet = parseValueSet(args.goldValues ?? args.goldValue);
  const predSet = parseValueSet(args.predictedValues ?? args.predictedValue);
  const goldValue = typeof args.goldValue === 'string' && args.goldValue.trim() !== '' ? args.goldValue.trim() : null;
  const predValue = typeof args.predictedValue === 'string' && args.predictedValue.trim() !== '' ? args.predictedValue.trim() : null;

  if (isExcludedFieldGold(args.goldState, goldValue, goldSet.size)) {
    return 'excluded';
  }
  if (args.outcome === EVALUATOR_OUTCOME_FAILED) return 'failed';
  if (args.outcome === EVALUATOR_OUTCOME_MISSING) return 'missing';

  if (expectsFieldAbstention(args.goldState)) {
    return scoreNoFitFieldExample(predValue, predSet.size, args.outcome);
  }

  // goldState === known or legacy gold with non-null goldValue
  if (isFieldPredictionAbstained(predValue, predSet.size, args.outcome)) {
    return 'abstained';
  }

  return scoreKnownFieldExample(args, goldSet, predSet, goldValue, predValue);
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

export interface EvaluatorFieldSetMetrics {
  evaluatedCount: number;
  exactMatchAccuracy: number;
  meanPrecision: number;
  meanRecall: number;
  meanF1: number;
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
  setMetrics?: EvaluatorFieldSetMetrics | null;
}

export interface EvaluatorPageAttributionReport {
  evaluatedByIdentity: boolean;
  eligibleToQualifyJev: boolean;
  verifiedImportProvenance: string | null;
  blocked: boolean;
  blockedReason: string | null;
  goldStates: {
    known: number;
    noFit: number;
    insufficientEvidence: number;
    unlabeled: number;
    legacy: number;
  };
  fixedPopulation: EvaluatorFixedPopulation;
  baselineComparison: EvaluatorBaselineComparison | null;
  setMetrics?: {
    evaluatedCount: number;
    exactMatchAccuracy: number;
    meanPrecision: number;
    meanRecall: number;
    meanF1: number;
  } | null;
}

export interface SingletonPageComparisonReport extends SharedPageComparisonSummary {
  examples: Array<{
    exampleId: string;
    productSku: string;
    goldPageIds: string[];
    goldPageNames: string[];
    baselinePageIds: string[];
    baselinePageNames: string[];
    challengerPageIds: string[];
    challengerPageNames: string[];
    baselineStatus: 'predicted' | 'abstained' | 'failed' | 'unavailable';
    challengerStatus: 'predicted' | 'abstained' | 'failed' | 'unavailable';
    isExactMatchBaseline: boolean;
    isExactMatchChallenger: boolean;
  }>;
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
  /** Page attribution report (issue #299 / AC 7 & 8). */
  pageReport?: EvaluatorPageAttributionReport;
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

// ─── Attribution sections (decomposed named steps) ────────────────────────────
// `computeEvaluatorAttribution` orchestrates these pure steps; each step owns
// one concern (indexing, product-type scoring, field scoring, page scoring,
// finalization) so no single function carries the whole flow.

interface AttributionPredictionIndex {
  entriesById: Map<string, BenchmarkPredictionEntry[]>;
  baselineById: Map<string, BenchmarkPredictionEntry[]>;
  baselinePredictions: BenchmarkPredictionEntry[];
  duplicateExampleIds: string[];
  unknownExampleIds: string[];
  hasBaseline: boolean;
}

/** Index candidate/baseline bundles by example id; detect duplicates/unknowns. */
function indexAttributionPredictions(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  baselinePredictions?: BenchmarkPredictionEntry[] | null,
): AttributionPredictionIndex {
  const entriesById = groupPredictionsByExampleId(predictions);
  const baselineList = baselinePredictions ?? [];
  const baselineById = groupPredictionsByExampleId(baselineList);
  const goldIds = new Set(gold.map(example => example.id));
  const duplicateExampleIds = sortedIds(
    [...entriesById.entries()].filter(([, list]) => list.length > 1).map(([id]) => id),
  );
  const unknownExampleIds = sortedIds([...entriesById.keys()].filter(id => !goldIds.has(id)));
  return {
    entriesById,
    baselineById,
    baselinePredictions: baselineList,
    duplicateExampleIds,
    unknownExampleIds,
    hasBaseline: baselinePredictions !== null && baselinePredictions !== undefined,
  };
}

/** First entry for an example id (duplicates stay readable via the index). */
function firstIndexedEntry(
  index: Map<string, BenchmarkPredictionEntry[]>,
  exampleId: string,
): BenchmarkPredictionEntry | undefined {
  const list = index.get(exampleId) ?? [];
  return list.length > 0 ? list[0] : undefined;
}

interface ProductTypeAttribution {
  known: number;
  noFit: number;
  insufficientEvidence: number;
  unlabeled: number;
  legacy: number;
  predicted: number;
  abstainedSemantic: number;
  failed: number;
  missing: number;
  counts: FixedPopulationCounts;
  failedPredictions: EvaluatorFailedPrediction[];
  missingExampleIds: string[];
  snapshotMismatches: EvaluatorSnapshotMismatch[];
  perClassGoldSupport: Record<string, number>;
  baseline: BaselineComparisonAccumulator;
}

function emptyProductTypeAttribution(): ProductTypeAttribution {
  return {
    known: 0,
    noFit: 0,
    insufficientEvidence: 0,
    unlabeled: 0,
    legacy: 0,
    predicted: 0,
    abstainedSemantic: 0,
    failed: 0,
    missing: 0,
    counts: emptyFixedPopulationCounts(),
    failedPredictions: [],
    missingExampleIds: [],
    snapshotMismatches: [],
    perClassGoldSupport: {},
    baseline: emptyBaselineComparisonAccumulator(),
  };
}

/** Tally one example's adjudicated gold state (unlabeled bucket is the fallthrough). */
function tallyAttributionGoldState(
  acc: ProductTypeAttribution,
  state: EvaluatorGoldState | null,
): void {
  if (state === null) acc.legacy++;
  else if (state === EVALUATOR_GOLD_STATE_KNOWN) acc.known++;
  else if (state === EVALUATOR_GOLD_STATE_NO_FIT) acc.noFit++;
  else if (state === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE) acc.insufficientEvidence++;
  else acc.unlabeled++;
}

/** Tally one eligible example's candidate outcome (missing bucket is the fallthrough). */
function tallyAttributionOutcome(
  acc: ProductTypeAttribution,
  outcome: EvaluatorPredictionOutcome,
): void {
  if (outcome === EVALUATOR_OUTCOME_PREDICTED) acc.predicted++;
  else if (outcome === EVALUATOR_OUTCOME_ABSTAINED) acc.abstainedSemantic++;
  else if (outcome === EVALUATOR_OUTCOME_FAILED) acc.failed++;
  else acc.missing++;
}

/** True for gold states whose correct verdicts count as correct abstentions. */
function countsAsCorrectAbstention(state: EvaluatorGoldState | null): boolean {
  return (
    state === EVALUATOR_GOLD_STATE_NO_FIT ||
    state === EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE
  );
}

/** Tally one eligible verdict into fixed-population counts. */
function tallyFixedPopulationVerdict(
  counts: FixedPopulationCounts,
  verdict: EvaluatorExampleVerdict,
  abstentionCountsAsCorrect: boolean,
): void {
  if (verdict === 'correct') {
    counts.correct++;
    if (abstentionCountsAsCorrect) counts.correctAbstentions++;
  } else if (verdict === 'incorrect') {
    counts.incorrect++;
  } else if (verdict === 'abstained') {
    counts.abstainedSemantic++;
  } else if (verdict === 'failed') {
    counts.failed++;
  } else if (verdict === 'missing') {
    counts.missing++;
  }
}

/** Capture failure code / missing id details for product-type attribution. */
function noteAttributionVerdictDetail(
  acc: ProductTypeAttribution,
  verdict: EvaluatorExampleVerdict,
  example: GoldExampleForEvaluation,
  entry: BenchmarkPredictionEntry | undefined,
): void {
  if (verdict === 'failed') {
    acc.failedPredictions.push({
      exampleId: example.id,
      productSku: example.productSku,
      failureCode: extractFailureCode(entry),
    });
  } else if (verdict === 'missing') {
    acc.missingExampleIds.push(example.id);
  }
}

/** Provenance record carried on a bundle entry (null when absent/malformed). */
function provenanceRecordOf(
  entry: BenchmarkPredictionEntry | undefined,
): Record<string, unknown> | null {
  const rawProvenance = (entry as unknown as Record<string, unknown> | undefined)?.provenance;
  return rawProvenance !== null && typeof rawProvenance === 'object' && !Array.isArray(rawProvenance)
    ? (rawProvenance as Record<string, unknown>)
    : null;
}

/** One snapshot-mismatch finding for a hash field (null when consistent). */
function snapshotMismatchForField(
  example: GoldExampleForEvaluation,
  provenanceRecord: Record<string, unknown> | null,
  field: 'sourceProductHash' | 'configSnapshotHash',
): EvaluatorSnapshotMismatch | null {
  const provenanceValue = provenanceRecord !== null ? provenanceRecord[field] : null;
  const goldValue = field === 'sourceProductHash'
    ? example.sourceProductHash
    : example.sourceConfigHash;
  if (
    typeof provenanceValue === 'string' && provenanceValue !== '' &&
    typeof goldValue === 'string' && goldValue !== '' &&
    provenanceValue !== goldValue
  ) {
    return {
      exampleId: example.id,
      productSku: example.productSku,
      field,
      goldValue,
      predictionValue: provenanceValue,
    };
  }
  return null;
}

/** Snapshot-mismatch findings for one example (both hash fields, in order). */
function collectExampleSnapshotMismatches(
  example: GoldExampleForEvaluation,
  entry: BenchmarkPredictionEntry | undefined,
): EvaluatorSnapshotMismatch[] {
  if (!entry) return [];
  const record = provenanceRecordOf(entry);
  const mismatches: EvaluatorSnapshotMismatch[] = [];
  for (const field of ['sourceProductHash', 'configSnapshotHash'] as const) {
    const mismatch = snapshotMismatchForField(example, record, field);
    if (mismatch) mismatches.push(mismatch);
  }
  return mismatches;
}

/** Tally known-type gold toward per-class labeled support. */
function tallyKnownClassSupport(
  acc: ProductTypeAttribution,
  state: EvaluatorGoldState | null,
  goldType: string | null,
): void {
  const isKnown = state === EVALUATOR_GOLD_STATE_KNOWN || (state === null && goldType !== null);
  if (isKnown && goldType !== null) {
    acc.perClassGoldSupport[goldType] = (acc.perClassGoldSupport[goldType] ?? 0) + 1;
  }
}

/** Score + record the baseline verdict paired with one candidate verdict. */
function tallyProductTypeBaselinePair(
  acc: ProductTypeAttribution,
  example: GoldExampleForEvaluation,
  state: EvaluatorGoldState | null,
  goldType: string | null,
  verdict: EvaluatorExampleVerdict,
  index: AttributionPredictionIndex,
): void {
  const baseEntry = firstIndexedEntry(index.baselineById, example.id);
  const baseOutcome = classifyEvaluatorPredictionOutcome(baseEntry);
  const baseVerdict = scoreEvaluatorExample({
    goldState: state,
    goldType,
    outcome: baseOutcome,
    predictedType: baseEntry?.productType,
  });
  recordBaselinePair(acc.baseline, verdict, baseVerdict, example.id);
}

/** Score one gold example's product-type attribution into the accumulator. */
function scoreProductTypeAttributionExample(
  acc: ProductTypeAttribution,
  example: GoldExampleForEvaluation,
  index: AttributionPredictionIndex,
): void {
  const state = example.goldState ?? null;
  tallyAttributionGoldState(acc, state);
  const goldType = typeof example.goldLabels.productType === 'string'
    ? example.goldLabels.productType
    : null;
  const entry = firstIndexedEntry(index.entriesById, example.id);
  const outcome = classifyEvaluatorPredictionOutcome(entry);
  const verdict = scoreEvaluatorExample({
    goldState: state,
    goldType,
    outcome,
    predictedType: entry?.productType,
  });
  if (verdict === 'excluded') return;
  tallyAttributionOutcome(acc, outcome);
  tallyFixedPopulationVerdict(acc.counts, verdict, countsAsCorrectAbstention(state));
  noteAttributionVerdictDetail(acc, verdict, example, entry);
  acc.snapshotMismatches.push(...collectExampleSnapshotMismatches(example, entry));
  tallyKnownClassSupport(acc, state, goldType);
  if (index.hasBaseline) {
    tallyProductTypeBaselinePair(acc, example, state, goldType, verdict, index);
  }
}

/** Product-type fixed-population attribution over the evaluated split. */
function scoreProductTypeAttributionSection(
  gold: GoldExampleForEvaluation[],
  index: AttributionPredictionIndex,
): ProductTypeAttribution {
  const acc = emptyProductTypeAttribution();
  for (const example of gold) {
    scoreProductTypeAttributionExample(acc, example, index);
  }
  return acc;
}

/** Build the report-level fixed population from section counts. */
function toEvaluatorFixedPopulation(counts: FixedPopulationCounts): EvaluatorFixedPopulation {
  const derived = deriveFixedPopulation(counts);
  return {
    eligible: derived.eligible,
    correct: counts.correct,
    correctAbstentions: counts.correctAbstentions,
    incorrect: counts.incorrect,
    abstainedSemantic: counts.abstainedSemantic,
    failed: counts.failed,
    missing: counts.missing,
    correctness: derived.correctness,
    errorRate: derived.errorRate,
    abstentionRate: derived.abstentionRate,
    coverage: derived.coverage,
    conditionalAccuracy: derived.conditionalAccuracy,
  };
}

/**
 * Build the report-level baseline comparison. `sortIds` mirrors the legacy
 * shape: product-type and field comparisons sort recovered/harmed/dual id
 * lists; the page comparison keeps gold order.
 */
function toEvaluatorBaselineComparison(
  acc: BaselineComparisonAccumulator,
  hasBaseline: boolean,
  sortIds: boolean,
): EvaluatorBaselineComparison | null {
  if (!hasBaseline) return null;
  const derived = deriveBaselineComparison(acc);
  return {
    eligible: derived.eligible,
    candidateCorrect: derived.candidateCorrect,
    baselineCorrect: derived.baselineCorrect,
    candidateCoverage: derived.candidateCoverage,
    baselineCoverage: derived.baselineCoverage,
    coverageShift: derived.coverageShift,
    fixedDeltaMean: derived.fixedDeltaMean,
    recoveredBaselineAbstentions: acc.recoveredBaselineAbstentions,
    recoveredExampleIds: sortIds ? sortedIds(acc.recoveredExampleIds) : acc.recoveredExampleIds,
    harmedBaselineSuccesses: acc.harmedBaselineSuccesses,
    harmedExampleIds: sortIds ? sortedIds(acc.harmedExampleIds) : acc.harmedExampleIds,
    retainedSuccesses: acc.retainedSuccesses,
    dualAbstentions: acc.dualAbstentions,
    dualAbstainedExampleIds: sortIds
      ? sortedIds(acc.dualAbstainedExampleIds)
      : acc.dualAbstainedExampleIds,
  };
}

/** Sort failed predictions by example id for stable report output. */
function sortFailedPredictions(
  failedPredictions: EvaluatorFailedPrediction[],
): EvaluatorFailedPrediction[] {
  return [...failedPredictions].sort((a, b) => (
    a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : 0
  ));
}

/** Sort snapshot mismatches by (example id, field) for stable report output. */
function sortSnapshotMismatches(
  snapshotMismatches: EvaluatorSnapshotMismatch[],
): EvaluatorSnapshotMismatch[] {
  return [...snapshotMismatches].sort((a, b) => (
    a.exampleId < b.exampleId ? -1 : a.exampleId > b.exampleId ? 1 : a.field < b.field ? -1 : 1
  ));
}

/** Build labeled-support status over eligible known-type examples. */
function buildAttributionSupport(
  eligible: number,
  perClassGoldSupport: Record<string, number>,
  requiredClassSupport: number,
): EvaluatorSupportStatus {
  const { orderedPerClassGoldSupport, labeledClasses, minClassSupport } =
    deriveSupportStatus(perClassGoldSupport);
  const reasons = supportReasonsFor(eligible, labeledClasses, minClassSupport, requiredClassSupport);
  return {
    eligibleExamples: eligible,
    labeledClasses: labeledClasses.length,
    perClassGoldSupport: orderedPerClassGoldSupport,
    minClassSupport,
    requiredClassSupport,
    sufficient: reasons.length === 0,
    reasons,
  };
}

/** Build family-leakage findings over dataset-wide split examples. */
function buildAttributionFamilyLeakage(
  allSplitExamples: Array<{ familyId: string | null; splitGroup: string | null }> | undefined,
): EvaluatorFamilyLeakage {
  const { leaked, findings, ungroupedExamples } = detectSharedFamilyLeakage(allSplitExamples ?? []);
  return { leaked, findings, ungroupedExamples };
}

// ─── Field attribution section ──────────────────────────────────────────────

interface FieldTargetAttribution {
  known: number;
  noFit: number;
  insufficientEvidence: number;
  inapplicable: number;
  unlabeled: number;
  legacy: number;
  counts: FixedPopulationCounts;
  baseline: BaselineComparisonAccumulator;
  setPrecisionSum: number;
  setRecallSum: number;
  setF1Sum: number;
  setExactMatchCount: number;
  setEvaluatedCount: number;
}

function emptyFieldTargetAttribution(): FieldTargetAttribution {
  return {
    known: 0,
    noFit: 0,
    insufficientEvidence: 0,
    inapplicable: 0,
    unlabeled: 0,
    legacy: 0,
    counts: emptyFixedPopulationCounts(),
    baseline: emptyBaselineComparisonAccumulator(),
    setPrecisionSum: 0,
    setRecallSum: 0,
    setF1Sum: 0,
    setExactMatchCount: 0,
    setEvaluatedCount: 0,
  };
}

/** Add gold-side field target ids (assignments + adjudicated states). */
function addGoldFieldTargetIds(
  ids: Set<string>,
  gold: GoldExampleForEvaluation[],
): void {
  for (const example of gold) {
    for (const field of example.goldLabels.fieldAssignments ?? []) {
      if (field.targetId) ids.add(field.targetId);
    }
    if (example.fieldGoldStates) {
      for (const targetId of Object.keys(example.fieldGoldStates)) ids.add(targetId);
    }
  }
}

/** Add bundle-side field target ids (candidate or baseline predictions). */
function addBundleFieldTargetIds(
  ids: Set<string>,
  predictions: BenchmarkPredictionEntry[],
): void {
  for (const prediction of predictions) {
    for (const field of prediction.fieldAssignments ?? []) {
      if (field.targetId) ids.add(field.targetId);
    }
  }
}

/** Collect every field target id across gold, candidate, and baseline sides. */
function collectAllFieldTargetIds(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  baselinePredictions: BenchmarkPredictionEntry[],
): string[] {
  const ids = new Set<string>();
  addGoldFieldTargetIds(ids, gold);
  addBundleFieldTargetIds(ids, predictions);
  addBundleFieldTargetIds(ids, baselinePredictions);
  return [...ids].sort();
}

/** Split a comma-joined field value into trimmed values (null when empty). */
function splitFieldValueList(value: string | null): string[] | null {
  if (!value) return null;
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

/** Gold value/values for one field target (explicit `values` win). */
function goldFieldValueOf(
  example: GoldExampleForEvaluation,
  targetId: string,
): { value: string | null; values: string[] | null } {
  const goldField = example.goldLabels.fieldAssignments?.find(field => field.targetId === targetId);
  const value = goldField ? goldField.value : null;
  const values = (goldField as { values?: string[] } | undefined)?.values
    ?? splitFieldValueList(value);
  return { value, values };
}

/** Predicted value/values for one field target (explicit `values` win). */
function predictedFieldValueOf(
  predEntry: BenchmarkPredictionEntry | undefined,
  targetId: string,
): { value: string | null; values: string[] | null } {
  const predField = predEntry?.fieldAssignments?.find(field => field.targetId === targetId);
  const value = predField ? predField.value : null;
  const values = (predField as { values?: string[] } | undefined)?.values
    ?? splitFieldValueList(value);
  return { value, values };
}

/** Tally one example's field gold state for a target. */
function tallyFieldTargetGoldState(
  acc: FieldTargetAttribution,
  fieldState: EvaluatorFieldGoldState | null,
  goldValue: string | null,
): void {
  if (fieldState === null) {
    if (goldValue !== null && goldValue !== undefined) acc.legacy++;
    else acc.unlabeled++;
  } else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_KNOWN) acc.known++;
  else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT) acc.noFit++;
  else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE) {
    acc.insufficientEvidence++;
  } else if (fieldState === EVALUATOR_FIELD_GOLD_STATE_INAPPLICABLE) acc.inapplicable++;
  else acc.unlabeled++;
}

/** True for field states whose correct verdicts count as correct abstentions. */
function fieldCountsAsCorrectAbstention(fieldState: EvaluatorFieldGoldState | null): boolean {
  return (
    fieldState === EVALUATOR_FIELD_GOLD_STATE_NO_FIT ||
    fieldState === EVALUATOR_FIELD_GOLD_STATE_INSUFFICIENT_EVIDENCE
  );
}

/** Tally one eligible field verdict (field reports keep no id lists). */
function tallyFieldTargetVerdict(
  acc: FieldTargetAttribution,
  verdict: EvaluatorExampleVerdict,
  fieldState: EvaluatorFieldGoldState | null,
): void {
  tallyFixedPopulationVerdict(acc.counts, verdict, fieldCountsAsCorrectAbstention(fieldState));
}

/**
 * Derive a field-side outcome for one entry: failures first, then missing
 * entries, then value-less entries as abstained, else predicted.
 */
function deriveFieldEntryOutcome(
  predEntry: BenchmarkPredictionEntry | undefined,
  predValue: string | null,
  predValues: string[] | null,
): EvaluatorPredictionOutcome {
  if (!predEntry) return EVALUATOR_OUTCOME_MISSING;
  const raw = predEntry as unknown as Record<string, unknown>;
  if (typeof raw.failureCode === 'string' && raw.failureCode.trim() !== '') {
    return EVALUATOR_OUTCOME_FAILED;
  }
  if (raw.outcome === 'failed') return EVALUATOR_OUTCOME_FAILED;
  if (predValue === null && (!predValues || predValues.length === 0)) {
    return EVALUATOR_OUTCOME_ABSTAINED;
  }
  return EVALUATOR_OUTCOME_PREDICTED;
}

/** Accumulate set metrics for eligible (non-no-fit) field examples with values. */
function accumulateFieldSetMetrics(
  acc: FieldTargetAttribution,
  fieldState: EvaluatorFieldGoldState | null,
  goldValues: string[] | null,
  goldValue: string | null,
  predValues: string[] | null,
  predValue: string | null,
): void {
  if (fieldCountsAsCorrectAbstention(fieldState)) return;
  const goldSet = parseValueSet(goldValues ?? goldValue);
  const predSet = parseValueSet(predValues ?? predValue);
  if (goldSet.size === 0 && predSet.size === 0) return;
  const setMetrics = computeSetMetrics(goldSet, predSet);
  acc.setPrecisionSum += setMetrics.precision;
  acc.setRecallSum += setMetrics.recall;
  acc.setF1Sum += setMetrics.f1;
  if (setMetrics.exactMatch) acc.setExactMatchCount++;
  acc.setEvaluatedCount++;
}

/** Score + record the baseline field verdict paired with one candidate verdict. */
function tallyFieldTargetBaselinePair(
  acc: FieldTargetAttribution,
  example: GoldExampleForEvaluation,
  targetId: string,
  fieldState: EvaluatorFieldGoldState | null,
  goldValue: string | null,
  goldValues: string[] | null,
  verdict: EvaluatorExampleVerdict,
  index: AttributionPredictionIndex,
): void {
  const baseEntry = firstIndexedEntry(index.baselineById, example.id);
  const { value: baseValue, values: baseValues } = predictedFieldValueOf(baseEntry, targetId);
  const baseOutcome = deriveFieldEntryOutcome(baseEntry, baseValue, baseValues);
  const baseVerdict = scoreEvaluatorFieldExample({
    goldState: fieldState,
    goldValue,
    goldValues,
    predictedValue: baseValue,
    predictedValues: baseValues,
    outcome: baseOutcome,
  });
  recordBaselinePair(acc.baseline, verdict, baseVerdict, example.id);
}

/** Score one gold example's field target into the accumulator. */
function scoreFieldTargetExample(
  acc: FieldTargetAttribution,
  example: GoldExampleForEvaluation,
  targetId: string,
  index: AttributionPredictionIndex,
): void {
  const fieldState = example.fieldGoldStates?.[targetId] ?? null;
  const { value: goldValue, values: goldValues } = goldFieldValueOf(example, targetId);
  tallyFieldTargetGoldState(acc, fieldState, goldValue);
  const predEntry = firstIndexedEntry(index.entriesById, example.id);
  const { value: predValue, values: predValues } = predictedFieldValueOf(predEntry, targetId);
  const outcome = deriveFieldEntryOutcome(predEntry, predValue, predValues);
  const verdict = scoreEvaluatorFieldExample({
    goldState: fieldState,
    goldValue,
    goldValues,
    predictedValue: predValue,
    predictedValues: predValues,
    outcome,
  });
  if (verdict === 'excluded') return;
  accumulateFieldSetMetrics(acc, fieldState, goldValues, goldValue, predValues, predValue);
  tallyFieldTargetVerdict(acc, verdict, fieldState);
  if (index.hasBaseline) {
    tallyFieldTargetBaselinePair(acc, example, targetId, fieldState, goldValue, goldValues, verdict, index);
  }
}

/** Field fixed-population attribution + baseline comparison for one target. */
function scoreFieldTargetSection(
  targetId: string,
  gold: GoldExampleForEvaluation[],
  index: AttributionPredictionIndex,
): EvaluatorFieldAttributionReport {
  const acc = emptyFieldTargetAttribution();
  for (const example of gold) {
    scoreFieldTargetExample(acc, example, targetId, index);
  }
  return {
    targetId,
    goldStates: {
      known: acc.known,
      noFit: acc.noFit,
      insufficientEvidence: acc.insufficientEvidence,
      inapplicable: acc.inapplicable,
      unlabeled: acc.unlabeled,
      legacy: acc.legacy,
    },
    fixedPopulation: toEvaluatorFixedPopulation(acc.counts),
    baselineComparison: toEvaluatorBaselineComparison(acc.baseline, index.hasBaseline, true),
    setMetrics: acc.setEvaluatedCount > 0
      ? {
        evaluatedCount: acc.setEvaluatedCount,
        exactMatchAccuracy: acc.setExactMatchCount / acc.setEvaluatedCount,
        meanPrecision: acc.setPrecisionSum / acc.setEvaluatedCount,
        meanRecall: acc.setRecallSum / acc.setEvaluatedCount,
        meanF1: acc.setF1Sum / acc.setEvaluatedCount,
      }
      : null,
  };
}

/** Field attribution reports keyed by field target id (sorted for determinism). */
function scoreAllFieldTargetSections(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  index: AttributionPredictionIndex,
): Record<string, EvaluatorFieldAttributionReport> {
  const targetIds = collectAllFieldTargetIds(gold, predictions, index.baselinePredictions);
  const fieldReports: Record<string, EvaluatorFieldAttributionReport> = {};
  for (const targetId of targetIds) {
    fieldReports[targetId] = scoreFieldTargetSection(targetId, gold, index);
  }
  return fieldReports;
}

// ─── Page attribution section ───────────────────────────────────────────────

interface PageAttributionAccumulator {
  known: number;
  unlabeled: number;
  counts: FixedPopulationCounts;
  comparisonEligible: number;
  candidateCorrect: number;
  baselineCorrect: number;
  candidateCoveredCount: number;
  baselineCoveredCount: number;
  deltaSum: number;
  recoveredBaselineAbstentions: number;
  recoveredExampleIds: string[];
  harmedBaselineSuccesses: number;
  harmedExampleIds: string[];
  precisionSum: number;
  recallSum: number;
  f1Sum: number;
  exactMatchCount: number;
  setEvaluatedCount: number;
}

function emptyPageAttributionAccumulator(): PageAttributionAccumulator {
  return {
    known: 0,
    unlabeled: 0,
    counts: emptyFixedPopulationCounts(),
    comparisonEligible: 0,
    candidateCorrect: 0,
    baselineCorrect: 0,
    candidateCoveredCount: 0,
    baselineCoveredCount: 0,
    deltaSum: 0,
    recoveredBaselineAbstentions: 0,
    recoveredExampleIds: [],
    harmedBaselineSuccesses: 0,
    harmedExampleIds: [],
    precisionSum: 0,
    recallSum: 0,
    f1Sum: 0,
    exactMatchCount: 0,
    setEvaluatedCount: 0,
  };
}

type AttributionPageStatus = 'predicted' | 'abstained' | 'failed' | 'missing';

/**
 * Resolve the attribution page status for one entry. Only an explicit
 * `outcome: 'failed'` fails here (legacy parity with the metrics path);
 * value-less entries abstain.
 */
function resolveAttributionPageStatus(
  entry: BenchmarkPredictionEntry | undefined,
): AttributionPageStatus {
  if (!entry) return 'missing';
  const raw = entry as unknown as Record<string, unknown> | undefined;
  if (raw?.outcome === 'failed') return 'failed';
  if (entry.abstained || (entry.pageAssignments.length === 0 && (!entry.pageIds || entry.pageIds.length === 0))) {
    return 'abstained';
  }
  return 'predicted';
}

/** Tally the candidate page status (missing/failed/abstained counters). */
function tallyPageCandidateStatus(
  acc: PageAttributionAccumulator,
  status: AttributionPageStatus,
): void {
  if (status === 'missing') acc.counts.missing++;
  else if (status === 'failed') acc.counts.failed++;
  else if (status === 'abstained') acc.counts.abstainedSemantic++;
}

/** Page gold target set under the identity capability (ids vs names). */
function pageTargetGoldSet(
  example: GoldExampleForEvaluation,
  byIdentity: boolean,
): Set<string> {
  return new Set(byIdentity ? goldPageIdsOf(example) : goldPageNamesOf(example));
}

/**
 * Score the candidate page prediction for one labeled example; returns the
 * exact-match flag consumed by the baseline comparison below.
 */
function scorePageCandidateMatch(
  acc: PageAttributionAccumulator,
  predSet: Set<string>,
  targetGoldSet: Set<string>,
): boolean {
  acc.setEvaluatedCount++;
  const { precision, recall, f1, exactMatch } = scorePageSet(targetGoldSet, predSet);
  acc.precisionSum += precision;
  acc.recallSum += recall;
  acc.f1Sum += f1;
  if (exactMatch) {
    acc.exactMatchCount++;
    acc.counts.correct++;
  } else {
    acc.counts.incorrect++;
  }
  return exactMatch;
}

/**
 * Score the baseline page prediction paired with one candidate verdict.
 * Covered rules mirror the legacy flow exactly: candidate coverage counts
 * predicted + abstained, baseline coverage counts predicted only.
 */
/** Resolved baseline page outcome: status plus scored set (predicted only). */
interface PageBaselineOutcome {
  status: AttributionPageStatus;
  set: Set<string>;
}

/** Resolve the baseline page status/set for one example. */
function resolvePageBaselineOutcome(
  index: AttributionPredictionIndex,
  example: GoldExampleForEvaluation,
  byIdentity: boolean,
): PageBaselineOutcome {
  const base = firstIndexedEntry(index.baselineById, example.id);
  const status = resolveAttributionPageStatus(base);
  if (status !== 'predicted') return { status, set: new Set<string>() };
  return { status, set: new Set(pageItemsOf(base, byIdentity)) };
}

/** Tally baseline coverage/correctness for one page example. */
function tallyPageBaselineCorrectness(
  acc: PageAttributionAccumulator,
  outcome: PageBaselineOutcome,
  targetGoldSet: Set<string>,
): boolean {
  if (outcome.status !== 'predicted') return false;
  acc.baselineCoveredCount++;
  const exact = scorePageSet(targetGoldSet, outcome.set).exactMatch;
  if (exact) acc.baselineCorrect++;
  return exact;
}

/** Tally candidate coverage/correctness + delta for one page example. */
function tallyPageCandidateCorrectness(
  acc: PageAttributionAccumulator,
  predStatus: AttributionPageStatus,
  isExactMatch: boolean,
  isBaseExactMatch: boolean,
): void {
  if (predStatus === 'predicted' || predStatus === 'abstained') {
    acc.candidateCoveredCount++;
  }
  const candidateScore = isExactMatch ? 1 : 0;
  acc.candidateCorrect += candidateScore;
  acc.deltaSum += candidateScore - (isBaseExactMatch ? 1 : 0);
}

/** Tally recovery/harm transitions for one page example. */
function tallyPageBaselineTransitions(
  acc: PageAttributionAccumulator,
  example: GoldExampleForEvaluation,
  baseStatus: AttributionPageStatus,
  isExactMatch: boolean,
  isBaseExactMatch: boolean,
): void {
  if (baseStatus === 'abstained' && isExactMatch) {
    acc.recoveredBaselineAbstentions++;
    acc.recoveredExampleIds.push(example.id);
  }
  if (isBaseExactMatch && !isExactMatch) {
    acc.harmedBaselineSuccesses++;
    acc.harmedExampleIds.push(example.id);
  }
}

function tallyPageBaselineMatch(
  acc: PageAttributionAccumulator,
  example: GoldExampleForEvaluation,
  index: AttributionPredictionIndex,
  byIdentity: boolean,
  targetGoldSet: Set<string>,
  predStatus: AttributionPageStatus,
  isExactMatch: boolean,
): void {
  acc.comparisonEligible++;
  const outcome = resolvePageBaselineOutcome(index, example, byIdentity);
  const isBaseExactMatch = tallyPageBaselineCorrectness(acc, outcome, targetGoldSet);
  tallyPageCandidateCorrectness(acc, predStatus, isExactMatch, isBaseExactMatch);
  tallyPageBaselineTransitions(acc, example, outcome.status, isExactMatch, isBaseExactMatch);
}

/** Score one gold example's page attribution into the accumulator. */
function scorePageAttributionExample(
  acc: PageAttributionAccumulator,
  example: GoldExampleForEvaluation,
  index: AttributionPredictionIndex,
  byIdentity: boolean,
): void {
  const pred = firstIndexedEntry(index.entriesById, example.id);
  const predStatus = resolveAttributionPageStatus(pred);
  tallyPageCandidateStatus(acc, predStatus);
  const targetGoldSet = pageTargetGoldSet(example, byIdentity);
  const hasGoldLabels = targetGoldSet.size > 0;
  if (hasGoldLabels) acc.known++;
  else acc.unlabeled++;
  let isExactMatch = false;
  if (hasGoldLabels && predStatus === 'predicted') {
    isExactMatch = scorePageCandidateMatch(acc, new Set(pageItemsOf(pred, byIdentity)), targetGoldSet);
  }
  if (index.hasBaseline && hasGoldLabels) {
    tallyPageBaselineMatch(acc, example, index, byIdentity, targetGoldSet, predStatus, isExactMatch);
  }
}

/** Page baseline comparison with gold-order id lists (legacy shape). */
function toPageBaselineComparison(
  acc: PageAttributionAccumulator,
  hasBaseline: boolean,
): EvaluatorBaselineComparison | null {
  if (!hasBaseline || acc.comparisonEligible === 0) return null;
  const candidateCoverage = acc.candidateCoveredCount / acc.comparisonEligible;
  const baselineCoverage = acc.baselineCoveredCount / acc.comparisonEligible;
  return {
    eligible: acc.comparisonEligible,
    candidateCorrect: acc.candidateCorrect,
    baselineCorrect: acc.baselineCorrect,
    candidateCoverage,
    baselineCoverage,
    coverageShift: candidateCoverage - baselineCoverage,
    fixedDeltaMean: acc.deltaSum / acc.comparisonEligible,
    recoveredBaselineAbstentions: acc.recoveredBaselineAbstentions,
    recoveredExampleIds: acc.recoveredExampleIds,
    harmedBaselineSuccesses: acc.harmedBaselineSuccesses,
    harmedExampleIds: acc.harmedExampleIds,
    retainedSuccesses: 0,
    dualAbstentions: 0,
    dualAbstainedExampleIds: [],
  };
}

/**
 * Category page fixed-population attribution + baseline comparison
 * (issue #299 / AC 7 & 8). Undefined when no gold page labels exist.
 */
function scorePageAttributionSection(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  index: AttributionPredictionIndex,
): EvaluatorPageAttributionReport | undefined {
  const goldPagesExist = gold.some(example =>
    (example.goldLabels.pageAssignments && example.goldLabels.pageAssignments.length > 0) ||
    (example.goldLabels.categoryPageIds && example.goldLabels.categoryPageIds.length > 0),
  );
  if (!goldPagesExist) return undefined;
  const { canEvaluateByIdentity } = resolvePageIdentityCapability(gold, predictions);
  const acc = emptyPageAttributionAccumulator();
  for (const example of gold) {
    scorePageAttributionExample(acc, example, index, canEvaluateByIdentity);
  }
  return {
    evaluatedByIdentity: canEvaluateByIdentity,
    eligibleToQualifyJev: canEvaluateByIdentity,
    verifiedImportProvenance: canEvaluateByIdentity ? pageProvenanceOf(gold, predictions) : null,
    blocked: !canEvaluateByIdentity,
    blockedReason: !canEvaluateByIdentity ? 'blocked_missing_verified_page_gold' : null,
    goldStates: {
      known: acc.known,
      noFit: 0,
      insufficientEvidence: 0,
      unlabeled: acc.unlabeled,
      legacy: 0,
    },
    fixedPopulation: toEvaluatorFixedPopulation(acc.counts),
    baselineComparison: toPageBaselineComparison(acc, index.hasBaseline),
    setMetrics: acc.setEvaluatedCount > 0 ? {
      evaluatedCount: acc.setEvaluatedCount,
      exactMatchAccuracy: acc.exactMatchCount / acc.setEvaluatedCount,
      meanPrecision: acc.precisionSum / acc.setEvaluatedCount,
      meanRecall: acc.recallSum / acc.setEvaluatedCount,
      meanF1: acc.f1Sum / acc.setEvaluatedCount,
    } : null,
  };
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
  const index = indexAttributionPredictions(gold, predictions, options.baselinePredictions);

  const productType = scoreProductTypeAttributionSection(gold, index);
  const fixedPopulation = toEvaluatorFixedPopulation(productType.counts);
  const baselineComparison = toEvaluatorBaselineComparison(
    productType.baseline,
    index.hasBaseline,
    true,
  );
  const support = buildAttributionSupport(
    fixedPopulation.eligible,
    productType.perClassGoldSupport,
    options.requiredClassSupport ?? 20,
  );
  const familyLeakage = buildAttributionFamilyLeakage(options.allSplitExamples);

  // ── Field fixed-population attribution & baseline comparison (issue #298 / AC 8)
  const fieldReports = scoreAllFieldTargetSections(gold, predictions, index);

  // ── Category Page fixed-population attribution & baseline comparison (issue #299 / AC 7 & 8)
  const pageReport = scorePageAttributionSection(gold, predictions, index);

  return {
    evaluatedSplit: splitGroup,
    goldTotal: gold.length,
    goldStates: {
      known: productType.known,
      noFit: productType.noFit,
      insufficientEvidence: productType.insufficientEvidence,
      unlabeled: productType.unlabeled,
      legacy: productType.legacy,
    },
    predictionOutcomes: {
      predicted: productType.predicted,
      abstainedSemantic: productType.abstainedSemantic,
      failed: productType.failed,
      missing: productType.missing,
    },
    failedPredictions: sortFailedPredictions(productType.failedPredictions),
    missingExampleIds: sortedIds(productType.missingExampleIds),
    duplicateExampleIds: index.duplicateExampleIds,
    unknownExampleIds: index.unknownExampleIds,
    snapshotMismatches: sortSnapshotMismatches(productType.snapshotMismatches),
    fixedPopulation,
    baselineComparison,
    support,
    familyLeakage,
    fieldReports,
    pageReport,
  };
}

// ─── Metrics sections (decomposed named steps) ────────────────────────────────
// `computeMetrics` orchestrates these pure steps; each step owns one metric
// family so no single function carries the whole computation.

interface ProductTypeSectionAccumulator {
  eligible: number;
  evaluated: number;
  correct: number;
  abstained: number;
  classStats: Record<string, { gold: number; correct: number; predicted: number }>;
  confusionMap: Record<string, number>;
}

function emptyProductTypeSectionAccumulator(): ProductTypeSectionAccumulator {
  return { eligible: 0, evaluated: 0, correct: 0, abstained: 0, classStats: {}, confusionMap: {} };
}

/** True when a prediction abstained (flag or null/undefined type). */
function isAbstainedTypePrediction(
  pred: BenchmarkPredictionEntry | undefined,
): boolean {
  return pred?.abstained || pred?.productType === null || pred?.productType === undefined;
}

/** Record a correct/incorrect type prediction into class stats + confusion. */
function tallyTypePredictionHit(
  acc: ProductTypeSectionAccumulator,
  goldType: string,
  predictedType: string,
): void {
  if (predictedType === goldType) {
    acc.correct++;
    acc.classStats[goldType].correct++;
  }
  acc.classStats[predictedType] = acc.classStats[predictedType] ?? { gold: 0, correct: 0, predicted: 0 };
  acc.classStats[predictedType].predicted++;
  if (predictedType !== goldType) {
    const pairKey = `${goldType} -> ${predictedType}`;
    acc.confusionMap[pairKey] = (acc.confusionMap[pairKey] ?? 0) + 1;
  }
}

/** Score one example's product-type contribution (abstentions counted, not evaluated). */
function accumulateProductTypeExample(
  acc: ProductTypeSectionAccumulator,
  example: GoldExampleForEvaluation,
  predictions: BenchmarkPredictionEntry[],
): void {
  const goldType = example.goldLabels.productType;
  const pred = predictionForExample(predictions, example.id);
  if (!pred || isAbstainedTypePrediction(pred)) {
    if (goldType) {
      acc.eligible++;
      acc.abstained++;
    }
    return;
  }
  if (!goldType) return;
  acc.eligible++;
  acc.evaluated++;
  acc.classStats[goldType] = acc.classStats[goldType] ?? { gold: 0, correct: 0, predicted: 0 };
  acc.classStats[goldType].gold++;
  if (pred.productType) {
    tallyTypePredictionHit(acc, goldType, pred.productType);
  }
}

/** Macro F1 from class-level precision/recall. */
function computeMacroF1(
  classStats: Record<string, { gold: number; correct: number; predicted: number }>,
): number {
  let macroF1Sum = 0;
  let classCount = 0;
  for (const stats of Object.values(classStats)) {
    const precision = stats.predicted > 0 ? stats.correct / stats.predicted : 0;
    const recall = stats.gold > 0 ? stats.correct / stats.gold : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    macroF1Sum += f1;
    classCount++;
  }
  return classCount > 0 ? macroF1Sum / classCount : 0;
}

/** Confusion pairs from the gold->predicted count map. */
function toConfusionPairs(
  confusionMap: Record<string, number>,
): Array<[string, string, number]> {
  return Object.entries(confusionMap).map(([key, count]) => {
    const [gold, predicted] = key.split(' -> ');
    return [gold, predicted, count] as [string, string, number];
  });
}

/**
 * Apply the product-type section to the metrics.
 * INTENTIONAL (M9 review note): per-class support is reported conservatively
 * as min(gold, predicted) rather than the standard gold-class count. This
 * UNDER-reports support for under-predicted classes, which makes the
 * qualification gate reject those classes more aggressively — a fail-closed
 * bias, never a license to pass.
 */
function applyProductTypeSection(
  metrics: EvalMetrics,
  acc: ProductTypeSectionAccumulator,
): void {
  metrics.productType.support = acc.evaluated;
  metrics.productType.coverage = acc.eligible > 0 ? acc.evaluated / acc.eligible : 0;
  metrics.productType.top1Accuracy = acc.evaluated > 0 ? acc.correct / acc.evaluated : 0;
  metrics.productType.perClassSupport = Object.fromEntries(
    Object.entries(acc.classStats).map(([cls, stats]) => [cls, Math.min(stats.gold, stats.correct + (stats.predicted - Math.min(stats.gold, stats.correct)))]),
  );
  metrics.productType.macroF1 = computeMacroF1(acc.classStats);
  metrics.productType.confusionPairs = toConfusionPairs(acc.confusionMap);
}

/** Score the product-type section over all gold examples. */
function scoreMetricsProductTypeSection(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): ProductTypeSectionAccumulator {
  const acc = emptyProductTypeSectionAccumulator();
  for (const example of gold) {
    accumulateProductTypeExample(acc, example, predictions);
  }
  return acc;
}

/** Apply abstention rates derived from the product-type section. */
function applyAbstentionSection(
  metrics: EvalMetrics,
  gold: GoldExampleForEvaluation[],
  abstained: number,
  evaluated: number,
  correct: number,
): void {
  metrics.abstention.abstainedPercent = gold.length > 0 ? (abstained / gold.length) * 100 : 0;
  metrics.abstention.accuracyOfNonAbstained = evaluated > 0 ? correct / evaluated : 0;
}

interface MetricsPageSection {
  goldPagesExist: boolean;
  canEvaluateByIdentity: boolean;
  precisionSum: number;
  recallSum: number;
  exactMatches: number;
  evaluated: number;
}

/** Gold/predicted page sets for the metrics path under the identity capability. */
function metricsPageSetsForExample(
  example: GoldExampleForEvaluation,
  pred: BenchmarkPredictionEntry | undefined,
  byIdentity: boolean,
): { goldPages: Set<string>; predPages: Set<string> } {
  if (byIdentity) {
    return {
      goldPages: new Set(goldPageIdsOf(example)),
      predPages: new Set(pageItemsOf(pred, true)),
    };
  }
  return {
    goldPages: new Set(goldPageNamesOf(example)),
    predPages: new Set(pageItemsOf(pred, false)),
  };
}

/** Score the page section over all gold examples (empty-vs-empty pairs skipped). */
function scoreMetricsPageSection(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  canEvaluateByIdentity: boolean,
): Omit<MetricsPageSection, 'goldPagesExist' | 'canEvaluateByIdentity'> {
  let precisionSum = 0;
  let recallSum = 0;
  let exactMatches = 0;
  let evaluated = 0;
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const { goldPages, predPages } = metricsPageSetsForExample(example, pred, canEvaluateByIdentity);
    if (goldPages.size === 0 && predPages.size === 0) continue;
    evaluated++;
    const { precision, recall, exactMatch } = scorePageSet(goldPages, predPages);
    precisionSum += precision;
    recallSum += recall;
    if (exactMatch) exactMatches++;
  }
  return { precisionSum, recallSum, exactMatches, evaluated };
}

/** Apply the page section to the metrics (blocked without verified identity). */
function applyPageSection(
  metrics: EvalMetrics,
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  section: MetricsPageSection,
): void {
  metrics.pages.precisionAtK = section.evaluated > 0 ? section.precisionSum / section.evaluated : 0;
  metrics.pages.recallAtK = section.evaluated > 0 ? section.recallSum / section.evaluated : 0;
  metrics.pages.exactSetAccuracy = section.evaluated > 0 ? section.exactMatches / section.evaluated : 0;
  metrics.pages.blocked = section.goldPagesExist && !section.canEvaluateByIdentity;
  metrics.pages.blockedReason = (section.goldPagesExist && !section.canEvaluateByIdentity)
    ? 'blocked_missing_verified_page_gold'
    : null;
  metrics.pages.evaluatedByIdentity = section.canEvaluateByIdentity;
  metrics.pages.eligibleToQualifyJev = section.canEvaluateByIdentity;
  metrics.pages.verifiedImportProvenance = section.canEvaluateByIdentity
    ? pageProvenanceOf(gold, predictions)
    : null;
}

/** Resolve the metrics page identity capability (empty gold cannot establish it). */
function resolveMetricsPageCapability(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): { goldPagesExist: boolean; canEvaluateByIdentity: boolean } {
  const goldPagesExist = gold.some(example =>
    (example.goldLabels.pageAssignments && example.goldLabels.pageAssignments.length > 0) ||
    (example.goldLabels.categoryPageIds && example.goldLabels.categoryPageIds.length > 0),
  );
  const capability = resolvePageIdentityCapability(gold, predictions);
  const canEvaluateByIdentity = goldPagesExist &&
    capability.allGoldPagesHaveVerifiedIds &&
    capability.hasVerifiedImportProvenance;
  return { goldPagesExist, canEvaluateByIdentity };
}

/** Predicted field map (target id -> value) for one example. */
function fieldPredictionMap(
  predictions: BenchmarkPredictionEntry[],
  exampleId: string,
): Map<string, string | null | undefined> {
  const pred = predictionForExample(predictions, exampleId);
  return new Map((pred?.fieldAssignments ?? []).map(field => [field.targetId, field.value]));
}

/** Score per-target field support/accuracy over non-null gold values. */
function scoreMetricsFieldSection(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): Record<string, { support: number; correct: number }> {
  const fieldStats: Record<string, { support: number; correct: number }> = {};
  for (const example of gold) {
    const predFields = fieldPredictionMap(predictions, example.id);
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      fieldStats[goldField.targetId] = fieldStats[goldField.targetId] ?? { support: 0, correct: 0 };
      fieldStats[goldField.targetId].support++;
      if (predFields.get(goldField.targetId) === goldField.value) {
        fieldStats[goldField.targetId].correct++;
      }
    }
  }
  return fieldStats;
}

/** Apply per-target field support/accuracy to the metrics. */
function applyFieldSection(
  metrics: EvalMetrics,
  fieldStats: Record<string, { support: number; correct: number }>,
): void {
  metrics.fields.targetSupport = Object.fromEntries(
    Object.entries(fieldStats).map(([targetId, stats]) => [targetId, stats.support]),
  );
  metrics.fields.targetAccuracy = Object.fromEntries(
    Object.entries(fieldStats).map(([targetId, stats]) => [targetId, stats.support > 0 ? stats.correct / stats.support : 0]),
  );
}

/** Score corrections-per-hundred over non-null gold field values. */
function scoreMetricsOperationsSection(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
): number {
  let totalCorrections = 0;
  let totalFieldProposals = 0;
  for (const example of gold) {
    const predFields = fieldPredictionMap(predictions, example.id);
    for (const goldField of example.goldLabels.fieldAssignments) {
      if (goldField.value === null) continue;
      totalFieldProposals++;
      const predicted = predFields.get(goldField.targetId);
      if (predicted !== null && predicted !== undefined && predicted !== goldField.value) {
        totalCorrections++;
      }
    }
  }
  return totalFieldProposals > 0 ? (totalCorrections / totalFieldProposals) * 100 : 0;
}

/** Cross-species violation text for one page (null when consistent). */
function crossSpeciesViolationForPage(
  example: GoldExampleForEvaluation,
  goldSpecies: { dog: boolean; cat: boolean },
  page: string,
): string | null {
  const lower = page.toLowerCase();
  if (goldSpecies.dog && /\bcat\b/.test(lower) && !/\bdog\b/.test(lower)) {
    return `${example.productSku}: Dog product on page '${page}'`;
  }
  if (goldSpecies.cat && /\bdog\b/.test(lower) && !/\bcat\b/.test(lower)) {
    return `${example.productSku}: Cat product on page '${page}'`;
  }
  return null;
}

/** Score cross-species page violations for one example. */
function scoreCrossSpeciesExample(
  example: GoldExampleForEvaluation,
  pred: BenchmarkPredictionEntry | undefined,
): string[] {
  const violations: string[] = [];
  const goldSpecies = speciesOfType(example.goldLabels.productType);
  for (const page of pred?.pageAssignments ?? []) {
    const violation = crossSpeciesViolationForPage(example, goldSpecies, page);
    if (violation) violations.push(violation);
  }
  return violations;
}

/** Count claim-safety violations (asserted claim-sensitive values). */
function countClaimSafetyViolations(pred: BenchmarkPredictionEntry | undefined): number {
  let violations = 0;
  for (const claimTarget of pred?.claimTargets ?? []) {
    const asserted = (pred?.fieldAssignments ?? []).some(
      field => field.targetId === claimTarget && field.value !== null && field.value !== undefined,
    );
    if (asserted) violations++;
  }
  return violations;
}

/** Count controlled-value violations (values outside the declared vocabulary). */
function countControlledValueViolations(
  pred: BenchmarkPredictionEntry | undefined,
  controlledValues: ControlledValues,
): number {
  let violations = 0;
  for (const field of pred?.fieldAssignments ?? []) {
    const allowed = controlledValues[field.targetId];
    if (field.value !== null && field.value !== undefined && allowed && allowed.length > 0 && !allowed.includes(field.value)) {
      violations++;
    }
  }
  return violations;
}

/** Apply the safety section (cross-species, claim-safety, controlled-value). */
function applySafetySection(
  metrics: EvalMetrics,
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  controlledValues: ControlledValues,
): void {
  const crossSpeciesExamples: string[] = [];
  for (const example of gold) {
    const pred = predictionForExample(predictions, example.id);
    const violations = scoreCrossSpeciesExample(example, pred);
    metrics.safety.crossSpeciesCount += violations.length;
    crossSpeciesExamples.push(...violations);
    metrics.safety.claimSafetyViolations += countClaimSafetyViolations(pred);
    metrics.safety.controlledValueViolations += countControlledValueViolations(pred, controlledValues);
  }
  metrics.safety.crossSpeciesExamples = crossSpeciesExamples;
}

/** Apply the paired-delta section (deterministic seeded bootstrap interval). */
function applyPairedDeltaSection(
  metrics: EvalMetrics,
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  options: ComputeMetricsOptions,
  primaryMetric: string,
  bootstrapRuns: number,
): void {
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
}

/**
 * Pure metrics computation. No database, no runs, no decisions.
 */
export function computeMetrics(
  gold: GoldExampleForEvaluation[],
  predictions: BenchmarkPredictionEntry[],
  options: ComputeMetricsOptions = {},
): EvalMetrics {
  const metrics = defaultMetrics();
  const controlledValues = options.controlledValues ?? {};
  const primaryMetric = options.primaryMetric ?? 'productType.top1Accuracy';
  const bootstrapRuns = options.bootstrapRuns ?? 2000;

  // ── Product Type + Abstention ────────────────────────────────────────────
  const productType = scoreMetricsProductTypeSection(gold, predictions);
  applyProductTypeSection(metrics, productType);
  applyAbstentionSection(metrics, gold, productType.abstained, productType.evaluated, productType.correct);

  // ── Pages ────────────────────────────────────────────────────────────────
  const pageCapability = resolveMetricsPageCapability(gold, predictions);
  const pageSection = scoreMetricsPageSection(gold, predictions, pageCapability.canEvaluateByIdentity);
  applyPageSection(metrics, gold, predictions, { ...pageCapability, ...pageSection });

  // ── Fields + Operations ──────────────────────────────────────────────────
  applyFieldSection(metrics, scoreMetricsFieldSection(gold, predictions));
  metrics.operations.correctionsPerHundred = scoreMetricsOperationsSection(gold, predictions);

  // ── Safety ───────────────────────────────────────────────────────────────
  applySafetySection(metrics, gold, predictions, controlledValues);

  // ── Calibration (ECE over non-abstained product-type predictions) ─────────
  metrics.calibration = computeEce(gold, predictions);

  // ── Paired delta (candidate vs baseline; default abstention baseline) ─────
  applyPairedDeltaSection(metrics, gold, predictions, options, primaryMetric, bootstrapRuns);

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

export interface CompareSingletonPagePredictionsOptions {
  /** If true, skip or mark unavailable examples without a reviewed product type in gold. Default true. */
  requireReviewedProductType?: boolean;
}

// ─── Singleton/cohort page comparison sections ────────────────────────────────
// The two comparisons share indexing, verified-identity capability, gold
// extraction, set scoring, and summary finalization. They differ only in
// status resolution (singleton entry status vs cohort outcome category),
// coverage rules, and per-example rows — each side owns a named scorer.

/** Singleton/cohort page status for one comparison entry. */
type ComparisonPageStatus = 'predicted' | 'abstained' | 'failed' | 'unavailable';

/** Index candidate/baseline bundles first-wins by example id. */
function indexComparisonPredictions(
  candidatePredictions: BenchmarkPredictionEntry[],
  baselinePredictions: BenchmarkPredictionEntry[],
): {
  candidateById: Map<string, BenchmarkPredictionEntry>;
  baselineById: Map<string, BenchmarkPredictionEntry>;
} {
  return {
    candidateById: indexPredictionsByExampleId(candidatePredictions),
    baselineById: indexPredictionsByExampleId(baselinePredictions),
  };
}

/** Verified-identity capability for the comparisons (empty gold cannot establish it). */
function resolveComparisonIdentityCapability(
  gold: GoldExampleForEvaluation[],
  candidatePredictions: BenchmarkPredictionEntry[],
  baselinePredictions: BenchmarkPredictionEntry[],
): boolean {
  return resolvePageIdentityCapability(gold, candidatePredictions, baselinePredictions, true)
    .canEvaluateByIdentity;
}

/** Gold ids/names + target set for one example under the identity capability. */
function comparisonGoldForExample(
  example: GoldExampleForEvaluation,
  byIdentity: boolean,
): { goldPageIds: string[]; goldPageNames: string[]; targetGoldSet: Set<string> } {
  const goldPageIds = goldPageIdsOf(example);
  const goldPageNames = goldPageNamesOf(example);
  return { goldPageIds, goldPageNames, targetGoldSet: new Set(byIdentity ? goldPageIds : goldPageNames) };
}

/**
 * Singleton entry status: missing entries are unavailable (not errors);
 * failure codes and explicit failed outcomes fail; value-less entries abstain.
 */
function resolveComparisonPageStatus(
  entry: BenchmarkPredictionEntry | undefined,
): ComparisonPageStatus {
  if (!entry) return 'unavailable';
  const raw = entry as unknown as Record<string, unknown>;
  if (typeof raw.failureCode === 'string' && raw.failureCode.trim() !== '') return 'failed';
  if (raw.outcome === 'failed') return 'failed';
  if (entry.abstained || (entry.pageAssignments.length === 0 && (!entry.pageIds || entry.pageIds.length === 0))) {
    return 'abstained';
  }
  return 'predicted';
}

/** Add one scored side's precision/recall/exact-match to the counters. */
function addComparisonSideSums(
  counters: PageComparisonCounters,
  precision: number,
  recall: number,
  exactMatch: boolean,
  isCandidate: boolean,
): void {
  if (isCandidate) {
    counters.candidatePrecisionSum += precision;
    counters.candidateRecallSum += recall;
    if (exactMatch) counters.candidateExactMatches++;
  } else {
    counters.baselinePrecisionSum += precision;
    counters.baselineRecallSum += recall;
    if (exactMatch) counters.baselineExactMatches++;
  }
}

/** Score one singleton comparison side (predicted only; abstained counts as covered). */
function scoreSingletonComparisonSide(
  counters: PageComparisonCounters,
  set: Set<string>,
  targetGoldSet: Set<string>,
  isCandidate: boolean,
): boolean {
  if (isCandidate) counters.candidateCoveredCount++;
  else counters.baselineCoveredCount++;
  const { precision, recall, exactMatch } = scorePageSet(targetGoldSet, set);
  addComparisonSideSums(counters, precision, recall, exactMatch, isCandidate);
  return exactMatch;
}

/** Note recovery (baseline abstained, challenger exact) and harm (reverse). */
function noteComparisonDelta(
  counters: PageComparisonCounters,
  challengerExact: boolean,
  baselineExact: boolean,
  recoveredWhen: boolean,
): void {
  counters.deltaSum += (challengerExact ? 1 : 0) - (baselineExact ? 1 : 0);
  if (recoveredWhen && challengerExact) counters.recoveredBaselineAbstentions++;
  if (baselineExact && !challengerExact) counters.harmedBaselineSuccesses++;
}

/** Gate one comparison example: require-pt and gold-label checks (true = score it). */
function gatePageComparisonExample(
  counters: PageComparisonCounters,
  example: GoldExampleForEvaluation,
  targetGoldSet: Set<string>,
  requirePt: boolean,
): boolean {
  if (requirePt && !example.goldLabels.productType) {
    counters.unavailableCount++;
    return false;
  }
  if (targetGoldSet.size === 0) {
    counters.unlabeledCount++;
    return false;
  }
  counters.eligibleCount++;
  return true;
}

/** Score the predicted singleton sides into counters; returns exact flags. */
function scoreSingletonComparisonSides(
  counters: PageComparisonCounters,
  candSet: Set<string>,
  baseSet: Set<string>,
  targetGoldSet: Set<string>,
  candStatus: ComparisonPageStatus,
  baseStatus: ComparisonPageStatus,
): { challengerExact: boolean; baselineExact: boolean } {
  let challengerExact = false;
  if (candStatus === 'predicted') {
    challengerExact = scoreSingletonComparisonSide(counters, candSet, targetGoldSet, true);
  } else if (candStatus === 'abstained') {
    counters.candidateCoveredCount++;
  }
  let baselineExact = false;
  if (baseStatus === 'predicted') {
    baselineExact = scoreSingletonComparisonSide(counters, baseSet, targetGoldSet, false);
  } else if (baseStatus === 'abstained') {
    counters.baselineCoveredCount++;
  }
  return { challengerExact, baselineExact };
}

/** Tally unavailable/evaluated presence for one singleton example. */
function tallySingletonExamplePresence(
  counters: PageComparisonCounters,
  candStatus: ComparisonPageStatus,
  baseStatus: ComparisonPageStatus,
): void {
  if (candStatus === 'unavailable' || baseStatus === 'unavailable') {
    counters.unavailableCount++;
  }
  if (candStatus !== 'unavailable' || baseStatus !== 'unavailable') {
    counters.evaluatedCount++;
  }
}

/** Non-empty page id/name lists for both comparison sides. */
function comparisonPageLists(
  cand: BenchmarkPredictionEntry | undefined,
  base: BenchmarkPredictionEntry | undefined,
): { candIds: string[]; candNames: string[]; baseIds: string[]; baseNames: string[] } {
  return {
    candIds: (cand?.pageIds ?? []).filter(Boolean),
    candNames: (cand?.pageAssignments ?? []).filter(Boolean),
    baseIds: (base?.pageIds ?? []).filter(Boolean),
    baseNames: (base?.pageAssignments ?? []).filter(Boolean),
  };
}

/** Push one singleton comparison row report. */
function pushSingletonExampleReport(
  exampleReports: SingletonPageComparisonReport['examples'],
  example: GoldExampleForEvaluation,
  goldPageIds: string[],
  goldPageNames: string[],
  lists: { candIds: string[]; candNames: string[]; baseIds: string[]; baseNames: string[] },
  candStatus: ComparisonPageStatus,
  baseStatus: ComparisonPageStatus,
  challengerExact: boolean,
  baselineExact: boolean,
): void {
  exampleReports.push({
    exampleId: example.id,
    productSku: example.productSku,
    goldPageIds,
    goldPageNames,
    baselinePageIds: lists.baseIds,
    baselinePageNames: lists.baseNames,
    challengerPageIds: lists.candIds,
    challengerPageNames: lists.candNames,
    baselineStatus: baseStatus,
    challengerStatus: candStatus,
    isExactMatchBaseline: baselineExact,
    isExactMatchChallenger: challengerExact,
  });
}

/** Push one cohort comparison row report. */
function pushCohortExampleReport(
  exampleReports: CohortPageExampleReport[],
  example: GoldExampleForEvaluation,
  goldPageIds: string[],
  goldPageNames: string[],
  lists: { candIds: string[]; candNames: string[]; baseIds: string[]; baseNames: string[] },
  candCat: CohortPageOutcomeCategory,
  baseCat: CohortPageOutcomeCategory,
  challenger: { exact: boolean; prec: number; rec: number },
  baseline: { exact: boolean; prec: number; rec: number },
): void {
  exampleReports.push({
    exampleId: example.id,
    productSku: example.productSku,
    goldPageIds,
    goldPageNames,
    baselinePageIds: lists.baseIds,
    baselinePageNames: lists.baseNames,
    challengerPageIds: lists.candIds,
    challengerPageNames: lists.candNames,
    baselineCategory: baseCat,
    challengerCategory: candCat,
    isExactMatchBaseline: baseline.exact,
    isExactMatchChallenger: challenger.exact,
    baselinePrecision: baseline.prec,
    baselineRecall: baseline.rec,
    challengerPrecision: challenger.prec,
    challengerRecall: challenger.rec,
  });
}

/** Score one singleton comparison example into counters + row reports. */
function scoreSingletonComparisonExample(
  counters: PageComparisonCounters,
  exampleReports: SingletonPageComparisonReport['examples'],
  example: GoldExampleForEvaluation,
  cand: BenchmarkPredictionEntry | undefined,
  base: BenchmarkPredictionEntry | undefined,
  byIdentity: boolean,
  requirePt: boolean,
): void {
  const { goldPageIds, goldPageNames, targetGoldSet } = comparisonGoldForExample(example, byIdentity);
  if (!gatePageComparisonExample(counters, example, targetGoldSet, requirePt)) return;
  const candStatus = resolveComparisonPageStatus(cand);
  const baseStatus = resolveComparisonPageStatus(base);
  tallySingletonExamplePresence(counters, candStatus, baseStatus);
  const lists = comparisonPageLists(cand, base);
  const candSet = new Set(candStatus === 'predicted' ? (byIdentity ? lists.candIds : lists.candNames) : []);
  const baseSet = new Set(baseStatus === 'predicted' ? (byIdentity ? lists.baseIds : lists.baseNames) : []);
  const { challengerExact, baselineExact } = scoreSingletonComparisonSides(
    counters, candSet, baseSet, targetGoldSet, candStatus, baseStatus,
  );
  noteComparisonDelta(counters, challengerExact, baselineExact, baseStatus === 'abstained');
  pushSingletonExampleReport(
    exampleReports, example, goldPageIds, goldPageNames, lists,
    candStatus, baseStatus, challengerExact, baselineExact,
  );
}

/** True for cohort model failures (service/dispatch codes or failed outcome). */
function isCohortModelFailure(
  raw: Record<string, unknown>,
  failureCode: string | null,
): boolean {
  return failureCode === 'service_failure' || raw.outcome === 'failed' || failureCode === 'dispatch_failed';
}

const COHORT_CORRECTNESS_REJECTION_CODES = [
  'species_conflict',
  'validation_blocked',
  'cardinality_limit_exceeded',
  'candidate_limit_exceeded',
  'unknown_option_key',
] as const;

/** True for correctness rejections (known codes or matching reason text). */
function isCohortCorrectnessRejection(
  abstentionCode: string | null,
  abstentionReason: string,
): boolean {
  if (abstentionCode !== null && (COHORT_CORRECTNESS_REJECTION_CODES as readonly string[]).includes(abstentionCode)) {
    return true;
  }
  return /cross-species|species conflict|validation|limit|exceeded|unknown choice/i.test(abstentionReason);
}

/** Empty cohort outcome breakdown (all categories start at zero). */
function emptyCohortOutcomeBreakdown(): CohortOutcomeBreakdown {
  return {
    successfulAssignments: 0,
    semanticAbstentions: 0,
    correctnessRejections: 0,
    modelFailures: 0,
    unlabeled: 0,
    unavailable: 0,
  };
}

/** Tally one cohort outcome category into its breakdown. */
function tallyCohortBreakdown(
  breakdown: CohortOutcomeBreakdown,
  category: CohortPageOutcomeCategory,
): void {
  if (category === 'successful_assignment') breakdown.successfulAssignments++;
  else if (category === 'semantic_abstention') breakdown.semanticAbstentions++;
  else if (category === 'correctness_rejection') breakdown.correctnessRejections++;
  else if (category === 'model_failure') breakdown.modelFailures++;
  else if (category === 'unavailable') breakdown.unavailable++;
}

/** Scored values for one cohort comparison side (precision/recall/exact). */
interface CohortSideScore {
  exact: boolean;
  prec: number;
  rec: number;
}

/** Score one cohort comparison side into counters (covered rules per category). */
function scoreCohortComparisonSide(
  counters: PageComparisonCounters,
  set: Set<string>,
  targetGoldSet: Set<string>,
  category: CohortPageOutcomeCategory,
  isCandidate: boolean,
): CohortSideScore {
  const covered = category === 'successful_assignment' ||
    category === 'semantic_abstention' ||
    category === 'correctness_rejection';
  if (!covered) return { exact: false, prec: 0, rec: 0 };
  if (isCandidate) counters.candidateCoveredCount++;
  else counters.baselineCoveredCount++;
  if (category !== 'successful_assignment') return { exact: false, prec: 0, rec: 0 };
  const { precision, recall, exactMatch } = scorePageSet(targetGoldSet, set);
  addComparisonSideSums(counters, precision, recall, exactMatch, isCandidate);
  return { exact: exactMatch, prec: precision, rec: recall };
}

/** Gate one cohort example: require-pt and gold checks with breakdown bumps. */
function gateCohortComparisonExample(
  counters: PageComparisonCounters,
  candidateBreakdown: CohortOutcomeBreakdown,
  baselineBreakdown: CohortOutcomeBreakdown,
  example: GoldExampleForEvaluation,
  targetGoldSet: Set<string>,
  requirePt: boolean,
): boolean {
  if (requirePt && !example.goldLabels.productType) {
    counters.unavailableCount++;
    candidateBreakdown.unavailable++;
    baselineBreakdown.unavailable++;
    return false;
  }
  if (targetGoldSet.size === 0) {
    counters.unlabeledCount++;
    candidateBreakdown.unlabeled++;
    baselineBreakdown.unlabeled++;
    return false;
  }
  counters.eligibleCount++;
  return true;
}

/** Tally cohort outcome categories + unavailable presence for one example. */
function tallyCohortExamplePresence(
  counters: PageComparisonCounters,
  candidateBreakdown: CohortOutcomeBreakdown,
  baselineBreakdown: CohortOutcomeBreakdown,
  candCat: CohortPageOutcomeCategory,
  baseCat: CohortPageOutcomeCategory,
): void {
  tallyCohortBreakdown(candidateBreakdown, candCat);
  tallyCohortBreakdown(baselineBreakdown, baseCat);
  if (candCat === 'unavailable' || baseCat === 'unavailable') {
    counters.unavailableCount++;
  }
}

/** Tally evaluated presence for one cohort example (either side available). */
function tallyCohortExampleEvaluated(
  counters: PageComparisonCounters,
  candCat: CohortPageOutcomeCategory,
  baseCat: CohortPageOutcomeCategory,
): void {
  if (candCat !== 'unavailable' || baseCat !== 'unavailable') {
    counters.evaluatedCount++;
  }
}

/** Score one cohort comparison example into counters, breakdowns, and rows. */
function scoreCohortComparisonExample(
  counters: PageComparisonCounters,
  candidateBreakdown: CohortOutcomeBreakdown,
  baselineBreakdown: CohortOutcomeBreakdown,
  exampleReports: CohortPageExampleReport[],
  example: GoldExampleForEvaluation,
  cand: BenchmarkPredictionEntry | undefined,
  base: BenchmarkPredictionEntry | undefined,
  byIdentity: boolean,
  requirePt: boolean,
): void {
  const { goldPageIds, goldPageNames, targetGoldSet } = comparisonGoldForExample(example, byIdentity);
  if (!gateCohortComparisonExample(counters, candidateBreakdown, baselineBreakdown, example, targetGoldSet, requirePt)) {
    return;
  }
  const candCat = classifyCohortPageOutcome(cand);
  const baseCat = classifyCohortPageOutcome(base);
  tallyCohortExamplePresence(counters, candidateBreakdown, baselineBreakdown, candCat, baseCat);
  const lists = comparisonPageLists(cand, base);
  const candSet = new Set(byIdentity ? lists.candIds : lists.candNames);
  const baseSet = new Set(byIdentity ? lists.baseIds : lists.baseNames);
  const challenger = scoreCohortComparisonSide(counters, candSet, targetGoldSet, candCat, true);
  const baseline = scoreCohortComparisonSide(counters, baseSet, targetGoldSet, baseCat, false);
  tallyCohortExampleEvaluated(counters, candCat, baseCat);
  noteComparisonDelta(
    counters,
    challenger.exact,
    baseline.exact,
    baseCat !== 'successful_assignment',
  );
  pushCohortExampleReport(
    exampleReports, example, goldPageIds, goldPageNames, lists,
    candCat, baseCat, challenger, baseline,
  );
}

/**
 * Stage-isolated comparison helper between uncorrected current/baseline and Jev challenger
 * singleton page outputs over the same frozen state with common reviewed product type (issue #299 / AC 8).
 * Honestly reports unavailable and unlabeled cases.
 */
export function compareSingletonPagePredictions(
  gold: GoldExampleForEvaluation[],
  candidatePredictions: BenchmarkPredictionEntry[],
  baselinePredictions: BenchmarkPredictionEntry[],
  options: CompareSingletonPagePredictionsOptions = {},
): SingletonPageComparisonReport {
  const requirePt = options.requireReviewedProductType ?? true;
  const { candidateById, baselineById } = indexComparisonPredictions(
    candidatePredictions,
    baselinePredictions,
  );
  const canEvaluateByIdentity = resolveComparisonIdentityCapability(
    gold,
    candidatePredictions,
    baselinePredictions,
  );
  const counters = emptyPageComparisonCounters();
  const exampleReports: SingletonPageComparisonReport['examples'] = [];
  for (const example of gold) {
    scoreSingletonComparisonExample(
      counters,
      exampleReports,
      example,
      candidateById.get(example.id),
      baselineById.get(example.id),
      canEvaluateByIdentity,
      requirePt,
    );
  }
  return {
    ...finalizePageComparisonSummary(counters, canEvaluateByIdentity),
    examples: exampleReports,
  };
}

// ─── Cohort Category Page Replay & Comparison ─────────────────────────────────

export type CohortPageOutcomeCategory =
  | 'successful_assignment'
  | 'semantic_abstention'
  | 'correctness_rejection'
  | 'model_failure'
  | 'unlabeled'
  | 'unavailable';

export interface CohortOutcomeBreakdown {
  successfulAssignments: number;
  semanticAbstentions: number;
  correctnessRejections: number;
  modelFailures: number;
  unlabeled: number;
  unavailable: number;
}

export interface CohortPageExampleReport {
  exampleId: string;
  productSku: string;
  goldPageIds: string[];
  goldPageNames: string[];
  baselinePageIds: string[];
  baselinePageNames: string[];
  challengerPageIds: string[];
  challengerPageNames: string[];
  baselineCategory: CohortPageOutcomeCategory;
  challengerCategory: CohortPageOutcomeCategory;
  isExactMatchBaseline: boolean;
  isExactMatchChallenger: boolean;
  baselinePrecision: number;
  baselineRecall: number;
  challengerPrecision: number;
  challengerRecall: number;
}

export interface CohortPageComparisonReport extends SharedPageComparisonSummary {
  candidateBreakdown: CohortOutcomeBreakdown;
  baselineBreakdown: CohortOutcomeBreakdown;
  examples: CohortPageExampleReport[];
}

export function classifyCohortPageOutcome(entry: BenchmarkPredictionEntry | undefined): CohortPageOutcomeCategory {
  if (!entry) return 'unavailable';
  const raw = entry as unknown as Record<string, unknown>;
  const failureCode = typeof raw.failureCode === 'string' ? raw.failureCode.trim() : null;
  if (isCohortModelFailure(raw, failureCode)) return 'model_failure';
  const hasPages = (entry.pageAssignments && entry.pageAssignments.length > 0) || (entry.pageIds && entry.pageIds.length > 0);
  if (!entry.abstained && hasPages) return 'successful_assignment';
  const abstentionCode = typeof raw.abstentionCode === 'string' ? raw.abstentionCode.trim() : null;
  const abstentionReason = typeof raw.abstentionReason === 'string' ? String(raw.abstentionReason) : '';
  if (isCohortCorrectnessRejection(abstentionCode, abstentionReason)) return 'correctness_rejection';
  return 'semantic_abstention';
}

export function compareCohortPagePredictions(
  gold: GoldExampleForEvaluation[],
  candidatePredictions: BenchmarkPredictionEntry[],
  baselinePredictions: BenchmarkPredictionEntry[],
  options: CompareSingletonPagePredictionsOptions = {},
): CohortPageComparisonReport {
  const requirePt = options.requireReviewedProductType ?? true;
  const { candidateById, baselineById } = indexComparisonPredictions(
    candidatePredictions,
    baselinePredictions,
  );
  const canEvaluateByIdentity = resolveComparisonIdentityCapability(
    gold,
    candidatePredictions,
    baselinePredictions,
  );
  const counters = emptyPageComparisonCounters();
  const candidateBreakdown = emptyCohortOutcomeBreakdown();
  const baselineBreakdown = emptyCohortOutcomeBreakdown();
  const exampleReports: CohortPageExampleReport[] = [];
  for (const example of gold) {
    scoreCohortComparisonExample(
      counters,
      candidateBreakdown,
      baselineBreakdown,
      exampleReports,
      example,
      candidateById.get(example.id),
      baselineById.get(example.id),
      canEvaluateByIdentity,
      requirePt,
    );
  }
  return {
    ...finalizePageComparisonSummary(counters, canEvaluateByIdentity),
    candidateBreakdown,
    baselineBreakdown,
    examples: exampleReports,
  };
}

export interface CohortPipelineEffectsReport {
  totalMembers: number;
  typeResolution: {
    correct: number;
    abstained: number;
    incorrect: number;
  };
  attributeEffects: {
    totalEvaluated: number;
    correctWhenTypeCorrect: number;
    abstainedWhenTypeAbstained: number;
  };
  pageEffects: {
    totalEvaluated: number;
    exactMatchWhenTypeCorrect: number;
    abstainedWhenTypeAbstained: number;
  };
  endToEndCorrectAllStages: number;
}

// ─── Cohort pipeline-effects sections ─────────────────────────────────────────
// Per-stage scorers for end-to-end cohort effects: type resolution, attribute
// effects conditioned on type correctness, and page effects likewise.

interface PipelinePredictionIndexes {
  typeBySku: Map<string, BenchmarkPredictionEntry>;
  attrBySku: Map<string, BenchmarkPredictionEntry[]>;
  pageBySku: Map<string, BenchmarkPredictionEntry>;
}

/** Index pipeline prediction sides by product SKU (last-wins for type/page). */
function indexPipelinePredictionsBySku(
  typePredictions: BenchmarkPredictionEntry[],
  attributePredictions: BenchmarkPredictionEntry[],
  pagePredictions: BenchmarkPredictionEntry[],
): PipelinePredictionIndexes {
  const typeBySku = new Map<string, BenchmarkPredictionEntry>();
  for (const prediction of typePredictions) typeBySku.set(prediction.productSku, prediction);
  const attrBySku = new Map<string, BenchmarkPredictionEntry[]>();
  for (const prediction of attributePredictions) {
    const list = attrBySku.get(prediction.productSku) ?? [];
    list.push(prediction);
    attrBySku.set(prediction.productSku, list);
  }
  const pageBySku = new Map<string, BenchmarkPredictionEntry>();
  for (const prediction of pagePredictions) pageBySku.set(prediction.productSku, prediction);
  return { typeBySku, attrBySku, pageBySku };
}

interface PipelineTypeStatus {
  isTypeCorrect: boolean;
  isTypeAbstained: boolean;
}

/** Resolve type correctness/abstention for one SKU (legacy id shapes included). */
function resolvePipelineTypeStatus(
  typePred: BenchmarkPredictionEntry | undefined,
  goldType: string | null,
): PipelineTypeStatus {
  const predType = typePred?.productType ?? (typePred as unknown as { predictedProductTypeId?: string })?.predictedProductTypeId;
  return {
    isTypeCorrect: Boolean(goldType && predType === goldType),
    isTypeAbstained: Boolean(typePred?.abstained || !predType),
  };
}

interface PipelineCounters {
  typeCorrect: number;
  typeAbstained: number;
  typeIncorrect: number;
  attrCorrectWhenTypeCorrect: number;
  attrAbstainedWhenTypeAbstained: number;
  totalAttrEvaluated: number;
  pageExactMatchWhenTypeCorrect: number;
  pageAbstainedWhenTypeAbstained: number;
  totalPageEvaluated: number;
  endToEndCorrect: number;
}

function emptyPipelineCounters(): PipelineCounters {
  return {
    typeCorrect: 0,
    typeAbstained: 0,
    typeIncorrect: 0,
    attrCorrectWhenTypeCorrect: 0,
    attrAbstainedWhenTypeAbstained: 0,
    totalAttrEvaluated: 0,
    pageExactMatchWhenTypeCorrect: 0,
    pageAbstainedWhenTypeAbstained: 0,
    totalPageEvaluated: 0,
    endToEndCorrect: 0,
  };
}

/** Tally type resolution for one example. */
function tallyPipelineTypeResolution(
  counters: PipelineCounters,
  status: PipelineTypeStatus,
): void {
  if (status.isTypeCorrect) counters.typeCorrect++;
  else if (status.isTypeAbstained) counters.typeAbstained++;
  else counters.typeIncorrect++;
}

/** Normalized field assignments for one attribute prediction (legacy shapes included). */
function pipelineFieldAssignmentsOf(
  prediction: BenchmarkPredictionEntry,
): Array<{ targetId: string; value: string | null }> {
  if (prediction.fieldAssignments && prediction.fieldAssignments.length > 0) {
    return prediction.fieldAssignments;
  }
  const legacy = prediction as unknown as {
    targetId?: string;
    predictedValue?: string | null;
    predictedValues?: string[];
  };
  if (legacy.targetId) {
    return [{
      targetId: legacy.targetId,
      value: legacy.predictedValue ?? legacy.predictedValues?.[0] ?? null,
    }];
  }
  return [];
}

/** Gold value for one field target (gold value, first values entry, or legacy attributes). */
function pipelineGoldFieldValueOf(
  example: GoldExampleForEvaluation,
  goldFieldMap: Map<string, string | null>,
  targetId: string,
): string | null {
  return goldFieldMap.get(targetId) ??
    (example.goldLabels as unknown as { attributes?: Record<string, string | null> }).attributes?.[targetId] ??
    null;
}

/** Correctness/abstention judgment for one pipeline attribute field. */
function judgePipelineAttributeField(
  goldAttrVal: string | null,
  predVal: string | null,
  abstained: boolean | undefined,
): { correct: boolean; abstained: boolean } {
  return {
    correct: Boolean(goldAttrVal && predVal === goldAttrVal),
    abstained: Boolean(abstained || !predVal),
  };
}

/** Tally one judged attribute field conditioned on the type status. */
function tallyPipelineAttributeJudgment(
  counters: PipelineCounters,
  judgment: { correct: boolean; abstained: boolean },
  status: PipelineTypeStatus,
): void {
  if (status.isTypeCorrect && judgment.correct) counters.attrCorrectWhenTypeCorrect++;
  if (status.isTypeAbstained && judgment.abstained) counters.attrAbstainedWhenTypeAbstained++;
}

/** Score one attribute field for the pipeline effects (conditioned on type status). */
function scorePipelineAttributeField(
  counters: PipelineCounters,
  example: GoldExampleForEvaluation,
  goldFieldMap: Map<string, string | null>,
  prediction: BenchmarkPredictionEntry,
  field: { targetId: string; value: string | null },
  status: PipelineTypeStatus,
): boolean {
  counters.totalAttrEvaluated++;
  const goldAttrVal = pipelineGoldFieldValueOf(example, goldFieldMap, field.targetId);
  const predVal = field.value ?? (field as { values?: string[] }).values?.[0] ?? null;
  const judgment = judgePipelineAttributeField(goldAttrVal, predVal, prediction.abstained);
  tallyPipelineAttributeJudgment(counters, judgment, status);
  return judgment.correct;
}

/** Score attribute effects for one example; returns all-attrs-correct for the SKU. */
function scorePipelineAttributeExample(
  counters: PipelineCounters,
  example: GoldExampleForEvaluation,
  index: PipelinePredictionIndexes,
  status: PipelineTypeStatus,
): boolean {
  const attrs = index.attrBySku.get(example.productSku) ?? [];
  let allAttrsCorrectForSku = attrs.length > 0;
  const goldFieldMap = new Map(
    example.goldLabels.fieldAssignments?.map(field => [field.targetId, field.value ?? field.values?.[0] ?? null]) ?? [],
  );
  for (const prediction of attrs) {
    for (const field of pipelineFieldAssignmentsOf(prediction)) {
      if (!scorePipelineAttributeField(counters, example, goldFieldMap, prediction, field, status)) {
        allAttrsCorrectForSku = false;
      }
    }
  }
  return allAttrsCorrectForSku;
}

/** Gold/predicted page sets for one pipeline example. */
function pipelinePageSetsOf(
  example: GoldExampleForEvaluation,
  pagePred: BenchmarkPredictionEntry | undefined,
): { goldPages: Set<string>; predPages: Set<string> } {
  return {
    goldPages: new Set(
      (example.goldLabels.categoryPageIds ??
        example.goldLabels.pageAssignments?.map(page => page.pageId).filter(Boolean) ??
        []) as string[],
    ),
    predPages: new Set(
      (pagePred?.pageIds ?? pagePred?.pageAssignments ?? []).filter(Boolean) as string[],
    ),
  };
}

/** Tally one pipeline page outcome conditioned on the type status. */
function tallyPipelinePageOutcome(
  counters: PipelineCounters,
  status: PipelineTypeStatus,
  isPageExactMatch: boolean,
  isPageAbstained: boolean,
): void {
  if (status.isTypeCorrect && isPageExactMatch) counters.pageExactMatchWhenTypeCorrect++;
  if (status.isTypeAbstained && isPageAbstained) counters.pageAbstainedWhenTypeAbstained++;
}

/** Score page effects for one example; returns exact-match for end-to-end. */
function scorePipelinePageExample(
  counters: PipelineCounters,
  example: GoldExampleForEvaluation,
  index: PipelinePredictionIndexes,
  status: PipelineTypeStatus,
): boolean {
  const pagePred = index.pageBySku.get(example.productSku);
  const { goldPages, predPages } = pipelinePageSetsOf(example, pagePred);
  counters.totalPageEvaluated++;
  const isPageExactMatch = goldPages.size > 0 &&
    goldPages.size === predPages.size &&
    [...goldPages].every(page => predPages.has(page));
  tallyPipelinePageOutcome(
    counters,
    status,
    isPageExactMatch,
    Boolean(pagePred?.abstained || predPages.size === 0),
  );
  return isPageExactMatch;
}

/** Score one example's end-to-end pipeline effects into the counters. */
function scorePipelineEffectsExample(
  counters: PipelineCounters,
  example: GoldExampleForEvaluation,
  index: PipelinePredictionIndexes,
): void {
  const status = resolvePipelineTypeStatus(
    index.typeBySku.get(example.productSku),
    example.goldLabels.productType,
  );
  tallyPipelineTypeResolution(counters, status);
  const allAttrsCorrect = scorePipelineAttributeExample(counters, example, index, status);
  const pageExact = scorePipelinePageExample(counters, example, index, status);
  if (status.isTypeCorrect && allAttrsCorrect && pageExact) {
    counters.endToEndCorrect++;
  }
}

export function evaluateCohortPipelineEffects(
  gold: GoldExampleForEvaluation[],
  typePredictions: BenchmarkPredictionEntry[],
  attributePredictions: BenchmarkPredictionEntry[],
  pagePredictions: BenchmarkPredictionEntry[],
): CohortPipelineEffectsReport {
  const index = indexPipelinePredictionsBySku(typePredictions, attributePredictions, pagePredictions);
  const counters = emptyPipelineCounters();
  for (const example of gold) {
    scorePipelineEffectsExample(counters, example, index);
  }
  return {
    totalMembers: gold.length,
    typeResolution: {
      correct: counters.typeCorrect,
      abstained: counters.typeAbstained,
      incorrect: counters.typeIncorrect,
    },
    attributeEffects: {
      totalEvaluated: counters.totalAttrEvaluated,
      correctWhenTypeCorrect: counters.attrCorrectWhenTypeCorrect,
      abstainedWhenTypeAbstained: counters.attrAbstainedWhenTypeAbstained,
    },
    pageEffects: {
      totalEvaluated: counters.totalPageEvaluated,
      exactMatchWhenTypeCorrect: counters.pageExactMatchWhenTypeCorrect,
      abstainedWhenTypeAbstained: counters.pageAbstainedWhenTypeAbstained,
    },
    endToEndCorrectAllStages: counters.endToEndCorrect,
  };
}
