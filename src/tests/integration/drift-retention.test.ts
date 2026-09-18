/**
 * Drift 6/6 (#255) — audit-event retention and legacy blob prune.
 *
 * Behavioral coverage at the repository + service seam (scratch database,
 * no ShopSite network, no Git workspace needed):
 * - backfill is resumable and idempotent; deletion only after verified audit
 * - missing actor/field/commit facts are never invented (explicit unknown)
 * - outstanding (`open`) and reconcile-linked (`in_reconcile`) rows survive
 * - past decisions are queryable (workspace-scoped, filtered, paginated)
 * - storage claims stay honest (measured bytes + freelist, no file-shrink promise)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  findDriftById,
  countLegacyTerminal,
  getDriftCounts,
} from '../../db/repositories/drift-repo';
import {
  addAuditLog,
  listDriftAuditHistory,
  countDriftAuditHistory,
  hasDriftDecisionAudit,
} from '../../db/repositories/audit-log-repo';
import {
  runDriftRetention,
  getDriftRetentionStats,
  UNKNOWN_LEGACY_PROVENANCE,
} from '../../shopsite/drift-retention';

const testDbPath = '/tmp/baystate-cms-drift-255-test.db';

function newWorkspace(): string {
  const ws = `ws-255-${randomUUID()}`;
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ws, `${ws}-store`, `/tmp/${ws}`, `/tmp/${ws}/.git`, now, now, 'complete'],
  );
  return ws;
}

function insertTerminal(
  ws: string,
  sku: string,
  status: string,
  opts: {
    link?: string | null;
    remoteHash?: string;
    localJson?: string | null;
    remoteJson?: string;
    diffJson?: string | null;
    detectedAt?: string;
  } = {},
): string {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO remote_drift
       (id, workspace_id, sku, detected_at, status, local_hash, remote_hash,
        local_json, remote_json, diff_json, reconcile_change_set_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ws,
      sku,
      opts.detectedAt ?? new Date().toISOString(),
      status,
      'lh',
      opts.remoteHash ?? `rh-${sku}`,
      opts.localJson ?? JSON.stringify({ sku, side: 'local' }),
      opts.remoteJson ?? `{"sku":"${sku}","side":"remote","pad":"${'x'.repeat(2000)}"}`,
      opts.diffJson ?? null,
      opts.link ?? null,
    ],
  );
  return id;
}

function insertOutstanding(ws: string, sku: string, status: 'open' | 'in_reconcile', link: string | null = null): string {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT INTO remote_drift
       (id, workspace_id, sku, detected_at, status, local_hash, remote_hash,
        local_json, remote_json, diff_json, reconcile_change_set_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ws, sku, new Date().toISOString(), status, 'lh', `rh-${sku}`,
      JSON.stringify({ sku, side: 'local' }), JSON.stringify({ sku, side: 'remote' }),
      JSON.stringify({ hunks: [{ field: 'core.price', baselineValue: '1', remoteValue: '2' }] }), link],
  );
  return id;
}

describe('Drift 6/6 (#255): audit retention and legacy blob prune', () => {
  beforeAll(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('dry-runs without mutating, then backfills + prunes idempotently', () => {
    const ws = newWorkspace();
    const keptId = insertTerminal(ws, 'DRY-001', 'kept_local');
    const acceptedId = insertTerminal(ws, 'DRY-002', 'accepted_remote');
    // Pre-existing decision audit: backfill must not duplicate it.
    addAuditLog({
      workspaceId: ws,
      entityType: 'drift',
      entityId: acceptedId,
      action: 'accepted_remote',
      message: 'Accepted remote version for SKU "DRY-002" into local Git catalog',
      detailsJson: JSON.stringify({ sku: 'DRY-002' }),
    });
    const resolvedId = insertTerminal(ws, 'DRY-003', 'resolved', {
      diffJson: JSON.stringify({
        hunks: [{ field: 'core.price', baselineValue: '19.99', remoteValue: '24.99' }],
        baselineCommit: 'abc123',
      }),
    });
    expect(countLegacyTerminal(ws)).toBe(3);

    const auditsBefore = countDriftAuditHistory(ws);

    // Dry run: plans and measures, writes nothing, deletes nothing.
    const dry = runDriftRetention(ws, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.backfilled).toBe(2);
    expect(dry.alreadyCovered).toBe(1);
    expect(dry.pruned).toBe(3);
    expect(dry.remaining).toBe(3);
    expect(countLegacyTerminal(ws)).toBe(3);
    expect(countDriftAuditHistory(ws)).toBe(auditsBefore);
    expect(dry.reclaimedBlobBytes).toBeGreaterThan(0);

    // Real run: two backfills, one already-covered, three prunes.
    const first = runDriftRetention(ws, {});
    expect(first.dryRun).toBe(false);
    expect(first.backfilled).toBe(2);
    expect(first.alreadyCovered).toBe(1);
    expect(first.pruned).toBe(3);
    expect(first.remaining).toBe(0);
    expect(first.unverified).toBe(0);
    expect(first.reclaimedBlobBytes).toBeGreaterThan(0);
    expect(countLegacyTerminal(ws)).toBe(0);

    // The already-covered row gained no duplicate audit.
    expect(hasDriftDecisionAudit(ws, acceptedId)).toBe(true);
    expect(
      listDriftAuditHistory(ws, {}, 100, 0).filter((e) => e.entityId === acceptedId).length,
    ).toBe(1);

    // Backfilled rows are answerable through the audit surface.
    expect(hasDriftDecisionAudit(ws, keptId)).toBe(true);
    expect(hasDriftDecisionAudit(ws, resolvedId)).toBe(true);

    // Idempotent rerun: zero new work.
    const second = runDriftRetention(ws, {});
    expect(second.backfilled).toBe(0);
    expect(second.pruned).toBe(0);
    expect(second.remaining).toBe(0);
    expect(second.alreadyCovered).toBe(0);
  });

  it('never invents missing actor, field, or commit facts', () => {
    const ws = newWorkspace();
    // No diff_json at all: field + commit are unknown.
    const bareId = insertTerminal(ws, 'BARE-001', 'kept_local', { diffJson: null });
    // Generic resolved status: decision itself is unknown.
    const genericId = insertTerminal(ws, 'GEN-001', 'resolved', { diffJson: null });
    // Single-hunk diff: known field facts are preserved.
    const hunkId = insertTerminal(ws, 'HUNK-001', 'resolved', {
      diffJson: JSON.stringify({
        hunks: [{ field: 'core.price', baselineValue: '19.99', remoteValue: '24.99' }],
        baselineCommit: 'abc123',
      }),
    });

    const result = runDriftRetention(ws, {});
    expect(result.backfilled).toBe(3);
    expect(result.pruned).toBe(3);

    const byEntity = new Map(
      listDriftAuditHistory(ws, { action: 'drift_decision_backfilled' }, 100, 0).map((e) => [e.entityId, e]),
    );

    const bare = JSON.parse(byEntity.get(bareId)!.detailsJson!) as Record<string, unknown>;
    expect(bare['actor']).toBe(UNKNOWN_LEGACY_PROVENANCE);
    expect(bare['field']).toBeNull();
    expect(bare['fields']).toEqual([]);
    expect(bare['fieldProvenance']).toBe(UNKNOWN_LEGACY_PROVENANCE);
    expect(bare['baselineCommit']).toBeNull();
    expect(bare['baselineCommitProvenance']).toBe(UNKNOWN_LEGACY_PROVENANCE);
    expect(bare['decision']).toBe('rejected');
    expect(bare['decisionSource']).toBe('legacy-status:kept_local');
    expect((bare['missing'] as string[]).sort()).toEqual(['actor', 'baselineCommit', 'field']);
    // Known facts preserved verbatim.
    expect(bare['sku']).toBe('BARE-001');
    expect(bare['remoteHash']).toBe('rh-BARE-001');
    expect(bare['legacyStatus']).toBe('kept_local');

    const generic = JSON.parse(byEntity.get(genericId)!.detailsJson!) as Record<string, unknown>;
    expect(generic['decision']).toBe('unknown');
    expect(generic['decisionSource']).toBe('legacy-status:resolved');

    const hunk = JSON.parse(byEntity.get(hunkId)!.detailsJson!) as Record<string, unknown>;
    expect(hunk['field']).toBe('core.price');
    expect(hunk['fields']).toEqual(['core.price']);
    expect(hunk['fieldProvenance']).toBe('diff-hunks');
    expect(hunk['baselineValue']).toBe('19.99');
    expect(hunk['remoteValue']).toBe('24.99');
    expect(hunk['baselineCommit']).toBe('abc123');
    expect(hunk['baselineCommitProvenance']).toBe('diff-json');
    expect((hunk['missing'] as string[])).toEqual(['actor']);
  });

  it('outstanding and reconcile-linked work always survives pruning', () => {
    const ws = newWorkspace();
    const openId = insertOutstanding(ws, 'LIVE-001', 'open');
    const recId = insertOutstanding(ws, 'LIVE-002', 'in_reconcile', 'cs-live-1');
    const openBefore = findDriftById(openId)!;
    insertTerminal(ws, 'OLD-001', 'kept_local');
    insertTerminal(ws, 'OLD-002', 'accepted_remote');
    expect(getDriftCounts(ws).open).toBe(1);
    expect(getDriftCounts(ws).reconcile).toBe(1);

    const result = runDriftRetention(ws, {});
    expect(result.pruned).toBe(2);
    expect(result.remaining).toBe(0);

    // Outstanding rows intact: same ids, status, link, and blobs.
    const openAfter = findDriftById(openId)!;
    expect(openAfter.status).toBe('open');
    expect(openAfter.localJson).toBe(openBefore.localJson);
    expect(openAfter.remoteJson).toBe(openBefore.remoteJson);
    const recAfter = findDriftById(recId)!;
    expect(recAfter.status).toBe('in_reconcile');
    expect(recAfter.reconcileChangeSetId).toBe('cs-live-1');
    expect(result.outstandingAfter.open).toBe(1);
    expect(result.outstandingAfter.reconcile).toBe(1);
    expect(countLegacyTerminal(ws)).toBe(0);
  });

  it('past decisions are queryable by sku, field, action, and decision', () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    insertTerminal(ws, 'Q-001', 'kept_local');
    insertTerminal(ws, 'Q-002', 'resolved', {
      diffJson: JSON.stringify({
        hunks: [{ field: 'core.price', baselineValue: '5', remoteValue: '6' }],
        baselineCommit: 'q-commit',
      }),
    });
    insertTerminal(other, 'Q-001', 'kept_local');
    runDriftRetention(ws, {});
    runDriftRetention(other, {});

    // Unfiltered history agrees with its own count.
    const total = countDriftAuditHistory(ws);
    const all = listDriftAuditHistory(ws, {}, 100, 0);
    expect(total).toBe(2);
    expect(all.length).toBe(2);

    // SKU filter isolates one decision.
    expect(countDriftAuditHistory(ws, { sku: 'Q-001' })).toBe(1);
    expect(listDriftAuditHistory(ws, { sku: 'Q-001' }, 100, 0)[0].entityType).toBe('drift');

    // Field filter finds the hunk-derived backfill only.
    expect(countDriftAuditHistory(ws, { field: 'core.price' })).toBe(1);
    const fieldHit = listDriftAuditHistory(ws, { field: 'core.price' }, 100, 0)[0];
    expect(JSON.parse(fieldHit.detailsJson!)['sku']).toBe('Q-002');

    // Action + decision filters.
    expect(countDriftAuditHistory(ws, { action: 'drift_decision_backfilled' })).toBe(2);
    expect(countDriftAuditHistory(ws, { decision: 'rejected' })).toBe(1);
    expect(countDriftAuditHistory(ws, { decision: 'unknown' })).toBe(1);

    // Workspace isolation: the other workspace never leaks in.
    expect(countDriftAuditHistory(ws, { sku: 'Q-001' })).toBe(1);
    expect(countDriftAuditHistory(other, {})).toBe(1);

    // Stable bounded pagination: limit 1 pages cover the full set exactly once.
    const page0 = listDriftAuditHistory(ws, {}, 1, 0);
    const page1 = listDriftAuditHistory(ws, {}, 1, 1);
    expect(page0.length).toBe(1);
    expect(page1.length).toBe(1);
    expect(page0[0].id).not.toBe(page1[0].id);
    expect(new Set([page0[0].id, page1[0].id]).size).toBe(2);
  });

  it('is resumable across bounded calls and rejects invalid bounds', () => {
    const ws = newWorkspace();
    for (let i = 0; i < 5; i++) insertTerminal(ws, `RS-${i}`, 'kept_local');
    const part = runDriftRetention(ws, { batchSize: 2, maxBatches: 1 });
    expect(part.pruned).toBe(2);
    expect(part.remaining).toBe(3);
    const rest = runDriftRetention(ws, {});
    expect(rest.remaining).toBe(0);
    expect(countLegacyTerminal(ws)).toBe(0);

    expect(() => runDriftRetention(ws, { batchSize: 0 })).toThrow(/batchSize/);
    expect(() => runDriftRetention(ws, { maxBatches: -1 })).toThrow(/maxBatches/);
  });

  it('reports honest storage: measured bytes, freelist reuse, vacuum note', () => {
    const ws = newWorkspace();
    insertTerminal(ws, 'ST-001', 'kept_local');
    const statsBefore = getDriftRetentionStats(ws);
    expect(statsBefore.terminalRows).toBe(1);
    expect(statsBefore.terminalBlobCharsEstimate).toBeGreaterThan(0);
    expect(statsBefore.vacuumNote).toMatch(/VACUUM/);

    const result = runDriftRetention(ws, {});
    expect(result.reclaimedBlobBytes).toBeGreaterThan(0);
    expect(result.vacuumNote).toMatch(/VACUUM/);
    expect(result.vacuumNote).toMatch(/not performed here/);
    expect(result.vacuumNote).toMatch(/freelist/);
    expect(typeof result.reusableFreelistBytes === 'number' || result.reusableFreelistBytes === null).toBe(true);
    expect(typeof result.fileBytes === 'number' || result.fileBytes === null).toBe(true);

    const statsAfter = getDriftRetentionStats(ws);
    expect(statsAfter.terminalRows).toBe(0);
  });
});
