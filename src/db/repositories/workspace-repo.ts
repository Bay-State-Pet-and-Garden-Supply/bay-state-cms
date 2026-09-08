import { getDb } from '../connection';
import type { Workspace } from '@/shared/types';

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
