// Browser Investigation SQLite repository (T1).
//
// Workspace-scoped persistence for the investigation lifecycle. Every read
// and write is scoped by (workspace_id [, id]); foreign-workspace access
// returns null so callers reject it without leaking cross-workspace state.

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';

export interface InvestigationInsert {
  workspaceId: string;
  domain: string;
  mode: string;
  status: string;
  provider: string;
  runId: string;
  requestedModelJson: string | null;
  actualModelJson: string | null;
  inputSnapshotJson: string;
  inputHash: string;
  budgetJson: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  usageJson?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
  resultJson?: string | null;
  resultHash?: string | null;
  discardedAt?: string | null;
  discardActor?: string | null;
}

function ensureBrowserInvestigationTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_investigations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('domain_onboarding', 'drift_repair')),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'discarded')),
      provider TEXT NOT NULL,
      run_id TEXT NOT NULL,
      requested_model_json TEXT,
      actual_model_json TEXT,
      input_snapshot_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      usage_json TEXT,
      failure_code TEXT,
      failure_detail TEXT,
      result_json TEXT,
      result_hash TEXT,
      discarded_at TEXT,
      discard_actor TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_browser_inv_ws_domain_status
      ON browser_investigations(workspace_id, domain, status);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_browser_inv_ws_created
      ON browser_investigations(workspace_id, created_at);
  `);
}

interface DbRow {
  id: string;
  workspace_id: string;
  domain: string;
  mode: string;
  status: string;
  provider: string;
  run_id: string;
  requested_model_json: string | null;
  actual_model_json: string | null;
  input_snapshot_json: string;
  input_hash: string;
  budget_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  usage_json: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  result_json: string | null;
  result_hash: string | null;
  discarded_at: string | null;
  discard_actor: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToInvestigationRecord(row: DbRow): InvestigationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    mode: row.mode as InvestigationRecord['mode'],
    status: row.status as InvestigationRecord['status'],
    provider: row.provider as InvestigationRecord['provider'],
    runId: row.run_id,
    requestedModel: parseJson(row.requested_model_json, null),
    actualModel: parseJson(row.actual_model_json, null),
    inputSnapshot: parseJson(row.input_snapshot_json, {} as InvestigationRecord['inputSnapshot']),
    inputHash: row.input_hash,
    budget: parseJson(row.budget_json, {} as InvestigationRecord['budget']),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    usage: parseJson(row.usage_json, null),
    failureCode: (row.failure_code as InvestigationRecord['failureCode']) ?? null,
    failureDetail: row.failure_detail,
    result: parseJson(row.result_json, null),
    resultHash: row.result_hash,
    discardedAt: row.discarded_at,
    discardActor: row.discard_actor,
  };
}

export function insertInvestigation(row: InvestigationInsert & { id?: string }): InvestigationRecord {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const id = row.id ?? `binv_${randomUUID()}`;
  db.query(`
    INSERT INTO browser_investigations (
      id, workspace_id, domain, mode, status, provider, run_id,
      requested_model_json, actual_model_json,
      input_snapshot_json, input_hash, budget_json,
      created_at, updated_at, started_at, completed_at,
      usage_json, failure_code, failure_detail,
      result_json, result_hash, discarded_at, discard_actor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    row.workspaceId,
    row.domain,
    row.mode,
    row.status,
    row.provider,
    row.runId,
    row.requestedModelJson,
    row.actualModelJson,
    row.inputSnapshotJson,
    row.inputHash,
    row.budgetJson,
    row.createdAt,
    row.updatedAt,
    row.startedAt ?? null,
    row.completedAt ?? null,
    row.usageJson ?? null,
    row.failureCode ?? null,
    row.failureDetail ?? null,
    row.resultJson ?? null,
    row.resultHash ?? null,
    row.discardedAt ?? null,
    row.discardActor ?? null,
  );
  const found = findInvestigationById(row.workspaceId, id);
  if (!found) throw new Error('browser investigation insert failed');
  return found;
}

export function findInvestigationById(workspaceId: string, id: string): InvestigationRecord | null {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const row = db
    .query('SELECT * FROM browser_investigations WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id) as DbRow | undefined;
  return row ? rowToInvestigationRecord(row) : null;
}

/** Unscoped lookup for internal conflict checks only — never return to callers. */
export function findInvestigationByIdAnyWorkspace(id: string): { workspaceId: string } | null {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const row = db.query('SELECT workspace_id FROM browser_investigations WHERE id = ?').get(id) as
    | { workspace_id: string }
    | undefined;
  return row ? { workspaceId: row.workspace_id } : null;
}

export function listInvestigationRecords(
  workspaceId: string,
  domain?: string,
): InvestigationRecord[] {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const rows = domain
    ? (db
        .query(
          'SELECT * FROM browser_investigations WHERE workspace_id = ? AND domain = ? ORDER BY created_at DESC, id DESC',
        )
        .all(workspaceId, domain) as DbRow[])
    : (db
        .query(
          'SELECT * FROM browser_investigations WHERE workspace_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(workspaceId) as DbRow[]);
  return rows.map(rowToInvestigationRecord);
}

export function findActiveInvestigation(
  workspaceId: string,
  domain: string,
): InvestigationRecord | null {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM browser_investigations
       WHERE workspace_id = ? AND domain = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(workspaceId, domain) as DbRow | undefined;
  return row ? rowToInvestigationRecord(row) : null;
}

export interface InvestigationPatch {
  status?: string;
  actualModelJson?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  usageJson?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
  resultJson?: string | null;
  resultHash?: string | null;
  discardedAt?: string | null;
  discardActor?: string | null;
  updatedAt: string;
}

export function updateInvestigation(
  workspaceId: string,
  id: string,
  patch: InvestigationPatch,
): InvestigationRecord | null {
  ensureBrowserInvestigationTables();
  const db = getDb();
  const current = findInvestigationById(workspaceId, id);
  if (!current) return null;
  db.query(`
    UPDATE browser_investigations SET
      status = COALESCE(?, status),
      actual_model_json = COALESCE(?, actual_model_json),
      started_at = COALESCE(?, started_at),
      completed_at = COALESCE(?, completed_at),
      usage_json = COALESCE(?, usage_json),
      failure_code = COALESCE(?, failure_code),
      failure_detail = COALESCE(?, failure_detail),
      result_json = COALESCE(?, result_json),
      result_hash = COALESCE(?, result_hash),
      discarded_at = COALESCE(?, discarded_at),
      discard_actor = COALESCE(?, discard_actor),
      updated_at = ?
    WHERE workspace_id = ? AND id = ?
  `).run(
    patch.status ?? null,
    patch.actualModelJson ?? null,
    patch.startedAt ?? null,
    patch.completedAt ?? null,
    patch.usageJson ?? null,
    patch.failureCode ?? null,
    patch.failureDetail ?? null,
    patch.resultJson ?? null,
    patch.resultHash ?? null,
    patch.discardedAt ?? null,
    patch.discardActor ?? null,
    patch.updatedAt,
    workspaceId,
    id,
  );
  return findInvestigationById(workspaceId, id);
}
