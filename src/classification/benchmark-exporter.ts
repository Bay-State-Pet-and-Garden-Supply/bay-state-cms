/**
 * Benchmark Exporter
 *
 * Exports reviewed classification decisions into an immutable Gold benchmark
 * dataset. Rules:
 * - The EXACT reviewed run is exported: gold labels come from the live
 *   (non-superseded) accepted decisions with their effective revised values
 *   and revised targets.
 * - Stale proposals, config-drift runs (no verifiable config snapshot), and
 *   source-drift records are excluded.
 * - Page labels are excluded until verified Page identity exists (an active
 *   verified page import). Until then pageAssignments are always empty.
 * - Examples are content-addressed (exampleHash) and carry the source run,
 *   config snapshot hash, and source product hash.
 * - Splits are deterministic per product family and split seed.
 * - Replay inputs NEVER carry the answer: `inputSnapshotJson` holds frozen
 *   evidence plus explicitly retained (non-target) reviewed inputs, while
 *   target labels travel ONLY in `goldLabelsJson`. Use
 *   `partitionReplayFactsForReplay` + `findReplayInputLeakage` to enforce the
 *   split, and `exportFixtureDataset` for adjudicated fixture builds whose
 *   gold state rides in `goldLabelsJson[productTypeState]` (legacy readers
 *   ignore the extra key; historical example hashes are untouched).
 */

import { getDb } from '../db/connection';
import { normalizeBrand, extractNameStem } from '../onboarding/product-line-grouper';
import { pageNameFromPageValue } from '../shared/proposal-display';
import * as benchmarkRepo from '../db/repositories/benchmark-repo';
import * as classRunRepo from '../db/repositories/classification-run-repo';
import type { BenchmarkGoldLabels, FrozenTaxonomySnapshot } from '../shared/schemas/classification';
import type { ReviewedFact } from './reviewed-facts';
import {
  detectDevHoldoutStraddle,
  effectiveReviewedTargetId,
  stringifyDecisionValue,
} from './benchmark-scoring-helpers';

export interface ExportBenchmarkOptions {
  name: string;
  holdoutPercent?: number;     // default 20
  splitSeed?: number;          // deterministic reproducibility, default 42
  minDecisionsPerSku?: number; // default 1
}

export interface ExportBenchmarkResult {
  datasetId: string;
  exported: number;
  skipped: number;
  familyCount: number;
  splitDistribution: { train: number; test: number; holdout: number };
  /** Count of SKUs excluded because their run has no verifiable config snapshot. */
  configDriftSkipped: number;
  /** True when Page gold labels were excluded because no verified Page identity exists. */
  pageLabelsExcluded: boolean;
}

/** Deterministic split assignment per family (stable across runs and seeds). */
export function splitForFamily(familyId: string, splitSeed: number, holdoutPercent: number): 'train' | 'test' | 'holdout' {
  let hash = 0x811c9dc5;
  const input = `${familyId}:${splitSeed}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const score = (hash >>> 0) % 100;
  if (score < holdoutPercent) return 'holdout';
  if (score < holdoutPercent * 2) return 'test';
  return 'train';
}

/** True when an active verified Page import exists (identity is authoritative). */
function hasVerifiedPageIdentity(workspaceId: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) AS c FROM page_imports
     WHERE workspace_id = ? AND status = 'active'
       AND EXISTS (
         SELECT 1 FROM page_index p
         WHERE p.import_id = page_imports.id
           AND p.identity_status = 'verified'
       )`,
  ).get(workspaceId) as { c: number } | undefined;
  return Number(row?.c ?? 0) > 0;
}

// ─── Export sections (decomposed named steps) ─────────────────────────────────
// `exportBenchmark` orchestrates these steps; per-SKU candidacy, gold
// accumulation, and split persistence each own a named function.

interface ExportCandidateItem {
  sku: string;
  familyId: string;
  inputSnapshotJson: string;
  goldLabels: BenchmarkGoldLabels;
  sourceRunId: string;
  sourceConfigHash: string | null;
  sourceProductHash: string | null;
}

type ExportCandidateOutcome =
  | { kind: 'candidate'; candidate: ExportCandidateItem }
  | { kind: 'skipped' }
  | { kind: 'config-drift' };

interface ExportGoldAccumulator {
  productType: string | null;
  pageAssignments: Array<{ pageName: string; pageId: string | null }>;
  fieldAssignments: Array<{ targetId: string; value: string | null }>;
}

function emptyExportGoldAccumulator(): ExportGoldAccumulator {
  return { productType: null, pageAssignments: [], fieldAssignments: [] };
}

type ExportRunProposal = ReturnType<typeof classRunRepo.getProposalsByRun>[number];
type ExportRunDecision = ReturnType<typeof classRunRepo.getLiveDecisionsByRun>[number];

/**
 * Effective reviewed value with exporter-exact semantics: a present revised
 * value wins (null/undefined revised values stay null); otherwise the
 * proposal value stringifies. Shared stringification via the scoring helpers.
 */
function exportReviewedValue(
  decision: ExportRunDecision,
  proposal: ExportRunProposal,
): string | null {
  if (decision.hasRevisedValue) {
    return decision.revisedValue === null || decision.revisedValue === undefined
      ? null
      : typeof decision.revisedValue === 'string'
        ? decision.revisedValue
        : JSON.stringify(decision.revisedValue);
  }
  return stringifyDecisionValue(proposal.proposedValue);
}

/** Apply one accepted category-page proposal (identity-gated display names). */
function applyExportPageProposal(
  acc: ExportGoldAccumulator,
  proposal: ExportRunProposal,
  decision: ExportRunDecision,
  verifiedPages: boolean,
): void {
  // Page labels are excluded until a verified Page identity exists.
  if (!verifiedPages) return;
  // Display name comes from the effective value — never the stable
  // Page ID (issue #17 D1).
  const pageName = pageNameFromPageValue(
    decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
  );
  if (pageName) acc.pageAssignments.push({ pageName, pageId: null });
}

/** Score one proposal into the export gold (accepted decisions only). */
function applyExportProposal(
  acc: ExportGoldAccumulator,
  proposal: ExportRunProposal,
  decisions: ExportRunDecision[],
  verifiedPages: boolean,
): void {
  // Source-drift exclusion: stale proposals never become gold.
  if (proposal.isStale) return;
  const decision = decisions.find(d => d.proposalId === proposal.id);
  if (!decision || decision.decision !== 'accepted') return;
  const value = exportReviewedValue(decision, proposal);
  const effectiveTarget = effectiveReviewedTargetId(decision, proposal);
  if (proposal.proposalType === 'primary_product_type') {
    acc.productType = value;
  } else if (proposal.proposalType === 'category_page') {
    applyExportPageProposal(acc, proposal, decision, verifiedPages);
  } else if (proposal.proposalType === 'field_assignment' && effectiveTarget) {
    acc.fieldAssignments.push({ targetId: effectiveTarget, value });
  }
}

