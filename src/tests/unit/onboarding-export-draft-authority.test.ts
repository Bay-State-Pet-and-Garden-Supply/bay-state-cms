import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { closeDb, getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { findItemById, insertItems } from '../../db/repositories/onboarding-item-repo';
import { createExportDraftsWithReceipt, listExportDraftLinks, markApproved, markReviewed, markReviewInvalidated } from '../../db/repositories/onboarding-review-repo';
import { assignProductToPageId, listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { createChangeSet, listChangeSetItems, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { openPreparationGap } from '../../db/repositories/preparation-gap-repo';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { ProductSchema } from '../../shared/schemas/product';
import { hashJson } from '../../git/deterministic-json';
import { computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import { getItemWorkState } from '../../onboarding/onboarding-work-state';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import onboardingStageReadRoutes from '../../server/routes/onboarding-stage-read-routes';

let workspacePath: string;
let dbPath: string;
let workspaceId: string;
let pageId: string;
let app: Hono;
let originalToken: string | undefined;

function mount() {
  app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  app.route('/api', onboardingStageReadRoutes);
}

beforeEach(() => {
  originalToken = process.env.BAYSTATE_CMS_API_TOKEN;
  delete process.env.BAYSTATE_CMS_API_TOKEN;
  workspacePath = mkdtempSync(path.join(os.tmpdir(), 'export-draft-authority-'));
  dbPath = path.join(workspacePath, 'fixture.db');
  workspaceId = randomUUID();
  initDb(dbPath);
  runMigrations();
  const now = new Date().toISOString();
  insertWorkspace({ id: workspaceId, name: 'Isolated fixture', workspacePath, gitPath: '',
    createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: 'a'.repeat(40) });
  activatePageImportFromRecords({ workspaceId, sourceHash: createHash('sha256').update('fixture pages').digest('hex'),
    parserFormatVersion: 'pages-xml-1', activatedBy: 'fixture', records: [{
      identity: { kind: 'exported_guid', key: 'fixture-toys', status: 'verified' },
      name: 'Toys', parentRef: null, availability: 'available',
    }] });
  pageId = listVerifiedPageOptions(workspaceId)[0].id;
  mount();
});

afterEach(() => {
  closeDb();
  rmSync(workspacePath, { recursive: true, force: true });
  if (originalToken === undefined) delete process.env.BAYSTATE_CMS_API_TOKEN;
  else process.env.BAYSTATE_CMS_API_TOKEN = originalToken;
});

function seed(count = 1, stage = 'promotion') {
  const batch = createBatch({ workspaceId, name: 'Draft fixture', fileName: 'fixture.csv', totalItems: count });
  const items = insertItems(batch.id, Array.from({ length: count }, (_, i) => ({
    upc: `FIXTURE-${i}`, name: `Fixture Brand Toy ${i}`, brandHint: 'Fixture Brand', price: '$12.50', rowNumber: i + 1,
    stage: stage as never, stageStatus: 'pending' as const,
  })), stage as never, 1);
  for (const item of items) {
    getDb().query('UPDATE onboarding_items SET extraction_data_json = ?, curation_data_json = ? WHERE id = ?').run(
      JSON.stringify({ title: item.name, description: 'Fixture description', primaryImage: 'fixture/toy.jpg', additionalImages: [], customFields: {} }),
      JSON.stringify({ curatedTitle: item.name, suggestedPages: ['Toys'] }), item.id);
    assignProductToPageId(item.upc, pageId, 'Toys');
    markReviewed({ itemId: item.id, batchId: batch.id, reviewedBy: 'fixture' });
    markApproved({ itemId: item.id, batchId: batch.id, approvedBy: 'fixture' });
  }
  return { batch, items };
}

function attachRun(item: { id: string; upc: string }) {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  db.query(`INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
    VALUES (?, ?, ?, ?, 'completed', ?)`).run(runId, workspaceId, item.id, item.upc, now);
  db.query("UPDATE onboarding_items SET curation_data_json = json_set(curation_data_json, '$.classificationRunId', ?) WHERE id = ?").run(runId, item.id);
  const proposalId = randomUUID();
  db.query(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
    VALUES (?, ?, ?, 'category_page', ?, ?, 1.0, 'accepted', ?)`).run(proposalId, runId, item.upc, pageId, JSON.stringify({ pageId, pageName: 'Toys' }), now);
  db.query(`INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_key, created_at)
    VALUES (?, ?, 'accepted', ?, ?)`).run(randomUUID(), proposalId, randomUUID(), now);
}

async function create(batchId: string, itemIds: string[], key = randomUUID()) {
  const response = await app.request(`/api/onboarding/batches/${batchId}/create-export-drafts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ itemIds }),
  });
  expect(response.status).toBe(200);
  return await response.json() as any;
}

