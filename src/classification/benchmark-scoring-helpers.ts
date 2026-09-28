/**
 * Benchmark Scoring Helpers (internal).
 *
 * Pure, dependency-free building blocks shared by the benchmark evaluator,
 * prediction-bundle builders, exporter, and Jev qualification service.
 * Everything here is deterministic and side-effect free:
 *
 * - gold-state token normalization (alias-table driven, no if-chains),
 * - prediction-outcome classification (semantic abstention vs failure vs
 *   missing — failures never earn abstention credit),
 * - fixed-population accumulators (correct / incorrect / abstained / failed /
 *   missing over a fixed eligible denominator),
 * - fixed-population baseline comparison (candidate vs baseline over the same
 *   eligible population; dual-abstained examples stay visible),
 * - labeled-support status, family-leakage grouping,
 * - verified page-identity capability + set scoring (precision/recall/F1/
 *   exact-match with identical denominators),
 * - decision-value stringification shared by reviewed-outcome extraction and
 *   gold export.
 *
 * Metric semantics are owned here once: accuracy/coverage/recovery/harm
 * formulas and denominators match the legacy evaluator exactly. Callers
 * decompose oversized flows into named steps that delegate to these helpers.
 */

import type {
  BenchmarkGoldLabels,
  BenchmarkPredictionEntry,
} from '../shared/schemas/classification';

// ─── State-token normalization ──────────────────────────────────────────────
// Canonical form: trimmed, lowercased, underscores become dashes. Every
// gold-state normalizer in the benchmark family funnels through this so
// spellings stay consistent without per-file if-chains.

function normalizeStateToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase().replace(/_/g, '-');
  return token === '' ? null : token;
}

/** Table-driven alias lookup: one branch instead of a normalizer if-chain. */
export function lookupStateAlias<T extends string>(
  value: unknown,
  aliases: Readonly<Record<string, T>>,
): T | null {
  const token = normalizeStateToken(value);
  if (token === null) return null;
  return aliases[token] ?? null;
}

// ─── Prediction-outcome classification ──────────────────────────────────────
// Explicit semantic abstention is tracked separately from service/validation
// failure: failures earn no abstention credit. Structural so legacy bundles
// (abstained flag only) and pre-review bundles (`outcome` + `failureCode`)
// classify identically.

type SharedPredictionOutcome =
  | 'predicted'
  | 'abstained-semantic'
  | 'failed'
  | 'missing';

/** Trimmed failure code on a bundle entry, or null when it failed codeless. */
export function extractFailureCode(
  entry: unknown,
): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const code = (entry as Record<string, unknown>).failureCode;
  return typeof code === 'string' && code.trim() !== '' ? code.trim() : null;
}

function explicitOutcomeOf(entry: Record<string, unknown>): string | null {
  return typeof entry.outcome === 'string' ? entry.outcome : null;
}

/**
 * Classify one bundle entry; undefined (no entry for the gold id) is
 * missing. A failure marker always wins: a failed call earns no abstention
 * credit even when the entry also carries an abstention flag or outcome.
 * Legacy parity: a null type with no abstention flag is "no answer"
 * (abstained), not an error.
 */
export function classifyPredictionOutcome(
  entry: BenchmarkPredictionEntry | undefined | null,
): SharedPredictionOutcome {
  if (!entry) return 'missing';
  const raw = entry as unknown as Record<string, unknown>;
  if (extractFailureCode(raw) !== null) return 'failed';
  const outcome = explicitOutcomeOf(raw);
  if (outcome === 'failed') return 'failed';
  if (outcome === 'abstained') return 'abstained-semantic';
  if (outcome === 'predicted') return 'predicted';
  if (entry.abstained === true) return 'abstained-semantic';
  if (entry.productType === null || entry.productType === undefined) {
    return 'abstained-semantic';
  }
  return 'predicted';
}

