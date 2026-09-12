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
 *
 * Issue #106 explicitly supersedes two #107/#109-era assumptions (kept as
 * history, not behavior): (a) the batch-only taken set — the assignment
 * and preview now run against the complete workspace ownership snapshot
 * (catalog + pending reservations); (b) the file-scan truncated preview —
 * catalog display now resolves through the same snapshot precedence.
 */
import { getDb } from '../db/connection';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { readProductFile } from '../git/workspace-files';
import {
  assignPromotionFileNames,
  assignPromotionFileNamesWithAudit,
  buildFilenameOwnershipSnapshot,
  buildNamingAssessmentBase,
  overlayCohortNamingContext,
  resolvePromotionBaseName,
  type FilenameOwnershipSnapshot,
} from './draft-promoter';
import { assessNamingInvariants } from './naming-assessment';
import { allocationScopeLabel, type AllocationRecord } from './naming-allocation';
import { listCatalogProductsForSnapshot } from '../db/repositories/product-index-repo';
import { getActiveCohortForItem } from '../db/repositories/curation-cohort-repo';
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
  /** Issue #106 (additive): naming-invariant findings on the final title. */
  namingFindings: Array<{ code: string; detail: string; axis?: string }>;
  /** Classification Evidence / run refs behind the findings (story 20). */
  evidenceRefs: string[];
  /** Reviewer actions that resolve this item (retitle / accept-suffix / defer). */
  allowedResolutions: Array<'retitle' | 'accept_suffix' | 'defer'>;
  /** Allocation identity: version + snapshot ref + scope label (story 21). */
  derivation: {
    algorithmVersion: number;
    snapshotRef: string | null;
    scopeLabel: string;
    suffix: number | null;
    keptOwnership: boolean;
  } | null;
}

export interface FilenamePreviewSummary {
  snapshotRef: string | null;
  allocationScope: string;
  /** Preview completeness: false when the snapshot/catalog reads failed. */
  complete: boolean;
  counts: {
    items: number;
    unresolvedCollisions: number;
    missingBrand: number;
    duplicateBrand: number;
    missingMeasurement: number;
    missingColor: number;
    duplicateSiblings: number;
    unresolvedDecisions: number;
    deferredExcluded: number;
  };
  /** Split of suffixed assignments: cleanly resolved vs still colliding. */
  resolvedSuffixes: string[];
  remainingCollisions: string[];
  /** Export-subset readiness: explicitly identified ready + excluded ids. */
  readyItemIds: string[];
  deferredItemIds: string[];
  workLogReady: boolean;
  workLogBlockers: string[];
}

/** Effective title through the EXACT promoter chain (curated → extraction → name). */
export function previewTitleForItem(item: OnboardingItem): string {
  return item.curationData?.curatedTitle || item.extractionData?.title || item.name;
}

/**
 * Preview-time naming assessment (issue #106): the shared base evidence +
 * the item's active candidate-cohort overlay (sibling titles for the
 * duplicate check). Never throws — lookup failures yield empty sets.
 */
export function assessPreviewNaming(
  item: OnboardingItem,
  workspaceId: string | null,
): { findings: Array<{ code: string; detail: string; axis?: string }>; evidenceRefs: string[] } {
  try {
    const base = buildNamingAssessmentBase(item, workspaceId ?? '');
    let cohortId: string | null = null;
    try {
      cohortId = getActiveCohortForItem(item.id)?.id ?? null;
    } catch {
      cohortId = null;
    }
    const input = overlayCohortNamingContext(base, item, cohortId);
    const assessment = assessNamingInvariants(input);
    const refs = new Set<string>();
    for (const token of input.measurementTokens) {
      for (const ref of token.refs ?? []) refs.add(ref);
    }
    return {
      findings: assessment.findings.map((f) => ({
        code: f.code,
        detail: f.detail,
        ...(f.axis ? { axis: f.axis } : {}),
      })),
      evidenceRefs: [...refs],
    };
  } catch {
    return { findings: [], evidenceRefs: [] };
  }
}

