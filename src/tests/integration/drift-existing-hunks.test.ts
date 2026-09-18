/**
 * Drift 4/6 (#253) — existing-product hunks end to end.
 *
 * Behavioral coverage at the highest existing integration seam (ShopSite XML
 * fixtures with a scratch workspace + database):
 * - field identity with before/after, one hunk per changed field
 * - group/filter by field in list operation
 * - explicit per-hunk decisions, no silent defaults
 * - single-field accept preserves unrelated fields + identity
 * - workspace-checked resolution
 * - rejection binds acknowledgement (no immediate recreation, no false sync)
 * - stale baseline / newer remote invalidates before apply
 * - filename-collision hold
 * - basic resolution audit
 * - new products / page assignments / reconcile stay visibly held
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import { expandDriftToHunks, resolveSingleHunk } from '../../shopsite/drift-hunk-service';
import { parseDriftDiff, applySingleFieldHunk } from '../../shopsite/drift-hunks';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  listDrift,
  countDrift,
  findDriftById,
  linkDriftToChangeSet,
  resolveDrift,
} from '../../db/repositories/drift-repo';
import { findProductBySku, insertProductIndex } from '../../db/repositories/product-index-repo';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashComparisonProjection, buildComparisonProjection as buildProj, diffComparisonProjections as diffProjs } from '../../shopsite/catalog-comparison';

const testDbPath = '/tmp/baystate-cms-drift-253-test.db';
let workspacePath = '';
const workspaceId = `ws-253-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>HUNK-001</SKU><Name>Hunk Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function commitAll(message: string): string {
  const git = new GitClient(workspacePath);
  git.add(['products/', '.gitignore']);
  git.commit(message);
  return git.getHeadHash();
}

function detect(xml: string) {
  return detectDrift(workspaceId, workspacePath, xml, {
    resolvePageIdentity: () => null,
    pageImportHash: null,
  });
}

describe('Drift 4/6 (#253): existing-product hunks', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-253-int-'));
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
    commitAll('Baseline for #253');
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('carries field identity with before/after; no finding without what changed', () => {
    const changed = BASE_XML.replace('19.99', '24.99');
    const result = detect(changed);
    expect(result.driftCount).toBe(1);
    const drift = result.drifts[0] ?? findDriftById(listDrift(workspaceId, 'open')[0].id)!;
    const parsed = parseDriftDiff(drift);
    expect(parsed.hunks.length).toBeGreaterThan(0);
    for (const h of parsed.hunks) {
      expect(typeof h.field).toBe('string');
      expect(h.field.length).toBeGreaterThan(0);
      // before/after are explicit (null allowed for add/remove, but present as keys)
      expect('baselineValue' in h).toBe(true);
      expect('remoteValue' in h).toBe(true);
    }
    // Cleanup for next tests: revert to baseline.
    detect(BASE_XML);
  });

  it('yields one hunk for one changed field; unchanged fields yield none', () => {
    detect(BASE_XML);
    const changed = BASE_XML.replace('19.99', '24.99');
    const result = detect(changed);
    expect(result.driftCount).toBe(1);
    const drift = result.drifts[0] ?? listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const parsed = parseDriftDiff(drift);
    expect(parsed.hunks).toEqual([
      { field: 'core.price', baselineValue: '19.99', remoteValue: '24.99' },
    ]);
    detect(BASE_XML);
  });

  it('supports two-field isolation: price + quantity yield two hunks', () => {
    detect(BASE_XML);
    const twoField = BASE_XML.replace('19.99', '24.99').replace(
      '<QuantityOnHand>10</QuantityOnHand>',
      '<QuantityOnHand>42</QuantityOnHand>',
    );
    const result = detect(twoField);
    const drift = result.drifts[0] ?? listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const parsed = parseDriftDiff(drift);
    const fields = parsed.hunks.map((h) => h.field).sort();
    expect(fields).toEqual(['core.price', 'core.quantityOnHand']);
    detect(BASE_XML);
  });

  it('filters and groups by field in the list operation', () => {
    detect(BASE_XML);
    const twoField = BASE_XML.replace('19.99', '24.99').replace(
      '<QuantityOnHand>10</QuantityOnHand>',
      '<QuantityOnHand>42</QuantityOnHand>',
    );
    detect(twoField);

    const priceOnly = listDrift(workspaceId, 'open', 100, 0, 'core.price');
    expect(priceOnly.length).toBe(1);
    expect(priceOnly[0].sku).toBe('HUNK-001');
    expect(countDrift(workspaceId, 'open', 'core.price')).toBe(1);

    const qtyOnly = listDrift(workspaceId, 'open', 100, 0, 'core.quantityOnHand');
    expect(qtyOnly.length).toBe(1);
    expect(countDrift(workspaceId, 'open', 'core.quantityOnHand')).toBe(1);

    const missing = listDrift(workspaceId, 'open', 100, 0, 'core.weight');
    expect(missing.length).toBe(0);
    expect(countDrift(workspaceId, 'open', 'core.weight')).toBe(0);

    // Hunk expansion groups by field.
    const sources = listDrift(workspaceId, 'open', 100, 0);
    const hunks = sources.flatMap((s) => expandDriftToHunks(s));
    const counts: Record<string, number> = {};
    for (const h of hunks) counts[h.field] = (counts[h.field] ?? 0) + 1;
    expect(counts['core.price']).toBe(1);
    expect(counts['core.quantityOnHand']).toBe(1);
    expect(counts['core.weight'] ?? 0).toBe(0);

    detect(BASE_XML);
  });

  it('requires explicit per-hunk decisions; omitted/invalid fail', () => {
    detect(BASE_XML);
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: 'core.price',
        decision: '',
      }),
    ).toThrow(/Invalid decision/);
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: 'core.price',
        decision: 'keep_local',
      }),
    ).toThrow(/Invalid decision/);
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: '',
        decision: 'accept',
      }),
    ).toThrow(/Missing field/);
    detect(BASE_XML);
  });

  it('accepting a hunk preserves unrelated fields and product identity', () => {
    detect(BASE_XML);
    const twoField = BASE_XML.replace('19.99', '24.99').replace(
      '<QuantityOnHand>10</QuantityOnHand>',
      '<QuantityOnHand>42</QuantityOnHand>',
    );
    detect(twoField);
    const before = readProductFile(workspacePath, 'HUNK-001')!;
    const beforeId = before.id;

    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const parsed = parseDriftDiff(drift);
    expect(parsed.hunks.length).toBe(2);

    const res = resolveSingleHunk(workspaceId, workspacePath, {
      driftId: drift.id,
      field: 'core.price',
      decision: 'accept',
      expectedRemoteHash: drift.remoteHash,
      expectedBaselineCommit: parsed.baselineCommit,
    });
    expect(res.decision).toBe('accepted');
    expect(res.remainingHunks).toBe(1);

    const after = readProductFile(workspacePath, 'HUNK-001')!;
    // Only price moved; quantity stays at baseline 10, identity preserved.
    expect(after.core.price).toBe('24.99');
    expect(after.core.inventory.quantityOnHand).toBe(10);
    expect(after.id).toBe(beforeId);
    expect(after.sku).toBe('HUNK-001');

    // Description hunk stays outstanding (field isolation).
    const remaining = findDriftById(drift.id)!;
    const reparsed = parseDriftDiff(remaining);
    expect(reparsed.hunks.map((h) => h.field)).toEqual(['core.quantityOnHand']);

    // Restore baseline for later tests.
    const restored = readProductFile(workspacePath, 'HUNK-001')!;
    restored.core.price = '19.99';
    writeProductFile(workspacePath, restored);
    commitAll('Restore price for #253');
    detect(BASE_XML);
  });

  it('workspace-checks resolution ids', () => {
    detect(BASE_XML);
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const otherWs = `ws-253-other-${randomUUID()}`;
    expect(() =>
      resolveSingleHunk(otherWs, workspacePath, {
        driftId: drift.id,
        field: 'core.price',
        decision: 'reject',
      }),
    ).toThrow(/not found/);
    detect(BASE_XML);
  });

  it('rejection neither recreates identical work nor asserts remote equality', () => {
    detect(BASE_XML);
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const res = resolveSingleHunk(workspaceId, workspacePath, {
      driftId: drift.id,
      field: 'core.price',
      decision: 'reject',
    });
    expect(res.decision).toBe('rejected');
    expect(res.resolvedAll).toBe(true);

    // Identical recheck: zero new rows, outstanding stays flat.
    const openBefore = countDrift(workspaceId, 'open');
    const again = detect(BASE_XML.replace('19.99', '24.99'));
    expect(again.driftCount).toBe(0);
    expect(countDrift(workspaceId, 'open')).toBe(openBefore);

    // Not falsely synced: index still reports drifted, never synced.
    const idx = findProductBySku('HUNK-001');
    if (idx) {
      expect(idx.syncStatus).not.toBe('synced');
    }

    // Newer remote invalidates the acknowledgement and reappears.
    const newer = detect(BASE_XML.replace('19.99', '29.99'));
    expect(newer.driftCount).toBe(1);
    const reopened = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    expect(parseDriftDiff(reopened).hunks.some((h) => h.field === 'core.price')).toBe(true);

    detect(BASE_XML);
    // Cleanup ack rows for this SKU so later tests start clean (rejection
    // acks are scoped to exact remote/baseline; the 29.99 ack-free recheck
    // below clears the row, but explicit delete keeps isolation).
    try {
      getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ? AND sku = ?', [workspaceId, 'HUNK-001']);
    } catch { /* ok */ }
    detect(BASE_XML.replace('19.99', '29.99'));
    const leftover = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001');
    if (leftover) {
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: leftover.id,
        field: 'core.price',
        decision: 'reject',
      });
      getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ? AND sku = ?', [workspaceId, 'HUNK-001']);
    }
    detect(BASE_XML);
  });

  it('invalidates stale reviews on changed baseline or newer remote', () => {
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const parsed = parseDriftDiff(drift);
    const staleBase = parsed.baselineCommit;

    // Move the approved baseline (unpushed approval style).
    const prod = readProductFile(workspacePath, 'HUNK-001')!;
    prod.core.price = '19.99';
    prod.core.weight = '5lb';
    writeProductFile(workspacePath, prod);
    const newHead = commitAll('Move baseline for staleness test');
    expect(newHead).not.toBe(staleBase);

    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: 'core.price',
        decision: 'accept',
        expectedRemoteHash: drift.remoteHash,
        expectedBaselineCommit: staleBase,
      }),
    ).toThrow(/Stale hunk: approved baseline moved/);

    // Restore baseline file to original for the remote-staleness leg.
    const restored = readProductFile(workspacePath, 'HUNK-001')!;
    restored.core.weight = null as unknown as string;
    writeProductFile(workspacePath, restored);
    commitAll('Restore baseline after staleness test');

    // Newer remote invalidates an old expected hash.
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML.replace('19.99', '24.99'));
    const fresh = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    detect(BASE_XML.replace('19.99', '29.99'));
    const superseded = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    expect(superseded.remoteHash).not.toBe(fresh.remoteHash);
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: superseded.id,
        field: 'core.price',
        decision: 'accept',
        expectedRemoteHash: fresh.remoteHash,
      }),
    ).toThrow(/Stale hunk: remote observation changed/);

    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('holds filename collisions for reviewed repair', async () => {
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    const db = getDb();
    const now = new Date().toISOString();
    // Owner reserves collide.html via explicit custom FileName.
    const ownerSku = `OWNER-${Date.now()}`;
    const ownerDecoded = ShopSiteProductCodec.decode(
      BASE_XML.replace('HUNK-001', ownerSku).replace('19.99', '9.99'),
      { workspaceId },
    ).products[0];
    ownerDecoded.customFields['FileName'] = 'collide.html';
    writeProductFile(workspacePath, ownerDecoded);
    commitAll(`Add owner ${ownerSku}`);
    const ownerHash = hashComparisonProjection(buildProj(ownerDecoded));
    try {
      insertProductIndex({
        id: ownerDecoded.id,
        sku: ownerSku,
        filePath: skuToProductFilePath(ownerSku),
        title: ownerDecoded.core.name,
        status: ownerDecoded.status,
        price: ownerDecoded.core.price,
        inventoryQuantity: ownerDecoded.core.inventory.quantityOnHand,
        primaryImage: ownerDecoded.core.media.primary,
        productHash: ownerHash,
        lastApprovedCommit: new GitClient(workspacePath).getHeadHash(),
        lastPulledRemoteHash: ownerHash,
        lastSyncedRemoteHash: ownerHash,
        lastSyncedAt: now,
        syncStatus: 'synced',
        hasAdvancedBlocks: 0,
        hasWarnings: 0,
        createdAt: now,
        updatedAt: now,
        description: ownerDecoded.core.description,
        searchKeywords: ownerDecoded.core.seo.searchKeywords,
        customFields: ownerDecoded.customFields,
      });
    } catch { /* may already exist */ }

    // Target pulls a colliding FileName.
    const collidingXml = BASE_XML.replace('<Price>19.99</Price>', '<Price>19.99</Price><FileName>collide.html</FileName>');
    detect(collidingXml);
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const parsed = parseDriftDiff(drift);
    expect(parsed.hunks.some((h) => h.field === 'seo.fileName')).toBe(true);
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: 'seo.fileName',
        decision: 'accept',
      }),
    ).toThrow(/IMPORT_FILENAME_COLLISION/);

    // Cleanup owner + drift.
    try { db.run('DELETE FROM product_index WHERE sku = ?', [ownerSku]); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(workspacePath, skuToProductFilePath(ownerSku))); } catch { /* ok */ }
    commitAll('Remove collision owner');
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('emits basic resolution audit with decision, actor, time, field, catalog ref', () => {
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    resolveSingleHunk(workspaceId, workspacePath, {
      driftId: drift.id,
      field: 'core.price',
      decision: 'accept',
    });
    const db = getDb();
    const audits = db.query(
      `SELECT * FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'drift_hunk_accepted' ORDER BY created_at DESC LIMIT 1`,
    ).all(workspaceId, drift.id) as Array<Record<string, unknown>>;
    expect(audits.length).toBe(1);
    const details = JSON.parse(String(audits[0].details_json)) as Record<string, unknown>;
    expect(details['decision']).toBe('accepted');
    expect(details['actor']).toBe(workspaceId);
    expect(details['field']).toBe('core.price');
    expect(typeof details['at']).toBe('string');
    expect(typeof details['catalogRef']).toBe('string');

    // Restore baseline file (accept moved it to 24.99).
    const prod = readProductFile(workspacePath, 'HUNK-001')!;
    prod.core.price = '19.99';
    writeProductFile(workspacePath, prod);
    commitAll('Restore after audit test');
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('holds new products, page assignments, and reconcile links visibly', async () => {
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }

    // New remote product (no baseline file).
    const newSku = `NEW-${Date.now()}`;
    const newXml = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>${newSku}</SKU><Name>Brand New</Name><Price>9.99</Price><ProductDisabled>uncheck</ProductDisabled></Product>
</Products></ShopSiteProducts>`;
    const newRes = detect(newXml);
    const newDrift = (newRes.drifts[0] ?? listDrift(workspaceId, 'open').find((d) => d.sku === newSku))!;
    expect(newDrift).toBeTruthy();
    const newHunks = expandDriftToHunks(newDrift);
    expect(newHunks.length).toBeGreaterThan(0);
    expect(newHunks.every((h) => h.heldReason === 'new_product')).toBe(true);
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: newDrift.id,
        field: newHunks[0].field,
        decision: 'accept',
      }),
    ).toThrow(/genuinely new remote products/);

    // Page assignment hunk is held.
    const pageXml = BASE_XML.replace(
      '</Product>',
      '<ProductOnPages><PageLink><Name>New Page</Name></PageLink></ProductOnPages></Product>',
    );
    detect(pageXml);
    const pageDrift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    const pageHunks = expandDriftToHunks(pageDrift).filter((h) => h.field === 'core.productOnPages');
    expect(pageHunks.length).toBeGreaterThan(0);
    expect(pageHunks[0].heldReason).toBe('unavailable_assignment');
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: pageDrift.id,
        field: 'core.productOnPages',
        decision: 'accept',
        baselineValue: pageHunks[0].baselineValue,
        remoteValue: pageHunks[0].remoteValue,
      }),
    ).toThrow(/unavailable page assignments/);

    // Reconcile-linked rows are held.
    detect(BASE_XML.replace('19.99', '24.99'));
    const recDrift = listDrift(workspaceId, 'open').find((d) => d.sku === 'HUNK-001')!;
    linkDriftToChangeSet(recDrift.id, `cs-253-${Date.now()}`, 'in_reconcile');
    const linked = findDriftById(recDrift.id)!;
    expect(linked.status).toBe('in_reconcile');
    const linkedHunks = expandDriftToHunks(linked);
    expect(linkedHunks[0].heldReason).toBe('in_reconcile');
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: linked.id,
        field: linkedHunks.find((h) => h.heldReason !== 'in_reconcile')?.field ?? linkedHunks[0].field,
        decision: 'accept',
      }),
    ).toThrow(/reconcile/);

    // Cleanup: resolve reconcile link + acks + new-product row.
    try { resolveDrift(linked.id, 'resolved'); } catch { /* ok */ }
    try { resolveDrift(newDrift.id, 'resolved'); } catch { /* ok */ }
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('applies a single custom field without touching siblings', async () => {
    detect(BASE_XML);
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    // Seed two custom fields on the baseline.
    const base = readProductFile(workspacePath, 'HUNK-001')!;
    base.customFields['ProductField16'] = 'KeepMe';
    base.customFields['ProductField17'] = 'Before';
    writeProductFile(workspacePath, base);
    commitAll('Seed custom fields for isolation test');

    const remoteDecoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId }).products[0];
    remoteDecoded.customFields['ProductField16'] = 'KeepMe';
    remoteDecoded.customFields['ProductField17'] = 'After';
    // Build remote XML with both custom fields via direct product diff:
    // detect via crafted products through the service layer instead of XML.
    const bProj = buildProj(base, { resolvePageIdentity: () => null });
    const rProj = buildProj(remoteDecoded, { resolvePageIdentity: () => null });
    const hunks = diffProjs(bProj, rProj);
    expect(hunks.some((h) => h.field === 'custom.ProductField17')).toBe(true);

    // Pure merge preserves the sibling.
    const merged = applySingleFieldHunk(base, remoteDecoded, 'custom.ProductField17');
    expect(merged.customFields['ProductField17']).toBe('After');
    expect(merged.customFields['ProductField16']).toBe('KeepMe');
    expect(merged.id).toBe(base.id);

    // Restore baseline custom fields.
    const restored = readProductFile(workspacePath, 'HUNK-001')!;
    delete restored.customFields['ProductField16'];
    delete restored.customFields['ProductField17'];
    writeProductFile(workspacePath, restored);
    commitAll('Restore custom fields');
    try { getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]); } catch { /* ok */ }
    detect(BASE_XML);
  });
});
