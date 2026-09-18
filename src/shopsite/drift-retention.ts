/**
 * Drift 6/6 (#255) — audit-event retention and legacy blob prune.
 *
 * This slice owns NO first-time resolution or audit behavior: per-hunk
 * decisions and their audit events belong to the hunk slices (#253 single,
 * #254 bulk), and the pre-hunk resolve path already emits its own audit.
 * This service only:
 *
 * 1. Backfills compact audit evidence from legacy terminal `remote_drift`
 *    history (resumable, idempotent, bounded batches). Known facts from the
 *    row are preserved; missing actor/field/commit facts are never invented
 *    and are explicitly marked `unknown:legacy-history`.
 * 2. Verifies the audit evidence durably (re-reads `audit_log`) and only
 *    then deletes the corresponding blob-heavy row.
 * 3. Never touches outstanding work: `open` + `in_reconcile` rows are
 *    excluded from every read and re-excluded by the guarded delete.
 * 4. Measures honestly: exact reclaimed blob bytes for deleted rows plus
 *    reusable freelist capacity. File shrinkage is never promised — that
 *    needs a separately authorized VACUUM.
 */

import { getDb } from '../db/connection';
import {
  addAuditLog,
  hasDriftDecisionAudit,
  DRIFT_DECISION_AUDIT_ACTIONS,
} from '../db/repositories/audit-log-repo';
import {
  listLegacyTerminalBatch,
  countLegacyTerminal,
  estimateLegacyTerminalBlobChars,
  deleteLegacyTerminalById,
  getDriftCounts,
  DRIFT_RETENTION_BATCH_SIZE,
  type DriftRow,
} from '../db/repositories/drift-repo';

/** Audit action written by the backfill (part of the queryable decision set). */
export const DRIFT_BACKFILL_ACTION = 'drift_decision_backfilled';

/** Explicit marker for provenance that was never recorded. Never invented. */
export const UNKNOWN_LEGACY_PROVENANCE = 'unknown:legacy-history';

/** Whole-path default: one retention call processes at most 20 batches. */
export const DRIFT_RETENTION_DEFAULT_MAX_BATCHES = 20;
/** Hard cap so one call can never run unbounded. */
export const DRIFT_RETENTION_MAX_BATCHES_CAP = 200;

export const DRIFT_RETENTION_VACUUM_NOTE =
  'File size is unchanged: deleted blobs free pages into the SQLite freelist for reuse ' +
  '(see reusableFreelistBytes). Physical file shrinkage requires a separately authorized VACUUM ' +
  'and is not performed here.';

export interface RetentionRunOptions {
  /** Rows per batch (default 50, clamped to 1..200). */
  batchSize?: number;
  /** Batches per call (default 20, capped at 200). Rerun to continue. */
  maxBatches?: number;
  /** When true, measure and plan without writing audits or deleting rows. */
  dryRun?: boolean;
}

export interface RetentionRunResult {
  workspaceId: string;
  dryRun: boolean;
  /** Terminal rows that gained their first decision audit in this run. */
  backfilled: number;
  /** Terminal rows that already had decision audit (no new event needed). */
  alreadyCovered: number;
  /** Terminal rows deleted after verified audit. */
  pruned: number;
  /** Terminal rows still present (rerun to continue). */
  remaining: number;
  /** Rows skipped because verification failed (never deleted). */
  unverified: number;
  outstandingBefore: { open: number; reconcile: number; blocking: number };
  outstandingAfter: { open: number; reconcile: number; blocking: number };
  /** Exact UTF-8 bytes of blobs removed by this run's deletes. */
  reclaimedBlobBytes: number;
  /** Freelist reusable capacity after this run (bytes), null when unreadable. */
  reusableFreelistBytes: number | null;
  /** Database file size in bytes (page_count * page_size), null when unreadable. */
  fileBytes: number | null;
  vacuumNote: string;
}

export interface RetentionStats {
  workspaceId: string;
  terminalRows: number;
  /** Server-side TEXT-length estimate (chars, not bytes) — no blobs cross into JS. */
  terminalBlobCharsEstimate: number;
  outstanding: { open: number; reconcile: number; blocking: number; total: number };
  reusableFreelistBytes: number | null;
  fileBytes: number | null;
  vacuumNote: string;
}

type BackfillDecision = 'accepted' | 'rejected' | 'reconciled' | 'unknown';

function decisionForLegacyStatus(status: string): BackfillDecision {
  if (status === 'accepted_remote') return 'accepted';
  if (status === 'kept_local') return 'rejected';
  return 'unknown';
}

function utf8Bytes(value: string | null): number {
  if (!value) return 0;
  return Buffer.byteLength(value, 'utf8');
}

