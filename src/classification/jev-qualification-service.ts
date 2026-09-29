/**
 * Jev Curation Qualification Service (Issue #302).
 *
 * Implements the offline comparison, qualification policy evaluation,
 * canary sequence verification, connection disablement guarantees,
 * and production qualification blocker reporting for the TypeSafe Jev
 * Curation workflow across:
 * - Primary Product Type
 * - Controlled Product Attributes (single & multi-value)
 * - Category Pages / Cohorts
 */

import {
  evaluateQualificationGate,
  reportRawAccuracyQualification,
  type QualificationResult,
  type RawAccuracyQualificationReport,
} from './benchmark-qualification';
import {
  computeSetMetrics,
  parseValueSet,
  evaluateCohortPipelineEffects,
  type CohortPipelineEffectsReport,
  type GoldExampleForEvaluation,
} from './benchmark-evaluator';
import {
  type QualificationGoldCore,
} from './benchmark-scoring-helpers';
import type { BenchmarkPredictionEntry, EvalMetrics } from '../shared/schemas/classification';
// Canonical proof version produced by `verifyFamilySeparation` (single
// definition site — the exporter owns the proof, this service validates it).
import { FAMILY_SEPARATION_PROOF_VERSION } from './benchmark-exporter';
// REAL applicability for fixed-population attribute scoring (issue #302):
// the shipped frozen-mapping helpers live in benchmark-prediction (single
// definition site — this service reuses them, never reimplements).
import {
  qualificationTaxonomiesFromFrozenSnapshot,
  qualificationApplicableTargetIds,
} from './benchmark-prediction';
import type {
  CompatibilityReceipt,
  FamilySeparationProof,
  FrozenTaxonomySnapshot,
  OperatorDocsReceipt,
} from '../shared/schemas/classification';

export interface QualificationGoldEntry extends QualificationGoldCore {
  baseline: {
    productType: string | null;
    abstained: boolean;
    fieldAssignments: Array<{ targetId: string; value?: string; values?: string[] }>;
    pageIds: string[];
    confidence: number;
    /** Blocked-side code carried from executed predictions (null when unblocked). */
    failureCode?: string | null;
    latencyMs?: number;
    costUsd?: number;
  };
  candidate: {
    productType: string | null;
    abstained: boolean;
    fieldAssignments: Array<{ targetId: string; value?: string; values?: string[] }>;
    pageIds: string[];
    confidence: number;
    /** Blocked-side code carried from executed predictions (null when unblocked). */
    failureCode?: string | null;
    latencyMs?: number;
    costUsd?: number;
  };
}

export interface QualificationGoldset {
  version: number;
  description: string;
  adjudicatedBy: string;
  verifiedPageImport?: {
    importId: string;
    importHash: string;
    provenance: string;
  };
  /**
   * Frozen production taxonomy snapshot the candidate option sets are derived
   * from (additive: legacy fixtures omit it). Gold labels remain the answers;
   * candidates come from this snapshot, never the union of gold labels. The
   * code-executed predictor workstream consumes it; the service carries it as
   * evidence without changing scoring.
   */
  frozenTaxonomy?: FrozenTaxonomySnapshot | null;
  entries: QualificationGoldEntry[];
}

export interface StageMetricComparison {
  rawCorrectness: { baseline: number; candidate: number; delta: number };
  coverage: { baseline: number; candidate: number; delta: number };
  incorrectProposals: { baseline: number; candidate: number; delta: number };
  harmfulRegressions: number;
  recoveredAbstentions: number;
  serviceFailures: { baseline: number; candidate: number };
}

export interface SetMetricComparison {
  exactMatch: { baseline: number; candidate: number };
  precision: { baseline: number; candidate: number };
  recall: { baseline: number; candidate: number };
  f1: { baseline: number; candidate: number };
}

export interface JevOfflineComparisonReport {
  timestamp: string;
  evaluatedExamples: number;
  devCount: number;
  holdoutCount: number;
  productType: StageMetricComparison;
  attributes: StageMetricComparison & { setMetrics: SetMetricComparison };
  categoryPages: StageMetricComparison & { setMetrics: SetMetricComparison };
  telemetry: {
    latency: {
      baseline: { meanMs: number; p50Ms: number; p95Ms: number };
      candidate: { meanMs: number; p50Ms: number; p95Ms: number };
    };
    estimatedCostUsd: {
      baseline: number;
      candidate: number;
    };
    operatorTimeNote: string;
  };
  endToEndPipeline: CohortPipelineEffectsReport;
  summary: {
    candidateOutperformsBaseline: boolean;
    zeroHarmfulRegressionsOnHoldout: boolean;
    zeroServiceFailures: boolean;
  };
}

/**
 * Pure evaluator comparing current-provider baseline vs TypeSafe Jev candidate.
 * Explicitly reports:
 * - raw correctness, coverage, incorrect proposals, harmful regressions, recovered abstentions
 * - field/page set metrics (precision, recall, F1, exact match)
 * - latency, cost, and service failures
 * - stage-isolated and end-to-end pipeline effects
 * - disclaimer: no operator-time gains claimed from pipeline/run duration.
 */
// ─── Offline comparison sections (decomposed named steps) ────────────────────
// `evaluateJevOfflineComparison` orchestrates these stage accumulators; each
// stage (product type, attributes, pages, telemetry, pipeline inputs) owns a
// named function. Metric semantics (including the legacy set-metric argument
// order) are preserved exactly.

interface JevComparisonAccumulator {
  ptBaseCorrect: number;
  ptCandCorrect: number;
  ptBaseAnswered: number;
  ptCandAnswered: number;
  ptBaseIncorrect: number;
  ptCandIncorrect: number;
  ptRegressions: number;
  ptRecovered: number;
  ptBaseFailures: number;
  ptCandFailures: number;
  attrBaseCorrect: number;
  attrCandCorrect: number;
  attrBaseAnswered: number;
  attrCandAnswered: number;
  attrBaseIncorrect: number;
  attrCandIncorrect: number;
  attrRegressions: number;
  attrRecovered: number;
  attrBaseExactMatches: number;
  attrCandExactMatches: number;
  totalAttrPrecBase: number;
  totalAttrRecBase: number;
  totalAttrPrecCand: number;
  totalAttrRecCand: number;
  attrEvaluatedCount: number;
  totalAttrInstances: number;
  pageBaseExactMatches: number;
  pageCandExactMatches: number;
  pageBaseAnswered: number;
  pageCandAnswered: number;
  pageBaseIncorrect: number;
  pageCandIncorrect: number;
  pageRegressions: number;
  pageRecovered: number;
  totalPagePrecBase: number;
  totalPageRecBase: number;
  totalPagePrecCand: number;
  totalPageRecCand: number;
  pageEvaluatedCount: number;
  baseLatencies: number[];
  candLatencies: number[];
  baseTotalCost: number;
  candTotalCost: number;
}

