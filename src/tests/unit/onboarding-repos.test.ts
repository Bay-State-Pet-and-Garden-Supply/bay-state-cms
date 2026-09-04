import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createBatch,
  findBatchById,
  listBatches,
  setBatchArchived,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  listItemsByBatch,
  listItemsByBatchStaged,
  findItemById,
  updateItemStageStatus,
  advanceItemsToNextStage,
  getPendingItemsByStage,
  getStageCounts,
  skipItems,
  resetItemsToPending,
  completeReviewStage,
  completePromotionStage,
  setDiscoverySourceUrl,
  sendItemsToPreviousStage,
  claimItemsForProcessing,
  requeueStaleInProgressItems,
} from '../../db/repositories/onboarding-item-repo';
import {
  insertSources,
  listSourcesByItem,
  selectSource,
  getSelectedSource,
  listValidationSamplesByDomain,
} from '../../db/repositories/onboarding-source-repo';
import {
  insertExtraction,
  getLatestExtraction,
  getLatestExtractionBindingsByItemIds,
} from '../../db/repositories/onboarding-extraction-repo';
import { startSourcingGeneration, insertEvidenceAttempt, getEvidenceAttemptsByItemAndGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { computeExtractionHash } from '../../db/repositories/curation-cohort-repo';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import {
  upsertApiKey,
  getApiKey,
  listApiKeys
} from '../../db/repositories/api-key-repo';
import {
  upsertBrandSite,
  findBrandSites,
  updateBrandSiteDomain
} from '../../db/repositories/brand-site-repo';
import { validateSiblingConsistency } from '../../classification/consistency-validator';

describe('Onboarding Repositories CRUD', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'onboarding-test.db');
  const wsId = 'workspace-test-id';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Create a dummy workspace in DB to satisfy foreign keys
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', '/tmp/ws', '/tmp/ws/.git', now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should support batch and item CRUD operations', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Weekly Import A',
      fileName: 'weekly_import_a.xlsx',
      totalItems: 2,
    });

    expect(batch.id).toBeDefined();
    expect(batch.name).toBe('Weekly Import A');
    expect(batch.status).toBe('active');

    const items = insertItems(batch.id, [
      { upc: '111111111111', name: 'Product 1', price: '9.99', rowNumber: 2 },
      { upc: '222222222222', name: 'Product 2', price: '19.99', rowNumber: 3 }
    ]);

    expect(items.length).toBe(2);
    expect(items[0].upc).toBe('111111111111');
    // New items start in the caller-selected entry stage (Discovery while the
    // Sourcing engine capability is disabled) with pending status
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');

    const batchItems = listItemsByBatch(batch.id);
    expect(batchItems.length).toBe(2);

    // Use new stage-based status updates
    updateItemStageStatus(items[0].id, 'in_progress');
    const updatedItem = findItemById(items[0].id);
    expect(updatedItem?.stageStatus).toBe('in_progress');
    expect(updatedItem?.stage).toBe('discovery');

    const batchDetails = findBatchById(batch.id);
    expect(batchDetails).toBeDefined();

    // Batch lifecycle is now active/archived only
    setBatchArchived(batch.id, true);
    const archivedBatch = findBatchById(batch.id);
    expect(archivedBatch?.status).toBe('archived');
  });

  it('should support source discovery candidate CRUD operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch B', fileName: 'b.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '333333333333', name: 'Product 3', rowNumber: 2 }]);
    const item = items[0];

    const sources = insertSources(item.id, [
      { url: 'https://site1.com/p', title: 'Site 1 Product', confidence: 0.9, domain: 'site1.com' },
      { url: 'https://site2.com/p', title: 'Site 2 Product', confidence: 0.5, domain: 'site2.com' }
    ]);

    expect(sources.length).toBe(2);
    
    const candidates = listSourcesByItem(item.id);
    expect(candidates.length).toBe(2);
    expect(candidates[0].confidence).toBe(0.9);

    selectSource(candidates[0].id);
    const selected = getSelectedSource(item.id);
    expect(selected?.url).toBe('https://site1.com/p');
  });

  it('should support extraction result CRUD operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch C', fileName: 'c.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [{ upc: '444444444444', name: 'Product 4', rowNumber: 2 }]);
    const item = items[0];

    const extractionData = {
      title: 'Scraped Product 4',
      brand: 'TestBrand',
      description: 'Extracted product description',
      bulletPoints: ['Feature 1', 'Feature 2'],
      primaryImage: 'products/444444444444/images/primary.jpg',
      additionalImages: [],
      price: '14.99',
      weight: '1 lb',
      dimensions: null,
      seoFileName: 'scraped-product-4',
      searchKeywords: 'keywords',
      sourceUrl: 'https://testsite.com/product4',
      confidence: 0.8,
      fieldProvenance: { title: 'html' }
    };

    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://testsite.com/product4',
      extractionDataJson: JSON.stringify(extractionData),
      extractionMethod: 'crawlee_playwright',
      confidence: 0.8,
    });

    const latest = getLatestExtraction(item.id);
    expect(latest).toBeDefined();
    expect(latest?.source_url).toBe('https://testsite.com/product4');
    expect(JSON.parse(latest!.extraction_data_json).title).toBe('Scraped Product 4');
  });

  it('returns the latest extraction binding per item in one batched query (Amendment A)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch Sources', fileName: 'sources.xlsx', totalItems: 2 });
    const items = insertItems(batch.id, [
      { upc: '777000000001', name: 'Source Item 1', rowNumber: 1 },
      { upc: '777000000002', name: 'Source Item 2', rowNumber: 2 },
    ]);
    const [itemA, itemB] = items;
    const db = getDb();

    // Item A: two extraction rows — the LATEST source wins (deterministic via
    // explicit created_at, since insertExtraction timestamps at ms precision).
    insertExtraction({ itemId: itemA.id, sourceUrl: 'https://a.example.com/first', extractionDataJson: '{"title":"A1"}', extractionMethod: 'test', confidence: 0.5 });
    db.run("UPDATE onboarding_extractions SET created_at = '2024-01-01T00:00:00.000Z' WHERE item_id = ?", [itemA.id]);
    insertExtraction({ itemId: itemA.id, sourceUrl: 'https://a.example.com/latest', extractionDataJson: '{"title":"A2"}', extractionMethod: 'test', confidence: 0.9 });
    db.run("UPDATE onboarding_extractions SET created_at = '2024-01-02T00:00:00.000Z' WHERE item_id = ?", [itemA.id]);
    // Item B: one row.
    insertExtraction({ itemId: itemB.id, sourceUrl: 'https://b.example.com/product', extractionDataJson: '{"title":"B"}', extractionMethod: 'test', confidence: 0.8 });

    const bindings = getLatestExtractionBindingsByItemIds([itemA.id, itemB.id]);
    expect(bindings.get(itemA.id)).toEqual({
      sourceUrl: 'https://a.example.com/latest',
      sourceType: 'official_page',
      extractionMethod: 'test',
      sourcingGenerationId: null,
      acceptedEvidenceAttemptIds: [],
      evidenceHash: null,
      // Parent #101: attestation link for manual-evidence rows (null here).
      manualAttestationId: null,
    });
    expect(bindings.get(itemB.id)?.sourceUrl).toBe('https://b.example.com/product');
    expect(bindings.size).toBe(2);

    // Items without extraction rows are absent from the map; empty input is empty.
    const ghostId = randomUUID();
    const partial = getLatestExtractionBindingsByItemIds([itemA.id, ghostId]);
    expect(partial.has(ghostId)).toBe(false);
    expect(partial.get(itemA.id)?.sourceUrl).toBe('https://a.example.com/latest');
    expect(getLatestExtractionBindingsByItemIds([]).size).toBe(0);
  });

  it('resolves equal created_at extraction rows deterministically by rowid (tiebreaker)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Batch Tie', fileName: 'tie.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '777000000003', name: 'Tie Item', rowNumber: 1 },
    ]);
    const db = getDb();

    // Two rows with IDENTICAL created_at: the rowid-DESC row must win.
    insertExtraction({ itemId: item.id, sourceUrl: 'https://t.example.com/first', extractionDataJson: '{"title":"First"}', extractionMethod: 'test', confidence: 0.5 });
    insertExtraction({ itemId: item.id, sourceUrl: 'https://t.example.com/second', extractionDataJson: '{"title":"Second"}', extractionMethod: 'test', confidence: 0.9 });
    db.run("UPDATE onboarding_extractions SET created_at = '2024-03-01T00:00:00.000Z' WHERE item_id = ?", [item.id]);

    const bindings = getLatestExtractionBindingsByItemIds([item.id]);
    expect(bindings.get(item.id)?.sourceUrl).toBe('https://t.example.com/second');
    expect(getLatestExtraction(item.id)?.source_url).toBe('https://t.example.com/second');

    // Reverse insert order (rowid ordering flips) → still the rowid-DESC row.
    db.run('DELETE FROM onboarding_extractions WHERE item_id = ?', [item.id]);
    insertExtraction({ itemId: item.id, sourceUrl: 'https://t.example.com/second', extractionDataJson: '{"title":"Second"}', extractionMethod: 'test', confidence: 0.9 });
    insertExtraction({ itemId: item.id, sourceUrl: 'https://t.example.com/first', extractionDataJson: '{"title":"First"}', extractionMethod: 'test', confidence: 0.5 });
    db.run("UPDATE onboarding_extractions SET created_at = '2024-03-01T00:00:00.000Z' WHERE item_id = ?", [item.id]);

    const bindings2 = getLatestExtractionBindingsByItemIds([item.id]);
    expect(bindings2.get(item.id)?.sourceUrl).toBe('https://t.example.com/first');
    expect(getLatestExtraction(item.id)?.source_url).toBe('https://t.example.com/first');
  });

  it('should implement stage-based listing (listItemsByBatchStaged)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Stage Batch', fileName: 'stage.xlsx', totalItems: 3 });
    const items = insertItems(batch.id, [
      { upc: '555555555555', name: 'Stage A', rowNumber: 1 },
      { upc: '666666666666', name: 'Stage B', rowNumber: 2 },
      { upc: '777777777777', name: 'Stage C', rowNumber: 3 },
    ]);

    // Try to advance item B to extraction — should be skipped (not completed yet)
    const r1 = advanceItemsToNextStage([items[1].id]);
    expect(r1.advanced).toBe(0);
    expect(r1.skipped).toBe(1);

    const staged = listItemsByBatchStaged(batch.id);
    expect(staged.discovery.length).toBe(3); // All still in discovery since none advanced
    expect(staged.extraction.length).toBe(0);

    // Now mark item A as completed and advance it
    updateItemStageStatus(items[0].id, 'completed');
    const r2 = advanceItemsToNextStage([items[0].id]);
    expect(r2.advanced).toBe(1);
    const staged2 = listItemsByBatchStaged(batch.id);
    expect(staged2.discovery.length).toBe(2); // B and C still in discovery
    expect(staged2.extraction.length).toBe(1); // A advanced to extraction with pending
    expect(staged2.extraction[0].id).toBe(items[0].id);
    expect(staged2.extraction[0].stageStatus).toBe('pending');
    expect(staged2.curation.length).toBe(0);
    expect(staged2.review.length).toBe(0);
    expect(staged2.promotion.length).toBe(0);
  });

  it('should enforce advancement eligibility (only completed items advance)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Advance Test', fileName: 'advance.xlsx', totalItems: 2 });
    const items = insertItems(batch.id, [
      { upc: '888888888888', name: 'Advance A', rowNumber: 1 },
      { upc: '999999999999', name: 'Advance B', rowNumber: 2 },
    ]);

    // Both start at discovery/pending — neither is completed, so advance should skip both
    const result = advanceItemsToNextStage(items.map(i => i.id));
    expect(result.advanced).toBe(0);
    expect(result.skipped).toBe(2);

    // Complete item A, then advance should move only it
    updateItemStageStatus(items[0].id, 'completed');
    const result2 = advanceItemsToNextStage(items.map(i => i.id));
    expect(result2.advanced).toBe(1);
    expect(result2.skipped).toBe(1);

    const a = findItemById(items[0].id);
    expect(a?.stage).toBe('extraction');
    expect(a?.stageStatus).toBe('pending');

    const b = findItemById(items[1].id);
    expect(b?.stage).toBe('discovery');
    expect(b?.stageStatus).toBe('pending');
  });

  it('should prevent advancement from curation to review if there are pending AI proposals', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Proposal Test', fileName: 'proposal.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '123456789012', name: 'Proposal Product', rowNumber: 1 },
    ]);
    const item = items[0];

    const curationData = {
      curatedTitle: 'Proposal Product',
      curatedWeight: '12 oz',
      suggestedPages: ['Test Page'],
      classificationProposals: [
        {
          id: 'proposal-1',
          runId: 'run-1',
          productSku: '123456789012',
          proposalType: 'field_assignment',
          targetId: 'brand',
          proposedValue: 'My Brand',
          confidence: 0.9,
          evidenceIds: [],
          status: 'pending',
          createdAt: new Date().toISOString(),
        }
      ],
      classificationEvidence: [],
    };

    const db = getDb();
    db.query(
      "UPDATE onboarding_items SET stage = 'curation', stage_status = 'completed', curation_data_json = ? WHERE id = ?"
    ).run(JSON.stringify(curationData), item.id);

    // Try to advance — should advance even with pending proposal
    const res1 = advanceItemsToNextStage([item.id]);
    expect(res1.advanced).toBe(1);
    expect(res1.skipped).toBe(0);

    const advancedItem = findItemById(item.id);
    expect(advancedItem?.stage).toBe('review');
    expect(advancedItem?.stageStatus).toBe('pending');
  });

  it('should implement skip and reset operations', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Skip Test', fileName: 'skip.xlsx', totalItems: 2 });
    const items = insertItems(batch.id, [
      { upc: '111111111112', name: 'Skip A', rowNumber: 1 },
      { upc: '222222222223', name: 'Skip B', rowNumber: 2 },
    ]);

    skipItems([items[0].id]);
    const a = findItemById(items[0].id);
    expect(a?.stageStatus).toBe('skipped');

    // Reset the skipped item
    resetItemsToPending([items[0].id]);
    const a2 = findItemById(items[0].id);
    expect(a2?.stageStatus).toBe('pending');
    expect(a2?.errorMessage).toBeNull();
  });

  it('should report correct stage counts', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Counts Test', fileName: 'counts.xlsx', totalItems: 4 });
    insertItems(batch.id, [
      { upc: '111111111113', name: 'Count A', rowNumber: 1 },
      { upc: '222222222224', name: 'Count B', rowNumber: 2 },
      { upc: '333333333335', name: 'Count C', rowNumber: 3 },
      { upc: '444444444446', name: 'Count D', rowNumber: 4 },
    ]);

    const counts = getStageCounts(batch.id);
    expect(counts.discovery).toBe(4);
    expect(counts.extraction).toBe(0);
    expect(counts.curation).toBe(0);
    expect(counts.review).toBe(0);
    expect(counts.promotion).toBe(0);
  });

  it('should support getPendingItemsByStage with workspace filtering', () => {
    const pendingWsId = 'ws-pending-test-' + Date.now();
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [pendingWsId, 'Pending Test WS', '/tmp/pending-ws', '/tmp/pending-ws/.git', now, now, 'complete']
    );

    const batch = createBatch({ workspaceId: pendingWsId, name: 'Pending Test', fileName: 'pending.xlsx', totalItems: 2 });
    insertItems(batch.id, [
      { upc: '555555555556', name: 'Pending A', rowNumber: 1 },
      { upc: '666666666667', name: 'Pending B', rowNumber: 2 },
    ]);

    // Items are discovery/pending by default
    const pending = getPendingItemsByStage('discovery', 10, pendingWsId);
    expect(pending.length).toBe(2);
    expect(pending[0].stage).toBe('discovery');
    expect(pending[0].stageStatus).toBe('pending');

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
    db.run('DELETE FROM workspace WHERE id = ?', [pendingWsId]);
  });

  it('should support completeReviewStage and completePromotionStage', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Completion Test', fileName: 'complete.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '777777777778', name: 'Complete A', rowNumber: 1 },
    ]);
    const item = items[0];

    // Manually advance through stages (bypass eligibility for test simplicity)
    const db = getDb();
    db.query("UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);

    // Complete review
    completeReviewStage(item.id);
    const reviewed = findItemById(item.id);
    expect(reviewed?.stage).toBe('review');
    expect(reviewed?.stageStatus).toBe('completed');

    // Advance to promotion
    advanceItemsToNextStage([item.id]);

    // Complete promotion
    completePromotionStage(item.id, true);
    const promoted = findItemById(item.id);
    expect(promoted?.stage).toBe('promotion');
    expect(promoted?.stageStatus).toBe('completed');
  });

  it('should support setDiscoverySourceUrl', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Source URL Test', fileName: 'source.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '888888888889', name: 'Source A', rowNumber: 1 },
    ]);
    const item = items[0];

    setDiscoverySourceUrl(item.id, 'https://example.com/product');
    const updated = findItemById(item.id);
    expect(updated?.sourceUrl).toBe('https://example.com/product');
    expect(updated?.stageStatus).toBe('completed');
  });

  it('should support api keys and brand sites CRUD operations', () => {
    // API Keys
    upsertApiKey('openai', 'test-openai-key');
    const keyRow = getApiKey('openai');
    expect(keyRow?.api_key).toBe('test-openai-key');

    const keyList = listApiKeys();
    expect(keyList.some(k => k.service === 'openai')).toBe(true);

    // Brand Sites
    upsertBrandSite('Nike', 'nike.com');
    upsertBrandSite('Nike', 'nike.com'); // Upsert should increment/succeed
    
    let brandMatches = findBrandSites('Nike');
    expect(brandMatches.length).toBe(1);
    expect(brandMatches[0].domain).toBe('nike.com');

    // Test updating brand domain
    updateBrandSiteDomain('Nike', 'nike-new.com');
    brandMatches = findBrandSites('Nike');
    expect(brandMatches.length).toBe(1);
    expect(brandMatches[0].domain).toBe('nike-new.com');
  });

  it('should support sendItemsToPreviousStage and undo results appropriately per stage', () => {
    const db = getDb();
    const batch = createBatch({ workspaceId: wsId, name: 'Previous Stage Test', fileName: 'prev.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: '999999999999', name: 'Previous Test A', rowNumber: 1 },
    ]);
    const item = items[0];

    // --- 1. Test going back from extraction to discovery ---
    db.query("UPDATE onboarding_items SET stage = 'extraction', stage_status = 'pending', extraction_data_json = ? WHERE id = ?").run(
      JSON.stringify({ title: 'Extracted' }),
      item.id
    );
    insertExtraction({
      itemId: item.id,
      sourceUrl: 'https://example.com/source',
      extractionDataJson: JSON.stringify({ title: 'Extracted' }),
      extractionMethod: 'test',
      confidence: 1.0,
    });

    const res1 = sendItemsToPreviousStage([item.id]);
    expect(res1.moved).toBe(1);

    const afterRes1 = findItemById(item.id);
    expect(afterRes1?.stage).toBe('discovery');
    expect(afterRes1?.stageStatus).toBe('completed');
    expect(afterRes1?.extractionData).toBeNull();
    expect(afterRes1?.status).toBe('source_confirmed');
    expect(getLatestExtraction(item.id)).toBeFalsy();

    // --- 2. Test going back from curation to extraction ---
    db.query("UPDATE onboarding_items SET stage = 'curation', stage_status = 'pending', curation_data_json = ? WHERE id = ?").run(
      JSON.stringify({ curatedTitle: 'Curated' }),
      item.id
    );

    const res2 = sendItemsToPreviousStage([item.id]);
    expect(res2.moved).toBe(1);

    const afterRes2 = findItemById(item.id);
    expect(afterRes2?.stage).toBe('extraction');
    expect(afterRes2?.stageStatus).toBe('completed');
    expect(afterRes2?.curationData).toBeNull();

    // --- 3. Test going back from review to curation ---
    db.query("UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);
    
    // Simulate classification run, proposals, decisions
    const runId = 'test-run-id';
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'completed', ?)`,
      [runId, wsId, item.id, item.upc, new Date().toISOString()]
    );
    const proposalId = 'test-prop-id';
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'attr-id', '"val"', 1.0, 'accepted', 1, 0, ?)`,
      [proposalId, runId, item.upc, new Date().toISOString()]
    );
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
       VALUES (?, ?, 'accepted', ?)`,
      ['dec-id', proposalId, new Date().toISOString()]
    );

    const res3 = sendItemsToPreviousStage([item.id]);
    expect(res3.moved).toBe(1);

    const afterRes3 = findItemById(item.id);
    expect(afterRes3?.stage).toBe('curation');
    expect(afterRes3?.stageStatus).toBe('completed');
    expect(afterRes3?.status).toBe('curated');

    // Verify proposals status reverted to pending and decisions superseded
    // (append-only: history is preserved, the decision is invalidated).
    const prop = db.query('SELECT status FROM classification_proposals WHERE id = ?').get(proposalId) as { status: string };
    expect(prop.status).toBe('pending');
    const decRow = db.query('SELECT superseded_at FROM classification_proposal_decisions WHERE proposal_id = ?').get(proposalId) as { superseded_at: string | null } | undefined;
    expect(decRow).toBeTruthy();
    expect(decRow!.superseded_at).toBeTruthy();

    // --- 4. Test going back from promotion to review ---
    db.query("UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?").run(item.id);
    
    // Simulate draft change set and change set items, and product page assignment
    const changeSetId = 'test-cs-id';
    db.run(
      `INSERT INTO change_sets (id, workspace_id, title, status, base_commit, created_at, updated_at)
       VALUES (?, ?, 'Test CS', 'draft', 'base', ?, ?)`,
      [changeSetId, wsId, new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO change_set_items (id, change_set_id, sku, operation, draft_json, draft_hash, validation_status, created_at, updated_at)
       VALUES (?, ?, ?, 'create', '{}', 'hash', 'unknown', ?, ?)`,
      ['cs-item-id', changeSetId, item.upc, new Date().toISOString(), new Date().toISOString()]
    );
    db.run(
      `INSERT INTO product_pages (product_sku, page_name, created_at)
       VALUES (?, 'page-name', ?)`,
      [item.upc, new Date().toISOString()]
    );

    const res4 = sendItemsToPreviousStage([item.id]);
    expect(res4.moved).toBe(1);

    const afterRes4 = findItemById(item.id);
    expect(afterRes4?.stage).toBe('review');
    expect(afterRes4?.stageStatus).toBe('completed');
    expect(afterRes4?.status).toBe('ready');

    // Verify change set item deleted and pages cleared
    const csItemCount = db.query('SELECT COUNT(*) as count FROM change_set_items WHERE change_set_id = ?').get(changeSetId) as { count: number };
    expect(csItemCount.count).toBe(0);
    const pagesCount = db.query('SELECT COUNT(*) as count FROM product_pages WHERE product_sku = ?').get(item.upc) as { count: number };
    expect(pagesCount.count).toBe(0);

    // Clean up
    db.run('DELETE FROM product_pages WHERE product_sku = ?', [item.upc]);
    db.run('DELETE FROM change_set_items WHERE change_set_id = ?', [changeSetId]);
    db.run('DELETE FROM change_sets WHERE id = ?', [changeSetId]);
    db.run('DELETE FROM classification_proposals WHERE run_id = ?', [runId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
  });

  it('insertEvidenceAttempt persists and hydrates connector-declared variant axes (Milestone E)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Axes Batch', fileName: 'axes.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '444444444444', name: 'Axes Product', rowNumber: 1 }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
    const gen = startSourcingGeneration(item.id, 'automatic');
    const declarations = [
      { rawField: 'PackCount', normalizedAxis: 'packCount' },
      { rawField: 'Flavour', normalizedAxis: 'flavor' },
      { rawField: 'Scent', normalizedAxis: 'scent' },
    ];
    // InsertEvidenceAttempt (shared schema) does not yet carry the field; the
    // repo reads it tolerantly via the extended shape (Milestone E seam).
    const attempt = {
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: '444444444444',
      outcome: 'found' as const,
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: '444444444444', name: 'Axes Product' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-14T00:00:00.000Z',
      sourcingGenerationId: gen.id,
      durationMs: 12,
      variantAxisDeclarations: declarations,
    } as unknown as Parameters<typeof insertEvidenceAttempt>[0] & { variantAxisDeclarations?: unknown };

    const inserted = insertEvidenceAttempt(attempt);
    // Hydrated from the durable row (tolerant column read).
    expect(inserted.variantAxisDeclarations).toEqual(declarations);

    // Read back through the generation-scoped reader — the declarations
    // survive the round-trip and feed the materializer's declared-axis set.
    const reloaded = getEvidenceAttemptsByItemAndGeneration(item.id, gen.id);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].variantAxisDeclarations).toEqual(declarations);
  });
});

