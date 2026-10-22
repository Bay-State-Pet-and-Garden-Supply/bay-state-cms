import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { classifySubproductsSupport, setManagedSubproducts } from '../../shopsite/storefront-subproducts';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { approveChangeSet, loadApprovedLinkedExport, recoverLinkedApproval } from '../../server/services/change-set-service';
import { createChangeSet, upsertChangeSetItem, findLinkedManifest } from '../../db/repositories/change-set-repo';
import { getChangeSetDetail } from '../../server/services/change-set-service';
import {
  stageStorefrontFamilyPlan,
  stageNonFoodStorefrontFamilyPlan,
  decideStorefrontFamilyPlan,
  applyStorefrontFamilyPlan,
  checkStorefrontFamilyFreshness,
} from '../../classification/storefront-family-plan-service';
import { validateAdoptedFamilyChangeSet } from '../../validation/change-set-validation';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { findStorefrontFamilyPlanById, parseStorefrontFamilyPlan } from '../../db/repositories/storefront-family-plan-repo';
import type { Product } from '../../shared/types';
import type { FamilyMemberOrigin } from '../../shared/schemas/storefront-family';
import { validateFamilyMemberOrigin } from '../../classification/storefront-family-origin';
import { computeReviewedAuthorityHash } from '../../classification/promotion-gate';
import { approveFamilyCatalogProduct } from './family-authority';

// Redacted native-family shape (issue #368 §10): adopted families author
// real Subproducts + PF7 on the wire through the managed writer (the sole
// author). Unmanaged products keep raw preservation untouched.
let activeFamilyOrigins: Map<string, FamilyMemberOrigin> = new Map();
const NATIVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>FAM-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-5.jpg</Graphic><QuantityOnHand>7</QuantityOnHand>
<Weight>5 lb</Weight><ProductField7></ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
<Product><SKU>FAM-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-15.jpg</Graphic><QuantityOnHand>4</QuantityOnHand>
<Weight>15 lb</Weight><ProductField7></ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
<Product><SKU>FAM-30</SKU><Name>Acme Chicken Dinner 30 lb</Name><Price>59.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-30.jpg</Graphic><QuantityOnHand>2</QuantityOnHand>
<Weight>30 lb</Weight><ProductField7></ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
</Products></ShopSiteProducts>`;

function setupFamily() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-368-'));
  const dbPath = path.join(workspacePath, `family-368-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-368-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const decoded = ShopSiteProductCodec.decode(NATIVE_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for storefront family');
  const authorized = decoded.products.map((product) => approveFamilyCatalogProduct({
    workspaceId, workspacePath, product, productTypeId: 'dog-food-dry',
  }));
  activeFamilyOrigins = new Map(authorized.map((item) => [item.product.sku, item.origin] as const));
  return { workspacePath, workspaceId, products: authorized.map((item) => item.product) };
}

function memberInputs(products: Product[]) {
  const ounces: Record<string, number> = { 'FAM-5': 80, 'FAM-15': 240, 'FAM-30': 480 };
  return products.map((p) => ({
    sku: p.sku,
    origin: activeFamilyOrigins.get(p.sku)!,
    purchasable: true,
    brand: 'Acme',
    recipe: 'Chicken Dinner',
    flavor: 'Chicken',
    species: 'Dog',
    lifeStage: 'Adult',
    form: 'Dry Kibble',
    sizeRaw: p.core.weight ?? '5 lb',
    ounces: ounces[p.sku] ?? 80,
    retailUnit: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: p.shopsite.preserved.rawAttributes.reviewedTypeHash as string,
    evidenceHash: `evidence-${p.sku}`,
  }));
}


