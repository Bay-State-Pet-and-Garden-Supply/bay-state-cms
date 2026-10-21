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
  classificationRunId: string | null;
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
  classificationRunId?: string | null;
}): ChangeSetItemRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  // A manual edit may clear catalog-classification routing, but cannot erase
  // an onboarding draft's release authority. A refreshed producer supplies a
  // new explicit run; omitted bindings preserve the existing source.
  const hasRunBinding = item.classificationRunId !== undefined && item.classificationRunId !== null;
  const clearsBinding = item.classificationRunId === null;
  const runConflictSet = hasRunBinding
    ? 'EXCLUDED.classification_run_id'
    : clearsBinding
      ? `CASE WHEN EXISTS (
           SELECT 1 FROM classification_runs r
           WHERE r.id = change_set_items.classification_run_id AND r.source_kind = 'onboarding'
         ) THEN change_set_items.classification_run_id ELSE NULL END`
      : 'change_set_items.classification_run_id';
  const cols = hasRunBinding
    ? 'id, change_set_id, sku, operation, draft_json, base_json, draft_hash, validation_status, classification_run_id, created_at, updated_at'
    : 'id, change_set_id, sku, operation, draft_json, base_json, draft_hash, validation_status, created_at, updated_at';
  const placeholders = hasRunBinding
    ? '?, ?, ?, ?, ?, ?, ?, \'unknown\', ?, ?, ?'
    : '?, ?, ?, ?, ?, ?, ?, \'unknown\', ?, ?';
  const runParam: string | null = hasRunBinding ? String(item.classificationRunId) : null;
  const insertParams: Array<string | number | bigint | boolean | Uint8Array | null> = hasRunBinding
    ? [id, item.changeSetId, item.sku, item.operation, item.draftJson, item.baseJson, item.draftHash, runParam, now, now]
    : [id, item.changeSetId, item.sku, item.operation, item.draftJson, item.baseJson, item.draftHash, now, now];
  db.run(
    `INSERT INTO change_set_items (${cols})
     VALUES (${placeholders})
     ON CONFLICT(change_set_id, sku) DO UPDATE SET
       operation = COALESCE(EXCLUDED.operation, change_set_items.operation),
       draft_json = EXCLUDED.draft_json,
       base_json = COALESCE(EXCLUDED.base_json, change_set_items.base_json),
       draft_hash = EXCLUDED.draft_hash,
       validation_status = 'unknown',
       classification_run_id = ${runConflictSet},
       updated_at = EXCLUDED.updated_at`,
    insertParams,
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

// fallow-ignore-next-line unused-export
function deleteChangeSetItem(changeSetId: string, sku: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ? AND sku = ?', [changeSetId, sku]);
}

export function deleteChangeSet(id: string): void {
  const db = getDb();
  db.run('DELETE FROM change_set_items WHERE change_set_id = ?', [id]);
  // A linked manifest is meaningless without its change set (issue #363):
  // drop it here so discarding a linked group — approved, failed, or
  // interrupted — never trips the manifest foreign key.
  try {
    ensureLinkedManifestTable();
    db.run('DELETE FROM change_set_linked_manifests WHERE change_set_id = ?', [id]);
  } catch { /* manifest cleanup best-effort; set deletion below still runs */ }
  db.run('DELETE FROM change_sets WHERE id = ?', [id]);
}

/**
 * Create an update change-set draft with its single item atomically (issue
 * #354): a failure between the two writes must never orphan an empty change
 * set — either both persist or neither does. Transaction ownership lives
 * here; callers pass only data, never SQL.
 */
export function createUpdateDraftWithItem(input: {
  workspaceId: string;
  title: string;
  description: string;
  baseCommit: string;
  sku: string;
  draftJson: string;
  baseJson: string;
  draftHash: string;
  classificationRunId: string;
}): ChangeSetRow {
  const db = getDb();
  return db.transaction(() => {
    const created = createChangeSet({
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description,
      baseCommit: input.baseCommit,
    });
    upsertChangeSetItem({
      changeSetId: created.id,
      sku: input.sku,
      operation: 'update',
      draftJson: input.draftJson,
      baseJson: input.baseJson,
      draftHash: input.draftHash,
      classificationRunId: input.classificationRunId,
    });
    return created;
  })();
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
    classificationRunId:
      'classification_run_id' in row && row.classification_run_id != null
        ? String(row.classification_run_id)
        : null,
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

// ── Linked/consistency-group approval manifest store (issue #363) ────────────
// Structural contract: full changed-product write set + unchanged-member read
// deps with true approved bases, exact product/native-reference hashes, and
// workspace ownership. No model or inferred family semantics.

export type LinkedManifestStatus = 'pending' | 'committed' | 'recovered';

export interface LinkedManifestRow {
  changeSetId: string;
  workspaceId: string;
  manifestJson: string;
  status: LinkedManifestStatus;
  commitHash: string | null;
  snapshotJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create the linked-manifest table on databases that predate the migration
 * (integration fixtures call runMigrations; direct table users converge here).
 */
export function ensureLinkedManifestTable(): void {
  const db = getDb();
  db.exec(
    `CREATE TABLE IF NOT EXISTS change_set_linked_manifests (
      change_set_id TEXT PRIMARY KEY REFERENCES change_sets(id),
      workspace_id TEXT NOT NULL REFERENCES workspace(id),
      manifest_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'recovered')),
      commit_hash TEXT,
      snapshot_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  );
  try {
    const cols = db.query('PRAGMA table_info(change_set_linked_manifests)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'snapshot_json')) {
      db.exec('ALTER TABLE change_set_linked_manifests ADD COLUMN snapshot_json TEXT;');
    }
  } catch { /* best-effort convergence; saves below stay compatible */ }
}

export function saveLinkedManifest(row: {
  changeSetId: string;
  workspaceId: string;
  manifestJson: string;
  status?: LinkedManifestStatus;
  commitHash?: string | null;
  snapshotJson?: string | null;
}): LinkedManifestRow {
  ensureLinkedManifestTable();
  const db = getDb();
  const now = new Date().toISOString();
  const hasSnapshot = row.snapshotJson !== undefined;
  db.run(
    `INSERT INTO change_set_linked_manifests
      (change_set_id, workspace_id, manifest_json, status, commit_hash, snapshot_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(change_set_id) DO UPDATE SET
      manifest_json = EXCLUDED.manifest_json,
      status = EXCLUDED.status,
      -- A pending-manifest save is the pre-mutation honesty anchor: it must
      -- clear any stale commit hash, never preserve one via COALESCE. Only
      -- committed/recovered saves carry a commit hash.
      commit_hash = CASE WHEN EXCLUDED.status = 'pending' THEN NULL ELSE COALESCE(EXCLUDED.commit_hash, change_set_linked_manifests.commit_hash) END,
      snapshot_json = ${hasSnapshot ? 'EXCLUDED.snapshot_json' : 'change_set_linked_manifests.snapshot_json'},
      updated_at = EXCLUDED.updated_at`,
    [
      row.changeSetId,
      row.workspaceId,
      row.manifestJson,
      row.status ?? 'pending',
      row.commitHash ?? null,
      hasSnapshot ? (row.snapshotJson ?? null) : null,
      now,
      now,
    ],
  );
  return findLinkedManifest(row.changeSetId)!;
}

export function findLinkedManifest(changeSetId: string): LinkedManifestRow | null {
  ensureLinkedManifestTable();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM change_set_linked_manifests WHERE change_set_id = ?',
  ).get(changeSetId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    changeSetId: String(row.change_set_id),
    workspaceId: String(row.workspace_id),
    manifestJson: String(row.manifest_json),
    status: String(row.status) as LinkedManifestStatus,
    commitHash: row.commit_hash ? String(row.commit_hash) : null,
    snapshotJson: typeof row.snapshot_json === 'string' && row.snapshot_json ? String(row.snapshot_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function markLinkedManifestCommitted(changeSetId: string, commitHash: string): void {
  ensureLinkedManifestTable();
  const db = getDb();
  db.run(
    `UPDATE change_set_linked_manifests
       SET status = 'committed', commit_hash = ?, updated_at = ?
     WHERE change_set_id = ?`,
    [commitHash, new Date().toISOString(), changeSetId],
  );
}

export function markLinkedManifestRecovered(changeSetId: string, commitHash: string): void {
  ensureLinkedManifestTable();
  const db = getDb();
  db.run(
    `UPDATE change_set_linked_manifests
       SET status = 'recovered', commit_hash = ?, updated_at = ?
     WHERE change_set_id = ?`,
    [commitHash, new Date().toISOString(), changeSetId],
  );
}

/**
 * Conflicting drafts for the whole linked group (issue #363 pre-mutation
 * gate): every draft/reviewing change set in this workspace that carries any
 * of the given SKUs, excluding the change set under review. Approved, pushed,
 * and discarded history never blocks — only open competing drafts do. One
 * invalid dep blocks the whole group.
 */
export function listConflictingDraftChangeSets(
  workspaceId: string,
  skus: string[],
  excludeChangeSetId: string,
): Array<{ changeSetId: string; sku: string; status: string }> {
  const db = getDb();
  if (skus.length === 0) return [];
  const placeholders = skus.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT csi.change_set_id AS change_set_id, csi.sku AS sku, cs.status AS status
       FROM change_set_items csi
       JOIN change_sets cs ON cs.id = csi.change_set_id
      WHERE cs.workspace_id = ? AND cs.status IN ('draft', 'reviewing')
        AND csi.sku IN (${placeholders})
        AND csi.change_set_id != ?
      ORDER BY csi.sku ASC, csi.change_set_id ASC`,
  ).all(workspaceId, ...skus, excludeChangeSetId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    changeSetId: String(row.change_set_id),
    sku: String(row.sku),
    status: String(row.status),
  }));
}
