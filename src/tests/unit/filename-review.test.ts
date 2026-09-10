/**
 * Unit tests for the Review filename preview + warnings module (issue #109).
 *
 * Runs under `bun test` (NOT vitest): history decisions, batch items, and
 * the product index are DB-backed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { listVerifiedPageOptions, assignProductToPageId } from '../../db/repositories/page-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { markReviewed, getReviewState } from '../../db/repositories/onboarding-review-repo';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import { writeProductFile } from '../../git/workspace-files';
import type { Product } from '../../shared/types';
import {
  computeBatchFilenamePreview,
  recordFilenameDecision,
  getFilenameAcceptance,
  filenameGateReason,
} from '../../onboarding/filename-review';

const TEST_DB = path.resolve(import.meta.dirname, 'filename-review-test.db');
const WS_DIR = path.resolve(import.meta.dirname, 'filename-review-workspace');
const WS_ID = 'ws-filename-review';

function makeProduct(sku: string, name: string, fileName: string | null): Product {
  const customFields: Record<string, string> = { ProductField16: 'Test Brand' };
  if (fileName) customFields['FileName'] = fileName;
  return {
    schemaVersion: 1,
    id: `id-${sku}`,
    sku,
    status: 'active',
    core: {
      name,
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: null,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields,
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
  };
}

function seedCatalogProduct(sku: string, name: string, fileName: string | null) {
  const now = new Date().toISOString();
  writeProductFile(WS_DIR, makeProduct(sku, name, fileName));
  insertProductIndex({
    id: `idx-${sku}`, sku, filePath: `products/${sku}.json`, title: name, status: 'active',
    price: '9.99', inventoryQuantity: null, primaryImage: null, productHash: `h-${sku}`,
    lastApprovedCommit: null, lastPulledRemoteHash: null, lastSyncedRemoteHash: null, lastSyncedAt: null,
    syncStatus: 'not_synced', hasAdvancedBlocks: 0, hasWarnings: 0, createdAt: now, updatedAt: now,
    description: null, searchKeywords: null, customFields: {},
  });
}

function seedItem(batchId: string, upc: string, title: string) {
  const [item] = insertItems(batchId, [{ upc, name: title, price: '$9.99', brandHint: 'Test Brand', rowNumber: 1 }]);
  getDb().query(
    `UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'review', stage_status = 'pending', status = 'ready' WHERE id = ?`,
  ).run(
    JSON.stringify({ title, seoFileName: null, primaryImage: 'http://img.example/p.jpg' }),
    JSON.stringify({ curatedTitle: title, suggestedPages: ['Pets'] }),
    item.id,
  );
  const page = listVerifiedPageOptions(WS_ID).find(p => p.name === 'Pets');
  if (page) assignProductToPageId(upc, page.id, 'Pets');
  return item;
}

function makeApi(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  app.route('/api', onboardingWorkRoutes);
  return app;
}

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(TEST_DB);
  runMigrations();
  try { mkdirSync(WS_DIR, { recursive: true }); } catch { /* ok */ }
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [WS_ID, 'Filename Review WS', WS_DIR, path.join(WS_DIR, '.git'), now, now, 'complete'],
  );
  activatePageImportFromRecords({
    workspaceId: WS_ID,
    sourceHash: createHash('sha256').update('filename-review-pets').digest('hex'),
    parserFormatVersion: 'pages-xml-1',
    records: [{
      identity: { kind: 'exported_guid' as const, key: 'guid-pets', status: 'verified' as const },
      name: 'Pets',
      parentRef: null,
      availability: 'available' as const,
    }],
    activatedBy: 'test',
  });
});

