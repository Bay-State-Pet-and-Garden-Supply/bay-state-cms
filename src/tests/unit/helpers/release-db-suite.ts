// Shared DB-suite lifecycle for the domain-release suites: the #198
// release guard, the #214 version-health evaluator, and the #218
// variant-identity hold.
//
// The three suites own the same fixture shape (temp bun:sqlite DB, one
// workspace batch, per-domain cleanup, profile-blocked seeds, terminal
// cohorts) — one definition here so per-ticket suites stay thin and the
// changed-code audit sees a single lifecycle instead of three clones.
// Callers own their domain constants and health setup
// (`makeDomainHealthy`); this module only owns lifecycle + seeds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../../db/connection';
import { runMigrations } from '../../../db/migrations';
import { insertWorkspace } from '../../../db/repositories/workspace-repo';
import { createBatch } from '../../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
} from '../../../db/repositories/onboarding-item-repo';
import { resetTestMatrixForTest } from '../../../onboarding/profile-test-matrix';

export interface ReleaseDbSetup {
  tempDir: string;
  batchId: string;
}

/**
 * Temp-DB lifecycle head: fresh DB + migrations + workspaces + one batch.
 * Insert workspaces in requesting-workspace order (the first id wins
 * `findWorkspace()` LIMIT 1 for route-level tests).
 */
export function setupReleaseDb(opts: {
  tmpPrefix: string;
  workspaceIds: string[];
  batch: { workspaceId: string; name: string; fileName: string; totalItems: number };
}): ReleaseDbSetup {
  try { resetDb(); } catch { /* ok */ }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix));
  initDb(path.join(tempDir, 'test.db'));
  runMigrations();
  const now = new Date().toISOString();
  for (const id of opts.workspaceIds) {
    insertWorkspace({
      id,
      name: id,
      workspacePath: `/tmp/${id}`,
      gitPath: `/tmp/${id}/.git`,
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  }
  const batchId = createBatch({
    workspaceId: opts.batch.workspaceId,
    name: opts.batch.name,
    fileName: opts.batch.fileName,
    totalItems: opts.batch.totalItems,
  }).id;
  return { tempDir, batchId };
}

/** Temp-DB lifecycle tail: close + remove the temp dir. */
export function teardownReleaseDb(tempDir: string): void {
  closeDb();
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Per-domain fixture cleanup: blocked items, variant resolutions,
 * profiles, versions, suite/waiver rows, and the in-memory matrix store.
 * Variant cleanup is best-effort (harmless for suites that never write
 * resolutions).
 *
 * Test-fixture exemption to AGENTS.md Architectural Guideline 1
 * (repository pattern): no repository exposes mass domain cleanup, and
 * adding production mass-delete methods for test teardown would widen
 * the production surface. This helper consolidates the identical
 * per-suite cleanup the three release suites previously inlined — the
 * SQL is moved, not introduced.
 */
export function cleanReleaseDomain(domain: string): void {
  const db = getDb();
  db.query(`DELETE FROM onboarding_items WHERE source_url LIKE ?`).run(`%${domain}%`);
  try {
    db.query(`DELETE FROM onboarding_variant_resolutions WHERE source_url LIKE ?`).run(`%${domain}%`);
  } catch (_e) { /* best-effort */ }
  db.query(`DELETE FROM extractor_profiles WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_active WHERE domain = ?`).run(domain);
  db.query(`DELETE FROM profile_versions WHERE domain = ?`).run(domain);
  try {
    db.query(`DELETE FROM domain_representative_suite WHERE domain = ?`).run(domain);
  } catch (_e) { /* best-effort */ }
  try {
    db.query(`DELETE FROM domain_waiver WHERE domain = ?`).run(domain);
  } catch (_e) { /* best-effort */ }
  resetTestMatrixForTest();
}

/** A blocked extraction item parked by the missing-profile error. */
export function seedProfileBlockedItem(batchId: string, upc: string, domain: string) {
  const [item] = insertItems(batchId, [
    {
      upc,
      name: `Release Product ${upc}`,
      rowNumber: 1,
      stage: 'extraction',
      stageStatus: 'failed',
      sourceUrl: `https://${domain}/products/${upc.toLowerCase()}`,
    },
  ]);
  updateItemStageStatus(item.id, 'failed', `No extractor profile for ${domain} — profile required`);
  return item;
}

export interface TerminalFixture {
  ids: string[];
  /** Stage snapshot keyed by item id (verified untouched after the act). */
  before: Map<string, { stage: string; stageStatus: string; errorMessage: string | null }>;
}

function snapshotTerminal(ids: string[]): TerminalFixture['before'] {
  return new Map(
    ids.map((id) => {
      const row = findItemById(id)!;
      return [id, { stage: row.stage, stageStatus: row.stageStatus, errorMessage: row.errorMessage }];
    }),
  );
}

/**
 * Completed/in-review/skipped cohorts that release work must never touch:
 * one completed curation item, one completed review item, one skipped
 * review item. Returns the ids plus their pre-act snapshot; the caller
 * re-snapshots after the act and expects equality.
 */
export function seedTerminalFixture(batchId: string, domain: string, upcs: [string, string, string]): TerminalFixture {
  const specs: Array<{ upc: string; stage: 'curation' | 'review'; status: 'completed' | 'skipped' }> = [
    { upc: upcs[0], stage: 'curation', status: 'completed' },
    { upc: upcs[1], stage: 'review', status: 'completed' },
    { upc: upcs[2], stage: 'review', status: 'skipped' },
  ];
  const items = insertItems(
    batchId,
    specs.map((s, i) => ({
      upc: s.upc,
      name: `Terminal ${i + 1}`,
      rowNumber: i + 1,
      stage: s.stage,
      stageStatus: 'pending',
      sourceUrl: `https://${domain}/products/${s.upc.toLowerCase()}`,
    })),
  );
  items.forEach((item, i) => {
    updateItemExtractionData(item.id, JSON.stringify({ title: 'T' }));
    updateItemStageStatus(item.id, specs[i].status);
  });
  const ids = items.map((item) => item.id);
  return { ids, before: snapshotTerminal(ids) };
}

/** Current stage snapshot for terminal ids (compare against `before`). */
export function readTerminalFixtureState(ids: string[]): TerminalFixture['before'] {
  return snapshotTerminal(ids);
}
