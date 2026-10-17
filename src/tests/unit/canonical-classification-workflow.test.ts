/**
 * Issue #356/#357 — reviewed-projection consumer regression proof.
 *
 * Replaces the old #350 projection-half placeholder with real consumer proof
 * at the approved run → proposals → reviewer decisions → approved preview →
 * actual local draft seam, for BOTH catalog and onboarding consumers.
 *
 * Certified slot semantics (docs/audits/extra-fields-certification-2026-10-15):
 * PF23 = Facet-Flavor, PF28 = Facet-Material, PF16 = Brand, PF6 = MAP Pricing.
 *
 * The catalog proof starts at classifyCatalogProduct with supplied text and a
 * genuinely activated v2 bundle/profile, then reviews persisted proposals and
 * observes the approved preview and repository draft (no proposal seeding).
 *
 * Case 1 (the #357 before-state): an accepted Flavor→Material correction
 * ("Rubber") must land in the MATERIAL slot (PF28) in preview AND in the
 * local draft — never the original Flavor slot (PF23). Fails on old main
 * where preview resolves the mapping on the immutable original target.
 *
 * Case 2: revised clears / removals, pending-vs-approved semantics, and
 * unchanged unrelated data, observed on the real final local draft.
 *
 * Case 3: protected / unknown / pricing role refusal and stale
 * mapping/source atomicity — no partial product/change-set mutation.
 *
 * Public interfaces only; isolated SQLite + temp Git workspaces;
 * deterministic adapters (no model/store calls, no internal classifier
 * mocks, no raw-SQL behavioral assertions). Pending supplements stay
 * provisional and never enter approved application.
 * Certified website Category and Product Type mappings are asserted in both
 * local consumer workflows below; neither identifier is written as a label.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb } from '../../db/connection';
import type { Database } from '../../db/driver';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createConfigSnapshot,
  getCachedAttributeMappings,
  syncConfigToCache,
  upsertConfigSnapshot,
} from '../../db/repositories/classification-config-repo';
import {
  buildRuntimeSnapshot,
  persistRuntimeSnapshot,
  snapshotHash,
  getRuntimeSnapshotByHash,
} from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { processProductTypeTarget } from '../../classification/curation-target-processor';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { StageInput, StageContext } from '../../classification/types';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import {
  buildAssignmentProjection,
  getEffectiveProposalTargetId,
  getEffectiveProposalValue,
} from '../../classification/assignment-projection';
import { productDraftProjectionStage } from '../../classification/stages/draft-projection';
import { classifyCatalogProduct } from '../../classification/catalog-product-classifier';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { scanCatalogEvidence, renderCatalogEvidence, verifyCatalogEvidenceTreeIntegrity } from '../../classification/catalog-evidence';
import { updateFieldMetadata } from '../../server/services/field-metadata-service';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { writeProductFile, readProductFile } from '../../git/workspace-files';
import { listChangeSetItems, listChangeSets } from '../../db/repositories/change-set-repo';
import { isTaxonomyFrozen, setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import {
  saveClassificationConfig,
  loadClassificationConfig,
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import {
  createRun as createRepositoryRun,
  completeRun,
  getAcceptedProposals,
  getProposalsByRun,
  getEvidenceByRun,
  getRun,
} from '../../db/repositories/classification-run-repo';
import { computeProductHash } from '../../classification/catalog-product-source';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { markReviewed, markApproved } from '../../db/repositories/onboarding-review-repo';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { promoteItems } from '../../onboarding/draft-promoter';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../classification/page-snapshot';
import type {
  ClassificationConfig,
  ClassificationProposal,
} from '../../shared/schemas/classification';
import type { Product } from '../../shared/schemas/product';

const WS_ID = 'ws-canonical-pair-seam';

// Certified slots: PF23 Facet-Flavor, PF28 Facet-Material, PF16 Brand,
// PF6 MAP Pricing (docs/audits/extra-fields-certification-2026-10-15).
const FLAVOR_FIELD = 'ProductField23';
const MATERIAL_FIELD = 'ProductField28';
const COLOR_FIELD = 'ProductField29';
const CATEGORY_FIELD = 'ProductField24';
const PRODUCT_TYPE_FIELD = 'ProductField25';
const BRAND_FIELD = 'ProductField16';
const PRICING_FIELD = 'ProductField6';

function configFixture(): ClassificationConfig {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Material' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: FLAVOR_FIELD, serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'material-map', attributeId: 'material', catalogField: MATERIAL_FIELD, serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: FLAVOR_FIELD, optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'mt', kind: 'product_field', label: 'Material', enabled: true, selectionMode: 'single', attributeId: 'material', catalogField: MATERIAL_FIELD, optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  } satisfies ClassificationConfig;
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(true);
  expect(isTaxonomyFrozen()).toBe(true);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-pair-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  persistLegacyConfigFixture(configFixture());
});

afterEach(() => {
  try {
    closeDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  } finally {
    setTaxonomyFreezeForTests(true);
    expect(isTaxonomyFrozen()).toBe(true);
  }
});

function persistLegacyConfigFixture(config: ClassificationConfig): void {
  const wasFrozen = isTaxonomyFrozen();
  expect(wasFrozen).toBe(true);
  setTaxonomyFreezeForTests(false);
  try {
    saveClassificationConfig(workspacePath, config);
    syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
  } finally {
    setTaxonomyFreezeForTests(wasFrozen);
  }
  expect(isTaxonomyFrozen()).toBe(true);
}

interface SnapshotRef {
  id: string;
  hash: string;
}

/**
 * Capture the run's frozen authority coherently: build the snapshot with its
 * resolved pair mapping, recompute the embedded hash over the captured view,
 * and persist that same captured snapshot. The run then executes against the
 * persisted coherent snapshot — never a patched-then-rebuilt mix where the
 * persisted base lacks the executed mapping.
 */
