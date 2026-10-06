import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { markReviewed } from '../../db/repositories/onboarding-review-repo';
import { findByScopedIdempotencyKey, computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import onboardingWorkRoutes from '../../server/routes/onboarding-work-routes';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { assignProductToPageId, listVerifiedPageOptions } from '../../db/repositories/page-repo';

let workspaceId: string;
let workspacePath: string;
let app: Hono;
let origToken: string | undefined;
let pageId: string;

function makeWorkspace() {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `ws-idem-${workspaceId.slice(0, 8)}`);
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
  activatePageImportFromRecords({ workspaceId, sourceHash: 'd'.repeat(64), parserFormatVersion: 'pages-xml-1',
    activatedBy: 'fixture', records: [{ identity: { kind: 'exported_guid', key: 'idem-fixture-toys', status: 'verified' },
      name: 'Toys', parentRef: null, availability: 'available' }] });
  pageId = listVerifiedPageOptions(workspaceId)[0].id;
  app = new Hono();
  app.route('/api', onboardingWorkRoutes);
}

// Receipt proofs exercise native catalog drafts, not placeholder payloads.
function makeDraftReady(itemId: string) {
  const item = getDb().query('SELECT upc, name FROM onboarding_items WHERE id = ?').get(itemId) as { upc: string; name: string };
  getDb().query('UPDATE onboarding_items SET price = ?, extraction_data_json = ?, curation_data_json = ? WHERE id = ?').run(
    '$12.50', JSON.stringify({ title: item.name, primaryImage: 'fixture/toy.jpg', additionalImages: [], customFields: {} }),
    JSON.stringify({ curatedTitle: item.name, suggestedPages: ['Toys'] }), itemId);
  assignProductToPageId(item.upc, pageId, 'Toys');
}

function makeReviewBatch(itemCount = 2): { batchId: string; itemIds: string[] } {
  const batch = createBatch({ workspaceId, name: 'Idem', fileName: 'f.csv', totalItems: 0 });
  const rows = Array.from({ length: itemCount }, (_, i) => ({
    upc: `IDEM-${randomUUID().slice(0, 6)}-${i}`,
    name: `Product ${i}`,
    brandHint: 'Blue Buffalo',
    sourceUrl: null,
    rowNumber: i + 1,
    stage: 'review' as const,
    stageStatus: 'completed' as const,
  }));
  const inserted = insertItems(batch.id, rows, 'review' as any, 1);
  const ids = inserted.map(r => r.id);
  for (const id of ids) {
    markReviewed({ itemId: id, batchId: batch.id, reviewedBy: 'tester' });
  }
  return { batchId: batch.id, itemIds: ids };
}

function injectFault(snippet: string, errorMsg: string): () => void {
  const db: any = getDb();
  const originalQuery = db.query.bind(db);
  const originalRun = db.run.bind(db);
  db.query = (sql: string, ...rest: any[]) => {
    const stmt: any = originalQuery(sql, ...rest);
    if (typeof sql === 'string' && sql.includes(snippet)) {
      const origRun = stmt.run?.bind(stmt);
      if (origRun) stmt.run = (...args: any[]) => { throw new Error(errorMsg); };
      const origGet = stmt.get?.bind(stmt);
      if (origGet) stmt.get = (...args: any[]) => { throw new Error(errorMsg); };
      const origAll = stmt.all?.bind(stmt);
      if (origAll) stmt.all = (...args: any[]) => { throw new Error(errorMsg); };
    }
    return stmt;
  };
  db.run = (sql: string, ...args: any[]) => {
    if (typeof sql === 'string' && sql.includes(snippet)) throw new Error(errorMsg);
    return originalRun(sql, ...args);
  };
  return () => {
    db.query = originalQuery;
    db.run = originalRun;
  };
}

