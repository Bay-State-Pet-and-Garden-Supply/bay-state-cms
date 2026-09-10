// Builder slice B2 — migration evidence (Bun; uses bun:sqlite).
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { createDistributor } from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';

beforeEach(() => {
  initDb(':memory:');
});

describe('brand strategy builder migration', () => {
  it('fresh run creates the snapshot table + marker; rerun is idempotent', () => {
    runMigrations();
    const table = getDb()
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_generation_strategy_snapshots'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('sourcing_generation_strategy_snapshots');
    const marker = getDb()
      .query("SELECT value FROM app_meta WHERE key = 'brand_strategy_builder_schema_version'")
      .get() as { value: string } | undefined;
    expect(marker?.value).toBe('1');

    // Idempotent rerun: marker stays, no duplicate objects.
    runMigrations();
    const markerAgain = getDb()
      .query("SELECT value FROM app_meta WHERE key = 'brand_strategy_builder_schema_version'")
      .get() as { value: string } | undefined;
    expect(markerAgain?.value).toBe('1');

    const fk = getDb().query('PRAGMA foreign_key_check').all() as unknown[];
    expect(fk).toEqual([]);
  });

  it('upgrade preserves preexisting approval/item/generation rows; no snapshot backfill', () => {
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: 'ws-mig', name: 'Mig WS', workspacePath: '/tmp/test-mig-ws', gitPath: '/tmp/test-mig-ws/.git',
      createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null,
    });
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    saveBrandStrategy('ws-mig', {
      brand: 'Acme',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId: 'ws-mig', name: 'Mig Batch', fileName: 'mig.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678901', name: 'Mig Item', rowNumber: 1, stage: 'sourcing' }], 'sourcing', 1);
    const generation = startSourcingGeneration(item.id, 'automatic');
    const beforeStrategies = getDb().query('SELECT * FROM brand_sourcing_strategies ORDER BY id').all();
    const beforeItems = getDb().query('SELECT * FROM onboarding_items ORDER BY id').all();
    const beforeGenerations = getDb().query('SELECT * FROM sourcing_generations ORDER BY id').all();
    expect(beforeStrategies).toHaveLength(1);

    runMigrations();

    // Preexisting rows byte-equivalent; the builder snapshot table is
    // created empty — generations are never backfilled with today's state.
    expect(getDb().query('SELECT * FROM brand_sourcing_strategies ORDER BY id').all()).toEqual(beforeStrategies);
    expect(getDb().query('SELECT * FROM onboarding_items ORDER BY id').all()).toEqual(beforeItems);
    expect(getDb().query('SELECT * FROM sourcing_generations ORDER BY id').all()).toEqual(beforeGenerations);
    expect(generation.id).toBeTruthy();
    const snapshots = getDb().query('SELECT COUNT(*) AS n FROM sourcing_generation_strategy_snapshots').get() as { n: number };
    expect(snapshots.n).toBe(0);

    // Marker set once; rerun is idempotent.
    const marker = getDb().query("SELECT value FROM app_meta WHERE key = 'brand_strategy_builder_schema_version'").get() as { value: string };
    expect(marker?.value).toBe('1');
    runMigrations();
    const markerAgain = getDb().query("SELECT value FROM app_meta WHERE key = 'brand_strategy_builder_schema_version'").get() as { value: string };
    expect(markerAgain?.value).toBe('1');
    expect(getDb().query('SELECT * FROM brand_sourcing_strategies ORDER BY id').all()).toEqual(beforeStrategies);
  });
});
