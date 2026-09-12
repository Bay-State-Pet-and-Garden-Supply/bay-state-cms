import { getDb } from '../db/connection';
import { findItemById, updateItemStageStatus, storedStageIs } from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import {
  getPreparationGap,
  recordGapCorrection,
  markCorrectionRun,
  type GapCorrectionEnvelope,
  type PreparationGap,
} from '../db/repositories/preparation-gap-repo';
import {
  claimReceipt,
  completeReceipt,
  computeGapCorrectionHash,
  failReceipt,
  type OperationReceipt,
} from '../db/repositories/onboarding-operation-receipt-repo';
import { markReviewInvalidated } from '../db/repositories/onboarding-review-repo';
import type { Principal } from '../server/authenticated-principal';

/**
 * Ticket #124: operator gap-correction commands (record + resume).
 *
 * One command = one receipt (`gap_correction`): record the attributed
 * correction envelope against the open gap, invalidate prior review, and
 * make the item worker-eligible for re-preparation from retained evidence.
 * The gap itself stays open — it clears only when re-preparation
 * validation succeeds (resolveAfterValidation, owned by the worker path).
 *
 * No source evidence is touched here; no refetch is triggered. Replay with
 * the same idempotency key + command hash returns the prior acceptance.
 */

export interface GapCorrectionCommand {
  workspaceId: string;
  itemId: string;
  values: Record<string, unknown>;
  expectedEvidenceHash?: string | null;
  expectedUpdatedAt?: string | null;
  idempotencyKey: string;
}

export type GapCorrectionResult =
  | { ok: true; replay: boolean; receipt: OperationReceipt; gap: PreparationGap; envelope: GapCorrectionEnvelope }
  | { ok: false; code: string; message: string; status: number };

function boundValues(values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim()) out[k.slice(0, 64)] = v.slice(0, 2000);
  }
  return out;
}

