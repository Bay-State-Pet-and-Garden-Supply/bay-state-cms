import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createChangeSet, listChangeSetItems, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { approveChangeSet } from '../../server/services/change-set-service';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';

const BASE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>APPR-001</SKU><Name>Approval Widget</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/widget.jpg</Graphic><QuantityOnHand>10</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function setup(): { workspacePath: string; workspaceId: string } {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-approve-22-'));
  const dbPath = path.join(workspacePath, `approve-22-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-approve-22-${Date.now()}`;
  initDb(dbPath);
  runMigrations();
  const now = new Date().toISOString();
  getDb().run(
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
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for approval scope');
  return { workspacePath, workspaceId };
}

describe('approval scope and atomicity (P2 #22)', () => {
  it('excludes pre-staged unrelated files from the approval commit', () => {
    const { workspacePath, workspaceId } = setup();
    const git = new GitClient(workspacePath);
    const decoded = ShopSiteProductCodec.decode(BASE_XML, { workspaceId });
    const product = decoded.products[0];
    product.core.price = '21.99';

    const cs = createChangeSet({ workspaceId, title: 'scoped approval', baseCommit: 'test' });
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: product.sku,
      operation: 'update',
      draftJson: deterministicStringify(product),
      baseJson: deterministicStringify(decoded.products[0]),
      draftHash: hashJson(product),
    });

    // Pre-stage an unrelated file that was never in the baseline: it must
    // stay out of the approval commit even though it sits in the index.
    const unrelated = path.join(workspacePath, 'store', 'unrelated-config.json');
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, '{"staged":true}', 'utf-8');
    git.add(['store/unrelated-config.json']);

    const result = approveChangeSet(cs.id, workspacePath);
    expect(result.success).toBe(true);
    expect(git.readFileAtHead('store/unrelated-config.json')).toBeNull();
    expect(listChangeSetItems(cs.id).length).toBe(1);
    // The staged unrelated file is still staged, not committed away.
    expect(git.status()).toContain('unrelated-config.json');
  });

  it('records HEAD without a new commit when targets are identical', () => {
    const { workspacePath, workspaceId } = setup();
    const git = new GitClient(workspacePath);
    const headBefore = git.getHeadHash();
    // Stable content: decode assigns random IDs, so reuse the exact
    // committed bytes as both base and draft.
    const committed = fs.readFileSync(path.join(workspacePath, 'products', 'APPR-001.json'), 'utf-8');
    const stored = JSON.parse(committed) as { sku: string };

    const cs = createChangeSet({ workspaceId, title: 'identical approval', baseCommit: 'test' });
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: stored.sku,
      operation: 'update',
      draftJson: committed,
      baseJson: committed,
      draftHash: hashJson(JSON.parse(committed)),
    });

    const result = approveChangeSet(cs.id, workspacePath);
    expect(result.success).toBe(true);
    expect(result.commitHash).toBe(headBefore);
    expect(git.getHeadHash()).toBe(headBefore);
  });
});
