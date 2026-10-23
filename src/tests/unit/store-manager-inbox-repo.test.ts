import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import {
  insertInboxItem,
  getInboxItem,
  listInboxItems,
  updateInboxItemContent,
  reopenInboxItem,
  acknowledgeInboxItem,
  resolveInboxItem,
  resolveInboxItemAsDisappeared,
  supersedeInboxItem,
  type InboxCandidateInput,
} from '../../db/repositories/store-manager-inbox-repo';

/**
 * Manager Inbox repository (operations console, Issue 3). DB-backed: run
 * under `bun test` (excluded from Vitest collection).
 */

const workspaceId = 'ws-inbox-repo-a';
const workspaceIdB = 'ws-inbox-repo-b';

function makeCandidate(overrides: Partial<InboxCandidateInput> = {}): InboxCandidateInput {
  return {
    kind: 'high_severity_catalog_issues',
    dedupeKey: 'high_severity_catalog_issues:catalog:v1',
    severity: 'critical',
    title: 'Product details need attention',
    summary: '3 product details need attention across 3 products.',
    scopeJson: JSON.stringify({ kind: 'catalog' }),
    count: 3,
    sourceRefsJson: JSON.stringify([{ kind: 'validation_result', id: 'MISSING_NAME:SKU1' }]),
    fingerprint: 'a'.repeat(64),
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('store_manager_inbox_items repository (Issue 3)', () => {
  const testDbPath = './test-inbox-repo.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('inserts with lifecycle open and first/last seen equal', () => {
    const inserted = insertInboxItem(workspaceId, makeCandidate());
    expect(inserted.lifecycle).toBe('open');
    expect(inserted.firstSeenAt).toBe(inserted.lastSeenAt);
    expect(inserted.acknowledgedAt).toBeNull();
    expect(inserted.dedupeKey).toBe('high_severity_catalog_issues:catalog:v1');
    const fetched = getInboxItem(workspaceId, inserted.id);
    expect(fetched?.scope).toEqual({ kind: 'catalog' });
  });

  it('enforces (workspace, dedupe_key) uniqueness — duplicate findings are refused', () => {
    const first = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'custom:dedupe:v1', count: 5 }));
    // The schema UNIQUE(workspace_id, dedupe_key) is the backstop: a second
    // insert with the same dedupe key throws. The reconcile service avoids
    // this by matching existing rows before inserting.
    expect(() => insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'custom:dedupe:v1', count: 5 }))).toThrow(/UNIQUE/);
    // Same dedupe key in ANOTHER workspace is allowed (workspace-scoped dedupe).
    const foreign = insertInboxItem(workspaceIdB, makeCandidate({ dedupeKey: 'custom:dedupe:v1', count: 5 }));
    expect(foreign.id).not.toBe(first.id);
    const rows = listInboxItems(workspaceId, { limit: 200 }).filter((r) => r.dedupeKey === 'custom:dedupe:v1');
    expect(rows).toHaveLength(1);
  });

  it('isolates workspaces: foreign ids and lists are invisible across workspaces', () => {
    const inA = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'proposals_awaiting_review:catalog:v1', kind: 'proposals_awaiting_review', severity: 'info' }));
    expect(getInboxItem(workspaceIdB, inA.id)).toBeNull();
    // B never sees A's rows (B may hold its own rows from earlier tests).
    const bItems = listInboxItems(workspaceIdB, { limit: 200 });
    for (const row of bItems) expect(row.workspaceId).toBe(workspaceIdB);
    expect(bItems.some((r) => r.id === inA.id)).toBe(false);
    expect(listInboxItems(workspaceId, { limit: 200 }).some((r) => r.id === inA.id)).toBe(true);
  });

  it('supports lifecycle transitions: open → acknowledged → resolved', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'failed_sync_jobs:sync:v1', kind: 'failed_sync_jobs', count: 1 }));
    expect(acknowledgeInboxItem(workspaceId, item.id)).toBe(true);
    expect(getInboxItem(workspaceId, item.id)?.lifecycle).toBe('acknowledged');
    // Acknowledge is only valid from open.
    expect(acknowledgeInboxItem(workspaceId, item.id)).toBe(false);
    expect(resolveInboxItem(workspaceId, item.id)).toBe(true);
    expect(getInboxItem(workspaceId, item.id)?.lifecycle).toBe('resolved');
    expect(getInboxItem(workspaceId, item.id)?.resolvedAt).not.toBeNull();
    // Resolve again from resolved is a no-op.
    expect(resolveInboxItem(workspaceId, item.id)).toBe(false);
  });

  it('acknowledgement is retained across content refreshes (same row keeps lifecycle)', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'curation_stalled:batch:b1:v1', kind: 'curation_stalled' }));
    expect(acknowledgeInboxItem(workspaceId, item.id)).toBe(true);
    const refreshed = updateInboxItemContent(workspaceId, item.id, makeCandidate({
      dedupeKey: 'curation_stalled:batch:b1:v1',
      kind: 'curation_stalled',
      count: 4,
      fingerprint: 'b'.repeat(64),
    }));
    expect(refreshed).toBe(true);
    const row = getInboxItem(workspaceId, item.id);
    expect(row?.lifecycle).toBe('acknowledged');
    expect(row?.acknowledgedAt).not.toBeNull();
    expect(row?.count).toBe(4);
  });

  it('re-opens a resolved finding on a new fingerprint (auditable, open again)', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'image_repairs_recommended:change_set:cs1:v1', kind: 'image_repairs_recommended', count: 2 }));
    expect(resolveInboxItem(workspaceId, item.id)).toBe(true);
    const reopened = reopenInboxItem(workspaceId, item.id, makeCandidate({
      dedupeKey: 'image_repairs_recommended:change_set:cs1:v1',
      kind: 'image_repairs_recommended',
      count: 3,
      fingerprint: 'c'.repeat(64),
    }));
    expect(reopened).toBe(true);
    const row = getInboxItem(workspaceId, item.id);
    expect(row?.lifecycle).toBe('open');
    expect(row?.resolvedAt).toBeNull();
    expect(row?.acknowledgedAt).toBeNull();
    expect(row?.count).toBe(3);
  });

  it('resolves disappeared open/acknowledged findings but leaves resolved rows untouched', () => {
    const openItem = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'custom:gone1:v1' }));
    const resolvedItem = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'custom:gone2:v1' }));
    expect(resolveInboxItem(workspaceId, resolvedItem.id)).toBe(true);
    expect(resolveInboxItemAsDisappeared(workspaceId, openItem.id)).toBe(true);
    expect(resolveInboxItemAsDisappeared(workspaceId, resolvedItem.id)).toBe(false);
    expect(getInboxItem(workspaceId, openItem.id)?.lifecycle).toBe('resolved');
    expect(getInboxItem(workspaceId, resolvedItem.id)?.lifecycle).toBe('resolved');
  });

  it('supersede marks a row superseded (auditable) and is idempotent', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: 'custom:supersede1:v1' }));
    expect(supersedeInboxItem(workspaceId, item.id)).toBe(true);
    expect(getInboxItem(workspaceId, item.id)?.lifecycle).toBe('superseded');
    expect(supersedeInboxItem(workspaceId, item.id)).toBe(false);
  });

  it('lists ordered by severity then last-seen desc and honors lifecycle filter', () => {
    const now = new Date();
    insertInboxItem(workspaceId, makeCandidate({ dedupeKey: `custom:order1:v1`, severity: 'info', sourceUpdatedAt: now.toISOString() }));
    insertInboxItem(workspaceId, makeCandidate({ dedupeKey: `custom:order2:v1`, severity: 'critical', sourceUpdatedAt: new Date(now.getTime() - 1000).toISOString() }));
    const all = listInboxItems(workspaceId, { limit: 200 });
    const idxCritical = all.findIndex((r) => r.dedupeKey === 'custom:order2:v1');
    const idxInfo = all.findIndex((r) => r.dedupeKey === 'custom:order1:v1');
    expect(idxCritical).toBeGreaterThanOrEqual(0);
    expect(idxInfo).toBeGreaterThanOrEqual(0);
    expect(idxCritical).toBeLessThan(idxInfo);
    const openOnly = listInboxItems(workspaceId, { lifecycle: 'open', limit: 200 });
    for (const row of openOnly) expect(row.lifecycle).toBe('open');
  });

  it('bounds the list limit', () => {
    expect(listInboxItems(workspaceId, { limit: 9999 }).length).toBeLessThanOrEqual(200);
    expect(listInboxItems(workspaceId, { limit: 0 }).length).toBeGreaterThan(0);
  });

  it('foreign mutation attempts report no change (fail closed)', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: `custom:foreign1:v1` }));
    expect(acknowledgeInboxItem(workspaceIdB, item.id)).toBe(false);
    expect(resolveInboxItem(workspaceIdB, item.id)).toBe(false);
    expect(updateInboxItemContent(workspaceIdB, item.id, makeCandidate())).toBe(false);
    expect(getInboxItem(workspaceId, item.id)?.lifecycle).toBe('open');
  });

  it('is idempotent across repeated reconcile-style operations', () => {
    const item = insertInboxItem(workspaceId, makeCandidate({ dedupeKey: `custom:reconcile1:v1` }));
    updateInboxItemContent(workspaceId, item.id, makeCandidate({ dedupeKey: `custom:reconcile1:v1`, count: 1 }));
    updateInboxItemContent(workspaceId, item.id, makeCandidate({ dedupeKey: `custom:reconcile1:v1`, count: 1 }));
    const row = getInboxItem(workspaceId, item.id);
    expect(row?.count).toBe(1);
  });
});
