/**
 * Slice 5b — native v2 API compatibility (Bun, UNCONDITIONAL).
 *
 * v1/v2 route, distribution, and rejection-message bodies plus SSE
 * vocabulary consistency after the D1 machine rename. Isolated temp DBs
 * only: no backfill is executed, no live DB is upgraded — v1 storage
 * (absent metadata) with v1 fixtures preserved as v1, plus ADDED v2
 * fixtures (direct v2-literal rows) proving dual reads.
 *
 * - GET staged: default/unversioned keys are legacy v1; opt-in
 *   `?stageVocabularyVersion=2` keys are canonical v2; mixed stored
 *   spellings group canonically; unknown version rejects invalid_version.
 * - POST reset-to-stage: strict version separation (v1 spelling by
 *   default, v2 spelling only under opt-in); Step 0 and unknown stages
 *   reject; the write encodes the observed (v1) storage version.
 * - Rejection messages speak runtime v2 vocabulary (review_listings,
 *   collect_details, route_sources); the promote guard message stays
 *   version-independent.
 * - SSE: v1 serializes canonical stages back to v1; v2 normalizes v1
 *   input to canonical; unknown stages drop on v2 and pass through
 *   untouched on v1 (non-stage payloads stay byte-identical).
 * - getStageCounts counts mixed spellings once under the v2 key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, getStageCounts } from '../../db/repositories/onboarding-item-repo';
import {
  serializeSseV1,
  serializeSseV2,
} from '../../server/onboarding-event-presentation';
import onboardingRoutes, { resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';

let workspaceId: string;
let batchId: string;
let app: Hono;

const V1_STAGES = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'];
const V2_STAGES = [
  'route_sources',
  'find_product_page',
  'collect_details',
  'prepare_listing',
  'review_listings',
  'create_drafts',
] as const;

function makeWorkspace(): void {
  workspaceId = randomUUID();
  const workspacePath = path.join(os.tmpdir(), `ws-stage-api-compat-${workspaceId.slice(0, 8)}`);
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
  const batch = createBatch({ workspaceId, name: 'Compat batch', fileName: 'test.csv', totalItems: 0 });
  batchId = batch.id;
  // v1 fixtures preserved as v1: one row per legacy stage.
  insertItems(
    batchId,
    V1_STAGES.map((stage, i) => ({
      upc: `v1-${stage}`,
      name: `V1 ${stage}`,
      rowNumber: i + 1,
      stage: stage as never,
      stageStatus: 'pending' as never,
    })),
    'route_sources',
    1,
  );
  // ADDED v2 fixtures: direct v2-literal rows (mixed storage on v1 metadata).
  const db = getDb();
  V2_STAGES.forEach((stage, i) => {
    db.query(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, stage, stage_status, row_number, sourcing_entry_policy_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'imported', ?, 'pending', ?, 1, ?, ?)`,
    ).run(
      randomUUID(),
      batchId,
      `v2-${stage}`,
      `V2 ${stage}`,
      stage,
      100 + i,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  });
  app = new Hono();
  app.route('/api', onboardingRoutes);
}

beforeEach(() => {
  makeWorkspace();
});

afterEach(() => {
  resetActiveWorkerForTest();
  closeDb();
});

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  const res = await app.request(pathname);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postJson(pathname: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

describe('staged grouping vocabulary', () => {
  it('defaults to legacy v1 keys with mixed rows grouped canonically', async () => {
    const { status, body } = await getJson(`/api/onboarding/batches/${batchId}/staged`);
    expect(status).toBe(200);
    expect(Object.keys(body.staged).sort()).toEqual([...V1_STAGES].sort());
    // One v1 row + one v2 row per semantic stage = 2 each.
    for (const stage of V1_STAGES) {
      expect(body.staged[stage].length).toBe(2);
    }
  });

  it('opts into canonical v2 keys under stageVocabularyVersion=2', async () => {
    const { status, body } = await getJson(
      `/api/onboarding/batches/${batchId}/staged?stageVocabularyVersion=2`,
    );
    expect(status).toBe(200);
    expect(Object.keys(body.staged).sort()).toEqual([...V2_STAGES].sort());
    for (const stage of V2_STAGES) {
      expect(body.staged[stage].length).toBe(2);
    }
  });

  it('rejects unknown vocabulary versions before grouping', async () => {
    const { status, body } = await getJson(
      `/api/onboarding/batches/${batchId}/staged?stageVocabularyVersion=3`,
    );
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_version');
  });
});

describe('reset-to-stage version separation', () => {
  it('accepts the legacy v1 spelling by default and encodes v1 storage', async () => {
    const [item] = insertItems(batchId, [{ upc: 'reset-v1', name: 'Reset V1', rowNumber: 900 }], 'route_sources', 1);
    const { status, body } = await postJson('/api/onboarding/items/reset-to-stage', {
      itemIds: [item.id],
      targetStage: 'review',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, reset: 1 });
    const row = getDb().query('SELECT stage, stage_status FROM onboarding_items WHERE id = ?').get(item.id) as {
      stage: string;
      stage_status: string;
    };
    expect(row.stage).toBe('review');
    expect(row.stage_status).toBe('completed');
  });

  it('rejects the v2 spelling on the default (v1) contract', async () => {
    const [item] = insertItems(batchId, [{ upc: 'reset-v2', name: 'Reset V2', rowNumber: 901 }], 'route_sources', 1);
    const { status, body } = await postJson('/api/onboarding/items/reset-to-stage', {
      itemIds: [item.id],
      targetStage: 'review_listings',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_stage');
  });

  it('accepts the canonical spelling under stageVocabularyVersion=2', async () => {
    const [item] = insertItems(batchId, [{ upc: 'reset-v2-ok', name: 'Reset V2 Ok', rowNumber: 902 }], 'route_sources', 1);
    const { status, body } = await postJson(
      '/api/onboarding/items/reset-to-stage?stageVocabularyVersion=2',
      { itemIds: [item.id], targetStage: 'review_listings' },
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, reset: 1 });
    const row = getDb().query('SELECT stage FROM onboarding_items WHERE id = ?').get(item.id) as { stage: string };
    // Storage is still v1: the canonical target encodes to the v1 spelling.
    expect(row.stage).toBe('review');
  });

  it('rejects the v1 spelling under the v2 contract', async () => {
    const [item] = insertItems(batchId, [{ upc: 'reset-v1-rej', name: 'Reset V1 Rej', rowNumber: 903 }], 'route_sources', 1);
    const { status, body } = await postJson(
      '/api/onboarding/items/reset-to-stage?stageVocabularyVersion=2',
      { itemIds: [item.id], targetStage: 'review' },
    );
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_stage');
  });

  it('rejects Step 0 and unknown stages on both contracts', async () => {
    const [item] = insertItems(batchId, [{ upc: 'reset-bad', name: 'Reset Bad', rowNumber: 904 }], 'route_sources', 1);
    for (const targetStage of ['brand-setup', 'nonsense', '']) {
      const v1 = await postJson('/api/onboarding/items/reset-to-stage', { itemIds: [item.id], targetStage });
      expect(v1.status).toBe(400);
      const v2 = await postJson('/api/onboarding/items/reset-to-stage?stageVocabularyVersion=2', {
        itemIds: [item.id],
        targetStage,
      });
      expect(v2.status).toBe(400);
    }
  });
});

describe('rejection-message vocabulary', () => {
  it('review-complete speaks runtime v2 vocabulary', async () => {
    const [item] = insertItems(
      batchId,
      [{ upc: 'rc-vocab', name: 'RC Vocab', rowNumber: 910, stage: 'find_product_page' as never, stageStatus: 'completed' as never }],
      'route_sources',
      1,
    );
    const { status, body } = await postJson('/api/onboarding/items/review-complete', { itemIds: [item.id] });
    expect(status).toBe(400);
    const text = JSON.stringify(body);
    expect(text).toContain('review_listings');
    expect(text).not.toContain('"review"');
  });

  it('promote guard message stays version-independent', async () => {
    const [item] = insertItems(
      batchId,
      [{ upc: 'promo-guard', name: 'Promo Guard', rowNumber: 911, stage: 'find_product_page' as never, stageStatus: 'completed' as never }],
      'route_sources',
      1,
    );
    const { status, body } = await postJson(`/api/onboarding/batches/${batchId}/promote`, { itemIds: [item.id] });
    expect(status).toBe(400);
    expect(body.error).toBe('All items must be in the promotion stage');
  });
});

describe('stage distribution under native enum', () => {
  it('counts mixed spellings once under the v2 key', () => {
    const counts = getStageCounts(batchId);
    expect(Object.keys(counts).sort()).toEqual([...V2_STAGES].sort());
    for (const stage of V2_STAGES) {
      expect(counts[stage]).toBe(2);
    }
  });
});

describe('SSE vocabulary consistency', () => {
  it('v1 serializes canonical stages back to the legacy spelling', () => {
    const frame = serializeSseV1({
      type: 'item:status',
      batchId,
      itemId: 'i1',
      data: { status: 'completed', stage: 'prepare_listing', stageStatus: 'completed' },
    });
    expect(frame.event).toBe('item:status');
    expect(JSON.parse(frame.data)).toEqual({
      type: 'item:status',
      batchId,
      itemId: 'i1',
      data: { status: 'completed', stage: 'curation', stageStatus: 'completed' },
    });
  });

  it('v1 leaves non-stage payloads byte-identical', () => {
    const event = { type: 'item:status', batchId, itemId: 'i2', data: { status: 'failed', error: 'x' } } as const;
    const frame = serializeSseV1(event);
    expect(frame.data).toBe(JSON.stringify(event));
  });

  it('v2 normalizes legacy input to canonical and drops unknown stages', () => {
    const ok = serializeSseV2({
      type: 'item:status',
      batchId,
      itemId: 'i3',
      data: { status: 'completed', stage: 'curation', stageStatus: 'completed' },
    });
    expect(ok).not.toBeNull();
    expect(JSON.parse(ok!.data).stage).toBe('prepare_listing');
    const native = serializeSseV2({
      type: 'item:status',
      batchId,
      itemId: 'i4',
      data: { status: 'pending', stage: 'route_sources', stageStatus: 'pending' },
    });
    expect(native).not.toBeNull();
    expect(JSON.parse(native!.data).stage).toBe('route_sources');
    const dropped = serializeSseV2({
      type: 'item:status',
      batchId,
      itemId: 'i5',
      data: { status: 'pending', stage: 'nonsense', stageStatus: 'pending' },
    });
    expect(dropped).toBeNull();
  });
});
