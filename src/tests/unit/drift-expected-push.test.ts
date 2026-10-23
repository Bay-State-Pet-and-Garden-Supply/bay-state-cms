import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { hasBlockingDriftForSku } from '../../db/repositories/drift-repo';
import { detectDrift } from '../../shopsite/drift';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';

/**
 * P2 #21 proof at the production drift seam: only approved local deltas
 * whose live value still equals the change-set baseJson are "expected
 * pending push". A concurrent live PF1 edit stays blocking, and real
 * remote drift is never auto-resolved as keep_local.
 */
const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>SKU-1</SKU><Name>Drift Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand>
<ProductField1>instock060526</ProductField1><ProductField23>Chicken</ProductField23></Product>
</Products></ShopSiteProducts>`;

describe('drift expected-vs-real lifecycle (P2 #21)', () => {
  let workspacePath: string;
  let workspaceId: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-drift-21-'));
    const dbPath = path.join(workspacePath, `drift-21-${Date.now()}.db`);
    workspaceId = `ws-drift-21-${Date.now()}`;
    initDb(dbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: workspaceId, name: `${workspaceId}-store`, workspacePath,
      gitPath: `${workspacePath}/.git`, createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null,
    });
    createWorkspaceDirs(workspacePath);
    fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'exports/\n');
    const git = new GitClient(workspacePath);
    git.init();
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    for (const p of decoded.products) writeProductFile(workspacePath, p);
    git.add(['products/', '.gitignore']);
    git.commit('Baseline for drift lifecycle');
    const cs = createChangeSet({ workspaceId, title: 'drift-21', baseCommit: git.getHeadHash() });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'SKU-1', operation: 'update',
      draftJson: JSON.stringify(decoded.products[0]), baseJson: JSON.stringify(decoded.products[0]),
      draftHash: 'h',
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  function detect(xml: string) {
    return detectDrift(workspaceId, workspacePath, xml, {
      resolvePageIdentity: () => null,
      pageImportHash: null,
    });
  }

  it('marks an approved delta with remote still at base as expected pending push (no blocking drift)', () => {
    // Remote equals the pinned HEAD baseline: no drift rows, no blocking
    // state — the approved-but-unpushed delta is expected.
    const first = detect(BASE_XML);
    expect(first.drifts).toHaveLength(0);
    expect(hasBlockingDriftForSku(workspaceId, 'SKU-1')).toBe(false);
    // Idempotent recheck: identical remote data produces zero new rows.
    const second = detect(BASE_XML);
    expect(second.drifts).toHaveLength(0);
  });

  it('keeps a concurrent live PF1 edit blocking and never auto-keep_local', () => {
    const live = BASE_XML.replace('instock060526', 'disabled101321');
    const result = detect(live);
    expect(result.drifts.length).toBeGreaterThan(0);
    expect(hasBlockingDriftForSku(workspaceId, 'SKU-1')).toBe(true);
    // The finding names the diverged field; nothing auto-resolves it.
    const text = JSON.stringify(result.drifts);
    expect(text).toContain('ProductField1');
  });
});