/** Accumulate reviewed gold labels from one run's proposals/decisions. */
function accumulateExportGold(
  proposals: ExportRunProposal[],
  decisions: ExportRunDecision[],
  verifiedPages: boolean,
): ExportGoldAccumulator {
  const acc = emptyExportGoldAccumulator();
  for (const proposal of proposals) {
    applyExportProposal(acc, proposal, decisions, verifiedPages);
  }
  return acc;
}

/** Brand + product name from run evidence (catalog guidance + product name). */
function exportBrandAndProductName(
  evidence: ReturnType<typeof classRunRepo.getEvidenceByRun>,
  sku: string,
): { brandName: string; productName: string } {
  let brandName = '';
  let productName = sku;
  for (const item of evidence) {
    if (item.source === 'catalog_manager_guidance' && item.snippet) {
      brandName = item.snippet;
    }
    if (item.sourceField === 'product_name' && item.snippet) {
      productName = item.snippet;
    }
  }
  return { brandName, productName };
}

/** Build one export candidate from a verified run (null when unlabeled). */
function buildExportCandidateItem(
  sku: string,
  run: NonNullable<ReturnType<typeof classRunRepo.getRecentRun>>,
  evidence: ReturnType<typeof classRunRepo.getEvidenceByRun>,
  gold: ExportGoldAccumulator,
): ExportCandidateItem | null {
  if (!gold.productType && gold.pageAssignments.length === 0 && gold.fieldAssignments.length === 0) {
    return null;
  }
  const goldLabels: BenchmarkGoldLabels = {
    productType: gold.productType,
    pageAssignments: gold.pageAssignments,
    fieldAssignments: gold.fieldAssignments,
  };
  const { brandName, productName } = exportBrandAndProductName(evidence, sku);
  const normBrand = normalizeBrand(brandName);
  const stem = extractNameStem(productName);
  const familyId = `family-${normBrand || 'no-brand'}-${stem.slice(0, 30).replace(/\s+/g, '-')}`;
  const inputSnapshotJson = JSON.stringify({
    sku,
    evidence: evidence.map(e => ({
      source: e.source,
      snippet: e.snippet,
      reliability: e.reliability,
      attributeId: e.attributeId,
    })),
  });
  return {
    sku,
    familyId,
    inputSnapshotJson,
    goldLabels,
    sourceRunId: run.id,
    sourceConfigHash: run.configSnapshotHash,
    sourceProductHash: run.sourceProductHash,
  };
}

