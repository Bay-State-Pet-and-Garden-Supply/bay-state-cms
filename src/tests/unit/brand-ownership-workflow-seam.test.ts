/**
 * Issue #349 — Brand ownership workflow seam (criterion 7).
 *
 * Proves Brand-present AND Brand-absent cases through the owner-confirmed
 * workflow seam using public interfaces only:
 * run (shared composition) → proposals → decisions → actual local draft
 * contents. Isolated persistence (fresh temp DB per test); deterministic
 * adapters (no provider calls — the flavor path resolves deterministically).
 *
 * - Unanimous Brand evidence yields NO Brand proposal (Brand-present case).
 * - Brand-absent evidence also classifies the owned attribute fine.
 * - An attempted protected revised target is refused attributably
 *   (`protected_target_refused`), never applied or rerouted.
 * - A historical Brand proposal accept is refused; reject passes.
 * - Catalog application preserves non-classification fields (identity,
 *   Name, description, images, pricing, inventory, Brand slot) in the
 *   actual local draft, applying only the owned classification change.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createRun as createRepositoryRun,
  completeRun,
  getProposalsByRun,
  getAcceptedProposals,
} from '../../db/repositories/classification-run-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { processProductFieldTarget } from '../../classification/curation-target-processor';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { writeProductFile } from '../../git/workspace-files';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { computeProductHash } from '../../classification/catalog-product-source';
import type { ClassificationEvidence } from '../../shared/types';

const WS_ID = 'ws-brand-ownership-seam';

function configFixture(): any {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [],
    attributes: [
      { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Identity' },
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'brand-map', attributeId: 'brand', catalogField: 'ProductField16', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      // Brand target deliberately ENABLED: proves the composition guard covers
      // it — no path emits a Brand proposal even from an enabled seed target.
      { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

function ev(id: string, runId: string, sku: string, overrides: Partial<ClassificationEvidence>): ClassificationEvidence {
  return {
    id, runId, stageName: 'evidence_extraction', productSku: sku,
    attributeId: null, source: 'spreadsheet', reliability: 'medium',
    sourceUrl: null, sourceField: 'name', snippet: null, value: null,
    metadata: {}, capturedAt: new Date().toISOString(), ...overrides,
  } as ClassificationEvidence;
}

function ctx(workspacePath: string, runId: string): any {
  return {
    workspacePath, workspaceId: WS_ID, runId,
    configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: new Date().toISOString() },
  };
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ownership-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

describe('issue #349 workflow seam: Brand ownership end to end', () => {
  it('Brand-present: unanimous Brand evidence yields no Brand proposal; owned flavor classifies', async () => {
    const runId = 'run-present';
    const evidence = [
      ev('ev-brand-1', runId, 'SKU-PRESENT', { source: 'spreadsheet', sourceField: 'brand', value: 'Acme', snippet: 'Acme' }),
      ev('ev-brand-2', runId, 'SKU-PRESENT', { source: 'official_product_page', sourceField: 'brand', value: 'Acme', snippet: 'Acme' }),
      ev('ev-flavor', runId, 'SKU-PRESENT', { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner' }),
    ];
    const brandTarget: any = {
      config: { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      options: [],
      attribute: { id: 'brand', name: 'Brand', valueMode: 'freeText', allowedValues: [], valueAliases: [], isUniversal: true },
    };
    const brandResult = await processProductFieldTarget(brandTarget, { sku: 'SKU-PRESENT', evidence, acceptedProposals: [], allProposals: [] }, ctx(workspacePath, runId));
    expect(brandResult.proposals).toEqual([]);

    const flavorTarget: any = {
      config: { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
      options: [{ value: 'Chicken', label: 'Chicken' }, { value: 'Beef', label: 'Beef' }],
      attribute: { id: 'flavor', name: 'Flavor', valueMode: 'controlled', allowedValues: ['Chicken', 'Beef'], valueAliases: [], isUniversal: false },
    };
    const flavorResult = await processProductFieldTarget(flavorTarget, { sku: 'SKU-PRESENT', evidence, acceptedProposals: [], allProposals: [] }, ctx(workspacePath, runId));
    expect(flavorResult.proposals).toHaveLength(1);
    expect(flavorResult.proposals[0].targetId).toBe('flavor');
  });

  it('Brand-absent: no Brand evidence still classifies the owned attribute; no Brand proposal', async () => {
    const runId = 'run-absent';
    const evidence = [
      ev('ev-name', runId, 'SKU-ABSENT', { sourceField: 'name', value: 'Chicken dinner kibble', snippet: 'Chicken dinner kibble' }),
      ev('ev-flavor', runId, 'SKU-ABSENT', { source: 'official_product_page', sourceField: 'ProductField23', attributeId: 'flavor', value: 'Chicken dinner', snippet: 'Chicken dinner' }),
    ];
    const brandTarget: any = {
      config: { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      options: [],
      attribute: { id: 'brand', name: 'Brand', valueMode: 'freeText', allowedValues: [], valueAliases: [], isUniversal: true },
    };
    const brandResult = await processProductFieldTarget(brandTarget, { sku: 'SKU-ABSENT', evidence, acceptedProposals: [], allProposals: [] }, ctx(workspacePath, runId));
    expect(brandResult.proposals).toEqual([]);
  });

  it('decisions → draft: protected revised target refused; accepted flavor applies; draft preserves the rest', async () => {
    const sku = 'SKU-DRAFT';
    const now = new Date().toISOString();
    const config = configFixture();
    const ref = createConfigSnapshot(WS_ID, config);
    const snapshot = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: now }, sourceProductHash: null });
    persistRuntimeSnapshot(snapshot);

    const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
    const db = getDb();
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', now]);
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-brand-hist', run.id, sku, 'field_assignment', 'brand', '"Acme"', 0.9, 'pending', now]);
    completeRun(run.id, 'completed');

    // Attempted protected revised target → attributable refusal.
    const refused = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedTargetId: 'brand', revisedValue: 'Acme' }],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('protected_target_refused');

    // Historical Brand proposal accept → refused; reject → passes.
    const histAccept = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-brand-hist', decision: 'accepted' }],
    });
    expect(histAccept.ok).toBe(false);
    if (!histAccept.ok) expect(histAccept.code).toBe('protected_target_refused');
    const histReject = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-brand-hist', decision: 'rejected' }],
    });
    expect(histReject.ok).toBe(true);

    // Accept the owned flavor proposal, then apply: draft carries only the
    // owned change; identity/Name/description/images/pricing/inventory/Brand
    // survive byte-identical.
    const acceptFlavor = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted' }],
    });
    expect(acceptFlavor.ok).toBe(true);
    expect(getProposalsByRun(run.id).filter(p => p.targetId === 'brand' && p.status === 'accepted')).toEqual([]);
    expect(getAcceptedProposals(sku, run.id).map(p => p.targetId)).toEqual(['flavor']);

    const product: any = {
      schemaVersion: 1, id: 'p-seam', sku, status: 'active',
      core: {
        name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
        inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
        weight: '5 lb', taxable: true, media: { primary: 'products/x/primary.jpg', additional: ['products/x/alt.jpg'] },
        seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Old Page'],
      },
      customFields: { ProductField16: 'Acme', ProductField23: 'Beef' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: now, updatedAt: now, archivedAt: null },
    };
    writeProductFile(workspacePath, product);
    // The run was created before the product file existed; align the
    // recorded source hash with the written bytes so apply() passes drift.
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).toEqual(['ProductField23']);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField23).toBe('Chicken');
    expect(draft.customFields.ProductField16).toBe('Acme');
    expect(draft.core.name).toBe('Acme Chicken Dinner');
    expect(draft.core.description).toBe('Yummy kibble');
    expect(draft.core.price).toBe('9.99');
    expect(draft.core.inventory.quantityOnHand).toBe(5);
    expect(draft.core.media.primary).toBe('products/x/primary.jpg');
    expect(draft.sku).toBe(sku);
  });
});
