import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface ChangeSetRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  baseCommit: string;
  approvedCommit: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

export interface ChangeSetItemRow {
  id: string;
  changeSetId: string;
  sku: string;
  operation: string;
  draftJson: string;
  baseJson: string | null;
  draftHash: string;
  validationStatus: string;
  createdAt: string;
  updatedAt: string;
}

export function createChangeSet(ws: {
  workspaceId: string;
  title: string;
  description?: string | null;
  baseCommit: string;
}): ChangeSetRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO change_sets (id, workspace_id, title, description, status, base_commit, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [id, ws.workspaceId, ws.title, ws.description ?? null, ws.baseCommit, now, now],
  );
  return findChangeSetById(id)!;
}

export function findChangeSetById(id: string): ChangeSetRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM change_sets WHERE id = ?').get(...[id]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Find a change set by ID within a specific workspace. Used by privileged
 * operations (e.g. image repair) so a change set from another workspace is
 * indistinguishable from a missing one (fail closed, no ownership disclosure).
 */
export function findChangeSetByWorkspaceId(workspaceId: string, id: string): ChangeSetRow | null {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM change_sets WHERE workspace_id = ? AND id = ?',
  ).get(...[workspaceId, id]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

/**
 * Workspace-scoped Change Set read with its bounded item summary (operations
 * console, Issue 2). A change set from another workspace is indistinguishable
 * from a missing one (fail closed, no ownership disclosure).
 */
export function getChangeSetWithItemsForWorkspace(
  workspaceId: string,
  changeSetId: string,
): { changeSet: ChangeSetRow; items: ChangeSetItemRow[] } | null {
  const changeSet = findChangeSetByWorkspaceId(workspaceId, changeSetId);
  if (!changeSet) return null;
  return { changeSet, items: listChangeSetItems(changeSetId) };
}

export function listChangeSets(workspaceId: string): ChangeSetRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM change_sets WHERE workspace_id = ? ORDER BY created_at DESC',
  ).all(...[workspaceId]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function listChangeSetCountsByState(workspaceId: string): Record<string, number> {
  const db = getDb();
  const rows = db.query(
    'SELECT status, COUNT(*) as count FROM change_sets WHERE workspace_id = ? GROUP BY status',
  ).all(...[workspaceId]) as Record<string, unknown>[];
  const byState: Record<string, number> = {};
  for (const row of rows) {
    byState[String(row.status)] = Number(row.count) || 0;
  }
  return byState;
}

export interface ImageRepairRecommendation {
  changeSetId: string;
  changeSetTitle: string;
  changeSetStatus: string;
  updatedAt: string;
  itemCount: number;
  sampleSkus: string[];
}

function isRepairWorthyImageValue(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  // HTTP(s) URLs are hosted references; only non-empty non-URL values are
  // local/path references that the hardened repair path replaces from
  // extraction evidence.
  return !/^https?:\/\//i.test(value.trim());
}

function imageRefsFromDraft(draftJson: string): { localRefs: number } {
  try {
    const draft = JSON.parse(draftJson) as {
      media?: { primary?: string | null; additional?: string[] | null };
    };
    const media = draft?.media ?? {};
    let localRefs = 0;
    if (isRepairWorthyImageValue(media.primary)) localRefs += 1;
    for (const extra of media.additional ?? []) {
      if (isRepairWorthyImageValue(extra)) localRefs += 1;
    }
    return { localRefs };
  } catch {
    return { localRefs: 0 };
  }
}

/**
 * Deterministic image-repair recommendation read (operations console,
 * Issue 3 — Inbox collector). A change-set item "recommends repair" when its
 * draft product media contains a non-empty image value that is NOT an http(s)
 * URL — a local/path reference the hardened repair path is designed to
 * replace from extraction evidence. Pure static analysis: no network, no
 * decode, no writes. Bounded results; foreign workspaces return nothing.
 */
export function listChangeSetsNeedingImageRepair(workspaceId: string, limit = 50): ImageRepairRecommendation[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 100);
  const rows = db.query(
    `SELECT cs.id, cs.title, cs.status, cs.updated_at, csi.sku, csi.draft_json
     FROM change_sets cs
     JOIN change_set_items csi ON csi.change_set_id = cs.id
     WHERE cs.workspace_id = ?
     ORDER BY cs.updated_at DESC, csi.sku ASC`,
  ).all(...[workspaceId]) as Array<Record<string, unknown>>;

  const perChangeSet = new Map<string, {
    changeSetId: string;
    changeSetTitle: string;
    changeSetStatus: string;
    updatedAt: string;
    itemCount: number;
    sampleSkus: string[];
  }>();
  for (const row of rows) {
    const id = String(row.id);
    const { localRefs } = imageRefsFromDraft(String(row.draft_json ?? ''));
    if (localRefs <= 0) continue;
    const entry = perChangeSet.get(id) ?? {
      changeSetId: id,
      changeSetTitle: String(row.title ?? ''),
      changeSetStatus: String(row.status ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      itemCount: 0,
      sampleSkus: [],
    };
    entry.itemCount += 1;
    if (entry.sampleSkus.length < 20) entry.sampleSkus.push(String(row.sku ?? ''));
    perChangeSet.set(id, entry);
  }
  return [...perChangeSet.values()].slice(0, bounded);
}

/**
 * Workspace-scoped terminal transition observation (operations console,
 * Issue 5 — change_set_approved trigger). Approved Change Sets are observed
 * as committed durable state only; foreign rows are invisible. Bounded.
 */
export function listApprovedChangeSetsForObservation(workspaceId: string, limit = 200): ChangeSetRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 500);
  const rows = db.query(
    "SELECT * FROM change_sets WHERE workspace_id = ? AND status = 'approved' ORDER BY approved_at ASC, updated_at ASC LIMIT ?",
  ).all(...[workspaceId, bounded]) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function updateChangeSetStatus(id: string, status: string, approvedCommit?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (approvedCommit) {
    db.run(
      `UPDATE change_sets SET status = ?, updated_at = ?, approved_commit = ?, approved_at = ? WHERE id = ?`,
      [status, now, approvedCommit, now, id],
    );
  } else {
    db.run(`UPDATE change_sets SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
  }
}

export function findActiveChangeSet(workspaceId: string): ChangeSetRow | null {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM change_sets WHERE workspace_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
  ).get(...[workspaceId]) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

// --- Change Set Items ---

export function upsertChangeSetItem(item: {
  changeSetId: string;
  sku: string;
  operation: string;
  draftJson: string;
  baseJson: string | null;
  draftHash: string;
}): ChangeSetItemRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.run(
    `INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, base_json, draft_hash, validation_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
     ON CONFLICT(change_set_id, sku) DO UPDATE SET
       operation = COALESCE(EXCLUDED.operation, change_set_items.operation),
       draft_json = EXCLUDED.draft_json,
       base_json = COALESCE(EXCLUDED.base_json, change_set_items.base_json),
       draft_hash = EXCLUDED.draft_hash,
       validation_status = 'unknown',
       updated_at = EXCLUDED.updated_at`,
    [id, item.changeSetId, item.sku, item.operation, item.draftJson, item.baseJson, item.draftHash, now, now],
  );
  const row = db.query(
    'SELECT * FROM change_set_items WHERE change_set_id = ? AND sku = ?',
  ).get(...[item.changeSetId, item.sku]) as Record<string, unknown> | undefined;
  return mapItemRow(row!);
}

export function listChangeSetItems(changeSetId: string): ChangeSetItemRow[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM change_set_items WHERE change_set_id = ? ORDER BY sku ASC',
  ).all(...[changeSetId]) as Record<string, unknown>[];
  return rows.map(mapItemRow);
}

/**
 * Most-advanced non-discarded change-set status per onboarding SKU (epic #46
 * Phase 8 — "ready to export / exported" projection). One batched query,
 * scoped to ONE workspace (epic #46 review remediation, fix 3): identical
 * SKUs promoted in DIFFERENT workspaces must never leak their change-set
 * status across workspace boundaries — a SKU pushed in workspace B can never
 * make workspace A report its own product as exported.
 *
 * Discarded change sets never count; a SKU in multiple live change sets
 * resolves to the most advanced lifecycle status (`pushed` > `approved` >
 * `reviewing` > `draft`), so an item already pushed through one release is
 * never reported as merely draft-pending.
 */
export function listChangeSetStatusBySkus(workspaceId: string, skus: string[]): Map<string, string> {
  const db = getDb();
  if (skus.length === 0) return new Map();
  const placeholders = skus.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT csi.sku AS sku, cs.status AS status
     FROM change_set_items csi
     JOIN change_sets cs ON cs.id = csi.change_set_id
     WHERE cs.workspace_id = ? AND csi.sku IN (${placeholders}) AND cs.status != 'discarded'`,
  ).all(workspaceId, ...skus) as Array<{ sku: string; status: string }>;
  const RANK: Record<string, number> = { draft: 1, reviewing: 2, approved: 3, pushed: 4 };
  const result = new Map<string, string>();
  for (const row of rows) {
    const current = result.get(row.sku);
    if (!current || (RANK[row.status] ?? 0) > (RANK[current] ?? 0)) {
      result.set(row.sku, row.status);
    }
  }
  return result;
}

function deleteChangeSetItem(changeSetId: string, sku: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ? AND sku = ?', [changeSetId, sku]);
}

export function deleteChangeSet(id: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ?', [id]);
  db.run('DELETE FROM change_sets WHERE id = ?', [id]);
}

export function setItemValidationStatus(changeSetId: string, sku: string, status: string): void {
  const db = getDb();
  db.run(
    'UPDATE change_set_items SET validation_status = ?, updated_at = ? WHERE change_set_id = ? AND sku = ?',
    [status, new Date().toISOString(), changeSetId, sku],
  );
}

function mapRow(row: Record<string, unknown>): ChangeSetRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    description: row.description ? String(row.description) : null,
    status: String(row.status),
    baseCommit: String(row.base_commit),
    approvedCommit: row.approved_commit ? String(row.approved_commit) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
  };
}