/** True when the run's config snapshot is verifiable (no config drift). */
function hasVerifiableExportSnapshot(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  configSnapshotHash: string | null | undefined,
): boolean {
  if (!configSnapshotHash) return false;
  const snapshotRow = db.query(
    'SELECT 1 FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(workspaceId, configSnapshotHash);
  return Boolean(snapshotRow);
}

/** Try one SKU: candidate, skipped (no run/labels), or config-drift. */
function tryBuildExportCandidate(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  sku: string,
  verifiedPages: boolean,
): ExportCandidateOutcome {
  const run = classRunRepo.getRecentRun(workspaceId, sku);
  if (!run) return { kind: 'skipped' };
  // Config-drift exclusion: the run must be bound to a verifiable config
  // snapshot, otherwise its labels cannot be tied to the activated config.
  if (!hasVerifiableExportSnapshot(db, workspaceId, run.configSnapshotHash)) {
    return { kind: 'config-drift' };
  }
  const evidence = classRunRepo.getEvidenceByRun(run.id);
  const proposals = classRunRepo.getProposalsByRun(run.id);
  const decisions = classRunRepo.getLiveDecisionsByRun(run.id);
  const gold = accumulateExportGold(proposals, decisions, verifiedPages);
  const candidate = buildExportCandidateItem(sku, run, evidence, gold);
  if (!candidate) return { kind: 'skipped' };
  return { kind: 'candidate', candidate };
}

/** Persist candidates with deterministic family-grouped splits. */
function persistExportCandidates(
  datasetId: string,
  candidates: ExportCandidateItem[],
  splitSeed: number,
  holdoutPercent: number,
): { exported: number; splitDistribution: { train: number; test: number; holdout: number } } {
  const splitDistribution = { train: 0, test: 0, holdout: 0 };
  let exported = 0;
  for (const candidate of candidates) {
    const splitGroup = splitForFamily(candidate.familyId, splitSeed, holdoutPercent);
    splitDistribution[splitGroup]++;
    benchmarkRepo.insertExample(
      datasetId,
      candidate.sku,
      candidate.familyId,
      splitGroup,
      candidate.inputSnapshotJson,
      JSON.stringify(candidate.goldLabels),
      {
        sourceRunId: candidate.sourceRunId,
        sourceConfigHash: candidate.sourceConfigHash,
        sourceProductHash: candidate.sourceProductHash,
      },
    );
    exported++;
  }
  return { exported, splitDistribution };
}

export function exportBenchmark(
  workspaceId: string,
  options: ExportBenchmarkOptions,
): ExportBenchmarkResult {
  const db = getDb();
  const holdoutPercent = options.holdoutPercent ?? 20;
  const splitSeed = options.splitSeed ?? 42;
  const minDecisionsPerSku = options.minDecisionsPerSku ?? 1;

  const verifiedPages = hasVerifiedPageIdentity(workspaceId);

  // 1. Create the draft dataset (family review is required before freeze).
  const dataset = benchmarkRepo.createDataset(
    workspaceId,
    options.name,
    'product_family',
    splitSeed,
  );

  // 2. Query qualifying SKUs with reviewed decisions.
  const skuRows = db
    .query(
      `SELECT DISTINCT r.product_sku
       FROM classification_runs r
       JOIN classification_proposals p ON p.run_id = r.id
       JOIN classification_proposal_decisions d ON d.proposal_id = p.id
       WHERE r.workspace_id = ?
         AND r.status IN ('completed', 'completed_with_abstentions')
         AND d.superseded_at IS NULL
         AND p.proposal_type != 'reviewable_abstention'
       GROUP BY r.product_sku
       HAVING COUNT(d.id) >= ?`,
    )
    .all(workspaceId, minDecisionsPerSku) as Array<{ product_sku: string }>;

  let skipped = 0;
  let configDriftSkipped = 0;
  const candidates: ExportCandidateItem[] = [];

  for (const { product_sku: sku } of skuRows) {
    const outcome = tryBuildExportCandidate(db, workspaceId, sku, verifiedPages);
    if (outcome.kind === 'candidate') candidates.push(outcome.candidate);
    else if (outcome.kind === 'config-drift') configDriftSkipped++;
    else skipped++;
  }

  const uniqueFamilies = new Set(candidates.map(c => c.familyId));
  const { exported, splitDistribution } = persistExportCandidates(
    dataset.id,
    candidates,
    splitSeed,
    holdoutPercent,
  );

  benchmarkRepo.updateDatasetExampleCount(dataset.id);

  return {
    datasetId: dataset.id,
    exported,
    skipped,
    familyCount: uniqueFamilies.size,
    splitDistribution,
    configDriftSkipped,
    pageLabelsExcluded: !verifiedPages,
  };
}
// ─── Replay input vs target-label separation (issue #294) ────────────────────
//
// Immutable benchmark replay MUST NOT leak the answer into a candidate's input.
// Reviewed facts partition into two disjoint classes:
//
// - Retained inputs (legal replay inputs): accepted facts a candidate replay is
//   allowed to consume as frozen input (facts for targets OUTSIDE the evaluated
//   set). They travel inside `inputSnapshotJson`.
// - Target labels (never replay inputs): the adjudicated answers under
//   evaluation (`primary_product_type`, `category_page`, and evaluated
//   `field_assignment` targets). They travel ONLY inside `goldLabelsJson`.
//
// `exportBenchmark` above keeps decisions out of the input snapshot (evidence
// only), so its snapshots are clean by construction. The helpers below make
// that guarantee explicit and checkable, and power the fixture-builder path
// which carries retained inputs deliberately.

/** Proposal types that are evaluation targets — never legal replay inputs. */
const REPLAY_TARGET_PROPOSAL_TYPES = [
  'primary_product_type',
  'category_page',
  'field_assignment',
] as const;
type ReplayTargetProposalType = (typeof REPLAY_TARGET_PROPOSAL_TYPES)[number];

/** Minimal retained-input record stored inside replay input snapshots. */
interface RetainedReplayInput {
  proposalType: string;
  targetId: string | null;
  value: unknown;
}

/** Evidence record stored inside replay input snapshots. */
interface ReplayEvidenceItem {
  source: string;
  snippet: string;
  reliability?: string;
  attributeId?: string | null;
}

interface PartitionReplayFactsOptions {
  /** When false, primary_product_type facts are retained inputs, not targets. */
  evaluateProductType?: boolean;
  /** When false, category_page facts are retained inputs, not targets. */
  evaluatePages?: boolean;
  /**
   * Field target ids under evaluation. `null`/`undefined` (default) treats
   * every field_assignment fact as a target label.
   */
  evaluateFieldTargetIds?: string[] | null;
}

function isTargetLabelFact(
  fact: Pick<ReviewedFact, 'proposalType' | 'targetId'>,
  options: PartitionReplayFactsOptions = {},
): boolean {
  const evaluateProductType = options.evaluateProductType ?? true;
  const evaluatePages = options.evaluatePages ?? true;
  const evaluateFieldTargetIds = options.evaluateFieldTargetIds ?? null;
  if (fact.proposalType === 'primary_product_type') return evaluateProductType;
  if (fact.proposalType === 'category_page') return evaluatePages;
  if (fact.proposalType === 'field_assignment') {
    if (evaluateFieldTargetIds === null) return true;
    return fact.targetId !== null && evaluateFieldTargetIds.includes(fact.targetId);
  }
  return false;
}

function partitionReplayFactsForReplay(
  facts: ReviewedFact[],
  options: PartitionReplayFactsOptions = {},
): { replayInputs: ReviewedFact[]; targetLabels: ReviewedFact[] } {
  const replayInputs: ReviewedFact[] = [];
  const targetLabels: ReviewedFact[] = [];
  for (const fact of facts) {
    if (isTargetLabelFact(fact, options)) targetLabels.push(fact);
    else replayInputs.push(fact);
  }
  return { replayInputs, targetLabels };
}

function toRetainedReplayInput(
  fact: Pick<ReviewedFact, 'proposalType' | 'targetId' | 'value'>,
): RetainedReplayInput {
  return { proposalType: fact.proposalType, targetId: fact.targetId, value: fact.value };
}

function buildReplayInputSnapshot(
  sku: string,
  evidence: ReplayEvidenceItem[],
  retainedInputs: RetainedReplayInput[] = [],
): string {
  return JSON.stringify({
    sku,
    evidence: evidence.map(e => ({
      source: e.source,
      snippet: e.snippet,
      reliability: e.reliability,
      attributeId: e.attributeId ?? null,
    })),
    retainedInputs,
  });
}

interface ParsedReplayInputSnapshot {
  sku: string;
  evidence: ReplayEvidenceItem[];
  retainedInputs: RetainedReplayInput[];
}

/** SKU string from a parsed snapshot (empty when absent). */
function snapshotSkuOf(parsed: Record<string, unknown>): string {
  return 'sku' in parsed && typeof parsed.sku === 'string' ? parsed.sku : '';
}

/** Evidence items from a parsed snapshot (empty when absent). */
function snapshotEvidenceOf(parsed: Record<string, unknown>): ReplayEvidenceItem[] {
  if (!('evidence' in parsed) || !Array.isArray(parsed.evidence)) return [];
  return parsed.evidence.filter(
    (item): item is ReplayEvidenceItem => !!item && typeof item === 'object' && 'source' in item && 'snippet' in item,
  );
}

/** Retained inputs from a parsed snapshot (empty for legacy snapshots). */
function snapshotRetainedInputsOf(parsed: Record<string, unknown>): RetainedReplayInput[] {
  if (!('retainedInputs' in parsed) || !Array.isArray(parsed.retainedInputs)) return [];
  return parsed.retainedInputs.filter(
    (item): item is RetainedReplayInput => !!item && typeof item === 'object' && 'proposalType' in item,
  );
}

/** Tolerant parse: legacy `{ sku, evidence }` snapshots read as zero retained inputs. */
function parseReplayInputSnapshot(json: string): ParsedReplayInputSnapshot {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { sku: '', evidence: [], retainedInputs: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    sku: snapshotSkuOf(record),
    evidence: snapshotEvidenceOf(record),
    retainedInputs: snapshotRetainedInputsOf(record),
  };
}

// ─── Adjudicated gold state (issue #294) ─────────────────────────────────────
//
// Fixture gold distinguishes a known type from a target with no fitting
// configured type, insufficient evidence, or no label at all. The state rides
// as `goldLabelsJson[productTypeState]`; legacy `BenchmarkGoldLabels` readers
// ignore the extra key, and historical example hashes are never rewritten.

const GOLD_STATE_KNOWN = 'known' as const;
const GOLD_STATE_NO_FIT = 'no-fit' as const;
const GOLD_STATE_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
const GOLD_STATE_UNLABELED = 'unlabeled' as const;
const ADJUDICATED_GOLD_STATES = [
  GOLD_STATE_KNOWN,
  GOLD_STATE_NO_FIT,
  GOLD_STATE_INSUFFICIENT_EVIDENCE,
  GOLD_STATE_UNLABELED,
] as const;
type AdjudicatedGoldState = (typeof ADJUDICATED_GOLD_STATES)[number];

/** Gold-labels JSON field carrying the adjudicated gold state. */
const FIXTURE_GOLD_STATE_FIELD = 'productTypeState' as const;

function isAdjudicatedGoldState(value: unknown): value is AdjudicatedGoldState {
  return (
    value === GOLD_STATE_KNOWN ||
    value === GOLD_STATE_NO_FIT ||
    value === GOLD_STATE_INSUFFICIENT_EVIDENCE ||
    value === GOLD_STATE_UNLABELED
  );
}

/** Read the adjudicated gold state; `null` for legacy gold without a state marker. */
function readFixtureGoldState(goldLabelsJson: string): AdjudicatedGoldState | null {
  try {
    const parsed = JSON.parse(goldLabelsJson) as Record<string, unknown>;
    const state = parsed[FIXTURE_GOLD_STATE_FIELD];
    return isAdjudicatedGoldState(state) ? state : null;
  } catch {
    return null;
  }
}

/** Split persisted gold JSON into labels + state; tolerates legacy gold without a state marker. */
function parseFixtureGoldLabels(goldLabelsJson: string): {
  labels: BenchmarkGoldLabels;
  goldState: AdjudicatedGoldState | null;
} {
  const parsed = JSON.parse(goldLabelsJson) as Record<string, unknown>;
  const pageAssignments = Array.isArray(parsed.pageAssignments)
    ? (parsed.pageAssignments as Array<{ pageName?: unknown; pageId?: unknown }>).map(p => ({
        pageName: typeof p?.pageName === 'string' ? p.pageName : '',
        pageId: typeof p?.pageId === 'string' ? p.pageId : null,
      }))
    : [];
  const fieldAssignments = Array.isArray(parsed.fieldAssignments)
    ? (parsed.fieldAssignments as Array<{ targetId?: unknown; value?: unknown }>).map(f => ({
        targetId: typeof f?.targetId === 'string' ? f.targetId : '',
        value: typeof f?.value === 'string' ? f.value : null,
      }))
    : [];
  const labels: BenchmarkGoldLabels = {
    productType: typeof parsed.productType === 'string' ? parsed.productType : null,
    pageAssignments,
    fieldAssignments,
  };
  return { labels, goldState: readFixtureGoldState(goldLabelsJson) };
}

// ─── Replay-leakage audit (issue #294) ───────────────────────────────────────
//
// Raw evidence text may naturally mention a type name — that is legal input,
// not leakage. Leakage is reviewer answers smuggled into the replay input:
// target-label proposal types inside `retainedInputs`, gold-shaped keys at the
// snapshot top level, or retained values equal to a target answer.

const FORBIDDEN_REPLAY_INPUT_KEYS = [
  'productType',
  'pageAssignments',
  'fieldAssignments',
  'goldLabels',
  'gold',
  'targetLabels',
] as const;

/** Normalized non-empty answer string (null when blank/non-string). */
function normalizedAnswerString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Collect normalized answer strings from a labeled list via a getter. */
function collectAnswerStrings<T>(
  items: T[] | undefined | null,
  valueOf: (item: T) => unknown,
): string[] {
  const answers: string[] = [];
  for (const item of items ?? []) {
    const answer = normalizedAnswerString(valueOf(item));
    if (answer) answers.push(answer);
  }
  return answers;
}

function goldAnswerStrings(gold: BenchmarkGoldLabels): string[] {
  return [
    ...collectAnswerStrings(gold.productType ? [gold.productType] : [], value => value),
    ...collectAnswerStrings(gold.pageAssignments, page => page?.pageName),
    ...collectAnswerStrings(gold.fieldAssignments, field => field?.value),
  ];
}

/** Parsed replay input + gold pair (null when either side is not JSON). */
function parseReplayLeakagePair(
  inputSnapshotJson: string,
  goldLabelsJson: string,
): { input: Record<string, unknown>; gold: BenchmarkGoldLabels } | { error: string } {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputSnapshotJson) as Record<string, unknown>;
  } catch {
    return { error: 'unparseable_input_snapshot: replay input is not JSON' };
  }
  try {
    const gold = JSON.parse(goldLabelsJson) as BenchmarkGoldLabels;
    return { input, gold };
  } catch {
    return { error: 'unparseable_gold_labels: gold labels are not JSON' };
  }
}