function emptyJevComparisonAccumulator(): JevComparisonAccumulator {
  return {
    ptBaseCorrect: 0,
    ptCandCorrect: 0,
    ptBaseAnswered: 0,
    ptCandAnswered: 0,
    ptBaseIncorrect: 0,
    ptCandIncorrect: 0,
    ptRegressions: 0,
    ptRecovered: 0,
    ptBaseFailures: 0,
    ptCandFailures: 0,
    attrBaseCorrect: 0,
    attrCandCorrect: 0,
    attrBaseAnswered: 0,
    attrCandAnswered: 0,
    attrBaseIncorrect: 0,
    attrCandIncorrect: 0,
    attrRegressions: 0,
    attrRecovered: 0,
    attrBaseExactMatches: 0,
    attrCandExactMatches: 0,
    totalAttrPrecBase: 0,
    totalAttrRecBase: 0,
    totalAttrPrecCand: 0,
    totalAttrRecCand: 0,
    attrEvaluatedCount: 0,
    totalAttrInstances: 0,
    pageBaseExactMatches: 0,
    pageCandExactMatches: 0,
    pageBaseAnswered: 0,
    pageCandAnswered: 0,
    pageBaseIncorrect: 0,
    pageCandIncorrect: 0,
    pageRegressions: 0,
    pageRecovered: 0,
    totalPagePrecBase: 0,
    totalPageRecBase: 0,
    totalPagePrecCand: 0,
    totalPageRecCand: 0,
    pageEvaluatedCount: 0,
    baseLatencies: [],
    candLatencies: [],
    baseTotalCost: 0,
    candTotalCost: 0,
  };
}

type JevSidePrediction = QualificationGoldEntry['baseline'];

type JevGoldProductType = QualificationGoldEntry['gold']['productType'];

/** Product-type correctness under adjudicated gold (unlabeled always true). */
function isJevProductTypeCorrect(
  goldPt: JevGoldProductType,
  prediction: JevSidePrediction,
): boolean {
  if (goldPt.kind === 'known-type') return prediction.productType === goldPt.typeId;
  if (goldPt.kind === 'no-fit' || goldPt.kind === 'insufficient-evidence') {
    return prediction.abstained;
  }
  return true;
}

/** Tally correctness/incorrectness for one side of the product-type stage. */
function tallyJevProductTypeSide(
  acc: JevComparisonAccumulator,
  correct: boolean,
  answered: boolean,
  isBaseline: boolean,
): void {
  if (isBaseline) {
    if (correct) acc.ptBaseCorrect++;
    else if (answered) acc.ptBaseIncorrect++;
  } else {
    if (correct) acc.ptCandCorrect++;
    else if (answered) acc.ptCandIncorrect++;
  }
}

/** Tally answered presence for both sides of the product-type stage. */
function tallyJevProductTypeAnswered(
  acc: JevComparisonAccumulator,
  isBaseAnswered: boolean,
  isCandAnswered: boolean,
): void {
  if (isBaseAnswered) acc.ptBaseAnswered++;
  if (isCandAnswered) acc.ptCandAnswered++;
}

/** Tally correctness transitions (regressions/recoveries) for the type stage. */
function tallyJevProductTypeTransitions(
  acc: JevComparisonAccumulator,
  baseCorrect: boolean,
  candCorrect: boolean,
  baseAbstained: boolean,
): void {
  if (baseCorrect && !candCorrect) acc.ptRegressions++;
  if (!baseCorrect && candCorrect && baseAbstained) acc.ptRecovered++;
}

/** Score the stage-isolated product-type comparison for one entry. */
function accumulateJevProductTypeStage(
  acc: JevComparisonAccumulator,
  entry: QualificationGoldEntry,
): void {
  const goldPt = entry.gold.productType;
  const base = entry.baseline;
  const cand = entry.candidate;
  if (base.failureCode) acc.ptBaseFailures++;
  if (cand.failureCode) acc.ptCandFailures++;
  const isBaseAnswered = !base.abstained && base.productType !== null;
  const isCandAnswered = !cand.abstained && cand.productType !== null;
  tallyJevProductTypeAnswered(acc, isBaseAnswered, isCandAnswered);
  const baseCorrect = isJevProductTypeCorrect(goldPt, base);
  const candCorrect = isJevProductTypeCorrect(goldPt, cand);
  tallyJevProductTypeSide(acc, baseCorrect, isBaseAnswered, true);
  tallyJevProductTypeSide(acc, candCorrect, isCandAnswered, false);
  tallyJevProductTypeTransitions(acc, baseCorrect, candCorrect, base.abstained);
}

/** Value sets by target id for one attribute side. */
function attributeValueSetsOf(
  assignments: Array<{ targetId: string; value?: string; values?: string[] }>,
): Map<string, Set<string>> {
  return new Map(assignments.map(f => [f.targetId, parseValueSet(f.value ?? f.values ?? [])]));
}

/** Score one attribute target's base/candidate sets (legacy argument order kept). */
function scoreJevAttributeTarget(
  acc: JevComparisonAccumulator,
  goldSet: Set<string>,
  baseSet: Set<string>,
  candSet: Set<string>,
): { baseExact: boolean; candExact: boolean } {
  acc.totalAttrInstances++;
  const bMetrics = computeSetMetrics(baseSet, goldSet);
  const cMetrics = computeSetMetrics(candSet, goldSet);
  acc.totalAttrPrecBase += bMetrics.precision;
  acc.totalAttrRecBase += bMetrics.recall;
  acc.totalAttrPrecCand += cMetrics.precision;
  acc.totalAttrRecCand += cMetrics.recall;
  if (bMetrics.exactMatch) acc.attrBaseExactMatches++;
  if (cMetrics.exactMatch) acc.attrCandExactMatches++;
  return { baseExact: bMetrics.exactMatch, candExact: cMetrics.exactMatch };
}

/** Tally answered presence for both sides of the attribute stage. */
function tallyJevAttributeAnswered(
  acc: JevComparisonAccumulator,
  baseAnswered: boolean,
  candAnswered: boolean,
): void {
  if (baseAnswered) acc.attrBaseAnswered++;
  if (candAnswered) acc.attrCandAnswered++;
}

/** Tally all-correct outcomes + transitions for the attribute stage. */
function tallyJevAttributeCorrectness(
  acc: JevComparisonAccumulator,
  baseAllCorrect: boolean,
  candAllCorrect: boolean,
  baseAnswered: boolean,
  candAnswered: boolean,
): void {
  if (baseAllCorrect) acc.attrBaseCorrect++;
  else if (baseAnswered) acc.attrBaseIncorrect++;
  if (candAllCorrect) acc.attrCandCorrect++;
  else if (candAnswered) acc.attrCandIncorrect++;
  if (baseAllCorrect && !candAllCorrect) acc.attrRegressions++;
  if (!baseAllCorrect && candAllCorrect) acc.attrRecovered++;
}

/** Tally all-correct/incorrect/regression transitions for the attribute stage. */
function tallyJevAttributeOutcome(
  acc: JevComparisonAccumulator,
  baseAllCorrect: boolean,
  candAllCorrect: boolean,
  baseAnswered: boolean,
  candAnswered: boolean,
): void {
  tallyJevAttributeAnswered(acc, baseAnswered, candAnswered);
  tallyJevAttributeCorrectness(acc, baseAllCorrect, candAllCorrect, baseAnswered, candAnswered);
}

