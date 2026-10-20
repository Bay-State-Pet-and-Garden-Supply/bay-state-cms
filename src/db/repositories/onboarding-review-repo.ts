/**
 * Durable operator review/approval state (epic #46, Phases 1/7).
 *
 * The pipeline stage alone cannot answer the five questions the operator
 * read model needs (Curation complete / Review not started / Reviewed /
 * Approved / Exported). This repository owns the durable review and approval
 * record for each onboarding item:
 *
 * - `markReviewed` — written by the review-complete flow; re-review clears
 *   any prior approval (a fresh review supersedes the old release decision).
 * - `markReviewInvalidated` — a consequential edit after review invalidates
 *   the review AND clears any approval: the item must be re-reviewed and is
 *   never bulk-approvable while invalidated.
 * - `markApproved` — guarded write: requires an existing, non-invalidated
 *   review and no prior approval. Approval does NOT export anything.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { readStorageVersion, encodeForStorage, stagePredicateParams } from './onboarding-stage-vocabulary-repo';
import { validateListingEvidenceForReview } from '../../classification/review-completion-gate';

export interface OnboardingReviewState {
  itemId: string;
  batchId: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewInvalidatedAt: string | null;
  reviewInvalidationReason: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalOrigin: string;
  createdAt: string;
  updatedAt: string;
}

interface ReviewStateRow {
  item_id: string;
  batch_id: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_invalidated_at: string | null;
  review_invalidation_reason: string | null;
  approved_at: string | null;
  approved_by: string | null;
  approval_origin: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ReviewStateRow): OnboardingReviewState {
  return {
    itemId: row.item_id,
    batchId: row.batch_id,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewInvalidatedAt: row.review_invalidated_at,
    reviewInvalidationReason: row.review_invalidation_reason,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    approvalOrigin: row.approval_origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getReviewState(itemId: string): OnboardingReviewState | undefined {
  const db = getDb();
  const row = db.query(
    'SELECT * FROM onboarding_review_state WHERE item_id = ?',
  ).get(itemId) as ReviewStateRow | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * Load every review-state row for a batch, keyed by item id. One batched
 * query — used by the batch work-state projection.
 */
export function listReviewStates(batchId: string): Map<string, OnboardingReviewState> {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM onboarding_review_state WHERE batch_id = ?',
  ).all(batchId) as ReviewStateRow[];
  return new Map(rows.map(row => [row.item_id, mapRow(row)]));
}

export interface ExportDraftLink {
  itemId: string;
  changeSetId: string;
  draftId: string;
  status: string;
}

/** Read actual item→draft→change-set linkage. Completed export receipts own the
 * immutable origin binding; editable product JSON is only a legacy fallback.
 * A receipt alone is not a draft: its change set and matching record must exist. */
export function listExportDraftLinks(workspaceId: string, itemIds: string[]): Map<string, ExportDraftLink> {
  if (itemIds.length === 0) return new Map();
  const rows = getDb().query(
    `SELECT oi.id AS itemId, csi.id AS draftId, cs.id AS changeSetId, cs.status AS status
     FROM onboarding_items oi JOIN onboarding_batches b ON b.id = oi.batch_id
     JOIN change_sets cs ON cs.workspace_id = b.workspace_id AND cs.status != 'discarded'
      JOIN change_set_items csi ON csi.change_set_id = cs.id AND csi.sku = oi.upc
        AND csi.operation != 'discarded'
      WHERE b.workspace_id = ? AND oi.id IN (${itemIds.map(() => '?').join(',')})
        AND (
          EXISTS (
            SELECT 1 FROM onboarding_operation_receipts receipt
            JOIN json_each(CASE WHEN json_valid(receipt.details_json) THEN receipt.details_json ELSE '{}' END, '$.created') origin
            WHERE receipt.workspace_id = b.workspace_id AND receipt.batch_id = b.id
              AND receipt.operation = 'export' AND receipt.status = 'completed'
              AND json_extract(CASE WHEN json_valid(receipt.details_json) THEN receipt.details_json ELSE '{}' END, '$.changeSetId') = cs.id
              AND origin.value = oi.id
          )
          OR CASE WHEN json_valid(csi.draft_json) THEN json_extract(csi.draft_json, '$.itemId') END = oi.id
        )
     ORDER BY CASE cs.status WHEN 'pushed' THEN 4 WHEN 'approved' THEN 3 WHEN 'reviewing' THEN 2 ELSE 1 END ASC, cs.created_at ASC`,
  ).all(workspaceId, ...itemIds) as ExportDraftLink[];
  return new Map(rows.map(row => [row.itemId, row]));
}

