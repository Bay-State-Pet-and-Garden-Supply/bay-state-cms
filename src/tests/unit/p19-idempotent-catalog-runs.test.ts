import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  completeRun,
  createRun,
  getRun,
  findCatalogRunByIdempotencyKey,
  claimCatalogRun,
  recoverStaleCatalogRuns,
} from '../../db/repositories/classification-run-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';

let root: string;
let workspaceId: string;

function freshDb(): void {
  workspaceId = randomUUID();
  root = fs.mkdtempSync(path.join(os.tmpdir(), `p19-${workspaceId.slice(0, 8)}`));
  fs.mkdirSync(path.join(root, '.baystate-cms'), { recursive: true });
  initDb(path.join(root, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'p19',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

describe('P2 #19 idempotent queued catalog starts + lease/claim (repo seam)', () => {
  beforeEach(() => {
    setTaxonomyFreezeForTests(false);
    freshDb();
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    closeDb();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('same idempotency key returns the same run, even after completion', () => {
    const first = createRun(workspaceId, 'SKU-KEY', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-1',
    });
    expect(first.status).toBe('queued');
    const replay = createRun(workspaceId, 'SKU-KEY', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-1',
    });
    expect(replay.id).toBe(first.id);
    completeRun(first.id, 'completed');
    const afterComplete = createRun(workspaceId, 'SKU-KEY', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-1',
    });
    expect(afterComplete.id).toBe(first.id);
  });

  it('a different key for a queued/running SKU conflicts with the active run id', () => {
    const first = createRun(workspaceId, 'SKU-ACTIVE', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-a',
    });
    let conflictRunId: string | null = null;
    try {
      createRun(workspaceId, 'SKU-ACTIVE', null, null, {
        sourceKind: 'catalog_product',
        idempotencyKey: 'key-b',
      });
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'activeRunId' in err && typeof err.activeRunId === 'string') {
        conflictRunId = err.activeRunId;
      }
    }
    expect(conflictRunId).toBe(first.id);
  });

  it('claim is atomic: second worker loses, crash recovery marks expired running failed', () => {
    const run = createRun(workspaceId, 'SKU-LEASE', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-lease',
    });
    expect(claimCatalogRun(run.id, 'worker-1', 60)).toBe(true);
    expect(claimCatalogRun(run.id, 'worker-2', 60)).toBe(false);
    // Expire the lease by backdating claimed_at, then a new claim succeeds.
    getDb().run("UPDATE classification_runs SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [run.id]);
    expect(claimCatalogRun(run.id, 'worker-2', 60)).toBe(true);
    // A stuck running lease with no heartbeat expires into failed at startup.
    getDb().run("UPDATE classification_runs SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [run.id]);
    const recovered = recoverStaleCatalogRuns(60);
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(getRun(run.id)?.status).toBe('failed');
  });

  it('completed decisions stay on the original run: no superseding second run', () => {
    const run = createRun(workspaceId, 'SKU-STABLE', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-stable',
    });
    claimCatalogRun(run.id, 'worker-1', 3600);
    completeRun(run.id, 'completed');
    const replay = createRun(workspaceId, 'SKU-STABLE', null, null, {
      sourceKind: 'catalog_product',
      idempotencyKey: 'key-stable',
    });
    expect(replay.id).toBe(run.id);
    expect(findCatalogRunByIdempotencyKey(workspaceId, 'SKU-STABLE', 'key-stable')?.id).toBe(run.id);
  });
});

describe('P2 #19 POST 202 / same-key / 409 / GET run (route seam)', () => {
  beforeEach(() => {
    setTaxonomyFreezeForTests(false);
    freshDb();
  });

  afterAll(() => {
    setTaxonomyFreezeForTests(true);
    closeDb();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function seedProduct(sku: string): void {
    const dir = path.join(root, 'products');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${sku}.json`), JSON.stringify({
      schemaVersion: 1, id: `prod-${sku}`, sku, status: 'active',
      core: {
        name: sku, price: '9.99', salePrice: null, description: null,
        taxable: true, availability: 'in stock', weight: null,
        inventory: { quantityOnHand: 1, lowStockThreshold: null, outOfStockLimit: null },
        media: { primary: null, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
        productOnPages: [],
      },
      customFields: {},
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    }));
  }

  function seedKeyedRun(sku: string, key: string, status: 'queued' | 'completed' = 'queued'): string {
    seedProduct(sku);
    const run = createRun(workspaceId, sku, null, null, { sourceKind: 'catalog_product', idempotencyKey: key });
    if (status === 'completed') completeRun(run.id, 'completed');
    return run.id;
  }

  async function postRuns(sku: string, body: unknown): Promise<Response> {
    const { default: routes } = await import('../../server/routes/catalog-classification-routes');
    const app = new Hono();
    app.route('/api', routes);
    return app.request(`/api/products/${sku}/classification/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function getRunRoute(sku: string, runId: string): Promise<Response> {
    const { default: routes } = await import('../../server/routes/catalog-classification-routes');
    const app = new Hono();
    app.route('/api', routes);
    return app.request(`/api/products/${sku}/classification/runs/${runId}`);
  }

  it('same-key POST replays the same run id (even after completion)', async () => {
    const id = seedKeyedRun('SKU-ROUTE', 'route-key-1', 'completed');
    const res = await postRuns('SKU-ROUTE', { idempotencyKey: 'route-key-1' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe(id);
    expect(getRun(id)?.status).toBe('completed');
  });

  it('different key for an active SKU throws conflict with the active run id', async () => {
    const id = seedKeyedRun('SKU-CONFLICT', 'key-one');
    const res = await postRuns('SKU-CONFLICT', { idempotencyKey: 'key-two' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { activeRunId: string };
    expect(body.activeRunId).toBe(id);
  });

  it('GET run by id returns status/review without touching latest-run state', async () => {
    const id = seedKeyedRun('SKU-GET', 'key-get', 'completed');
    const res = await getRunRoute('SKU-GET', id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; sku: string; status: string; decisions: unknown[] };
    expect(body.runId).toBe(id);
    expect(body.sku).toBe('SKU-GET');
    expect(body.status).toBe('completed');
    expect(Array.isArray(body.decisions)).toBe(true);
  });

  it('restart executes queued once: claim wins for one worker, recovery fails only expired running', () => {
    const queuedId = seedKeyedRun('SKU-RESTART', 'key-restart');
    expect(claimCatalogRun(queuedId, 'worker-a', 3600)).toBe(true);
    expect(claimCatalogRun(queuedId, 'worker-b', 3600)).toBe(false);
    expect(getRun(queuedId)?.status).toBe('running');
    // Fresh queued run with no lease survives recovery (restart re-claims it).
    const freshId = seedKeyedRun('SKU-FRESH', 'key-fresh');
    expect(recoverStaleCatalogRuns(300)).toBe(0);
    expect(getRun(freshId)?.status).toBe('queued');
  });
});
