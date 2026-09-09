/**
 * Repair script for historical system_auto_accept decisions (Plan Section 6).
 *
 * Usage:
 *   bun run scripts/repair-system-auto-accept.ts [--apply --i-stopped-the-writer] [--db=path] [--backup-dir=path]
 *
 * Behaviors:
 * 1. Dry-run by default (read-only: no migrations, no writes). Pass `--apply` to commit.
 * 2. `--apply` requires `--i-stopped-the-writer` plus a verified SQLite backup.
 * 3. Finds historical decisions where reviewer_id or decision_origin = 'system_auto_accept'.
 * 4. Supersedes (never deletes) live primary decisions, marks primary + mismatched
 *    dependents stale, supersedes dependent live decisions, appends history,
 *    invalidates review, returns unexported promotion items to review/pending.
 * 5. Already-exported records are listed for manual audit, never unpublished.
 * 6. Idempotent: re-running finds zero live targets and appends zero history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { initDb, getDb, closeDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { createSqliteBackup, verifySqliteBackup } from '../src/db/sqlite-backup-verifier';
import { markReviewInvalidated } from '../src/db/repositories/onboarding-review-repo';
import { randomUUID } from 'node:crypto';

interface RepairMetrics {
  itemsExamined: number;
  proposalsSuperseded: number;
  dependentProposalsStaled: number;
  reviewStateRowsInvalidated: number;
  promotionItemsReturned: number;
  exportedItemsListed: number;
}

export async function runRepair(options: {
  dbPath: string;
  apply: boolean;
  backupDir?: string;
  writerStopped?: boolean;
}): Promise<RepairMetrics> {
  const { dbPath, apply, backupDir = './backups', writerStopped = false } = options;
  const resolvedDbPath = path.resolve(dbPath);

  console.log(`[repair:auto-accept] Mode: ${apply ? 'APPLY (mutating)' : 'DRY RUN (no changes)'}`);
  console.log(`[repair:auto-accept] Target DB: ${resolvedDbPath}`);

  let db: Database;
  let owned = false;
  if (!apply) {
    // Dry-run is read-only: no initDb side-effects, no migrations.
    db = new Database(resolvedDbPath, { readonly: true });
  } else {
    if (!writerStopped) {
      throw new Error('Refusing --apply without --i-stopped-the-writer: stop the application writer first.');
    }
    initDb(dbPath);
    runMigrations();
    db = getDb();
    owned = true;
    // Fail-closed when a refresh worker holds live claims.
    try {
      const live = db.query(
        `SELECT COUNT(*) AS n FROM classification_refresh_queue WHERE status = 'claimed'`,
      ).get() as { n: number } | undefined;
      if (live && live.n > 0) {
        throw new Error(`Refusing --apply with ${live.n} claimed refresh item(s); stop the worker first.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing --apply')) throw err;
      // Missing table on fresh DBs = no live claims; continue.
    }
  }

  try {
    // Slice 5a bridge: version-known or refuse-v2 with a clear error.
    // This script's promotion predicates are v1-only until the 5b native
    // cutover; on v1/absent storage every query below is byte-identical.
    // (app_meta may be absent on fresh DBs — absent means v1.)
    let vocabValue: string | null = null;
    try {
      const vocabRow = db.query('SELECT value FROM app_meta WHERE key = ?').get(
        'onboarding_stage_vocabulary_version',
      ) as { value: string } | undefined;
      vocabValue = vocabRow?.value ?? null;
    } catch { vocabValue = null; }
    if (vocabValue !== null && vocabValue !== '1') {
      throw new Error(
        `[repair:auto-accept] Refusing: onboarding_stage_vocabulary_version=${vocabValue} ` +
          `(v1-only script until the 5b native cutover — refusing instead of misreading stages)`,
      );
    }
    // Find all active primary_product_type decisions authored by system_auto_accept
    const targetDecisions = db.query(
      `SELECT d.id AS decision_id, d.proposal_id, p.run_id, p.product_sku,
              r.onboarding_item_id, r.workspace_id
       FROM classification_proposal_decisions d
       JOIN classification_proposals p ON p.id = d.proposal_id
       JOIN classification_runs r ON r.id = p.run_id
       WHERE (d.reviewer_id = 'system_auto_accept' OR d.decision_origin = 'system_auto_accept')
         AND p.proposal_type = 'primary_product_type'
         AND d.superseded_at IS NULL
         AND p.superseded_at IS NULL`,
    ).all() as Array<{
      decision_id: string;
      proposal_id: string;
      run_id: string;
      product_sku: string;
      onboarding_item_id: string | null;
      workspace_id: string;
    }>;

    const runIds = [...new Set(targetDecisions.map(d => d.run_id))];
    const itemIds = [...new Set(targetDecisions.map(d => d.onboarding_item_id).filter((id): id is string => Boolean(id)))];

    const dependentProposals = runIds.length > 0
      ? (db.query(
          `SELECT p.id, p.run_id, p.proposal_type, p.target_id
           FROM classification_proposals p
           WHERE p.run_id IN (${runIds.map(() => '?').join(', ')})
             AND p.proposal_type IN ('category_page', 'field_assignment')
             AND p.superseded_at IS NULL
             AND p.status != 'stale'`,
        ).all(...runIds) as Array<{ id: string; run_id: string; proposal_type: string; target_id: string | null }>)
      : [];

    // Promotion + export audit surfaces.
    let promotionItems: Array<{ id: string; stage: string }> = [];
    let exportedItems: Array<{ id: string }> = [];
    let activeReviews = 0;
    try {
      if (itemIds.length > 0) {
        const ph = itemIds.map(() => '?').join(', ');
        promotionItems = db.query(
          `SELECT id, stage FROM onboarding_items WHERE id IN (${ph}) AND stage = 'promotion'`,
        ).all(...itemIds) as Array<{ id: string; stage: string }>;
        try {
          exportedItems = db.query(
            `SELECT id FROM onboarding_items WHERE id IN (${ph}) AND (stage = 'promoted' OR stage = 'exported')`,
          ).all(...itemIds) as Array<{ id: string }>;
        } catch { exportedItems = []; }
        try {
          const r = db.query(
            `SELECT COUNT(*) AS n FROM onboarding_review_state WHERE onboarding_item_id IN (${ph}) AND status = 'approved'`,
          ).get(...itemIds) as { n: number } | undefined;
          activeReviews = r?.n ?? 0;
        } catch { activeReviews = 0; }
      }
    } catch { promotionItems = []; exportedItems = []; }

    const metrics: RepairMetrics = {
      itemsExamined: itemIds.length,
      proposalsSuperseded: targetDecisions.length,
      dependentProposalsStaled: dependentProposals.length,
      reviewStateRowsInvalidated: 0,
      promotionItemsReturned: promotionItems.length,
      exportedItemsListed: exportedItems.length,
    };

    console.log('\n--- REPAIR SUMMARY ---');
    console.log(`Items examined:                      ${metrics.itemsExamined}`);
    console.log(`Primary type decisions to supersede: ${metrics.proposalsSuperseded}`);
    console.log(`Dependent proposals to stale:        ${metrics.dependentProposalsStaled}`);
    console.log(`Active approvals:                    ${activeReviews}`);
    console.log(`Promotion items to return to review: ${metrics.promotionItemsReturned}`);
    console.log(`Already-exported (manual audit):     ${exportedItems.map(e => e.id).join(', ') || '<none>'}`);

    if (!apply) {
      console.log('\nRun with --apply --i-stopped-the-writer to perform backup and apply repair.');
      return metrics;
    }

    // APPLY MODE: 1. Backup & Verification
    const resolvedBackupDir = path.resolve(backupDir);
    if (!fs.existsSync(resolvedBackupDir)) {
      fs.mkdirSync(resolvedBackupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(resolvedBackupDir, `backup-pre-auto-accept-repair-${timestamp}.db`);

    console.log(`[repair:auto-accept] Creating SQLite backup at: ${backupPath}...`);
    const manifest = createSqliteBackup(resolvedDbPath, backupPath);

    console.log('[repair:auto-accept] Verifying SQLite backup...');
    const verification = await verifySqliteBackup(backupPath, manifest, { sourceDbPath: resolvedDbPath });
    if (!verification.ok) {
      throw new Error(`SQLite backup verification failed: ${verification.errors.join('; ')}`);
    }
    console.log('[repair:auto-accept] Backup verified successfully.');

    // APPLY MODE: 2. Transactional Mutation (idempotent: only live rows match)
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const row of targetDecisions) {
        const res = db.run(
          `UPDATE classification_proposal_decisions SET superseded_at = ? WHERE id = ? AND superseded_at IS NULL`,
          [now, row.decision_id],
        );
        if (res.changes === 0) continue; // already repaired by a concurrent run
        db.run(
          `UPDATE classification_proposals SET status = 'stale', is_stale = 1, staleness_reason = 'historical_auto_accept_repaired' WHERE id = ?`,
          [row.proposal_id],
        );
        db.run(
          `INSERT INTO classification_history_events (id, workspace_id, product_sku, run_id, proposal_id, decision_id, event_type, event_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'system_auto_accept_repaired', ?, ?)`,
          [randomUUID(), row.workspace_id, row.product_sku, row.run_id, row.proposal_id, row.decision_id,
            JSON.stringify({ originalDecisionId: row.decision_id, reason: 'historical_auto_accept_repaired' }), now],
        );
      }

      for (const dep of dependentProposals) {
        db.run(
          `UPDATE classification_proposals SET status = 'stale', is_stale = 1, staleness_reason = 'historical_auto_accept_repaired' WHERE id = ? AND superseded_at IS NULL`,
          [dep.id],
        );
        db.run(
          `UPDATE classification_proposal_decisions SET superseded_at = ? WHERE proposal_id = ? AND superseded_at IS NULL`,
          [now, dep.id],
        );
      }

      for (const itemId of itemIds) {
        const invalidated = markReviewInvalidated(itemId, 'historical_auto_accept_repaired');
        if (invalidated) metrics.reviewStateRowsInvalidated++;
        // Return unexported promotion items to review; never touch exported rows.
        const ret = db.run(
          `UPDATE onboarding_items SET stage = 'review', stage_status = 'pending', updated_at = ? WHERE id = ? AND stage = 'promotion'`,
          [now, itemId],
        );
        void ret;
      }
    })();

    console.log('\n--- REPAIR APPLIED SUCCESSFULLY ---');
    console.log(`Items examined:                    ${metrics.itemsExamined}`);
    console.log(`Primary type decisions superseded: ${metrics.proposalsSuperseded}`);
    console.log(`Dependent proposals staled:        ${metrics.dependentProposalsStaled}`);
    console.log(`Review state rows invalidated:     ${metrics.reviewStateRowsInvalidated}`);
    if (exportedItems.length > 0) {
      console.log(`[repair:auto-accept] Already-exported items require manual catalog audit: ${exportedItems.map(e => e.id).join(', ')}`);
    }

    return metrics;
  } finally {
    if (!apply) {
      try { (db as Database).close(); } catch { /* ignore */ }
    } else if (!owned) {
      closeDb();
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const writerStopped = args.includes('--i-stopped-the-writer');
  const dbArg = args.find(a => a.startsWith('--db='));
  const backupDirArg = args.find(a => a.startsWith('--backup-dir='));

  const dbPath = dbArg
    ? dbArg.slice(5)
    : process.env.BAYSTATE_CMS_DB_PATH || process.env.DATABASE_PATH || './app.db';

  const backupDir = backupDirArg ? backupDirArg.slice(13) : './backups';

  runRepair({ dbPath, apply, backupDir, writerStopped })
    .then(() => {
      try { closeDb(); } catch { /* ignore when dry-run used its own handle */ }
      process.exit(0);
    })
    .catch(err => {
      console.error('[repair:auto-accept] Error:', err);
      try { closeDb(); } catch { /* ignore */ }
      process.exit(1);
    });
}
