/**
 * Issue #354 — readiness + invalidation workflow seam.
 *
 * Proves through the owner-confirmed workflow seam (public interfaces only):
 * run → proposals → decisions → invalidation/refresh → readiness → draft.
 * Isolated persistence (fresh temp DB per test); deterministic adapters.
 *
 * Slice S1+S2 (RED first): Category correction and Type correction separately
 * invalidate accepted dependents; stale accepted dependents never replay into
 * the draft; independent (universal) results survive.
 */
import { Hono } from 'hono';
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun as createRepositoryRun, completeRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import { evaluateCanonicalReadiness } from '../../classification/classification-readiness';
import { getPendingRefreshCount } from '../../db/repositories/classification-refresh-repo';
import { writeProductFile } from '../../git/workspace-files';
import { listChangeSetItems, listChangeSets } from '../../db/repositories/change-set-repo';
import catalogClassificationRoutes from '../../server/routes/catalog-classification-routes';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { computeProductHash } from '../../classification/catalog-product-source';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { scanCatalogEvidence, renderCatalogEvidence, verifyCatalogEvidenceTreeIntegrity } from '../../classification/catalog-evidence';
import { updateFieldMetadata } from '../../server/services/field-metadata-service';
import {
  loadRuntimeConfigAuthority,
  createRuntimeActivationContext,
} from '../../classification/config-loader';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
const WS_ID = 'ws-readiness-seam';
const NOW = '2026-08-01T12:00:00.000Z';

function seedFixture(): BayStateSeed {
  return {
    ...BayStatePetGardenSeed,
    name: 'Readiness seam fixture',
    revision: 'readiness-seam-v2',
    createdAt: NOW,
    categories: [
      { id: 'dog-food', name: 'Dog Food', description: null },
      { id: 'cat-food', name: 'Cat Food', description: null },
    ],
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, categoryId: 'dog-food', websiteValues: { category: 'QA Category: dog-food', productType: 'QA Product Type: dry-dog-food' } },
      { id: 'dry-cat-food', name: 'Dry Cat Food', description: null, categoryId: 'cat-food', websiteValues: { category: 'QA Category: cat-food', productType: 'QA Product Type: dry-cat-food' } },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false, isCompositionAttribute: false, group: 'Food', isUniversal: false },
      { id: 'product-feature', name: 'Product Feature', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false, isCompositionAttribute: false, group: 'Features', isUniversal: true },
    ],
    profileTemplates: [
      { id: 'dry-dog-food-profile', name: 'Dog Profile', productTypeIds: ['dry-dog-food'], attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' }] },
      { id: 'dry-cat-food-profile', name: 'Cat Profile', productTypeIds: ['dry-cat-food'], attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' }] },
    ],
    mappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      { id: 'feature-map', attributeId: 'product-feature', catalogField: 'ProductField26', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
    ],
    classificationOutputBindings: [
      { role: 'category', catalogField: 'ProductField24', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type', catalogField: 'ProductField25', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'class-target', kind: 'product_type', label: 'Classification', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, sortOrder: 0 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 1 },
      { id: 'feature-target', kind: 'product_field', label: 'Product Feature', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'product-feature', catalogField: 'ProductField26', optionSource: 'configured', required: false, sortOrder: 2 },
    ],
  };
}

let workspacePath: string;
let activeAuthority: Extract<RuntimeConfigAuthority, { kind: 'v2' }>;
let activeSnapshotRef: { id: string; hash: string };

async function activateFixtureAuthority(): Promise<void> {
  writeProduct('SKU-SEED');
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField23', { label: 'Facet-Flavor' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField24', { label: 'Facet - Category' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField25', { label: 'Facet - Product Type' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField26', { label: 'Facet-Product Feature' });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: workspacePath,
    encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-b', 'main');
  git('config', '--local', 'user.name', 'Readiness Fixture');
  git('config', '--local', 'user.email', 'readiness@example.test');
  git('config', '--local', 'core.hooksPath', '/dev/null');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('add', 'products', 'store/field-registry.json');
  git('commit', '-m', 'Seed readiness catalog evidence');
  const sourceCatalogCommit = git('rev-parse', 'HEAD');
  const catalogEvidence = await scanCatalogEvidence(workspacePath, WS_ID);
  const artifact = renderCatalogEvidence(catalogEvidence);
  const catalogEvidenceHash = createHash('sha256').update(artifact).digest('hex');
  const candidate = generateCandidate(seedFixture(), catalogEvidence);
  const preview = previewCandidate(candidate.bundle, workspacePath, { catalogEvidence: artifact });
  if (!preview.hash) throw new Error(JSON.stringify(preview.report.findings));
  await activateBundle(preview.hash, null, {
    workspacePath,
    workspaceId: WS_ID,
    sourceCatalogCommit,
    catalogEvidenceHash,
    activationContext: {
      ...createRuntimeActivationContext(workspacePath, WS_ID),
      verifyCatalogEvidenceTree: hash => verifyCatalogEvidenceTreeIntegrity(workspacePath, hash, WS_ID),
    },
  });
  const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
  if (authority.kind !== 'v2') throw new Error('Readiness fixture did not activate V2 authority');
  activeAuthority = authority;
  activeSnapshotRef = upsertConfigSnapshot(WS_ID, authority.bundle, sourceCatalogCommit);
}

beforeEach(async () => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });
  await activateFixtureAuthority();
});

