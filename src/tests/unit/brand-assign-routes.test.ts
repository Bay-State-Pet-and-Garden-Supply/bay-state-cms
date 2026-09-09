/**
 * ADR 0017 commitment 4 — assign_brand / assign_domain discovery attention
 * action routes, extended for Check source options single-brand assignment.
 *
 * DB-backed route suite (bun:sqlite — run under `bun test`, same convention
 * as sourcing-safety-routes.test.ts / brand-authority-gate.test.ts). Proves
 * the two first-class attention actions end-to-end through the real Hono
 * app:
 * - assign_brand updates the item's brand hint and, for Find product page
 *   items, re-queues discovery exactly like the search_again/retry flow
 *   (discovery/pending, flat status back to imported, error cleared,
 *   worker polled);
 * - assign_brand also accepts Check source options items, overwrites an
 *   existing hint, saves without a discovery requeue, and releases a
 *   missing_brand hold so the item can flow;
 * - assign_domain remains Find product page-only: it upserts the
 *   brand→domain mapping for the item's current brand hint, fails with a
 *   clear error when no brand is assigned, and re-queues discovery;
 * - assign_brand still rejects later stages, and both actions fail closed
 *   cross-workspace (404).
 *
 * - assign_domain upserts the brand→domain mapping for the item's current
 *   brand hint, fails with a clear error when no brand is assigned, and
 *   re-queues discovery;
 * - both reject non-Discovery items and fail closed cross-workspace (404).
 *
 * Offline-only: discovery runs entirely against local brand-domain indexes
 * and sitemaps — no search API key exists in the test DB. The background
 * worker's discovery attempt therefore settles deterministically (setup
 * hold or zero-candidate completion) without external calls, and the re-queue
 * contract asserted here (stage stays discovery, flat status 'imported',
 * stage_status pending-or-claimed) is written synchronously by the routes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateItemStageStatus,
  holdBatchItems,
} from '../../db/repositories/onboarding-item-repo';
import { toCanonicalStored } from '../../db/repositories/onboarding-stage-vocabulary-repo';
import { findBrandSites } from '../../db/repositories/brand-site-repo';
import { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import app from '../../server/app';

const wsId = 'ws-brand-assign';
const foreignWsId = 'ws-brand-assign-foreign';

function makeDiscoveryItem(overrides: { brandHint?: string | null } = {}) {
  const batch = createBatch({ workspaceId: wsId, name: 'Brand Assign', fileName: 'ba.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [
    {
      upc: 'BA-0001',
      name: 'Brand Assign Product',
      brandHint: overrides.brandHint ?? null,
      rowNumber: 1,
      stage: 'discovery',
    },
  ]);
  // Realistic discovery-card state: discovery completed, held for manual
  // review (needs_review error-message convention).
  updateItemStageStatus(item.id, 'completed', 'needs_review: no candidate passed verification');
  return item;
}

function makeSourcingItem(overrides: { brandHint?: string | null; stageStatus?: 'pending' | 'needs_input'; errorMessage?: string | null; isHeld?: boolean; heldReason?: string | null } = {}) {
  const batch = createBatch({ workspaceId: wsId, name: 'Sourcing Brand Assign', fileName: 'sba.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [
    {
      upc: 'SBA-0001',
      name: 'Sourcing Brand Product',
      brandHint: overrides.brandHint ?? null,
      rowNumber: 1,
      stage: 'route_sources',
      stageStatus: overrides.stageStatus ?? 'pending',
      isHeld: overrides.isHeld ?? false,
      heldReason: overrides.heldReason ?? null,
    },
  ]);
  if (overrides.errorMessage !== undefined) {
    updateItemStageStatus(item.id, overrides.stageStatus ?? 'pending', overrides.errorMessage);
  }
  return item;
}

describe('ADR 0017 commitment 4 — assign_brand / assign_domain routes', () => {
  let tempDir: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-assign-routes-test-'));
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
    // Stop any worker started by a prior test so poll intervals never cross
    // test boundaries. Each route re-creates its worker on demand.
    resetActiveWorkerForTest();
  });

  it('assign_brand updates the brand hint and re-queues discovery (search_again flow)', async () => {
    const item = makeDiscoveryItem();

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: '  Fromm  ' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.item.brandHint).toBe('Fromm'); // trimmed

    const after = findItemById(item.id);
    expect(after?.brandHint).toBe('Fromm');
    // Re-discovery contract (same reset the search_again/retry path uses):
    // stage stays discovery, the manual-review error is cleared, and the
    // stage status is pending — or already claimed (in_progress) by the
    // worker poll the route triggers.
    expect(after?.stage).toBe('discovery');
    expect(after?.errorMessage).toBeNull();
    expect(['pending', 'in_progress']).toContain(after?.stageStatus);
  });

  it('assign_brand accepts Check source options without a discovery requeue', async () => {
    const item = makeSourcingItem({ stageStatus: 'needs_input', errorMessage: 'source conflict' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: '  Open Farm  ' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.item.brandHint).toBe('Open Farm'); // trimmed

    const after = findItemById(item.id);
    expect(after?.brandHint).toBe('Open Farm');
    expect(toCanonicalStored(after?.stage)).toBe('route_sources');
    // A discovery requeue would reset an in-stage sourcing status/error to
    // pending/null. Sourcing keeps its own status and error untouched.
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.errorMessage).toBe('source conflict');
    expect(after?.isHeld).toBe(false);
    expect(after?.heldReason).toBeNull();
  });

  it('assign_brand overwrites an existing sourcing hint and releases a missing_brand hold', async () => {    const item = makeSourcingItem({ brandHint: 'Wrong Brand', isHeld: true, heldReason: 'missing_brand' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Open Farm' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const after = findItemById(item.id);
    expect(after?.brandHint).toBe('Open Farm');
    expect(toCanonicalStored(after?.stage)).toBe('route_sources');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.isHeld).toBe(false);
    expect(after?.heldReason).toBeNull();
  });

  it('assign_brand releases an unresolved_brand hold on a discovery item and re-queues discovery', async () => {
    // Regression: ready_only start holds unbranded items with
    // heldReason='unresolved_brand'; a later brand fix must release the
    // hold even though discovery is re-queued (the requeue only resets
    // stage_status/status and never clears is_held/held_reason).
    const item = makeDiscoveryItem();
    holdBatchItems(item.batchId, [item.id], 'unresolved_brand');
    expect(findItemById(item.id)?.isHeld).toBe(true);

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Fromm' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const after = findItemById(item.id);
    expect(after?.brandHint).toBe('Fromm');
    expect(after?.isHeld).toBe(false);
    expect(after?.heldReason).toBeNull();
    // Discovery requeue contract still holds: stage stays discovery and
    // the item is pending — or already claimed (in_progress) by the
    // worker poll the route triggers.
    expect(after?.stage).toBe('discovery');
    expect(['pending', 'in_progress']).toContain(after?.stageStatus);
  });

  it('assign_brand rejects a missing or blank brand without mutation', async () => {
    const item = makeDiscoveryItem();

    const missing = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain('brand is required');

    const blank = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: '   ' }),
    });
    expect(blank.status).toBe(400);

    const after = findItemById(item.id);
    expect(after?.brandHint).toBeNull();
    expect(after?.stageStatus).toBe('completed');
  });

  it('assign_domain upserts the brand→domain mapping and re-queues discovery', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Fromm' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://www.frommfamily.com/products' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Mapping persisted with normalized brand + bare domain (upsertBrandSite
    // normalizes both; URL-shaped input is reduced to the hostname).
    const sites = findBrandSites('Fromm');
    expect(sites).toHaveLength(1);
    expect(sites[0].brandName).toBe('fromm');
    expect(sites[0].domain).toBe('frommfamily.com');

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.errorMessage).toBeNull();
    expect(['pending', 'in_progress']).toContain(after?.stageStatus);
  });

  it('assign_domain fails with a clear error when the item has no brand hint', async () => {
    const item = makeDiscoveryItem(); // brandHint null

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'frommfamily.com' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('no brand assigned yet');

    // The item was not re-queued (stage status + manual-review error
    // untouched) and no mapping could be written (the upsert happens only
    // after the brand-hint guard).
    const after = findItemById(item.id);
    expect(after?.stageStatus).toBe('completed');
    expect(after?.errorMessage).toContain('needs_review');
    expect(after?.brandHint).toBeNull();
  });

  it('assign_domain rejects invalid domain shapes', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Acme Pet' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('valid bare domain or URL');
    expect(findBrandSites('Acme Pet')).toHaveLength(0);
  });

  it('assign_domain rejects known retailer/distributor domains (no upsert, no requeue)', async () => {
    const item = makeDiscoveryItem({ brandHint: 'Butchers' });

    const res = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'https://farmtopaw.ca/products' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Retailer/distributor domains cannot be mapped');

    // No mapping was upserted and the item was NOT re-queued: still
    // completed with the needs_review manual-review error, brand hint
    // untouched — the guard returns before the upsert and requeue.
    expect(findBrandSites('Butchers')).toHaveLength(0);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.errorMessage).toContain('needs_review');
    expect(after?.brandHint).toBe('Butchers');
  });

  it('assign-brand still rejects later stages; assign-domain remains Discovery-only', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Not Discovery', fileName: 'nd.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'BA-0002', name: 'Extraction Item', rowNumber: 1, stage: 'extraction' },
    ]);

    const brandRes = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Fromm' }),
    });
    expect(brandRes.status).toBe(400);
    expect((await brandRes.json()).error).toContain('Check source options (route_sources) or Find product page (find_product_page)');

    const domainRes = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'frommfamily.com' }),
    });
    expect(domainRes.status).toBe(400);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.brandHint).toBeNull();
  });

  it('cross-workspace assign actions fail closed (404) without mutation', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [
      { upc: 'BA-0003', name: 'Foreign Item', brandHint: 'ForeignBrand', rowNumber: 1, stage: 'discovery' },
    ]);

    const brandRes = await app.request(`/api/onboarding/items/${item.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'ForeignBrand' }),
    });
    expect(brandRes.status).toBe(404);

    const domainRes = await app.request(`/api/onboarding/items/${item.id}/assign-domain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'foreignbrand.com' }),
    });
    expect(domainRes.status).toBe(404);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending'); // untouched
    expect(after?.brandHint).toBe('ForeignBrand');
    expect(findBrandSites('ForeignBrand')).toHaveLength(0);
  });

  it('GET /api/onboarding/settings/brand-sites includes brand hints from onboarding items and persists newly assigned brands', async () => {
    // 1. Initial brand-sites response
    const initialRes = await app.request('/api/onboarding/settings/brand-sites');
    expect(initialRes.status).toBe(200);
    const initialData = await initialRes.json();
    expect(Array.isArray(initialData.brandSites)).toBe(true);
    expect(Array.isArray(initialData.catalogBrands)).toBe(true);

    // 2. Create an item with a brand hint
    const testBatch = createBatch({ workspaceId: wsId, name: 'Brand Persist Batch', fileName: 'bp.csv', totalItems: 1 });
    const [testItem] = insertItems(testBatch.id, [
      { upc: 'BP-0001', name: 'Persisted Brand Item', brandHint: 'Wild Frontier', rowNumber: 1, stage: 'route_sources' },
    ]);

    // 3. Verify GET /settings/brand-sites now returns "Wild Frontier" in catalogBrands
    const resAfterInsert = await app.request('/api/onboarding/settings/brand-sites');
    expect(resAfterInsert.status).toBe(200);
    const dataAfterInsert = await resAfterInsert.json();
    expect(dataAfterInsert.catalogBrands).toContain('Wild Frontier');

    // 4. Assign a new brand via the route
    const assignRes = await app.request(`/api/onboarding/items/${testItem.id}/assign-brand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'BrandCraft' }),
    });
    expect(assignRes.status).toBe(200);

    // 5. Verify the newly assigned brand is returned on subsequent fetch (persisting across refreshes)
    const resAfterAssign = await app.request('/api/onboarding/settings/brand-sites');
    expect(resAfterAssign.status).toBe(200);
    const dataAfterAssign = await resAfterAssign.json();
    expect(dataAfterAssign.catalogBrands).toContain('BrandCraft');
  });
});