/**
 * Latest deferral decisions per SKU for a batch (explicit exclusions).
 * Latest decision per SKU wins; only deferrals are returned.
 */
export function getFilenameDeferrals(workspaceId: string, batchId: string): Set<string> {
  const out = new Set<string>();
  const db = getDb();
  // Latest decision of EITHER kind per SKU wins: a deferral counts only
  // while no later accept supersedes it.
  const rows = db.query(
    `SELECT product_sku, event_type, event_json, created_at FROM classification_history_events
     WHERE workspace_id = ? AND event_type IN (?, ?)`,
  ).all(workspaceId, ACCEPT_EVENT, DEFER_EVENT) as Array<{
    product_sku: string; event_type: string; event_json: string; created_at: string;
  }>;
  const latest = new Map<string, { type: string; at: string }>();
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as { batchId?: string };
      if (event.batchId !== batchId) continue;
      const prev = latest.get(row.product_sku);
      if (!prev || row.created_at >= prev.at) latest.set(row.product_sku, { type: row.event_type, at: row.created_at });
    } catch {
      continue;
    }
  }
  for (const [sku, v] of latest) {
    if (v.type === DEFER_EVENT) out.add(sku);
  }
  return out;
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
  return computeBatchFilenamePreviewInternal(workspacePath, items, workspaceId, batchId).items;
}

/**
 * Preview + snapshot identity for summary computation (issue #106).
 * `complete` is false when the workspace snapshot failed to build.
 */
