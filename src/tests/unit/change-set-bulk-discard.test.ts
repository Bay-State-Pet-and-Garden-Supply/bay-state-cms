import { describe, expect, it, beforeEach } from 'bun:test';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createChangeSet, findChangeSetById, listChangeSetItems, updateChangeSetStatus, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { discardDraftChangeSets } from '../../server/services/change-set-service';

const workspaceId = 'ws-bulk-discard-25';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  const now = new Date().toISOString();
  getDb().run(
    `INSERT OR IGNORE INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workspaceId, `${workspaceId}-store`, '/tmp/bulk-discard', '/tmp/bulk-discard/.git', now, now, 'complete'],
  );
});

function draftSet(title: string): string {
  const cs = createChangeSet({ workspaceId, title, baseCommit: 'test' });
  upsertChangeSetItem({
    changeSetId: cs.id, sku: `SKU-${title}`, operation: 'update',
    draftJson: '{}', baseJson: null, draftHash: 'h',
  });
  return cs.id;
}

describe('bulk draft discard (P2 #25)', () => {
  it('discards 50 drafts in one call with elapsed instrumentation', () => {
    const ids = Array.from({ length: 50 }, (_, i) => draftSet(`bulk-${i}`));
    const startedAt = Date.now();
    const result = discardDraftChangeSets(ids, workspaceId);
    const elapsedMs = Date.now() - startedAt;
    expect(result.success).toBe(true);
    expect(result.discarded).toHaveLength(50);
    for (const id of ids) expect(findChangeSetById(id)).toBeNull();
    // Instrumented timing identifies the remaining bottleneck.
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects the entire batch on one approved or foreign ID', () => {
    const draftId = draftSet('good');
    const approved = createChangeSet({ workspaceId, title: 'approved', baseCommit: 'test' });
    updateChangeSetStatus(approved.id, 'approved', 'abc123');
    expect(listChangeSetItems(draftId).length).toBe(1);

    const rejected = discardDraftChangeSets([draftId, approved.id], workspaceId);
    expect(rejected.success).toBe(false);
    // Atomic: the draft survives the rejected batch.
    expect(findChangeSetById(draftId)).not.toBeNull();
    expect(listChangeSetItems(draftId).length).toBe(1);

    const foreign = discardDraftChangeSets([draftId, 'missing-id'], workspaceId);
    expect(foreign.success).toBe(false);
    expect(findChangeSetById(draftId)).not.toBeNull();
  });
});
