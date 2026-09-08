/**
 * Epic #46 Phase 2 — automation-owned progression: automatic continuation
 * helpers.
 *
 * The operating model: automation owns ordinary stage advancement; humans own
 * exceptions (URL verification, profile setup, conflicts), final review, and
 * release. These helpers implement the deterministic continuation rules:
 *
 * - `advanceDiscoveryItemToExtraction` — a Discovery item that completed with
 *   a confirmed URL (auto-selected by the worker, or operator-set via
 *   select-source/set-url) automatically continues to Extraction. The
 *   human-held discovery holds (no domain mapped / no candidate passed
 *   verification) leave `source_url` NULL and are NEVER auto-advanced.
 * - `advanceCurationItemToReview` — a completed Curation automatically enters
 *   Review (the human QA gate). Guarded: a member whose committed cohort
 *   semantic validation is `blocked` stays at curation/completed (the Needs
 *   Attention surface), and a cohort child whose parent run is still
 *   `freezing`/`running` is never advanced before the parent terminal write.
 * - `sweepAutoAdvance` — poll-loop sweep that applies both rules to every
 *   eligible item in a workspace (cheap: two indexed-scope queries; the
 *   per-item hydration runs only for completed rows).
 *
 * Every automatic transition emits an SSE `item:status` event so the
 * progression stays observable/auditable to the UI and telemetry.
 */
import {
  findItemById,
  listDiscoveryCompletedWithUrl,
  listExtractionCompleted,
  listCurationCompleted,
  advanceDiscoveryToExtraction,
  advanceExtractionToCuration,
  advanceCurationToReview,
} from '../db/repositories/onboarding-item-repo';
import { getActiveCohortForItem } from '../db/repositories/curation-cohort-repo';
import { getCurrentCohortRun } from '../db/repositories/classification-cohort-run-repo';
import { onboardingEvents } from './sse-emitter';
import { getDb } from '../db/connection';
import { toCanonicalStage, type StageV2 } from '../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical comparison of a hydrated (either-spelling) stage. */
function isCanonicalStage(rawStage: unknown, canonical: StageV2): boolean {
  try {
    return toCanonicalStage(rawStage) === canonical;
  } catch {
    return false;
  }
}

/** Parent-run statuses that mean the cohort is still executing. */
const COHORT_PARENT_IN_FLIGHT = new Set(['freezing', 'running']);

export interface AutoAdvanceResult {
  advanced: boolean;
  reason?: string;
}

/**
 * True when the item's active classification run is a cohort child whose
 * parent cohort run is still `freezing`/`running` — or the parent row is
 * missing (orphaned child → fail closed, never advanced). Members are only
 * review-eligible once the parent reached a terminal state (the post-loop
 * Brand coherence check may still block them mid-flight).
 */
function cohortParentInFlight(item: { curationData?: { classificationRunId?: string | null } | null }): boolean {
  const runId = item.curationData?.classificationRunId;
  if (!runId) return false;
  const db = getDb();
  const child = db.query(
    'SELECT cohort_run_id FROM classification_runs WHERE id = ?',
  ).get(runId) as { cohort_run_id: string | null } | undefined;
  if (!child?.cohort_run_id) return false;
  const parent = db.query(
    'SELECT status FROM classification_cohort_runs WHERE id = ?',
  ).get(child.cohort_run_id) as { status: string } | undefined;
  if (!parent) return true;
  return COHORT_PARENT_IN_FLIGHT.has(parent.status);
}

/**
 * Advance one Discovery-completed item (with a confirmed URL) to Extraction.
 * Emits an SSE `item:status` (pending, stage extraction) on success.
 */
