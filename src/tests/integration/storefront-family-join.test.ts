import { describe, expect, it } from 'bun:test';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import { GitClient } from '../../git/git-client';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { approveChangeSet, loadApprovedLinkedExport } from '../../server/services/change-set-service';
import { stageNativeAdoption, applyAdoptedFamilyPlan, type AdoptionEvidence } from '../../classification/storefront-family-adoption';
import { decideStorefrontFamilyPlan, stageNonFoodStorefrontFamilyPlan, stageStorefrontFamilyPlan, applyStorefrontFamilyPlan } from '../../classification/storefront-family-plan-service';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import {
  discoverJoinCandidates,
  buildImportedJoinQuery,
  buildCatalogJoinAnchor,
  stageFamilyJoin,
  reviewFamilyJoin,
  checkFamilyJoinFreshness,
  decideFamilyJoin,
  applyFamilyJoin,
  type JoinMemberEvidence,
} from '../../classification/storefront-family-join';
import { canonicalJoinVariantTuple } from '../../classification/family-variant-rule';
import { findStorefrontFamilyPlanById, parseStorefrontFamilyPlan } from '../../db/repositories/storefront-family-plan-repo';
import type { FamilyMemberOrigin } from '../../shared/schemas/storefront-family';
import { approveFamilyCatalogProduct } from './family-authority';
import { projectBoundCatalogFamilyOrigin, type ApprovedCatalogFamilyProjection } from '../../classification/storefront-family-origin';
import { computeReviewedAuthorityHash } from '../../classification/promotion-gate';
import type { Product } from '../../shared/types';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById, updateItemCurationData } from '../../db/repositories/onboarding-item-repo';
import { acceptedItemNameSpans } from '../../classification/name-candidates';
import { resolveNameSelection, toNameDecision } from '../../classification/name-decision';
import { validateNameDecisionForReview } from '../../classification/review-completion-gate';
import { getCurrentItemEvidenceView } from '../../onboarding/item-evidence';
import { prepareListingEvidenceWorkspace, seedListingEvidenceItem } from '../unit/helpers/listing-evidence-authority';
import type { ClassificationEvidence } from '../../shared/schemas/classification';
import type { NameDecision } from '../../shared/schemas/onboarding';

// Disposable-workspace smoke for issue #370: two approved earlier sizes
// (FAM-5 + FAM-15 adopted from an earlier batch) plus a new imported third
// size (FAM-30). The join preserves main/labels/data, proves create/update
// identity, refuses stale/conflicting joins, reviews the complete group,
// and exports the relationship from one complete commit.

const EARLIER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>FAM-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-5.jpg</Graphic><QuantityOnHand>7</QuantityOnHand>
<Weight>5 lb</Weight><ProductField7>Acme 5 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText>
<Subproducts><Subproduct><SKU>FAM-5</SKU><Name>Acme Chicken Dinner 5 lb</Name><Price>19.99</Price></Subproduct><Subproduct><SKU>FAM-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price></Subproduct></Subproducts>
</Product>
<Product><SKU>FAM-15</SKU><Name>Acme Chicken Dinner 15 lb</Name><Price>39.99</Price>
<ProductDisabled>checked</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/fam-15.jpg</Graphic><QuantityOnHand>4</QuantityOnHand>
<Weight>15 lb</Weight><ProductField7>Acme 15 lb</ProductField7>
<ProductField16>Acme</ProductField16><ProductField17>Dog</ProductField17><ProductField18>Adult</ProductField18>
<ProductField22>Dry Kibble</ProductField22><ProductField23>Chicken</ProductField23><ProductField24>Chicken Dinner</ProductField24>
<MoreInformationText>Real chicken dinner.</MoreInformationText></Product>
</Products></ShopSiteProducts>`;

let activeFamilyOrigins: Map<string, FamilyMemberOrigin> = new Map();
let activeFamilyTypeHashes: Record<string, string> = {};
let activeFamilyProjections = new Map<string, ApprovedCatalogFamilyProjection>();
let activeImportedOrigins: Record<string, Extract<FamilyMemberOrigin, { kind: 'onboarding' }>> = {};
function axisFor(p: Product) {
  const ounces: Record<string, number> = { 'FAM-5': 80, 'FAM-15': 240, 'FAM-30': 480 };
  return {
    brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken', species: 'Dog',
    lifeStage: 'Adult', form: 'Dry Kibble',
    sizeRaw: p.core.weight ?? '5 lb', ounces: ounces[p.sku] ?? 80,
    retailUnit: null, packCountDeclared: false, packCount: null, purchasable: true,
  };
}

function setupEarlier() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-370-'));
  const dbPath = path.join(workspacePath, `family-370-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-370-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const decoded = ShopSiteProductCodec.decode(EARLIER_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.commit('Baseline for family join (earlier batch)');
  const authorized = decoded.products.map((product) => approveFamilyCatalogProduct({
    workspaceId, workspacePath, product, productTypeId: 'dog-food-dry',
  }));
  activeFamilyOrigins = new Map(authorized.map((item) => [item.product.sku, item.origin] as const));
  activeFamilyProjections = new Map(authorized.map((item) => {
    const projection = projectBoundCatalogFamilyOrigin({
      workspaceId, workspacePath, sku: item.product.sku, origin: item.origin,
    });
    if (!projection) throw new Error(`Approved family projection unavailable for ${item.product.sku}`);
    return [item.product.sku, projection] as const;
  }));
  activeFamilyTypeHashes = Object.fromEntries(authorized.map((item) => [
    item.product.sku, item.product.shopsite.preserved.rawAttributes.reviewedTypeHash as string,
  ]));
  prepareListingEvidenceWorkspace(workspacePath, workspaceId);
  return { workspacePath, workspaceId, products: authorized.map((item) => item.product) };
}
async function seedImportedOrigin(input: { workspaceId: string; workspacePath: string; sku: string; name: string; brand: string; description: string; weight: string; }): Promise<Extract<FamilyMemberOrigin, { kind: 'onboarding' }>> {
  const batch = createBatch({ workspaceId: input.workspaceId, name: `Family evidence ${input.sku}`, fileName: `${input.sku}.csv`, totalItems: 1 });
  const [item] = insertItems(batch.id, [{ upc: input.sku, name: input.name, brandHint: input.brand, rowNumber: 1 }]);
  const authority = seedListingEvidenceItem({ workspaceId: input.workspaceId, workspacePath: input.workspacePath, itemId: item.id, sku: input.sku, description: input.description, weight: input.weight });
  const current = getCurrentItemEvidenceView(input.workspaceId, item.id);
  if (current.status !== 'accepted' || !current.evidence) throw new Error(`Family evidence unavailable for ${input.sku}: ${current.status}`);
  const spans = acceptedItemNameSpans(current.evidence).spans;
  const evidence = getDb().query('SELECT * FROM classification_evidence WHERE run_id = ?').all(authority.runId).map((row: unknown) => row as ClassificationEvidence);
  const result = await resolveNameSelection({ evidence, spans, brand: input.brand, sku: input.sku, runId: authority.runId, snapshot: null, modelPolicy: null });
  if (result.status !== 'resolved') throw new Error(`Family item name unresolved for ${input.sku}`);
  const decision = toNameDecision({ result, spans, brand: input.brand });
  if (!decision) throw new Error(`Family item name decision unavailable for ${input.sku}`);
  const itemRow = findItemById(item.id)!;
  const curation = { ...(itemRow.curationData ?? {}), purchasable: true, curatedTitle: result.title, titleSource: decision.producer, nameDecision: decision, classificationRunId: authority.runId };
  updateItemCurationData(item.id, JSON.stringify(curation));
  const persisted = findItemById(item.id)!;
  if (!persisted.curationData?.itemExecutionCurrentness || validateNameDecisionForReview(item.id) !== null) throw new Error(`Family item Review authority failed for ${input.sku}`);
  const origin: Extract<FamilyMemberOrigin, { kind: 'onboarding' }> = {
    kind: 'onboarding', itemId: item.id, runId: authority.runId,
    runCurrentnessHash: String(persisted.curationData.itemExecutionCurrentness.runCurrentnessHash),
    evidenceId: current.evidence.id, evidenceHash: current.evidence.evidenceHash,
  };
  return origin;
}