/**
 * Resolve the FIXED-POPULATION applicable attribute set for one entry
 * (issue #302, from item 1's REAL mapping — never gold-gated prediction).
 *
 * - `unlabeled` gold → null (excluded from the eligible denominator, matching
 *   benchmark-evaluator's `excluded` verdict — never counted correct/incorrect).
 * - Frozen mapping present → applicable ids for the GOLD effective type
 *   (`known-type` typeId, else null → universals only). Throws in prediction;
 *   scoring falls back to the union (weaker, still penalizes extras) rather
 *   than blocking the report.
 * - Frozen absent (legacy script runs) → union of gold + predicted target ids
 *   (gold-free denominator for extras: extra proposals to inapplicable targets
 *   are still visible as false positives, though uncovered applicable misses
 *   beyond gold cannot be seen — documented weaker separation).
 */
function resolveJevAttributeApplicableIds(
  entry: QualificationGoldEntry,
  frozenTaxonomies: ReturnType<typeof qualificationTaxonomiesFromFrozenSnapshot> | null,
): string[] | null {
  if (entry.gold.productType.kind === 'unlabeled') return null;
  const predictedIds = new Set<string>();
  for (const f of entry.baseline.fieldAssignments) predictedIds.add(f.targetId);
  for (const f of entry.candidate.fieldAssignments) predictedIds.add(f.targetId);
  if (frozenTaxonomies) {
    try {
      const goldEffectiveTypeId = entry.gold.productType.kind === 'known-type'
        ? entry.gold.productType.typeId
        : null;
      const applicable = qualificationApplicableTargetIds(frozenTaxonomies, goldEffectiveTypeId);
      return [...new Set([...applicable, ...predictedIds])].sort();
    } catch {
      // Scoring never blocks on mapping gaps — fall through to union.
    }
  }
  const goldIds = new Set(entry.gold.fieldAssignments.map(f => f.targetId));
  return [...new Set([...goldIds, ...predictedIds])].sort();
}

/**
 * Score the attributes comparison for one entry over the FIXED-POPULATION
 * applicable set (issue #302).
 *
 * DELIBERATE metric impact: replacing the legacy gold-only loop NARROWS the
 * denominator to the applicable set PLUS extra predicted targets, so extra
 * proposals to inapplicable targets (`organic`/`material`/`life_stage` when
 * outside the profile) now count as false positives (precision/recall/F1 move
 * DOWN vs the legacy inflated numbers by design) and uncovered applicable
 * targets count as misses (recall/coverage down). Abstention stays honest:
 * an entry with no predictions and all applicable uncovered counts as a miss
 * (not correct, not an incorrect proposal); an abstention on
 * no-fit/insufficient-evidence with no predictions counts as correct.
 */
function accumulateJevAttributeStage(
  acc: JevComparisonAccumulator,
  entry: QualificationGoldEntry,
  frozenTaxonomies: ReturnType<typeof qualificationTaxonomiesFromFrozenSnapshot> | null = null,
): void {
  const applicableIds = resolveJevAttributeApplicableIds(entry, frozenTaxonomies);
  if (applicableIds === null) return;
  if (applicableIds.length === 0) return;
  acc.attrEvaluatedCount++;
  const goldAttrMap = attributeValueSetsOf(entry.gold.fieldAssignments);
  const baseAttrMap = attributeValueSetsOf(entry.baseline.fieldAssignments);
  const candAttrMap = attributeValueSetsOf(entry.candidate.fieldAssignments);
  let allBaseFieldsCorrect = true;
  let allCandFieldsCorrect = true;
  for (const targetId of applicableIds) {
    const goldSet = goldAttrMap.get(targetId) ?? new Set<string>();
    const { baseExact, candExact } = scoreJevAttributeTarget(
      acc,
      goldSet,
      baseAttrMap.get(targetId) ?? new Set<string>(),
      candAttrMap.get(targetId) ?? new Set<string>(),
    );
    if (!baseExact) allBaseFieldsCorrect = false;
    if (!candExact) allCandFieldsCorrect = false;
  }
  tallyJevAttributeOutcome(
    acc,
    allBaseFieldsCorrect,
    allCandFieldsCorrect,
    entry.baseline.fieldAssignments.length > 0,
    entry.candidate.fieldAssignments.length > 0,
  );
}

/** Score one page side's set metrics (legacy argument order kept). */
function scoreJevPageSide(
  acc: JevComparisonAccumulator,
  goldSet: Set<string>,
  sideSet: Set<string>,
  isBaseline: boolean,
): boolean {
  const metrics = computeSetMetrics(sideSet, goldSet);
  if (isBaseline) {
    acc.totalPagePrecBase += metrics.precision;
    acc.totalPageRecBase += metrics.recall;
  } else {
    acc.totalPagePrecCand += metrics.precision;
    acc.totalPageRecCand += metrics.recall;
  }
  return metrics.exactMatch;
}

/** Tally exact-match/incorrect outcomes for one page side. */
function tallyJevPageSideOutcome(
  acc: JevComparisonAccumulator,
  exactMatch: boolean,
  answered: boolean,
  isBaseline: boolean,
): void {
  if (isBaseline) {
    if (exactMatch) acc.pageBaseExactMatches++;
    else if (answered) acc.pageBaseIncorrect++;
  } else {
    if (exactMatch) acc.pageCandExactMatches++;
    else if (answered) acc.pageCandIncorrect++;
  }
}

/** Score the category-pages comparison for one entry (skipped without gold ids). */
function accumulateJevPageStage(
  acc: JevComparisonAccumulator,
  entry: QualificationGoldEntry,
): void {
  if (entry.gold.categoryPages.pageIds.length === 0) return;
  acc.pageEvaluatedCount++;
  const goldPageSet = new Set(entry.gold.categoryPages.pageIds);
  const basePageSet = new Set(entry.baseline.pageIds);
  const candPageSet = new Set(entry.candidate.pageIds);
  const baseExact = scoreJevPageSide(acc, goldPageSet, basePageSet, true);
  const candExact = scoreJevPageSide(acc, goldPageSet, candPageSet, false);
  const baseAnswered = basePageSet.size > 0;
  const candAnswered = candPageSet.size > 0;
  if (baseAnswered) acc.pageBaseAnswered++;
  if (candAnswered) acc.pageCandAnswered++;
  tallyJevPageSideOutcome(acc, baseExact, baseAnswered, true);
  tallyJevPageSideOutcome(acc, candExact, candAnswered, false);
  if (baseExact && !candExact) acc.pageRegressions++;
  if (!baseExact && candExact) acc.pageRecovered++;
}

/** Accumulate latency/cost telemetry for one entry (documented defaults). */
function accumulateJevTelemetry(
  acc: JevComparisonAccumulator,
  entry: QualificationGoldEntry,
): void {
  acc.baseLatencies.push(entry.baseline.latencyMs ?? 250);
  acc.candLatencies.push(entry.candidate.latencyMs ?? 180);
  acc.baseTotalCost += entry.baseline.costUsd ?? 0.002;
  acc.candTotalCost += entry.candidate.costUsd ?? 0.0015;
}

/** Score one gold entry across every comparison stage. */
function accumulateJevComparisonEntry(
  acc: JevComparisonAccumulator,
  entry: QualificationGoldEntry,
  frozenTaxonomies: ReturnType<typeof qualificationTaxonomiesFromFrozenSnapshot> | null = null,
): void {
  accumulateJevTelemetry(acc, entry);
  accumulateJevProductTypeStage(acc, entry);
  accumulateJevAttributeStage(acc, entry, frozenTaxonomies);
  accumulateJevPageStage(acc, entry);
}

