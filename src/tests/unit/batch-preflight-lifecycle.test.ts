import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  createBatch,
  findBatchById,
  updateBatchExecutionState,
} from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  claimItemsForProcessing,
  releaseBatchItems,
  holdBatchItems,
  bulkAssignBrandToItems,
} from '../../db/repositories/onboarding-item-repo';
import { partitionBatchByBrand, buildMissingBrandGroups } from '../../onboarding/batch-release';

describe('Batch Start & Controlled Release Lifecycle', () => {
  const workspaceId = 'ws-preflight-test';

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

  it('defaults new batch to draft executionState and blocks worker claims', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Weekly Catalog Upload',
      fileName: 'upload.xlsx',
      totalItems: 2,
      executionState: 'draft',
    });

    expect(batch.executionState).toBe('draft');

    insertItems(
      batch.id,
      [
        { upc: '011111111111', name: 'Acana Wild Prairie Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '022222222222', name: 'Orijen Six Fish Cat 12lb', brandHint: 'ORIJEN', rowNumber: 2 },
      ],
      'sourcing',
      1,
    );

    // Worker attempts to claim items from 'sourcing' stage
    const claimedInDraft = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInDraft).toHaveLength(0); // Worker CANNOT claim while batch is draft

    // Pause batch state also blocks claims
    updateBatchExecutionState(batch.id, 'paused');
    const claimedInPaused = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInPaused).toHaveLength(0);

    // Starting the batch allows worker claims
    updateBatchExecutionState(batch.id, 'running');
    const claimedInRunning = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimedInRunning).toHaveLength(2);
  });

  it('respects item hold flags when batch is running', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Partial Release Batch',
      fileName: 'upload.xlsx',
      totalItems: 3,
    });

    const items = insertItems(
      batch.id,
      [
        { upc: '011111111111', name: 'Acana Lamb & Apple 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '022222222222', name: 'Mystery Kibble 5lb', brandHint: null, rowNumber: 2 },
        { upc: '033333333333', name: 'Redbarn Bully Sticks 3pk', brandHint: 'REDBARN', rowNumber: 3 },
      ],
      'sourcing',
      1,
    );

    // Put mystery kibble on hold
    holdBatchItems(batch.id, [items[1].id], 'unresolved_brand');
    updateBatchExecutionState(batch.id, 'running');

    // Worker claims only unheld items
    const claimed = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test');
    expect(claimed).toHaveLength(2);
    expect(claimed.map((i) => i.upc)).toEqual(['011111111111', '033333333333']);

    // Release mystery kibble and claim again with a distinct worker
    releaseBatchItems(batch.id, [items[1].id]);
    const claimedAfterRelease = claimItemsForProcessing('sourcing', 10, workspaceId, 'worker-test-2');
    expect(claimedAfterRelease).toHaveLength(1);
    expect(claimedAfterRelease[0].upc).toBe('022222222222');
  });

  it('partitions ready/held by brand presence and groups missing brands for assignment', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Mixed Readiness Batch',
      fileName: 'mixed.csv',
      totalItems: 4,
    });

    const inserted = insertItems(
      batch.id,
      [
        { upc: '111111111111', name: 'Acana Singles Lamb 25lb', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '222222222222', name: 'CustomBrandX Chew Stick', brandHint: 'CustomBrandX', rowNumber: 2 },
        { upc: '333333333333', name: 'Fromm Four-Star Duck 15lb', brandHint: null, rowNumber: 3 },
        { upc: '444444444444', name: 'Fromm Four-Star Salmon 15lb', brandHint: null, rowNumber: 4 },
      ],
      'sourcing',
      1,
    );

    // Ready = non-empty trimmed brandHint (no distributor exemption).
    const { readyItemIds, heldItemIds } = partitionBatchByBrand(batch.id);
    expect(readyItemIds).toEqual([inserted[0].id, inserted[1].id]);
    expect(heldItemIds).toEqual([inserted[2].id, inserted[3].id]);

    // Missing-brand groups cluster the held items with a suggestion.
    const groups = buildMissingBrandGroups(batch.id);
    expect(groups).toHaveLength(1);
    expect(groups[0].suggestedBrand?.toLowerCase()).toBe('fromm');
    expect(groups[0].itemCount).toBe(2);
    expect(groups[0].itemIds).toEqual([inserted[2].id, inserted[3].id]);

    // Bulk assign brand to the Fromm group resolves the partition.
    bulkAssignBrandToItems(batch.id, groups[0].itemIds, 'Fromm Family');
    const updated = partitionBatchByBrand(batch.id);
    expect(updated.readyItemIds).toHaveLength(4);
    expect(updated.heldItemIds).toHaveLength(0);
    expect(buildMissingBrandGroups(batch.id)).toHaveLength(0);
  });

  it('treats empty/whitespace brand hints as held', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Whitespace Batch',
      fileName: 'ws.csv',
      totalItems: 5,
    });

    const inserted = insertItems(
      batch.id,
      [
        { upc: '511111111111', name: 'Blank One', brandHint: '', rowNumber: 1 },
        { upc: '522222222222', name: 'Blank Two', brandHint: '   ', rowNumber: 2 },
        { upc: '533333333333', name: 'Blank Three', brandHint: '\t', rowNumber: 3 },
        { upc: '544444444444', name: 'Blank Four', brandHint: null, rowNumber: 4 },
        { upc: '555555555555', name: 'Padded Brand', brandHint: '  Acana  ', rowNumber: 5 },
      ],
      'sourcing',
      1,
    );

    const { readyItemIds, heldItemIds } = partitionBatchByBrand(batch.id);
    expect(readyItemIds).toEqual([inserted[4].id]);
    expect(heldItemIds).toEqual([inserted[0].id, inserted[1].id, inserted[2].id, inserted[3].id]);
  });

  it('does not exempt brandless distributor_record items from the hold partition', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Distributor Batch',
      fileName: 'dist.csv',
      totalItems: 1,
    });

    const [item] = insertItems(
      batch.id,
      [{ upc: '611111111111', name: 'Distributor Kibble 5lb', brandHint: null, rowNumber: 1 }],
      'sourcing',
      1,
    );
    // insertItems hardcodes official_page; flip the row to a
    // distributor record directly — release still requires a brand.
    getDb().run(`UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?`, [item.id]);
    expect(findItemById(item.id)?.sourceType).toBe('distributor_record');

    const { readyItemIds, heldItemIds } = partitionBatchByBrand(batch.id);
    expect(readyItemIds).toHaveLength(0);
    expect(heldItemIds).toEqual([item.id]);
  });

  it('release-all clears every hold; pause/resume preserve holds; draft brand edits keep draft', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Hold Lifecycle Batch',
      fileName: 'holds.csv',
      totalItems: 3,
      executionState: 'draft',
    });
    expect(findBatchById(batch.id)?.executionState).toBe('draft');

    const items = insertItems(
      batch.id,
      [
        { upc: '711111111111', name: 'Branded One', brandHint: 'ACANA', rowNumber: 1 },
        { upc: '722222222222', name: 'Unbranded Two', brandHint: null, rowNumber: 2 },
        { upc: '733333333333', name: 'Unbranded Three', brandHint: null, rowNumber: 3 },
      ],
      'sourcing',
      1,
    );
    holdBatchItems(batch.id, [items[1].id, items[2].id], 'unresolved_brand');

    // Brand edits while draft do not flip execution state.
    bulkAssignBrandToItems(batch.id, [items[1].id], 'Fromm');
    releaseBatchItems(batch.id, [items[1].id]);
    expect(findBatchById(batch.id)?.executionState).toBe('draft');
    expect(findItemById(items[1].id)?.isHeld).toBe(false);

    // Pause/resume only flip execution state; holds survive both.
    updateBatchExecutionState(batch.id, 'paused');
    expect(findItemById(items[2].id)?.isHeld).toBe(true);
    expect(findItemById(items[2].id)?.heldReason).toBe('unresolved_brand');
    updateBatchExecutionState(batch.id, 'running');
    expect(findItemById(items[2].id)?.isHeld).toBe(true);

    // Release-all with no id list clears every remaining hold.
    releaseBatchItems(batch.id);
    expect(findItemById(items[2].id)?.isHeld).toBe(false);
    expect(findItemById(items[2].id)?.heldReason).toBeNull();
  });
});