describe('storefront family smoke: review → revise/accept → approval → export (issue #368)', () => {
  it('completes the full path for three sizes with main self-membership, PF7, preservation, disabled state', () => {
    const { workspacePath, workspaceId, products } = setupFamily();
    const staged = stageStorefrontFamilyPlan({
      workspaceId,
      workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1',
      curationBySku: new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }])),
    });
    expect(staged.plan.mainSku).toBe('FAM-5');
    expect(staged.plan.members.map((m) => m.sku).sort()).toEqual(['FAM-15', 'FAM-30', 'FAM-5']);
    expect(new Set(staged.plan.pf7Proposals.map((p) => p.shortName)).size).toBe(3);

    const revised = decideStorefrontFamilyPlan({ planId: staged.plan.id, actor: 'operator-1', action: 'revise', mainOverrideSku: 'FAM-15' });
    expect(revised.plan.mainSku).toBe('FAM-15');
    expect(revised.plan.mainOverridden).toBe(true);
    const accepted = decideStorefrontFamilyPlan({ planId: revised.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');

    const applied = applyStorefrontFamilyPlan({
      planId: accepted.plan.id,
      workspaceId,
      workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const git = new GitClient(workspacePath);
    const headBefore = git.getHeadHash();
    const failedBeforeCommit = approveChangeSet(applied.changeSetId, workspacePath, { beforeCommit: true });
    expect(failedBeforeCommit.success).toBe(false);
    expect(git.getHeadHash()).toBe(headBefore);
    expect(getChangeSetDetail(applied.changeSetId).changeSet!.status).toBe('draft');
    expect(findLinkedManifest(applied.changeSetId)!.status).toBe('pending');
    const interrupted = approveChangeSet(applied.changeSetId, workspacePath, { afterCommitBeforeCompletion: true });
    expect(interrupted.success).toBe(false);
    const manifest = findLinkedManifest(applied.changeSetId)!;
    expect(manifest.status).toBe('committed');
    expect(manifest.commitHash).toMatch(/^[0-9a-f]{40}$/);
    const interruptedHash = manifest.commitHash!;
    expect(git.getHeadHash()).toBe(interruptedHash);
    const recovered = recoverLinkedApproval(applied.changeSetId, workspacePath);
    expect(recovered.success).toBe(true);
    expect(recovered.commitHash).toBe(interruptedHash);
    expect(git.getHeadHash()).toBe(interruptedHash);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.load.commitHash).toBe(interruptedHash);
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['FAM-15', 'FAM-30', 'FAM-5']);
    // Block-on-main-only emission (#368 criterion 4): the main (FAM-15
    // after the pre-acceptance override) carries the single managed block
    // with the full member set self-included exactly once; non-main members
    // carry no managed block of their own.
    for (const product of linked.load.products) {
      const atCommit = git.readFileAtCommit(interruptedHash, `products/${product.sku}.json`);
      expect(atCommit).not.toBeNull();
      expect(hashJson(JSON.parse(atCommit!))).toBe(hashJson(product));
      expect((product.customFields['ProductField7'] ?? '').length).toBeGreaterThan(0);
      expect(product.sku).toMatch(/^FAM-/);
      expect(product.status).toBe('draft');
      expect(product.core.media.primary).toMatch(/^media\/fam-/);
      const block = product.shopsite.preserved.advancedBlocks['Subproducts'];
      if (product.sku === 'FAM-15') {
        const refs = [...(block ?? '').matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)]
          .map((m) => m[1]!.trim())
          .sort();
        expect(refs).toEqual(['FAM-15', 'FAM-30', 'FAM-5']);
      } else {
        expect(block ?? '').not.toMatch(/<SKU\s*>/);
      }
    }
    expect(new Set(linked.load.products.map((p) => p.customFields['ProductField7'])).size).toBe(3);
    const pkg = ShopSiteProductCodec.encodeMany(linked.load.products);
    expect((pkg.xml.match(/<Subproducts>/g) ?? []).length).toBe(1);
    expect((pkg.xml.match(/<Subproduct>/g) ?? []).length).toBe(3);
    expect(pkg.xml).toContain('<ProductDisabled>checked</ProductDisabled>');
    expect(pkg.xml).toContain('<MoreInformationText>');
    const familyRow = findStorefrontFamilyPlanById(accepted.plan.id)!;
    expect(parseStorefrontFamilyPlan(familyRow.planJson).linkedChangeSetId).toBe(applied.changeSetId);
  });

  it('validates generated catalog origins and refuses missing, wrong-run, stale-product, and wrong-commit bindings', () => {
    const { workspacePath, workspaceId, products } = setupFamily();
    const product = products[0]!;
    const origin = activeFamilyOrigins.get(product.sku)!;
    if (origin.kind !== 'catalog') throw new Error('Expected catalog origin in fixture');
    expect(validateFamilyMemberOrigin({ workspaceId, workspacePath, sku: product.sku, origin }).ok).toBe(true);
    expect(validateFamilyMemberOrigin({ workspaceId, workspacePath, sku: product.sku, origin: undefined }))
      .toMatchObject({ ok: false, code: 'family_origin_missing' });
    expect(validateFamilyMemberOrigin({
      workspaceId, workspacePath, sku: product.sku,
      origin: { ...origin, classificationRunId: null },
    })).toMatchObject({ ok: false, code: 'catalog_origin_unverified' });
    expect(validateFamilyMemberOrigin({
      workspaceId, workspacePath, sku: product.sku,
      origin: { ...origin, classificationRunId: 'wrong-run' },
    })).toMatchObject({ ok: false, code: 'catalog_origin_unverified' });
    expect(validateFamilyMemberOrigin({
      workspaceId, workspacePath, sku: product.sku,
      origin: { ...origin, approvedCommit: 'f'.repeat(40) },
    })).toMatchObject({ ok: false, code: 'catalog_origin_unverified' });
    const changed = structuredClone(product);
    changed.core.price = '99.99';
    writeProductFile(workspacePath, changed);
    expect(validateFamilyMemberOrigin({ workspaceId, workspacePath, sku: product.sku, origin }))
      .toMatchObject({ ok: false, code: 'catalog_origin_unverified' });
  });

  it('keeps unmanaged Subproducts raw-preserved, refuses unsafe structures, stale bases, and refusals', () => {
    const { products } = setupFamily();
    const encoded = ShopSiteProductCodec.encode(products[0]!).xml;
    expect(encoded).not.toMatch(/<Subproducts>/);
    const nested = structuredClone(products[0]!);
    nested.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproducts><SKU>GHOST</SKU></Subproducts></Subproducts>';
    expect(classifySubproductsSupport(nested).code).toBe('unsupported_nested');
    // Stale base through the shared precheck: editing live state after
    // staging blocks the whole group at approval.
    const ctx = setupFamily();
    const stagedStale = stageStorefrontFamilyPlan({
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      input: { members: memberInputs(ctx.products), mainSku: undefined },
      actor: 'operator-1',
      curationBySku: new Map(ctx.products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }])),
    });
    const acceptedStale = decideStorefrontFamilyPlan({ planId: stagedStale.plan.id, actor: 'r', action: 'accept' });
    const appliedStale = applyStorefrontFamilyPlan({
      planId: acceptedStale.plan.id,
      workspaceId: ctx.workspaceId,
      workspacePath: ctx.workspacePath,
      draftsBySku: new Map(ctx.products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'r',
    });
    const liveEdit = structuredClone(ctx.products[0]!);
    liveEdit.core.price = '99.99';
    writeProductFile(ctx.workspacePath, liveEdit);
    const denied = approveChangeSet(appliedStale.changeSetId, ctx.workspacePath);
    expect(denied.success).toBe(false);
    // Managed writer keeps a single canonical block (no duplicates).
    const managed = setManagedSubproducts(structuredClone(ctx.products[0]!), 'plan-x', [
      { sku: 'FAM-5', name: 'F 5' },
      { sku: 'FAM-15', name: 'F 15' },
      { sku: 'FAM-30', name: 'F 30' },
    ]);
    expect(Object.keys(managed.shopsite.preserved.advancedBlocks).filter((k) => k.toLowerCase() === 'subproducts')).toEqual(['Subproducts']);
  });

  it('blocks unlinked partial change sets from claiming family completeness', () => {
    const { workspaceId, products } = setupFamily();
    const cs = createChangeSet({ workspaceId, title: 'partial family', baseCommit: 'test' });
    const single = structuredClone(products[0]!);
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: single.sku,
      operation: 'update',
      draftJson: deterministicStringify(single),
      baseJson: deterministicStringify(single),
      draftHash: hashJson(single),
    });
    // No linking plan for this ad-hoc set: non-family drafts pass through untouched.
    const gate = validateAdoptedFamilyChangeSet(cs.id, [
      { sku: single.sku, draftJson: deterministicStringify(single), baseJson: deterministicStringify(single) },
    ]);
    expect(gate).toEqual([]);
  });

  it('N8: defer/reject leave standalone releasable, nonmember override and duplicate SKUs refuse, freshness stales', () => {
    const { workspacePath, workspaceId, products } = setupFamily();
    const curation = new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }]));
    // Defer leaves the plan deferred (standalone releasable, no Cohort
    // barrier) and apply refuses a non-accepted plan.
    const deferred = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    });
    const deferView = decideStorefrontFamilyPlan({ planId: deferred.plan.id, actor: 'operator-1', action: 'defer' });
    expect(deferView.plan.status).toBe('deferred');
    expect(() => applyStorefrontFamilyPlan({
      planId: deferred.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'operator-1',
    })).toThrow(/family_plan_not_accepted/);
    // Reject likewise leaves a rejected unapplied plan.
    const rejected = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    });
    expect(decideStorefrontFamilyPlan({ planId: rejected.plan.id, actor: 'r', action: 'reject' }).plan.status).toBe('rejected');
    // Override to a nonmember refuses closed.
    const staged = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    });
    expect(() => decideStorefrontFamilyPlan({
      planId: staged.plan.id, actor: 'operator-1', action: 'revise', mainOverrideSku: 'GHOST-SKU',
    })).toThrow(/family_main_not_member/);
    expect(() => stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: 'GHOST-SKU' },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/family_main_not_member/);
    // Duplicate-SKU staging refuses closed.
    const dupes = [...memberInputs(products), memberInputs(products)[0]!];
    expect(() => stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: dupes, mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/duplicate/i);
    // N2: accept → revise → apply without re-accept refuses; re-accept heals.
    const lifecycle = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    });
    decideStorefrontFamilyPlan({ planId: lifecycle.plan.id, actor: 'a', action: 'accept' });
    decideStorefrontFamilyPlan({ planId: lifecycle.plan.id, actor: 'a', action: 'revise', mainOverrideSku: 'FAM-15' });
    expect(() => applyStorefrontFamilyPlan({
      planId: lifecycle.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'a',
    })).toThrow(/family_plan_not_accepted/);
    const reaccepted = decideStorefrontFamilyPlan({ planId: lifecycle.plan.id, actor: 'a', action: 'accept' });
    expect(reaccepted.plan.status).toBe('accepted');
    // N6: per-member evidence drift marks the plan stale directly.
    const stale = checkStorefrontFamilyFreshness({
      planId: reaccepted.plan.id,
      workspacePath,
      liveBySku: new Map(products.map((p) => [p.sku, p])),
      currentTypeHashBySku: new Map(products.map((p) => [p.sku, p.shopsite.preserved.rawAttributes.reviewedTypeHash as string])),
      currentEvidenceHashBySku: new Map(products.map((p) => [p.sku, p.sku === 'FAM-5' ? 'evidence-drifted' : `evidence-${p.sku}`])),
    });
    expect(stale.fresh).toBe(false);
    expect(stale.reasons.some((r) => r.includes('FAM-5') && r.includes('evidence'))).toBe(true);
    expect(findStorefrontFamilyPlanById(reaccepted.plan.id)!.status).toBe('stale');
  });

  it('B2: unsupported native structures refuse adoption with preservation', () => {
    const { workspacePath, workspaceId, products } = setupFamily();
    const nested = structuredClone(products[0]!);
    nested.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproducts><SKU>GHOST</SKU></Subproducts></Subproducts>';
    const curation = new Map(products.map((p) => [
      p.sku,
      { base: p, draftBase: p.sku === nested.sku ? nested : structuredClone(p) },
    ]));
    // Stage refuses closed; the raw block is never overwritten.
    expect(() => stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/family_native_unsupported/);
    expect(nested.shopsite.preserved.advancedBlocks['Subproducts']).toContain('<Subproducts><Subproducts>');
    // Apply refuses closed when the unsafe block appears after staging.
    const clean = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { members: memberInputs(products), mainSku: undefined },
      actor: 'operator-1',
      curationBySku: new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }])),
    });
    decideStorefrontFamilyPlan({ planId: clean.plan.id, actor: 'a', action: 'accept' });
    const driftedDrafts = new Map(products.map((p) => [p.sku, structuredClone(p)]));
    driftedDrafts.set(nested.sku, nested);
    expect(() => applyStorefrontFamilyPlan({
      planId: clean.plan.id, workspaceId, workspacePath,
      draftsBySku: driftedDrafts, actor: 'a',
    })).toThrow(/family_native_unsupported/);
  });
});