/** Latency percentile helpers over sorted samples. */
function latencyPercentile(sorted: number[], ratio: number): number {
  return sorted[Math.floor(sorted.length * ratio)] ?? 0;
}

function latencyMean(samples: number[]): number {
  return samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
}

/** Latency summary (mean/p50/p95) for one side. */
function summarizeJevLatencies(samples: number[]): { meanMs: number; p50Ms: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    meanMs: Math.round(latencyMean(sorted)),
    p50Ms: Math.round(latencyPercentile(sorted, 0.5)),
    p95Ms: Math.round(latencyPercentile(sorted, 0.95)),
  };
}

/** Averaged precision/recall/F1 over per-target slots (zero-safe). */
function averageJevSetMetrics(
  precisionSum: number,
  recallSum: number,
  slots: number,
): { precision: number; recall: number; f1: number } {
  const precision = precisionSum / slots;
  const recall = recallSum / slots;
  return {
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

/** Product-type raw accuracies over all evaluated examples. */
function jevProductTypeAccuracies(
  acc: JevComparisonAccumulator,
  total: number,
): { base: number; candidate: number } {
  return {
    base: total > 0 ? acc.ptBaseCorrect / total : 0,
    candidate: total > 0 ? acc.ptCandCorrect / total : 0,
  };
}

/** Product-type stage report (raw correctness, coverage, errors, failures). */
function buildJevProductTypeReport(
  acc: JevComparisonAccumulator,
  total: number,
): JevOfflineComparisonReport['productType'] {
  const { base, candidate } = jevProductTypeAccuracies(acc, total);
  return {
    rawCorrectness: {
      baseline: Number(base.toFixed(4)),
      candidate: Number(candidate.toFixed(4)),
      delta: Number((candidate - base).toFixed(4)),
    },
    coverage: {
      baseline: Number((acc.ptBaseAnswered / (total || 1)).toFixed(4)),
      candidate: Number((acc.ptCandAnswered / (total || 1)).toFixed(4)),
      delta: Number(((acc.ptCandAnswered - acc.ptBaseAnswered) / (total || 1)).toFixed(4)),
    },
    incorrectProposals: {
      baseline: acc.ptBaseIncorrect,
      candidate: acc.ptCandIncorrect,
      delta: acc.ptCandIncorrect - acc.ptBaseIncorrect,
    },
    harmfulRegressions: acc.ptRegressions,
    recoveredAbstentions: acc.ptRecovered,
    serviceFailures: {
      baseline: acc.ptBaseFailures,
      candidate: acc.ptCandFailures,
    },
  };
}

/** Attributes stage report (correctness, coverage, errors, set metrics). */
function buildJevAttributesReport(
  acc: JevComparisonAccumulator,
): JevOfflineComparisonReport['attributes'] {
  const evaluated = acc.attrEvaluatedCount;
  const slots = acc.totalAttrInstances > 0 ? acc.totalAttrInstances : 1;
  const base = averageJevSetMetrics(acc.totalAttrPrecBase, acc.totalAttrRecBase, slots);
  const cand = averageJevSetMetrics(acc.totalAttrPrecCand, acc.totalAttrRecCand, slots);
  return {
    rawCorrectness: {
      baseline: Number((acc.attrBaseCorrect / (evaluated || 1)).toFixed(4)),
      candidate: Number((acc.attrCandCorrect / (evaluated || 1)).toFixed(4)),
      delta: Number(((acc.attrCandCorrect - acc.attrBaseCorrect) / (evaluated || 1)).toFixed(4)),
    },
    coverage: {
      baseline: Number((acc.attrBaseAnswered / (evaluated || 1)).toFixed(4)),
      candidate: Number((acc.attrCandAnswered / (evaluated || 1)).toFixed(4)),
      delta: Number(((acc.attrCandAnswered - acc.attrBaseAnswered) / (evaluated || 1)).toFixed(4)),
    },
    incorrectProposals: {
      baseline: acc.attrBaseIncorrect,
      candidate: acc.attrCandIncorrect,
      delta: acc.attrCandIncorrect - acc.attrBaseIncorrect,
    },
    harmfulRegressions: acc.attrRegressions,
    recoveredAbstentions: acc.attrRecovered,
    serviceFailures: { baseline: 0, candidate: 0 },
    setMetrics: buildJevSetMetricsReport(
      acc.attrBaseExactMatches,
      acc.attrCandExactMatches,
      slots,
      base,
      cand,
    ),
  };
}

/** Shared set-metrics report (exact match + averaged precision/recall/F1). */
function buildJevSetMetricsReport(
  baseExactMatches: number,
  candExactMatches: number,
  divisor: number,
  base: { precision: number; recall: number; f1: number },
  cand: { precision: number; recall: number; f1: number },
): SetMetricComparison {
  return {
    exactMatch: {
      baseline: Number((baseExactMatches / divisor).toFixed(4)),
      candidate: Number((candExactMatches / divisor).toFixed(4)),
    },
    precision: {
      baseline: Number(base.precision.toFixed(4)),
      candidate: Number(cand.precision.toFixed(4)),
    },
    recall: {
      baseline: Number(base.recall.toFixed(4)),
      candidate: Number(cand.recall.toFixed(4)),
    },
    f1: {
      baseline: Number(base.f1.toFixed(4)),
      candidate: Number(cand.f1.toFixed(4)),
    },
  };
}

/** Category-pages set-metrics report from averaged precision/recall/F1. */
function buildJevPageSetMetricsReport(
  acc: JevComparisonAccumulator,
  evaluated: number,
  base: { precision: number; recall: number; f1: number },
  cand: { precision: number; recall: number; f1: number },
): JevOfflineComparisonReport['categoryPages']['setMetrics'] {
  return buildJevSetMetricsReport(
    acc.pageBaseExactMatches,
    acc.pageCandExactMatches,
    evaluated || 1,
    base,
    cand,
  );
}

/** Category-pages stage report (exact-match correctness, coverage, set metrics). */
function buildJevCategoryPagesReport(
  acc: JevComparisonAccumulator,
): JevOfflineComparisonReport['categoryPages'] {
  const evaluated = acc.pageEvaluatedCount;
  const slots = evaluated > 0 ? evaluated : 1;
  const base = averageJevSetMetrics(acc.totalPagePrecBase, acc.totalPageRecBase, slots);
  const cand = averageJevSetMetrics(acc.totalPagePrecCand, acc.totalPageRecCand, slots);
  return {
    rawCorrectness: {
      baseline: Number((acc.pageBaseExactMatches / (evaluated || 1)).toFixed(4)),
      candidate: Number((acc.pageCandExactMatches / (evaluated || 1)).toFixed(4)),
      delta: Number(((acc.pageCandExactMatches - acc.pageBaseExactMatches) / (evaluated || 1)).toFixed(4)),
    },
    coverage: {
      baseline: Number((acc.pageBaseAnswered / (evaluated || 1)).toFixed(4)),
      candidate: Number((acc.pageCandAnswered / (evaluated || 1)).toFixed(4)),
      delta: Number(((acc.pageCandAnswered - acc.pageBaseAnswered) / (evaluated || 1)).toFixed(4)),
    },
    incorrectProposals: {
      baseline: acc.pageBaseIncorrect,
      candidate: acc.pageCandIncorrect,
      delta: acc.pageCandIncorrect - acc.pageBaseIncorrect,
    },
    harmfulRegressions: acc.pageRegressions,
    recoveredAbstentions: acc.pageRecovered,
    serviceFailures: { baseline: 0, candidate: 0 },
    setMetrics: buildJevPageSetMetricsReport(acc, evaluated, base, cand),
  };
}

/** Latency/cost telemetry report (no operator-time claims). */
function buildJevTelemetryReport(
  acc: JevComparisonAccumulator,
): JevOfflineComparisonReport['telemetry'] {
  return {
    latency: {
      baseline: summarizeJevLatencies(acc.baseLatencies),
      candidate: summarizeJevLatencies(acc.candLatencies),
    },
    estimatedCostUsd: {
      baseline: Number(acc.baseTotalCost.toFixed(4)),
      candidate: Number(acc.candTotalCost.toFixed(4)),
    },
    operatorTimeNote:
      'Pipeline and model run duration metrics reflect computational latency and do not constitute measured operator-time gains.',
  };
}

/** End-to-end pipeline inputs for `evaluateCohortPipelineEffects`. */
function buildJevPipelineInputs(
  entries: QualificationGoldEntry[],
  goldset: QualificationGoldset,
): {
  goldForEffects: GoldExampleForEvaluation[];
  typePreds: BenchmarkPredictionEntry[];
  attrPreds: BenchmarkPredictionEntry[];
  pagePreds: BenchmarkPredictionEntry[];
} {
  const goldForEffects: GoldExampleForEvaluation[] = entries.map(e => ({
    id: `ex-${e.sku}`,
    productSku: e.sku,
    evidenceText: e.evidence.map(ev => ev.snippet).join(' '),
    goldLabels: {
      productType: e.gold.productType.typeId,
      fieldAssignments: e.gold.fieldAssignments.map(f => ({
        targetId: f.targetId,
        value: f.value ?? null,
        values: f.values ?? (f.value ? [f.value] : []),
      })),
      categoryPageIds: e.gold.categoryPages.pageIds,
      pageAssignments: e.gold.categoryPages.pageAssignments,
      verifiedImportProvenance: goldset.verifiedPageImport?.provenance ?? null,
    },
  }));

  const typePreds: BenchmarkPredictionEntry[] = entries.map(e => ({
    exampleId: `ex-${e.sku}`,
    productSku: e.sku,
    productType: e.candidate.productType,
    abstained: e.candidate.abstained,
    confidence: e.candidate.confidence,
    pageAssignments: [],
    fieldAssignments: [],
    claimTargets: [],
  }));

  const attrPreds: BenchmarkPredictionEntry[] = entries.map(e => ({
    exampleId: `ex-${e.sku}`,
    productSku: e.sku,
    productType: null,
    abstained: e.candidate.abstained,
    confidence: e.candidate.confidence,
    pageAssignments: [],
    fieldAssignments: e.candidate.fieldAssignments.map(f => ({
      targetId: f.targetId,
      value: f.value ?? null,
      values: f.values ?? (f.value ? [f.value] : []),
    })),
    claimTargets: [],
  }));

  const pagePreds: BenchmarkPredictionEntry[] = entries.map(e => ({
    exampleId: `ex-${e.sku}`,
    productSku: e.sku,
    productType: null,
    pageIds: e.candidate.pageIds,
    pageAssignments: e.candidate.pageIds.map(p => p),
    fieldAssignments: [],
    abstained: e.candidate.abstained,
    confidence: e.candidate.confidence,
    claimTargets: [],
  }));

  return { goldForEffects, typePreds, attrPreds, pagePreds };
}

export function evaluateJevOfflineComparison(
  goldset: QualificationGoldset,
  filterSplit?: 'dev' | 'holdout',
): JevOfflineComparisonReport {
  const entries = filterSplit ? goldset.entries.filter(e => e.split === filterSplit) : goldset.entries;
  const devEntries = goldset.entries.filter(e => e.split === 'dev');
  const holdoutEntries = goldset.entries.filter(e => e.split === 'holdout');

  // Fixed-population applicability (issue #302): when the goldset carries the
  // frozen taxonomy, attribute scoring uses the REAL applicable set per entry
  // (gold type's profile + predicted extras); otherwise it falls back to the
  // gold+predicted union (still penalizes extras, weaker on uncovered misses).
  let frozenTaxonomies: ReturnType<typeof qualificationTaxonomiesFromFrozenSnapshot> | null = null;
  if (goldset.frozenTaxonomy) {
    try {
      frozenTaxonomies = qualificationTaxonomiesFromFrozenSnapshot(goldset.frozenTaxonomy);
    } catch {
      frozenTaxonomies = null;
    }
  }

  const acc = emptyJevComparisonAccumulator();

  for (const entry of entries) {
    accumulateJevComparisonEntry(acc, entry, frozenTaxonomies);
  }

  const total = entries.length;
  const { base: ptBaseAccuracy, candidate: ptCandAccuracy } = jevProductTypeAccuracies(acc, total);

  // Prepare entries for evaluateCohortPipelineEffects
  const pipelineInputs = buildJevPipelineInputs(entries, goldset);
  const pipelineEffects = evaluateCohortPipelineEffects(
    pipelineInputs.goldForEffects,
    pipelineInputs.typePreds,
    pipelineInputs.attrPreds,
    pipelineInputs.pagePreds,
  );

  return {
    timestamp: new Date().toISOString(),
    evaluatedExamples: total,
    devCount: devEntries.length,
    holdoutCount: holdoutEntries.length,
    productType: buildJevProductTypeReport(acc, total),
    attributes: buildJevAttributesReport(acc),
    categoryPages: buildJevCategoryPagesReport(acc),
    telemetry: buildJevTelemetryReport(acc),
    endToEndPipeline: pipelineEffects,
    summary: {
      candidateOutperformsBaseline: ptCandAccuracy >= ptBaseAccuracy,
      zeroHarmfulRegressionsOnHoldout: acc.ptRegressions === 0,
      zeroServiceFailures: acc.ptCandFailures === 0,
    },
  };
}

export interface ProductionQualificationBlocker {
  criterion: number;
  area: string;
  code: string;
  message: string;
  actionRequired: string;
}

export interface ProductionQualificationAssessment {
  status: 'qualified' | 'provisionally_qualified' | 'blocked';
  evaluatedAt: string;
  blockers: ProductionQualificationBlocker[];
  summary: string;
  checklist: {
    offlineEvaluationPassed: boolean;
    familySeparationPassed: boolean;
    policiesPublished: boolean;
    comparisonReportComplete: boolean;
    liveCredentialsProvisioned: boolean;
    liveContractCheckPassed: boolean;
    stagedCanariesReviewed: boolean;
    connectionDisablementVerified: boolean;
    compatibilityVerified: boolean;
    operatorDocumentationPublished: boolean;
  };
}

// ─── Production qualification sections (decomposed named steps) ───────────────
// Every gate below independently adds a blocker (fail-closed); the checklist
// flags are set from direct evidence only. Blocker codes/messages/actions are
// preserved verbatim — decomposition must never weaken a gate.

type ProductionChecklist = ProductionQualificationAssessment['checklist'];

interface ProductionQualificationInputs {
  hasTypeSafeApiKey: boolean;
  liveContractCheckExecuted: boolean;
  liveContractCheckSuccess: boolean;
  canaryProductTypeReviewed: boolean;
  canaryAttributesReviewed: boolean;
  canaryCohortPagesReviewed: boolean;
  offlineComparisonReport?: JevOfflineComparisonReport;
  /**
   * Family-separation proof (shared-identity + near-duplicate verification
   * over the qualification goldset, e.g. via `verifyFamilySeparation`).
   * Absent or failing proof keeps the fail-closed blocker below.
   */
  familySeparationProof?: FamilySeparationProof | null;
  /**
   * Compatibility receipt (already-green suites recorded at qualification
   * time with suite identifiers + commit + pass status). Absent or failing
   * receipt keeps the fail-closed blocker below.
   */
  compatibilityReceipt?: CompatibilityReceipt | null;
  /**
   * Commit the compatibility receipt must be bound to (issue #302): the
   * current HEAD (or the explicitly qualified commit/digest recorded with the
   * run). Every suite's `commit` must equal this value — an old green receipt
   * cannot qualify later changed code. Null/undefined means the caller did
   * not bind (fail-closed when a receipt is present but unbound? No — legacy
   * callers without binding keep the prior non-empty-commit check; binding is
   * enforced whenever an expected commit is supplied, and the qualification
   * runner always supplies HEAD).
   */
  compatibilityExpectedCommit?: string | null;
  /**
   * Operator-documentation receipt (published runbook path + content hash
   * recorded at qualification time). Absent or failing receipt keeps the
   * fail-closed blocker below.
   */
  operatorDocsReceipt?: OperatorDocsReceipt | null;
}

// ─── Qualification evidence receipts ─────────────────────────────────────────
// Explicit evidence inputs consumed by the gates below. Every receipt is
// fail-closed when absent: omitting a receipt reproduces today's blockers
// byte-for-byte. The family-separation proof version is canonical in
// `benchmark-exporter.ts` (imported above) — never redefined here.

/**
 * Compatibility suites that must each report passed at qualification time:
 * other providers, deterministic rules, frozen snapshots, and legacy reads.
 * Suite ids map to the already-green seams: provider transports
 * (classification policy stages), deterministic page rules (page/cohort
 * seams), frozen runtime snapshots, and legacy reviewed-outcome/legacy-gold
 * reads (prediction/evaluator contracts).
 */
export const REQUIRED_COMPATIBILITY_SUITE_IDS = [
  'other-providers',
  'deterministic-rules',
  'frozen-snapshots',
  'legacy-reads',
] as const;

/** Published runbook path accepted by the operator-docs gate. */
export const OPERATOR_RUNBOOK_PATH = 'docs/runbooks/typesafe-jev-curation-rollout.md' as const;

/** Proof version + timestamp identity for a family-separation receipt. */
function hasFamilyProofIdentity(proof: FamilySeparationProof): boolean {
  return (
    proof.proofVersion === FAMILY_SEPARATION_PROOF_VERSION &&
    typeof proof.verifiedAt === 'string' &&
    proof.verifiedAt.trim() !== ''
  );
}

/** Non-empty checked population for a family-separation receipt. */
function hasFamilyProofPopulation(proof: FamilySeparationProof): boolean {
  return proof.familiesChecked > 0;
}

/** Zero-leakage outcome for a family-separation receipt. */
function hasFamilyProofCleanOutcome(proof: FamilySeparationProof): boolean {
  return (
    proof.passed === true &&
    Array.isArray(proof.leakedFamilies) &&
    proof.leakedFamilies.length === 0 &&
    Array.isArray(proof.nearDuplicatePairs) &&
    proof.nearDuplicatePairs.length === 0
  );
}

/** True for a family-separation proof that establishes zero leakage. */
function isValidFamilySeparationProof(proof: FamilySeparationProof | null | undefined): boolean {
  if (!proof || typeof proof !== 'object') return false;
  return (
    hasFamilyProofIdentity(proof) &&
    hasFamilyProofPopulation(proof) &&
    hasFamilyProofCleanOutcome(proof)
  );
}

/**
 * True for a compatibility receipt with every required suite passing AND
 * commit-bound to the code being qualified (issue #302).
 *
 * DELIBERATE gate tightening: when `expectedCommit` is supplied (the runner
 * always supplies HEAD), every suite's `commit` must equal it — an old green
 * receipt for a different commit FAILS (blocker retained), even when every
 * suite passed. When `expectedCommit` is absent (legacy direct callers), the
 * prior non-empty-commit check applies (documented weaker binding — the
 * runner never uses this path).
 */
function isValidCompatibilityReceipt(
  receipt: CompatibilityReceipt | null | undefined,
  expectedCommit?: string | null,
): boolean {
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.suites)) return false;
  if (typeof receipt.recordedAt !== 'string' || receipt.recordedAt.trim() === '') return false;
  const byId = new Map(receipt.suites.map(suite => [suite?.suiteId, suite]));
  const bound = typeof expectedCommit === 'string' && expectedCommit.trim() !== '';
  return (REQUIRED_COMPATIBILITY_SUITE_IDS as readonly string[]).every(suiteId => {
    const result = byId.get(suiteId);
    if (!result || result.passed !== true) return false;
    if (typeof result.commit !== 'string' || result.commit.trim() === '') return false;
    if (bound && result.commit !== expectedCommit) return false;
    return true;
  });
}

