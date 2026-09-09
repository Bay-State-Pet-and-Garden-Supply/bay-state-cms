/**
 * Classification Refresh Queue Repository (P1.3).
 *
 * Implements atomic claiming with lease expiration, completion, failure/retry,
 * and pending counts for type-dependent recomputation queue items.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface RefreshQueueItem {
  id: string;
  workspaceId: string;
  productSku: string;
  sourceKind: string;
  onboardingItemId: string | null;
  cohortId: string | null;
  expectedRunId: string | null;
  expectedParentRunId: string | null;
  triggerType: string;
  triggerDecisionId: string | null;
  refreshScopeJson: string;
  requestedBy: string;
  status: 'queued' | 'claimed' | 'completed' | 'failed';
  claimedBy: string | null;
  claimedAt: string | null;
  attemptCount: number;
  outcomeRunId: string | null;
  errorMessage: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export interface EnqueueRefreshOptions {
  workspaceId: string;
  productSku: string;
  sourceKind?: string;
  onboardingItemId?: string | null;
  cohortId?: string | null;
  expectedRunId?: string | null;
  expectedParentRunId?: string | null;
  triggerType: string;
  triggerDecisionId?: string | null;
  refreshScope?: Record<string, unknown>;
  requestedBy: string;
}

function mapRowToItem(row: Record<string, any>): RefreshQueueItem {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    productSku: String(row.product_sku),
    sourceKind: String(row.source_kind ?? 'onboarding'),
    onboardingItemId: row.onboarding_item_id ? String(row.onboarding_item_id) : null,
    cohortId: row.cohort_id ? String(row.cohort_id) : null,
    expectedRunId: row.expected_run_id ? String(row.expected_run_id) : null,
    expectedParentRunId: row.expected_parent_run_id ? String(row.expected_parent_run_id) : null,
    triggerType: String(row.trigger_type),
    triggerDecisionId: row.trigger_decision_id ? String(row.trigger_decision_id) : null,
    refreshScopeJson: String(row.refresh_scope_json ?? '{}'),
    requestedBy: String(row.requested_by),
    status: String(row.status) as RefreshQueueItem['status'],
    claimedBy: row.claimed_by ? String(row.claimed_by) : null,
    claimedAt: row.claimed_at ? String(row.claimed_at) : null,
    attemptCount: Number(row.attempt_count ?? 0),
    outcomeRunId: row.outcome_run_id ? String(row.outcome_run_id) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    requestedAt: String(row.requested_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

/**
 * Enqueue a new refresh request. Supersedes older queued triggers for the same
 * scope so a later type correction wins and stale triggers never execute.
 */
