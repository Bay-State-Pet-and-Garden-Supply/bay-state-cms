import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { closeDb, getDb, initDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  installItemAcquisitionBudgetSchema,
  markItemAcquisitionBudgetDispatched,
  releaseItemAcquisitionBudgetAttempt,
  reserveItemAcquisitionBudgetAttempt,
  settleItemAcquisitionBudgetAttempt,
  type ItemAcquisitionResources,
} from '../../db/repositories/item-acquisition-budget-repo';
import type { ItemAcquisitionLimits } from '../../shared/schemas/item-acquisition';
import { ItemAcquisitionBudgetDeniedError, withItemAcquisitionBudget } from '../../onboarding/item-acquisition-budget';

const TEST_DB = 'src/tests/unit/item-acquisition-budget-test.db';
const WORKSPACE = 'item-acquisition-budget-ws';
const RESOURCES: ItemAcquisitionResources = {
  attempts: 1, pages: 0, actions: 0, redirects: 0, bytes: 0, artifacts: 0,
  durationMs: 1, inputTokens: 0, outputTokens: 0,
};
const LIMITS = {
  attempts: 100, pages: 100, actions: 100, redirects: 100, bytes: 10_000,
  artifacts: 100, durationMs: 100_000, inputTokens: 10_000, outputTokens: 10_000,
  maxConcurrent: 10, maxCostMicros: 100,
};