/** True for verdicts that count as "covered" (semantic answer present). */
function isCoveredVerdict(
  verdict: 'correct' | 'incorrect' | 'abstained' | 'failed' | 'missing' | 'excluded',
): boolean {
  return verdict === 'correct' || verdict === 'incorrect' || verdict === 'abstained';
}

// ─── Fixed-population accumulation ──────────────────────────────────────────
// Eligible examples: known + no-fit + insufficient-evidence (unlabeled
// excluded). Failures lower correctness/coverage via the fixed denominator;
// they are never counted as errors.

export interface FixedPopulationCounts {
  correct: number;
  correctAbstentions: number;
  incorrect: number;
  abstainedSemantic: number;
  failed: number;
  missing: number;
}

export function emptyFixedPopulationCounts(): FixedPopulationCounts {
  return {
    correct: 0,
    correctAbstentions: 0,
    incorrect: 0,
    abstainedSemantic: 0,
    failed: 0,
    missing: 0,
  };
}

interface FixedPopulationDerivation {
  eligible: number;
  covered: number;
  correctness: number;
  errorRate: number;
  abstentionRate: number;
  coverage: number;
  conditionalAccuracy: number;
}

/** Derive rates from counts with identical denominators (zero-safe). */
export function deriveFixedPopulation(
  counts: FixedPopulationCounts,
): FixedPopulationDerivation {
  const eligible =
    counts.correct + counts.incorrect + counts.abstainedSemantic + counts.failed + counts.missing;
  const covered = counts.correct + counts.incorrect + counts.abstainedSemantic;
  return {
    eligible,
    covered,
    correctness: eligible > 0 ? counts.correct / eligible : 0,
    errorRate: eligible > 0 ? counts.incorrect / eligible : 0,
    abstentionRate: eligible > 0 ? counts.abstainedSemantic / eligible : 0,
    coverage: eligible > 0 ? covered / eligible : 0,
    conditionalAccuracy: covered > 0 ? counts.correct / covered : 0,
  };
}

// ─── Fixed-population baseline comparison ───────────────────────────────────

export interface BaselineComparisonAccumulator {
  eligible: number;
  candidateCorrect: number;
  baselineCorrect: number;
  candidateCoveredCount: number;
  baselineCoveredCount: number;
  deltaSum: number;
  recoveredBaselineAbstentions: number;
  recoveredExampleIds: string[];
  harmedBaselineSuccesses: number;
  harmedExampleIds: string[];
  retainedSuccesses: number;
  dualAbstentions: number;
  dualAbstainedExampleIds: string[];
}

export function emptyBaselineComparisonAccumulator(): BaselineComparisonAccumulator {
  return {
    eligible: 0,
    candidateCorrect: 0,
    baselineCorrect: 0,
    candidateCoveredCount: 0,
    baselineCoveredCount: 0,
    deltaSum: 0,
    recoveredBaselineAbstentions: 0,
    recoveredExampleIds: [],
    harmedBaselineSuccesses: 0,
    harmedExampleIds: [],
    retainedSuccesses: 0,
    dualAbstentions: 0,
    dualAbstainedExampleIds: [],
  };
}

function isCorrectVerdict(verdict: string): boolean {
  return verdict === 'correct';
}

function isAbstainedVerdict(verdict: string): boolean {
  return verdict === 'abstained';
}

function noteRecovery(
  acc: BaselineComparisonAccumulator,
  candidateVerdict: string,
  baselineVerdict: string,
  exampleId: string,
): void {
  if (isAbstainedVerdict(baselineVerdict) && isCorrectVerdict(candidateVerdict)) {
    acc.recoveredBaselineAbstentions++;
    acc.recoveredExampleIds.push(exampleId);
  }
}

function noteHarm(
  acc: BaselineComparisonAccumulator,
  candidateVerdict: string,
  baselineVerdict: string,
  exampleId: string,
): void {
  if (isCorrectVerdict(baselineVerdict) && !isCorrectVerdict(candidateVerdict)) {
    acc.harmedBaselineSuccesses++;
    acc.harmedExampleIds.push(exampleId);
  }
}