function mapItemRow(row: Record<string, unknown>): ChangeSetItemRow {
  return {
    id: String(row.id),
    changeSetId: String(row.change_set_id),
    sku: String(row.sku),
    operation: String(row.operation),
    draftJson: String(row.draft_json),
    baseJson: row.base_json ? String(row.base_json) : null,
    draftHash: String(row.draft_hash),
    validationStatus: String(row.validation_status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Non-discarded change-set draft payloads for filename reservation
 * (issue #106 SEQUENCE 2b). Previously promoted drafts reserve their file
 * names until Git approval lands them in the catalog — a new promotion
 * must uniquify against these, not just its own batch. Discarded change
 * sets never reserve. Workspace-scoped (fail closed, no cross-workspace
 * ownership disclosure).
 */
export function listNonDiscardedChangeSetDrafts(workspaceId: string): Array<{ sku: string; draftJson: string }> {
  const db = getDb();
  const rows = db.query(
    `SELECT csi.sku, csi.draft_json
     FROM change_set_items csi
     JOIN change_sets cs ON cs.id = csi.change_set_id
     WHERE cs.workspace_id = ? AND cs.status != 'discarded'
     ORDER BY csi.sku ASC`,
  ).all(...[workspaceId]) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ sku: String(row.sku ?? ''), draftJson: String(row.draft_json ?? '') }));
}
