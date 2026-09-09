/**
 * Epic #46 Phase 1 — operator work-state projection tests.
 *
 * Table-driven: internal (stage, stageStatus, sourceType, errorMessage,
 * cohort readiness, review/approval state, change-set state) → expected
 * operator category/label/attention pair. Mirrors the epic #46 test plan
 * mapping table.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { overrideManualEvidenceFlags, resetManualEvidenceFlagsOverride } from '../../onboarding/flags';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  updateItemStageStatus,
  updateItemExtractionData,
  setDiscoverySourceUrl,
  advanceItemsToNextStage,
  listItemsByBatch,
} from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import { insertSources } from '../../db/repositories/onboarding-source-repo';
import {
  markReviewed,
  markApproved,
} from '../../db/repositories/onboarding-review-repo';
import {
  createChangeSet,
  upsertChangeSetItem,
  updateChangeSetStatus,
  listChangeSetStatusBySkus,
} from '../../db/repositories/change-set-repo';
import { refreshCandidateCohorts } from '../../onboarding/curation-cohort-service';
import {
  deriveItemWorkState,
  buildBatchWorkStateContext,
  getBatchWorkState,
} from '../../onboarding/onboarding-work-state';

let workspaceId: string;
let workspacePath: string;

function makeExtractionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Blue Buffalo Life Protection Chicken',
    brand: 'Blue Buffalo',
    ocrOutcome: { status: 'disabled' },
    ...overrides,
  };
}

/** Persist source URL + discovery/completed (worker real path). */
function completeDiscovery(itemId: string, url: string): void {
  setDiscoverySourceUrl(itemId, url);
}

/** Move an item to `extraction / completed` with complete evidence. */
function makeItemExtractionReady(itemId: string, url: string): void {
  completeDiscovery(itemId, url);
  updateItemStageStatus(itemId, 'completed');
  advanceItemsToNextStage([itemId]);
  updateItemExtractionData(itemId, JSON.stringify(makeExtractionData()));
  insertExtraction({
    itemId,
    sourceUrl: url,
    extractionDataJson: JSON.stringify(makeExtractionData()),
    extractionMethod: 'test',
    confidence: 0.9,
  });
  updateItemStageStatus(itemId, 'completed');
}

function makeItemExtractionFailed(itemId: string): void {
  updateItemStageStatus(itemId, 'completed');
  advanceItemsToNextStage([itemId]);
  updateItemExtractionData(itemId, JSON.stringify(makeExtractionData()));
  updateItemStageStatus(itemId, 'failed', 'simulated extraction failure');
}

function createItem(
  batchId: string,
  overrides: {
    upc: string;
    name: string;
    brandHint?: string | null;
    stage: string;
    stageStatus: string;
    sourceUrl?: string | null;
    sourceType?: 'official_page' | 'distributor_record';
    errorMessage?: string | null;
  },
): string {
  const inserted = insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name,
    brandHint: overrides.brandHint !== undefined ? overrides.brandHint : 'Blue Buffalo',
    sourceUrl: overrides.sourceUrl ?? null,
    rowNumber: 1,
    stage: overrides.stage as any,
    stageStatus: overrides.stageStatus as any,
  }], overrides.stage as any, 1);
  const id = inserted[0].id;
  const db = getDb();
  if (overrides.sourceType === 'distributor_record') {
    db.query("UPDATE onboarding_items SET source_type = 'distributor_record', source_url = NULL WHERE id = ?").run(id);
  }
  if (overrides.errorMessage) {
    db.query('UPDATE onboarding_items SET error_message = ? WHERE id = ?').run(overrides.errorMessage, id);
  }
  return id;
}

/** Derive one item's work state with a fresh batch context. */
function derive(batchId: string, itemId: string) {
  const items = listItemsByBatch(batchId);
  const ctx = buildBatchWorkStateContext(batchId, items);
  const item = items.find(i => i.id === itemId)!;
  return deriveItemWorkState(item, ctx);
}

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-workstate-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

function makeBatch(name = 'Test Batch'): string {
  const batch = createBatch({
    workspaceId,
    name,
    fileName: 'test.csv',
    totalItems: 0,
  });
  return batch.id;
}

