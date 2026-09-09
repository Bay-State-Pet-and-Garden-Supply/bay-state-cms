/**
 * Slice 5a — queued continuation (Bun-only, isolated :memory: DBs via the
 * production connection + real migrations; never a live DB).
 *
 * Drives the PRODUCTION queue functions — `claimItemsForProcessing`,
 * `requeueStaleInProgressItems`, `advanceItemsToNextStage`,
 * `resetItemsToPending`, `resetItemsToStage` — on isolated DBs under
 * v1 / migrated-v2 / mixed spellings. No local eligible-count oracle: every
 * assertion observes production side effects (claimed rows, stored spellings,
 * requeue counts). Covers stale-lease CAS recovery, held + policy-v0
 * exclusion, distributor-record rows, and cohort-member rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  claimItemsForProcessing,
  requeueStaleInProgressItems,
  advanceItemsToNextStage,
  resetItemsToPending,
  resetItemsToStage,
} from '../../db/repositories/onboarding-item-repo';
import { runStageVocabularyMigration } from '../../db/repositories/onboarding-stage-vocabulary-repo';

const WS = 'ws-queue-bridge';
const NOW = '2026-06-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';

let batchId = '';

beforeEach(() => {
  try { closeDb(); } catch { /* fresh */ }
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: WS,
    name: 'Queue Bridge WS',
    workspacePath: '/tmp/queue-bridge-ws',
    gitPath: '/tmp/queue-bridge-ws/.git',
    createdAt: NOW,
    updatedAt: NOW,
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  batchId = createBatch({ workspaceId: WS, name: 'Q', fileName: 'q.csv', totalItems: 0 }).id;
});

afterEach(() => {
  try { closeDb(); } catch { /* closed */ }
});

