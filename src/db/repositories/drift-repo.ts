import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

/**
 * Drift 2/6 (#251) — workspace-scoped counts, consistent totals, bounded reads.
 *
 * Outstanding is explicitly defined:
 * - `open` findings form the open (outstanding) count.
 * - `in_reconcile` findings carry a separate visible reconcile count.
 * Neither is folded into or dropped from the other; `blocking` is the
 * explicit union (open + in_reconcile) for push guards.
 *
 * Pagination is stable under concurrent resolution: every list orders by
 * `detected_at DESC, id ASC` so equal timestamps never shuffle rows across
 * pages. Maximum page size is bounded; oversized limits clamp, invalid
 * limits/offsets are rejected by `parseDriftPageParams`.
 *
 * Coexists with Drift 1/6 (#250) upsert/dedup below: identical rechecks
 * update rather than duplicate, and these list/count helpers expose that
 * state consistently per workspace.
 */
export const DRIFT_MAX_PAGE_SIZE = 100;
export const DRIFT_DEFAULT_PAGE_SIZE = 100;
/** Bounded queue read size for bulk resolution (paging reads only). */
export const DRIFT_BULK_PAGE_SIZE = 50;

export interface DriftRow {
  id: string;
  workspaceId: string;
  sku: string;
  detectedAt: string;
  status: string;
  localHash: string | null;
  remoteHash: string;
  localJson: string | null;
  remoteJson: string;
  diffJson: string | null;
  reconcileChangeSetId: string | null;
}

export interface CreateDriftInput {
  workspaceId: string;
  sku: string;
  localHash: string | null;
  remoteHash: string;
  localJson: string | null;
  remoteJson: string;
  diffJson?: string | null;
}

export function createDrift(row: CreateDriftInput): DriftRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status,
       local_hash, remote_hash, local_json, remote_json, diff_json)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [id, row.workspaceId, row.sku, now,
      row.localHash, row.remoteHash, row.localJson, row.remoteJson, row.diffJson ?? null],
  );
  return findDriftById(id)!;
}

/**
 * Idempotent drift upsert (Drift 1/6 #250). Outstanding = `open` +
 * `in_reconcile` (both blocking); the partial unique index
 * `idx_remote_drift_ws_sku_outstanding` enforces at most one outstanding
 * row per (workspace_id, sku) across both statuses so reconcile links are
 * covered without being broken.
 */
export interface UpsertDriftInput extends CreateDriftInput {
  /** Preserve an existing reconcile link when superseding (default true). */
  preserveLink?: boolean;
}

export type UpsertDriftOutcome =
  | { kind: 'inserted'; row: DriftRow }
  | { kind: 'noop'; row: DriftRow }
  | { kind: 'updated'; row: DriftRow };

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT/i.test(msg);
}

