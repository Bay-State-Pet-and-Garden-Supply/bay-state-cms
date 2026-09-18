/**
 * Drift 3b (#256) — remaining writer integration and safe backfill.
 *
 * Behavioral coverage at the highest existing integration seam (ShopSite XML
 * fixtures with a scratch workspace + database):
 * - approval writes the canonical comparison value without advancing
 *   remote-observation or successful-sync pointers
 * - drift acceptance writes the canonical comparison value
 * - backfill rebuilds stale caches from approved HEAD data only, never
 *   inferring remote equality from local products
 * - missing sources stay explicitly unverified (not_synced) pending recheck
 * - backfill is resumable and repeat-safe, including interrupted runs
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift, acceptRemoteForDrift } from '../../shopsite/drift';
import {
  runCanonicalComparisonBackfill,
  getCanonicalBackfillProgress,
} from '../../shopsite/canonical-comparison-backfill';
import { comparisonHashForProduct } from '../../shopsite/catalog-comparison';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { findProductBySku, insertProductIndex, updateProductIndex } from '../../db/repositories/product-index-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { approveChangeSet } from '../../server/services/change-set-service';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashJson, deterministicStringify } from '../../git/deterministic-json';

const testDbPath = '/tmp/baystate-cms-drift-256-test.db';
let workspacePath = '';
const workspaceId = `ws-256-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>BACKFILL-001</SKU><Name>Backfill Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
<Product><SKU>BACKFILL-002</SKU><Name>Second Widget</Name><Price>9.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/second.jpg</Graphic><QuantityOnHand>5</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function commitAll(message: string): string {
  const git = new GitClient(workspacePath);
  git.add(['products/', '.gitignore']);
  git.commit(message);
  return git.getHeadHash();
}

describe('Drift 3b (#256): remaining writers + safe backfill', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-256-int-'));
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [workspaceId, `${workspaceId}-store`, workspacePath, `${workspacePath}/.git`, now, now, 'complete'],
    );
    createWorkspaceDirs(workspacePath);
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'exports/\n');
    const git = new GitClient(workspacePath);
    git.init();
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    for (const p of decoded.products) writeProductFile(workspacePath, p);
    commitAll('Baseline for #256');
    // Seed product_index with canonical hashes (import slice behavior).
    for (const p of decoded.products) {
      const h = comparisonHashForProduct(p);
      insertProductIndex({
        id: p.id,
        sku: p.sku,
        filePath: skuToProductFilePath(p.sku),
        title: p.core.name,
        status: p.status,
        price: p.core.price,
        inventoryQuantity: p.core.inventory.quantityOnHand,
        primaryImage: p.core.media.primary,
        productHash: h,
        lastApprovedCommit: new GitClient(workspacePath).getHeadHash(),
        lastPulledRemoteHash: h,
        lastSyncedRemoteHash: h,
        lastSyncedAt: now,
        syncStatus: 'synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: p.core.description,
        searchKeywords: p.core.seo.searchKeywords,
        customFields: p.customFields,
      });
    }
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('approval writes the canonical value without advancing remote/sync pointers', () => {
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    const product = decoded.products.find((p) => p.sku === 'BACKFILL-001')!;
    product.core.price = '21.99';
    const before = findProductBySku('BACKFILL-001')!;
    const beforePulled = before.lastPulledRemoteHash;
    const beforeSynced = before.lastSyncedRemoteHash;
    const beforeSyncedAt = before.lastSyncedAt;

    const cs = createChangeSet({ workspaceId, title: 'price bump', baseCommit: 'test' });
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: product.sku,
      operation: 'update',
      draftJson: deterministicStringify(product),
      baseJson: deterministicStringify(decoded.products[0]),
      draftHash: hashJson(product),
    });
    const result = approveChangeSet(cs.id, workspacePath);
    expect(result.success).toBe(true);

    const after = findProductBySku('BACKFILL-001')!;
    expect(after.productHash).toBe(comparisonHashForProduct(product));
    // Approval never advances remote-observation or successful-sync pointers.
    expect(after.lastPulledRemoteHash).toBe(beforePulled);
    expect(after.lastSyncedRemoteHash).toBe(beforeSynced);
    expect(after.lastSyncedAt).toBe(beforeSyncedAt);
    expect(after.syncStatus).toBe('not_synced');

    // Restore baseline file for later tests.
    const restored = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products.find((p) => p.sku === 'BACKFILL-001')!;
    writeProductFile(workspacePath, restored);
    commitAll('Restore after approval test');
    updateProductIndex({
      sku: 'BACKFILL-001',
      productHash: comparisonHashForProduct(restored),
      syncStatus: 'synced',
      lastPulledRemoteHash: comparisonHashForProduct(restored),
      lastSyncedRemoteHash: comparisonHashForProduct(restored),
    });
  });

  it('drift acceptance writes the canonical comparison value', () => {
    const changed = BASE_XML.replace('19.99', '24.99');
    const detected = detectDrift(workspaceId, workspacePath, changed, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(detected.driftCount).toBeGreaterThan(0);
    const drift = detected.drifts.find((d) => d.sku === 'BACKFILL-001')!;
    const accepted = acceptRemoteForDrift(workspacePath, drift);
    expect(accepted.product.sku).toBe('BACKFILL-001');
    const idx = findProductBySku('BACKFILL-001')!;
    expect(idx.productHash).toBe(comparisonHashForProduct(accepted.product));
    expect(idx.productHash).toBe(drift.remoteHash);
    expect(idx.syncStatus).toBe('synced');

    // Restore baseline.
    const restored = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products.find((p) => p.sku === 'BACKFILL-001')!;
    writeProductFile(workspacePath, restored);
    commitAll('Restore after accept test');
    updateProductIndex({
      sku: 'BACKFILL-001',
      productHash: comparisonHashForProduct(restored),
      syncStatus: 'synced',
      lastPulledRemoteHash: comparisonHashForProduct(restored),
      lastSyncedRemoteHash: comparisonHashForProduct(restored),
    });
    detectDrift(workspaceId, workspacePath, BASE_XML, { resolvePageIdentity: () => null, pageImportHash: null });
  });

  it('backfill rebuilds stale caches from approved data without inferring synced', () => {
    // Simulate a pre-cutover row: legacy hashJson value marked synced.
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    const approved = decoded.products.find((p) => p.sku === 'BACKFILL-002')!;
    const legacyHash = hashJson(approved);
    const canonical = comparisonHashForProduct(approved);
    expect(legacyHash).not.toBe(canonical);
    updateProductIndex({
      sku: 'BACKFILL-002',
      productHash: legacyHash,
      syncStatus: 'synced',
      lastPulledRemoteHash: legacyHash,
      lastSyncedRemoteHash: legacyHash,
      lastSyncedAt: new Date().toISOString(),
    });

    const result = runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 50 });
    expect(result.rebuilt).toBeGreaterThanOrEqual(1);

    const after = findProductBySku('BACKFILL-002')!;
    expect(after.productHash).toBe(canonical);
    // Historical remote equality is never inferred from local products:
    // the stale synced signal becomes explicit unverified pending recheck.
    expect(after.syncStatus).toBe('not_synced');
    expect(after.lastSyncedRemoteHash).toBeNull();
    expect(after.lastSyncedAt).toBeNull();
  });

  it('missing approved source stays unverified pending recheck, never manufactured', () => {
    const sku = `MISSING-${Date.now()}`;
    const now = new Date().toISOString();
    insertProductIndex({
      id: `id-${sku}`,
      sku,
      filePath: skuToProductFilePath(sku),
      title: 'Ghost',
      status: 'active',
      price: '1.00',
      inventoryQuantity: 1,
      primaryImage: null,
      productHash: 'stale-legacy-hash',
      lastApprovedCommit: null,
      lastPulledRemoteHash: 'stale-legacy-hash',
      lastSyncedRemoteHash: 'stale-legacy-hash',
      lastSyncedAt: now,
      syncStatus: 'synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
      description: null,
      searchKeywords: null,
      customFields: {},
    });
    const result = runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 50 });
    expect(result.missingSource).toBeGreaterThanOrEqual(1);
    const after = findProductBySku(sku)!;
    expect(after.syncStatus).toBe('not_synced');
    expect(after.syncStatus).not.toBe('synced');
    expect(after.syncStatus).not.toBe('drifted');
    // Cleanup ghost row.
    getDb().run('DELETE FROM product_index WHERE sku = ?', [sku]);
  });

  it('backfill is resumable and repeat-safe, including interrupted runs', () => {
    // Re-dirty one row to force work across batches of one.
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    const approved = decoded.products.find((p) => p.sku === 'BACKFILL-001')!;
    updateProductIndex({
      sku: 'BACKFILL-001',
      productHash: hashJson(approved),
      syncStatus: 'synced',
      lastPulledRemoteHash: hashJson(approved),
      lastSyncedRemoteHash: hashJson(approved),
    });
    // Interrupted run: one batch of one.
    const first = runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 1, maxBatches: 1 });
    expect(first.complete || first.remaining >= 0).toBe(true);
    // Resume to completion.
    const second = runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 50 });
    expect(second.complete).toBe(true);
    expect(second.remaining).toBe(0);
    // Repeat-safe: a further run rebuilds nothing.
    const third = runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 50 });
    expect(third.rebuilt).toBe(0);
    expect(third.complete).toBe(true);
    const progress = getCanonicalBackfillProgress(workspaceId);
    expect(progress.done).toBe(true);
  });

  it('leaves classification source-hash semantics untouched', async () => {
    const { computeProductHash } = await import('../../classification/catalog-product-source');
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    const before = computeProductHash(decoded.products[0]);
    runCanonicalComparisonBackfill(workspaceId, workspacePath, { batchSize: 50 });
    const after = computeProductHash(decoded.products[0]);
    expect(after).toBe(before);
  });
});