beforeAll(() => {
  overrideManualEvidenceFlags({ enabled: false });
  makeWorkspace();
});

afterAll(() => {
  resetManualEvidenceFlagsOverride();
});

describe('work-state projection — mapping table (epic #46 Phase 1)', () => {
  it('sourcing pending → processing / distributor_lookup', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U1', name: 'X', stage: 'sourcing', stageStatus: 'pending' });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.activity).toBe('distributor_lookup');
    expect(state.label).toBe('Running distributor lookups');
    expect(state.attentionReason).toBeNull();
  });

  it('sourcing needs_input (identity conflict) → needs_attention / source_conflict', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U2', name: 'X', stage: 'sourcing', stageStatus: 'needs_input',
      errorMessage: 'Identity conflict detected',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('source_conflict');
    expect(state.attentionAction).toBe('resolve_source_conflict');
    expect(state.label).toBe('Distributor match needs decision');
  });

  it('clean distributor record → extraction pending → processing / materializing (NO human gate)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U3', name: 'X', stage: 'extraction', stageStatus: 'pending',
      sourceType: 'distributor_record',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.activity).toBe('extraction');
    expect(state.label).toBe('Materializing distributor data');
    expect(state.attentionReason).toBeNull();
  });

  it('distributor materialization failed → needs_attention / retry_extraction', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U3b', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceType: 'distributor_record', errorMessage: 'integrity_failure',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('processing_failed');
    expect(state.attentionAction).toBe('retry_extraction');
  });

  it('discovery pending → processing / official_site_search', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U4', name: 'X', stage: 'discovery', stageStatus: 'pending' });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.activity).toBe('official_site_search');
  });

  it('discovery needs_input with candidates → needs_attention / verify_official_url', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U5', name: 'X', stage: 'discovery', stageStatus: 'needs_input' });
    insertSources(id, [
      { url: 'https://brand.example.com/p/x', title: 'X', confidence: 0.8 },
    ]);
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('verify_official_url');
    expect(state.attentionAction).toBe('verify_official_url');
    expect(state.label).toBe('Verify official product page');
  });

  it('discovery needs_input without candidates → needs_attention / no_official_url', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U6', name: 'X', stage: 'discovery', stageStatus: 'needs_input' });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('no_official_url');
    expect(state.attentionAction).toBe('choose_official_url');
  });

  it('discovery completed with needs_review reason + candidates → needs_attention / verify_official_url', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U6b', name: 'X', stage: 'discovery', stageStatus: 'completed',
      errorMessage: 'needs_review: no candidate passed verification',
      sourceUrl: 'https://brand.example.com/p/x',
    });
    insertSources(id, [{ url: 'https://brand.example.com/p/x', title: 'X', confidence: 0.6 }]);
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('verify_official_url');
  });

  it('extraction pending (official) → processing / extraction', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U7', name: 'X', stage: 'extraction', stageStatus: 'pending',
      sourceUrl: 'https://brand.example.com/p/x',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.activity).toBe('extraction');
    expect(state.label).toBe('Extracting product data');
  });

  it('extraction in_progress → processing / extraction', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U8', name: 'X', stage: 'extraction', stageStatus: 'in_progress',
      sourceUrl: 'https://brand.example.com/p/x',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.label).toBe('Extracting product data');
  });

  it('extraction failed with missing profile → needs_attention / extractor_profile_required', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U9', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://brand.example.com/p/x',
      errorMessage: 'No extractor profile for brand.example.com — profile required',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('extractor_profile_required');
    expect(state.attentionAction).toBe('setup_extractor_profile');
    expect(state.label).toBe('Extractor profile required');
  });

  it('extraction failed with no confirmed source URL → needs_attention / choose_official_url', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U9b', name: 'X', stage: 'extraction', stageStatus: 'failed',
      errorMessage: 'No confirmed source URL',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('no_official_url');
  });

  it('extraction failed (other) → needs_attention / extraction_profile_failed / retry_extraction', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U10', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://brand.example.com/p/x',
      errorMessage: 'Timeout while scraping',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('extraction_profile_failed');
    expect(state.attentionAction).toBe('retry_extraction');
  });

  it('extraction completed → processing (auto-advance ahead)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U11', name: 'X', stage: 'extraction', stageStatus: 'completed',
      sourceUrl: 'https://brand.example.com/p/x',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('processing');
    expect(state.label).toBe('Extraction complete');
  });

  it('curation pending + cohort waiting (3/4 ready) → waiting_on_family with counts', () => {
    const batchId = makeBatch();
    const ready1 = createItem(batchId, { upc: 'F1', name: 'Blue Buffalo Life Protection Chicken 30 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const ready2 = createItem(batchId, { upc: 'F2', name: 'Blue Buffalo Life Protection Chicken 15 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const ready3 = createItem(batchId, { upc: 'F3', name: 'Blue Buffalo Life Protection Chicken 5 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const waiting = createItem(batchId, { upc: 'F4', name: 'Blue Buffalo Life Protection Chicken 40 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    // 3 ready members
    for (const id of [ready1, ready2, ready3]) {
      makeItemExtractionReady(id, `https://brand.example.com/products/${id}`);
    }
    // 4th member stays at extraction/pending (no evidence yet)
    updateItemStageStatus(waiting, 'completed');
    advanceItemsToNextStage([waiting]); // extraction/pending
    refreshCandidateCohorts(workspaceId, batchId);

    // Move ready members into curation/pending (the family barrier applies)
    for (const id of [ready1, ready2, ready3]) {
      advanceItemsToNextStage([id]);
    }
    const state = derive(batchId, ready1);
    expect(state.category).toBe('waiting_on_family');
    expect(state.activity).toBe('curation');
    expect(state.label).toBe('Family not ready yet');
    expect(state.family).not.toBeNull();
    expect(state.family!.memberCount).toBe(4);
    expect(state.family!.readyCount).toBe(3);
    expect(state.family!.blockedCount).toBe(0);
    expect(state.family!.waitingOnItemIds).toContain(waiting);
    expect(state.family!.waitingOnItemIds).not.toContain(ready1);
  });

  it('full cohort ready → processing / curation', () => {
    const batchId = makeBatch();
    const m1 = createItem(batchId, { upc: 'G1', name: 'Blue Buffalo Life Protection Chicken 30 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const m2 = createItem(batchId, { upc: 'G2', name: 'Blue Buffalo Life Protection Chicken 15 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    makeItemExtractionReady(m1, `https://brand.example.com/products/${m1}`);
    makeItemExtractionReady(m2, `https://brand.example.com/products/${m2}`);
    refreshCandidateCohorts(workspaceId, batchId);
    advanceItemsToNextStage([m1, m2]); // curation/pending
    const state = derive(batchId, m1);
    expect(state.category).toBe('processing');
    expect(state.activity).toBe('curation');
    expect(state.label).toBe('Curating product family');
    expect(state.family!.readyCount).toBe(2);
  });

  it('cohort with a blocked member → waiting_on_family / family blocked', () => {
    const batchId = makeBatch();
    const ok1 = createItem(batchId, { upc: 'H1', name: 'Blue Buffalo Life Protection Chicken 30 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const blocked = createItem(batchId, { upc: 'H2', name: 'Blue Buffalo Life Protection Chicken 15 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    makeItemExtractionReady(ok1, `https://brand.example.com/products/${ok1}`);
    makeItemExtractionFailed(blocked);
    refreshCandidateCohorts(workspaceId, batchId);
    advanceItemsToNextStage([ok1]); // curation/pending
    const state = derive(batchId, ok1);
    expect(state.category).toBe('waiting_on_family');
    expect(state.label).toBe('Family blocked');
    expect(state.family!.blockedCount).toBe(1);
    expect(state.detail).toContain('Member failed in Extraction');
  });

  it('curation completed → ready_for_review / unreviewed', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U12', name: 'X', stage: 'curation', stageStatus: 'completed',
      sourceUrl: 'https://brand.example.com/p/x',
    });
    updateItemExtractionData(id, JSON.stringify(makeExtractionData()));
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_for_review');
    expect(state.reviewState).toBe('unreviewed');
    expect(state.activity).toBe('review');
  });

  it('review completed + durable reviewed → ready_for_review / reviewed', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U13', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_for_review');
    expect(state.reviewState).toBe('reviewed');
    expect(state.label).toBe('Reviewed — ready to approve');
  });

  it('approved + advanced to promotion → approved (approval does not export)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U14', name: 'X', stage: 'promotion', stageStatus: 'pending' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'operator' });
    const state = derive(batchId, id);
    expect(state.category).toBe('approved');
    expect(state.reviewState).toBe('approved');
    expect(state.label).toBe('Approved — ready to export');
  });

  it('approved + promotion completed + change-set drafts → ready_to_export', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U15', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'operator' });
    const cs = createChangeSet({ workspaceId, title: 'Onboarding: Test Batch', description: null, baseCommit: 'a'.repeat(40) });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'U15', operation: 'create', draftJson: '{}', baseJson: null, draftHash: 'h1' });
    updateChangeSetStatus(cs.id, 'approved');
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_to_export');
    expect(state.activity).toBe('export');
    expect(state.reviewState).toBe('approved');
  });

  it('promotion completed + change-set pushed → completed / exported (verified only)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U16', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    const cs = createChangeSet({ workspaceId, title: 'Onboarding: Test Batch', description: null, baseCommit: 'a'.repeat(40) });
    upsertChangeSetItem({ changeSetId: cs.id, sku: 'U16', operation: 'create', draftJson: '{}', baseJson: null, draftHash: 'h1' });
    updateChangeSetStatus(cs.id, 'pushed');
    const state = derive(batchId, id);
    expect(state.category).toBe('completed');
    expect(state.activity).toBe('export');
    expect(state.label).toBe('Exported');
  });

  it('promotion completed WITHOUT any change set → ready_to_export, never exported', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U17', name: 'X', stage: 'promotion', stageStatus: 'completed' });
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_to_export');
    expect(state.category).not.toBe('completed');
  });

  it('skipped item → skipped', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'U18', name: 'X', stage: 'discovery', stageStatus: 'skipped' });
    const state = derive(batchId, id);
    expect(state.category).toBe('skipped');
  });

  it('failed item anywhere → needs_attention / processing_failed / retry_processing', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'U19', name: 'X', stage: 'curation', stageStatus: 'failed',
      errorMessage: 'model_unavailable',
    });
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('processing_failed');
    expect(state.attentionAction).toBe('retry_processing');
  });
});