/**
 * Record a durable human review. Upsert semantics: re-review replaces the
 * review timestamp and CLEARS any prior approval (a fresh review supersedes
 * the old release decision) plus any prior invalidation (the item is being
 * deliberately re-verified after an edit).
 */
export function markReviewed(input: { itemId: string; batchId: string; reviewedBy: string }): OnboardingReviewState {
  const db = getDb();
  const now = new Date().toISOString();
  // Ticket #124: review readiness refuses unresolved Listing Evidence
  // Gaps at the repository boundary (not only at route/UI layers) — a
  // direct markReviewed call can never make a gapped item review-ready.
  try {
    const gapRow = db.query('SELECT status FROM preparation_gaps WHERE item_id = ?').get(input.itemId) as
      | { status: string }
      | undefined;
    if (gapRow?.status === 'open') {
      throw new Error('preparation_gap_unresolved: resolve the open Listing Evidence Gap before review');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('preparation_gap_unresolved')) throw err;
    // Minimal DBs without the gaps table: no gap can be open.
  }
  const existing = getReviewState(input.itemId);
  const createdAt = existing?.createdAt ?? now;
  db.query(
    `INSERT INTO onboarding_review_state
       (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason,
        approved_at, approved_by, approval_origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'bulk', ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       reviewed_at = excluded.reviewed_at,
       reviewed_by = excluded.reviewed_by,
       review_invalidated_at = NULL,
       review_invalidation_reason = NULL,
       approved_at = NULL,
       approved_by = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.itemId, input.batchId, now, input.reviewedBy, createdAt, now);
  return getReviewState(input.itemId)!;
}

/**
 * Invalidate a durable review after a consequential edit. Also clears any
 * approval: the release decision no longer applies to the edited output.
 * No-op when the item was never reviewed (or already invalidated).
 *
 * @returns true when a review was actually invalidated.
 */
export function markReviewInvalidated(itemId: string, reason: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_review_state
     SET review_invalidated_at = ?, review_invalidation_reason = ?,
         approved_at = NULL, approved_by = NULL, updated_at = ?
     WHERE item_id = ? AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL`,
  ).run(now, reason, now, itemId);
  return result.changes > 0;
}

/**
 * Guarded approval write: requires an existing non-invalidated review and no
 * prior approval. Returns false (no write) when the durable state does not
 * support approval — the caller reports the item as rejected.
 */
export function markApproved(input: {
  itemId: string;
  batchId: string;
  approvedBy: string;
  origin?: string;
}): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.query(
    `UPDATE onboarding_review_state
     SET approved_at = ?, approved_by = ?, approval_origin = ?, updated_at = ?
     WHERE item_id = ? AND batch_id = ?
       AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL AND approved_at IS NULL`,
  ).run(now, input.approvedBy, input.origin ?? 'bulk', now, input.itemId, input.batchId);
  return result.changes > 0;
}

/**
 * Atomic bulk approval + review→promotion advance (epic #46 review
 * remediation, fix 1).
 *
 * The two writes — durable approval (`onboarding_review_state`) and the
 * item stage transition (`onboarding_items` review/completed →
 * promotion/pending) — happen in ONE transaction for the whole batch
 * operation (a stronger guarantee than per-item transactions: a concurrent
 * consequential edit can never interleave and leave an item in `promotion`
 * WITHOUT durable approval). Per-item failures are isolated via `continue`
 * (no throw), so one rejected item never rolls back the others.
 *
 * Guards mirror the existing single-write primitives: the approval UPDATE
 * requires an existing non-invalidated review and no prior approval; the
 * advance UPDATE requires the item to still be `review / completed` in the
 * SAME batch. A blocked semantic validation is refused exactly like the
 * diagnostics advance guard (`advanceReviewedItemsToPromotion`). When the
 * advance guard fails AFTER the approval write succeeded, the approval is
 * reverted inside the SAME transaction — no partial state escapes.
 *
 * Returns per-item structured outcomes (approved | rejected + reason).
 */