/** All outstanding rows for one product, deterministic survivor first. */
export function listOutstandingDriftForSku(workspaceId: string, sku: string): DriftRow[] {
  const db = getDb();
  const rows = db.query(
    `SELECT * FROM remote_drift
     WHERE workspace_id = ? AND sku = ? AND status IN ('open', 'in_reconcile')
     ORDER BY
       CASE WHEN status = 'in_reconcile' THEN 0 ELSE 1 END ASC,
       CASE WHEN reconcile_change_set_id IS NOT NULL THEN 0 ELSE 1 END ASC,
       detected_at ASC, id ASC`,
  ).all(workspaceId, sku) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Idempotent upsert for drift detection (Drift 1/6 #250).
 *
 * - No outstanding row → INSERT a new `open` row (reports `inserted`).
 * - Outstanding row with identical local_hash + remote_hash → no-op
 *   (no new row, no timestamp churn; reports `noop`). This is the
 *   identical-recheck path: zero new rows, existing work stays visible.
 * - Outstanding row with a different remote_hash and/or local_hash →
 *   UPDATE the survivor in place (newer remote supersedes obsolete work,
 *   stale baseline context refreshes) preserving status + reconcile link,
 *   collapsing any extra outstanding duplicates deterministically.
 *   Reports `updated`.
 * - Concurrent racers hitting the partial unique index retry via re-select
 *   + update, so repeated and concurrent checks behave deterministically.
 */
export function upsertDrift(input: UpsertDriftInput): UpsertDriftOutcome {
  const db = getDb();
  const preserveLink = input.preserveLink ?? true;

  const attempt = (): UpsertDriftOutcome => {
    const existing = listOutstandingDriftForSku(input.workspaceId, input.sku);
    if (existing.length === 0) {
      return { kind: 'inserted', row: createDrift(input) };
    }

    const survivor = existing[0];
    const sameRemote = survivor.remoteHash === input.remoteHash;
    const sameLocal = (survivor.localHash ?? null) === (input.localHash ?? null);
    if (sameRemote && sameLocal && existing.length === 1) {
      return { kind: 'noop', row: survivor };
    }

    const now = new Date().toISOString();
    db.run(
      `UPDATE remote_drift
       SET local_hash = ?, remote_hash = ?, local_json = ?, remote_json = ?,
           diff_json = ?, detected_at = ?
       WHERE id = ?`,
      [input.localHash, input.remoteHash, input.localJson, input.remoteJson,
        input.diffJson ?? null, now, survivor.id],
    );

    // Collapse redundant outstanding observations (never touches resolved
    // history). Preserve a reconcile link when the survivor lacks one.
    if (existing.length > 1) {
      let linkToPreserve: string | null = survivor.reconcileChangeSetId;
      if (preserveLink && !linkToPreserve) {
        for (const dup of existing.slice(1)) {
          if (dup.reconcileChangeSetId) {
            linkToPreserve = dup.reconcileChangeSetId;
            break;
          }
        }
      }
      if (linkToPreserve && linkToPreserve !== survivor.reconcileChangeSetId) {
        // Promote the survivor to the reconcile state carrying the link so
        // the change-set back-reference survives the collapse.
        db.run(
          `UPDATE remote_drift SET reconcile_change_set_id = ?, status = 'in_reconcile' WHERE id = ?`,
          [linkToPreserve, survivor.id],
        );
      }
      for (const dup of existing.slice(1)) {
        db.run('DELETE FROM remote_drift WHERE id = ?', [dup.id]);
      }
    }

    return { kind: 'updated', row: findDriftById(survivor.id)! };
  };

  try {
    return attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a concurrent insert race: re-select the winner and update it.
    return attempt();
  }
}

/**
 * Clear outstanding `open` findings that no longer differ (Drift 1/6 #250).
 * Runs only when local vs remote comparison actually matches
 * (localHash === remoteHash). `in_reconcile` rows are deliberately left
 * alone so reconcile links never break via auto-clear; they resolve through
 * the change-set approve/discard path. Returns the number of rows cleared.
 */
export function clearMatchedOpenDrift(workspaceId: string, sku: string): number {
  const db = getDb();
  const res = db.run(
    `DELETE FROM remote_drift
     WHERE workspace_id = ? AND sku = ? AND status = 'open'`,
    [workspaceId, sku],
  );
  return Number(res.changes ?? 0);
}

export function findDriftById(id: string): DriftRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM remote_drift WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listDrift(
  workspaceId: string,
  status?: string,
  limit?: number,
  offset?: number,
  field?: string,
): DriftRow[] {
  const db = getDb();
  let sql = 'SELECT * FROM remote_drift WHERE workspace_id = ?';
  const params: (string | number | null)[] = [workspaceId];
  if (status) {
    if (status === 'blocking') {
      sql += ' AND (status = ? OR status = ?)';
      params.push('open', 'in_reconcile');
    } else {
      sql += ' AND status = ?';
      params.push(status);
    }
  }
  if (field) {
    // Field-scoped listing (#253): product rows containing at least one hunk
    // for this exact field. diff_json is pretty-printed deterministic JSON
    // (`"field": "core.price"` with a space), so match the quoted field name
    // itself (`%"core.price"%`): the closing quote keeps it exact
    // (core.price never matches core.priceExtra) while staying immune to
    // key-spacing. LIKE wildcards in the filter are escaped.
    const escaped = field.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    sql += " AND diff_json LIKE ? ESCAPE '\\'";
    params.push(`%"${escaped}"%`);
  }
  // Stable pagination (#251): detected_at alone is not unique (equal
  // timestamps shuffle across pages while rows resolve). id breaks ties
  // deterministically.
  sql += ' ORDER BY detected_at DESC, id ASC';
  if (limit !== undefined) {
    const clamped = Math.min(Math.max(Math.floor(limit), 1), DRIFT_MAX_PAGE_SIZE);
    sql += ' LIMIT ?';
    params.push(clamped);
    if (offset !== undefined) {
      sql += ' OFFSET ?';
      params.push(Math.max(Math.floor(offset), 0));
    }
  }
  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Parse + validate raw limit/offset query params for GET /api/drift (#251).
 * Returns a bounded { limit, offset }. Throws on negative/invalid values
 * (route maps to 400); oversized limits clamp to DRIFT_MAX_PAGE_SIZE.
 */
export function parseDriftPageParams(
  limitVal: string | null | undefined,
  offsetVal: string | null | undefined,
): { limit: number; offset: number } {
  let limit = DRIFT_DEFAULT_PAGE_SIZE;
  if (limitVal !== null && limitVal !== undefined && limitVal !== '') {
    const parsed = Number(limitVal);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid limit "${limitVal}": must be a positive integer (max ${DRIFT_MAX_PAGE_SIZE}).`,
      );
    }
    limit = Math.min(parsed, DRIFT_MAX_PAGE_SIZE);
  }
  let offset = 0;
  if (offsetVal !== null && offsetVal !== undefined && offsetVal !== '') {
    const parsed = Number(offsetVal);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`Invalid offset "${offsetVal}": must be a non-negative integer.`);
    }
    offset = parsed;
  }
  return { limit, offset };
}

export function hasBlockingDriftForSku(workspaceId: string, sku: string): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT 1 FROM remote_drift
     WHERE workspace_id = ? AND sku = ? AND (status = ? OR status = ?) LIMIT 1`,
  ).get(workspaceId, sku, 'open', 'in_reconcile') as Record<string, unknown> | undefined;
  return !!row;
}

export function hasOpenDriftForSku(workspaceId: string, sku: string): boolean {
  const db = getDb();
  const row = db.query(
    'SELECT 1 FROM remote_drift WHERE workspace_id = ? AND sku = ? AND status = ? LIMIT 1',
  ).get(workspaceId, sku, 'open') as Record<string, unknown> | undefined;
  return !!row;
}

export function countBlockingDrift(workspaceId: string): number {
  return countDrift(workspaceId, 'blocking');
}

export function countOpenDrift(workspaceId: string): number {
  return countDrift(workspaceId, 'open');
}

export function countReconcileDrift(workspaceId: string): number {
  return countDrift(workspaceId, 'in_reconcile');
}

/**
 * Count findings matching the same filter semantics as listDrift (#251),
 * always scoped to the workspace. `undefined` counts every status in the
 * workspace; 'blocking' counts open + in_reconcile; any other value counts
 * that status exactly. When `field` is supplied, only product rows
 * containing at least one hunk for that exact field are counted (#253), so
 * filtered list headers agree with their rows. List totals must be derived
 * from this so the header and rows agree.
 */
export function countDrift(workspaceId: string, status?: string, field?: string): number {
  const db = getDb();
  let sql = 'SELECT COUNT(*) as cnt FROM remote_drift WHERE workspace_id = ?';
  const params: (string | null)[] = [workspaceId];
  if (status) {
    if (status === 'blocking') {
      sql += ' AND (status = ? OR status = ?)';
      params.push('open', 'in_reconcile');
    } else {
      sql += ' AND status = ?';
      params.push(status);
    }
  }
  if (field) {
    const escaped = field.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    sql += " AND diff_json LIKE ? ESCAPE '\\'";
    params.push(`%"${escaped}"%`);
  }
  const row = db.query(sql).get(...params) as Record<string, unknown>;
  return Number(row.cnt);
}

export interface DriftCounts {
  /** Outstanding queue: status = 'open'. */
  open: number;
  /** Reconcile-linked: status = 'in_reconcile'. Never folded into open. */
  reconcile: number;
  /** Explicit union for push guards: open + in_reconcile. */
  blocking: number;
  /** Every finding in the workspace regardless of status. */
  total: number;
}

/** Single consistent snapshot for dashboard + list headers (one workspace). */
export function getDriftCounts(workspaceId: string): DriftCounts {
  const db = getDb();
  const rows = db.query(
    `SELECT status, COUNT(*) as cnt FROM remote_drift
     WHERE workspace_id = ? GROUP BY status`,
  ).all(workspaceId) as Array<{ status: string; cnt: number }>;
  let open = 0;
  let reconcile = 0;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.cnt);
    total += n;
    if (r.status === 'open') open = n;
    else if (r.status === 'in_reconcile') reconcile = n;
  }
  return { open, reconcile, blocking: open + reconcile, total };
}

export function resolveDrift(id: string, newStatus: string): void {
  const db = getDb();
  db.run('UPDATE remote_drift SET status = ? WHERE id = ?', [newStatus, id]);
}

/**
 * Update outstanding hunk state after a single-hunk accept/reject (#253).
 * Rewrites local_hash/local_json/diff_json in place and refreshes
 * detected_at. When `remainingHunks` is empty the caller resolves the row
 * to a terminal status separately; this helper never deletes rows itself.
 */
export function updateDriftHunkState(
  id: string,
  input: { localHash: string | null; localJson: string | null; diffJson: string | null },
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `UPDATE remote_drift
     SET local_hash = ?, local_json = ?, diff_json = ?, detected_at = ?
     WHERE id = ?`,
    [input.localHash, input.localJson, input.diffJson, now, id],
  );
}

/**
 * Lightweight hunk sources for hunk-level listing (#253): outstanding rows
 * without the large local_json/remote_json blobs (diff_json carries the
 * compact hunks). Ordered for stable hunk pagination downstream.
 */
export function listDriftHunkSources(workspaceId: string, status?: string): DriftRow[] {
  const db = getDb();
  let sql = `SELECT id, workspace_id, sku, detected_at, status, local_hash, remote_hash,
    NULL as local_json, '' as remote_json, diff_json, reconcile_change_set_id
    FROM remote_drift WHERE workspace_id = ?`;
  const params: (string | null)[] = [workspaceId];
  if (status) {
    if (status === 'blocking') {
      sql += ' AND (status = ? OR status = ?)';
      params.push('open', 'in_reconcile');
    } else {
      sql += ' AND status = ?';
      params.push(status);
    }
  }
  sql += ' ORDER BY sku ASC, detected_at DESC, id ASC';
  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    sku: String(r.sku),
    detectedAt: String(r.detected_at),
    status: String(r.status),
    localHash: r.local_hash ? String(r.local_hash) : null,
    remoteHash: String(r.remote_hash),
    localJson: null,
    remoteJson: '',
    diffJson: r.diff_json ? String(r.diff_json) : null,
    reconcileChangeSetId: r.reconcile_change_set_id ? String(r.reconcile_change_set_id) : null,
  }));
}