describe('batch work-state counts + filters', () => {
  it('counts every category across the batch', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'C1', name: 'A', stage: 'sourcing', stageStatus: 'pending' });
    createItem(batchId, { upc: 'C2', name: 'B', stage: 'discovery', stageStatus: 'needs_input' });
    createItem(batchId, { upc: 'C3', name: 'C', stage: 'curation', stageStatus: 'completed' });
    createItem(batchId, { upc: 'C4', name: 'D', stage: 'discovery', stageStatus: 'skipped' });
    const payload = getBatchWorkState(batchId);
    expect(payload.counts.processing).toBe(1);
    expect(payload.counts.needs_attention).toBe(1);
    expect(payload.counts.ready_for_review).toBe(1);
    expect(payload.counts.skipped).toBe(1);
    expect(payload.total).toBe(4);
  });

  it('filters by category, query, and paginates', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'F1', name: 'Alpha', stage: 'discovery', stageStatus: 'needs_input' });
    createItem(batchId, { upc: 'F2', name: 'Beta', stage: 'discovery', stageStatus: 'needs_input' });
    createItem(batchId, { upc: 'F3', name: 'Gamma', stage: 'sourcing', stageStatus: 'pending' });
    const onlyAttention = getBatchWorkState(batchId, { category: 'needs_attention' });
    expect(onlyAttention.items).toHaveLength(2);
    expect(onlyAttention.total).toBe(2);
    const byUpc = getBatchWorkState(batchId, { q: 'F2' });
    expect(byUpc.total).toBe(1);
    expect(byUpc.items[0].upc).toBe('F2');
    const paged = getBatchWorkState(batchId, { limit: 1, offset: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(3);
  });
});