export function approveAndAdvanceItems(input: {
  itemIds: string[];
  batchId: string;
  approvedBy: string;
  origin?: string;
  principal?: string;
  role?: string;
  idempotencyKey?: string | null;
  workspaceId?: string;
  requestHash: string;
  preRejected?: Array<{ itemId: string; reason: string }>;
}): { approved: string[]; rejected: Array<{ itemId: string; reason: string }>; receiptId?: string } {
  const db = getDb();
  const now = new Date().toISOString();
  const approved: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];

  let receiptId: string | undefined;
  const requestHash = input.requestHash;
  if (!requestHash) throw new Error('requestHash is required');

  db.transaction(() => {
    // Slice 5a bridge (narrow D4 exception): per-transaction storage-version
    // read; the promotion write encodes the observed version, and its guard
    // matches the semantic review stage under either spelling.
    const promoVersion = readStorageVersion(db);
    const promoStage = encodeForStorage('create_drafts', promoVersion);
    // Resolve workspaceId for receipt
    let wsId = input.workspaceId ?? null;
    if (!wsId) {
      const batchRow = db.query('SELECT workspace_id FROM onboarding_batches WHERE id = ?').get(input.batchId) as { workspace_id: string } | undefined;
      wsId = batchRow?.workspace_id ?? null;
    }

    // Idempotent receipt handling with composite key + payload hash verification (P1-D)
    if (wsId) {
      if (input.idempotencyKey) {
        const existing = db.query(
          'SELECT id, request_hash, details_json, status FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?'
        ).get(wsId, input.batchId, 'approve', input.idempotencyKey) as { id: string; request_hash: string; details_json: string | null; status: string | null } | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            const err: any = new Error('payload_mismatch');
            err.code = 'payload_mismatch';
            err.existingReceiptId = existing.id;
            throw err;
          }
          // Interrupted started receipt — fail closed, do not re-execute
          if (existing.status === 'started' && !existing.details_json) {
            const err: any = new Error('operation_in_progress');
            err.code = 'operation_in_progress';
            err.existingReceiptId = existing.id;
            throw err;
          }
          if (existing.details_json) {
            try {
              const parsed = JSON.parse(existing.details_json) as { results?: Array<{ itemId: string; status: string; reason: string | null }>; approved?: string[]; rejected?: Array<{ itemId: string; reason: string }>; receiptId?: string; approvedCount?: number; rejectedCount?: number; audited?: boolean; principal?: string };
              if (Array.isArray(parsed.results) && typeof parsed.receiptId === 'string') {
                // Full envelope replay - extract approved/rejected from results for return value
                for (const r of parsed.results) {
                  if (r.status === 'approved') approved.push(r.itemId);
                  else rejected.push({ itemId: r.itemId, reason: r.reason ?? 'rejected' });
                }
                receiptId = parsed.receiptId;
                return;
              }
              if (Array.isArray(parsed.approved)) {
                approved.push(...parsed.approved);
                if (parsed.rejected) rejected.push(...parsed.rejected);
                receiptId = existing.id;
                return;
              }
            } catch {}
          }
          receiptId = existing.id;
          return;
        }
        receiptId = randomUUID();
        try {
          db.query(`INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at)
           VALUES (?, ?, ?, 'approve', ?, ?, ?, ?, ?, NULL, 'started', ?, NULL)`).run(receiptId!, wsId, input.batchId, input.principal ?? input.approvedBy, input.role ?? 'operator', now, input.idempotencyKey, requestHash, now);
        } catch (e) {
          const dup = db.query('SELECT id, request_hash, details_json, status FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?').get(wsId, input.batchId, 'approve', input.idempotencyKey) as { id: string; request_hash: string; details_json: string | null; status: string | null } | undefined;
          if (dup) {
            if (dup.request_hash !== requestHash) {
              const err: any = new Error('payload_mismatch');
              err.code = 'payload_mismatch';
              err.existingReceiptId = dup.id;
              throw err;
            }
            if (dup.status === 'started' && !dup.details_json) {
              const err: any = new Error('operation_in_progress');
              err.code = 'operation_in_progress';
              err.existingReceiptId = dup.id;
              throw err;
            }
            if (dup.details_json) {
              try {
                const parsed = JSON.parse(dup.details_json) as { approved?: string[]; rejected?: Array<{ itemId: string; reason: string }> };
                if (Array.isArray(parsed.approved)) {
                  approved.push(...parsed.approved);
                  if (parsed.rejected) rejected.push(...parsed.rejected);
                  receiptId = dup.id;
                  return;
                }
              } catch {}
            }
            receiptId = dup.id;
            return;
          }
          throw e;
        }
      } else {
        receiptId = randomUUID();
        db.query(`INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at)
         VALUES (?, ?, ?, 'approve', ?, ?, ?, NULL, ?, NULL, 'started', ?, NULL)`).run(receiptId!, wsId, input.batchId, input.principal ?? input.approvedBy, input.role ?? 'operator', now, requestHash, now);
      }
    }

    for (const id of input.itemIds) {
      const itemRow = db.query(
        `SELECT id, batch_id, stage, stage_status, curation_data_json
         FROM onboarding_items WHERE id = ?`,
      ).get(id) as
        | { id: string; batch_id: string; stage: string; stage_status: string; curation_data_json: string | null }
        | undefined;
      if (!itemRow) {
        rejected.push({ itemId: id, reason: 'item_not_found' });
        continue;
      }
      if (itemRow.batch_id !== input.batchId) {
        rejected.push({ itemId: id, reason: 'item_not_in_batch' });
        continue;
      }
      // Slice 5a bridge (narrow D4 exception): dual-spelling review guard —
      // the semantic review stage under either spelling (same pattern as
      // the item-repo claim predicate).
      const [reviewAltA, reviewAltB] = stagePredicateParams('review_listings');
      if (itemRow.stage !== reviewAltA && itemRow.stage !== reviewAltB || itemRow.stage_status !== 'completed') {
        rejected.push({ itemId: id, reason: `not_eligible:${itemRow.stage}/${itemRow.stage_status}` });
        continue;
      }
      let curation: {
        semanticValidation?: { status?: unknown; findings?: Array<{ message?: unknown }> };
      } | null = null;
      try {
        curation = itemRow.curation_data_json
          ? JSON.parse(itemRow.curation_data_json) as {
              semanticValidation?: { status?: unknown; findings?: Array<{ message?: unknown }> };
            }
          : null;
      } catch {
        rejected.push({ itemId: id, reason: 'invalid_curation_data' });
        continue;
      }
      const semanticValidation = curation?.semanticValidation;
      // Spec #120 (ticket #124): an unresolved Listing Evidence Gap blocks
      // review approval exactly like a blocked semantic validation. The gap
      // clears only when preparation validation succeeds (durable resolve),
      // never by clicking submit alone.
      try {
        const gapRow = db.query(
          'SELECT status FROM preparation_gaps WHERE item_id = ?',
        ).get(id) as { status: string } | undefined;
        if (gapRow?.status === 'open') {
          rejected.push({ itemId: id, reason: 'preparation_gap_unresolved' });
          continue;
        }
      } catch {
        // Minimal DBs without the gaps table: no gap can be open.
      }
      if (
        semanticValidation &&
        typeof semanticValidation === 'object' &&
        semanticValidation.status === 'blocked'
      ) {
        const findings = semanticValidation.findings;
        const firstMessage =
          Array.isArray(findings) && findings.length > 0 && typeof findings[0]?.message === 'string'
            ? findings[0].message
            : 'A hard cohort semantic validation finding blocks this item.';
        rejected.push({ itemId: id, reason: `semantic_validation_blocked: ${firstMessage}` });
        continue;
      }
      // Issue #366: durable approval refuses when the single listing-evidence
      // gate refuses. Grandfathers legacy rows (absent record passes); a
      // present-but-stale/blocked/unavailable record refuses with the gate
      // code. Fail closed on unexpected throw (never an invented pass).
      try {
        const wsPathRow = db.query('SELECT workspace_path FROM workspace LIMIT 1').get() as
          | { workspace_path: string }
          | undefined;
        const gate = validateListingEvidenceForReview(
          id,
          wsPathRow?.workspace_path ? { workspacePath: wsPathRow.workspace_path, workspaceId: input.workspaceId ?? wsId ?? undefined } : undefined,
        );
        if (gate && !gate.ok) {
          rejected.push({ itemId: id, reason: `${gate.code}: ${gate.reason}` });
          continue;
        }
      } catch {
        rejected.push({ itemId: id, reason: 'listing_evidence_unavailable: evaluation unavailable; resolve before approval.' });
        continue;
      }

      const approvalResult = db.query(
        `UPDATE onboarding_review_state
         SET approved_at = ?, approved_by = ?, approval_origin = ?, updated_at = ?
         WHERE item_id = ? AND batch_id = ?
           AND reviewed_at IS NOT NULL AND review_invalidated_at IS NULL AND approved_at IS NULL`,
      ).run(now, input.principal ?? input.approvedBy, input.origin ?? 'bulk', now, id, input.batchId);
      if (approvalResult.changes === 0) {
        const row = db.query(
          'SELECT reviewed_at, review_invalidated_at, approved_at FROM onboarding_review_state WHERE item_id = ?',
        ).get(id) as
          | { reviewed_at: string | null; review_invalidated_at: string | null; approved_at: string | null }
          | undefined;
        if (!row?.reviewed_at) {
          rejected.push({ itemId: id, reason: 'not_reviewed' });
        } else if (row.review_invalidated_at) {
          rejected.push({ itemId: id, reason: 'review_invalidated' });
        } else if (row.approved_at) {
          rejected.push({ itemId: id, reason: 'already_approved' });
        } else {
          rejected.push({ itemId: id, reason: 'approval_write_conflict' });
        }
        continue;
      }

      const advanceResult = db.query(
        `UPDATE onboarding_items
         SET stage = ?, stage_status = 'pending', error_message = NULL, retry_count = 0,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND batch_id = ? AND (stage = ? OR stage = ?) AND stage_status = 'completed'`,
      ).run(promoStage, now, id, input.batchId, reviewAltA, reviewAltB);
      if (advanceResult.changes > 0) {
        approved.push(id);
      } else {
        db.query(
          `UPDATE onboarding_review_state
           SET approved_at = NULL, approved_by = NULL, approval_origin = NULL, updated_at = ?
           WHERE item_id = ?`,
        ).run(now, id);
        rejected.push({ itemId: id, reason: 'advance_failed_state_changed' });
      }
    }

    // Update receipt with final details and insert audit logs atomically
    // Merge pre-validation rejections (phase 1) so mixed eligible/ineligible replays identically
    if (receiptId && wsId) {
      const pre = input.preRejected ?? [];
      const finalRejected = [...pre, ...rejected];
      const results = [
        ...approved.map(itemId => ({ itemId, status: 'approved' as const, reason: null as string | null })),
        ...finalRejected.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
      ];
      const envelope = {
        results,
        approvedCount: approved.length,
        rejectedCount: finalRejected.length,
        rejected: finalRejected,
        audited: true,
        receiptId: receiptId!,
        principal: input.principal ?? input.approvedBy,
      };
      const details = JSON.stringify(envelope);
      db.query("UPDATE onboarding_operation_receipts SET details_json = ?, status = 'completed', completed_at = ? WHERE id = ?").run(details, now, receiptId!);
      // Per-item audit
      for (const id of approved) {
        const aid = randomUUID();
        db.query(`INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at)
           VALUES (?, ?, 'onboarding_item', ?, 'bulk_approve', ?, ?, ?)`).run(aid, wsId, id, `Item approved for export (bulk approval by ${input.principal ?? input.approvedBy})`, JSON.stringify({ batchId: input.batchId, origin: input.origin ?? 'bulk' }), now);
      }
      // Batch audit — must include pre-validation rejections (item 6) — use finalRejected which already includes pre
      const batchAid = randomUUID();
      db.query(`INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at)
         VALUES (?, ?, 'onboarding_batch', ?, 'bulk_approve', ?, ?, ?)`).run(batchAid, wsId, input.batchId, `Bulk approval completed: ${approved.length} approved, ${finalRejected.length} rejected`, JSON.stringify({ approvedCount: approved.length, rejectedCount: finalRejected.length, approvedBy: input.principal ?? input.approvedBy }), now);
    }
  })();

  return { approved, rejected, receiptId };
}

