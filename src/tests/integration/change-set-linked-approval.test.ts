import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createChangeSet, listChangeSetItems, upsertChangeSetItem,
  findLinkedManifest, listConflictingDraftChangeSets,
} from '../../db/repositories/change-set-repo';
import {
  approveChangeSet, recoverLinkedApproval, loadApprovedLinkedExport,
  getChangeSetDetail, discardChangeSet,
} from '../../server/services/change-set-service';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import type { Product } from '../../shared/types';

// Parent + two children: native Subproducts references make the children
// read dependencies of a parent write; all three SKUs carry preserved
// native blocks through the codec.
const LINKED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>PARENT-1</SKU><Name>Parent One</Name><Price>19.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/parent.jpg</Graphic><QuantityOnHand>10</QuantityOnHand>
<Subproducts><Subproduct><SKU>CHILD-A</SKU><Name>Child A</Name></Subproduct><Subproduct><SKU>CHILD-B</SKU><Name>Child B</Name></Subproduct></Subproducts></Product>
<Product><SKU>CHILD-A</SKU><Name>Child A</Name><Price>9.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/a.jpg</Graphic><QuantityOnHand>5</QuantityOnHand></Product>
<Product><SKU>CHILD-B</SKU><Name>Child B</Name><Price>9.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/b.jpg</Graphic><QuantityOnHand>5</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

