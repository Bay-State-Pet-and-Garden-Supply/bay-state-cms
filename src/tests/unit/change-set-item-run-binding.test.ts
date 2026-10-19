/**
 * Backfill P0 #1 — change-set item classification run binding (TDD).
 *
 * Provenance is `classificationRunId: string | null` (nullable for
 * noncatalog drafts). Catalog upserts set the supplied run; an explicit
 * noncatalog upsert (null) clears a stale binding; omitted (legacy) leaves
 * the binding untouched on conflict and defaults NULL on fresh rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createChangeSet,
  upsertChangeSetItem,
  listChangeSetItems,
} from '../../db/repositories/change-set-repo';

const WS = 'ws-run-binding-p0-1';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WS, name: 'run-binding', workspacePath: '/tmp/run-binding', gitPath: '/tmp/run-binding/.git',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete', baselineCommit: null,
  });
});

function draft(sku: string) {
  return JSON.stringify({ sku, core: { name: `Draft ${sku}` } });
}

describe('change-set item classification run binding', () => {
  it('retains a catalog run id through read/upsert', () => {
    const cs = createChangeSet({ workspaceId: WS, title: 'catalog', description: null, baseCommit: 'c0' });
    const first = upsertChangeSetItem({
      changeSetId: cs.id, sku: 'CAT-1', operation: 'update',
      draftJson: draft('CAT-1'), baseJson: null, draftHash: 'h1',
      classificationRunId: 'run-abc',
    });
    expect(first.classificationRunId).toBe('run-abc');

    const second = upsertChangeSetItem({
      changeSetId: cs.id, sku: 'CAT-1', operation: 'update',
      draftJson: draft('CAT-1'), baseJson: null, draftHash: 'h2',
      classificationRunId: 'run-def',
    });
    expect(second.classificationRunId).toBe('run-def');

    const items = listChangeSetItems(cs.id);
    expect(items).toHaveLength(1);
    expect(items[0].classificationRunId).toBe('run-def');
  });

  it('keeps noncatalog drafts null and clears stale bindings on explicit null', () => {
    const cs = createChangeSet({ workspaceId: WS, title: 'mixed', description: null, baseCommit: 'c0' });
    const plain = upsertChangeSetItem({
      changeSetId: cs.id, sku: 'PLAIN-1', operation: 'update',
      draftJson: draft('PLAIN-1'), baseJson: null, draftHash: 'h1',
    });
    expect(plain.classificationRunId).toBeNull();

    // Stale binding from an earlier catalog draft for the same SKU.
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'STALE-1', operation: 'update',
      draftJson: draft('STALE-1'), baseJson: null, draftHash: 'h1',
      classificationRunId: 'run-old',
    });
    const cleared = upsertChangeSetItem({
      changeSetId: cs.id, sku: 'STALE-1', operation: 'update',
      draftJson: draft('STALE-1'), baseJson: null, draftHash: 'h2',
      classificationRunId: null,
    });
    expect(cleared.classificationRunId).toBeNull();
  });

  it('leaves the binding untouched when legacy callsites omit the parameter', () => {
    const cs = createChangeSet({ workspaceId: WS, title: 'legacy', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'LEG-1', operation: 'update',
      draftJson: draft('LEG-1'), baseJson: null, draftHash: 'h1',
      classificationRunId: 'run-keep',
    });
    const again = upsertChangeSetItem({
      changeSetId: cs.id, sku: 'LEG-1', operation: 'update',
      draftJson: draft('LEG-1'), baseJson: null, draftHash: 'h2',
    });
    expect(again.classificationRunId).toBe('run-keep');
  });

  it('migrates an existing database without the column (idempotent)', () => {
    getDb().exec('ALTER TABLE change_set_items DROP COLUMN classification_run_id;');
    const cols = getDb().query('PRAGMA table_info(change_set_items)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'classification_run_id')).toBe(false);

    runMigrations();
    runMigrations();
    const after = getDb().query('PRAGMA table_info(change_set_items)').all() as Array<{ name: string }>;
    expect(after.some((c) => c.name === 'classification_run_id')).toBe(true);

    // Pre-existing rows read back as null (no backfill fabrication).
    const cs = createChangeSet({ workspaceId: WS, title: 'legacy-rows', description: null, baseCommit: 'c0' });
    getDb().query(
      `INSERT INTO change_set_items
        (id, change_set_id, sku, operation, draft_json, base_json, draft_hash, validation_status, created_at, updated_at)
       VALUES ('legacy-id', ?, 'LEGACY-1', 'update', '{}', NULL, 'h', 'unknown', '2026-01-01', '2026-01-01')`,
    ).run(cs.id);
    const items = listChangeSetItems(cs.id);
    expect(items[0].classificationRunId).toBeNull();
  });
});
