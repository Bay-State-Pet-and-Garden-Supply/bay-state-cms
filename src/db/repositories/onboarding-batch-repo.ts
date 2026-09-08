import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { getStageCounts } from './onboarding-item-repo';
import type { OnboardingBatch, BatchStatus, BatchExecutionState, PipelineStage } from '../../shared/schemas/onboarding';

export interface OnboardingBatchRow {
  id: string;
  workspace_id: string;
  name: string;
  file_name: string;
  status: string;
  execution_state?: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  skipped_items?: number;
  column_mapping_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapRowToBatch(row: OnboardingBatchRow): OnboardingBatch {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    fileName: row.file_name,
    status: (row.status || 'active') as BatchStatus,
    executionState: (row.execution_state || 'draft') as BatchExecutionState,
    totalItems: row.total_items,
    completedItems: row.completed_items ?? 0,
    failedItems: row.failed_items ?? 0,
    skippedItems: row.skipped_items ?? 0,
    columnMapping: row.column_mapping_json ? JSON.parse(row.column_mapping_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createBatch(data: {
  workspaceId: string;
  name: string;
  fileName: string;
  totalItems: number;
  executionState?: BatchExecutionState;
  columnMappingJson?: string;
}): OnboardingBatch {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const executionState = data.executionState || 'running';

  db.query(
    `INSERT INTO onboarding_batches
      (id, workspace_id, name, file_name, status, execution_state, total_items, completed_items, failed_items, column_mapping_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0, 0, ?, ?, ?)`,
  ).run(id, data.workspaceId, data.name, data.fileName, executionState, data.totalItems, data.columnMappingJson ?? null, now, now);

  return {
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    fileName: data.fileName,
    status: 'active',
    executionState,
    totalItems: data.totalItems,
    completedItems: 0,
    failedItems: 0,
    skippedItems: 0,
    columnMapping: data.columnMappingJson ? JSON.parse(data.columnMappingJson) : null,
    createdAt: now,
    updatedAt: now,
  };
}

export function findBatchById(id: string): OnboardingBatch | undefined {
  const db = getDb();
  // Slice 5a bridge: semantic (dual-spelling) completed counting — both
  // spellings of the promotion stage accumulate into the same bucket.
  const row = db.query(
    `SELECT 
       b.*,
       COALESCE(i.completed_count, 0) as completed_items,
       COALESCE(i.failed_count, 0) as failed_items,
       COALESCE(i.skipped_count, 0) as skipped_items
     FROM onboarding_batches b
     LEFT JOIN (
       SELECT 
         batch_id,
         SUM(CASE WHEN (stage = 'promotion' OR stage = 'create_drafts') AND stage_status = 'completed' THEN 1 ELSE 0 END) as completed_count,
         SUM(CASE WHEN stage_status = 'failed' THEN 1 ELSE 0 END) as failed_count,
         SUM(CASE WHEN stage_status = 'skipped' THEN 1 ELSE 0 END) as skipped_count
       FROM onboarding_items
       GROUP BY batch_id
     ) i ON b.id = i.batch_id
     WHERE b.id = ?`,
  ).get(id) as OnboardingBatchRow | undefined;
  return row ? mapRowToBatch(row) : undefined;
}

export function listBatches(workspaceId: string): OnboardingBatch[] {
  const db = getDb();
  // Slice 5a bridge: semantic (dual-spelling) completed counting.
  const rows = db.query(
    `SELECT 
       b.*,
       COALESCE(i.completed_count, 0) as completed_items,
       COALESCE(i.failed_count, 0) as failed_items,
       COALESCE(i.skipped_count, 0) as skipped_items
     FROM onboarding_batches b
     LEFT JOIN (
       SELECT 
         batch_id,
         SUM(CASE WHEN (stage = 'promotion' OR stage = 'create_drafts') AND stage_status = 'completed' THEN 1 ELSE 0 END) as completed_count,
         SUM(CASE WHEN stage_status = 'failed' THEN 1 ELSE 0 END) as failed_count,
         SUM(CASE WHEN stage_status = 'skipped' THEN 1 ELSE 0 END) as skipped_count
       FROM onboarding_items
       GROUP BY batch_id
     ) i ON b.id = i.batch_id
     WHERE b.workspace_id = ?
     ORDER BY b.created_at DESC`,
  ).all(workspaceId) as OnboardingBatchRow[];
  return rows.map(mapRowToBatch);
}

/**
 * Update the execution state of a batch (draft, ready, running, paused, completed).
 */
export function updateBatchExecutionState(id: string, executionState: BatchExecutionState): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query('UPDATE onboarding_batches SET execution_state = ?, updated_at = ? WHERE id = ?').run(
    executionState,
    now,
    id,
  );
}

/**
 * Archive or reactivate a batch. Batches no longer carry pipeline lifecycle status.
 */
export function setBatchArchived(id: string, archived: boolean): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query('UPDATE onboarding_batches SET status = ?, updated_at = ? WHERE id = ?').run(
    archived ? 'archived' : 'active',
    now,
    id,
  );
}

/**
 * Get derived stage distribution for a batch (computed from items, not stored).
 */
function getBatchStageDistribution(batchId: string): Record<PipelineStage, number> {
  return getStageCounts(batchId);
}

/**
 * Compute whether all items in a batch have reached promotion or been skipped.
 */
export function isBatchComplete(batchId: string): boolean {
  const db = getDb();
  // Slice 5a bridge: dual-spelling archival predicate — v2 create_drafts
  // counts as the terminal promotion stage (same pattern as the claim predicate).
  const remaining = db.query(
    `SELECT COUNT(*) as count FROM onboarding_items
     WHERE batch_id = ? AND (stage != 'promotion' AND stage != 'create_drafts') AND stage_status NOT IN ('skipped', 'failed')`,
  ).get(batchId) as { count: number };
  return remaining.count === 0;
}

/** @deprecated — batches no longer control pipeline lifecycle. Use setBatchArchived instead. */
function updateBatchStatus(
  id: string,
  status: string,
  counters?: { completedItems?: number; failedItems?: number },
): void {
  const db = getDb();
  const now = new Date().toISOString();

  if (counters) {
    const setClauses: string[] = ['status = ?', 'updated_at = ?'];
    const params: (string | number)[] = [status, now];

    if (counters.completedItems !== undefined) {
      setClauses.push('completed_items = ?');
      params.push(counters.completedItems);
    }
    if (counters.failedItems !== undefined) {
      setClauses.push('failed_items = ?');
      params.push(counters.failedItems);
    }
    params.push(id);

    db.query(`UPDATE onboarding_batches SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  } else {
    db.query('UPDATE onboarding_batches SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }
}

/** @deprecated — use getStageCounts + batch completion logic instead */
function incrementBatchCounters(
  id: string,
  field: 'completed_items' | 'failed_items',
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(
    `UPDATE onboarding_batches SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`,
  ).run(now, id);
}

export function deleteBatch(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM onboarding_batches WHERE id = ?').run(id);
  return result.changes > 0;
}
