/**
 * Review filename preview + warnings (issue #109).
 *
 * Makes more-information page file-name problems visible BEFORE approval:
 * every draft in a batch shows its computed file name in the Review drawer,
 * base-name collisions within the batch name the conflicting drafts, and
 * collisions against live catalog products identify the catalog product.
 *
 * Single source of truth: preview names reuse the promotion derivation
 * (`assignPromotionFileNames` / `resolvePromotionBaseName` from
 * draft-promoter, backed by `shopsite/file-name`) — the preview a reviewer
 * sees matches what a full-batch promotion would persist. Nothing here
 * reimplements slugging. Displayed suffixes are batch-scoped: partial
 * promotions may renumber them, so the warning message says so and accepts
 * stay keyed to the base name.
 *
 * Approval gating: warned items need an explicit operator decision recorded
 * in Classification History (`filename_warning_accepted` /
 * `filename_warning_deferred`). Accepts suppress the gate ONLY for
 * batch-internal warnings on the accepted base name (retitles re-warn);
 * catalog collisions can never be accepted — only a retitle (recompute) or
 * defer resolves them.
 */
import { getDb } from '../db/connection';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { listProducts } from '../db/repositories/product-index-repo';
import { recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { readProductFile } from '../git/workspace-files';
import { assignPromotionFileNames, resolvePromotionBaseName } from './draft-promoter';
import { findDuplicateFileNames, resolveBaseFileName } from '../shopsite/file-name';
import type { OnboardingItem } from '../shared/schemas/onboarding';

export const FILENAME_WARNING_BATCH = 'filename_collision_batch' as const;
export const FILENAME_WARNING_CATALOG = 'filename_collision_catalog' as const;
export type FilenameWarningCode = typeof FILENAME_WARNING_BATCH | typeof FILENAME_WARNING_CATALOG;

export interface FilenameWarning {
  code: FilenameWarningCode;
  /** Reviewer-facing message naming the conflict. */
  message: string;
  /** The colliding file name. */
  fileName: string;
  /** Batch case: other drafts sharing the base name (UPCs). */
  conflictingUpcs: string[];
  /** Batch case: their display titles. */
  conflictingTitles: string[];
  /** Catalog case: the live product's SKU. */
  catalogSku?: string | null;
  /** Catalog case: the live product's title. */
  catalogTitle?: string | null;
}

export interface FilenamePreviewItem {
  itemId: string;
  upc: string;
  /** Effective title promotion would use. */
  title: string;
  /** Assigned file name promotion would persist. */
  fileName: string;
  /**
   * Base (pre-uniquify) file name. Explicit accepts are recorded against
   * the base so sibling changes (suffix shifts) don't stale them; retitles
   * change the base and re-warn.
   */
  baseFileName: string;
  /** Latest accepted base file name for this batch, if any (null = unresolved). */
  acceptedFileName: string | null;
  warnings: FilenameWarning[];
}

/** Effective title through the EXACT promoter chain (curated → extraction → name). */
export function previewTitleForItem(item: OnboardingItem): string {
  return item.curationData?.curatedTitle || item.extractionData?.title || item.name;
}

/**
 * Compute the per-draft filename preview for every item in a batch.
 * Pure reads only (workspace product files + product index); no mutation.
 * Deterministic: same batch state → same payload (compute once per batch
 * review load and cache client-side).
 */
export function computeBatchFilenamePreview(
  workspacePath: string,
  items: OnboardingItem[],
  workspaceId?: string,
  batchId?: string,
): FilenamePreviewItem[] {
  const assigned = assignPromotionFileNames(items, workspacePath);

  // Base (pre-uniquify) names through the shared promotion derivation so
  // batch-internal groups reflect true would-have-collided roots.
  const bases = new Map<string, string>();
  for (const item of items) {
    bases.set(item.id, resolvePromotionBaseName(item, readProductFile(workspacePath, item.upc)).name);
  }
  const groups = findDuplicateFileNames(items.map(i => ({ key: i.id, fileName: bases.get(i.id)! })));
  const groupByMember = new Map<string, { fileName: string; keys: string[] }>();
  for (const g of groups) {
    for (const k of g.keys) groupByMember.set(k, g);
  }
  const byId = new Map(items.map(i => [i.id, i]));

  // Latest recorded accepts for this batch (one read, not per item), so the
  // drawer can render resolved state without extra round-trips.
  const acceptances = workspaceId && batchId ? getFilenameAcceptances(workspaceId, batchId) : new Map<string, string>();

  // Live catalog effective names, excluding the batch's own UPCs (same
  // product under review is not a collision). Cap mirrors review-scale
  // batches; catalogs beyond it fall back to the pre-sync validation
  // backstop (DUPLICATE_FILENAME).
  const batchUpcs = new Set(items.map(i => i.upc));
  const catalog = new Map<string, { sku: string; title: string }>();
  try {
    const { products } = listProducts({ limit: 10000 });
    for (const row of products) {
      if (batchUpcs.has(row.sku)) continue;
      const prod = readProductFile(workspacePath, row.sku);
      if (!prod) continue;
      const lower = resolveBaseFileName(prod).toLowerCase();
      if (!catalog.has(lower)) catalog.set(lower, { sku: row.sku, title: prod.core.name });
    }
  } catch {
    // Product index/file reads must never break the preview; without a
    // catalog map only batch-internal warnings surface.
  }

  return items.map(item => {
    const title = previewTitleForItem(item);
    const baseFileName = bases.get(item.id)!;
    const fileName = assigned.get(item.id) ?? baseFileName;
    const warnings: FilenameWarning[] = [];
    const group = groupByMember.get(item.id);
    if (group) {
      const others = group.keys.filter(k => k !== item.id).map(k => byId.get(k)!);
      const conflictDesc = others.map(o => `${o.upc} ("${previewTitleForItem(o)}")`).join(', ');
      warnings.push({
        code: FILENAME_WARNING_BATCH,
        fileName: group.fileName,
        message: `"${group.fileName}" is also the file name of ${conflictDesc}. Within a full-batch promotion this draft would save as "${fileName}" (partial promotions may renumber suffixes) — accept the suffixed names, retitle, or defer.`,
        conflictingUpcs: others.map(o => o.upc),
        conflictingTitles: others.map(o => previewTitleForItem(o)),
      });
    }
    // Catalog check runs on the ASSIGNED name: sibling-uniquified names that
    // still hit a live product are genuine export-time collisions.
    const live = catalog.get(fileName.toLowerCase());
    if (live) {
      warnings.push({
        code: FILENAME_WARNING_CATALOG,
        fileName,
        message: `"${fileName}" is already the file name of live catalog product ${live.sku} ("${live.title}"). Retitle this draft or defer — a catalog collision cannot be accepted.`,
        conflictingUpcs: [],
        conflictingTitles: [],
        catalogSku: live.sku,
        catalogTitle: live.title,
      });
    }
    return { itemId: item.id, upc: item.upc, title, fileName, baseFileName, acceptedFileName: acceptances.get(item.upc) ?? null, warnings };
  });
}

/**
 * Latest recorded accepts for a batch: UPC → accepted base file name.
 * Single read for drawer rendering (not per item).
 */
export function getFilenameAcceptances(workspaceId: string, batchId: string): Map<string, string> {
  const out = new Map<string, string>();
  const db = getDb();
  const rows = db.query(
    `SELECT product_sku, event_json, created_at FROM classification_history_events
     WHERE workspace_id = ? AND event_type = ?`,
  ).all(workspaceId, ACCEPT_EVENT) as Array<{ product_sku: string; event_json: string; created_at: string }>;
  // Latest per SKU wins.
  const latest = new Map<string, { fileName: string; batchId: string; at: string }>();
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as { batchId?: string; fileName?: string };
      if (event.batchId !== batchId || typeof event.fileName !== 'string') continue;
      const prev = latest.get(row.product_sku);
      if (!prev || row.created_at >= prev.at) {
        latest.set(row.product_sku, { fileName: event.fileName, batchId: event.batchId, at: row.created_at });
      }
    } catch { /* skip malformed rows */ }
  }
  for (const [sku, v] of latest) out.set(sku, v.fileName);
  return out;
}