function adoptionEvidence(products: Product[]): Map<string, AdoptionEvidence> {
  return new Map(products.map((p) => {
    const projection = activeFamilyProjections.get(p.sku);
    if (!projection) throw new Error(`Approved family projection unavailable for ${p.sku}`);
    return [p.sku, {
      base: structuredClone(projection.product),
      draftBase: structuredClone(projection.product),
      origin: projection.origin,
      reviewedProductTypeId: projection.reviewedProductTypeId,
      reviewedTypeHash: projection.reviewedTypeHash,
      evidenceHash: projection.evidenceHash,
      axis: {
        brand: projection.brand, recipe: projection.recipe, flavor: projection.flavor,
        species: projection.species, lifeStage: projection.lifeStage, form: projection.form,
        sizeRaw: projection.sizeRaw ?? p.core.weight ?? '',
        ounces: projection.ounces, retailUnit: projection.retailUnit,
        packCountDeclared: projection.packCountDeclared, packCount: projection.packCount,
        purchasable: projection.purchasable,
      },
      nonFoodAxis: {
        model: projection.model, material: projection.material, function: projection.function,
        safetyDose: projection.safetyDose, strength: projection.strength, fit: projection.fit,
        sizeRaw: projection.sizeRaw, colorRaw: projection.colorRaw, countRaw: projection.countRaw,
        countQuantity: projection.countQuantity,
        reviewedProductTypeId: projection.reviewedProductTypeId,
      },
    }];
  }));
}

