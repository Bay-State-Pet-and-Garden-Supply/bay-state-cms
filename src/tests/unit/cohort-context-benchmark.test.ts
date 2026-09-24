import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getDb, initDb, closeDb, isDbInitialized } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { refreshCandidateCohorts } from '../../db/repositories/curation-cohort-repo';
import { buildCohortContext } from '../../onboarding/onboarding-work-state';
import { getBatchReviewQueue } from '../../onboarding/onboarding-review-queue';

describe('Cohort Context & Review Queue Performance Benchmark', () => {
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
  });

  afterEach(() => {
    if (isDbInitialized()) {
      closeDb();
    }
  });

  it('buildCohortContext and getBatchReviewQueue execute efficiently on 500 items across 100 cohorts', () => {
    const now = new Date().toISOString();
    insertWorkspace({
      id: 'ws_bench',
      name: 'Bench Workspace',
      workspacePath: '/tmp/ws_bench',
      gitPath: '/tmp/ws_bench/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'main',
    });

    const numItems = 500;
    const batch = createBatch({
      workspaceId: 'ws_bench',
      name: 'Batch Bench',
      fileName: 'test.csv',
      totalItems: numItems,
    });

    const items = [];
    for (let i = 0; i < numItems; i++) {
      items.push({
        rowNumber: i + 1,
        upc: `123456789${String(i).padStart(4, '0')}`,
        name: `Test Product Family ${Math.floor(i / 5)} Item ${i % 5}`,
        brandHint: 'TestBrand',
        stage: 'prepare_listing',
        stageStatus: 'completed',
        sourceType: 'official_page',
      });
    }

    const inserted = insertItems(batch.id, items as any);
    refreshCandidateCohorts('ws_bench', batch.id, inserted);

    // Warmup
    const context = buildCohortContext(batch.id, inserted);
    expect(context.size).toBe(numItems);

    const iterations = 10;

    const startCohort = performance.now();
    for (let i = 0; i < iterations; i++) {
      buildCohortContext(batch.id, inserted);
    }
    const cohortAvgMs = (performance.now() - startCohort) / iterations;

    const startReview = performance.now();
    for (let i = 0; i < iterations; i++) {
      getBatchReviewQueue(batch.id);
    }
    const reviewQueueAvgMs = (performance.now() - startReview) / iterations;

    // Both operations must complete well within performance budget thresholds
    expect(cohortAvgMs).toBeLessThan(30); // Optimised ~10ms vs baseline ~88ms
    expect(reviewQueueAvgMs).toBeLessThan(100); // Optimised ~32ms vs baseline ~118ms
  });
});
