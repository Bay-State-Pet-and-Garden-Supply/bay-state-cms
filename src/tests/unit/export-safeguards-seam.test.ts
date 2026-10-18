/**
 * Reviewed classification → local draft → offline export package → XML parity.
 * Real curator and reviewer composition, immutable SKU-local authority, isolated
 * persistence, and certified Flavor/PF23 and Material/PF28 destinations.
 * No live ShopSite/model transport or internal-module mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { getCachedAttributeMappings, getCachedClassificationOutputBindings, upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { createRun, completeRun, getProposalsByRun, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { listChangeSetItems, listChangeSets } from '../../db/repositories/change-set-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { buildAssignmentProjection, createAssignmentProjectionAuthority } from '../../classification/assignment-projection';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { computeProductHash } from '../../classification/catalog-product-source';
import { setTaxonomyFreezeForTests, isTaxonomyFrozen } from '../../classification/taxonomy-freeze';
import { writeProductFile, readProductFile } from '../../git/workspace-files';
import { generateCandidate } from '../../classification/config-generator';
import type { BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { previewCandidate, activateBundle } from '../../classification/config-store';
import { scanCatalogEvidence, renderCatalogEvidence, verifyCatalogEvidenceTreeIntegrity } from '../../classification/catalog-evidence';
import { updateFieldMetadata } from '../../server/services/field-metadata-service';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../classification/page-snapshot';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
import { createExportPackage } from '../../shopsite/export-package';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { Product } from '../../shared/types';

const NOW = '2026-08-01T12:00:00.000Z';
const WS_ID = 'ws-export-safeguards-seam';
let workspacePath: string;
let cachedAuthority: RuntimeConfigAuthority | null = null;

function product(): Product {
  return {
    schemaVersion: 1, id: 'p-export', sku: 'SKU-EXPORT', status: 'active',
    core: {
      name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Chicken dinner in Rubber packaging.',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: null, additional: [] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Dog Food', 'Brand - Acme'],
    },
    customFields: { ProductField23: 'Beef', ProductField28: 'Nylon', ProductField16: 'Acme', ProductField6: '12.50', ProductField99: 'opaque custom value' },
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null,
      lastSyncedAt: null, lastRemoteHash: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: { ProductType: 'Download', CustomMystery: 'keep-me' }, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: NOW, updatedAt: NOW, archivedAt: null },
  };
}

function seedFixture(): BayStateSeed {
  return {
    ...BayStatePetGardenSeed,
    name: 'Export seam fixture',
    revision: 'export-seam-v2',
    createdAt: NOW,
    categories: [{ id: 'dog-food', name: 'Dog Food', description: null }],
    productTypes: [
      { id: 'dog-food-dry', name: 'Dry Dog Food', description: null, categoryId: 'dog-food', websiteValues: { category: 'QA Category: dog-food', productType: 'QA Product Type: dog-food-dry' } },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false, isCompositionAttribute: false, group: 'Food', isUniversal: false },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false, isCompositionAttribute: false, group: 'Material', isUniversal: false },
    ],
    profileTemplates: [
      { id: 'flavor-material-profile', name: 'Flavor Material', productTypeIds: ['dog-food-dry'], attributes: [
        { attributeId: 'flavor', required: false, cardinality: 'single' },
        { attributeId: 'material', required: false, cardinality: 'single' },
      ] },
    ],
    mappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
      { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { kind: 'scalar', prefix: '', suffix: '' } },
    ],
    classificationOutputBindings: [
      { role: 'category', catalogField: 'ProductField24', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type', catalogField: 'ProductField25', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'class-target', kind: 'product_type', label: 'Primary Product Type', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: true, sortOrder: 0 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 1 },
      { id: 'material-target', kind: 'product_field', label: 'Material', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField28', optionSource: 'configured', required: false, sortOrder: 2 },
    ],
  };
}

interface CapturedRun { source: Product; snapshot: RuntimeClassificationSnapshot; run: { id: string } }

async function activateFixtureAuthority(): Promise<void> {
  const source = product();
  writeProductFile(workspacePath, source);
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField23', { label: 'Facet-Flavor' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField24', { label: 'Facet - Category' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField25', { label: 'Facet - Product Type' });
  updateFieldMetadata({ id: WS_ID, workspacePath }, 'ProductField28', { label: 'Facet-Material' });
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: workspacePath, encoding: 'utf-8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-b', 'main');
  git('config', '--local', 'user.name', 'Export Fixture');
  git('config', '--local', 'user.email', 'export@example.test');
  git('config', '--local', 'core.hooksPath', '/dev/null');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('add', 'products', 'store/field-registry.json');
  git('commit', '-m', 'Seed export catalog evidence');
  const sourceCatalogCommit = git('rev-parse', 'HEAD');
  const catalogEvidence = await scanCatalogEvidence(workspacePath, WS_ID);
  const artifact = renderCatalogEvidence(catalogEvidence);
  const catalogEvidenceHash = createHash('sha256').update(artifact).digest('hex');
  const candidate = generateCandidate(seedFixture(), catalogEvidence);
  const preview = previewCandidate(candidate.bundle, workspacePath, { catalogEvidence: artifact });
  if (!preview.hash) throw new Error(JSON.stringify(preview.report.findings));
  setTaxonomyFreezeForTests(false);
  try {
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
  } finally {
    setTaxonomyFreezeForTests(true);
  }
  const authority = loadRuntimeConfigAuthority(workspacePath, createRuntimeActivationContext(workspacePath, WS_ID));
  if (authority.kind !== 'v2') throw new Error('Export fixture did not activate V2 authority');
  cachedAuthority = authority;
}

beforeEach(async () => {
  cachedAuthority = null;
  setTaxonomyFreezeForTests(true);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'export-safeguards-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'export seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });
  expect(isTaxonomyFrozen()).toBe(true);
  await activateFixtureAuthority();
  expect(isTaxonomyFrozen()).toBe(true);
});

afterEach(() => {
  cachedAuthority = null;
  closeDb();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

function captureRun(): CapturedRun {
  if (!cachedAuthority || cachedAuthority.kind !== 'v2') throw new Error('Export fixture authority is not activated');
  const authority = cachedAuthority;
  const source = product();
  writeProductFile(workspacePath, source);
  const configRef = upsertConfigSnapshot(WS_ID, authority.bundle, null);
  const pages = captureVerifiedPageSnapshot(WS_ID);
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: source.sku,
    authority,
    configSnapshotRef: { id: configRef.id, hash: configRef.hash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: computeProductHash(source),
    pages: toPageSnapshotState(pages),
    pageImportId: pages.pageImportId,
    pageImportHash: pages.pageImportHash,
    productPageNames: source.core.productOnPages ?? [],
  });
  const persisted = persistRuntimeSnapshot(snapshot);
  const run = createRun(WS_ID, source.sku, persisted.id, persisted.hash, {
    sourceKind: 'catalog_product', sourceProductHash: snapshot.sourceProductHash,
  });
  return { source, snapshot, run };
}

async function curateFields(captured: CapturedRun) {
  const { source, snapshot, run } = captured;
  getDb().run(`INSERT INTO classification_proposals
    (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
    VALUES (?, ?, ?, 'product_classification', ?, ?, 1.0, 'pending', ?)`,
  [`${run.id}-pair`, run.id, source.sku, 'dog-food-dry', JSON.stringify({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' }), NOW]);
  const proposals: ClassificationProposal[] = [];
  for (const attributeId of ['flavor', 'material']) {
    const target = snapshot.curationTargets.find(target => target.attributeId === attributeId)!;
    const value = attributeId === 'flavor' ? 'Chicken dinner' : 'Rubber';
    const output = await processProductFieldTarget(
      { config: target, options: snapshot.fieldOptions[target.id] },
      { sku: source.sku, acceptedProposals: [], allProposals: [], evidence: [{
        id: `supplied-${attributeId}`, runId: run.id, stageName: 'evidence_extraction', productSku: source.sku,
        attributeId, source: 'official_product_page', reliability: 'medium', sourceUrl: null,
        sourceField: target.catalogField, snippet: value, value, metadata: {}, capturedAt: NOW,
      }] },
      { workspaceId: WS_ID, workspacePath, runId: run.id, configSnapshotRef: snapshot.configSnapshotRef, snapshot },
    );
    proposals.push(...output.proposals);
  }
  expect(proposals.map(proposal => [proposal.targetId, proposal.proposedValue])).toEqual([
    ['flavor', 'Chicken'], ['material', 'Rubber'],
  ]);
  for (const proposal of proposals) {
    getDb().run(`INSERT INTO classification_proposals
      (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [proposal.id, run.id, source.sku, proposal.proposalType, proposal.targetId, JSON.stringify(proposal.proposedValue), proposal.confidence, NOW]);
  }
  completeRun(run.id, 'completed');
  return getProposalsByRun(run.id);
}

function approvedPreview(captured: CapturedRun) {
  const { source, snapshot, run } = captured;
  const accepted = getAcceptedProposals(source.sku, run.id);
  return buildAssignmentProjection(
    accepted, source.customFields, source.core.productOnPages ?? [],
    getCachedAttributeMappings(WS_ID), new Set(),
    createAssignmentProjectionAuthority(snapshot, undefined, getCachedClassificationOutputBindings(WS_ID)),
    { reviewedProposals: accepted, currentRunProposals: getProposalsByRun(run.id) },
  );
}

async function exportReviewedDraft(captured: CapturedRun) {
  const applied = await applyCatalogClassification(workspacePath, WS_ID, captured.source.sku, captured.run.id);
  const items = listChangeSetItems(applied.changeSetId);
  expect(items.map(item => item.sku)).toEqual([captured.source.sku]);
  const draft = JSON.parse(items[0].draftJson) as Product;
  expect(draft.core).toEqual(captured.source.core);
  expect(draft.shopsite).toEqual(captured.source.shopsite);
  expect(readProductFile(workspacePath, captured.source.sku)).toEqual(captured.source);
  const pkg = await createExportPackage(workspacePath, applied.changeSetId, [draft], { changeSetTitle: 'Reviewed classification export' });
  const xml = fs.readFileSync(pkg.xmlPath, 'utf-8');
  const decoded = ShopSiteProductCodec.decodeOne(xml)!.product;
  expect(decoded.customFields.ProductField16).toBe('Acme');
  expect(decoded.customFields.ProductField6).toBe('12.50');
  expect(decoded.customFields.ProductField99).toBe('opaque custom value');
  expect(decoded.shopsite.preserved.unknownElements.CustomMystery).toBe('keep-me');
  // This is a supplied native fulfillment value, not a codec-default assertion.
  expect(xml).toContain('<ProductType>Download</ProductType>');
  expect(decoded.sku).toBe(captured.source.sku);
  expect(decoded.core.name).toBe('Acme Chicken Dinner');
  expect(decoded.core.price).toBe('9.99');
  return { draft, decoded, xml };
}

describe('reviewed classification export safeguards', () => {
  it('exports an accepted explicit clear while pending material and protected/native/unknown data remain unchanged', async () => {
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const pair = proposals.find(proposal => proposal.proposalType === 'product_classification')!;
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: pair.id, decision: 'accepted' },
        { proposalId: flavor.id, decision: 'accepted', revisedValue: null },
      ],
    });
    expect(reviewed.ok).toBe(true);
    const preview = approvedPreview(captured);
    expect(preview.skipped).toEqual([]);
    expect(preview.fields.map(field => [field.catalogField, field.proposedValue])).toEqual([
      ['ProductField24', 'QA Category: dog-food'],
      ['ProductField25', 'QA Product Type: dog-food-dry'],
      ['ProductField23', ''],
    ]);
    const { draft, decoded, xml } = await exportReviewedDraft(captured);
    expect(draft.customFields.ProductField23).toBe('');
    expect(xml).toContain('<ProductField23></ProductField23>');
    expect(decoded.customFields.ProductField23).toBe('');
    expect(decoded.customFields.ProductField28).toBe('Nylon');
  });

  it('exports a reviewed Flavor→Material correction to PF28 without rewriting PF23', async () => {
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const pair = proposals.find(proposal => proposal.proposalType === 'product_classification')!;
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: pair.id, decision: 'accepted' },
        { proposalId: flavor.id, decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' },
      ],
    });
    expect(reviewed.ok).toBe(true);
    const preview = approvedPreview(captured);
    expect(preview.skipped).toEqual([]);
    expect(preview.fields.map(field => [field.catalogField, field.proposedValue])).toEqual([
      ['ProductField24', 'QA Category: dog-food'],
      ['ProductField25', 'QA Product Type: dog-food-dry'],
      ['ProductField28', 'Rubber'],
    ]);
    const { draft, decoded } = await exportReviewedDraft(captured);
    expect(draft.customFields.ProductField28).toBe('Rubber');
    expect(decoded.customFields.ProductField28).toBe('Rubber');
    expect(decoded.customFields.ProductField23).toBe('Beef');
  });

  it('refuses protected and unknown correction destinations at review', async () => {
    // V2-native: corrections naming a destination outside the frozen
    // authority fail closed at review — never accepted, never exported.
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    for (const destination of ['brand', 'ProductField16', 'ProductField17', 'does-not-exist']) {
      const refused = submitProposalDecisions({
        workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
        decisions: [{ proposalId: flavor.id, decision: 'accepted', revisedTargetId: destination, revisedValue: 'X' }],
      });
      expect(refused.ok).toBe(false);
    }
    expect(getAcceptedProposals(captured.source.sku, captured.run.id)).toEqual([]);
    expect(listChangeSets(WS_ID)).toEqual([]);
    expect(readProductFile(workspacePath, captured.source.sku)).toEqual(captured.source);
  });

  it('refuses frozen destination drift atomically rather than exporting a rerouted value', async () => {
    // The hardened projection pins the corrected destination to its frozen
    // mapping: drifting the live mapping away from PF28 refuses the entire
    // export instead of rerouting the reviewed value.
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const pair = proposals.find(proposal => proposal.proposalType === 'product_classification')!;
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: [
        { proposalId: pair.id, decision: 'accepted' },
        { proposalId: flavor.id, decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' },
      ],
    });
    expect(reviewed.ok).toBe(true);
    const baseline = getCachedAttributeMappings(WS_ID);
    getDb().run(`UPDATE classification_attribute_mappings SET catalog_field = ? WHERE workspace_id = ? AND attribute_id = ?`,
      ['ProductField24', WS_ID, 'material']);
    try {
      await expect(applyCatalogClassification(workspacePath, WS_ID, captured.source.sku, captured.run.id))
        .rejects.toThrow(/Classification projection refused/);
      expect(listChangeSets(WS_ID)).toEqual([]);
      expect(readProductFile(workspacePath, captured.source.sku)).toEqual(captured.source);
    } finally {
      getDb().run(`DELETE FROM classification_attribute_mappings WHERE workspace_id = ?`, [WS_ID]);
      for (const mapping of baseline) {
        getDb().run(`INSERT INTO classification_attribute_mappings
          (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [WS_ID, mapping.id, mapping.attributeId, mapping.catalogField, JSON.stringify(mapping.serialization),
          mapping.isStale ? 1 : 0, 'test-restore', NOW, NOW]);
      }
    }
  });
});