/** Forbidden top-level answer keys carried alongside the replay input. */
function findForbiddenReplayInputKeys(input: Record<string, unknown>): string[] {
  const findings: string[] = [];
  for (const key of FORBIDDEN_REPLAY_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      findings.push(`forbidden_input_key: replay input carries "${key}" alongside the answer`);
    }
  }
  return findings;
}

/** Retained inputs array (null when malformed — reported, not thrown). */
function parseRetainedReplayInputs(
  input: Record<string, unknown>,
): { retained: RetainedReplayInput[] } | { error: string } {
  const rawRetained = (input as { retainedInputs?: unknown }).retainedInputs;
  if (rawRetained !== undefined && !Array.isArray(rawRetained)) {
    return { error: 'malformed_retained_inputs: "retainedInputs" must be an array' };
  }
  return { retained: (Array.isArray(rawRetained) ? rawRetained : []) as RetainedReplayInput[] };
}

/** String proposal type on a retained input (null when absent/non-string). */
function retainedProposalTypeOf(entry: RetainedReplayInput): string | null {
  return 'proposalType' in entry && typeof entry.proposalType === 'string' ? entry.proposalType : null;
}

/** Target id on a retained input (undefined when absent/non-string-or-null). */
function retainedTargetIdOf(entry: RetainedReplayInput): string | null | undefined {
  if (!('targetId' in entry)) return undefined;
  const targetId = entry.targetId;
  return typeof targetId === 'string' || targetId === null ? targetId : undefined;
}

/** Reviewer-answer marker for one retained input (null when it carries nothing). */
function retainedInputMarker(
  entry: RetainedReplayInput,
): Pick<ReviewedFact, 'proposalType' | 'targetId'> | null {
  if (!entry || typeof entry !== 'object') return null;
  const proposalType = retainedProposalTypeOf(entry);
  const targetId = retainedTargetIdOf(entry);
  if (proposalType === null && targetId === undefined && !('value' in entry)) return null;
  return { proposalType: proposalType ?? '', targetId: targetId ?? null };
}

