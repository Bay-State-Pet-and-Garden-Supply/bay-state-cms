import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { insertExtraction } from '../../db/repositories/onboarding-extraction-repo';
import { refreshCandidateCohorts, listCandidateCohortViews } from '../../onboarding/curation-cohort-service';
import { buildCohortContext } from '../../onboarding/onboarding-work-state';

let workspaceId: string;
let workspacePath: string;
let batchId: string;

describe('Cohort projection performance benchmark', () => {
  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `baystate-cms-cohort-bench-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'bench',
      workspacePath,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    batchId = createBatch({ workspaceId, name: 'Bench Batch', fileName: 'bench.xlsx', totalItems: 1000 }).id;

    // Seed 200 groups of 5 items = 1,000 items
    const itemRows = [];
    for (let g = 0; g < 200; g++) {
      for (let m = 0; m < 5; m++) {
        const idx = g * 5 + m;
        itemRows.push({
          upc: `8500000${idx.toString().padStart(5, '0')}`,
          name: `BrandAlpha Formula ${g} Variant ${m} Package`,
          brandHint: `BrandAlpha ${g}`,
          rowNumber: idx + 1,
        });
      }
    }
    const inserted = insertItems(batchId, itemRows);

    // Make all items extraction-ready
    const db = getDb();
    db.transaction(() => {
      for (const item of inserted) {
        const extData = JSON.stringify({ title: item.name, brand: item.brandHint });
        db.query("UPDATE onboarding_items SET stage = 'collect_details', stage_status = 'completed', source_url = ?, extraction_data_json = ? WHERE id = ?")
          .run(`https://brandalpha.com/p/${item.upc}`, extData, item.id);
        insertExtraction({
          itemId: item.id,
          sourceUrl: `https://brandalpha.com/p/${item.upc}`,
          extractionDataJson: extData,
          extractionMethod: 'test',
          confidence: 0.9,
        });
      }
    })();

    // Refresh candidate cohorts once to persist them in DB
    refreshCandidateCohorts(workspaceId, batchId);
  });

  it('measures baseline execution time for buildCohortContext on 1000 items / 200 cohorts', () => {
    const items = listItemsByBatch(batchId);
    expect(items.length).toBe(1000);

    // Warmup
    for (let i = 0; i < 3; i++) {
      buildCohortContext(batchId, items);
    }

    const start = performance.now();
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) {
      buildCohortContext(batchId, items);
    }
    const totalElapsed = performance.now() - start;
    const avgPerCall = totalElapsed / ITERATIONS;

    console.log(`[BENCHMARK BASELINE] buildCohortContext (1,000 items, 200 cohorts):`);
    console.log(`  Total time for ${ITERATIONS} iterations: ${totalElapsed.toFixed(2)} ms`);
    console.log(`  Average time per buildCohortContext call: ${avgPerCall.toFixed(2)} ms`);

    expect(avgPerCall).toBeGreaterThan(0);
  });

  it('measures baseline execution time for listCandidateCohortViews on 1000 items / 200 cohorts', () => {
    // Warmup
    for (let i = 0; i < 3; i++) {
      listCandidateCohortViews(batchId);
    }

    const start = performance.now();
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) {
      listCandidateCohortViews(batchId);
    }
    const totalElapsed = performance.now() - start;
    const avgPerCall = totalElapsed / ITERATIONS;

    console.log(`[BENCHMARK BASELINE] listCandidateCohortViews (1,000 items, 200 cohorts):`);
    console.log(`  Total time for ${ITERATIONS} iterations: ${totalElapsed.toFixed(2)} ms`);
    console.log(`  Average time per listCandidateCohortViews call: ${avgPerCall.toFixed(2)} ms`);

    expect(avgPerCall).toBeGreaterThan(0);
  });
});