/** Import-side evidence for the new third size (no approved base → create). */
function importEvidence(sku: string, weight: string, ounces: number): JoinMemberEvidence {
  const draft: Product = {
    schemaVersion: 1,
    id: `family-new-${sku}`,
    sku,
    status: 'draft',
    core: {
      name: `Acme Chicken Dinner ${weight}`,
      price: '59.99',
      salePrice: null,
      description: 'Real chicken dinner.',
      inventory: { quantityOnHand: 2, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight,
      taxable: true,
      media: { primary: 'media/fam-30.jpg', additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {
      ProductField16: 'Acme',
      ProductField17: 'Dog',
      ProductField18: 'Adult',
      ProductField22: 'Dry Kibble',
      ProductField23: 'Chicken',
      ProductField24: 'Chicken Dinner',
    },
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
  };
  return {
    sku,
    origin: 'import',
    base: null,
    draftBase: draft,
    purchasable: true,
    brand: 'Acme',
    recipe: 'Chicken Dinner',
    flavor: 'Chicken',
    species: 'Dog',
    lifeStage: 'Adult',
    form: 'Dry Kibble',
    sizeRaw: weight,
    ounces,
    retailUnit: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: computeReviewedAuthorityHash('dog-food-dry') ?? (() => { throw new Error('Missing dog-food-dry authority hash'); })(),
    evidenceHash: `evidence-${sku}`,
    productTypeId: null,
    model: null,
    material: null,
    function: null,
    safetyDose: null,
    strength: null,
    fit: null,
    colorRaw: null,
    countRaw: null,
    countQuantity: null,
  };
}

function catalogEvidence(p: Product): JoinMemberEvidence {
  return {
    sku: p.sku,
    base: structuredClone(p),
    draftBase: structuredClone(p),
    purchasable: true,
    brand: 'Acme',
    recipe: 'Chicken Dinner',
    flavor: 'Chicken',
    species: 'Dog',
    lifeStage: 'Adult',
    form: 'Dry Kibble',
    sizeRaw: p.core.weight ?? '5 lb',
    ounces: p.sku === 'FAM-5' ? 80 : 240,
    retailUnit: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: p.shopsite.preserved.rawAttributes.reviewedTypeHash as string,
    evidenceHash: `evidence-${p.sku}`,
    origin: 'catalog',
    productTypeId: null,
    model: null,
    material: null,
    function: null,
    safetyDose: null,
    strength: null,
    fit: null,
    colorRaw: null,
    countRaw: null,
    countQuantity: null,
  };
}

const NON_FOOD_EARLIER_XML = `<?xml version="1.0" encoding="UTF-8"?>
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
</Products></ShopSiteProducts>`;

function setupNonFoodEarlier() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-370-nf-'));
  const dbPath = path.join(workspacePath, `family-370-nf-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const workspaceId = `ws-family-370-nf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  const decoded = ShopSiteProductCodec.decode(NON_FOOD_EARLIER_XML, { workspaceId });
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Baseline for family join non-food target (earlier batch)');
  const authorized = decoded.products.map((product) => approveFamilyCatalogProduct({
    workspaceId, workspacePath, product, productTypeId: 'collars-leashes',
  }));
  activeFamilyOrigins = new Map(authorized.map((item) => [item.product.sku, item.origin] as const));
  activeFamilyTypeHashes = Object.fromEntries(authorized.map((item) => [
    item.product.sku, item.product.shopsite.preserved.rawAttributes.reviewedTypeHash as string,
  ]));
  return { workspacePath, workspaceId, products: authorized.map((item) => item.product) };
}

const NON_FOOD_IDENTITY = {
  brand: 'Acme',
  model: 'Trail Harness',
  material: 'Nylon',
  function: 'Walking',
  safetyDose: 'N/A',
  strength: 'Standard',
  fit: 'Adjustable',
} as const;

function nonFoodMemberInput(sku: string, size: string | null, color: string, typeId = 'collars-leashes'): {
  sku: string; origin: FamilyMemberOrigin; purchasable: boolean; ounces: null; retailUnit: null; brand: string; model: string; material: string;
  function: string; safetyDose: string; strength: string; fit: string;
  sizeRaw: string | null; colorRaw: string; countRaw: null; countQuantity: null;
  packCountDeclared: boolean; packCount: null; reviewedTypeHash: string;
  reviewedProductTypeId: string; evidenceHash: string;
} {
  return {
    sku,
    origin: activeFamilyOrigins.get(sku)!,
    purchasable: true,
    ounces: null,
    retailUnit: null,
    ...NON_FOOD_IDENTITY,
    sizeRaw: size,
    colorRaw: color,
    countRaw: null,
    countQuantity: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: activeFamilyTypeHashes[sku] ?? '',
    reviewedProductTypeId: typeId,
    evidenceHash: `evidence-${sku}`,
  };
}

function nonFoodDraft(sku: string, size: string | null, color: string | null): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `family-new-${sku}`,
    sku,
    status: 'draft',
    core: {
      name: `Acme Trail Harness ${size ?? ''} ${color ?? ''}`.replace(/ +/g, ' ').trim(),
      price: '29.99',
      salePrice: null,
      description: 'Nylon walking harness.',
      inventory: { quantityOnHand: 2, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: size,
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: { ProductField16: 'Acme', ProductField17: 'Dog', ProductField18: 'Adult' },
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

function nonFoodCatalogEvidence(p: Product, size: string | null, color: string): JoinMemberEvidence {
  return {
    sku: p.sku,
    base: structuredClone(p),
    draftBase: structuredClone(p),
    purchasable: true,
    ...NON_FOOD_IDENTITY,
    recipe: null,
    flavor: null,
    species: null,
    lifeStage: null,
    form: null,
    sizeRaw: size ?? '',
    ounces: null,
    retailUnit: null,
    packCountDeclared: false,
    packCount: null,
    reviewedTypeHash: p.shopsite.preserved.rawAttributes.reviewedTypeHash as string,
    evidenceHash: `evidence-${p.sku}`,
    origin: 'catalog',
    productTypeId: 'collars-leashes',
    model: NON_FOOD_IDENTITY.model,
    material: NON_FOOD_IDENTITY.material,
    function: NON_FOOD_IDENTITY.function,
    safetyDose: NON_FOOD_IDENTITY.safetyDose,
    strength: NON_FOOD_IDENTITY.strength,
    fit: NON_FOOD_IDENTITY.fit,
    colorRaw: color,
    countRaw: null,
    countQuantity: null,
  };
}

function nonFoodImportEvidence(sku: string, size: string, color: string): JoinMemberEvidence {
  const origin = activeImportedOrigins[sku];
  if (!origin) throw new Error(`No current imported origin seeded for ${sku}`);
  return {
    sku, base: null, draftBase: nonFoodDraft(sku, size, color), purchasable: true, ...NON_FOOD_IDENTITY,
    recipe: null, flavor: null, species: null, lifeStage: null, form: null,
    sizeRaw: size, ounces: null, retailUnit: null, packCountDeclared: false, packCount: null,
    reviewedTypeHash: computeReviewedAuthorityHash('collars-leashes') ?? (() => { throw new Error('Missing collars-leashes authority hash'); })(), evidenceHash: origin.evidenceHash, origin: 'import' as const,
    productTypeId: 'collars-leashes', model: NON_FOOD_IDENTITY.model, material: NON_FOOD_IDENTITY.material,
    function: NON_FOOD_IDENTITY.function, safetyDose: NON_FOOD_IDENTITY.safetyDose, strength: NON_FOOD_IDENTITY.strength,
    fit: NON_FOOD_IDENTITY.fit, colorRaw: color, countRaw: null, countQuantity: null,
  };
}
describe('imported size joins reviewed existing family (issue #370)', () => {
  it('discovers the existing family, stages a join, and exports one complete commit with main/labels/data preserved', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    // Earlier batch: adopt the two-size native family (main FAM-5 preserved).
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(acceptedAdoption.plan.status).toBe('accepted');
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    const approvedAdoption = approveChangeSet(appliedAdoption.changeSetId, workspacePath);
    expect(approvedAdoption.success).toBe(true);

    // Candidate discovery: the new import SKU finds the reviewed family
    // through cheap equality keys (brand block + name/model evidence with
    // stem corroboration) — never a pairwise model scan.
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const anchors = live.map((p) => buildCatalogJoinAnchor({
      product: p,
      familyPlanId: adopted.plan.id,
      familyMain: adopted.plan.mainSku,
      familyOrder: [adopted.plan.mainSku, ...adopted.plan.memberSkus.filter((s) => s !== adopted.plan.mainSku).sort()],
      familyRuleVersion: adopted.plan.ruleVersion,
      origin: 'managed_plan',
    }));
    const query = buildImportedJoinQuery({
      sku: 'FAM-30',
      brand: 'Acme',
      name: 'Acme Chicken Dinner 30 lb',
    });
    const candidates = discoverJoinCandidates(query, anchors);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.familyPlanId === adopted.plan.id)).toBe(true);
    // Stem-only matches are never authority: a bare stem different-brand
    // import yields no candidate.
    const stranger = buildImportedJoinQuery({ sku: 'ZZZ-9', brand: 'Other', name: 'Acme Chicken Dinner 30 lb' });
    const strangerCandidates = discoverJoinCandidates(stranger, anchors);
    expect(strangerCandidates.every((c) => !c.signals.includes('workspace_sku_identity') && !c.signals.includes('source_identifier'))).toBe(true);

    // Stage the join: existing main preserved (never re-nominated to the
    // smaller import), existing members/order/labels preserved verbatim.
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    const staged = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    expect(staged.plan.mainSku).toBe('FAM-5');
    expect(staged.plan.mainOverridden).toBe(false);
    expect(staged.plan.memberSkus).toEqual(['FAM-15', 'FAM-30', 'FAM-5']);
    expect(staged.plan.joinOrigin?.familyMain).toBe('FAM-5');
    expect(staged.plan.joinOrigin?.joinedSkus).toEqual(['FAM-30']);
    expect(staged.plan.pf7Proposals.find((p) => p.sku === 'FAM-5')?.shortName).toBe('Acme 5 lb');
    expect(staged.plan.pf7Proposals.find((p) => p.sku === 'FAM-15')?.shortName).toBe('Acme 15 lb');

    // Review: complete import+catalog membership, origins, invariants/axes,
    // labels, native refs, read deps, and the exact write set.
    const reviewLive = new Map<string, Product | null>([
      ...live.map((p) => [p.sku, p] as const),
      ['FAM-30', null],
    ]);
    const review = reviewFamilyJoin({ planId: staged.plan.id, workspacePath, liveBySku: reviewLive, evidenceBySku, currentEvidenceBySku: evidenceBySku });
    expect(review.membership.map((m) => `${m.sku}:${m.origin}`)).toEqual(['FAM-15:catalog', 'FAM-30:import', 'FAM-5:catalog']);
    expect(review.invariantEvidence.every((r) => r.agreed)).toBe(true);
    // Minimal write set: only the import (create) plus the main's managed
    // block write; the unchanged non-main member is a read dependency.
    expect(review.writeSet).toEqual([
      { sku: 'FAM-30', operation: 'create' },
      { sku: 'FAM-5', operation: 'update' },
    ]);
    expect(review.readDependencies).toContain('FAM-15');
    // Truthful native diffs: only the main emits the managed block.
    expect(review.nativeDiffs.find((d) => d.sku === 'FAM-5')?.afterRefs).toEqual(['FAM-5', 'FAM-15', 'FAM-30']);
    expect(review.nativeDiffs.find((d) => d.sku === 'FAM-15')?.afterRefs).toEqual(review.nativeDiffs.find((d) => d.sku === 'FAM-15')?.beforeRefs);
    expect(review.nativeDiffs.find((d) => d.sku === 'FAM-30')?.afterRefs).toEqual(review.nativeDiffs.find((d) => d.sku === 'FAM-30')?.beforeRefs);
    expect(review.nativeDiffs.find((d) => d.sku === 'FAM-30')?.operation).toBe('create');
    expect(review.nativeDiffs.find((d) => d.sku === 'FAM-5')?.operation).toBe('update');
    expect(review.blockers).toEqual([]);

    // Freshness: the staged join is fresh; a stale base stales the group.
    const freshLive = new Map<string, Product | null>(live.map((p) => [p.sku, p]));
    freshLive.set('FAM-30', null);
    const fresh = checkFamilyJoinFreshness({
      planId: staged.plan.id,
      workspacePath,
      workspaceId,
      liveBySku: freshLive,
      currentTypeHashBySku: new Map([
        ['FAM-5', activeFamilyTypeHashes['FAM-5']!],
        ['FAM-15', activeFamilyTypeHashes['FAM-15']!],
        ['FAM-30', computeReviewedAuthorityHash('dog-food-dry')],
      ]),
      currentEvidenceHashBySku: new Map([['FAM-5', 'evidence-FAM-5'], ['FAM-15', 'evidence-FAM-15'], ['FAM-30', 'evidence-FAM-30']]),
    });
    expect(fresh.fresh).toBe(true);

    // Accept → apply → approve → export: one complete commit, exact group.
    const accepted = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const drafts = new Map<string, Product>([
      ...live.map((p) => [p.sku, structuredClone(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480).draftBase],
    ]);
    const applied = applyFamilyJoin({
      planId: accepted.plan.id, workspaceId, workspacePath, draftsBySku: drafts, actor: 'reviewer-2',
      currentTypeHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.reviewedTypeHash] as const)),
      currentEvidenceHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.evidenceHash] as const)),
      currentRuleVersionBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, 'food-family-variant-rule-v1'] as const)),
      currentProductTypeIdBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.productTypeId] as const)),
      currentLabelBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, null] as const)),
    });
    const approved = approveChangeSet(applied.changeSetId, workspacePath);
    expect(approved.success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    // Minimal writes: the change set carries only the import create plus the
    // main's managed-block update; the unchanged member exports from the
    // approved commit via the linked read-dependency contract.
    expect(linked.load.manifest.writes.map((w) => w.sku).sort()).toEqual(['FAM-30', 'FAM-5']);
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['FAM-30', 'FAM-5']);
    expect(linked.load.manifest.reads.map((r) => r.sku)).toContain('FAM-15');
    // Block-on-main-only emission: the existing main (FAM-5) carries the
    // single managed block — full group, main first in preserved order,
    // joined size appended. Non-main members carry no block of their own.
    for (const product of linked.load.products) {
      const block = product.shopsite.preserved.advancedBlocks['Subproducts'] ?? '';
      if (product.sku === 'FAM-5') {
        const refs = [...block.matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)]
          .map((m) => m[1]!.trim());
        expect(refs).toEqual(['FAM-5', 'FAM-15', 'FAM-30']);
        expect(refs.filter((r) => r === product.sku)).toHaveLength(1);
      } else {
        expect(block).not.toMatch(/<SKU\s*>/);
      }
      expect((product.customFields['ProductField7'] ?? '').length).toBeGreaterThan(0);
      // Unrelated data preserved: names/prices/media survive the join.
      expect(product.core.name).toContain('Acme Chicken Dinner');
      expect(product.core.media.primary).toMatch(/^media\/fam-/);
    }
    // Existing labels verbatim; only the import receives a derived label.
    // The unchanged member (FAM-15) verifies from the live approved file.
    const bySku = new Map(linked.load.products.map((p) => [p.sku, p]));
    expect(bySku.get('FAM-5')?.customFields['ProductField7']).toBe('Acme 5 lb');
    expect(bySku.get('FAM-30')?.customFields['ProductField7']).toBe('30 lb (480 oz)');
    expect(readProductFile(workspacePath, 'FAM-15')!.customFields['ProductField7']).toBe('Acme 15 lb');
    const familyRow = findStorefrontFamilyPlanById(accepted.plan.id)!;
    expect(parseStorefrontFamilyPlan(familyRow.planJson).linkedChangeSetId).toBe(applied.changeSetId);
  });

  it('refuses same-SKU ambiguity, competing families, smaller-main replacement, stale bases, and conflicting drafts', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);
    const evidenceFor = (extra: Map<string, JoinMemberEvidence>): Map<string, JoinMemberEvidence> => {
      const liveNow = products.map((p) => readProductFile(workspacePath, p.sku)!);
      const base = new Map<string, JoinMemberEvidence>(liveNow.map((p) => [p.sku, catalogEvidence(p)]));
      for (const [sku, evidence] of extra) base.set(sku, evidence);
      return base;
    };
    // Same-SKU ambiguity: a joined SKU that already exists in the catalog
    // routes to identity/duplicate resolution, never a duplicate file.
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const sameSkuEvidence = evidenceFor(new Map([
      ['FAM-15', { ...catalogEvidence(live.find((p) => p.sku === 'FAM-15')!), base: structuredClone(live.find((p) => p.sku === 'FAM-15')!), origin: 'import' as const }],
    ]));
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-15'],
      actor: 'operator-1',
      evidenceBySku: sameSkuEvidence,
    })).toThrow(/family_join_same_sku/);
    // Duplicate tuples refuse, never branch: an import duplicating FAM-5's
    // verified size tuple cannot join.
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-DUPE'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(new Map([['FAM-DUPE', importEvidence('FAM-DUPE', '5 lb', 80)]])),
    })).toThrow(/FAMILY_DUPLICATE_VARIANT/);
    // Invariant conflict: a different-flavor import is a separate family.
    const beef = importEvidence('FAM-BEEF', '30 lb', 480);
    beef.flavor = 'Beef';
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-BEEF'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(new Map([['FAM-BEEF', beef]])),
    })).toThrow(/FAMILY_INVARIANT_CONFLICT/);
    // Missing authority stays unresolved: no fabricated rule membership.
    const noType = importEvidence('FAM-NOTYPE', '30 lb', 480);
    noType.reviewedTypeHash = '';
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-NOTYPE'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(new Map([['FAM-NOTYPE', noType]])),
    })).toThrow(/family_member_unresolved/);
    // Stale/conflicting refusal: a staged join blocks when the approved
    // catalog moves under it (no partial commit, no overwrite).
    const staged = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceFor(new Map([['FAM-30', importEvidence('FAM-30', '30 lb', 480)]])),
    });
    const accepted = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    const liveEdit = structuredClone(readProductFile(workspacePath, 'FAM-5')!);
    liveEdit.core.price = '99.99';
    writeProductFile(workspacePath, liveEdit);
    const stale = checkFamilyJoinFreshness({
      planId: accepted.plan.id,
      workspacePath,
      workspaceId,
      liveBySku: new Map([...products.map((p) => [p.sku, readProductFile(workspacePath, p.sku)] as const), ['FAM-30', null]]),
      currentTypeHashBySku: new Map([
        ['FAM-5', activeFamilyTypeHashes['FAM-5']!],
        ['FAM-15', activeFamilyTypeHashes['FAM-15']!],
        ['FAM-30', computeReviewedAuthorityHash('dog-food-dry')],
      ]),
      currentEvidenceHashBySku: new Map([['FAM-5', 'evidence-FAM-5'], ['FAM-15', 'evidence-FAM-15'], ['FAM-30', 'evidence-FAM-30']]),
    });
    expect(stale.fresh).toBe(false);
    expect(stale.reasons.some((r) => r.includes('FAM-5'))).toBe(true);
  });

  it('reject/defer preserves relationships and standalone progress', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption3 = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption3 = applyAdoptedFamilyPlan({
      planId: acceptedAdoption3.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption3.changeSetId, workspacePath).success).toBe(true);
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    const rejected = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    const rejectedView = decideFamilyJoin({ planId: rejected.plan.id, actor: 'reviewer-2', action: 'reject' });
    expect(rejectedView.plan.status).toBe('rejected');
    expect(() => applyFamilyJoin({
      planId: rejected.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map([...live.map((p) => [p.sku, structuredClone(p)] as const), ['FAM-30', importEvidence('FAM-30', '30 lb', 480).draftBase]]),
      actor: 'reviewer-2',
    })).toThrow(/family_plan_not_accepted/);
    // The existing family is untouched: main, members, order, labels intact.
    expect(readProductFile(workspacePath, 'FAM-5')!.core.name).toBe('Acme Chicken Dinner 5 lb');
    const deferred = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    expect(decideFamilyJoin({ planId: deferred.plan.id, actor: 'reviewer-2', action: 'defer' }).plan.status).toBe('deferred');
  });

  it('blocks a competing applied family until explicitly rejected, then stages with the rejection pinned', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);
    // A second applied family owns the third size (same food invariants, a
    // distinct family document): FAM-30's import draft + FAM-5's live base
    // stage/accept/apply as their own family so "competing" is real state.
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const liveBySku = new Map(live.map((p) => [p.sku, structuredClone(p)]));
    const rivalProduct = structuredClone(importEvidence('FAM-30', '30 lb', 480).draftBase);
    rivalProduct.status = 'active';
    const rivalAuthority = approveFamilyCatalogProduct({
      workspaceId, workspacePath, product: rivalProduct, productTypeId: 'dog-food-dry',
    });
    const rivalDraft = rivalAuthority.product;
    const rivalStaged = stageStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: {
        members: [
          {
            sku: 'FAM-5', origin: activeFamilyOrigins.get('FAM-5')!, purchasable: true, brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken',
            species: 'Dog', lifeStage: 'Adult', form: 'Dry Kibble', sizeRaw: '5 lb', ounces: 80,
            retailUnit: null, packCountDeclared: false, packCount: null,
            reviewedTypeHash: activeFamilyTypeHashes['FAM-5']!, evidenceHash: 'evidence-FAM-5',
          },
          {
            sku: 'FAM-30', origin: rivalAuthority.origin, purchasable: true, brand: 'Acme', recipe: 'Chicken Dinner', flavor: 'Chicken',
            species: 'Dog', lifeStage: 'Adult', form: 'Dry Kibble', sizeRaw: '30 lb', ounces: 480,
            retailUnit: null, packCountDeclared: false, packCount: null,
            reviewedTypeHash: rivalProduct.shopsite.preserved.rawAttributes.reviewedTypeHash as string, evidenceHash: 'evidence-FAM-30',
          },
        ],
      },
      actor: 'operator-2',
      curationBySku: new Map([
        ['FAM-5', { base: liveBySku.get('FAM-5')!, draftBase: structuredClone(liveBySku.get('FAM-5')!) }],
        ['FAM-30', { base: rivalProduct, draftBase: rivalDraft }],
      ]),
    });
    const rivalAccepted = decideStorefrontFamilyPlan({ planId: rivalStaged.plan.id, actor: 'reviewer-2', action: 'accept' });
    const liveFam5 = structuredClone(liveBySku.get('FAM-5')!);
    // The adopted family stamped managed markers on FAM-5's catalog base;
    // the rival plan re-stages FAM-5 as a freestanding member, so strip the
    // adopted markers from the rival's working draft (the rival writer
    // re-stamps its own markers at apply). The catalog file keeps its own.
    delete liveFam5.shopsite.preserved.rawAttributes['managedFamilyId'];
    delete liveFam5.shopsite.preserved.rawAttributes['managedFamilyMemberSkus'];
    for (const tag of Object.keys(liveFam5.shopsite.preserved.advancedBlocks ?? {})) {
      if (tag.toLowerCase() === 'subproducts') delete liveFam5.shopsite.preserved.advancedBlocks[tag];
    }
    const rivalDrafts = new Map<string, Product>([
      ['FAM-5', liveFam5],
      ['FAM-30', structuredClone(rivalDraft)],
    ]);
    const rivalApplied = applyStorefrontFamilyPlan({
      planId: rivalAccepted.plan.id, workspaceId, workspacePath,
      draftsBySku: rivalDrafts, actor: 'reviewer-2',
    });
    expect(approveChangeSet(rivalApplied.changeSetId, workspacePath).success).toBe(true);
    // Same-SKU fires at the earliest honest point: FAM-30 now exists in the
    // approved catalog, so true route-threaded bases refuse staging before
    // any competing-family logic runs.
    const fam30Base = readProductFile(workspacePath, 'FAM-30')!;
    const trueBaseEvidence = new Map<string, JoinMemberEvidence>([
      ...products.map((p) => [p.sku, catalogEvidence(readProductFile(workspacePath, p.sku)!)] as const),
      ['FAM-30', { ...importEvidence('FAM-30', '30 lb', 480), base: structuredClone(fam30Base) }],
    ]);
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku: trueBaseEvidence,
    })).toThrow(/family_join_same_sku/);
    // Competing-family path: the catalog file is later removed (operator
    // deletion) while the applied rival still owns FAM-30. No live base, so
    // no same-SKU — the rival's applied membership blocks staging until the
    // operator explicitly reviews and rejects it.
    fs.rmSync(path.join(workspacePath, skuToProductFilePath('FAM-30')));
    expect(readProductFile(workspacePath, 'FAM-30')).toBeNull();
    const liveAfterRemoval = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceForJoin = new Map<string, JoinMemberEvidence>([
      ...liveAfterRemoval.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceForJoin,
    })).toThrow(/family_join_competing_family/);
    // Pin the rival revision explicitly: re-resolve against the rival and
    // stage the join with the competing family reviewed + rejected.
    const rivalRow = findStorefrontFamilyPlanById(rivalStaged.plan.id)!;
    const rivalPlan = parseStorefrontFamilyPlan(rivalRow.planJson);
    const joined = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceForJoin,
      rejectedFamilies: [{
        planId: rivalPlan.id,
        revision: rivalPlan.revision,
        ruleVersion: rivalPlan.ruleVersion,
        memberSkus: rivalPlan.memberSkus,
      }],
    });
    expect(joined.plan.joinOrigin?.rejectedFamilies.map((r) => r.planId)).toContain(rivalPlan.id);
    // Freshness records no competing-family reason once rejected explicitly.
    const freshCheck = checkFamilyJoinFreshness({
      planId: joined.plan.id,
      workspacePath,
      workspaceId,
      liveBySku: new Map([...liveAfterRemoval.map((p) => [p.sku, readProductFile(workspacePath, p.sku)] as const), ['FAM-30', null]]),
      currentTypeHashBySku: new Map([
        ['FAM-5', activeFamilyTypeHashes['FAM-5']!],
        ['FAM-15', activeFamilyTypeHashes['FAM-15']!],
        ['FAM-30', computeReviewedAuthorityHash('dog-food-dry')],
      ]),
      currentEvidenceHashBySku: new Map([['FAM-5', 'evidence-FAM-5'], ['FAM-15', 'evidence-FAM-15'], ['FAM-30', 'evidence-FAM-30']]),
    });
    expect(freshCheck.fresh).toBe(true);
    expect(freshCheck.reasons.some((r) => r.includes('Competing family'))).toBe(false);
    // … but a stale pinned revision re-blocks: the rejection no longer
    // matches the rival's current revision.
    expect(() => stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku: evidenceForJoin,
      rejectedFamilies: [{
        planId: rivalPlan.id,
        revision: rivalPlan.revision + 1,
        ruleVersion: rivalPlan.ruleVersion,
        memberSkus: rivalPlan.memberSkus,
      }],
    })).toThrow(/family_join_rejection_stale/);
  });

  it('refuses to overwrite a competing active draft and populates review blockers', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    const staged = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    // A competing active (draft) change set touches FAM-30: freshness
    // blocks the whole plan and the plan auto-stales.
    const competitor = createChangeSet({ workspaceId, title: 'competing FAM-30 edit', baseCommit: 'family-plan' });
    upsertChangeSetItem({
      changeSetId: competitor.id,
      sku: 'FAM-30',
      operation: 'create',
      draftJson: deterministicStringify(importEvidence('FAM-30', '30 lb', 480).draftBase),
      baseJson: null,
      draftHash: hashJson(importEvidence('FAM-30', '30 lb', 480).draftBase),
      classificationRunId: null,
    });
    const blocked = checkFamilyJoinFreshness({
      planId: staged.plan.id,
      workspacePath,
      workspaceId,
      liveBySku: new Map([...live.map((p) => [p.sku, p] as const), ['FAM-30', null]]),
      currentTypeHashBySku: new Map([
        ['FAM-5', activeFamilyTypeHashes['FAM-5']!],
        ['FAM-15', activeFamilyTypeHashes['FAM-15']!],
        ['FAM-30', computeReviewedAuthorityHash('dog-food-dry')],
      ]),
      currentEvidenceHashBySku: new Map([['FAM-5', 'evidence-FAM-5'], ['FAM-15', 'evidence-FAM-15'], ['FAM-30', 'evidence-FAM-30']]),
    });
    expect(blocked.fresh).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('FAM-30') && r.includes('change set'))).toBe(true);
    // The stale plan refuses decisions — the operator must re-stage.
    expect(() => decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' }))
      .toThrow(/family_plan_stale/);
    // Review surfaces the same block honestly (blockers populated).
    const review = reviewFamilyJoin({
      planId: staged.plan.id,
      workspacePath,
      liveBySku: new Map([...live.map((p) => [p.sku, p] as const), ['FAM-30', null]]),
      evidenceBySku,
      currentEvidenceBySku: evidenceBySku,
      conflictingDrafts: [{ changeSetId: competitor.id, sku: 'FAM-30', status: 'draft' }],
    });
    expect(review.blockers.some((b) => b.includes('FAM-30') && b.includes('change set'))).toBe(true);
  });

  it('completes the revise → re-accept → apply lifecycle', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    const staged = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    // Revise bumps the revision; revised plans refuse apply until re-accepted.
    const revised = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'revise', note: 'recheck labels' });
    expect(revised.plan.status).toBe('revised');
    expect(revised.plan.revision).toBe(staged.plan.revision + 1);
    expect(() => applyFamilyJoin({
      planId: staged.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map([...live.map((p) => [p.sku, structuredClone(p)] as const), ['FAM-30', importEvidence('FAM-30', '30 lb', 480).draftBase]]),
      actor: 'reviewer-2',
    })).toThrow(/family_plan_not_accepted/);
    // Re-accept persists the full group; apply exports the exact mesh.
    const reaccepted = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(reaccepted.plan.status).toBe('accepted');
    const applied = applyFamilyJoin({
      planId: staged.plan.id, workspaceId, workspacePath,
      draftsBySku: new Map([...live.map((p) => [p.sku, structuredClone(p)] as const), ['FAM-30', importEvidence('FAM-30', '30 lb', 480).draftBase]]),
      actor: 'reviewer-2',
      currentTypeHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.reviewedTypeHash] as const)),
      currentEvidenceHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.evidenceHash] as const)),
      currentRuleVersionBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, 'food-family-variant-rule-v1'] as const)),
      currentProductTypeIdBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.productTypeId] as const)),
      currentLabelBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, null] as const)),
    });
    expect(applied.plan.status).toBe('applied');
    expect(approveChangeSet(applied.changeSetId, workspacePath).success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    const commitHash = linked.load.commitHash;
    expect(commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['FAM-30', 'FAM-5']);
    expect(linked.load.manifest.reads.map((r) => r.sku)).toContain('FAM-15');
    const git = new GitClient(workspacePath);
    expect(git.getHeadHash()).toBe(commitHash);
    for (const sku of ['FAM-5', 'FAM-30']) {
      const committed = git.readFileAtCommit(commitHash, `products/${sku}.json`);
      expect(committed).not.toBeNull();
      const product = JSON.parse(committed!) as Product;
      expect(product.sku).toBe(sku);
      expect(product.customFields['ProductField7']).toBeTruthy();
      expect(product.customFields['ProductField16']).toBe('Acme');
      expect(product.customFields['ProductField17']).toBe('Dog');
      expect(product.customFields['ProductField18']).toBe('Adult');
      expect(product.customFields['ProductField22']).toBe('Dry Kibble');
      expect(product.customFields['ProductField23']).toBe('Chicken');
      expect(product.customFields['ProductField24']).toBe('Chicken Dinner');
    }
    const main = JSON.parse(git.readFileAtCommit(commitHash, 'products/FAM-5.json')!) as Product;
    const refs = [...(main.shopsite.preserved.advancedBlocks['Subproducts'] ?? '').matchAll(/<SKU\s*>([^<]*)<\/SKU\s*>/gi)].map((m) => m[1]!.trim()).sort();
    expect(refs).toEqual(['FAM-30', 'FAM-5']);
    expect(ShopSiteProductCodec.encodeMany(linked.load.products).xml).toContain('<ProductDisabled>checked</ProductDisabled>');
  });

  it('reviews a complete non-food join: member/model invariants, varying size/color axes, and exact write set', () => {
    const { workspacePath, workspaceId, products } = setupNonFoodEarlier();
    // Earlier batch: a reviewed non-food size/color family (explicit main).
    const curation = new Map(products.map((p, _i) => [p.sku, {
      base: structuredClone(p),
      draftBase: structuredClone(p),
    }]));
    const target = stageNonFoodStorefrontFamilyPlan({
      workspaceId, workspacePath,
      input: {
        ruleVersion: 'non-food-size-color-family-variant-rule-v1',
        members: [nonFoodMemberInput('NF-S-RED', 'Small', 'Red'), nonFoodMemberInput('NF-S-BLUE', 'Small', 'Blue')],
        mainSku: 'NF-S-RED',
      },
      actor: 'operator-1',
      curationBySku: curation,
    });
    const targetAccepted = decideStorefrontFamilyPlan({ planId: target.plan.id, actor: 'reviewer-2', action: 'accept' });
    const bySkuTarget = new Map(products.map((p) => [p.sku, structuredClone(p)]));
    const targetApplied = applyStorefrontFamilyPlan({ planId: targetAccepted.plan.id, workspaceId, workspacePath, draftsBySku: bySkuTarget, actor: 'reviewer-2' });
    expect(approveChangeSet(targetApplied.changeSetId, workspacePath).success).toBe(true);
    // Join: a new Large Red import joins the reviewed family.
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ['NF-S-RED', nonFoodCatalogEvidence(live.find((p) => p.sku === 'NF-S-RED')!, 'Small', 'Red')],
      ['NF-S-BLUE', nonFoodCatalogEvidence(live.find((p) => p.sku === 'NF-S-BLUE')!, 'Small', 'Blue')],
      ['NF-L-RED', nonFoodImportEvidence('NF-L-RED', 'Large', 'Red')],
    ]);
    const joined = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: target.plan.id,
      joinedSkus: ['NF-L-RED'],
      actor: 'operator-1',
      evidenceBySku,
    });
    expect(joined.plan.mainSku).toBe('NF-S-RED');
    expect(joined.plan.mainOverridden).toBe(false);
    const reviewLive = new Map<string, Product | null>([
      ...live.map((p) => [p.sku, p] as const),
      ['NF-L-RED', null],
    ]);
    const review = reviewFamilyJoin({ planId: joined.plan.id, workspacePath, liveBySku: reviewLive, evidenceBySku, currentEvidenceBySku: evidenceBySku });
    // Food-only axes are absent; the non-food invariant record agrees.
    expect(review.invariantEvidence.map((r) => r.axis)).toEqual(['brand', 'model', 'material', 'function', 'safetyDose', 'strength', 'fit']);
    expect(review.invariantEvidence.every((r) => r.agreed)).toBe(true);
    expect(review.membership.map((m) => `${m.sku}:${m.origin}`).sort()).toEqual(['NF-L-RED:import', 'NF-S-BLUE:catalog', 'NF-S-RED:catalog']);
    expect(review.varyingAxes.find((v) => v.sku === 'NF-L-RED')?.sizeRaw).toContain('Large');
    expect(review.varyingAxes.find((v) => v.sku === 'NF-S-BLUE')?.colorRaw).toContain('Blue');
    expect(review.blockers).toEqual([]);
    expect(review.writeSet).toEqual([
      { sku: 'NF-L-RED', operation: 'create' },
      { sku: 'NF-S-RED', operation: 'update' },
    ]);
    expect(review.readDependencies).toContain('NF-S-BLUE');
    // Accept → apply → approve exports the full non-food group intact.
    const accepted = decideFamilyJoin({ planId: joined.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    const drafts = new Map<string, Product>([
      ['NF-S-RED', structuredClone(live.find((p) => p.sku === 'NF-S-RED')!)],
      ['NF-S-BLUE', structuredClone(live.find((p) => p.sku === 'NF-S-BLUE')!)],
      ['NF-L-RED', nonFoodDraft('NF-L-RED', 'Large', 'Red')],
    ]);
    const applied = applyFamilyJoin({
      planId: accepted.plan.id, workspaceId, workspacePath, draftsBySku: drafts, actor: 'reviewer-2',
      currentTypeHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.reviewedTypeHash] as const)),
      currentEvidenceHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.evidenceHash] as const)),
      currentRuleVersionBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, 'non-food-size-color-family-variant-rule-v1'] as const)),
      currentProductTypeIdBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.productTypeId] as const)),
      currentLabelBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, null] as const)),
    });
    expect(approveChangeSet(applied.changeSetId, workspacePath).success).toBe(true);
    const linked = loadApprovedLinkedExport(applied.changeSetId, workspacePath);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.load.products.map((p) => p.sku).sort()).toEqual(['NF-L-RED', 'NF-S-RED']);
    expect(linked.load.manifest.reads.map((r) => r.sku)).toContain('NF-S-BLUE');
  });

  it('materializes accepted PF7 before comparing, gates full freshness on apply, and blocks missing evidence', () => {
    const { workspacePath, workspaceId, products } = setupEarlier();
    const adopted = stageNativeAdoption({
      workspaceId, workspacePath,
      memberSkus: ['FAM-5', 'FAM-15'],
      actor: 'operator-1',
      evidenceBySku: adoptionEvidence(products),
    });
    const acceptedAdoption = decideStorefrontFamilyPlan({ planId: adopted.plan.id, actor: 'reviewer-2', action: 'accept' });
    const appliedAdoption = applyAdoptedFamilyPlan({
      planId: acceptedAdoption.plan.id,
      workspaceId, workspacePath,
      draftsBySku: new Map(products.map((p) => [p.sku, structuredClone(p)])),
      actor: 'reviewer-2',
    });
    expect(approveChangeSet(appliedAdoption.changeSetId, workspacePath).success).toBe(true);
    const live = products.map((p) => readProductFile(workspacePath, p.sku)!);
    const evidenceBySku = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480)],
    ]);
    const staged = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    const accepted = decideFamilyJoin({ planId: staged.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(accepted.plan.status).toBe('accepted');
    // Blank-PF7 import drafts apply cleanly: materialization installs the
    // accepted proposal before any comparison (no always-throw).
    const drafts = new Map<string, Product>([
      ...live.map((p) => [p.sku, structuredClone(p)] as const),
      ['FAM-30', importEvidence('FAM-30', '30 lb', 480).draftBase],
    ]);
    expect(drafts.get('FAM-30')?.customFields['ProductField7']).toBeUndefined();
    const applied = applyFamilyJoin({
      planId: accepted.plan.id, workspaceId, workspacePath, draftsBySku: drafts, actor: 'reviewer-2',
      currentTypeHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.reviewedTypeHash] as const)),
      currentEvidenceHashBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.evidenceHash] as const)),
      currentRuleVersionBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, 'food-family-variant-rule-v1'] as const)),
      currentProductTypeIdBySku: new Map([...evidenceBySku].map(([sku, ev]) => [sku, ev.productTypeId] as const)),
      currentLabelBySku: new Map([...evidenceBySku.keys()].map((sku) => [sku, null] as const)),
    });
    expect(applied.plan.status).toBe('applied');
    expect(approveChangeSet(applied.changeSetId, workspacePath).success).toBe(true);
    // Unbound authority fails closed at apply (no opt-out): a fresh
    // accepted plan without bound authority refuses stale, never assumes.
    const stagedAgain = stageFamilyJoin({
      workspaceId, workspacePath,
      familyPlanId: adopted.plan.id,
      joinedSkus: ['FAM-30'],
      actor: 'operator-1',
      evidenceBySku,
    });
    const acceptedAgain = decideFamilyJoin({ planId: stagedAgain.plan.id, actor: 'reviewer-2', action: 'accept' });
    expect(acceptedAgain.plan.status).toBe('accepted');
    expect(() => applyFamilyJoin({ planId: acceptedAgain.plan.id, workspaceId, workspacePath, draftsBySku: drafts, actor: 'reviewer-2' }))
      .toThrow(/family_apply_stale/);
    // Missing current evidence blocks review rather than skipping.
    const reviewLive = new Map<string, Product | null>([
      ...live.map((p) => [p.sku, p] as const),
      ['FAM-30', null],
    ]);
    const partialEvidence = new Map<string, JoinMemberEvidence>([
      ...live.map((p) => [p.sku, catalogEvidence(p)] as const),
    ]);
    const blocked = reviewFamilyJoin({
      planId: staged.plan.id, workspacePath, liveBySku: reviewLive,
      evidenceBySku: partialEvidence, currentEvidenceBySku: partialEvidence,
    });
    expect(blocked.blockers.some((b) => b.includes('FAM-30') && b.includes('no current evidence'))).toBe(true);
  });

  it('flags unit-equivalent duplicates and distinct retail units honestly via the canonical tuple', () => {
    expect(canonicalJoinVariantTuple('food-family-variant-rule-v1', { sizeRaw: '5 lb', ounces: 80, retailUnit: null, colorRaw: null, countRaw: null, countQuantity: null }))
      .toBe(canonicalJoinVariantTuple('food-family-variant-rule-v1', { sizeRaw: '80 oz', ounces: 80, retailUnit: null, colorRaw: null, countRaw: null, countQuantity: null }));
    expect(canonicalJoinVariantTuple('food-family-variant-rule-v1', { sizeRaw: '5 lb', ounces: 80, retailUnit: 'each', colorRaw: null, countRaw: null, countQuantity: null }))
      .not.toBe(canonicalJoinVariantTuple('food-family-variant-rule-v1', { sizeRaw: '5 lb', ounces: 80, retailUnit: 'case', colorRaw: null, countRaw: null, countQuantity: null }));
    expect(canonicalJoinVariantTuple('food-family-variant-rule-v1', { sizeRaw: 'mystery', ounces: null, retailUnit: null, colorRaw: null, countRaw: null, countQuantity: null })).toBeNull();
  });
});
