/**
 * Issue #106 SEQUENCE 2b — complete filename-ownership snapshot (TDD).
 *
 * Batch-only + backstop is REJECTED. The snapshot covers approved catalog
 * products (product_index) + previously promoted non-discarded drafts
 * (change-set reservations before Git approval). Same-SKU ownership is a
 * self-update, never a foreign collision.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { buildFilenameOwnershipSnapshot } from '../../onboarding/draft-promoter';
import { listCatalogFilenameOwners } from '../../db/repositories/product-index-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';

const WS = 'ws-snap-106';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WS, name: 'snap', workspacePath: '/tmp/snap-106', gitPath: '/tmp/snap-106/.git',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete', baselineCommit: null,
  });
});

function seedCatalogProduct(sku: string, fileName: string | null) {
  getDb().query(`INSERT INTO product_index
    (id, sku, file_path, title, status, price, inventory_quantity, primary_image, product_hash, created_at, updated_at, custom_fields)
    VALUES (?, ?, ?, ?, 'active', '1.00', 1, NULL, 'h', '2026-01-01', '2026-01-01', ?)`).run(
    `pi-${sku}`, sku, `/p/${sku}.xml`, `Title ${sku}`, fileName ? JSON.stringify({ FileName: fileName }) : null,
  );
}

function seedPendingDraft(sku: string, fileName: string): string {
  const cs = createChangeSet({ workspaceId: WS, title: 'pending', description: null, baseCommit: 'c0' });
  upsertChangeSetItem({
    changeSetId: cs.id, sku, operation: 'create',
    draftJson: JSON.stringify({ sku, core: { name: `Draft ${sku}` }, customFields: { FileName: fileName } }),
    baseJson: null, draftHash: 'h',
  });
  return cs.id;
}

describe('buildFilenameOwnershipSnapshot', () => {
  it('covers catalog names and pending reservations with origins', () => {
    seedCatalogProduct('SKU-A', 'acme-food.html');
    seedPendingDraft('SKU-B', 'acme-treats.html');
    const snap = buildFilenameOwnershipSnapshot(WS);
    expect(snap.taken.map((t) => t.toLowerCase()).sort()).toEqual(['acme-food.html', 'acme-treats.html']);
    expect(snap.owners.get('acme-food.html')).toMatchObject({ sku: 'SKU-A', origin: 'catalog' });
    expect(snap.owners.get('acme-treats.html')).toMatchObject({ sku: 'SKU-B', origin: 'pending' });
    expect(snap.ref).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores discarded change sets and products without filenames', () => {
    seedCatalogProduct('SKU-A', null);
    const csId = seedPendingDraft('SKU-B', 'acme-treats.html');
    getDb().query(`UPDATE change_sets SET status = 'discarded' WHERE id = ?`).run(csId);
    const snap = buildFilenameOwnershipSnapshot(WS);
    expect(snap.taken).toEqual([]);
  });

  it('same-SKU ownership resolves as self-update, never foreign collision', () => {
    seedCatalogProduct('SKU-A', 'acme-food.html');
    const snap = buildFilenameOwnershipSnapshot(WS);
    // Without a self SKU the owner is reported foreign (caller supplies context).
    expect(snap.ownerOf('acme-food.html')).toMatchObject({ sku: 'SKU-A', origin: 'catalog', selfOwned: false });
    expect(snap.ownerOf('acme-food.html', 'SKU-A')).toMatchObject({ sku: 'SKU-A', selfSku: 'SKU-A', selfOwned: true });
    expect(snap.ownerOf('ACME-FOOD.HTML', 'SKU-A')).toMatchObject({ selfOwned: true });
    expect(snap.ownerOf('acme-food.html', 'SKU-Z')).toMatchObject({ sku: 'SKU-A', selfOwned: false });
    expect(snap.ownerOf('unclaimed.html', 'SKU-Z')).toBeNull();
  });

  it('is case-insensitive and deterministic across calls', () => {
    seedCatalogProduct('SKU-A', 'Acme-Food.HTML');
    const a = buildFilenameOwnershipSnapshot(WS);
    const b = buildFilenameOwnershipSnapshot(WS);
    expect(a.ref).toBe(b.ref);
    expect(a.taken).toEqual(b.taken);
  });

  it('indexed owners cover custom FileName only; seo-only rows reserve nothing (C2 scope pin)', () => {
    // A catalog row with an explicit custom FileName is indexed ownership.
    seedCatalogProduct('SKU-A', 'acme-food.html');
    // A catalog row WITHOUT custom fields (healed seo-only name living only
    // in the workspace file) reserves nothing in the indexed set — by
    // design (C2): pre-sync/drift enforce on indexed state; promotion adds
    // the workspace-file overlay as the primary enforcer.
    seedCatalogProduct('SKU-B', null);
    const owners = listCatalogFilenameOwners();
    expect(owners).toEqual([{ sku: 'SKU-A', fileName: 'acme-food.html' }]);
    expect(owners.some((o) => o.sku === 'SKU-B')).toBe(false);
  });
});
