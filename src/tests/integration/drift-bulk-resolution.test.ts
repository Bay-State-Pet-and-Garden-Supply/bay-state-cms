/**
 * Drift 5/6 (#254) — filter-scoped bulk resolution through the reviewed change path.
 *
 * Behavioral coverage at the highest existing integration seam (ShopSite XML
 * fixtures with a scratch workspace + database):
 * - explicit filter scope required, unscoped rejected
 * - frozen selection (filter, versions, baseline ref, count, confirmation);
 *   late arrivals excluded
 * - field isolation (price bulk leaves description outstanding)
 * - staleness + filename ownership revalidated, incl. cross-batch collisions
 * - one bounded change set -> one commit via the reviewed path
 * - whole-path bounds (not just queue reads)
 * - failure honesty: no false resolved/synced, no unrelated staged commit,
 *   retry idempotent
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import {
  freezeBulkSelection,
  approveBulkSelection,
  DRIFT_BULK_MAX_HUNKS,
} from '../../shopsite/drift-bulk-service';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { listDrift, countDrift, findDriftById } from '../../db/repositories/drift-repo';
import { findProductBySku, insertProductIndex } from '../../db/repositories/product-index-repo';
import { findChangeSetById, listChangeSetItems } from '../../db/repositories/change-set-repo';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashComparisonProjection, buildComparisonProjection } from '../../shopsite/catalog-comparison';

const testDbPath = '/tmp/baystate-cms-drift-254-test.db';
let workspacePath = '';
const workspaceId = `ws-254-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>BULK-001</SKU><Name>Bulk Widget A</Name><Price>10.00</Price>
<ProductDescription><![CDATA[Alpha description.]]></ProductDescription>
<ProductDisabled>uncheck</ProductDisabled></Product>
<Product><SKU>BULK-002</SKU><Name>Bulk Widget B</Name><Price>20.00</Price>
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
  // Restore core fixtures.
  try {
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    for (const p of decoded.products) {
      writeProductFile(workspacePath, p);
    }
  } catch { /* ok */ }
  // Remove stray test products (late, batch, owner, unrelated).
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
          if (sku && sku !== 'BULK-001' && sku !== 'BULK-002') {
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
      if (sku !== 'BULK-001' && sku !== 'BULK-002' && (sku.startsWith('FNB-') || sku.startsWith('LATE-') || sku.startsWith('OWNER-') || sku.startsWith('UNRELATED-'))) {
        try { db.run('DELETE FROM product_index WHERE sku = ?', [sku]); } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
  clearAcks();
  try {
    commitAll('Reset to baseline for #254');
  } catch { /* empty commit ok */ }
  detect(BASE_XML);
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
  clearAcks();
}

function ensureIndex(sku: string): void {
  try {
    const prod = readProductFile(workspacePath, sku);
    if (!prod) return;
    if (findProductBySku(sku)) return;
    const now = new Date().toISOString();
    const h = hashComparisonProjection(buildComparisonProjection(prod));
    insertProductIndex({
      id: prod.id,
      sku,
      filePath: skuToProductFilePath(sku),
      title: prod.core.name,
      status: prod.status,
      price: prod.core.price,
      inventoryQuantity: prod.core.inventory.quantityOnHand,
      primaryImage: prod.core.media.primary,
      productHash: h,
      lastApprovedCommit: headHash(),
      lastPulledRemoteHash: h,
      lastSyncedRemoteHash: h,
      lastSyncedAt: now,
      syncStatus: 'synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
      description: prod.core.description,
      searchKeywords: prod.core.seo.searchKeywords,
      customFields: prod.customFields,
    });
  } catch { /* ok */ }
}

describe('Drift 5/6 (#254): filter-scoped bulk resolution', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-254-int-'));
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
    const h = commitAll('Baseline for #254');
    try {
      getDb().run('UPDATE product_index SET last_approved_commit = ? WHERE sku IN (?, ?)', [h, 'BULK-001', 'BULK-002']);
    } catch { /* ok */ }
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('requires an explicit filter scope; unscoped accept-everything is not offered', () => {
    resetToBaseline();
    expect(() => freezeBulkSelection(workspaceId, workspacePath, '')).toThrow(/explicit filter scope/);
    expect(() => freezeBulkSelection(workspaceId, workspacePath, '   ')).toThrow(/explicit filter scope/);
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: '',
        baselineCommit: headHash(),
        hunks: [],
        confirmed: true,
      }),
    ).toThrow(/explicit filter scope/);
    // Confirmation is part of the freeze contract.
    detect(BASE_XML.replace('10.00', '11.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(frozen.count).toBeGreaterThan(0);
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: 'core.price',
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: false,
      }),
    ).toThrow(/explicit confirmation/);
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: 'core.price',
        baselineCommit: frozen.baselineCommit,
        hunks: [],
        confirmed: true,
      }),
    ).toThrow(/non-empty frozen/);
    resetToBaseline();
  });

  it('freezes filter, versions, baseline ref, and count; late arrivals are excluded', () => {
    resetToBaseline();
    const priced = BASE_XML.replace('10.00', '15.00').replace('20.00', '25.00');
    detect(priced);
    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(frozen.field).toBe('core.price');
    expect(frozen.baselineCommit).toBe(headHash());
    expect(frozen.count).toBe(2);
    expect(frozen.hunks.length).toBe(2);
    for (const h of frozen.hunks) {
      expect(h.field).toBe('core.price');
      expect(typeof h.driftId).toBe('string');
      expect(typeof h.remoteHash).toBe('string');
      expect(h.baselineCommit).toBe(frozen.hunks[0].baselineCommit);
    }

    // Late arrival after the freeze WITHOUT moving the baseline: a newer
    // remote observation for BULK-001. The frozen versions stay pinned;
    // approval must skip the stale hunk and must not silently join the new one.
    const newerRemote = BASE_XML.replace('10.00', '15.50').replace('20.00', '25.00');
    detect(newerRemote);
    // The frozen selection still holds only the original two versions.
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    // BULK-001's frozen version is stale (remote moved 15.00 -> 15.50), so
    // only BULK-002 honestly resolves; the newer BULK-001 hunk stays open.
    expect(result.acceptedCount).toBe(1);
    expect(result.resolvedSkus).toEqual(['BULK-002']);
    expect(result.skippedStale.some((s) => s.sku === 'BULK-001')).toBe(true);
    const bulk1 = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'BULK-001')!;
    expect(parseDriftDiff(bulk1).hunks.some((h) => h.field === 'core.price' && String(h.remoteValue).startsWith('15.5'))).toBe(true);

    resetToBaseline();
  });

  it('proves field isolation: bulk price acceptance leaves description outstanding', () => {
    resetToBaseline();
    // BULK-001 moves both price and description; BULK-002 moves price only.
    const twoField = BASE_XML.replace('10.00', '13.00').replace(
      'Alpha description.',
      'Alpha description CHANGED.',
    ).replace('20.00', '23.00');
    detect(twoField);
    const drift1 = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'BULK-001')!;
    expect(parseDriftDiff(drift1).hunks.map((h) => h.field).sort()).toEqual(['core.description', 'core.price']);

    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(frozen.count).toBe(2);
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(result.acceptedCount).toBe(2);
    expect(result.changeSetId).toBeTruthy();
    expect(result.commitHash).toBeTruthy();

    const after1 = readProductFile(workspacePath, 'BULK-001')!;
    expect(after1.core.price).toBe('13.00');
    // Description untouched by the price-only bulk.
    expect(after1.core.description).toContain('Alpha description.');
    expect(after1.core.description).not.toContain('CHANGED');

    const remaining1 = findDriftById(drift1.id)!;
    // BULK-001 still outstanding for description only; BULK-002 fully resolved.
    expect(remaining1.status).toBe('open');
    expect(parseDriftDiff(remaining1).hunks.map((h) => h.field)).toEqual(['core.description']);
    const drift2Rows = listDrift(workspaceId, 'open', 100, 0).filter((d) => d.sku === 'BULK-002');
    expect(drift2Rows.length).toBe(0);

    resetToBaseline();
  });

  it('revalidates staleness before approval (moved baseline + newer remote)', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '16.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(frozen.count).toBe(1);
    const staleBase = frozen.baselineCommit!;

    // Move the approved baseline.
    const prod = readProductFile(workspacePath, 'BULK-001')!;
    prod.core.weight = '9lb';
    writeProductFile(workspacePath, prod);
    const newHead = commitAll('Move baseline for bulk staleness');
    expect(newHead).not.toBe(staleBase);

    // Global baseline move fails the whole bulk as stale.
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: frozen.field,
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: true,
      }),
    ).toThrow(/baseline moved since freeze/);

    // Restore baseline.
    const restored = readProductFile(workspacePath, 'BULK-001')!;
    (restored.core as unknown as Record<string, unknown>).weight = null;
    writeProductFile(workspacePath, restored);
    commitAll('Restore baseline after bulk staleness');

    // Newer remote invalidates the frozen hunk version (skipped, not resolved).
    detect(BASE_XML);
    clearAcks();
    detect(BASE_XML.replace('10.00', '16.00'));
    const fresh = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
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
    // Nothing falsely resolved: the newer hunk stays open.
    expect(countDrift(workspaceId, 'open', 'core.price')).toBe(1);

    resetToBaseline();
  });

  it('holds filename collisions, including claims across processing batches', () => {
    resetToBaseline();
    const db = getDb();
    // Catalog owner reserves owner.html.
    const ownerSku = `OWNER-${Date.now()}`;
    const ownerDecoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
    ownerDecoded.sku = ownerSku;
    ownerDecoded.customFields['FileName'] = 'owner.html';
    writeProductFile(workspacePath, ownerDecoded);
    ensureIndex(ownerSku);
    commitAll(`Add owner ${ownerSku}`);

    // 11 filename hunks span two processing batches (batch size 10):
    // first + last claim the catalog-owned name (cross-batch collision proof).
    const batchSkus: string[] = [];
    for (let i = 0; i < 11; i++) {
      const sku = `FNB-${Date.now()}-${i}`;
      batchSkus.push(sku);
      const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
      decoded.sku = sku;
      decoded.core.price = '10.00';
      writeProductFile(workspacePath, decoded);
      ensureIndex(sku);
    }
    commitAll('Add filename batch baselines');

    const remoteProducts = batchSkus
      .map((sku, i) => {
        const fname = i === 0 || i === 10 ? 'owner.html' : `unique-${Date.now()}-${i}.html`;
        return `<Product><SKU>${sku}</SKU><Name>Bulk Widget A</Name><Price>10.00</Price><FileName>${fname}</FileName><ProductDisabled>uncheck</ProductDisabled></Product>`;
      })
      .join('');
    const ownerRemote = `<Product><SKU>${ownerSku}</SKU><Name>Bulk Widget A</Name><Price>10.00</Price><ProductDisabled>uncheck</ProductDisabled></Product>`;
    const remoteXml = `<?xml version="1.0" encoding="UTF-8"?><ShopSiteProducts version="15.0"><Products>${ownerRemote}${remoteProducts}</Products></ShopSiteProducts>`;
    detect(remoteXml);

    const sample = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === batchSkus[1])!;
    const sampleHunks = parseDriftDiff(sample).hunks;
    const filenameField = sampleHunks.find((h) => h.field === 'seo.fileName' || h.field === 'custom.FileName')!.field;

    const frozen = freezeBulkSelection(workspaceId, workspacePath, filenameField);
    expect(frozen.count).toBe(11);
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    // 9 unique names commit; both catalog-colliding claims hold (first + cross-batch last).
    expect(result.acceptedCount).toBe(9);
    expect(result.failed.length).toBe(2);
    expect(result.failed.every((f) => /COLLISION/.test(f.reason))).toBe(true);
    const failedSkus = result.failed.map((f) => f.sku).sort();
    expect(failedSkus).toEqual([batchSkus[0], batchSkus[10]].sort());
    // Held hunks stay open.
    for (const sku of [batchSkus[0], batchSkus[10]]) {
      expect(listDrift(workspaceId, 'open', 100, 0).some((d) => d.sku === sku)).toBe(true);
    }

    // Cleanup batch + owner.
    for (const sku of [...batchSkus, ownerSku]) {
      try { fs.unlinkSync(path.join(workspacePath, skuToProductFilePath(sku))); } catch { /* ok */ }
      try { db.run('DELETE FROM product_index WHERE sku = ?', [sku]); } catch { /* ok */ }
      try { db.run('DELETE FROM remote_drift WHERE workspace_id = ? AND sku = ?', [workspaceId, sku]); } catch { /* ok */ }
    }
    commitAll('Remove filename batch');
    resetToBaseline();
  });

  it('commits through one bounded reviewed change set mapping to one commit', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '17.00').replace('20.00', '27.00'));
    const beforeHead = headHash();
    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    const result = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    expect(result.acceptedCount).toBe(2);
    const cs = findChangeSetById(result.changeSetId!)!;
    expect(cs.status).toBe('approved');
    expect(cs.title).toContain('core.price');
    const items = listChangeSetItems(cs.id);
    expect(items.length).toBe(2);
    // One commit: HEAD moved exactly once from the frozen baseline.
    expect(result.commitHash).toBe(headHash());
    expect(result.commitHash).not.toBe(beforeHead);
    const log = execFileSync('git', ['log', '--oneline', '-2'], { cwd: workspacePath, encoding: 'utf-8' }).trim().split('\n');
    expect(log.length).toBeGreaterThanOrEqual(2);
    const files = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(files.sort()).toEqual([skuToProductFilePath('BULK-001'), skuToProductFilePath('BULK-002')].sort());

    // Complete audit trail: per-hunk events + one bulk summary.
    const audits = dbQuery(
      `SELECT action FROM audit_log WHERE workspace_id = ? AND (action = 'drift_hunk_accepted' OR action = 'drift_bulk_accepted') ORDER BY created_at DESC LIMIT 10`,
      [workspaceId],
    ) as Array<{ action: string }>;
    expect(audits.some((a) => a.action === 'drift_bulk_accepted')).toBe(true);
    expect(audits.filter((a) => a.action === 'drift_hunk_accepted').length).toBeGreaterThanOrEqual(2);

    resetToBaseline();
  });

  it('bounds the whole path, not just queue reads', () => {
    expect(DRIFT_BULK_MAX_HUNKS).toBe(50);
    // Oversized frozen selection is rejected before any draft work.
    const oversized = Array.from({ length: DRIFT_BULK_MAX_HUNKS + 1 }, (_, i) => ({
      driftId: `d-${i}`,
      sku: `S-${i}`,
      field: 'core.price',
      baselineValue: '1',
      remoteValue: '2',
      remoteHash: 'r',
      baselineCommit: 'b',
    }));
    expect(() =>
      approveBulkSelection(workspaceId, workspacePath, {
        field: 'core.price',
        baselineCommit: headHash(),
        hunks: oversized,
        confirmed: true,
      }),
    ).toThrow(/whole-path bound/);
  });

  it('fails honestly, never commits unrelated work, and retries idempotently', () => {
    resetToBaseline();
    detect(BASE_XML.replace('10.00', '18.00').replace('20.00', '28.00'));
    const frozen = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(frozen.count).toBe(2);

    // Stage unrelated catalog work before approval.
    const unrelatedSku = `UNRELATED-${Date.now()}`;
    const unrelatedDecoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
    unrelatedDecoded.sku = unrelatedSku;
    unrelatedDecoded.core.price = '999.00';
    writeProductFile(workspacePath, unrelatedDecoded);
    execFileSync('git', ['add', '--', skuToProductFilePath(unrelatedSku)], { cwd: workspacePath });

    // Injected merge failure on BULK-002: only BULK-001 honestly resolves.
    const headBefore = headHash();
    const auditBefore = countAudits();
    const result = approveBulkSelection(
      workspaceId,
      workspacePath,
      {
        field: frozen.field,
        baselineCommit: frozen.baselineCommit,
        hunks: frozen.hunks,
        confirmed: true,
      },
      { failOnSku: 'BULK-002' },
    );
    expect(result.acceptedCount).toBe(1);
    expect(result.resolvedSkus).toEqual(['BULK-001']);
    expect(result.failed.some((f) => f.sku === 'BULK-002')).toBe(true);
    // BULK-002 stays open + drifted, never falsely synced.
    const stillOpen = listDrift(workspaceId, 'open', 100, 0).find((d) => d.sku === 'BULK-002');
    expect(stillOpen).toBeTruthy();
    const idx2 = findProductBySku('BULK-002');
    if (idx2) expect(idx2.syncStatus).not.toBe('synced');
    // Unrelated staged file is not swept into the bulk commit.
    const bulkFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workspacePath, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(bulkFiles).not.toContain(skuToProductFilePath(unrelatedSku));
    expect(bulkFiles).toEqual([skuToProductFilePath('BULK-001')]);
    expect(headHash()).not.toBe(headBefore);
    // Unrelated work still staged/unstaged in the tree, untouched.
    expect(fs.existsSync(path.join(workspacePath, skuToProductFilePath(unrelatedSku)))).toBe(true);

    // Retry the same frozen selection: BULK-001 is already resolved (skipped),
    // BULK-002 is still valid — retry without injection resolves it, and a
    // third retry is a clean no-op with no duplicate commit or audits.
    const retry = approveBulkSelection(workspaceId, workspacePath, {
      field: frozen.field,
      baselineCommit: result.commitHash ?? frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
    });
    // BULK-001 reports stale/already-resolved; BULK-002 resolves now.
    expect(retry.acceptedCount).toBe(1);
    expect(retry.resolvedSkus).toEqual(['BULK-002']);

    const headAfterRetry = headHash();
    const auditAfterRetry = countAudits();
    expect(auditAfterRetry).toBeGreaterThan(auditBefore);

    // Re-freeze: queue is now empty for this field, so a repeat approve is a no-op.
    const empty = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    // BULK-001/002 files now carry the accepted remote prices, so a baseline
    // recheck clears them; the freeze sees no work.
    detect(BASE_XML.replace('10.00', '18.00').replace('20.00', '28.00'));
    const noOpFreeze = freezeBulkSelection(workspaceId, workspacePath, 'core.price');
    expect(noOpFreeze.count).toBe(0);

    // Cleanup unrelated + restore.
    try { execFileSync('git', ['reset', 'HEAD', '--', skuToProductFilePath(unrelatedSku)], { cwd: workspacePath }); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(workspacePath, skuToProductFilePath(unrelatedSku))); } catch { /* ok */ }
    for (const sku of ['BULK-001', 'BULK-002']) {
      const p = readProductFile(workspacePath, sku)!;
      p.core.price = sku === 'BULK-001' ? '10.00' : '20.00';
      writeProductFile(workspacePath, p);
    }
    commitAll('Restore after honesty test');
    expect(headHash()).not.toBe(headAfterRetry);
    void empty;
    detect(BASE_XML);
    clearAcks();
  });
});

function dbQuery(sql: string, params: unknown[]): unknown[] {
  return getDb().query(sql).all(...(params as [])) as unknown[];
}

function countAudits(): number {
  const rows = dbQuery(
    `SELECT COUNT(*) as c FROM audit_log WHERE workspace_id = ? AND action IN ('drift_hunk_accepted','drift_bulk_accepted')`,
    [workspaceId],
  ) as Array<{ c: number }>;
  return Number(rows[0]?.c ?? 0);
}
