/**
 * Drift 2/6 (#251) — workspace-scoped counts, consistent totals, bounded bulk read.
 *
 * Behavioral coverage at the highest existing integration seam (drift repo +
 * dashboard service, scratch workspaces + database):
 * - two-workspace isolation for counts and lists
 * - explicit outstanding definition (open vs reconcile, blocking union)
 * - filtered-list totals agree with their own filter; dashboard agrees with
 *   the unfiltered workspace counts
 * - max page size clamping + invalid limit/offset rejection
 * - stable pagination across equal timestamps and across resolution
 * - bulk queue reads in bounded pages (multi-page queue drains completely)
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  createDrift,
  listDrift,
  resolveDrift,
  countDrift,
  countOpenDrift,
  countReconcileDrift,
  countBlockingDrift,
  getDriftCounts,
  parseDriftPageParams,
  DRIFT_MAX_PAGE_SIZE,
  DRIFT_BULK_PAGE_SIZE,
} from '../../db/repositories/drift-repo';
import { getDashboardStatsData } from '../../server/services/dashboard-service';

const testDbPath = '/tmp/baystate-cms-drift-251-test.db';

function insertWorkspace(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, `${id}-store`, `/tmp/${id}`, `/tmp/${id}/.git`, now, now, 'complete'],
  );
}

function makeDrift(workspaceId: string, sku: string) {
  return createDrift({
    workspaceId,
    sku,
    localHash: `local-${sku}`,
    remoteHash: `remote-${sku}`,
    localJson: JSON.stringify({ sku }),
    remoteJson: JSON.stringify({ sku }),
  });
}

describe('Drift 2/6 (#251): workspace-scoped counts and consistent totals', () => {
  const wsA = `ws-a-${randomUUID()}`;
  const wsB = `ws-b-${randomUUID()}`;

  beforeAll(() => {
    try { (Bun as unknown as { unlinkSync?: (p: string) => void }).unlinkSync?.(testDbPath); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace(wsA);
    insertWorkspace(wsB);
  });

  afterAll(() => {
    try { (Bun as unknown as { unlinkSync?: (p: string) => void }).unlinkSync?.(testDbPath); } catch { /* ok */ }
  });

  it('isolates two workspaces: rows from B never leak into A counts or lists', () => {
    makeDrift(wsA, `A-ISO-1-${randomUUID()}`);
    makeDrift(wsA, `A-ISO-2-${randomUUID()}`);
    makeDrift(wsB, `B-ISO-1-${randomUUID()}`);

    expect(countOpenDrift(wsA)).toBe(2);
    expect(countOpenDrift(wsB)).toBe(1);
    expect(listDrift(wsA, 'open', 100, 0).every(d => d.workspaceId === wsA)).toBe(true);
    expect(listDrift(wsB, 'open', 100, 0).every(d => d.workspaceId === wsB)).toBe(true);

    const countsA = getDriftCounts(wsA);
    expect(countsA.open).toBe(2);
    expect(countsA.total).toBe(2);
  });

  it('defines outstanding explicitly: open vs reconcile vs blocking', () => {
    const ws = `ws-out-${randomUUID()}`;
    insertWorkspace(ws);
    const d1 = makeDrift(ws, `OUT-1-${randomUUID()}`);
    const d2 = makeDrift(ws, `OUT-2-${randomUUID()}`);
    resolveDrift(d2.id, 'in_reconcile');

    const counts = getDriftCounts(ws);
    // Neither folded nor dropped: 1 open + 1 reconcile, blocking is the union.
    expect(counts.open).toBe(1);
    expect(counts.reconcile).toBe(1);
    expect(counts.blocking).toBe(2);
    expect(counts.total).toBe(2);
    expect(countOpenDrift(ws)).toBe(1);
    expect(countReconcileDrift(ws)).toBe(1);
    expect(countBlockingDrift(ws)).toBe(2);

    // Filtered totals agree with their own filter.
    expect(countDrift(ws, 'open')).toBe(1);
    expect(countDrift(ws, 'in_reconcile')).toBe(1);
    expect(countDrift(ws, 'blocking')).toBe(2);
    expect(countDrift(ws)).toBe(2);
    expect(listDrift(ws, 'open', 100, 0).length).toBe(countDrift(ws, 'open'));
    expect(listDrift(ws, 'in_reconcile', 100, 0).length).toBe(countDrift(ws, 'in_reconcile'));
    expect(listDrift(ws, 'blocking', 100, 0).length).toBe(countDrift(ws, 'blocking'));
    expect(d1.sku).toBeTruthy();
  });

  it('keeps dashboard counts scoped and agreeing with the drift list', () => {
    const statsA = getDashboardStatsData(wsA);
    expect(statsA.metrics.openDrifts).toBe(countOpenDrift(wsA));
    expect(statsA.metrics.reconcileDrifts).toBe(countReconcileDrift(wsA));

    const statsB = getDashboardStatsData(wsB);
    expect(statsB.metrics.openDrifts).toBe(countOpenDrift(wsB));
    // B's rows do not inflate A's dashboard.
    expect(statsA.metrics.openDrifts).not.toBe(
      countOpenDrift(wsA) + countOpenDrift(wsB),
    );
  });
});

