/**
 * Drift trust-remote (#270) — explicit all-eligible-fields bulk accept.
 *
 * Behavioral coverage at the bulk service seam:
 * - "*" is an explicit scope; bare scope still fails
 * - freeze "*" collects multi-field hunks with versions + baseline ref
 * - approve "*" merges every eligible field per SKU into one draft/commit
 * - new products stay held, never auto-imported
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import app from '../../server/app';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import {
  freezeBulkSelection,
  approveBulkSelection,
  TRUST_REMOTE_SCOPE,
} from '../../shopsite/drift-bulk-service';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { createReconcileChangeSet } from '../../shopsite/drift-reconcile-service';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { listDrift, findDriftById } from '../../db/repositories/drift-repo';
import { insertProductIndex, findProductBySku } from '../../db/repositories/product-index-repo';
import { findChangeSetById, listChangeSetItems } from '../../db/repositories/change-set-repo';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashComparisonProjection, buildComparisonProjection } from '../../shopsite/catalog-comparison';

const testDbPath = '/tmp/baystate-cms-drift-270-test.db';
let workspacePath = '';
const workspaceId = `ws-270-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>TR-001</SKU><Name>Trust Widget A</Name><Price>10.00</Price>
<ProductDescription><![CDATA[Alpha description.]]></ProductDescription>
<ProductDisabled>uncheck</ProductDisabled></Product>
<Product><SKU>TR-002</SKU><Name>Trust Widget B</Name><Price>20.00</Price>
<ProductDescription><![CDATA[Beta description.]]></ProductDescription>
<ProductDisabled>uncheck</ProductDisabled></Product>
</Products></ShopSiteProducts>`;

function commitAll(message: string): string {
  const git = new GitClient(workspacePath);
  git.add(['products/', '.gitignore']);
  git.commit(message);
  return git.getHeadHash();
}

function headHash(): string {
  return new GitClient(workspacePath).getHeadHash();
}

function detect(xml: string) {
  return detectDrift(workspaceId, workspacePath, xml, {
    resolvePageIdentity: () => null,
    pageImportHash: null,
  });
}

function clearAcks(): void {
  try {
    getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]);
  } catch { /* ok */ }
}

