// fallow-ignore-file unused-export

/**
 * Page import persistence.
 *
 * `page_imports` is the audit + authority seam for verified Page identity.
 * Import PREVIEW has no DB effect — only `activatePageImport` writes, and it
 * does so atomically: supersede the prior active import, insert the new active
 * import with canonical records JSON, upsert `page_index` rows while
 * preserving local row IDs by verified identity key, then mark rows tied to
 * the superseded import unavailable.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { canonicalJsonStringify } from '../../shared/stable-id';
import type { PageImport, PageRecord, PageImportCounts } from '../../shared/schemas/page';
import { PageImportSchema, PageRecordSchema } from '../../shared/schemas/page';

const now = () => new Date().toISOString();

export function mapImportRow(row: Record<string, any>): PageImport {
  return PageImportSchema.parse({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceHash: String(row.source_hash),
    parserFormatVersion: String(row.parser_format_version),
    status: String(row.status),
    counts: JSON.parse(row.counts_json ?? '{"total":0,"verified":0,"nameOnly":0,"withParent":0}'),
    createdAt: String(row.created_at),
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    activatedBy: row.activated_by ? String(row.activated_by) : null,
  });
}

/**
 * Minimal readonly driver surface for verified-Page snapshot reads (#302).
 * Accepts the global Database or an independent readonly driver — never
 * initDb, never writes.
 */
export interface ReadonlySnapshotDb {
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}

export interface VerifiedPageIndexRow {
  id: string;
  name: string;
  parent_id: string | null;
  source_hash: string | null;
  identity_kind: string;
  identity_key: string;
  availability: string;
}

/** Active page-import row for a workspace over an explicit readonly db. */
export function getActivePageImportRow(
  db: ReadonlySnapshotDb,
  workspaceId: string,
): Record<string, unknown> | undefined {
  return db.query(
    "SELECT * FROM page_imports WHERE workspace_id = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1",
  ).get(workspaceId) as Record<string, unknown> | undefined;
}

/** Verified page_index rows of one import over an explicit readonly db. */
export function listVerifiedPageIndexRows(
  db: ReadonlySnapshotDb,
  workspaceId: string,
  importId: string,
): VerifiedPageIndexRow[] {
  return db.query(
    `SELECT id, name, parent_id, source_hash, identity_kind, identity_key, availability
     FROM page_index
     WHERE workspace_id = ? AND import_id = ? AND identity_status = 'verified'`,
  ).all(workspaceId, importId) as VerifiedPageIndexRow[];
}

/** The currently active verified import for a workspace, or null. */
export function getActivePageImport(workspaceId: string): PageImport | null {
  const db = getDb();
  const row = db.query(
    "SELECT * FROM page_imports WHERE workspace_id = ? AND status = 'active' ORDER BY activated_at DESC LIMIT 1",
  ).get(workspaceId) as Record<string, any> | undefined;
  return row ? mapImportRow(row) : null;
}

/** Full import history for a workspace (oldest first). */
export function listPageImports(workspaceId: string): PageImport[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM page_imports WHERE workspace_id = ? ORDER BY created_at ASC',
  ).all(workspaceId) as Record<string, any>[];
  return rows.map(mapImportRow);
}

/** Canonical records of the active verified import, re-validated. */
export function getActiveImportRecords(workspaceId: string): PageRecord[] {
  const active = getActivePageImport(workspaceId);
  if (!active) return [];
  const row = getDb().query('SELECT records_json FROM page_imports WHERE id = ?').get(active.id) as
    | { records_json: string }
    | undefined;
  if (!row) return [];
  const parsed = JSON.parse(row.records_json) as unknown;
  const result = PageRecordSchema.array().safeParse(parsed);
  return result.success ? result.data : [];
}

/** Deterministic counts over a record batch. */
export function computePageImportCounts(records: PageRecord[]): PageImportCounts {
  return {
    total: records.length,
    verified: records.filter(r => r.identity.status === 'verified').length,
    nameOnly: records.filter(r => r.identity.kind === 'unverified_name_only').length,
    withParent: records.filter(r => r.parentRef !== null && r.parentRef.length > 0).length,
  };
}

