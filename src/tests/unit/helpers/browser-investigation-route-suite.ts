// Shared route-suite harness for browser investigation Bun suites.
//
// Lifecycle (T1) and policy-draft (T2) suites share the same SQLite +
// workspace + HTTP plumbing: one definition here so the suites cannot drift.
// Callers own scenario state (fake provider scenario, call accounting);
// this helper only manages DB lifecycle, workspace rows, and HTTP calls.
//
// Bun-only (SQLite + server app); imported solely by suites excluded from
// Vitest and registered in test:db.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../../db/connection';
import { runMigrations } from '../../../db/migrations';
import { insertWorkspace } from '../../../db/repositories/workspace-repo';
import app from '../../../server/app';

export async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

export async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await app.request(url);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

/**
 * Fresh temp SQLite DB with migrations plus workspace rows. The first
 * workspace is the requesting workspace for route-level tests because
 * findWorkspace() (LIMIT 1) resolves to it.
 */
export function initInvestigationDb(
  dirPrefix: string,
  workspaces: Array<{ id: string; name: string }>,
): string {
  try { resetDb(); } catch { /* ok */ }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix));
  initDb(path.join(tempDir, 'test.db'));
  runMigrations();
  const now = new Date().toISOString();
  for (const [index, ws] of workspaces.entries()) {
    const dir = index === 0 ? 'ws-main' : 'ws-foreign';
    insertWorkspace({
      id: ws.id,
      name: ws.name,
      workspacePath: path.join(tempDir, dir),
      gitPath: path.join(tempDir, dir, '.git'),
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  }
  return tempDir;
}

export function teardownInvestigationDb(tempDir: string): void {
  closeDb();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}
