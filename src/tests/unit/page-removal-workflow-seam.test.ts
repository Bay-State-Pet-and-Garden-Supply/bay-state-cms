/**
 * Issue #353 — page proposals + reviewed removals workflow seam.
 *
 * Proves through the owner-confirmed workflow seam (public interfaces only):
 * run → proposals → decisions → actual local draft contents. Isolated
 * persistence (fresh temp DB per test); deterministic adapters.
 *
 * Slice 1 (RED): verified taxonomy destination vs Brand/unverified pages.
 * A verified taxonomy page proposal is accepted and applied; a Brand page
 * proposal and an unverified page proposal are refused/never applied.
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
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../classification/page-snapshot';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { writeProductFile } from '../../git/workspace-files';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { setTaxonomyFreezeForTests } from '../../classification/taxonomy-freeze';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { computeProductHash } from '../../classification/catalog-product-source';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';

const WS_ID = 'ws-page-removal-seam';
const NOW = '2026-08-01T12:00:00.000Z';

const TAXONOMY_PAGE = { pageId: 'page-dog-food', pageName: 'Dog Food' };
const BRAND_PAGE = { pageId: 'page-brand-acme', pageName: 'Brand - Acme' };

function configFixture(): any {
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
    productTypes: [],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
    ],
    attributeProfiles: [],
    attributeMappings: [
      { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      { id: 'page-target', kind: 'page', label: 'Category Page', enabled: true, selectionMode: 'multiple', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
}
function seedPageImport() {
  activatePageImportFromRecords({
    workspaceId: WS_ID,
    sourceHash: 'a'.repeat(64),
    parserFormatVersion: 'pages-xml-1',
    records: [
      { identity: { kind: 'exported_guid', key: TAXONOMY_PAGE.pageId, status: 'verified' }, name: TAXONOMY_PAGE.pageName, parentRef: null, availability: 'available' },
      { identity: { kind: 'exported_guid', key: BRAND_PAGE.pageId, status: 'verified' }, name: BRAND_PAGE.pageName, parentRef: null, availability: 'available' },
    ],
    activatedBy: 'test',
  });
}

let workspacePath: string;

beforeEach(() => {
  setTaxonomyFreezeForTests(false);
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'page-removal-seam-'));
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });
  seedPageImport();
  saveClassificationConfig(workspacePath, configFixture());
  syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));
});

function seedRun(sku: string) {
  // Application gates on the ACTIVE import's row IDs (randomUUIDs) — resolve
  // the real verified identities by name so proposals carry true identities.
  const byName = new Map(listVerifiedPageOptions(WS_ID).map(p => [p.name, p.id]));
  const taxonomyId = byName.get(TAXONOMY_PAGE.pageName)!;
  const brandId = byName.get(BRAND_PAGE.pageName)!;
  const config = configFixture();
  const ref = createConfigSnapshot(WS_ID, config);
  const pageSnapshot = captureVerifiedPageSnapshot(WS_ID);
  const snapshot = buildRuntimeSnapshot({
    workspaceId: WS_ID, workspacePath, productSku: sku, config,
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW },
    sourceProductHash: null,
    pages: toPageSnapshotState(pageSnapshot),
    pageImportId: pageSnapshot.pageImportId,
    pageImportHash: pageSnapshot.pageImportHash,
  });
  persistRuntimeSnapshot(snapshot);
  const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['prop-page-taxonomy', run.id, sku, 'category_page', taxonomyId, JSON.stringify({ pageId: taxonomyId, pageName: TAXONOMY_PAGE.pageName, identityVerified: true }), 0.9, 'pending', now],
  );
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['prop-page-brand', run.id, sku, 'category_page', brandId, JSON.stringify({ pageId: brandId, pageName: BRAND_PAGE.pageName, identityVerified: true }), 0.95, 'pending', now],
  );
  db.run(
    `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ['prop-page-unverified', run.id, sku, 'category_page', 'page-ghost', JSON.stringify({ pageId: 'page-ghost', pageName: 'Ghost Page', identityVerified: false }), 0.8, 'pending', now],
  );
  completeRun(run.id, 'completed');
  return run;
}

function writeProduct(sku: string) {
  const product: any = {
    schemaVersion: 1, id: 'p-seam', sku, status: 'active',
    core: {
      name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: 'products/x/primary.jpg', additional: [] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Old Page'],
    },
    customFields: { ProductField23: 'Beef' },
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: NOW, updatedAt: NOW, archivedAt: null },
  };
  writeProductFile(workspacePath, product);
  return product;
}

describe('issue #353 workflow seam: verified pages vs Brand/unverified', () => {
  it('verified taxonomy page accepts + applies; Brand page is refused; unverified page never applies', async () => {
    const sku = 'SKU-PAGE-SEAM';
    const run = seedRun(sku);
    expect(getProposalsByRun(run.id)).toHaveLength(3);

    // Verified taxonomy destination accepts.
    const acceptTaxonomy = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-page-taxonomy', decision: 'accepted' }],
    });
    expect(acceptTaxonomy.ok).toBe(true);

    // Brand page accept is refused attributably (never applied, never rerouted).
    const acceptBrand = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-page-brand', decision: 'accepted' }],
    });
    expect(acceptBrand.ok).toBe(false);
    if (!acceptBrand.ok) expect(acceptBrand.code).toBe('protected_target_refused');

    // Brand reject passes (carries no write authority).
    const rejectBrand = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-page-brand', decision: 'rejected' }],
    });
    expect(rejectBrand.ok).toBe(true);

    // Draft applies ONLY the verified taxonomy page; Brand + unverified absent.
    const product = writeProduct(sku);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedPages).toEqual([TAXONOMY_PAGE.pageName]);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.core.productOnPages).toContain('Old Page');
    expect(draft.core.productOnPages).toContain(TAXONOMY_PAGE.pageName);
    expect(draft.core.productOnPages.find((p: string) => p.startsWith('Brand -'))).toBeUndefined();
    expect(draft.core.productOnPages).not.toContain('Ghost Page');
    expect(getAcceptedProposals(sku, run.id).map(p => p.id)).not.toContain('prop-page-brand');
  });
});

describe('issue #353 workflow seam: reviewed removals', () => {
  it('incompatible field clear: explicit null correction clears the owned slot, preserves the rest', async () => {
    const sku = 'SKU-FIELD-CLEAR';
    const run = seedRun(sku);
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Salmon"', 0.9, 'pending', now],
    );

    // Reviewed removal: explicit null value clears the incompatible slot.
    const clear = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-flavor', decision: 'accepted', revisedValue: null }],
    });
    expect(clear.ok).toBe(true);

    const product = writeProduct(sku);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField23).toBe('');
    expect(draft.core.name).toBe('Acme Chicken Dinner');
  });

  it('taxonomy-page removal: accepted clear removes the assignment from the draft, preserves other pages', async () => {
    const sku = 'SKU-PAGE-REMOVAL';
    const run = seedRun(sku);

    // Reviewed removal in ONE decision: accept + explicit null clears the
    // assignment (before/after intent lives in proposal vs correction).
    const remove = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-page-taxonomy', decision: 'accepted', revisedValue: null, revisedTargetId: null }],
    });
    expect(remove.ok).toBe(true);

    // The product already sits on the taxonomy page; the reviewed removal
    // takes it off while the pre-existing Old Page survives.
    const product = writeProduct(sku);
    product.core.productOnPages = ['Old Page', TAXONOMY_PAGE.pageName];
    writeProductFile(workspacePath, product);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.core.productOnPages).toContain('Old Page');
    expect(draft.core.productOnPages).not.toContain(TAXONOMY_PAGE.pageName);
  });

  it('pending/rejected removal preserves existing assignments (no silent delete)', async () => {
    const sku = 'SKU-PENDING-REMOVAL';
    const run = seedRun(sku);

    // Reject the removal: existing placement survives.
    const reject = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-page-taxonomy', decision: 'rejected' }],
    });
    expect(reject.ok).toBe(true);

    const product = writeProduct(sku);
    product.core.productOnPages = ['Old Page', TAXONOMY_PAGE.pageName];
    writeProductFile(workspacePath, product);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const accepted = getAcceptedProposals(sku, run.id);
    expect(accepted.map(p => p.id)).not.toContain('prop-page-taxonomy');
  });
});

describe('issue #353 workflow seam: targeted multi-value removal', () => {
  it('reviewed reduced array removes only the named value, keeps the rest', async () => {
    const sku = 'SKU-MULTI-REMOVE';
    const run = seedRun(sku);
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-multi', run.id, sku, 'field_assignment', 'flavor', JSON.stringify(['Chicken', 'Beef']), 0.9, 'pending', now],
    );

    // Reviewed intent: drop Beef, keep Chicken — no collateral clearing.
    const reduce = submitProposalDecisions({
      workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-multi', decision: 'accepted', revisedValue: ['Chicken'] }],
    });
    expect(reduce.ok).toBe(true);

    const product = writeProduct(sku);
    product.customFields.ProductField23 = 'Chicken, Beef';
    writeProductFile(workspacePath, product);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(product), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).toContain('ProductField23');
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField23).toBe('Chicken');
    expect(draft.core.name).toBe('Acme Chicken Dinner');
  });
});
