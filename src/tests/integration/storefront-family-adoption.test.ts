import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import {
  classifyNativeAdoption,
  clearSubproductsBlock,
  hasExplicitSubproductsClear,
  isManagedFamilyProduct,
} from '../../shopsite/storefront-subproducts';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { approveChangeSet, loadApprovedLinkedExport } from '../../server/services/change-set-service';
import {
  stageNativeAdoption,
  previewNativeAdoption,
  stageMembershipChange,
  applyAdoptedFamilyPlan,
  type AdoptionEvidence,
} from '../../classification/storefront-family-adoption';
import { decideStorefrontFamilyPlan as decidePlan } from '../../classification/storefront-family-plan-service';
import { validateAdoptedFamilyChangeSet } from '../../validation/change-set-validation';
import { createChangeSet, upsertChangeSetItem, listChangeSetItems } from '../../db/repositories/change-set-repo';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { findStorefrontFamilyPlanById, parseStorefrontFamilyPlan } from '../../db/repositories/storefront-family-plan-repo';
import type { Product } from '../../shared/types';

// Native family as the live store actually persists it (issue #369): the
// existing main hosts one raw Subproducts block listing every member
// (main self-included, purchasable), nonempty PF7 labels, and supported
// child metadata (<Price>/<Name> per member). Accessory/ambiguous shapes
// below reuse this base with targeted mutations.
const NATIVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>ADOPT-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/adopt-5.jpg</Graphic><QuantityOnHand>7</QuantityOnHand>
<Weight>5 lb</Weight><ProductField7>Acme 5 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText>
<Subproducts><Subproduct><SKU>ADOPT-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price></Subproduct><Subproduct><SKU>ADOPT-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price></Subproduct><Subproduct><SKU>ADOPT-30</SKU><Name>Acme Chicken Dinner 30 lb</Name><Price>59.99</Price></Subproducts>
</Product>
<Product><SKU>ADOPT-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/adopt-15.jpg</Graphic><QuantityOnHand>4</QuantityOnHand>
<Weight>15 lb</Weight><ProductField7>Acme 15 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
<Product><SKU>ADOPT-30</SKU><Name>Acme Chicken Dinner 30 lb</Name><Price>59.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/adopt-30.jpg</Graphic><QuantityOnHand>2</QuantityOnHand>
<Weight>30 lb</Weight><ProductField7>Acme 30 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
</Products></ShopSiteProducts>`;

function setupNative() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-369-'));
  const dbPath = path.join(workspacePath, `family-369-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-369-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  git.commit('Baseline native family for adoption');
  return { workspacePath, workspaceId, products: decoded.products };
}

function axisFor(p: Product) {
  const ounces: Record<string, number> = { 'ADOPT-5': 80, 'ADOPT-15': 240, 'ADOPT-30': 480 };
  return {
    brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog',
    lifeStage: 'Adult', form: 'Dry Kibble',
    sizeRaw: p.core.weight ?? '5 lb', ounces: ounces[p.sku] ?? 80,
    retailUnit: null, packCountDeclared: false, packCount: null, purchasable: true,
  };
}

function evidenceFor(products: Product[]): Map<string, AdoptionEvidence> {
  return new Map(products.map((p) => [p.sku, {
    base: structuredClone(p),
    draftBase: structuredClone(p),
    reviewedTypeHash: 'reviewed-type-v1',
    evidenceHash: `evidence-${p.sku}`,
    axis: axisFor(p),
  }]));
}

