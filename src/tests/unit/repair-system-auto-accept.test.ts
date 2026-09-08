import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runRepair } from '../../../scripts/repair-system-auto-accept';
import { markReviewed } from '../../db/repositories/onboarding-review-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';

describe('repair-system-auto-accept script (Plan Section 6)', () => {
  const tmpDir = `/tmp/test-repair-${randomUUID()}`;
  const dbPath = path.join(tmpDir, 'test-app.db');
  const backupDir = path.join(tmpDir, 'backups');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    initDb(dbPath);
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dry-run identifies historical auto-accept decisions without mutating', async () => {
    const db = getDb();
    const runId = randomUUID();
    const itemId = randomUUID();
    const batchId = randomUUID();
    const wsId = 'ws-test';

    // Seed workspace, batch & item
    insertWorkspace({
      id: wsId,
      name: 'Test WS',
      workspacePath: '/tmp/test',
      gitPath: '/tmp/test/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
       VALUES (?, ?, 'Batch 1', 'test.csv', datetime('now'), datetime('now'))`,
      [batchId, wsId],
    );
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, '123456789012', 'Test Product', 'review', 'ready', datetime('now'), datetime('now'))`,
      [itemId, batchId],
    );

    // Seed run
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, '123456789012', 'completed', datetime('now'), datetime('now'))`,
      [runId, wsId, itemId],
    );

    // Seed primary_product_type proposal + system_auto_accept decision
    const ptProposalId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, confidence, status, created_at)
       VALUES (?, ?, '123456789012', 'primary_product_type', 'dog_food', 0.9, 'accepted', datetime('now'))`,
      [ptProposalId, runId],
    );
    const ptDecId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_id, decision_origin, created_at)
       VALUES (?, ?, 'accepted', 'system_auto_accept', 'system_auto_accept', datetime('now'))`,
      [ptDecId, ptProposalId],
    );

    // Seed dependent proposal (category_page)
    const catProposalId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, confidence, status, created_at)
       VALUES (?, ?, '123456789012', 'category_page', 'page-1', 0.85, 'accepted', datetime('now'))`,
      [catProposalId, runId],
    );
    const catDecId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_id, created_at)
       VALUES (?, ?, 'accepted', 'operator-1', datetime('now'))`,
      [catDecId, catProposalId],
    );

    // Durable review state
    markReviewed({ itemId, batchId, reviewedBy: 'operator-1' });

    // Run dry run
    const metrics = await runRepair({ dbPath, apply: false, backupDir });

    expect(metrics.itemsExamined).toBe(1);
    expect(metrics.proposalsSuperseded).toBe(1);
    expect(metrics.dependentProposalsStaled).toBe(1);
    expect(metrics.reviewStateRowsInvalidated).toBe(0);

    // Verify no mutation occurred in dry-run
    const decAfter = db.query('SELECT superseded_at FROM classification_proposal_decisions WHERE id = ?').get(ptDecId) as any;
    expect(decAfter.superseded_at).toBeNull();

    const ptPropAfter = db.query('SELECT status FROM classification_proposals WHERE id = ?').get(ptProposalId) as any;
    expect(ptPropAfter.status).toBe('accepted');

    const catPropAfter = db.query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get(catProposalId) as any;
    expect(catPropAfter.status).toBe('accepted');
    expect(catPropAfter.is_stale).toBe(0);
  });

  it('apply mode creates verified backup, supersedes decisions, stales dependents, and invalidates review state', async () => {
    const db = getDb();
    const runId = randomUUID();
    const itemId = randomUUID();
    const batchId = randomUUID();
    const wsId = 'ws-test';

    insertWorkspace({
      id: wsId,
      name: 'Test WS',
      workspacePath: '/tmp/test',
      gitPath: '/tmp/test/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
       VALUES (?, ?, 'Batch 1', 'test.csv', datetime('now'), datetime('now'))`,
      [batchId, wsId],
    );
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, '123456789012', 'Test Product', 'review', 'ready', datetime('now'), datetime('now'))`,
      [itemId, batchId],
    );
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, '123456789012', 'completed', datetime('now'), datetime('now'))`,
      [runId, wsId, itemId],
    );

    const ptProposalId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, confidence, status, created_at)
       VALUES (?, ?, '123456789012', 'primary_product_type', 'dog_food', 0.9, 'accepted', datetime('now'))`,
      [ptProposalId, runId],
    );
    const ptDecId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_id, decision_origin, created_at)
       VALUES (?, ?, 'accepted', 'system_auto_accept', 'system_auto_accept', datetime('now'))`,
      [ptDecId, ptProposalId],
    );

    const catProposalId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, confidence, status, created_at)
       VALUES (?, ?, '123456789012', 'category_page', 'page-1', 0.85, 'accepted', datetime('now'))`,
      [catProposalId, runId],
    );

    markReviewed({ itemId, batchId, reviewedBy: 'operator-1' });

    // Run with apply: true (writer stopped)
    const metrics = await runRepair({ dbPath, apply: true, backupDir, writerStopped: true });

    expect(metrics.itemsExamined).toBe(1);
    expect(metrics.proposalsSuperseded).toBe(1);
    expect(metrics.dependentProposalsStaled).toBe(1);
    expect(metrics.reviewStateRowsInvalidated).toBe(1);

    // Verify backup created in backupDir
    const backupFiles = fs.readdirSync(backupDir);
    expect(backupFiles.some(f => f.endsWith('.db'))).toBe(true);
    expect(backupFiles.some(f => f.endsWith('.manifest.json'))).toBe(true);

    // Verify decision superseded and proposal marked stale (never resurrected to pending)
    const decAfter = db.query('SELECT superseded_at FROM classification_proposal_decisions WHERE id = ?').get(ptDecId) as any;
    expect(decAfter.superseded_at).not.toBeNull();

    const ptPropAfter = db.query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get(ptProposalId) as any;
    expect(ptPropAfter.status).toBe('stale');

    // Verify dependent proposal staled
    const catPropAfter = db.query('SELECT status, is_stale, staleness_reason FROM classification_proposals WHERE id = ?').get(catProposalId) as any;
    expect(catPropAfter.status).toBe('stale');
    expect(catPropAfter.is_stale).toBe(1);
    expect(catPropAfter.staleness_reason).toBe('historical_auto_accept_repaired');

    // Verify review state invalidated
    const reviewRow = db.query('SELECT review_invalidated_at, review_invalidation_reason FROM onboarding_review_state WHERE item_id = ?').get(itemId) as any;
    expect(reviewRow.review_invalidated_at).not.toBeNull();
    expect(reviewRow.review_invalidation_reason).toBe('historical_auto_accept_repaired');
  });
});