function seedBatch(batchId: string, itemIds: string[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.query(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
    VALUES (?, ?, ?, 'fixture.csv', ?, ?)`).run(batchId, WORKSPACE, batchId, now, now);
  for (const itemId of itemIds) {
    db.query(`INSERT INTO onboarding_items
      (id, batch_id, upc, name, error_message, brand_hint, row_number, stage, stage_status,
       source_type, source_url, created_at, updated_at)
      VALUES (?, ?, ?, 'Fixture item', '', '', 1, 'extraction', 'pending', 'official_page', NULL, ?, ?)`)
      .run(itemId, batchId, `sku-${itemId}`, now, now);
  }
}

function reserve(input: { id: string; itemId: string; batchId: string; costMicros: number | null; itemLimits?: ItemAcquisitionLimits; batchLimits?: ItemAcquisitionLimits }) {
  return reserveItemAcquisitionBudgetAttempt({
    id: input.id, workspaceId: WORKSPACE, batchId: input.batchId, itemId: input.itemId,
    runId: `run-${input.itemId}`, provider: 'fixture', model: 'fixture-v1', kind: 'brave_search',
    policyHash: 'policy-hash', pricingHash: 'pricing-hash', reservedResources: RESOURCES,
    costMicros: input.costMicros, itemLimits: input.itemLimits ?? LIMITS, batchLimits: input.batchLimits ?? LIMITS,
  });
}

beforeAll(() => {
  try { resetDb(); } catch { /* first test database */ }
  initDb(TEST_DB);
  runMigrations();
  installItemAcquisitionBudgetSchema(getDb());
  const now = new Date().toISOString();
  getDb().query(`INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
    VALUES (?, 'budget fixture', '/tmp/item-acquisition-budget-fixture', '/tmp/item-acquisition-budget-fixture/.git', ?, ?)`)
    .run(WORKSPACE, now, now);
  seedBatch('batch-concurrent', ['item-concurrent-a', 'item-concurrent-b']);
  seedBatch('batch-retries', ['item-retries']);
  seedBatch('batch-parallelism', ['item-parallelism']);
  seedBatch('batch-unpriced-history', ['item-unpriced-history']);
  seedBatch('batch-unknown', ['item-unknown']);
});

afterAll(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { unlinkSync(`${TEST_DB}${suffix}`); } catch { /* already removed */ }
  }
});

describe('durable item acquisition budgets', () => {
  it('atomically allows only one concurrent reservation at the shared batch attempt cap', async () => {
    const batchLimits = { ...LIMITS, attempts: 1 };
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => reserve({ id: 'concurrent-a', itemId: 'item-concurrent-a', batchId: 'batch-concurrent', costMicros: 1, batchLimits })),
      Promise.resolve().then(() => reserve({ id: 'concurrent-b', itemId: 'item-concurrent-b', batchId: 'batch-concurrent', costMicros: 1, batchLimits })),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('budget_exhausted:batch_attempts');
  });

  it('enforces concurrent request ceilings across active item reservations', () => {
    const itemLimits = { ...LIMITS, maxConcurrent: 1 };
    const batchLimits = { ...LIMITS, maxConcurrent: 1 };
    reserve({ id: 'parallel-first', itemId: 'item-parallelism', batchId: 'batch-parallelism', costMicros: 1, itemLimits, batchLimits });
    expect(() => reserve({ id: 'parallel-second', itemId: 'item-parallelism', batchId: 'batch-parallelism', costMicros: 1, itemLimits, batchLimits }))
      .toThrow('concurrency_limit:item');
    releaseItemAcquisitionBudgetAttempt('parallel-first', WORKSPACE, 'item-parallelism', 'run-item-parallelism', 'test_release');
  });

  it('counts settled retries cumulatively against item and batch monetary caps', () => {
    const itemLimits = { ...LIMITS, maxCostMicros: 15 };
    const batchLimits = { ...LIMITS, maxCostMicros: 15 };
    reserve({ id: 'retry-first', itemId: 'item-retries', batchId: 'batch-retries', costMicros: 10, itemLimits, batchLimits });
    markItemAcquisitionBudgetDispatched('retry-first', WORKSPACE, 'item-retries', 'run-item-retries');
    settleItemAcquisitionBudgetAttempt({ id: 'retry-first', workspaceId: WORKSPACE, itemId: 'item-retries', runId: 'run-item-retries', billing: 'known', actualResources: RESOURCES, actualCostMicros: 10 });
    expect(() => reserve({ id: 'retry-second', itemId: 'item-retries', batchId: 'batch-retries', costMicros: 6, itemLimits, batchLimits }))
      .toThrow('budget_exhausted:item_cost');
  });

  it('retains the full reserved charge after dispatched billing becomes unknown', () => {
    const itemLimits = { ...LIMITS, maxCostMicros: 15 };
    const batchLimits = { ...LIMITS, maxCostMicros: 15 };
    reserve({ id: 'unknown-first', itemId: 'item-unknown', batchId: 'batch-unknown', costMicros: 10, itemLimits, batchLimits });
    markItemAcquisitionBudgetDispatched('unknown-first', WORKSPACE, 'item-unknown', 'run-item-unknown');
    settleItemAcquisitionBudgetAttempt({ id: 'unknown-first', workspaceId: WORKSPACE, itemId: 'item-unknown', runId: 'run-item-unknown', billing: 'unknown', actualResources: RESOURCES, actualCostMicros: null });
    expect(() => releaseItemAcquisitionBudgetAttempt('unknown-first', WORKSPACE, 'item-unknown', 'run-item-unknown', 'cancelled_after_dispatch'))
      .toThrow('reservation_not_releasable');
    expect(() => reserve({ id: 'unknown-retry', itemId: 'item-unknown', batchId: 'batch-unknown', costMicros: 6, itemLimits, batchLimits }))
      .toThrow('budget_exhausted:item_cost');
    expect(() => reserve({ id: 'unknown-priced', itemId: 'item-unknown', batchId: 'batch-unknown', costMicros: null, itemLimits, batchLimits }))
      .toThrow('budget_not_enforceable:item_cost_unknown');
  });

  it('blocks a new monetary cap when an earlier unpriced attempt has unknown billing', () => {
    const uncapped = { ...LIMITS, maxCostMicros: null };
    reserve({ id: 'history-first', itemId: 'item-unpriced-history', batchId: 'batch-unpriced-history', costMicros: null, itemLimits: uncapped, batchLimits: uncapped });
    markItemAcquisitionBudgetDispatched('history-first', WORKSPACE, 'item-unpriced-history', 'run-item-unpriced-history');
    settleItemAcquisitionBudgetAttempt({ id: 'history-first', workspaceId: WORKSPACE, itemId: 'item-unpriced-history', runId: 'run-item-unpriced-history', billing: 'unknown', actualResources: RESOURCES, actualCostMicros: null });
    const capped = { ...LIMITS, maxCostMicros: 15 };
    expect(() => reserve({ id: 'history-next', itemId: 'item-unpriced-history', batchId: 'batch-unpriced-history', costMicros: 1, itemLimits: capped, batchLimits: capped }))
      .toThrow('budget_not_enforceable:item_cost_unknown');
  });

  it('releases only pre-dispatch reservations and rejects cancellation or missing policy before work', async () => {
    seedBatch('batch-release', ['item-release']);
    reserve({ id: 'release-first', itemId: 'item-release', batchId: 'batch-release', costMicros: 10 });
    releaseItemAcquisitionBudgetAttempt('release-first', WORKSPACE, 'item-release', 'run-item-release', 'cancelled_before_dispatch');
    expect(() => reserve({ id: 'release-retry', itemId: 'item-release', batchId: 'batch-release', costMicros: 10 })).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(withItemAcquisitionBudget({ workspaceId: WORKSPACE, itemId: 'item-release', runId: 'cancelled-run', signal: controller.signal }, async () => 'unreachable'))
      .rejects.toMatchObject({ code: 'cancelled' } satisfies Partial<ItemAcquisitionBudgetDeniedError>);
    await expect(withItemAcquisitionBudget({ workspaceId: 'missing-workspace', itemId: 'missing-item', runId: 'denied-run' }, async () => 'unreachable'))
      .rejects.toMatchObject({ code: 'workspace_unavailable' } satisfies Partial<ItemAcquisitionBudgetDeniedError>);
  });
});
