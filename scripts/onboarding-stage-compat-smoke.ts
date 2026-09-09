#!/usr/bin/env bun
/**
 * Slice 5a — isolated bridge exercise (council plan §5.6 child executable).
 *
 * Imports the ACTUAL bridge repositories/services/app (never reimplements
 * them). Used two ways:
 *   1. Directly: `bun scripts/onboarding-stage-compat-smoke.ts --db <path> ...`
 *   2. As the emitted artifact `$BRIDGE_ROOT/bun/scripts/onboarding-stage-compat-smoke.js`
 *      spawned by `src/tests/unit/onboarding-stage-rollback-bridge.test.ts`.
 *
 * Args: --fixture-root --db --workspace --scenario --expected-storage-version
 *       --manifest --report
 *
 * The child opens the fixture DB read-write via the production connection,
 * dynamic-imports the EMITTED Hono app AFTER initDb (never the server entry,
 * so no live schedulers start), and proves every §5.5 bridge behavior:
 * storage-version match, no unknown stages, emitted-app v1 route + auth
 * check, one production queue-continuation, one receipt-replay exactness,
 * one distributor/cohort assertion, and v2-encoding of a newly inserted row.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// Static imports of the ACTUAL bridge modules under test (never reimplemented).
// Static (not dynamic) so the pinned `--splitting` build dedupes them into the
// shared chunks. The Hono app itself is dynamic-imported AFTER initDb.
import { allKnownStageLiterals } from '../src/db/repositories/onboarding-stage-vocabulary-repo';
import { initDb, getDb, closeDb } from '../src/db/connection';
import { claimItemsForProcessing, insertItems } from '../src/db/repositories/onboarding-item-repo';
import { approveAndAdvanceItems } from '../src/db/repositories/onboarding-review-repo';

function arg(name: string, fallback = ''): string {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const fixtureRoot = arg('fixture-root');
const dbPath = arg('db');
const workspace = arg('workspace');
const scenario = arg('scenario', 'migrated-edited-v2');
const expectedVersion = arg('expected-storage-version', '2');
const manifestPath = arg('manifest');
const reportPath = arg('report');

function fail(reason: string): never {
  try { closeDb(); } catch { /* already closed */ }
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ ok: false, scenario, reason }, null, 2));
  console.error(`compat-smoke FAIL: ${reason}`);
  process.exit(1);
}

// Path safety: everything must realpath inside the fresh fixture root.
for (const p of [dbPath, reportPath]) {
  if (!p) fail(`missing required path arg`);
  const real = fs.realpathSync(path.dirname(p)) + '/' + p.split('/').pop();
  const root = fs.realpathSync(fixtureRoot);
  if (!real.startsWith(root)) fail(`escaping path rejected: ${p}`);
}
if (!fs.existsSync(manifestPath)) fail('missing bridge manifest');

// Production connection on the fixture DB (read-write: the bridge proof
// claims queue rows and inserts a version-encoded row). No migrations run
// here — the parent initialized all prerequisite schemas.
initDb(dbPath);
const db = getDb();
const checks: string[] = [];
const evidence: Record<string, unknown> = {};

const metaRow = db.query("SELECT value FROM app_meta WHERE key = 'onboarding_stage_vocabulary_version'").get() as
  | { value: string }
  | undefined;
const storageVersion = metaRow?.value ?? '1';
if (storageVersion !== expectedVersion) fail(`storage version ${storageVersion} != expected ${expectedVersion}`);
checks.push('storage-version-match');

// Exercise the actual bridge vocabulary module's known-literal universe.
const KNOWN = new Set(allKnownStageLiterals());
const rows = db.query('SELECT stage, COUNT(*) AS count FROM onboarding_items GROUP BY stage').all() as Array<{
  stage: string | null;
  count: number;
}>;
const unknownRows = rows.filter((r) => r.stage === null || !KNOWN.has(r.stage));
if (unknownRows.length > 0) fail(`unknown stage rows present: ${JSON.stringify(unknownRows)}`);
checks.push('no-unknown-stages', 'manifest-present', 'paths-inside-fixture-root');

// Discover the fixture batch (parent seeds exactly one) + workspace.
const batchRow = db.query('SELECT id, workspace_id FROM onboarding_batches LIMIT 1').get() as
  | { id: string; workspace_id: string }
  | undefined;
if (!batchRow) fail('fixture has no batch');
const batchId = (batchRow as { id: string }).id;
const workspaceId = (batchRow as { workspace_id: string }).workspace_id;