afterAll(() => {
  closeDb();
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { rmSync(WS_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('computeBatchFilenamePreview (issue #109)', () => {
  it('shows the computed file name for every draft; clean batches warn nothing', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'clean', fileName: 'c.csv', totalItems: 2 });
    seedItem(batch.id, `CLEAN-A-${randomUUID().slice(0, 6)}`, 'Alpha Product');
    seedItem(batch.id, `CLEAN-B-${randomUUID().slice(0, 6)}`, 'Beta Product');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    expect(preview).toHaveLength(2);
    expect(preview.map(p => p.fileName).sort()).toEqual(['alpha-product.html', 'beta-product.html']);
    expect(preview.flatMap(p => p.warnings)).toEqual([]);
  });

  it('batch-internal base collisions warn naming the conflicting drafts', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'dup', fileName: 'd.csv', totalItems: 2 });
    const a = seedItem(batch.id, `DUP-A-${randomUUID().slice(0, 6)}`, 'Identical Product Name');
    const b = seedItem(batch.id, `DUP-B-${randomUUID().slice(0, 6)}`, 'Identical Product Name!');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    expect(preview).toHaveLength(2);
    // Assigned names stay distinct (promotion uniquifies)…
    const names = preview.map(p => p.fileName);
    expect(new Set(names).size).toBe(2);
    // …but both items warn, each naming the other draft.
    for (const entry of preview) {
      expect(entry.warnings).toHaveLength(1);
      expect(entry.warnings[0].code).toBe('filename_collision_batch');
      expect(entry.warnings[0].fileName).toBe('identical-product-name.html');
    }
    const byUpc = new Map(preview.map(p => [p.upc, p]));
    expect(byUpc.get(a.upc)!.warnings[0].conflictingUpcs).toEqual([b.upc]);
    expect(byUpc.get(a.upc)!.warnings[0].conflictingTitles).toEqual(['Identical Product Name!']);
    expect(byUpc.get(b.upc)!.warnings[0].conflictingUpcs).toEqual([a.upc]);
  });

  it('live-catalog collisions warn identifying the catalog SKU and title', () => {
    const catSku = `CAT-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(catSku, 'Catalog Widget', 'catalog-widget.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'cat', fileName: 'cat.csv', totalItems: 1 });
    seedItem(batch.id, `NEW-${randomUUID().slice(0, 6)}`, 'Catalog Widget');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    expect(preview).toHaveLength(1);
    expect(preview[0].warnings).toHaveLength(1);
    expect(preview[0].warnings[0].code).toBe('filename_collision_catalog');
    expect(preview[0].warnings[0].catalogSku).toBe(catSku);
    expect(preview[0].warnings[0].catalogTitle).toBe('Catalog Widget');
  });

  it('same-UPC catalog entries are the same product, not a collision', () => {
    const upc = `SELF-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(upc, 'Self Product', 'self-product.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'self', fileName: 's.csv', totalItems: 1 });
    seedItem(batch.id, upc, 'Self Product');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    expect(preview).toHaveLength(1);
    // Kept live name, no warnings.
    expect(preview[0].fileName).toBe('self-product.html');
    expect(preview[0].warnings).toEqual([]);
  });

  it('batch warning message is batch-scoped: partial promotions may renumber', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'scope', fileName: 'sc.csv', totalItems: 2 });
    seedItem(batch.id, `SC-A-${randomUUID().slice(0, 6)}`, 'Scoped Product Name');
    seedItem(batch.id, `SC-B-${randomUUID().slice(0, 6)}`, 'Scoped Product Name');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    for (const entry of preview) {
      expect(entry.warnings).toHaveLength(1);
      // The displayed suffix is batch-scoped: promotion over a subset may
      // renumber, so the message must not promise the exact persisted name.
      expect(entry.warnings[0].message).toContain('full-batch promotion');
      expect(entry.warnings[0].message).toContain('partial promotions may renumber');
    }
  });
});