function noteRetention(
  acc: BaselineComparisonAccumulator,
  candidateVerdict: string,
  baselineVerdict: string,
): void {
  if (isCorrectVerdict(baselineVerdict) && isCorrectVerdict(candidateVerdict)) {
    acc.retainedSuccesses++;
  }
}

function noteDualAbstention(
  acc: BaselineComparisonAccumulator,
  candidateVerdict: string,
  baselineVerdict: string,
  exampleId: string,
): void {
  if (isAbstainedVerdict(baselineVerdict) && isAbstainedVerdict(candidateVerdict)) {
    acc.dualAbstentions++;
    acc.dualAbstainedExampleIds.push(exampleId);
  }
}

/**
 * Record one candidate/baseline verdict pair over the fixed eligible
 * population. Scores are 1 for `correct` else 0; coverage counts
 * correct/incorrect/abstained on each side independently.
 */
export function recordBaselinePair(
  acc: BaselineComparisonAccumulator,
  candidateVerdict: 'correct' | 'incorrect' | 'abstained' | 'failed' | 'missing' | 'excluded',
  baselineVerdict: 'correct' | 'incorrect' | 'abstained' | 'failed' | 'missing' | 'excluded',
  exampleId: string,
): void {
  const candidateScore = isCorrectVerdict(candidateVerdict) ? 1 : 0;
  const baselineScore = isCorrectVerdict(baselineVerdict) ? 1 : 0;
  if (isCoveredVerdict(candidateVerdict)) acc.candidateCoveredCount++;
  if (isCoveredVerdict(baselineVerdict)) acc.baselineCoveredCount++;
  acc.eligible++;
  acc.candidateCorrect += candidateScore;
  acc.baselineCorrect += baselineScore;
  acc.deltaSum += candidateScore - baselineScore;
  noteRecovery(acc, candidateVerdict, baselineVerdict, exampleId);
  noteHarm(acc, candidateVerdict, baselineVerdict, exampleId);
  noteRetention(acc, candidateVerdict, baselineVerdict);
  noteDualAbstention(acc, candidateVerdict, baselineVerdict, exampleId);
}

interface BaselineComparisonDerivation {
  eligible: number;
  candidateCorrect: number;
  baselineCorrect: number;
  candidateCoverage: number;
  baselineCoverage: number;
  coverageShift: number;
  fixedDeltaMean: number;
}

/** Derive coverages/delta with identical denominators (zero-safe). */
export function deriveBaselineComparison(
  acc: BaselineComparisonAccumulator,
): BaselineComparisonDerivation {
  const candidateCoverage = acc.eligible > 0 ? acc.candidateCoveredCount / acc.eligible : 0;
  const baselineCoverage = acc.eligible > 0 ? acc.baselineCoveredCount / acc.eligible : 0;
  return {
    eligible: acc.eligible,
    candidateCorrect: acc.candidateCorrect,
    baselineCorrect: acc.baselineCorrect,
    candidateCoverage,
    baselineCoverage,
    coverageShift: candidateCoverage - baselineCoverage,
    fixedDeltaMean: acc.eligible > 0 ? acc.deltaSum / acc.eligible : 0,
  };
}

/** Sort id lists deterministically for stable report output. */
export function sortedIds(ids: string[]): string[] {
  return [...ids].sort();
}

// ─── Labeled-support status ─────────────────────────────────────────────────

interface SupportStatusDerivation {
  orderedPerClassGoldSupport: Record<string, number>;
  labeledClasses: string[];
  minClassSupport: number;
}