describe('epic #46 review remediation — fix 2: semantic-blocked curation is never ready_for_review', () => {
  function seedCurationWithSemantic(itemId: string, status: 'blocked' | 'passed' | null): void {
    const payload: Record<string, unknown> = { curatedTitle: 'X', titleSource: 'web' };
    if (status) {
      payload.semanticValidation = {
        status,
        findings: status === 'blocked'
          ? [{ code: 'family_product_type', memberSku: 'SKU-1', message: 'Family members disagree on product type.' }]
          : [],
      };
    }
    getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(payload), itemId]);
  }

  it('curation/completed + blocked → needs_attention / semantic_validation_blocked (NEVER ready_for_review)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'S1', name: 'X', stage: 'curation', stageStatus: 'completed' });
    seedCurationWithSemantic(id, 'blocked');
    const state = derive(batchId, id);
    expect(state.category).toBe('needs_attention');
    expect(state.attentionReason).toBe('semantic_validation_blocked');
    expect(state.attentionAction).toBe('resolve_semantic_conflict');
    expect(state.label).toBe('Curation blocked by semantic validation');
    expect(state.detail).toContain('Family members disagree');
  });

  it('curation/completed + semantic passed → ready_for_review unchanged', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'S2', name: 'X', stage: 'curation', stageStatus: 'completed' });
    seedCurationWithSemantic(id, 'passed');
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_for_review');
    expect(state.attentionReason).toBeNull();
  });

  it('curation/completed WITHOUT semanticValidation → ready_for_review unchanged', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'S3', name: 'X', stage: 'curation', stageStatus: 'completed' });
    seedCurationWithSemantic(id, null);
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_for_review');
  });

  it('blocked curation items are excluded from the ready_for_review count', () => {
    const batchId = makeBatch();
    const ok = createItem(batchId, { upc: 'S4', name: 'X', stage: 'curation', stageStatus: 'completed' });
    const blocked = createItem(batchId, { upc: 'S5', name: 'Y', stage: 'curation', stageStatus: 'completed' });
    seedCurationWithSemantic(ok, null);
    seedCurationWithSemantic(blocked, 'blocked');
    const payload = getBatchWorkState(batchId);
    expect(payload.counts.ready_for_review).toBe(1);
    expect(payload.counts.needs_attention).toBe(1);
  });
});