describe('filename decisions + gate (issue #109)', () => {
  it('unresolved warnings block; accept records history and clears batch warnings', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'gate', fileName: 'g.csv', totalItems: 2 });
    const a = seedItem(batch.id, `GATE-A-${randomUUID().slice(0, 6)}`, 'Gated Product Name');
    seedItem(batch.id, `GATE-B-${randomUUID().slice(0, 6)}`, 'Gated Product Name');
    const items = listItemsByBatch(batch.id);
    const preview = computeBatchFilenamePreview(WS_DIR, items);
    const entryA = preview.find(p => p.upc === a.upc)!;
    expect(entryA.warnings).toHaveLength(1);

    expect(filenameGateReason(entryA, WS_ID, batch.id)).toMatch(/^filename_warning_unresolved/);

    recordFilenameDecision(WS_ID, a.upc, batch.id, 'accept', 'gated-product-name.html', 'tester');
    expect(getFilenameAcceptance(WS_ID, a.upc, batch.id, 'gated-product-name.html')).toBe(true);
    expect(filenameGateReason(entryA, WS_ID, batch.id)).toBeNull();
  });

  it('accept is scoped to the accepted base name; real retitles re-warn', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'stale', fileName: 's.csv', totalItems: 3 });
    const a = seedItem(batch.id, `STALE-A-${randomUUID().slice(0, 6)}`, 'Stale Name');
    seedItem(batch.id, `STALE-B-${randomUUID().slice(0, 6)}`, 'Stale Name');
    seedItem(batch.id, `STALE-C-${randomUUID().slice(0, 6)}`, 'Other Name');
    recordFilenameDecision(WS_ID, a.upc, batch.id, 'accept', 'stale-name.html', 'tester');
    // Real retitle: operator renames A so it now collides with C instead.
    const db = getDb();
    const row = db.query(`SELECT extraction_data_json, curation_data_json FROM onboarding_items WHERE id = ?`).get(a.id) as {
      extraction_data_json: string; curation_data_json: string;
    };
    const ext = JSON.parse(row.extraction_data_json);
    const cur = JSON.parse(row.curation_data_json);
    ext.title = 'Other Name';
    cur.curatedTitle = 'Other Name';
    db.query(`UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ? WHERE id = ?`).run(
      JSON.stringify(ext),
      JSON.stringify(cur),
      a.id,
    );
    // Recompute from the renamed state: A warns on the NEW base and the
    // stale alpha accept does not suppress it.
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    const entryA = preview.find(p => p.upc === a.upc)!;
    expect(entryA.baseFileName).toBe('other-name.html');
    expect(entryA.warnings.some(w => w.code === 'filename_collision_batch')).toBe(true);
    expect(getFilenameAcceptance(WS_ID, a.upc, batch.id, 'other-name.html')).toBe(false);
    expect(filenameGateReason(entryA, WS_ID, batch.id)).toMatch(/^filename_warning_unresolved/);
  });

  it('catalog warnings stay blocked even with an accept recorded', () => {
    const catSku = `CATB-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(catSku, 'Blocked Widget', 'blocked-widget.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'catblock', fileName: 'cb.csv', totalItems: 1 });
    const a = seedItem(batch.id, `CB-${randomUUID().slice(0, 6)}`, 'Blocked Widget');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    const entry = preview[0];
    expect(entry.warnings.some(w => w.code === 'filename_collision_catalog')).toBe(true);
    recordFilenameDecision(WS_ID, a.upc, batch.id, 'accept', 'blocked-widget.html', 'tester');
    expect(filenameGateReason(entry, WS_ID, batch.id)).toMatch(/^filename_collision_catalog/);
  });

  it('defer records history without suppressing the gate', () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'defer', fileName: 'd.csv', totalItems: 2 });
    const a = seedItem(batch.id, `DEF-A-${randomUUID().slice(0, 6)}`, 'Deferred Product');
    seedItem(batch.id, `DEF-B-${randomUUID().slice(0, 6)}`, 'Deferred Product');
    const preview = computeBatchFilenamePreview(WS_DIR, listItemsByBatch(batch.id));
    const entryA = preview.find(p => p.upc === a.upc)!;
    recordFilenameDecision(WS_ID, a.upc, batch.id, 'defer', 'deferred-product.html', 'tester');
    // Defer is an explicit recorded decision, but the item still cannot approve silently.
    expect(filenameGateReason(entryA, WS_ID, batch.id)).toMatch(/^filename_warning_unresolved/);
    const rows = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ? ORDER BY created_at ASC`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(rows.map(r => r.event_type)).toContain('filename_warning_deferred');
  });
});

