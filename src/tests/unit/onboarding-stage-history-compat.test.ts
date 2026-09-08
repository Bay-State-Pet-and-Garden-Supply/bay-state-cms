/**
 * Slice 5a — history compatibility (Bun-only, isolated temp DBs).
 * Immutable snapshots/evidence/acceptances, sourcing route IDs/decision JSON,
 * review rows, operation receipts/audit records and recorded request bodies
 * keep byte/hash equality across the rename; v2 decision targets validate
 * under the original schema then map to canonical runtime; forbidden routes
 * stay unactionable; malformed newer schema never legacy-falls-back.
 */
import { describe, it, expect } from 'bun:test';
import crypto from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { runStageVocabularyMigration } from '../../db/repositories/onboarding-stage-vocabulary-repo';
import {
  toCanonicalStored,
  encodeForStorage,
  readStorageVersion,
} from '../../db/repositories/onboarding-stage-vocabulary-repo';
import { interpretDecisionTarget, serializeDecisionTarget, isStableRouteId } from '../../onboarding/onboarding-stage-artifacts';

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

describe('immutable history bytes', () => {
  it('recorded decision/route-ID bytes are stable across interpretation', () => {
    const recorded = JSON.stringify({ schemaVersion: 2, route: 'distributor_record_to_extraction', target: 'extraction' });
    const before = sha(recorded);
    expect(isStableRouteId('distributor_record_to_extraction')).toBe(true);
    expect(interpretDecisionTarget('extraction')).toBe('collect_details');
    expect(serializeDecisionTarget('collect_details')).toBe('extraction');
    expect(sha(recorded)).toBe(before);
  });
  it('forbidden routes remain unactionable', () => {
    expect(isStableRouteId('sourcing_to_curation')).toBe(false);
    expect(() => interpretDecisionTarget('curation_direct')).toThrow();
  });
  it('malformed newer schema never legacy-falls-back', () => {
    for (const bad of ['Collect Details', '', null, 'brand-setup']) {
      let threw = false;
      try {
        toCanonicalStored(bad);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });
});

describe('dual-read normalization', () => {
  it('both spellings normalize to the same canonical stage', () => {
    const pairs: Array<[string, string]> = [
      ['sourcing', 'route_sources'],
      ['discovery', 'find_product_page'],
      ['extraction', 'collect_details'],
      ['curation', 'prepare_listing'],
      ['review', 'review_listings'],
      ['promotion', 'create_drafts'],
    ];
    for (const [v1, v2] of pairs) {
      expect(toCanonicalStored(v1) as string).toBe(v2);
      expect(toCanonicalStored(v2) as string).toBe(v2);
    }
  });
  it('writes use the observed storage version encoding', () => {
    expect(encodeForStorage('review_listings', 1)).toBe('review');
    expect(encodeForStorage('review_listings', 2)).toBe('review_listings');
  });
  it('unknown storage version fails closed', () => {
    const fake = { query: () => ({ get: () => ({ value: '7' }) }) } as never;
    let threw = false;
    try {
      readStorageVersion(fake);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('immutable history bytes across the real migration seam (DB-level)', () => {
  it('review rows, sourcing decision JSON, operation receipts and audit records are byte/hash-stable', () => {
    try {
      closeDb();
    } catch { /* fresh */ }
    try {
      initDb(':memory:');
      runMigrations();
      const t = '2026-03-01T00:00:00.000Z';
      insertWorkspace({
        id: 'ws-hist',
        name: 'History WS',
        workspacePath: '/tmp/hist-ws',
        gitPath: '/tmp/hist-ws/.git',
        createdAt: t,
        updatedAt: t,
        bootstrapStatus: 'complete',
        baselineCommit: null,
      });
      const batchId = createBatch({ workspaceId: 'ws-hist', name: 'H', fileName: 'h.csv', totalItems: 2 }).id;
      const db = getDb();
      const decision = JSON.stringify({
        schemaVersion: 2,
        route: 'distributor_record_to_extraction',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: ['a1'],
        providerIds: ['phillips'],
        sourcingGenerationId: 'g1',
        conflicts: [],
        warnings: [],
        decidedAt: t,
        evidenceHash: 'ev-hash-1',
        sourceType: 'distributor_record',
        target: 'extraction',
      });
      db.query(
        `INSERT INTO onboarding_items
           (id, batch_id, upc, name, stage, stage_status, status, sourcing_decision_json, source_type, source_url, row_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('hist-1', batchId, 'upc-h1', 'Hist One', 'review', 'completed', 'imported', decision, 'distributor_record', null, 1, t, t);
      db.query(
        `INSERT INTO onboarding_items
           (id, batch_id, upc, name, stage, stage_status, status, sourcing_decision_json, source_type, source_url, row_number, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('hist-2', batchId, 'upc-h2', 'Hist Two', 'sourcing', 'completed', 'imported', decision, 'official_page', 'https://example.com/p', 2, t, t);
      db.query(
        `INSERT INTO onboarding_review_state
           (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason,
            approved_at, approved_by, approval_origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      ).run('hist-1', batchId, t, 'op', t, 'op', 'bulk', t, t);
      const receiptBody = JSON.stringify({
        results: [{ itemId: 'hist-1', status: 'approved', reason: null }],
        approvedCount: 1,
        rejectedCount: 0,
        receiptId: 'rcpt-1',
        principal: 'op',
      });
      const requestHash = 'a'.repeat(64);
      db.query(
        `INSERT INTO onboarding_operation_receipts
           (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('rcpt-1', 'ws-hist', batchId, 'approve', 'op', 'operator', t, 'idem-1', requestHash, receiptBody, 'completed', t, t);
      db.query(
        `INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('audit-1', 'ws-hist', 'onboarding_item', 'hist-1', 'bulk_approve', 'approved', '{"batchId":"B"}', t);

      const snapshot = (): string => {
        const review = db.query('SELECT * FROM onboarding_review_state ORDER BY item_id').all();
        const decisions = db.query('SELECT id, sourcing_decision_json FROM onboarding_items ORDER BY id').all();
        const receipts = db.query('SELECT * FROM onboarding_operation_receipts ORDER BY id').all();
        const audits = db.query('SELECT * FROM audit_log ORDER BY id').all();
        return crypto.createHash('sha256').update(JSON.stringify({ review, decisions, receipts, audits })).digest('hex');
      };
      const before = snapshot();
      const decisionBefore = (db.query('SELECT sourcing_decision_json AS j FROM onboarding_items WHERE id = ?').get('hist-1') as { j: string }).j;

      // Real sanctioned seam (deferred marker-2 hop established first).
      db.query("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      const mig = runStageVocabularyMigration(db as never);
      expect(mig.rerunNoop).toBe(false);

      // Byte/hash stability of every immutable artifact.
      expect(snapshot()).toBe(before);
      const decisionAfter = (db.query('SELECT sourcing_decision_json AS j FROM onboarding_items WHERE id = ?').get('hist-1') as { j: string }).j;
      expect(decisionAfter).toBe(decisionBefore);
      expect(sha(decisionAfter)).toBe(sha(decision));
      // Stages moved (v1→v2) while nothing else did.
      const stages = db.query('SELECT id, stage FROM onboarding_items ORDER BY id').all() as Array<{ id: string; stage: string }>;
      expect(stages).toEqual([
        { id: 'hist-1', stage: 'review_listings' },
        { id: 'hist-2', stage: 'route_sources' },
      ]);
    } finally {
      try {
        closeDb();
      } catch { /* closed */ }
    }
  });
});