/**
 * Commit-mismatch detail for a receipt that passes structurally but is bound
 * to a different commit (fail-closed — blocker retained, never silently
 * current). Null when structurally invalid or fully bound.
 */
function compatibilityCommitMismatchDetail(
  receipt: CompatibilityReceipt | null | undefined,
  expectedCommit?: string | null,
): string | null {
  if (!receipt || typeof expectedCommit !== 'string' || expectedCommit.trim() === '') return null;
  const mismatched = (receipt.suites ?? [])
    .filter(s => typeof s?.commit === 'string' && s.commit !== expectedCommit)
    .map(s => `${s.suiteId}@${s.commit.slice(0, 12)}`);
  if (mismatched.length === 0) return null;
  return `compatibility receipt bound to ${mismatched.join(', ')}; expected ${expectedCommit.slice(0, 12)}… (refresh after the suites pass at the qualified commit)`;
}

/** True for an operator-docs receipt bound to the published runbook bytes. */
function isValidOperatorDocsReceipt(receipt: OperatorDocsReceipt | null | undefined): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  return (
    receipt.runbookPath === OPERATOR_RUNBOOK_PATH &&
    typeof receipt.contentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(receipt.contentHash)
  );
}

/** Fail-closed checklist defaults (verification flags start false). */
function emptyProductionChecklist(
  inputs: ProductionQualificationInputs,
): ProductionChecklist {
  return {
    offlineEvaluationPassed: false,
    familySeparationPassed: false,
    policiesPublished: true,
    comparisonReportComplete: false,
    liveCredentialsProvisioned: inputs.hasTypeSafeApiKey,
    liveContractCheckPassed: inputs.liveContractCheckExecuted && inputs.liveContractCheckSuccess,
    stagedCanariesReviewed:
      inputs.canaryProductTypeReviewed &&
      inputs.canaryAttributesReviewed &&
      inputs.canaryCohortPagesReviewed,
    connectionDisablementVerified: true,
    compatibilityVerified: false,
    operatorDocumentationPublished: false,
  };
}