describe('filename preview endpoint (issue #109)', () => {
  it('serves computed file names plus warnings for the batch', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'ep', fileName: 'ep.csv', totalItems: 2 });
    const a = seedItem(batch.id, `EP-A-${randomUUID().slice(0, 6)}`, 'Endpoint Product');
    seedItem(batch.id, `EP-B-${randomUUID().slice(0, 6)}`, 'Endpoint Product!');
    const res = await makeApi().request(`/api/onboarding/batches/${batch.id}/filename-preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      batchId: string;
      items: Array<{ itemId: string; upc: string; fileName: string; warnings: Array<{ code: string }> }>;
    };
    expect(body.batchId).toBe(batch.id);
    expect(body.items).toHaveLength(2);
    expect(new Set(body.items.map(i => i.fileName)).size).toBe(2);
    for (const entry of body.items) {
      expect(entry.warnings.map(w => w.code)).toContain('filename_collision_batch');
    }
    expect(body.items.find(i => i.itemId === a.id)).toBeDefined();
  });

  it('404s unknown batches', async () => {
    const res = await makeApi().request('/api/onboarding/batches/does-not-exist/filename-preview');
    expect(res.status).toBe(404);
  });
});

describe('review-complete filename gate (issue #109)', () => {
  it('rejects warned items without a decision and mutates nothing', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-block', fileName: 'rc.csv', totalItems: 2 });
    const a = seedItem(batch.id, `RC-A-${randomUUID().slice(0, 6)}`, 'Review Gate Product');
    seedItem(batch.id, `RC-B-${randomUUID().slice(0, 6)}`, 'Review Gate Product');
    const beforeRes = await makeApi().request(`/api/onboarding/batches/${batch.id}/filename-preview`);
    const before = (await beforeRes.json()) as any;
    expect(before.items[0].warnings).toHaveLength(1);

    const res = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { failures: Array<{ itemId: string; reason: string }> };
    expect(body.failures.find(f => f.itemId === a.id)?.reason).toMatch(/^filename_warning_unresolved/);
    expect(getReviewState(a.id)).toBeUndefined();
  });

  it('accept records history and completes; defer records and skips via deferred[]', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-accept', fileName: 'rc.csv', totalItems: 2 });
    const a = seedItem(batch.id, `RCA-A-${randomUUID().slice(0, 6)}`, 'Accept Gate Product');
    const b = seedItem(batch.id, `RCA-B-${randomUUID().slice(0, 6)}`, 'Accept Gate Product');

    const resAccept = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'accept' } }),
    });
    expect(resAccept.status).toBe(200);
    const accepted = await resAccept.json() as { success: boolean; deferred: string[] };
    expect(accepted.success).toBe(true);
    expect(getReviewState(a.id)?.reviewedAt).toBeTruthy();
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(history.map(h => h.event_type)).toContain('filename_warning_accepted');

    const resDefer = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [b.id], filenameDecisions: { [b.id]: 'defer' } }),
    });
    expect(resDefer.status).toBe(200);
    const deferred = await resDefer.json() as { success: boolean; deferred: string[] };
    expect(deferred.deferred).toContain(b.id);
    expect(getReviewState(b.id)).toBeUndefined();
    // Defer audit trail: the explicit defer decision is in history even
    // though the item was skipped without review state.
    const deferHistory = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, b.upc) as Array<{ event_type: string }>;
    expect(deferHistory.map(h => h.event_type)).toContain('filename_warning_deferred');
  });

  it('catalog collisions stay blocked even with accept', async () => {
    const catSku = `RCCAT-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(catSku, 'Route Catalog Widget', 'route-catalog-widget.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-cat', fileName: 'rc.csv', totalItems: 1 });
    const a = seedItem(batch.id, `RCC-${randomUUID().slice(0, 6)}`, 'Route Catalog Widget');
    const res = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'accept' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { failures: Array<{ reason: string }> };
    expect(body.failures[0].reason).toMatch(/^filename_collision_catalog/);
  });

  it('rejects malformed filenameDecisions with no mutation', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-bad', fileName: 'rc.csv', totalItems: 1 });
    const a = seedItem(batch.id, `RCB-${randomUUID().slice(0, 6)}`, 'Lone Product');
    const res = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'maybe' } }),
    });
    expect(res.status).toBe(400);
    expect(getReviewState(a.id)).toBeUndefined();
  });

  it('clean batches complete with no decisions at all (P0: empty-case gate)', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-clean', fileName: 'rc.csv', totalItems: 2 });
    const a = seedItem(batch.id, `RCCL-A-${randomUUID().slice(0, 6)}`, 'Clean Alpha Product');
    const b = seedItem(batch.id, `RCCL-B-${randomUUID().slice(0, 6)}`, 'Clean Beta Product');
    // No filenameDecisions key whatsoever: warnings-empty items must not
    // require any explicit decision.
    const res = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id, b.id] }),
    });
    expect(res.status).toBe(200);
    expect(getReviewState(a.id)?.reviewedAt).toBeTruthy();
    expect(getReviewState(b.id)?.reviewedAt).toBeTruthy();
    // And no filename history was written for either item.
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku IN (?, ?)`,
    ).all(WS_ID, a.upc, b.upc) as Array<{ event_type: string }>;
    expect(history.map(h => h.event_type).filter(e => e.startsWith('filename_warning_'))).toEqual([]);
  });

  it('catalog collision plus defer records history and lands in deferred[]', async () => {
    const catSku = `RCDEF-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(catSku, 'Defer Catalog Widget', 'defer-catalog-widget.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'rc-defcat', fileName: 'rc.csv', totalItems: 1 });
    const a = seedItem(batch.id, `RCD-${randomUUID().slice(0, 6)}`, 'Defer Catalog Widget');
    const res = await makeApi().request('/api/onboarding/items/review-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'defer' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; deferred: string[] };
    expect(body.deferred).toContain(a.id);
    expect(getReviewState(a.id)).toBeUndefined();
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(history.map(h => h.event_type)).toContain('filename_warning_deferred');
  });
});