function seedRun(
  sku: string,
  pageImport?: { id: string; hash: string },
  flavorValue: unknown = 'Chicken',
  options: { websiteMapping?: boolean; measuredValue?: unknown; proposalPrefix?: string } = {},
) {
  const ref = activeSnapshotRef;
  const authority = options.websiteMapping === false
    ? {
      ...activeAuthority,
      bundle: {
        ...activeAuthority.bundle,
        productTypes: activeAuthority.bundle.productTypes.map(type => {
          const unmapped = { ...type };
          delete unmapped.websiteValues;
          return unmapped;
        }),
      },
    }
    : activeAuthority;
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: sku,
    authority,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: null,
    ...(pageImport ? { pageImportId: pageImport.id, pageImportHash: pageImport.hash } : {}),
  });
  persistRuntimeSnapshot(snapshot);
  const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
  const db = getDb();
  const now = new Date().toISOString();
  const proposalPrefix = options.proposalPrefix ?? 'prop';
  const insert = (id: string, type: string, target: string | null, value: unknown) => {
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, run.id, sku, type, target, JSON.stringify(value), 0.9, 'pending', now],
    );
  };
  insert(`${proposalPrefix}-pair`, 'product_classification', 'dry-dog-food', { categoryId: 'dog-food', productTypeId: 'dry-dog-food' });
  insert(`${proposalPrefix}-flavor`, 'field_assignment', 'flavor', flavorValue);
  insert(`${proposalPrefix}-note`, 'field_assignment', 'product-feature', options.measuredValue ?? 'Free text');
  completeRun(run.id, 'completed');
  return run;
}

function acceptSeededProposals(sku: string, runId: string, proposalPrefix = 'prop') {
  const result = submitProposalDecisions({
    workspaceId: WS_ID, productSku: sku, runId, sourceKind: 'catalog_product',
    decisions: [
      { proposalId: `${proposalPrefix}-pair`, decision: 'accepted' },
      { proposalId: `${proposalPrefix}-flavor`, decision: 'accepted' },
      { proposalId: `${proposalPrefix}-note`, decision: 'accepted' },
    ],
  });
  if (!result.ok) throw new Error(`Could not accept seeded proposals: ${JSON.stringify(result)}`);
  return result;
}

