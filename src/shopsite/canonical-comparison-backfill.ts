/**
 * Canonical comparison backfill (issue #256).
 *
 * Rebuilds product_index comparison caches from approved catalog data only.
 * The import/check slice (#252) owns the canonical comparison value; the
 * remaining writers (push, approval, drift acceptance, maintenance reindex)
 * now write it directly, but databases created before the cutover still carry
 * legacy `hashJson` values that never match canonical drift hashes. This
 * service migrates those rows safely:
 *
 * - product_hash is recomputed from the pinned approved Git HEAD file (or the
 *   working-tree file when no HEAD exists). Approved data only — never from
 *   remote observations or drift rows.
 * - Historical remote equality is never inferred from current local products:
 *   backfill never writes lastSyncedRemoteHash/lastSyncedAt based on the
 *   local file. A row whose cached hash was stale is demoted to the explicit
 *   unverified pending-recheck state (not_synced with null sync pointers)
 *   rather than a manufactured synced or drifted status. The next drift check
 *   repopulates observation and proves equality honestly.
 * - Where the approved source cannot be reconstructed (file missing at HEAD
 *   and on disk), the row stays unverified pending recheck — never deleted,
 *   never marked synced/drifted.
 * - Resumable and repeat-safe: SKUs process in sorted batches with a durable
 *   per-workspace cursor in app_meta. Reruns and interrupted runs converge
 *   (already-canonical rows are no-ops). Bounded batches keep memory flat.
 * - Classification source-hash semantics are untouched: this service never
 *   reads or writes classification_runs, benchmarks, or any
 *   computeProductHash value.
 */

import { getDb } from '../db/connection';
import { comparisonHashForProduct } from './catalog-comparison';
import { findProductBySku, updateProductIndex } from '../db/repositories/product-index-repo';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import { readProductFile } from '../git/workspace-files';
import type { Product } from '../shared/types';

export const CANONICAL_BACKFILL_VERSION = 'canonical-comparison-backfill-v1';
export const CANONICAL_BACKFILL_VERSION_KEY = 'canonical_comparison_backfill_version';
export const CANONICAL_BACKFILL_BATCH_SIZE = 50;
export const CANONICAL_BACKFILL_MAX_BATCHES_CAP = 200;

export function canonicalBackfillCursorKey(workspaceId: string): string {
  return `canonical_comparison_backfill_cursor:${workspaceId}`;
}

export function canonicalBackfillDoneKey(workspaceId: string): string {
  return `canonical_comparison_backfill_done:${workspaceId}`;
}

export interface CanonicalBackfillOptions {
  /** Rows per batch (default 50, clamped to 1..200). */
  batchSize?: number;
  /** Batches per call (default: all remaining, capped at 200). Rerun to continue. */
  maxBatches?: number;
  /** Resume after this SKU (exclusive). Defaults to the durable cursor. */
  cursor?: string | null;
}

export interface CanonicalBackfillResult {
  workspaceId: string;
  /** Rows whose product_hash was stale and is now canonical. */
  rebuilt: number;
  /** Rows already canonical (no write). */
  alreadyCanonical: number;
  /** Rows left in unverified pending-recheck (stale or missing source). */
  unverified: number;
  /** Rows with no reconstructible approved source (file missing). */
  missingSource: number;
  /** Remaining rows awaiting a follow-up run (0 means complete). */
  remaining: number;
  /** Durable cursor for resuming (last processed SKU, or null when complete). */
  cursor: string | null;
  /** True when every indexed SKU has been visited at least once. */
  complete: boolean;
}

