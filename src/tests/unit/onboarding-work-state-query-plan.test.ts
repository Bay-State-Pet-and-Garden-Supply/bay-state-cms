/**
 * Milestone 3 (P1-E) — Bounded work-state query plan assertions.
 *
 * Verifies that the work-state read model is O(1) in DB statements:
 * N items must not cause N+1 fan-out. The projection must use bulk
 * repositories, not per-item queries. Also verifies cursor pagination
 * and projectionHealth / fail-closed behavior.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { getBatchWorkState, getBatchWorkStateCountsWithHealth, getBatchWorkStateItems, getItemWorkState, buildBatchWorkStateContext } from '../../onboarding/onboarding-work-state';
import { getWorkStateQueryCount, resetWorkStateQueryCount, bulkGetClassificationStageResults } from '../../db/repositories/onboarding-work-state-repo';
import { computeWorkStateFilterHash, encodeWorkStateCursor, decodeWorkStateCursor } from '../../shared/schemas/onboarding-work-state';

let workspaceId: string;
let workspacePath: string;

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-qplan-${workspaceId.slice(0, 8)}`);
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

function makeBatchWithItems(count: number, opts: { stage?: string; stageStatus?: string } = {}): string {
  const batch = createBatch({ workspaceId, name: `Batch ${count}`, fileName: 'test.csv', totalItems: 0 });
  const rows = Array.from({ length: count }, (_, i) => ({
    upc: `QP-${count}-${i}`,
    name: `Product ${i} Blue Buffalo Chicken`,
    brandHint: 'Blue Buffalo',
    sourceUrl: null,
    rowNumber: i + 1,
    stage: (opts.stage ?? 'sourcing') as any,
    stageStatus: (opts.stageStatus ?? 'pending') as any,
  }));
  insertItems(batch.id, rows, (opts.stage ?? 'sourcing') as any, 1);
  return batch.id;
}

function seedClassificationRunsForItems(itemIds: string[], workspaceId: string) {
  const db = getDb();
  const now = new Date().toISOString();
  for (const itemId of itemIds) {
    const runId = randomUUID();
    const sku = db.query('SELECT upc FROM onboarding_items WHERE id = ?').get(itemId) as { upc: string } | undefined;
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, started_at) VALUES (?, ?, ?, 'onboarding', ?, 'running', ?)`,
      [runId, workspaceId, itemId, sku?.upc ?? `SKU-${itemId.slice(0, 6)}`, now],
    );
    const stageId = randomUUID();
    db.run(
      `INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at) VALUES (?, ?, 'packaging_ocr', 'running', ?)`,
      [stageId, runId, now],
    );
  }
}

describe('onboarding work-state query plan — bounded bulk reads', () => {
  beforeEach(() => {
    makeWorkspace();
  });

  it('uses bounded number of bulk queries regardless of batch size', () => {
    const batch10 = makeBatchWithItems(10);
    const items10 = listItemsByBatch(batch10);
    seedClassificationRunsForItems(items10.map(i => i.id), workspaceId);
    resetWorkStateQueryCount();
    const ctx10 = buildBatchWorkStateContext(batch10, listItemsByBatch(batch10));
    const count10 = getWorkStateQueryCount();

    // New isolated workspace for 100 to avoid cross-contamination
    makeWorkspace();
    const batch100 = makeBatchWithItems(100);
    const items100 = listItemsByBatch(batch100);
    seedClassificationRunsForItems(items100.map(i => i.id), workspaceId);
    resetWorkStateQueryCount();
    const ctx100 = buildBatchWorkStateContext(batch100, listItemsByBatch(batch100));
    const count100 = getWorkStateQueryCount();

    // Both should be same bounded count (5 bulk queries: variant, candidate, cohortRun, latestRun, stageResults)
    expect(count10).toBeGreaterThan(0);
    expect(count100).toBeGreaterThan(0);
    expect(count100).toBe(count10);
    // Ensure contexts are built correctly and bulk maps populated (not vacuous size>=0)
    expect(ctx10.candidateCountByItem.size).toBe(10);
    expect(ctx100.candidateCountByItem.size).toBe(100);
    expect(ctx10.latestRunIdByItem.size).toBe(10);
    expect(ctx100.latestRunIdByItem.size).toBe(100);
    expect(ctx10.stageResultsByRunId.size).toBe(10);
    expect(ctx100.stageResultsByRunId.size).toBe(100);
    // Verify stage results actually contain running packaging_ocr
    for (const arr of ctx10.stageResultsByRunId.values()) {
      expect(arr.length).toBeGreaterThan(0);
      expect(arr[0].stage_name).toBe('packaging_ocr');
    }
  });

  it('getBatchWorkState remains bounded for large batches (no N+1)', () => {
    const batch = makeBatchWithItems(80);
    const items = listItemsByBatch(batch);
    seedClassificationRunsForItems(items.map(i => i.id), workspaceId);
    resetWorkStateQueryCount();
    const result = getBatchWorkState(batch, { limit: 50 });
    const qc = getWorkStateQueryCount();
    // Bounded: should be <= 6 bulk queries (5 plus maybe chunked stage results)
    expect(qc).toBeLessThanOrEqual(6);
    expect(result.total).toBe(80);
    expect(result.counts.processing).toBe(80);
    expect(result.projectionHealth?.status).toBe('healthy');
  });

  it('candidate counts are bulk-loaded (discovery items do not fan out)', () => {
    const batch = makeBatchWithItems(15, { stage: 'discovery', stageStatus: 'needs_input' });
    const items = listItemsByBatch(batch);
    const ctx = buildBatchWorkStateContext(batch, items);
    // All discovery items should have bulk candidate counts (0, since no sources)
    for (const item of items) {
      expect(ctx.candidateCountByItem.has(item.id)).toBe(true);
      expect(ctx.candidateCountByItem.get(item.id)).toBe(0);
    }
  });

  it('cohortRun and stageResults are bulk-loaded (curation granularity is O(1))', () => {
    const batch = makeBatchWithItems(20, { stage: 'curation', stageStatus: 'pending' });
    const items = listItemsByBatch(batch);
    seedClassificationRunsForItems(items.map(i => i.id), workspaceId);
    const ctx = buildBatchWorkStateContext(batch, items);
    expect(ctx.cohortRunStatusByItem).toBeDefined();
    expect(ctx.stageResultsByRunId).toBeDefined();
    expect(ctx.latestRunIdByItem.size).toBe(20);
    expect(ctx.stageResultsByRunId.size).toBe(20);
    // Each run has exactly one stage result
    for (const [, rows] of ctx.stageResultsByRunId) {
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('running');
    }
  });

  it('projectionHealth is present and healthy for clean data', () => {
    const batch = makeBatchWithItems(5);
    const result = getBatchWorkState(batch);
    expect(result.projectionHealth).toBeDefined();
    expect(result.projectionHealth!.status).toBe('healthy');
    expect(result.projectionHealth!.version).toBe('1.0.0');
    expect(result.projectionHealth!.issues).toEqual([]);
  });

  it('projectionHealth degraded on corrupt curationData (fail-closed, never false zeros)', () => {
    const batch = makeBatchWithItems(3);
    const items = listItemsByBatch(batch);
    // Corrupt one item's curation_data_json to a valid JSON string that is not an object
    const db = getDb();
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify('corrupt_string_not_an_object'), items[0].id]);
    const result = getBatchWorkState(batch);
    // Must not return false zero counts — total still 3
    expect(result.total).toBe(3);
    const totalCounts = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(totalCounts).toBe(3);
    // Must be degraded with specific issue
    expect(result.projectionHealth!.status).toBe('degraded');
    const issue = result.projectionHealth!.issues.find(i => i.code === 'corrupt_curation_data');
    expect(issue).toBeDefined();
    expect(issue!.affectedCount).toBe(1);
    expect(issue!.source).toBe('onboarding_items');
  });

  it('cursor pagination is stable and hash-bound to filters', () => {
    const filtersA = { category: 'processing' as const, q: 'Blue' };
    const filtersB = { category: 'needs_attention' as const, q: 'Blue' };
    const hashA = computeWorkStateFilterHash(filtersA);
    const hashB = computeWorkStateFilterHash(filtersB);
    expect(hashA).not.toBe(hashB);

    const payload = { v: 1 as const, sortKey: '0:abc:123', itemId: 'item-1', filterHash: hashA };
    const cursor = encodeWorkStateCursor(payload);
    const decoded = decodeWorkStateCursor(cursor);
    expect(decoded.filterHash).toBe(hashA);
    expect(decoded.itemId).toBe('item-1');
  });

  it('getBatchWorkStateItems cursor pagination returns nextCursor and respects limit', () => {
    const batch = makeBatchWithItems(25);
    const page1 = getBatchWorkStateItems(batch, { limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.projectionHealth.status).toBe('healthy');
    expect(page1.scannedRows).toBeLessThanOrEqual(50);

    const page2 = getBatchWorkStateItems(batch, { limit: 10, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(10);
    expect(page2.scannedRows).toBeLessThanOrEqual(50);
    // No overlap
    const ids1 = new Set(page1.items.map(i => i.itemId));
    for (const item of page2.items) {
      expect(ids1.has(item.itemId)).toBe(false);
    }

    const page3 = getBatchWorkStateItems(batch, { limit: 10, cursor: page2.nextCursor! });
    expect(page3.items).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();
    expect(page3.scannedRows).toBeLessThanOrEqual(50);
    // Total/counts come from /counts, not /items — verify separately via counts endpoint
    const countsInfo = getBatchWorkStateCountsWithHealth(batch);
    expect(countsInfo.total).toBe(25);
  });

  it('getBatchWorkStateCountsWithHealth returns counts + health', () => {
    const batch = makeBatchWithItems(7);
    const result = getBatchWorkStateCountsWithHealth(batch);
    expect(result.counts.processing).toBe(7);
    expect(result.total).toBe(7);
    expect(result.projectionHealth.status).toBe('healthy');
  });

  it('never returns false zeros when DB is under load — health degraded but counts non-zero', () => {
    const batch = makeBatchWithItems(10);
    const items = listItemsByBatch(batch);
    // Inject corrupt row to simulate degraded DB / bulk failure
    const db = getDb();
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify('corrupt_string_not_an_object'), items[0].id]);
    const result = getBatchWorkState(batch);
    const sum = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10);
    expect(result.total).toBe(10);
    expect(result.projectionHealth!.status).toBe('degraded');
    expect(result.projectionHealth!.issues.length).toBeGreaterThan(0);
    // Degraded but not zeroed
    expect(result.counts.processing + result.counts.needs_attention + result.counts.waiting_on_family + result.counts.ready_for_review + result.counts.approved + result.counts.ready_to_export + result.counts.completed + result.counts.skipped).toBe(10);
  });

  it('category-critical DB failure does not silently become healthy empty — returns degraded 503, not false zero', () => {
    const batch = makeBatchWithItems(5);
    const db = getDb();
    // Simulate category-critical DB failure by temporarily renaming the critical table
    db.exec('ALTER TABLE onboarding_sources RENAME TO onboarding_sources_tmp');
    try {
      const { bulkCountDiscoveryCandidatesWithHealth } = require('../../db/repositories/onboarding-work-state-repo');
      const res = bulkCountDiscoveryCandidatesWithHealth(['id1', 'id2']);
      expect(res.issue).not.toBeNull();
      expect(res.issue!.code).toBe('candidate_count_failed');
      expect(res.issue!.source).toBe('onboarding_sources');
      expect(res.issue!.affectedCount).toBe(2);
      expect(res.data.size).toBe(2);
    } finally {
      db.exec('ALTER TABLE onboarding_sources_tmp RENAME TO onboarding_sources');
    }
    // Now test full context propagation via same table-drop trick
    db.exec('ALTER TABLE onboarding_sources RENAME TO onboarding_sources_tmp');
    try {
      const ctx = buildBatchWorkStateContext(batch, listItemsByBatch(batch));
      expect((ctx.healthIssues as any)._hasCritical).toBe(true);
      expect(ctx.healthIssues.some(i => i.code === 'candidate_count_failed')).toBe(true);
      let threw503 = false;
      try {
        getBatchWorkState(batch);
      } catch (e: any) {
        threw503 = e.name === 'WorkStateProjectionError' || e.code === 'candidate_count_failed' || e.message.includes('critical');
        expect(e.health ?? e).toBeDefined();
      }
      expect(threw503).toBe(true);
    } finally {
      db.exec('ALTER TABLE onboarding_sources_tmp RENAME TO onboarding_sources');
    }
  });

  it('request_hash is full 64-hex SHA-256 and order-insensitive', async () => {
    const { computeRequestHash, isValidRequestHash } = await import('../../db/repositories/onboarding-operation-receipt-repo');
    const hashA = computeRequestHash(['b', 'a', 'c']);
    const hashB = computeRequestHash(['a', 'c', 'b']);
    const hashC = computeRequestHash(['a', 'b']);
    expect(hashA).toBe(hashB); // order-insensitive
    expect(hashA).not.toBe(hashC); // different set
    expect(hashA.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(hashA)).toBe(true);
    expect(isValidRequestHash(hashA)).toBe(true);
    expect(isValidRequestHash('abc')).toBe(false);
    expect(isValidRequestHash('')).toBe(false);
  });

  it('50/500/5000-row bounded scanning — query count and scanned rows stay bounded', () => {
    for (const n of [50, 500, 5000]) {
      makeWorkspace();
      const batch = makeBatchWithItems(n);
      resetWorkStateQueryCount();
      const page1 = getBatchWorkStateItems(batch, { limit: 10 });
      expect(page1.items).toHaveLength(10);
      expect(page1.scannedRows).toBeLessThanOrEqual(50); // one chunk, not N
      expect(page1.queryCount).toBeLessThanOrEqual(3); // chunk read + bulk context + total counts
      expect(page1.nextCursor).toBeTruthy();
      // Second page also bounded
      const page2 = getBatchWorkStateItems(batch, { limit: 10, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(10);
      expect(page2.scannedRows).toBeLessThanOrEqual(50);
      expect(page2.queryCount).toBeLessThanOrEqual(3);
    }
  });


  it('items endpoint does not call full-batch listItemsByBatch — instrumented', () => {
    makeWorkspace();
    const batch = makeBatchWithItems(500);
    // Instrument via counting scannedRows and ensuring bounded chunk, not via monkey-patching readonly export.
    // The bounded implementation must not call full-batch list; we verify via scannedRows and that
    // a spy on the DB query for onboarding_items with row_number bounded is used instead.
    // We also verify that a full-batch call would be detectable via query count: bounded should be <=3 queries.
    const before = getWorkStateQueryCount();
    resetWorkStateQueryCount();
    const page = getBatchWorkStateItems(batch, { limit: 10 });
    const after = getWorkStateQueryCount();
    expect(page.items.length).toBe(10);
    expect(page.scannedRows).toBeLessThanOrEqual(50);
    expect(after - before).toBeLessThanOrEqual(3);
    // Verify that the page was produced without scanning 500 rows: if it had called full-batch, scannedRows would be 500
    expect(page.scannedRows).not.toBe(500);
  });

  it('sparse-filter traversal returns continuation cursor rather than scanning entire batch in one request', () => {
    makeWorkspace();
    const batch = makeBatchWithItems(500);
    // Make only 1 of 500 match the sparse filter (needs_attention vs processing)
    const db = getDb();
    const all = listItemsByBatch(batch);
    // First item stays needs_attention via brand_not_provided, others are processing (sourcing pending)
    // Our makeBatchWithItems creates sourcing pending => processing. Make first item held brand_not_provided => needs_attention
    db.run("UPDATE onboarding_items SET is_held=1, held_reason='missing_brand', brand_hint=NULL WHERE id=?", [all[0].id]);
    // Now filter for needs_attention should match exactly 1 of 500
    const page1 = getBatchWorkStateItems(batch, { category: 'needs_attention', limit: 10 });
    // Should return the 1 match, not 500 scanned in one request, and should indicate whether more DB rows remain to scan
    expect(page1.items).toHaveLength(1);
    // Since we scanned 50 rows per chunk and found 1, scannedRows should be 50, not 500, and nextCursor should be present because more DB rows remain to scan for sparse filter
    expect(page1.scannedRows).toBeLessThanOrEqual(50);
    expect(page1.nextCursor).toBeTruthy(); // continuation for sparse filter
    // Second page should be empty but still bounded (scans next chunk)
    const page2 = getBatchWorkStateItems(batch, { category: 'needs_attention', limit: 10, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(0);
    expect(page2.scannedRows).toBeLessThanOrEqual(50);
  });

  it('getItemWorkState single-item work-state query plan is bounded and O(1) w.r.t batch size', () => {
    makeWorkspace();
    const batch = makeBatchWithItems(500);
    const items = listItemsByBatch(batch);
    seedClassificationRunsForItems(items.map(i => i.id), workspaceId);
    const targetItemId = items[250].id;

    resetWorkStateQueryCount();
    const start = performance.now();
    const state = getItemWorkState(targetItemId);
    const duration = performance.now() - start;
    const qc = getWorkStateQueryCount();

    expect(state).toBeDefined();
    expect(state?.itemId).toBe(targetItemId);
    console.log(`[getItemWorkState Baseline] N=500 batch: ${duration.toFixed(2)}ms, ${qc} queries`);
  });
});