/** Order per-class gold support by sorted class name; min over classes. */
export function deriveSupportStatus(
  perClassGoldSupport: Record<string, number>,
): SupportStatusDerivation {
  const labeledClasses = Object.keys(perClassGoldSupport).sort();
  const orderedPerClassGoldSupport: Record<string, number> = {};
  for (const className of labeledClasses) {
    orderedPerClassGoldSupport[className] = perClassGoldSupport[className] ?? 0;
  }
  const minClassSupport = labeledClasses.length > 0
    ? Math.min(...labeledClasses.map(className => orderedPerClassGoldSupport[className] ?? 0))
    : 0;
  return { orderedPerClassGoldSupport, labeledClasses, minClassSupport };
}

export function supportReasonsFor(
  eligible: number,
  labeledClasses: string[],
  minClassSupport: number,
  requiredClassSupport: number,
): string[] {
  if (eligible === 0) {
    return ['no_eligible_examples: no labeled gold in the evaluated split'];
  }
  if (labeledClasses.length === 0) {
    return ['no_labeled_classes: eligible examples carry no known-type labels'];
  }
  if (minClassSupport < requiredClassSupport) {
    return [
      `insufficient_class_support: min support ${minClassSupport} < ${requiredClassSupport} over ${labeledClasses.length} class(es)`,
    ];
  }
  return [];
}

// ─── Family-leakage grouping ────────────────────────────────────────────────
// A family leaks when its examples span more than one split. Ungrouped
// examples (no family id) cannot leak by construction.

interface FamilyLeakageFinding {
  familyId: string;
  splits: string[];
}

function normalizedFamilyId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function normalizedSplitName(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'unknown';
}

function groupFamiliesBySplit(
  examples: Array<{ familyId: unknown; splitGroup: unknown }>,
): { byFamily: Map<string, Set<string>>; ungroupedExamples: number } {
  const byFamily = new Map<string, Set<string>>();
  let ungroupedExamples = 0;
  for (const example of examples) {
    const familyId = normalizedFamilyId(example.familyId);
    if (familyId === null) {
      ungroupedExamples++;
      continue;
    }
    const splitName = normalizedSplitName(example.splitGroup);
    const splits = byFamily.get(familyId);
    if (splits) splits.add(splitName);
    else byFamily.set(familyId, new Set([splitName]));
  }
  return { byFamily, ungroupedExamples };
}

function leakedFamilies(
  byFamily: Map<string, Set<string>>,
): FamilyLeakageFinding[] {
  return [...byFamily.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([familyId, splits]) => ({ familyId, splits: [...splits].sort() }))
    .sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
}

export function detectSharedFamilyLeakage(
  examples: Array<{ familyId: unknown; splitGroup: unknown }>,
): { leaked: boolean; findings: FamilyLeakageFinding[]; ungroupedExamples: number } {
  const { byFamily, ungroupedExamples } = groupFamiliesBySplit(examples);
  const findings = leakedFamilies(byFamily);
  return { leaked: findings.length > 0, findings, ungroupedExamples };
}

/** Dev/holdout straddle check used by the fixture builder (clean by construction). */
export function detectDevHoldoutStraddle(
  assignments: Array<{ familyId: string; splitGroup: string }>,
): Array<{ familyId: string; groups: string[] }> {
  const byFamily = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    if (!byFamily.has(assignment.familyId)) byFamily.set(assignment.familyId, new Set());
    byFamily.get(assignment.familyId)!.add(assignment.splitGroup);
  }
  const offenders: Array<{ familyId: string; groups: string[] }> = [];
  for (const [familyId, groups] of byFamily) {
    const list = [...groups].sort();
    if ((list.includes('train') || list.includes('test')) && list.includes('holdout')) {
      offenders.push({ familyId, groups: list });
    }
  }
  offenders.sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
  return offenders;
}

// ─── Verified page-identity capability ──────────────────────────────────────
// Page labels evaluate by stable Page ID only when every labeled example
// carries verified ids AND verified import provenance exists; otherwise the
// comparison is blocked (names are never a substitute for identity).

interface PageIdentityCapability {
  allGoldPagesHaveVerifiedIds: boolean;
  hasVerifiedImportProvenance: boolean;
  canEvaluateByIdentity: boolean;
}