export function linkDriftToChangeSet(id: string, changeSetId: string, newStatus?: string): void {
  const db = getDb();
  if (newStatus) {
    db.run(
      'UPDATE remote_drift SET reconcile_change_set_id = ?, status = ? WHERE id = ?',
      [changeSetId, newStatus, id],
    );
  } else {
    db.run(
      'UPDATE remote_drift SET reconcile_change_set_id = ? WHERE id = ?',
      [changeSetId, id],
    );
  }
}

export function reopenDriftForChangeSet(workspaceId: string, changeSetId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  // Reopen any drifts linked to this change set back to 'open' status
  db.run(
    `UPDATE remote_drift
     SET status = 'open', reconcile_change_set_id = NULL, detected_at = ?
     WHERE workspace_id = ? AND reconcile_change_set_id = ? AND status = 'in_reconcile'`,
    [now, workspaceId, changeSetId],
  );
}

export function findLinkedDrift(workspaceId: string, changeSetId: string): DriftRow | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM remote_drift WHERE workspace_id = ? AND reconcile_change_set_id = ? LIMIT 1',
  ).get(workspaceId, changeSetId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Drift 4b (#257) — every drift linked to one reconcile change set.
 * The reconcile-approval path must settle every linked hunk, not just the
 * first row: a change set may carry several SKUs and each linked drift
 * keeps its own outstanding hunks.
 */
export function listLinkedDrifts(workspaceId: string, changeSetId: string): DriftRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM remote_drift WHERE workspace_id = ? AND reconcile_change_set_id = ? ORDER BY sku ASC, id ASC',
  ).all(workspaceId, changeSetId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/**
 * Drift 4b (#257) — release a single reconcile-linked drift back to `open`
 * without touching its hunk content. Used by explicit reopen (which leaves
 * the change set itself intact for reference) and by reconcile approval
 * when hunks remain after the merge. Returns 1 when released, 0 when the
 * row is missing, foreign, or no longer reconcile-linked.
 */
export function releaseSingleReconcileDrift(id: string, workspaceId: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const res = db.run(
    `UPDATE remote_drift
      SET status = 'open', reconcile_change_set_id = NULL, detected_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'in_reconcile'`,
    [now, id, workspaceId],
  );
  return Number(res.changes ?? 0);
}

/**
 * Drift 6/6 (#255) — legacy terminal-row access for audit retention + prune.
 *
 * Terminal = every status EXCEPT outstanding (`open`) and reconcile-linked
 * (`in_reconcile`). Outstanding work is never a prune candidate: every
 * helper below excludes it by construction, and the guarded delete
 * re-checks the exclusion so a concurrent status move can never be pruned.
 *
 * Reads are bounded (one page per call) so large legacy histories cannot
 * exhaust memory; callers loop until a page comes back short. Blob columns
 * are selected only for the bounded batch being processed.
 */

/** Whole-path bound for one retention batch (matches bulk-path discipline). */
export const DRIFT_RETENTION_BATCH_SIZE = 50;

function isOutstandingStatus(status: string): boolean {
  return status === 'open' || status === 'in_reconcile';
}

/** One bounded page of legacy terminal rows, oldest first (resumable order). */
export function listLegacyTerminalBatch(workspaceId: string, limit: number, offset = 0): DriftRow[] {
  const db = getDb();
  const clamped = Math.min(Math.max(Math.floor(limit), 1), DRIFT_RETENTION_BATCH_SIZE * 4);
  const safeOffset = Math.max(Math.floor(offset), 0);
  const rows = db.query(
    `SELECT * FROM remote_drift
      WHERE workspace_id = ? AND status NOT IN ('open', 'in_reconcile')
      ORDER BY detected_at ASC, id ASC
      LIMIT ? OFFSET ?`,
  ).all(workspaceId, clamped, safeOffset) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Count of legacy terminal rows awaiting backfill + prune. */
export function countLegacyTerminal(workspaceId: string): number {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) as cnt FROM remote_drift
      WHERE workspace_id = ? AND status NOT IN ('open', 'in_reconcile')`,
  ).get(workspaceId) as Record<string, unknown>;
  return Number(row.cnt);
}

/**
 * Server-side blob-size estimate for legacy terminal rows (no blobs cross
 * into JS): SUM of TEXT lengths. Reported as an estimate; the prune result
 * reports exact reclaimed bytes measured per deleted row.
 */
export function estimateLegacyTerminalBlobChars(workspaceId: string): { rows: number; chars: number } {
  const db = getDb();
  const row = db.query(
    `SELECT COUNT(*) as rows,
       COALESCE(SUM(LENGTH(COALESCE(local_json, '')) + LENGTH(remote_json) + LENGTH(COALESCE(diff_json, ''))), 0) as chars
      FROM remote_drift
      WHERE workspace_id = ? AND status NOT IN ('open', 'in_reconcile')`,
  ).get(workspaceId) as Record<string, unknown>;
  return { rows: Number(row.rows), chars: Number(row.chars) };
}

/**
 * Guarded delete of one legacy terminal row. Returns 1 when deleted, 0 when
 * the row is missing, foreign, or no longer terminal (outstanding rows can
 * never match this predicate).
 */
export function deleteLegacyTerminalById(id: string, workspaceId: string): number {
  const db = getDb();
  const res = db.run(
    `DELETE FROM remote_drift
      WHERE id = ? AND workspace_id = ? AND status NOT IN ('open', 'in_reconcile')`,
    [id, workspaceId],
  );
  return Number(res.changes ?? 0);
}

/** Outstanding rows must be untouched by retention; exported for verification. */
export function isOutstandingDriftStatus(status: string): boolean {
  return isOutstandingStatus(status);
}

function mapRow(row: Record<string, unknown>): DriftRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sku: String(row.sku),
    detectedAt: String(row.detected_at),
    status: String(row.status),
    localHash: row.local_hash ? String(row.local_hash) : null,
    remoteHash: String(row.remote_hash),
    localJson: row.local_json ? String(row.local_json) : null,
    remoteJson: String(row.remote_json),
    diffJson: row.diff_json ? String(row.diff_json) : null,
    reconcileChangeSetId: row.reconcile_change_set_id ? String(row.reconcile_change_set_id) : null,
  };
}
