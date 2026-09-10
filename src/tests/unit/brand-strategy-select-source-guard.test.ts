// Builder slice B2 — strategy-bound manual select-source guard (Bun; real app).
//
// The select-source handler is the manual mutation that can route a
// strategy-bound item to an unselected/unsupported official source. This
// suite proves the narrow fail-closed check at that existing boundary:
// approved official domains are admitted, non-official candidates are held
// with 409 strategy_source_not_approved, and legacy unbound rows keep their
// historical semantics (no check without an approved strategy).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertSources } from '../../db/repositories/onboarding-source-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { createDistributor } from '../../db/repositories/distributor-repo';
import app from '../../server/app';

const testDbPath = path.resolve(import.meta.dirname, 'brand-strategy-guard-test.db');
const wsId = 'ws-strategy-guard';

function seedItem(brandHint: string | null) {
  const batch = createBatch({ workspaceId: wsId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(
    batch.id,
    [{ upc: '012345678905', name: 'Guard Product', brandHint, rowNumber: 1 }],
    'sourcing',
    1,
  );
  const [official, retailer] = insertSources(item.id, [
    { url: 'https://acme.com/products/1', domain: 'acme.com', confidence: 0.9 },
    { url: 'https://retailer.example.net/p/9', domain: 'retailer.example.net', confidence: 0.8 },
  ]);
  return { item, official, retailer };
}

describe('select-source strategy guard', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Guard Workspace',
      workspacePath: '/tmp/ws-guard',
      gitPath: '/tmp/ws-guard/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    upsertBrandSite('Acana', 'acme.com');
    saveBrandStrategy(wsId, {
      brand: 'Acana',
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
      ],
      expectedRevision: 0,
    });
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(testDbPath + suffix); } catch { /* ok */ }
    }
  });

  it('admits an approved official domain for a strategy-bound item', async () => {
    const { item, official } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: official.id }),
    });
    expect(res.status).toBe(200);
  });

  it('holds a non-official candidate with 409 strategy_source_not_approved', async () => {
    const { item, retailer } = seedItem('Acana');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: retailer.id }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('strategy_source_not_approved');
  });

  it('legacy unbound rows keep historical semantics (no approved strategy, no check)', async () => {
    const { item, retailer } = seedItem('UnbrandedCo');
    const res = await app.request(`/api/onboarding/items/${item.id}/select-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: retailer.id }),
    });
    expect(res.status).toBe(200);
  });
});
