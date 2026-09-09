import fs from 'fs';
import path from 'path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'Bay State Store';

export function getStoreCatalogPath(): string {
  return path.resolve(process.cwd(), 'storage', 'catalog');
}

export function migrateLegacyWorkspaceIfNeeded(): string {
  const targetDir = getStoreCatalogPath();

  // Ensure target directory structure exists even for fresh installations
  ensureCatalogStructure(targetDir);

  // Initialize DB at target location & update single workspace record
  const dbPath = path.join(targetDir, '.shopsite-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  updateWorkspaceRecord(targetDir);

  return targetDir;
}

function ensureCatalogStructure(targetDir: string): void {
  const dirs = [
    targetDir,
    path.join(targetDir, 'products'),
    path.join(targetDir, 'store'),
    path.join(targetDir, 'exports'),
    path.join(targetDir, '.shopsite-cms'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function updateWorkspaceRecord(targetDir: string): void {
  const db = getDb();
  const gitPath = path.join(targetDir, '.git');
  const now = new Date().toISOString();

  const existing = db.query('SELECT id FROM workspace LIMIT 1').get() as { id: string } | undefined;
  if (existing) {
    db.run(
      `UPDATE workspace SET workspace_path = ?, git_path = ?, updated_at = ? WHERE id = ?`,
      [targetDir, gitPath, now, existing.id],
    );
    // Also ensure workspace ID in foreign key tables matches if needed
  } else {
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, targetDir, gitPath, now, now, 'not_started'],
    );
  }
  // ADR-0030 Phase 3: the PI default approved-policy seed hook was removed
  // with the Agent Lab; workspaces bootstrap without PI state.
}
