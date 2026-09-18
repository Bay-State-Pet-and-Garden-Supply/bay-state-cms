/**
 * Drift 4b (#257) — new-product, unavailable-assignment, and
 * reconcile-lifecycle workflows.
 *
 * Behavioral coverage at the highest existing integration seam (ShopSite XML
 * fixtures with a scratch workspace + database):
 * - genuinely new remote products are distinguished (productKind) and import
 *   via an explicit confirmed workflow, never per-hunk accept
 * - unavailable page assignments hold accepts without corrupting local state;
 *   verified page moves resolve like any other hunk
 * - reconcile creation is field-selective and never blocks unrelated fields
 * - rechecks preserve reconcile links; approval settles every linked hunk;
 *   discard and explicit reopen return hunks to open with content preserved
 * - audit history captures every lifecycle decision
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { detectDrift } from '../../shopsite/drift';
import { expandDriftToHunks, resolveSingleHunk } from '../../shopsite/drift-hunk-service';
import {
  createReconcileChangeSet,
  reopenReconcileDrift,
  importNewRemoteProduct,
  getReconciledFieldsForDrift,
} from '../../shopsite/drift-reconcile-service';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  listDrift,
  countDrift,
  findDriftById,
  resolveDrift,
} from '../../db/repositories/drift-repo';
import { approveChangeSet, discardChangeSet } from '../../server/services/change-set-service';
import { findChangeSetById } from '../../db/repositories/change-set-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { hashComparisonProjection, buildComparisonProjection as buildProj } from '../../shopsite/catalog-comparison';
import { skuToProductFilePath } from '../../git/product-file-path';

const testDbPath = '/tmp/baystate-cms-drift-257-test.db';
let workspacePath = '';
const workspaceId = `ws-257-${Date.now()}`;

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>WIDGET-257</SKU><Name>Widget 257</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function commitAll(message: string): string {
  const git = new GitClient(workspacePath);
  git.add(['products/', '.gitignore']);
  git.commit(message);
  return git.getHeadHash();
}

function detect(xml: string, opts?: { resolvePageIdentity?: (name: string) => string | null }) {
  return detectDrift(workspaceId, workspacePath, xml, {
    resolvePageIdentity: opts?.resolvePageIdentity ?? (() => null),
    pageImportHash: null,
  });
}

function clearState() {
  try {
    getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]);
  } catch { /* ok */ }
  detect(BASE_XML);
  // Release any lingering reconcile links from failed assertions.
  for (const d of listDrift(workspaceId, 'in_reconcile', 100, 0)) {
    try {
      reopenReconcileDrift(workspaceId, d.id, workspaceId);
    } catch { /* ok */ }
  }
  // Resolve leftovers so the next test starts flat.
  for (const d of listDrift(workspaceId, 'open', 100, 0)) {
    try {
      resolveDrift(d.id, 'resolved');
    } catch { /* ok */ }
  }
  detect(BASE_XML);
}

/** Strip every Category Page source (first-class + preserved) from a product. */
function clearPages(product: ReturnType<typeof readProductFile> & object): void {
  const p = product as unknown as {
    core: { productOnPages: string[] };
    shopsite?: { preserved?: { unknownElements?: Record<string, unknown>; advancedBlocks?: Record<string, string> } };
  };
  p.core.productOnPages = [];
  if (p.shopsite?.preserved?.unknownElements?.['ProductOnPages'] !== undefined) {
    delete p.shopsite.preserved.unknownElements['ProductOnPages'];
  }
  if (p.shopsite?.preserved?.advancedBlocks?.['ProductOnPages'] !== undefined) {
    delete p.shopsite.preserved.advancedBlocks['ProductOnPages'];
  }
  if (p.shopsite?.preserved?.advancedBlocks?.['productOnPages'] !== undefined) {
    delete p.shopsite.preserved.advancedBlocks['productOnPages'];
  }
}

