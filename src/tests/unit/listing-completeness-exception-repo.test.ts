import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { closeDb, getDb, initDb, resetDb } from '../../db/connection';
import { appendListingCompletenessDecision, installListingCompletenessExceptionSchema, listListingCompletenessExceptions } from '../../db/repositories/listing-completeness-exception-repo';

const decision = {
  workspaceId: 'workspace-1', itemId: 'item-1', sku: '000111', requirementId: 'care', standardId: 'standard-1',
  standardHash: 'a'.repeat(64), classificationHash: 'b'.repeat(64), inputHash: 'c'.repeat(64), dependencyHash: 'd'.repeat(64),
  decision: 'approved' as const, reason: 'Source does not provide this optional detail.', actor: 'approver@example.test',
  actionToken: 'action-approve-1', expectedRevision: 0,
};

beforeEach(() => {
  try { resetDb(); } catch { /* No database was open. */ }
  initDb(':memory:');
  installListingCompletenessExceptionSchema(getDb());
});
afterAll(() => { closeDb(); });

describe('listing completeness omission receipts', () => {
  it('atomically replays an identical action and appends revocation history', () => {
    const created = appendListingCompletenessDecision(decision);
    expect(created.status).toBe('appended');
    if (created.status !== 'appended') return;
    const replay = appendListingCompletenessDecision(decision);
    expect(replay).toMatchObject({ status: 'replayed', exception: { id: created.exception.id, receiptId: created.exception.receiptId } });
    const revoked = appendListingCompletenessDecision({ ...decision, decision: 'revoked', reason: 'Corrected after source review.',
      actionToken: 'action-revoke-1', expectedRevision: 1 });
    expect(revoked).toMatchObject({ status: 'appended', exception: { decision: 'revoked', revision: 2 } });
    expect(listListingCompletenessExceptions(decision.workspaceId, decision.itemId).map(receipt => receipt.decision)).toEqual(['approved', 'revoked']);
  });

  it('rejects an idempotency token reused for a different command', () => {
    appendListingCompletenessDecision({ ...decision, actionToken: 'action-conflict-1', expectedRevision: 0 });
    expect(() => appendListingCompletenessDecision({ ...decision, reason: 'Different reason.', actionToken: 'action-conflict-1', expectedRevision: 1 }))
  });

  it('refuses mutation or deletion of a persisted receipt', () => {
    appendListingCompletenessDecision(decision);
    const receipt = listListingCompletenessExceptions(decision.workspaceId, decision.itemId)[0];
    expect(receipt).toBeDefined();
    if (!receipt) return;
    expect(() => getDb().query('UPDATE listing_completeness_exceptions SET receipt_json = ? WHERE id = ?').run('{}', receipt.id))
      .toThrow(/append-only/);
    expect(() => getDb().query('DELETE FROM listing_completeness_exceptions WHERE id = ?').run(receipt.id))
      .toThrow(/append-only/);
  });
});