/** Criterion 4 (missing report): independently blocking + offline unevaluated. */
function blockMissingComparisonReport(blockers: ProductionQualificationBlocker[]): void {
  blockers.push({
    criterion: 4,
    area: 'offline_comparison_report',
    code: 'comparison_report_missing',
    message: 'Offline baseline-vs-Jev comparison report has not been produced.',
    actionRequired: 'Run bun scripts/typesafe-curation-qualification.ts to produce the offline comparison report.',
  });
  blockers.push({
    criterion: 4,
    area: 'offline_evaluation',
    code: 'offline_evaluation_incomplete',
    message: 'Offline evaluation cannot be established without a comparison report.',
    actionRequired: 'Provide offlineComparisonReport with candidate outperforming baseline and zero regressions/service failures.',
  });
}

/** Zero-regression detail: summary flag plus every stage at zero. */
function hasZeroRegressions(report: JevOfflineComparisonReport): boolean {
  return report.summary.zeroHarmfulRegressionsOnHoldout === true &&
    report.productType.harmfulRegressions === 0 &&
    report.attributes.harmfulRegressions === 0 &&
    report.categoryPages.harmfulRegressions === 0;
}

/** Candidate service failures summed across stages. */
function countCandidateServiceFailures(report: JevOfflineComparisonReport): number {
  return (report.productType.serviceFailures?.candidate ?? 0) +
    (report.attributes.serviceFailures?.candidate ?? 0) +
    (report.categoryPages.serviceFailures?.candidate ?? 0);
}

