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
import type { BenchmarkGoldLabels } from '../shared/schemas/classification';
import type { ReviewedFact } from './reviewed-facts';

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

  let exported = 0;
  let skipped = 0;
  let configDriftSkipped = 0;

  interface CandidateItem {
    sku: string;
    familyId: string;
    inputSnapshotJson: string;
    goldLabels: BenchmarkGoldLabels;
    sourceRunId: string;
    sourceConfigHash: string | null;
    sourceProductHash: string | null;
  }

  const candidates: CandidateItem[] = [];

  for (const { product_sku: sku } of skuRows) {
    const run = classRunRepo.getRecentRun(workspaceId, sku);
    if (!run) {
      skipped++;
      continue;
    }

    // Config-drift exclusion: the run must be bound to a verifiable config
    // snapshot, otherwise its labels cannot be tied to the activated config.
    if (!run.configSnapshotHash) {
      configDriftSkipped++;
      continue;
    }
    const snapshotRow = db.query(
      'SELECT 1 FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
    ).get(workspaceId, run.configSnapshotHash);
    if (!snapshotRow) {
      configDriftSkipped++;
      continue;
    }

    const evidence = classRunRepo.getEvidenceByRun(run.id);
    const proposals = classRunRepo.getProposalsByRun(run.id);
    const decisions = classRunRepo.getLiveDecisionsByRun(run.id);

    const pageAssignments: Array<{ pageName: string; pageId: string | null }> = [];
    const fieldAssignments: Array<{ targetId: string; value: string | null }> = [];
    let productType: string | null = null;
    let brandName = '';
    let productName = sku;

    for (const ev of evidence) {
      if (ev.source === 'catalog_manager_guidance' && ev.snippet) {
        brandName = ev.snippet;
      }
      if (ev.sourceField === 'product_name' && ev.snippet) {
        productName = ev.snippet;
      }
    }

    for (const proposal of proposals) {
      // Source-drift exclusion: stale proposals never become gold.
      if (proposal.isStale) continue;

      const decision = decisions.find(d => d.proposalId === proposal.id);
      if (!decision || decision.decision !== 'accepted') continue;

      let val: string | null;
      if (decision.hasRevisedValue) {
        val = decision.revisedValue === null || decision.revisedValue === undefined
          ? null
          : typeof decision.revisedValue === 'string'
            ? decision.revisedValue
            : JSON.stringify(decision.revisedValue);
      } else {
        val = proposal.proposedValue === null || proposal.proposedValue === undefined
          ? null
          : typeof proposal.proposedValue === 'string'
            ? proposal.proposedValue
            : JSON.stringify(proposal.proposedValue);
      }

      const effectiveTarget = decision.hasRevisedTargetId && decision.revisedTargetId !== undefined
        ? decision.revisedTargetId
        : proposal.targetId;

      if (proposal.proposalType === 'primary_product_type') {
        productType = val;
      } else if (proposal.proposalType === 'category_page') {
        // Page labels are excluded until a verified Page identity exists.
        if (verifiedPages) {
          // Display name comes from the effective value — never the stable
          // Page ID (issue #17 D1).
          const pageName = pageNameFromPageValue(
            decision.hasRevisedValue ? decision.revisedValue : proposal.proposedValue,
          );
          if (pageName) pageAssignments.push({ pageName, pageId: null });
        }
      } else if (proposal.proposalType === 'field_assignment' && effectiveTarget) {
        fieldAssignments.push({ targetId: effectiveTarget, value: val });
      }
    }

    if (!productType && pageAssignments.length === 0 && fieldAssignments.length === 0) {
      skipped++;
      continue;
    }

    const goldLabels: BenchmarkGoldLabels = {
      productType,
      pageAssignments,
      fieldAssignments,
    };

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

    candidates.push({
      sku,
      familyId,
      inputSnapshotJson,
      goldLabels,
      sourceRunId: run.id,
      sourceConfigHash: run.configSnapshotHash,
      sourceProductHash: run.sourceProductHash,
    });
  }

  const uniqueFamilies = new Set(candidates.map(c => c.familyId));
  const splitDistribution = { train: 0, test: 0, holdout: 0 };

  for (const candidate of candidates) {
    const splitGroup = splitForFamily(candidate.familyId, splitSeed, holdoutPercent);
    splitDistribution[splitGroup]++;

    benchmarkRepo.insertExample(
      dataset.id,
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
export const REPLAY_TARGET_PROPOSAL_TYPES = [
  'primary_product_type',
  'category_page',
  'field_assignment',
] as const;
export type ReplayTargetProposalType = (typeof REPLAY_TARGET_PROPOSAL_TYPES)[number];

/** Minimal retained-input record stored inside replay input snapshots. */
export interface RetainedReplayInput {
  proposalType: string;
  targetId: string | null;
  value: unknown;
}

/** Evidence record stored inside replay input snapshots. */
export interface ReplayEvidenceItem {
  source: string;
  snippet: string;
  reliability?: string;
  attributeId?: string | null;
}

export interface PartitionReplayFactsOptions {
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

export function isTargetLabelFact(
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

export function partitionReplayFactsForReplay(
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

export function toRetainedReplayInput(
  fact: Pick<ReviewedFact, 'proposalType' | 'targetId' | 'value'>,
): RetainedReplayInput {
  return { proposalType: fact.proposalType, targetId: fact.targetId, value: fact.value };
}

export function buildReplayInputSnapshot(
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

export interface ParsedReplayInputSnapshot {
  sku: string;
  evidence: ReplayEvidenceItem[];
  retainedInputs: RetainedReplayInput[];
}

/** Tolerant parse: legacy `{ sku, evidence }` snapshots read as zero retained inputs. */
export function parseReplayInputSnapshot(json: string): ParsedReplayInputSnapshot {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { sku: '', evidence: [], retainedInputs: [] };
  }
  const sku = 'sku' in parsed && typeof parsed.sku === 'string' ? parsed.sku : '';
  const evidence: ReplayEvidenceItem[] = 'evidence' in parsed && Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((item): item is ReplayEvidenceItem => !!item && typeof item === 'object' && 'source' in item && 'snippet' in item)
    : [];
  const retainedInputs: RetainedReplayInput[] =
    'retainedInputs' in parsed && Array.isArray(parsed.retainedInputs)
      ? parsed.retainedInputs.filter((item): item is RetainedReplayInput => !!item && typeof item === 'object' && 'proposalType' in item)
      : [];
  return { sku, evidence, retainedInputs };
}

// ─── Adjudicated gold state (issue #294) ─────────────────────────────────────
//
// Fixture gold distinguishes a known type from a target with no fitting
// configured type, insufficient evidence, or no label at all. The state rides
// as `goldLabelsJson[productTypeState]`; legacy `BenchmarkGoldLabels` readers
// ignore the extra key, and historical example hashes are never rewritten.

export const GOLD_STATE_KNOWN = 'known' as const;
export const GOLD_STATE_NO_FIT = 'no-fit' as const;
export const GOLD_STATE_INSUFFICIENT_EVIDENCE = 'insufficient-evidence' as const;
export const GOLD_STATE_UNLABELED = 'unlabeled' as const;
export const ADJUDICATED_GOLD_STATES = [
  GOLD_STATE_KNOWN,
  GOLD_STATE_NO_FIT,
  GOLD_STATE_INSUFFICIENT_EVIDENCE,
  GOLD_STATE_UNLABELED,
] as const;
export type AdjudicatedGoldState = (typeof ADJUDICATED_GOLD_STATES)[number];

/** Gold-labels JSON field carrying the adjudicated gold state. */
export const FIXTURE_GOLD_STATE_FIELD = 'productTypeState' as const;

function isAdjudicatedGoldState(value: unknown): value is AdjudicatedGoldState {
  return (
    value === GOLD_STATE_KNOWN ||
    value === GOLD_STATE_NO_FIT ||
    value === GOLD_STATE_INSUFFICIENT_EVIDENCE ||
    value === GOLD_STATE_UNLABELED
  );
}

/** Read the adjudicated gold state; `null` for legacy gold without a state marker. */
export function readFixtureGoldState(goldLabelsJson: string): AdjudicatedGoldState | null {
  try {
    const parsed = JSON.parse(goldLabelsJson) as Record<string, unknown>;
    const state = parsed[FIXTURE_GOLD_STATE_FIELD];
    return isAdjudicatedGoldState(state) ? state : null;
  } catch {
    return null;
  }
}

/** Split persisted gold JSON into labels + state; tolerates legacy gold without a state marker. */
export function parseFixtureGoldLabels(goldLabelsJson: string): {
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

function goldAnswerStrings(gold: BenchmarkGoldLabels): string[] {
  const answers: string[] = [];
  if (typeof gold.productType === 'string' && gold.productType.trim() !== '') {
    answers.push(gold.productType.trim().toLowerCase());
  }
  for (const p of gold.pageAssignments ?? []) {
    if (typeof p?.pageName === 'string' && p.pageName.trim() !== '') {
      answers.push(p.pageName.trim().toLowerCase());
    }
  }
  for (const f of gold.fieldAssignments ?? []) {
    if (typeof f?.value === 'string' && f.value.trim() !== '') {
      answers.push(f.value.trim().toLowerCase());
    }
  }
  return answers;
}

/**
 * List answer-leakage findings for a replay input / gold pair. Empty means
 * clean. Legacy `{ sku, evidence }` snapshots (no retained inputs) are clean
 * by construction.
 */
export function findReplayInputLeakage(
  inputSnapshotJson: string,
  goldLabelsJson: string,
  scope: PartitionReplayFactsOptions = {},
): string[] {
  const findings: string[] = [];
  let input: Record<string, unknown>;
  let gold: BenchmarkGoldLabels;
  try {
    input = JSON.parse(inputSnapshotJson) as Record<string, unknown>;
  } catch {
    return ['unparseable_input_snapshot: replay input is not JSON'];
  }
  try {
    gold = JSON.parse(goldLabelsJson) as BenchmarkGoldLabels;
  } catch {
    return ['unparseable_gold_labels: gold labels are not JSON'];
  }
  for (const key of FORBIDDEN_REPLAY_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      findings.push(`forbidden_input_key: replay input carries "${key}" alongside the answer`);
    }
  }
  const rawRetained = (input as { retainedInputs?: unknown }).retainedInputs;
  if (rawRetained !== undefined && !Array.isArray(rawRetained)) {
    findings.push('malformed_retained_inputs: "retainedInputs" must be an array');
    return findings;
  }
  const retained: RetainedReplayInput[] = Array.isArray(rawRetained)
    ? (rawRetained as RetainedReplayInput[])
    : [];
  const answers = new Set(goldAnswerStrings(gold));
  for (const entry of retained) {
    if (!entry || typeof entry !== 'object') continue;
    const hasType = 'proposalType' in entry && typeof entry.proposalType === 'string';
    const hasTarget = 'targetId' in entry && (typeof entry.targetId === 'string' || entry.targetId === null);
    if (!hasType && !hasTarget && !('value' in entry)) continue;
    const marker: Pick<ReviewedFact, 'proposalType' | 'targetId'> = {
      proposalType: hasType ? entry.proposalType : '',
      targetId: hasTarget ? entry.targetId : null,
    };
    if (isTargetLabelFact(marker, scope)) {
      findings.push(
        `retained_target_label: proposalType="${marker.proposalType}" targetId="${marker.targetId ?? ''}" must never replay as input`,
      );
      continue;
    }
    const value = 'value' in entry ? entry.value : undefined;
    if (typeof value === 'string' && value.trim() !== '' && answers.has(value.trim().toLowerCase())) {
      findings.push(`retained_value_matches_gold: retained input value "${value}" equals a target answer`);
    }
  }
  return findings;
}

/** Fail closed when a replay input carries the answer. */
export function assertNoReplayLeakage(
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

export const FIXTURE_COVERAGE_FOOD = 'food' as const;
export const FIXTURE_COVERAGE_TREATS = 'treats' as const;
export const FIXTURE_COVERAGE_TOYS = 'toys' as const;
export const FIXTURE_COVERAGE_ANIMAL_CARE = 'animal-care' as const;
export const FIXTURE_COVERAGE_GARDEN = 'garden' as const;
export const FIXTURE_COVERAGE_PEST_CONTROL = 'pest-control' as const;
export const FIXTURE_COVERAGE_CONFUSING_NEIGHBOR = 'confusing-neighbor' as const;
export const FIXTURE_COVERAGE_UNKNOWN_TYPE = 'unknown-type' as const;
export const FIXTURE_COVERAGE_INCOMPLETE_EVIDENCE = 'incomplete-evidence' as const;
export const REQUIRED_FIXTURE_COVERAGE = [
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
export type FixtureCoverageKind = (typeof REQUIRED_FIXTURE_COVERAGE)[number];

export interface AdjudicatedFixtureCase {
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

export interface ExportFixtureDatasetOptions {
  name: string;
  cases: AdjudicatedFixtureCase[];
  holdoutPercent?: number;
  splitSeed?: number;
}

export interface ExportFixtureDatasetResult {
  datasetId: string;
  exported: number;
  familyCount: number;
  splitDistribution: { train: number; test: number; holdout: number };
  coverage: Record<string, number>;
  missingCoverage: FixtureCoverageKind[];
  leakageChecked: boolean;
}

export function summarizeFixtureCoverage(
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
  const byFamily = new Map<string, Set<string>>();
  for (const a of assignments) {
    if (!byFamily.has(a.familyId)) byFamily.set(a.familyId, new Set());
    byFamily.get(a.familyId)!.add(a.splitGroup);
  }
  const offenders: Array<{ familyId: string; groups: string[] }> = [];
  for (const [familyId, groups] of byFamily) {
    const list = [...groups].sort();
    const inDev = list.includes('train') || list.includes('test');
    const inHoldout = list.includes('holdout');
    if (inDev && inHoldout) offenders.push({ familyId, groups: list });
  }
  offenders.sort((a, b) => (a.familyId < b.familyId ? -1 : a.familyId > b.familyId ? 1 : 0));
  return offenders;
}

function assertFixtureCaseAdjudicated(fixtureCase: AdjudicatedFixtureCase): void {
  if (!fixtureCase.sku || fixtureCase.sku.trim() === '') {
    throw new Error('fixture_case_missing_sku: every fixture case needs a sku.');
  }
  if (!fixtureCase.familyId || fixtureCase.familyId.trim() === '') {
    throw new Error(`fixture_case_missing_family: SKU "${fixtureCase.sku}" needs a familyId for family-grouped splits.`);
  }
  if (!Array.isArray(fixtureCase.evidence)) {
    throw new Error(`fixture_case_missing_evidence: SKU "${fixtureCase.sku}" needs an evidence array (possibly empty for incomplete-evidence cases).`);
  }
  if (!fixtureCase.adjudicatedBy || fixtureCase.adjudicatedBy.trim() === '') {
    throw new Error(
      `fixture_case_not_adjudicated: SKU "${fixtureCase.sku}" has no adjudicator; catalog assignments never auto-gold.`,
    );
  }
  if (!isAdjudicatedGoldState(fixtureCase.goldState)) {
    throw new Error(`fixture_case_unknown_gold_state: SKU "${fixtureCase.sku}" carries "${fixtureCase.goldState}".`);
  }
  const productType = fixtureCase.gold?.productType ?? null;
  if (fixtureCase.goldState === GOLD_STATE_KNOWN && (typeof productType !== 'string' || productType.trim() === '')) {
    throw new Error(`fixture_gold_state_mismatch: SKU "${fixtureCase.sku}" is "known" but has no productType gold.`);
  }
  if (fixtureCase.goldState !== GOLD_STATE_KNOWN && productType !== null) {
    throw new Error(
      `fixture_gold_state_mismatch: SKU "${fixtureCase.sku}" is "${fixtureCase.goldState}" but carries productType gold "${productType}".`,
    );
  }
  // NOTE: `catalogAssignment` is deliberately never read here — it is
  // reference-only and can never become gold without explicit adjudication.
}

/**
 * Build a draft labeled fixture dataset from adjudicated cases. Family-grouped
 * splits reuse `splitForFamily`; every example is leakage-audited before
 * insert. Freeze through the existing family-review + freeze interfaces.
 */
export function exportFixtureDataset(
  workspaceId: string,
  options: ExportFixtureDatasetOptions,
): ExportFixtureDatasetResult {
  const holdoutPercent = options.holdoutPercent ?? 20;
  const splitSeed = options.splitSeed ?? 42;
  if (!Number.isFinite(holdoutPercent) || holdoutPercent < 0 || holdoutPercent > 100) {
    throw new Error(`fixture_invalid_holdout_percent: ${holdoutPercent} must be within 0-100.`);
  }
  if (!options.cases || options.cases.length === 0) {
    throw new Error('fixture_no_cases: at least one adjudicated case is required.');
  }
  const seenSkus = new Set<string>();
  for (const fixtureCase of options.cases) {
    assertFixtureCaseAdjudicated(fixtureCase);
    if (seenSkus.has(fixtureCase.sku)) {
      throw new Error(`fixture_duplicate_sku: SKU "${fixtureCase.sku}" appears twice.`);
    }
    seenSkus.add(fixtureCase.sku);
  }

  const dataset = benchmarkRepo.createDataset(workspaceId, options.name, 'product_family', splitSeed);
  const splitDistribution = { train: 0, test: 0, holdout: 0 };
  const assignments: Array<{ familyId: string; splitGroup: string }> = [];

  for (const fixtureCase of options.cases) {
    const splitGroup = splitForFamily(fixtureCase.familyId, splitSeed, holdoutPercent);
    splitDistribution[splitGroup]++;
    assignments.push({ familyId: fixtureCase.familyId, splitGroup });

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

    benchmarkRepo.insertExample(
      dataset.id,
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
  }

  const familyLeakage = detectFamilySplitLeakage(assignments);
  if (familyLeakage.length > 0) {
    throw new Error(
      `fixture_family_leakage: families straddle dev and holdout: ${familyLeakage.map(f => f.familyId).join(', ')}`,
    );
  }

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
