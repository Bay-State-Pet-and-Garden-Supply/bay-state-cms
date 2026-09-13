import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  claimItemsForProcessing,
  getStageCounts,
  listItemsByBatchStageChunked,
  type InsertItemData,
} from '../../db/repositories/onboarding-item-repo';
import app from '../../server/app';

describe('Intra-Batch Duplicate Line Item Handling', () => {
  const workspaceId = 'ws-dedup-test';

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  it('repository: getStageCounts and listItemsByBatchStageChunked exclude duplicates', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Duplicate Test Batch',
      fileName: 'test.xlsx',
      totalItems: 3,
      executionState: 'running',
    });

    const items: InsertItemData[] = [
      { upc: '035585357409', name: 'KONG Classic Gold LG', quantity: 24, rowNumber: 42, isDuplicate: false },
      { upc: '035585357416', name: 'KONG Classic Gold MD', quantity: 12, rowNumber: 43, isDuplicate: false },
      // Duplicate row (Row 59 duplicates Row 42)
      {
        upc: '035585357409',
        name: 'KONG Classic Gold LG',
        quantity: 12,
        rowNumber: 59,
        isDuplicate: true,
        stageStatus: 'skipped',
        isHeld: true,
        heldReason: 'duplicate_line_item',
      },
    ];

    insertItems(batch.id, items, 'route_sources', 1);

    // 1. Stage counts must count only unique, non-duplicate products
    const counts = getStageCounts(batch.id);
    expect(counts.route_sources).toBe(2);

    // 2. Chunk reader excludes duplicates by default
    const defaultChunk = listItemsByBatchStageChunked(batch.id, { limit: 10 });
    expect(defaultChunk.items).toHaveLength(2);
    expect(defaultChunk.items.map(i => i.rowNumber)).toEqual([42, 43]);

    // 3. Chunk reader includes duplicates when explicitly requested
    const allChunk = listItemsByBatchStageChunked(batch.id, { limit: 10, includeDuplicates: true });
    expect(allChunk.items).toHaveLength(3);

    // 4. Worker claim ignores duplicate rows completely
    const claimed = claimItemsForProcessing('route_sources', 10, workspaceId, 'worker-1');
    expect(claimed).toHaveLength(2);
    expect(claimed.map(i => i.rowNumber)).toEqual([42, 43]);
  });

  it('routes: POST /api/onboarding/batches merges quantity and flags duplicates as skipped', async () => {
    const payload = {
      name: 'Duplicate Batch Upload',
      fileName: 'distributor_order.xlsx',
      mapping: {
        upc: 'UPC',
        name: 'Description',
        price: 'Price',
        quantity: 'Qty',
      },
      rows: [
        { UPC: '035585357409', Description: 'KONG Classic Gold LG', Price: '11.99', Qty: '12' },
        { UPC: '035585357416', Description: 'KONG Classic Gold MD', Price: '9.99', Qty: '12' },
        // Intra-batch duplicate of the first row
        { UPC: '035585357409', Description: 'KONG Classic Gold LG', Price: '11.99', Qty: '12' },
      ],
    };

    const res = await app.request('/api/onboarding/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.batch).toBeDefined();

    // Check validation error/warning reported
    expect(data.validationErrors).toBeDefined();
    const dupWarning = data.validationErrors.find((e: any) => e.message.includes('Duplicate UPC 035585357409'));
    expect(dupWarning).toBeDefined();

    // Check items in DB: Row 2 (the primary) should have consolidated quantity 24
    const chunk = listItemsByBatchStageChunked(data.batch.id, { limit: 10, includeDuplicates: true });
    expect(chunk.items).toHaveLength(3);

    const primaryRow = chunk.items.find(i => i.rowNumber === 2)!;
    expect(primaryRow.quantity).toBe(24);
    expect(primaryRow.isDuplicate).toBe(false);

    const dupRow = chunk.items.find(i => i.rowNumber === 4)!;
    expect(dupRow.isDuplicate).toBe(true);
    expect(dupRow.stageStatus).toBe('skipped');
    expect(dupRow.isHeld).toBe(true);
    expect(dupRow.heldReason).toBe('duplicate_line_item');

    // Default stage read excludes duplicate
    const stageCounts = getStageCounts(data.batch.id);
    expect(stageCounts.route_sources).toBe(2);
  });
});
