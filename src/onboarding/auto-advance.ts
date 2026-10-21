/**
 * Automation-owned progression between completed item stages.
 * Release authority is checked by the item-local review and promotion gates;
 * cohort parent completion is not a prerequisite for an independent item.
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
import { onboardingEvents } from './sse-emitter';
import { toCanonicalStage, type StageV2 } from '../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical comparison of a hydrated (either-spelling) stage. */
function isCanonicalStage(rawStage: unknown, canonical: StageV2): boolean {
  try {
    return toCanonicalStage(rawStage) === canonical;
  } catch {
    return false;
  }
}

/**
 * Issue #303 follow-up: cross-leg rotation + keyset cursors so a permanently
 * held prefix on ANY leg can never starve the other legs. Each leg keeps a
 * keyset cursor (last inspected row id); each poll also rotates the STARTING
 * leg round-robin, so a leg whose pool never drains (e.g. 200 held
 * Extraction rows) cannot consume every poll's budget before Curation is
 * visited. Per-leg legs additionally reserve bounded capacity
 * (`ceil(limit / 3)` each): leftover budget still flows to the other legs,
 * but one leg can never take the whole poll.
 *
 * Pagination is cursor-based at the repository layer (LIMIT + keyset on
 * `(row_number, id)`), so per-poll work stays bounded regardless of the
 * completed-row count — no full-pool materialize-and-rotate before the first
 * yield. A missing cursor id (fresh DB, advanced-away row) wraps from the
 * head; an unknown keyset cursor restarts from the head once per poll.
 * In-memory only — a restart re-scans from the head, which is merely one
 * redundant bounded pass.
 */
const sweepCursors = new Map<string, string>();
const sweepStartLeg = new Map<string, number>();

function sweepCursorKey(workspaceId: string, leg: string): string {
  return `${workspaceId}:${leg}`;
}

/**
 * Bounded page of one sweep leg starting after `cursorId` (keyset on
 * `(row_number, id)` via the repository). Wraps once from the head when the
 * cursor is absent/unknown or the page past it is empty.
 */
function listLegPage(
  leg: 'discovery' | 'extraction' | 'curation',
  workspaceId: string,
  cursorId: string | undefined,
  limit: number,
): Array<{ id: string }> {
  const list =
    leg === 'discovery' ? listDiscoveryCompletedWithUrl : leg === 'extraction' ? listExtractionCompleted : listCurationCompleted;
  if (cursorId === undefined) return list(workspaceId, { limit });
  const after = list(workspaceId, { afterId: cursorId, limit });
  // Unknown cursor (advanced-away row, cross-workspace id) OR end of pool:
  // wrap once from the head so later rows keep progressing.
  if (after.length > 0) return after;
  return list(workspaceId, { limit });
}