async function read(batchId: string, category?: string) {
  const response = await app.request(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?stage=create_drafts${category ? `&category=${category}` : ''}`);
  expect(response.status).toBe(200);
  return await response.json() as any;
}

describe('persisted export-draft authority (#332)', () => {
  it('retains origin linkage across ordinary Catalog edits and cold reads', async () => {
    const { batch, items: [item] } = seed();
    const result = await create(batch.id, [item.id]);
    const before = listExportDraftLinks(workspaceId, [item.id]).get(item.id)!;
    const raw = JSON.parse(listChangeSetItems(result.changeSetId)[0].draftJson);
    const { autosaveDraft } = await import('../../server/services/product-service');
    const saved = autosaveDraft(workspaceId, workspacePath, item.upc, {
      core: { ...raw.core, price: '13.00' }, customFields: raw.customFields, shopsite: raw.shopsite,
    });
    expect(saved.changeSetId).toBe(result.changeSetId);
    expect(JSON.parse(listChangeSetItems(result.changeSetId)[0].draftJson).itemId).toBeUndefined();
    closeDb(); initDb(dbPath); mount();
    expect(listExportDraftLinks(workspaceId, [item.id]).get(item.id)).toEqual(before);
    expect((await read(batch.id)).items[0].category).toBe('ready_to_export');
  });

  it('preserves different-key duplicate protection after editing an older incomplete draft', async () => {
    const { batch, items: [item] } = seed();
    const first = await create(batch.id, [item.id]);
    getDb().query("UPDATE onboarding_items SET stage_status = 'pending' WHERE id = ?").run(item.id);
    const raw = JSON.parse(listChangeSetItems(first.changeSetId)[0].draftJson);
    const { autosaveDraft } = await import('../../server/services/product-service');
    autosaveDraft(workspaceId, workspacePath, item.upc, {
      core: { ...raw.core, price: '13.00' }, customFields: raw.customFields, shopsite: raw.shopsite,
    });
    const duplicate = await create(batch.id, [item.id]);
    expect(duplicate.created).toEqual([]);
    expect(duplicate.rejected).toEqual([{ itemId: item.id, reason: 'already_drafted' }]);
    expect(JSON.parse(listChangeSetItems(first.changeSetId)[0].draftJson).core.price).toBe('13.00');
    expect((getDb().query('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n).toBe(1);
  });

  it('does not project a receipt as a draft when its persisted record is gone', async () => {
    const { batch, items: [item] } = seed();
    const result = await create(batch.id, [item.id]);
    getDb().query('DELETE FROM change_set_items WHERE change_set_id = ?').run(result.changeSetId);
    expect(listExportDraftLinks(workspaceId, [item.id]).size).toBe(0);
  });

  it('creates real catalog drafts and cold-loads them outside the approved scope', async () => {
    const { batch, items: [item] } = seed();
    const result = await create(batch.id, [item.id]);
    expect(result.created).toEqual([item.id]);
    closeDb();
    initDb(dbPath);
    mount();
    const all = await read(batch.id);
    expect(all.items[0].category).toBe('ready_to_export');
    expect(all.items[0].stageStatus).toBe('completed');
    expect((await read(batch.id, 'approved')).items).toEqual([]);
    const [draft] = listChangeSetItems(result.changeSetId);
    const raw = JSON.parse(draft.draftJson);
    expect(raw.itemId).toBe(item.id);
    expect(ProductSchema.safeParse(raw).success).toBe(true);
    expect(raw.sku).toBe(item.upc);
    expect(raw.core.productOnPages).toEqual(['Toys']);
    expect(raw.core.price).toBe('12.50');
    expect(draft.draftHash).toBe(hashJson(raw));
    expect(draft.changeSetId).toBe(result.changeSetId);
  });

  it('rejects a different-key repeat after remount without creating another draft', async () => {
    const { batch, items: [item] } = seed();
    const first = await create(batch.id, [item.id]);
    closeDb(); initDb(dbPath); mount();
    const repeat = await create(batch.id, [item.id]);
    expect(repeat.created).toEqual([]);
    expect(repeat.rejected).toHaveLength(1);
    expect(listChangeSetItems(first.changeSetId)).toHaveLength(1);
    expect((getDb().query('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n).toBe(1);
    expect(findItemById(item.id)?.stageStatus).toBe('completed');
  });

  it('replays mixed results exactly and retries only failures under a new key', async () => {
    const { batch, items: [success, stale, missing] } = seed(3);
    markReviewInvalidated(stale.id, 'changed after approval');
    getDb().query('UPDATE onboarding_items SET extraction_data_json = NULL WHERE id = ?').run(missing.id);
    const key = randomUUID();
    const ids = [success.id, stale.id, missing.id];
    const first = await create(batch.id, ids, key);
    expect(first.created).toEqual([success.id]);
    expect(first.rejected).toEqual(expect.arrayContaining([
      { itemId: stale.id, reason: 'not_approved' }, { itemId: missing.id, reason: 'Missing extraction data' },
    ]));
    expect(findItemById(missing.id)?.stageStatus).toBe('failed');
    closeDb(); initDb(dbPath); mount();
    expect(await create(batch.id, ids, key)).toEqual(first);
    markReviewed({ itemId: stale.id, batchId: batch.id, reviewedBy: 'fixture' });
    markApproved({ itemId: stale.id, batchId: batch.id, approvedBy: 'fixture' });
    getDb().query("UPDATE onboarding_items SET extraction_data_json = ?, stage_status = 'pending' WHERE id = ?").run(
      JSON.stringify({ title: missing.name, primaryImage: 'fixture/toy.jpg', additionalImages: [] }), missing.id);
    const retry = await create(batch.id, ids);
    expect(retry.created.sort()).toEqual([stale.id, missing.id].sort());
    expect(retry.rejected).toEqual([{ itemId: success.id, reason: 'not_eligible:promotion/completed' }]);
    expect((getDb().query('SELECT COUNT(*) AS n FROM change_set_items').get() as { n: number }).n).toBe(3);
  });

  it('retains transactional stale-approval authority after async preparation', async () => {
    const { batch, items: [item] } = seed();
    getDb().exec(`CREATE TRIGGER invalidate_at_receipt BEFORE INSERT ON onboarding_operation_receipts
      WHEN NEW.operation = 'export' BEGIN
        UPDATE onboarding_review_state SET review_invalidated_at = 'fixture-invalidated', approved_at = NULL;
      END`);
    const result = await create(batch.id, [item.id]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([{ itemId: item.id, reason: 'not_approved' }]);
    expect((getDb().query('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n).toBe(0);
  });

  it('reads actual linked drafts even if an older completion write is missing', async () => {
    const { batch, items: [item] } = seed();
    const result = await create(batch.id, [item.id]);
    getDb().query("UPDATE onboarding_items SET stage_status = 'pending' WHERE id = ?").run(item.id);
    closeDb(); initDb(dbPath); mount();
    expect((await read(batch.id)).items[0].category).toBe('ready_to_export');
    expect(getItemWorkState(item.id)?.category).toBe('ready_to_export');
    expect((await read(batch.id, 'approved')).items).toEqual([]);
    const links = listExportDraftLinks(workspaceId, [item.id]);
    expect(links.get(item.id)?.changeSetId).toBe(result.changeSetId);
    expect((await create(batch.id, [item.id])).rejected).toEqual([{ itemId: item.id, reason: 'already_drafted' }]);
    getDb().query("UPDATE change_sets SET status = 'pushed' WHERE id = ?").run(result.changeSetId);
    expect((await read(batch.id)).items[0].category).toBe('completed');
  });

  it('does not treat an unrelated same-SKU draft as item linkage', async () => {
    const { batch, items: [item] } = seed();
    const first = await create(batch.id, [item.id]);
    const otherBatch = createBatch({ workspaceId, name: 'Other fixture', fileName: 'other.csv', totalItems: 1 });
    const [other] = insertItems(otherBatch.id, [{ upc: item.upc, name: item.name, brandHint: item.brandHint, rowNumber: 1,
      stage: 'promotion', stageStatus: 'pending' }], 'promotion', 1);
    markReviewed({ itemId: other.id, batchId: otherBatch.id, reviewedBy: 'fixture' });
    markApproved({ itemId: other.id, batchId: otherBatch.id, approvedBy: 'fixture' });
    expect(listExportDraftLinks(workspaceId, [other.id]).size).toBe(0);
    expect((await read(otherBatch.id)).items[0].category).toBe('approved');
    expect(listChangeSetItems(first.changeSetId)).toHaveLength(1);
  });

  it('enforces workspace isolation at the repository and linked-read boundary', async () => {
    const { batch, items: [item] } = seed();
    await create(batch.id, [item.id]);
    expect(listExportDraftLinks('other-workspace', [item.id]).size).toBe(0);
    await expect(createExportDraftsWithReceipt({ workspaceId: 'other-workspace', batchId: batch.id, itemIds: [item.id],
      requestedBy: 'fixture', principal: 'fixture', role: 'system', requestHash: computeRequestHash([item.id]),
    })).rejects.toThrow('batch_workspace_mismatch');
  });

  it('completes native v2 stages without changing their stored spelling', async () => {
    getDb().query("INSERT INTO app_meta (key, value) VALUES ('onboarding_stage_vocabulary_version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
    const { batch, items: [item] } = seed(1, 'create_drafts');
    const result = await create(batch.id, [item.id]);
    expect(result.created).toEqual([item.id]);
    expect(findItemById(item.id)?.stage).toBe('create_drafts');
    expect(findItemById(item.id)?.stageStatus).toBe('completed');
    expect((await create(batch.id, [item.id])).created).toEqual([]);
  });

  it('rolls back native drafts, completion, linkage and receipts on audit failure', async () => {
    const { batch, items: [item] } = seed();
    getDb().exec("CREATE TRIGGER fail_export_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'create_export_draft' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END");
    const response = await app.request(`/api/onboarding/batches/${batch.id}/create-export-drafts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(response.status).toBe(500);
    for (const table of ['change_sets', 'change_set_items', 'onboarding_operation_receipts']) {
      expect((getDb().query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect(findItemById(item.id)?.stageStatus).toBe('pending');
    expect(listExportDraftLinks(workspaceId, [item.id]).size).toBe(0);
    getDb().exec('DROP TRIGGER fail_export_audit');
    expect((await create(batch.id, [item.id])).created).toEqual([item.id]);
  });

  it('keeps open-gap, semantic and filename authority on the receipt command', async () => {
    const { batch, items: [gap, semantic, filename] } = seed(3);
    openPreparationGap({ workspaceId, itemId: gap.id, batchId: batch.id, missingFields: ['description'], reason: 'Fixture gap' });
    attachRun(semantic);
    getDb().query("UPDATE onboarding_items SET curation_data_json = json_set(curation_data_json, '$.semanticValidation', json(?)) WHERE id = ?").run(
      JSON.stringify({ status: 'blocked', findings: [{ message: 'Fixture semantic hold' }] }), semantic.id);
    attachRun(filename);
    getDb().query("UPDATE onboarding_items SET curation_data_json = json_set(curation_data_json, '$.curatedTitle', ?), extraction_data_json = json_set(extraction_data_json, '$.seoFileName', ?) WHERE id = ?").run(
      'Fixture Brand Toy 2 5 LB', 'fixture-brand-toy-2.html', filename.id);
    const reservation = createChangeSet({ workspaceId, title: 'Fixture reservation', baseCommit: 'a'.repeat(40) });
    const reserved = { sku: 'FOREIGN', core: { name: 'Foreign fixture' }, customFields: { FileName: 'fixture-brand-toy-2.html' } };
    upsertChangeSetItem({ changeSetId: reservation.id, sku: 'FOREIGN', operation: 'create', draftJson: JSON.stringify(reserved), baseJson: null, draftHash: hashJson(reserved) });
    const result = await create(batch.id, [gap.id, semantic.id, filename.id]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { itemId: gap.id, reason: expect.stringContaining('preparation_gap_unresolved') },
      { itemId: semantic.id, reason: expect.stringContaining('Fixture semantic hold') },
      { itemId: filename.id, reason: expect.stringContaining('duplicate_filename') },
    ]));
    expect(listExportDraftLinks(workspaceId, [gap.id, semantic.id, filename.id]).size).toBe(0);
  });

  it.each(['completed', 'running', 'failed', 'skipped'])('refuses %s items without changing their state', async status => {
    const { batch, items: [item] } = seed();
    getDb().query('UPDATE onboarding_items SET stage_status = ? WHERE id = ?').run(status, item.id);
    const result = await create(batch.id, [item.id]);
    expect(result.created).toEqual([]);
    expect(result.rejected).toEqual([{ itemId: item.id, reason: `not_eligible:promotion/${status}` }]);
    expect(findItemById(item.id)?.stageStatus).toBe(status as never);
  });

  it('serializes simultaneous different keys at final item authority', async () => {
    const { batch, items: [item] } = seed();
    const results = await Promise.all([create(batch.id, [item.id]), create(batch.id, [item.id])]);
    expect(results.flatMap(result => result.created)).toEqual([item.id]);
    expect((getDb().query('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n).toBe(1);
    expect(findItemById(item.id)?.stageStatus).toBe('completed');
  });

  it('replays simultaneous mixed in-batch and missing-item results without duplicate rejections', async () => {
    const { batch, items: [item] } = seed();
    const ids = [item.id, randomUUID()];
    const key = randomUUID();
    const [a, b] = await Promise.all([create(batch.id, ids, key), create(batch.id, ids, key)]);
    expect(a).toEqual(b);
    expect(a.created).toEqual([item.id]);
    expect(a.rejected).toEqual([{ itemId: ids[1], reason: 'item_not_found' }]);
  });
});