function clampBatchSize(raw: number | undefined): number {
  if (raw === undefined) return CANONICAL_BACKFILL_BATCH_SIZE;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    const err = new Error(`Invalid batchSize "${String(raw)}": must be a positive integer.`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return Math.min(raw, CANONICAL_BACKFILL_BATCH_SIZE * 4);
}

function clampMaxBatches(raw: number | undefined): number {
  if (raw === undefined) return CANONICAL_BACKFILL_MAX_BATCHES_CAP;
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    const err = new Error(`Invalid maxBatches "${String(raw)}": must be a positive integer.`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return Math.min(raw, CANONICAL_BACKFILL_MAX_BATCHES_CAP);
}

function readCursor(workspaceId: string): string | null {
  try {
    const db = getDb();
    const row = db.query('SELECT value FROM app_meta WHERE key = ?').get(
      canonicalBackfillCursorKey(workspaceId),
    ) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeCursor(workspaceId: string, cursor: string | null): void {
  try {
    const db = getDb();
    if (cursor === null) {
      db.run('DELETE FROM app_meta WHERE key = ?', [canonicalBackfillCursorKey(workspaceId)]);
    } else {
      db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        canonicalBackfillCursorKey(workspaceId),
        cursor,
      ]);
    }
  } catch {
    // Cursor is resumability-only; a missing app_meta table never fails the backfill itself.
  }
}

function markDone(workspaceId: string): void {
  try {
    const db = getDb();
    db.run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      canonicalBackfillDoneKey(workspaceId),
      CANONICAL_BACKFILL_VERSION,
    ]);
    db.run('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', [
      CANONICAL_BACKFILL_VERSION_KEY,
      CANONICAL_BACKFILL_VERSION,
    ]);
  } catch {
    // Best-effort completion marker.
  }
}

/**
 * Read the approved catalog product for one SKU: HEAD content when the
 * workspace is a Git repo with a HEAD, otherwise the working-tree file.
 * Returns null when neither source exists (cannot reconstruct).
 */
function readApprovedProduct(workspacePath: string, sku: string): Product | null {
  try {
    const git = new GitClient(workspacePath);
    if (git.isRepo()) {
      try {
        const head = git.getHeadHash();
        if (head) {
          const content = git.readFileAtHead(skuToProductFilePath(sku));
          if (content) return JSON.parse(content) as Product;
          // File absent at HEAD: genuinely no approved source for this SKU.
          // Fall through to working-tree only when there is no HEAD at all;
          // a dirty working tree must never stand in for approved state.
          return null;
        }
      } catch {
        // HEAD unreadable: fall through to working-tree attempt below.
      }
      // No HEAD yet (uncommitted workspace): working-tree file is the only
      // approved-data candidate available.
      try {
        return readProductFile(workspacePath, sku);
      } catch {
        return null;
      }
    }
  } catch {
    // Git failures never manufacture data; try the working tree.
  }
  try {
    return readProductFile(workspacePath, sku);
  } catch {
    return null;
  }
}

function listSkuBatch(afterSku: string | null, limit: number): string[] {
  const db = getDb();
  const rows = (afterSku
    ? db.query('SELECT sku FROM product_index WHERE sku > ? ORDER BY sku ASC LIMIT ?').all(afterSku, limit)
    : db.query('SELECT sku FROM product_index ORDER BY sku ASC LIMIT ?').all(limit)) as Array<{ sku: string }>;
  return rows.map((r) => String(r.sku));
}

function countRemaining(afterSku: string | null): number {
  const db = getDb();
  try {
    const row = (afterSku
      ? db.query('SELECT COUNT(*) as cnt FROM product_index WHERE sku > ?').get(afterSku)
      : db.query('SELECT COUNT(*) as cnt FROM product_index').get()) as { cnt: number };
    return Number(row.cnt);
  } catch {
    return 0;
  }
}

/**
 * Rebuild stale comparison caches from approved catalog data.
 *
 * Idempotent: rerunning over already-canonical rows writes nothing.
 * Resumable: pass no cursor to continue from the durable cursor; each call
 * processes at most maxBatches * batchSize SKUs in SKU order.
 */