export interface AutoAdvanceResult {
  advanced: boolean;
  reason?: string;
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
 * Advance one Extraction-completed item with persisted extraction data to
 * its item-local Curation stage.
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
 * Advance one completed item-local Curation run to Review. Review completion
 * and promotion enforce currentness and readiness; no cohort output is a
 * prerequisite for showing this item to its reviewer.
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
 * Issue #303: per-iteration work budget for the poll-loop auto-advance
 * sweep. The lists are unbounded (every completed row in the workspace), and
 * `poll()` runs the sweep synchronously before claiming — a large production
 * batch (thousands of completed rows) holds the event loop for the whole
 * sweep and starves HTTP throughput. The cap keeps one poll iteration
 * bounded; leftover rows advance on later polls (claims are atomic and rows
 * stay `completed` until advanced, so a restart mid-sweep is safe).
 *
 * Sized so a single iteration stays well under the 2s poll cadence on
 * commodity hardware: each advance is one guarded UPDATE plus one SSE emit
 * (in-process). Tune only via this constant — never per call site.
 */
export const AUTO_ADVANCE_SWEEP_LIMIT = 200;

export interface AutoAdvanceSweepOptions {
  /**
 * Maximum eligible items advanced per sweep invocation (across all three
 * legs, discovery → extraction → curation in order). Defaults to
 * AUTO_ADVANCE_SWEEP_LIMIT; callers pass a smaller value only in tests.
   */
  limit?: number;
  /**
 * Cooperative yield called after every processed item (default: none for
 * direct callers — the worker passes its `setImmediate` yield). Lets a
 * large sweep serve pending HTTP work between items instead of after the
 * whole sweep.
   */
  yieldBetweenItems?: () => Promise<void>;
}

/**
 * Poll-loop sweep: apply all automatic-continuation rules to eligible items
 * in the workspace, bounded to `limit` inspected items per invocation so one
 * iteration can never hold the event loop for an unbounded row set.
 * Idempotent and cheap (three bounded keyset pages; the guarded per-item
 * UPDATEs are no-ops once advanced). Skipped rows stay eligible: a later
 * poll (or a post-restart re-poll — claims are atomic, sweeps are
 * idempotent) picks them up. Failures are isolated per item and never throw.
 *
 * Fairness: each leg resumes after the row the previous poll inspected last
 * (keyset cursor, wrapping around) AND the starting leg rotates round-robin
 * per workspace, with bounded capacity (`ceil(limit / 3)`) reserved per leg.
 * A permanently held prefix on any leg (e.g. semantic-blocked Curation rows,
 * or an Extraction pool that never drains) therefore cannot consume every
 * poll's budget before the other legs are visited.
 */
export async function sweepAutoAdvance(workspaceId: string, options: AutoAdvanceSweepOptions = {}): Promise<AutoAdvanceSweepResult> {
  const limit = options.limit ?? AUTO_ADVANCE_SWEEP_LIMIT;
  const yieldBetweenItems = options.yieldBetweenItems;
  const result: AutoAdvanceSweepResult = {
    discoveryToExtraction: [],
    extractionToCuration: [],
    curationToReview: [],
  };
  if (limit <= 0) return result;
  const perLegCap = Math.max(1, Math.ceil(limit / 3));
  const legs = [
    { leg: 'discovery' as const, advance: advanceDiscoveryItemToExtraction, collected: result.discoveryToExtraction },
    { leg: 'extraction' as const, advance: advanceExtractionItemToCuration, collected: result.extractionToCuration },
    { leg: 'curation' as const, advance: advanceCurationItemToReview, collected: result.curationToReview },
  ];
  const start = sweepStartLeg.get(workspaceId) ?? 0;
  sweepStartLeg.set(workspaceId, (start + 1) % legs.length);
  let remaining = limit;
  for (let i = 0; i < legs.length; i++) {
    if (remaining <= 0) break;
    const entry = legs[(start + i) % legs.length]!;
    remaining -= await sweepLeg(
      entry.leg,
      workspaceId,
      Math.min(perLegCap, remaining),
      entry.advance,
      entry.collected,
      yieldBetweenItems,
    );
  }
  return result;
}

/**
 * Inspect up to `legBudget` rows of one sweep leg via a single bounded
 * keyset page, advancing the eligibility rule per row. Records the last
 * inspected row id as the leg's rotation cursor so the next poll resumes
 * after it instead of re-scanning a held prefix. Returns the inspected
 * count. Never materializes more than the page ahead of the cursor.
 */
async function sweepLeg(
  leg: 'discovery' | 'extraction' | 'curation',
  workspaceId: string,
  legBudget: number,
  advance: (itemId: string) => AutoAdvanceResult,
  collected: string[],
  yieldBetweenItems: (() => Promise<void>) | undefined,
): Promise<number> {
  const cursorKey = sweepCursorKey(workspaceId, leg);
  const page = listLegPage(leg, workspaceId, sweepCursors.get(cursorKey), legBudget);
  let inspected = 0;
  for (const row of page) {
    inspected++;
    const adv = advance(row.id);
    if (adv.advanced) collected.push(row.id);
    sweepCursors.set(cursorKey, row.id);
    if (yieldBetweenItems) await yieldBetweenItems();
  }
  return inspected;
}