function goldExampleHasVerifiedPageIds(
  example: { goldLabels: BenchmarkGoldLabels },
): boolean {
  const assignments = example.goldLabels.pageAssignments ?? [];
  const catPageIds = example.goldLabels.categoryPageIds ?? [];
  if (assignments.length === 0 && catPageIds.length === 0) return true;
  if (catPageIds.length > 0) return true;
  return assignments.every(
    page => typeof page.pageId === 'string' && page.pageId.trim().length > 0,
  );
}

function predictionsCarryPageProvenance(
  predictions: BenchmarkPredictionEntry[],
): boolean {
  return predictions.some(
    prediction =>
      Boolean(prediction.verifiedImportProvenance) ||
      (Array.isArray(prediction.pageIds) && prediction.pageIds.length > 0),
  );
}

/**
 * Resolve whether page comparison may proceed by stable identity.
 * `requireNonEmptyGold` mirrors the singleton/cohort comparisons (empty gold
 * cannot establish identity); the attribution/metrics path passes false.
 */
export function resolvePageIdentityCapability(
  gold: Array<{ goldLabels: BenchmarkGoldLabels }>,
  predictions: BenchmarkPredictionEntry[],
  extraPredictions: BenchmarkPredictionEntry[] = [],
  requireNonEmptyGold = false,
): PageIdentityCapability {
  const verifiedIds = gold.every(goldExampleHasVerifiedPageIds);
  const allGoldPagesHaveVerifiedIds = requireNonEmptyGold
    ? gold.length > 0 && verifiedIds
    : verifiedIds;
  const hasVerifiedImportProvenance =
    gold.some(example => Boolean(example.goldLabels.verifiedImportProvenance)) ||
    predictionsCarryPageProvenance(predictions) ||
    predictionsCarryPageProvenance(extraPredictions);
  return {
    allGoldPagesHaveVerifiedIds,
    hasVerifiedImportProvenance,
    canEvaluateByIdentity: allGoldPagesHaveVerifiedIds && hasVerifiedImportProvenance,
  };
}

/** Gold page ids (identity path) for one example. */
export function goldPageIdsOf(example: { goldLabels: BenchmarkGoldLabels }): string[] {
  const assignments = example.goldLabels.pageAssignments ?? [];
  const catPageIds = example.goldLabels.categoryPageIds ?? [];
  if (catPageIds.length > 0) return catPageIds;
  return assignments.map(page => page.pageId).filter((id): id is string => Boolean(id));
}

/** Gold page names (blocked-identity fallback path) for one example. */
export function goldPageNamesOf(example: { goldLabels: BenchmarkGoldLabels }): string[] {
  return (example.goldLabels.pageAssignments ?? []).map(page => page.pageName);
}

/** Candidate page items for one prediction under the identity capability. */
export function pageItemsOf(
  prediction: BenchmarkPredictionEntry | undefined | null,
  byIdentity: boolean,
): string[] {
  if (!prediction) return [];
  const items = byIdentity ? (prediction.pageIds ?? []) : (prediction.pageAssignments ?? []);
  return items.filter((item): item is string => Boolean(item));
}

/** Provenance string for identity-eligible page reports (predictions first). */
export function pageProvenanceOf(
  gold: Array<{ goldLabels: BenchmarkGoldLabels }>,
  predictions: BenchmarkPredictionEntry[],
): string | null {
  return (
    predictions.find(prediction => prediction.verifiedImportProvenance)?.verifiedImportProvenance ??
    gold.find(example => example.goldLabels.verifiedImportProvenance)?.goldLabels
      .verifiedImportProvenance ??
    null
  );
}

// ─── Set scoring (precision / recall / F1 / exact-match) ────────────────────
// Identical denominators everywhere: precision over the predicted set,
// recall over the gold set, exact-match requires equal size and full overlap.

