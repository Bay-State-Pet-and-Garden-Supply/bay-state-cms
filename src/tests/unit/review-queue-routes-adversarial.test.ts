import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { markReviewed, markApproved, markReviewInvalidated } from '../../db/repositories/onboarding-review-repo';
import { getBatchReviewQueue } from '../../onboarding/onboarding-review-queue';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import {
  ReviewQueuePageSchema,
  encodeReviewQueueCursor,
  computeReviewQueueFilterHash,
  type ReviewQueueFilters,
} from '../../shared/schemas/onboarding-review-queue';

let workspaceId: string;
let workspacePath: string;
let dbPath: string;
let testBatchId: string;
let foreignBatchId: string;
const TOTAL_ITEMS = 105;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  return app;
}

beforeAll(async () => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-review-queue-adv-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');

  initDb(dbPath);
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'Review Queue Adversarial Workspace',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  // Create active workspace batch with 105 items having identical names and brands
  const batch = createBatch({
    workspaceId,
    name: 'Review Queue Stress Batch',
    fileName: 'stress.csv',
    totalItems: TOTAL_ITEMS,
  });
  testBatchId = batch.id;

  const itemSeeds = [];
  for (let i = 1; i <= TOTAL_ITEMS; i++) {
    const idStr = String(i).padStart(3, '0');
    itemSeeds.push({
      upc: `111111111${idStr}`,
      name: 'Identical Adversarial Product 30lb',
      rowNumber: i,
    });
  }
  const inserted = insertItems(testBatchId, itemSeeds);

  // Set items to review / completed stage with curation and extraction data
  const db = getDb();
  for (let i = 0; i < inserted.length; i++) {
    const item = inserted[i];
    const hasCuration = i % 2 === 0;
    const curationJson = JSON.stringify({
      curatedTitle: 'Identical Adversarial Product 30lb',
      brandHint: 'Blue Buffalo',
      suggestedPages: ['cat-dog-food'],
      reviewedMedia: { primaryImage: `https://images.example.com/img-${i}.jpg` },
      description: 'PROHIBITED IN SERVER PROJECTION',
      curationData: 'PROHIBITED IN SERVER PROJECTION',
    });
    const extractionJson = JSON.stringify({
      title: 'Identical Adversarial Product 30lb',
      price: '$49.99',
      primaryImage: `https://images.example.com/ext-${i}.jpg`,
      extractionData: 'PROHIBITED IN SERVER PROJECTION',
    });

    db.run(
      `UPDATE onboarding_items
       SET stage = 'review',
           stage_status = 'completed',
           brand_hint = 'Blue Buffalo',
           price = '$49.99',
           curation_data_json = ?,
           extraction_data_json = ?
       WHERE id = ?`,
      [hasCuration ? curationJson : null, extractionJson, item.id],
    );
  }

  // Create foreign workspace batch
  const foreignWorkspaceId = 'ws-foreign-workspace';
  insertWorkspace({
    id: foreignWorkspaceId,
    name: 'Foreign Workspace',
    workspacePath: path.join(workspacePath, 'foreign'),
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  const foreignBatch = createBatch({
    workspaceId: foreignWorkspaceId,
    name: 'Foreign Batch',
    fileName: 'foreign.csv',
    totalItems: 5,
  });
  foreignBatchId = foreignBatch.id;
});

describe('Active review scope and progress (#280 service + HTTP seam)', () => {
  it('returns selected metadata beyond the page without changing rows, counts, or cursor identity', async () => {
    const first = getBatchReviewQueue(testBatchId, { limit: 50 });
    const second = getBatchReviewQueue(testBatchId, { limit: 50, cursor: first.nextCursor! });
    const selected = second.rows[10];
    const app = makeApp();
    const response = await app.request(`/api/onboarding/batches/${testBatchId}/review-queue?limit=50&selectedItemId=${selected.itemId}`);
    expect(response.status).toBe(200);
    const result = ReviewQueuePageSchema.parse(await response.json());
    expect(result.rows).toEqual(first.rows);
    expect(result.selectedRow?.itemId).toBe(selected.itemId);
    expect(result.counts).toEqual(first.counts);
    expect(result.nextCursor).toBe(first.nextCursor);
    expect(computeReviewQueueFilterHash({ limit: 50, selectedItemId: selected.itemId })).toBe(computeReviewQueueFilterHash({ limit: 50 }));
    expect(getBatchReviewQueue(testBatchId, { limit: 50, brand: 'No matching brand', selectedItemId: selected.itemId }).selectedRow).toBeNull();
    const foreign = getDb().query('SELECT id FROM onboarding_items WHERE batch_id = ? LIMIT 1').get(foreignBatchId) as { id: string } | undefined;
    // An unknown or foreign selection returns no context rather than fetching across scopes.
    expect(getBatchReviewQueue(testBatchId, { selectedItemId: foreign?.id ?? 'foreign-item' }).selectedRow).toBeNull();
  });

  function fixture() {
    const batch = createBatch({ workspaceId, name: 'Review decisions', fileName: 'decisions.csv', totalItems: 10 });
    const items = insertItems(batch.id, [
      'Needs review', 'Durably reviewed', 'Legacy reviewed', 'Approved awaiting drafts',
      'Skipped review', 'Skipped approved', 'Draft created legacy', 'Still preparing',
      'Invalidated and preparing', 'Preparation complete',
    ].map((name, i) => ({ upc: `${batch.id.slice(0, 8)}-${i}`, name, rowNumber: i + 1 })));
    const contexts = [
      ['review_listings', 'pending'], ['review', 'completed'], ['review_listings', 'completed'],
      ['create_drafts', 'pending'], ['review', 'skipped'], ['promotion', 'skipped'],
      ['create_drafts', 'completed'], ['prepare_listing', 'pending'], ['curation', 'pending'],
      ['prepare_listing', 'completed'],
    ];
    items.forEach((item, i) => getDb().run(
      'UPDATE onboarding_items SET stage = ?, stage_status = ?, price = ?, brand_hint = ?, curation_data_json = ?, extraction_data_json = ? WHERE id = ?',
      [contexts[i][0], contexts[i][1], '19.99', 'Acme', JSON.stringify({ curatedTitle: item.name, suggestedPages: ['Pet food'] }), JSON.stringify({ primaryImage: 'https://example.test/image.jpg' }), item.id],
    ));
    for (const index of [1, 3, 5, 8]) markReviewed({ itemId: items[index].id, batchId: batch.id, reviewedBy: 'test' });
    for (const index of [3, 5]) markApproved({ itemId: items[index].id, batchId: batch.id, approvedBy: 'test' });
    markReviewInvalidated(items[8].id, 'Preparing changed output');
    return { batch, items };
  }

  it('excludes skipped and downstream completed rows before pagination, retaining review/completed history', () => {
    const { batch, items } = fixture();
    const all = ReviewQueuePageSchema.parse(getBatchReviewQueue(batch.id));
    expect(all.counts.total).toBe(5);
    expect(all.counts.reviewedTotal).toBe(3); // legacy field includes approved
    expect(all.statusTotals).toEqual({ unreviewed: 2, reviewed: 2, approved: 1 });
    expect(all.progress).toEqual({ total: 5, reviewed: 3, remaining: 2 });
    expect(new Set(all.rows.map(r => r.itemId))).toEqual(new Set([0, 1, 2, 3, 9].map(i => items[i].id)));
    expect(all.rows.find(r => r.itemId === items[2].id)?.reviewState).toBe('reviewed');
    expect(all.rows.find(r => r.itemId === items[2].id)?.actions?.canApprove).toBe(false);
    expect(all.rows.find(r => r.itemId === items[1].id)?.actions?.canApprove).toBe(true);
    expect(all.rows.find(r => r.itemId === items[9].id)?.actions?.canCompleteReview).toBe(false);
    const approved = all.rows.find(r => r.itemId === items[3].id)!;
    expect(approved.stage).toBe('create_drafts');
    expect(approved.actions).toEqual({ canEdit: false, canCompleteReview: false, canApprove: false });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const current = getBatchReviewQueue(batch.id, { reviewStates: ['unreviewed'], limit: 1, cursor });
      expect(current.rows).toHaveLength(1);
      expect(current.counts.total).toBe(2);
      expect(current.statusTotals).toEqual(all.statusTotals);
      expect(current.progress).toEqual(all.progress);
      seen.push(current.rows[0].itemId);
      cursor = current.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set([items[0].id, items[9].id]));
  });

  it('provides filter-independent status totals and progress through the actual validated route', async () => {
    const { batch } = fixture();
    const app = makeApp();
    for (const state of ['unreviewed', 'reviewed', 'approved']) {
      const res = await app.request(`/api/onboarding/batches/${batch.id}/review-queue?reviewStates=${state}&limit=1`);
      expect(res.status).toBe(200);
      const current = ReviewQueuePageSchema.parse(await res.json());
      expect(current.rows.every(r => r.reviewState === state)).toBe(true);
      expect(current.counts.total).toBe(state === 'approved' ? 1 : 2);
      expect(current.statusTotals).toEqual({ unreviewed: 2, reviewed: 2, approved: 1 });
      expect(current.progress).toEqual({ total: 5, reviewed: 3, remaining: 2 });
    }
    const searched = getBatchReviewQueue(batch.id, { q: 'Legacy', reviewStates: ['unreviewed'] });
    expect(searched.counts.total).toBe(0);
    expect(searched.statusTotals).toEqual({ unreviewed: 0, reviewed: 1, approved: 0 });
    expect(searched.progress).toEqual({ total: 5, reviewed: 3, remaining: 2 });
  });

  it('invalidation changes status and command eligibility without confusing completed review with a terminal outcome', () => {
    const { batch, items } = fixture();
    markReviewInvalidated(items[1].id, 'Listing changed');
    const current = getBatchReviewQueue(batch.id, { reviewStates: ['unreviewed'] });
    const changed = current.rows.find(r => r.itemId === items[1].id)!;
    expect(changed.stageStatus).toBe('completed');
    expect(changed.actions).toEqual({ canEdit: true, canCompleteReview: true, canApprove: false });
    expect(current.statusTotals).toEqual({ unreviewed: 3, reviewed: 1, approved: 1 });
    expect(current.progress).toEqual({ total: 5, reviewed: 2, remaining: 3 });
    expect(getBatchReviewQueue(batch.id, { q: 'Still preparing' }).rows).toHaveLength(0);
  });

  it('uses the same collation for sorting and cursor traversal of accented titles', () => {
    const batch = createBatch({ workspaceId, name: 'Cursor collation', fileName: 'collation.csv', totalItems: 4 });
    const items = insertItems(batch.id, ['Å product', 'Z product', 'É product', 'A product'].map((name, i) => ({ name, upc: `accent-${batch.id}-${i}`, rowNumber: i + 1 })));
    items.forEach(item => getDb().run("UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?", [item.id]));
    const expected = getBatchReviewQueue(batch.id).rows.map(r => r.itemId);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const current = getBatchReviewQueue(batch.id, { limit: 1, cursor });
      seen.push(...current.rows.map(r => r.itemId));
      cursor = current.nextCursor ?? undefined;
      if (seen.length > 4) throw new Error('Cursor did not advance');
    } while (cursor);
    expect(seen).toEqual(expected);
  });
});

