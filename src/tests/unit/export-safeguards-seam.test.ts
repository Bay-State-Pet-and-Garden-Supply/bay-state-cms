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
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot, syncConfigToCache, getCachedAttributeMappings } from '../../db/repositories/classification-config-repo';
import { createRun, completeRun, getProposalsByRun, getAcceptedProposals } from '../../db/repositories/classification-run-repo';
import { listChangeSetItems, listChangeSets } from '../../db/repositories/change-set-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { buildAssignmentProjection } from '../../classification/assignment-projection';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { computeProductHash } from '../../classification/catalog-product-source';
import { saveClassificationConfig } from '../../classification/config-loader';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { writeProductFile, readProductFile } from '../../git/workspace-files';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createExportPackage } from '../../shopsite/export-package';
import type { ClassificationConfig, ClassificationProposal } from '../../shared/schemas/classification';
import type { Product } from '../../shared/types';

const NOW = '2026-08-01T12:00:00.000Z';
const WS_ID = 'ws-export-safeguards-seam';
let workspacePath: string;

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
      lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: { ProductType: 'Download', CustomMystery: 'keep-me' }, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: NOW, updatedAt: NOW, archivedAt: null },
  };
}

function configFixture(): ClassificationConfig {
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
    productTypes: [], attributeProfiles: [],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Material' },
    ],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'material-map', attributeId: 'material', catalogField: 'ProductField28', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'material-target', kind: 'product_field', label: 'Material', enabled: true, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField28', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'export-safeguards-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'export seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });
});

afterEach(() => {
  closeDb();
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

function captureRun(config = configFixture()) {
  const source = product();
  writeProductFile(workspacePath, source);
  saveClassificationConfig(workspacePath, config);
  syncConfigToCache(WS_ID, config);
  const ref = createConfigSnapshot(WS_ID, config);
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: source.sku, config,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: computeProductHash(source),
  });
  const persisted = persistRuntimeSnapshot(snapshot);
  const run = createRun(WS_ID, source.sku, persisted.id, persisted.hash, {
    sourceKind: 'catalog_product', sourceProductHash: snapshot.sourceProductHash,
  });
  return { source, snapshot, run };
}

async function curateFields(captured: ReturnType<typeof captureRun>) {
  const { source, snapshot, run } = captured;
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

function approvedPreview(captured: ReturnType<typeof captureRun>) {
  const { source, snapshot, run } = captured;
  return buildAssignmentProjection(
    getAcceptedProposals(source.sku, run.id), source.customFields, source.core.productOnPages ?? [],
    getCachedAttributeMappings(WS_ID), new Set(),
    { attributes: snapshot.attributes, frozenMappings: snapshot.attributeMappings },
  );
}

async function exportReviewedDraft(captured: ReturnType<typeof captureRun>) {
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
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: flavor.id, decision: 'accepted', revisedValue: null }],
    });
    expect(reviewed.ok).toBe(true);
    const preview = approvedPreview(captured);
    expect(preview.skipped).toEqual([]);
    expect(preview.fields.map(field => [field.catalogField, field.proposedValue])).toEqual([['ProductField23', '']]);
    expect(getProposalsByRun(captured.run.id).find(proposal => proposal.targetId === 'material')?.status).toBe('pending');
    const { draft, decoded, xml } = await exportReviewedDraft(captured);
    expect(draft.customFields.ProductField23).toBe('');
    expect(xml).toContain('<ProductField23></ProductField23>');
    expect(decoded.customFields.ProductField23).toBe('');
    expect(decoded.customFields.ProductField28).toBe('Nylon');
  });

  it('exports a reviewed Flavor→Material correction to PF28 without rewriting PF23', async () => {
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const flavor = proposals.find(proposal => proposal.targetId === 'flavor')!;
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: flavor.id, decision: 'accepted', revisedTargetId: 'material', revisedValue: 'Rubber' }],
    });
    expect(reviewed.ok).toBe(true);
    const preview = approvedPreview(captured);
    expect(preview.skipped).toEqual([]);
    expect(preview.fields.map(field => [field.catalogField, field.proposedValue])).toEqual([['ProductField28', 'Rubber']]);
    const { draft, decoded } = await exportReviewedDraft(captured);
    expect(draft.customFields.ProductField28).toBe('Rubber');
    expect(decoded.customFields.ProductField28).toBe('Rubber');
    expect(decoded.customFields.ProductField23).toBe('Beef');
  });

  it('refuses protected, native, unknown and cross-role frozen destinations before acceptance or export', () => {
    for (const destination of ['ProductField16', 'ProductField6', 'ProductType', 'ProductField999', 'ProductField1', 'ProductField17', 'ProductField28']) {
      const config = configFixture();
      config.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!.catalogField = destination;
      config.curationTargets!.find(target => target.attributeId === 'flavor')!.catalogField = destination;
      const captured = captureRun(config);
      const proposalId = `historical-${destination}`;
      getDb().run(`INSERT INTO classification_proposals
        (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, 'field_assignment', 'flavor', ?, 0.9, 'pending', ?)`,
      [proposalId, captured.run.id, captured.source.sku, JSON.stringify('Chicken'), NOW]);
      completeRun(captured.run.id, 'completed');
      const input = { workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product' as const };
      const refused = submitProposalDecisions({ ...input, decisions: [{ proposalId, decision: 'accepted' }] });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe('protected_target_refused');
      expect(getAcceptedProposals(captured.source.sku, captured.run.id)).toEqual([]);
      const rejected = submitProposalDecisions({ ...input, decisions: [{ proposalId, decision: 'rejected' }] });
      expect(rejected.ok).toBe(true);
      expect(listChangeSets(WS_ID)).toEqual([]);
      expect(readProductFile(workspacePath, captured.source.sku)).toEqual(captured.source);
    }
  });

  it('refuses live destination or serialization drift atomically rather than exporting a rerouted value', async () => {
    const captured = captureRun();
    const proposals = await curateFields(captured);
    const reviewed = submitProposalDecisions({
      workspaceId: WS_ID, productSku: captured.source.sku, runId: captured.run.id, sourceKind: 'catalog_product',
      decisions: proposals.map(proposal => ({ proposalId: proposal.id, decision: 'accepted' as const })),
    });
    expect(reviewed.ok).toBe(true);
    for (const destination of ['ProductField24', 'ProductField16', 'ProductType', 'serialization']) {
      const drifted = configFixture();
      const mapping = drifted.attributeMappings.find(mapping => mapping.attributeId === 'flavor')!;
      if (destination === 'serialization') mapping.serialization.prefix = 'Flavor: ';
      else mapping.catalogField = destination;
      syncConfigToCache(WS_ID, drifted);
      await expect(applyCatalogClassification(workspacePath, WS_ID, captured.source.sku, captured.run.id))
        .rejects.toThrow(destination === 'serialization' ? /mapping_changed/ : /Classification projection refused/);
      expect(listChangeSets(WS_ID)).toEqual([]);
      expect(readProductFile(workspacePath, captured.source.sku)).toEqual(captured.source);
    }
  });
});
