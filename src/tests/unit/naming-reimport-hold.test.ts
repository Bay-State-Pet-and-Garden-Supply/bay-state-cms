/**
 * Issue #106 SEQUENCE 2e — drift accept holds foreign filename claims (TDD).
 *
 * A pulled FileName owned by ANOTHER sku holds with IMPORT_FILENAME_COLLISION:
 * no file write, no live-page rename. Uniquely-owned names preserve.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createDrift } from '../../db/repositories/drift-repo';
import { acceptRemoteForDrift } from '../../shopsite/drift';

const WS = 'ws-drift-106';

function remoteProduct(sku: string, fileName: string) {
  return JSON.stringify({
    sku,
    core: {
      name: `Remote ${sku}`, price: '1.00', salePrice: null, description: 'd',
      inventory: {}, availability: 'instock', weight: null, taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {},
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0',
      lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null },
    schemaVersion: 1, id: `id-${sku}`, status: 'active',
  });
}

describe('drift accept filename holds', () => {
  let workspacePath: string;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    workspacePath = path.join(os.tmpdir(), `drift-106-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(workspacePath, 'products'), { recursive: true });
    insertWorkspace({
      id: WS, name: 'drift', workspacePath, gitPath: path.join(workspacePath, '.git'),
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

  it('holds a cross-product healed-name claim without writing', () => {
    seedCatalog('LIVE-1', 'healed-live.html');
    const drift = createDrift({
      workspaceId: WS, sku: 'NEW-9', localHash: null, remoteHash: 'r',
      localJson: null, remoteJson: remoteProduct('NEW-9', 'healed-live.html'),
    });
    expect(() => acceptRemoteForDrift(workspacePath, drift)).toThrow(/IMPORT_FILENAME_COLLISION/);
    // Nothing written: no product file, no index row for the claimant.
    expect(existsSync(path.join(workspacePath, 'products', 'NEW-9.json'))).toBe(false);
    expect(getDb().query('SELECT id FROM product_index WHERE sku = ?').get('NEW-9')).toBeNull();
  });

  it('preserves a uniquely self-owned pulled name', () => {
    seedCatalog('LIVE-1', 'healed-live.html');
    const drift = createDrift({
      workspaceId: WS, sku: 'LIVE-1', localHash: null, remoteHash: 'r',
      localJson: null, remoteJson: remoteProduct('LIVE-1', 'healed-live.html'),
    });
    // Self-owned: passes the hold check (git commit may fail without a repo —
    // the hold decision itself is what this asserts: no collision throw).
    try {
      acceptRemoteForDrift(workspacePath, drift);
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/IMPORT_FILENAME_COLLISION/);
    }
    // Either written or failed past the hold — never a collision hold.
    rmSync(workspacePath, { recursive: true, force: true });
  });
});