/** Offline pass detail: outperforms + zero regressions + zero service failures. */
function offlinePassDetail(report: JevOfflineComparisonReport): {
  outperforms: boolean;
  zeroRegressions: boolean;
  zeroServiceFailures: boolean;
  candidateServiceFailures: number;
} {
  const outperforms = report.summary.candidateOutperformsBaseline === true;
  const zeroRegressions = hasZeroRegressions(report);
  const candidateServiceFailures = countCandidateServiceFailures(report);
  return {
    outperforms,
    zeroRegressions,
    zeroServiceFailures: report.summary.zeroServiceFailures === true && candidateServiceFailures === 0,
    candidateServiceFailures,
  };
}

/** Criterion 4 (report present): each failing condition blocks independently. */
function assessOfflineComparisonGates(
  blockers: ProductionQualificationBlocker[],
  checklist: ProductionChecklist,
  report: JevOfflineComparisonReport,
): void {
  checklist.comparisonReportComplete = true;
  const detail = offlinePassDetail(report);
  checklist.offlineEvaluationPassed =
    detail.outperforms && detail.zeroRegressions && detail.zeroServiceFailures;
  if (!detail.outperforms) {
    blockers.push({
      criterion: 4,
      area: 'offline_evaluation',
      code: 'offline_evaluation_failed',
      message: 'Offline evaluation did not show the Jev candidate outperforming the baseline.',
      actionRequired: 'Investigate offline comparison deltas; do not promote until candidateOutperformsBaseline is true.',
    });
  }
  if (!detail.zeroRegressions) {
    blockers.push({
      criterion: 4,
      area: 'offline_regressions',
      code: 'harmful_regressions_detected',
      message: 'Offline evaluation detected harmful regressions vs baseline.',
      actionRequired: 'Resolve harmful regressions (product type, attributes, and pages must each show zero) before release.',
    });
  }
  // Service failures independently block even when raw accuracy looks
  // fine: an unavailable service must never count as a correct abstention.
  if (!detail.zeroServiceFailures) {
    blockers.push({
      criterion: 4,
      area: 'offline_service_failures',
      code: 'service_failures_detected',
      message: `Offline evaluation recorded ${detail.candidateServiceFailures} candidate service failure(s).`,
      actionRequired: 'Eliminate candidate service failures (summary.zeroServiceFailures must be true) before release.',
    });
  }
}

/**
 * Criterion 2: family separation is never assumed. Without a zero-leakage
 * proof (shared family identity plus cross-split near-duplicate detection,
 * e.g. `verifyFamilySeparation` over the goldset familyIds) the gate fails
 * closed with the blocker below. A valid proof sets
 * `familySeparationPassed` and clears the blocker.
 */
function assessFamilySeparationGates(
  blockers: ProductionQualificationBlocker[],
  checklist: ProductionChecklist,
  proof: FamilySeparationProof | null | undefined,
): void {
  if (isValidFamilySeparationProof(proof)) {
    checklist.familySeparationPassed = true;
    return;
  }
  checklist.familySeparationPassed = false;
  blockers.push({
    criterion: 2,
    area: 'family_separation',
    code: 'family_separation_unverified',
    message: 'Family-separated dev/holdout evaluation has not been verified (zero-leakage proof absent).',
    actionRequired: 'Verify family-split isolation (e.g. detectFamilySplitLeakage over goldset familyIds) and wire the proof into the qualification input.',
  });
}

/**
 * Criterion 8: compatibility is never assumed. Without a receipt recording
 * the already-green suites (other providers, deterministic rules, frozen
 * snapshots, legacy reads) with suite identifiers + commit + pass status at
 * qualification time, the gate fails closed with the blocker below. A valid
 * receipt sets `compatibilityVerified` and clears the blocker. Commit-bound
 * (issue #302): when `expectedCommit` is supplied, every suite commit must
 * match it — a stale green receipt for an older commit retains the blocker.
 */
function assessCompatibilityGates(
  blockers: ProductionQualificationBlocker[],
  checklist: ProductionChecklist,
  receipt: CompatibilityReceipt | null | undefined,
  expectedCommit?: string | null,
): void {
  if (isValidCompatibilityReceipt(receipt, expectedCommit ?? null)) {
    checklist.compatibilityVerified = true;
    return;
  }
  checklist.compatibilityVerified = false;
  const mismatch = compatibilityCommitMismatchDetail(receipt, expectedCommit ?? null);
  blockers.push({
    criterion: 8,
    area: 'compatibility',
    code: 'compatibility_unverified',
    message: mismatch
      ?? 'Compatibility with other providers, deterministic rules, frozen snapshots, and legacy reads is unverified.',
    actionRequired: mismatch
      ? `Re-run the four compatibility suites at ${String(expectedCommit).slice(0, 12)}… and refresh the receipt (receipt records the commit it passed on).`
      : 'Run compatibility verification (other providers, deterministic rules, frozen snapshots, legacy reads) and wire its result into qualification.',
  });
}

/**
 * Criterion 9: operator documentation is never assumed. Without a receipt
 * recording the published runbook path + content hash at qualification time,
 * the gate fails closed with the blocker below. A valid receipt sets
 * `operatorDocumentationPublished` and clears the blocker.
 */
function assessOperatorDocumentationGates(
  blockers: ProductionQualificationBlocker[],
  checklist: ProductionChecklist,
  receipt: OperatorDocsReceipt | null | undefined,
): void {
  if (isValidOperatorDocsReceipt(receipt)) {
    checklist.operatorDocumentationPublished = true;
    return;
  }
  checklist.operatorDocumentationPublished = false;
  blockers.push({
    criterion: 9,
    area: 'operator_documentation',
    code: 'operator_docs_missing',
    message: 'Operator documentation and confidence concepts are not recorded as published.',
    actionRequired: 'Publish operator documentation (rollout runbook, confidence concepts) and wire its receipt into qualification.',
  });
}

