import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { collectInboxCandidates } from '../../server/services/store-manager-inbox-collectors';
import { reconcileInbox, openInboxItem } from '../../server/services/store-manager-inbox-service';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import { createSyncJob, completeSyncJob } from '../../db/repositories/sync-job-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';

/**
 * Manager Inbox collectors + reconciliation (operations console, Issue 3).
 * DB-backed: run under `bun test`. Exercises the FIVE deterministic collector
 * classes against seeded authoritative rows. No model, no network, no
 * onboarding mutation.
 */

const workspaceId = 'ws-inbox-collectors';
const workspaceIdB = 'ws-inbox-collectors-b';

function seedWorkspaceRow(id: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, 'Inbox Test Store', `/tmp/ws-${id}`, `/tmp/ws-${id}/.git`, now, now, 'complete'],
  );
}

function seedProduct(sku: string) {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO product_index (id, sku, file_path, title, status, product_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [randomUUID(), sku, `/products/${sku}.xml`, `Product ${sku}`, `hash-${sku}`, now, now],
  );
}

function seedBlocker(sku: string) {
  const db = getDb();
  db.run(
    `INSERT INTO validation_results (id, scope_type, scope_id, severity, code, message, created_at)
     VALUES (?, 'catalog', ?, 'blocker', 'MISSING_NAME', 'Product name is missing', ?)`,
    [randomUUID(), sku, new Date().toISOString()],
  );
}

function seedCurationItem(batchId: string, upc: string, stageStatus: string, updatedAtIso: string) {
  const inserted = insertItems(batchId, [
    { upc, name: `Item ${upc}`, rowNumber: 1, stage: 'curation', stageStatus } as never,
  ]);
  for (const item of inserted) {
    getDb().run('UPDATE onboarding_items SET updated_at = ? WHERE id = ?', [updatedAtIso, item.id]);
  }
}