/** Target-label finding for one marker (null when the fact is a legal input). */
function retainedTargetLabelFinding(
  marker: Pick<ReviewedFact, 'proposalType' | 'targetId'>,
  scope: PartitionReplayFactsOptions,
): string | null {
  if (!isTargetLabelFact(marker, scope)) return null;
  return `retained_target_label: proposalType="${marker.proposalType}" targetId="${marker.targetId ?? ''}" must never replay as input`;
}

/** Value-match finding for one retained input (null when it matches no answer). */
function retainedValueMatchFinding(
  entry: RetainedReplayInput,
  answers: Set<string>,
): string | null {
  const value = 'value' in entry ? entry.value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && answers.has(value.trim().toLowerCase())) {
    return `retained_value_matches_gold: retained input value "${value}" equals a target answer`;
  }
  return null;
}

/** Leakage finding for one retained input (null when clean). */
function findRetainedInputLeakage(
  entry: RetainedReplayInput,
  answers: Set<string>,
  scope: PartitionReplayFactsOptions,
): string | null {
  const marker = retainedInputMarker(entry);
  if (!marker) return null;
  return retainedTargetLabelFinding(marker, scope)
    ?? retainedValueMatchFinding(entry, answers);
}

/**
 * List answer-leakage findings for a replay input / gold pair. Empty means
 * clean. Legacy `{ sku, evidence }` snapshots (no retained inputs) are clean
 * by construction.
 */
function findReplayInputLeakage(
  inputSnapshotJson: string,
  goldLabelsJson: string,
  scope: PartitionReplayFactsOptions = {},
): string[] {
  const parsed = parseReplayLeakagePair(inputSnapshotJson, goldLabelsJson);
  if ('error' in parsed) return [parsed.error];
  const findings = findForbiddenReplayInputKeys(parsed.input);
  const retained = parseRetainedReplayInputs(parsed.input);
  if ('error' in retained) {
    findings.push(retained.error);
    return findings;
  }
  const answers = new Set(goldAnswerStrings(parsed.gold));
  for (const entry of retained.retained) {
    const finding = findRetainedInputLeakage(entry, answers, scope);
    if (finding) findings.push(finding);
  }
  return findings;
}

/** Fail closed when a replay input carries the answer. */
function assertNoReplayLeakage(
  inputSnapshotJson: string,
  goldLabelsJson: string,
  scope: PartitionReplayFactsOptions = {},
): void {
  const findings = findReplayInputLeakage(inputSnapshotJson, goldLabelsJson, scope);
  if (findings.length > 0) {
    throw new Error(`Replay input leaks the answer: ${findings.join('; ')}`);
  }
}

// ─── Fixture-builder support (issue #294) ────────────────────────────────────
//
// Representative synthetic/adjudicated fixtures span the store assortment
// (food, treats, toys, animal-care, garden, pest-control) plus confusing
// neighbors, unknown types, and incomplete evidence. Splits reuse
// `splitForFamily` so a family never straddles dev (train/test) and holdout.
// Catalog assignments are reference-only: every case MUST carry an explicit
// `adjudicatedBy` and explicit `gold` — the builder never copies
// `catalogAssignment` into gold. The dataset is created as a draft; freeze it
// through the existing family-review + freeze interfaces.

const FIXTURE_COVERAGE_FOOD = 'food' as const;
const FIXTURE_COVERAGE_TREATS = 'treats' as const;
const FIXTURE_COVERAGE_TOYS = 'toys' as const;
const FIXTURE_COVERAGE_ANIMAL_CARE = 'animal-care' as const;
const FIXTURE_COVERAGE_GARDEN = 'garden' as const;
const FIXTURE_COVERAGE_PEST_CONTROL = 'pest-control' as const;
const FIXTURE_COVERAGE_CONFUSING_NEIGHBOR = 'confusing-neighbor' as const;
const FIXTURE_COVERAGE_UNKNOWN_TYPE = 'unknown-type' as const;
const FIXTURE_COVERAGE_INCOMPLETE_EVIDENCE = 'incomplete-evidence' as const;
const REQUIRED_FIXTURE_COVERAGE = [
  FIXTURE_COVERAGE_FOOD,
  FIXTURE_COVERAGE_TREATS,
  FIXTURE_COVERAGE_TOYS,
  FIXTURE_COVERAGE_ANIMAL_CARE,
  FIXTURE_COVERAGE_GARDEN,
  FIXTURE_COVERAGE_PEST_CONTROL,
  FIXTURE_COVERAGE_CONFUSING_NEIGHBOR,
  FIXTURE_COVERAGE_UNKNOWN_TYPE,
  FIXTURE_COVERAGE_INCOMPLETE_EVIDENCE,
] as const;
type FixtureCoverageKind = (typeof REQUIRED_FIXTURE_COVERAGE)[number];

interface AdjudicatedFixtureCase {
  sku: string;
  familyId: string;
  coverage: FixtureCoverageKind | string;
  evidence: ReplayEvidenceItem[];
  retainedInputs?: RetainedReplayInput[];
  gold: BenchmarkGoldLabels;
  goldState: AdjudicatedGoldState;
  /** Explicit human/system adjudicator — required. Catalog assignments never substitute. */
  adjudicatedBy: string;
  reviewerId?: string | null;
  /** Existing catalog assignment for reference only — NEVER copied into gold. */
  catalogAssignment?: string | null;
  sourceRunId?: string | null;
  sourceConfigHash?: string | null;
  sourceProductHash?: string | null;
}

interface ExportFixtureDatasetOptions {
  name: string;
  cases: AdjudicatedFixtureCase[];
  holdoutPercent?: number;
  splitSeed?: number;
}

interface ExportFixtureDatasetResult {
  datasetId: string;
  exported: number;
  familyCount: number;
  splitDistribution: { train: number; test: number; holdout: number };
  coverage: Record<string, number>;
  missingCoverage: FixtureCoverageKind[];
  leakageChecked: boolean;
}

function summarizeFixtureCoverage(
  cases: Array<Pick<AdjudicatedFixtureCase, 'coverage'>>,
): { counts: Record<string, number>; missing: FixtureCoverageKind[] } {
  const counts: Record<string, number> = {};
  for (const kind of REQUIRED_FIXTURE_COVERAGE) counts[kind] = 0;
  for (const c of cases) {
    counts[c.coverage] = (counts[c.coverage] ?? 0) + 1;
  }
  const missing = (REQUIRED_FIXTURE_COVERAGE as readonly string[]).filter(k => (counts[k] ?? 0) === 0) as FixtureCoverageKind[];
  return { counts, missing };
}
/**
 * Families straddling dev (train/test) and holdout. Empty means clean;
 * `splitForFamily` assignment is clean by construction, so non-empty indicates
 * a manual split override that must be fixed.
 */
