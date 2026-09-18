import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface AuditLogRow {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson: string | null;
}

export function addAuditLog(entry: {
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson?: string | null;
}): AuditLogRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, entry.workspaceId, entry.entityType, entry.entityId, entry.action, entry.message, entry.detailsJson ?? null, now],
  );
  return { id, ...entry, detailsJson: entry.detailsJson ?? null };
}

/**
 * Count audit-log rows for an action within one workspace.
 *
 * Additive telemetry helper (epic #46): e.g. `domain_release` operations
 * (entityType `extractor_profile_domain`) are counted to measure
 * extractor-profile domain unblocks. NOTE: the private `listAuditLogs`
 * helper that previously sat right above this function was removed as dead
 * code (never referenced) while touching this file.
 */
export function countAuditLogsByAction(workspaceId: string, action: string): number {
  const db = getDb();
  const row = db.query(
    'SELECT COUNT(*) AS count FROM audit_log WHERE workspace_id = ? AND action = ?',
  ).get(workspaceId, action) as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}

/**
 * Drift 6/6 (#255) — queryable audit history for past drift decisions.
 *
 * Resolution audit itself is owned by the hunk slices (#253 single-hunk,
 * #254 bulk) plus the 4b lifecycle slice (#257 new-product import and
 * reconcile approval/reopen): they emit `drift_hunk_accepted` /
 * `drift_hunk_rejected` / `drift_bulk_accepted` / `drift_new_product_imported`
 * / `drift_reconcile_approved` / `drift_reconcile_reopened`, and the pre-hunk
 * resolve path emits `kept_local` / `accepted_remote` /
 * `created_reconcile_change_set`. This module adds no new resolution behavior — it only makes those past decisions queryable
 * (workspace-scoped, bounded pagination, stable ordering) so history stays
 * answerable after legacy blob-heavy `remote_drift` rows are pruned.
 *
 * The backfill path (`drift_decision_backfilled`) is written by the
 * retention service for legacy terminal rows that lack any decision audit;
 * it is part of the same queryable decision set.
 */

/** Every audit action that counts as drift-decision evidence. */
export const DRIFT_DECISION_AUDIT_ACTIONS = [
  'drift_hunk_accepted',
  'drift_hunk_rejected',
  'drift_bulk_accepted',
  'accepted_remote',
  'kept_local',
  'created_reconcile_change_set',
  'drift_new_product_imported',
  'drift_reconcile_approved',
  'drift_reconcile_reopened',
  'drift_decision_backfilled',
] as const;

export type DriftDecisionAuditAction = (typeof DRIFT_DECISION_AUDIT_ACTIONS)[number];

/** Bounded pagination for the audit history surface (mirrors #251). */
export const DRIFT_AUDIT_MAX_PAGE_SIZE = 100;
export const DRIFT_AUDIT_DEFAULT_PAGE_SIZE = 100;

export interface DriftAuditEvent {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson: string | null;
  createdAt: string;
}

export interface DriftAuditFilter {
  /** Exact action match. Defaults to the drift-decision set. */
  action?: string;
  /** Exact SKU match (inside details_json). */
  sku?: string;
  /** Exact comparison-field match (inside details_json). */
  field?: string;
  /** Exact decision match: accepted | rejected | reconciled | unknown (inside details_json). */
  decision?: string;
}

function escapeAuditLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function auditWhere(workspaceId: string, filter: DriftAuditFilter): { sql: string; params: (string | null)[] } {
  let sql = 'WHERE workspace_id = ?';
  const params: (string | null)[] = [workspaceId];
  if (filter.action) {
    sql += ' AND action = ?';
    params.push(filter.action);
  } else {
    const placeholders = DRIFT_DECISION_AUDIT_ACTIONS.map(() => '?').join(',');
    sql += ` AND action IN (${placeholders})`;
    for (const a of DRIFT_DECISION_AUDIT_ACTIONS) params.push(a);
  }
  if (filter.sku) {
    sql += " AND details_json LIKE ? ESCAPE '\\'";
    params.push(`%"sku":"${escapeAuditLike(filter.sku)}"%`);
  }
  if (filter.field) {
    sql += " AND details_json LIKE ? ESCAPE '\\'";
    params.push(`%"field":"${escapeAuditLike(filter.field)}"%`);
  }
  if (filter.decision) {
    sql += " AND details_json LIKE ? ESCAPE '\\'";
    params.push(`%"decision":"${escapeAuditLike(filter.decision)}"%`);
  }
  return { sql, params };
}

function mapAuditRow(row: Record<string, unknown>): DriftAuditEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    action: String(row.action),
    message: String(row.message),
    detailsJson: row.details_json ? String(row.details_json) : null,
    createdAt: String(row.created_at),
  };
}

/**
 * True when at least one drift-decision audit exists for this drift row id.
 * The retention backfill uses this as its idempotency + verification gate:
 * creation is skipped when evidence already exists, and pruning proceeds
 * only when this returns true after the backfill attempt.
 */
export function hasDriftDecisionAudit(workspaceId: string, driftId: string): boolean {
  const db = getDb();
  const placeholders = DRIFT_DECISION_AUDIT_ACTIONS.map(() => '?').join(',');
  const row = db.query(
    `SELECT 1 AS hit FROM audit_log
      WHERE workspace_id = ? AND entity_id = ? AND action IN (${placeholders})
      LIMIT 1`,
  ).get(workspaceId, driftId, ...[...DRIFT_DECISION_AUDIT_ACTIONS]) as { hit: number } | undefined;
  return !!row;
}

/**
 * List past drift decisions for one workspace, newest first with a stable
 * id tiebreak so pages never skip or repeat rows while retention prunes.
 */
export function listDriftAuditHistory(
  workspaceId: string,
  filter: DriftAuditFilter = {},
  limit?: number,
  offset?: number,
): DriftAuditEvent[] {
  const db = getDb();
  const { sql, params } = auditWhere(workspaceId, filter);
  let query = `SELECT * FROM audit_log ${sql} ORDER BY created_at DESC, id ASC`;
  const args: (string | number | null)[] = [...params];
  if (limit !== undefined) {
    const clamped = Math.min(Math.max(Math.floor(limit), 1), DRIFT_AUDIT_MAX_PAGE_SIZE);
    query += ' LIMIT ?';
    args.push(clamped);
    if (offset !== undefined) {
      query += ' OFFSET ?';
      args.push(Math.max(Math.floor(offset), 0));
    }
  }
  const rows = db.query(query).all(...args) as Record<string, unknown>[];
  return rows.map(mapAuditRow);
}

/** Count rows matching the same filter semantics as listDriftAuditHistory. */
export function countDriftAuditHistory(workspaceId: string, filter: DriftAuditFilter = {}): number {
  const db = getDb();
  const { sql, params } = auditWhere(workspaceId, filter);
  const row = db.query(`SELECT COUNT(*) as cnt FROM audit_log ${sql}`).get(...params) as Record<string, unknown>;
  return Number(row.cnt);
}