describe('bulk approve filename gate (issue #109)', () => {
  function markCompleted(ids: string[]) {
    getDb().query(`UPDATE onboarding_items SET stage_status = 'completed' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }

  it('rejects warned items without a decision; accept approves and records', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'bulk', fileName: 'b.csv', totalItems: 2 });
    const a = seedItem(batch.id, `BULK-A-${randomUUID().slice(0, 6)}`, 'Bulk Gate Product');
    const b = seedItem(batch.id, `BULK-B-${randomUUID().slice(0, 6)}`, 'Bulk Gate Product');
    markCompleted([a.id, b.id]);
    markReviewed({ itemId: a.id, batchId: batch.id, reviewedBy: 'tester' });
    markReviewed({ itemId: b.id, batchId: batch.id, reviewedBy: 'tester' });

    const resBlocked = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id, b.id] }),
    });
    expect(resBlocked.status).toBe(200);
    const blocked = await resBlocked.json() as { results: Array<{ itemId: string; status: string; reason: string | null }> };
    expect(blocked.results.find(r => r.itemId === a.id)).toMatchObject({ status: 'rejected' });
    expect(blocked.results.find(r => r.itemId === a.id)?.reason).toMatch(/^filename_warning_unresolved/);

    const resAccept = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'accept' } }),
    });
    const accepted = await resAccept.json() as { results: Array<{ itemId: string; status: string }> };
    expect(accepted.results.find(r => r.itemId === a.id)?.status).toBe('approved');
  });

  it('defer records history and lands in rejected as deferred_by_operator', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'bulkdefer', fileName: 'bd.csv', totalItems: 2 });
    const a = seedItem(batch.id, `BULKD-A-${randomUUID().slice(0, 6)}`, 'Bulk Defer Product');
    seedItem(batch.id, `BULKD-B-${randomUUID().slice(0, 6)}`, 'Bulk Defer Product');
    markCompleted([a.id]);
    markReviewed({ itemId: a.id, batchId: batch.id, reviewedBy: 'tester' });
    const res = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'defer' } }),
    });
    const body = await res.json() as { results: Array<{ itemId: string; status: string; reason: string | null }> };
    expect(body.results.find(r => r.itemId === a.id)).toMatchObject({ status: 'rejected', reason: 'deferred_by_operator' });
    // Defer audit trail on the bulk path too.
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(history.map(h => h.event_type)).toContain('filename_warning_deferred');
  });

  it('clean batches approve with no decisions at all (P0: empty-case gate)', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'bulkclean', fileName: 'bc.csv', totalItems: 2 });
    const a = seedItem(batch.id, `BULKC-A-${randomUUID().slice(0, 6)}`, 'Bulk Clean Alpha');
    const b = seedItem(batch.id, `BULKC-B-${randomUUID().slice(0, 6)}`, 'Bulk Clean Beta');
    markCompleted([a.id, b.id]);
    markReviewed({ itemId: a.id, batchId: batch.id, reviewedBy: 'tester' });
    markReviewed({ itemId: b.id, batchId: batch.id, reviewedBy: 'tester' });
    const res = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id, b.id] }),
    });
    const body = await res.json() as { results: Array<{ itemId: string; status: string }> };
    expect(body.results.find(r => r.itemId === a.id)?.status).toBe('approved');
    expect(body.results.find(r => r.itemId === b.id)?.status).toBe('approved');
  });

  it('malformed filenameDecisions fail closed with no mutation and no history', async () => {
    const batch = createBatch({ workspaceId: WS_ID, name: 'bulkbag', fileName: 'bb.csv', totalItems: 2 });
    const a = seedItem(batch.id, `BULKB-A-${randomUUID().slice(0, 6)}`, 'Bulk Bad Product');
    seedItem(batch.id, `BULKB-B-${randomUUID().slice(0, 6)}`, 'Bulk Bad Product');
    markCompleted([a.id]);
    markReviewed({ itemId: a.id, batchId: batch.id, reviewedBy: 'tester' });
    const res = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'maybe' } }),
    });
    expect(res.status).toBe(400);
    // No mutation: not approved, no review advancement side-effects visible
    // via approval state, and no filename history written.
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(history).toEqual([]);
    expect(getReviewState(a.id)?.approvedAt).toBeFalsy();
  });

  it('catalog collision plus defer records history and defers instead of blocking', async () => {
    const catSku = `BULKCAT-${randomUUID().slice(0, 6)}`;
    seedCatalogProduct(catSku, 'Bulk Catalog Defer Widget', 'bulk-catalog-defer-widget.html');
    const batch = createBatch({ workspaceId: WS_ID, name: 'bulkcatdef', fileName: 'bcd.csv', totalItems: 1 });
    const a = seedItem(batch.id, `BULKCD-${randomUUID().slice(0, 6)}`, 'Bulk Catalog Defer Widget');
    markCompleted([a.id]);
    markReviewed({ itemId: a.id, batchId: batch.id, reviewedBy: 'tester' });
    const res = await makeApi().request(`/api/onboarding/batches/${batch.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [a.id], filenameDecisions: { [a.id]: 'defer' } }),
    });
    const body = await res.json() as { results: Array<{ itemId: string; status: string; reason: string | null }> };
    expect(body.results.find(r => r.itemId === a.id)).toMatchObject({ status: 'rejected', reason: 'deferred_by_operator' });
    const history = getDb().query(
      `SELECT event_type FROM classification_history_events WHERE workspace_id = ? AND product_sku = ?`,
    ).all(WS_ID, a.upc) as Array<{ event_type: string }>;
    expect(history.map(h => h.event_type)).toContain('filename_warning_deferred');
  });
});
