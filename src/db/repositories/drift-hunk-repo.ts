import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

export interface HunkAckRow {
  id: string;
  workspaceId: string;
  sku: string;
  field: string;
  baselineValue: string;
  remoteValue: string;
  remoteHash: string;
  baselineCommit: string;
  projectionVersion: string;
  builtInPolicyVersion: string;
  fieldCatalogVersion: string;
  pageImportHash: string;
  decision: string;
  actor: string;
  createdAt: string;
}

export interface HunkAckInput {
  workspaceId: string;
  sku: string;
  field: string;
  baselineValue: string | null;
  remoteValue: string | null;
  remoteHash: string;
  baselineCommit: string | null;
  projectionVersion: string;
  builtInPolicyVersion: string | null;
  fieldCatalogVersion: string | null;
  pageImportHash: string | null;
  decision?: string;
  actor: string;
}

function norm(s: string | null | undefined): string {
  return s ?? '';
}

/** Record an explicit rejection acknowledgement (idempotent). */
export function recordHunkAck(input: HunkAckInput): HunkAckRow {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const baselineValue = norm(input.baselineValue);
  const remoteValue = norm(input.remoteValue);
  const baselineCommit = norm(input.baselineCommit);
  const projectionVersion = input.projectionVersion;
  const builtIn = norm(input.builtInPolicyVersion);
  const catalog = norm(input.fieldCatalogVersion);
  const pageHash = norm(input.pageImportHash);
  const decision = input.decision ?? 'rejected';
  db.run(
    `INSERT OR IGNORE INTO drift_hunk_ack
      (id, workspace_id, sku, field, baseline_value, remote_value,
       remote_hash, baseline_commit,
       projection_version, built_in_policy_version, field_catalog_version,
       page_import_hash, decision, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.sku,
      input.field,
      baselineValue,
      remoteValue,
      input.remoteHash,
      baselineCommit,
      projectionVersion,
      builtIn,
      catalog,
      pageHash,
      decision,
      input.actor,
      now,
    ],
  );
  const found = findHunkAck({
    workspaceId: input.workspaceId,
    sku: input.sku,
    field: input.field,
    baselineValue,
    remoteValue,
    remoteHash: input.remoteHash,
    baselineCommit,
    projectionVersion,
    builtInPolicyVersion: builtIn,
    fieldCatalogVersion: catalog,
    pageImportHash: pageHash,
  });
  return found!;
}

export function findHunkAck(key: {
  workspaceId: string;
  sku: string;
  field: string;
  baselineValue: string;
  remoteValue: string;
  remoteHash: string;
  baselineCommit: string;
  projectionVersion: string;
  builtInPolicyVersion: string;
  fieldCatalogVersion: string;
  pageImportHash: string;
}): HunkAckRow | null {
  const db = getDb();
  let row: Record<string, unknown> | undefined;
  try {
    row = db.query(
      `SELECT * FROM drift_hunk_ack
       WHERE workspace_id = ? AND sku = ? AND field = ?
         AND baseline_value = ? AND remote_value = ?
         AND remote_hash = ? AND baseline_commit = ?
         AND projection_version = ? AND built_in_policy_version = ?
         AND field_catalog_version = ? AND page_import_hash = ?
       LIMIT 1`,
    ).get(
      key.workspaceId,
      key.sku,
      key.field,
      key.baselineValue,
      key.remoteValue,
      key.remoteHash,
      key.baselineCommit,
      key.projectionVersion,
      key.builtInPolicyVersion,
      key.fieldCatalogVersion,
      key.pageImportHash,
    ) as Record<string, unknown> | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  return mapAckRow(row);
}

/** All acknowledgements for one product in one workspace. */
export function listHunkAcksForSku(workspaceId: string, sku: string): HunkAckRow[] {
  const db = getDb();
  try {
    const rows = db.query(
      `SELECT * FROM drift_hunk_ack WHERE workspace_id = ? AND sku = ?`,
    ).all(workspaceId, sku) as Record<string, unknown>[];
    return rows.map(mapAckRow);
  } catch {
    return [];
  }
}

function mapAckRow(row: Record<string, unknown>): HunkAckRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sku: String(row.sku),
    field: String(row.field),
    baselineValue: String(row.baseline_value ?? ''),
    remoteValue: String(row.remote_value ?? ''),
    remoteHash: String(row.remote_hash),
    baselineCommit: String(row.baseline_commit ?? ''),
    projectionVersion: String(row.projection_version ?? ''),
    builtInPolicyVersion: String(row.built_in_policy_version ?? ''),
    fieldCatalogVersion: String(row.field_catalog_version ?? ''),
    pageImportHash: String(row.page_import_hash ?? ''),
    decision: String(row.decision ?? 'rejected'),
    actor: String(row.actor ?? ''),
    createdAt: String(row.created_at ?? ''),
  };
}