function parseLegacyDiff(diffJson: string | null): {
  fields: string[];
  baselineCommit: string | null;
  singleBaselineValue: string | null;
  singleRemoteValue: string | null;
} {
  if (!diffJson) return { fields: [], baselineCommit: null, singleBaselineValue: null, singleRemoteValue: null };
  try {
    const raw = JSON.parse(diffJson) as Record<string, unknown>;
    const hunks = (raw as { hunks?: unknown }).hunks;
    const fields: string[] = Array.isArray(hunks)
      ? [...new Set(hunks.filter((h) => h && typeof (h as { field?: unknown }).field === 'string')
          .map((h) => String((h as { field: string }).field)).filter((f) => f.length > 0))]
      : [];
    const baselineCommit = typeof raw.baselineCommit === 'string' ? (raw.baselineCommit as string) : null;
    let singleBaselineValue: string | null = null;
    let singleRemoteValue: string | null = null;
    if (Array.isArray(hunks) && hunks.length === 1) {
      const only = hunks[0] as { baselineValue?: unknown; remoteValue?: unknown };
      singleBaselineValue = only.baselineValue == null ? null : String(only.baselineValue);
      singleRemoteValue = only.remoteValue == null ? null : String(only.remoteValue);
    }
    return { fields, baselineCommit, singleBaselineValue, singleRemoteValue };
  } catch {
    return { fields: [], baselineCommit: null, singleBaselineValue: null, singleRemoteValue: null };
  }
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = 400;
  return err;
}

function clampBatchSize(raw: number | undefined): number {
  if (raw === undefined) return DRIFT_RETENTION_BATCH_SIZE;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw badRequest(`Invalid batchSize "${String(raw)}": must be a positive integer.`);
  }
  return Math.min(raw, DRIFT_RETENTION_BATCH_SIZE * 4);
}

function clampMaxBatches(raw: number | undefined): number {
  if (raw === undefined) return DRIFT_RETENTION_DEFAULT_MAX_BATCHES;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw badRequest(`Invalid maxBatches "${String(raw)}": must be a positive integer.`);
  }
  return Math.min(raw, DRIFT_RETENTION_MAX_BATCHES_CAP);
}

function readStorageCapacity(): { reusableFreelistBytes: number | null; fileBytes: number | null } {
  try {
    const db = getDb();
    const pageSize = db.query('PRAGMA page_size').get() as { page_size: number } | undefined;
    const pageCount = db.query('PRAGMA page_count').get() as { page_count: number } | undefined;
    const freelist = db.query('PRAGMA freelist_count').get() as { freelist_count: number } | undefined;
    const size = pageSize ? Number(pageSize.page_size) : NaN;
    if (!Number.isFinite(size) || size <= 0 || !pageCount || !freelist) {
      return { reusableFreelistBytes: null, fileBytes: null };
    }
    return {
      reusableFreelistBytes: Number(freelist.freelist_count) * size,
      fileBytes: Number(pageCount.page_count) * size,
    };
  } catch {
    return { reusableFreelistBytes: null, fileBytes: null };
  }
}

function buildBackfillDetails(row: DriftRow, nowIso: string): Record<string, unknown> {
  const parsed = parseLegacyDiff(row.diffJson);
  const missing: string[] = ['actor'];
  if (parsed.fields.length === 0) missing.push('field');
  if (!parsed.baselineCommit) missing.push('baselineCommit');
  const localBytes = utf8Bytes(row.localJson);
  const remoteBytes = utf8Bytes(row.remoteJson);
  const diffBytes = utf8Bytes(row.diffJson);
  return {
    sku: row.sku,
    decision: decisionForLegacyStatus(row.status),
    decisionSource: `legacy-status:${row.status}`,
    field: parsed.fields.length === 1 ? parsed.fields[0] : null,
    fields: parsed.fields,
    fieldProvenance: parsed.fields.length > 0 ? 'diff-hunks' : UNKNOWN_LEGACY_PROVENANCE,
    baselineValue: parsed.singleBaselineValue,
    remoteValue: parsed.singleRemoteValue,
    remoteHash: row.remoteHash,
    baselineCommit: parsed.baselineCommit,
    baselineCommitProvenance: parsed.baselineCommit ? 'diff-json' : UNKNOWN_LEGACY_PROVENANCE,
    reconcileChangeSetId: row.reconcileChangeSetId,
    detectedAt: row.detectedAt,
    legacyStatus: row.status,
    driftId: row.id,
    actor: UNKNOWN_LEGACY_PROVENANCE,
    actorProvenance: UNKNOWN_LEGACY_PROVENANCE,
    provenance: 'backfilled:legacy-history',
    missing,
    originalBlobBytes: { local: localBytes, remote: remoteBytes, diff: diffBytes, total: localBytes + remoteBytes + diffBytes },
    backfilledAt: nowIso,
  };
}

/**
 * Backfill compact audit evidence for legacy terminal rows, verify it, then
 * prune the blob-heavy rows. Resumable (loop until `remaining` is 0) and
 * idempotent (reruns create no duplicate audits and delete nothing new).
 */