export async function createExportDraftsWithReceipt(input: {
  itemIds: string[];
  batchId: string;
  requestedBy: string;
  principal: string;
  role: string;
  idempotencyKey?: string | null;
  workspaceId: string;
  requestHash: string;
  preRejected?: Array<{ itemId: string; reason: string }>;
}): Promise<{ created: string[]; rejected: Array<{ itemId: string; reason: string }>; receiptId?: string; changeSetId?: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const created: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];
  let receiptId: string | undefined;
  let changeSetId: string | undefined;
  const requestHash = input.requestHash;
  if (!requestHash) throw new Error('requestHash is required');
  if (!/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('requestHash must be 64-hex');

  const batch = db.query('SELECT workspace_id FROM onboarding_batches WHERE id = ?').get(input.batchId) as { workspace_id: string } | undefined;
  if (!batch || batch.workspace_id !== input.workspaceId) throw new Error('batch_workspace_mismatch');
  const workspace = db.query('SELECT workspace_path FROM workspace WHERE id = ?').get(input.workspaceId) as { workspace_path: string } | undefined;
  if (!workspace) throw new Error('workspace_not_found');

  // Replays must not redo asynchronous preparation. The same check below is
  // still the transactional authority when two requests prepare concurrently.
  if (input.idempotencyKey) {
    const existing = db.query(
      'SELECT id, request_hash, details_json, status FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?',
    ).get(input.workspaceId, input.batchId, 'export', input.idempotencyKey) as { id: string; request_hash: string; details_json: string | null; status: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash || (existing.status === 'started' && !existing.details_json)) {
        const code = existing.request_hash !== requestHash ? 'payload_mismatch' : 'operation_in_progress';
        throw Object.assign(new Error(code), { code, existingReceiptId: existing.id });
      }
      const details = existing.details_json ? JSON.parse(existing.details_json) : {};
      return { created: details.created ?? [], rejected: details.rejected ?? [], receiptId: existing.id, changeSetId: details.changeSetId };
    }
  }

  // Item state and linked records guard *all* keys, rather than trusting a
  // request receipt as the sole duplicate barrier. Re-read inside the final
  // transaction, after the native promoter's asynchronous preparation.
  const authorizeItem = (id: string): string | null => {
    const item = db.query('SELECT batch_id, stage, stage_status, upc FROM onboarding_items WHERE id = ?').get(id) as
      { batch_id: string; stage: string; stage_status: string; upc: string } | undefined;
    if (!item) return 'item_not_found';
    if (item.batch_id !== input.batchId) return 'item_not_in_batch';
    const [stageA, stageB] = stagePredicateParams('create_drafts');
    if ((item.stage !== stageA && item.stage !== stageB) || item.stage_status !== 'pending') return `not_eligible:${item.stage}/${item.stage_status}`;
    const review = getReviewState(id);
    if (review?.batchId !== input.batchId || !review.reviewedAt || !review.approvedAt || review.reviewInvalidatedAt) return 'not_approved';
    return listExportDraftLinks(input.workspaceId, [id]).has(id) ? 'already_drafted' : null;
  };
  const eligible: string[] = [];
  for (const id of new Set(input.itemIds)) {
    const reason = authorizeItem(id);
    if (reason) rejected.push({ itemId: id, reason });
    else eligible.push(id);
  }
  const { prepareDraftPromotion } = await import('../../onboarding/draft-promoter');
  const commitDrafts = eligible.length > 0
    ? await prepareDraftPromotion(input.workspaceId, workspace.workspace_path, input.batchId, eligible, { receiptOwned: true, authorizeItem })
    : null;

  db.transaction(() => {
    const wsId = input.workspaceId;
    const batchId = input.batchId;
    // Idempotent receipt handling for export
    if (input.idempotencyKey) {
      const existing = db.query(
        'SELECT id, request_hash, details_json, status FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?'
      ).get(wsId, batchId, 'export', input.idempotencyKey) as { id: string; request_hash: string; details_json: string | null; status: string | null } | undefined;
      if (existing) {
        rejected.length = 0;
        if (existing.request_hash !== requestHash) {
          const err: any = new Error('payload_mismatch');
          err.code = 'payload_mismatch';
          err.existingReceiptId = existing.id;
          throw err;
        }
        if (existing.status === 'started' && !existing.details_json) {
          const err: any = new Error('operation_in_progress');
          err.code = 'operation_in_progress';
          err.existingReceiptId = existing.id;
          throw err;
        }
        if (existing.details_json) {
          try {
            const parsed = JSON.parse(existing.details_json) as { created?: string[]; rejected?: Array<{ itemId: string; reason: string }>; changeSetId?: string; receiptId?: string };
            if (Array.isArray(parsed.created)) {
              created.push(...parsed.created);
              if (parsed.rejected) rejected.push(...parsed.rejected);
              changeSetId = parsed.changeSetId;
              receiptId = existing.id;
              return;
            }
          } catch {}
        }
        receiptId = existing.id;
        return;
      }
      receiptId = randomUUID();
      try {
        db.query(`INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at) VALUES (?, ?, ?, 'export', ?, ?, ?, ?, ?, NULL, 'started', ?, NULL)`).run(receiptId!, wsId, batchId, input.principal, input.role, now, input.idempotencyKey, requestHash, now);
      } catch (e) {
        const dup = db.query('SELECT id, request_hash, details_json, status FROM onboarding_operation_receipts WHERE workspace_id = ? AND batch_id = ? AND operation = ? AND idempotency_key = ?').get(wsId, batchId, 'export', input.idempotencyKey) as { id: string; request_hash: string; details_json: string | null; status: string | null } | undefined;
        if (dup) {
          rejected.length = 0;
          if (dup.request_hash !== requestHash) {
            const err: any = new Error('payload_mismatch');
            err.code = 'payload_mismatch';
            err.existingReceiptId = dup.id;
            throw err;
          }
          if (dup.status === 'started' && !dup.details_json) {
            const err: any = new Error('operation_in_progress');
            err.code = 'operation_in_progress';
            err.existingReceiptId = dup.id;
            throw err;
          }
          if (dup.details_json) {
            try {
              const parsed = JSON.parse(dup.details_json) as { created?: string[]; rejected?: Array<{ itemId: string; reason: string }>; changeSetId?: string };
              if (Array.isArray(parsed.created)) {
                created.push(...parsed.created);
                if (parsed.rejected) rejected.push(...parsed.rejected);
                changeSetId = parsed.changeSetId;
                receiptId = dup.id;
                return;
              }
            } catch {}
          }
          receiptId = dup.id;
          return;
        }
        throw e;
      }
    } else {
      receiptId = randomUUID();
      db.query(`INSERT INTO onboarding_operation_receipts (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at) VALUES (?, ?, ?, 'export', ?, ?, ?, NULL, ?, NULL, 'started', ?, NULL)`).run(receiptId!, wsId, batchId, input.principal, input.role, now, requestHash, now);
    }

    if (commitDrafts) {
      const result = commitDrafts();
      created.push(...result.created);
      rejected.push(...result.failures.map(f => ({ itemId: f.itemId, reason: f.error })));
      changeSetId = result.changeSetId ?? undefined;
    }

    // Merge pre-rejected for final envelope
    const pre = input.preRejected ?? [];
    const finalRejected = [...pre, ...rejected];
    const envelope = {
      created,
      rejected: finalRejected,
      changeSetId,
      receiptId: receiptId!,
      principal: input.principal,
      results: [
        ...created.map(itemId => ({ itemId, status: 'created' as const, reason: null as string | null })),
        ...finalRejected.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
      ],
      createdCount: created.length,
      rejectedCount: finalRejected.length,
      audited: true,
    };
    const details = JSON.stringify(envelope);
    db.query("UPDATE onboarding_operation_receipts SET details_json = ?, status = 'completed', completed_at = ? WHERE id = ?").run(details, now, receiptId!);
    // Audit logs
    for (const id of created) {
      const aid = randomUUID();
      db.query(`INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at) VALUES (?, ?, 'onboarding_item', ?, 'create_export_draft', ?, ?, ?)`).run(aid, wsId, id, `Export draft created for ${id} by ${input.principal}`, JSON.stringify({ batchId, changeSetId }), now);
    }
    const batchAid = randomUUID();
    db.query(`INSERT INTO audit_log (id, workspace_id, entity_type, entity_id, action, message, details_json, created_at) VALUES (?, ?, 'onboarding_batch', ?, 'create_export_drafts', ?, ?, ?)`).run(batchAid, wsId, batchId, `Export drafts: ${created.length} created, ${finalRejected.length} rejected`, JSON.stringify({ createdCount: created.length, rejectedCount: finalRejected.length, changeSetId, requestedBy: input.requestedBy }), now);
    // Return the same complete rejection scope on first execution and replay.
    rejected.splice(0, rejected.length, ...finalRejected);
  })();

  return { created, rejected, receiptId, changeSetId };
}