function persistCoherentSnapshot(sku: string, config: ClassificationConfig, ref: SnapshotRef): SnapshotRef & { snapshot: RuntimeClassificationSnapshot } {
  const now = new Date().toISOString();
  const pages = captureVerifiedPageSnapshot(WS_ID);
  const product = readProductFile(workspacePath, sku);
  const base = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: sku, config,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: now },
    sourceProductHash: product ? computeProductHash(product) : null,
    pages: toPageSnapshotState(pages),
    pageImportId: pages.pageImportId, pageImportHash: pages.pageImportHash,
    productPageNames: product?.core.productOnPages ?? [],
  });
  const captured: RuntimeClassificationSnapshot = {
    ...base,
    categories: [{ id: 'dog-food', name: 'Dog Food' }],
    productTypes: base.productTypes.map(type => ({ ...type, categoryId: 'dog-food' })),
  };
  captured.snapshotHash = snapshotHash(captured);
  const persisted = persistRuntimeSnapshot(captured);
  return { ...persisted, snapshot: captured };
}
async function persistGovernedOnboardingSnapshot(sku: string, product: Product): Promise<SnapshotRef & { snapshot: RuntimeClassificationSnapshot }> {
  writeProductFile(workspacePath, product);
  for (const [xmlField, label] of [
    [FLAVOR_FIELD, 'Facet-Flavor'],
    [MATERIAL_FIELD, 'Facet-Material'],
    [BRAND_FIELD, 'Brand'],
    [PRICING_FIELD, 'MAP Pricing'],
  ]) {
    updateFieldMetadata({ id: WS_ID, workspacePath }, xmlField, { label });
  }
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: workspacePath,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-b', 'main');
  git('config', '--local', 'user.name', 'Onboarding Fixture');
  git('config', '--local', 'user.email', 'onboarding@example.test');
  git('config', '--local', 'core.hooksPath', '/dev/null');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('add', 'products', 'store/field-registry.json');
  git('commit', '-m', 'Seed onboarding catalog evidence');
  const sourceCatalogCommit = git('rev-parse', 'HEAD');
  const seed: BayStateSeed = {
    ...BayStatePetGardenSeed,
    name: 'Onboarding canonical fixture',
    revision: 'onboarding-canonical-v2',
    categories: [{ id: 'dog-food', name: 'Dog Food', description: null }],
    productTypes: [{
      id: 'dog-food-dry', name: 'Dry Dog Food', description: null, categoryId: 'dog-food',
      websiteValues: { category: 'QA Category: dog-food', productType: 'QA Product Type: dog-food-dry' },
    }],
    attributes: [
      { id: 'flavor', name: 'Flavor', allowedValues: ['Chicken'] },
      { id: 'material', name: 'Material', allowedValues: ['Rubber'] },
    ].map((attribute): BayStateSeed['attributes'][number] => ({
      ...attribute,
      description: null,
      valueMode: 'controlled',
      canonicalUnit: null,
      valueAliases: [],
      visualEvidenceEligibility: 'ineligible',
      isClaim: false,
      isCompositionAttribute: false,
      group: null,
      isUniversal: false,
      evidencePolicy: {
        directEvidenceRequired: true,
        forbidAbsenceInference: true,
        allowedSources: ['catalog_product'],
        allowVisualEvidence: false,
        allowThirdPartyEvidence: false,
        thirdPartyEvidenceApproval: null,
        manualReviewRequired: true,
      },
    })),
    profileTemplates: [{
      id: 'dog-food-dry-profile',
      name: 'Dry Dog Food',
      productTypeIds: ['dog-food-dry'],
      attributes: [
        { attributeId: 'flavor', required: false, cardinality: 'single' },
        { attributeId: 'material', required: false, cardinality: 'single' },
      ],
    }],
    mappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: FLAVOR_FIELD, serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      { id: 'material-map', attributeId: 'material', catalogField: MATERIAL_FIELD, serialization: { kind: 'scalar', prefix: '', suffix: '' } },
    ],
    curationTargets: [
      { ...pairTypeTarget().config, required: true, mandatory: true },
      { id: 'ft', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: FLAVOR_FIELD, optionSource: 'configured', required: false, sortOrder: 1 },
      { id: 'mt', kind: 'product_field', label: 'Material', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'material', catalogField: MATERIAL_FIELD, optionSource: 'configured', required: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
  };
  const catalogEvidence = await scanCatalogEvidence(workspacePath, WS_ID);
  const artifact = renderCatalogEvidence(catalogEvidence);
  const evidenceHash = createHash('sha256').update(artifact).digest('hex');
  const candidate = generateCandidate(seed, catalogEvidence);
  const preview = previewCandidate(candidate.bundle, workspacePath, { catalogEvidence: artifact });
  if (!preview.hash) throw new Error(JSON.stringify(preview.report.findings));
  const candidateHash = preview.hash;
  const priorFreeze = isTaxonomyFrozen();
  expect(priorFreeze).toBe(true);
  await (async () => {
    setTaxonomyFreezeForTests(false);
    try {
      return await activateBundle(candidateHash, null, {
        workspacePath,
        workspaceId: WS_ID,
        sourceCatalogCommit,
        catalogEvidenceHash: evidenceHash,
        activationContext: {
          ...createRuntimeActivationContext(workspacePath, WS_ID),
          verifyCatalogEvidenceTree: hash => verifyCatalogEvidenceTreeIntegrity(workspacePath, hash, WS_ID),
        },
      });
    } finally {
      setTaxonomyFreezeForTests(priorFreeze);
    }
  })();
  expect(isTaxonomyFrozen()).toBe(true);
  const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
  if (authority.kind !== 'v2') throw new Error('Onboarding fixture did not activate v2 authority');
  const configRef = upsertConfigSnapshot(WS_ID, authority.bundle, sourceCatalogCommit);
  const pages = captureVerifiedPageSnapshot(WS_ID);
  const base = buildRuntimeSnapshot({
    workspaceId: WS_ID,
    workspacePath,
    productSku: sku,
    authority,
    configSnapshotRef: {
      id: configRef.id,
      hash: configRef.hash,
      sourceCommit: sourceCatalogCommit,
      createdAt: new Date().toISOString(),
    },
    sourceProductHash: computeProductHash(product),
    catalogEvidenceHash: evidenceHash,
    pages: toPageSnapshotState(pages),
    pageImportId: pages.pageImportId,
    pageImportHash: pages.pageImportHash,
    productPageNames: product.core.productOnPages ?? [],
  });
  const persisted = persistRuntimeSnapshot(base);
  return { ...persisted, snapshot: base };
}


function seedFieldProposal(db: Database, runId: string, sku: string, id: string, targetId: string, value: unknown, now: string): void {
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, runId, sku, 'field_assignment', targetId, JSON.stringify(value), 0.9, 'pending', now],
  );
}
function seedPairProposal(db: Database, runId: string, sku: string, now: string): void {
  db.run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'product_classification', ?, ?, 0.95, 'pending', ?)`,
    ['prop-ob-pair', runId, sku, 'dog-food-dry', JSON.stringify({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' }), now],
  );
}


function seedPageProposal(db: Database, runId: string, sku: string, id: string, targetId: string, value: unknown, now: string): void {
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, runId, sku, 'category_page', targetId, JSON.stringify(value), 0.9, 'pending', now],
  );
}

interface DraftProductOptions {
  customFields?: Record<string, string>;
  productOnPages?: string[];
  name?: string;
}

function baseProduct(sku: string, now: string, overrides: DraftProductOptions = {}): Product {
  return {
    schemaVersion: 1, id: `p-${sku}`, sku, status: 'active',
    core: {
      name: overrides.name ?? 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: 'products/x/primary.jpg', additional: ['products/x/alt.jpg'] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null },
      productOnPages: overrides.productOnPages ?? ['Old Page'],
    },
    customFields: overrides.customFields ?? { [BRAND_FIELD]: 'Acme', [FLAVOR_FIELD]: 'Beef', [MATERIAL_FIELD]: 'Nylon' },
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

interface DraftAssertionView {
  customFields: Record<string, string>;
  core: { name: string; price: string; productOnPages?: string[] };
  sku: string;
}

function readDraftView(changeSetId: string): DraftAssertionView {
  const items = listChangeSetItems(changeSetId);
  expect(items).toHaveLength(1);
  const parsed: unknown = JSON.parse(items[0].draftJson);
  if (!parsed || typeof parsed !== 'object') throw new Error('draft JSON is not an object');
  if (!('customFields' in parsed) || !('core' in parsed) || !('sku' in parsed)) {
    throw new Error('draft JSON lacks customFields/core/sku');
  }
  const customFields: unknown = parsed.customFields;
  const core: unknown = parsed.core;
  const sku: unknown = parsed.sku;
  if (!customFields || typeof customFields !== 'object') throw new Error('draft customFields is not an object');
  if (!core || typeof core !== 'object' || !('name' in core) || !('price' in core)) {
    throw new Error('draft core lacks name/price');
  }
  const name: unknown = core.name;
  const price: unknown = core.price;
  if (typeof name !== 'string' || typeof price !== 'string' || typeof sku !== 'string') {
    throw new Error('draft name/price/sku are not strings');
  }
  const pages: unknown = 'productOnPages' in core ? core.productOnPages : undefined;
  return {
    customFields: customFields as Record<string, string>,
    core: { name, price, productOnPages: Array.isArray(pages) ? (pages as string[]) : undefined },
    sku,
  };
}

function pairTypeTarget(): ResolvedTarget {
  return {
    config: { id: 'pt', kind: 'product_type', label: 'Primary Product Type', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 0 },
    options: [{ value: 'dog-food-dry', label: 'Dry Dog Food' }],
  } satisfies ResolvedTarget;
}

function pairSnapshotContext(runId: string, ref: SnapshotRef, snapshot: RuntimeClassificationSnapshot): StageContext {
  return {
    workspacePath, workspaceId: WS_ID, runId,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
    snapshot,
  };
}
describe('canonical classification from supplied facts to reviewed catalog draft', () => {
  it('classifies the own-SKU pair and profile attributes, then drafts only reviewed changes', async () => {
    const sku = 'SKU-ACTUAL-CATALOG';
    const now = new Date().toISOString();
    const product = baseProduct(sku, now, {
      name: 'Acme Red Rubber Dog Toys',
      customFields: {
        [BRAND_FIELD]: 'Acme', [FLAVOR_FIELD]: 'Beef',
        [MATERIAL_FIELD]: 'Nylon', [COLOR_FIELD]: 'Blue',
        [PRICING_FIELD]: '12.50', ProductField99: 'opaque custom value',
      },
      productOnPages: ['Old Page', 'Brand - Acme'],
    });
    product.core.description = 'Dog Toys made of Rubber. Color: Red.';
    // Supplied text is sufficient; no OCR/image discovery or model transport.
    product.core.media = { primary: null, additional: [] };
    product.shopsite.preserved = {
      unknownElements: { ProductType: 'Tangible', VendorExtension: 'opaque native value' },
      advancedBlocks: { VendorBlock: '<VendorBlock keep="yes"/>' },
      rawAttributes: { vendorFlag: 'keep' },
    };
    writeProductFile(workspacePath, product);

    // R1 metadata and its R2 attestation are written through the real owner.
    for (const [xmlField, label] of [
      [MATERIAL_FIELD, 'Facet-Material'], [COLOR_FIELD, 'Facet-Color'],
      [BRAND_FIELD, 'Brand'], [PRICING_FIELD, 'MAP Pricing'],
    ]) {
      updateFieldMetadata({ id: WS_ID, workspacePath }, xmlField, { label });
    }
    // All Git identity/configuration is confined to this temporary repository.
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: workspacePath, encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    git('init', '-b', 'main');
    git('config', '--local', 'user.name', 'Workflow Fixture');
    git('config', '--local', 'user.email', 'workflow@example.test');
    git('config', '--local', 'core.hooksPath', '/dev/null');
    git('config', '--local', 'commit.gpgsign', 'false');
    git('add', 'products', 'store/field-registry.json');
    git('commit', '-m', 'Seed supplied catalog facts and certified fields');
    const sourceCatalogCommit = git('rev-parse', 'HEAD');

    const seed: BayStateSeed = {
      ...BayStatePetGardenSeed,
      name: 'Catalog workflow fixture', revision: 'catalog-workflow-v2',
      categories: [{ id: 'dog', name: 'Dog', description: null }],
      productTypes: [{
        id: 'dog-toys', name: 'Dog Toys', description: null, categoryId: 'dog',
        websiteValues: { category: 'QA Canine Goods', productType: 'QA Dog Toy' },
      }],
      attributes: [
        { id: 'material', name: 'Material', allowedValues: ['Rubber'] },
        { id: 'color', name: 'Color', allowedValues: ['Red'] },
      ].map((attribute): BayStateSeed['attributes'][number] => ({
        ...attribute, description: null, valueMode: 'controlled', canonicalUnit: null,
        valueAliases: [], visualEvidenceEligibility: 'ineligible',
        isClaim: false, isCompositionAttribute: false, group: null, isUniversal: false,
        evidencePolicy: {
          directEvidenceRequired: true, forbidAbsenceInference: true,
          allowedSources: ['catalog_product'], allowVisualEvidence: false,
          allowThirdPartyEvidence: false, thirdPartyEvidenceApproval: null, manualReviewRequired: true,
        },
      })),
      profileTemplates: [{
        id: 'toys', name: 'Toy attributes', productTypeIds: ['dog-toys'],
        attributes: [
          { attributeId: 'material', required: true, cardinality: 'single' },
          { attributeId: 'color', required: false, cardinality: 'single' },
        ],
      }],
      mappings: [
        { id: 'material-map', attributeId: 'material', catalogField: MATERIAL_FIELD, serialization: { kind: 'scalar', prefix: '', suffix: '' } },
        { id: 'color-map', attributeId: 'color', catalogField: COLOR_FIELD, serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      ],
      curationTargets: [
        { ...pairTypeTarget().config, required: true, mandatory: true },
        { id: 'mt', kind: 'product_field', label: 'Material', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'material', catalogField: MATERIAL_FIELD, optionSource: 'configured', required: false, sortOrder: 1 },
        { id: 'ct', kind: 'product_field', label: 'Color', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'color', catalogField: COLOR_FIELD, optionSource: 'configured', required: false, sortOrder: 2 },
      ],
      brands: [], guidance: [],
    };
    const catalogEvidence = await scanCatalogEvidence(workspacePath, WS_ID);
    const artifact = renderCatalogEvidence(catalogEvidence);
    const evidenceHash = createHash('sha256').update(artifact).digest('hex');
    const candidate = generateCandidate(seed, catalogEvidence);
    const preview = previewCandidate(candidate.bundle, workspacePath, { catalogEvidence: artifact });
    if (!preview.hash) throw new Error(JSON.stringify(preview.report.findings));
    const priorFreeze = isTaxonomyFrozen();
    expect(priorFreeze).toBe(true);
    const activation = await (async () => {
      setTaxonomyFreezeForTests(false);
      try {
        return await activateBundle(preview.hash!, null, {
          workspacePath, workspaceId: WS_ID, sourceCatalogCommit, catalogEvidenceHash: evidenceHash,
          activationContext: {
            ...createRuntimeActivationContext(workspacePath, WS_ID),
            verifyCatalogEvidenceTree: hash => verifyCatalogEvidenceTreeIntegrity(workspacePath, hash, WS_ID),
          },
        });
      } finally {
        setTaxonomyFreezeForTests(priorFreeze);
      }
    })();
    expect(isTaxonomyFrozen()).toBe(true);
    const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
    expect(authority.kind).toBe('v2');

    // This is the production entrypoint: it captures/persists its own frozen
    // authority and creates all evidence/proposals through the real pipeline.
    const classified = await classifyCatalogProduct(WS_ID, workspacePath, product);
    expect(classified.error).toBeUndefined();
    expect(classified.success).toBe(true);
    const run = getRun(classified.runId);
    if (!run?.configSnapshotHash) throw new Error('Classifier did not persist frozen authority');
    const snapshot = getRuntimeSnapshotByHash(WS_ID, run.configSnapshotHash);
    if (!snapshot) throw new Error('Frozen runtime snapshot was not persisted');
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.configAuthorityKind).toBe('v2');
    expect(snapshot.configSnapshotRef.hash).toBe(activation.hash);
    expect(snapshot.snapshotHash).toBe(run.configSnapshotHash);
    expect(snapshotHash(snapshot)).toBe(run.configSnapshotHash);
    expect(snapshot.sourceProductHash).toBe(computeProductHash(product));
    expect(snapshot.productTypes.find(type => type.id === 'dog-toys')).toMatchObject({
      categoryId: 'dog', attributeProfileId: 'dog-toys-profile',
    });

    const proposals = getProposalsByRun(run.id);
    const pairs = proposals.filter(proposal => proposal.proposalType === 'product_classification');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].proposedValue).toMatchObject({ categoryId: 'dog', productTypeId: 'dog-toys' });
    const material = proposals.find(proposal => proposal.proposalType === 'field_assignment' && proposal.targetId === 'material');
    const color = proposals.find(proposal => proposal.proposalType === 'field_assignment' && proposal.targetId === 'color');
    if (!material || !color) throw new Error('Same-pass profile attribute proposals are missing');
    expect(material.proposedValue).toBe('Rubber');
    expect(color.proposedValue).toBe('Red');
    expect(material.status).toBe('pending');
    expect(color.status).toBe('pending');
    expect(proposals.some(proposal => proposal.targetId === 'brand' || proposal.targetId === BRAND_FIELD)).toBe(false);
    const evidence = getEvidenceByRun(run.id);
    expect(evidence.some(record => record.source === 'catalog_product' && record.productSku === sku && record.snippet?.includes('Rubber'))).toBe(true);
    expect((material.supportingEvidenceIds ?? []).some(id => evidence.some(record => record.id === id && record.productSku === sku))).toBe(true);

    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [pairs[0], material].map(proposal => ({ proposalId: proposal.id, decision: 'accepted' as const })),
    });
    expect(reviewed.ok).toBe(true);
    const accepted = getAcceptedProposals(sku, run.id);
    expect(accepted.map(proposal => proposal.id).sort()).toEqual([pairs[0].id, material.id].sort());
    expect(getProposalsByRun(run.id).find(proposal => proposal.id === color.id)?.status).toBe('pending');

    // The shared approved-only preview excludes the unreviewed Red proposal.
    const approved = buildAssignmentProjection(
      accepted, product.customFields, product.core.productOnPages ?? [], getCachedAttributeMappings(WS_ID),
      new Set(), {
        attributes: snapshot.attributes,
        frozenMappings: snapshot.attributeMappings,
        categories: snapshot.categories,
        productTypes: snapshot.productTypes,
      },
    );
    expect(approved.skipped).toEqual([]);
    expect(approved.fields.find(field => field.catalogField === MATERIAL_FIELD)?.proposedValue).toBe('Rubber');
    expect(approved.fields.find(field => field.catalogField === CATEGORY_FIELD)?.proposedValue).toBe('QA Canine Goods');
    expect(approved.fields.find(field => field.catalogField === PRODUCT_TYPE_FIELD)?.proposedValue).toBe('QA Dog Toy');
    const applied = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(approved.fields.some(field => field.catalogField === CATEGORY_FIELD)).toBe(true);
    expect(approved.fields.some(field => field.catalogField === PRODUCT_TYPE_FIELD)).toBe(true);
    expect(applied.appliedFields).toContain(MATERIAL_FIELD);
    expect(applied.appliedFields).not.toContain(COLOR_FIELD);
    expect(applied.appliedFields).toContain(CATEGORY_FIELD);
    expect(applied.appliedFields).toContain(PRODUCT_TYPE_FIELD);
    expect(applied.skipped).toEqual([]);
    const items = listChangeSetItems(applied.changeSetId);
    expect(items).toHaveLength(1);
    const draft = JSON.parse(items[0].draftJson) as Product;
    const projectedMaterial = approved.fields.find(field => field.catalogField === MATERIAL_FIELD);
    if (!projectedMaterial?.proposedValue) throw new Error('approved projection lacks a material value');
    expect(draft.customFields[MATERIAL_FIELD]).toBe(projectedMaterial.proposedValue);
    expect(draft.customFields[CATEGORY_FIELD]).toBe('QA Canine Goods');
    expect(draft.customFields[PRODUCT_TYPE_FIELD]).toBe('QA Dog Toy');
    expect(draft.customFields[COLOR_FIELD]).toBe('Blue');
    for (const field of [BRAND_FIELD, FLAVOR_FIELD, PRICING_FIELD, 'ProductField99']) {
      expect(draft.customFields[field]).toBe(product.customFields[field]);
    }
    expect(draft.core).toEqual(product.core);
    expect(draft.shopsite).toEqual(product.shopsite);
    expect(draft.sku).toBe(sku);
    expect(draft.status).toBe(product.status);
    // Local change-set only: the repository source product is untouched.
    expect(readProductFile(workspacePath, sku)).toEqual(product);
  });

  it('empty evidence abstains on both components — never a forced label', async () => {
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const persisted = persistCoherentSnapshot('SKU-EMPTY', config, ref);
    const snapshot = getRuntimeSnapshotByHash(WS_ID, persisted.hash);
    if (!snapshot) throw new Error('Frozen snapshot was not persisted');
    const input: StageInput = { sku: 'SKU-EMPTY', evidence: [], acceptedProposals: [], allProposals: [] };
    const result = await processProductTypeTarget(
      pairTypeTarget(), input,
      pairSnapshotContext('run-empty', ref, snapshot),
    );
    expect(result.proposals).toEqual([]);
  });
});

describe('issue #357 reviewed-projection parity: Flavor→Material correction (catalog)', () => {
  it('preview and local draft agree on the corrected destination — Rubber lands in PF28, never PF23', async () => {
    const sku = 'SKU-FLAVOR-MATERIAL';
    const now = new Date().toISOString();
    const product = baseProduct(sku, now);
    writeProductFile(workspacePath, product);
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    // The run executes against the persisted coherent snapshot (captured
    // authority), so review-time frozen validation sees the same
    // flavor/material attributes the test configured.
    const persisted = persistCoherentSnapshot(sku, config, ref);
    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product', sourceProductHash: persisted.snapshot.sourceProductHash });
    const db = getDb();
    seedFieldProposal(db, run.id, sku, 'prop-flavor', 'flavor', 'Chicken', now);
    completeRun(run.id, 'completed');

    // Reviewer corrects the Flavor proposal to Material/Rubber (the observed
    // #357 before-state).
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' },
      ],
    });
    expect(reviewed.ok).toBe(true);

    const accepted: ClassificationProposal[] = getAcceptedProposals(sku, run.id);
    expect(accepted).toHaveLength(1);
    expect(getEffectiveProposalTargetId(accepted[0])).toBe('material');
    expect(getEffectiveProposalValue(accepted[0])).toBe('Rubber');

    const mappings = getCachedAttributeMappings(WS_ID);

    // Approved preview (generic projector): corrected destination parity —
    // Rubber projects to PF28 (Material), and PF23 (Flavor) is untouched.
    const projection = buildAssignmentProjection(
      accepted, product.customFields, product.core.productOnPages ?? [], mappings, new Set(),
      { attributes: persisted.snapshot.attributes, frozenMappings: persisted.snapshot.attributeMappings },
    );
    expect(projection.skipped).toEqual([]);
    const projectedByField: Record<string, string> = {};
    for (const field of projection.fields) projectedByField[field.catalogField] = field.proposedValue ?? '';
    expect(projectedByField[MATERIAL_FIELD]).toBe('Rubber');
    expect(FLAVOR_FIELD in projectedByField).toBe(false);
    expect(projection.skipped.map(s => s.targetId)).not.toContain('brand');

    // Approved preview (draft-projection stage): SAME destination. This is
    // the #357 regression — old main wrote the revised value to PF23 here
    // while the generic projector wrote PF28.
    const stageInput: StageInput = { sku, evidence: [], acceptedProposals: accepted, allProposals: accepted };
    const stageResult = await productDraftProjectionStage.execute(
      stageInput,
      pairSnapshotContext(run.id, ref, persisted.snapshot),
    );
    if (stageResult.status === 'failed') throw new Error(stageResult.error);
    if (!stageResult.output) throw new Error('Draft projection stage returned no output');
    const stageMetadata: unknown = stageResult.output.metadata;
    if (!stageMetadata || typeof stageMetadata !== 'object' || !('projection' in stageMetadata)) {
      throw new Error('draft projection stage returned no projection metadata');
    }
    const stageProjection: unknown = stageMetadata.projection;
    if (!stageProjection || typeof stageProjection !== 'object' || !('fieldAssignments' in stageProjection)) {
      throw new Error('draft projection metadata lacks fieldAssignments');
    }
    const previewFields = stageProjection.fieldAssignments;
    if (!previewFields || typeof previewFields !== 'object') {
      throw new Error('Draft projection returned invalid field assignments');
    }
    expect(MATERIAL_FIELD in previewFields && previewFields[MATERIAL_FIELD]).toBe('Rubber');
    expect(FLAVOR_FIELD in previewFields).toBe(false);

    // Actual local draft: the change-set product carries Rubber in PF28,
    // PF23 keeps its existing value, Brand and the rest survive.
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).toEqual([MATERIAL_FIELD]);
    const draft = readDraftView(result.changeSetId);
    expect(draft.customFields[MATERIAL_FIELD]).toBe('Rubber');
    expect(draft.customFields[FLAVOR_FIELD]).toBe('Beef');
    expect(draft.customFields[BRAND_FIELD]).toBe('Acme');
    expect(draft.core.name).toBe('Acme Chicken Dinner');
    expect(draft.core.price).toBe('9.99');
    expect(draft.sku).toBe(sku);
  });

  it('accepted clears and page removals apply; pending supplements stay provisional and never enter the draft', async () => {
    const sku = 'SKU-CLEAR-REMOVE';
    const now = new Date().toISOString();
    activatePageImportFromRecords({
      workspaceId: WS_ID, sourceHash: createHash('sha256').update(sku).digest('hex'),
      parserFormatVersion: 'pages-xml-1', activatedBy: 'test',
      records: [{ identity: { kind: 'exported_guid', key: 'old-page', status: 'verified' }, name: 'Old Page', parentRef: null, availability: 'available' }],
    });
    const oldPage = listVerifiedPageOptions(WS_ID).find(page => page.name === 'Old Page');
    if (!oldPage) throw new Error('Verified removal page was not imported');
    const product = baseProduct(sku, now, {
      customFields: { [BRAND_FIELD]: 'Acme', [FLAVOR_FIELD]: 'Chicken', [MATERIAL_FIELD]: 'Nylon' },
      productOnPages: ['Old Page', 'Brand - Acme'],
    });
    writeProductFile(workspacePath, product);
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const persisted = persistCoherentSnapshot(sku, config, ref);
    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product', sourceProductHash: persisted.snapshot.sourceProductHash });
    const db = getDb();
    seedFieldProposal(db, run.id, sku, 'prop-clear', 'flavor', 'Chicken', now);
    seedFieldProposal(db, run.id, sku, 'prop-pending', 'material', 'Rubber', now);
    seedPageProposal(db, run.id, sku, 'prop-page', oldPage.id, { pageId: oldPage.id, pageName: oldPage.name }, now);
    completeRun(run.id, 'completed');

    // Explicit reviewed clear (null value, same target) + reviewed page
    // removal (null target + null value). The material proposal stays
    // pending — provisional only.
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-clear', decision: 'accepted', revisedValue: null },
        { proposalId: 'prop-page', decision: 'accepted', revisedTargetId: null, revisedValue: null },
      ],
    });
    expect(reviewed.ok).toBe(true);

    const accepted: ClassificationProposal[] = getAcceptedProposals(sku, run.id);
    expect(accepted.map(p => p.id).sort()).toEqual(['prop-clear', 'prop-page']);

    // The approved projection carries the clear; the pending Rubber
    // supplement never enters approved application.
    const mappings = getCachedAttributeMappings(WS_ID);
    const projection = buildAssignmentProjection(
      accepted, product.customFields, product.core.productOnPages ?? [], mappings, new Set([oldPage.id]),
      { attributes: persisted.snapshot.attributes, frozenMappings: persisted.snapshot.attributeMappings,
        verifiedPageNames: new Map([[oldPage.id, oldPage.name]]) },
    );
    expect(projection.skipped).toEqual([]);
    expect(projection.pages.final).toEqual(['Brand - Acme']);
    expect(projection.fields.some(field => field.catalogField === MATERIAL_FIELD)).toBe(false);
    const projectedByField: Record<string, string> = {};
    for (const field of projection.fields) projectedByField[field.catalogField] = field.proposedValue ?? '';
    expect(projectedByField[FLAVOR_FIELD]).toBe('');

    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    const draft = readDraftView(result.changeSetId);
    expect(draft.customFields[FLAVOR_FIELD]).toBe('');
    expect(draft.customFields[MATERIAL_FIELD]).toBe('Nylon');
    expect(draft.customFields[BRAND_FIELD]).toBe('Acme');
    expect(draft.core.productOnPages).toEqual(['Brand - Acme']);
    expect(readProductFile(workspacePath, sku)).toEqual(product);
  });

  it('protected/unknown/pricing revised targets refuse; stale mapping or source fails atomically with no partial write', async () => {
    const sku = 'SKU-REFUSE-STALE';
    const now = new Date().toISOString();
    const product = baseProduct(sku, now);
    writeProductFile(workspacePath, product);
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const persisted = persistCoherentSnapshot(sku, config, ref);
    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { sourceKind: 'catalog_product', sourceProductHash: persisted.snapshot.sourceProductHash });
    const db = getDb();
    seedFieldProposal(db, run.id, sku, 'prop-flavor', 'flavor', 'Chicken', now);
    completeRun(run.id, 'completed');

    // Protected revised targets (Brand, pricing slot) refuse at review.
    const protectedTargets = ['brand', BRAND_FIELD, PRICING_FIELD];
    for (const revisedTargetId of protectedTargets) {
      const refused = submitProposalDecisions({
        workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
        decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId, revisedValue: 'X' }],
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('protected_target_refused');
    }
    // Unknown revised target: frozen validation refuses (not in the run's
    // frozen taxonomy) — never a silent write.
    const unknown = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId: 'no-such-attribute', revisedValue: 'X' }],
    });
    expect(unknown.ok).toBe(false);

    // Accept cleanly, then drift the live destination/serialization. A
    // projection refusal blocks the entire local draft (no partial write).
    const clean = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted' }],
    });
    expect(clean.ok).toBe(true);
    const repointed = configFixture();
    repointed.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.catalogField = 'ProductField24';
    syncConfigToCache(WS_ID, repointed);
    const draftsBefore = listChangeSets(WS_ID);
    await expect(applyCatalogClassification(workspacePath, WS_ID, sku, run.id)).rejects.toThrow(/Classification projection refused/);
    expect(listChangeSets(WS_ID)).toEqual(draftsBefore);
    expect(readProductFile(workspacePath, sku)).toEqual(product);

    // Serialization-only drift is also refused even with the same certified slot.
    const reserialized = configFixture();
    reserialized.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.serialization.prefix = 'Flavor: ';
    syncConfigToCache(WS_ID, reserialized);
    await expect(applyCatalogClassification(workspacePath, WS_ID, sku, run.id)).rejects.toThrow(/mapping_changed/);
    expect(listChangeSets(WS_ID)).toEqual(draftsBefore);
    syncConfigToCache(WS_ID, config);

    // Stale SOURCE: a product edit after review refuses the whole apply
    // atomically — the drifted run throws before any change set is written.
    const sku2 = 'SKU-SOURCE-DRIFT';
    const product2 = baseProduct(sku2, now);
    writeProductFile(workspacePath, product2);
    const persisted2 = persistCoherentSnapshot(sku2, config, ref);
    const run2 = createRepositoryRun(WS_ID, sku2, persisted2.id, persisted2.hash, { sourceKind: 'catalog_product', sourceProductHash: persisted2.snapshot.sourceProductHash });
    seedFieldProposal(getDb(), run2.id, sku2, 'prop-f2', 'material', 'Rubber', now);
    completeRun(run2.id, 'completed');
    const accept2 = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku2, runId: run2.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-f2', decision: 'accepted' }],
    });
    expect(accept2.ok).toBe(true);
    // Drift the source after the hash was recorded.
    const drifted = baseProduct(sku2, now, { name: 'Tampered Name' });
    writeProductFile(workspacePath, drifted);
    await expect(applyCatalogClassification(workspacePath, WS_ID, sku2, run2.id)).rejects.toThrow(/changed since classification/);
    expect(listChangeSets(WS_ID)).toEqual(draftsBefore);
    expect(readProductFile(workspacePath, sku2)).toEqual(drifted);
  });
});

describe('issue #357 reviewed-projection parity: onboarding consumer', () => {
  it('an accepted Flavor→Material correction promotes Rubber into PF28 through the real onboarding draft path', async () => {
    const sku = 'SKU-ONBOARD-357';
    const now = new Date().toISOString();
    const product = baseProduct(sku, now, {
      name: 'Acme Dry Dog Food Chicken',
      productOnPages: ['Old Page', 'Brand - Acme'],
      customFields: {
        [BRAND_FIELD]: 'Acme',
        [FLAVOR_FIELD]: 'Chicken',
        [MATERIAL_FIELD]: 'Nylon',
        [PRICING_FIELD]: '9.99',
      },
    });

    // Onboarding item with a verified page (mandatory Pages gate) and a
    // title carrying both brand and measurement evidence (naming gate).
    const batch = createBatch({ workspaceId: WS_ID, name: 'Onboard 357', fileName: 'promo-357.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{
      upc: sku, name: 'Acme Rubber Chew 5 LB', price: '9.99', brandHint: 'Acme', rowNumber: 1,
    }]);
    const odb = getDb();
    // A real supplied workspace image satisfies the separate listing-media
    // requirement without a model call or a live image download.
    const imageDir = path.join(workspacePath, 'products', 'images', 'acme');
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'rubber-chew.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64',
    ));
    const extractionData = {
      title: 'Acme Rubber Chew 5 LB', brand: 'Acme', description: 'Tough rubber chew.',
      bulletPoints: [], primaryImage: 'acme/rubber-chew.png', additionalImages: [], price: '9.99',
      weight: '5 LB', dimensions: null, seoFileName: null, searchKeywords: null,
      packagingTitle: null, packagingOcrData: null, customFields: {},
      sourceUrl: `https://example.test/${sku}`, confidence: 0.9, fieldProvenance: { title: 'json-ld' },
    };
    const key = `vp-357-${sku}`;
    activatePageImportFromRecords({
      workspaceId: WS_ID,
      sourceHash: createHash('sha256').update(key).digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key, status: 'verified' }, name: 'Toys', parentRef: null, availability: 'available' },
        { identity: { kind: 'exported_guid', key: `old-${key}`, status: 'verified' }, name: 'Old Page', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });
    const verified = listVerifiedPageOptions(WS_ID).find(p => p.name === 'Toys');
    const oldPage = listVerifiedPageOptions(WS_ID).find(p => p.name === 'Old Page');
    if (!verified || !oldPage) throw new Error('verified onboarding page fixture not created');

    const persisted = await persistGovernedOnboardingSnapshot(sku, product);
    expect(isTaxonomyFrozen()).toBe(true);
    expect(persisted.snapshot.schemaVersion).toBe(2);
    expect(persisted.snapshot.configAuthorityKind).toBe('v2');
    expect(persisted.snapshot.productTypes.find(type => type.id === 'dog-food-dry')).toMatchObject({
      categoryId: 'dog-food',
      attributeProfileId: 'dog-food-dry-profile',
    });

    // Onboarding run linked to the item; proposals carry the frozen
    // authority of the persisted coherent snapshot.
    const run = createRepositoryRun(WS_ID, sku, persisted.id, persisted.hash, { onboardingItemId: item.id, sourceKind: 'onboarding' });
    seedPairProposal(odb, run.id, sku, now);
    seedFieldProposal(odb, run.id, sku, 'prop-ob-flavor', 'flavor', 'Chicken', now);
    seedFieldProposal(odb, run.id, sku, 'prop-ob-clear', 'flavor', 'Chicken', now);
    seedFieldProposal(odb, run.id, sku, 'prop-ob-pending', 'material', 'Nylon', now);
    seedPageProposal(odb, run.id, sku, 'prop-ob-page', verified.id, { pageId: verified.id, pageName: 'Toys' }, now);
    seedPageProposal(odb, run.id, sku, 'prop-ob-remove', oldPage.id, { pageId: oldPage.id, pageName: 'Old Page' }, now);
    completeRun(run.id, 'completed');

    for (const revisedTargetId of ['brand', 'does-not-exist']) {
      const refused = submitProposalDecisions({
        workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'onboarding', onboardingItemId: item.id,
        decisions: [{
          proposalId: 'prop-ob-flavor', decision: 'accepted',
          revisedTargetId, revisedValue: 'Not a classification value',
        }],
      });
      expect(refused.ok).toBe(false);
    }
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'onboarding', onboardingItemId: item.id,
      decisions: [
        { proposalId: 'prop-ob-pair', decision: 'accepted' },
        { proposalId: 'prop-ob-flavor', decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' },
        { proposalId: 'prop-ob-clear', decision: 'accepted', revisedValue: null },
        { proposalId: 'prop-ob-page', decision: 'accepted' },
        { proposalId: 'prop-ob-pending', decision: 'rejected' },
        { proposalId: 'prop-ob-remove', decision: 'accepted', revisedTargetId: null, revisedValue: null },
      ],
    });
    expect(reviewed.ok).toBe(true);

    odb.query(
      `UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`,
    ).run(
      JSON.stringify(extractionData),
      JSON.stringify({
        curatedTitle: 'Acme Rubber Chew 5 LB', titleSource: 'web',
        curatedWeight: '5 LB', curationMethod: 'manual', curatedAt: now,
        classificationRunId: run.id, suggestedPages: ['Toys'],
      }),
      item.id,
    );
    const reviewGate = validateReviewCompletionGate({
      workspaceId: WS_ID, onboardingItemId: item.id, productSku: sku, activeRunId: run.id,
    });
    expect(reviewGate.ok).toBe(true);
    markReviewed({ itemId: item.id, batchId: batch.id, reviewedBy: 'seam-test' });
    markApproved({ itemId: item.id, batchId: batch.id, approvedBy: 'seam-test' });
    const draftsBeforeStaleImport = listChangeSets(WS_ID);
    activatePageImportFromRecords({
      workspaceId: WS_ID,
      sourceHash: createHash('sha256').update(`${key}-stale-import`).digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key: `stale-${key}`, status: 'verified' },
        name: 'Toys', parentRef: null, availability: 'available',
      }],
      activatedBy: 'test',
    });
    const stalePromotion = await promoteItems(WS_ID, workspacePath, batch.id, [item.id]);
    expect(stalePromotion.count).toBe(0);
    expect(stalePromotion.failures).toHaveLength(1);
    expect(stalePromotion.failures[0]!.error).toContain('Page import authority changed');
    expect(listChangeSets(WS_ID)).toEqual(draftsBeforeStaleImport);
    odb.query(
      `UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`,
    ).run(item.id);
    activatePageImportFromRecords({
      workspaceId: WS_ID,
      sourceHash: createHash('sha256').update(key).digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key, status: 'verified' }, name: 'Toys', parentRef: null, availability: 'available' },
        { identity: { kind: 'exported_guid', key: `old-${key}`, status: 'verified' }, name: 'Old Page', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });

    const result = await promoteItems(WS_ID, workspacePath, batch.id, [item.id]);
    expect(result.failures).toEqual([]);
    expect(result.count).toBe(1);
    if (!result.changeSetId) throw new Error('promotion produced no change set');
    const draft = readDraftView(result.changeSetId);
    // Corrected destination parity: Rubber in PF28; the accepted Flavor
    // clear and page removal apply, pending Nylon is excluded, and unrelated
    // Brand/listing data remain unchanged.
    expect(draft.customFields[FLAVOR_FIELD]).toBe('');
    expect(draft.customFields[MATERIAL_FIELD]).toBe('Rubber');
    expect(draft.customFields[CATEGORY_FIELD]).toBe('QA Category: dog-food');
    expect(draft.customFields[PRODUCT_TYPE_FIELD]).toBe('QA Product Type: dog-food-dry');
    expect(draft.customFields[BRAND_FIELD]).toBe('Acme');
    expect(draft.core.productOnPages).toEqual(['Brand - Acme', 'Toys']);
    expect(draft.core.price).toBe('9.99');
    const promoted = JSON.parse(listChangeSetItems(result.changeSetId)[0].draftJson) as Product;
    expect(promoted.core.media.primary).toBe('acme/rubber-chew.png');
});
});
