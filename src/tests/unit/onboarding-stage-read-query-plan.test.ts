/**
 * Slice 1 — v2 stage-read query-plan tests (Bun; isolated temp DBs).
 *
 * Proves the §4.1 budget with the all-statement counter (no N+1 false-greens):
 * - v2 projection equivalence with the frozen v1 path on identical fixtures;
 * - per-items-request bound (≤24 total statements, single 50-row chunk);
 * - counts bound (6 + 18×C chunks) with single-traversal matrix derivation;
 * - response queryCount completeness (tracked + shared + chunk statements);
 * - mapping parity for the replicated loaders (review/extraction/cohort).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { listReviewStates, markReviewed } from '../../db/repositories/onboarding-review-repo';
import { getLatestExtractionBindingsByItemIds } from '../../db/repositories/onboarding-extraction-repo';
import { refreshCandidateCohorts } from '../../db/repositories/curation-cohort-repo';
import {
  getStageReadCounts,
  getStageReadItems,
} from '../../onboarding/onboarding-stage-read';
import {
  getBatchWorkState,
  buildBatchWorkStateContext,
  deriveItemWorkState,
} from '../../onboarding/onboarding-work-state';
import {
  resetStageReadStatementCount,
  getStageReadStatementCount,
  loadV2ReviewStates,
  loadV2ExtractionBindings,
} from '../../db/repositories/onboarding-stage-read-repo';
import {
  resetWorkStateQueryCount,
  getWorkStateQueryCount,
} from '../../db/repositories/onboarding-work-state-repo';
import type { WorkStateCounts } from '../../shared/schemas/onboarding-work-state';
import {
  build36CellSpecs,
  buildLargeMixedSpecs,
  buildSparseSpecs,
  type StageReadItemSpec,
} from '../helpers/onboarding-stage-read-fixtures';

let workspaceId: string;

function makeWorkspace(): void {
  workspaceId = randomUUID();
  const workspacePath = path.join(os.tmpdir(), `ws-stage-plan-${workspaceId.slice(0, 8)}`);
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

function seedBatch(specs: StageReadItemSpec[]): string {
  const batch = createBatch({ workspaceId, name: `Batch ${randomUUID().slice(0, 6)}`, fileName: 'test.csv', totalItems: 0 });
  insertItems(
    batch.id,
    specs.map(s => ({
      upc: s.upc,
      name: s.name,
      brandHint: s.brandHint,
      sourceUrl: s.sourceUrl,
      rowNumber: s.rowNumber,
      stage: s.stage as never,
      stageStatus: s.stageStatus as never,
    })),
    'sourcing',
    1,
  );
  return batch.id;
}

const scopeFor = (batchId: string) => ({ workspaceId, batchId });

beforeEach(() => {
  makeWorkspace();
});

describe('v1 projection equivalence', () => {
  it('v2 rows equal frozen v1 rows on a mixed fixture (review/distributor/null-brand)', () => {
    const batchId = seedBatch(build36CellSpecs());
    const items = listItemsByBatch(batchId);
    markReviewed({ itemId: items[0]!.id, batchId, reviewedBy: 'tester' });
    // v1 reference on the same rows.
    const ctx = buildBatchWorkStateContext(batchId, listItemsByBatch(batchId));
    const v1ById = new Map(listItemsByBatch(batchId).map(item => [item.id, deriveItemWorkState(item, ctx)]));
    // v2 full traversal.
    const seen = new Map<string, unknown>();
    let cursor: string | null = null;
    for (;;) {
      const page = getStageReadItems(batchId, cursor ? { cursor } : {}, 50, scopeFor(batchId));
      for (const row of page.items) seen.set(row.itemId, row);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(36);
    for (const [id, v1] of v1ById) {
      expect(seen.get(id)).toEqual(v1);
    }
  });

  it('replicated loaders match v1 loaders exactly (review states, extraction bindings)', () => {
    const batchId = seedBatch(buildLargeMixedSpecs(60));
    const items = listItemsByBatch(batchId);
    const ids = items.map(i => i.id);
    resetStageReadStatementCount();
    expect(loadV2ReviewStates(batchId)).toEqual(listReviewStates(batchId));
    expect(loadV2ExtractionBindings(ids)).toEqual(getLatestExtractionBindingsByItemIds(ids));
  });
});

describe('items budget (≤24 total statements, one chunk)', () => {
  it.each([1, 50, 501, 1001])('serves a %i-candidate batch in one bounded chunk within budget', (n: number) => {
    const batchId = seedBatch(buildLargeMixedSpecs(n));
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const page = getStageReadItems(batchId, {}, 50, scopeFor(batchId));
    const sharedDelta = getWorkStateQueryCount();
    const tracked = getStageReadStatementCount();
    expect(page.scannedRows).toBeLessThanOrEqual(50);
    expect(page.queryCount).toBeLessThanOrEqual(24);
    // Completeness: the reported count covers every instrumented seam.
    expect(page.queryCount).toBe(tracked + sharedDelta);
    expect(page.items.length).toBeLessThanOrEqual(50);
  });

  it('sparse filters return continuation without unbounded scans', () => {
    const batchId = seedBatch(buildSparseSpecs());
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const page = getStageReadItems(batchId, { stage: 'prepare_listing' }, 50, scopeFor(batchId));
    expect(page.queryCount).toBeLessThanOrEqual(24);
    expect(page.scannedRows).toBeLessThanOrEqual(50);
    // One chunk cannot fill from sparse matches here; continuation OR fewer.
    expect(page.items.length).toBeLessThanOrEqual(3);
  });

  it('query cost does not scale with matched rows (no per-item fan-out)', () => {
    const small = seedBatch(buildLargeMixedSpecs(60));
    const big = seedBatch(buildLargeMixedSpecs(600));
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const qSmall = getStageReadItems(small, {}, 50, scopeFor(small)).queryCount;
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const qBig = getStageReadItems(big, {}, 50, scopeFor(big)).queryCount;
    expect(qBig).toBeLessThanOrEqual(24);
    expect(qBig - qSmall).toBeLessThanOrEqual(6);
  });
});

describe('counts budget (6 + 18×C) with single-traversal matrix', () => {
  it('scans a 1001-candidate batch in bounded chunks with exact matrix math', () => {
    const batchId = seedBatch(buildLargeMixedSpecs(1001));
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const counts = getStageReadCounts(batchId, {}, scopeFor(batchId));
    const sharedDelta = getWorkStateQueryCount();
    const tracked = getStageReadStatementCount();
    // C = floor(1001/50)+1 = 21 chunks (terminal empty chunk included).
    const C = Math.floor(1001 / 50) + 1;
    expect(counts.matchingTotal).toBe(1001);
    expect(tracked + sharedDelta).toBeLessThanOrEqual(6 + 18 * C);
    let matrixSum = 0;
    for (const cells of Object.values(counts.stageStatusMatrix)) {
      for (const n of Object.values(cells)) matrixSum += n;
    }
    expect(matrixSum).toBe(1001);
    const catSum = Object.values(counts.counts).reduce((a, b) => a + b, 0);
    expect(catSum).toBe(1001);
  });

  it('counts agree with full items traversal for every stage filter', () => {
    const batchId = seedBatch(buildLargeMixedSpecs(300));
    const stages = ['route_sources', 'find_product_page', 'collect_details', 'prepare_listing', 'review_listings', 'create_drafts'] as const;
    for (const stage of stages) {
      const counts = getStageReadCounts(batchId, { stage }, scopeFor(batchId));
      let union = 0;
      let cursor: string | null = null;
      for (;;) {
        const page = getStageReadItems(batchId, cursor ? { stage, cursor } : { stage }, 50, scopeFor(batchId));
        union += page.items.length;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(union).toBe(counts.matchingTotal);
    }
  });
});

describe('cohort-heavy budget', () => {
  it('holds the items bound with one cohort per row (bulk member loads, no per-cohort fan-out)', () => {
    // Distinct brand+stem per item so grouping forms one 1-member cohort each.
    const specs = Array.from({ length: 40 }, (_, i) => ({
      key: `fam-${i}`,
      upc: `FAM-${String(i).padStart(3, '0')}`,
      name: `Solo Product Alpha ${i} Pack`,
      brandHint: `Brand ${i}`,
      sourceType: 'official_page' as const,
      sourceUrl: `https://fam.example.com/p/${i}`,
      stage: 'curation' as const,
      stageStatus: 'pending' as const,
      rowNumber: 5000 + i,
    }));
    const batchId = seedBatch(specs);
    const items = listItemsByBatch(batchId);
    refreshCandidateCohorts(workspaceId, batchId, items);
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const page = getStageReadItems(batchId, { stage: 'prepare_listing' }, 50, scopeFor(batchId));
    expect(page.queryCount).toBeLessThanOrEqual(24);
    expect(page.scannedRows).toBeLessThanOrEqual(50);
  });
});

describe('acceptance-hydration paths', () => {
  it('stays in budget on completed-empty, completed-with-rows, and legacy-marker-absent paths', () => {
    const batchId = seedBatch(buildLargeMixedSpecs(60));
    const db = getDb();
    // Fresh migrations set the marker: completed path with zero acceptances.
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const legacy = getStageReadItems(batchId, {}, 50, scopeFor(batchId));
    expect(legacy.queryCount).toBeLessThanOrEqual(24);
    // Completed path: relational rows via test-only SQL seeding (marker already set by migrations).
    const ids = (db.query(`SELECT id FROM onboarding_items WHERE batch_id = ? LIMIT 5`).all(batchId) as Array<{ id: string }>).map(r => r.id);
    for (const id of ids) {
      const now = new Date().toISOString();
      db.query(
        `INSERT INTO onboarding_item_evidence_acceptances (id, item_id, evidence_attempt_id, accepted_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(`acc-${id.slice(0, 8)}`, id, `attempt-${id.slice(0, 8)}`, now, now);
    }
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const completed = getStageReadItems(batchId, {}, 50, scopeFor(batchId));
    expect(completed.queryCount).toBeLessThanOrEqual(24);
    expect(completed.items).toHaveLength(legacy.items.length);
    // Legacy path: marker absent → JSON fallback, still in budget.
    db.query(`DELETE FROM app_meta WHERE key = 'distributor_v2_schema_version'`).run();
    resetStageReadStatementCount();
    resetWorkStateQueryCount();
    const noMarker = getStageReadItems(batchId, {}, 50, scopeFor(batchId));
    expect(noMarker.queryCount).toBeLessThanOrEqual(24);
    expect(noMarker.items).toHaveLength(legacy.items.length);
  });
});

describe('v1 differential parity', () => {
  it('v2 category totals equal frozen v1 filtered histograms for facet filters', () => {
    const batchId = seedBatch(buildLargeMixedSpecs(200));
    const v1 = getBatchWorkState(batchId, { sourceType: 'distributor_record', limit: 500 });
    const v2 = getStageReadCounts(batchId, { sourceType: 'distributor_record' }, scopeFor(batchId));
    expect(v2.matchingTotal).toBe(v1.total);
    const histogram: WorkStateCounts = {
      processing: 0,
      needs_attention: 0,
      waiting_on_family: 0,
      ready_for_review: 0,
      approved: 0,
      ready_to_export: 0,
      completed: 0,
      skipped: 0,
    };
    for (const item of v1.items) histogram[item.category] = (histogram[item.category] ?? 0) + 1;
    expect(v2.counts).toEqual(histogram);
  });
});

describe('v2 storage reads (post-migration regression)', () => {
  // Live incident: after the sanctioned storage flip, getStageReadCounts
  // threw unsupported_storage_version (SQL encoded v1-only) and projectChunk
  // rejected v2 rows (v1-only guard) — every batch page 503'd. Both seams
  // must serve v2-spelled storage with v2 API responses.
  function seedV2Batch(): string {
    getDb()
      .query(
        "INSERT INTO app_meta (key, value) VALUES ('onboarding_stage_vocabulary_version','2') ON CONFLICT(key) DO UPDATE SET value='2'",
      )
      .run();
    const batch = createBatch({ workspaceId, name: `V2 ${randomUUID().slice(0, 6)}`, fileName: 'v2.csv', totalItems: 0 });
    const rows: Array<{ upc: string; name: string; brandHint: string; sourceUrl: string; rowNumber: number; stage: never; stageStatus: never }> = [];
    let n = 0;
    for (const [stage, count] of [
      ['route_sources', 3],
      ['find_product_page', 2],
      ['prepare_listing', 1],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        rows.push({
          upc: `V2-${stage}-${i}`,
          name: `V2 product ${stage} ${i}`,
          brandHint: 'brand',
          sourceUrl: `https://example-${n}.com/p/${n}`,
          rowNumber: n,
          stage: stage as never,
          stageStatus: 'pending' as never,
        });
      }
    }
    insertItems(
      batch.id,
      rows,
      'route_sources',
      1,
    );
    return batch.id;
  }

  it('counts serve v2 storage with a v2 matrix', () => {
    const batchId = seedV2Batch();
    const counts = getStageReadCounts(batchId, {}, scopeFor(batchId));
    expect(counts.matchingTotal).toBe(6);
    expect(counts.stageStatusMatrix.route_sources.pending).toBe(3);
    expect(counts.stageStatusMatrix.find_product_page.pending).toBe(2);
    expect(counts.stageStatusMatrix.prepare_listing.pending).toBe(1);
  });

  it('stage-filtered counts encode to the storage spelling', () => {
    const batchId = seedV2Batch();
    const filtered = getStageReadCounts(batchId, { stage: 'find_product_page' } as never, scopeFor(batchId));
    expect(filtered.matchingTotal).toBe(2);
  });

  it('items pages serve v2 storage rows', () => {
    const batchId = seedV2Batch();
    const page = getStageReadItems(batchId, {}, 50, scopeFor(batchId));
    expect(page.items).toHaveLength(6);
    expect(page.nextCursor).toBeNull();
  });
});
