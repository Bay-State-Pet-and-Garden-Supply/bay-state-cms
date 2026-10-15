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
} from '../../db/repositories/classification-run-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot, snapshotHash } from '../../classification/runtime-snapshot';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { evaluateCanonicalReadiness } from '../../classification/classification-readiness';
import { getPendingRefreshCount } from '../../db/repositories/classification-refresh-repo';
import { writeProductFile } from '../../git/workspace-files';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { computeProductHash } from '../../classification/catalog-product-source';

const WS_ID = 'ws-readiness-seam';
const NOW = '2026-08-01T12:00:00.000Z';

function configFixture(): any {
  // v1 file fixture (like the #350 seam): no categories key, no profiles,
  // no isUniversal — the SNAPSHOT is patched post-build with the canonical
  // pair mapping + universal flag (snapshot-only semantics, never file state).
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
      { id: 'dry-cat-food', name: 'Dry Cat Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      { id: 'note', name: 'Note', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Note' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'note-map', attributeId: 'note', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'class-target', kind: 'product_type', label: 'Classification', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'note-target', kind: 'product_field', label: 'Note', enabled: true, selectionMode: 'single', attributeId: 'note', catalogField: 'ProductField24', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

function seedRun(sku: string, pageImport?: { id: string; hash: string }) {
  const config = configFixture();
  const ref = createConfigSnapshot(WS_ID, config);
  const snapshot: any = {
    ...buildRuntimeSnapshot({
      workspaceId: WS_ID, workspacePath, productSku: sku, config,
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW },
      sourceProductHash: null,
      ...(pageImport ? { pageImportId: pageImport.id, pageImportHash: pageImport.hash } : {}),
    }),
    // Canonical pair mapping + universal flag + profile wiring (snapshot-only,
    // like #350 seam: v1 files cannot express the pair mapping or profiles).
    categories: [{ id: 'dog-food', name: 'Dog Food' }, { id: 'cat-food', name: 'Cat Food' }],
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', categoryId: 'dog-food', attributeProfileId: 'dry-dog-food-profile' },
      { id: 'dry-cat-food', name: 'Dry Cat Food', categoryId: 'cat-food', attributeProfileId: 'dry-cat-food-profile' },
    ],
    attributeProfiles: [
      { id: 'dry-dog-food-profile', productTypeId: 'dry-dog-food', name: 'Dog Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      { id: 'dry-cat-food-profile', productTypeId: 'dry-cat-food', name: 'Cat Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
    ],
  };
  snapshot.attributes = snapshot.attributes.map((a: any) =>
    a.id === 'note' ? { ...a, isUniversal: true } : a,
  );
  // The test is the config authority here (v1 files cannot express the
  // canonical pair mapping): re-embed the content hash so persistence
  // integrity holds truthfully over exactly what was frozen.
  snapshot.snapshotHash = snapshotHash(snapshot);
  persistRuntimeSnapshot(snapshot);
  const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
  const db = getDb();
  const now = new Date().toISOString();
  const insert = (id: string, type: string, target: string | null, value: unknown) => {
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, run.id, sku, type, target, JSON.stringify(value), 0.9, 'pending', now],
    );
  };
  insert('prop-pair', 'product_classification', 'dry-dog-food', { categoryId: 'dog-food', productTypeId: 'dry-dog-food' });
  insert('prop-flavor', 'field_assignment', 'flavor', 'Chicken');
  insert('prop-note', 'field_assignment', 'note', 'Free text');
  completeRun(run.id, 'completed');
  return run;
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

    // The pair-gated dependent is stale; the universal note is intact.
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
    expect(result.appliedFields).toContain('ProductField24');
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField23).toBe('Beef');
    expect(draft.customFields.ProductField24).toBe('Free text');
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
    if (!readiness.ok) expect(readiness.code).toBe('required_values_missing');
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
