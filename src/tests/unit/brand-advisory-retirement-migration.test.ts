// Issue #150 (Amendment B1.1) — brand advisory retirement migration evidence.
//
// Bun suite (bun:sqlite; registered in test:db, excluded from Vitest).
// Proves fresh/upgrade/idempotence/fail-closed behavior against temporary
// DBs only: the advisory table disappears, historical snapshot rows keep
// their exact meaning, protected tables are untouched, and unexpected
// states fail closed without claiming success. No live migration runs here.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { createDistributor } from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { getGenerationStrategyBinding } from '../../db/repositories/brand-strategy-generation-repo';

const WS = 'ws-retirement-test';

function tableNames(): string[] {
  return (getDb().query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
}

function snapshotSql(): string | null {
  const row = getDb().query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_generation_strategy_snapshots'").get() as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? null;
}

function dumpAll(table: string): string {
  return JSON.stringify(getDb().query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** Rebuild the genuine pre-retirement state on top of a migrated DB. */
function simulatePreRetirement(): void {
  const db = getDb();
  db.exec("DELETE FROM app_meta WHERE key = 'brand_advisory_retirement_schema_version'");
  // Snapshots back to the legacy CHECK/default (genuine old definition).
  db.exec('DROP TABLE IF EXISTS sourcing_generation_strategy_snapshots');
  const builderSql = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../db/brand-strategy-builder-migration.sql'),
    'utf-8',
  );
  db.exec(builderSql);
  // Legacy advisory table (genuine columns from distributor-v2).
  db.exec(`CREATE TABLE IF NOT EXISTS brand_advisory_profiles (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(id),
    brand TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
    sourcing_policy TEXT NOT NULL DEFAULT 'advisory',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, brand)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_brand_advisory_profiles_workspace ON brand_advisory_profiles(workspace_id)');
}

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WS,
    name: 'Retirement WS',
    workspacePath: '/tmp/test-retirement-ws',
    gitPath: '/tmp/test-retirement-ws/.git',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

describe('brand advisory retirement migration', () => {
  it('fresh migration ends retired: no advisory table, query-all-capable snapshots, marker set', () => {
    expect(tableNames()).not.toContain('brand_advisory_profiles');
    const sql = snapshotSql();
    expect(sql).toContain('query_all');
    expect(sql).toContain('legacy_advisory');
    expect(sql).toContain('strategy-binding-v2');
    const marker = getDb().query("SELECT value FROM app_meta WHERE key = 'brand_advisory_retirement_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
    const indexes = (getDb().query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sourcing_generation_strategy_snapshots'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain('idx_gen_strategy_snapshots_item');
    expect(indexes).toContain('idx_gen_strategy_snapshots_workspace');
    expect(getDb().query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rerun with the final marker verifies schema and performs no row writes', () => {
    const beforeSql = snapshotSql();
    const beforeSnapshots = dumpAll('sourcing_generation_strategy_snapshots');
    runMigrations();
    expect(snapshotSql()).toBe(beforeSql);
    expect(dumpAll('sourcing_generation_strategy_snapshots')).toBe(beforeSnapshots);
    const marker = getDb().query("SELECT value FROM app_meta WHERE key = 'brand_advisory_retirement_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
    expect(getDb().query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('upgrade preserves rows, drops only the advisory table, and creates no strategy/mapping/snapshot rows', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    createDistributor({ id: 'dist_bci', name: 'BCI' });
    // Mapping-only brand, approval-only distributor brand.
    upsertBrandSite('Mapping Only', 'mapped-only.example.com');
    saveBrandStrategy(WS, {
      brand: 'Approval Only',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId: WS, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Legacy Food', brandHint: 'Legacy', rowNumber: 1 }], 'sourcing', 1);
    const genApproved = startSourcingGeneration(item.id, 'automatic');

    simulatePreRetirement();
    const db = getDb();
    const now = new Date().toISOString();
    // All three old policies, a profile-only brand, and v1 snapshots with
    // inert preference bytes.
    const profiles: Array<[string, string, string, string]> = [
      ['bp1', 'Legacy', '[]', '["dist_phillips"]'],
      ['bp2', 'Preferred Only Brand', '["po alias"]', '["dist_phillips"]'],
      ['bp3', 'Fallback Brand', '[]', '[]'],
    ];
    const policies = ['advisory', 'preferred_only', 'preferred_then_fallback'];
    profiles.forEach(([id, brand, aliases, preferred], i) => {
      db.query(`INSERT INTO brand_advisory_profiles
        (id, workspace_id, brand, aliases_json, preferred_distributor_ids_json, sourcing_policy, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, WS, brand, aliases, preferred, policies[i], now, now);
    });
    db.query(`INSERT INTO sourcing_generation_strategy_snapshots
      (sourcing_generation_id, workspace_id, item_id, mode, strategy_revision, normalized_brand,
       sources_json, preferred_distributor_ids_json, binding_version, captured_at, created_at)
      VALUES (?, ?, ?, 'approved', 1, 'approval only', '[{"kind":"distributor_record","distributorId":"dist_phillips"}]', '["dist_phillips"]', 'strategy-binding-v1', ?, ?)`)
      .run(genApproved.id, WS, item.id, now, now);
    const genLegacy = startSourcingGeneration(item.id, 'operator_retry');
    db.query(`INSERT INTO sourcing_generation_strategy_snapshots
      (sourcing_generation_id, workspace_id, item_id, mode, strategy_revision, normalized_brand,
       sources_json, preferred_distributor_ids_json, binding_version, captured_at, created_at)
      VALUES (?, ?, ?, 'legacy_advisory', NULL, NULL, '[]', '["dist_phillips"]', 'strategy-binding-v1', ?, ?)`)
      .run(genLegacy.id, WS, item.id, now, now);

    const beforeSnapshots = dumpAll('sourcing_generation_strategy_snapshots');
    const beforeStrategies = dumpAll('brand_sourcing_strategies');
    const beforeSites = dumpAll('brand_sites');
    const beforeDistributors = dumpAll('distributors');

    runMigrations();

    // Only the profile table is gone; historical rows keep exact meaning.
    expect(tableNames()).not.toContain('brand_advisory_profiles');
    expect(dumpAll('sourcing_generation_strategy_snapshots')).toBe(beforeSnapshots);
    expect(dumpAll('brand_sourcing_strategies')).toBe(beforeStrategies);
    expect(dumpAll('brand_sites')).toBe(beforeSites);
    expect(dumpAll('distributors')).toBe(beforeDistributors);
    // No manufactured approvals, mappings, or snapshot rows.
    expect((getDb().query('SELECT COUNT(*) AS n FROM sourcing_generation_strategy_snapshots').get() as { n: number }).n).toBe(2);
    const marker = getDb().query("SELECT value FROM app_meta WHERE key = 'brand_advisory_retirement_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
    expect(getDb().query('PRAGMA foreign_key_check').all()).toEqual([]);

    // Old pins retain exact meaning: approved executes, legacy parks.
    expect(getGenerationStrategyBinding(genApproved.id)).toMatchObject({ version: 'strategy-binding-v1', mode: 'approved', strategyRevision: 1 });
    expect(getGenerationStrategyBinding(genLegacy.id)).toMatchObject({ version: 'strategy-binding-v1', mode: 'legacy_advisory' });
  });

  it('legacy batch-preflight dependency completes before the drop; selective markers never resurrect the table', () => {
    // Simulate an older DB missing only the batch marker: the guarded
    // advisory-column substep must not ALTER a retired (absent) table.
    getDb().exec("DELETE FROM app_meta WHERE key = 'batch_preflight_schema_version'");
    expect(() => runMigrations()).not.toThrow();
    expect(tableNames()).not.toContain('brand_advisory_profiles');
    const batch = getDb().query("SELECT value FROM app_meta WHERE key = 'batch_preflight_schema_version'").get() as { value: string };
    expect(batch.value).toBe('1');
  });

  it('unexpected resurrection or schema drift with a completed marker fails closed', () => {
    // Advisory table reappears despite a completed marker: refuse boot,
    // never silently use or delete the unexpected data.
    const now = new Date().toISOString();
    getDb().exec(`CREATE TABLE brand_advisory_profiles (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, brand TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]', preferred_distributor_ids_json TEXT NOT NULL DEFAULT '[]',
      sourcing_policy TEXT NOT NULL DEFAULT 'advisory', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, brand))`);
    getDb().query(`INSERT INTO brand_advisory_profiles
      (id, workspace_id, brand, aliases_json, preferred_distributor_ids_json, sourcing_policy, created_at, updated_at)
      VALUES ('bp-x', ?, 'Ghost', '[]', '[]', 'advisory', ?, ?)`)
      .run(WS, now, now);
    expect(() => runMigrations()).toThrow(/reappeared after retirement/);
    // The unexpected data is preserved for the owner-approved recovery plan.
    expect(tableNames()).toContain('brand_advisory_profiles');
  });
});
