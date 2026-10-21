import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { ListingCompletenessExceptionSchema, type ListingCompletenessException } from '../../shared/schemas/item-evidence';
import { getDb } from '../connection';

/** Install the append-only omission-receipt table; no historical rows are backfilled. */
export function installListingCompletenessExceptionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_completeness_exceptions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      action_token TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, item_id, revision),
      UNIQUE (workspace_id, item_id, action_token)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_completeness_exceptions_history
      ON listing_completeness_exceptions(workspace_id, item_id, revision DESC);
    CREATE TRIGGER IF NOT EXISTS listing_completeness_exceptions_no_update
      BEFORE UPDATE ON listing_completeness_exceptions
      BEGIN SELECT RAISE(ABORT, 'listing completeness receipts are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS listing_completeness_exceptions_no_delete
      BEFORE DELETE ON listing_completeness_exceptions
      BEGIN SELECT RAISE(ABORT, 'listing completeness receipts are append-only'); END;
  `);
}

function parseReceipt(json: string): ListingCompletenessException {
  const raw: unknown = JSON.parse(json);
  return ListingCompletenessExceptionSchema.parse(raw);
}

export function listListingCompletenessExceptions(workspaceId: string, itemId: string): ListingCompletenessException[] {
  const db = getDb();
  const rows = db.query(
    'SELECT receipt_json FROM listing_completeness_exceptions WHERE workspace_id = ? AND item_id = ? ORDER BY revision ASC',
  ).all(workspaceId, itemId) as Array<{ receipt_json: string }>;
  return rows.map((row) => parseReceipt(row.receipt_json));
}

export function findListingCompletenessDecisionByActionToken(
  workspaceId: string,
  itemId: string,
  actionToken: string,
): ListingCompletenessException | null {
  const db = getDb();
  const row = db.query(
    'SELECT receipt_json FROM listing_completeness_exceptions WHERE workspace_id = ? AND item_id = ? AND action_token = ?',
  ).get(workspaceId, itemId, actionToken) as { receipt_json: string } | undefined;
  if (!row) return null;
  return parseReceipt(row.receipt_json);
}

export interface AppendListingCompletenessDecisionInput {
  workspaceId: string;
  itemId: string;
  sku: string;
  requirementId: string;
  standardId: string;
  standardHash: string;
  classificationHash: string;
  inputHash: string;
  dependencyHash: string;
  decision: 'approved' | 'revoked';
  reason: string;
  actor: string;
  actionToken: string;
  expectedRevision: number;
}

export type AppendListingCompletenessDecisionResult =
  | { status: 'appended'; exception: ListingCompletenessException }
  | { status: 'replayed'; exception: ListingCompletenessException }
  | { status: 'conflict' };

/**
 * Append an omission decision receipt. Idempotent on action-token replay for
 * an identical command; a token reused for a different command or a stale
 * expected revision is a conflict. History is append-only and never mutated.
 */
export function appendListingCompletenessDecision(
  input: AppendListingCompletenessDecisionInput,
): AppendListingCompletenessDecisionResult {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.query(
    'SELECT receipt_json FROM listing_completeness_exceptions WHERE workspace_id = ? AND item_id = ? AND action_token = ?',
  ).get(input.workspaceId, input.itemId, input.actionToken) as { receipt_json: string } | undefined;
  if (existing) {
    const receipt = parseReceipt(existing.receipt_json);
    const identical =
      receipt.requirementId === input.requirementId &&
      receipt.standardId === input.standardId &&
      receipt.standardHash === input.standardHash &&
      receipt.classificationHash === input.classificationHash &&
      receipt.inputHash === input.inputHash &&
      receipt.dependencyHash === input.dependencyHash &&
      receipt.decision === input.decision &&
      receipt.reason === input.reason &&
      receipt.sku === input.sku;
    if (!identical) throw new Error('listing_completeness_action_token_conflict: this idempotency token was already used for a different decision');
    return { status: 'replayed', exception: receipt };
  }
  const rows = db.query(
    'SELECT revision FROM listing_completeness_exceptions WHERE workspace_id = ? AND item_id = ? ORDER BY revision DESC LIMIT 1',
  ).all(input.workspaceId, input.itemId) as Array<{ revision: number }>;
  const currentRevision = rows.length > 0 ? Number(rows[0]!.revision) : 0;
  if (currentRevision !== input.expectedRevision) return { status: 'conflict' };
  const revision = currentRevision + 1;
  const receipt: ListingCompletenessException = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    itemId: input.itemId,
    sku: input.sku,
    revision,
    requirementId: input.requirementId,
    standardId: input.standardId,
    standardHash: input.standardHash,
    classificationHash: input.classificationHash,
    inputHash: input.inputHash,
    dependencyHash: input.dependencyHash,
    decision: input.decision,
    reason: input.reason,
    actor: input.actor,
    decidedAt: now,
    actionToken: input.actionToken,
    receiptId: randomUUID(),
  };
  const parsed = ListingCompletenessExceptionSchema.parse(receipt);
  db.query(
    `INSERT INTO listing_completeness_exceptions
      (id, workspace_id, item_id, receipt_json, action_token, revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(parsed.id, input.workspaceId, input.itemId, JSON.stringify(parsed), input.actionToken, revision, now);
  return { status: 'appended', exception: parsed };
}