export function recordCorrectionAndResume(
  command: GapCorrectionCommand,
  principal: Principal,
): GapCorrectionResult {
  const bounded = boundValues(command.values);
  if (Object.keys(bounded).length === 0) {
    return { ok: false, code: 'invalid_correction', message: 'Correction carries no usable values', status: 400 };
  }
  const db = getDb();
  const item = findItemById(command.itemId);
  if (!item) return { ok: false, code: 'not_found', message: 'Item not found', status: 404 };
  const batchId = (item as { batchId: string }).batchId;
  if (!batchId) return { ok: false, code: 'wrong_scope', message: 'Item has no batch', status: 404 };
  const batch = findBatchById(batchId);
  if (!batch || (batch as { workspaceId: string }).workspaceId !== command.workspaceId) {
    return { ok: false, code: 'wrong_scope', message: 'Item is not in this workspace', status: 404 };
  }
  const gap = getPreparationGap(command.itemId);
  if (!gap) return { ok: false, code: 'no_gap', message: 'No preparation gap for item', status: 404 };
  if (gap.status !== 'open') return { ok: false, code: 'gap_not_open', message: 'Preparation gap is not open', status: 409 };
  // Corrections resume preparation in place: the item must still be in
  // Prepare listing (review/promotion items are guarded downstream and
  // never silently pulled back by a correction).
  if (!storedStageIs((item as { stage: unknown }).stage, 'prepare_listing')) {
    return { ok: false, code: 'wrong_stage', message: 'Item is not in Prepare listing', status: 409 };
  }

  const requestHash = computeGapCorrectionHash({
    workspaceId: command.workspaceId,
    batchId,
    itemId: command.itemId,
    expectedEvidenceHash: command.expectedEvidenceHash ?? null,
    expectedUpdatedAt: command.expectedUpdatedAt ?? null,
    values: bounded,
    principal: principal.actor,
  });

  const run = db.transaction(() => {
    const claim = claimReceipt({
      workspaceId: command.workspaceId,
      batchId,
      operation: 'gap_correction',
      principal: principal.actor,
      role: principal.role,
      idempotencyKey: command.idempotencyKey,
      requestHash,
    });
    if (claim.isConflict) {
      return { ok: false as const, code: 'idempotency_conflict', message: 'Idempotency key was used with a different correction', status: 409 };
    }
    // Ticket #124 P1-3: replay only a LIVE acceptance — the gap must still
    // be open and its envelope still recorded/preparing. A refresh
    // preserves the revision number while flipping the envelope to
    // superseded, so revision equality alone would resurrect a dead
    // envelope. Post-resolve replay stays a 409 via the open-gap check
    // above (a resolved gap needs no correction command).
    if (claim.isReplay && claim.receipt.detailsJson) {
      try {
        const prior = JSON.parse(claim.receipt.detailsJson) as { revision?: number };
        const live = getPreparationGap(command.itemId);
        const liveEnvelope = live?.status === 'open' ? live.correctionEnvelope : null;
        if (
          liveEnvelope
          && (liveEnvelope.status === 'recorded' || liveEnvelope.status === 'preparing')
          && (!prior || prior.revision === liveEnvelope.revision)
        ) {
          return {
            ok: true as const, replay: true, receipt: claim.receipt, gap: live, envelope: liveEnvelope,
          };
        }
      } catch {
        // Corrupt receipt details never replay — fall through and re-record.
      }
    }
    if (claim.isInterrupted) {
      return { ok: false as const, code: 'interrupted_command', message: 'A previous correction command was interrupted; retry with a new idempotency key', status: 409 };
    }
    let recorded: { gap: PreparationGap; envelope: GapCorrectionEnvelope };
    try {
      recorded = recordGapCorrection({
        itemId: command.itemId,
        values: bounded,
        actor: principal.actor,
        role: principal.role,
        expectedEvidenceHash: command.expectedEvidenceHash,
        expectedUpdatedAt: command.expectedUpdatedAt,
        receiptId: claim.receipt.id,
      });
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      const message = err instanceof Error ? err.message : 'correction failed';
      // Ticket #124 P2-6: coded validation failures fail the claimed
      // receipt instead of leaving it started — a fixable 400/422 must
      // not force the caller onto a new idempotency key via
      // 409-interrupted. Unexpected errors rethrow (transaction rolls
      // back the started row).
      if (code === 'stale_gap') {
        try { failReceipt(claim.receipt.id, JSON.stringify({ code, message })); } catch { /* best-effort */ }
        return { ok: false as const, code: 'stale_gap', message, status: 409 };
      }
      if (code === 'correction_incomplete') {
        try { failReceipt(claim.receipt.id, JSON.stringify({ code, message })); } catch { /* best-effort */ }
        return { ok: false as const, code: 'correction_incomplete', message, status: 422 };
      }
      if (code === 'invalid_field' || code === 'invalid_actor') {
        try { failReceipt(claim.receipt.id, JSON.stringify({ code, message })); } catch { /* best-effort */ }
        return { ok: false as const, code, message, status: 400 };
      }
      if (code === 'no_gap' || code === 'gap_not_open') {
        try { failReceipt(claim.receipt.id, JSON.stringify({ code, message })); } catch { /* best-effort */ }
        return { ok: false as const, code, message, status: 409 };
      }
      throw err;
    }
    // Prior review no longer applies to the corrected output.
    try {
      markReviewInvalidated(command.itemId, 'gap correction recorded');
    } catch {
      // Review table absence (minimal DBs) never blocks correction.
    }
    // Worker-eligible for re-preparation from retained evidence. No new
    // sourcing generation, no refetch — preparation reruns only.
    updateItemStageStatus(command.itemId, 'pending', null);
    try {
      markCorrectionRun({ itemId: command.itemId, revision: recorded.envelope.revision, runId: null, status: 'preparing' });
      recorded = { gap: getPreparationGap(command.itemId)!, envelope: getPreparationGap(command.itemId)!.correctionEnvelope! };
    } catch {
      // Status transition is best-effort here; the recorded envelope stands.
    }
    completeReceipt(claim.receipt.id, JSON.stringify({
      revision: recorded.envelope.revision,
      correctionHash: recorded.envelope.correctionHash,
      itemId: command.itemId,
    }));
    return { ok: true as const, replay: false, receipt: claim.receipt, gap: recorded.gap, envelope: recorded.envelope };
  });

  return run() as GapCorrectionResult;
}
