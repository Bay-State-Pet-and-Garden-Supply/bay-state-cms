import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  enqueueRefreshItem,
  claimRefreshBatch,
  completeRefreshItem,
  failRefreshItem,
  getPendingRefreshCount,
} from '../../db/repositories/classification-refresh-repo';

describe('classification-refresh-repo (P1.3)', () => {
  const dbPath = `/tmp/test-refresh-repo-${randomUUID()}.db`;
  const wsId = 'ws-test';

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
  });

  beforeEach(() => {
    getDb().run('DELETE FROM classification_refresh_queue');
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // ok
    }
  });

  it('enqueues, claims, completes, and tracks counts', () => {
    expect(getPendingRefreshCount(wsId)).toBe(0);

    const id = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: '012345678901',
      triggerType: 'primary_product_type_change',
      requestedBy: 'operator-1',
    });

    expect(getPendingRefreshCount(wsId)).toBe(1);

    const claimed = claimRefreshBatch('worker-1', 5, 300);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(id);
    expect(claimed[0].status).toBe('claimed');
    expect(claimed[0].claimedBy).toBe('worker-1');
    expect(claimed[0].attemptCount).toBe(1);

    // Another claim cannot take it while lease is active
    const secondClaim = claimRefreshBatch('worker-2', 5, 300);
    expect(secondClaim.length).toBe(0);

    // Complete item
    const completed = completeRefreshItem(id, 'outcome-run-1');
    expect(completed).toBe(true);

    expect(getPendingRefreshCount(wsId)).toBe(0);
  });

  it('retries on failure up to maxAttempts and then marks failed', () => {
    const id = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: '012345678901',
      triggerType: 'primary_product_type_change',
      requestedBy: 'operator-1',
    });

    // Attempt 1: claim & fail (retryable)
    claimRefreshBatch('worker-1', 1, 300);
    failRefreshItem(id, 'Transient error 1', true, 2);

    // Should be back to pending
    expect(getPendingRefreshCount(wsId)).toBe(1);

    // Attempt 2: claim & fail (exceeds maxAttempts 2)
    claimRefreshBatch('worker-1', 1, 300);
    failRefreshItem(id, 'Fatal error 2', true, 2);

    // Should be failed now
    expect(getPendingRefreshCount(wsId)).toBe(0);
  });

  it('returns the existing row on a retried submit with the same trigger decision id', () => {
    const triggerDecisionId = randomUUID();
    const first = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: '012345678901',
      triggerType: 'primary_product_type_change',
      triggerDecisionId,
      requestedBy: 'proposal_review',
    });
    const second = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: '012345678901',
      triggerType: 'primary_product_type_change',
      triggerDecisionId,
      requestedBy: 'proposal_review',
    });
    expect(second).toBe(first);
    expect(getPendingRefreshCount(wsId)).toBe(1);
  });

  it('claims expired leases', () => {
    const id = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: '012345678901',
      triggerType: 'primary_product_type_change',
      requestedBy: 'operator-1',
    });

    // Claim initially with worker-1
    claimRefreshBatch('worker-1', 1, 300);

    // Simulate expired lease (claimed 10 minutes ago)
    getDb().run("UPDATE classification_refresh_queue SET claimed_at = datetime('now', '-10 minutes') WHERE id = ?", [id]);

    // Next worker should be able to steal the expired lease
    const reclaimed = claimRefreshBatch('worker-2', 1, 300);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(id);
    expect(reclaimed[0].claimedBy).toBe('worker-2');
    expect(reclaimed[0].attemptCount).toBe(2);
  });
});