function resetToBaseline(): void {
  const db = getDb();
  try {
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    for (const p of decoded.products) {
      writeProductFile(workspacePath, p);
    }
  } catch { /* ok */ }
  try {
    const dir = path.join(workspacePath, 'products');
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) out.push(...walk(full));
        else if (e.name.endsWith('.json')) out.push(full);
      }
      return out;
    };
    if (fs.existsSync(dir)) {
      for (const f of walk(dir)) {
        try {
          const prod = JSON.parse(fs.readFileSync(f, 'utf-8')) as { sku?: string };
          const sku = String(prod.sku ?? '');
          if (sku && sku !== 'TR-001' && sku !== 'TR-002') {
            fs.unlinkSync(f);
          }
        } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  try {
    const rows = db.query(`SELECT sku FROM product_index`).all() as Array<{ sku: string }>;
    for (const r of rows) {
      const sku = String(r.sku);
      if (sku !== 'TR-001' && sku !== 'TR-002') {
        try { db.run('DELETE FROM product_index WHERE sku = ?', [sku]); } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
  clearAcks();
  try {
    commitAll('Reset to baseline for #270');
  } catch { /* empty ok */ }
  detect(BASE_XML);
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
  clearAcks();
}

describe('Drift trust-remote (#270)', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-270-int-'));
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
    for (const p of decoded.products) {
      writeProductFile(workspacePath, p);
      try {
        const now2 = new Date().toISOString();
        const h = hashComparisonProjection(buildComparisonProjection(p));
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
          lastApprovedCommit: null,
          lastPulledRemoteHash: h,
          lastSyncedRemoteHash: h,
          lastSyncedAt: now2,
          syncStatus: 'synced',
          hasAdvancedBlocks: 0,
          hasWarnings: 0,
          createdAt: now2,
          updatedAt: now2,
          description: p.core.description,
          searchKeywords: p.core.seo.searchKeywords,
          customFields: p.customFields,
        });
      } catch { /* ok */ }
    }
    commitAll('Baseline for #270');
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('requires explicit scope; "*" is accepted, bare scope fails', () => {
    resetToBaseline();
    expect(TRUST_REMOTE_SCOPE).toBe('*');
    expect(() => freezeBulkSelection(workspaceId, workspacePath, '')).toThrow(/explicit/);
    expect(() => freezeBulkSelection(workspaceId, workspacePath, '   ')).toThrow(/explicit/);
    detect(BASE_XML.replace('10.00', '11.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.field).toBe('*');
    expect(frozen.count).toBeGreaterThan(0);
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: '*',
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: false,
      }),
    ).toThrow(/explicit confirmation/);
    resetToBaseline();
  });

  it('merges every eligible field per product into one draft and one commit', () => {
    resetToBaseline();
    const twoField = BASE_XML.replace('10.00', '13.00')
      .replace('Alpha description.', 'Alpha description CHANGED.')
      .replace('20.00', '23.00');
    detect(twoField);
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    // TR-001 price + description, TR-002 price only.
    expect(frozen.count).toBe(3);
    expect(new Set(frozen.hunks.map((h) => h.field))).toEqual(new Set(['core.price', 'core.description']));

    const beforeHead = headHash();
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(result.field).toBe('*');
    expect(result.acceptedCount).toBe(3);
    expect(result.resolvedSkus.sort()).toEqual(['TR-001', 'TR-002']);
    expect(result.changeSetId).toBeTruthy();
    expect(result.commitHash).toBeTruthy();
    expect(result.commitHash).not.toBe(beforeHead);

    // One bounded change set with one item per product (not per hunk).
    const cs = findChangeSetById(result.changeSetId!)!;
    expect(cs.status).toBe('approved');
    expect(listChangeSetItems(cs.id).length).toBe(2);

    // Both eligible fields moved for TR-001.
    const after1 = readProductFile(workspacePath, 'TR-001')!;
    expect(after1.core.price).toBe('13.00');
    expect(after1.core.description).toContain('CHANGED');
    const after2 = readProductFile(workspacePath, 'TR-002')!;
    expect(after2.core.price).toBe('23.00');

    // Queue converged; one commit touched exactly both product files.
    const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' })
      .trim().split('\n').map((s) => s.trim()).filter(Boolean);
    expect(files.sort()).toEqual([skuToProductFilePath('TR-001'), skuToProductFilePath('TR-002')].sort());

    const audits = getDb().query(
      `SELECT action FROM audit_log WHERE workspace_id = ? AND action IN ('drift_hunk_accepted','drift_bulk_accepted') ORDER BY created_at DESC LIMIT 10`,
    ).all(workspaceId) as Array<{ action: string }>;
    expect(audits.filter((a) => a.action === 'drift_hunk_accepted').length).toBeGreaterThanOrEqual(3);
    expect(audits.some((a) => a.action === 'drift_bulk_accepted')).toBe(true);
    resetToBaseline();
  });

  it('holds new remote products; they never auto-import', () => {
    resetToBaseline();
    const withNew = BASE_XML.replace(
      '</Products>',
      '<Product><SKU>TR-NEW</SKU><Name>Brand New</Name><Price>99.00</Price><ProductDisabled>uncheck</ProductDisabled></Product></Products>',
    ).replace('10.00', '14.00');
    detect(withNew);
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    // Only the eligible TR-001 price hunk freezes; the new product holds.
    expect(frozen.hunks.every((h) => h.sku !== 'TR-NEW')).toBe(true);
    expect(frozen.heldSkipped).toBeGreaterThanOrEqual(1);
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(result.resolvedSkus).toContain('TR-001');
    expect(result.resolvedSkus).not.toContain('TR-NEW');
    // New-product drift stays outstanding.
    expect(listDrift(workspaceId, 'open', 100, 0).some((d) => d.sku === 'TR-NEW')).toBe(true);
    const newRow = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'TR-NEW')!;
    expect(parseDriftDiff(newRow).hunks.length).toBeGreaterThan(0);
    resetToBaseline();
  });

  it('holds unverified page assignments; eligible fields still merge', () => {
    resetToBaseline();
    const baselinePages = readProductFile(workspacePath, 'TR-001')!.core.productOnPages ?? [];
    // One verified page add (eligible) plus one unverified add (held) plus a
    // price change on the same row: the page merge must not ship wholesale.
    const withPages = BASE_XML.replace('10.00', '15.00').replace(
      '</Product>',
      '<ProductOnPages><PageLink><Name>Verified Page</Name></PageLink><PageLink><Name>Unverified Page</Name></PageLink></ProductOnPages></Product>',
    );
    detectDrift(workspaceId, workspacePath, withPages, {
      resolvePageIdentity: (name: string) => (name === 'Verified Page' ? 'id:verified-1' : null),
      pageImportHash: null,
    });
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    // Price hunks freeze; the unverified page hunk holds (verified page may freeze).
    expect(frozen.hunks.some((h) => h.field === 'core.price')).toBe(true);
    expect(frozen.hunks.every((h) => !(h.field === 'core.productOnPages' && (h.remoteValue ?? '').startsWith('name:')))).toBe(true);
    expect(frozen.heldSkipped).toBeGreaterThanOrEqual(1);
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    // Eligible price still merged.
    expect(result.field).toBe('*');
    expect(readProductFile(workspacePath, 'TR-001')!.core.price).toBe('15.00');
    // Held page never shipped wholesale: no new page names in the file.
    const afterPages = readProductFile(workspacePath, 'TR-001')!.core.productOnPages ?? [];
    expect(afterPages).toEqual(baselinePages);
    // Page hunks stay outstanding (row stays open while price converged).
    const remaining = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'TR-001');
    expect(remaining).toBeTruthy();
    expect(parseDriftDiff(remaining!).hunks.some((h) => h.field === 'core.productOnPages')).toBe(true);
    resetToBaseline();
  });

  it('holds reconcile-linked fields while unrelated fields on the same product stay eligible', () => {
    resetToBaseline();
    // TR-001 changes both price and description.
    const twoField = BASE_XML.replace('10.00', '16.00').replace(
      'Alpha description.',
      'Alpha description RECONCILE.',
    );
    detect(twoField);
    const drift = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'TR-001')!;
    expect(parseDriftDiff(drift).hunks.length).toBe(2);

    // Link TR-001 into reconcile for price only.
    const rec = createReconcileChangeSet(workspaceId, workspacePath, {
      driftId: drift.id,
      fields: ['core.price'],
      actor: workspaceId,
    });
    expect(rec.fields).toEqual(['core.price']);
    const linked = findDriftById(drift.id)!;
    expect(linked.status).toBe('in_reconcile');

    // Freeze '*': price is held due to in_reconcile; description is frozen.
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.hunks.some((h) => h.sku === 'TR-001' && h.field === 'core.description')).toBe(true);
    expect(frozen.hunks.every((h) => !(h.sku === 'TR-001' && h.field === 'core.price'))).toBe(true);
    expect(frozen.heldSkipped).toBeGreaterThanOrEqual(1);

    // Approve '*': description merges into TR-001, price stays in reconcile.
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(result.resolvedSkus).toContain('TR-001');
    const after = readProductFile(workspacePath, 'TR-001')!;
    expect(after.core.description).toContain('RECONCILE');
    expect(after.core.price).toBe('10.00'); // price untouched

    // TR-001 still in_reconcile with price hunk remaining.
    const still = findDriftById(drift.id)!;
    expect(still.status).toBe('in_reconcile');
    expect(parseDriftDiff(still).hunks.map((h) => h.field)).toEqual(['core.price']);

    resetToBaseline();
  });

  it('holds filename collisions, including claims across processing batches', () => {
    resetToBaseline();
    const ownerSku = `OWNER-${Date.now()}`;
    const ownerDecoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
    ownerDecoded.sku = ownerSku;
    ownerDecoded.customFields['FileName'] = 'owner.html';
    writeProductFile(workspacePath, ownerDecoded);
    insertProductIndex({
      id: ownerDecoded.id,
      sku: ownerSku,
      filePath: skuToProductFilePath(ownerSku),
      title: ownerDecoded.core.name,
      status: ownerDecoded.status,
      price: ownerDecoded.core.price,
      inventoryQuantity: ownerDecoded.core.inventory.quantityOnHand,
      primaryImage: ownerDecoded.core.media.primary,
      productHash: hashComparisonProjection(buildComparisonProjection(ownerDecoded)),
      lastApprovedCommit: headHash(),
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      description: ownerDecoded.core.description,
      searchKeywords: ownerDecoded.core.seo.searchKeywords,
      customFields: ownerDecoded.customFields,
    });
    commitAll(`Add owner ${ownerSku}`);

    // 11 filename hunks spanning two batches: first and last collide with owner.html
    const batchSkus: string[] = [];
    for (let i = 0; i < 11; i++) {
      const sku = `FNB-${Date.now()}-${i}`;
      batchSkus.push(sku);
      const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
      decoded.sku = sku;
      decoded.core.price = '10.00';
      writeProductFile(workspacePath, decoded);
      insertProductIndex({
        id: decoded.id,
        sku,
        filePath: skuToProductFilePath(sku),
        title: decoded.core.name,
        status: decoded.status,
        price: decoded.core.price,
        inventoryQuantity: decoded.core.inventory.quantityOnHand,
        primaryImage: decoded.core.media.primary,
        productHash: hashComparisonProjection(buildComparisonProjection(decoded)),
        lastApprovedCommit: headHash(),
        lastPulledRemoteHash: null,
        lastSyncedRemoteHash: null,
        lastSyncedAt: new Date().toISOString(),
        syncStatus: 'synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        description: decoded.core.description,
        searchKeywords: decoded.core.seo.searchKeywords,
        customFields: decoded.customFields,
      });
    }
    commitAll('Add filename batch baselines');

    const remoteProducts = batchSkus
      .map((sku, i) => {
        const fname = i === 0 || i === 10 ? 'owner.html' : `unique-${Date.now()}-${i}.html`;
        return `<Product><SKU>${sku}</SKU><Name>Trust Widget A</Name><Price>10.00</Price><ProductDescription><![CDATA[Alpha description.]]></ProductDescription><FileName>${fname}</FileName><ProductDisabled>uncheck</ProductDisabled></Product>`;
      })
      .join('');
    const remoteXml = `<?xml version="1.0" encoding="UTF-8"?><ShopSiteProducts version="15.0"><Products>${remoteProducts}</Products></ShopSiteProducts>`;
    detect(remoteXml);

    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.count).toBe(11);
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    // 9 unique commit; 2 colliding hold
    expect(result.acceptedCount).toBe(9);
    expect(result.failed.length).toBe(2);
    expect(result.failed.every((f) => /COLLISION/.test(f.reason))).toBe(true);
    expect(result.failed.map((f) => f.sku).sort()).toEqual([batchSkus[0], batchSkus[10]].sort());

    resetToBaseline();
  });

  it('revalidates staleness before approval (moved baseline + newer remote)', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '17.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.count).toBe(1);
    const staleBase = frozen.baselineCommit!;

    // Move baseline by modifying TR-001 weight and committing
    const prod = readProductFile(workspacePath, 'TR-001')!;
    prod.core.weight = '5lb';
    writeProductFile(workspacePath, prod);
    const newHead = commitAll('Move baseline for trust-remote staleness');
    expect(newHead).not.toBe(staleBase);

    // Global baseline move fails with 409
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: frozen.field,
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: true,
      }),
    ).toThrow(/baseline moved since freeze/);

    // Restore baseline
    const restored = readProductFile(workspacePath, 'TR-001')!;
    (restored.core as unknown as Record<string, unknown>).weight = null;
    writeProductFile(workspacePath, restored);
    commitAll('Restore baseline');

    // Newer remote skips as stale, not resolved
    detect(BASE_XML);
    clearAcks();
    detect(BASE_XML.replace('10.00', '17.00'));
    const fresh = freezeBulkSelection(workspaceId, workspacePath, '*');
    detect(BASE_XML.replace('10.00', '19.00'));
    const res = approveBulkSelection(workspaceId, workspacePath, {
      field: fresh.field,
      baselineCommit: fresh.baselineCommit,
      hunks: fresh.hunks,
      confirmed: true,
    });
    expect(res.acceptedCount).toBe(0);
    expect(res.changeSetId).toBeNull();
    expect(res.commitHash).toBeNull();
    expect(res.skippedStale.length).toBe(1);

    resetToBaseline();
  });

  it('leaves unrelated staged files uncommitted and retries idempotently', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '18.00').replace('20.00', '28.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.count).toBe(2);

    // Stage unrelated product file
    const unrelatedSku = `UNRELATED-${Date.now()}`;
    const unrelatedDecoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
    unrelatedDecoded.sku = unrelatedSku;
    unrelatedDecoded.core.price = '999.00';
    writeProductFile(workspacePath, unrelatedDecoded);
    execFileSync('git', ['add', '--', skuToProductFilePath(unrelatedSku)], { cwd: workspacePath });

    // Inject failure on TR-002: only TR-001 resolves
    const headBefore = headHash();
    const result = approveBulkSelection(
      workspaceId,
      workspacePath,
      {
        field: frozen.field,
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: true,
      },
      { failOnSku: 'TR-002' },
    );
    expect(result.acceptedCount).toBe(1);
    expect(result.resolvedSkus).toEqual(['TR-001']);
    expect(result.failed.some((f) => f.sku === 'TR-002')).toBe(true);

    // Unrelated staged file is NOT committed
    const bulkFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' })
      .trim().split('\n').map((s) => s.trim()).filter(Boolean);
    expect(bulkFiles).not.toContain(skuToProductFilePath(unrelatedSku));
    expect(bulkFiles).toEqual([skuToProductFilePath('TR-001')]);
    expect(headHash()).not.toBe(headBefore);

    // Retry with same frozen selection: TR-001 is already resolved (skipped), TR-002 now resolves
    const retry = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: result.commitHash ?? frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(retry.acceptedCount).toBe(1);
    expect(retry.resolvedSkus).toEqual(['TR-002']);

    // Third retry is clean no-op
    const thirdRetry = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: retry.commitHash ?? frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(thirdRetry.acceptedCount).toBe(0);
    expect(thirdRetry.changeSetId).toBeNull();
    expect(thirdRetry.commitHash).toBeNull();

    // Clean up staged unrelated file
    try { execFileSync('git', ['reset', 'HEAD', '--', skuToProductFilePath(unrelatedSku)], { cwd: workspacePath }); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(workspacePath, skuToProductFilePath(unrelatedSku))); } catch { /* ok */ }
    resetToBaseline();
  });

  it('fails closed when change set validation blocks approval', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '18.50'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen.count).toBe(1);

    expect(() =>
      approveBulkSelection(
        workspaceId,
        workspacePath,
        {
          field: frozen.field,
          baselineCommit: frozen.baselineCommit,
          hunks: frozen.hunks,
          confirmed: true,
        },
        { failCommit: true },
      ),
    ).toThrow(/Injected commit failure/);

    // Queue stays open, no drift resolved
    const still = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'TR-001');
    expect(still).toBeTruthy();

    // Fail closed: product index never marked synced, working tree clean, file restored to baseline
    const pIndex = findProductBySku('TR-001');
    expect(pIndex?.syncStatus).not.toBe('synced');
    const diskProd = readProductFile(workspacePath, 'TR-001')!;
    expect(diskProd.core.price).toBe('10.00');
    const git = new GitClient(workspacePath);
    expect(git.status()).toBe('');

    resetToBaseline();
  });

  it('handles empty queue gracefully and skips unsupported fields with counts', () => {
    resetToBaseline();
    const empty = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(empty.count).toBe(0);
    expect(empty.hunks.length).toBe(0);
    expect(empty.heldSkipped).toBe(0);
    expect(empty.unsupportedSkipped).toBe(0);

    // Remote XML with SKU change creates a new product drift for the changed SKU
    const withSkuDrift = BASE_XML.replace('<SKU>TR-001</SKU>', '<SKU>TR-001-ALT</SKU>');
    detect(withSkuDrift);
    const frozen2 = freezeBulkSelection(workspaceId, workspacePath, '*');
    expect(frozen2.heldSkipped).toBeGreaterThanOrEqual(1);

    resetToBaseline();
  });

  it('exercises HTTP endpoints (/drift/bulk/preview, /drift/bulk/approve, /drift/bulk-resolve) with "*" scope', async () => {
    resetToBaseline();
    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.BAYSTATE_CMS_API_TOKEN) {
      authHeaders['Authorization'] = `Bearer ${process.env.BAYSTATE_CMS_API_TOKEN}`;
    }

    // 1. Preview endpoint
    // Bare scope fails 400
    const barePreview = await app.request('/api/drift/bulk/preview', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ field: '' }),
    });
    expect(barePreview.status).toBe(400);

    detect(BASE_XML.replace('10.00', '19.50').replace('20.00', '29.50'));

    // Preview with "*" succeeds
    const previewRes = await app.request('/api/drift/bulk/preview', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ field: '*' }),
    });
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as any;
    expect(previewData.success).toBe(true);
    expect(previewData.field).toBe('*');
    expect(previewData.count).toBe(2);
    expect(previewData.hunks.length).toBe(2);

    // 2. Approve endpoint
    // Unconfirmed fails 400
    const unconfirmedRes = await app.request('/api/drift/bulk/approve', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        field: '*',
        baselineCommit: previewData.baselineCommit,
        hunks: previewData.hunks,
        confirmed: false,
      }),
    });
    expect(unconfirmedRes.status).toBe(400);

    // Confirmed succeeds 200
    const approveRes = await app.request('/api/drift/bulk/approve', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        field: '*',
        baselineCommit: previewData.baselineCommit,
        hunks: previewData.hunks,
        confirmed: true,
      }),
    });
    expect(approveRes.status).toBe(200);
    const approveData = (await approveRes.json()) as any;
    expect(approveData.success).toBe(true);
    expect(approveData.acceptedCount).toBe(2);
    expect(approveData.resolvedSkus.sort()).toEqual(['TR-001', 'TR-002']);
    expect(approveData.commitHash).toBeTruthy();

    resetToBaseline();

    // 3. Single-step bulk-resolve endpoint
    // Bare scope fails 400
    const bareBulk = await app.request('/api/drift/bulk-resolve', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ field: '' }),
    });
    expect(bareBulk.status).toBe(400);

    // Empty queue returns 200 with resolvedCount: 0 and clear message
    const emptyBulk = await app.request('/api/drift/bulk-resolve', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ field: '*' }),
    });
    expect(emptyBulk.status).toBe(200);
    const emptyData = (await emptyBulk.json()) as any;
    expect(emptyData.success).toBe(true);
    expect(emptyData.resolvedCount).toBe(0);
    expect(emptyData.acceptedCount).toBe(0);
    expect(emptyData.resolvedSkus).toEqual([]);
    expect(emptyData.skippedStale).toEqual([]);
    expect(emptyData.skippedHeld).toEqual([]);
    expect(emptyData.failed).toEqual([]);
    expect(emptyData.message).toBe('No outstanding eligible hunks to resolve.');

    // Single-step with incoming changes
    detect(BASE_XML.replace('10.00', '19.99'));
    const bulkRes = await app.request('/api/drift/bulk-resolve', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ field: '*' }),
    });
    expect(bulkRes.status).toBe(200);
    const bulkData = (await bulkRes.json()) as any;
    expect(bulkData.success).toBe(true);
    expect(bulkData.acceptedCount).toBe(1);
    expect(bulkData.resolvedSkus).toEqual(['TR-001']);
    expect(bulkData.message).toContain('Bulk accepted trust-remote (*)');

    resetToBaseline();
  });
});
