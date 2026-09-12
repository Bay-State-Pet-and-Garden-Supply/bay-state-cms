/**
 * Issue #106 SEQUENCE 2c — pre-sync catalog-overlay filename checks (TDD).
 *
 * validateChangeSet must validate the change-set overlay against UNTOUCHED
 * catalog ownership (not change-set-only), and filename-check failures are
 * blockers (never swallowed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { validateChangeSet } from '../../validation/change-set-validation';

const WS = 'ws-presync-106';

function draft(sku: string, fileName: string | null) {
  return JSON.stringify({
    sku,
    core: { name: `Draft ${sku}`, price: '1.00', salePrice: null, description: 'd', inventory: {}, availability: 'instock', weight: null, taxable: true, media: { primary: null, additional: [] }, seo: { fileName: null, searchKeywords: null, googleProductCategory: null }, productOnPages: [] },
    customFields: fileName ? { FileName: fileName } : {},
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null },
    schemaVersion: 1, id: `id-${sku}`, status: 'draft',
  });
}

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WS, name: 'presync', workspacePath: '/tmp/presync-106', gitPath: '/tmp/presync-106/.git',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete', baselineCommit: null,
  });
});

function seedCatalog(sku: string, fileName: string) {
  getDb().query(`INSERT INTO product_index
    (id, sku, file_path, title, status, price, inventory_quantity, primary_image, product_hash, created_at, updated_at, custom_fields)
    VALUES (?, ?, ?, ?, 'active', '1.00', 1, NULL, 'h', '2026-01-01', '2026-01-01', ?)`).run(
    `pi-${sku}`, sku, `/p/${sku}.xml`, `Title ${sku}`, JSON.stringify({ FileName: fileName }),
  );
}

describe('pre-sync catalog filename overlay', () => {
  it('foreign catalog ownership blocks the change set', () => {
    seedCatalog('LIVE-1', 'live-name.html');
    const cs = createChangeSet({ workspaceId: WS, title: 't', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'NEW-1', operation: 'create',
      draftJson: draft('NEW-1', 'live-name.html'), baseJson: null, draftHash: 'h',
    });
    const result = validateChangeSet(cs.id);
    expect(result.canApprove).toBe(false);
    const codes = result.items.flatMap((i) => i.results.map((r) => r.code));
    expect(codes).toContain('CATALOG_FILENAME_COLLISION');
  });

  it('same-SKU catalog ownership is a self-update, not a collision', () => {
    seedCatalog('LIVE-1', 'live-name.html');
    const cs = createChangeSet({ workspaceId: WS, title: 't', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'LIVE-1', operation: 'update',
      draftJson: draft('LIVE-1', 'live-name.html'), baseJson: null, draftHash: 'h',
    });
    const result = validateChangeSet(cs.id);
    const codes = result.items.flatMap((i) => i.results.map((r) => r.code));
    expect(codes).not.toContain('CATALOG_FILENAME_COLLISION');
  });

  it('unowned names stay clear', () => {
    seedCatalog('LIVE-1', 'live-name.html');
    const cs = createChangeSet({ workspaceId: WS, title: 't', description: null, baseCommit: 'c0' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'NEW-1', operation: 'create',
      draftJson: draft('NEW-1', 'fresh-name.html'), baseJson: null, draftHash: 'h',
    });
    const result = validateChangeSet(cs.id);
    const codes = result.items.flatMap((i) => i.results.map((r) => r.code));
    expect(codes).not.toContain('CATALOG_FILENAME_COLLISION');
    expect(codes).not.toContain('DUPLICATE_FILENAME');
  });
});