export function runCanonicalComparisonBackfill(
  workspaceId: string,
  workspacePath: string,
  options: CanonicalBackfillOptions = {},
): CanonicalBackfillResult {
  const batchSize = clampBatchSize(options.batchSize);
  const maxBatches = clampMaxBatches(options.maxBatches);
  let cursor: string | null = options.cursor !== undefined ? options.cursor : readCursor(workspaceId);

  let rebuilt = 0;
  let alreadyCanonical = 0;
  let unverified = 0;
  let missingSource = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const skus = listSkuBatch(cursor, batchSize);
    if (skus.length === 0) {
      cursor = null;
      writeCursor(workspaceId, null);
      markDone(workspaceId);
      break;
    }
    for (const sku of skus) {
      const row = findProductBySku(sku);
      cursor = sku;
      if (!row) continue;
      const approved = readApprovedProduct(workspacePath, sku);
      if (!approved) {
        // Cannot reconstruct the approved source: stay explicitly unverified
        // pending recheck rather than manufacturing synced or drifted status.
        // Demote stale synced/drifted signals to not_synced without inventing
        // pointers; already-unverified rows are untouched (repeat-safe).
        missingSource += 1;
        if (row.syncStatus === 'synced' || row.syncStatus === 'drifted') {
          try {
            updateProductIndex({
              sku,
              syncStatus: 'not_synced',
              lastPulledRemoteHash: null,
              lastSyncedRemoteHash: null,
              lastSyncedAt: null,
            });
            unverified += 1;
          } catch {
            // Best-effort demotion; the row stays for the next run.
          }
        } else {
          unverified += 1;
        }
        continue;
      }
      let canonical: string;
      try {
        canonical = comparisonHashForProduct(approved);
      } catch {
        // Uncomputable projection: leave unverified, never manufacture.
        unverified += 1;
        continue;
      }
      if (row.productHash === canonical) {
        alreadyCanonical += 1;
        continue;
      }
      // Stale cache: rebuild from approved data only. Never infer historical
      // remote equality from the current local product, so the row moves to
      // the explicit unverified pending-recheck state (not_synced, null sync
      // pointers). The next drift check repopulates observation honestly and
      // proves synced only on a real canonical match.
      try {
        updateProductIndex({
          sku,
          productHash: canonical,
          syncStatus: 'not_synced',
          lastSyncedRemoteHash: null,
          lastSyncedAt: null,
          lastPulledRemoteHash: null,
        });
        rebuilt += 1;
        unverified += 1;
      } catch {
        // Row-level failure never aborts the batch; the cursor has already
        // advanced past prior SKUs and this SKU retries on the next run.
      }
    }
    writeCursor(workspaceId, cursor);
    if (skus.length < batchSize) {
      // Exhausted the index: clear the cursor and record completion.
      cursor = null;
      writeCursor(workspaceId, null);
      markDone(workspaceId);
      break;
    }
  }

  const remaining = cursor ? countRemaining(cursor) : 0;
  if (remaining === 0 && cursor !== null) {
    writeCursor(workspaceId, null);
    markDone(workspaceId);
    cursor = null;
  }
  return {
    workspaceId,
    rebuilt,
    alreadyCanonical,
    unverified,
    missingSource,
    remaining,
    cursor,
    complete: remaining === 0,
  };
}

/** Read-only progress snapshot without mutating any row or the cursor. */
export function getCanonicalBackfillProgress(workspaceId: string): {
  workspaceId: string;
  cursor: string | null;
  done: boolean;
  version: string | null;
} {
  let version: string | null;
  try {
    const db = getDb();
    const row = db.query('SELECT value FROM app_meta WHERE key = ?').get(
      canonicalBackfillDoneKey(workspaceId),
    ) as { value: string } | undefined;
    version = row?.value ?? null;
  } catch {
    version = null;
  }
  return { workspaceId, cursor: readCursor(workspaceId), done: version === CANONICAL_BACKFILL_VERSION, version };
}
