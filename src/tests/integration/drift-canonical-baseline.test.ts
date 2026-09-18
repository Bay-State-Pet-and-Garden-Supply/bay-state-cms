/**
 * Drift 3/6 (#252) — canonical Git-baseline comparison: import/check behavior.
 *
 * Behavioral coverage at the highest existing integration seam (ShopSite XML
 * fixtures with a scratch workspace + database):
 * - pushing the catalog and immediately checking drift yields zero findings
 * - a genuine remote change yields exactly the hunks that moved
 * - unpushed approval still moves the pinned HEAD baseline
 * - a dirty working tree does not move the baseline (recorded, not silently used)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

const testDbPath = '/tmp/baystate-cms-drift-252-test.db';
let workspacePath = '';
const workspaceId = `ws-252-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>CANON-001</SKU><Name>Canonical Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function commitAll(message: string): string {
  const git = new GitClient(workspacePath);
  git.add(['products/', '.gitignore']);
  git.commit(message);
  return git.getHeadHash();
}

describe('Drift 3/6 (#252): canonical Git-baseline import/check', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-252-int-'));
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
    commitAll('Baseline for #252');
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('pushing the catalog then checking identical remote yields zero findings', () => {
    const result = detectDrift(workspaceId, workspacePath, BASE_XML, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(result.errors).toEqual([]);
    expect(result.driftCount).toBe(0);
    expect(result.baselineSource).toBe('head');
    expect(result.baselineDirty).toBe(false);
    expect(result.projectionVersion).toBe('catalog-comparison-v1');
  });

  it('a genuine price change yields exactly the price hunk', () => {
    const changed = BASE_XML.replace('19.99', '24.99');
    const result = detectDrift(workspaceId, workspacePath, changed, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(result.driftCount).toBe(1);
    const drift = result.drifts[0];
    expect(drift.sku).toBe('CANON-001');
    const diff = JSON.parse(drift.diffJson!) as {
      hunks: Array<{ field: string; baselineValue: string | null; remoteValue: string | null }>;
      projectionVersion: string;
      baselineSource: string;
    };
    expect(diff.hunks).toEqual([
      { field: 'core.price', baselineValue: '19.99', remoteValue: '24.99' },
    ]);
    expect(diff.projectionVersion).toBe('catalog-comparison-v1');
    expect(diff.baselineSource).toBe('head');
  });

  it('an unpushed approval moves the pinned baseline', () => {
    const decoded = ShopSiteProductCodec.decode(BASE_XML.replace('19.99', '29.99'), { workspaceId });
    for (const p of decoded.products) writeProductFile(workspacePath, p);
    const newHead = commitAll('Unpushed approval: price to 29.99');
    expect(newHead).toBeTruthy();

    const sameAsNewHead = BASE_XML.replace('19.99', '29.99');
    const clean = detectDrift(workspaceId, workspacePath, sameAsNewHead, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(clean.driftCount).toBe(0);
    expect(clean.baselineCommit).toBe(newHead);

    const oldRemote = detectDrift(workspaceId, workspacePath, BASE_XML, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(oldRemote.driftCount).toBe(1);
  });

  it('a dirty working tree does not move the baseline', () => {
    const git = new GitClient(workspacePath);
    const headBefore = git.getHeadHash();
    const decoded = ShopSiteProductCodec.decode(BASE_XML.replace('19.99', '29.99'), { workspaceId });
    const dirtyProduct = decoded.products[0];
    dirtyProduct.core.price = '99.99';
    writeProductFile(workspacePath, dirtyProduct);
    expect(git.status().length).toBeGreaterThan(0);

    const result = detectDrift(workspaceId, workspacePath, BASE_XML.replace('19.99', '29.99'), {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(result.baselineDirty).toBe(true);
    expect(result.baselineCommit).toBe(headBefore);
    expect(result.driftCount).toBe(0);

    git.add(['products/']);
    git.commit('Restore clean tree');
  });

  it('local-ahead (unpushed approval with index) stays not_synced, not drift', async () => {
    const { comparisonHashForProduct } = await import('../../shopsite/catalog-comparison');
    const { insertProductIndex, findProductBySku } = await import('../../db/repositories/product-index-repo');
    const { skuToProductFilePath } = await import('../../git/product-file-path');
    const sku = `LOCAL-AHEAD-${Date.now()}`;
    const baseXml = BASE_XML.replace('CANON-001', sku).replace('19.99', '40.00');
    const decodedBase = ShopSiteProductCodec.decode(baseXml, { workspaceId });
    const baseProduct = decodedBase.products[0];
    writeProductFile(workspacePath, baseProduct);
    commitAll(`Add ${sku} at 40.00`);
    const baseHash = comparisonHashForProduct(baseProduct, {
      resolvePageIdentity: () => null,
    });
    const now = new Date().toISOString();
    try {
      insertProductIndex({
        id: baseProduct.id,
        sku,
        filePath: skuToProductFilePath(sku),
        title: baseProduct.core.name,
        status: baseProduct.status,
        price: baseProduct.core.price,
        inventoryQuantity: baseProduct.core.inventory.quantityOnHand,
        primaryImage: baseProduct.core.media.primary,
        productHash: baseHash,
        lastApprovedCommit: new GitClient(workspacePath).getHeadHash(),
        lastPulledRemoteHash: baseHash,
        lastSyncedRemoteHash: baseHash,
        lastSyncedAt: now,
        syncStatus: 'synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: baseProduct.core.description,
        searchKeywords: baseProduct.core.seo.searchKeywords,
        customFields: baseProduct.customFields,
      });
    } catch {
      // Row may already exist from a prior run: reset to synced baseline.
      const { updateProductIndex } = await import('../../db/repositories/product-index-repo');
      updateProductIndex({ sku, lastPulledRemoteHash: baseHash, lastSyncedRemoteHash: baseHash, syncStatus: 'synced' });
    }

    const approvedXml = baseXml.replace('40.00', '41.00');
    const decodedApproved = ShopSiteProductCodec.decode(approvedXml, { workspaceId });
    for (const p of decodedApproved.products) writeProductFile(workspacePath, p);
    commitAll(`Unpushed approval ${sku} to 41.00`);

    const result = detectDrift(workspaceId, workspacePath, baseXml, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
    expect(result.driftCount).toBe(0);
    expect(findProductBySku(sku)?.syncStatus).toBe('not_synced');
  });
});