export function detectFamilySplitLeakage(
  assignments: Array<{ familyId: string; splitGroup: string }>,
): Array<{ familyId: string; groups: string[] }> {
  return detectDevHoldoutStraddle(assignments);
}

/** Assert fixture identity basics: non-empty sku + familyId + evidence array. */
function assertFixtureCaseIdentity(fixtureCase: AdjudicatedFixtureCase): void {
  if (!fixtureCase.sku || fixtureCase.sku.trim() === '') {
    throw new Error('fixture_case_missing_sku: every fixture case needs a sku.');
  }
  if (!fixtureCase.familyId || fixtureCase.familyId.trim() === '') {
    throw new Error(`fixture_case_missing_family: SKU "${fixtureCase.sku}" needs a familyId for family-grouped splits.`);
  }
  if (!Array.isArray(fixtureCase.evidence)) {
    throw new Error(`fixture_case_missing_evidence: SKU "${fixtureCase.sku}" needs an evidence array (possibly empty for incomplete-evidence cases).`);
  }
}

/** Assert explicit adjudication: adjudicator + known gold state. */
function assertFixtureCaseAdjudication(fixtureCase: AdjudicatedFixtureCase): void {
  if (!fixtureCase.adjudicatedBy || fixtureCase.adjudicatedBy.trim() === '') {
    throw new Error(
      `fixture_case_not_adjudicated: SKU "${fixtureCase.sku}" has no adjudicator; catalog assignments never auto-gold.`,
    );
  }
  if (!isAdjudicatedGoldState(fixtureCase.goldState)) {
    throw new Error(`fixture_case_unknown_gold_state: SKU "${fixtureCase.sku}" carries "${fixtureCase.goldState}".`);
  }
}

/** Assert gold/state consistency: known carries a type, others carry none. */
function assertFixtureGoldStateConsistency(fixtureCase: AdjudicatedFixtureCase): void {
  const productType = fixtureCase.gold?.productType ?? null;
  if (fixtureCase.goldState === GOLD_STATE_KNOWN && (typeof productType !== 'string' || productType.trim() === '')) {
    throw new Error(`fixture_gold_state_mismatch: SKU "${fixtureCase.sku}" is "known" but has no productType gold.`);
  }
  if (fixtureCase.goldState !== GOLD_STATE_KNOWN && productType !== null) {
    throw new Error(
      `fixture_gold_state_mismatch: SKU "${fixtureCase.sku}" is "${fixtureCase.goldState}" but carries productType gold "${productType}".`,
    );
  }
}

function assertFixtureCaseAdjudicated(fixtureCase: AdjudicatedFixtureCase): void {
  assertFixtureCaseIdentity(fixtureCase);
  assertFixtureCaseAdjudication(fixtureCase);
  assertFixtureGoldStateConsistency(fixtureCase);
  // NOTE: `catalogAssignment` is deliberately never read here — it is
  // reference-only and can never become gold without explicit adjudication.
}

/** Validate fixture dataset options (holdout percent + non-empty cases). */
function validateFixtureDatasetOptions(
  options: ExportFixtureDatasetOptions,
): { holdoutPercent: number; splitSeed: number } {
  const holdoutPercent = options.holdoutPercent ?? 20;
  const splitSeed = options.splitSeed ?? 42;
  if (!Number.isFinite(holdoutPercent) || holdoutPercent < 0 || holdoutPercent > 100) {
    throw new Error(`fixture_invalid_holdout_percent: ${holdoutPercent} must be within 0-100.`);
  }
  if (!options.cases || options.cases.length === 0) {
    throw new Error('fixture_no_cases: at least one adjudicated case is required.');
  }
  return { holdoutPercent, splitSeed };
}

/** Assert every fixture case is adjudicated and SKUs are unique. */
function assertFixtureCasesUnique(cases: AdjudicatedFixtureCase[]): void {
  const seenSkus = new Set<string>();
  for (const fixtureCase of cases) {
    assertFixtureCaseAdjudicated(fixtureCase);
    if (seenSkus.has(fixtureCase.sku)) {
      throw new Error(`fixture_duplicate_sku: SKU "${fixtureCase.sku}" appears twice.`);
    }
    seenSkus.add(fixtureCase.sku);
  }
}

/** Build leakage-audited snapshot + gold JSON for one fixture case. */
function buildFixtureCasePayload(
  fixtureCase: AdjudicatedFixtureCase,
): { inputSnapshotJson: string; goldLabelsJson: string } {
  const inputSnapshotJson = buildReplayInputSnapshot(
    fixtureCase.sku,
    fixtureCase.evidence,
    fixtureCase.retainedInputs ?? [],
  );
  const goldLabelsJson = JSON.stringify({
    productType: fixtureCase.gold.productType,
    pageAssignments: fixtureCase.gold.pageAssignments,
    fieldAssignments: fixtureCase.gold.fieldAssignments,
    [FIXTURE_GOLD_STATE_FIELD]: fixtureCase.goldState,
  });
  assertNoReplayLeakage(inputSnapshotJson, goldLabelsJson);
  return { inputSnapshotJson, goldLabelsJson };
}

/** Insert one fixture case with its family-grouped split; returns the assignment. */
function insertFixtureCase(
  datasetId: string,
  fixtureCase: AdjudicatedFixtureCase,
  splitSeed: number,
  holdoutPercent: number,
): { familyId: string; splitGroup: 'train' | 'test' | 'holdout' } {
  const splitGroup = splitForFamily(fixtureCase.familyId, splitSeed, holdoutPercent);
  const { inputSnapshotJson, goldLabelsJson } = buildFixtureCasePayload(fixtureCase);
  benchmarkRepo.insertExample(
    datasetId,
    fixtureCase.sku,
    fixtureCase.familyId,
    splitGroup,
    inputSnapshotJson,
    goldLabelsJson,
    {
      reviewerId: fixtureCase.reviewerId ?? null,
      adjudicatedBy: fixtureCase.adjudicatedBy,
      sourceRunId: fixtureCase.sourceRunId ?? null,
      sourceConfigHash: fixtureCase.sourceConfigHash ?? null,
      sourceProductHash: fixtureCase.sourceProductHash ?? null,
    },
  );
  return { familyId: fixtureCase.familyId, splitGroup };
}

/** Fail closed when fixture families straddle dev and holdout. */
function assertNoFixtureFamilyLeakage(
  assignments: Array<{ familyId: string; splitGroup: string }>,
): void {
  const familyLeakage = detectFamilySplitLeakage(assignments);
  if (familyLeakage.length > 0) {
    throw new Error(
      `fixture_family_leakage: families straddle dev and holdout: ${familyLeakage.map(f => f.familyId).join(', ')}`,
    );
  }
}