/** Convenience: preview for every item currently in a batch. */
export function previewBatchFilenames(workspacePath: string, batchId: string, workspaceId?: string): FilenamePreviewItem[] {
  return computeBatchFilenamePreview(workspacePath, listItemsByBatch(batchId), workspaceId, batchId);
}

// ─── Explicit decisions (Classification History) ─────────────────────────────

export type FilenameDecision = 'accept' | 'defer';

const ACCEPT_EVENT = 'filename_warning_accepted';
const DEFER_EVENT = 'filename_warning_deferred';

/**
 * Record an explicit operator decision. Accept/Defer are keyed to the base
 * file name the reviewer saw: retitles change the base and re-warn instead
 * of inheriting a stale accept.
 */
export function recordFilenameDecision(
  workspaceId: string,
  upc: string,
  batchId: string,
  decision: FilenameDecision,
  fileName: string,
  decidedBy: string,
): void {
  recordHistoryEvent(workspaceId, upc, decision === 'accept' ? ACCEPT_EVENT : DEFER_EVENT, {
    batchId,
    fileName,
    decidedBy,
  });
}

/**
 * Whether a non-stale accept exists for this exact base file name + batch.
 * Deferrals are explicit but never suppress (deferred items simply are not
 * approved).
 */
export function getFilenameAcceptance(
  workspaceId: string,
  upc: string,
  batchId: string,
  fileName: string,
): boolean {
  const db = getDb();
  const row = db.query(
    `SELECT event_json FROM classification_history_events
     WHERE workspace_id = ? AND product_sku = ? AND event_type = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspaceId, upc, ACCEPT_EVENT) as { event_json: string } | undefined;
  if (!row) return false;
  try {
    const event = JSON.parse(row.event_json) as { batchId?: string; fileName?: string };
    return event.batchId === batchId && event.fileName === fileName;
  } catch {
    return false;
  }
}

/**
 * Gate verdict for one previewed item. Returns the rejection reason, or null
 * when the item may proceed. Catalog collisions fail closed unconditionally;
 * batch collisions need a current accept (payload-recorded or history).
 */
export function filenameGateReason(
  preview: FilenamePreviewItem,
  workspaceId: string,
  batchId: string,
): string | null {
  if (preview.warnings.length === 0) return null;
  const catalog = preview.warnings.find(w => w.code === FILENAME_WARNING_CATALOG);
  if (catalog) {
    return `filename_collision_catalog: "${catalog.fileName}" belongs to live catalog product ${catalog.catalogSku} ("${catalog.catalogTitle}"). Retitle or defer.`;
  }
  if (getFilenameAcceptance(workspaceId, preview.upc, batchId, preview.baseFileName)) return null;
  const first = preview.warnings[0];
  return `filename_warning_unresolved: "${first.fileName}" collides (${first.message}) — accept, retitle, or defer explicitly.`;
}