function seedPriorReviewedFieldFact(sku: string, attributeId: string, value: string): void {
  const run = createRepositoryRun(
    WS_ID,
    sku,
    activeSnapshotRef.id,
    activeSnapshotRef.hash,
    { sourceKind: 'catalog_product', sourceProductHash: null },
  );
  const proposalId = `prior-${sku}-${attributeId}`;
  const now = new Date().toISOString();
  getDb().run(
    `INSERT INTO classification_proposals
     (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
     VALUES (?, ?, ?, 'field_assignment', ?, ?, 0.9, 'accepted', ?)`,
    [proposalId, run.id, sku, attributeId, JSON.stringify(value), now],
  );
  getDb().run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, created_at, decision_origin)
     VALUES (?, ?, 'accepted', ?, 'human_review')`,
    [`decision-${proposalId}`, proposalId, now],
  );
  completeRun(run.id, 'completed');
}

function replaceActiveFixtureBundle(bundle: typeof activeAuthority.bundle): void {
  activeAuthority = { ...activeAuthority, bundle };
  activeSnapshotRef = upsertConfigSnapshot(WS_ID, bundle, null);
}


function writeProduct(sku: string, fields: Record<string, string> = {}) {
  const product: any = {
    schemaVersion: 1, id: 'p-seam', sku, status: 'active',
    core: {
      name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: null, additional: [] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: [],
    },
    customFields: { ProductField23: 'Beef', ...fields },
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: NOW, updatedAt: NOW, archivedAt: null },
  };
  writeProductFile(workspacePath, product);
  return product;
}

describe('issue #354 workflow seam: dependent invalidation', () => {
  it('Type correction stales the accepted dependent; stale never replays; universal survives', async () => {
    const sku = 'SKU-TYPE-CHANGE';
    const run = seedRun(sku);

    // Accept everything first.
    const acceptAll = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(acceptAll.ok).toBe(true);
    if (!acceptAll.ok) throw new Error('setup failed');
    const pairDecisionId = acceptAll.decisions.find(d => d.proposalId === 'prop-pair')!.id;

    // Correct the TYPE member only (dog -> cat, category follows the mapping).
    const changeType = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-pair', decision: 'accepted', revisedTargetId: 'dry-cat-food', expectedRevisionId: pairDecisionId }],
    });
    expect(changeType.ok).toBe(true);

    // The pair-gated dependent is stale; the independent universal feature remains accepted.
    const rows = getProposalsByRun(run.id);
    expect(rows.find(p => p.id === 'prop-flavor')!.status).toBe('stale');
    expect(rows.find(p => p.id === 'prop-note')!.status).toBe('accepted');

    // A dependent refresh is queued for new review (pending, never auto-accepted).
    expect(getPendingRefreshCount(WS_ID)).toBe(1);
    // Apply: stale flavor never replays; note applies; draft has no partial write.
    const product = writeProduct(sku);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).not.toContain('ProductField23');
    expect(result.appliedFields).toContain('ProductField26');
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField24).toBe('QA Category: cat-food');
    expect(draft.customFields.ProductField25).toBe('QA Product Type: dry-cat-food');
    expect(draft.customFields.ProductField24).not.toBe('QA Category: dog-food');
    expect(draft.customFields.ProductField25).not.toBe('QA Product Type: dry-dog-food');
    expect(draft.customFields.ProductField23).toBe('Beef');
    expect(draft.customFields.ProductField26).toBe('Free text');
  });

  it('Category-member correction stales the accepted dependent (pair moves to the other approved combination)', async () => {
    const sku = 'SKU-CAT-CHANGE';
    const run = seedRun(sku);

    const acceptAll = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
      ],
    });
    expect(acceptAll.ok).toBe(true);
    if (!acceptAll.ok) throw new Error('setup failed');
    const pairDecisionId = acceptAll.decisions.find(d => d.proposalId === 'prop-pair')!.id;

    // Correct the CATEGORY member (dog-food -> cat-food) to the other approved
    // combination. A same-type cross-category value would be an unapproved
    // invention (correctly refused) — under the approved mapping the type
    // determines its category, so the category intent travels with its pair.
    const changeCat = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-pair', decision: 'accepted', revisedValue: { categoryId: 'cat-food', productTypeId: 'dry-cat-food' }, expectedRevisionId: pairDecisionId }],
    });
    expect(changeCat.ok).toBe(true);

    const rows = getProposalsByRun(run.id);
    expect(rows.find(p => p.id === 'prop-flavor')!.status).toBe('stale');
  });
});

describe('issue #354 workflow seam: canonical readiness', () => {
  it('catalog apply route refuses a required attribute gap before creating a local draft', async () => {
    const sku = 'SKU-REQUIRED-GAP-APPLY';
    const product = writeProduct(sku);
    const run = seedRun(sku);
    getDb().run(
      'UPDATE classification_runs SET source_product_hash = ? WHERE id = ?',
      [computeProductHash(product), run.id],
    );
    const decisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decisions.ok).toBe(true);

    const app = new Hono();
    app.route('/api', catalogClassificationRoutes);
    const before = listChangeSets(WS_ID);
    const response = await app.request(`/api/products/${sku}/classification/runs/${run.id}/apply`, {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'required_values_missing' });
    expect(listChangeSets(WS_ID)).toEqual(before);
  });

  it('rejected required value blocks draft creation (required gap keeps Review)', async () => {
    const sku = 'SKU-REQUIRED-GAP';
    const run = seedRun(sku);

    // Pair accepted; the profile-required flavor proposal is REJECTED
    // (reviewed, so decision-completeness passes) — but the required value
    // is unresolved. Draft creation must refuse.
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
    }
    const review = validateCatalogReviewCompletionGate({
      workspaceId: WS_ID, productSku: sku, runId: run.id,
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('required_values_missing');
  });
  it('blocks completed Review when the accepted pair has no approved ShopSite mapping', async () => {
    const sku = 'SKU-CORE-MAPPING-GAP';
    const run = seedRun(sku, undefined, 'Chicken', { websiteMapping: false });
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('core_mapping_unresolved');
    const review = validateCatalogReviewCompletionGate({
      workspaceId: WS_ID, productSku: sku, runId: run.id,
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('core_mapping_unresolved');
  });
  it('keeps Review open when a current canonical output binding is missing', () => {
    const sku = 'SKU-CORE-OUTPUT-BINDING-GAP';
    const run = seedRun(sku);
    const decide = submitProposalDecisions({
      workspaceId: WS_ID,
      productSku: sku,
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    getDb().run(
      'DELETE FROM classification_output_bindings WHERE workspace_id = ? AND role = ?',
      [WS_ID, 'category'],
    );

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('core_mapping_unresolved');
    const review = validateCatalogReviewCompletionGate({
      workspaceId: WS_ID,
      productSku: sku,
      runId: run.id,
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('core_mapping_unresolved');
  });
  it('keeps Review open when multiple accepted canonical pairs disagree', async () => {
    const sku = 'SKU-DUPLICATE-CORE-PAIR';
    const run = seedRun(sku);
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'product_classification', ?, ?, 0.9, 'pending', ?)`,
      ['prop-pair-second', run.id, sku, 'dry-cat-food', JSON.stringify({ categoryId: 'cat-food', productTypeId: 'dry-cat-food' }), NOW],
    );
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-pair-second', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('pair_unresolved');
    const review = validateCatalogReviewCompletionGate({
      workspaceId: WS_ID, productSku: sku, runId: run.id,
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('pair_unresolved');
  });



  it('unresolved pair blocks with pair_unresolved (no accepted pair, no reviewed fact)', async () => {
    const sku = 'SKU-PAIR-GAP';
    const run = seedRun(sku);

    // Dependents decided, pair never accepted: the canonical classification
    // itself is unresolved. Details name the missing members.
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('pair_unresolved');
      expect(readiness.details.categoryId).toBeNull();
      expect(readiness.details.productTypeId).toBeNull();
    }
  });

  it('does not treat a previously accepted stale pair as current readiness authority', () => {
    const sku = 'SKU-STALE-PAIR';
    const run = seedRun(sku);
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decide.ok).toBe(true);

    getDb().run(
      'UPDATE classification_proposals SET is_stale = 1, stale_at = ? WHERE id = ? AND run_id = ?',
      [new Date().toISOString(), 'prop-pair', run.id],
    );

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('pair_unresolved');
    const review = validateCatalogReviewCompletionGate({
      workspaceId: WS_ID, productSku: sku, runId: run.id,
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('pair_unresolved');
  });

  it('optional missing value does not block (supported optional stays optional)', async () => {
    const sku = 'SKU-OPTIONAL-OK';
    const run = seedRun(sku);

    // Flavor (required) accepted; note (universal/optional) rejected.
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('valued');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'product-feature')?.status).toBe('optional_unvalued');
    }
  });
  it('blocks unknown optional applicability but keeps known optional states nonblocking', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogProfile = bundle.attributeProfiles.find(profile => profile.id === 'dry-dog-food-profile')!;
    const flavorRule = dogProfile.attributes.find(attribute => attribute.attributeId === 'flavor')!;
    flavorRule.required = false;
    flavorRule.applicabilityConditions = [{
      operator: 'equals',
      attributeId: 'product-feature',
      value: 'Dog-only',
      factSource: 'accepted_reviewed',
    }];
    replaceActiveFixtureBundle(bundle);

    const unknownSku = 'SKU-OPTIONAL-UNKNOWN';
    const unknownRun = seedRun(unknownSku, undefined, 'Chicken', { proposalPrefix: 'optional-unknown' });
    const unknownDecision = submitProposalDecisions({
      workspaceId: WS_ID, productSku: unknownSku, runId: unknownRun.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'optional-unknown-pair', decision: 'accepted' },
        { proposalId: 'optional-unknown-flavor', decision: 'rejected' },
        { proposalId: 'optional-unknown-note', decision: 'rejected' },
      ],
    });
    expect(unknownDecision.ok).toBe(true);
    const unknownReadiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: unknownRun.id });
    expect(unknownReadiness.ok).toBe(false);
    if (!unknownReadiness.ok) {
      expect(unknownReadiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('optional_unknown');
      expect(unknownReadiness.reason).toContain('flavor');
      expect(unknownReadiness.reason).toContain('applicability');
    }

    const applicableSku = 'SKU-OPTIONAL-UNVALUED';
    const applicableRun = seedRun(applicableSku, undefined, 'Chicken', { proposalPrefix: 'optional-applicable' });
    const applicableDecision = submitProposalDecisions({
      workspaceId: WS_ID, productSku: applicableSku, runId: applicableRun.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'optional-applicable-pair', decision: 'accepted' },
        { proposalId: 'optional-applicable-flavor', decision: 'rejected' },
        { proposalId: 'optional-applicable-note', decision: 'accepted', revisedValue: 'Dog-only' },
      ],
    });
    expect(applicableDecision.ok).toBe(true);
    const applicableReadiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: applicableRun.id });
    expect(applicableReadiness.ok).toBe(true);
    if (applicableReadiness.ok) {
      expect(applicableReadiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('optional_unvalued');
    }

    const inapplicableSku = 'SKU-OPTIONAL-NOT-APPLICABLE';
    const inapplicableRun = seedRun(inapplicableSku, undefined, 'Chicken', { proposalPrefix: 'optional-inapplicable' });
    const inapplicableDecision = submitProposalDecisions({
      workspaceId: WS_ID, productSku: inapplicableSku, runId: inapplicableRun.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'optional-inapplicable-pair', decision: 'accepted' },
        { proposalId: 'optional-inapplicable-flavor', decision: 'rejected' },
        { proposalId: 'optional-inapplicable-note', decision: 'accepted', revisedValue: 'Cat-only' },
      ],
    });
    expect(inapplicableDecision.ok).toBe(true);
    const inapplicableReadiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: inapplicableRun.id });
    expect(inapplicableReadiness.ok).toBe(true);
    if (inapplicableReadiness.ok) {
      expect(inapplicableReadiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('not_applicable');
    }
  });


  it('uses current accepted discriminator values when evaluating frozen required-field applicability', () => {
    const sku = 'SKU-CURRENT-APPLICABILITY-FACT';
    const bundle = structuredClone(activeAuthority.bundle);
    const dogProfile = bundle.attributeProfiles.find(profile => profile.id === 'dry-dog-food-profile')!;
    const flavorRule = dogProfile.attributes.find(attribute => attribute.attributeId === 'flavor')!;
    flavorRule.applicabilityConditions = [{
      operator: 'equals',
      attributeId: 'product-feature',
      value: 'Dog-only',
      factSource: 'accepted_reviewed',
    }];
    replaceActiveFixtureBundle(bundle);
    seedPriorReviewedFieldFact(sku, 'product-feature', 'Cat-only');
    const run = seedRun(sku);
    const decision = submitProposalDecisions({
      workspaceId: WS_ID,
      productSku: sku,
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'accepted', revisedValue: 'Dog-only' },
      ],
    });
    expect(decision.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'product-feature')?.status).toBe('valued');
    }
  });
  it('keeps required applicability unknown when the accepted discriminator is cleared', () => {
    const sku = 'SKU-CLEARED-APPLICABILITY-FACT';
    const bundle = structuredClone(activeAuthority.bundle);
    const dogProfile = bundle.attributeProfiles.find(profile => profile.id === 'dry-dog-food-profile')!;
    const flavorRule = dogProfile.attributes.find(attribute => attribute.attributeId === 'flavor')!;
    flavorRule.applicabilityConditions = [{
      operator: 'equals',
      attributeId: 'product-feature',
      value: 'Dog-only',
      factSource: 'accepted_reviewed',
    }];
    replaceActiveFixtureBundle(bundle);
    seedPriorReviewedFieldFact(sku, 'product-feature', 'Cat-only');
    const run = seedRun(sku);
    const decision = submitProposalDecisions({
      workspaceId: WS_ID,
      productSku: sku,
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'accepted', revisedValue: null },
      ],
    });
    expect(decision.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('required_unknown');
    }
  });



  it('keeps required applicability unknown when the accepted discriminator is blank', () => {
    const sku = 'SKU-BLANK-APPLICABILITY-FACT';
    const bundle = structuredClone(activeAuthority.bundle);
    const dogProfile = bundle.attributeProfiles.find(profile => profile.id === 'dry-dog-food-profile')!;
    const flavorRule = dogProfile.attributes.find(attribute => attribute.attributeId === 'flavor')!;
    flavorRule.applicabilityConditions = [{
      operator: 'equals',
      attributeId: 'product-feature',
      value: 'Dog-only',
      factSource: 'accepted_reviewed',
    }];
    replaceActiveFixtureBundle(bundle);
    seedPriorReviewedFieldFact(sku, 'product-feature', 'Cat-only');
    const run = seedRun(sku);
    const decision = submitProposalDecisions({
      workspaceId: WS_ID,
      productSku: sku,
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'accepted', revisedValue: '   ' },
      ],
    });
    expect(decision.ok).toBe(true);
    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('required_unknown');
    }
  });

  it('does not report Review readiness when the completed run has no resolvable frozen snapshot', () => {
    const sku = 'SKU-MISSING-FROZEN-SNAPSHOT';
    const run = seedRun(sku);
    const decisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
      ],
    });
    expect(decisions.ok).toBe(true);
    getDb().run("UPDATE classification_runs SET config_snapshot_hash = 'missing-snapshot' WHERE id = ?", [run.id]);
    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('profile_unresolved');
    const review = validateCatalogReviewCompletionGate({ workspaceId: WS_ID, productSku: sku, runId: run.id });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.code).toBe('profile_unresolved');
  });

  it('does not satisfy a required single-valued profile attribute with a one-item array', () => {
    const sku = 'SKU-SINGLE-VALUE-ARRAY';
    const run = seedRun(sku, undefined, ['Chicken']);
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'product-feature')?.status).toBe('optional_unvalued');
    }
  });

  it('does not satisfy a required controlled value with whitespace-only text', () => {
    const sku = 'SKU-WHITESPACE-VALUE';
    const run = seedRun(sku, undefined, '   ');
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
    }
  });

  it('does not satisfy a required controlled value outside its captured allowed values', () => {
    const sku = 'SKU-INVALID-CONTROLLED-VALUE';
    const run = seedRun(sku, undefined, 'Duck');
    const decide = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decide.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
    }
  });
  it('does not let accepted required values survive empty or retargeted proposal data', () => {
    const sku = 'SKU-REVALIDATED-ACCEPTED-VALUE';
    const run = seedRun(sku);
    acceptSeededProposals(sku, run.id);

    for (const invalidValue of ['', []]) {
      getDb().run(
        'UPDATE classification_proposals SET proposed_value_json = ? WHERE id = ? AND run_id = ?',
        [JSON.stringify(invalidValue), 'prop-flavor', run.id],
      );
      const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
      expect(readiness.ok).toBe(false);
      if (!readiness.ok) {
        expect(readiness.code).toBe('required_values_missing');
        expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
      }
    }

    getDb().run(
      `UPDATE classification_proposals
       SET target_id = 'product-feature', proposed_value_json = ?
       WHERE id = ? AND run_id = ?`,
      [JSON.stringify('Chicken'), 'prop-flavor', run.id],
    );
    const wrongTargetReadiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(wrongTargetReadiness.ok).toBe(false);
    if (!wrongTargetReadiness.ok) {
      expect(wrongTargetReadiness.code).toBe('required_values_missing');
      expect(wrongTargetReadiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
    }
  });

  it('does not let a stale accepted attribute decision satisfy a required profile entry', () => {
    const sku = 'SKU-STALE-ATTRIBUTE-DECISION';
    const run = seedRun(sku);
    acceptSeededProposals(sku, run.id);
    getDb().run(
      `UPDATE classification_proposals
       SET status = 'stale', is_stale = 1, stale_at = ?
       WHERE id = ? AND run_id = ?`,
      [new Date().toISOString(), 'prop-flavor', run.id],
    );

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('missing');
    }
  });

  it('revalidates accepted measured values against the frozen canonical unit', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const measuredAttribute = bundle.attributes.find(attribute => attribute.id === 'product-feature');
    const measuredMapping = bundle.attributeMappings.find(mapping => mapping.attributeId === 'product-feature');
    const measuredTarget = bundle.curationTargets.find(target => target.id === 'feature-target');
    if (!measuredAttribute || !measuredMapping || !measuredTarget) {
      throw new Error('Measured readiness fixture is incomplete.');
    }
    measuredAttribute.valueMode = 'measured';
    measuredAttribute.canonicalUnit = 'lb';
    measuredAttribute.allowedValues = [];
    measuredAttribute.valueAliases = [];
    measuredMapping.serialization = {
      kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '', suffix: '',
    };
    measuredTarget.required = true;
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-MEASURED-UNIT-DRIFT';
    const run = seedRun(sku, undefined, 'Chicken', { measuredValue: '15 lb' });
    acceptSeededProposals(sku, run.id);
    getDb().run(
      'UPDATE classification_proposals SET proposed_value_json = ? WHERE id = ? AND run_id = ?',
      [JSON.stringify('15 kg'), 'prop-note', run.id],
    );

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'product-feature')?.status).toBe('missing');
    }
  });

  it('treats an explicitly empty Attribute Profile as a valid configured outcome', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogType = bundle.productTypes.find(type => type.id === 'dry-dog-food');
    if (!dogType) throw new Error('Readiness fixture is missing its dog-food Product Type.');
    dogType.attributeProfileId = null;
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-EMPTY-ATTRIBUTE-PROFILE';
    const run = seedRun(sku);
    const decisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decisions.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('not_applicable');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'product-feature')?.status).toBe('optional_unvalued');
    }
  });

  it('keeps a missing declared Attribute Profile distinct from an explicitly empty profile', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogType = bundle.productTypes.find(type => type.id === 'dry-dog-food');
    if (!dogType) throw new Error('Readiness fixture is missing its dog-food Product Type.');
    dogType.attributeProfileId = 'missing-readiness-profile';
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-MISSING-ATTRIBUTE-PROFILE';
    const run = seedRun(sku);
    const pairDecision = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-pair', decision: 'accepted' }],
    });
    expect(pairDecision.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.code).toBe('profile_unresolved');
  });

  it('reports a configured profile omission as confirmed non-applicability', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogType = bundle.productTypes.find(type => type.id === 'dry-dog-food');
    const profile = bundle.attributeProfiles.find(candidate => candidate.id === dogType?.attributeProfileId);
    if (!dogType || !profile) throw new Error('Readiness fixture is missing its dog-food Attribute Profile.');
    profile.attributes = profile.attributes.filter(rule => rule.attributeId !== 'flavor');
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-PROFILE-OMITS-FLAVOR';
    const run = seedRun(sku);
    const decisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decisions.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('not_applicable');
    }
  });
  it('keeps required attributes unresolved when their output binding is stale or protected', () => {
    for (const binding of ['stale', 'pricing'] as const) {
      const bundle = structuredClone(activeAuthority.bundle);
      const flavorMapping = bundle.attributeMappings.find(mapping => mapping.attributeId === 'flavor');
      const flavorTarget = bundle.curationTargets.find(target => target.id === 'flavor-target');
      if (!flavorMapping || !flavorTarget) throw new Error('Readiness fixture is missing the Flavor output binding.');
      if (binding === 'stale') {
        flavorMapping.isStale = true;
      } else {
        flavorMapping.catalogField = 'ProductField6';
        flavorTarget.catalogField = 'ProductField6';
      }
      replaceActiveFixtureBundle(bundle);

      const sku = `SKU-REQUIRED-${binding.toUpperCase()}-BINDING`;
      const proposalPrefix = `prop-${binding}`;
      const run = seedRun(sku, undefined, 'Chicken', { proposalPrefix });
      const decisions = submitProposalDecisions({
        workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
        decisions: [
          { proposalId: `${proposalPrefix}-pair`, decision: 'accepted' },
          { proposalId: `${proposalPrefix}-flavor`, decision: 'rejected' },
          { proposalId: `${proposalPrefix}-note`, decision: 'rejected' },
        ],
      });
      expect(decisions.ok).toBe(true);

      const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
      expect(readiness.ok).toBe(false);
      if (!readiness.ok) {
        expect(readiness.code).toBe('required_values_missing');
        expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('required_unknown');
      }
    }
  });


  it('reports unknown applicability separately from an applicable required gap', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogType = bundle.productTypes.find(type => type.id === 'dry-dog-food');
    const profile = bundle.attributeProfiles.find(candidate => candidate.id === dogType?.attributeProfileId);
    const flavorRule = profile?.attributes.find(rule => rule.attributeId === 'flavor');
    if (!dogType || !profile || !flavorRule) throw new Error('Readiness fixture is missing its required Flavor rule.');
    flavorRule.applicabilityConditions = [
      { operator: 'equals', attributeId: 'product-feature', value: 'Observed condition', factSource: 'accepted_reviewed' },
    ];
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-UNKNOWN-ATTRIBUTE-APPLICABILITY';
    const run = seedRun(sku);
    const decisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'rejected' },
        { proposalId: 'prop-note', decision: 'rejected' },
      ],
    });
    expect(decisions.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: run.id });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.code).toBe('required_values_missing');
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('required_unknown');
    }
  });

  it('uses compatible reviewed facts to confirm configured non-applicability', () => {
    const bundle = structuredClone(activeAuthority.bundle);
    const dogType = bundle.productTypes.find(type => type.id === 'dry-dog-food');
    const profile = bundle.attributeProfiles.find(candidate => candidate.id === dogType?.attributeProfileId);
    const flavorRule = profile?.attributes.find(rule => rule.attributeId === 'flavor');
    if (!dogType || !profile || !flavorRule) throw new Error('Readiness fixture is missing its required Flavor rule.');
    flavorRule.applicabilityConditions = [
      { operator: 'equals', attributeId: 'product-feature', value: 'Observed condition', factSource: 'accepted_reviewed' },
    ];
    replaceActiveFixtureBundle(bundle);

    const sku = 'SKU-REVIEWED-CONDITION-FACT';
    const priorRun = seedRun(sku, undefined, 'Chicken', { proposalPrefix: 'prior' });
    const priorDecisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: priorRun.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prior-pair', decision: 'accepted' },
        { proposalId: 'prior-flavor', decision: 'rejected' },
        { proposalId: 'prior-note', decision: 'accepted' },
      ],
    });
    expect(priorDecisions.ok).toBe(true);

    const currentRun = seedRun(sku, undefined, 'Chicken', { proposalPrefix: 'current' });
    const currentDecisions = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: currentRun.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'current-pair', decision: 'accepted' },
        { proposalId: 'current-flavor', decision: 'rejected' },
        { proposalId: 'current-note', decision: 'rejected' },
      ],
    });
    expect(currentDecisions.ok).toBe(true);

    const readiness = evaluateCanonicalReadiness({ workspaceId: WS_ID, runId: currentRun.id });
    expect(readiness.ok).toBe(true);
    if (readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'flavor')?.status).toBe('not_applicable');
    }
  });

});

