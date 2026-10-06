#!/usr/bin/env bun
/**
 * One-shot: run the canonical comparison backfill for the active workspace
 * after the preserved-block repair, so product_index comparison hashes are
 * recomputed from the pinned approved Git HEAD (never from remote
 * observations). Repeat-safe and resumable via its durable cursor.
 *
 * Usage: bun run scripts/realign-comparison-hashes.ts
 */
import { initDb, closeDb, getDb } from '../src/db/connection';
import { runCanonicalComparisonBackfill } from '../src/shopsite/canonical-comparison-backfill';

initDb('storage/catalog/.shopsite-cms/app.db');
try {
  const db = getDb();
  const workspace = db
    .query('SELECT id, workspace_path AS workspacePath FROM workspace LIMIT 1')
    .get() as { id: string; workspacePath: string } | undefined;
  if (!workspace) throw new Error('No workspace row found in the workspace database.');

  let total = { rebuilt: 0, alreadyCanonical: 0, unverified: 0, missingSource: 0, remaining: 0 };
  for (let pass = 0; pass < 200; pass++) {
    const result = runCanonicalComparisonBackfill(workspace.id, workspace.workspacePath, { batchSize: 200, maxBatches: 200 });
    total = {
      rebuilt: total.rebuilt + result.rebuilt,
      alreadyCanonical: total.alreadyCanonical + result.alreadyCanonical,
      unverified: total.unverified + result.unverified,
      missingSource: total.missingSource + result.missingSource,
      remaining: result.remaining,
    };
    console.log(`pass ${pass + 1}: rebuilt=${result.rebuilt} canonical=${result.alreadyCanonical} unverified=${result.unverified} missing=${result.missingSource} remaining=${result.remaining} complete=${result.complete}`);
    if (result.complete) break;
  }
  console.log('totals:', JSON.stringify(total));
} finally {
  closeDb();
}
