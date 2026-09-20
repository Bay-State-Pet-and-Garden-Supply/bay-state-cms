/**
 * Filter-scoped bulk resolution through the reviewed change path (issue #254),
 * plus explicit trust-remote scope "*" (issue #270).
 *
 * Bulk resolution is scoped to an explicit filter, freezes the reviewed
 * selection before approval (explicit filter + hunk versions + baseline
 * reference + count + confirmation), and commits through one bounded reviewed
 * change set mapping to one commit — never as a side channel.
 *
 * Bounds cover the whole path, not just queue reads:
 * - queue reads page in DRIFT_BULK_PAGE_SIZE chunks (#251 contract)
 * - frozen selection is capped at DRIFT_BULK_MAX_HUNKS
 * - draft construction, validation, approval, response payload, and audit
 *   writing all honor the same bound
 *
 * Failure honesty:
 * - stale hunks (moved baseline, newer remote, changed context) are skipped,
 *   never reported as resolved
 * - filename collisions (catalog, change-set drafts, and intra-bulk claims
 *   across processing batches) hold, never commit
 * - validation blockers fail closed with no commit, no drift resolution,
 *   and no false synced signals
 * - commits use --only over the bulk file set so unrelated staged catalog
 *   changes are never swept into the bulk commit
 * - retry with the same frozen selection is idempotent: already-resolved
 *   hunks report as skipped, never duplicate commits or audits
 */

import { execFileSync } from 'node:child_process';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import {
  findDriftById,
  resolveDrift,
  updateDriftHunkState,
  listDrift,
  DRIFT_BULK_PAGE_SIZE,
} from '../db/repositories/drift-repo';
import { addAuditLog } from '../db/repositories/audit-log-repo';
import {
  buildComparisonProjection,
  buildComparisonContext,
  diffComparisonProjections,
  hashComparisonProjection,
  isComparisonContextStale,
} from './catalog-comparison';
import {
  parseDriftDiff,
  heldReasonForHunk,
  isFilenameField,
  applySingleFieldHunk,
  isSupportedHunkField,
} from './drift-hunks';
import { getReconciledFieldsForDrift } from './drift-reconcile-service';
import { expandDriftToHunks } from './drift-hunk-service';
import { findProductBySku, updateProductIndex, listCatalogFilenameOwners } from '../db/repositories/product-index-repo';
import { indexProductPageAssignments } from '../db/repositories/page-repo';
import {
  createChangeSet,
  upsertChangeSetItem,
  deleteChangeSet,
  updateChangeSetStatus,
  listNonDiscardedChangeSetDrafts,
} from '../db/repositories/change-set-repo';
import { getActivePageImportHash } from '../db/repositories/page-repo';
import { normalizeFileName, resolveBaseFileName, resolveReimportFilename } from './file-name';
import { writeProductFile } from '../git/workspace-files';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import { validateChangeSet } from '../validation/change-set-validation';
import type { Product } from '../shared/types';

/** Whole-path bound: frozen selection, draft items, audits, response lists. */
export const DRIFT_BULK_MAX_HUNKS = 50;
/** Processing batch size: merges + filename checks run per batch so cross-batch collisions are caught. */
export const DRIFT_BULK_BATCH_SIZE = 10;
/**
 * Explicit trust-remote scope (#270): accept all eligible fields in one
 * reviewable action. Still explicit — bare/omitted scope continues to fail
 * rather than defaulting here.
 */
export const TRUST_REMOTE_SCOPE = '*';

export function isTrustRemoteScope(field: string): boolean {
  return field === TRUST_REMOTE_SCOPE;
}

export interface FrozenBulkHunk {
  driftId: string;
  sku: string;
  field: string;
  baselineValue: string | null;
  remoteValue: string | null;
  remoteHash: string;
  baselineCommit: string | null;
}

export interface BulkFreezeResult {
  field: string;
  baselineCommit: string | null;
  projectionVersion: string;
  count: number;
  totalMatching: number;
  truncated: boolean;
  hunks: FrozenBulkHunk[];
  heldSkipped: number;
  unsupportedSkipped: number;
}

export interface BulkApproveInput {
  field: string;
  baselineCommit?: string | null;
  hunks: FrozenBulkHunk[];
  confirmed?: boolean;
  actor?: string;
}

export interface BulkApproveResult {
  field: string;
  changeSetId: string | null;
  commitHash: string | null;
  acceptedCount: number;
  totalFrozen: number;
  resolvedSkus: string[];
  skippedStale: Array<{ driftId: string; sku: string; reason: string }>;
  skippedHeld: Array<{ driftId: string; sku: string; reason: string }>;
  failed: Array<{ driftId: string; sku: string; reason: string }>;
  truncatedResponse: boolean;
}