export function enqueueRefreshItem(options: EnqueueRefreshOptions): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Idempotency against the UNIQUE INDEX on trigger_decision_id: a retried
  // submit reusing the same trigger decision id returns the existing row
  // instead of inserting a duplicate that would abort the review-commit
  // transaction in proposal-review-service.ts. The check runs inside the
  // enqueue transaction so concurrent retries cannot both pass the check.
  let resultId: string = id;
  db.transaction(() => {
    if (options.triggerDecisionId) {
      const existing = db.query(
        `SELECT id FROM classification_refresh_queue WHERE trigger_decision_id = ? LIMIT 1`,
      ).get(options.triggerDecisionId) as { id: string } | undefined;
      if (existing) {
        resultId = existing.id;
        return;
      }
    }
    // Supersede older queued rows for the same item/run scope.
    if (options.onboardingItemId || options.expectedRunId) {
      db.run(
        `UPDATE classification_refresh_queue SET status = 'failed', error_message = 'superseded by newer trigger', completed_at = ?
         WHERE status = 'queued' AND ((onboarding_item_id IS NOT NULL AND onboarding_item_id = ?) OR (expected_run_id IS NOT NULL AND expected_run_id = ?))`,
        [now, options.onboardingItemId ?? null, options.expectedRunId ?? null],
      );
    }
  db.run(
    `INSERT INTO classification_refresh_queue
     (id, workspace_id, product_sku, source_kind, onboarding_item_id, cohort_id,
      expected_run_id, expected_parent_run_id, trigger_type, trigger_decision_id,
      refresh_scope_json, requested_by, status, attempt_count, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
    [
      id,
      options.workspaceId,
      options.productSku,
      options.sourceKind ?? 'onboarding',
      options.onboardingItemId ?? null,
      options.cohortId ?? null,
      options.expectedRunId ?? null,
      options.expectedParentRunId ?? null,
      options.triggerType,
      options.triggerDecisionId ?? null,
      JSON.stringify(options.refreshScope ?? {}),
      options.requestedBy,
      now,
    ],
  );
  })();

  return resultId;
}

/**
 * Atomically claim up to `limit` pending or expired-lease items (CAS).
 * Single-statement conditional claim: only rows still queued/expired are
 * claimed, and only actually-claimed rows are returned.
 */
export function claimRefreshBatch(
  workerId: string,
  limit = 5,
  leaseSeconds = 300,
  options?: { workspaceId?: string; excludeDeferred?: boolean },
): RefreshQueueItem[] {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiredBefore = new Date(now.getTime() - leaseSeconds * 1000).toISOString();

  // Workspace scoping + deferral exclusion happen in the claim query itself:
  // claiming foreign/deferred rows would park them as 'claimed' (burning an
  // attempt and stalling their rightful worker until lease expiry).
  const scopeClause = options?.workspaceId ? `AND workspace_id = ?` : ``;
  const deferralClause = options?.excludeDeferred
    ? `AND NOT EXISTS (SELECT 1 FROM classification_refresh_deferrals d WHERE d.refresh_queue_id = classification_refresh_queue.id)`
    : ``;
  const scopeArgs: string[] = options?.workspaceId ? [options.workspaceId] : [];

  const candidates = db.query(
    `SELECT id FROM classification_refresh_queue
       WHERE ((status = 'queued')
          OR (status = 'claimed' AND claimed_at <= ?))
       ${scopeClause} ${deferralClause}
       ORDER BY requested_at ASC
       LIMIT ?`,
  ).all(expiredBefore, ...scopeArgs, limit) as Array<{ id: string }>;

  if (candidates.length === 0) return [];

  const claimedIds: string[] = [];
  for (const c of candidates) {
    const res = db.run(
      `UPDATE classification_refresh_queue
       SET status = 'claimed', claimed_by = ?, claimed_at = ?, attempt_count = attempt_count + 1
       WHERE id = ? AND ((status = 'queued') OR (status = 'claimed' AND claimed_at <= ?))
       ${scopeClause} ${deferralClause}`,
      [workerId, nowIso, c.id, expiredBefore, ...scopeArgs],
    );
    if (res.changes > 0) claimedIds.push(c.id);
  }
  if (claimedIds.length === 0) return [];
  const placeholders = claimedIds.map(() => '?').join(', ');
  const claimedRows = db.query(
    `SELECT * FROM classification_refresh_queue WHERE id IN (${placeholders})`,
  ).all(...claimedIds) as Record<string, any>[];
  return claimedRows.map(mapRowToItem);
}

/**
 * Mark a refresh item as completed with the outcome run ID.
 */
export function completeRefreshItem(id: string, outcomeRunId?: string | null): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db.run(
    `UPDATE classification_refresh_queue
     SET status = 'completed',
         outcome_run_id = ?,
         completed_at = ?,
         error_message = NULL
     WHERE id = ?`,
    [outcomeRunId ?? null, now, id],
  );
  return res.changes > 0;
}

/**
 * Mark a refresh item as failed, either permanently or re-queued for retry.
 */
export function failRefreshItem(
  id: string,
  error: string,
  retryable = true,
  maxAttempts = 3,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();

  const item = db.query(
    'SELECT attempt_count FROM classification_refresh_queue WHERE id = ?',
  ).get(id) as { attempt_count: number } | undefined;

  const attempts = item ? item.attempt_count : 1;
  const shouldRetry = retryable && attempts < maxAttempts;
  const nextStatus = shouldRetry ? 'queued' : 'failed';

  const res = db.run(
    `UPDATE classification_refresh_queue
     SET status = ?,
         claimed_by = NULL,
         claimed_at = NULL,
         error_message = ?,
         completed_at = ?
     WHERE id = ?`,
    [nextStatus, error, shouldRetry ? null : now, id],
  );

  return res.changes > 0;
}

/**
 * Get pending (or claimed) refresh count for a workspace.
 */
export function getPendingRefreshCount(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) AS count
     FROM classification_refresh_queue
     WHERE workspace_id = ? AND status IN ('queued', 'claimed')`,
  ).get(workspaceId) as { count: number } | undefined;
  return row ? row.count : 0;
}