export function advanceDiscoveryItemToExtraction(itemId: string): AutoAdvanceResult {
  const item = findItemById(itemId);
  if (!item) return { advanced: false, reason: 'item_not_found' };
  if (!isCanonicalStage(item.stage, 'find_product_page') || item.stageStatus !== 'completed') {
    return { advanced: false, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
  }
  if (!item.sourceUrl) {
    return { advanced: false, reason: 'no_source_url' };
  }
  if (advanceDiscoveryToExtraction(itemId)) {
    onboardingEvents.emitItemStatus(item.batchId, itemId, 'pending', {
      stage: 'collect_details',
      autoAdvanced: true,
      fromStage: 'find_product_page',
    });
    return { advanced: true };
  }
  return { advanced: false, reason: 'transition_failed' };
}

/**
 * Advance one Extraction-completed item (with persisted extraction data) to
 * Curation readiness. Guards:
 * - the item must be `extraction/completed` with extraction data;
 * - a member of a candidate cohort whose current run is still
 *   `freezing`/`running` is never stage-advanced mid-execution (the cohort
 *   path owns its lifecycle; post-run the member advances normally).
 * Emits an SSE `item:status` (pending, stage curation) on success.
 */
export function advanceExtractionItemToCuration(itemId: string): AutoAdvanceResult {
  const item = findItemById(itemId);
  if (!item) return { advanced: false, reason: 'item_not_found' };
  if (!isCanonicalStage(item.stage, 'collect_details') || item.stageStatus !== 'completed') {
    return { advanced: false, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
  }
  if (!item.extractionData) {
    return { advanced: false, reason: 'no_extraction_data' };
  }
  const cohort = getActiveCohortForItem(item.id);
  if (cohort) {
    const run = getCurrentCohortRun(cohort.id);
    if (run && COHORT_PARENT_IN_FLIGHT.has(run.status)) {
      return { advanced: false, reason: 'cohort_parent_in_flight' };
    }
  }
  if (advanceExtractionToCuration(itemId)) {
    onboardingEvents.emitItemStatus(item.batchId, itemId, 'pending', {
      stage: 'prepare_listing',
      autoAdvanced: true,
      fromStage: 'collect_details',
    });
    return { advanced: true };
  }
  return { advanced: false, reason: 'transition_failed' };
}

/**
 * Advance one Curation-completed item to Review (the human gate). Guards:
 * - the item must be `curation/completed` with a committed curation payload;
 * - a `semanticValidation.status === 'blocked'` member stays (the review gate
 *   refuses blocked members, so it is not review-ready);
 * - a cohort child whose parent is still executing stays until the parent is
 *   terminal.
 * Emits an SSE `item:status` (pending, stage review) on success.
 */
export function advanceCurationItemToReview(itemId: string): AutoAdvanceResult {
  const item = findItemById(itemId);
  if (!item) return { advanced: false, reason: 'item_not_found' };
  if (!isCanonicalStage(item.stage, 'prepare_listing') || item.stageStatus !== 'completed') {
    return { advanced: false, reason: `not_eligible:${item.stage}/${item.stageStatus}` };
  }
  if (!item.curationData) {
    return { advanced: false, reason: 'no_curation_data' };
  }
  const semanticValidation = (item.curationData as { semanticValidation?: unknown }).semanticValidation;
  if (
    semanticValidation &&
    typeof semanticValidation === 'object' &&
    (semanticValidation as { status?: unknown }).status === 'blocked'
  ) {
    return { advanced: false, reason: 'semantic_validation_blocked' };
  }
  if (cohortParentInFlight(item)) {
    return { advanced: false, reason: 'cohort_parent_in_flight' };
  }
  if (advanceCurationToReview(itemId)) {
    onboardingEvents.emitItemStatus(item.batchId, itemId, 'pending', {
      stage: 'review_listings',
      autoAdvanced: true,
      fromStage: 'prepare_listing',
    });
    return { advanced: true };
  }
  return { advanced: false, reason: 'transition_failed' };
}

export interface AutoAdvanceSweepResult {
  discoveryToExtraction: string[];
  extractionToCuration: string[];
  curationToReview: string[];
}

/**
 * Poll-loop sweep: apply all automatic-continuation rules to every eligible
 * item in the workspace. Idempotent and cheap (three scoped list queries; the
 * guarded per-item UPDATEs are no-ops once advanced). Failures are isolated
 * per item and never throw.
 */
export function sweepAutoAdvance(workspaceId: string): AutoAdvanceSweepResult {
  const result: AutoAdvanceSweepResult = {
    discoveryToExtraction: [],
    extractionToCuration: [],
    curationToReview: [],
  };
  for (const row of listDiscoveryCompletedWithUrl(workspaceId)) {
    const adv = advanceDiscoveryItemToExtraction(row.id);
    if (adv.advanced) result.discoveryToExtraction.push(row.id);
  }
  for (const row of listExtractionCompleted(workspaceId)) {
    const adv = advanceExtractionItemToCuration(row.id);
    if (adv.advanced) result.extractionToCuration.push(row.id);
  }
  for (const row of listCurationCompleted(workspaceId)) {
    const adv = advanceCurationItemToReview(row.id);
    if (adv.advanced) result.curationToReview.push(row.id);
  }
  return result;
}