afterAll(() => {
  closeDb();
  if (workspacePath && fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

describe('GET /api/onboarding/batches/:id/review-queue Adversarial Route Tests', () => {
  const app = makeApp();

  it('serves valid review queue with 200 and schema-compliant projection payload', async () => {
    const res = await app.request(`/api/onboarding/batches/${testBatchId}/review-queue?limit=25`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = ReviewQueuePageSchema.parse(body);

    expect(parsed.batchId).toBe(testBatchId);
    expect(parsed.rows.length).toBe(25);
    expect(parsed.counts.total).toBe(TOTAL_ITEMS);
    expect(parsed.nextCursor).not.toBeNull();
    expect(parsed.projectionHealth.status).toBe('healthy');

    // Verify PROHIBITED detail fields were stripped in server projection
    for (const row of parsed.rows) {
      expect((row as any).description).toBeUndefined();
      expect((row as any).curatedDescription).toBeUndefined();
      expect((row as any).curationData).toBeUndefined();
      expect((row as any).extractionData).toBeUndefined();
      expect((row as any).packagingOcrData).toBeUndefined();
      expect((row as any).sourceHtml).toBeUndefined();
    }
  });

  describe('Adversarial Cursor Injection and Tampering over HTTP', () => {
    it('returns HTTP 400 with malformed_cursor for unparseable cursor string (NO silent page 1 restart)', async () => {
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?cursor=invalid!base64url!string`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
      expect(body.error).toContain('Malformed review queue cursor');
    });

    it('returns HTTP 400 with malformed_cursor for valid base64url non-JSON payload', async () => {
      const badCursor = Buffer.from('this is not json {', 'utf8').toString('base64url');
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?cursor=${badCursor}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
    });

    it('returns HTTP 400 with malformed_cursor for tampered version (v: 2)', async () => {
      const filters: ReviewQueueFilters = { brand: 'Blue Buffalo' };
      const filterHash = computeReviewQueueFilterHash(filters);
      const tamperedV2 = encodeReviewQueueCursor({
        v: 2 as any,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash,
      });

      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?brand=Blue Buffalo&cursor=${tamperedV2}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('malformed_cursor');
    });

    it('returns HTTP 400 with filter_mismatch when cursor is used with altered query filters', async () => {
      // Cursor generated with warningsOnly: true
      const filters1: ReviewQueueFilters = { warningsOnly: true };
      const filterHash1 = computeReviewQueueFilterHash(filters1);
      const cursor = encodeReviewQueueCursor({
        v: 1,
        sortKey: '0:key:item-1',
        itemId: 'item-1',
        filterHash: filterHash1,
      });

      // Request sent with warningsOnly: false
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?warningsOnly=false&cursor=${cursor}`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('filter_mismatch');
      expect(body.error).toContain('Cursor filter hash does not match');
    });

    it('returns HTTP 400 when query parameter validation fails', async () => {
      const res = await app.request(
        `/api/onboarding/batches/${testBatchId}/review-queue?gateStatus=unsupported_status`,
      );
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe('Invalid query filters');
    });
  });

  describe('Workspace Scoping and 404 Guards', () => {
    it('returns HTTP 404 for non-existent batch ID', async () => {
      const res = await app.request('/api/onboarding/batches/batch-nonexistent-12345/review-queue');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Batch not found');
    });

    it('returns HTTP 404 for batch belonging to another workspace', async () => {
      const res = await app.request(`/api/onboarding/batches/${foreignBatchId}/review-queue`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Batch not found');
    });
  });

  describe('End-to-End Multi-Page HTTP Traversal with Tie-Breakers', () => {
    it('traverses 105 identical-title items across 4 HTTP requests with 0 duplicates and 0 missed items', async () => {
      const pageSize = 30;
      const collectedRows: any[] = [];
      let currentCursor: string | null = null;
      let pageNumber = 0;

      while (true) {
        pageNumber++;
        const url = currentCursor
          ? `/api/onboarding/batches/${testBatchId}/review-queue?limit=${pageSize}&cursor=${encodeURIComponent(currentCursor)}`
          : `/api/onboarding/batches/${testBatchId}/review-queue?limit=${pageSize}`;

        const res = await app.request(url);
        expect(res.status).toBe(200);

        const page = await res.json();
        expect(page.counts.total).toBe(TOTAL_ITEMS);

        collectedRows.push(...page.rows);
        currentCursor = page.nextCursor;

        if (!currentCursor) break;
        if (pageNumber > 10) throw new Error('Infinite loop detected in HTTP traversal');
      }

      // 105 items with pageSize 30 -> 4 pages (30, 30, 30, 15)
      expect(pageNumber).toBe(4);
      expect(collectedRows.length).toBe(TOTAL_ITEMS);

      // Verify ZERO duplicate items across all pages
      const collectedIds = collectedRows.map(r => r.itemId);
      const uniqueIds = new Set(collectedIds);
      expect(uniqueIds.size).toBe(TOTAL_ITEMS);

      // Verify sort ordering is strictly monotonic across all pages
      for (let i = 0; i < collectedRows.length - 1; i++) {
        const curr = collectedRows[i];
        const next = collectedRows[i + 1];
        if (curr.sortKey === next.sortKey) {
          expect(curr.itemId.localeCompare(next.itemId)).toBeLessThan(0);
        } else {
          expect(curr.sortKey.localeCompare(next.sortKey)).toBeLessThan(0);
        }
      }
    });
  });
});
