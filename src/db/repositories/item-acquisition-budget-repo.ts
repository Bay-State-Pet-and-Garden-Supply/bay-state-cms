import type { Database } from 'bun:sqlite';
import { getDb } from '../connection';
import type { ItemAcquisitionLimits } from '../../shared/schemas/item-acquisition';

export interface ItemAcquisitionResources {
  attempts: number;
  pages: number;
  actions: number;
  redirects: number;
  bytes: number;
  artifacts: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ItemAcquisitionReservationRecord {
  id: string;
  workspaceId: string;
  batchId: string;
  itemId: string;
  runId: string;
  provider: string;
  model: string;
  kind: 'model' | 'brave_search' | 'serper_search' | 'browser';
  policyHash: string;
  pricingHash: string;
  reservedResources: ItemAcquisitionResources;
  costMicros: number | null;
}

export type BudgetReservationStatus = 'reserved' | 'dispatched' | 'settled' | 'released';

const RESOURCE_KEYS: ReadonlyArray<keyof ItemAcquisitionResources> = [
  'attempts', 'pages', 'actions', 'redirects', 'bytes', 'artifacts', 'durationMs', 'inputTokens', 'outputTokens',
];

/** Install the durable acquisition attempt ledger; Main registers this installer with database startup. */
export function installItemAcquisitionBudgetSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_acquisition_budget_reservations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('model', 'brave_search', 'serper_search', 'browser')),
      policy_hash TEXT NOT NULL,
      pricing_hash TEXT NOT NULL,
      reserved_resources_json TEXT NOT NULL,
      actual_resources_json TEXT,
      cost_micros INTEGER,
      actual_cost_micros INTEGER,
      billing_status TEXT NOT NULL CHECK (billing_status IN ('pending', 'known', 'unknown', 'not_applicable')),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'dispatched', 'settled', 'released')),
      release_reason TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      settled_at TEXT,
      CHECK (workspace_id <> '' AND batch_id <> '' AND item_id <> '')
    );
    CREATE INDEX IF NOT EXISTS idx_item_acquisition_budget_item_status
      ON item_acquisition_budget_reservations(workspace_id, item_id, status);
    CREATE INDEX IF NOT EXISTS idx_item_acquisition_budget_batch_status
      ON item_acquisition_budget_reservations(workspace_id, batch_id, status);
    CREATE INDEX IF NOT EXISTS idx_item_acquisition_budget_run
      ON item_acquisition_budget_reservations(workspace_id, item_id, run_id, status);
  `);
}

function parseResources(json: string): ItemAcquisitionResources {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('Budget ledger resource row is invalid.'); }
  if (!value || typeof value !== 'object') throw new Error('Budget ledger resource row is invalid.');
  const record = value as Record<string, unknown>;
  const parsed = {} as ItemAcquisitionResources;
  for (const key of RESOURCE_KEYS) {
    const n = record[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Budget ledger resource row is invalid.');
    parsed[key] = n;
  }
  return parsed;
}

function assertValidResources(resources: ItemAcquisitionResources): void {
  for (const key of RESOURCE_KEYS) {
    const value = resources[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_budget_resources');
  }
}

interface BudgetLedgerRow {
  status: string;
  billing_status: string;
  reserved_resources_json: string;
  actual_resources_json: string | null;
  cost_micros: number | null;
  actual_cost_micros: number | null;
}

function sumResources(rows: BudgetLedgerRow[]): ItemAcquisitionResources {
  const total: ItemAcquisitionResources = {
    attempts: 0, pages: 0, actions: 0, redirects: 0, bytes: 0, artifacts: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
  };
  for (const row of rows) {
    if (row.status === 'released') continue;
    const raw = row.status === 'settled' && row.actual_resources_json
      ? row.actual_resources_json : row.reserved_resources_json;
    const resources = parseResources(raw);
    for (const key of RESOURCE_KEYS) {
      total[key] += resources[key];
      if (!Number.isSafeInteger(total[key])) throw new Error('Budget ledger cumulative resource overflow.');
    }
  }
  return total;
}

function exceeds(total: ItemAcquisitionResources, requested: ItemAcquisitionResources, limits: ItemAcquisitionLimits): keyof ItemAcquisitionResources | null {
  for (const key of RESOURCE_KEYS) if (total[key] + requested[key] > limits[key]) return key;
  return null;
}

function acquireWriteTransaction<T>(db: Database, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the first failure */ }
    throw error;
  }
}

/** Atomic reservation against both item and batch cumulative limits. Batch ownership comes from live onboarding rows. */
export function reserveItemAcquisitionBudgetAttempt(input: ItemAcquisitionReservationRecord & { itemLimits: ItemAcquisitionLimits; batchLimits: ItemAcquisitionLimits }): { batchId: string } {
  assertValidResources(input.reservedResources);
  if (input.costMicros !== null && (!Number.isSafeInteger(input.costMicros) || input.costMicros < 0)) throw new Error('invalid_budget_cost');
  const db = getDb();
  return acquireWriteTransaction(db, () => {
    const owner = db.query(`
      SELECT i.batch_id FROM onboarding_items i
      JOIN onboarding_batches b ON b.id = i.batch_id
      WHERE i.id = ? AND b.workspace_id = ?
    `).get(input.itemId, input.workspaceId) as { batch_id: string } | undefined;
    if (!owner || owner.batch_id !== input.batchId) throw new Error('Item acquisition reservation owner is unavailable.');
    const itemRows = db.query(`
      SELECT status, billing_status, reserved_resources_json, actual_resources_json, cost_micros, actual_cost_micros
      FROM item_acquisition_budget_reservations WHERE workspace_id = ? AND item_id = ?
    `).all(input.workspaceId, input.itemId) as BudgetLedgerRow[];
    const batchRows = db.query(`
      SELECT status, billing_status, reserved_resources_json, actual_resources_json, cost_micros, actual_cost_micros
      FROM item_acquisition_budget_reservations WHERE workspace_id = ? AND batch_id = ?
    `).all(input.workspaceId, input.batchId) as BudgetLedgerRow[];
    const itemTotal = sumResources(itemRows);
    const batchTotal = sumResources(batchRows);
    const itemExceeded = exceeds(itemTotal, input.reservedResources, input.itemLimits);
    if (itemExceeded) throw new Error(`budget_exhausted:${itemExceeded}`);
    const batchExceeded = exceeds(batchTotal, input.reservedResources, input.batchLimits);
    if (batchExceeded) throw new Error(`budget_exhausted:batch_${batchExceeded}`);

    for (const [rows, scope, limit] of [[itemRows, 'item', input.itemLimits.maxConcurrent], [batchRows, 'batch', input.batchLimits.maxConcurrent]] as const) {
      const active = rows.filter(row =>
        (row.status === 'reserved' || row.status === 'dispatched') &&
        parseResources(row.reserved_resources_json).attempts > 0,
      ).length;
      if (input.reservedResources.attempts > 0 && active >= limit) throw new Error(`concurrency_limit:${scope}`);
    }

    const itemPriorCost = totalCost(itemRows);
    const batchPriorCost = totalCost(batchRows);
    if (input.itemLimits.maxCostMicros !== null) {
      if (itemPriorCost === null || input.costMicros === null) throw new Error('budget_not_enforceable:item_cost_unknown');
      if (itemPriorCost + input.costMicros > input.itemLimits.maxCostMicros) throw new Error('budget_exhausted:item_cost');
    }
    if (input.batchLimits.maxCostMicros !== null) {
      if (batchPriorCost === null || input.costMicros === null) throw new Error('budget_not_enforceable:batch_cost_unknown');
      if (batchPriorCost + input.costMicros > input.batchLimits.maxCostMicros) throw new Error('budget_exhausted:batch_cost');
    }

    db.query(`
      INSERT INTO item_acquisition_budget_reservations
        (id, workspace_id, batch_id, item_id, run_id, provider, model, kind, policy_hash, pricing_hash,
         reserved_resources_json, actual_resources_json, cost_micros, actual_cost_micros, billing_status,
         status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'pending', 'reserved', ?)
    `).run(input.id, input.workspaceId, input.batchId, input.itemId, input.runId, input.provider, input.model, input.kind,
      input.policyHash, input.pricingHash, JSON.stringify(input.reservedResources), input.costMicros, new Date().toISOString());
    return { batchId: input.batchId };
  });
}

function totalCost(rows: BudgetLedgerRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.status === 'released') continue;
    const amount = row.status === 'settled' && row.billing_status === 'known'
      ? row.actual_cost_micros : row.cost_micros;
    if (amount === null) return null;
    total += amount;
    if (!Number.isSafeInteger(total)) throw new Error('Budget ledger cumulative cost overflow.');
  }
  return total;
}

export function markItemAcquisitionBudgetDispatched(id: string, workspaceId: string, itemId: string, runId: string): void {
  const result = getDb().query(`
    UPDATE item_acquisition_budget_reservations SET status = 'dispatched', dispatched_at = ?
    WHERE id = ? AND workspace_id = ? AND item_id = ? AND run_id = ? AND status = 'reserved'
  `).run(new Date().toISOString(), id, workspaceId, itemId, runId);
  if (result.changes !== 1) throw new Error('reservation_not_dispatchable');
}

export function settleItemAcquisitionBudgetAttempt(input: {
  id: string; workspaceId: string; itemId: string; runId: string;
  billing: 'known' | 'unknown' | 'not_applicable';
  actualResources: ItemAcquisitionResources;
  actualCostMicros: number | null;
}): void {
  assertValidResources(input.actualResources);
  if (input.actualCostMicros !== null && (!Number.isSafeInteger(input.actualCostMicros) || input.actualCostMicros < 0)) throw new Error('invalid_budget_cost');
  if (input.billing === 'known' && input.actualCostMicros === null) throw new Error('known_billing_requires_cost');
  const result = getDb().query(`
    UPDATE item_acquisition_budget_reservations
    SET status = 'settled', billing_status = ?, actual_resources_json = ?, actual_cost_micros = ?, settled_at = ?
    WHERE id = ? AND workspace_id = ? AND item_id = ? AND run_id = ? AND status = 'dispatched'
  `).run(input.billing, JSON.stringify(input.actualResources), input.actualCostMicros, new Date().toISOString(), input.id, input.workspaceId, input.itemId, input.runId);
  if (result.changes !== 1) throw new Error('reservation_not_settleable');
}

export function releaseItemAcquisitionBudgetAttempt(id: string, workspaceId: string, itemId: string, runId: string, reason: string): void {
  const result = getDb().query(`
    UPDATE item_acquisition_budget_reservations SET status = 'released', billing_status = 'not_applicable', release_reason = ?, settled_at = ?
    WHERE id = ? AND workspace_id = ? AND item_id = ? AND run_id = ? AND status = 'reserved'
  `).run(reason.slice(0, 128), new Date().toISOString(), id, workspaceId, itemId, runId);
  if (result.changes !== 1) throw new Error('reservation_not_releasable');
}

export function settleAbandonedItemAcquisitionBudgetAttempts(ids: readonly string[], workspaceId: string, itemId: string, runId: string): void {
  if (ids.length === 0) return;
  const db = getDb();
  acquireWriteTransaction(db, () => {
    for (const id of ids) {
      db.query(`
        UPDATE item_acquisition_budget_reservations
        SET status = 'settled', billing_status = 'unknown', actual_resources_json = NULL, actual_cost_micros = NULL, settled_at = ?
        WHERE id = ? AND workspace_id = ? AND item_id = ? AND run_id = ? AND status = 'dispatched'
      `).run(new Date().toISOString(), id, workspaceId, itemId, runId);
      db.query(`
        UPDATE item_acquisition_budget_reservations
        SET status = 'released', billing_status = 'not_applicable', release_reason = 'scope_closed_before_dispatch', settled_at = ?
        WHERE id = ? AND workspace_id = ? AND item_id = ? AND run_id = ? AND status = 'reserved'
      `).run(new Date().toISOString(), id, workspaceId, itemId, runId);
    }
  });
}

export function getItemAcquisitionBatchId(workspaceId: string, itemId: string): string | null {
  const owner = getDb().query(`
    SELECT i.batch_id FROM onboarding_items i JOIN onboarding_batches b ON b.id = i.batch_id
    WHERE i.id = ? AND b.workspace_id = ?
  `).get(itemId, workspaceId) as { batch_id: string } | undefined;
  return owner?.batch_id ?? null;
}
