/**
 * Brave→Serper credential migration guarantees.
 *
 * A Brave-issued secret must never become a Serper credential: the migration
 * drops the retired `brave_search` row instead of relabeling it, fabricates
 * no `serper_search` row, and repeated startups cannot resurrect a removed key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { deleteApiKey, getApiKey, upsertApiKey } from '../../db/repositories/api-key-repo';

let tempDir: string;

function services(): string[] {
  return (getDb().query('SELECT service FROM api_keys').all() as Array<{ service: string }>)
    .map((row) => row.service);
}

describe('Brave to Serper credential migration', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'serper-migration-'));
    initDb(path.join(tempDir, 'fixture.sqlite'));
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('drops the retired Brave row without fabricating a Serper credential', () => {
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    expect(services()).not.toContain('brave_search');
    expect(getApiKey('serper_search')).toBeFalsy();
  });

  it('leaves an operator-supplied Serper key untouched and still drops Brave', () => {
    upsertApiKey('serper_search', 'real-serper-key');
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    expect(getApiKey('serper_search')?.api_key).toBe('real-serper-key');
    expect(services()).not.toContain('brave_search');
  });

  it('cannot resurrect a Serper key the operator removed', () => {
    upsertApiKey('brave_search', 'brave-issued-secret');
    runMigrations();
    upsertApiKey('serper_search', 'real-serper-key');
    deleteApiKey('serper_search');
    runMigrations();
    expect(getApiKey('serper_search')).toBeFalsy();
    expect(services()).not.toContain('brave_search');
  });
});

describe('Brave to Serper ledger rebuild', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'serper-ledger-'));
    initDb(path.join(tempDir, 'fixture.sqlite'));
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rebuilds an old-CHECK ledger atomically with historic rows preserved', () => {
    const db = getDb();
    // Simulate a pre-cutover database: old CHECK without serper_search,
    // one settled brave_search reservation holding real accounting.
    db.exec(`DROP TABLE item_acquisition_budget_reservations`);
    db.exec(`
      CREATE TABLE item_acquisition_budget_reservations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('model', 'brave_search', 'browser')),
        policy_hash TEXT NOT NULL,
        pricing_hash TEXT NOT NULL,
        reserved_resources_json TEXT NOT NULL,
        actual_resources_json TEXT,
        cost_micros INTEGER,
        actual_cost_micros INTEGER,
        billing_status TEXT NOT NULL CHECK (billing_status IN ('pending', 'known', 'unknown', 'not_applicable')),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'dispatched', 'settled', 'released')),
        release_reason TEXT,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        settled_at TEXT,
        CHECK (workspace_id <> '' AND batch_id <> '' AND item_id <> '')
      );
    `);
    const resources = JSON.stringify({
      attempts: 1, pages: 0, actions: 0, redirects: 0,
      bytes: 1024, artifacts: 0, durationMs: 1500, inputTokens: 0, outputTokens: 0,
    });
    db.query(`
      INSERT INTO item_acquisition_budget_reservations
        (id, workspace_id, batch_id, item_id, run_id, provider, model, kind,
         policy_hash, pricing_hash, reserved_resources_json, cost_micros,
         billing_status, status, created_at)
      VALUES ('hist-1', 'ws', 'batch-1', 'item-1', 'run-1', 'brave_search', 'web',
        'brave_search', 'ph', 'prh', ?, 50, 'known', 'settled', '2026-01-01T00:00:00.000Z')
    `).run(resources);
    runMigrations();
    const ddl = db.query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'item_acquisition_budget_reservations'`,
    ).get() as { sql: string };
    expect(ddl.sql).toContain('serper_search');
    const row = db.query(`SELECT * FROM item_acquisition_budget_reservations WHERE id = 'hist-1'`).get() as Record<string, unknown> | undefined;
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('brave_search');
    expect(row?.cost_micros).toBe(50);
    expect(db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'item_acquisition_budget_reservations%'`).all()).toHaveLength(1);
  });
});