function assertAllOrNothing(batchId: string, itemIds: string[] = [], opts: { expectedApproved?: number, expectedPromoted?: number, baselineChangeSetItems?: number } = {}) {
  const db = getDb();
  const receipt = db.query('SELECT COUNT(*) as c FROM onboarding_operation_receipts WHERE batch_id = ?').get(batchId) as { c: number };
  expect(receipt.c).toBe(0);
  const expectedApproved = opts.expectedApproved ?? 0;
  const expectedPromoted = opts.expectedPromoted ?? 0;
  const approved = db.query('SELECT COUNT(*) as c FROM onboarding_review_state WHERE batch_id = ? AND approved_at IS NOT NULL').get(batchId) as { c: number };
  expect(approved.c).toBe(expectedApproved);
  const promoted = db.query("SELECT COUNT(*) as c FROM onboarding_items WHERE batch_id = ? AND stage = 'promotion'").get(batchId) as { c: number };
  expect(promoted.c).toBe(expectedPromoted);
  const batchAudits = db.query('SELECT COUNT(*) as c FROM audit_log WHERE entity_id = ?').get(batchId) as { c: number };
  let totalAudits = batchAudits.c;
  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(',');
    const itemAudits = db.query(`SELECT COUNT(*) as c FROM audit_log WHERE entity_id IN (${placeholders})`).get(...itemIds) as { c: number };
    totalAudits += itemAudits.c;
  }
  expect(totalAudits).toBe(0);
  const cs = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
  expect(cs.c).toBe(0);
  const csi = db.query('SELECT COUNT(*) as c FROM change_set_items').get() as { c: number };
  expect(csi.c).toBe(opts.baselineChangeSetItems ?? 0);
}

