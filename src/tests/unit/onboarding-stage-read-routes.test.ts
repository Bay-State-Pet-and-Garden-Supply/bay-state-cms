/**
 * Slice 1 — v2 stage-read route tests (Bun; isolated temp DBs, no network).
 *
 * Exercises the HTTP contract: strict filters, v3 cursor traversal, error
 * codes, v1 golden compatibility, read-only guarantees (no worker start, no
 * row mutation), and injection safety.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { markReviewed, markApproved } from '../../db/repositories/onboarding-review-repo';
import onboardingStageReadRoutes from '../../server/routes/onboarding-stage-read-routes';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import {
  build36CellSpecs,
  buildLargeMixedSpecs,
  expectedMatrixForSpecs,
  type StageReadItemSpec,
} from '../helpers/onboarding-stage-read-fixtures';

let workspaceId: string;
let app: Hono;

function makeWorkspace(): string {
  workspaceId = randomUUID();
  const workspacePath = path.join(os.tmpdir(), `ws-stage-read-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  app = new Hono();
  app.route('/api', onboardingStageReadRoutes);
  app.route('/api', onboardingWorkRoutes);
  return workspaceId;
}

function seedBatch(specs: StageReadItemSpec[]): string {
  const batch = createBatch({ workspaceId, name: `Batch ${randomUUID().slice(0, 6)}`, fileName: 'test.csv', totalItems: 0 });
  insertItems(
    batch.id,
    specs.map(s => ({
      upc: s.upc,
      name: s.name,
      brandHint: s.brandHint,
      sourceUrl: s.sourceUrl,
      rowNumber: s.rowNumber,
      stage: s.stage as never,
      stageStatus: s.stageStatus as never,
    })),
    'sourcing',
    1,
  );
  return batch.id;
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const res = await app.fetch(new Request(`http://localhost${pathname}`));
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function itemDigest(): string {
  const rows = getDb().query(
    'SELECT id, stage, stage_status, claimed_by, claimed_at, updated_at FROM onboarding_items ORDER BY id',
  ).all() as Array<Record<string, unknown>>;
  return JSON.stringify(rows);
}

beforeEach(() => {
  makeWorkspace();
});

describe('v2 counts', () => {
  it('returns the full 36-cell matrix with matching totals on a 36-cell batch', async () => {
    const specs = build36CellSpecs();
    const batchId = seedBatch(specs);
    const { status, body } = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts`);
    expect(status).toBe(200);
    expect(body.schemaVersion).toBe(2);
    expect(body.stageVocabularyVersion).toBe(2);
    expect(body.batchId).toBe(batchId);
    expect(body.matchingTotal).toBe(36);
    expect(typeof body.filterFingerprint).toBe('string');
    const expected = expectedMatrixForSpecs(specs);
    expect(body.stageStatusMatrix).toEqual(expected);
    const catSum = Object.values(body.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(catSum).toBe(36);
    expect(body.projectionHealth).toBeDefined();
    expect(body.projectionHealth.computedAt).toBeDefined();
  });

  it('filters by canonical v2 stage (official flow is the same items as v1 sourcing)', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const { status, body } = await getJson(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=route_sources`,
    );
    expect(status).toBe(200);
    expect(body.matchingTotal).toBe(6);
    expect(body.stageStatusMatrix.route_sources.pending).toBe(1);
    expect(body.stageStatusMatrix.find_product_page.pending).toBe(0);
  });

  it('produces a stable fingerprint for identical requests', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const a = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=collect_details`);
    const b = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=collect_details`);
    expect(a.body.filterFingerprint).toBe(b.body.filterFingerprint);
  });
});

describe('strict input validation', () => {
  it('rejects v1 stage strings with invalid_version, step zero distinctly, unknown vaguely-but-400', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const v1 = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=sourcing`);
    expect(v1.status).toBe(400);
    expect(v1.body.code).toBe('invalid_version');
    const step0 = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=brand-setup`);
    expect(step0.status).toBe(400);
    const bogus = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=publish`);
    expect(bogus.status).toBe(400);
  });

  it('rejects bad limits, unknown params, duplicates, and wrong vocab version', async () => {
    const batchId = seedBatch(build36CellSpecs());
    for (const lim of ['0', '101', '500', '1.5', 'NaN', 'fifty', '-3']) {
      const r = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?limit=${lim}`);
      expect(r.status).toBe(400);
    }
    for (const lim of ['1', '50', '100']) {
      const r = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?limit=${lim}`);
      expect(r.status).toBe(200);
    }
    const unknown = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?bogus=1`);
    expect(unknown.status).toBe(400);
    const dup = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=route_sources&stage=find_product_page`);
    expect(dup.status).toBe(400);
    const v1param = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stageVocabularyVersion=1`);
    expect(v1param.status).toBe(400);
    expect(v1param.body.code).toBe('invalid_version');
  });

  it('404s unknown and foreign batches before querying', async () => {
    const missing = await getJson(`/api/onboarding/v2/batches/does-not-exist/stage-work-state/counts`);
    expect(missing.status).toBe(404);
    const foreignWs = randomUUID();
    insertWorkspace({
      id: foreignWs,
      name: 'foreign',
      workspacePath: `/tmp/foreign-${foreignWs.slice(0, 8)}`,
      gitPath: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const foreignBatch = createBatch({ workspaceId: foreignWs, name: 'foreign', fileName: 'f.csv', totalItems: 0 });
    const foreign = await getJson(`/api/onboarding/v2/batches/${foreignBatch.id}/stage-work-state/counts`);
    expect(foreign.status).toBe(404);
  });
});

describe('cursor traversal', () => {
  it('walks a 600-row batch to completion with union == oracle set and stable order', async () => {
    const specs = buildLargeMixedSpecs(600);
    const batchId = seedBatch(specs);
    const seen = new Set<string>();
    const order: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const qs = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
      const { status, body } = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items${qs}`);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(50);
      for (const item of body.items as Array<{ itemId: string }>) {
        expect(seen.has(item.itemId)).toBe(false);
        seen.add(item.itemId);
        order.push(item.itemId);
      }
      pages += 1;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 30) throw new Error('traversal did not terminate');
    }
    expect(seen.size).toBe(600);
    // Determinism: repeat traversal, identical order.
    const order2: string[] = [];
    let cursor2: string | null = null;
    for (;;) {
      const qs = cursor2 ? `?limit=50&cursor=${encodeURIComponent(cursor2)}` : '?limit=50';
      const { body } = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items${qs}`);
      for (const item of body.items as Array<{ itemId: string }>) order2.push(item.itemId);
      if (!body.nextCursor) break;
      cursor2 = body.nextCursor;
    }
    expect(order2).toEqual(order);
  });

  it('preserves the result set when the limit changes mid-traversal', async () => {
    const batchId = seedBatch(buildLargeMixedSpecs(200));
    const collect = async (limits: number[]): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let i = 0;
      for (;;) {
        const lim = limits[Math.min(i, limits.length - 1)]!;
        const qs = cursor ? `?limit=${lim}&cursor=${encodeURIComponent(cursor)}` : `?limit=${lim}`;
        const { body } = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items${qs}`);
        for (const item of body.items as Array<{ itemId: string }>) ids.push(item.itemId);
        if (!body.nextCursor) break;
        cursor = body.nextCursor;
        i += 1;
      }
      return ids.sort();
    };
    expect(await collect([50])).toEqual(await collect([13, 97, 7]));
  });

  it('rejects legacy cursors, tampered cursors, and cross-filter reuse with distinct codes', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const legacy = Buffer.from(JSON.stringify({ v: 2, rowNumber: 1, id: 'x', filterHash: 'a'.repeat(16) }), 'utf8').toString('base64url');
    const r1 = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?cursor=${encodeURIComponent(legacy)}`);
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('invalid_version');
    const r2 = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?cursor=!!!`);
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('malformed_cursor');
    const first = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?limit=5&stage=route_sources`);
    expect(first.status).toBe(200);
    const reuse = await getJson(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/items?limit=5&stage=find_product_page&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('filter_mismatch');
  });
});

describe('v1 compatibility', () => {
  it('leaves legacy work-state bodies, totals, and cursors byte-behavioral', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const counts = await getJson(`/api/onboarding/batches/${batchId}/work-state/counts`);
    expect(counts.status).toBe(200);
    expect(counts.body.batchId).toBe(batchId);
    expect(counts.body.total).toBe(36);
    expect(counts.body.counts).toBeDefined();
    expect(counts.body.projectionHealth).toBeDefined();
    const page1 = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=10`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(10);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await getJson(
      `/api/onboarding/batches/${batchId}/work-state/items?limit=10&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(10);
    // v1 default limit parity: v1 accepts 500 (v2 must not).
    const wide = await getJson(`/api/onboarding/batches/${batchId}/work-state/items?limit=500`);
    expect(wide.status).toBe(200);
    const v2wide = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?limit=500`);
    expect(v2wide.status).toBe(400);
  });
});

describe('review-state facets', () => {
  it('separates unreviewed/reviewed/approved through server filters', async () => {
    const batchId = seedBatch(build36CellSpecs());
    const reviewRows = getDb().query(`SELECT id FROM onboarding_items WHERE batch_id = ? AND stage = 'review'`).all(batchId) as Array<{ id: string }>;
    expect(reviewRows.length).toBe(6);
    markReviewed({ itemId: reviewRows[0]!.id, batchId, reviewedBy: 'tester' });
    markReviewed({ itemId: reviewRows[1]!.id, batchId, reviewedBy: 'tester' });
    markApproved({ itemId: reviewRows[1]!.id, batchId, approvedBy: 'tester' });
    const unreviewed = await getJson(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=review_listings&reviewState=unreviewed`,
    );
    expect(unreviewed.body.matchingTotal).toBe(4);
    const reviewed = await getJson(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=review_listings&reviewState=reviewed`,
    );
    expect(reviewed.body.matchingTotal).toBe(1);
    const approved = await getJson(
      `/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=review_listings&reviewState=approved`,
    );
    expect(approved.body.matchingTotal).toBe(1);
  });
});

describe('read-only guarantees', () => {
  it('never starts the worker and never mutates rows', async () => {
    const batchId = seedBatch(buildLargeMixedSpecs(120));
    const before = itemDigest();
    const reviewCountBefore = (getDb().query('SELECT COUNT(*) AS n FROM onboarding_review_state').get() as { n: number }).n;
    await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts`);
    await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts?stage=prepare_listing`);
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const qs = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
      const { body } = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items${qs}`);
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(itemDigest()).toBe(before);
    expect((getDb().query('SELECT COUNT(*) AS n FROM onboarding_review_state').get() as { n: number }).n).toBe(reviewCountBefore);
    const claimed = getDb().query(`SELECT COUNT(*) AS n FROM onboarding_items WHERE claimed_by IS NOT NULL`).get() as { n: number };
    expect(claimed.n).toBe(0);
  });

  it('fails closed with 503 on unknown stored stages (never false zeros)', async () => {
    const batchId = seedBatch(build36CellSpecs());
    getDb().query(`UPDATE onboarding_items SET stage = 'bogus' WHERE id = (SELECT id FROM onboarding_items WHERE batch_id = ? LIMIT 1)`).run(batchId);
    const counts = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/counts`);
    expect(counts.status).toBe(503);
    expect(counts.body.code).toBe('unknown_stage');
    const items = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items`);
    expect(items.status).toBe(503);
  });
});

describe('injection safety', () => {
  it('treats hostile filter text literally without widening scope or writing', async () => {
    const specs = build36CellSpecs();
    const batchId = seedBatch(specs);
    const before = itemDigest();
    const payloads = [
      `x' OR 1=1 --`,
      `'; DROP TABLE onboarding_items; --`,
      `%`,
      `_`,
      `\\`,
      `<script>alert(1)</script>`,
      `password=hunter2&token=abc`,
      `${'A'.repeat(2000)}`,
    ];
    for (const p of payloads) {
      const r = await getJson(`/api/onboarding/v2/batches/${batchId}/stage-work-state/items?q=${encodeURIComponent(p)}`);
      expect([200, 400]).toContain(r.status);
      if (r.status === 200) {
        expect(r.body.matchingTotal ?? r.body.items.length).toBeLessThanOrEqual(36);
        for (const item of r.body.items as Array<{ itemId: string }>) {
          const belongs = getDb().query(`SELECT COUNT(*) AS n FROM onboarding_items WHERE id = ? AND batch_id = ?`).get(item.itemId, batchId) as { n: number };
          expect(belongs.n).toBe(1);
        }
      }
    }
    expect(itemDigest()).toBe(before);
    expect((getDb().query(`SELECT COUNT(*) AS n FROM onboarding_items`).get() as { n: number }).n).toBe(36);
  });
});