export function computeBatchFilenamePreviewInternal(
  workspacePath: string,
  items: OnboardingItem[],
  workspaceId?: string,
  batchId?: string,
): { items: FilenamePreviewItem[]; snapshotRef: string | null; complete: boolean } {
  // Issue #106: preview == promotion — the assignment runs against the
  // SAME complete workspace snapshot (catalog + pending reservations)
  // promotion uses. Without a workspace id there is no snapshot; the
  // legacy batch-only derivation applies (and the summary marks scope).
  let snapshot: FilenameOwnershipSnapshot | null = null;
  let snapshotComplete = true;
  if (workspaceId) {
    try {
      snapshot = buildFilenameOwnershipSnapshot(workspaceId, workspacePath);
    } catch {
      snapshot = null;
      snapshotComplete = false;
    }
  }
  const audit = snapshot
    ? assignPromotionFileNamesWithAudit(items, workspacePath, readProductFile, snapshot)
    : null;
  const assigned = audit?.assigned ?? assignPromotionFileNames(items, workspacePath);
  const allocationByItem = new Map<string, AllocationRecord>(
    (audit?.records ?? []).map((r) => [r.itemId, r]),
  );
  const snapshotRef = audit?.snapshotRef ?? null;

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
  // product under review is not a collision). Issue #106: sourced from the
  // SAME workspace snapshot the assignment uses (single authority), with
  // display titles from the catalog index. The #107 file-scan + 10000 cap
  // is superseded: snapshot coverage is complete, and anything unreadable
  // falls back to the pre-sync validation backstop (DUPLICATE_FILENAME).
  // Live catalog effective names, excluding the batch's own UPCs (same
  // product under review is not a collision). Single authority: the same
  // custom-fields-first precedence the snapshot builder uses, so preview
  // warnings and promotion assignment can never disagree on ownership.
  const batchUpcs = new Set(items.map(i => i.upc));
  const catalog = new Map<string, { sku: string; title: string }>();
  const seenCatalogSkus = new Set<string>();
  try {
    for (const row of listCatalogProductsForSnapshot()) {
      if (batchUpcs.has(row.sku) || seenCatalogSkus.has(row.sku)) continue;
      seenCatalogSkus.add(row.sku);
      const raw = row.customFields?.['FileName'];
      let effective: string | null = null;
      if (typeof raw === 'string' && raw.trim()) {
        const trimmed = raw.trim();
        effective = /\.html$/i.test(trimmed) ? trimmed : `${trimmed}.html`;
      } else {
        try {
          const prod = readProductFile(workspacePath, row.sku);
          if (prod) effective = resolveBaseFileName(prod);
        } catch {
          effective = null;
        }
      }
      if (!effective || effective.toLowerCase() === '.html') continue;
      const lower = effective.toLowerCase();
      if (!catalog.has(lower)) {
        catalog.set(lower, { sku: row.sku, title: row.title || row.sku });
      }
    }
  } catch {
    // Catalog reads must never break the preview; without a catalog map
    // only batch-internal warnings surface (pre-sync backstop still guards).
  }

  const previewItems = items.map(item => {
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
    // Catalog checks run on the BASE and the ASSIGNED name. A base owned
    // by a live product warns even when assignment would suffix away from
    // it: ownership conflicts need explicit retitle/defer, never silent
    // suffix repair (#109 contract; the promotion gate blocks the same).
    // Sibling-uniquified assigned names that still hit live products are
    // genuine export-time collisions.
    const liveBase = catalog.get(baseFileName.toLowerCase());
    if (liveBase) {
      warnings.push({
        code: FILENAME_WARNING_CATALOG,
        fileName: baseFileName,
        message: `"${baseFileName}" is already the file name of live catalog product ${liveBase.sku} ("${liveBase.title}"). Retitle this draft or defer — a catalog collision cannot be accepted.`,
        conflictingUpcs: [],
        conflictingTitles: [],
        catalogSku: liveBase.sku,
        catalogTitle: liveBase.title,
      });
    }
    const live = catalog.get(fileName.toLowerCase());
    if (live && live.sku !== liveBase?.sku) {
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
    // Issue #106 (additive): naming findings + allocation identity per item.
    const naming = assessPreviewNaming(item, workspaceId ?? null);
    const record = allocationByItem.get(item.id);
    const hasCatalogWarning = warnings.some((w) => w.code === FILENAME_WARNING_CATALOG);
    const allowedResolutions: Array<'retitle' | 'accept_suffix' | 'defer'> =
      hasCatalogWarning ? ['retitle', 'defer'] : group ? ['retitle', 'accept_suffix', 'defer'] : ['defer'];
    return {
      itemId: item.id, upc: item.upc, title, fileName, baseFileName,
      acceptedFileName: acceptances.get(item.upc) ?? null, warnings,
      namingFindings: naming.findings,
      evidenceRefs: naming.evidenceRefs,
      allowedResolutions,
      derivation: record ? {
        algorithmVersion: record.algorithmVersion,
        snapshotRef: record.snapshotRef,
        scopeLabel: allocationScopeLabel('preview', record.snapshotRef),
        suffix: record.suffix,
        keptOwnership: record.keptOwnership,
      } : null,
    };
  });
  return { items: previewItems, snapshotRef, complete: snapshotComplete };
}

/**
 * Preview items + batch summary for the Review drawer route (issue #106).
 * The summary's `complete` flag is false when the workspace snapshot
 * failed — a stale/partial preview is never work-log ready.
 */
export function previewBatchFilenamesWithSummary(
  workspacePath: string,
  batchId: string,
  workspaceId: string,
): { items: FilenamePreviewItem[]; summary: FilenamePreviewSummary } {
  const { items, snapshotRef, complete } = computeBatchFilenamePreviewInternal(
    workspacePath, listItemsByBatch(batchId), workspaceId, batchId,
  );
  return {
    items,
    summary: computeFilenamePreviewSummary(items, { workspaceId, batchId, snapshotRef, complete }),
  };
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

/**
 * Batch-level preview summary (issue #106 SEQUENCE 3b): counts, the
 * resolved-suffix vs remaining-collision split, and work-log readiness.
 *
 * Work-log ready = explicitly identified export subset (readyItemIds) +
 * complete/current validation (complete flag) + zero naming blockers +
 * decisions resolved + durable approval current is evaluated by the caller
 * (export validation lives outside this module). Deferred items are
 * explicitly excluded (deferredItemIds). A green preview is advisory only
 * — it never approves anything by itself.
 */
export function computeFilenamePreviewSummary(
  items: FilenamePreviewItem[],
  opts: { workspaceId: string; batchId: string; snapshotRef: string | null; complete: boolean },
): FilenamePreviewSummary {
  const acceptances = getFilenameAcceptances(opts.workspaceId, opts.batchId);
  const deferrals = getFilenameDeferrals(opts.workspaceId, opts.batchId);
  const counts = {
    items: items.length,
    unresolvedCollisions: 0,
    missingBrand: 0,
    duplicateBrand: 0,
    missingMeasurement: 0,
    missingColor: 0,
    duplicateSiblings: 0,
    unresolvedDecisions: 0,
    deferredExcluded: 0,
  };
  const resolvedSuffixes: string[] = [];
  const remainingCollisions: string[] = [];
  const readyItemIds: string[] = [];
  const deferredItemIds: string[] = [];
  const workLogBlockers: string[] = [];

  for (const item of items) {
    const batchWarning = item.warnings.find((w) => w.code === FILENAME_WARNING_BATCH);
    const catalogWarning = item.warnings.find((w) => w.code === FILENAME_WARNING_CATALOG);
    const accepted = acceptances.get(item.upc) === item.baseFileName;
    const deferred = deferrals.has(item.upc);
    if (deferred) {
      counts.deferredExcluded += 1;
      deferredItemIds.push(item.itemId);
      continue;
    }
    // Suffix split: suffixed assignments with no warning — or whose base
    // group the reviewer accepted — are cleanly resolved; anything still
    // warning without a decision remains a collision.
    if (item.derivation?.suffix != null && !catalogWarning && (!batchWarning || accepted)) {
      resolvedSuffixes.push(item.fileName);
    }
    if (batchWarning && !accepted) remainingCollisions.push(item.fileName);
    if (catalogWarning) remainingCollisions.push(item.fileName);

    let itemBlocked = false;
    if ((batchWarning && !accepted) || catalogWarning) {
      counts.unresolvedCollisions += 1;
      itemBlocked = true;
    }
    if (batchWarning && !accepted) counts.unresolvedDecisions += 1;
    for (const finding of item.namingFindings) {
      if (finding.code === 'missing_brand') counts.missingBrand += 1;
      else if (finding.code === 'duplicate_brand') counts.duplicateBrand += 1;
      else if (finding.code === 'missing_size') counts.missingMeasurement += 1;
      else if (finding.code === 'missing_color') counts.missingColor += 1;
      else if (finding.code === 'duplicate_sibling') counts.duplicateSiblings += 1;
    }
    if (item.namingFindings.length > 0) itemBlocked = true;
    if (!itemBlocked) readyItemIds.push(item.itemId);
  }

  if (!opts.complete) workLogBlockers.push('preview_incomplete');
  if (counts.unresolvedCollisions > 0) workLogBlockers.push('unresolved_collisions');
  if (counts.missingBrand + counts.duplicateBrand + counts.missingMeasurement + counts.missingColor + counts.duplicateSiblings > 0) {
    workLogBlockers.push('naming_findings');
  }
  if (counts.unresolvedDecisions > 0) workLogBlockers.push('unresolved_decisions');
  const workLogReady = opts.complete && workLogBlockers.length === 0 && readyItemIds.length > 0;
  if (readyItemIds.length === 0 && workLogBlockers.length === 0) workLogBlockers.push('empty_export_subset');

  return {
    snapshotRef: opts.snapshotRef,
    allocationScope: allocationScopeLabel('preview', opts.snapshotRef ?? 'unknown'),
    complete: opts.complete,
    counts,
    resolvedSuffixes,
    remainingCollisions,
    readyItemIds,
    deferredItemIds,
    workLogReady,
    workLogBlockers,
  };
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