const run = async (): Promise<void> => {
  // Dynamic-import the EMITTED app AFTER initDb (plan §5.6: never the server
  // entry, so no live schedulers start; fetch() stays in-process, no TCP port).
  // The specifier is resolved at RUNTIME relative to this file (never a
  // build-time edge: bun --splitting emits duplicate-export chunks when the
  // app graph is statically reachable from the smoke entry). `.js` is the
  // emitted artifact; `.ts` keeps direct source runs working.
  const appModule = (await loadBridgeApp()) as { default: { fetch: (req: Request) => Response | Promise<Response> } };
  const app = appModule.default;
  if (!app || typeof app.fetch !== 'function') fail('emitted app has no fetch(Request) handler');

  // (1) Emitted-app v1 route: health + frozen v1 work-state counts on the
  // migrated-then-edited v2 DB.
  const healthRes = (await app.fetch(new Request('http://bridge.local/api/health'))) as Response;
  if (healthRes.status !== 200) fail(`v1 GET /api/health -> ${healthRes.status}`);
  const healthBody = (await healthRes.json()) as { status?: string };
  if (healthBody.status !== 'ok') fail('v1 GET /api/health body mismatch');
  checks.push('emitted-app-v1-health');
  const countsRes = (await app.fetch(
    new Request(`http://bridge.local/api/onboarding/batches/${batchId}/work-state/counts`),
  )) as Response;
  if (countsRes.status !== 200) fail(`v1 GET work-state/counts -> ${countsRes.status}`);
  const countsBody = (await countsRes.json()) as Record<string, unknown>;
  evidence['workStateCountsKeys'] = Object.keys(countsBody).sort();
  checks.push('emitted-app-v1-work-state-counts');

  // (1b) Auth check on an emitted mutating v1 route: no token -> 401, fresh
  // token -> passes the middleware (any non-401 proves auth acceptance).
  const approveUrl = `http://bridge.local/api/onboarding/batches/${batchId}/approve`;
  const denied = (await app.fetch(
    new Request(approveUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  )) as Response;
  if (denied.status !== 401) fail(`v1 POST approve without token -> ${denied.status} (need 401)`);
  const token = process.env['BAYSTATE_CMS_API_TOKEN'] ?? '';
  if (!token) fail('missing BAYSTATE_CMS_API_TOKEN in child env');
  const allowed = (await app.fetch(
    new Request(approveUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    }),
  )) as Response;
  if (allowed.status === 401) fail('v1 POST approve with valid token unexpectedly denied (401)');
  evidence['approveWithTokenStatus'] = allowed.status;
  checks.push('emitted-app-v1-auth');

  // (2) One production queue-continuation: discover the single eligible
  // fixture row (discovery-semantic, pending, unheld, policy-v1), claim it
  // exactly once; held/policy-v0 rows stay excluded.
  const eligible = db.query(
    `SELECT id FROM onboarding_items
     WHERE (stage = 'discovery' OR stage = 'find_product_page') AND stage_status = 'pending'
       AND (is_held = 0 OR is_held IS NULL) AND sourcing_entry_policy_version = 1
     ORDER BY row_number LIMIT 10`,
  ).all() as Array<{ id: string }>;
  if (eligible.length !== 1) fail(`queue-continuation fixture needs exactly 1 eligible row, found ${eligible.length}`);
  const eligibleId = eligible[0].id;
  const claimed = claimItemsForProcessing('discovery', 10, workspaceId, 'bridge-smoke');
  if (claimed.length !== 1 || claimed[0].id !== eligibleId) {
    fail(`queue-continuation claimed [${claimed.map((i) => i.id).join(',')}] (need exactly [${eligibleId}])`);
  }
  const reClaim = claimItemsForProcessing('find_product_page', 10, workspaceId, 'bridge-smoke-2');
  if (reClaim.length !== 0) fail(`queue-continuation re-claim leaked [${reClaim.map((i) => i.id).join(',')}]`);
  const heldMoved = (db.query('SELECT COUNT(*) AS c FROM onboarding_items WHERE is_held = 1 AND stage_status != \'pending\'').get() as { c: number }).c;
  const v0Moved = (db.query('SELECT COUNT(*) AS c FROM onboarding_items WHERE sourcing_entry_policy_version = 0 AND stage_status != \'pending\'').get() as { c: number }).c;
  if (heldMoved !== 0 || v0Moved !== 0) fail('held/policy-v0 exclusion violated by claim');
  evidence['claimedId'] = claimed[0].id;
  checks.push('queue-continuation-exactly-once', 'held-policy-v0-excluded');

  // (3) One receipt-replay exactness: discover the parent's approval receipt
  // by its idempotency key, re-invoke with the SAME key + request hash, and
  // require byte-identical results with zero duplicate drafts/audits.
  const receiptRow = db.query(
    "SELECT id, request_hash AS h, details_json AS j FROM onboarding_operation_receipts WHERE batch_id = ? AND operation = 'approve' AND idempotency_key = 'idem-approve-1'",
  ).get(batchId) as { id: string; h: string; j: string } | undefined;
  if (!receiptRow?.j) fail('parent approval receipt (idem-approve-1) missing');
  const receiptId = receiptRow.id;
  const requestHash = receiptRow.h;
  const envelope = JSON.parse(receiptRow.j) as { results?: Array<{ itemId: string; status: string }> };
  const approvedIds = (envelope.results ?? []).filter((r) => r.status === 'approved').map((r) => r.itemId);
  if (approvedIds.length === 0) fail('parent approval receipt has no approved results to replay');
  const hashBefore = crypto.createHash('sha256').update(receiptRow.j).digest('hex');
  const draftsBefore = (db.query('SELECT COUNT(*) AS c FROM change_set_items').get() as { c: number }).c;
  const auditsBefore = (db.query('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
  const replay = approveAndAdvanceItems({
    itemIds: approvedIds,
    batchId,
    approvedBy: 'op',
    requestHash,
    idempotencyKey: 'idem-approve-1',
    workspaceId,
  });
  const receiptAfter = db.query('SELECT details_json AS j FROM onboarding_operation_receipts WHERE id = ?').get(receiptId) as
    | { j: string }
    | undefined;
  if (!receiptAfter || receiptAfter.j !== receiptRow.j) fail('receipt-replay changed stored receipt bytes');
  if (crypto.createHash('sha256').update(receiptAfter.j).digest('hex') !== hashBefore) fail('receipt-replay hash drift');
  if (replay.receiptId !== receiptId) fail(`receipt-replay receiptId ${replay.receiptId} (need ${receiptId})`);
  if (JSON.stringify(replay.approved.sort()) !== JSON.stringify([...approvedIds].sort())) fail('receipt-replay approved set drift');
  const draftsAfter = (db.query('SELECT COUNT(*) AS c FROM change_set_items').get() as { c: number }).c;
  const auditsAfter = (db.query('SELECT COUNT(*) AS c FROM audit_log').get() as { c: number }).c;
  if (draftsAfter !== draftsBefore || auditsAfter !== auditsBefore) fail('receipt-replay duplicated drafts/audits');
  evidence['receiptHash'] = hashBefore;
  checks.push('receipt-replay-exact-bytes', 'receipt-replay-no-duplicate-effects');

  // (4) Distributor/cohort assertion: every distributor row keeps null URL +
  // profile-free materialization shape; every cohort membership is intact.
  const dists = db.query("SELECT id, source_type AS st, source_url AS url, stage AS stage, stage_status AS ss FROM onboarding_items WHERE source_type = 'distributor_record'").all() as
    Array<{ id: string; st: string; url: string | null; stage: string; ss: string }>;
  if (dists.length === 0) fail('no distributor-record rows for the bridge to read');
  for (const dist of dists) {
    if (dist.st !== 'distributor_record' || dist.url !== null) fail(`distributor row ${dist.id} lost null-URL record shape`);
  }
  const members = db.query('SELECT onboarding_item_id AS item, cohort_id AS c FROM curation_cohort_members').all() as
    Array<{ item: string; c: string }>;
  if (members.length === 0) fail('no cohort memberships for the bridge to read');
  for (const m of members) {
    const coh = db.query('SELECT status AS s FROM curation_cohorts WHERE id = ?').get(m.c) as { s: string } | undefined;
    const itemExists = db.query('SELECT id FROM onboarding_items WHERE id = ?').get(m.item) as { id: string } | undefined;
    if (!coh || !itemExists) fail(`cohort membership broken by bridge (item ${m.item}, cohort ${m.c})`);
  }
  evidence['distributorStages'] = dists.map((d) => `${d.id}:${d.stage}/${d.ss}`);
  evidence['cohortMemberships'] = members.map((m) => `${m.item}->${m.c}`);
  checks.push('distributor-record-shape', 'cohort-membership-intact');

  // (5) New rows use the metadata-selected (v2) representation.
  const inserted = insertItems(batchId, [{ upc: 'upc-bridge-new', name: 'Bridge New', rowNumber: 90 }], 'discovery', 1);
  if (inserted.length !== 1) fail('bridge insert failed');
  const newStage = (db.query('SELECT stage FROM onboarding_items WHERE id = ?').get(inserted[0].id) as { stage: string }).stage;
  if (newStage !== 'find_product_page') fail(`new row encoded as '${newStage}' (need v2 'find_product_page')`);
  evidence['newRowId'] = inserted[0].id;
  evidence['newRowStage'] = newStage;
  checks.push('v2-encoding-of-new-row');
};

/**
 * Runtime-resolved import of the bridge app entry (see above). Not a string
 * literal the bundler can follow — intentionally resolved at runtime.
 */
async function loadBridgeApp(): Promise<unknown> {
  const base = import.meta.url;
  const candidates = ['../src/server/app.js', '../src/server/app.ts'];
  let lastErr: unknown = null;
  for (const cand of candidates) {
    try {
      return await import(new URL(cand, base).href);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

try {
  await run();
} catch (err) {
  fail(`bridge exercise threw: ${err instanceof Error ? err.message : String(err)}`);
}

const report = {
  ok: true,
  scenario,
  storageVersion,
  workspace,
  batchId,
  groups: rows,
  manifest: manifestPath,
  checks,
  evidence,
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
try { closeDb(); } catch { /* closed */ }
console.log(JSON.stringify({ ok: true, scenario, checks }));
