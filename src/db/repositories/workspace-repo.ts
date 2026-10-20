import { getDb } from '../connection';
import type { Workspace } from '@/shared/types';

/** Minimal readonly driver surface for workspace-identity reads (#302). */
export interface ReadonlyWorkspaceDb {
  query(sql: string): {
    get(...params: unknown[]): unknown;
  };
}

/**
 * Workspace id over an explicit readonly db (independent readonly driver —
 * never initDb). Returns null when the workspace table is absent/empty.
 */
export function findWorkspaceIdReadonly(db: ReadonlyWorkspaceDb): string | null {
  try {
    const row = db.query('SELECT id FROM workspace LIMIT 1').get() as { id: unknown } | undefined;
    return row && typeof row.id === 'string' ? row.id : null;
  } catch {
    return null;
  }
}

export function findWorkspace(): Workspace | null {
  try {
    const db = getDb();
    const row = db.query('SELECT * FROM workspace LIMIT 1').get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToWorkspace(row);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Database not initialized')) {
      return null;
    }
    throw err;
  }
}

/**
 * Workspace path for one workspace id (change-set validation seam).
 * Null when the row is absent — callers fail closed, never fall back to
 * the global workspace. SQL stays inside this repository.
 */
export function findWorkspacePathById(workspaceId: string): string | null {
  try {
    const row = getDb()
      .query('SELECT workspace_path FROM workspace WHERE id = ?')
      .get(workspaceId) as { workspace_path?: unknown } | undefined;
    return typeof row?.workspace_path === 'string' ? String(row.workspace_path) : null;
  } catch {
    return null;
  }
}

export function insertWorkspace(ws: Workspace): void {
  const db = getDb();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status, baseline_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ws.id, ws.name, ws.workspacePath, ws.gitPath, ws.createdAt, ws.updatedAt, ws.bootstrapStatus, ws.baselineCommit ?? null],
  );
}

export function updateBootstrapStatus(id: string, status: string, baselineCommit?: string): void {
  const db = getDb();
  db.run(
    `UPDATE workspace SET bootstrap_status = ?, baseline_commit = COALESCE(?, baseline_commit), updated_at = ? WHERE id = ?`,
    [status, baselineCommit ?? null, new Date().toISOString(), id],
  );
}

export function updateWorkspacePaths(id: string, workspacePath: string, gitPath: string): void {
  const db = getDb();
  db.run(
    `UPDATE workspace SET workspace_path = ?, git_path = ?, updated_at = ? WHERE id = ?`,
    [workspacePath, gitPath, new Date().toISOString(), id],
  );
}

function mapRowToWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    workspacePath: String(row.workspace_path),
    gitPath: String(row.git_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    bootstrapStatus: String(row.bootstrap_status) as Workspace['bootstrapStatus'],
    baselineCommit: row.baseline_commit ? String(row.baseline_commit) : null,
  };
}