const NON_FOOD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>NF-S-RED</SKU><Name>Acme Trail Harness Small Red</Name><Price>24.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/nf-s-red.jpg</Graphic><QuantityOnHand>7</QuantityOnHand>
<ProductField7>Small Red</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<MoreInformationText>Nylon walking harness.</MoreInformationText></Product>
<Product><SKU>NF-S-BLUE</SKU><Name>Acme Trail Harness Small Blue</Name><Price>24.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/nf-s-blue.jpg</Graphic><QuantityOnHand>4</QuantityOnHand>
<ProductField7></ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<MoreInformationText>Nylon walking harness.</MoreInformationText></Product>
<Product><SKU>NF-L-RED</SKU><Name>Acme Trail Harness Large Red</Name><Price>29.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/nf-l-red.jpg</Graphic><QuantityOnHand>2</QuantityOnHand>
<ProductField7></ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<MoreInformationText>Nylon walking harness.</MoreInformationText></Product>
</Products></ShopSiteProducts>`;

function setupNonFoodFamily() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-372-'));
  const dbPath = path.join(workspacePath, `family-372-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-372-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const decoded = ShopSiteProductCodec.decode(NON_FOOD_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for non-food storefront family');
  const authorized = decoded.products.map((product) => approveFamilyCatalogProduct({
    workspaceId, workspacePath, product, productTypeId: 'collars-leashes',
  }));
  activeFamilyOrigins = new Map(authorized.map((item) => [item.product.sku, item.origin] as const));
  return { workspacePath, workspaceId, products: authorized.map((item) => item.product) };
}