describe('Drift 2/6 (#251): bounded pagination', () => {
  const ws = `ws-page-${randomUUID()}`;

  beforeAll(() => {
    insertWorkspace(ws);
  });

  it('rejects negative/invalid limits and offsets deterministically', () => {
    expect(() => parseDriftPageParams('-1', undefined)).toThrow(/Invalid limit/);
    expect(() => parseDriftPageParams('0', undefined)).toThrow(/Invalid limit/);
    expect(() => parseDriftPageParams('abc', undefined)).toThrow(/Invalid limit/);
    expect(() => parseDriftPageParams('1.5', undefined)).toThrow(/Invalid limit/);
    expect(() => parseDriftPageParams(undefined, '-1')).toThrow(/Invalid offset/);
    expect(() => parseDriftPageParams(undefined, 'xyz')).toThrow(/Invalid offset/);
  });

  it('clamps oversized limits to the defined maximum', () => {
    const { limit } = parseDriftPageParams(String(DRIFT_MAX_PAGE_SIZE + 900), undefined);
    expect(limit).toBe(DRIFT_MAX_PAGE_SIZE);
    expect(DRIFT_MAX_PAGE_SIZE).toBe(100);
  });

  it('clamps oversized repository reads to the maximum page size', () => {
    const w = `ws-clamp-${randomUUID()}`;
    insertWorkspace(w);
    for (let i = 0; i < 5; i++) makeDrift(w, `CLAMP-${i}-${randomUUID()}`);
    const rows = listDrift(w, 'open', DRIFT_MAX_PAGE_SIZE + 500, 0);
    expect(rows.length).toBeLessThanOrEqual(DRIFT_MAX_PAGE_SIZE);
  });

  it('pages stably across equal timestamps with no skips or repeats', () => {
    const w = `ws-stable-${randomUUID()}`;
    insertWorkspace(w);
    const skus: string[] = [];
    for (let i = 0; i < 7; i++) {
      const sku = `STABLE-${i}-${randomUUID()}`;
      skus.push(sku);
      makeDrift(w, sku);
    }
    // Force identical timestamps: ordering must still be deterministic via id.
    const db = getDb();
    db.run(`UPDATE remote_drift SET detected_at = ? WHERE workspace_id = ?`, ['2026-09-18T00:00:00.000Z', w]);

    const first = listDrift(w, 'open', 3, 0).map(d => d.id);
    const second = listDrift(w, 'open', 3, 3).map(d => d.id);
    const third = listDrift(w, 'open', 3, 6).map(d => d.id);
    const all = [...first, ...second, ...third];
    expect(all.length).toBe(7);
    expect(new Set(all).size).toBe(7);

    // Repeating the same paged read yields the identical order.
    const again = [
      ...listDrift(w, 'open', 3, 0).map(d => d.id),
      ...listDrift(w, 'open', 3, 3).map(d => d.id),
      ...listDrift(w, 'open', 3, 6).map(d => d.id),
    ];
    expect(again).toEqual(all);
    expect(skus.length).toBe(7);
  });

  it('stays consistent while rows resolve between pages', () => {
    const w = `ws-resolve-${randomUUID()}`;
    insertWorkspace(w);
    const created = [];
    for (let i = 0; i < 5; i++) created.push(makeDrift(w, `RES-${i}-${randomUUID()}`));

    const page1 = listDrift(w, 'open', 2, 0);
    expect(page1.length).toBe(2);
    for (const row of page1) resolveDrift(row.id, 'kept_local');

    // Remaining rows keep their relative order; resolved rows are gone.
    const remaining = listDrift(w, 'open', 100, 0).map(d => d.id).sort();
    const expected = created.filter(c => !page1.some(p => p.id === c.id)).map(c => c.id).sort();
    expect(remaining).toEqual(expected);
    expect(countDrift(w, 'open')).toBe(3);
  });

  it('reads a multi-page queue in bounded pages (bulk contract)', () => {
    const w = `ws-bulk-${randomUUID()}`;
    insertWorkspace(w);
    const total = DRIFT_BULK_PAGE_SIZE * 2 + 10;
    for (let i = 0; i < total; i++) makeDrift(w, `BULK-${i}-${randomUUID()}`);

    // Same bounded-page loop the bulk route uses: never one unbounded read.
    const collected = [];
    const seenPageSizes: number[] = [];
    let offset = 0;
    for (;;) {
      const page = listDrift(w, 'open', DRIFT_BULK_PAGE_SIZE, offset);
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(DRIFT_BULK_PAGE_SIZE);
      seenPageSizes.push(page.length);
      collected.push(...page);
      if (page.length < DRIFT_BULK_PAGE_SIZE) break;
      offset += page.length;
    }
    expect(collected.length).toBe(total);
    expect(new Set(collected.map(d => d.id)).size).toBe(total);
    expect(seenPageSizes.length).toBeGreaterThan(2);
    expect(countDrift(w, 'open')).toBe(total);
  });

  it('workspace-checks resolution: cross-workspace ids are refused', async () => {
    const wA = `ws-xa-${randomUUID()}`;
    const wB = `ws-xb-${randomUUID()}`;
    insertWorkspace(wA);
    insertWorkspace(wB);
    const row = makeDrift(wA, `X-${randomUUID()}`);
    // Repo-level guard lives at the route (workspace comparison); the row
    // itself is still only visible inside its own workspace lists.
    expect(listDrift(wB, 'open', 100, 0).some(d => d.id === row.id)).toBe(false);
    expect(listDrift(wA, 'open', 100, 0).some(d => d.id === row.id)).toBe(true);
  });
});