describe('listValidationSamplesByDomain (Phase 3, task 16)', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'onboarding-validation-samples-test.db');
  const wsId = 'workspace-validation-samples-test-id';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    // Create a dummy workspace in DB to satisfy foreign keys
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Test Workspace', '/tmp/ws-validation', '/tmp/ws-validation/.git', now, now, 'complete']
    );
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('returns no rows for an unknown domain', () => {
    const samples = listValidationSamplesByDomain('nonexistent-domain-xyz.com');
    expect(samples).toEqual([]);
  });

  it('returns URL + expected name + brand hint for matching items', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Sample Test Batch',
      fileName: 'sample.xlsx',
      totalItems: 2,
    });
    const items = insertItems(batch.id, [
      { upc: '111', name: 'Test Product A', rowNumber: 1 },
      { upc: '222', name: 'Test Product B', rowNumber: 2 },
    ]);
    const sourcesA = insertSources(items[0].id, [
      { url: 'https://acmepet.com/a', domain: 'acmepet.com', title: 'A title', confidence: 0.9 },
    ]);
    const sourcesB = insertSources(items[1].id, [
      { url: 'https://acmepet.com/b', domain: 'acmepet.com', title: 'B title', confidence: 0.8 },
    ]);
    // Policy: only selected/confirmed sources. Both must be selected for this test.
    selectSource(sourcesA[0].id);
    selectSource(sourcesB[0].id);
    const samples = listValidationSamplesByDomain('acmepet.com', 10);
    expect(samples.length).toBe(2);
    const urls = samples.map((s) => s.url).sort();
    expect(urls).toEqual(['https://acmepet.com/a', 'https://acmepet.com/b']);
    // expectedName falls back to the parent item's name when no
    // expected_name column is set (Phase 3 task 14 policy).
    expect(samples.find((s) => s.url === 'https://acmepet.com/a')?.expectedName).toBe('Test Product A');
    expect(samples.find((s) => s.url === 'https://acmepet.com/b')?.expectedName).toBe('Test Product B');
  });

  it('prefers is_selected sources first, then by confidence', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Sort Test Batch',
      fileName: 'sort.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '333', name: 'Sort Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://sort-test.com/low', domain: 'sort-test.com', title: 'low', confidence: 0.3 },
      { url: 'https://sort-test.com/high', domain: 'sort-test.com', title: 'high', confidence: 0.9 },
    ]);
    // Select the high-confidence one; it should be returned first.
    selectSource(sources[1].id);
    const samples = listValidationSamplesByDomain('sort-test.com', 10);
    expect(samples.length).toBe(1);
    expect(samples[0].url).toBe('https://sort-test.com/high');
  });

  it('respects the limit parameter', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Limit Test Batch',
      fileName: 'limit.xlsx',
      totalItems: 3,
    });
    const items = insertItems(batch.id, [
      { upc: '444-a', name: 'Limit A', rowNumber: 1 },
      { upc: '444-b', name: 'Limit B', rowNumber: 2 },
      { upc: '444-c', name: 'Limit C', rowNumber: 3 },
    ]);
    // Each source belongs to a different item so that selectSource
    // can mark each one as is_selected independently. A single item
    // only has one is_selected source at a time.
    const sourcesA = insertSources(items[0].id, [
      { url: 'https://limit-test.com/a', domain: 'limit-test.com', confidence: 0.1 },
    ]);
    const sourcesB = insertSources(items[1].id, [
      { url: 'https://limit-test.com/b', domain: 'limit-test.com', confidence: 0.2 },
    ]);
    const sourcesC = insertSources(items[2].id, [
      { url: 'https://limit-test.com/c', domain: 'limit-test.com', confidence: 0.3 },
    ]);
    selectSource(sourcesA[0].id);
    selectSource(sourcesB[0].id);
    selectSource(sourcesC[0].id);
    const samples = listValidationSamplesByDomain('limit-test.com', 2);
    expect(samples.length).toBe(2);
  });

  it('claimItemsForProcessing claims disjoint items across simulated workers', () => {
    const claimWsId = 'ws-claim-1';
    const db = getDb();
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)', [claimWsId, 'Claim WS 1', '/tmp/claim1', '/tmp/claim1/.git', now, now, 'complete']);
    const batch = createBatch({ workspaceId: claimWsId, name: 'Claim Test Batch', fileName: 'claim.xlsx', totalItems: 4 });
    insertItems(batch.id, [
      { upc: 'CLAIM-001', name: 'Claim 1', rowNumber: 1 },
      { upc: 'CLAIM-002', name: 'Claim 2', rowNumber: 2 },
      { upc: 'CLAIM-003', name: 'Claim 3', rowNumber: 3 },
      { upc: 'CLAIM-004', name: 'Claim 4', rowNumber: 4 },
    ]);

    // Worker A claims 2 items
    const claimedA = claimItemsForProcessing('discovery', 2, claimWsId, 'worker-a');
    expect(claimedA).toHaveLength(2);
    expect(claimedA[0].upc).toBe('CLAIM-001');
    expect(claimedA[1].upc).toBe('CLAIM-002');
    expect(claimedA[0].stageStatus).toBe('in_progress');

    // Worker B claims different 2 items (disjoint)
    const claimedB = claimItemsForProcessing('discovery', 2, claimWsId, 'worker-b');
    expect(claimedB).toHaveLength(2);
    expect(claimedB[0].upc).toBe('CLAIM-003');
    expect(claimedB[1].upc).toBe('CLAIM-004');

    // No more pending items remain
    const remaining = claimItemsForProcessing('discovery', 2, claimWsId, 'worker-c');
    expect(remaining).toHaveLength(0);
  });

  it('claimItemsForProcessing does not claim already-in-progress items', () => {
    const claimWsId = 'ws-claim-2';
    const db = getDb();
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)', [claimWsId, 'Claim WS 2', '/tmp/claim2', '/tmp/claim2/.git', now, now, 'complete']);
    const batch = createBatch({ workspaceId: claimWsId, name: 'Inprog Claim Test Batch', fileName: 'inprog.xlsx', totalItems: 2 });
    insertItems(batch.id, [
      { upc: 'INPROG-001', name: 'Inprog 1', rowNumber: 1 },
      { upc: 'INPROG-002', name: 'Inprog 2', rowNumber: 2 },
    ]);

    // First worker takes both
    const first = claimItemsForProcessing('discovery', 5, claimWsId, 'worker-1');
    expect(first).toHaveLength(2);

    // Second worker gets none (all in_progress, none pending)
    const second = claimItemsForProcessing('discovery', 5, claimWsId, 'worker-2');
    expect(second).toHaveLength(0);
  });

  it('requeueStaleInProgressItems recovers only stale claims', () => {
    const claimWsId = 'ws-claim-3';
    const db = getDb();
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)', [claimWsId, 'Claim WS 3', '/tmp/claim3', '/tmp/claim3/.git', now, now, 'complete']);
    const batch = createBatch({ workspaceId: claimWsId, name: 'Stale Claim Test Batch', fileName: 'stale.xlsx', totalItems: 4 });
    const items = insertItems(batch.id, [
      { upc: 'STALE-001', name: 'Stale 1', rowNumber: 1 },
      { upc: 'STALE-002', name: 'Stale 2', rowNumber: 2 },
      { upc: 'STALE-003', name: 'Fresh 1', rowNumber: 3 },
      { upc: 'STALE-004', name: 'Unleased Legacy Item', rowNumber: 4 },
    ]);

    // Claim items
    claimItemsForProcessing('discovery', 4, claimWsId, 'worker-stale');

    // Manually age two items to be stale, leave one fresh, and simulate one
    // pre-lease in_progress row from an older app version with no claim time.
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.run('UPDATE onboarding_items SET claimed_at = ? WHERE upc = ?', [oldTime, 'STALE-001']);
    db.run('UPDATE onboarding_items SET claimed_at = ? WHERE upc = ?', [oldTime, 'STALE-002']);
    db.run('UPDATE onboarding_items SET claimed_by = NULL, claimed_at = NULL WHERE upc = ?', ['STALE-004']);

    // Requeue stale and unleased legacy rows, but not a fresh live claim.
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const requeued = requeueStaleInProgressItems(claimWsId, staleBefore);
    expect(requeued).toBe(3);

    // Verify STALE-001 and STALE-002 are pending again
    const item1 = findItemById(items[0].id);
    const item2 = findItemById(items[1].id);
    const item3 = findItemById(items[2].id);
    const item4 = findItemById(items[3].id);
    expect(item1!.stageStatus).toBe('pending');
    expect(item2!.stageStatus).toBe('pending');
    expect(item4!.stageStatus).toBe('pending');
    // Fresh item still in_progress
    expect(item3!.stageStatus).toBe('in_progress');
  });

  it('surfaces page, Product Type, and title divergence without mutating siblings', () => {
    const db = getDb();
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Consistency Warning Batch',
      fileName: 'consistency.xlsx',
      totalItems: 2,
    });
    const items = insertItems(batch.id, [
      { upc: 'CONSIST-001', name: 'INSTINCT CAT PATE CHKN SPLIT CUP 2.64OZ', rowNumber: 1, brandHint: 'Instinct' },
      { upc: 'CONSIST-002', name: 'INSTINCT CAT PATE SLMN SPLIT CUP 2.64OZ', rowNumber: 2, brandHint: 'Instinct' },
    ]);
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify({
      curatedTitle: 'Instinct Cat Pate Chicken Split Cup 2.64 oz',
      suggestedPages: ['Cat Food Wet', 'Brand - Instinct'],
      suggestedProductType: 'Wet Cat Food',
    }), items[0].id]);
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify({
      curatedTitle: 'Instinct Cat Flake Salmon Split Cup 2.64 oz',
      suggestedPages: ['Cat Food Wet'],
      suggestedProductType: null,
    }), items[1].id]);

    const warnings = validateSiblingConsistency(batch.id);
    expect(new Set(warnings.map(w => w.field))).toEqual(new Set([
      'category_page',
      'primary_product_type',
      'curated_title',
    ]));
    expect(warnings.every(w => Object.keys(w.values).length === 2)).toBe(true);
  });

  it('updateItemStageStatus clears claim fields on non-in_progress transitions', () => {
    const claimWsId = 'ws-claim-4';
    const db = getDb();
    const now = new Date().toISOString();
    db.run('INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)', [claimWsId, 'Claim WS 4', '/tmp/claim4', '/tmp/claim4/.git', now, now, 'complete']);
    const batch = createBatch({ workspaceId: claimWsId, name: 'Claim Clear Test Batch', fileName: 'clear.xlsx', totalItems: 1 });
    const items = insertItems(batch.id, [
      { upc: 'CLEAR-001', name: 'Clear 1', rowNumber: 1 },
    ]);
    const item = items[0];

    // Claim it
    claimItemsForProcessing('discovery', 1, claimWsId, 'worker-clear');
    const rawClaimed = db.query('SELECT claimed_by, claimed_at, stage_status FROM onboarding_items WHERE id = ?').get(item.id) as any;
    expect(rawClaimed).toBeDefined();
    expect(rawClaimed.claimed_by).toBe('worker-clear');
    expect(rawClaimed.claimed_at).toBeDefined();

    // Mark completed — claim fields should be cleared
    updateItemStageStatus(item.id, 'completed');
    const rawCompleted = db.query('SELECT stage_status, claimed_by, claimed_at FROM onboarding_items WHERE id = ?').get(item.id) as any;
    expect(rawCompleted.stage_status).toBe('completed');
    expect(rawCompleted.claimed_by).toBeNull();
    expect(rawCompleted.claimed_at).toBeNull();
  });

  it('matches subdomains of the requested domain', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Subdomain Batch',
      fileName: 'sub.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '555', name: 'Sub Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://shop.subbrand.com/x', domain: 'shop.subbrand.com', confidence: 0.5 },
    ]);
    selectSource(sources[0].id);
    const samples = listValidationSamplesByDomain('subbrand.com');
    expect(samples.length).toBe(1);
    expect(samples[0].url).toBe('https://shop.subbrand.com/x');
  });

  it('excludes sources from unrelated domains (notmywoof.com vs mywoof.com)', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Negative Match Batch',
      fileName: 'neg.xlsx',
      totalItems: 1,
    });
    const item = insertItems(batch.id, [
      { upc: '666', name: 'Negative Test', rowNumber: 1 },
    ])[0];
    const sources = insertSources(item.id, [
      { url: 'https://notmywoof.com/x', domain: 'notmywoof.com', confidence: 0.9 },
    ]);
    selectSource(sources[0].id);
    const samples = listValidationSamplesByDomain('mywoof.com');
    expect(samples.length).toBe(0);
  });

  it('resets and requeues active classification runs when items are reset or requeued', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Reset Curation Test Batch',
      fileName: 'reset_curation.xlsx',
      totalItems: 2,
    });
    const items = insertItems(batch.id, [
      { upc: 'UPC-RESET-1', name: 'Reset Item 1', rowNumber: 1 },
      { upc: 'UPC-RESET-2', name: 'Reset Item 2', rowNumber: 2 },
    ]);

    // Set items to curation stage so they are claimable for curation
    db.run("UPDATE onboarding_items SET stage = 'curation' WHERE batch_id = ?", [batch.id]);

    // Claim them
    claimItemsForProcessing('curation', 2, wsId, 'worker-reset');

    const runId1 = randomUUID();
    const runId2 = randomUUID();

    // Insert active classification runs for these items
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [runId1, wsId, items[0].id, 'UPC-RESET-1', now]
    );
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [runId2, wsId, items[1].id, 'UPC-RESET-2', now]
    );

    // 1. Test requeueStaleInProgressItems fails the run
    // Age item 1 to be stale
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.run('UPDATE onboarding_items SET claimed_at = ? WHERE id = ?', [oldTime, items[0].id]);
    
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    requeueStaleInProgressItems(wsId, staleBefore);

    // Verify run 1 is failed
    const run1 = db.query('SELECT status, error_message FROM classification_runs WHERE id = ?').get(runId1) as any;
    expect(run1.status).toBe('failed');
    expect(run1.error_message).toBe('Worker claim went stale');

    // Run 2 is still running
    const run2Before = db.query('SELECT status FROM classification_runs WHERE id = ?').get(runId2) as any;
    expect(run2Before.status).toBe('running');

    // 2. Test resetItemsToPending fails the run
    resetItemsToPending([items[1].id]);

    // Verify run 2 is failed
    const run2After = db.query('SELECT status, error_message FROM classification_runs WHERE id = ?').get(runId2) as any;
    expect(run2After.status).toBe('failed');
    expect(run2After.error_message).toBe('Superseded by reset');
  });

  it('should dynamically calculate completed, failed, and skipped items counts for a batch', () => {
    const batch = createBatch({
      workspaceId: wsId,
      name: 'Dynamic Progress Batch',
      fileName: 'dynamic.xlsx',
      totalItems: 4,
    });

    const initialDetails = findBatchById(batch.id);
    expect(initialDetails).toBeDefined();
    expect(initialDetails?.completedItems).toBe(0);
    expect(initialDetails?.failedItems).toBe(0);
    expect(initialDetails?.skippedItems).toBe(0);

    const items = insertItems(batch.id, [
      { upc: 'UPC-DYN-1', name: 'Item 1', rowNumber: 1 },
      { upc: 'UPC-DYN-2', name: 'Item 2', rowNumber: 2 },
      { upc: 'UPC-DYN-3', name: 'Item 3', rowNumber: 3 },
      { upc: 'UPC-DYN-4', name: 'Item 4', rowNumber: 4 },
    ]);

    // Update statuses to match the test scenarios
    // Item 1: fully promoted
    const db = getDb();
    db.run("UPDATE onboarding_items SET stage = 'promotion', stage_status = 'completed' WHERE id = ?", [items[0].id]);
    // Item 2: failed
    db.run("UPDATE onboarding_items SET stage = 'discovery', stage_status = 'failed' WHERE id = ?", [items[1].id]);
    // Item 3: skipped
    db.run("UPDATE onboarding_items SET stage = 'extraction', stage_status = 'skipped' WHERE id = ?", [items[2].id]);
    // Item 4: pending (remains as discovery/pending from insertion)

    const updatedDetails = findBatchById(batch.id);
    expect(updatedDetails).toBeDefined();
    expect(updatedDetails?.completedItems).toBe(1);
    expect(updatedDetails?.failedItems).toBe(1);
    expect(updatedDetails?.skippedItems).toBe(1);

    const batchList = listBatches(wsId);
    const dynamicBatch = batchList.find(b => b.id === batch.id);
    expect(dynamicBatch).toBeDefined();
    expect(dynamicBatch?.completedItems).toBe(1);
    expect(dynamicBatch?.failedItems).toBe(1);
    expect(dynamicBatch?.skippedItems).toBe(1);
  });


  it('advanceItemsToNextStage never advances needs_input or unresolved-conflict sourcing items', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Guard Batch', fileName: 'guard.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678999', name: 'Guarded', rowNumber: 1, stage: 'sourcing' },
    ]);
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    // needs_input items are excluded by the completed-only filter.
    const res = advanceItemsToNextStage([item.id]);
    expect(res.advanced).toBe(0);
    expect(res.skipped).toBe(1);
    expect(findItemById(item.id)?.stage).toBe('sourcing');

    // An open hard conflict blocks even a completed-marked sourcing item.
    updateItemStageStatus(item.id, 'completed', null);
    const db = getDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO onboarding_evidence_conflicts (id, item_id, field, severity, status, created_at)
       VALUES ('guard-conflict', ?, 'brand', 'hard', 'open', ?)`,
    ).run(item.id, now);

    const res2 = advanceItemsToNextStage([item.id]);
    expect(res2.advanced).toBe(0);
    expect(res2.skipped).toBe(1);
    expect(findItemById(item.id)?.stage).toBe('sourcing');
  });

  it('hydrates the sourcing entry-policy version (omitted=0, explicit=1)', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Policy Batch', fileName: 'policy.xlsx', totalItems: 2 });
    const [legacyItem] = insertItems(batch.id, [{ upc: 'POLICY-000001', name: 'Legacy', rowNumber: 1 }]);
    const [amendedItem] = insertItems(batch.id, [{ upc: 'POLICY-000002', name: 'Amended', rowNumber: 2 }], 'discovery', 1);

    // The default (omitted) version is 0 (fail closed); production callers
    // pass the current version explicitly (seam contract for routes/imports).
    expect(SOURCING_ENTRY_POLICY_VERSION).toBe(1);
    expect(legacyItem.sourcingEntryPolicyVersion).toBe(0);
    expect(amendedItem.sourcingEntryPolicyVersion).toBe(1);
    expect(findItemById(legacyItem.id)?.sourcingEntryPolicyVersion).toBe(0);
    expect(findItemById(amendedItem.id)?.sourcingEntryPolicyVersion).toBe(1);
  });

  it('sourcing claims require the exact current entry-policy version (148-row isolation)', () => {
    const claimWsId = 'ws-policy-claim'; // brand-new workspace, no leakage
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)',
      [claimWsId, 'Policy Claim WS', '/tmp/policy-claim', '/tmp/policy-claim/.git', now, now, 'complete'],
    );
    const batch = createBatch({ workspaceId: claimWsId, name: 'Stranded Batch', fileName: 'stranded.csv', totalItems: 150 });

    // 148 pre-amendment sourcing rows (policy 0, explicit sourcing stage) — the
    // legacy stranded cohort must NEVER be claimable by the engine.
    const stranded: Array<{ upc: string; name: string; rowNumber: number; stage: 'sourcing' }> = [];
    for (let i = 0; i < 148; i++) {
      stranded.push({ upc: `STRAND-${String(i).padStart(5, '0')}`, name: `Stranded ${i}`, rowNumber: i + 1, stage: 'sourcing' });
    }
    insertItems(batch.id, stranded);
    // Two post-amendment rows (policy 1, sourcing stage).
    insertItems(batch.id, [
      { upc: 'STRAND-99998', name: 'Amended Sourcing 1', rowNumber: 149, stage: 'sourcing' as const },
      { upc: 'STRAND-99999', name: 'Amended Sourcing 2', rowNumber: 150, stage: 'sourcing' as const },
    ], 'sourcing', 1);

    // Only the policy-1 rows are claimable; every claimed row hydrates version 1.
    const claimed = claimItemsForProcessing('sourcing', 200, claimWsId, 'worker-policy');
    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => c.sourcingEntryPolicyVersion === 1)).toBe(true);
    expect(claimed.map((c) => c.upc).sort()).toEqual(['STRAND-99998', 'STRAND-99999']);

    // No policy-0 row is ever claimed by a second pass either.
    const second = claimItemsForProcessing('sourcing', 200, claimWsId, 'worker-policy-2');
    expect(second).toHaveLength(0);

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
    db.run('DELETE FROM workspace WHERE id = ?', [claimWsId]);
  });

  it('non-sourcing claims are unaffected by the entry-policy version', () => {
    const claimWsId = 'ws-policy-discovery';
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO workspace (id,name,workspace_path,git_path,created_at,updated_at,bootstrap_status) VALUES (?,?,?,?,?,?,?)',
      [claimWsId, 'Discovery Claim WS', '/tmp/policy-disc', '/tmp/policy-disc/.git', now, now, 'complete'],
    );
    const batch = createBatch({ workspaceId: claimWsId, name: 'Discovery Batch', fileName: 'disc.xlsx', totalItems: 2 });
    // One policy-0 and one policy-1 discovery row: discovery claims have NO
    // version filter, so both are claimable (entry policy gates Sourcing only).
    insertItems(batch.id, [{ upc: 'DISC-000001', name: 'D1', rowNumber: 1 }]);
    insertItems(batch.id, [{ upc: 'DISC-000002', name: 'D2', rowNumber: 2 }], 'discovery', 1);

    const claimed = claimItemsForProcessing('discovery', 5, claimWsId, 'worker-disc');
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((c) => c.sourcingEntryPolicyVersion))).toEqual(new Set([0, 1]));

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batch.id]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batch.id]);
    db.run('DELETE FROM workspace WHERE id = ?', [claimWsId]);
  });

  it('insertExtraction rejects an official_page extraction without a real URL', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Ext URL', fileName: 'exturl.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: 'EXTURL-001', name: 'Ext URL', rowNumber: 1 }]);

    expect(() =>
      insertExtraction({ itemId: item.id, sourceUrl: '', extractionDataJson: '{}', extractionMethod: 'test', confidence: 0.5 }),
    ).toThrow(/source URL/i);
    expect(() =>
      insertExtraction({ itemId: item.id, sourceUrl: '   ', extractionDataJson: '{}', extractionMethod: 'test', confidence: 0.5 }),
    ).toThrow(/source URL/i);
    expect(() =>
      insertExtraction({ itemId: item.id, sourceUrl: null as unknown as string, extractionDataJson: '{}', extractionMethod: 'test', confidence: 0.5 }),
    ).toThrow(/source URL/i);
  });

  it('insertExtraction persists distributor_record provenance and fails closed on mismatches', () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Ext Dist', fileName: 'extdist.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: 'EXTDIST-001', name: 'Ext Dist', rowNumber: 1 }]);
    const generation = startSourcingGeneration(item.id);
    const hash = 'a'.repeat(64);

    const row = insertExtraction({
      itemId: item.id,
      sourceType: 'distributor_record',
      sourceUrl: null,
      extractionDataJson: JSON.stringify({ name: 'Dist' }),
      extractionMethod: 'distributor_record_v1',
      confidence: 0.9,
      sourcingGenerationId: generation.id,
      acceptedEvidenceAttemptIds: ['att-b', 'att-a'],
      evidenceHash: hash,
    });

    expect(row.source_type).toBe('distributor_record');
    expect(row.source_url).toBeNull();
    expect(row.sourcing_generation_id).toBe(generation.id);
    // Canonical sorted accepted ids (order-insensitive provenance).
    expect(JSON.parse(row.accepted_evidence_attempt_ids_json!)).toEqual(['att-a', 'att-b']);
    expect(row.evidence_hash).toBe(hash);

    // Fail-closed mismatches (cast: the discriminated input type already
    // prevents these at compile time; the casts exercise the runtime guards).
    const badDistributor = (o: Record<string, unknown>) => o as unknown as Parameters<typeof insertExtraction>[0];
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: 'https://fake.example',
        extractionDataJson: '{}', extractionMethod: 'distributor_record_v1', confidence: 0.5,
        sourcingGenerationId: generation.id, acceptedEvidenceAttemptIds: ['a'], evidenceHash: hash,
      })),
    ).toThrow(/NULL source URL/i);
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: null,
        extractionDataJson: '{}', extractionMethod: 'distributor_record_v1', confidence: 0.5,
        acceptedEvidenceAttemptIds: ['a'], evidenceHash: hash,
      })),
    ).toThrow(/sourcing generation/i);
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: null,
        extractionDataJson: '{}', extractionMethod: 'distributor_record_v1', confidence: 0.5,
        sourcingGenerationId: generation.id, acceptedEvidenceAttemptIds: [], evidenceHash: hash,
      })),
    ).toThrow(/accepted evidence/i);
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: null,
        extractionDataJson: '{}', extractionMethod: 'distributor_record_v1', confidence: 0.5,
        sourcingGenerationId: generation.id, acceptedEvidenceAttemptIds: ['a'], evidenceHash: 'not-a-hash',
      })),
    ).toThrow(/evidence hash/i);
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: null,
        extractionDataJson: '{}', extractionMethod: 'legacy_method', confidence: 0.5,
        sourcingGenerationId: generation.id, acceptedEvidenceAttemptIds: ['a'], evidenceHash: hash,
      })),
    ).toThrow(/distributor_record_v1/i);
    // Duplicate accepted ids are rejected.
    expect(() =>
      insertExtraction(badDistributor({
        itemId: item.id, sourceType: 'distributor_record', sourceUrl: null,
        extractionDataJson: '{}', extractionMethod: 'distributor_record_v1', confidence: 0.5,
        sourcingGenerationId: generation.id, acceptedEvidenceAttemptIds: ['a', 'a'], evidenceHash: hash,
      })),
    ).toThrow(/unique/i);
  });

  it('computeExtractionHash binds source type and sorted distributor provenance', () => {
    const base = {
      id: 'h1', batchId: 'b1', upc: 'HASH-001', name: 'Hash', price: null, quantity: null,
      brandHint: null, departmentHint: null, sourceUrl: null, expectedName: null,
      coordinatedTitle: null, acceptedEvidenceAttemptId: null, stage: 'extraction' as const,
      stageStatus: 'pending' as const, status: 'imported' as const, errorMessage: null,
      retryCount: 0, isDuplicate: false, existingSku: null, curationData: null,
      rowNumber: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      extractionData: { title: 'Hash Product' },
    };

    // Identical provenance, differing ONLY in source type → hashes differ.
    const official = { ...base, sourceType: 'official_page' as const, acceptedEvidenceAttemptIds: ['att-1'] as string[] };
    const distributor = { ...base, sourceType: 'distributor_record' as const, acceptedEvidenceAttemptIds: ['att-1'] as string[] };
    const hOfficial = computeExtractionHash(official as any);
    const hDistributor = computeExtractionHash(distributor as any);
    expect(hOfficial).not.toBeNull();
    expect(hDistributor).not.toBeNull();
    expect(hOfficial).not.toBe(hDistributor);

    // Order-insensitive provenance: ['b','a'] vs ['a','b'] → same hash.
    const orderedA = { ...distributor, acceptedEvidenceAttemptIds: ['a', 'b'] };
    const orderedB = { ...distributor, acceptedEvidenceAttemptIds: ['b', 'a'] };
    expect(computeExtractionHash(orderedA as any)).toBe(computeExtractionHash(orderedB as any));
  });

  it('computeExtractionHash ignores the observation-only shadowPackagingOcrData key (post-review fixup 5)', () => {
    const base = {
      id: 'h2', batchId: 'b1', upc: 'HASH-002', name: 'Hash Shadow', price: null, quantity: null,
      brandHint: null, departmentHint: null, sourceUrl: null, expectedName: null,
      coordinatedTitle: null, acceptedEvidenceAttemptIds: [] as string[], stage: 'extraction' as const,
      stageStatus: 'pending' as const, status: 'imported' as const, errorMessage: null,
      retryCount: 0, isDuplicate: false, existingSku: null, curationData: null,
      rowNumber: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      extractionData: { title: 'Hash Product' },
    };

    // A shadow-mode packaging-OCR write adds ONLY the namespaced observation
    // key (and bumps updated_at). The evidence identity must NOT move —
    // identical extraction data ± shadowPackagingOcrData ⇒ SAME hash.
    const withoutShadow = computeExtractionHash(base as any);
    const withShadow = computeExtractionHash({
      ...base,
      updatedAt: '2026-01-02T00:00:00.000Z',
      extractionData: { title: 'Hash Product', shadowPackagingOcrData: { productName: 'Shadow Name' } },
    } as any);
    expect(withoutShadow).not.toBeNull();
    expect(withShadow).toBe(withoutShadow);

    // Sanity: a REAL evidence change still rebinds the hash.
    const changed = computeExtractionHash({ ...base, extractionData: { title: 'Different Title' } } as any);
    expect(changed).not.toBe(withoutShadow);
  });
});
