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
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import {
  freezeBulkSelection,
  approveBulkSelection,
  TRUST_REMOTE_SCOPE,
} from '../../shopsite/drift-bulk-service';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { listDrift } from '../../db/repositories/drift-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
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

function resetToBaseline(): void {
  const db = getDb();
  try {
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    for (const p of decoded.products) {
      writeProductFile(workspacePath, p);
    }
  } catch { /* ok */ }
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
  try {
    commitAll('Reset to baseline for #270');
  } catch { /* empty ok */ }
  detect(BASE_XML);
  try { db.run('DELETE FROM remote_drift WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
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
});