async function postApprove(batchId: string, itemIds: string[], headers: Record<string, string> = {}, bodyExtra: any = {}) {
  const body = { itemIds, reviewerId: 'evil-operator', ...bodyExtra };
  const req = new Request(`http://localhost/api/onboarding/batches/${batchId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe('approval idempotency and server-derived principal', () => {
  beforeEach(() => {
    origToken = process.env.BAYSTATE_CMS_API_TOKEN;
    makeWorkspace();
  });
  afterEach(() => {
    if (origToken === undefined) delete process.env.BAYSTATE_CMS_API_TOKEN;
    else process.env.BAYSTATE_CMS_API_TOKEN = origToken;
  });

  it('same Idempotency-Key returns same receipt without double-advancing', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batchId, itemIds, headers);
    expect(first.status).toBe(200);
    expect(first.json.approvedCount).toBe(2);
    expect(first.json.receiptId).toBeTruthy();
    const firstReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(firstReceipt?.id).toBe(first.json.receiptId);
    expect(firstReceipt?.requestHash).toBe(computeRequestHash(itemIds));

    // Second call with same key — should be idempotent, replay identical response with same receiptId
    const second = await postApprove(batchId, itemIds, headers);
    expect(second.status).toBe(200);
    expect(second.json.approvedCount).toBe(2);
    expect(second.json.receiptId).toBe(first.json.receiptId);
    expect(second.json.receiptId).toBeTruthy();
    // Identical replay: second response should equal first (except maybe timing)
    expect(second.json.results).toEqual(first.json.results);
    expect(second.json.approvedCount).toBe(first.json.approvedCount);
    expect(second.json.rejectedCount).toBe(first.json.rejectedCount);
    // Items should still be in promotion, not re-advancing to error
    const db = getDb();
    const rows = db.query('SELECT stage FROM onboarding_items WHERE id IN (?,?)').all(itemIds[0], itemIds[1]) as Array<{ stage: string }>;
    for (const r of rows) expect(r.stage).toBe('promotion');

    const secondReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(secondReceipt?.id).toBe(firstReceipt?.id);
    expect(secondReceipt?.requestHash).toBe(firstReceipt?.requestHash);
  });

  it('payload mismatch with same Idempotency-Key returns 409', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(3);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batchId, itemIds.slice(0, 2), headers);
    expect(first.status).toBe(200);
    const firstReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(firstReceipt).toBeTruthy();
    // Second call with same key but different itemIds (payload mismatch) should 409
    const second = await postApprove(batchId, itemIds.slice(1, 3), headers);
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('payload_mismatch');
    expect(second.json.receiptId).toBe(firstReceipt?.id);
    // Original receipt unchanged
    const still = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(still?.requestHash).toBe(firstReceipt?.requestHash);
  });

  it('missing or invalid Authorization returns 401', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(1);
    const key = 'idem-' + randomUUID();
    // No Authorization header
    const noAuth = await postApprove(batchId, itemIds, { 'Idempotency-Key': key });
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.code).toBe('unauthorized');
    // Wrong token
    const wrong = await postApprove(batchId, itemIds, { Authorization: 'Bearer wrong-token', 'Idempotency-Key': key + '-2' });
    expect(wrong.status).toBe(401);
  });

  it('server-derived principal beats client reviewerId', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-xyz';
    const { batchId, itemIds } = makeReviewBatch(1);
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-xyz', 'Idempotency-Key': key };
    const res = await postApprove(batchId, itemIds, headers);
    expect(res.status).toBe(200);
    expect(res.json.principal).toBeTruthy();
    expect(res.json.principal).not.toBe('evil-operator');
    expect(res.json.principal).toContain('catalog_approver:');
    const receipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(receipt?.principal).not.toBe('evil-operator');
    expect(receipt?.principal).toBe(res.json.principal);
    expect(receipt?.role).toBe('catalog_approver');
  });

  it('without token, principal is system (dev mode) and still succeeds', async () => {
    delete process.env.BAYSTATE_CMS_API_TOKEN;
    const { batchId, itemIds } = makeReviewBatch(1);
    const res = await postApprove(batchId, itemIds, {});
    expect(res.status).toBe(200);
    expect(res.json.principal).toBe('system');
  });

  it('different idempotency keys create separate receipts', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId: batch1, itemIds: ids1 } = makeReviewBatch(1);
    const { batchId: batch2, itemIds: ids2 } = (() => {
      const b = createBatch({ workspaceId, name: 'B2', fileName: 'b2.csv', totalItems: 0 });
      const rows = [{ upc: `IDEM2-${randomUUID().slice(0, 6)}`, name: 'P2', brandHint: 'Blue', sourceUrl: null, rowNumber: 1, stage: 'review' as const, stageStatus: 'completed' as const }];
      const ins = insertItems(b.id, rows, 'review' as any, 1);
      markReviewed({ itemId: ins[0].id, batchId: b.id, reviewedBy: 'tester' });
      return { batchId: b.id, itemIds: [ins[0].id] };
    })();
    const key1 = 'idem-' + randomUUID();
    const key2 = 'idem-' + randomUUID();
    const headers1 = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key1 };
    const headers2 = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key2 };
    const r1 = await postApprove(batch1, ids1, headers1);
    const r2 = await postApprove(batch2, ids2, headers2);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.receiptId).not.toBe(r2.json.receiptId);
  });

  it('mixed eligible/ineligible exact retry replays identical envelope with same receiptId', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const batch = createBatch({ workspaceId, name: 'Mixed', fileName: 'mix.csv', totalItems: 0 });
    const eligible = insertItems(batch.id, [{ upc: `MIX-E-${randomUUID().slice(0,4)}`, name: 'Eligible', brandHint: 'Blue', sourceUrl: null, rowNumber: 1, stage: 'review' as const, stageStatus: 'completed' as const }], 'review' as any, 1)[0];
    const ineligible = insertItems(batch.id, [{ upc: `MIX-I-${randomUUID().slice(0,4)}`, name: 'Ineligible', brandHint: 'Blue', sourceUrl: null, rowNumber: 2, stage: 'review' as const, stageStatus: 'completed' as const }], 'review' as any, 1)[0];
    markReviewed({ itemId: eligible.id, batchId: batch.id, reviewedBy: 'tester' });
    // do NOT markReviewed for ineligible -> not_reviewed
    const itemIds = [eligible.id, ineligible.id];
    const key = 'idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const first = await postApprove(batch.id, itemIds, headers);
    expect(first.status).toBe(200);
    expect(first.json.approvedCount).toBe(1);
    expect(first.json.rejectedCount).toBe(1);
    expect(first.json.receiptId).toBeTruthy();
    // Ensure no item appears in both approved and rejected
    const approvedSet = new Set(first.json.results.filter((r:any)=>r.status==='approved').map((r:any)=>r.itemId));
    const rejectedSet = new Set(first.json.results.filter((r:any)=>r.status==='rejected').map((r:any)=>r.itemId));
    for (const id of approvedSet) expect(rejectedSet.has(id)).toBe(false);
    expect(approvedSet.has(eligible.id)).toBe(true);
    expect(rejectedSet.has(ineligible.id)).toBe(true);

    const second = await postApprove(batch.id, itemIds, headers);
    expect(second.status).toBe(200);
    expect(second.json.receiptId).toBe(first.json.receiptId);
    // Deep JSON equality - whole envelope must be identical
    expect(second.json).toEqual(first.json);
    expect(second.json.principal).toBe(first.json.principal);
    expect(second.json.results).toEqual(first.json.results);
    expect(second.json.approvedCount).toBe(first.json.approvedCount);
    expect(second.json.rejectedCount).toBe(first.json.rejectedCount);
    expect(second.json.rejected).toEqual(first.json.rejected);
    expect(second.json.audited).toBe(first.json.audited);
    // No duplicate side effects - details_json must equal first response
    const receipt = findByScopedIdempotencyKey(workspaceId, batch.id, 'approve', key);
    expect(receipt?.id).toBe(first.json.receiptId);
    expect(JSON.parse(receipt!.detailsJson!)).toEqual(first.json);
    // All items still correct stage
    const db = getDb();
    const row = db.query('SELECT stage FROM onboarding_items WHERE id = ?').get(eligible.id) as { stage: string };
    expect(row.stage).toBe('promotion');
  });

  // ── Export-draft receipt lifecycle (Item 5) ──────────────────────────────

  async function postExportDrafts(batchId: string, itemIds: string[], headers: Record<string, string> = {}) {
    const body = { itemIds };
    const req = new Request(`http://localhost/api/onboarding/batches/${batchId}/create-export-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const res = await app.fetch(req);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  function makeExportBatch(itemCount = 2): { batchId: string; itemIds: string[] } {
    const batch = createBatch({ workspaceId, name: `Export-${randomUUID().slice(0,4)}`, fileName: 'e.csv', totalItems: 0 });
    const rows = Array.from({ length: itemCount }, (_, i) => ({
      upc: `EXP-${randomUUID().slice(0,6)}-${i}`,
      name: `Product ${i}`,
      brandHint: 'Blue Buffalo',
      sourceUrl: null,
      rowNumber: i + 1,
      stage: 'promotion' as const,
      stageStatus: 'pending' as const,
    }));
    const inserted = insertItems(batch.id, rows, 'promotion' as any, 1);
    const ids = inserted.map(r => r.id);
    // Make them durably approved (promotion items require approved review)
    const db = getDb();
    const now = new Date().toISOString();
    for (const id of ids) {
      makeDraftReady(id);
      db.run(
        `INSERT INTO onboarding_review_state (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason, approved_at, approved_by, approval_origin, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'test', ?, ?)`,
        [id, batch.id, now, 'tester', now, 'tester', now, now],
      );
    }
    return { batchId: batch.id, itemIds: ids };
  }

  it('export-draft concurrent double-send creates drafts exactly once', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeExportBatch(2);
    const key = 'export-idem-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };

    // Fire two concurrent requests with same key+payload
    const [a, b] = await Promise.all([
      postExportDrafts(batchId, itemIds, headers),
      postExportDrafts(batchId, itemIds, headers),
    ]);

    // One should be 200 completed, the other either 200 replay or 409 in_progress depending on timing.
    // In single-threaded sqlite, one wins and the other replays. Both should not 500.
    expect([a.status, b.status].every(s => s === 200 || s === 409)).toBe(true);
    const successes = [a, b].filter(r => r.status === 200);
    expect(successes.length).toBeGreaterThanOrEqual(1);
    // If both 200, they must share same receiptId and same created list (no double create)
    if (a.status === 200 && b.status === 200) {
      expect(a.json.receiptId).toBe(b.json.receiptId);
      expect(a.json.created).toEqual(b.json.created);
      expect(a.json.createdCount).toBe(2);
    }
    // Ensure drafts created exactly once (count change_sets)
    const db = getDb();
    const csCount = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    expect(csCount.c).toBe(1);
    const itemCount = db.query('SELECT COUNT(*) as c FROM change_set_items WHERE change_set_id IN (SELECT id FROM change_sets WHERE workspace_id = ?)').get(workspaceId) as { c: number };
    expect(itemCount.c).toBe(2);

    // Subsequent replay must be identical
    const third = await postExportDrafts(batchId, itemIds, headers);
    expect(third.status).toBe(200);
    const firstSuccess = successes[0];
    expect(third.json.receiptId).toBe(firstSuccess.json.receiptId);
    expect(third.json).toEqual(firstSuccess.json);
  });

  it('approval fault-injection started without details returns 409 fail-closed', async () => {
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'approve-started-' + randomUUID();
    const hash = computeRequestHash(itemIds.slice(0,2));
    const now = new Date().toISOString();
    const fakeReceiptId = randomUUID();
    getDb().run(
      `INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at) VALUES (?, ?, ?, 'approve', ?, ?, ?, ?, ?, NULL, 'started', ?, NULL)`,
      [fakeReceiptId, workspaceId, batchId, 'system', 'catalog_approver', now, key, hash, now],
    );
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const res = await postApprove(batchId, itemIds.slice(0,2), headers);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('operation_in_progress');
    expect(res.json.receiptId).toBe(fakeReceiptId);
    // Second retry still 409 (still started)
    const res2 = await postApprove(batchId, itemIds.slice(0,2), headers);
    expect(res2.status).toBe(409);
    expect(res2.json.code).toBe('operation_in_progress');
  });

  it('export-draft fault-injection started without details returns 409 fail-closed', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeExportBatch(2);
    const key = 'fault-' + randomUUID();
    const db = getDb();
    const now = new Date().toISOString();
    const fakeReceiptId = randomUUID();
    const hash = computeRequestHash(itemIds);
    // Manually claim receipt as started without completing (simulates crash after claim before mutation)
    db.run(
      `INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at) VALUES (?, ?, ?, 'export', ?, ?, ?, ?, ?, NULL, 'started', ?, NULL)`,
      [fakeReceiptId, workspaceId, batchId, 'system', 'catalog_exporter', now, key, hash, now],
    );
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const beforeCs = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    const res = await postExportDrafts(batchId, itemIds, headers);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('operation_in_progress');
    expect(res.json.receiptId).toBe(fakeReceiptId);
    // No drafts should have been created (count unchanged)
    const csCount = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    expect(csCount.c).toBe(beforeCs.c);
    // Second retry still 409 (still started)
    const res2 = await postExportDrafts(batchId, itemIds, headers);
    expect(res2.status).toBe(409);
    expect(res2.json.receiptId).toBe(fakeReceiptId);
    const csCount2 = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    expect(csCount2.c).toBe(beforeCs.c);
  });

  it('approval never creates change set and export never auto-approves, export revalidates durable approval', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    // Approval path
    const { batchId: approveBatch, itemIds: approveIds } = makeReviewBatch(1);
    const approveKey = 'idem-approve-' + randomUUID();
    const approveHeaders = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': approveKey };
    const db = getDb();
    const csBeforeApprove = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    const approveRes = await postApprove(approveBatch, approveIds, approveHeaders);
    expect(approveRes.status).toBe(200);
    // Approval should not create change_set (count unchanged)
    const csAfterApprove = db.query('SELECT COUNT(*) as c FROM change_sets WHERE workspace_id = ?').get(workspaceId) as { c: number };
    expect(csAfterApprove.c).toBe(csBeforeApprove.c);

    // Now create an export batch with one approved and one not approved
    const batch = createBatch({ workspaceId, name: `ExportReval-${randomUUID().slice(0,4)}`, fileName: 'r.csv', totalItems: 0 });
    const approvedItem = insertItems(batch.id, [{ upc: `REVAL-A-${randomUUID().slice(0,4)}`, name: 'Approved', brandHint: 'Blue', sourceUrl: null, rowNumber: 1, stage: 'promotion' as const, stageStatus: 'pending' as const }], 'promotion' as any, 1)[0];
    const unapprovedItem = insertItems(batch.id, [{ upc: `REVAL-B-${randomUUID().slice(0,4)}`, name: 'Unapproved', brandHint: 'Blue', sourceUrl: null, rowNumber: 2, stage: 'promotion' as const, stageStatus: 'pending' as const }], 'promotion' as any, 1)[0];
    makeDraftReady(approvedItem.id);
    const now2 = new Date().toISOString();
    db.run(
      `INSERT INTO onboarding_review_state (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason, approved_at, approved_by, approval_origin, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'test', ?, ?)`,
      [approvedItem.id, batch.id, now2, 'tester', now2, 'tester', now2, now2],
    );
    // unapprovedItem has no review row -> not_approved

    const exportKey = 'export-reval-' + randomUUID();
    const exportHeaders = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': exportKey };
    const exportRes = await postExportDrafts(batch.id, [approvedItem.id, unapprovedItem.id], exportHeaders);
    expect(exportRes.status).toBe(200);
    expect(exportRes.json.createdCount).toBe(1);
    expect(exportRes.json.rejectedCount).toBe(1);
    expect(exportRes.json.created).toContain(approvedItem.id);
    expect(exportRes.json.rejected.some((r:any)=>r.itemId===unapprovedItem.id)).toBe(true);
    // Only approved item got draft, not auto-approved
    const reviewU = db.query('SELECT approved_at FROM onboarding_review_state WHERE item_id = ?').get(unapprovedItem.id) as { approved_at: string | null } | undefined;
    expect(reviewU?.approved_at ?? null).toBeNull();
    // Batch audit parity for export
    const audit = db.query("SELECT message, details_json FROM audit_log WHERE entity_id = ? AND action = 'create_export_drafts' ORDER BY created_at DESC LIMIT 1").get(batch.id) as { message: string; details_json: string } | undefined;
    expect(audit).toBeTruthy();
    const details = JSON.parse(audit!.details_json);
    expect(details.createdCount).toBe(exportRes.json.createdCount);
    expect(details.rejectedCount).toBe(exportRes.json.rejectedCount);
    // Approval batch audit still correct
    const approveAudit = db.query("SELECT details_json FROM audit_log WHERE entity_id = ? AND action = 'bulk_approve' ORDER BY created_at DESC LIMIT 1").get(approveBatch) as { details_json: string } | undefined;
    expect(approveAudit).toBeTruthy();
  });

  it('concurrent approval with same Idempotency-Key does not double-advance', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-concurrent-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const [first, second] = await Promise.all([
      postApprove(batchId, itemIds, headers),
      postApprove(batchId, itemIds, headers),
    ]);
    // Both should succeed or one replays; neither should 500
    expect([first.status, second.status].every(s => s === 200)).toBe(true);
    expect(first.json.receiptId).toBeTruthy();
    expect(second.json.receiptId).toBeTruthy();
    expect(first.json.receiptId).toBe(second.json.receiptId);
    expect(first.json).toEqual(second.json);
    expect(first.json.approvedCount).toBe(2);
    // Exactly once: onboarding_review_state approved count and stage promotion
    const db = getDb();
    const approvedRows = db.query('SELECT COUNT(*) as c FROM onboarding_review_state WHERE batch_id = ? AND approved_at IS NOT NULL').get(batchId) as { c: number };
    expect(approvedRows.c).toBe(2);
    const promotedRows = db.query('SELECT COUNT(*) as c FROM onboarding_items WHERE batch_id = ? AND stage = ?').get(batchId, 'promotion') as { c: number };
    expect(promotedRows.c).toBe(2);
    const receipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(receipt).toBeTruthy();
    expect(receipt!.id).toBe(first.json.receiptId);
    // Audit written exactly once for this batch+key
    const auditRows = db.query("SELECT COUNT(*) as c FROM audit_log WHERE entity_id = ? AND action = 'bulk_approve'").get(batchId) as { c: number };
    // At least one audit; concurrent should not double-count
    expect(auditRows.c).toBe(1);
  });

  it('fault-injection during receipt claim rolls back with no partial state', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-fault-claim-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const beforeReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(beforeReceipt).toBeFalsy();
    const restore = injectFault('INSERT INTO onboarding_operation_receipts', 'injected receipt claim failure');
    let res: any;
    try {
      res = await postApprove(batchId, itemIds, headers);
    } catch {}
    restore();
    if (res) expect([500, 409].includes(res.status)).toBe(true);
    assertAllOrNothing(batchId, itemIds);
  });

  it('fault-injection during approval mutation rolls back receipt and audit', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-fault-approve-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const beforeReceipt = findByScopedIdempotencyKey(workspaceId, batchId, 'approve', key);
    expect(beforeReceipt).toBeFalsy();
    const restore = injectFault('UPDATE onboarding_review_state', 'injected approval mutation failure');
    let res: any;
    try { res = await postApprove(batchId, itemIds, headers); } catch {}
    restore();
    if (res) expect([500, 409].includes(res.status)).toBe(true);
    assertAllOrNothing(batchId, itemIds);
  });

  it('fault-injection during audit insertion rolls back approval and receipt completion', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-fault-audit-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const restore = injectFault('INSERT INTO audit_log', 'injected audit failure');
    let res: any;
    try { res = await postApprove(batchId, itemIds, headers); } catch {}
    restore();
    if (res) expect([500, 409].includes(res.status)).toBe(true);
    assertAllOrNothing(batchId, itemIds);
  });

  it('fault-injection during receipt completion leaves no completed receipt without audit', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const { batchId, itemIds } = makeReviewBatch(2);
    const key = 'idem-fault-complete-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const restore = injectFault('UPDATE onboarding_operation_receipts SET details_json', 'injected receipt completion failure');
    let res: any;
    try { res = await postApprove(batchId, itemIds, headers); } catch {}
    restore();
    if (res) expect([500, 409].includes(res.status)).toBe(true);
    assertAllOrNothing(batchId, itemIds);
  });

  it('fault-injection during draft insertion rolls back with no partial state', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'test-token-123';
    const batch = createBatch({ workspaceId, name: `ExportDraft-${randomUUID().slice(0,4)}`, fileName: 'd.csv', totalItems: 0 });
    const rows = Array.from({ length: 2 }, (_, i) => ({
      upc: `DRAFT-${randomUUID().slice(0,6)}-${i}`,
      name: `Product ${i}`,
      brandHint: 'Blue Buffalo',
      sourceUrl: null,
      rowNumber: i + 1,
      stage: 'promotion' as const,
      stageStatus: 'pending' as const,
    }));
    const inserted = insertItems(batch.id, rows, 'promotion' as any, 1);
    const ids = inserted.map(r => r.id);
    const db0 = getDb();
    const now = new Date().toISOString();
    for (const id of ids) {
      makeDraftReady(id);
      db0.run(
        `INSERT INTO onboarding_review_state (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason, approved_at, approved_by, approval_origin, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'test', ?, ?)`,
        [id, batch.id, now, 'tester', now, 'tester', now, now],
      );
    }
    const key = 'export-draft-fault-' + randomUUID();
    const headers = { Authorization: 'Bearer test-token-123', 'Idempotency-Key': key };
    const baselineChangeSetItems = (getDb().query('SELECT COUNT(*) as c FROM change_set_items').get() as { c: number }).c;
    const restore = injectFault('INSERT INTO change_set_items', 'injected draft insert failure');
    let res: any;
    try {
      const body = { itemIds: ids };
      const req = new Request(`http://localhost/api/onboarding/batches/${batch.id}/create-export-drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      const response = await app.fetch(req);
      res = { status: response.status, json: await response.json().catch(() => ({})) };
    } catch {}
    restore();
    if (res) expect([500, 409].includes(res.status)).toBe(true);
    assertAllOrNothing(batch.id, ids, { expectedApproved: 2, expectedPromoted: 2, baselineChangeSetItems });
  });
});
