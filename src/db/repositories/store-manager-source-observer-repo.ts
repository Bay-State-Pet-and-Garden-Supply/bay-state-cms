/**
 * Store Manager source-observer repository (operations console, Issue 5).
 *
 * READ-ONLY observation queries over committed durable sources for the
 * event-trigger worker. The onboarding tables are observed here WITHOUT
 * editing any protected onboarding/sourcing repository or route: the trigger
 * worker is a passive reader. All queries are workspace-scoped and bounded;
 * nothing here writes to onboarding, change-set, sync, or catalog tables.
 *
 * Workspace identity for onboarding batches: batches carry `workspace_id`.
 * Items carry `batch_id`; batch membership is the workspace lens (a batch is
 * a view, never a lifecycle control).
 */

import { getDb } from '../connection';
import { isStageV1String, isStageV2String } from '../../shared/onboarding-stage-vocabulary';

export interface OnboardingBatchObservation {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface OnboardingItemObservation {
  id: string;
  batchId: string;
  upc: string;
  stage: string;
  stageStatus: string;
  isDuplicate: boolean;
  existingSku: string | null;
  updatedAt: string;
}

/** Bounded list of batches in the workspace (observation source). */
export function listBatchesForObservation(workspaceId: string, limit = 200): OnboardingBatchObservation[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 500);
  const rows = db.query(
    'SELECT id, workspace_id, name, created_at, updated_at FROM onboarding_batches WHERE workspace_id = ? ORDER BY created_at ASC LIMIT ?',
  ).all(...[workspaceId, bounded]) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name ?? ''),
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }));
}

/**
 * Bounded item snapshot for one batch. SELECT-only over onboarding_items —
 * the protected onboarding repositories are never modified; observation is a
 * passive committed-state read.
 */
export function listItemsForBatchObservation(batchId: string, limit = 1000): OnboardingItemObservation[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 5000);
  const rows = db.query(
    `SELECT id, batch_id, upc, stage, stage_status, is_duplicate, existing_sku, updated_at
     FROM onboarding_items WHERE batch_id = ? ORDER BY row_number ASC LIMIT ?`,
  ).all(...[batchId, bounded]) as Record<string, unknown>[];
  return rows.map((r) => {
    // Slice 5b native: refuse-v2 retained (downstream trigger comparisons
    // are canonical/dual-read; the observer still passes stored v1 rows
    // through byte-identical). v2/unknown literals fail closed here
    // instead of silently misclassifying terminal/promotion state.
    // Storage activation (v2 rows) is a separately authorized operational
    // action that must revisit this seam first.
    const rawStage = typeof r.stage === 'string' ? r.stage : '';
    if (isStageV2String(rawStage)) {
      throw new Error(
        `[observer] Refusing v2 stage literal '${rawStage}' (item ${String(r.id ?? '?')}): ` +
          `the observer bridge is v1-only until the 5b native cutover — refusing instead of misreading terminal state`,
      );
    }
    if (!isStageV1String(rawStage)) {
      throw new Error(
        `[observer] Refusing unknown stage literal '${rawStage}' (item ${String(r.id ?? '?')}): ` +
          `unknown stages are never coerced to the first stage`,
      );
    }
    return {
      id: String(r.id),
      batchId: String(r.batch_id),
      upc: String(r.upc ?? ''),
      stage: rawStage,
      stageStatus: String(r.stage_status ?? ''),
      isDuplicate: Number(r.is_duplicate ?? 0) === 1,
      existingSku: r.existing_sku ? String(r.existing_sku) : null,
      updatedAt: String(r.updated_at ?? ''),
    };
  });
}
