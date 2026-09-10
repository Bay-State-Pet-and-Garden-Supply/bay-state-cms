import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  updateItemStageStatus,
  completeSourcingWithDecision,
} from '../../db/repositories/onboarding-item-repo';
import { promoteItems } from '../../onboarding/draft-promoter';
import { markReviewed, markApproved } from '../../db/repositories/onboarding-review-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { listChangeSets, listChangeSetItems } from '../../db/repositories/change-set-repo';
import { assignProductToPageId } from '../../db/repositories/page-repo';
import { type ExtractionData, ExtractionDataSchema, type SourcingDecisionV2 } from '../../shared/schemas/onboarding';
import { startSourcingGeneration, insertEvidenceAttempt } from '../../db/repositories/onboarding-evidence-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { buildDistributorRecordProjection } from '../../onboarding/sourcing/distributor-record-projection';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { createDistributor, createConnection } from '../../db/repositories/distributor-repo';
import { materializeDistributorRecordExtraction } from '../../onboarding/sourcing/distributor-record-materializer';

describe('Draft Promoter Service', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'promoter-test.db');
  const tempWorkspaceDir = path.resolve(import.meta.dirname, 'temp-workspace');
  const wsId = 'ws-promoter-id';

  /** Seed a durable approval (reviewed + approved) so promoteItems' final
   *  durable-approval authority gate (epic #46 review round 2) passes and the
   *  test exercises the downstream draft/change-set logic it intends. */
  function seedApproved(itemId: string, batchId: string): void {
    markReviewed({ itemId, batchId, reviewedBy: 'promoter-test' });
    markApproved({ itemId, batchId, approvedBy: 'promoter-test' });
  }


  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create temp workspace folder
    try { mkdirSync(tempWorkspaceDir, { recursive: true }); } catch { /* ok */ }

    // Insert dummy workspace
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Promoter WS', tempWorkspaceDir, path.join(tempWorkspaceDir, '.git'), now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function seedAttributeMapping(db: any, attributeId: string, catalogField: string, isStale = 0) {
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_attribute_mappings
       (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        wsId,
        `map-${attributeId}`,
        attributeId,
        catalogField,
        JSON.stringify({ format: 'direct', separator: ', ', prefix: '', suffix: '' }),
        isStale,
        now,
        now,
      ],
    );
  }

  /** Activate a verified import containing one page; returns its verified ID. */
  function activateVerifiedPage(pageName: string, suffix: string): string {
    const key = `vp-${suffix}-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: createHash('sha256').update(key).digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key, status: 'verified' },
        name: pageName,
        parentRef: null,
        availability: 'available',
      }],
      activatedBy: 'test',
    });
    const verified = listVerifiedPageOptions(wsId).find(p => p.name === pageName);
    if (!verified) throw new Error(`verified page not created: ${pageName}`);
    return verified.id;
  }

  function seedAcceptedCategoryProposal(db: any, sku: string, pageName: string, runOverride?: string) {
    const runId = runOverride ?? `run-${sku}`;
    const now = new Date().toISOString();
    const item = db.query(
      'SELECT id, curation_data_json FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1',
    ).get(sku) as { id: string; curation_data_json: string | null };
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, wsId, item.id, sku, 'completed', now]
    );
    const curationData = item.curation_data_json ? JSON.parse(item.curation_data_json) : {};
    curationData.classificationRunId = runId;
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify(curationData), item.id],
    );

    // The proposal must reference a VERIFIED page from the ACTIVE import — an
    // unverified page can no longer satisfy the mandatory Pages gate.
    const pageId = activateVerifiedPage(pageName, sku);

    const proposalId = `prop-${sku}-${pageName.replace(/\s+/g, '-').toLowerCase()}`;
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [proposalId, runId, sku, 'category_page', pageId, JSON.stringify({ pageId, pageName }), 1.0, 'accepted', now]
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now]
    );
  }

  function seedPromotionReadyItem(batchName: string, sku: string) {
    const batch = createBatch({
      workspaceId: wsId,
      name: batchName,
      fileName: `${sku}.csv`,
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{
      upc: sku,
      name: `Product ${sku}`,
      price: '$9.99',
      brandHint: 'Test Brand',
      rowNumber: 1,
    }]);
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: `Product ${sku}`,
      brand: 'Test Brand',
      description: 'Promotion classification test product.',
      bulletPoints: [],
      primaryImage: `products/${sku}/images/primary.jpg`,
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/${sku}`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const curationData = {
      curatedTitle: `Product ${sku}`,
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO page_index
       (id, name, file_name, page_hash, created_at, updated_at)
       VALUES ('promotion-toys-page', 'Toys', 'toys.html', 'promotion-toys-hash', ?, ?)`,
      [now, now],
    );
    db.run(
      `UPDATE onboarding_items
       SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion',
           stage_status = 'pending', status = 'ready'
       WHERE id = ?`,
      [JSON.stringify(extractionData), JSON.stringify(curationData), item.id],
    );
    return { batch, item, curationData };
  }

  it('should successfully build product drafts and promote them to a change set', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo A',
      fileName: 'promo.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Awesome Running Shoes',
      brand: 'RunningCo',
      description: 'Extremely lightweight running shoes.',
      bulletPoints: ['Lightweight', 'Breathable'],
      primaryImage: 'products/123456123456/images/primary.jpg',
      additionalImages: [],
      price: '89.99',
      weight: '12 oz',
      dimensions: null,
      seoFileName: 'awesome-running-shoes',
      searchKeywords: 'running shoes lightweight',
      sourceUrl: 'https://runningco.com/shoes',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' },
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {}
    });

    const items = insertItems(batch.id, [{
      upc: '123456123456',
      name: 'Running Shoes',
      price: '89.99',
      rowNumber: 2
    }]);

    const item = items[0];
    
    // Save extraction data, set curation_data with pages, advance to promotion stage
    const curationData = {
      curatedTitle: 'Awesome Running Shoes',
      titleSource: 'web',
      suggestedPages: ['Shoes', 'Running Gear'],
      suggestedProductType: 'Footwear',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    // Create existing product file with brand set (simulates a prior promotion)
    const productFileDir = path.join(tempWorkspaceDir, 'products');
    mkdirSync(productFileDir, { recursive: true });
    const existingProduct = {
      schemaVersion: 1,
      id: 'test-id-1',
      sku: '123456123456',
      status: 'draft',
      core: { name: 'Awesome Running Shoes', price: '89.99', salePrice: null, description: 'Extremely lightweight running shoes.', inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null }, availability: null, weight: '12 oz', taxable: true, media: { primary: 'products/123456123456/images/primary.jpg', additional: [] }, seo: { fileName: 'awesome-running-shoes', searchKeywords: 'running shoes lightweight', googleProductCategory: null } },
      customFields: { ProductField16: 'RunningCo' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };
    writeFileSync(path.join(productFileDir, '123456123456.json'), JSON.stringify(existingProduct));

    seedAcceptedCategoryProposal(db, '123456123456', 'Shoes');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.changeSetId).toBeDefined();

    // Check Change Sets
    const csList = listChangeSets(wsId);
    expect(csList.length).toBe(1);
    expect(csList[0].id).toBe(promoteRes.changeSetId);
    expect(csList[0].title).toContain('Onboarding: Onboard Promo A');

    // Check Change Set Items
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    expect(csItems.length).toBe(1);
    expect(csItems[0].sku).toBe('123456123456');
    // Pre-existing product file causes an 'update' operation
    expect(csItems[0].operation).toBe('update');

    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.sku).toBe('123456123456');
    expect(draftProduct.core.name).toBe('Awesome Running Shoes');
    expect(draftProduct.core.price).toBe('89.99');
    expect(draftProduct.core.media.primary).toBe('products/123456123456/images/primary.jpg');
  });

  it('should strictly use spreadsheet price and ignore extraction price', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo B',
      fileName: 'promo2.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Premium Dog Food',
      brand: 'DogCo',
      description: 'Healthy dog food.',
      bulletPoints: [],
      primaryImage: null,
      additionalImages: [],
      price: '19.99', // extracted price
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://dogco.com/food',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '987654321098',
      name: 'Dog Food',
      price: '24.99', // spreadsheet price (different from extraction!)
      rowNumber: 2
    }]);

    const item = items[0];
    
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      item.id
    );

    // Add mandatory fields: primary image, brand in customFields, pages
    const curationData = {
      curatedTitle: 'Premium Dog Food',
      titleSource: 'web',
      suggestedPages: ['Dog Food'],
      suggestedProductType: 'Food',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };
    const db2 = getDb();
    db2.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify({ ...extractionData, primaryImage: 'products/987654321098/images/primary.jpg' }),
      JSON.stringify(curationData),
      item.id
    );

    // Create an existing product file with brand set (simulates a prior promotion)
    const productFileDir = path.join(tempWorkspaceDir, 'products');
    mkdirSync(productFileDir, { recursive: true });
    const existingProduct = {
      schemaVersion: 1,
      id: 'test-id-2',
      sku: '987654321098',
      status: 'draft',
      core: { name: 'Premium Dog Food', price: '24.99', salePrice: null, description: 'Healthy dog food.', inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null }, availability: null, weight: null, taxable: true, media: { primary: 'products/987654321098/images/primary.jpg', additional: [] }, seo: { fileName: null, searchKeywords: null, googleProductCategory: null } },
      customFields: { ProductField16: 'DogCo' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };
    writeFileSync(path.join(productFileDir, '987654321098.json'), JSON.stringify(existingProduct));

    seedAcceptedCategoryProposal(db2, '987654321098', 'Dog Food');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const itemMatch = csItems.find(ci => ci.sku === '987654321098');
    expect(itemMatch).toBeDefined();

    const draftProduct = JSON.parse(itemMatch!.draftJson);
    expect(draftProduct.core.price).toBe('24.99'); // Should be spreadsheet price, not extracted price!
  });

  it('should clean price strings by removing dollar signs and commas', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo C',
      fileName: 'promo3.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Premium Cat Food',
      brand: 'CatCo',
      description: 'Healthy cat food.',
      bulletPoints: [],
      primaryImage: 'products/888888888888/images/primary.jpg',
      additionalImages: [],
      price: null,
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://catco.com/food',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '888888888888',
      name: 'Cat Food',
      price: '$19,999.95', // Dirty price format
      brandHint: 'CatCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Premium Cat Food',
      titleSource: 'web',
      suggestedPages: ['Cat Food'],
      suggestedProductType: 'Food',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    seedAcceptedCategoryProposal(db, '888888888888', 'Cat Food');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.price).toBe('19999.95'); // cleaned price
  });

  it('should fall back to extraction data price if item price is empty', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo D',
      fileName: 'promo4.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Premium Dog Treat',
      brand: 'DogCo',
      description: 'Tasty treat.',
      bulletPoints: [],
      primaryImage: 'products/777777777777/images/primary.jpg',
      additionalImages: [],
      price: '$12.50', // extracted price (dirty format)
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://dogco.com/treat',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '777777777777',
      name: 'Dog Treat',
      price: null, // empty in spreadsheet
      brandHint: 'DogCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Premium Dog Treat',
      titleSource: 'web',
      suggestedPages: ['Dog Treats'],
      suggestedProductType: 'Treat',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    seedAcceptedCategoryProposal(db, '777777777777', 'Dog Treats');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.price).toBe('12.50'); // fallback to cleaned extracted price
  });

  it('should mark items as failed on missing mandatory fields and return failures list', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo E',
      fileName: 'promo5.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Missing Details Product',
      brand: null, // missing brand
      description: null,
      bulletPoints: [],
      primaryImage: null, // missing primary image
      additionalImages: [],
      price: null, // missing price
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://missing.com/item',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '555555555555',
      name: 'Incomplete Item',
      price: null, // missing price
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'Incomplete Item',
      titleSource: 'web',
      suggestedPages: [], // missing pages
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    seedAcceptedCategoryProposal(db, '555555555555', 'Some Page');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].itemId).toBe(item.id);
    expect(promoteRes.failures[0].error).toContain('Missing mandatory fields');

    // Verify in db that stage_status is failed and has error_message
    const updatedRow = db.query('SELECT stage_status, error_message FROM onboarding_items WHERE id = ?').get(item.id) as { stage_status: string; error_message: string };
    expect(updatedRow.stage_status).toBe('failed');
    expect(updatedRow.error_message).toContain('Missing mandatory fields');
  });

  it('should set ProductField1 to new{todaysDate} in MMDDYY format on new product promotion', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo F',
      fileName: 'promo6.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'New Animal Toy',
      brand: 'ToyCo',
      description: 'Brand new toy.',
      bulletPoints: [],
      primaryImage: 'products/444444444444/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '444444444444',
      name: 'New Animal Toy',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'New Animal Toy',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: 'Toy',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    seedAcceptedCategoryProposal(db, '444444444444', 'Toys');

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.failures.length).toBe(0);

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    
    // Format today's date in MMDDYY format
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const expectedField1Value = `new${mm}${dd}${yy}`;
    
    expect(draftProduct.customFields['ProductField1']).toBe(expectedField1Value);
  });

  it('routes Brand to the mapped catalog slot instead of hardcoded ProductField16 (#142)', async () => {
    const db = getDb();
    seedAttributeMapping(db, 'brand', 'ProductField12');
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Brand Slot',
      fileName: 'brand-slot.xlsx',
      totalItems: 1
    });
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Mapped Brand Toy',
      brand: 'SlotCo',
      description: 'Brand slot routing test.',
      bulletPoints: [],
      primaryImage: 'products/445544554455/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://slotco.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });
    const items = insertItems(batch.id, [{
      upc: '445544554455',
      name: 'Mapped Brand Toy',
      price: '$9.99',
      brandHint: 'SlotCo',
      rowNumber: 1
    }]);
    const item = items[0];
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({
        curatedTitle: 'Mapped Brand Toy',
        titleSource: 'web',
        suggestedPages: ['Toys'],
        suggestedProductType: 'Toy',
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
      }),
      item.id
    );
    seedAcceptedCategoryProposal(db, '445544554455', 'Brand Slot Toys');
    seedApproved(item.id, batch.id);
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.failures).toHaveLength(0);
    expect(promoteRes.count).toBe(1);
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.customFields['ProductField12']).toBe('SlotCo');
    expect(draftProduct.customFields['ProductField16']).toBeUndefined();
    db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ? AND id = ?', [wsId, 'map-brand']);
  });

  it('routes the new-arrival date tag to the mapped catalog slot instead of hardcoded ProductField1 (#142)', async () => {
    const db = getDb();
    seedAttributeMapping(db, 'arrival_date', 'ProductField7');
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Date Slot',
      fileName: 'date-slot.xlsx',
      totalItems: 1
    });
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Mapped Date Toy',
      brand: 'DateCo',
      description: 'Date slot routing test.',
      bulletPoints: [],
      primaryImage: 'products/446644664466/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://dateco.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });
    const items = insertItems(batch.id, [{
      upc: '446644664466',
      name: 'Mapped Date Toy',
      price: '$9.99',
      brandHint: 'DateCo',
      rowNumber: 1
    }]);
    const item = items[0];
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({
        curatedTitle: 'Mapped Date Toy',
        titleSource: 'web',
        suggestedPages: ['Toys'],
        suggestedProductType: 'Toy',
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
      }),
      item.id
    );
    seedAcceptedCategoryProposal(db, '446644664466', 'Date Slot Toys');
    seedApproved(item.id, batch.id);
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.failures).toHaveLength(0);
    expect(promoteRes.count).toBe(1);
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    expect(draftProduct.customFields['ProductField7']).toBe(`new${mm}${dd}${yy}`);
    expect(draftProduct.customFields['ProductField1']).toBeUndefined();
    db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ? AND id = ?', [wsId, 'map-arrival_date']);
  });

  it('writes verified Category Page assignments to first-class core.productOnPages (#142)', async () => {
    const db = getDb();
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard First Class Pages',
      fileName: 'first-class-pages.xlsx',
      totalItems: 1
    });
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'First Class Pages Toy',
      brand: 'PageCo',
      description: 'First-class pages test.',
      bulletPoints: [],
      primaryImage: 'products/447744774477/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://pageco.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });
    const items = insertItems(batch.id, [{
      upc: '447744774477',
      name: 'First Class Pages Toy',
      price: '$9.99',
      brandHint: 'PageCo',
      rowNumber: 1
    }]);
    const item = items[0];
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({
        curatedTitle: 'First Class Pages Toy',
        titleSource: 'web',
        suggestedPages: ['Toys'],
        suggestedProductType: 'Toy',
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
      }),
      item.id
    );
    seedAcceptedCategoryProposal(db, '447744774477', 'First Class Toys');
    seedApproved(item.id, batch.id);
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.failures).toHaveLength(0);
    expect(promoteRes.count).toBe(1);
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.productOnPages).toEqual(['First Class Toys']);
    expect(draftProduct.shopsite.preserved.unknownElements.ProductOnPages).toBeUndefined();
  });

  it('promotes MULTIPLE verified pages to core.productOnPages in order (#142)', async () => {
    const db = getDb();
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Multi Pages',
      fileName: 'multi-pages.xlsx',
      totalItems: 1
    });
    const sku = '448844884488';
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Multi Pages Toy',
      brand: 'MultiCo',
      description: 'Multi-page promotion test.',
      bulletPoints: [],
      primaryImage: `products/${sku}/images/primary.jpg`,
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://multico.com/toy',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });
    const items = insertItems(batch.id, [{
      upc: sku,
      name: 'Multi Pages Toy',
      price: '$9.99',
      brandHint: 'MultiCo',
      rowNumber: 1
    }]);
    const item = items[0];
    const runId = `run-${sku}`;
    const now = new Date().toISOString();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({
        curatedTitle: 'Multi Pages Toy',
        titleSource: 'web',
        suggestedPages: ['Toys'],
        suggestedProductType: 'Toy',
        curatedAt: now,
        curationMethod: 'auto',
        classificationRunId: runId,
      }),
      item.id
    );
    // ONE active import carrying BOTH verified pages — sequential
    // single-page activations would supersede each other (only the latest
    // import is active), leaving the first proposal unverified.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: createHash('sha256').update('multi-pages-import').digest('hex'),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid' as const, key: 'guid-multi-a', status: 'verified' as const }, name: 'Multi Toys A', parentRef: null, availability: 'available' as const },
        { identity: { kind: 'exported_guid' as const, key: 'guid-multi-b', status: 'verified' as const }, name: 'Multi Toys B', parentRef: null, availability: 'available' as const },
      ],
      activatedBy: 'test',
    });
    const pageA = listVerifiedPageOptions(wsId).find(p => p.name === 'Multi Toys A');
    const pageB = listVerifiedPageOptions(wsId).find(p => p.name === 'Multi Toys B');
    expect(pageA).toBeDefined();
    expect(pageB).toBeDefined();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [runId, wsId, item.id, sku, 'completed', now]
    );
    for (const page of [{ id: pageA!.id, name: 'Multi Toys A' }, { id: pageB!.id, name: 'Multi Toys B' }]) {
      const proposalId = `prop-${sku}-${page.name.replace(/\s+/g, '-').toLowerCase()}`;
      db.run(
        `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [proposalId, runId, sku, 'category_page', page.id, JSON.stringify({ pageId: page.id, pageName: page.name }), 1.0, 'accepted', now]
      );
      db.run(
        `INSERT OR IGNORE INTO classification_proposal_decisions
         (id, proposal_id, decision, decision_key, created_at)
         VALUES (?, ?, 'accepted', ?, ?)`,
        [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now]
      );
    }
    seedApproved(item.id, batch.id);
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.failures).toHaveLength(0);
    expect(promoteRes.count).toBe(1);
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    const draftProduct = JSON.parse(csItems[0].draftJson);
    expect(draftProduct.core.productOnPages).toEqual(['Multi Toys A', 'Multi Toys B']);
  });

  it('falls back to ProductField16 when the brand mapping is stale (#142)', async () => {
    const db = getDb();
    seedAttributeMapping(db, 'brand', 'ProductField12', 1);
    try {
      const batch = createBatch({
        workspaceId: wsId,
        name: 'Onboard Stale Brand Slot',
        fileName: 'stale-brand-slot.xlsx',
        totalItems: 1
      });
      const sku = '449944994499';
      const extractionData: ExtractionData = ExtractionDataSchema.parse({
        title: 'Stale Brand Toy',
        brand: 'StaleCo',
        description: 'Stale mapping fallback test.',
        bulletPoints: [],
        primaryImage: `products/${sku}/images/primary.jpg`,
        additionalImages: [],
        price: '$9.99',
        weight: null,
        dimensions: null,
        seoFileName: null,
        searchKeywords: null,
        packagingTitle: null,
        packagingOcrData: null,
        customFields: {},
        sourceUrl: 'https://staleco.com/toy',
        confidence: 0.9,
        fieldProvenance: { title: 'json-ld' }
      });
      const items = insertItems(batch.id, [{
        upc: sku,
        name: 'Stale Brand Toy',
        price: '$9.99',
        brandHint: 'StaleCo',
        rowNumber: 1
      }]);
      const item = items[0];
      db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
        JSON.stringify(extractionData),
        JSON.stringify({
          curatedTitle: 'Stale Brand Toy',
          titleSource: 'web',
          suggestedPages: ['Toys'],
          suggestedProductType: 'Toy',
          curatedAt: new Date().toISOString(),
          curationMethod: 'auto',
        }),
        item.id
      );
      seedAcceptedCategoryProposal(db, sku, 'Stale Brand Toys');
      seedApproved(item.id, batch.id);
      const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
      expect(promoteRes.failures).toHaveLength(0);
      expect(promoteRes.count).toBe(1);
      const csItems = listChangeSetItems(promoteRes.changeSetId!);
      const draftProduct = JSON.parse(csItems[0].draftJson);
      expect(draftProduct.customFields['ProductField16']).toBe('StaleCo');
      expect(draftProduct.customFields['ProductField12']).toBeUndefined();
    } finally {
      db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ? AND id = ?', [wsId, 'map-brand']);
    }
  });

  it('falls back to ProductField1 when the arrival-date mapping is empty (#142)', async () => {
    const db = getDb();
    seedAttributeMapping(db, 'arrival_date', '   ');
    try {
      const batch = createBatch({
        workspaceId: wsId,
        name: 'Onboard Empty Date Slot',
        fileName: 'empty-date-slot.xlsx',
        totalItems: 1
      });
      const sku = '450045004500';
      const extractionData: ExtractionData = ExtractionDataSchema.parse({
        title: 'Empty Date Toy',
        brand: 'DateCo',
        description: 'Empty mapping fallback test.',
        bulletPoints: [],
        primaryImage: `products/${sku}/images/primary.jpg`,
        additionalImages: [],
        price: '$9.99',
        weight: null,
        dimensions: null,
        seoFileName: null,
        searchKeywords: null,
        packagingTitle: null,
        packagingOcrData: null,
        customFields: {},
        sourceUrl: 'https://dateco.com/toy',
        confidence: 0.9,
        fieldProvenance: { title: 'json-ld' }
      });
      const items = insertItems(batch.id, [{
        upc: sku,
        name: 'Empty Date Toy',
        price: '$9.99',
        brandHint: 'DateCo',
        rowNumber: 1
      }]);
      const item = items[0];
      db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
        JSON.stringify(extractionData),
        JSON.stringify({
          curatedTitle: 'Empty Date Toy',
          titleSource: 'web',
          suggestedPages: ['Toys'],
          suggestedProductType: 'Toy',
          curatedAt: new Date().toISOString(),
          curationMethod: 'auto',
        }),
        item.id
      );
      seedAcceptedCategoryProposal(db, sku, 'Empty Date Toys');
      seedApproved(item.id, batch.id);
      const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
      expect(promoteRes.failures).toHaveLength(0);
      expect(promoteRes.count).toBe(1);
      const csItems = listChangeSetItems(promoteRes.changeSetId!);
      const draftProduct = JSON.parse(csItems[0].draftJson);
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yy = String(d.getFullYear()).slice(-2);
      expect(draftProduct.customFields['ProductField1']).toBe(`new${mm}${dd}${yy}`);
    } finally {
      db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ? AND id = ?', [wsId, 'map-arrival_date']);
    }
  });

  it('should fail promotion if no accepted category proposals exist', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo Fail',
      fileName: 'promo_fail.xlsx',
      totalItems: 1
    });

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'No Proposals Product',
      brand: 'ToyCo',
      description: 'Brand new toy.',
      bulletPoints: [],
      primaryImage: 'products/333333333333/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy-fail',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    });

    const items = insertItems(batch.id, [{
      upc: '333333333333',
      name: 'No Proposals Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 2
    }]);

    const item = items[0];
    const curationData = {
      curatedTitle: 'No Proposals Product',
      titleSource: 'web',
      suggestedPages: [],
      suggestedProductType: 'Toy',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

    const initialCsCount = listChangeSets(wsId).length;

    // We do NOT seed any accepted category proposals here.
        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].itemId).toBe(item.id);
    expect(promoteRes.failures[0].error).toContain('No accepted product page proposals or manual page assignments exist');
    expect(promoteRes.changeSetId).toBeNull();

    // Verify no change set was created in the database
    const csList = listChangeSets(wsId);
    expect(csList.length).toBe(initialCsCount);
  });

  it('does not leak accepted category proposals from a historical run', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Historical Proposal Isolation',
      fileName: 'historical-proposal.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [{
      upc: '222222222222',
      name: 'Active Run Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 1,
    }])[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Active Run Product',
      brand: 'ToyCo',
      description: 'A product whose old run must not leak.',
      bulletPoints: [],
      primaryImage: 'products/222222222222/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.example/active-run-product',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' },
    });
    const db = getDb();
    db.run(
      `UPDATE onboarding_items
       SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready'
       WHERE id = ?`,
      [JSON.stringify(extractionData), JSON.stringify({
        curatedTitle: 'Active Run Product',
        titleSource: 'web',
        suggestedPages: [],
        suggestedProductType: null,
        curatedAt: new Date().toISOString(),
        curationMethod: 'auto',
      }), item.id],
    );

    // Historical run has an accepted page proposal.
    seedAcceptedCategoryProposal(db, item.upc, 'Toys');

    // The item's current run has no accepted page proposal.
    const activeRunId = `active-run-${item.upc}`;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?)`,
      [activeRunId, wsId, item.id, item.upc, now, now],
    );
    const currentCuration = JSON.parse((db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(item.id) as { curation_data_json: string }).curation_data_json);
    currentCuration.classificationRunId = activeRunId;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(currentCuration),
      item.id,
    ]);

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('No accepted product page proposals');
  });

  it('fails promotion when only curationData.suggestedPages exist without accepted proposals or manual DB assignments', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Onboard Promo Fallback',
      fileName: 'promo_fallback.xlsx',
      totalItems: 1
    });

    const db = getDb();
    db.run(
      "INSERT OR IGNORE INTO page_index (id, name, file_name, parent_id, page_hash, last_synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ['toy-page-id', 'Toys', 'toys.html', null, 'hash', null, new Date().toISOString(), new Date().toISOString()]
    );

    const extractionData = {
      title: 'Manual Page Product',
      primaryImage: 'products/999999999999/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://toyco.com/toy-success',
      confidence: 0.9,
      fieldProvenance: { title: 'json-ld' }
    };

    const items = insertItems(batch.id, [{
      upc: '999999999999',
      name: 'Manual Page Product',
      price: '$9.99',
      brandHint: 'ToyCo',
      rowNumber: 3
    }]);

    const item = items[0];

    const curationData = {
      curatedTitle: 'Manual Page Product',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: 'Toy',
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };

    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify(curationData),
      item.id
    );

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('No accepted product page proposals');
  });

  it('promotes the reviewer-corrected Product Type target rather than prediction metadata', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Corrected Product Type',
      'TYPE-CORRECTED-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-type-corrected';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    const toysPageId = activateVerifiedPage('Toys', 'type-corrected');
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-type-corrected', ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
      [runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] }), now],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-page-corrected', ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      [runId, item.upc, toysPageId, JSON.stringify({ pageId: toysPageId, pageName: 'Toys' }), now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, revised_target_id,
        has_revised_target, decision_key, created_at)
       VALUES ('decision-type-corrected', 'proposal-type-corrected', 'accepted', ?,
               'cat-food-wet', 1, 'type-corrected-token', ?)`,
      [JSON.stringify({ productTypeId: 'cat-food-wet' }), now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-page-corrected', 'proposal-page-corrected', 'accepted', 'page-corrected-token', ?)`,
      [now],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const history = db.query(
      `SELECT event_json FROM classification_history_events
       WHERE product_sku = ? AND event_type = 'promotion'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(item.upc) as { event_json: string };
    expect(JSON.parse(history.event_json).acceptedProductType).toBe('cat-food-wet');
  });

  it('uses the shared Product Type rule for historical one-sided, clear, and conflicting decisions', async () => {
    const scenarios = [
      {
        suffix: 'value-only',
        revisedValueJson: JSON.stringify({ productTypeId: 'cat-food-wet' }),
        revisedTargetId: null,
        hasRevisedTarget: 0,
        expected: 'cat-food-wet',
      },
      {
        suffix: 'target-only',
        revisedValueJson: null,
        revisedTargetId: 'bird-food',
        hasRevisedTarget: 1,
        expected: 'bird-food',
      },
      {
        suffix: 'target-clear',
        revisedValueJson: null,
        revisedTargetId: null,
        hasRevisedTarget: 1,
        expected: null,
      },
      {
        suffix: 'conflicting-pair',
        revisedValueJson: JSON.stringify({ productTypeId: 'cat-food-wet' }),
        revisedTargetId: 'bird-food',
        hasRevisedTarget: 1,
        expected: 'bird-food',
      },
    ] as const;

    for (const scenario of scenarios) {
      const sku = `TYPE-HISTORY-${scenario.suffix.toUpperCase()}`;
      const { batch, item, curationData } = seedPromotionReadyItem(
        `Historical Product Type ${scenario.suffix}`,
        sku,
      );
      const db = getDb();
      const now = new Date().toISOString();
      const runId = `run-type-history-${scenario.suffix}`;
      const proposalId = `proposal-type-history-${scenario.suffix}`;
      db.run(
        `INSERT INTO classification_runs
         (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
         VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
        [runId, wsId, item.id, item.upc, now, now],
      );
      db.run(
        'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
        [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
      );
      db.run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
          confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
        [proposalId, runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] }), now],
      );
      const toysPageId = activateVerifiedPage('Toys', `history-${scenario.suffix}`);
      db.run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
          confidence, status, created_at)
         VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
        [`proposal-page-history-${scenario.suffix}`, runId, item.upc, toysPageId, JSON.stringify({ pageId: toysPageId, pageName: 'Toys' }), now],
      );
      db.run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, revised_value_json, revised_target_id,
          has_revised_target, decision_key, created_at)
         VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?)`,
        [
          `decision-type-history-${scenario.suffix}`,
          proposalId,
          scenario.revisedValueJson,
          scenario.revisedTargetId,
          scenario.hasRevisedTarget,
          `type-history-token-${scenario.suffix}`,
          now,
        ],
      );
      db.run(
        `INSERT INTO classification_proposal_decisions
         (id, proposal_id, decision, decision_key, created_at)
         VALUES (?, ?, 'accepted', ?, ?)`,
        [
          `decision-page-history-${scenario.suffix}`,
          `proposal-page-history-${scenario.suffix}`,
          `page-history-token-${scenario.suffix}`,
          now,
        ],
      );

            seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
      expect(result.failures).toHaveLength(0);
      expect(result.count).toBe(1);
      const history = db.query(
        `SELECT event_json FROM classification_history_events
         WHERE product_sku = ? AND event_type = 'promotion'
         ORDER BY created_at DESC LIMIT 1`,
      ).get(item.upc) as { event_json: string };
      expect(JSON.parse(history.event_json).acceptedProductType).toBe(scenario.expected);
    }
  });

  it('fails promotion when the persisted classification run belongs to another onboarding item', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Foreign Product Type Run',
      'TYPE-FOREIGN-001',
    );
    const [foreignItem] = insertItems(batch.id, [{
      upc: 'TYPE-FOREIGN-HOLDER',
      name: 'Foreign holder',
      rowNumber: 2,
    }]);
    const db = getDb();
    const now = new Date().toISOString();
    seedAcceptedCategoryProposal(db, item.upc, 'Toys');
    const toysId = listVerifiedPageOptions(wsId).find(p => p.name === 'Toys')!.id;
    assignProductToPageId(item.upc, toysId, 'Toys');
    const runId = 'run-type-foreign';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, foreignItem.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('proposal-type-foreign', ?, ?, 'primary_product_type', 'dog-food-dry', ?, 0.9, 'accepted', ?)`,
      [runId, item.upc, JSON.stringify({ productTypeId: 'dog-food-dry' }), now],
    );

    // A present run pointer that fails ownership validation blocks promotion
    // entirely — it never downgrades to a legacy branch.
        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.count).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('Invalid classification run pointer');
  });

  it('resolves brand from product title when brandHint is missing', async () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Insert cached brand into classification_brands
    db.run(
      `INSERT OR REPLACE INTO classification_brands
       (id, workspace_id, name, aliases_json, created_at, updated_at)
       VALUES ('brand-greenies', ?, 'Greenies', ?, ?, ?)`,
      [wsId, JSON.stringify(['Feline Greenies']), now, now],
    );

    const batch = createBatch({
      workspaceId: wsId,
      name: 'Missing Brand Batch',
      fileName: 'missing-brand.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{
      upc: 'GREENIES-001',
      name: 'FELINE GREENIES TUNA 9.75OZ',
      price: '$12.99',
      brandHint: null,
      rowNumber: 1,
    }]);

    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'FELINE GREENIES TUNA 9.75OZ',
      brand: null,
      description: 'Tasty cat treats.',
      bulletPoints: [],
      primaryImage: 'products/GREENIES-001/images/primary.jpg',
      additionalImages: [],
      price: '$12.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
    });

    db.run(
      'UPDATE onboarding_items SET stage = ?, stage_status = ?, extraction_data_json = ? WHERE id = ?',
      ['promotion', 'pending', JSON.stringify(extractionData), item.id],
    );

    seedAcceptedCategoryProposal(db, item.upc, 'Cat Treats');

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);

    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };

    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields.ProductField16).toBe('Greenies');
  });

  it('applies nothing when an active run has only deferred proposals', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Deferred Only',
      'DEFERRED-ONLY-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-deferred-only';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Deferred field proposal with a live deferred decision — never promoted.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-deferred-field', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'deferred', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-deferred-field', 'prop-deferred-field', 'deferred', 'deferred-token', ?)`,
      [now],
    );
    // Accepted page proposal with a live accepted decision.
    seedAcceptedCategoryProposal(db, item.upc, 'Dog Food', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    // The AI-suggested deferred field value must not be serialized.
    expect(draft.customFields['ProductField23']).toBeUndefined();
  });

  it('serializes only accepted proposals when an active run mixes accepted and deferred', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Mixed Decisions',
      'MIXED-DEC-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-mixed-dec';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Deferred flavor proposal.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-mixed-deferred', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'deferred', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('decision-mixed-deferred', 'prop-mixed-deferred', 'deferred', 'mixed-deferred-token', ?)`,
      [now],
    );
    // Accepted flavor proposal with revised value.
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-mixed-accepted', ?, ?, 'field_assignment', 'flavor', '"AI Guess"', 0.8, 'accepted', ?)`,
      [runId, item.upc, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, decision_key, created_at)
       VALUES ('decision-mixed-accepted', 'prop-mixed-accepted', 'accepted', '"Salmon"', 'mixed-accepted-token', ?)`,
      [now],
    );
    seedAcceptedCategoryProposal(db, item.upc, 'Cat Food', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBe('Salmon');
  });

  it('excludes an accepted-status proposal without a live accepted decision', async () => {
    const { batch, item, curationData } = seedPromotionReadyItem(
      'Spoofed Accepted',
      'SPOOF-ACC-001',
    );
    const db = getDb();
    const now = new Date().toISOString();
    const runId = 'run-spoof-accepted';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, item.id, item.upc, now, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ ...curationData, classificationRunId: runId }), item.id],
    );
    // Proposal status says accepted but no decision row exists (spoofed).
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
        confidence, status, created_at)
       VALUES ('prop-spoof', ?, ?, 'field_assignment', 'flavor', '"Spoof"', 0.9, 'accepted', ?)`,
      [runId, item.upc, now],
    );
    // The page proposal is a genuine accepted decision so the rest of the draft proceeds.
    seedAcceptedCategoryProposal(db, item.upc, 'Dog Treats', runId);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBeUndefined();
  });

  it('promotes legacy embedded proposals only when status is exactly accepted', async () => {
    const { batch, item } = seedPromotionReadyItem(
      'Legacy Embedded',
      'LEGACY-EMB-001',
    );
    const db = getDb();
    const legacyToysPageId = activateVerifiedPage('Toys', 'legacy-emb');
    // No classificationRunId — a genuine legacy item. Embedded proposals in the
    // curation JSON are the only classification input.
    const legacyProposals = [
      {
        id: 'legacy-acc',
        proposalType: 'field_assignment',
        targetId: 'flavor',
        proposedValue: 'Beef',
        status: 'accepted',
      },
      {
        id: 'legacy-pending',
        proposalType: 'field_assignment',
        targetId: 'species',
        proposedValue: 'Dog',
        status: 'pending',
      },
      {
        id: 'legacy-rejected',
        proposalType: 'field_assignment',
        targetId: 'life_stage',
        proposedValue: 'Puppy',
        status: 'rejected',
      },
      {
        id: 'legacy-stale',
        proposalType: 'field_assignment',
        targetId: 'food_form',
        proposedValue: 'Kibble',
        status: 'stale',
      },
      {
        id: 'legacy-deferred',
        proposalType: 'field_assignment',
        targetId: 'health_benefits',
        proposedValue: 'Joint',
        status: 'deferred',
      },
      {
        id: 'legacy-page',
        proposalType: 'category_page',
        targetId: 'Toys',
        proposedValue: { pageId: legacyToysPageId, pageName: 'Toys' },
        status: 'accepted',
      },
    ];
    const curation = db.query(
      'SELECT curation_data_json FROM onboarding_items WHERE id = ?',
    ).get(item.id) as { curation_data_json: string };
    const parsed = JSON.parse(curation.curation_data_json);
    parsed.classificationProposals = legacyProposals;
    parsed.classificationRunId = null;
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify(parsed),
      item.id,
    ]);
    seedAttributeMapping(db, 'flavor', 'ProductField23');

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      `SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1`,
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    expect(draft.customFields['ProductField23']).toBe('Beef');
    // None of the pending/rejected/stale/deferred embedded proposals may appear.
    expect(draft.customFields['ProductField17']).toBeUndefined();
    expect(draft.customFields['ProductField18']).toBeUndefined();
    expect(draft.customFields['ProductField22']).toBeUndefined();
    expect(draft.customFields['ProductField21']).toBeUndefined();
  });

  it('promotes an accepted category page proposal whose identity is verified in the ACTIVE import', async () => {
    // Create an ACTIVE verified import so verifiedPageIds is non-empty.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: 'a'.repeat(64),
      parserFormatVersion: 'pages-xml-1',
      records: [
        { identity: { kind: 'exported_guid', key: 'vf', status: 'verified' }, name: 'Verified Food', parentRef: null, availability: 'available' },
      ],
      activatedBy: 'test',
    });
    const verifiedRows = listVerifiedPageOptions(wsId);
    const verifiedFood = verifiedRows.find(r => r.name === 'Verified Food');
    expect(verifiedFood).toBeDefined();

    const batch = createBatch({ workspaceId: wsId, name: 'Verified Pages', fileName: 'vp.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000001', name: 'Verified Product', price: '$5.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Verified Product',
      brand: 'Test Brand',
      description: 'Promotion verified-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000001/images/primary.jpg',
      additionalImages: [],
      price: '$5.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000001`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Verified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    // Seed a run + accepted category_page proposal referencing the REAL
    // verified page_index row id and the display name.
    const runId = 'run-verified-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Verified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-verified-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      [proposalId, runId, item.upc, verifiedFood!.id, JSON.stringify({ pageId: verifiedFood!.id, pageName: 'Verified Food' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    // The verified page must be written to first-class core.productOnPages
    // (the codec serializes it to ProductOnPages XML at export).
    expect(draft.core.productOnPages).toEqual(['Verified Food']);
    expect(draft.shopsite.preserved.unknownElements.ProductOnPages).toBeUndefined();
  });

  it('BLOCKS promotion when the only accepted page proposal is NOT in the active import (fail-closed page gate)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Unverified Pages', fileName: 'up.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000002', name: 'Unverified Product', price: '$6.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Unverified Product',
      brand: 'Test Brand',
      description: 'Promotion unverified-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000002/images/primary.jpg',
      additionalImages: [],
      price: '$6.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000002`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Unverified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    const runId = 'run-unverified-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Unverified Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-unverified-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      // pageId 'bogus-not-in-import' is not among the active import's verified rows.
      [proposalId, runId, item.upc, 'bogus-not-in-import', JSON.stringify({ pageId: 'bogus-not-in-import', pageName: 'Bogus Page' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    // Fail closed: an unverified page identity can NEVER promote — e09 B3
    // (P11) refuses the item at the promotion gate BEFORE any draft write
    // (previously it reached the mandatory Pages gate and failed there; the
    // item is still blocked, now earlier and with the Page-specific reason).
    expect(result.failures).toHaveLength(1);
    expect(result.count).toBe(0);
    expect(result.failures[0].error).toContain('does not resolve into the active verified Page import');
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string } | null;
    expect(changeSetItem).toBeNull();
  });

  it('BLOCKS promotion when the only page input is an unverified/name-only manual DB row (fail-closed page gate)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'NameOnly Pages', fileName: 'np2.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000004', name: 'NameOnly Product', price: '$8.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'NameOnly Product',
      brand: 'Test Brand',
      description: 'Promotion name-only manual row test.',
      bulletPoints: [],
      primaryImage: 'products/999000000004/images/primary.jpg',
      additionalImages: [],
      price: '$8.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000004`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'NameOnly Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );
    // Name-only manual assignment: no pageId (or an unverified one) — it must
    // never satisfy the mandatory Pages gate.
    db.run(
      'INSERT INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, NULL, ?)',
      [item.upc, 'Legacy Name-Only Row', new Date().toISOString()],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(result.failures).toHaveLength(1);
    expect(result.count).toBe(0);
    expect(result.failures[0].error).toContain('No verified page assignments exist');
  });

  it('REFUSES promotion when a MIXED verified + unverified accepted set exists — P11 fails the item closed before any draft write', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Mixed Pages', fileName: 'mx.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000005', name: 'Mixed Product', price: '$9.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Mixed Product',
      brand: 'Test Brand',
      description: 'Promotion mixed verified/unverified test.',
      bulletPoints: [],
      primaryImage: 'products/999000000005/images/primary.jpg',
      additionalImages: [],
      price: '$9.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000005`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Mixed Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    seedAcceptedCategoryProposal(db, item.upc, 'Verified Only');
    // Second accepted proposal referencing a bogus (unverified) page.
    const now = new Date().toISOString();
    const runId = `run-${item.upc}`;
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      ['prop-mixed-bogus', runId, item.upc, 'bogus-mixed', JSON.stringify({ pageId: 'bogus-mixed', pageName: 'Bogus Mixed' }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      ['decision-mixed-bogus', 'prop-mixed-bogus', 'mixed-bogus-token', now],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    // e09 B3 (P11): an accepted category_page proposal whose identity does
    // not resolve into the active verified import refuses the WHOLE item
    // before any draft write — even when another accepted proposal IS
    // verified (no partial page sets may reach ProductOnPages).
    expect(result.failures).toHaveLength(1);
    expect(result.count).toBe(0);
    expect(result.failures[0].error).toContain('does not resolve into the active verified Page import');
    const changeSetItemAfterRefusal = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string } | null;
    expect(changeSetItemAfterRefusal).toBeNull();
  });

  it('resolves the verified page display name from the ACTIVE import when the proposal lacks one — never serializes the Page ID as a name', async () => {
    // Build a verified page in the active import, then seed an accepted
    // category_page proposal whose value carries only the stable Page ID
    // (no pageName). The Page ID must never be serialized as a page name.
    activatePageImportFromRecords({
      workspaceId: wsId,
      sourceHash: 'a'.repeat(64),
      parserFormatVersion: 'pages-xml-1',
      records: [{
        identity: { kind: 'exported_guid', key: 'nameless-1', status: 'verified' },
        name: 'Nameless Page',
        parentRef: null,
        availability: 'available',
      }],
      activatedBy: 'test',
    });
    const verifiedRows = listVerifiedPageOptions(wsId);
    const verifiedNameless = verifiedRows.find(r => r.name === 'Nameless Page');
    expect(verifiedNameless).toBeDefined();

    const batch = createBatch({ workspaceId: wsId, name: 'Nameless Pages', fileName: 'np.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '999000000003', name: 'Nameless Product', price: '$7.00', rowNumber: 1, brandHint: 'Test Brand' }]);
    const item = items[0];
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Nameless Product',
      brand: 'Test Brand',
      description: 'Promotion nameless-page test.',
      bulletPoints: [],
      primaryImage: 'products/999000000003/images/primary.jpg',
      additionalImages: [],
      price: '$7.00',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: `https://example.test/999000000003`,
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const db = getDb();
    db.query("UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(
      JSON.stringify(extractionData),
      JSON.stringify({ curatedTitle: 'Nameless Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, curatedAt: new Date().toISOString(), curationMethod: 'auto' }),
      item.id,
    );

    const runId = 'run-nameless-page';
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO classification_runs
       (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, now],
    );
    db.run(
      'UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?',
      [JSON.stringify({ curatedTitle: 'Nameless Product', titleSource: 'web', suggestedPages: [], suggestedProductType: null, classificationRunId: runId, curatedAt: now, curationMethod: 'auto' }), item.id],
    );
    const proposalId = 'prop-nameless-page';
    db.run(
      `INSERT OR IGNORE INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`,
      // targetId is the stable Page ID; proposedValue lacks pageName on purpose.
      [proposalId, runId, item.upc, verifiedNameless!.id, JSON.stringify({ pageId: verifiedNameless!.id }), now],
    );
    db.run(
      `INSERT OR IGNORE INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [`decision-${proposalId}`, proposalId, `decision-token-${proposalId}`, now],
    );

        seedApproved(item.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    // A verified Page ID is a real assignment: the verified catalog is the
    // display-name authority, so the proposal resolves to the catalog name
    // even though the proposal value carried no pageName.
    expect(result.failures).toHaveLength(0);
    expect(result.count).toBe(1);
    const changeSetItem = db.query(
      'SELECT draft_json FROM change_set_items WHERE sku = ? LIMIT 1',
    ).get(item.upc) as { draft_json: string };
    const draft = JSON.parse(changeSetItem.draft_json);
    // The Page ID must never appear as a page name in first-class assignments.
    expect(draft.core.productOnPages).not.toContain(verifiedNameless!.id);
    // The verified catalog's display name IS assigned.
    expect(draft.core.productOnPages).toEqual(['Nameless Page']);
    expect(draft.shopsite?.preserved?.unknownElements?.ProductOnPages).toBeUndefined();
  });

  it('refuses a PR9-blocked member in the promotion stage PER-ITEM and promotes its siblings (PR11 C2 promotion gate)', async () => {
    const db = getDb();
    const batch = createBatch({
      workspaceId: wsId,
      name: 'PR11 Blocked Sibling',
      fileName: 'pr11-blocked.xlsx',
      totalItems: 2,
    });
    const items = insertItems(batch.id, [
      { upc: 'PR11-HEALTHY-001', name: 'Healthy Sibling', price: '$9.99', brandHint: 'Test Brand', rowNumber: 1 },
      { upc: 'PR11-BLOCKED-001', name: 'Blocked Member', price: '$9.99', brandHint: 'Test Brand', rowNumber: 2 },
    ]);
    const [healthy, blocked] = items;
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'PR11 Product',
      brand: 'Test Brand',
      description: 'PR11 gate promotion test.',
      bulletPoints: [],
      primaryImage: 'products/PR11-BLOCKED-001/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://example.test/pr11',
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const curation = {
      curatedTitle: 'PR11 Product',
      titleSource: 'web',
      suggestedPages: [],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
    };
    for (const item of items) {
      db.run(
        "UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?",
        [JSON.stringify(extractionData), JSON.stringify(curation), item.id],
      );
    }

    // Healthy sibling: a LEGACY item (no run pointer) with an embedded accepted
    // page proposal — the narrow legacy path must stay byte-identical. The
    // page import is activated LAST (each activation supersedes the prior
    // import, and the promoted sibling's page must be in the ACTIVE one).

    // Blocked member: a VALID run pointer + committed semanticValidation
    // blocked. The accepted verified page proposal proves the refusal comes
    // from the promotion gate, not the mandatory Pages gate.
    const now = new Date().toISOString();
    const runId = 'run-pr11-blocked';
    db.run(
      `INSERT INTO classification_runs
       (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, ?)`,
      [runId, wsId, blocked.id, blocked.upc, now, now],
    );
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify({
        ...curation,
        classificationRunId: runId,
        semanticValidation: {
          status: 'blocked',
          findings: [{
            code: 'family_brand',
            memberSku: blocked.upc,
            message: 'PR11 brand conflict: acme vs woof',
          }],
        },
      }),
      blocked.id,
    ]);
    seedAcceptedCategoryProposal(db, blocked.upc, 'Toys', runId);

    const legacyPageId = activateVerifiedPage('Toys', 'pr11-healthy');
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [
      JSON.stringify({
        ...curation,
        classificationRunId: null,
        classificationProposals: [{
          id: 'pr11-healthy-page',
          proposalType: 'category_page',
          targetId: 'Toys',
          proposedValue: { pageId: legacyPageId, pageName: 'Toys' },
          status: 'accepted',
        }],
      }),
      healthy.id,
    ]);

        seedApproved(healthy.id, batch.id);
    seedApproved(blocked.id, batch.id);
const result = await promoteItems(wsId, tempWorkspaceDir, batch.id, [healthy.id, blocked.id]);

    // Sibling promotes; the blocked member is refused per-item with the first
    // finding as the reason (200-shape failures list, sibling not aborted).
    expect(result.count).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].itemId).toBe(blocked.id);
    expect(result.failures[0].error).toBe('PR11 brand conflict: acme vs woof');

    const blockedRow = db.query(
      'SELECT stage_status, error_message FROM onboarding_items WHERE id = ?',
    ).get(blocked.id) as { stage_status: string; error_message: string };
    expect(blockedRow.stage_status).toBe('failed');
    expect(blockedRow.error_message).toBe('PR11 brand conflict: acme vs woof');

    const healthyRow = db.query(
      'SELECT stage_status FROM onboarding_items WHERE id = ?',
    ).get(healthy.id) as { stage_status: string };
    expect(healthyRow.stage_status).toBe('completed');

    // ZERO product draft rows for the refused member; the sibling's draft exists.
    const blockedDrafts = db.query(
      'SELECT COUNT(*) as c FROM change_set_items WHERE sku = ?',
    ).get(blocked.upc) as { c: number };
    expect(blockedDrafts.c).toBe(0);
    const healthyDrafts = db.query(
      'SELECT COUNT(*) as c FROM change_set_items WHERE sku = ?',
    ).get(healthy.upc) as { c: number };
    expect(healthyDrafts.c).toBe(1);
  });

// ─── Milestone E: promotion image boundary + distributor provenance gate ──────

/**
 * Seed an evidence attempt whose identityJson carries images. The Milestone E
 * fix deleted the `item_id OR lookup_upc` evidence query entirely, so NONE of
 * these marker images may reach the image downloader or the draft media —
 * regardless of acceptance, generation, or workspace.
 */
function seedAttemptWithImages(opts: {
  itemId: string;
  providerId?: string;
  upc: string;
  generationId?: string | null;
  images: string[];
}): string {
  const db = getDb();
  const id = `att-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO onboarding_evidence_attempts
      (id, item_id, provider_id, lookup_upc, outcome, confidence, evidence_url,
       matched_fields_json, identity_json, warnings_json, error_code, error_message,
       catalog_version, observed_at, sourcing_generation_id, duration_ms, created_at)
     VALUES (?, ?, ?, ?, 'found', 0.9, NULL, ?, ?, NULL, NULL, NULL, 'v2026.3', ?, ?, NULL, ?)`,
  ).run(
    id,
    opts.itemId,
    opts.providerId ?? 'phillips',
    opts.upc,
    JSON.stringify(['upc']),
    JSON.stringify({ upc: opts.upc, name: 'Product', images: opts.images }),
    now,
    opts.generationId ?? null,
    now,
  );
  return id;
}

describe('Milestone E — promotion image boundary (BLOCKER #1 closure)', () => {
  it('evidence-attempt images (same-item, stale-generation, same-UPC foreign) cause ZERO downloads and never reach the draft', async () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'ME Image Boundary',
      fileName: 'me-images.xlsx',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [{
      upc: '100000000001',
      name: 'Boundary Product',
      price: '$9.99',
      brandHint: 'Boundary Brand',
      rowNumber: 1,
    }]);
    const extractionData = ExtractionDataSchema.parse({
      title: 'Boundary Product',
      brand: 'Boundary Brand',
      description: 'Boundary description.',
      bulletPoints: [],
      primaryImage: 'products/100000000001/images/primary.jpg',
      additionalImages: [],
      price: '$9.99',
      weight: null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
      sourceUrl: 'https://boundary.example/100000000001',
      confidence: 0.9,
      fieldProvenance: { title: 'fixture' },
    });
    const curationData = {
      curatedTitle: 'Boundary Product',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO page_index
       (id, name, file_name, page_hash, created_at, updated_at)
       VALUES ('me-boundary-page', 'Toys', 'toys.html', 'me-boundary-hash', ?, ?)`,
      [now, now],
    );
    db.run(
      `UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion',
          stage_status = 'pending', status = 'ready', source_type = 'official_page'
       WHERE id = ?`,
      [JSON.stringify(extractionData), JSON.stringify(curationData), item.id],
    );

    // Evidence the OLD `item_id OR lookup_upc` query would have matched:
    const gen = startSourcingGeneration(item.id, 'automatic');
    // (a) same-item attempt with images
    seedAttemptWithImages({ itemId: item.id, upc: item.upc, generationId: gen.id, images: ['evidence/a.jpg'] });
    // (b) stale-generation attempt (old generation superseded)
    const staleGen = startSourcingGeneration(item.id, 'automatic');
    // supersede the current one so staleGen is NOT current
    db.query(`UPDATE sourcing_generations SET status = 'superseded' WHERE id = ?`).run(staleGen.id);
    seedAttemptWithImages({ itemId: item.id, upc: item.upc, generationId: staleGen.id, images: ['evidence/b.jpg'] });
    // (c) same-lookup-UPC attempt on a DIFFERENT item (the old `lookup_upc`
    // match would have pulled this item's images too). The foreign item has
    // its OWN UPC; only the attempt's lookup_upc equals the target's UPC.
    const foreignBatch = createBatch({ workspaceId: wsId, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
    const [foreignItem] = insertItems(foreignBatch.id, [{ upc: '300000000003', name: 'Foreign Item', rowNumber: 1 }]);
    seedAttemptWithImages({ itemId: foreignItem.id, upc: item.upc, images: ['evidence/c.jpg'] });

    seedAcceptedCategoryProposal(db, item.upc, 'Toys', `run-${item.upc}-${randomUUID().slice(0, 4)}`);

        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    expect(promoteRes.changeSetId).toBeDefined();

    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    expect(csItems.length).toBe(1);
    const draft = JSON.parse(csItems[0].draftJson);
    const media = draft.core?.media ?? {};
    // The ONLY image is the official extracted primary; no evidence marker
    // (evidence/a.jpg, evidence/b.jpg, evidence/c.jpg) anywhere.
    expect(media.primary).toBe('products/100000000001/images/primary.jpg');
    expect(media.additional ?? []).toEqual([]);
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain('evidence/a.jpg');
    expect(serialized).not.toContain('evidence/b.jpg');
    expect(serialized).not.toContain('evidence/c.jpg');
  });
});

describe('Milestone E — distributor promotion provenance gate (computePromotionGate)', () => {
  /**
   * Build a fully qualified distributor item at promotion/pending with a
   * durable materialized extraction row. Optional `merchandising` evidence
   * (description/features/category keys in the identity JSON) makes the v2
   * materialization merchandising-depth (Amendment B).
   */
  function seedQualifiedDistributorItem(options: {
    merchandising?: { description?: string; features?: string[]; category?: string };
    legacyV2?: boolean;
  } = {}): { item: { id: string; upc: string }; decision: SourcingDecisionV2 } {
    const sku = '200000000002';
    const batch = createBatch({ workspaceId: wsId, name: 'ME Distributor Gate', fileName: 'me-dist.xlsx', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: sku, name: 'Dist Product', price: '$14.99', rowNumber: 1 }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const db = getDb();
    const gen = startSourcingGeneration(item.id, 'automatic');
    const distId = `phillips-${randomUUID().slice(0, 4)}`;
    const dist = createDistributor({ id: distId, name: 'Phillips', status: 'active' });
    void dist;
    const conn = createConnection({ workspaceId: wsId, distributorId: distId, connectorType: 'api' });
    const identityJson = {
      upc: sku,
      name: 'Dist Product 5lb',
      brand: 'Dist Brand',
      weight: '5 lb',
      ...(options.merchandising?.description ? { description: options.merchandising.description } : {}),
      ...(options.merchandising?.features ? { features: options.merchandising.features } : {}),
      ...(options.merchandising?.category ? { category: options.merchandising.category } : {}),
    };
    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: sku,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc', 'name'],
      identityJson: JSON.stringify(identityJson),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
      durationMs: 12,
    });
    recordAcceptances(item.id, [attempt.id], 'system', 'test');
    const projection = buildDistributorRecordProjection({
      itemId: item.id,
      itemUpc: sku,
      sourcingGenerationId: gen.id,
      attempts: [attempt],
      acceptedAttemptIds: [attempt.id],
      declaredVariantAxes: [],
    });
    if (!projection.qualified) {
      throw new Error(`fixture must qualify: ${projection.reasonCodes.join(',')}`);
    }
    const decision: SourcingDecisionV2 = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      sourcingGenerationId: gen.id,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    };
    const routed = completeSourcingWithDecision(item.id, decision, 'collect_details');
    if (!routed.ok) throw new Error(`routing failed: ${routed.reason}`);
    // Claim + materialize (the durable distributor extraction row + item
    // payload — the canonical v2 payload the deep-compare gate re-verifies).
    updateItemStageStatus(item.id, 'in_progress');
    const materialized = materializeDistributorRecordExtraction(item.id, wsId);
    if (!materialized.ok) throw new Error(`materialization failed: ${materialized.code}`);
    if (options.legacyV2) {
      // Simulate a v2 row/item written before distributorReferenceValues was
      // introduced; promotion must accept and remain tamper-safe.
      const extractionRow = db.query('SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ?').get(item.id) as { extraction_data_json: string };
      const historical = JSON.parse(extractionRow.extraction_data_json) as Record<string, unknown>;
      delete historical.distributorReferenceValues;
      const historicalJson = JSON.stringify(historical);
      db.query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE item_id = ?').run(historicalJson, item.id);
      db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(historicalJson, item.id);
    }
    // Advance to promotion/pending with curation data + gate-ready proposals.
    // The materialized v2 payload is KEPT as-is (Amendment B M5b-2): the
    // deep-compare gate requires the item payload to equal the reconstructed
    // canonical payload, so an overwrite here would count as a tamper.
    const curationData = {
      curatedTitle: 'Dist Product',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: null,
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const now = new Date().toISOString();
    db.run(
      `INSERT OR IGNORE INTO page_index
       (id, name, file_name, page_hash, created_at, updated_at)
       VALUES ('me-dist-page', 'Toys', 'toys.html', 'me-dist-hash', ?, ?)`,
      [now, now],
    );
    db.run(
      `UPDATE onboarding_items SET curation_data_json = ?, stage = 'promotion',
          stage_status = 'pending', status = 'ready'
       WHERE id = ?`,
      [JSON.stringify(curationData), item.id],
    );
    seedAcceptedCategoryProposal(db, sku, 'Toys', `run-${sku}-${randomUUID().slice(0, 4)}`);
    return { item: { id: item.id, upc: sku }, decision };
  }

  it('a valid distributor materialization passes the promotion gate (identity-only drafts still block on the mandatory primary image)', async () => {
    const { item, decision } = seedQualifiedDistributorItem();
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    // The provenance gate PASSES (no 'Distributor promotion blocked' reason):
    // the item only fails the DRAFT builder's mandatory-image rule because
    // distributor extraction is identity-only (no commerce images yet — PI-6).
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).not.toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).toContain('Primary Image');
    void decision;
  });

  it('a historical v2 payload missing distributorReferenceValues remains promotable', async () => {
    const { item } = seedQualifiedDistributorItem({ legacyV2: true });
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
    seedApproved(item.id, batch.batch_id);
    const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).not.toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).not.toContain('materialization payload diverged');
  });

  it('a TAMPERED extraction evidence hash blocks promotion (stale materialization cannot draft)', async () => {
    const { item } = seedQualifiedDistributorItem();
    getDb().query(`UPDATE onboarding_extractions SET evidence_hash = ? WHERE item_id = ?`).run('b'.repeat(64), item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('hash mismatch');
  });

  it('a SUPERSEDED sourcing generation blocks promotion', async () => {
    const { item } = seedQualifiedDistributorItem();
    getDb().query(`UPDATE sourcing_generations SET status = 'superseded' WHERE item_id = ?`).run(item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('superseded');
  });

  it('a TAMPERED extraction-row source_type blocks promotion (Milestone E review)', async () => {
    const { item } = seedQualifiedDistributorItem();
    // The durable row no longer says distributor_record — the immutability of
    // the materialization is broken, so drafting must fail closed even though
    // generation + hash still match.
    getDb().query(`UPDATE onboarding_extractions SET source_type = 'official_page' WHERE item_id = ?`).run(item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('source type mismatch');
  });

  it('a TAMPERED extraction-row accepted-attempt column blocks promotion (Milestone E review)', async () => {
    const { item, decision } = seedQualifiedDistributorItem();
    // The durable accepted-attempt column diverges from the decision set — a
    // row whose materialization provenance was rewritten can never draft.
    getDb().query(`UPDATE onboarding_extractions SET accepted_evidence_attempt_ids_json = ? WHERE item_id = ?`).run(
      JSON.stringify([...decision.acceptedEvidenceAttemptIds, 'att-foreign']),
      item.id,
    );
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('accepted-evidence mismatch');
  });

  it('a distributor payload containing raw image URLs is BLOCKED at the gate by the M5b-2 deep-compare (item payload tamper)', async () => {
    const { item } = seedQualifiedDistributorItem();
    // Simulate a tampered/acquired item payload with raw distributor URLs:
    // the deep-compare gate now rejects ANY divergence from the
    // reconstructed canonical payload — image tampering blocks drafting
    // before the downloader is ever consulted (stronger than the Milestone E
    // downloader-only boundary).
    const row = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json);
    payload.primaryImage = 'https://evidence.example/primary.jpg';
    payload.additionalImages = ['https://evidence.example/alt1.jpg', 'https://evidence.example/alt2.jpg'];
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).toContain('item payload tampered');
    // No URL ever reaches a draft/change-set row.
    expect(promoteRes.failures[0].error).not.toContain('https://evidence.example');
  });

  it('a VERIFIED v2 distributor materialization with merchandising data passes the gate and its raw image candidates NEVER reach the downloader (M5b-2)', async () => {
    const { item } = seedQualifiedDistributorItem({
      merchandising: { description: 'Verified v2 description copy.', features: ['Feature A'], category: 'Dog Food' },
    });
    // The v2 payload carries distributorImageCandidates by contract (the
    // evidence has no image URLs here, so assert the gate + draft boundary
    // on the materialized payload: no primaryImage, no download, no fetch).
    const row = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, any>;
    expect(payload.distributorRecordProvenance.extractionMethod).toBe('distributor_record_v2');
    expect(payload.description).toBe('Verified v2 description copy.');
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
    seedAcceptedCategoryProposal(getDb(), item.upc, 'Dog Food', `run-v2-${randomUUID().slice(0, 6)}`);
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    // The provenance + deep-compare gate PASSES; with no image evidence in
    // this fixture there are no approvals, so the mandatory primary image
    // still blocks the draft (approved distributor images are the only path).
    expect(promoteRes.failures[0].error).not.toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).toContain('Primary Image');
  });

  it('a post-materialization DESCRIPTION tamper on the durable row blocks promotion (M5b-2 deep-compare)', async () => {
    const { item } = seedQualifiedDistributorItem({
      merchandising: { description: 'Original verified v2 description.' },
    });
    // Tamper the DURABLE row's extraction JSON description (the canonical
    // reconstructed payload still says the original).
    const row = getDb().query('SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ?').get(item.id) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, any>;
    payload.description = 'Post-materialization tampered description.';
    getDb().query('UPDATE onboarding_extractions SET extraction_data_json = ? WHERE item_id = ?').run(JSON.stringify(payload), item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).toContain('row tampered');
  });

  it('a post-materialization DESCRIPTION tamper on the item payload blocks promotion (M5b-2 deep-compare)', async () => {
    const { item } = seedQualifiedDistributorItem({
      merchandising: { description: 'Original verified v2 description.' },
    });
    // Tamper the ITEM payload description while the durable row stays intact.
    const row = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, any>;
    payload.description = 'Item-payload tampered description.';
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('Distributor promotion blocked');
    expect(promoteRes.failures[0].error).toContain('item payload tampered');
  });

  it('a v2 materialization with a PRICE tamper never drafts (deep-compare; price stays spreadsheet-only)', async () => {
    const { item } = seedQualifiedDistributorItem();
    const row = getDb().query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(item.id) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, any>;
    payload.price = '9.99';
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), item.id);
    const batch = getDb().query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.id) as { batch_id: string };
        seedApproved(item.id, batch.batch_id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.batch_id, [item.id]);
    expect(promoteRes.count).toBe(0);
    expect(promoteRes.failures.length).toBe(1);
    expect(promoteRes.failures[0].error).toContain('item payload tampered');
  });

  it('a reviewed Curation description wins over the extraction description in the drafted product (M5b-2 preference)', async () => {
    // Official-source item that CAN draft (relative-path image, no network):
    // the same draftDescription expression drives the preference for every
    // source. curatedDescription from Review must beat the extraction copy.
    const batch = createBatch({ workspaceId: wsId, name: 'M5b-2 desc pref', fileName: 'desc-pref.xlsx', totalItems: 1 });
    const extractionData: ExtractionData = ExtractionDataSchema.parse({
      title: 'Pref Product',
      brand: 'Pref Brand',
      description: 'Extraction description copy.',
      bulletPoints: [],
      primaryImage: 'products/599999999999/images/primary.jpg',
      additionalImages: [],
      price: '7.99',
      weight: '2 lb',
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      sourceUrl: 'https://example.test/pref',
      confidence: 0.9,
      fieldProvenance: {},
      packagingTitle: null,
      packagingOcrData: null,
      customFields: {},
    });
    const [item] = insertItems(batch.id, [{ upc: '599999999999', name: 'Pref Product', price: '7.99', rowNumber: 1 }]);
    const curationData = {
      curatedTitle: 'Pref Product',
      titleSource: 'web',
      suggestedPages: ['Toys'],
      suggestedProductType: null,
      curatedDescription: 'Reviewed curation copy.',
      curatedDescriptionSourceAttemptIds: ['att-1'],
      curatedAt: new Date().toISOString(),
      curationMethod: 'manual',
    };
    const db = getDb();
    db.query(
      "UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ?, stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?",
    ).run(JSON.stringify(extractionData), JSON.stringify(curationData), item.id);
    // Create the existing product file with brand + accepted page proposal.
    const productFileDir = path.join(tempWorkspaceDir, 'products');
    mkdirSync(productFileDir, { recursive: true });
    const existingProduct = {
      schemaVersion: 1,
      id: 'test-id-pref',
      sku: '599999999999',
      status: 'draft',
      core: { name: 'Pref Product', price: '7.99', salePrice: null, description: 'Extraction description copy.', inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null }, availability: null, weight: '2 lb', taxable: true, media: { primary: 'products/555555555555/images/primary.jpg', additional: [] }, seo: { fileName: null, searchKeywords: null, googleProductCategory: null } },
      customFields: { ProductField16: 'Pref Brand' },
      shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null },
    };
    writeFileSync(path.join(productFileDir, '599999999999.json'), JSON.stringify(existingProduct));
    seedAcceptedCategoryProposal(db, '599999999999', 'Toys');
        seedApproved(item.id, batch.id);
const promoteRes = await promoteItems(wsId, tempWorkspaceDir, batch.id, [item.id]);
    expect(promoteRes.count).toBe(1);
    // The drafted product uses the REVIEWED Curation description, not the
    // extraction copy.
    const csItems = listChangeSetItems(promoteRes.changeSetId!);
    expect(csItems.length).toBe(1);
    const drafted = JSON.parse(csItems[0].draftJson) as { core: { description: string } };
    expect(drafted.core.description).toBe('Reviewed curation copy.');
  });
});
});