interface PageSetScore {
  hits: number;
  precision: number;
  recall: number;
  f1: number;
  exactMatch: boolean;
}

export function scorePageSet(
  goldSet: Set<string>,
  predictedSet: Set<string>,
): PageSetScore {
  let hits = 0;
  for (const item of predictedSet) {
    if (goldSet.has(item)) hits++;
  }
  const precision = predictedSet.size > 0 ? hits / predictedSet.size : 0;
  const recall = goldSet.size > 0 ? hits / goldSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const exactMatch = goldSet.size === predictedSet.size && hits === goldSet.size;
  return { hits, precision, recall, f1, exactMatch };
}

/** First-wins index of bundle entries by example id (duplicates kept readable). */
export function indexPredictionsByExampleId(
  predictions: BenchmarkPredictionEntry[],
): Map<string, BenchmarkPredictionEntry> {
  const byId = new Map<string, BenchmarkPredictionEntry>();
  for (const entry of predictions) {
    if (!byId.has(entry.exampleId)) byId.set(entry.exampleId, entry);
  }
  return byId;
}

/** Grouped (all-entries) index by example id for duplicate detection. */
export function groupPredictionsByExampleId(
  predictions: BenchmarkPredictionEntry[],
): Map<string, BenchmarkPredictionEntry[]> {
  const byId = new Map<string, BenchmarkPredictionEntry[]>();
  for (const entry of predictions) {
    const existing = byId.get(entry.exampleId);
    if (existing) existing.push(entry);
    else byId.set(entry.exampleId, [entry]);
  }
  return byId;
}

// ─── Decision-value stringification ─────────────────────────────────────────
// Reviewed-outcome extraction and gold export share one rule: revised values
// win when present; non-string values stringify; null/undefined stay null.

export function stringifyDecisionValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Effective reviewed value: revised (when present) else the proposal value. */
export function effectiveReviewedValue(
  decision: { hasRevisedValue?: boolean; revisedValue?: unknown },
  proposal: { proposedValue?: unknown },
): string | null {
  if (decision.hasRevisedValue && decision.revisedValue !== undefined) {
    return stringifyDecisionValue(decision.revisedValue);
  }
  return stringifyDecisionValue(proposal.proposedValue);
}

/** Effective target: revised target id (when present) else the proposal target. */
export function effectiveReviewedTargetId(
  decision: { hasRevisedTargetId?: boolean; revisedTargetId?: string | null },
  proposal: { targetId?: string | null },
): string | null | undefined {
  if (decision.hasRevisedTargetId && decision.revisedTargetId !== undefined) {
    return decision.revisedTargetId;
  }
  return proposal.targetId;
}

// ─── Generic best-choice selection ──────────────────────────────────────────
// Highest probability wins; ties keep the first (deterministic input order).
// Module-private: no callers yet (unexported per ADR 0036); export it when a
// second consumer needs the shared rule.

function selectBestByProbability<T>(
  items: T[],
  probabilityOf: (item: T) => number,
): { best: T | null; bestProb: number } {
  let best: T | null = null;
  let bestProb = -1;
  for (const item of items) {
    const prob = probabilityOf(item);
    if (prob > bestProb) {
      bestProb = prob;
      best = item;
    }
  }
  return { best, bestProb };
}

// ─── Qualification shared gold core ─────────────────────────────────────────
// The code-executed predictor input and the scored qualification entry share
// one adjudicated-gold + evidence core; prediction sides differ (executed
// artifact vs stored baseline/candidate) and stay on their own types.

export interface QualificationGoldCore {
  sku: string;
  familyId: string;
  split: 'dev' | 'holdout';
  assortment: string;
  gold: {
    productType: {
      kind: 'known-type' | 'no-fit' | 'insufficient-evidence' | 'unlabeled';
      typeId: string | null;
    };
    fieldAssignments: Array<{
      targetId: string;
      value?: string;
      values?: string[];
      state: string;
    }>;
    categoryPages: {
      pageIds: string[];
      pageAssignments: Array<{ pageId: string; pageName: string }>;
    };
  };
  evidence: Array<{
    source: string;
    snippet: string;
    reliability: string;
    attributeId: string | null;
  }>;
}