export function runDriftRetention(workspaceId: string, options: RetentionRunOptions = {}): RetentionRunResult {
  const batchSize = clampBatchSize(options.batchSize);
  const maxBatches = clampMaxBatches(options.maxBatches);
  const dryRun = options.dryRun === true;

  const outstandingBefore = getDriftCounts(workspaceId);
  let backfilled = 0;
  let alreadyCovered = 0;
  let pruned = 0;
  let unverified = 0;
  let reclaimedBlobBytes = 0;

  if (dryRun) {
    // Measure without mutating: page through terminal rows with offsets and
    // count how many still lack decision audit.
    let wouldBackfill = 0;
    let wouldPrune = 0;
    let estimatedBytes = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = listLegacyTerminalBatch(workspaceId, batchSize, batch * batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (hasDriftDecisionAudit(workspaceId, row.id)) {
          alreadyCovered += 1;
        } else {
          wouldBackfill += 1;
        }
        wouldPrune += 1;
        estimatedBytes += utf8Bytes(row.localJson) + utf8Bytes(row.remoteJson) + utf8Bytes(row.diffJson);
      }
      if (rows.length < batchSize) break;
    }
    const capacity = readStorageCapacity();
    return {
      workspaceId,
      dryRun: true,
      backfilled: wouldBackfill,
      alreadyCovered,
      pruned: wouldPrune,
      remaining: countLegacyTerminal(workspaceId),
      unverified: 0,
      outstandingBefore,
      outstandingAfter: getDriftCounts(workspaceId),
      reclaimedBlobBytes: estimatedBytes,
      reusableFreelistBytes: capacity.reusableFreelistBytes,
      fileBytes: capacity.fileBytes,
      vacuumNote: DRIFT_RETENTION_VACUUM_NOTE,
    };
  }

  // Mutating path: always read the oldest remaining page (offset 0) so
  // deletes make progress without a cursor.
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = listLegacyTerminalBatch(workspaceId, batchSize, 0);
    if (rows.length === 0) break;
    for (const row of rows) {
      const rowBytes = utf8Bytes(row.localJson) + utf8Bytes(row.remoteJson) + utf8Bytes(row.diffJson);
      let covered = hasDriftDecisionAudit(workspaceId, row.id);
      if (!covered) {
        const nowIso = new Date().toISOString();
        const details = buildBackfillDetails(row, nowIso);
        const decision = String((details as { decision: unknown }).decision);
        addAuditLog({
          workspaceId,
          entityType: 'drift',
          entityId: row.id,
          action: DRIFT_BACKFILL_ACTION,
          message: `Backfilled drift decision for SKU "${row.sku}" from legacy ${row.status} history (decision: ${decision}; actor unknown)`,
          detailsJson: JSON.stringify(details),
        });
        // Durable verification: re-read before any delete.
        covered = hasDriftDecisionAudit(workspaceId, row.id);
        if (covered) {
          backfilled += 1;
        } else {
          unverified += 1;
          continue;
        }
      } else {
        alreadyCovered += 1;
      }
      const deleted = deleteLegacyTerminalById(row.id, workspaceId);
      if (deleted === 1) {
        pruned += 1;
        reclaimedBlobBytes += rowBytes;
      }
    }
    if (rows.length < batchSize) break;
  }

  const capacity = readStorageCapacity();
  return {
    workspaceId,
    dryRun: false,
    backfilled,
    alreadyCovered,
    pruned,
    remaining: countLegacyTerminal(workspaceId),
    unverified,
    outstandingBefore,
    outstandingAfter: getDriftCounts(workspaceId),
    reclaimedBlobBytes,
    reusableFreelistBytes: capacity.reusableFreelistBytes,
    fileBytes: capacity.fileBytes,
    vacuumNote: DRIFT_RETENTION_VACUUM_NOTE,
  };
}

/** Read-only storage + queue snapshot for honest capacity claims. */
export function getDriftRetentionStats(workspaceId: string): RetentionStats {
  const estimate = estimateLegacyTerminalBlobChars(workspaceId);
  const counts = getDriftCounts(workspaceId);
  const capacity = readStorageCapacity();
  return {
    workspaceId,
    terminalRows: estimate.rows,
    terminalBlobCharsEstimate: estimate.chars,
    outstanding: {
      open: counts.open,
      reconcile: counts.reconcile,
      blocking: counts.blocking,
      total: counts.total,
    },
    reusableFreelistBytes: capacity.reusableFreelistBytes,
    fileBytes: capacity.fileBytes,
    vacuumNote: DRIFT_RETENTION_VACUUM_NOTE,
  };
}

/** Re-exported so routes/tests share one decision-action vocabulary. */
export { DRIFT_DECISION_AUDIT_ACTIONS };
