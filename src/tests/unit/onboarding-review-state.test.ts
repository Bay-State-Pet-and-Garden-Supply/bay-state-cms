/**
 * Epic #46 Phases 7/8 — durable review/approval state, bulk approval
 * validation, and domain-level extraction release.
 *
 * Covers: durable review write + re-review supersession, consequential-edit
 * invalidation (projection returns unreviewed), approval guards (unreviewed /
 * invalidated / already-approved rejected), mixed-request per-item outcomes,
 * approval does NOT export, and domain release re-queues only the blocked
 * extraction items on the released domain.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  updateItemStageStatus,
  findItemById,
  advanceReviewedItemsToPromotion,
  listItemsByBatch,
} from '../../db/repositories/onboarding-item-repo';
import {
  markReviewed,
  markApproved,
  markReviewInvalidated,
  getReviewState,
  listReviewStates,
  approveAndAdvanceItems,
} from '../../db/repositories/onboarding-review-repo';
import { computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import {
  deriveItemWorkState,
  buildBatchWorkStateContext,
} from '../../onboarding/onboarding-work-state';
import { releaseDomainExtractionItems } from '../../onboarding/domain-release';
import onboardingWorkRoutes, { setWorkerPollTriggerForTest } from '../../server/routes/onboarding-work-routes';
import { getWorker, resetActiveWorkerForTest } from '../../server/routes/onboarding-routes';
import { onboardingEvents } from '../../onboarding/sse-emitter';

let workspaceId: string;
let workspacePath: string;

function createItem(
  batchId: string,
  overrides: {
    upc: string;
    name: string;
    stage: string;
    stageStatus: string;
    sourceUrl?: string | null;
    sourceType?: 'official_page' | 'distributor_record';
    errorMessage?: string | null;
    curationDataJson?: string | null;
  },
): string {
  const inserted = insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name,
    sourceUrl: overrides.sourceUrl ?? null,
    rowNumber: 1,
    stage: overrides.stage as any,
    stageStatus: overrides.stageStatus as any,
  }], overrides.stage as any, 1);
  const id = inserted[0].id;
  const db = getDb();
  if (overrides.sourceType === 'distributor_record') {
    db.query("UPDATE onboarding_items SET source_type = 'distributor_record', source_url = NULL WHERE id = ?").run(id);
  }
  if (overrides.errorMessage) {
    db.query('UPDATE onboarding_items SET error_message = ? WHERE id = ?').run(overrides.errorMessage, id);
  }
  if (overrides.curationDataJson) {
    db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(overrides.curationDataJson, id);
  }
  return id;
}

function derive(batchId: string, itemId: string) {
  const items = listItemsByBatch(batchId);
  const ctx = buildBatchWorkStateContext(batchId, items);
  const item = items.find(i => i.id === itemId)!;
  return deriveItemWorkState(item, ctx);
}

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingWorkRoutes);
  return app;
}

function makeBatch(name = 'Approval Batch'): string {
  const batch = createBatch({
    workspaceId,
    name,
    fileName: 'test.csv',
    totalItems: 0,
  });
  return batch.id;
}

beforeAll(() => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-reviewstate-${workspaceId.slice(0, 8)}`);
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
  // Never start the real background worker during unit tests: a real poll
  // would claim released extraction items and hit the extraction worker.
  setWorkerPollTriggerForTest(null);
});

describe('durable review state (epic #46 Phase 1/7)', () => {
  it('markReviewed persists reviewed_at and supersedes a prior approval on re-review', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R1', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });
    let state = getReviewState(id)!;
    expect(state.reviewedAt).not.toBeNull();
    expect(state.approvedAt).not.toBeNull();

    // Re-review supersedes the approval
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator2' });
    state = getReviewState(id)!;
    expect(state.reviewedBy).toBe('operator2');
    expect(state.approvedAt).toBeNull();
    expect(state.reviewInvalidatedAt).toBeNull();
  });

  it('listReviewStates returns the batch map keyed by item id', () => {
    const batchId = makeBatch();
    const a = createItem(batchId, { upc: 'L1', name: 'X', stage: 'review', stageStatus: 'completed' });
    const b = createItem(batchId, { upc: 'L2', name: 'Y', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: a, batchId, reviewedBy: 'operator' });
    markReviewed({ itemId: b, batchId, reviewedBy: 'operator' });
    const map = listReviewStates(batchId);
    expect(map.size).toBe(2);
    expect(map.get(a)?.reviewedAt).not.toBeNull();
    expect(map.get(b)?.reviewedAt).not.toBeNull();
  });

  it('consequential-edit invalidation clears approval and the projection shows unreviewed', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R2', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });
    expect(derive(batchId, id).reviewState).toBe('approved');

    const invalidated = markReviewInvalidated(id, 'consequential_edit');
    expect(invalidated).toBe(true);
    const state = getReviewState(id)!;
    expect(state.reviewInvalidatedAt).not.toBeNull();
    expect(state.approvedAt).toBeNull();

    const projected = derive(batchId, id);
    expect(projected.reviewState).toBe('unreviewed');
    expect(projected.category).toBe('ready_for_review');
  });

  it('invalidating an unreviewed item is a no-op', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R3', name: 'X', stage: 'review', stageStatus: 'pending' });
    expect(markReviewInvalidated(id, 'consequential_edit')).toBe(false);
  });
});

describe('bulk approval route (epic #46 Phase 7)', () => {
  it('unreviewed items are rejected by server validation', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'A1', name: 'X', stage: 'review', stageStatus: 'completed' });
    // No durable review → rejected
    const app = makeApp();
    const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvedCount).toBe(0);
    expect(body.rejectedCount).toBe(1);
    expect(body.rejected[0].reason).toBe('not_reviewed');
    // Item not advanced
    expect(findItemById(id)!.stage).toBe('review');
  });

  it('reviewed items approve, advance to promotion, and do NOT export', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'A2', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const app = makeApp();
    const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id], reviewerId: 'store-manager' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvedCount).toBe(1);
    expect(body.results[0].status).toBe('approved');
    expect(body.audited).toBe(true);

    // Advanced to promotion/pending (approved, NOT exported)
    const item = findItemById(id)!;
    expect(item.stage).toBe('promotion');
    expect(item.stageStatus).toBe('pending');
    // Server-derived principal beats client reviewerId; without token principal is system
    expect(getReviewState(id)!.approvedBy).toBe('system');

    const projected = derive(batchId, id);
    expect(projected.category).toBe('approved');
    expect(projected.reviewState).toBe('approved');
  });

  it('invalidated review is rejected', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'A3', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markReviewInvalidated(id, 'consequential_edit');

    const app = makeApp();
    const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    const body = await res.json();
    expect(body.approvedCount).toBe(0);
    expect(body.rejected[0].reason).toBe('review_invalidated');
  });

  it('already-approved item is rejected (no double approval)', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'A4', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });

    const app = makeApp();
    const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    const body = await res.json();
    expect(body.approvedCount).toBe(0);
    expect(body.rejected[0].reason).toBe('already_approved');
  });

  it('mixed valid/invalid request returns structured per-item outcomes', async () => {
    const batchId = makeBatch();
    const ok = createItem(batchId, { upc: 'A5', name: 'X', stage: 'review', stageStatus: 'completed' });
    const unreviewed = createItem(batchId, { upc: 'A6', name: 'Y', stage: 'review', stageStatus: 'completed' });
    const wrongStage = createItem(batchId, { upc: 'A7', name: 'Z', stage: 'curation', stageStatus: 'completed' });
    markReviewed({ itemId: ok, batchId, reviewedBy: 'operator' });

    const app = makeApp();
    const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [ok, unreviewed, wrongStage] }),
    });
    const body = await res.json();
    expect(body.approvedCount).toBe(1);
    expect(body.rejectedCount).toBe(2);
    const byId = new Map(body.results.map((r: any) => [r.itemId, r.status]));
    expect(byId.get(ok)).toBe('approved');
    expect(byId.get(unreviewed)).toBe('rejected');
    expect(byId.get(wrongStage)).toBe('rejected');
    const reasons = new Map(body.rejected.map((r: any) => [r.itemId, r.reason]));
    expect(reasons.get(unreviewed)).toBe('not_reviewed');
    expect(reasons.get(wrongStage)).toMatch(/not_eligible/);
  });

  it('semantic-blocked reviewed members are refused by the advance guard', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, {
      upc: 'A8', name: 'X', stage: 'review', stageStatus: 'completed',
      curationDataJson: JSON.stringify({ semanticValidation: { status: 'blocked', findings: [{ code: 'family_product_type', memberSku: 'A8', message: 'Family type conflict' }] } }),
    });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    const { advanced, refused } = advanceReviewedItemsToPromotion([id]);
    expect(advanced).toHaveLength(0);
    expect(refused[0].reason).toContain('semantic_validation_blocked');
    expect(findItemById(id)!.stage).toBe('review');
  });

  it('advance guard refuses items not in review/completed', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'A9', name: 'X', stage: 'extraction', stageStatus: 'completed' });
    const { advanced, refused } = advanceReviewedItemsToPromotion([id]);
    expect(advanced).toHaveLength(0);
    expect(refused[0].reason).toMatch(/not_eligible/);
  });
});

describe('domain-level extraction release (epic #46 Phase 4/8)', () => {
  it('releases only blocked official-page extraction items on the released domain', async () => {
    const batchId = makeBatch();
    // blocked on example.com
    const blocked1 = createItem(batchId, {
      upc: 'D1', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://www.example.com/products/1',
      errorMessage: 'No extractor profile for example.com — profile required',
    });
    // needs_input on example.com
    const blocked2 = createItem(batchId, {
      upc: 'D2', name: 'Y', stage: 'extraction', stageStatus: 'needs_input',
      sourceUrl: 'https://example.com/products/2',
    });
    // different domain — must NOT be released
    const otherDomain = createItem(batchId, {
      upc: 'D3', name: 'Z', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://other.com/products/3',
      errorMessage: 'No extractor profile for other.com — profile required',
    });
    // already pending on example.com — not "blocked", should count as skipped
    createItem(batchId, {
      upc: 'D4', name: 'W', stage: 'extraction', stageStatus: 'pending',
      sourceUrl: 'https://example.com/products/4',
    });

    // Seed a usable profile for example.com AFTER the failures (recency is no
    // longer required — availability alone releases; the comment documents the
    // relaxed semantics).
    const profileUpdatedAt = new Date(Date.now() + 60_000).toISOString();
    getDb().query(
      `INSERT INTO extractor_profiles (id, domain, title_selector, created_at, updated_at)
       VALUES (?, ?, 'h1', ?, ?)`,
    ).run(randomUUID(), 'example.com', profileUpdatedAt, profileUpdatedAt);

    const app = makeApp();
    const res = await app.request('/api/onboarding/domains/example.com/release', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.releasedItemIds).toContain(blocked1);
    expect(body.releasedItemIds).toContain(blocked2);
    expect(body.releasedItemIds).not.toContain(otherDomain);
    // Canonical primitive: no transition failures → 0 skipped. The already-
    // pending item (D4) is not a blocked extraction item at all.
    expect(body.skippedCount).toBe(0);

    // Released items are re-queued to pending
    expect(findItemById(blocked1)!.stageStatus).toBe('pending');
    expect(findItemById(blocked2)!.stageStatus).toBe('pending');
    // Different-domain item untouched
    expect(findItemById(otherDomain)!.stageStatus).toBe('failed');
  });

  it('fails closed when no extractor profile exists for the domain', async () => {
    const batchId = makeBatch();
    const noProfileItem = createItem(batchId, {
      upc: 'D5', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://noprofile.com/products/5',
      errorMessage: 'No extractor profile for noprofile.com — profile required',
    });
    const app = makeApp();
    const res = await app.request('/api/onboarding/domains/noprofile.com/release', { method: 'POST' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('No usable extractor profile');
    expect(findItemById(noProfileItem)!.stageStatus).toBe('failed');
  });

  it('canonical release never releases distributor-source items', () => {
    const batchId = makeBatch();
    const official = createItem(batchId, {
      upc: 'D6', name: 'X', stage: 'extraction', stageStatus: 'failed',
      sourceUrl: 'https://canonical.example.com/products/6',
      errorMessage: 'No extractor profile for canonical.example.com — profile required',
    });
    const distributor = createItem(batchId, {
      upc: 'D7', name: 'Y', stage: 'extraction', stageStatus: 'failed',
      sourceType: 'distributor_record',
    });
    // Profile exists — availability alone releases (no recency guard).
    const profileUpdatedAt = new Date(Date.now() + 60_000).toISOString();
    getDb().query(
      `INSERT INTO extractor_profiles (id, domain, title_selector, created_at, updated_at)
       VALUES (?, ?, 'h1', ?, ?)`,
    ).run(randomUUID(), 'canonical.example.com', profileUpdatedAt, profileUpdatedAt);

    const result = releaseDomainExtractionItems(workspaceId, 'canonical.example.com', { releaseAllBlocked: true });
    expect(result.profileAvailable).toBe(true);
    // The distributor item is never released; the official item is.
    expect(result.releasedIds).not.toContain(distributor);
    expect(result.releasedIds).toContain(official);
    expect(findItemById(distributor)!.stageStatus).toBe('failed');
  });
});

describe('approval is durable and never implies export', () => {
  it('approved item stays reviewState approved and category approved until drafts/export', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'E1', name: 'X', stage: 'review', stageStatus: 'completed', curationDataJson: JSON.stringify({ suggestedPages: ['Some Category Page'] }) });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });
    // The approval path advances review → promotion automatically.
    const { advanced } = advanceReviewedItemsToPromotion([id]);
    expect(advanced).toHaveLength(1);
    expect(findItemById(id)!.stage).toBe('promotion');
    updateItemStageStatus(id, 'completed');
    // promotion/completed without a change set → ready_to_export, never exported
    const projected = derive(batchId, id);
    expect(projected.category).toBe('ready_to_export');
    expect(projected.reviewState).toBe('approved');
    expect(projected.category).not.toBe('completed');
  });

  it('bulk approval emits an SSE item:status event per approved item', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'E2', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const events: Array<{ itemId?: string; status?: string; data: Record<string, unknown> }> = [];
    const unsubscribe = onboardingEvents.subscribe(batchId, event => {
      if (event.itemId === id) {
        events.push({ itemId: event.itemId, status: event.data.status as string, data: event.data });
      }
    });
    try {
      const app = makeApp();
      const res = await app.request(`/api/onboarding/batches/${batchId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [id], reviewerId: 'store-manager' }),
      });
      expect(res.status).toBe(200);
    } finally {
      unsubscribe();
    }

    const approveEvent = events.find(e => e.status === 'approved');
    expect(approveEvent).toBeDefined();
    expect(approveEvent!.data.stage).toBe('create_drafts');
    expect(approveEvent!.data.approvalOrigin).toBe('bulk');
  });

  it('promotion-stage item WITHOUT durable approval projects as ready_for_review, never approved', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'E3', name: 'X', stage: 'promotion', stageStatus: 'pending' });

    const projected = derive(batchId, id);

    expect(projected.category).toBe('ready_for_review');
    expect(projected.reviewState).not.toBe('approved');
    expect(projected.label).toMatch(/Ready for review/);
  });

  it('promotion-stage item with durable REVIEW but no approval projects as reviewed-pending-approval', () => {
    const batchId = makeBatch();
    // Legacy diagnostics advance: review/completed → promotion without ever
    // passing bulk approval. Durable review EXISTS, approval does not.
    const id = createItem(batchId, { upc: 'E4', name: 'X', stage: 'promotion', stageStatus: 'pending' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const projected = derive(batchId, id);

    expect(projected.category).toBe('ready_for_review');
    expect(projected.reviewState).toBe('reviewed');
    expect(projected.label).toMatch(/pending approval/);
  });
});

describe('epic #46 review remediation — fix 1: approval + advance are atomic', () => {
  it('concurrent invalidation (full edit path) → route rejects BEFORE any advance', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R1', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    // The concurrent consequential edit: review invalidated AND the item moved
    // back to review/pending (the real invalidation path).
    markReviewInvalidated(id, 'consequential_edit');
    updateItemStageStatus(id, 'pending');

    const res = await makeApp().request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    const body = await res.json();
    expect(body.approvedCount).toBe(0);
    expect(body.rejected[0].reason).toMatch(/^not_eligible:review\/pending/);

    // The item is NOT in promotion and NO approval was written.
    const item = findItemById(id)!;
    expect(item.stage).toBe('review');
    expect(item.stageStatus).toBe('pending');
    expect(getReviewState(id)!.approvedAt).toBeNull();
  });

  it('approveAndAdvanceItems re-validates INSIDE its transaction — a review invalidated after validation is refused (race window)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R1b', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    // The route's phase-1 validation already PASSED (review/completed +
    // reviewed), then the concurrent edit invalidates the durable review
    // BEFORE the atomic write. Stage is still review/completed (the narrowest
    // race window) — the primitive must re-validate and refuse.
    markReviewInvalidated(id, 'consequential_edit');

    const { approved, rejected } = approveAndAdvanceItems({ itemIds: [id], batchId, approvedBy: 'manager', requestHash: computeRequestHash([id]) });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe('review_invalidated');
    expect(findItemById(id)!.stage).toBe('review');
    expect(getReviewState(id)!.approvedAt).toBeNull();
  });

  it('approveAndAdvanceItems refuses an item that left review/completed (no partial state)', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R2', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    // State moved before the call (e.g. worker advanced it): review/completed
    // is gone.
    updateItemStageStatus(id, 'completed'); // still review
    getDb().run("UPDATE onboarding_items SET stage = 'curation' WHERE id = ?", [id]);

    const { approved, rejected } = approveAndAdvanceItems({ itemIds: [id], batchId, approvedBy: 'manager', requestHash: computeRequestHash([id]) });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/^not_eligible:/);
    // No approval leaked onto a non-promotion item.
    expect(getReviewState(id)!.approvedAt).toBeNull();
    expect(findItemById(id)!.stage).toBe('curation');
  });

  it('already-approved item is rejected atomically and its stage is untouched', async () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R3', name: 'X', stage: 'review', stageStatus: 'completed' });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });
    markApproved({ itemId: id, batchId, approvedBy: 'manager' });

    const res = await makeApp().request(`/api/onboarding/batches/${batchId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [id] }),
    });
    const body = await res.json();
    expect(body.approvedCount).toBe(0);
    expect(body.rejected[0].reason).toBe('already_approved');
    expect(findItemById(id)!.stage).toBe('review');
  });

  it('semantic-blocked reviewed member is refused by the atomic approve+advance', () => {
    const batchId = makeBatch();
    const id = createItem(batchId, { upc: 'R4', name: 'X', stage: 'review', stageStatus: 'completed', curationDataJson: JSON.stringify({
      curatedTitle: 'X',
      semanticValidation: { status: 'blocked', findings: [{ code: 'family_product_type', memberSku: 'SKU', message: 'Family members disagree on product type.' }] },
    }) });
    markReviewed({ itemId: id, batchId, reviewedBy: 'operator' });

    const { approved, rejected } = approveAndAdvanceItems({ itemIds: [id], batchId, approvedBy: 'manager', requestHash: computeRequestHash([id]) });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/^semantic_validation_blocked/);
    expect(findItemById(id)!.stage).toBe('review');
    expect(getReviewState(id)!.approvedAt).toBeNull();
  });
});

describe('epic #46 review remediation — fix 7: worker singleton is workspace-keyed', () => {
  it('reuses the worker for the same workspace and replaces it on a workspace switch', () => {
    const wsB = randomUUID();
    const wsBPath = path.join(os.tmpdir(), `baystate-wsb-${wsB.slice(0, 8)}`);
    fs.mkdirSync(path.join(wsBPath, '.baystate-cms'), { recursive: true });
    const wsBRow = getDb().query(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at)
       VALUES (?, 'ws-b', ?, '', ?, ?)`,
    ).run(wsB, wsBPath, new Date().toISOString(), new Date().toISOString());
    expect(wsBRow.changes).toBe(1);

    try {
      const workerA1 = getWorker(workspaceId, workspacePath);
      const workerA2 = getWorker(workspaceId, workspacePath);
      expect(workerA1).toBe(workerA2); // same workspace → same instance

      const workerB = getWorker(wsB, wsBPath);
      expect(workerB).not.toBe(workerA1); // workspace switch → NEW worker

      const workerA3 = getWorker(workspaceId, workspacePath);
      expect(workerA3).not.toBe(workerB); // switching back creates another
    } finally {
      resetActiveWorkerForTest();
    }
  });
});
