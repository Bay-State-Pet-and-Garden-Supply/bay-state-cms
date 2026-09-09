/**
 * Controlled-release routes (replaces the deleted Preflight Review modal's
 * server coverage): POST /batches/:id/start (ready_only vs all, zero-ready),
 * GET /batches/:id/missing-brand-groups, pause/resume hold preservation,
 * and cross-workspace 404s.
 * DB-backed route suite (SQLite — offline-only: the start/resume worker
 * poll settles deterministically without external calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch, findBatchById } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const wsId = 'ws-controlled-release';
const foreignWsId = 'ws-controlled-release-foreign';

let tempDir: string;

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controlled-release-routes-test-'));
  initDb(path.join(tempDir, 'test.db'));
  runMigrations();
  const now = new Date().toISOString();
  insertWorkspace({
    id: wsId,
    name: 'Test Workspace',
    workspacePath: '/tmp/ws',
    gitPath: '/tmp/ws/.git',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: 'baseline-sha',
  });
  insertWorkspace({
    id: foreignWsId,
    name: 'Foreign Workspace',
    workspacePath: '/tmp/foreign',
    gitPath: '/tmp/foreign/.git',
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'complete',
    baselineCommit: 'baseline-sha',
  });
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetActiveWorkerForTest();
});

function makeBatch(rows: Array<{ upc: string; name: string; brandHint?: string | null }>) {
  const batch = createBatch({
    workspaceId: wsId,
    name: 'Release Batch',
    fileName: 'release.csv',
    totalItems: rows.length,
    executionState: 'draft',
  });
  const items = insertItems(
    batch.id,
    rows.map((r, i) => ({ upc: r.upc, name: r.name, brandHint: r.brandHint ?? null, rowNumber: i + 1 })),
    'sourcing',
    1,
  );
  return { batch, items };
}

describe('POST /batches/:id/start controlled release', () => {
  it('ready_only releases branded items and holds unbranded ones with unresolved_brand', async () => {
    const { batch, items } = makeBatch([
      { upc: 'CR-0001', name: 'Acana Lamb 25lb', brandHint: 'ACANA' },
      { upc: 'CR-0002', name: 'Mystery Kibble 5lb' },
      { upc: 'CR-0003', name: 'Mystery Treats 2lb', brandHint: '   ' },
    ]);

    const res = await app.request(`/api/onboarding/batches/${batch.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ready_only' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.executionState).toBe('running');
    expect(findBatchById(batch.id)?.executionState).toBe('running');

    expect(findItemById(items[0].id)?.isHeld).toBe(false);
    expect(findItemById(items[1].id)?.isHeld).toBe(true);
    expect(findItemById(items[1].id)?.heldReason).toBe('unresolved_brand');
    expect(findItemById(items[2].id)?.isHeld).toBe(true);
    expect(findItemById(items[2].id)?.heldReason).toBe('unresolved_brand');
  });

  it('all releases every item including unbranded ones', async () => {
    const { batch, items } = makeBatch([
      { upc: 'CA-0001', name: 'Acana Lamb 25lb', brandHint: 'ACANA' },
      { upc: 'CA-0002', name: 'Mystery Kibble 5lb' },
    ]);

    const res = await app.request(`/api/onboarding/batches/${batch.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).executionState).toBe('running');
    expect(findItemById(items[0].id)?.isHeld).toBe(false);
    expect(findItemById(items[1].id)?.isHeld).toBe(false);
    expect(findItemById(items[1].id)?.heldReason).toBeNull();
  });

  it('zero-ready start flips to running with every item held (0 claimable)', async () => {
    const { batch, items } = makeBatch([
      { upc: 'CZ-0001', name: 'Mystery Kibble 5lb' },
      { upc: 'CZ-0002', name: 'Mystery Treats 2lb' },
    ]);

    const res = await app.request(`/api/onboarding/batches/${batch.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ready_only' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).executionState).toBe('running');
    for (const item of items) {
      expect(findItemById(item.id)?.isHeld).toBe(true);
      expect(findItemById(item.id)?.heldReason).toBe('unresolved_brand');
    }
  });

  it('pause/resume preserve release holds', async () => {
    const { batch, items } = makeBatch([
      { upc: 'CP-0001', name: 'Acana Lamb 25lb', brandHint: 'ACANA' },
      { upc: 'CP-0002', name: 'Mystery Kibble 5lb' },
    ]);
    await app.request(`/api/onboarding/batches/${batch.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ready_only' }),
    });

    const pause = await app.request(`/api/onboarding/batches/${batch.id}/pause`, { method: 'POST' });
    expect(pause.status).toBe(200);
    expect(findBatchById(batch.id)?.executionState).toBe('paused');
    expect(findItemById(items[1].id)?.isHeld).toBe(true);

    const resume = await app.request(`/api/onboarding/batches/${batch.id}/resume`, { method: 'POST' });
    expect(resume.status).toBe(200);
    expect(findBatchById(batch.id)?.executionState).toBe('running');
    expect(findItemById(items[0].id)?.isHeld).toBe(false);
    expect(findItemById(items[1].id)?.isHeld).toBe(true);
    expect(findItemById(items[1].id)?.heldReason).toBe('unresolved_brand');
  });
});

describe('GET /batches/:id/missing-brand-groups', () => {
  it('groups unbranded items with suggestions and 404s cross-workspace', async () => {
    const { batch, items } = makeBatch([
      { upc: 'CG-0001', name: 'Fromm Four-Star Duck 15lb', brandHint: 'ACANA' },
      { upc: 'CG-0002', name: 'Fromm Four-Star Salmon 15lb' },
      { upc: 'CG-0003', name: 'Fromm Four-Star Lamb 15lb' },
    ]);

    const res = await app.request(`/api/onboarding/batches/${batch.id}/missing-brand-groups`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batchId).toBe(batch.id);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].itemIds.sort()).toEqual([items[1].id, items[2].id].sort());
    expect(body.groups[0].suggestedBrand?.toLowerCase()).toBe('fromm');

    const foreignBatch = createBatch({
      workspaceId: foreignWsId,
      name: 'Foreign',
      fileName: 'f.csv',
      totalItems: 1,
      executionState: 'draft',
    });
    const foreignRes = await app.request(`/api/onboarding/batches/${foreignBatch.id}/missing-brand-groups`);
    expect(foreignRes.status).toBe(404);
  });
});

describe('controlled-release cross-workspace guards', () => {
  it('start/pause/resume/assign-brand-group fail closed (404) without mutation', async () => {
    const foreignBatch = createBatch({
      workspaceId: foreignWsId,
      name: 'Foreign',
      fileName: 'f.csv',
      totalItems: 1,
      executionState: 'draft',
    });
    const [item] = insertItems(
      foreignBatch.id,
      [{ upc: 'CF-0001', name: 'Foreign Product', brandHint: null, rowNumber: 1 }],
      'sourcing',
      1,
    );

    const start = await app.request(`/api/onboarding/batches/${foreignBatch.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ready_only' }),
    });
    expect(start.status).toBe(404);

    const pause = await app.request(`/api/onboarding/batches/${foreignBatch.id}/pause`, { method: 'POST' });
    expect(pause.status).toBe(404);

    const resume = await app.request(`/api/onboarding/batches/${foreignBatch.id}/resume`, { method: 'POST' });
    expect(resume.status).toBe(404);

    const assign = await app.request(`/api/onboarding/batches/${foreignBatch.id}/assign-brand-group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id], brand: 'Acana' }),
    });
    expect(assign.status).toBe(404);

    // No mutation leaked through the failed attempts.
    expect(findBatchById(foreignBatch.id)?.executionState).toBe('draft');
    expect(findItemById(item.id)?.brandHint).toBeNull();
  });
});
