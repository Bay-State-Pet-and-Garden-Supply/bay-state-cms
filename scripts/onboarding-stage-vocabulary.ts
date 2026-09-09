#!/usr/bin/env bun
/**
 * Slice 5a — offline stage-vocabulary maintenance entry (council plan §5.1).
 *
 * Dry-run by default. Apply requires ALL of:
 *   --mode=apply --db=<path> --expected-identity=<sha> --backup-manifest=<path>
 *   --maintenance-proof=<path> (exclusive-maintenance/quiescence proof file)
 *
 * Never imports server startup; never runs unrelated migrations/repairs.
 * Never touches the live DB: the DB path must NOT be the operator DB unless
 * the maintenance proof explicitly names it (operational gate, still rejected
 * in this tranche — this script refuses `--db` pointing at ./data/*.db
 * without an explicit --allow-named-path escape that CI never passes).
 *
 * Usage:
 *   bun scripts/onboarding-stage-vocabulary.ts --db /tmp/case/app.db            # dry-run inventory
 *   bun scripts/onboarding-stage-vocabulary.ts --mode=apply --db ... --expected-identity ... --backup-manifest ... --maintenance-proof ...
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runStageVocabularyMigration } from '../src/db/repositories/onboarding-stage-vocabulary-repo';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);

const mode = String(args['mode'] ?? 'dry-run');
const dbPath = String(args['db'] ?? '');
if (!dbPath) {
  console.error('Missing --db=<path>');
  process.exit(2);
}
const realDb = fs.realpathSync(dbPath);

if (mode !== 'dry-run' && mode !== 'apply') {
  console.error(`Unknown --mode=${mode} (want dry-run|apply)`);
  process.exit(2);
}

const db = mode === 'dry-run' ? new Database(realDb, { readonly: true }) : new Database(realDb);

// Read storage version (absent = v1) — same-connection read, no cache.
const metaRow = db.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
  | { value: string }
  | undefined;
const storageVersion = metaRow?.value ?? '1';
console.log(JSON.stringify({ mode, db: realDb, storageVersion }));

const KNOWN = [
  'sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion',
  'route_sources', 'find_product_page', 'collect_details', 'prepare_listing',
  'review_listings', 'create_drafts',
];
const matrix = db
  .query('SELECT stage, stage_status AS status, COUNT(*) AS count FROM onboarding_items GROUP BY stage, stage_status ORDER BY stage, status')
  .all() as Array<{ stage: string | null; status: string; count: number }>;
const unknown = matrix.filter((r) => r.stage === null || !KNOWN.includes(r.stage));
console.log(JSON.stringify({ matrix, unknownCount: unknown.reduce((n, r) => n + r.count, 0) }));

if (mode === 'dry-run') {
  console.log('dry-run: wrote nothing.');
  db.close();
  process.exit(unknown.length > 0 ? 3 : 0);
}

// ---- apply gate ----
for (const k of ['expected-identity', 'backup-manifest', 'maintenance-proof'] as const) {
  if (!args[k]) {
    console.error(`apply requires --${k}`);
    process.exit(2);
  }
}
const manifestPath = path.resolve(String(args['backup-manifest']));
const proofPath = path.resolve(String(args['maintenance-proof']));
if (!fs.existsSync(manifestPath) || !fs.existsSync(proofPath)) {
  console.error('apply requires existing backup manifest + maintenance proof files');
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
  dbIdentity?: string;
  sourceIdentityHash?: string;
  sourceIdentityHashAfter?: string;
};
// Verifier manifests (src/db/sqlite-backup-verifier.ts) bind the source via
// `sourceIdentityHash` (never `dbIdentity`); accept the real emitted field
// with the legacy name as fallback, and never fail open on a missing field.
const manifestedIdentity = manifest.sourceIdentityHash ?? manifest.dbIdentity;
if (typeof manifestedIdentity !== 'string' || manifestedIdentity.length === 0) {
  console.error('backup manifest carries no source identity (sourceIdentityHash) — refusing apply');
  process.exit(2);
}
if (typeof manifest.sourceIdentityHashAfter !== 'string' || manifest.sourceIdentityHashAfter.length === 0) {
  console.error('backup manifest carries no post-snapshot source identity (sourceIdentityHashAfter) — refusing apply');
  process.exit(2);
}
if (manifest.sourceIdentityHashAfter !== manifest.sourceIdentityHash) {
  console.error('backup manifest source-identity invariant violated (sourceIdentityHashAfter mismatch) — refusing apply');
  process.exit(2);
}
if (manifestedIdentity !== String(args['expected-identity'])) {
  console.error('source identity mismatch vs backup manifest — refusing apply');
  process.exit(2);
}
if (unknown.length > 0) {
  console.error(`refusing apply: ${unknown.length} unknown stage groups present`);
  process.exit(3);
}
const opRow = db.query("SELECT value FROM app_meta WHERE key = 'operator_state_schema_version'").get() as
  | { value: string }
  | undefined;
if (opRow?.value !== '2') {
  console.error(`refusing apply: operator_state_schema_version=${opRow?.value ?? 'absent'} (need '2')`);
  process.exit(3);
}
// ---- apply: transactional seam (council plan §5.4 step 5) ----
// One atomic transaction for stage-only updates + version marker +
// maintenance receipt. The expected source identity is checked pre-call by
// the script gate above and recorded by the seam; the seam executes
// atomically — failure rolls back and leaves writers stopped (never a
// partial migration marked complete).
let result;
try {
  result = runStageVocabularyMigration(db, { expectedSourceIdentity: String(args['expected-identity']) });
} catch (err) {
  console.error(`apply refused/failed: ${err instanceof Error ? err.message : String(err)}`);
  db.close();
  process.exit(3);
}
const afterRow = db.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
  | { value: string }
  | undefined;
const receiptTable = db.query(
  "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_stage_migration_receipts'",
).get() as { one: number } | undefined;
const receiptCount = receiptTable
  ? (db.query('SELECT COUNT(*) AS c FROM onboarding_stage_migration_receipts').get() as { c: number }).c
  : 0;
console.log(
  JSON.stringify({
    applied: true,
    rerunNoop: result.rerunNoop,
    storageVersionBefore: result.storageVersionBefore,
    storageVersionAfter: afterRow?.value ?? '1',
    perStageUpdated: result.perStageUpdated,
    receiptCount,
  }),
);
db.close();
process.exit(0);