function draftWithLocalImage(sku: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: `Product ${sku}`,
    price: '10.00',
    media: { primary: 'images/local.jpg', additional: ['https://cdn.example.com/ok.jpg'] },
    dbname: 'products',
    uniqueName: 'SKU',
    source: { type: 'local' },
    preserved: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('Manager Inbox collectors + service (Issue 3)', () => {
  const testDbPath = './test-inbox-collectors.db';
  const staleIso = '2026-01-01T00:00:00.000Z';
  const nowIso = '2026-01-10T00:00:00.000Z';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    seedWorkspaceRow(workspaceId);
    seedWorkspaceRow(workspaceIdB);

    // 1) High-severity catalog issues: 2 blockers on active products.
    seedProduct('SKU-1');
    seedProduct('SKU-2');
    seedBlocker('SKU-1');
    seedBlocker('SKU-2');

    // 2) Proposals awaiting review.
    insertProposal({
      workspaceId,
      field: 'ProductField24',
      oldValue: 'acme corp',
      newValue: 'Acme Corp',
      affectedSkus: ['SKU-1'],
      reason: 'casing',
      confidence: 0.9,
      source: 'deterministic',
      status: 'proposed',
    } as never);

    // 3) Failed sync job.
    const job = createSyncJob({ workspaceId, kind: 'export' });
    completeSyncJob(job.id, 'failed', { errorSummary: 'remote rejected' });

    // 4) Image repairs recommended: change set item with a local image path.
    const cs = createChangeSet({ workspaceId, title: 'Repair me', description: null, baseCommit: 'head' });
    upsertChangeSetItem({
      changeSetId: cs.id,
      sku: 'SKU-1',
      operation: 'update',
      draftJson: draftWithLocalImage('SKU-1'),
      baseJson: null,
      draftHash: 'draft-hash-1',
    });

    // 5) Stalled Curation items (old in_progress + failed) in one batch.
    const batch = createBatch({ workspaceId, name: 'Fall 2025', fileName: 'fall.csv', totalItems: 2 });
    seedCurationItem(batch.id, 'UPC-1', 'in_progress', staleIso);
    seedCurationItem(batch.id, 'UPC-2', 'failed', staleIso);
    // A fresh in_progress item must NOT be counted.
    seedCurationItem(batch.id, 'UPC-3', 'in_progress', nowIso);

    // Foreign workspace gets its own data (isolation assertions).
    const batchB = createBatch({ workspaceId: workspaceIdB, name: 'B batch', fileName: 'b.csv', totalItems: 1 });
    seedCurationItem(batchB.id, 'UPC-B', 'in_progress', staleIso);
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('collects exactly the five deterministic classes from authoritative rows', () => {
    const candidates = collectInboxCandidates(workspaceId, {
      now: () => new Date(nowIso),
      curationStallMs: 24 * 60 * 60 * 1000,
    });
    const kinds = new Set(candidates.map((c) => c.kind));
    for (const kind of [
      'high_severity_catalog_issues',
      'proposals_awaiting_review',
      'failed_sync_jobs',
      'image_repairs_recommended',
      'curation_stalled',
    ] as const) {
      expect(kinds.has(kind), `missing collector class ${kind}`).toBe(true);
    }
    const high = candidates.find((c) => c.kind === 'high_severity_catalog_issues');
    expect(high?.count).toBe(2);
    expect(high?.severity).toBe('critical');
    const proposals = candidates.find((c) => c.kind === 'proposals_awaiting_review');
    expect(proposals?.count).toBe(1);
    const sync = candidates.find((c) => c.kind === 'failed_sync_jobs');
    expect(sync?.count).toBe(1);
    const repairs = candidates.find((c) => c.kind === 'image_repairs_recommended');
    expect(repairs?.count).toBe(1);
    expect(repairs?.scope).toEqual({ kind: 'change_set', changeSetId: expect.any(String) });
    const curation = candidates.filter((c) => c.kind === 'curation_stalled');
    expect(curation).toHaveLength(1); // one batch lens
    expect(curation[0].count).toBe(2); // only the two STALE items; UPC-3 excluded
    expect(curation[0].summary).not.toMatch(/failed|in_progress|Curation/i);
  });

  it('never invents an Onboarding Batch lifecycle status (items are the authority)', () => {
    const candidates = collectInboxCandidates(workspaceId, {
      now: () => new Date(nowIso),
      curationStallMs: 24 * 60 * 60 * 1000,
    });
    const curation = candidates.find((c) => c.kind === 'curation_stalled');
    // Scope is the batch LENS; the count derives from item Stage Status only.
    expect(curation?.scope).toEqual({ kind: 'onboarding_batch', batchId: expect.any(String) });
    // Onboarding batches table never carries a lifecycle status beyond active/archived.
    const statuses = getDb()
      .query('SELECT DISTINCT status FROM onboarding_batches')
      .all() as Array<{ status: string }>;
    for (const row of statuses) expect(['active', 'archived']).toContain(row.status);
  });

  it('isolates workspaces for every workspace-scoped collector class', () => {
    const candidatesB = collectInboxCandidates(workspaceIdB, {
      now: () => new Date(nowIso),
      curationStallMs: 24 * 60 * 60 * 1000,
    });
    const curationB = candidatesB.filter((c) => c.kind === 'curation_stalled');
    expect(curationB).toHaveLength(1);
    expect(curationB[0].scope).toEqual({ kind: 'onboarding_batch', batchId: expect.any(String) });
    expect(curationB[0].count).toBe(1);
    // Workspace B seeded no proposals, sync failures, or repair-worthy change
    // sets — those collectors must not leak workspace A rows. NOTE: catalog
    // health is derived from the GLOBAL catalog (product_index / validation
    // results carry no workspace_id), so the high_severity_catalog_issues
    // candidate is intentionally shared across workspaces and not asserted
    // here.
    expect(candidatesB.some((c) => c.kind === 'proposals_awaiting_review')).toBe(false);
    expect(candidatesB.some((c) => c.kind === 'failed_sync_jobs')).toBe(false);
    expect(candidatesB.some((c) => c.kind === 'image_repairs_recommended')).toBe(false);
  });

  it('reconciliation is idempotent and dedupes by kind+source identity', () => {
    const first = reconcileInbox(workspaceId, {
      now: () => new Date(nowIso),
      curationStallMs: 24 * 60 * 60 * 1000,
    });
    const second = reconcileInbox(workspaceId, {
      now: () => new Date(nowIso),
      curationStallMs: 24 * 60 * 60 * 1000,
    });
    expect(first.inserted).toBeGreaterThanOrEqual(5);
    expect(second.inserted).toBe(0);
    const keys = second.items.map((i) => i.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('high_severity_catalog_issues:catalog:v1');
    expect(keys).toContain('proposals_awaiting_review:catalog:v1');
    expect(keys).toContain('failed_sync_jobs:sync:v1');
  });

  it('reconciliation resolves disappeared findings and re-opens changed ones', () => {
    // A finding disappears: flip the failed sync job back to success.
    const db = getDb();
    const failedJobId = (db.query("SELECT id FROM sync_jobs WHERE workspace_id = ? AND status = 'failed'").get(workspaceId) as { id: string }).id;
    completeSyncJob(failedJobId, 'success');
    const after = reconcileInbox(workspaceId, { now: () => new Date(nowIso), curationStallMs: 24 * 60 * 60 * 1000 });
    const syncItem = after.items.find((i) => i.dedupeKey === 'failed_sync_jobs:sync:v1');
    expect(syncItem).toBeDefined();
    expect(syncItem!.lifecycle).toBe('resolved');
    expect(syncItem!.resolvedAt).not.toBeNull();
    // Reappears with a NEW fingerprint → re-opened.
    completeSyncJob(failedJobId, 'failed');
    const reopen = reconcileInbox(workspaceId, { now: () => new Date(nowIso), curationStallMs: 24 * 60 * 60 * 1000 });
    const reopenedSync = reopen.items.find((i) => i.dedupeKey === 'failed_sync_jobs:sync:v1');
    expect(reopenedSync!.lifecycle).toBe('open');
    expect(reopenedSync!.resolvedAt).toBeNull();
  });

  it('openInboxItem revalidates against current authority', () => {
    const items = reconcileInbox(workspaceId, { now: () => new Date(nowIso), curationStallMs: 24 * 60 * 60 * 1000 }).items;
    const proposals = items.find((i) => i.dedupeKey === 'proposals_awaiting_review:catalog:v1')!;
    const fresh = openInboxItem(workspaceId, proposals.id);
    expect(fresh?.isCurrent).toBe(true);
    expect(fresh?.current?.count).toBe(1);
    // Change the source authority (dismiss the proposal) → stale revalidation.
    getDb().query(
      "UPDATE catalog_health_proposals SET status = 'dismissed', updated_at = ? WHERE workspace_id = ? AND status = 'proposed'",
    ).run(new Date(nowIso).toISOString(), workspaceId);
    const stale = openInboxItem(workspaceId, proposals.id);
    expect(stale?.isCurrent).toBe(false);
    expect(stale?.current).toBeNull();
    // A stale item is NOT treated as current.
    expect(stale!.item.lifecycle).toBe('open');
  });

  it('reconciliation never mutates onboarding state', () => {
    const beforeItems = getDb().query('SELECT id, updated_at FROM onboarding_items').all() as Array<{ id: string; updated_at: string }>;
    const beforeBatches = getDb().query('SELECT id, status, updated_at FROM onboarding_batches').all() as Array<{ id: string; status: string; updated_at: string }>;
    reconcileInbox(workspaceId, { now: () => new Date(nowIso), curationStallMs: 24 * 60 * 60 * 1000 });
    reconcileInbox(workspaceIdB, { now: () => new Date(nowIso), curationStallMs: 24 * 60 * 60 * 1000 });
    const afterItems = getDb().query('SELECT id, updated_at FROM onboarding_items').all() as Array<{ id: string; updated_at: string }>;
    const afterBatches = getDb().query('SELECT id, status, updated_at FROM onboarding_batches').all() as Array<{ id: string; status: string; updated_at: string }>;
    expect(afterItems).toEqual(beforeItems);
    expect(afterBatches).toEqual(beforeBatches);
  });

  it('unknown/foreign inbox ids return null on open (fail closed)', () => {
    expect(openInboxItem(workspaceId, randomUUID())).toBeNull();
    expect(openInboxItem(workspaceIdB, randomUUID())).toBeNull();
  });
});