/**
 * Build a draft labeled fixture dataset from adjudicated cases. Family-grouped
 * splits reuse `splitForFamily`; every example is leakage-audited before
 * insert. Freeze through the existing family-review + freeze interfaces.
 */
function exportFixtureDataset(
  workspaceId: string,
  options: ExportFixtureDatasetOptions,
): ExportFixtureDatasetResult {
  const { holdoutPercent, splitSeed } = validateFixtureDatasetOptions(options);
  assertFixtureCasesUnique(options.cases);

  const dataset = benchmarkRepo.createDataset(workspaceId, options.name, 'product_family', splitSeed);
  const splitDistribution = { train: 0, test: 0, holdout: 0 };
  const assignments: Array<{ familyId: string; splitGroup: string }> = [];

  for (const fixtureCase of options.cases) {
    const assignment = insertFixtureCase(dataset.id, fixtureCase, splitSeed, holdoutPercent);
    splitDistribution[assignment.splitGroup]++;
    assignments.push(assignment);
  }

  assertNoFixtureFamilyLeakage(assignments);
  benchmarkRepo.updateDatasetExampleCount(dataset.id);

  const families = new Set(options.cases.map(c => c.familyId));
  const { counts, missing } = summarizeFixtureCoverage(options.cases);

  return {
    datasetId: dataset.id,
    exported: options.cases.length,
    familyCount: families.size,
    splitDistribution,
    coverage: counts,
    missingCoverage: missing,
    leakageChecked: true,
  };
}

// ─── Frozen-taxonomy candidates ─────────────────────────────────────────────
//
// Candidate option sets (Product Types, allowed attribute values, pages) MUST
// come from the frozen production taxonomy/config snapshot — never from the
// union of adjudicated gold labels. Gold labels remain the answers: they are
// validated to sit WITHIN the frozen sets (`assertGoldWithinFrozenTaxonomy`)
// but never define them. The code-executed predictor workstream consumes
// `buildFrozenTaxonomyCandidates`; this module owns the frozen source so the
// option pool cannot silently narrow to the gold union.

/** Closed-world candidate sets derived from a frozen taxonomy snapshot. */
export interface FrozenCandidateSets {
  productTypes: Array<{ id: string; label: string }>;
  attributeTargets: Array<{ targetId: string; cardinality: 'single' | 'multiple'; options: string[] }>;
  pages: Array<{ pageId: string; pageName: string }>;
}

/**
 * Derive closed-world candidate sets from the frozen taxonomy snapshot.
 * Sorted for determinism. Reads ONLY the snapshot — gold labels are never an
 * input, so a gold-only type/value/page can never widen or narrow the pool.
 */
