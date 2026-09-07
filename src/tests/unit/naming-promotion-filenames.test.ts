import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { promoteItems } from '../../onboarding/draft-promoter';
import { markReviewed, markApproved } from '../../db/repositories/onboarding-review-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { listChangeSetItems, createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { buildProductsXml } from '../../shopsite/xml-builder';
import { validateChangeSet } from '../../validation/change-set-validation';
import { listValidationResults } from '../../db/repositories/validation-repo';
import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';
import type { Product } from '../../shared/types';

describe('Naming filenames at Promotion and pre-sync (issue #107)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'naming-promotion-test.db');
  const tempWorkspaceDir = path.resolve(import.meta.dirname, 'naming-temp-workspace');
  const wsId = 'ws-naming-id';

  function seedApproved(itemId: string, batchId: string): void {
    markReviewed({ itemId, batchId, reviewedBy: 'naming-test' });
    markApproved({ itemId, batchId, approvedBy: 'naming-test' });
  }

  function seedAcceptedCategoryProposal(db: any, sku: string, pageId: string, pageName: string) {
    const runId = `run-naming-${sku}`;
    const now = new Date().toISOString();
    const item = db.query(
      'SELECT id, curation_data_json FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1',
    ).get(sku) as { id: string; curation_data_json: string | null };
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, wsId, item.id, sku, 'completed', now],
    );
    const curationData = item.curation_data_json ? JSON.parse(item.curation_data_json) : {};
    curationData.classificationRunId = runId;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(curationData), item.id]);
    const proposalId = `prop-naming-${sku}`;
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [proposalId, runId, sku, 'category_page', pageId, JSON.stringify({ pageId, pageName }), 1.0, 'accepted', now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );
  }

  function seedItem(batchId: string, sku: string, opts: { title: string; seoFileName: string | null }) {
    const [item] = insertItems(batchId, [{
      upc: sku,
      name: opts.title,
      price: '$9.99',
      brandHint: 'Test Brand',
      rowNumber: 1,
    }]);
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: opts.title,
      brand: 'Test Brand',
      description: 'Naming test product.',
      bulletPoints: [],
      primaryImage: `products/${sku}/images/primary.jpg`,
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: opts.seoFileName,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: opts.seoFileName ? `https://example.test/${opts.seoFileName}` : null,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const curationData = {
      curatedTitle: opts.title,
      titleSource: 'web',
      suggestedPages: ['Shoes'],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const db = getDb();
    db.query(
      `UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`,
    ).run(JSON.stringify(extractionData), JSON.stringify(curationData), item.id);
    return item;
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    try { mkdirSync(tempWorkspaceDir, { recursive: true }); } catch { /* ok */ }
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Naming WS', tempWorkspaceDir, path.join(tempWorkspaceDir, '.git'), now, now, 'complete'],
    );
    // One verified page shared by every item in this file.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: createHash('sha256').update('naming-shoes').digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key: 'naming-shoes', status: 'verified' },
        name: 'Shoes',
        parentRef: null,
        availability: 'available',
      }],
      activatedBy: 'test',
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('promotes same-named siblings to distinct persisted FileNames', async () => {
    const db = getDb();
    const page = listVerifiedPageOptions(wsId).find(p => p.name === 'Shoes');
    if (!page) throw new Error('verified page missing');
    const batch = createBatch({ workspaceId: wsId, name: 'Naming Batch A', fileName: 'a.csv', totalItems: 3 });
    const skus = ['900000000001', '900000000002', '900000000003'];
    const ids: string[] = [];
    for (const sku of skus) {
      const item = seedItem(batch.id, sku, { title: 'Identical Product Name', seoFileName: null });
      seedAcceptedCategoryProposal(db, sku, page.id, 'Shoes');
      seedApproved(item.id, batch.id);
      ids.push(item.id);
    }
    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, ids);
    expect(res.failures).toEqual([]);
    expect(res.count).toBe(3);

    const drafts = listChangeSetItems(res.changeSetId!).map(i => JSON.parse(i.draftJson) as Product);
    const persisted = drafts.map(d => d.customFields['FileName']);
    expect(persisted.every(Boolean)).toBe(true);
    expect(new Set(persisted).size).toBe(3);
    expect(persisted).toContain('identical-product-name.html');

    // Exported XML carries the same distinct names.
    const xml = buildProductsXml(drafts);
    const exported = [...xml.matchAll(/<FileName>([^<]*)<\/FileName>/g)].map(m => m[1]);
    expect(new Set(exported).size).toBe(3);
    expect([...exported].sort()).toEqual([...persisted].sort());
  });

  it('prefers the per-source-URL slug for official items; distributor items take the name path', async () => {
    const db = getDb();
    const page = listVerifiedPageOptions(wsId).find(p => p.name === 'Shoes');
    if (!page) throw new Error('verified page missing');
    const batch = createBatch({ workspaceId: wsId, name: 'Naming Batch B', fileName: 'b.csv', totalItems: 2 });
    const official = seedItem(batch.id, '900000000011', { title: 'Shared Title', seoFileName: 'shared-title-abc123' });
    const distributor = seedItem(batch.id, '900000000012', { title: 'Shared Title', seoFileName: null });
    for (const sku of ['900000000011', '900000000012']) seedAcceptedCategoryProposal(db, sku, page.id, 'Shoes');
    seedApproved(official.id, batch.id);
    seedApproved(distributor.id, batch.id);

    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [official.id, distributor.id]);
    expect(res.failures).toEqual([]);
    const bySku = new Map(listChangeSetItems(res.changeSetId!).map(i => [i.sku, JSON.parse(i.draftJson) as Product]));
    expect(bySku.get('900000000011')!.customFields['FileName']).toBe('shared-title-abc123.html');
    const distName = bySku.get('900000000012')!.customFields['FileName'] as string;
    expect(distName).toMatch(/^shared-title(-\d+)?\.html$/);
    expect(distName).not.toBe('shared-title-abc123.html');
  });

  it('pre-sync validation blocks a change set with duplicate FileNames', () => {
    const mkDraft = (sku: string, name: string): Product => ({
      schemaVersion: 1,
      id: `id-${sku}`,
      sku,
      status: 'draft',
      core: {
        name, price: '9.99', salePrice: null, description: 'd',
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: `products/${sku}/images/primary.jpg`, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      },
      customFields: { ProductField16: 'Test Brand' },
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    });
    const cs = createChangeSet({ workspaceId: wsId, title: 'Naming dup CS', description: 'dup', baseCommit: 'unknown' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'DUP-1', operation: 'create', draftJson: JSON.stringify(mkDraft('DUP-1', 'Same Name')), baseJson: null, draftHash: 'h1' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'DUP-2', operation: 'create', draftJson: JSON.stringify(mkDraft('DUP-2', 'Same Name')), baseJson: null, draftHash: 'h2' });

    const result = validateChangeSet(cs.id);
    expect(result.canApprove).toBe(false);
    // Change-set-level blockers live on the scope, not on any single item.
    const scopeCodes = listValidationResults('change_set', cs.id).map(r => r.code);
    expect(scopeCodes).toContain('DUPLICATE_FILENAME');
  });

  it('pre-sync validation passes distinct FileNames without a DUPLICATE_FILENAME code', () => {
    const mkDraft = (sku: string, name: string): Product => ({
      schemaVersion: 1,
      id: `id-${sku}`,
      sku,
      status: 'draft',
      core: {
        name, price: '9.99', salePrice: null, description: 'd',
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: `products/${sku}/images/primary.jpg`, additional: [] },
        seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      },
      customFields: { ProductField16: 'Test Brand' },
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', archivedAt: null },
    });
    const cs = createChangeSet({ workspaceId: wsId, title: 'Naming ok CS', description: 'ok', baseCommit: 'unknown' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'OK-1', operation: 'create', draftJson: JSON.stringify(mkDraft('OK-1', 'Alpha Product')), baseJson: null, draftHash: 'h1' });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'OK-2', operation: 'create', draftJson: JSON.stringify(mkDraft('OK-2', 'Beta Product')), baseJson: null, draftHash: 'h2' });

    const result = validateChangeSet(cs.id);
    const codes = result.items.flatMap(i => i.results.map(r => r.code));
    expect(codes).not.toContain('DUPLICATE_FILENAME');
    // Scope-level blockers never appear on items by construction — assert the
    // scope surface too so this test cannot pass vacuously.
    const scopeCodes = listValidationResults('change_set', cs.id).map(r => r.code);
    expect(scopeCodes).not.toContain('DUPLICATE_FILENAME');
  });

  it('true collision: official URL slug wins the base name, sibling is suffixed', async () => {
    const db = getDb();
    const page = listVerifiedPageOptions(wsId).find(p => p.name === 'Shoes');
    if (!page) throw new Error('verified page missing');
    const batch = createBatch({ workspaceId: wsId, name: 'Naming Batch C', fileName: 'c.csv', totalItems: 2 });
    // Official item's URL slug collides exactly with the sibling's slugged title.
    const official = seedItem(batch.id, '900000000021', { title: 'Shared Title', seoFileName: 'shared-title' });
    const sibling = seedItem(batch.id, '900000000022', { title: 'Shared Title', seoFileName: null });
    for (const sku of ['900000000021', '900000000022']) seedAcceptedCategoryProposal(db, sku, page.id, 'Shoes');
    seedApproved(official.id, batch.id);
    seedApproved(sibling.id, batch.id);

    const res = await promoteItems(wsId, tempWorkspaceDir, batch.id, [official.id, sibling.id]);
    expect(res.failures).toEqual([]);
    const bySku = new Map(listChangeSetItems(res.changeSetId!).map(i => [i.sku, JSON.parse(i.draftJson) as Product]));
    expect(bySku.get('900000000021')!.customFields['FileName']).toBe('shared-title.html');
    expect(bySku.get('900000000022')!.customFields['FileName']).toBe('shared-title-2.html');
  });

  it('assignPromotionFileNames keeps healed catalog names (incl. seo-only) without renaming', async () => {
    const { assignPromotionFileNames } = await import('../../onboarding/draft-promoter');
    const healed: Product = {
      schemaVersion: 1, id: 'healed-1', sku: 'HEALED-1', status: 'active',
      core: {
        name: 'Healed Product', price: '9.99', salePrice: null, description: null,
        inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
        availability: null, weight: null, taxable: true,
        media: { primary: null, additional: [] },
        seo: { fileName: 'healed-product-7.html', searchKeywords: null, googleProductCategory: null },
      },
      customFields: { ProductField16: 'Test Brand' },
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0',
        lastPulledAt: '2026-01-02T00:00:00.000Z', lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', archivedAt: null },
    };
    const items = [
      { id: 'item-healed', upc: 'HEALED-1', name: 'Healed Product', curationData: { curatedTitle: 'Healed Product' }, extractionData: { title: 'Healed Product', seoFileName: 'other-slug' } },
      { id: 'item-new', upc: 'HEALED-2', name: 'Healed Product 7', curationData: { curatedTitle: 'Healed Product 7' }, extractionData: { title: 'Healed Product 7', seoFileName: null } },
    ] as any;
    const assigned = assignPromotionFileNames(items, tempWorkspaceDir, ((_wp: string, upc: string) => (upc === 'HEALED-1' ? healed : null)) as any);
    // Healed live page keeps its name even though the new extraction disagrees…
    expect(assigned.get('HEALED-1')).toBe('healed-product-7.html');
    // …and the sibling whose slug collides with the kept name is suffixed.
    expect(assigned.get('HEALED-2')).toBe('healed-product-7-2.html');
  });
});