describe('epic #46 review remediation — fix 3: change-set status is workspace-scoped', () => {
  it('a pushed change set for the same SKU in ANOTHER workspace never projects exported', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'SAME-SKU', name: 'X', stage: 'promotion', stageStatus: 'completed' });

    // Workspace B with an identical SKU that is PUSHED.
    const wsB = randomUUID();
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
       VALUES (?, 'ws-b', ?, '', ?, ?)`,
      [wsB, path.join(os.tmpdir(), `baystate-wsb-${wsB.slice(0, 8)}`), now, now],
    );
    const batchB = createBatch({ workspaceId: wsB, name: 'Batch B', fileName: 'b.csv', totalItems: 0 });
    void batchB;
    const csB = createChangeSet({ workspaceId: wsB, title: 'B', description: null, baseCommit: 'b'.repeat(40) });
    upsertChangeSetItem({ changeSetId: csB.id, sku: 'SAME-SKU', operation: 'create', draftJson: '{}', baseJson: null, draftHash: 'hb' });
    updateChangeSetStatus(csB.id, 'pushed');

    // Workspace A's batch has NO change set for this SKU → ready_to_export,
    // NEVER exported — the other workspace's pushed status must not leak.
    const state = derive(batchId, id);
    expect(state.category).toBe('ready_to_export');
    expect(state.label).toBe('Ready to export');

    // The repo primitive itself is workspace-scoped.
    expect(listChangeSetStatusBySkus(workspaceId, ['SAME-SKU']).has('SAME-SKU')).toBe(false);
    expect(listChangeSetStatusBySkus(wsB, ['SAME-SKU']).get('SAME-SKU')).toBe('pushed');
  });
});

describe('epic #46 review remediation — fix 5: search/filter contract', () => {
  it('domain filter matches the item DOMAIN only, never a family label that merely contains the string', () => {
    const batchId = makeBatch();
    // Cohort label contains "Purina" (family name) but the item's own source
    // domain is unrelated.
    const m1 = createItem(batchId, { upc: 'D1', name: 'Purina Pro Plan Chicken 30 lb', brandHint: 'Purina', stage: 'discovery', stageStatus: 'pending' });
    const m2 = createItem(batchId, { upc: 'D2', name: 'Purina Pro Plan Chicken 15 lb', brandHint: 'Purina', stage: 'discovery', stageStatus: 'pending' });
    makeItemExtractionReady(m1, 'https://unrelated-site.example/p/d1');
    makeItemExtractionReady(m2, 'https://unrelated-site.example/p/d2');
    refreshCandidateCohorts(workspaceId, batchId);
    advanceItemsToNextStage([m1, m2]);

    const byDomain = getBatchWorkState(batchId, { domain: 'purina' });
    expect(byDomain.total).toBe(0);
    const byDomain2 = getBatchWorkState(batchId, { domain: 'unrelated-site.example' });
    expect(byDomain2.total).toBe(2);
  });

  it('free-text q matches the source-type label (distributor record)', () => {
    const batchId = makeBatch();
    createItem(batchId, { upc: 'Q1', name: 'Alpha', stage: 'sourcing', stageStatus: 'completed', sourceType: 'distributor_record' });
    createItem(batchId, { upc: 'Q2', name: 'Beta', stage: 'sourcing', stageStatus: 'completed' });
    const bySource = getBatchWorkState(batchId, { q: 'distributor record' });
    expect(bySource.total).toBe(1);
    expect(bySource.items[0].upc).toBe('Q1');
  });

  it('free-text q matches the family/cohort label', () => {
    const batchId = makeBatch();
    const m1 = createItem(batchId, { upc: 'FQ1', name: 'Blue Buffalo Life Protection Chicken 30 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    const m2 = createItem(batchId, { upc: 'FQ2', name: 'Blue Buffalo Life Protection Chicken 15 lb', brandHint: 'Blue Buffalo', stage: 'discovery', stageStatus: 'pending' });
    makeItemExtractionReady(m1, `https://brand.example.com/products/${m1}`);
    makeItemExtractionReady(m2, `https://brand.example.com/products/${m2}`);
    refreshCandidateCohorts(workspaceId, batchId);
    advanceItemsToNextStage([m1, m2]);
    const byFamily = getBatchWorkState(batchId, { q: 'life protection chicken' });
    expect(byFamily.total).toBe(2);
  });
});