function nonFoodMemberInputs(): Array<{
  sku: string; origin: { kind: 'catalog'; approvedCommit: string; productHash: string; classificationRunId: string | null; classificationHash: string }; purchasable: boolean;
  brand: string; model: string; material: string; function: string; safetyDose: string; strength: string; fit: string;
  sizeRaw: string; colorRaw: string; ounces: null; countRaw: null; countQuantity: null; retailUnit: null;
  packCountDeclared: boolean; packCount: null; reviewedTypeHash: string; reviewedProductTypeId: string; evidenceHash: string;
}> {
  const defs: Array<{ sku: string; size: string; color: string }> = [
    { sku: 'NF-S-RED', size: 'Small', color: 'Red' },
    { sku: 'NF-S-BLUE', size: 'Small', color: 'Blue' },
    { sku: 'NF-L-RED', size: 'Large', color: 'Red' },
  ];
  return defs.map((d) => {
    const origin = activeFamilyOrigins.get(d.sku);
    if (!origin || origin.kind !== 'catalog') throw new Error(`Expected catalog origin for ${d.sku}`);
    return {
      sku: d.sku,
      origin,
      purchasable: true,
      retailUnit: null,
      brand: 'Acme',
      model: 'Trail Harness',
      material: 'Nylon',
      function: 'Walking',
      safetyDose: 'N/A',
      strength: 'Standard',
      fit: 'Adjustable',
      sizeRaw: d.size,
      colorRaw: d.color,
      ounces: null,
      countRaw: null,
      countQuantity: null,
      packCountDeclared: false,
      packCount: null,
      reviewedTypeHash: computeReviewedAuthorityHash('collars-leashes') ?? (() => { throw new Error('Missing collars-leashes authority hash'); })(),
      reviewedProductTypeId: 'collars-leashes',
      evidenceHash: `evidence-${d.sku}`,
    };
  });
}