/**
 * Atomically activate a verified Page import. Single transaction:
 *
 * 1. supersede the prior active import (if any);
 * 2. insert the new active import row with canonical records JSON;
 * 3. upsert page_index rows, preserving local row IDs by verified identity
 *    key (a name is never an identity key — duplicate names are allowed);
 * 4. mark rows tied to the superseded import unavailable.
 */
export function activatePageImport(params: {
  workspaceId: string;
  sourceHash: string;
  parserFormatVersion: string;
  records: PageRecord[];
  activatedBy?: string | null;
}): PageImport {
  const db = getDb();
  const id = randomUUID();
  const timestamp = now();
  const counts = computePageImportCounts(params.records);
  const recordsJson = canonicalJsonStringify(params.records);

  db.transaction(() => {
    // 1. Supersede prior active import.
    db.run(
      "UPDATE page_imports SET status = 'superseded', superseded_at = ? WHERE workspace_id = ? AND status = 'active'",
      [timestamp, params.workspaceId],
    );

    // 2. Insert the new active import.
    db.run(
      `INSERT INTO page_imports
       (id, workspace_id, source_hash, parser_format_version, status, counts_json, records_json, created_at, activated_at, superseded_at, activated_by)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, ?)`,
      [
        id,
        params.workspaceId,
        params.sourceHash,
        params.parserFormatVersion,
        canonicalJsonStringify(counts),
        recordsJson,
        timestamp,
        timestamp,
        params.activatedBy ?? null,
      ],
    );

    // 3. Preserve local row IDs by verified identity key, then upsert rows.
    const rowIds = new Map<string, string>();
    for (const record of params.records) {
      const existing = db.query(
        `SELECT id FROM page_index
         WHERE workspace_id = ? AND identity_kind = ? AND identity_key = ?
         ORDER BY rowid ASC LIMIT 1`,
      ).get(params.workspaceId, record.identity.kind, record.identity.key) as { id: string } | undefined;
      rowIds.set(record.identity.key, existing?.id ?? randomUUID());
    }

    for (const record of params.records) {
      const rowId = rowIds.get(record.identity.key)!;
      const parentId = record.parentRef ? (rowIds.get(record.parentRef) ?? null) : null;
      const fileName = record.identity.kind === 'exported_file_name' ? record.identity.key : null;
      db.run(
        `INSERT INTO page_index
         (id, name, file_name, parent_id, page_hash, workspace_id, import_id, identity_kind, identity_key, identity_status, source_hash, availability, review_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, 'imported', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = EXCLUDED.name,
           file_name = EXCLUDED.file_name,
           parent_id = EXCLUDED.parent_id,
           page_hash = EXCLUDED.page_hash,
           workspace_id = EXCLUDED.workspace_id,
           import_id = EXCLUDED.import_id,
           identity_kind = EXCLUDED.identity_kind,
           identity_key = EXCLUDED.identity_key,
           identity_status = 'verified',
           source_hash = EXCLUDED.source_hash,
           availability = EXCLUDED.availability,
           review_status = 'imported',
           updated_at = EXCLUDED.updated_at`,
        [
          rowId,
          record.name,
          fileName,
          parentId,
          params.sourceHash,
          params.workspaceId,
          id,
          record.identity.kind,
          record.identity.key,
          params.sourceHash,
          record.availability,
          timestamp,
          timestamp,
        ],
      );
    }

    // 4. Rows tied to the superseded import are no longer live options.
    db.run(
      `UPDATE page_index SET availability = 'unavailable', updated_at = ?
       WHERE workspace_id = ? AND import_id IS NOT NULL AND import_id != ? AND identity_status = 'verified'`,
      [timestamp, params.workspaceId, id],
    );
  })();

  const row = db.query('SELECT * FROM page_imports WHERE id = ?').get(id) as Record<string, any>;
  return mapImportRow(row);
}