/** Criterion 5: bounded live contract check requires provisioned credentials. */
function assessLiveContractGates(
  blockers: ProductionQualificationBlocker[],
  inputs: ProductionQualificationInputs,
): void {
  if (!inputs.hasTypeSafeApiKey) {
    blockers.push({
      criterion: 5,
      area: 'live_provider_credentials',
      code: 'missing_typesafe_api_key',
      message: 'TYPESAFE_API_KEY is not provisioned in the environment.',
      actionRequired: 'Provision a valid TYPESAFE_API_KEY in the environment or .env file before running live checks.',
    });
  }
  if (inputs.hasTypeSafeApiKey && (!inputs.liveContractCheckExecuted || !inputs.liveContractCheckSuccess)) {
    blockers.push({
      criterion: 5,
      area: 'live_provider_contract',
      code: 'live_contract_check_incomplete',
      message: 'Bounded live contract check has not passed against api.typesafe.ai.',
      actionRequired: 'Run TYPESAFE_LIVE_CHECK=1 bun scripts/typesafe-live-contract-check.ts with valid credentials.',
    });
  }
}

/** Criterion 6: staged canaries require final human approval in order. */
function assessCanaryGates(
  blockers: ProductionQualificationBlocker[],
  inputs: ProductionQualificationInputs,
): void {
  if (!inputs.canaryProductTypeReviewed) {
    blockers.push({
      criterion: 6,
      area: 'staged_canaries',
      code: 'canary_product_type_unreviewed',
      message: 'Product Type canary cohort has not received final Store Manager review sign-off.',
      actionRequired: 'Execute Stage 1 Product Type canary and record operator review in review drawer.',
    });
  }
  if (!inputs.canaryAttributesReviewed) {
    blockers.push({
      criterion: 6,
      area: 'staged_canaries',
      code: 'canary_attributes_unreviewed',
      message: 'Controlled attributes canary cohort has not received final Store Manager review sign-off.',
      actionRequired: 'Execute Stage 2 controlled attributes canary and record operator review in review drawer.',
    });
  }
  if (!inputs.canaryCohortPagesReviewed) {
    blockers.push({
      criterion: 6,
      area: 'staged_canaries',
      code: 'canary_cohort_pages_unreviewed',
      message: 'Category Pages/cohorts canary has not received final Store Manager review sign-off.',
      actionRequired: 'Execute Stage 3 Category Pages cohort canary and record operator review in review drawer.',
    });
  }
}

/**
 * Resolve the qualification status. 'qualified' requires zero blockers;
 * clean offline evidence with remaining verification/operational blockers is
 * 'provisionally_qualified'; incomplete/failed offline evidence is 'blocked'.
 */
function resolveProductionQualificationStatus(
  checklist: ProductionChecklist,
  blockers: ProductionQualificationBlocker[],
): ProductionQualificationAssessment['status'] {
  const isBlocked = blockers.length > 0;
  // Note (genuinely not gating here): policiesPublished and
  // connectionDisablementVerified remain true without adding blockers. They
  // are owned by other seams (Criterion 3 qualification gates via
  // evaluateQualificationGate; Criterion 7 disablement dispatch guarantees)
  // and this function's signature carries no evidence input that could
  // fail-closed on them without making every assessment trivially blocked
  // for reasons outside its remit. All eight required gates above
  // (offline, report, family, service, compatibility, docs, live, canaries)
  // independently block 'qualified'.
  const isOfflineClean =
    checklist.offlineEvaluationPassed && checklist.comparisonReportComplete;
  const isProvisionallyQualified = isOfflineClean && isBlocked;
  return !isBlocked ? 'qualified' : isProvisionallyQualified ? 'provisionally_qualified' : 'blocked';
}

/** Human summary for the qualification status + blocker codes. */
function summarizeProductionQualification(
  status: ProductionQualificationAssessment['status'],
  blockers: ProductionQualificationBlocker[],
): string {
  if (status === 'qualified') {
    return 'The complete reviewed Jev Curation workflow is fully qualified for production release.';
  }
  if (status === 'provisionally_qualified') {
    return `Offline benchmarks and comparison reports are fully qualified, but production qualification remains incomplete due to ${blockers.length} verification/operational prerequisite(s) (${blockers.map(b => b.code).join(', ')}).`;
  }
  return `Production qualification is blocked: ${blockers.map(b => b.code).join(', ')}`;
}

/**
 * Checks all 10 acceptance criteria and produces an honest assessment.
 *
 * Fail-closed semantics (fix for confirmed blocker where operational flags
 * alone could yield 'qualified'):
 * - 'qualified' requires zero blockers. Every gate below independently adds
 *   a blocker, so any single failure prevents 'qualified'.
 * - 'provisionally_qualified' means offline evidence itself is clean
 *   (offlineEvaluationPassed && comparisonReportComplete, which includes
 *   zero harmful regressions and zero service failures) but operational /
 *   verification blockers remain (family separation, live
 *   credentials/contract, staged canaries, compatibility, operator docs).
 * - 'blocked' means offline evidence itself is incomplete or failed
 *   (missing report, offline failure, service failures, regressions).
 *   Offline failures never yield 'provisionally_qualified'.
 *
 * The family-separation, compatibility, and operator-docs gates consume
 * explicit evidence receipts (`familySeparationProof`, `compatibilityReceipt`,
 * `operatorDocsReceipt`): each is fail-closed when its receipt is absent or
 * failing, and clears only on a valid receipt. Omitting all three receipts
 * reproduces the previous always-blocking behavior exactly.
 * If credentials, live contract check, or store manager canary review
 * are missing, reports the specific blocker and keeps qualification incomplete.
 */
export function assessProductionQualification(
  options: ProductionQualificationInputs,
): ProductionQualificationAssessment {
  const blockers: ProductionQualificationBlocker[] = [];
  // Fail-closed defaults: every verification flag starts false (or is set
  // from direct evidence below). The two exceptions documented at the end
  // (policiesPublished, connectionDisablementVerified) are owned by other
  // seams and are genuinely not gating here — see note before status.
  const checklist = emptyProductionChecklist(options);

  // Criterion 4: offline comparison report must exist. A missing report is
  // independently blocking (comparisonReportComplete stays false) and also
  // means offline evaluation cannot have passed.
  if (!options.offlineComparisonReport) {
    blockMissingComparisonReport(blockers);
  } else {
    assessOfflineComparisonGates(blockers, checklist, options.offlineComparisonReport);
  }

  assessFamilySeparationGates(blockers, checklist, options.familySeparationProof);
  assessCompatibilityGates(blockers, checklist, options.compatibilityReceipt, options.compatibilityExpectedCommit ?? null);
  assessOperatorDocumentationGates(blockers, checklist, options.operatorDocsReceipt);
  assessLiveContractGates(blockers, options);
  assessCanaryGates(blockers, options);

  const status = resolveProductionQualificationStatus(checklist, blockers);
  return {
    status,
    evaluatedAt: new Date().toISOString(),
    blockers,
    summary: summarizeProductionQualification(status, blockers),
    checklist,
  };
}
