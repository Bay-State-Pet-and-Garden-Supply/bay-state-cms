/**
 * Slice 5a — onboarding-stage-vocabulary maintenance script regression tests
 * (Bun-only, isolated temp DBs; NEVER the live DB).
 *
 * Covers the three defects proven by the live maintenance run:
 *  1. `--mode=apply` must open the target read-write (bun:sqlite rejects
 *     `{ readonly: false }` with SQLITE_MISUSE at open).
 *  2. The apply gate must read the REAL verifier manifest identity field
 *     (`sourceIdentityHash` from src/db/sqlite-backup-verifier.ts, never the
 *     never-emitted `dbIdentity`) — refusing on genuine mismatch, accepting
 *     the real shape. A real manifest is produced by `createSqliteBackup`.
 *  3. The apply path must execute the transactional seam
 *     (`runStageVocabularyMigration`: stage-only updates + version marker +
 *     maintenance receipt, atomically) — and dry-run must still write nothing.
 *
 * The script under test is spawned as a child process (`bun
 * scripts/onboarding-stage-vocabulary.ts`) against isolated temp DBs only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteBackup } from '../../db/sqlite-backup-verifier';

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'onboarding-stage-vocabulary.ts');

let dir = '';
let dbPath = '';

function seedDb(): void {
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE onboarding_items (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, upc TEXT, name TEXT,
        stage TEXT, stage_status TEXT DEFAULT 'pending', status TEXT DEFAULT 'imported',
        source_url TEXT, updated_at TEXT NOT NULL DEFAULT 'x'
      );`);
    db.query("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '2')").run();
    const ins = db.query(
      'INSERT INTO onboarding_items (id, batch_id, upc, name, stage, stage_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    ins.run('item-1', 'b1', 'upc-1', 'One', 'sourcing', 'pending', '2026-01-01T00:00:00Z');
    ins.run('item-2', 'b1', 'upc-2', 'Two', 'discovery', 'completed', '2026-01-01T00:00:00Z');
    ins.run('item-3', 'b1', 'upc-3', 'Three', 'review', 'pending', '2026-01-01T00:00:00Z');
  } finally {
    db.close();
  }
}

/** Real verifier manifest shape for the CURRENT temp DB content. */
function realManifest(): { manifestPath: string; sourceIdentityHash: string } {
  const backupPath = path.join(dir, 'app.backup.db');
  const manifest = createSqliteBackup(dbPath, backupPath);
  return { manifestPath: `${backupPath}.manifest.json`, sourceIdentityHash: manifest.sourceIdentityHash };
}

function writeProof(): string {
  const proofPath = path.join(dir, 'maintenance-proof.json');
  fs.writeFileSync(proofPath, JSON.stringify({ quiesced: true, writersStopped: true }));
  return proofPath;
}

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return { status: res.status ?? -1, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

function openReadonly(): Database {
  return new Database(dbPath, { readonly: true });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-vocab-script-'));
  dbPath = path.join(dir, 'app.db');
  seedDb();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('apply-mode DB open (defect 1)', () => {
  it('opens the target read-write: no SQLITE_MISUSE crash', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${manifestPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(`${out.stdout}\n${out.stderr}`).not.toMatch(/SQLITE_MISUSE/i);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/\"applied\":true/);
  });
});

describe('apply identity gate (defect 2)', () => {
  it('accepts the real verifier manifest shape', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${manifestPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(0);
  });

  it('refuses on tampered expected identity', () => {
    const { manifestPath } = realManifest();
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${'0'.repeat(64)}`,
      `--backup-manifest=${manifestPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/source identity mismatch/);
  });

  it('refuses on a tampered manifest identity field', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const tamperedPath = path.join(dir, 'tampered.manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    // Tamper BOTH identity fields consistently: the gate must still compare
    // against --expected-identity, not trust the manifest.
    parsed.sourceIdentityHash = 'f'.repeat(64);
    parsed.sourceIdentityHashAfter = 'f'.repeat(64);
    fs.writeFileSync(tamperedPath, JSON.stringify(parsed));
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${tamperedPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/source identity mismatch/);
  });

  it('refuses a manifest whose after-identity breaks the verifier invariant', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const tamperedPath = path.join(dir, 'invariant-broken.manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    parsed.sourceIdentityHash = 'f'.repeat(64);
    fs.writeFileSync(tamperedPath, JSON.stringify(parsed));
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${tamperedPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/refusing apply/);
  });

  it('refuses a manifest with sourceIdentityHash but no After field (both identity fields required)', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const missingAfterPath = path.join(dir, 'missing-after.manifest.json');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    delete parsed.sourceIdentityHashAfter;
    fs.writeFileSync(missingAfterPath, JSON.stringify(parsed));
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${missingAfterPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/sourceIdentityHashAfter/);
  });

  it('refuses a manifest with no identity field at all (never fail-open)', () => {
    const emptyPath = path.join(dir, 'empty.manifest.json');
    fs.writeFileSync(emptyPath, JSON.stringify({ format: 'baystate-sqlite-backup', version: 4 }));
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${'0'.repeat(64)}`,
      `--backup-manifest=${emptyPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/no source identity/);
  });
});

describe('apply executes the transactional seam (defect 3)', () => {
  it('migrates rows, sets the marker, and writes the receipt end-to-end', () => {
    const { manifestPath, sourceIdentityHash } = realManifest();
    const out = runScript([
      '--mode=apply',
      `--db=${dbPath}`,
      `--expected-identity=${sourceIdentityHash}`,
      `--backup-manifest=${manifestPath}`,
      `--maintenance-proof=${writeProof()}`,
    ]);
    expect(out.status).toBe(0);

    const db = openReadonly();
    try {
      const marker = db.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
        | { value: string }
        | undefined;
      expect(marker?.value).toBe('2');
      const stages = db.query('SELECT DISTINCT stage FROM onboarding_items ORDER BY stage').all() as Array<{
        stage: string;
      }>;
      expect(stages.map((r) => r.stage).sort()).toEqual(['find_product_page', 'review_listings', 'route_sources']);
      const leftover = db.query(
        "SELECT COUNT(*) AS c FROM onboarding_items WHERE stage IN ('sourcing','discovery','extraction','curation','review','promotion')",
      ).get() as { c: number };
      expect(leftover.c).toBe(0);
      const receipts = db.query('SELECT source_identity AS ident FROM onboarding_stage_migration_receipts').all() as Array<{
        ident: string | null;
      }>;
      expect(receipts.length).toBe(1);
      expect(receipts[0]!.ident).toBe(sourceIdentityHash);
    } finally {
      db.close();
    }
  });
});

describe('dry-run writes nothing', () => {
  it('leaves bytes, marker, stages, and receipts untouched', () => {
    const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    const out = runScript(['--mode=dry-run', `--db=${dbPath}`]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/dry-run: wrote nothing/);
    const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    expect(shaAfter).toBe(shaBefore);

    const db = openReadonly();
    try {
      const marker = db.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
        | { value: string }
        | undefined;
      expect(marker).toBeNull();
      const receiptTable = db.query(
        "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_stage_migration_receipts'",
      ).get();
      expect(receiptTable).toBeNull();
      const stages = db.query('SELECT DISTINCT stage FROM onboarding_items ORDER BY stage').all() as Array<{
        stage: string;
      }>;
      expect(stages.map((r) => r.stage).sort()).toEqual(['discovery', 'review', 'sourcing']);
    } finally {
      db.close();
    }
  });
});