export interface BulkTestHooks {
  failOnSku?: string;
  failCommit?: boolean;
}

function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  throw err;
}

function requireFieldScope(field: unknown): string {
  if (typeof field !== 'string' || field.trim() === '') {
    fail(400, 'Bulk resolution requires an explicit filter scope: supply a non-empty "field" (e.g. "core.price") or "*" for all eligible fields. Bare accept-everything is not offered.');
  }
  const trimmed = (field as string).trim();
  if (isTrustRemoteScope(trimmed)) return trimmed;
  if (!isSupportedHunkField(trimmed)) {
    fail(400, `Unsupported bulk field "${trimmed}". Bulk acceptance applies one supported comparison field per run, or "*" for trust-remote.`);
  }
  return trimmed;
}

/**
 * Freeze the reviewed selection: explicit filter, hunk versions, baseline
 * reference, count. Reads the queue in bounded pages; caps the frozen set so
 * large queues resolve in predictable batches. Hunsk arriving after this
 * snapshot are excluded by construction (approve only processes these IDs).
 */
export function freezeBulkSelection(
  workspaceId: string,
  workspacePath: string,
  fieldInput: string,
): BulkFreezeResult {
  const field = requireFieldScope(fieldInput);
  const trustAll = isTrustRemoteScope(field);

  let baselineCommit: string | null = null;
  try {
    const git = new GitClient(workspacePath);
    if (git.isRepo()) baselineCommit = git.getHeadHash() || null;
  } catch {
    baselineCommit = null;
  }

  const frozen: FrozenBulkHunk[] = [];
  let heldSkipped = 0;
  let unsupportedSkipped = 0;
  let truncated = false;
  let queueExhausted = false;

  let offset = 0;
  for (;;) {
    // Read the blocking queue (open + in_reconcile): per-hunk held checks
    // below skip frozen-linked fields, so unrelated hunks on
    // reconcile-linked rows stay bulk-eligible (#257 field isolation).
    // Trust-remote reads unfiltered and fans out per hunk; single-field
    // keeps the DB prefilter.
    const page = listDrift(workspaceId, 'blocking', DRIFT_BULK_PAGE_SIZE, offset, trustAll ? undefined : field);
    if (page.length === 0) {
      queueExhausted = true;
      break;
    }
    for (const row of page) {
      let hunks;
      try {
        hunks = expandDriftToHunks(row as never);
      } catch {
        continue;
      }
      for (const h of hunks) {
        if (!trustAll && h.field !== field) continue;
        if (h.heldReason) {
          heldSkipped += 1;
          continue;
        }
        if (!h.supported || !isSupportedHunkField(h.field)) {
          unsupportedSkipped += 1;
          continue;
        }
        if (frozen.length >= DRIFT_BULK_MAX_HUNKS) {
          truncated = true;
          break;
        }
        frozen.push({
          driftId: h.driftId,
          sku: h.sku,
          field: h.field,
          baselineValue: h.baselineValue,
          remoteValue: h.remoteValue,
          remoteHash: h.remoteHash,
          baselineCommit: h.baselineCommit,
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
    if (page.length < DRIFT_BULK_PAGE_SIZE) {
      queueExhausted = true;
      break;
    }
    offset += page.length;
    // Safety: never scan unbounded pages in one freeze; the frozen set is
    // already capped, and continuing to scan a huge queue would defeat the
    // bound. Stop after enough pages to fill the cap plus one probe page.
    if (offset > DRIFT_BULK_MAX_HUNKS * 4 + DRIFT_BULK_PAGE_SIZE * 4) {
      truncated = true;
      break;
    }
  }

  frozen.sort((a, b) => {
    if (a.sku !== b.sku) return a.sku < b.sku ? -1 : 1;
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if ((a.remoteValue ?? '') !== (b.remoteValue ?? '')) return (a.remoteValue ?? '') < (b.remoteValue ?? '') ? -1 : 1;
    if ((a.baselineValue ?? '') !== (b.baselineValue ?? '')) return (a.baselineValue ?? '') < (b.baselineValue ?? '') ? -1 : 1;
    return a.driftId < b.driftId ? -1 : 1;
  });

  return {
    field,
    baselineCommit,
    projectionVersion: 'catalog-comparison-v1',
    count: frozen.length,
    totalMatching: truncated ? frozen.length + 1 : frozen.length,
    truncated: truncated || !queueExhausted,
    hunks: frozen,
    heldSkipped,
    unsupportedSkipped,
  };
}

interface PerHunkValidated {
  frozen: FrozenBulkHunk;
  driftId: string;
  sku: string;
  baseline: Product;
  remote: Product;
  remoteHash: string;
  parsedBaselineCommit: string | null;
}

interface ValidatedMerge {
  frozenHunks: FrozenBulkHunk[];
  driftId: string;
  sku: string;
  merged: Product;
  baseline: Product;
  remote: Product;
  remoteHash: string;
  parsedBaselineCommit: string | null;
}

function getCurrentHead(workspacePath: string): string | null {
  try {
    const git = new GitClient(workspacePath);
    if (!git.isRepo()) return null;
    return git.getHeadHash() || null;
  } catch {
    return null;
  }
}

function listStagedFiles(workspacePath: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: workspacePath,
      encoding: 'utf-8',
    }).trim();
    if (!out) return [];
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function commitOnlyFiles(workspacePath: string, files: string[], message: string, hooks?: BulkTestHooks): void {
  if (hooks?.failCommit) {
    throw new Error('Injected commit failure for bulk honesty test.');
  }
  execFileSync('git', ['commit', '-m', message, '--only', '--', ...files], {
    cwd: workspacePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

/**
 * Approve a frozen bulk selection through one bounded reviewed change set
 * mapping to one commit. Revalidates staleness + filename ownership before
 * approval, including collisions across processing batches.
 */
export function approveBulkSelection(
  workspaceId: string,
  workspacePath: string,
  input: BulkApproveInput,
  hooks?: BulkTestHooks,
): BulkApproveResult {
  const field = requireFieldScope(input.field);
  const trustAll = isTrustRemoteScope(field);

  if (!Array.isArray(input.hunks) || input.hunks.length === 0) {
    fail(400, 'Bulk approval requires a non-empty frozen hunk selection. Freeze first, then confirm.');
  }
  if (input.confirmed !== true) {
    fail(400, 'Bulk approval requires explicit confirmation: pass confirmed:true with the frozen selection.');
  }
  if (input.hunks.length > DRIFT_BULK_MAX_HUNKS) {
    fail(400, `Bulk selection exceeds the whole-path bound of ${DRIFT_BULK_MAX_HUNKS} hunks (${input.hunks.length} supplied). Narrow the filter or approve in batches.`);
  }
  for (const h of input.hunks) {
    if (!h.driftId || !h.sku || !h.field) {
      fail(400, `Frozen selection mismatch: every hunk must carry driftId, sku, and field. Newly arriving matches are excluded — re-freeze to include them.`);
    }
    if (!trustAll && h.field !== field) {
      fail(400, `Frozen selection mismatch: every hunk must carry driftId, sku, and field "${field}". Newly arriving matches are excluded — re-freeze to include them.`);
    }
    if (trustAll && !isSupportedHunkField(h.field)) {
      fail(400, `Frozen selection mismatch: trust-remote hunk field "${h.field}" is not supported. Re-freeze to exclude it.`);
    }
  }

  const actor = input.actor ?? workspaceId;
  const nowIso = new Date().toISOString();
  const currentHead = getCurrentHead(workspacePath);
  const frozenHead = input.baselineCommit ?? null;

  // Global baseline reference: a moved HEAD invalidates the freeze.
  if (frozenHead && currentHead && frozenHead !== currentHead) {
    fail(
      409,
      `Stale bulk selection: approved baseline moved since freeze (froze ${frozenHead}, HEAD is ${currentHead}). Re-freeze before approving.`,
    );
  }

  const skippedStale: BulkApproveResult['skippedStale'] = [];
  const skippedHeld: BulkApproveResult['skippedHeld'] = [];
  const failed: BulkApproveResult['failed'] = [];

  // Current comparison context for staleness checks.
  const currentPageHash: string | null = (() => {
    try {
      return getActivePageImportHash(workspaceId);
    } catch {
      return null;
    }
  })();
  const currentCtx = buildComparisonContext(currentPageHash);

  // Per-hunk revalidation in bounded batches, then grouped per product so
  // trust-remote merges every eligible field for one SKU into one draft.
  const perHunk: PerHunkValidated[] = [];
  for (let batchStart = 0; batchStart < input.hunks.length; batchStart += DRIFT_BULK_BATCH_SIZE) {
    const batch = input.hunks.slice(batchStart, batchStart + DRIFT_BULK_BATCH_SIZE);
    for (const frozen of batch) {
      const hunkField = trustAll ? frozen.field : field;
      const drift = findDriftById(frozen.driftId);
      if (!drift || drift.workspaceId !== workspaceId) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'already-resolved-or-foreign' });
        continue;
      }
      if (drift.status !== 'open' && (drift.status as string) !== 'in_reconcile') {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: `status-${drift.status}` });
        continue;
      }
      // `in_reconcile` rows stay eligible here: the held check below skips
      // only frozen-linked fields, so unrelated hunks bulk-resolve (#257).
      if (drift.sku !== frozen.sku) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'sku-moved' });
        continue;
      }
      let parsed;
      try {
        parsed = parseDriftDiff(drift);
      } catch {
        failed.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'unreadable-diff' });
        continue;
      }
      const held = heldReasonForHunk(drift, parsed, hunkField, {
        reconciledFields: getReconciledFieldsForDrift(drift),
        hunk: { baselineValue: frozen.baselineValue, remoteValue: frozen.remoteValue },
      });
      if (held) {
        skippedHeld.push({ driftId: frozen.driftId, sku: frozen.sku, reason: held });
        continue;
      }
      if (!isSupportedHunkField(hunkField)) {
        skippedHeld.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'unsupported-field' });
        continue;
      }
      // Frozen-version match: remote observation + baseline + values.
      if (drift.remoteHash !== frozen.remoteHash) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'remote-moved-since-freeze' });
        continue;
      }
      if ((parsed.baselineCommit ?? null) !== (frozen.baselineCommit ?? null)) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'baseline-moved-since-freeze' });
        continue;
      }
      const norm = (v: string | null | undefined): string => v ?? '';
      const match = parsed.hunks.find(
        (h) => h.field === hunkField && norm(h.baselineValue) === norm(frozen.baselineValue) && norm(h.remoteValue) === norm(frozen.remoteValue),
      );
      if (!match) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'hunk-superseded' });
        continue;
      }
      // Live baseline: the SKU's file at HEAD must still match the recorded
      // baseline. A global HEAD move from unrelated files does not stale
      // this hunk; only a move of this SKU's own baseline does. This keeps
      // retry honest after a partial bulk commit (which moves HEAD).
      try {
        const git = new GitClient(workspacePath);
        if (git.isRepo() && parsed.baselineCommit) {
          const headContent = git.readFileAtHead(skuToProductFilePath(drift.sku));
          if (headContent && drift.localJson) {
            try {
              const headProd = JSON.parse(headContent) as Product;
              const baseProd = JSON.parse(drift.localJson) as Product;
              const headHash = hashComparisonProjection(buildComparisonProjection(headProd));
              const baseHash = hashComparisonProjection(buildComparisonProjection(baseProd));
              if (headHash !== baseHash) {
                skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'baseline-moved' });
                continue;
              }
            } catch {
              // Unparseable HEAD/baseline: fail closed as stale, never as resolved.
              skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'baseline-unreadable' });
              continue;
            }
          }
        }
      } catch {
        // Git read failures never manufacture staleness; continue to context checks.
      }
      if (parsed.context && isComparisonContextStale(parsed.context, currentCtx)) {
        skippedStale.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'context-moved' });
        continue;
      }

      let baselineProduct: Product | null;
      let remoteProduct: Product | null;
      try {
        baselineProduct = drift.localJson ? (JSON.parse(drift.localJson) as Product) : null;
      } catch {
        failed.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'unreadable-baseline' });
        continue;
      }
      try {
        remoteProduct = JSON.parse(drift.remoteJson) as Product;
      } catch {
        failed.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'unreadable-remote' });
        continue;
      }
      if (!baselineProduct) {
        skippedHeld.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'new_product' });
        continue;
      }
      if (hooks?.failOnSku === frozen.sku) {
        failed.push({ driftId: frozen.driftId, sku: frozen.sku, reason: 'injected-merge-failure' });
        continue;
      }
      perHunk.push({
        frozen,
        driftId: drift.id,
        sku: drift.sku,
        baseline: baselineProduct,
        remote: remoteProduct,
        remoteHash: drift.remoteHash,
        parsedBaselineCommit: parsed.baselineCommit,
      });
    }
  }

  // Group validated hunks per product and merge every eligible field with
  // field isolation (one draft per SKU, never wholesale overwrite).
  const candidates: ValidatedMerge[] = [];
  {
    const byDrift = new Map<string, PerHunkValidated[]>();
    for (const p of perHunk) {
      const list = byDrift.get(p.driftId) ?? [];
      list.push(p);
      byDrift.set(p.driftId, list);
    }
    const orderedDriftIds = [...byDrift.keys()].sort((a, b) => {
      const sa = byDrift.get(a)![0].sku;
      const sb = byDrift.get(b)![0].sku;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a < b ? -1 : 1;
    });
    for (const driftId of orderedDriftIds) {
      let group = byDrift.get(driftId)!;
      group.sort((a, b) => (a.frozen.field < b.frozen.field ? -1 : a.frozen.field > b.frozen.field ? 1 : 0));
      // Fail closed for page assignments: the productOnPages merge copies the
      // whole remote list, so a held unverified page would ship silently even
      // though its hunk was excluded from the freeze. Hold the page fields
      // when the row carries any held page hunk; non-page fields still merge.
      if (group.some((g) => g.frozen.field === 'core.productOnPages')) {
        try {
          const liveDrift = findDriftById(driftId);
          if (liveDrift) {
            const liveParsed = parseDriftDiff(liveDrift);
            const reconciled = getReconciledFieldsForDrift(liveDrift);
            const anyHeldPage = liveParsed.hunks.some(
              (ph) =>
                ph.field === 'core.productOnPages' &&
                heldReasonForHunk(liveDrift, liveParsed, ph.field, {
                  reconciledFields: reconciled,
                  hunk: { baselineValue: ph.baselineValue, remoteValue: ph.remoteValue },
                }),
            );
            if (anyHeldPage) {
              const kept: PerHunkValidated[] = [];
              for (const g of group) {
                if (g.frozen.field === 'core.productOnPages') {
                  skippedHeld.push({ driftId: g.driftId, sku: g.sku, reason: 'unavailable_assignment' });
                } else {
                  kept.push(g);
                }
              }
              if (kept.length === 0) continue;
              group = kept;
            }
          }
        } catch {
          // Parse failure: hold page hunks rather than risk silent overwrite.
          const kept: PerHunkValidated[] = [];
          for (const g of group) {
            if (g.frozen.field === 'core.productOnPages') {
              skippedHeld.push({ driftId: g.driftId, sku: g.sku, reason: 'unavailable_assignment' });
            } else {
              kept.push(g);
            }
          }
          if (kept.length === 0) continue;
          group = kept;
        }
      }
      const first = group[0];
      if (hooks?.failOnSku === first.sku) {
        for (const g of group) failed.push({ driftId: g.driftId, sku: g.sku, reason: 'injected-merge-failure' });
        continue;
      }
      try {
        let merged: Product = first.baseline;
        for (const g of group) {
          merged = applySingleFieldHunk(merged, first.remote, g.frozen.field);
        }
        // Baselines/remotes agree within one drift row; keep the first copy.
        candidates.push({
          frozenHunks: group.map((g) => g.frozen),
          driftId: first.driftId,
          sku: first.sku,
          merged,
          baseline: first.baseline,
          remote: first.remote,
          remoteHash: first.remoteHash,
          parsedBaselineCommit: first.parsedBaselineCommit,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        for (const g of group) failed.push({ driftId: g.driftId, sku: g.sku, reason });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      field,
      changeSetId: null,
      commitHash: null,
      acceptedCount: 0,
      totalFrozen: input.hunks.length,
      resolvedSkus: [],
      skippedStale: skippedStale.slice(0, DRIFT_BULK_MAX_HUNKS),
      skippedHeld: skippedHeld.slice(0, DRIFT_BULK_MAX_HUNKS),
      failed: failed.slice(0, DRIFT_BULK_MAX_HUNKS),
      truncatedResponse: skippedStale.length > DRIFT_BULK_MAX_HUNKS || skippedHeld.length > DRIFT_BULK_MAX_HUNKS || failed.length > DRIFT_BULK_MAX_HUNKS,
    };
  }

  // Filename ownership revalidation across processing batches: catalog +
  // non-discarded drafts + intra-bulk claims from earlier batches.
  const owners = new Map<string, string>();
  try {
    for (const { sku, fileName } of listCatalogFilenameOwners()) {
      const key = fileName.toLowerCase();
      if (!owners.has(key)) owners.set(key, sku);
    }
  } catch {
    // Minimal DBs: fall through.
  }
  try {
    for (const { sku, draftJson } of listNonDiscardedChangeSetDrafts(workspaceId)) {
      try {
        const base = resolveBaseFileName(JSON.parse(draftJson) as Product);
        const key = base.toLowerCase();
        if (!owners.has(key)) owners.set(key, sku);
      } catch {
        continue;
      }
    }
  } catch {
    // Change-set reads never block the bulk path itself.
  }
  const bulkClaimed = new Map<string, string>();
  const collisionFree: ValidatedMerge[] = [];
  for (let i = 0; i < candidates.length; i += DRIFT_BULK_BATCH_SIZE) {
    const batch = candidates.slice(i, i + DRIFT_BULK_BATCH_SIZE);
    for (const c of batch) {
      let effective: string | null;
      try {
        const explicit = normalizeFileName(
          (c.merged.customFields?.['FileName'] as unknown) ?? (c.merged.core?.seo?.fileName as unknown) ?? null,
        );
        effective = explicit || resolveBaseFileName(c.merged);
      } catch {
        effective = null;
      }
      if (!effective) {
        collisionFree.push(c);
        continue;
      }
      const key = effective.toLowerCase();
      const catalogOwner = owners.get(key);
      if (catalogOwner && catalogOwner !== c.sku) {
        failed.push({ driftId: c.driftId, sku: c.sku, reason: `IMPORT_FILENAME_COLLISION: "${effective}" owned by ${catalogOwner}` });
        continue;
      }
      const bulkOwner = bulkClaimed.get(key);
      if (bulkOwner && bulkOwner !== c.sku) {
        failed.push({ driftId: c.driftId, sku: c.sku, reason: `BULK_FILENAME_COLLISION: "${effective}" also claimed by ${bulkOwner} in this bulk` });
        continue;
      }
      // Cross-batch reservation: later batches see this claim.
      if (!bulkClaimed.has(key)) bulkClaimed.set(key, c.sku);
      // Filename-field merges get the strict reimport disposition too.
      if (c.frozenHunks.some((fh) => isFilenameField(fh.field))) {
        const disposition = resolveReimportFilename(effective, c.sku, owners);
        if (disposition.action === 'hold_collision') {
          failed.push({ driftId: c.driftId, sku: c.sku, reason: `IMPORT_FILENAME_COLLISION: "${disposition.name}" owned by ${disposition.ownerSku}` });
          bulkClaimed.delete(key);
          continue;
        }
      }
      collisionFree.push(c);
    }
  }

  if (collisionFree.length === 0) {
    return {
      field,
      changeSetId: null,
      commitHash: null,
      acceptedCount: 0,
      totalFrozen: input.hunks.length,
      resolvedSkus: [],
      skippedStale: skippedStale.slice(0, DRIFT_BULK_MAX_HUNKS),
      skippedHeld: skippedHeld.slice(0, DRIFT_BULK_MAX_HUNKS),
      failed: failed.slice(0, DRIFT_BULK_MAX_HUNKS),
      truncatedResponse: false,
    };
  }

  // One bounded reviewed change set for the whole bulk.
  const baseCommit = currentHead ?? frozenHead ?? 'unknown';
  const collisionHunkCount = collisionFree.reduce((n, c) => n + c.frozenHunks.length, 0);
  const bulkTitle = trustAll
    ? `Drift bulk accept * (${collisionHunkCount} hunk(s) across ${collisionFree.length} product(s))`
    : `Drift bulk accept ${field} (${collisionFree.length} hunk(s))`;
  const changeSet = createChangeSet({
    workspaceId,
    title: bulkTitle,
    description: trustAll
      ? `Trust-remote bulk resolution through the reviewed change path. Scope: all eligible fields. Frozen baseline: ${frozenHead ?? 'unknown'}.`
      : `Filter-scoped bulk resolution through the reviewed change path. Field: ${field}. Frozen baseline: ${frozenHead ?? 'unknown'}.`,
    baseCommit,
  });

  const bulkFiles: string[] = [];
  try {
    for (const c of collisionFree) {
      const draftHash = hashJson(c.merged);
      upsertChangeSetItem({
        changeSetId: changeSet.id,
        sku: c.sku,
        operation: 'update',
        draftJson: deterministicStringify(c.merged),
        baseJson: deterministicStringify(c.baseline),
        draftHash,
      });
    }

    // Bounded validation through the normal reviewed path. Drift checks are
    // disabled here by design: this change set IS the drift resolution —
    // requiring zero open drift would deadlock (and price-only bulks must
    // stay approvable while other fields remain outstanding).
    const validation = validateChangeSet(changeSet.id, { checkDrift: false });
    if (!validation.canApprove) {
      try {
        deleteChangeSet(changeSet.id);
      } catch {
        // Cleanup best-effort; the honest outcome is no commit + no resolutions.
      }
      const blockerMsgs = validation.items
        .flatMap((i) => i.results.filter((r) => r.severity === 'blocker').map((r) => `${i.sku}: ${r.message}`))
        .slice(0, DRIFT_BULK_MAX_HUNKS);
      for (const c of collisionFree) {
        for (let hi = 0; hi < c.frozenHunks.length; hi++) {
          failed.push({ driftId: c.driftId, sku: c.sku, reason: 'change-set-validation-blocked' });
        }
      }
      return {
        field,
        changeSetId: null,
        commitHash: null,
        acceptedCount: 0,
        totalFrozen: input.hunks.length,
        resolvedSkus: [],
        skippedStale: skippedStale.slice(0, DRIFT_BULK_MAX_HUNKS),
        skippedHeld: skippedHeld.slice(0, DRIFT_BULK_MAX_HUNKS),
        failed: [...failed.slice(0, DRIFT_BULK_MAX_HUNKS), ...blockerMsgs.map((m) => ({ driftId: '', sku: '', reason: m }))].slice(0, DRIFT_BULK_MAX_HUNKS),
        truncatedResponse: false,
      };
    }

    // Bounded approval: write files, then one --only commit over the
    // bulk file set. Indexing and drift clearing happen only after the commit
    // succeeds. Unrelated staged changes are never swept in.
    const stagedBefore = new Set(listStagedFiles(workspacePath));
    void stagedBefore;
    for (const c of collisionFree) {
      if (hooks?.failOnSku === c.sku) {
        throw new Error(`Injected write failure for ${c.sku}.`);
      }
      writeProductFile(workspacePath, c.merged);
      bulkFiles.push(skuToProductFilePath(c.sku));
    }

    let commitHash: string | null = null;
    const git = new GitClient(workspacePath);
    if (git.isRepo()) {
      const uniqueFiles = [...new Set(bulkFiles)];
      git.add(uniqueFiles);
      let status: string;
      try {
        status = execFileSync('git', ['status', '--porcelain', '--', ...uniqueFiles], {
          cwd: workspacePath,
          encoding: 'utf-8',
        }).trim();
      } catch {
        status = git.status();
      }
      if (status) {
        commitOnlyFiles(workspacePath, uniqueFiles, bulkTitle, hooks);
        commitHash = git.getHeadHash() || null;
      } else {
        commitHash = git.getHeadHash() || baseCommit;
      }
    }

    updateChangeSetStatus(changeSet.id, 'approved', commitHash ?? undefined);

    for (const c of collisionFree) {
      if (c.frozenHunks.some((fh) => fh.field === 'core.productOnPages')) {
        try {
          indexProductPageAssignments(c.merged);
        } catch {
          // Page indexing never blocks the bulk path itself.
        }
      }
    }

    for (const c of collisionFree) {
      const mergedProjection = buildComparisonProjection(c.merged);
      const mergedHash = hashComparisonProjection(mergedProjection);
      const remoteProjection = buildComparisonProjection(c.remote);
      const nowMatchesRemote = mergedHash === hashComparisonProjection(remoteProjection);
      const existing = findProductBySku(c.sku);
      if (existing) {
        updateProductIndex({
          sku: c.sku,
          title: c.merged.core.name,
          status: c.merged.status,
          price: c.merged.core.price,
          inventoryQuantity: c.merged.core.inventory.quantityOnHand,
          primaryImage: c.merged.core.media.primary,
          productHash: mergedHash,
          lastPulledRemoteHash: c.remoteHash,
          lastSyncedRemoteHash: nowMatchesRemote ? c.remoteHash : existing.lastSyncedRemoteHash,
          lastSyncedAt: nowMatchesRemote ? nowIso : existing.lastSyncedAt,
          syncStatus: nowMatchesRemote ? 'synced' : 'drifted',
          hasAdvancedBlocks: Object.keys(c.merged.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
          description: c.merged.core.description,
          searchKeywords: c.merged.core.seo.searchKeywords,
          customFields: c.merged.customFields,
          lastApprovedCommit: commitHash,
        });
      }
    }

    // Honest drift clearing: recompute remaining hunks per SKU so surviving
    // values are never stale; failures never report resolved.
    const resolvedSkus: string[] = [];
    for (const c of collisionFree) {
      try {
        const fresh = findDriftById(c.driftId);
        if (!fresh || (fresh.status !== 'open' && (fresh.status as string) !== 'in_reconcile')) continue;
        const newBaselineProjection = buildComparisonProjection(c.merged);
        const remoteProjection = buildComparisonProjection(c.remote);
        const newHunks = diffComparisonProjections(newBaselineProjection, remoteProjection);
        const acceptedStillDiffers = newHunks.some((h) =>
          c.frozenHunks.some(
            (fh) => h.field === fh.field && (h.remoteValue ?? '') === (fh.remoteValue ?? ''),
          ),
        );
        if (acceptedStillDiffers) {
          failed.push({ driftId: c.driftId, sku: c.sku, reason: 'acceptance-did-not-converge' });
          continue;
        }
        if (newHunks.length === 0) {
          resolveDrift(c.driftId, 'accepted_remote');
        } else {
          const parsed = parseDriftDiff(fresh);
          const nextDiff = {
            ...(parsed.raw as Record<string, unknown>),
            hunks: newHunks,
            baselineCommit: commitHash ?? parsed.baselineCommit,
            baselineDirty: false,
          };
          const mergedHash = hashComparisonProjection(newBaselineProjection);
          updateDriftHunkState(c.driftId, {
            localHash: mergedHash,
            localJson: deterministicStringify(c.merged),
            diffJson: deterministicStringify(nextDiff),
          });
        }
        resolvedSkus.push(c.sku);
      } catch (e) {
        failed.push({ driftId: c.driftId, sku: c.sku, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // Bounded audit trail: one event per accepted hunk + one bulk summary.
    const acceptedBySku = new Map(collisionFree.map((c) => [c.sku, c]));
    const acceptedHunks: Array<{ sku: string; driftId: string; hunk: FrozenBulkHunk; product: ValidatedMerge }> = [];
    for (const sku of resolvedSkus) {
      const c = acceptedBySku.get(sku);
      if (!c) continue;
      for (const fh of c.frozenHunks) {
        if (acceptedHunks.length >= DRIFT_BULK_MAX_HUNKS) break;
        acceptedHunks.push({ sku, driftId: c.driftId, hunk: fh, product: c });
      }
      if (acceptedHunks.length >= DRIFT_BULK_MAX_HUNKS) break;
    }
    for (const entry of acceptedHunks) {
      const c = entry.product;
      const fh = entry.hunk;
      try {
        addAuditLog({
          workspaceId,
          entityType: 'drift_hunk',
          entityId: c.driftId,
          action: 'drift_hunk_accepted',
          message: `Bulk accepted remote ${fh.field} for SKU "${entry.sku}" (${fh.baselineValue ?? 'null'} → ${fh.remoteValue ?? 'null'})`,
          detailsJson: JSON.stringify({
            sku: entry.sku,
            field: fh.field,
            baselineValue: fh.baselineValue,
            remoteValue: fh.remoteValue,
            remoteHash: c.remoteHash,
            baselineCommit: c.parsedBaselineCommit,
            resultingCommit: commitHash,
            changeSetId: changeSet.id,
            bulk: true,
            trustRemote: trustAll,
            decision: 'accepted',
            actor,
            at: nowIso,
          }),
        });
      } catch {
        // Audit best-effort after honest state; never rewrites the outcome.
      }
    }
    const summaryMessage = trustAll
      ? `Bulk accepted trust-remote (*) for ${acceptedHunks.length} hunk(s) across ${resolvedSkus.length} product(s) via change set ${changeSet.id}`
      : `Bulk accepted remote ${field} for ${resolvedSkus.length} product(s) via change set ${changeSet.id}`;
    try {
      addAuditLog({
        workspaceId,
        entityType: 'drift',
        entityId: changeSet.id,
        action: 'drift_bulk_accepted',
        message: summaryMessage,
        detailsJson: JSON.stringify({
          field,
          changeSetId: changeSet.id,
          commitHash,
          resolvedSkus: resolvedSkus.slice(0, DRIFT_BULK_MAX_HUNKS),
          acceptedHunks: acceptedHunks.length,
          frozenCount: input.hunks.length,
          staleSkipped: skippedStale.length,
          heldSkipped: skippedHeld.length,
          failed: failed.length,
          baselineCommit: frozenHead,
          actor,
          at: nowIso,
        }),
      });
    } catch {
      // Bulk summary audit best-effort.
    }

    return {
      field,
      changeSetId: changeSet.id,
      commitHash,
      acceptedCount: trustAll ? acceptedHunks.length : resolvedSkus.length,
      totalFrozen: input.hunks.length,
      resolvedSkus: resolvedSkus.slice(0, DRIFT_BULK_MAX_HUNKS),
      skippedStale: skippedStale.slice(0, DRIFT_BULK_MAX_HUNKS),
      skippedHeld: skippedHeld.slice(0, DRIFT_BULK_MAX_HUNKS),
      failed: failed.slice(0, DRIFT_BULK_MAX_HUNKS),
      truncatedResponse: trustAll
        ? acceptedHunks.length > DRIFT_BULK_MAX_HUNKS || resolvedSkus.length > DRIFT_BULK_MAX_HUNKS
        : resolvedSkus.length > DRIFT_BULK_MAX_HUNKS,
    };
  } catch (e) {
    // Fail closed: no false resolved/synced. Best-effort cleanup of the
    // unapproved change set so retry never duplicates decisions.
    try {
      deleteChangeSet(changeSet.id);
    } catch {
      // Cleanup best-effort.
    }
    if (bulkFiles.length > 0) {
      try {
        execFileSync('git', ['checkout', 'HEAD', '--', ...bulkFiles], {
          cwd: workspacePath,
          stdio: 'pipe',
        });
      } catch {
        // Best effort file restoration.
      }
    }
    throw e;
  }
}