export function buildFrozenTaxonomyCandidates(snapshot: FrozenTaxonomySnapshot): FrozenCandidateSets {
  return {
    productTypes: [...snapshot.productTypes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(t => ({ id: t.id, label: t.label })),
    attributeTargets: [...snapshot.attributeTargets]
      .sort((a, b) => (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
      .map(t => ({
        targetId: t.targetId,
        cardinality: t.cardinality,
        options: [...t.options].sort(),
      })),
    pages: [...snapshot.pages]
      .sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0))
      .map(p => ({ pageId: p.pageId, pageName: p.pageName })),
  };
}

/** Minimal adjudicated-gold view for frozen-taxonomy containment checks. */
export interface FrozenGoldCheckEntry {
  sku: string;
  gold: {
    productType: { kind: string; typeId: string | null };
    fieldAssignments: Array<{ targetId: string; value?: unknown; values?: unknown }>;
    categoryPages: {
      pageIds: string[];
      pageAssignments: Array<{ pageId: string }>;
    };
  };
}

/** One string value under test (null when absent/non-string). */
function frozenCheckString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** String values carried by one gold field assignment. */
function frozenCheckFieldValues(field: { value?: unknown; values?: unknown }): string[] {
  const out: string[] = [];
  const single = frozenCheckString(field.value);
  if (single) out.push(single);
  if (Array.isArray(field.values)) {
    for (const v of field.values) {
      const s = frozenCheckString(v);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * List gold-outside-frozen findings. Empty means every adjudicated answer
 * sits within the frozen candidate pool (gold answers, never the pool).
 */
export function findGoldOutsideFrozenTaxonomy(
  entries: FrozenGoldCheckEntry[],
  frozen: FrozenTaxonomySnapshot,
): string[] {
  const findings: string[] = [];
  const typeIds = new Set(frozen.productTypes.map(t => t.id));
  const attrOptions = new Map(frozen.attributeTargets.map(t => [t.targetId, new Set(t.options)]));
  const pageIds = new Set(frozen.pages.map(p => p.pageId));
  for (const entry of entries) {
    const typeId = frozenCheckString(entry.gold.productType.typeId);
    if (typeId !== null && !typeIds.has(typeId)) {
      findings.push(`gold_outside_frozen_taxonomy: SKU "${entry.sku}" productType "${typeId}" not in frozen candidates`);
    }
    for (const field of entry.gold.fieldAssignments ?? []) {
      const allowed = attrOptions.get(field.targetId);
      if (!allowed) {
        findings.push(`gold_outside_frozen_taxonomy: SKU "${entry.sku}" field target "${field.targetId}" not in frozen candidates`);
        continue;
      }
      for (const value of frozenCheckFieldValues(field)) {
        if (!allowed.has(value)) {
          findings.push(`gold_outside_frozen_taxonomy: SKU "${entry.sku}" field "${field.targetId}" value "${value}" not in frozen candidates`);
        }
      }
    }
    for (const pageId of entry.gold.categoryPages?.pageIds ?? []) {
      if (!pageIds.has(pageId)) {
        findings.push(`gold_outside_frozen_taxonomy: SKU "${entry.sku}" page "${pageId}" not in frozen candidates`);
      }
    }
    for (const page of entry.gold.categoryPages?.pageAssignments ?? []) {
      if (!pageIds.has(page.pageId)) {
        findings.push(`gold_outside_frozen_taxonomy: SKU "${entry.sku}" page "${page.pageId}" not in frozen candidates`);
      }
    }
  }
  return findings;
}

/** Fail closed when any adjudicated answer falls outside the frozen pool. */
export function assertGoldWithinFrozenTaxonomy(
  entries: FrozenGoldCheckEntry[],
  frozen: FrozenTaxonomySnapshot,
): void {
  const findings = findGoldOutsideFrozenTaxonomy(entries, frozen);
  if (findings.length > 0) {
    throw new Error(`Gold outside frozen taxonomy: ${findings.join('; ')}`);
  }
}

// ─── Family-separation verification ─────────────────────────────────────────
//
// True family split: real product families (variants/sizes of the same
// underlying product) share ONE family id and never cross the dev/holdout
// boundary. Split-suffixed ids (`*-dev` / `*-holdout` as distinct families)
// are forbidden as family identity — they disguise leakage as separation.
// `verifyFamilySeparation` produces the proof consumed by
// `assessProductionQualification`: shared-identity leakage (a family id on
// both sides) plus cross-split near-duplicate detection (the same underlying
// product filed under two family ids).

/** Proof version bound into every family-separation receipt. */
export const FAMILY_SEPARATION_PROOF_VERSION = 'family-separation-v1' as const;

/** Minimal entry view for family-separation verification. */
export interface FamilySeparationEntry {
  sku: string;
  familyId: string;
  split: string;
  splitGroup?: string;
  evidence?: Array<{ snippet?: unknown }>;
  evidenceText?: string;
}

/** One cross-split near-duplicate pair under distinct family ids. */
export interface FamilyNearDuplicatePair {
  skuA: string;
  skuB: string;
  familyA: string;
  familyB: string;
  reason: string;
  similarity: number | null;
}

/** Family-separation proof consumed by production qualification. */
export interface FamilySeparationProof {
  proofVersion: typeof FAMILY_SEPARATION_PROOF_VERSION;
  verifiedAt: string;
  familiesChecked: number;
  leakedFamilies: Array<{ familyId: string; groups: string[] }>;
  nearDuplicatePairs: FamilyNearDuplicatePair[];
  passed: boolean;
}

/** Jaccard threshold for cross-split near-duplicate evidence (0.5). */
const FAMILY_NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.5;
/** Pairs with either side below this many evidence tokens are skipped (thin-evidence guard). */
const FAMILY_NEAR_DUPLICATE_MIN_TOKENS = 5;

/** Effective split side: train/test/dev are dev-side; holdout stands alone. */
function familySplitSide(split: string): 'dev' | 'holdout' | 'other' {
  if (split === 'holdout') return 'holdout';
  if (split === 'dev' || split === 'train' || split === 'test') return 'dev';
  return 'other';
}

/**
 * Families straddling the dev/holdout boundary (dev-side is dev, train, or
 * test). Unlike `detectDevHoldoutStraddle` (train/test/holdout vocabulary of
 * persisted dataset splits), this covers the qualification goldset's
 * dev/holdout vocabulary: the shared helper is blind to a family shared
 * between dev and holdout, so the exporter owns the dev-aware boundary.
 */
export function detectFamilyDevHoldoutStraddle(
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
    const touchesDevSide = list.some(group => familySplitSide(group) === 'dev');
    if (touchesDevSide && list.includes('holdout')) {
      offenders.push({ familyId, groups: list });
    }
  }
  offenders.sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
  return offenders;
}

/** Split value for one entry (splitGroup alias wins when present). */
function familyEntrySplit(entry: FamilySeparationEntry): string {
  return entry.splitGroup ?? entry.split;
}

/** Evidence text for one entry (joined snippets, or the explicit text). */
function familyEvidenceText(entry: FamilySeparationEntry): string {
  if (typeof entry.evidenceText === 'string') return entry.evidenceText;
  return (entry.evidence ?? [])
    .map(e => (typeof e?.snippet === 'string' ? e.snippet : ''))
    .join(' ')
    .trim();
}

/** Lowercased alphanumeric evidence tokens. */
function familyEvidenceTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1);
  return new Set(tokens);
}

/** Jaccard similarity over two token sets (0 when both empty). */
function familyEvidenceJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Near-duplicate finding for one cross-split pair (null when clean/skipped). */
function findFamilyNearDuplicatePair(
  a: FamilySeparationEntry,
  b: FamilySeparationEntry,
): FamilyNearDuplicatePair | null {
  if (a.familyId === b.familyId) return null;
  if (familySplitSide(familyEntrySplit(a)) === familySplitSide(familyEntrySplit(b))) return null;
  if (familySplitSide(familyEntrySplit(a)) === 'other' || familySplitSide(familyEntrySplit(b)) === 'other') return null;
  const tokensA = familyEvidenceTokens(familyEvidenceText(a));
  const tokensB = familyEvidenceTokens(familyEvidenceText(b));
  if (tokensA.size < FAMILY_NEAR_DUPLICATE_MIN_TOKENS || tokensB.size < FAMILY_NEAR_DUPLICATE_MIN_TOKENS) return null;
  const similarity = familyEvidenceJaccard(tokensA, tokensB);
  if (similarity < FAMILY_NEAR_DUPLICATE_JACCARD_THRESHOLD) return null;
  const [first, second] = a.sku < b.sku ? [a, b] : [b, a];
  return {
    skuA: first.sku,
    skuB: second.sku,
    familyA: first.familyId,
    familyB: second.familyId,
    reason: `near-duplicate-evidence: jaccard ${similarity.toFixed(3)} across dev/holdout under distinct families`,
    similarity: Number(similarity.toFixed(4)),
  };
}

/** Cross-split near-duplicate pairs, sorted deterministically by (skuA, skuB). */
function detectFamilyNearDuplicates(entries: FamilySeparationEntry[]): FamilyNearDuplicatePair[] {
  const pairs: FamilyNearDuplicatePair[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const pair = findFamilyNearDuplicatePair(entries[i], entries[j]);
      if (pair) pairs.push(pair);
    }
  }
  pairs.sort((x, y) => (x.skuA < y.skuA ? -1 : x.skuA > y.skuA ? 1 : x.skuB < y.skuB ? -1 : x.skuB > y.skuB ? 1 : 0));
  return pairs;
}

/**
 * Verify true family separation over qualification entries: shared family
 * identity must never cross the dev/holdout boundary (dev-aware straddle
 * check) AND no cross-split pair under distinct family ids may read as the
 * same underlying product (evidence near-duplicates).
 * Pure and deterministic; `passed` is true only over a non-empty family
 * population with both lists empty.
 */
export function verifyFamilySeparation(entries: FamilySeparationEntry[]): FamilySeparationProof {
  const assignments = entries.map(e => ({ familyId: e.familyId, splitGroup: familyEntrySplit(e) }));
  const leakedFamilies = detectFamilyDevHoldoutStraddle(assignments);
  const nearDuplicatePairs = detectFamilyNearDuplicates(entries);
  const familiesChecked = new Set(entries.map(e => e.familyId)).size;
  return {
    proofVersion: FAMILY_SEPARATION_PROOF_VERSION,
    verifiedAt: new Date().toISOString(),
    familiesChecked,
    leakedFamilies,
    nearDuplicatePairs,
    passed: familiesChecked > 0 && leakedFamilies.length === 0 && nearDuplicatePairs.length === 0,
  };
}
