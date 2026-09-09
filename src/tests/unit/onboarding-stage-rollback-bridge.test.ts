/**
 * Slice 5a — rollback-bridge proof (Bun-only, 120s budget).
 *
 * Launches the ACTUAL EMITTED bridge artifact
 * (`$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js`) pinned by
 * `ONBOARDING_BRIDGE_MANIFEST` against a disposable migrated-then-edited v2
 * DB. Missing/checksum-mismatched input FAILS (never skips, never rebuilds
 * native code as the bridge). Parent independently re-verifies DB effects —
 * it never trusts child `ok:true` alone.
 *
 * Fixture (all on an isolated temp file, never a live DB): deterministic v1
 * history (queue rows, held + policy-v0 rows, review rows, an approval
 * receipt, an export-draft receipt, distributor + cohort rows, sourcing
 * decision JSON) → the REAL `runStageVocabularyMigration` seam (never
 * hand-written UPDATEs) → post-migration edits through the CURRENT
 * implementation (native claim, review invalidation + re-review, approval,
 * export drafts, fresh v2-encoded import). The child then proves every §5.5
 * behavior; the parent re-verifies expected row diffs, protected hashes, and
 * side-effect counts.
 */
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { freshFixtureRoot, spawnBridgeChild } from '../helpers/onboarding-stage-bridge-harness';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  claimItemsForProcessing,
  insertItems,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  markReviewed,
  markReviewInvalidated,
  approveAndAdvanceItems,
  createExportDraftsWithReceipt,
} from '../../db/repositories/onboarding-review-repo';
import { runStageVocabularyMigration } from '../../db/repositories/onboarding-stage-vocabulary-repo';