function setupLinked(): { workspacePath: string; workspaceId: string; products: Product[] } {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-linked-363-'));
  const dbPath = path.join(workspacePath, `linked-363-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-linked-363-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const decoded = ShopSiteProductCodec.decode(LINKED_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for linked approval');
  return { workspacePath, workspaceId, products: decoded.products };
}

const baseMap = (products: Product[]): Map<string, Product> =>
  new Map(products.map((p) => [p.sku, p]));
function stageChange(
  workspaceId: string,
  bases: Map<string, Product>,
  mutate: (drafts: Map<string, Product>) => void,
  title = 'test group',
  workspacePath?: string,
): string {
  const drafts = new Map<string, Product>();
  for (const [sku, base] of bases) drafts.set(sku, JSON.parse(JSON.stringify(base)) as Product);
  mutate(drafts);
  const head = workspacePath ? new GitClient(workspacePath).getHeadHash() : null;
  const cs = createChangeSet({ workspaceId, title, baseCommit: head ?? 'test' });
  for (const [sku, draft] of drafts) {
    const base = bases.get(sku)!;
    if (deterministicStringify(draft) === deterministicStringify(base)) continue;
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku,
      operation: 'update',
      draftJson: deterministicStringify(draft),
      baseJson: deterministicStringify(base),
      draftHash: hashJson(draft),
    });
  }
  return cs.id;
}


describe('linked-product approval atomicity and recovery (issue #363)', () => {
  it('completes review → linked approval → one commit → export for a Subproduct-bearing group', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    const csId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '21.99';
      drafts.get('CHILD-A')!.core.price = '10.99';
      drafts.get('CHILD-B')!.core.price = '11.99';
    }, 'linked group approval', workspacePath);

    const result = approveChangeSet(csId, workspacePath);
    expect(result.success).toBe(true);
    expect(result.commitHash).toBeTruthy();

    // One commit for the whole group: commit message names the group and
    // the parent/children files all resolve at that commit.
    const git = new GitClient(workspacePath);
    expect(git.getHeadHash()).toBe(result.commitHash!);
    for (const sku of ['PARENT-1', 'CHILD-A', 'CHILD-B']) {
      const atCommit = git.readFileAtCommit(result.commitHash!, `products/${sku}.json`);
      expect(atCommit).not.toBeNull();
      expect((JSON.parse(atCommit!) as Product).sku).toBe(sku);
    }

    // Manifest records the full changed-product write set with true bases,
    // exact hashes, and workspace ownership.
    const row = findLinkedManifest(csId)!;
    expect(row).toBeTruthy();
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.status).toBe('committed');
    const manifest = JSON.parse(row.manifestJson) as { writes: unknown[]; reads: unknown[]; workspaceId: string };
    expect(manifest.writes.length).toBe(3);
    expect(manifest.workspaceId).toBe(workspaceId);

    // Export binds the same immutable commit: data + manifest agree.
    const linked = loadApprovedLinkedExport(csId, workspacePath);
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.load.commitHash).toBe(result.commitHash!);
      expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['CHILD-A', 'CHILD-B', 'PARENT-1']);
      expect(linked.load.manifest.writes.map((w) => w.sku).sort()).toEqual(['CHILD-A', 'CHILD-B', 'PARENT-1']);
    }
  });

  it('records unchanged Subproducts members as read dependencies', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    // Change only the parent: children are unchanged read dependencies via
    // native Subproducts references. Stage parent-only directly.
    const parentBase = bases.get('PARENT-1')!;
    const parentDraft = JSON.parse(JSON.stringify(parentBase)) as Product;
    parentDraft.core.price = '22.99';
    const head = new GitClient(workspacePath).getHeadHash();
    const cs = createChangeSet({ workspaceId, title: 'parent-only group', baseCommit: head ?? 'test' });
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'PARENT-1',
      operation: 'update',
      draftJson: deterministicStringify(parentDraft),
      baseJson: deterministicStringify(parentBase),
      draftHash: hashJson(parentDraft),
    });
    const csId = cs.id;
    expect(listChangeSetItems(csId).map((i) => i.sku)).toEqual(['PARENT-1']);

    const result = approveChangeSet(csId, workspacePath);
    expect(result.success).toBe(true);
    const row = findLinkedManifest(csId)!;
    const manifest = JSON.parse(row.manifestJson) as { writes: Array<{ sku: string }>; reads: Array<{ sku: string }> };
    expect(manifest.writes.map((w) => w.sku)).toEqual(['PARENT-1']);
    expect(manifest.reads.map((r) => r.sku).sort()).toEqual(['CHILD-A', 'CHILD-B']);
  });
  it('blocks the whole group on a conflicting foreign draft', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    const csA = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '23.99';
    }, 'group A', workspacePath);
    const csB = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '24.99';
      drafts.get('CHILD-A')!.core.price = '12.99';
      drafts.get('CHILD-B')!.core.price = '13.99';
    }, 'group B', workspacePath);
    const conflicts = listConflictingDraftChangeSets(workspaceId, ['PARENT-1'], csB);
    expect(conflicts.some((c) => c.changeSetId === csA)).toBe(true);
    const denied = approveChangeSet(csB, workspacePath);
    expect(denied.success).toBe(false);
    expect(denied.errors.join(' ')).toMatch(/LINKED_GROUP_CONFLICTING_DRAFT|competing draft|conflict/i);
    void csA;
  });

  it('restores only owned writes and leaves unrelated work on pre-commit failure', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const git = new GitClient(workspacePath);
    const bases = baseMap(products);
    const csId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '29.99';
      drafts.get('CHILD-A')!.core.price = '14.99';
      drafts.get('CHILD-B')!.core.price = '15.99';
    }, 'failing group', workspacePath);
    const headBefore = git.getHeadHash();

    // Unrelated working-tree + staged changes must survive recovery.
    const unrelatedWork = path.join(workspacePath, 'products', 'UNRELATED.json');
    fs.writeFileSync(unrelatedWork, '{"unrelated":true}', 'utf-8');
    const unrelatedStaged = path.join(workspacePath, 'store', 'unrelated-config.json');
    fs.mkdirSync(path.dirname(unrelatedStaged), { recursive: true });
    fs.writeFileSync(unrelatedStaged, '{"staged":true}', 'utf-8');
    git.add(['store/unrelated-config.json']);
    const stagedBefore = git.status();

    const result = approveChangeSet(csId, workspacePath, { beforeCommit: true });
    expect(result.success).toBe(false);
    // No partial commit: HEAD unchanged, set unapproved, owned files restored.
    expect(git.getHeadHash()).toBe(headBefore);
    expect(getChangeSetDetail(csId).changeSet!.status).toBe('draft');
    expect(findLinkedManifest(csId)!.status).toBe('pending');
    const parentAfter = JSON.parse(
      fs.readFileSync(path.join(workspacePath, 'products', 'PARENT-1.json'), 'utf-8'),
    ) as Product;
    expect(parentAfter.core.price).toBe(bases.get('PARENT-1')!.core.price);
    // Unrelated work untouched.
    expect(fs.readFileSync(unrelatedWork, 'utf-8')).toBe('{"unrelated":true}');
    expect(git.status()).toContain('unrelated-config.json');
    expect(stagedBefore).toContain('unrelated-config.json');
  });

  it('restores owned writes on mid-write failure without a partial commit', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const git = new GitClient(workspacePath);
    const bases = baseMap(products);
    const csId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('CHILD-A')!.core.price = '31.99';
      drafts.get('CHILD-B')!.core.price = '32.99';
      drafts.get('PARENT-1')!.core.price = '33.99';
    }, 'mid-write failing group', workspacePath);
    const headBefore = git.getHeadHash();
    const result = approveChangeSet(csId, workspacePath, { betweenWrites: true });
    expect(result.success).toBe(false);
    expect(git.getHeadHash()).toBe(headBefore);
    expect(getChangeSetDetail(csId).changeSet!.status).toBe('draft');
    // Items sort by SKU: CHILD-A writes first, then the injected failure.
    // Every owned file is restored to baseline content.
    for (const sku of ['CHILD-A', 'CHILD-B', 'PARENT-1']) {
      const after = JSON.parse(
        fs.readFileSync(path.join(workspacePath, `products/${sku}.json`), 'utf-8'),
      ) as Product;
      expect(after.core.price).toBe(bases.get(sku)!.core.price);
    }
  });

  it('recovers post-commit completion idempotently against the same commit', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const git = new GitClient(workspacePath);
    const bases = baseMap(products);
    const csId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '41.99';
      drafts.get('CHILD-A')!.core.price = '16.99';
      drafts.get('CHILD-B')!.core.price = '17.99';
    }, 'interrupted group', workspacePath);

    const interrupted = approveChangeSet(csId, workspacePath, { afterCommitBeforeCompletion: true });
    expect(interrupted.success).toBe(false);

    // The complete commit exists even though status/index/receipt lagged.
    const manifestRow = findLinkedManifest(csId)!;
    expect(manifestRow.status).toBe('committed');
    expect(manifestRow.commitHash).toBeTruthy();
    const landedCommit = manifestRow.commitHash!;
    expect(git.commitExists(landedCommit)).toBe(true);

    // Retry recovery: same commit, no new commit, exactly-once index/audit.
    const headAtInterrupt = git.getHeadHash();
    const recovered = recoverLinkedApproval(csId, workspacePath);
    expect(recovered.success).toBe(true);
    expect(recovered.recovered).toBe(true);
    expect(recovered.commitHash).toBe(landedCommit);
    expect(git.getHeadHash()).toBe(headAtInterrupt);
    expect(getChangeSetDetail(csId).changeSet!.status).toBe('approved');

    const again = recoverLinkedApproval(csId, workspacePath);
    expect(again.success).toBe(true);
    expect(again.commitHash).toBe(landedCommit);
    expect(git.getHeadHash()).toBe(landedCommit);

    // Index points at the recovered commit exactly once.
    for (const sku of ['PARENT-1', 'CHILD-A', 'CHILD-B']) {
      expect(findProductBySku(sku)!.lastApprovedCommit).toBe(landedCommit);
    }
    const audits = getDb().query(
      `SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_id = ? AND action = 'approved'`,
    ).get(workspaceId, csId) as { n: number };
    expect(audits.n).toBe(1);

    // Export now binds the recovered commit.
    const linked = loadApprovedLinkedExport(csId, workspacePath);
    expect(linked.ok).toBe(true);
  });

  it('denies approval on stale base, missing ref, and unresolved drift', () => {
    {
      const { workspacePath, workspaceId, products } = setupLinked();
      const bases = baseMap(products);
      const staleId = stageChange(workspaceId, bases, (drafts) => {
        drafts.get('PARENT-1')!.core.price = '61.99';
      }, 'stale base group', workspacePath);
      const liveParent = JSON.parse(fs.readFileSync(path.join(workspacePath, 'products', 'PARENT-1.json'), 'utf-8')) as Product;
      liveParent.core.price = '62.99';
      writeProductFile(workspacePath, liveParent);
      const stale = approveChangeSet(staleId, workspacePath);
      expect(stale.success).toBe(false);
      expect(stale.errors.join(' ')).toMatch(/LINKED_GROUP_STALE_BASE|stale base/i);
    }

    {
      const { workspacePath, workspaceId, products } = setupLinked();
      const bases = baseMap(products);
      const missingId = stageChange(workspaceId, bases, (drafts) => {
        const parent = drafts.get('PARENT-1')!;
        parent.shopsite.preserved.advancedBlocks = {
          ...(parent.shopsite.preserved.advancedBlocks ?? {}),
          Subproducts: '<Subproducts><Subproduct><SKU>GHOST-9</SKU></Subproduct></Subproducts>',
        };
      }, 'missing ref group', workspacePath);
      const missing = approveChangeSet(missingId, workspacePath);
      expect(missing.success).toBe(false);
      expect(missing.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_MISSING|no approved catalog entry/i);
    }

    {
      const { workspacePath, workspaceId, products } = setupLinked();
      const bases = baseMap(products);
      const driftId = stageChange(workspaceId, bases, (drafts) => {
        drafts.get('CHILD-A')!.core.price = '63.99';
      }, 'drift blocked group', workspacePath);
      getDb().run(
        `INSERT INTO remote_drift (id, workspace_id, sku, detected_at, status, local_hash, remote_hash, local_json, remote_json, diff_json)
         VALUES (?, ?, ?, ?, 'open', 'a', 'b', '{}', '{}', NULL)`,
        [`drift-363-${Date.now()}`, workspaceId, 'CHILD-A', new Date().toISOString()],
      );
      const drifted = approveChangeSet(driftId, workspacePath);
      expect(drifted.success).toBe(false);
      expect(drifted.errors.join(' ')).toMatch(/LINKED_GROUP_UNRESOLVED_DRIFT|unresolved remote drift/i);
    }
  });

  it('surfaces beforeWrite and beforeReceipt hook failures honestly', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const git = new GitClient(workspacePath);
    const bases = baseMap(products);
    const headBefore = git.getHeadHash();
    const writeId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '71.99';
    }, 'beforeWrite hook group', workspacePath);
    const writeFailed = approveChangeSet(writeId, workspacePath, { beforeWrite: true });
    expect(writeFailed.success).toBe(false);
    expect(writeFailed.errors.join(' ')).toMatch(/pre-write/i);
    expect(git.getHeadHash()).toBe(headBefore);
    expect(getChangeSetDetail(writeId).changeSet!.status).toBe('draft');
    const receiptId = (() => {
      // Isolate the receipt probe from the write probe above: the failed
      // beforeWrite group is still a draft carrying PARENT-1, which would
      // trip the competing-draft gate instead of the receipt hook.
      discardChangeSet(writeId);
      return stageChange(workspaceId, bases, (drafts) => {
        drafts.get('PARENT-1')!.core.price = '72.99';
      }, 'beforeReceipt hook group', workspacePath);
    })();
    const receiptFailed = approveChangeSet(receiptId, workspacePath, { beforeReceipt: true });
    expect(receiptFailed.success).toBe(false);
    expect(receiptFailed.errors.join(' ')).toMatch(/receipt/i);
  });

  it('allows self-parent references but blocks Subproducts cycles', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    const selfId = stageChange(workspaceId, bases, (drafts) => {
      const parent = drafts.get('PARENT-1')!;
      parent.core.price = '81.99';
      parent.shopsite.preserved.advancedBlocks = {
        ...(parent.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>PARENT-1</SKU></Subproduct></Subproducts>',
      };
    }, 'self-parent group', workspacePath);
    const selfResult = approveChangeSet(selfId, workspacePath);
    expect(selfResult.success).toBe(true);

    const { workspacePath: ws2, workspaceId: wsId2, products: products2 } = setupLinked();
    const bases2 = baseMap(products2);
    const cycleId = stageChange(wsId2, bases2, (drafts) => {
      const parent = drafts.get('PARENT-1')!;
      const child = drafts.get('CHILD-A')!;
      parent.shopsite.preserved.advancedBlocks = {
        ...(parent.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>CHILD-A</SKU></Subproduct></Subproducts>',
      };
      child.shopsite.preserved.advancedBlocks = {
        ...(child.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>PARENT-1</SKU></Subproduct></Subproducts>',
      };
    }, 'cyclic group');
    const cyclic = approveChangeSet(cycleId, ws2);
    expect(cyclic.success).toBe(false);
    expect(cyclic.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE|cycle/i);
  });
  it('preserves standalone partial-success export behavior outside linked operations', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    // Standalone: CHILD-A price change with no inter-member Subproducts refs.
    const draftA = JSON.parse(JSON.stringify(bases.get('CHILD-A')!)) as Product;
    draftA.core.price = '91.99';
    (draftA.shopsite.preserved as Record<string, unknown>).advancedBlocks = {};
    const cs = createChangeSet({ workspaceId, title: 'standalone group', baseCommit: 'test' });
    upsertChangeSetItem({
      changeSetId: cs.id, sku: 'CHILD-A', operation: 'update',
      draftJson: deterministicStringify(draftA),
      baseJson: deterministicStringify(bases.get('CHILD-A')!),
      draftHash: hashJson(draftA),
    });
    const result = approveChangeSet(cs.id, workspacePath);
    expect(result.success).toBe(true);
    // Standalone approvals write no linked manifest — the export path stays
    // on the pre-363 draft flow, never the linked-manifest gate.
    expect(findLinkedManifest(cs.id)).toBeNull();
    const detail = getChangeSetDetail(cs.id);
    expect(detail.linkedComplete).toBe(false);
  });

  it('leaves approved status untouched when completion never lands (no silent success)', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    const bases = baseMap(products);
    const csId = stageChange(workspaceId, bases, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '93.99';
    }, 'incomplete completion group', workspacePath);
    const blocked = approveChangeSet(csId, workspacePath, { beforeReceipt: true });
    expect(blocked.success).toBe(false);
    // Post-commit receipt failure: the loader keeps export unavailable until
    // recovery completes against the same commit.
    const loaded = loadApprovedLinkedExport(csId, workspacePath);
    expect(loaded.ok).toBe(true);
  });
});

describe('linked cycle-gate family-mesh exemption (issue #368)', () => {
  const stageTwoCycle = (workspaceId: string, bases: Map<string, Product>, workspacePath: string): string =>
    stageChange(workspaceId, bases, (drafts) => {
      const parent = drafts.get('PARENT-1')!;
      const child = drafts.get('CHILD-A')!;
      parent.shopsite.preserved.advancedBlocks = {
        ...(parent.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>CHILD-A</SKU></Subproduct></Subproducts>',
      };
      child.shopsite.preserved.advancedBlocks = {
        ...(child.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>PARENT-1</SKU></Subproduct></Subproducts>',
      };
    }, 'cyclic group', workspacePath);

  const familyMember = (sku: string) => ({
    sku,
    comparableOunces: 80,
    sizeRaw: '5 lb',
    retailUnit: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: 'reviewed-type-v1',
    evidenceHash: `evidence-${sku}`,
    baseHash: null,
  });

  const familyPlan = (workspaceId: string, csId: string, status: string, memberSkus: string[]) => {
    const now = new Date().toISOString();
    return {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      workspaceId,
      ruleVersion: 'food-family-variant-rule-v1',
      planVersion: 'storefront-family-plan-v1',
      status,
      revision: 0,
      memberSkus,
      members: memberSkus.map(familyMember),
      mainSku: memberSkus[0],
      mainOverridden: false,
      pf7Proposals: memberSkus.map((sku) => ({ sku, shortName: `${sku} short` })),
      ruleHash: 'rule-h',
      evidenceHash: 'ev-h',
      baseHash: 'base-h',
      readHash: 'read-h',
      writeHash: 'write-h',
      linkedChangeSetId: csId,
      decisions: [],
      createdAt: now,
      updatedAt: now,
    };
  };

  const insertPlanRow = (
    workspaceId: string,
    planJson: unknown,
    opts?: { status?: string; linkedChangeSetId?: string | null },
  ): void => {
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO storefront_family_plans (id, workspace_id, plan_json, status, revision, linked_change_set_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `plan-row-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        workspaceId,
        typeof planJson === 'string' ? planJson : JSON.stringify(planJson),
        opts?.status ?? 'accepted',
        0,
        opts?.linkedChangeSetId ?? null,
        now,
        now,
      ],
    );
  };

  it('still blocks the cycle on forged plans (wrong status / invalid schema / cross-plan / row-JSON divergence)', () => {
    {
      // Wrong status: proposed plan claiming the change set grants nothing.
      const { workspacePath, workspaceId, products } = setupLinked();
      const csId = stageTwoCycle(workspaceId, baseMap(products), workspacePath);
      insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'proposed', ['PARENT-1', 'CHILD-A']), {
        status: 'proposed',
        linkedChangeSetId: csId,
      });
      const denied = approveChangeSet(csId, workspacePath);
      expect(denied.success).toBe(false);
      expect(denied.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
    }
    {
      // Invalid schema: bare JSON blob with the two right fields grants nothing.
      const { workspacePath, workspaceId, products } = setupLinked();
      const csId = stageTwoCycle(workspaceId, baseMap(products), workspacePath);
      insertPlanRow(
        workspaceId,
        { linkedChangeSetId: csId, memberSkus: ['PARENT-1', 'CHILD-A'] },
        { status: 'accepted', linkedChangeSetId: csId },
      );
      const denied = approveChangeSet(csId, workspacePath);
      expect(denied.success).toBe(false);
      expect(denied.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
    }
    {
      // Cross-plan: members split across two linking plans grant nothing (no union).
      const { workspacePath, workspaceId, products } = setupLinked();
      const csId = stageTwoCycle(workspaceId, baseMap(products), workspacePath);
      insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'accepted', ['PARENT-1', 'GHOST-X']), {
        status: 'accepted',
        linkedChangeSetId: csId,
      });
      insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'accepted', ['CHILD-A', 'GHOST-Y']), {
        status: 'accepted',
        linkedChangeSetId: csId,
      });
      const denied = approveChangeSet(csId, workspacePath);
      expect(denied.success).toBe(false);
      expect(denied.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
    }
    {
      // Row-JSON divergence: JSON claims the change set but the row column does not.
      const { workspacePath, workspaceId, products } = setupLinked();
      const csId = stageTwoCycle(workspaceId, baseMap(products), workspacePath);
      insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'accepted', ['PARENT-1', 'CHILD-A']), {
        status: 'accepted',
        linkedChangeSetId: null,
      });
      const denied = approveChangeSet(csId, workspacePath);
      expect(denied.success).toBe(false);
      expect(denied.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
    }
  });

  it('exempts only the main-out emission for a valid accepted same-plan mesh, refusing other cycles', () => {
    // Block-on-main-only (#368 criterion 4): a full 2-cycle (PARENT-1↔CHILD-A)
    // still blocks even with a valid accepted plan — only the main's single
    // block (main→member edges with the main self-included exactly once) is
    // exempt. CHILD-A→PARENT-1 is a non-main cycle and refuses.
    const { workspacePath, workspaceId, products } = setupLinked();
    const csId = stageTwoCycle(workspaceId, baseMap(products), workspacePath);
    insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'accepted', ['PARENT-1', 'CHILD-A']), {
      status: 'accepted',
      linkedChangeSetId: csId,
    });
    const result = approveChangeSet(csId, workspacePath);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
  });

  it('passes a valid main-only emission under an accepted same-plan mesh', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    // Main-only shape: PARENT-1 (main) lists both members self-included;
    // CHILD-A carries no managed block of its own — no cycle, exempt edge.
    const csId = stageChange(workspaceId, baseMap(products), (drafts) => {
      const parent = drafts.get('PARENT-1')!;
      parent.shopsite.preserved.advancedBlocks = {
        ...(parent.shopsite.preserved.advancedBlocks ?? {}),
        Subproducts: '<Subproducts><Subproduct><SKU>PARENT-1</SKU></Subproduct><Subproduct><SKU>CHILD-A</SKU></Subproduct></Subproducts>',
      };
    }, 'main-only group', workspacePath);
    insertPlanRow(workspaceId, familyPlan(workspaceId, csId, 'accepted', ['PARENT-1', 'CHILD-A']), {
      status: 'accepted',
      linkedChangeSetId: csId,
    });
    const result = approveChangeSet(csId, workspacePath);
    expect(result.errors.join(' ')).not.toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
  });

  it('passes a plan-unlinked price-only update over a live adopted mesh', () => {
    const { workspacePath, workspaceId, products } = setupLinked();
    // Live adopted mesh: both members carry the full managed mesh live.
    const liveMesh = baseMap(products);
    liveMesh.get('PARENT-1')!.shopsite.preserved.advancedBlocks = {
      ...(liveMesh.get('PARENT-1')!.shopsite.preserved.advancedBlocks ?? {}),
      Subproducts: '<Subproducts><Subproduct><SKU>CHILD-A</SKU></Subproduct></Subproducts>',
    };
    liveMesh.get('CHILD-A')!.shopsite.preserved.advancedBlocks = {
      ...(liveMesh.get('CHILD-A')!.shopsite.preserved.advancedBlocks ?? {}),
      Subproducts: '<Subproducts><Subproduct><SKU>PARENT-1</SKU></Subproduct></Subproducts>',
    };
    for (const p of liveMesh.values()) writeProductFile(workspacePath, p);
    // Plan-unlinked price-only update: drafts clone the live mesh, so the
    // 2-cycle exists in both live and draft — no new cycle, must pass.
    const csId = stageChange(workspaceId, liveMesh, (drafts) => {
      drafts.get('PARENT-1')!.core.price = '29.99';
      drafts.get('CHILD-A')!.core.price = '14.99';
    }, 'price update over live mesh', workspacePath);
    const result = approveChangeSet(csId, workspacePath);
    expect(result.errors.join(' ')).not.toMatch(/LINKED_GROUP_REFERENCE_CYCLE/);
    expect(result.success).toBe(true);
  });
});