describe('issue #354 workflow seam: stale page authority refuses without partial write', () => {
  it('rotated page import fails page-carrying apply attributably; no changeset created', async () => {
    const { activatePageImportFromRecords } = await import('../../shopsite/page-import-service');
    const { getActivePageImport } = await import('../../db/repositories/page-import-repo');
    const { getActivePageImportHash, listVerifiedPageOptions } = await import('../../db/repositories/page-repo');
    const { listChangeSets } = await import('../../db/repositories/change-set-repo');
    activatePageImportFromRecords({
      workspaceId: WS_ID, sourceHash: 'b'.repeat(64), parserFormatVersion: 'pages-xml-1',
      records: [{ identity: { kind: 'exported_guid', key: 'page-dog-food', status: 'verified' }, name: 'Dog Food', parentRef: null, availability: 'available' }],
      activatedBy: 'test',
    });
    const active = getActivePageImport(WS_ID)!;
    const sku = 'SKU-PAGE-STALE';
    // The snapshot freezes the CURRENT import authority.
    const run = seedRun(sku, { id: active.id, hash: active.sourceHash });
    // Page proposals must carry the ACTIVE import's row IDs (randomUUIDs).
    const pageId = listVerifiedPageOptions(WS_ID).find(p => p.name === 'Dog Food')!.id;
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-page', run.id, sku, 'category_page', pageId, JSON.stringify({ pageId, pageName: 'Dog Food', identityVerified: true }), 0.9, 'pending', now],
    );
    const accept = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-flavor', decision: 'accepted' },
        { proposalId: 'prop-note', decision: 'accepted' },
        { proposalId: 'prop-page', decision: 'accepted' },
      ],
    });
    expect(accept.ok).toBe(true);

    // Rotate the import AFTER review: the frozen authority is stale.
    activatePageImportFromRecords({
      workspaceId: WS_ID, sourceHash: 'c'.repeat(64), parserFormatVersion: 'pages-xml-1',
      records: [{ identity: { kind: 'exported_guid', key: 'page-dog-food', status: 'verified' }, name: 'Dog Food', parentRef: null, availability: 'available' }],
      activatedBy: 'test',
    });
    expect(getActivePageImportHash(WS_ID)).not.toBe(active.sourceHash);

    const setsBefore = listChangeSets(WS_ID).length;
    const product = writeProduct(sku);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    await expect(applyCatalogClassification(workspacePath, WS_ID, sku, run.id)).rejects.toThrow(/page_decision_stale/);
    expect(listChangeSets(WS_ID).length).toBe(setsBefore);
  });
});
