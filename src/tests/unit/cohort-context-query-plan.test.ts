/**
 * Query plan test for buildCohortContext and buildCohortView bulk operations.
 *
 * Measures DB query execution count and timing to prevent N+1 SQLite query fan-out.
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
import { refreshCandidateCohorts } from '../../onboarding/curation-cohort-service';
import { buildCohortContext } from '../../onboarding/onboarding-work-state';

let workspaceId: string;
let workspacePath: string;

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-cohort-qplan-${workspaceId.slice(0, 8)}`);
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

function makeBatchWithItems(count: number): string {
  const batch = createBatch({ workspaceId, name: `Batch ${count}`, fileName: 'test.csv', totalItems: 0 });
  const rows = Array.from({ length: count }, (_, i) => ({
    upc: `UPC-CQP-${count}-${i}`,
    name: `Brand ${i % 50} Product ${i}`,
    brandHint: `Brand ${i % 50}`,
    sourceUrl: null,
    rowNumber: i + 1,
    stage: 'sourcing' as any,
    stageStatus: 'pending' as any,
  }));
  insertItems(batch.id, rows, 'sourcing' as any, 1);
  refreshCandidateCohorts(workspaceId, batch.id);
  return batch.id;
}

describe('buildCohortContext query plan — bounded bulk reads', () => {
  beforeEach(() => {
    makeWorkspace();
  });

  it('buildCohortContext executes bounded bulk queries for 200 items', () => {
    const batchId = makeBatchWithItems(200);
    const items = listItemsByBatch(batchId);

    let queryCount = 0;
    const db = getDb();
    const origQuery = db.query.bind(db);
    (db as any).query = function (...args: [any, ...any[]]) {
      queryCount++;
      return (origQuery as any)(...args);
    };

    const start = performance.now();
    const cohortMap = buildCohortContext(batchId, items);
    const elapsed = performance.now() - start;

    console.log(`[BENCHMARK] 200 items/cohorts: Queries = ${queryCount}, Time = ${elapsed.toFixed(2)}ms`);

    expect(cohortMap.size).toBe(200);
    // Baseline count before optimization is 601 (1 listCohortsByBatch + 200 * (1 getCohortMembers + 1 getLatestExtractionBindingsByItemIds + 1 getCurrentCohortRun))
    // Target after optimization is <= 5 queries
    expect(queryCount).toBeLessThanOrEqual(5);
  });
});
