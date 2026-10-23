import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { evaluateNotificationRules } from '../../server/services/store-manager-notification-service';
import { reconcileInbox } from '../../server/services/store-manager-inbox-service';
import { ensureNotificationRules, markNotificationRead } from '../../db/repositories/store-manager-notification-repo';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import type { InboxCandidate } from '../../server/services/store-manager-inbox-collectors';
import type { StoreManagerInboxKind } from '../../shared/schemas/store-manager-inbox';

/**
 * Notification rule engine (operations console, Issue 3). DB-backed: run
 * under `bun test`. Rule logic uses an injected deterministic collector seam;
 * linking/integration uses the real collectors. No model, no network.
 */

function candidate(
  kind: StoreManagerInboxKind,
  count: number,
  sourceRefs: Array<{ kind: string; id: string }> = [],
): InboxCandidate {
  return {
    workspaceId: 'ignored-by-observe',
    kind,
    dedupeKey: `${kind}:x:v1`,
    severity: 'warning',
    title: kind,
    summary: `${count}`,
    scope: { kind: 'catalog' },
    count,
    sourceRefs,
    fingerprint: 'f'.repeat(64),
    sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function collectOnly(kinds: Array<InboxCandidate>): () => InboxCandidate[] {
  return () => kinds;
}

describe('Store Manager notification rules (Issue 3)', () => {
  const testDbPath = './test-notifications.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${testDbPath}-wal`); } catch { /* ok */ }
  });

  it('seeds deterministic default rules (proposal backlog enabled, scheduled-report seam disabled)', () => {
    const rules = ensureNotificationRules('ws-rules-defaults');
    const byKind = Object.fromEntries(rules.map((r) => [r.kind, r]));
    expect(byKind.proposal_backlog_exceeded.enabled).toBe(true);
    expect(JSON.parse(byKind.proposal_backlog_exceeded.configJson)).toEqual({ threshold: 20 });
    expect(byKind.scheduled_report_new_fingerprint.enabled).toBe(false);
    expect(byKind.critical_issue_count_increased.enabled).toBe(true);
    expect(byKind.sync_failure_appeared.enabled).toBe(true);
    expect(byKind.image_integrity_dropped.enabled).toBe(true);
  });

  it('proposal backlog emits on threshold CROSSING only (no repeat chatter above)', () => {
    const ws = 'ws-proposal-cross';
    const proposal = (count: number) => [candidate('proposals_awaiting_review', count)];
    // First scan: 10 (below threshold 20) → no emission.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(proposal(10)) }).emitted).toHaveLength(0);
    // Crossing 10 → 21 → one emission.
    const crossed = evaluateNotificationRules(ws, { collect: collectOnly(proposal(21)) });
    expect(crossed.emitted).toHaveLength(1);
    expect(crossed.emitted[0].ruleKind).toBe('proposal_backlog_exceeded');
    expect(crossed.emitted[0].message).toContain('21');
    // Same count again → no chatter.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(proposal(21)) }).emitted).toHaveLength(0);
    // Higher but already crossed → still no new emission.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(proposal(25)) }).emitted).toHaveLength(0);
    // Drop below, then re-cross → a NEW emission (distinct fingerprint).
    evaluateNotificationRules(ws, { collect: collectOnly(proposal(5)) });
    const reCross = evaluateNotificationRules(ws, { collect: collectOnly(proposal(22)) });
    expect(reCross.emitted).toHaveLength(1);
    expect(reCross.emitted[0].fingerprint).not.toBe(crossed.emitted[0].fingerprint);
  });

  it('critical issue count emits on each increase, never on decrease/equality', () => {
    const ws = 'ws-critical';
    const critical = (count: number) => [candidate('high_severity_catalog_issues', count)];
    expect(evaluateNotificationRules(ws, { collect: collectOnly(critical(3)) }).emitted).toHaveLength(0);
    const up1 = evaluateNotificationRules(ws, { collect: collectOnly(critical(5)) });
    expect(up1.emitted).toHaveLength(1);
    expect(up1.emitted[0].message).toContain('3');
    expect(up1.emitted[0].message).toContain('5');
    expect(evaluateNotificationRules(ws, { collect: collectOnly(critical(5)) }).emitted).toHaveLength(0);
    expect(evaluateNotificationRules(ws, { collect: collectOnly(critical(4)) }).emitted).toHaveLength(0);
    const up2 = evaluateNotificationRules(ws, { collect: collectOnly(critical(7)) });
    expect(up2.emitted).toHaveLength(1);
    expect(up2.emitted[0].message).toContain('4');
    expect(up2.emitted[0].message).toContain('7');
  });

  it('sync failures emit per NEW source identity only', () => {
    const ws = 'ws-sync';
    const sync = (ids: string[]) => [
      candidate('failed_sync_jobs', ids.length, ids.map((id) => ({ kind: 'sync_job', id }))),
    ];
    // First evaluation records the baseline (job-1) — no transition yet.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(sync(['job-1'])) }).emitted).toHaveLength(0);
    // Same identity → no chatter.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(sync(['job-1'])) }).emitted).toHaveLength(0);
    // New identity → one new emission.
    const second = evaluateNotificationRules(ws, { collect: collectOnly(sync(['job-1', 'job-2'])) });
    expect(second.emitted).toHaveLength(1);
    expect(second.emitted[0].message).not.toContain('job-2');
    expect(second.emitted[0].title).not.toContain('sync');
    // An old failure disappears → no emission.
    expect(evaluateNotificationRules(ws, { collect: collectOnly(sync(['job-2'])) }).emitted).toHaveLength(0);
  });

  it('image integrity emits when the recommended-repairs count increases', () => {
    const ws = 'ws-image';
    const image = (count: number) => [candidate('image_repairs_recommended', count)];
    expect(evaluateNotificationRules(ws, { collect: collectOnly(image(2)) }).emitted).toHaveLength(0);
    const up = evaluateNotificationRules(ws, { collect: collectOnly(image(4)) });
    expect(up.emitted).toHaveLength(1);
    expect(up.emitted[0].title).not.toMatch(/integrity|change set/i);
    expect(evaluateNotificationRules(ws, { collect: collectOnly(image(4)) }).emitted).toHaveLength(0);
  });

  it('messages are deterministic templates with validated counts, never model prose', () => {
    const ws = 'ws-templates';
    // Baseline scan first (records state, emits nothing), then an increase.
    evaluateNotificationRules(ws, {
      collect: collectOnly([candidate('high_severity_catalog_issues', 9), candidate('proposals_awaiting_review', 25)]),
    });
    const emitted = evaluateNotificationRules(ws, {
      collect: collectOnly([candidate('high_severity_catalog_issues', 12), candidate('proposals_awaiting_review', 25)]),
    }).emitted;
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    for (const n of emitted) {
      expect(n.message).toMatch(/\d/);
      expect(n.message).not.toMatch(/[\n\r]{2,}/);
      expect(n.title.length).toBeLessThanOrEqual(200);
      expect(n.message.length).toBeLessThanOrEqual(2000);
    }
  });

  it('links notifications to their Inbox item (end-to-end via real collectors)', () => {
    const ws = 'ws-link';
    getDb().query(
      'INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ws, 'Link Store', `/tmp/link-${ws}`, `/tmp/link-${ws}/.git`, new Date().toISOString(), new Date().toISOString(), 'complete');
    // Seed rules FIRST, then lower the per-workspace backlog threshold so one
    // proposal crosses it.
    ensureNotificationRules(ws);
    getDb().query('UPDATE store_manager_notification_rules SET config_json = ? WHERE workspace_id = ? AND kind = ?')
      .run(JSON.stringify({ threshold: 1 }), ws, 'proposal_backlog_exceeded');
    // Baseline: no proposals → no emission.
    const baseline = reconcileInbox(ws);
    expect(baseline.items.some((i) => i.kind === 'proposals_awaiting_review')).toBe(false);
    expect(evaluateNotificationRules(ws).emitted).toHaveLength(0);
    // Proposal appears → crossing 0→1 emits and links the Inbox item.
    insertProposal({
      workspaceId: ws,
      field: 'ProductField24',
      oldValue: 'x',
      newValue: 'X',
      affectedSkus: ['SKU'],
      reason: 'casing',
      confidence: 0.9,
      source: 'deterministic',
      status: 'proposed',
    } as never);
    const reconciled = reconcileInbox(ws);
    expect(reconciled.items.some((i) => i.kind === 'proposals_awaiting_review')).toBe(true);
    const evalResult = evaluateNotificationRules(ws);
    const proposalNotif = evalResult.emitted.find((n) => n.ruleKind === 'proposal_backlog_exceeded');
    expect(proposalNotif).toBeDefined();
    expect(proposalNotif!.inboxItemId).not.toBeNull();
    const linked = reconciled.items.find((i) => i.id === proposalNotif!.inboxItemId);
    expect(linked?.kind).toBe('proposals_awaiting_review');
  });

  it('marking a notification read never resolves the source finding or inbox lifecycle', () => {
    const ws = 'ws-read';
    ensureNotificationRules(ws);
    const zero = candidate('proposals_awaiting_review', 0);
    // Baseline first (no emission), then cross the threshold.
    evaluateNotificationRules(ws, { collect: collectOnly([zero]) });
    const emitted = evaluateNotificationRules(ws, { collect: collectOnly([candidate('proposals_awaiting_review', 30)]) }).emitted;
    const notif = emitted.find((n) => n.ruleKind === 'proposal_backlog_exceeded');
    expect(notif).toBeDefined();
    expect(markNotificationRead(ws, notif!.id)).toBe(true);
    expect(markNotificationRead(ws, notif!.id)).toBe(false); // idempotent
    // The source proposal count is untouched; the rule snapshot is untouched.
    const rules = ensureNotificationRules(ws);
    expect(JSON.parse(rules.find((r) => r.kind === 'proposal_backlog_exceeded')!.lastSeenSnapshotJson ?? '{}').count).toBe(30);
  });

  it('emits are bounded and sequence is monotonic', () => {
    const ws = 'ws-bounds';
    const many = Array.from({ length: 30 }, (_, i) => candidate('failed_sync_jobs', 1, [{ kind: 'sync_job', id: `job-${i}` }]));
    const first = evaluateNotificationRules(ws, { collect: collectOnly([]) });
    // Baseline records state first; the NEXT scan emits the new identities.
    evaluateNotificationRules(ws, { collect: collectOnly(many) });
    const evalResult = evaluateNotificationRules(ws, { collect: collectOnly(many) });
    expect(evalResult.emitted.length).toBe(0);
    // Add 30 more identities on a later scan — emission is bounded.
    const more = Array.from({ length: 30 }, (_, i) => candidate('failed_sync_jobs', 1, [{ kind: 'sync_job', id: `job2-${i}` }]));
    const bounded = evaluateNotificationRules(ws, { collect: collectOnly(more) });
    expect(bounded.emitted.length).toBeLessThanOrEqual(20);
    expect(bounded.emitted.length).toBeGreaterThanOrEqual(1);
    const seqs = bounded.emitted.map((n) => n.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(bounded.latestSequence).toBeGreaterThanOrEqual(first.latestSequence);
  });
});