// ─── Page-comparison summary ────────────────────────────────────────────────
// Singleton and cohort page comparisons report one shared summary shape;
// per-example rows and outcome breakdowns stay on their own reports.

export interface SharedPageComparisonSummary {
  eligibleCount: number;
  evaluatedCount: number;
  unlabeledCount: number;
  unavailableCount: number;
  candidateExactMatches: number;
  baselineExactMatches: number;
  candidatePrecision: number;
  candidateRecall: number;
  baselinePrecision: number;
  baselineRecall: number;
  exactSetDeltaMean: number;
  recoveredBaselineAbstentions: number;
  harmedBaselineSuccesses: number;
  coverageShift: number;
  evaluatedByIdentity: boolean;
  eligibleToQualifyJev: boolean;
}

export interface PageComparisonCounters {
  eligibleCount: number;
  evaluatedCount: number;
  unlabeledCount: number;
  unavailableCount: number;
  candidateExactMatches: number;
  baselineExactMatches: number;
  candidatePrecisionSum: number;
  candidateRecallSum: number;
  baselinePrecisionSum: number;
  baselineRecallSum: number;
  recoveredBaselineAbstentions: number;
  harmedBaselineSuccesses: number;
  deltaSum: number;
  candidateCoveredCount: number;
  baselineCoveredCount: number;
}

export function emptyPageComparisonCounters(): PageComparisonCounters {
  return {
    eligibleCount: 0,
    evaluatedCount: 0,
    unlabeledCount: 0,
    unavailableCount: 0,
    candidateExactMatches: 0,
    baselineExactMatches: 0,
    candidatePrecisionSum: 0,
    candidateRecallSum: 0,
    baselinePrecisionSum: 0,
    baselineRecallSum: 0,
    recoveredBaselineAbstentions: 0,
    harmedBaselineSuccesses: 0,
    deltaSum: 0,
    candidateCoveredCount: 0,
    baselineCoveredCount: 0,
  };
}

/** Finalize a page-comparison summary with identical denominators. */
export function finalizePageComparisonSummary(
  counters: PageComparisonCounters,
  evaluatedByIdentity: boolean,
): SharedPageComparisonSummary {
  const { eligibleCount, evaluatedCount } = counters;
  const candidateCoverage = eligibleCount > 0 ? counters.candidateCoveredCount / eligibleCount : 0;
  const baselineCoverage = eligibleCount > 0 ? counters.baselineCoveredCount / eligibleCount : 0;
  return {
    eligibleCount,
    evaluatedCount,
    unlabeledCount: counters.unlabeledCount,
    unavailableCount: counters.unavailableCount,
    candidateExactMatches: counters.candidateExactMatches,
    baselineExactMatches: counters.baselineExactMatches,
    candidatePrecision: evaluatedCount > 0 ? counters.candidatePrecisionSum / evaluatedCount : 0,
    candidateRecall: evaluatedCount > 0 ? counters.candidateRecallSum / evaluatedCount : 0,
    baselinePrecision: evaluatedCount > 0 ? counters.baselinePrecisionSum / evaluatedCount : 0,
    baselineRecall: evaluatedCount > 0 ? counters.baselineRecallSum / evaluatedCount : 0,
    exactSetDeltaMean: eligibleCount > 0 ? counters.deltaSum / eligibleCount : 0,
    recoveredBaselineAbstentions: counters.recoveredBaselineAbstentions,
    harmedBaselineSuccesses: counters.harmedBaselineSuccesses,
    coverageShift: candidateCoverage - baselineCoverage,
    evaluatedByIdentity,
    eligibleToQualifyJev: evaluatedByIdentity,
  };
}