function shaFile(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const T = '2026-04-01T00:00:00.000Z';
const PAGES = JSON.stringify({ suggestedPages: [{ pageId: 'p1' }] });

function seedFixed(input: {
  id: string;
  batchId: string;
  stage: string;
  status?: string;
  held?: boolean;
  policy?: number;
  sourceType?: string;
  sourceUrl?: string | null;
  curationJson?: string | null;
  decisionJson?: string | null;
  rowNumber?: number;
}): void {
  const db = getDb();
  db.query(
    `INSERT INTO onboarding_items
       (id, batch_id, upc, name, stage, stage_status, status, is_held, sourcing_entry_policy_version,
        source_type, source_url, curation_data_json, sourcing_decision_json, row_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.batchId,
    `upc-${input.id}`,
    `item ${input.id}`,
    input.stage,
    input.status ?? 'pending',
    input.held ? 1 : 0,
    input.policy ?? 1,
    input.sourceType ?? 'official_page',
    input.sourceUrl ?? null,
    input.curationJson ?? null,
    input.decisionJson ?? null,
    input.rowNumber ?? 1,
    T,
    T,
  );
}

describe('rollback bridge artifact proof', () => {
  it('bridge artifact reads a migrated-then-edited v2 DB', async () => {
    const manifestPath = process.env['ONBOARDING_BRIDGE_MANIFEST'] ?? '';
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      throw new Error('ONBOARDING_BRIDGE_MANIFEST missing or unreadable — failing (no skip, no rebuild)');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { bridgeRoot?: string };
    const bridgeRoot = manifest.bridgeRoot ?? path.dirname(manifestPath);
    const entry = path.join(bridgeRoot, 'bun/scripts/onboarding-stage-compat-smoke.js');
    if (!fs.existsSync(entry)) throw new Error(`missing bridge entry: ${entry}`);
    const sumsPath = path.join(bridgeRoot, 'SHA256SUMS');
    if (!fs.existsSync(sumsPath)) throw new Error('missing SHA256SUMS — failing');
    const sums = fs.readFileSync(sumsPath, 'utf-8');
    const rel = 'bun/scripts/onboarding-stage-compat-smoke.js';
    const line = sums.split('\n').find((l) => l.endsWith(rel));
    if (!line || !line.startsWith(shaFile(entry))) throw new Error('bridge checksum mismatch — failing');

    // Disposable fixture (isolated temp file, never a live DB).
    const fixtureRoot = freshFixtureRoot();
    const dbPath = path.join(fixtureRoot, 'db', 'app.db');
    const workspacePath = path.join(fixtureRoot, 'workspace');
    fs.mkdirSync(path.join(fixtureRoot, 'db'), { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.ownership-sentinel'), 'bridge-fixture');
    try {
      closeDb();
    } catch { /* fresh */ }
    initDb(dbPath);
    runMigrations();
    const wsId = 'ws-bridge';
    insertWorkspace({
      id: wsId,
      name: 'Bridge WS',
      workspacePath,
      gitPath: path.join(workspacePath, '.git'),
      createdAt: T,
      updatedAt: T,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batchId = createBatch({ workspaceId: wsId, name: 'Bridge', fileName: 'b.csv', totalItems: 0 }).id;

    // Deterministic v1 history: queue rows, held + policy-v0, review target,
    // approval/export targets, distributor + cohort rows, decision JSON.
    seedFixed({ id: 'q-child', batchId, stage: 'discovery', rowNumber: 1 });
    seedFixed({ id: 'q-held', batchId, stage: 'discovery', held: true, rowNumber: 2 });
    seedFixed({ id: 'q-v0', batchId, stage: 'sourcing', policy: 0, rowNumber: 3 });
    seedFixed({ id: 'q-dist', batchId, stage: 'extraction', sourceType: 'distributor_record', sourceUrl: null, rowNumber: 4 });
    seedFixed({ id: 'q-coh', batchId, stage: 'curation', rowNumber: 5 });
    seedFixed({ id: 'q-approved', batchId, stage: 'review', status: 'completed', curationJson: PAGES, rowNumber: 6 });
    seedFixed({ id: 'q-rereview', batchId, stage: 'review', status: 'completed', curationJson: PAGES, rowNumber: 7 });
    seedFixed({
      id: 'q-hist', batchId, stage: 'sourcing', status: 'completed', rowNumber: 8,
      decisionJson: JSON.stringify({ schemaVersion: 2, route: 'evidence_to_discovery', target: 'discovery' }),
    });
    const db = getDb();
    db.query(
      `INSERT INTO curation_cohorts
         (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('coh-bridge', wsId, batchId, 'gb', 'Bridge Group', 'product-family-v1', 'hb', 'waiting', T, T);
    db.query(
      `INSERT INTO curation_cohort_members
         (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem, ordinal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('coh-bridge', 'q-coh', 'upc-q-coh', 'brand', 'stem', 0, T);

    // The REAL sanctioned seam (never hand-written UPDATEs). Deferred
    // marker-2 hop established first as the seam's explicit precondition.
    db.query("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const mig = runStageVocabularyMigration(db as never);
    expect(mig.rerunNoop).toBe(false);

    // Post-migration edits through the CURRENT (native/bridge-source)
    // implementation on v2 storage.
    const nativeClaim = claimItemsForProcessing('collect_details', 10, wsId, 'parent-native');
    expect(nativeClaim.map((i) => i.id)).toEqual(['q-dist']);
    markReviewed({ itemId: 'q-approved', batchId, reviewedBy: 'op' });
    const approval = approveAndAdvanceItems({
      itemIds: ['q-approved'],
      batchId,
      approvedBy: 'op',
      requestHash: 'b'.repeat(64),
      idempotencyKey: 'idem-approve-1',
      workspaceId: wsId,
    });
    expect(approval.approved).toEqual(['q-approved']);
    const exported = createExportDraftsWithReceipt({
      itemIds: ['q-approved'],
      batchId,
      requestedBy: 'op',
      principal: 'op',
      role: 'operator',
      idempotencyKey: 'idem-export-1',
      workspaceId: wsId,
      requestHash: 'c'.repeat(64),
    });
    expect(exported.created).toEqual(['q-approved']);
    markReviewed({ itemId: 'q-rereview', batchId, reviewedBy: 'op' });
    expect(markReviewInvalidated('q-rereview', 'bridge-edit')).toBe(true);
    markReviewed({ itemId: 'q-rereview', batchId, reviewedBy: 'op2' });
    const fresh = insertItems(batchId, [{ upc: 'upc-fresh', name: 'Fresh', rowNumber: 0 }], 'discovery', 1);
    expect(fresh).toHaveLength(1);
    const freshStage = (db.query('SELECT stage FROM onboarding_items WHERE id = ?').get(fresh[0].id) as { stage: string }).stage;
    expect(freshStage).toBe('find_product_page');
    // Parent continues the fresh row natively (lowest row_number, limit 1)
    // so the child's continuation set is exactly {q-child}.
    const nativeClaim2 = claimItemsForProcessing('discovery', 1, wsId, 'parent-native-2');
    expect(nativeClaim2.map((i) => i.id)).toEqual([fresh[0].id]);
    updateItemStageStatus(fresh[0].id, 'completed');

    // Protected-state baseline (hashes the child must not disturb).
    const protectedHash = (): string => {
      const c = getDb();
      const review = c.query('SELECT * FROM onboarding_review_state ORDER BY item_id').all();
      const receipts = c.query('SELECT * FROM onboarding_operation_receipts ORDER BY id').all();
      const audits = c.query('SELECT * FROM audit_log ORDER BY id').all();
      const decisions = c.query('SELECT id, sourcing_decision_json FROM onboarding_items ORDER BY id').all();
      const cohorts = c.query('SELECT * FROM curation_cohorts ORDER BY id').all();
      const members = c.query('SELECT * FROM curation_cohort_members ORDER BY onboarding_item_id').all();
      const drafts = c.query('SELECT * FROM change_set_items ORDER BY id').all();
      return crypto.createHash('sha256').update(JSON.stringify({ review, receipts, audits, decisions, cohorts, members, drafts })).digest('hex');
    };
    const baselineHash = protectedHash();
    const itemsBefore = db.query('SELECT id, stage, stage_status, claimed_by FROM onboarding_items ORDER BY id').all();
    closeDb();

    const bunExe = process.execPath;
    const res = await spawnBridgeChild({
      bridgeRoot,
      bunExe,
      fixtureRoot,
      dbPath,
      workspacePath,
      expectedStorageVersion: 2,
      timeoutMs: 30000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.report).not.toBeNull();
    const report = res.report as Record<string, unknown>;
    expect(report['ok']).toBe(true);
    expect(report['storageVersion']).toBe('2');
    for (const name of [
      'storage-version-match', 'no-unknown-stages', 'emitted-app-v1-health',
      'emitted-app-v1-work-state-counts', 'emitted-app-v1-auth',
      'queue-continuation-exactly-once', 'held-policy-v0-excluded',
      'receipt-replay-exact-bytes', 'receipt-replay-no-duplicate-effects',
      'distributor-record-shape', 'cohort-membership-intact', 'v2-encoding-of-new-row',
    ]) {
      expect((report['checks'] as string[])).toContain(name);
    }

    // Independent parent re-verification (never trust child ok:true alone).
    const check = new Database(dbPath, { readonly: true });
    try {
      const after = check.query('SELECT id, stage, stage_status, claimed_by FROM onboarding_items ORDER BY id').all() as Array<{
        id: string; stage: string; stage_status: string; claimed_by: string | null;
      }>;
      const before = itemsBefore as Array<{ id: string; stage: string; stage_status: string; claimed_by: string | null }>;
      // Exactly two diffs: q-child claimed by the bridge child + its new row.
      const newRows = after.filter((r) => !before.some((b) => b.id === r.id));
      expect(newRows).toHaveLength(1);
      expect(newRows[0].stage).toBe('find_product_page');
      const changed = after.filter((r) => {
        const b = before.find((x) => x.id === r.id);
        return b && JSON.stringify(b) !== JSON.stringify(r);
      });
      expect(changed.map((r) => r.id)).toEqual(['q-child']);
      const qChild = after.find((r) => r.id === 'q-child')!;
      expect(qChild.stage_status).toBe('in_progress');
      expect(qChild.claimed_by).toBe('bridge-smoke');
      // No v1 literals remain anywhere.
      const v1left = check.query(
        "SELECT COUNT(*) AS c FROM onboarding_items WHERE stage IN ('sourcing','discovery','extraction','curation','review','promotion')",
      ).get() as { c: number };
      expect(v1left.c).toBe(0);
      // Protected tables hash-stable (replay made zero writes).
      const review = check.query('SELECT * FROM onboarding_review_state ORDER BY item_id').all();
      const receipts = check.query('SELECT * FROM onboarding_operation_receipts ORDER BY id').all();
      const audits = check.query('SELECT * FROM audit_log ORDER BY id').all();
      const decisions = check.query('SELECT id, sourcing_decision_json FROM onboarding_items ORDER BY id').all();
      const cohorts = check.query('SELECT * FROM curation_cohorts ORDER BY id').all();
      const members = check.query('SELECT * FROM curation_cohort_members ORDER BY onboarding_item_id').all();
      const drafts = check.query('SELECT * FROM change_set_items ORDER BY id').all();
      // Exclude the child's newly inserted row from the decisions comparison.
      const decisionsSansChild = (decisions as Array<{ id: string }>).filter((d) => d.id !== newRows[0].id);
      const recomputed = crypto.createHash('sha256').update(JSON.stringify({
        review, receipts, audits, decisions: decisionsSansChild, cohorts, members, drafts,
      })).digest('hex');
      expect(recomputed).toBe(baselineHash);
    } finally {
      check.close();
    }
    try {
      closeDb();
    } catch { /* closed */ }
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }, 120000);
});