describe('brand assignment work-state projection', () => {
  it('projects held missing_brand items into needs_attention with brand_not_provided', () => {
    const batchId = makeBatch();
    const itemId = createItem(batchId, {
      upc: 'NO-BRAND-1',
      name: 'Acana Grasslands 25lb',
      stage: 'sourcing',
      stageStatus: 'pending',
    });

    const db = getDb();
    db.run("UPDATE onboarding_items SET is_held = 1, held_reason = 'missing_brand' WHERE id = ?", [itemId]);

    const res = getBatchWorkState(batchId);
    expect(res.total).toBe(1);
    expect(res.items[0].category).toBe('needs_attention');
    expect(res.items[0].attentionReason).toBe('brand_not_provided');
    expect(res.items[0].attentionAction).toBe('assign_brand');
    expect(res.items[0].label).toBe('Brand assignment required');
  });

  it('projects discovery needs_input items without brandHint into brand_not_provided', () => {
    const batchId = makeBatch();
    const itemId = createItem(batchId, {
      upc: 'NO-BRAND-2',
      name: 'Fromm Gold Adult Dog 30lb',
      brandHint: null,
      stage: 'discovery',
      stageStatus: 'needs_input',
    });

    const res = getBatchWorkState(batchId);
    expect(res.total).toBe(1);
    expect(res.items[0].category).toBe('needs_attention');
    expect(res.items[0].attentionReason).toBe('brand_not_provided');
    expect(res.items[0].attentionAction).toBe('assign_brand');
  });
});