describe('non-food family smoke: review → revise/accept → approval → export (issue #372)', () => {
  it('completes the full size/color path with unique labels, preserved data/main, and shared export contracts', () => {
    const { workspacePath, workspaceId, products } = setupNonFoodFamily();
    const curation = new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }]));
    const staged = stageNonFoodStorefrontFamilyPlan({
      workspaceId,
      workspacePath,
      input: {
        ruleVersion: 'non-food-size-color-family-variant-rule-v1',
        members: nonFoodMemberInputs(),
        mainSku: 'NF-S-RED',
      },
      actor: 'operator-1',
      curationBySku: curation,
    });
    const preserved = staged.plan.pf7Proposals.find((p) => p.sku === 'NF-S-RED');
    expect(preserved).toBeDefined();
    expect(new Set(staged.plan.pf7Proposals.map((p) => p.shortName)).size).toBe(3);
    expect(staged.plan.mainSku).toBe('NF-S-RED');
    expect(staged.plan.mainOverridden).toBe(true);
    expect(staged.plan.members.every((m) => m.productTypeId === 'collars-leashes')).toBe(true);
    const accepted = decideStorefrontFamilyPlan({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const applied = applyStorefrontFamilyPlan({
      planId: accepted.plan.id,
      workspaceId,
      workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const approved = approveChangeSet(applied.changeSetId, workspacePath);

    expect(approved.success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['NF-L-RED', 'NF-S-BLUE', 'NF-S-RED']);
    for (const product of linked.load.products) {
      // Main-only emission: only the main (NF-S-RED) carries the managed
      // block (full member set, self-included exactly once); non-main
      // members carry no managed member refs.
      const block = product.shopsite.preserved.advancedBlocks['Subproducts'] ?? '';
      if (product.sku === 'NF-S-RED') {
        const refs = [...block.matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)]
          .map((m) => m[1]!.trim())
          .sort();
        expect(refs).toEqual(['NF-L-RED', 'NF-S-BLUE', 'NF-S-RED']);
      } else {
        expect(block).not.toMatch(/<SKU\s*>/);
      }
      expect((product.customFields['ProductField7'] ?? '').length).toBeGreaterThan(0);
      expect(product.status).toBe('draft');
      const baseline = products.find((p) => p.sku === product.sku)!;
      expect(product.core.name).toBe(baseline.core.name);
      expect(product.core.price).toBe(baseline.core.price);
      expect(product.core.media.primary).toBe(baseline.core.media.primary);
    }
    expect(new Set(linked.load.products.map((p) => p.customFields['ProductField7'])).size).toBe(3);
    const pkg = ShopSiteProductCodec.encodeMany(linked.load.products);
    expect((pkg.xml.match(/<Subproducts>/g) ?? []).length).toBe(1);
  });

  it('refuses material merges and undeclared-axis joins; stale type invalidates', () => {
    const { workspacePath, workspaceId, products } = setupNonFoodFamily();
    const curation = new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }]));
    const badMaterial = nonFoodMemberInputs().map((m) =>
      m.sku === 'NF-L-RED' ? { ...m, material: 'Leather' } : m,
    );
    expect(() => stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-size-color-family-variant-rule-v1', members: badMaterial },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/family_rule_invariant_conflict/);
    // Color-only rule with a size difference refuses as an undeclared axis
    // (NF-S-RED vs NF-L-RED: sizes differ where only color may vary).
    const sizeDiffUnderColor = nonFoodMemberInputs()
      .filter((m) => m.colorRaw === 'Red')
      .map((m) => ({ ...m, reviewedProductTypeId: 'dog-toys' }));
    expect(sizeDiffUnderColor.map((m) => m.sku)).toEqual(['NF-S-RED', 'NF-L-RED']);
    expect(() => stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-color-family-variant-rule-v1', members: sizeDiffUnderColor },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/family_rule_unsupported_axis/);
    const staged = stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-size-color-family-variant-rule-v1', members: nonFoodMemberInputs(), mainSku: 'NF-S-RED' },
      actor: 'operator-1', curationBySku: curation,
    });
    decideStorefrontFamilyPlan({ planId: staged.plan.id, actor: 'r', action: 'accept' });
    const staleType = checkStorefrontFamilyFreshness({
      planId: staged.plan.id,
      workspacePath,
      liveBySku: new Map(products.map((p) => [p.sku, p])),
      currentTypeHashBySku: new Map(products.map((p) => [p.sku, 'reviewed-type-moved'])),
      currentEvidenceHashBySku: new Map(products.map((p) => [p.sku, `evidence-${p.sku}`])),
    });
    expect(staleType.fresh).toBe(false);
    expect(staleType.reasons.some((r) => r.includes('type authority'))).toBe(true);
  });

  it('completes the count-combination path with main-only emission', () => {
    const { workspacePath, workspaceId, products: initialProducts } = setupNonFoodFamily();
    const authorized = initialProducts.map((product) => approveFamilyCatalogProduct({
      workspaceId, workspacePath, product, productTypeId: 'dog-waste-bags',
    }));
    const products = authorized.map((item) => item.product);
    activeFamilyOrigins = new Map(authorized.map((item) => [item.product.sku, item.origin] as const));
    const curation = new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }]));
    const defs = [
      { sku: 'NF-S-RED', sizeRaw: 'Small', colorRaw: 'Red', countRaw: '60 ct', countQuantity: 60 },
      { sku: 'NF-S-BLUE', sizeRaw: 'Small', colorRaw: 'Blue', countRaw: '60 ct', countQuantity: 60 },
      { sku: 'NF-L-RED', sizeRaw: 'Large', colorRaw: 'Red', countRaw: '120 ct', countQuantity: 120 },
    ];
    const members = defs.map((d) => ({
      sku: d.sku,
      origin: activeFamilyOrigins.get(d.sku)!,
      purchasable: true,
      ounces: null,
      retailUnit: null,
      brand: 'Acme',
      model: 'Waste Bags',
      material: 'Plastic',
      function: 'Cleanup',
      safetyDose: 'N/A',
      strength: 'Standard',
      fit: 'Tie',
      sizeRaw: d.sizeRaw,
      colorRaw: d.colorRaw,
      countRaw: d.countRaw,
      countQuantity: d.countQuantity,
      packCountDeclared: true,
      packCount: d.countQuantity,
      reviewedTypeHash: computeReviewedAuthorityHash('dog-waste-bags') ?? (() => { throw new Error('Missing dog-waste-bags authority hash'); })(),
      reviewedProductTypeId: 'dog-waste-bags',
      evidenceHash: 'evidence-' + d.sku,
    }));
    const staged = stageNonFoodStorefrontFamilyPlan({
      workspaceId,
      workspacePath,
      input: { ruleVersion: 'non-food-size-color-count-family-variant-rule-v1', members, mainSku: 'NF-S-RED' },
      actor: 'operator-1',
      curationBySku: curation,
    });
    expect(staged.plan.mainSku).toBe('NF-S-RED');
    const accepted = decideStorefrontFamilyPlan({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const applied = applyStorefrontFamilyPlan({
      planId: accepted.plan.id,
      workspaceId,
      workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const approved = approveChangeSet(applied.changeSetId, workspacePath);
    expect(approved.success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    for (const product of linked.load.products) {
      const block = product.shopsite.preserved.advancedBlocks['Subproducts'] ?? '';
      if (product.sku === 'NF-S-RED') {
        const refs = Array.from(block.matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)).map((m) => String(m[1]).trim()).sort();
        expect(refs).toEqual(['NF-L-RED', 'NF-S-BLUE', 'NF-S-RED']);
      } else {
        expect(block).not.toMatch(/<SKU\s*>/);
      }
    }
    const pkg = ShopSiteProductCodec.encodeMany(linked.load.products);
    expect((pkg.xml.match(/<Subproducts>/g) ?? []).length).toBe(1);
  });

  it('stales on rule reconfiguration/product-type drift; stages color-only without size', () => {
    const { workspacePath, workspaceId, products } = setupNonFoodFamily();
    const curation = new Map(products.map((p) => [p.sku, { base: p, draftBase: structuredClone(p) }]));
    // Size-absent color-only members stage under the color rule (size is not
    // a permitted axis there) but refuse under the size rule.
    const colorNoSize = nonFoodMemberInputs().slice(0, 2).map((m) => ({ ...m, sizeRaw: null, reviewedProductTypeId: 'dog-toys' }));
    const stagedColor = stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-color-family-variant-rule-v1', members: colorNoSize, mainSku: colorNoSize[0]!.sku },
      actor: 'operator-1', curationBySku: curation,
    });
    expect(stagedColor.plan.members.every((m) => m.sizeRaw == null)).toBe(true);
    expect(() => stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-size-family-variant-rule-v1', members: nonFoodMemberInputs().slice(0, 2).map((m) => ({ ...m, sizeRaw: null })) },
      actor: 'operator-1', curationBySku: curation,
    })).toThrow(/family_rule_missing_variant/);
    // Rule reconfiguration that keeps the type hash: a moved productTypeId
    // (and resolved rule version) stales the plan via the served maps.
    const staged = stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: { ruleVersion: 'non-food-size-color-family-variant-rule-v1', members: nonFoodMemberInputs(), mainSku: 'NF-S-RED' },
      actor: 'operator-1', curationBySku: curation,
    });
    decideStorefrontFamilyPlan({ planId: staged.plan.id, actor: 'r', action: 'accept' });
    const sameHashRuleDrift = checkStorefrontFamilyFreshness({
      planId: staged.plan.id,
      workspacePath,
      liveBySku: new Map(products.map((p) => [p.sku, p])),
      currentTypeHashBySku: new Map(products.map((p) => [p.sku, p.shopsite.preserved.rawAttributes.reviewedTypeHash as string])),
      currentEvidenceHashBySku: new Map(products.map((p) => [p.sku, `evidence-${p.sku}`])),
      currentRuleVersionBySku: new Map(products.map((p) => [p.sku, 'non-food-color-family-variant-rule-v1'])),
    });
    expect(sameHashRuleDrift.fresh).toBe(false);
    expect(sameHashRuleDrift.reasons.some((r) => r.includes('stale rule'))).toBe(true);
  });
});