describe('native family adoption (issue #369)', () => {
  it('round-trips the unmanaged native relationship byte-identical with zero adoption', () => {
    const { products } = setupNative();
    const host = products.find((p) => p.sku === 'ADOPT-5')!;
    const encoded = ShopSiteProductCodec.encode(host).xml;
    expect(encoded).toContain('<Subproducts>');
    expect(encoded).toContain('<SKU>ADOPT-5</SKU>');
    expect(encoded).toContain('<SKU>ADOPT-15</SKU>');
    expect(encoded).toContain('<SKU>ADOPT-30</SKU>');
    expect(encoded).toContain('<Price>19.99</Price>');
    // Unmanaged: no managed markers, raw block preserved verbatim.
    expect(isManagedFamilyProduct(host)).toBe(false);
    expect(hasExplicitSubproductsClear(host)).toBe(false);
  });

  it('previews the complete native relationship, then adopts with main/labels/order preserved', () => {
    const { workspacePath, workspaceId, products } = setupNative();
    const liveBySku = new Map(products.map((p) => [p.sku, structuredClone(p) as Product | null]));
    const preview = previewNativeAdoption({
      workspaceId, workspacePath,
      skus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      liveBySku,
      evidenceBySku: new Map(products.map((p) => [p.sku, { reviewedTypeHash: 'reviewed-type-v1', evidenceHash: `evidence-${p.sku}` }])),
      axisOf: (p) => axisFor(p),
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.support.code).toBe('adoptable_family');
    expect(preview.relationship.mainSku).toBe('ADOPT-5');
    // Document order preserved verbatim (native block order, not SKU sort).
    expect(preview.relationship.memberSkus).toEqual(['ADOPT-5', 'ADOPT-15', 'ADOPT-30']);
    expect(preview.relationship.order).toEqual(['ADOPT-5', 'ADOPT-15', 'ADOPT-30']);
    expect(preview.relationship.existingLabels).toEqual([
      { sku: 'ADOPT-5', pf7: 'Acme 5 lb' },
      { sku: 'ADOPT-15', pf7: 'Acme 15 lb' },
      { sku: 'ADOPT-30', pf7: 'Acme 30 lb' },
    ]);
    // Supported child metadata carried verbatim (Price + child Name values).
    expect(preview.relationship.supportedMetadata).toEqual([
      { sku: 'ADOPT-5', price: '19.99', childName: 'Acme Chicken Dinner 5 lb' },
      { sku: 'ADOPT-15', price: '39.99', childName: 'Acme Chicken Dinner 15 lb' },
      { sku: 'ADOPT-30', price: '59.99', childName: 'Acme Chicken Dinner 30 lb' },
    ]);
    expect(preview.relationship.invariantEvidence.every((r) => r.agreed)).toBe(true);
    for (const pf7 of preview.pf7Disposition) {
      expect(pf7.replaced).toBe(false);
      expect(pf7.existing).toBe(pf7.proposed);
    }

    const staged = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['ADOPT-30', 'ADOPT-5', 'ADOPT-15'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(products),
    });
    // Existing main preserved verbatim (never re-nominated to smallest).
    expect(staged.plan.mainSku).toBe('ADOPT-5');
    expect(staged.plan.mainOverridden).toBe(false);
    // Existing nonempty PF7 labels preserved verbatim.
    expect(staged.plan.pf7Proposals).toEqual([
      { sku: 'ADOPT-15', shortName: 'Acme 15 lb', replaced: false },
      { sku: 'ADOPT-30', shortName: 'Acme 30 lb', replaced: false },
      { sku: 'ADOPT-5', shortName: 'Acme 5 lb', replaced: false },
    ]);
    const accepted = decidePlan({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const applied = applyAdoptedFamilyPlan({
      planId: accepted.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const approved = approveChangeSet(applied.changeSetId, workspacePath);
    expect(approved.success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['ADOPT-15', 'ADOPT-30', 'ADOPT-5']);
    // Block-on-main-only emission (#368 criterion 4): the native main
    // (ADOPT-5, the sole native host) carries the single managed block with
    // the full member set in preserved native document order; non-main
    // members carry no managed block of their own. Other cycles refuse.
    for (const product of linked.load.products) {
      const block = product.shopsite.preserved.advancedBlocks['Subproducts'] ?? '';
      if (product.sku === 'ADOPT-5') {
        const refs = [...block.matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)]
          .map((m) => m[1]!.trim());
        // Native document order preserved (not SKU-sorted); main
        // self-included exactly once; purchasable preserved.
        expect(refs).toEqual(['ADOPT-5', 'ADOPT-15', 'ADOPT-30']);
        expect(refs.filter((r) => r === product.sku)).toHaveLength(1);
        // Supported child metadata verbatim on the managed block.
        expect(block).toContain('<Price>19.99</Price>');
        expect(block).toContain('<Name>Acme Chicken Dinner 15 lb</Name>');
      } else {
        expect(block).not.toMatch(/<SKU\s*>/);
      }
    }
    const familyRow = findStorefrontFamilyPlanById(accepted.plan.id)!;
    expect(parseStorefrontFamilyPlan(familyRow.planJson).linkedChangeSetId).toBe(applied.changeSetId);
  });

  it('refuses accessory, incomplete, ambiguous, malformed, and unsupported natives with preservation', () => {
    const { workspacePath, workspaceId, products } = setupNative();
    const live = new Map(products.map((p) => [p.sku, structuredClone(p) as Product | null]));
    const ev = new Map(products.map((p) => [p.sku, { reviewedTypeHash: 'reviewed-type-v1', evidenceHash: `evidence-${p.sku}` }]));
    const axisOf = (p: Product) => axisFor(p);

    // Accessory: host lists only children, never itself — never reinterpreted.
    const accessory = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    accessory.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproduct><SKU>TOY-1</SKU><Name>Cat Toy</Name></Subproduct><Subproduct><SKU>TOY-2</SKU><Name>Cat Toy 2</Name></Subproduct></Subproducts>';
    expect(classifyNativeAdoption(accessory, ['ADOPT-5', 'TOY-1', 'TOY-2']).code).toBe('refused_accessory');
    // A host-less group (no block at all) is not a family.
    expect(classifyNativeAdoption(structuredClone(products.find((p) => p.sku === 'ADOPT-15')!), ['ADOPT-15', 'ADOPT-30']).code)
      .toBe('refused_not_family');
    // Incomplete: native block names 3 members, supplied group names 2.
    const incomplete = previewNativeAdoption({
      workspaceId, workspacePath, skus: ['ADOPT-5', 'ADOPT-15'],
      liveBySku: live, evidenceBySku: ev, axisOf,
    });
    expect(incomplete.blockers.some((b) => b.includes('family_native_incomplete'))).toBe(true);
    // Ambiguous: duplicate refs.
    const dupe = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    dupe.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproduct><SKU>ADOPT-5</SKU></Subproduct><Subproduct><SKU>ADOPT-5</SKU></Subproduct></Subproducts>';
    expect(classifyNativeAdoption(dupe, ['ADOPT-5']).code).toBe('refused_ambiguous');
    // Malformed: stanza without SKU identity.
    const malformed = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    malformed.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproduct><Name>No Sku</Name></Subproduct><Subproduct><SKU>ADOPT-5</SKU></Subproduct></Subproducts>';
    expect(classifyNativeAdoption(malformed, ['ADOPT-5']).code).toBe('refused_unsupported');
    // Unsupported: nested blocks.
    const nested = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    nested.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproducts><SKU>GHOST</SKU></Subproducts></Subproducts>';
    expect(classifyNativeAdoption(nested, ['ADOPT-5', 'GHOST']).code).toBe('refused_unsupported');
    // Refused adoptions never mutate: raw block byte-identical.
    const rawBefore = products.find((p) => p.sku === 'ADOPT-5')!.shopsite.preserved.advancedBlocks['Subproducts'];
    expect(() => stageNativeAdoption({
      workspaceId, workspacePath, memberSkus: ['ADOPT-5', 'ADOPT-15'],
      actor: 'operator-1', evidenceBySku: evidenceFor(products),
    })).toThrow(/family_native_/);
    expect(products.find((p) => p.sku === 'ADOPT-5')!.shopsite.preserved.advancedBlocks['Subproducts']).toBe(rawBefore);
  });

  it('removes a member and dissolves as reviewed revisions with explicit clear semantics', () => {
    const { workspacePath, workspaceId, products } = setupNative();
    const staged = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(products),
    });
    const liveBySku = new Map(products.map((p) => [p.sku, structuredClone(p) as Product | null]));
    // Removing the main without dissolving refuses.
    expect(() => stageMembershipChange({
      planId: staged.plan.id, actor: 'operator-1',
      removeSkus: ['ADOPT-5'], dissolve: false, liveBySku,
    })).toThrow(/family_removal_main/);
    // Removing down to one member refuses — dissolve instead.
    expect(() => stageMembershipChange({
      planId: staged.plan.id, actor: 'operator-1',
      removeSkus: ['ADOPT-15', 'ADOPT-30'], dissolve: false, liveBySku,
    })).toThrow(/family_removal_too_few/);
    // Unknown SKUs are not members: clean not_member refusal (no ghost revision).
    expect(() => stageMembershipChange({
      planId: staged.plan.id, actor: 'operator-1',
      removeSkus: ['GHOST'], dissolve: false, liveBySku,
    })).toThrow(/family_removal_not_member/);
    // Rule-violating remainder refuses AT STAGE: mutating the live base of a
    // remaining member (different flavor) breaks the same-family subset, so
    // the removal never stages a revised revision (no late apply/gate wait).
    const violatingLive = new Map(products.map((p) => [p.sku, structuredClone(p) as Product | null]));
    violatingLive.get('ADOPT-15')!.customFields['ProductField23'] = 'Beef';
    expect(() => stageMembershipChange({
      planId: staged.plan.id, actor: 'operator-1',
      removeSkus: ['ADOPT-30'], dissolve: false, liveBySku: violatingLive,
    })).toThrow(/FAMILY_INVARIANT_CONFLICT/);
    expect(parseStorefrontFamilyPlan(findStorefrontFamilyPlanById(staged.plan.id)!.planJson).revision).toBe(0);
    // Explicit supported removal: ADOPT-30 leaves; main + ADOPT-15 remain.
    const removal = stageMembershipChange({
      planId: staged.plan.id, actor: 'operator-1',
      removeSkus: ['ADOPT-30'], dissolve: false, liveBySku,
    });
    expect(removal.plan.status).toBe('revised');
    expect(removal.plan.revision).toBe(1);
    const acceptedRemoval = decidePlan({ planId: removal.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(acceptedRemoval.plan.status).toBe('accepted');
    const appliedRemoval = applyAdoptedFamilyPlan({
      planId: acceptedRemoval.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const removalItems = listChangeSetItems(appliedRemoval.changeSetId);
    expect(removalItems.map((i) => i.sku).sort()).toEqual(['ADOPT-15', 'ADOPT-30', 'ADOPT-5']);
    const removalDrafts = new Map(removalItems.map((i) => [i.sku, JSON.parse(i.draftJson) as Product]));
    // Remaining members: block-on-main-only over the remaining set —
    // the main (ADOPT-5) carries the remaining-set block in native relative
    // order; the other remaining member carries no block of its own.
    {
      const refs = [...(removalDrafts.get('ADOPT-5')!.shopsite.preserved.advancedBlocks['Subproducts'] ?? '').matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)]
        .map((m) => m[1]!.trim());
      expect(refs).toEqual(['ADOPT-5', 'ADOPT-15']);
      expect(removalDrafts.get('ADOPT-15')!.shopsite.preserved.advancedBlocks['Subproducts'] ?? '').not.toMatch(/<SKU\s*>/);
    }
    // Removed member: PF7 preserved, no managed markers, explicit empty clear,
    // and no stale family-local markers left on the cleared draft.
    const removed = removalDrafts.get('ADOPT-30')!;
    expect((removed.customFields['ProductField7'] ?? '').trim()).toBe('Acme 30 lb');
    expect(isManagedFamilyProduct(removed)).toBe(false);
    expect(hasExplicitSubproductsClear(removed)).toBe(true);
    expect('managedFamilyMain' in removed.shopsite.preserved.rawAttributes).toBe(false);
    expect('reviewedTypeHash' in removed.shopsite.preserved.rawAttributes).toBe(false);
    // Omitting the clear refuses at the gate: rewrite the removed draft
    // without the empty block and re-validate (removed member missing from
    // the staged set breaks the reviewed revision's exact-touch contract).
    const tampered = structuredClone(removed);
    delete tampered.shopsite.preserved.advancedBlocks['Subproducts'];
    const gateWithoutClear = validateAdoptedFamilyChangeSet(appliedRemoval.changeSetId, removalItems
      .filter((i) => i.sku !== 'ADOPT-30')
      .map((i) => ({ sku: i.sku, draftJson: i.draftJson, baseJson: i.baseJson })));
    expect(gateWithoutClear.some((g) => g.code === 'FAMILY_GROUP_INCOMPLETE')).toBe(true);
    const approvedRemoval = approveChangeSet(appliedRemoval.changeSetId, workspacePath);
    expect(approvedRemoval.success).toBe(true);

    // Full dissolution on a fresh adoption: every member cleared explicitly.
    const ctx2 = setupNative();
    const staged2 = stageNativeAdoption({
      workspaceId: ctx2.workspaceId, workspacePath: ctx2.workspacePath,
      memberSkus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(ctx2.products),
    });
    const dissolved = stageMembershipChange({
      planId: staged2.plan.id, actor: 'operator-1',
      removeSkus: [], dissolve: true,
      liveBySku: new Map(ctx2.products.map((p) => [p.sku, structuredClone(p) as Product | null])),
    });
    const acceptedDissolution = decidePlan({ planId: dissolved.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedDissolution = applyAdoptedFamilyPlan({
      planId: acceptedDissolution.plan.id,
      workspaceId: ctx2.workspaceId, workspacePath: ctx2.workspacePath,
      draftsBySku: new Map(ctx2.products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const dissolutionItems = listChangeSetItems(appliedDissolution.changeSetId);
    for (const item of dissolutionItems) {
      const draft = JSON.parse(item.draftJson) as Product;
      expect(hasExplicitSubproductsClear(draft)).toBe(true);
      expect((draft.customFields['ProductField7'] ?? '').trim().length).toBeGreaterThan(0);
      // Unrelated fields survive: price, inventory, media untouched.
      const base = ctx2.products.find((p) => p.sku === item.sku)!;
      expect(draft.core.price).toBe(base.core.price);
      expect(draft.core.media.primary).toBe(base.core.media.primary);
    }
    // The explicit clear emits ON THE WIRE (not an omission).
    const wire = ShopSiteProductCodec.encodeMany(dissolutionItems.map((i) => JSON.parse(i.draftJson) as Product));
    expect((wire.xml.match(/<Subproducts><\/Subproducts>/g) ?? []).length).toBe(3);
    const approvedDissolution = approveChangeSet(appliedDissolution.changeSetId, ctx2.workspacePath);
    expect(approvedDissolution.success).toBe(true);
  });

  it('blocks stale bases and conflicting drafts at decision/approval/export with no partial commit', () => {
    const { workspacePath, workspaceId, products } = setupNative();
    const staged = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(products),
    });
    const accepted = decidePlan({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    const applied = applyAdoptedFamilyPlan({
      planId: accepted.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    // Stale base: live state moves after apply; approval refuses the group.
    const liveEdit = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    liveEdit.core.price = '99.99';
    writeProductFile(workspacePath, liveEdit);
    const denied = approveChangeSet(applied.changeSetId, workspacePath);
    expect(denied.success).toBe(false);
    // No partial commit: approval wrote nothing — the file still carries the
    // operator's own live edit (99.99), never the change set's staged draft
    // (19.99). Approval refuses; it does not revert operator state.
    expect(readProductFile(workspacePath, 'ADOPT-5')!.core.price).toBe('99.99');
    // Conflicting draft: another change set carrying a group SKU blocks.
    const ctx2 = setupNative();
    const staged2 = stageNativeAdoption({
      workspaceId: ctx2.workspaceId, workspacePath: ctx2.workspacePath,
      memberSkus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(ctx2.products),
    });
    const accepted2 = decidePlan({ planId: staged2.plan.id, actor: 'reviewer-2', action: 'accept' });
    const applied2 = applyAdoptedFamilyPlan({
      planId: accepted2.plan.id,
      workspaceId: ctx2.workspaceId, workspacePath: ctx2.workspacePath,
      draftsBySku: new Map(ctx2.products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const conflict = createChangeSet({ workspaceId: ctx2.workspaceId, title: 'conflict', baseCommit: 'test' });
    const conflictDraft = structuredClone(ctx2.products[0]!);
    upsertChangeSetItem({
      changeSetId: conflict.id,
      sku: conflictDraft.sku,
      operation: 'update',
      draftJson: deterministicStringify(conflictDraft),
      baseJson: deterministicStringify(conflictDraft),
      draftHash: hashJson(conflictDraft),
    });
    const blocked = approveChangeSet(applied2.changeSetId, ctx2.workspacePath);
    expect(blocked.success).toBe(false);
  });

  it('smokes a real temp-workspace commit/export incl. a refused unsafe adoption and an unmanaged round-trip', () => {
    // Adopted path: full review → safe adoption → supported edit → commit/export.
    const { workspacePath, workspaceId, products } = setupNative();
    const staged = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['ADOPT-5', 'ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(products),
    });
    const accepted = decidePlan({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    const applied = applyAdoptedFamilyPlan({
      planId: accepted.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    // Supported edit on the adopted family (price change on one member)
    // flows through the same approved commit/export — complete group intact.
    const edited = structuredClone(products.find((p) => p.sku === 'ADOPT-15')!);
    edited.core.price = '41.99';
    writeProductFile(workspacePath, edited);
    const denied = approveChangeSet(applied.changeSetId, workspacePath);
    expect(denied.success).toBe(false);
    // Refused unsafe adoption: a nested-block native stays preserved.
    const unsafe = structuredClone(products.find((p) => p.sku === 'ADOPT-5')!);
    unsafe.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproducts><SKU>GHOST</SKU></Subproducts></Subproducts>';
    expect(classifyNativeAdoption(unsafe, ['ADOPT-5', 'GHOST']).code).toBe('refused_unsupported');
    expect(unsafe.shopsite.preserved.advancedBlocks['Subproducts']).toContain('<Subproducts><Subproducts>');
    const reEncoded = ShopSiteProductCodec.encodeMany(products);
    expect(reEncoded.xml).toContain('<Subproducts>');
    // Malformed unknown metadata (non-SKU stanza) refuses with preservation.
    const weird = structuredClone(products.find((p) => p.sku === 'ADOPT-15')!);
    weird.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproduct><Name>Nameless</Name></Subproduct></Subproducts>';
    expect(() => stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['ADOPT-15', 'ADOPT-30'],
      actor: 'operator-1',
      evidenceBySku: new Map([
        ['ADOPT-15', { base: structuredClone(products[1]!), draftBase: weird, reviewedTypeHash: 'reviewed-type-v1', evidenceHash: 'evidence-ADOPT-15', axis: axisFor(products[1]!) }],
        ['ADOPT-30', { base: structuredClone(products[2]!), draftBase: structuredClone(products[2]!), reviewedTypeHash: 'reviewed-type-v1', evidenceHash: 'evidence-ADOPT-30', axis: axisFor(products[2]!) }],
      ]),
    })).toThrow(/family_native_/);
  });

  it('emits exactly one managed block and never a duplicate Short Name field', () => {
    const managed = clearSubproductsBlock(structuredClone(setupNative().products[0]!));
    expect(Object.keys(managed.shopsite.preserved.advancedBlocks).filter((k) => k.toLowerCase() === 'subproducts')).toEqual(['Subproducts']);
    expect(managed.shopsite.preserved.advancedBlocks['Subproducts']).toBe('<Subproducts></Subproducts>');
    expect('ProductField7' in managed.customFields).toBe(true);
    expect('shortName' in (managed as unknown as Record<string, unknown>)).toBe(false);
  });
});