describe('Drift 4b (#257): new-product, unavailable-assignment, reconcile lifecycle', () => {
  beforeAll(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-257-int-'));
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
    commitAll('Baseline for #257');
  });

  afterAll(() => {
    try { fs.rmSync(workspacePath, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('distinguishes new remote products and imports via an explicit confirmed workflow', () => {
    clearState();
    const newSku = `NEW-257-${Date.now()}`;
    const newXml = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>${newSku}</SKU><Name>Brand New 257</Name><Price>9.99</Price><ProductDisabled>uncheck</ProductDisabled></Product>
</Products></ShopSiteProducts>`;
    const res = detect(newXml);
    const drift = (res.drifts[0] ?? listDrift(workspaceId, 'open').find((d) => d.sku === newSku))!;
    expect(drift).toBeTruthy();
    const parsed = parseDriftDiff(drift);
    expect(parsed.hasLocalProduct).toBe(false);

    const hunks = expandDriftToHunks(drift);
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks.every((h) => h.productKind === 'new')).toBe(true);
    expect(hunks.every((h) => h.heldReason === 'new_product')).toBe(true);

    // Per-hunk accept stays held with a pointer to the import workflow.
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: drift.id,
        field: hunks[0].field,
        decision: 'accept',
      }),
    ).toThrow(/import-new/);

    // Confirmation is required: no silent import.
    expect(() =>
      importNewRemoteProduct(workspaceId, workspacePath, { driftId: drift.id }),
    ).toThrow(/confirmed/);

    const imported = importNewRemoteProduct(workspaceId, workspacePath, {
      driftId: drift.id,
      confirmed: true,
      expectedRemoteHash: drift.remoteHash,
      actor: workspaceId,
    });
    expect(imported.sku).toBe(newSku);
    expect(imported.productKind).toBe('new');
    expect(typeof imported.commitHash).toBe('string');

    // File + terminal state.
    expect(fs.existsSync(path.join(workspacePath, skuToProductFilePath(newSku)))).toBe(true);
    expect(findDriftById(drift.id)!.status).toBe('accepted_remote');

    // Audit carries decision, actor, time, and catalog reference.
    const db = getDb();
    const audits = db.query(
      `SELECT * FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'drift_new_product_imported' ORDER BY created_at DESC LIMIT 1`,
    ).all(workspaceId, drift.id) as Array<Record<string, unknown>>;
    expect(audits.length).toBe(1);
    const details = JSON.parse(String(audits[0].details_json)) as Record<string, unknown>;
    expect(details['decision']).toBe('accepted');
    expect(details['actor']).toBe(workspaceId);
    expect(typeof details['at']).toBe('string');
    expect(typeof details['catalogRef']).toBe('string');

    // Changed products are still the hunk path, not the import path.
    detect(BASE_XML.replace('19.99', '24.99'));
    const changed = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    const changedHunks = expandDriftToHunks(changed);
    expect(changedHunks[0].productKind).toBe('changed');
    expect(changedHunks[0].heldReason).toBeNull();
    expect(() =>
      importNewRemoteProduct(workspaceId, workspacePath, { driftId: changed.id, confirmed: true }),
    ).toThrow(/already exists locally/);

    // Cleanup: reject the changed hunk + ack cleanup, keep the imported file.
    resolveSingleHunk(workspaceId, workspacePath, {
      driftId: changed.id,
      field: 'core.price',
      decision: 'reject',
    });
    try {
      getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ? AND sku = ?', [workspaceId, 'WIDGET-257']);
    } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('workspace-checks the new-product import', () => {
    clearState();
    const newSku = `NEW-WS-${Date.now()}`;
    const newXml = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>${newSku}</SKU><Name>Ws Guard</Name><Price>1.99</Price><ProductDisabled>uncheck</ProductDisabled></Product>
</Products></ShopSiteProducts>`;
    detect(newXml);
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === newSku)!;
    expect(() =>
      importNewRemoteProduct(`ws-foreign-${randomUUID()}`, workspacePath, { driftId: drift.id, confirmed: true }),
    ).toThrow(/not found/);
    clearState();
  });

  it('holds filename collisions on new-product import', () => {
    clearState();
    const db = getDb();
    const now = new Date().toISOString();
    const ownerSku = `OWNER-257-${Date.now()}`;
    const ownerDecoded = ShopSiteProductCodec.decode(
      BASE_XML.replace('WIDGET-257', ownerSku).replace('19.99', '9.99'),
      { workspaceId },
    ).products[0];
    ownerDecoded.customFields['FileName'] = 'new-collide-257.html';
    writeProductFile(workspacePath, ownerDecoded);
    commitAll(`Add owner ${ownerSku}`);
    // Reserve the name in the catalog index (the collision source of truth).
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

    const clashSku = `CLASH-257-${Date.now()}`;
    const clashXml = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>${clashSku}</SKU><Name>Clash</Name><Price>5.99</Price><ProductDisabled>uncheck</ProductDisabled><FileName>new-collide-257.html</FileName></Product>
</Products></ShopSiteProducts>`;
    detect(clashXml);
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === clashSku)!;
    expect(() =>
      importNewRemoteProduct(workspaceId, workspacePath, { driftId: drift.id, confirmed: true }),
    ).toThrow(/IMPORT_FILENAME_COLLISION/);
    expect(fs.existsSync(path.join(workspacePath, skuToProductFilePath(clashSku)))).toBe(false);

    // Cleanup owner + clash row.
    try { db.run('DELETE FROM product_index WHERE sku = ?', [ownerSku]); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(workspacePath, skuToProductFilePath(ownerSku))); } catch { /* ok */ }
    commitAll('Remove collision owner');
    try { resolveDrift(drift.id, 'resolved'); } catch { /* ok */ }
    clearState();
  });

  it('resolves verified page moves but holds unverified page accepts without corrupting local state', () => {
    clearState();
    const pageXml = BASE_XML.replace(
      '</Product>',
      '<ProductOnPages><PageLink><Name>New Page</Name></PageLink></ProductOnPages></Product>',
    );

    // Verified: stable identity resolves like any other hunk.
    detect(pageXml, { resolvePageIdentity: (name) => (name === 'New Page' ? 'exported_guid:page-1' : null) });
    const verified = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    const verifiedHunks = expandDriftToHunks(verified).filter((h) => h.field === 'core.productOnPages');
    expect(verifiedHunks.length).toBeGreaterThan(0);
    expect(verifiedHunks[0].remoteValue).toBe('id:exported_guid:page-1');
    expect(verifiedHunks[0].heldReason).toBeNull();
    const acceptRes = resolveSingleHunk(workspaceId, workspacePath, {
      driftId: verified.id,
      field: 'core.productOnPages',
      decision: 'accept',
      baselineValue: verifiedHunks[0].baselineValue,
      remoteValue: verifiedHunks[0].remoteValue,
    });
    expect(acceptRes.decision).toBe('accepted');
    const afterAccept = readProductFile(workspacePath, 'WIDGET-257')!;
    expect(afterAccept.core.productOnPages).toContain('New Page');

    // Restore baseline pages for the unverified leg (all page sources).
    const restored = readProductFile(workspacePath, 'WIDGET-257')!;
    clearPages(restored);
    writeProductFile(workspacePath, restored);
    commitAll('Restore pages after verified accept');
    detect(BASE_XML);

    // Unverified: accept holds, reject keeps local without corruption.
    detect(pageXml, { resolvePageIdentity: () => null });
    const unverified = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    const unverifiedHunks = expandDriftToHunks(unverified).filter((h) => h.field === 'core.productOnPages');
    expect(unverifiedHunks.length).toBeGreaterThan(0);
    expect(unverifiedHunks[0].heldReason).toBe('unavailable_assignment');
    expect(() =>
      resolveSingleHunk(workspaceId, workspacePath, {
        driftId: unverified.id,
        field: 'core.productOnPages',
        decision: 'accept',
        baselineValue: unverifiedHunks[0].baselineValue,
        remoteValue: unverifiedHunks[0].remoteValue,
      }),
    ).toThrow(/no stable live-store identity/);
    const rejectRes = resolveSingleHunk(workspaceId, workspacePath, {
      driftId: unverified.id,
      field: 'core.productOnPages',
      decision: 'reject',
      baselineValue: unverifiedHunks[0].baselineValue,
      remoteValue: unverifiedHunks[0].remoteValue,
    });
    expect(rejectRes.decision).toBe('rejected');
    const kept = readProductFile(workspacePath, 'WIDGET-257')!;
    expect(kept.core.productOnPages ?? []).toEqual([]);

    try {
      getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]);
    } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('reconciles selected fields without blocking unrelated outstanding fields', () => {
    clearState();
    const twoField = BASE_XML.replace('19.99', '24.99').replace(
      '<QuantityOnHand>10</QuantityOnHand>',
      '<QuantityOnHand>42</QuantityOnHand>',
    );
    detect(twoField);
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    expect(parseDriftDiff(drift).hunks.length).toBe(2);

    const created = createReconcileChangeSet(workspaceId, workspacePath, {
      driftId: drift.id,
      fields: ['core.price'],
      actor: workspaceId,
    });
    expect(created.fields).toEqual(['core.price']);
    expect(created.productKind).toBe('changed');
    const linked = findDriftById(drift.id)!;
    expect(linked.status).toBe('in_reconcile');

    // The reconciled set covers price only.
    const reconciled = getReconciledFieldsForDrift(linked);
    expect(reconciled?.has('core.price')).toBe(true);
    expect(reconciled?.has('core.quantityOnHand')).toBe(false);

    // Price holds; quantity stays resolvable on the same product.
    const hunks = expandDriftToHunks(linked);
    const priceHunk = hunks.find((h) => h.field === 'core.price')!;
    const qtyHunk = hunks.find((h) => h.field === 'core.quantityOnHand')!;
    expect(priceHunk.heldReason).toBe('in_reconcile');
    expect(qtyHunk.heldReason).toBeNull();

    const qtyRes = resolveSingleHunk(workspaceId, workspacePath, {
      driftId: linked.id,
      field: 'core.quantityOnHand',
      decision: 'accept',
    });
    expect(qtyRes.decision).toBe('accepted');
    const afterQty = readProductFile(workspacePath, 'WIDGET-257')!;
    expect(afterQty.core.inventory.quantityOnHand).toBe(42);
    // Price was not dragged along.
    expect(afterQty.core.price).toBe('19.99');

    // Price is still outstanding and linked.
    const still = findDriftById(drift.id)!;
    expect(still.status).toBe('in_reconcile');
    expect(parseDriftDiff(still).hunks.map((h) => h.field)).toEqual(['core.price']);

    // Explicit reopen restores resolvability with content preserved.
    const reopened = reopenReconcileDrift(workspaceId, drift.id, workspaceId);
    expect(reopened.sku).toBe('WIDGET-257');
    const open = findDriftById(drift.id)!;
    expect(open.status).toBe('open');
    expect(open.reconcileChangeSetId).toBeNull();
    expect(parseDriftDiff(open).hunks.map((h) => h.field)).toEqual(['core.price']);

    // Restore baseline for later tests.
    const restored = readProductFile(workspacePath, 'WIDGET-257')!;
    restored.core.inventory.quantityOnHand = 10;
    writeProductFile(workspacePath, restored);
    commitAll('Restore quantity after selective reconcile test');
    try {
      resolveDrift(drift.id, 'resolved');
    } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('keeps reconcile links across rechecks and settles every linked hunk on approval', () => {
    clearState();
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    const created = createReconcileChangeSet(workspaceId, workspacePath, { driftId: drift.id, actor: workspaceId });
    const csId = created.changeSetId;
    expect(findChangeSetById(csId)?.status).toBe('draft');

    // Identical recheck: noop, link preserved.
    const noop = detect(BASE_XML.replace('19.99', '24.99'));
    expect(noop.driftCount).toBe(0);
    const same = findDriftById(drift.id)!;
    expect(same.status).toBe('in_reconcile');
    expect(same.reconcileChangeSetId).toBe(csId);

    // Newer remote: supersedes in place (reported as updated work) with the
    // reconcile link preserved.
    const newer = detect(BASE_XML.replace('19.99', '29.99'));
    expect(newer.driftCount).toBe(1);
    expect(newer.drifts[0].id).toBe(drift.id);
    const moved = findDriftById(drift.id)!;
    expect(moved.status).toBe('in_reconcile');
    expect(moved.reconcileChangeSetId).toBe(csId);
    expect(moved.remoteHash).not.toBe(same.remoteHash);

    // Approval writes the frozen draft (24.99): the newer remote (29.99)
    // must come back as open — never silently cleared.
    const approved = approveChangeSet(csId, workspacePath);
    expect(approved.success).toBe(true);
    const settled = findDriftById(drift.id)!;
    expect(settled.status).toBe('open');
    expect(settled.reconcileChangeSetId).toBeNull();
    const remaining = parseDriftDiff(settled).hunks;
    expect(remaining.some((h) => h.field === 'core.price')).toBe(true);

    const db = getDb();
    const approvalAudits = db.query(
      `SELECT * FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'drift_reconcile_approved' ORDER BY created_at DESC LIMIT 1`,
    ).all(workspaceId, drift.id) as Array<Record<string, unknown>>;
    expect(approvalAudits.length).toBe(1);

    // Restore baseline price and clear the remaining drift.
    const prod = readProductFile(workspacePath, 'WIDGET-257')!;
    prod.core.price = '19.99';
    writeProductFile(workspacePath, prod);
    commitAll('Restore price after approval test');
    try {
      resolveDrift(drift.id, 'resolved');
    } catch { /* ok */ }
    try {
      getDb().run('DELETE FROM drift_hunk_ack WHERE workspace_id = ?', [workspaceId]);
    } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('discards reopen hunks with content preserved and validates reconcile inputs', () => {
    clearState();
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;

    // Unknown fields fail instead of inventing work.
    expect(() =>
      createReconcileChangeSet(workspaceId, workspacePath, { driftId: drift.id, fields: ['core.nope'] }),
    ).toThrow(/No outstanding hunk/);

    const created = createReconcileChangeSet(workspaceId, workspacePath, { driftId: drift.id, actor: workspaceId });
    // Double-linking fails closed while the first reconcile is live.
    expect(() =>
      createReconcileChangeSet(workspaceId, workspacePath, { driftId: drift.id, actor: workspaceId }),
    ).toThrow(/not open/);
    // Reopening an open row fails closed (asserted below after discard).

    const discarded = discardChangeSet(created.changeSetId);
    expect(discarded.success).toBe(true);
    expect(findChangeSetById(created.changeSetId)).toBeNull();
    const reopened = findDriftById(drift.id)!;
    expect(reopened.status).toBe('open');
    expect(parseDriftDiff(reopened).hunks.map((h) => h.field)).toEqual(['core.price']);

    const db = getDb();
    const reopenAudits = db.query(
      `SELECT * FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'drift_reconcile_reopened' ORDER BY created_at DESC LIMIT 1`,
    ).all(workspaceId, drift.id) as Array<Record<string, unknown>>;
    expect(reopenAudits.length).toBe(1);

    // Reopen on an open row fails closed.
    expect(() => reopenReconcileDrift(workspaceId, drift.id, workspaceId)).toThrow(/not in_reconcile/);

    try {
      resolveDrift(drift.id, 'resolved');
    } catch { /* ok */ }
    detect(BASE_XML);
  });

  it('leaves only truly unsupported fields visibly held', () => {
    clearState();
    detect(BASE_XML.replace('19.99', '24.99'));
    const drift = listDrift(workspaceId, 'open').find((d) => d.sku === 'WIDGET-257')!;
    const hunks = expandDriftToHunks(drift);
    // Supported existing-product hunks are actionable, not held.
    expect(hunks.every((h) => h.heldReason === null)).toBe(true);
    expect(countDrift(workspaceId, 'open')).toBeGreaterThan(0);
    clearState();
    expect(countDrift(workspaceId, 'open')).toBe(0);
  });
});