function seedItem(input: {
  id: string;
  stage: string;
  status?: string;
  held?: boolean;
  policy?: number;
  sourceType?: string;
  sourceUrl?: string | null;
  claimedBy?: string | null;
  claimedAt?: string | null;
  rowNumber?: number;
}): void {
  const db = getDb();
  db.query(
    `INSERT INTO onboarding_items
       (id, batch_id, upc, name, stage, stage_status, status, is_held, sourcing_entry_policy_version,
        source_type, source_url, claimed_by, claimed_at, row_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    batchId,
    `upc-${input.id}`,
    `item ${input.id}`,
    input.stage,
    input.status ?? 'pending',
    input.held ? 1 : 0,
    input.policy ?? 1,
    input.sourceType ?? 'official_page',
    input.sourceUrl ?? null,
    input.claimedBy ?? null,
    input.claimedAt ?? null,
    input.rowNumber ?? 1,
    NOW,
    NOW,
  );
}

function storedStage(id: string): string {
  const db = getDb();
  const row = db.query('SELECT stage FROM onboarding_items WHERE id = ?').get(id) as { stage: string };
  return row.stage;
}

function stageStatus(id: string): string {
  const db = getDb();
  const row = db.query('SELECT stage_status FROM onboarding_items WHERE id = ?').get(id) as { stage_status: string };
  return row.stage_status;
}

describe('queue continuation parity (production claim/advance/reset)', () => {
  it('v1 storage: production claim is eligible-only and exactly-once; v2 input spelling claims the same semantic stage', () => {
    seedItem({ id: 'd1', stage: 'discovery', rowNumber: 1 });
    seedItem({ id: 'd2', stage: 'discovery', rowNumber: 2 });
    seedItem({ id: 'held', stage: 'discovery', held: true, rowNumber: 3 });
    seedItem({ id: 'done', stage: 'discovery', status: 'completed', rowNumber: 4 });
    seedItem({ id: 's1', stage: 'sourcing', rowNumber: 5 });
    seedItem({ id: 'v0', stage: 'sourcing', policy: 0, rowNumber: 6 });
    seedItem({ id: 'fail', stage: 'extraction', status: 'failed', rowNumber: 7 });

    const first = claimItemsForProcessing('discovery', 10, WS, 'w1').map((i) => i.id).sort();
    expect(first).toEqual(['d1', 'd2']);
    // Exactly-once: a second production claim finds nothing (rows now in_progress).
    expect(claimItemsForProcessing('discovery', 10, WS, 'w2')).toEqual([]);
    // Same semantic stage through the v2 input spelling also finds nothing new.
    expect(claimItemsForProcessing('find_product_page', 10, WS, 'w3')).toEqual([]);
    // Sourcing claim honors policy-v0 exclusion and held exclusion.
    const claimed = claimItemsForProcessing('sourcing', 10, WS, 'w4').map((i) => i.id);
    expect(claimed).toEqual(['s1']);
    // Terminal/failed rows never requeue through the claim path.
    expect(claimItemsForProcessing('extraction', 10, WS, 'w5')).toEqual([]);
  });

  it('migrated-v2 storage (real seam): v1-spelled input still claims; advance writes the v2 spelling', () => {
    seedItem({ id: 'q1', stage: 'sourcing', rowNumber: 1 });
    seedItem({ id: 'q2', stage: 'discovery', status: 'completed', rowNumber: 2 });
    const db = getDb();
    // Establish the deferred marker-1→2 hop (the seam's explicit
    // precondition) before running the sanctioned flip.
    db.query("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const mig = runStageVocabularyMigration(db);
    expect(mig.rerunNoop).toBe(false);
    expect(storedStage('q1')).toBe('route_sources');

    // v1-spelled production input claims the migrated row (dual read).
    const claimed = claimItemsForProcessing('sourcing', 10, WS, 'w1').map((i) => i.id);
    expect(claimed).toEqual(['q1']);
    // Advance of a completed row writes the observed (v2) spelling.
    const adv = advanceItemsToNextStage(['q2']);
    expect(adv).toEqual({ advanced: 1, skipped: 0 });
    expect(storedStage('q2')).toBe('collect_details');
    expect(stageStatus('q2')).toBe('pending');
  });

  it('mixed spellings: dual read claims both; reset-to-stage encodes the observed version', () => {
    seedItem({ id: 'm1', stage: 'discovery', rowNumber: 1 });
    seedItem({ id: 'm2', stage: 'find_product_page', rowNumber: 2 });
    // Absent marker = v1 storage; mixed known literals are still dual-readable.
    const first = claimItemsForProcessing('discovery', 1, WS, 'w-mix-1').map((i) => i.id);
    expect(first).toEqual(['m1']);
    const second = claimItemsForProcessing('find_product_page', 10, WS, 'w-mix-2').map((i) => i.id);
    expect(second).toEqual(['m2']);

    // resetItemsToStage accepts a v1 target and stores the observed spelling.
    seedItem({ id: 'r1', stage: 'curation', status: 'failed', rowNumber: 3 });
    const res = resetItemsToStage(['r1'], 'curation');
    expect(res).toEqual({ reset: 1 });
    expect(storedStage('r1')).toBe('curation');
  });

  it('stale-lease CAS recovery requeues, then the queue continues; live leases are untouched', () => {
    seedItem({ id: 'stale', stage: 'extraction', status: 'in_progress', claimedBy: 'dead', claimedAt: OLD, rowNumber: 1 });
    seedItem({ id: 'live', stage: 'extraction', status: 'in_progress', claimedBy: 'w9', claimedAt: NOW, rowNumber: 2 });
    const requeued = requeueStaleInProgressItems(WS, '2026-01-01T00:00:00.000Z');
    expect(requeued).toBe(1);
    expect(stageStatus('stale')).toBe('pending');
    expect(stageStatus('live')).toBe('in_progress');
    // The recovered row continues through the production claim exactly once.
    expect(claimItemsForProcessing('extraction', 10, WS, 'w1').map((i) => i.id)).toEqual(['stale']);
    expect(claimItemsToBeEmpty('extraction')).toBe(true);
  });

  it('distributor-record and cohort-member rows continue the queue profile-free', () => {
    seedItem({
      id: 'dist1', stage: 'extraction', sourceType: 'distributor_record', sourceUrl: null, rowNumber: 1,
    });
    seedItem({ id: 'coh1', stage: 'curation', rowNumber: 2 });
    const db = getDb();
    const now = NOW;
    db.query(
      `INSERT INTO curation_cohorts
         (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('coh-ready', WS, batchId, 'g1', 'Group 1', 'product-family-v1', 'h1', 'ready', now, now);
    db.query(
      `INSERT INTO curation_cohort_members
         (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem, ordinal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('coh-ready', 'coh1', 'upc-coh1', 'brand', 'stem', 0, now);

    // Distributor-record row: null URL, no profile — still claimable extraction work.
    // NOTE: distinct worker per production claim — the claim read-back
    // identifies rows by (claimed_by, claimed_at), so reusing a worker ID
    // within the same millisecond would over-match.
    const distClaimed = claimItemsForProcessing('collect_details', 10, WS, 'w-dist');
    expect(distClaimed.map((i) => i.id)).toEqual(['dist1']);
    expect(distClaimed[0].sourceType).toBe('distributor_record');
    // Cohort-member row: ordinary queue continuation in its current stage.
    const cohClaimed = claimItemsForProcessing('curation', 10, WS, 'w-coh').map((i) => i.id);
    expect(cohClaimed).toEqual(['coh1']);
    const member = db.query('SELECT cohort_id FROM curation_cohort_members WHERE onboarding_item_id = ?').get('coh1') as {
      cohort_id: string;
    };
    expect(member.cohort_id).toBe('coh-ready');
  });

  it('reset-to-pending requeues in_progress rows under both spellings', () => {
    seedItem({ id: 'p1', stage: 'review_listings', status: 'in_progress', rowNumber: 1 });
    resetItemsToPending(['p1']);
    expect(stageStatus('p1')).toBe('pending');
    // v1 input spelling claims the v2-spelled row (dual read).
    expect(claimItemsForProcessing('review', 10, WS, 'w1').map((i) => i.id)).toEqual(['p1']);
  });
});

function claimItemsToBeEmpty(stage: 'extraction'): boolean {
  return claimItemsForProcessing(stage, 10, WS, 'w2').length === 0;
}
