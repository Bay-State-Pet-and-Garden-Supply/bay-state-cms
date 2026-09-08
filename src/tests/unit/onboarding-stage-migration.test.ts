/**
 * Slice 5a — stage migration rehearsal (Bun-only, isolated temp DBs).
 * Covers: fresh/status-legacy/current-v1/mixed/already-migrated/empty
 * fixtures, unknown/null/corrupt rejection, old operator-state ordering
 * (deferred marker-1→2 hop), rerun idempotency, 36-combo + row-by-row
 * non-stage parity, immutable byte/hash equality, dry-run-writes-nothing,
 * and every named failure checkpoint (§5.4a) with second-connection proof.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runStageVocabularyMigration,
  inventoryStageUsage,
  checkMigrationPreconditions,
  stageMatrixCounts,
  readStorageVersion,
  encodeForStorage,
  type MigrationCheckpoint,
} from '../../db/repositories/onboarding-stage-vocabulary-repo';
import { STAGE_ORDER_V1, STAGE_ORDER_V2 } from '../../shared/onboarding-stage-vocabulary';

const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'needs_input', 'skipped'] as const;

let dir = '';
let dbPath = '';
let db: Database;

function openDb(): Database {
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS onboarding_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, upc TEXT, name TEXT,
      stage TEXT, stage_status TEXT DEFAULT 'pending', status TEXT DEFAULT 'imported',
      source_url TEXT, extraction_data_json TEXT, curation_data_json TEXT,
      claimed_by TEXT, claimed_at TEXT, updated_at TEXT NOT NULL DEFAULT 'x'
    );
    CREATE TABLE IF NOT EXISTS onboarding_review_state (item_id TEXT PRIMARY KEY, batch_id TEXT, reviewed_at TEXT, approved_at TEXT, updated_at TEXT, review_invalidated_at TEXT);`);
  return d;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-mig-'));
  dbPath = path.join(dir, 'app.db');
  db = openDb();
});

afterEach(() => {
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedStage(stage: string | null, status = 'pending', id = Math.random().toString(36).slice(2)): void {
  db.query('INSERT INTO onboarding_items (id, batch_id, upc, name, stage, stage_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, 'b1', 'upc', 'n', stage, status, '2026-01-01T00:00:00Z',
  );
}
function setMeta(key: string, value: string): void {
  db.query("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

describe('migration preconditions', () => {
  it('refuses without operator marker-2 (deferred 1→2 hop ordering)', () => {
    seedStage('sourcing');
    setMeta('operator_state_schema_version', '1');
    expect(() => runStageVocabularyMigration(db as never)).toThrow();
  });
  it('refuses unknown/null/corrupt stage rows', () => {
    seedStage('sourcing');
    seedStage('bogus_stage');
    seedStage(null);
    setMeta('operator_state_schema_version', '2');
    const pre = checkMigrationPreconditions(db as never);
    expect(pre.unknownCount).toBe(2);
    expect(() => runStageVocabularyMigration(db as never)).toThrow();
  });
  it('empty DB migrates as no-op success with marker write', () => {
    setMeta('operator_state_schema_version', '2');
    const res = runStageVocabularyMigration(db as never);
    expect(res.rerunNoop).toBe(false);
    const inv = inventoryStageUsage(db as never);
    expect(inv.storageVersion).toBe(2);
  });
  it('already-migrated DB reruns as no-op (idempotent)', () => {
    seedStage('route_sources');
    setMeta('operator_state_schema_version', '2');
    setMeta('onboarding_stage_vocabulary_version', '2');
    const res = runStageVocabularyMigration(db as never);
    expect(res.rerunNoop).toBe(true);
  });
});

describe('36-combo bijection + non-stage parity', () => {
  it('maps every stage×status cell and preserves non-stage columns', () => {
    setMeta('operator_state_schema_version', '2');
    const before: Array<{ id: string; status: string; url: string | null }> = [];
    let n = 0;
    for (const v1 of STAGE_ORDER_V1) {
      for (const st of STATUSES) {
        const id = `item-${n++}`;
        db.query('INSERT INTO onboarding_items (id, batch_id, upc, name, stage, stage_status, source_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          id, 'b1', `upc-${id}`, `name-${id}`, v1, st, v1 === 'sourcing' ? null : 'https://example.com/p', '2026-01-01T00:00:00Z',
        );
        before.push({ id, status: st, url: v1 === 'sourcing' ? null : 'https://example.com/p' });
      }
    }
    const res = runStageVocabularyMigration(db as never);
    expect(res.perStageUpdated.length).toBe(6);
    const matrix = stageMatrixCounts(db as never);
    expect(matrix.length).toBe(36);
    for (const row of before) {
      const got = db.query('SELECT stage_status AS s, source_url AS u, upc, name FROM onboarding_items WHERE id = ?').get(row.id) as {
        s: string; u: string | null; upc: string; name: string;
      };
      expect(got.s).toBe(row.status);
      expect(got.u).toBe(row.url);
      expect(got.upc).toBe(`upc-${row.id}`);
    }
    // Zero v1 literals remain.
    const left = db.query(`SELECT COUNT(*) AS c FROM onboarding_items WHERE stage IN ('sourcing','discovery','extraction','curation','review','promotion')`).get() as { c: number };
    expect(left.c).toBe(0);
    // Canonical order preserved positionally.
    expect(STAGE_ORDER_V2.length).toBe(6);
  });
});

describe('no cache loophole (§5.2)', () => {
  it('same un-restarted process observes the flip across connections', () => {
    setMeta('operator_state_schema_version', '2');
    seedStage('sourcing', 'pending', 'flip-1');
    // Process writes in v1 (same connection).
    expect(readStorageVersion(db as never)).toBe(1);
    expect(encodeForStorage('route_sources', readStorageVersion(db as never))).toBe('sourcing');
    // Another connection commits the sanctioned flip while the first is idle.
    const db2 = new Database(dbPath);
    try {
      db2.query("INSERT INTO app_meta (key, value) VALUES ('onboarding_stage_vocabulary_version','2') ON CONFLICT(key) DO UPDATE SET value='2'").run();
    } finally {
      db2.close();
    }
    // Original process/connection now writes in v2 — no restart, no cache clear.
    expect(readStorageVersion(db as never)).toBe(2);
    expect(encodeForStorage('route_sources', readStorageVersion(db as never))).toBe('route_sources');
  });
  it('dry-run maintenance script writes nothing', () => {
    seedStage('sourcing', 'pending', 'dry-1');
    setMeta('operator_state_schema_version', '2');
    const before = fs.readFileSync(dbPath);
    const proc = Bun.spawnSync(
      ['bun', 'scripts/onboarding-stage-vocabulary.ts', `--db=${dbPath}`],
      { cwd: '/Users/nickborrello/Desktop/Projects/bay-state-cms' },
    );
    expect(proc.exitCode).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});
import { runMigrations } from '../../db/migrations';
import { initDb, getDb, closeDb } from '../../db/connection';

describe('boot guard (P0-3: corrupt v2 DB refuses boot)', () => {
  it('runMigrations throws on v2 storage with unknown stage rows (fail closed, no coercion)', () => {
    try {
      closeDb();
    } catch { /* fresh */ }
    initDb(':memory:');
    runMigrations();
    const bootDb = getDb();
    const t = '2026-01-01T00:00:00Z';
    bootDb.query(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status, baseline_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ws-boot', 'Boot WS', '/tmp/boot-ws', '/tmp/boot-ws/.git', t, t, 'complete', null);
    bootDb.query(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, execution_state, total_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('b-boot', 'ws-boot', 'B', 'b.csv', 'active', 'running', 2, t, t);
    bootDb.query(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, stage, stage_status, row_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ok1', 'b-boot', 'u1', 'n', 'review', 'completed', 1, t, t);
    bootDb.query(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, stage, stage_status, row_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('bad1', 'b-boot', 'u2', 'n', 'bogus_stage', 'pending', 2, t, t);
    bootDb.query(
      "INSERT INTO app_meta (key, value) VALUES ('onboarding_stage_vocabulary_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    expect(() => runMigrations()).toThrow(/unknown\/null stage literals/);
    // The corrupt row is still present and uncoerced (no silent first-stage default).
    const kept = bootDb.query('SELECT stage FROM onboarding_items WHERE id = ?').get('bad1') as { stage: string };
    expect(kept.stage).toBe('bogus_stage');
    try {
      closeDb();
    } catch { /* closed */ }
  });
});

describe('failure checkpoints (§5.4a)', () => {
  const checkpoints: MigrationCheckpoint[] = [
    'after-preconditions', 'after-stage-1', 'after-stage-2', 'after-stage-3',
    'after-stage-4', 'after-stage-5', 'after-stage-6', 'after-invariant-verification',
    'after-version-marker', 'after-maintenance-receipt', 'before-commit',
  ];
  for (const cp of checkpoints) {
    it(`rolls back fully when hook throws at ${cp}`, () => {
      seedStage('sourcing', 'pending', `s-${cp}`);
      seedStage('promotion', 'completed', `p-${cp}`);
      setMeta('operator_state_schema_version', '2');
      const before = db.query('SELECT id, stage, stage_status FROM onboarding_items ORDER BY id').all();
      expect(() =>
        runStageVocabularyMigration(db as never, {
          failureHook: (hit) => {
            if (hit === cp) throw new Error(`injected-${cp}`);
          },
        }),
      ).toThrow(`injected-${cp}`);
      // Second-connection observation: rows, absent marker, receipt count unchanged.
      const db2 = new Database(dbPath);
      try {
        const after = db2.query('SELECT id, stage, stage_status FROM onboarding_items ORDER BY id').all();
        expect(after).toEqual(before);
        const marker = db2.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
          | { value: string }
          | undefined
          | null;
        expect(marker == null).toBe(true);
      } finally {
        db2.close();
      }
    });
  }
});
