import { deterministicStringify } from '../git/deterministic-json';
import { findDriftById, resolveDrift, updateDriftHunkState } from '../db/repositories/drift-repo';
import { recordHunkAck } from '../db/repositories/drift-hunk-repo';
import { addAuditLog } from '../db/repositories/audit-log-repo';
import {
  buildComparisonProjection,
  buildComparisonContext,
  diffComparisonProjections,
  hashComparisonProjection,
  isComparisonContextStale,
  type FieldHunk,
} from './catalog-comparison';
import { SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION } from './built-in-output-policy';
import { SHOP_SITE_FIELD_CATALOG_VERSION } from './field-catalog';
import {
  parseDriftDiff,
  heldReasonForHunk,
  isFilenameField,
  applySingleFieldHunk,
  isSupportedHunkField,
  type HunkHeldReason,
} from './drift-hunks';
import { productKindForDrift, getReconciledFieldsForDrift, type DriftProductKind } from './drift-reconcile-service';
import { findProductBySku, updateProductIndex, listCatalogFilenameOwners } from '../db/repositories/product-index-repo';
import { indexProductPageAssignments } from '../db/repositories/page-repo';
import { listNonDiscardedChangeSetDrafts } from '../db/repositories/change-set-repo';
import { getActivePageImportHash } from '../db/repositories/page-repo';
import { normalizeFileName, resolveBaseFileName, resolveReimportFilename } from './file-name';
import { writeProductFile } from '../git/workspace-files';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import type { Product } from '../shared/types';

export interface HunkView {
  id: string;
  driftId: string;
  workspaceId: string;
  sku: string;
  field: string;
  baselineValue: string | null;
  remoteValue: string | null;
  remoteHash: string;
  baselineCommit: string | null;
  baselineSource: 'head' | 'working-tree';
  projectionVersion: string;
  detectedAt: string;
  status: string;
  heldReason: HunkHeldReason | null;
  supported: boolean;
  /** Genuinely new remote products vs changed products (#257). */
  productKind: DriftProductKind;
}

export interface ListHunksResult {
  hunks: HunkView[];
  total: number;
  fieldCounts: Record<string, number>;
}

export function expandDriftToHunks(
  drift: {
    id: string;
    workspaceId: string;
    sku: string;
    detectedAt: string;
    status: string;
    remoteHash: string;
    diffJson: string | null;
    localJson: string | null;
    reconcileChangeSetId?: string | null;
  },
  reconciledFields?: Set<string> | null,
): HunkView[] {
  const parsed = parseDriftDiff(drift as never);
  const kind = productKindForDrift(parsed);
  const reconciled =
    reconciledFields !== undefined
      ? reconciledFields
      : drift.status === 'in_reconcile'
        ? getReconciledFieldsForDrift(drift as never)
        : new Set<string>();
  return parsed.hunks.map((h, idx) => {
    const held = heldReasonForHunk(drift as never, parsed, h.field, {
      reconciledFields: reconciled,
      hunk: { baselineValue: h.baselineValue, remoteValue: h.remoteValue },
    });
    return {
      id: `${drift.id}:${h.field}:${idx}`,
      driftId: drift.id,
      workspaceId: drift.workspaceId,
      sku: drift.sku,
      field: h.field,
      baselineValue: h.baselineValue,
      remoteValue: h.remoteValue,
      remoteHash: drift.remoteHash,
      baselineCommit: parsed.baselineCommit,
      baselineSource: parsed.baselineSource,
      projectionVersion: parsed.projectionVersion,
      detectedAt: drift.detectedAt,
      status: drift.status,
      heldReason: held,
      supported: isSupportedHunkField(h.field),
      productKind: kind,
    };
  });
}

export interface ResolveHunkInput {
  driftId: string;
  field: string;
  decision: string;
  baselineValue?: string | null;
  remoteValue?: string | null;
  expectedRemoteHash?: string | null;
  expectedBaselineCommit?: string | null;
  actor?: string;
}

export interface ResolveHunkResult {
  driftId: string;
  sku: string;
  field: string;
  decision: 'accepted' | 'rejected';
  commitHash: string | null;
  remainingHunks: number;
  resolvedAll: boolean;
}

function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  throw err;
}

export function resolveSingleHunk(
  workspaceId: string,
  workspacePath: string,
  input: ResolveHunkInput,
): ResolveHunkResult {
  const { driftId, field } = input;
  const decisionRaw = input.decision;

  // Explicit per-hunk decision with no silent default (#253).
  if (decisionRaw !== 'accept' && decisionRaw !== 'reject') {
    fail(400, `Invalid decision "${String(decisionRaw)}". Use: accept, reject`);
  }
  const decision = decisionRaw as 'accept' | 'reject';

  if (!field || typeof field !== 'string' || field.trim() === '') {
    fail(400, 'Missing field: per-hunk resolution requires an explicit field.');
  }

  const drift = findDriftById(driftId);
  if (!drift) fail(404, 'Drift record not found.');
  if (drift.workspaceId !== workspaceId) fail(404, 'Drift record not found.');
  // Outstanding rows resolve per hunk. `in_reconcile` rows resolve here too
  // for fields outside the frozen reconciled set (#257 field isolation);
  // linked fields stay held by the check below. Terminal rows never resolve.
  if (drift.status !== 'open' && (drift.status as string) !== 'in_reconcile') {
    fail(400, `Drift status is "${drift.status}", not open.`);
  }

  const parsed = parseDriftDiff(drift);
  const candidates = parsed.hunks
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => h.field === field);
  if (candidates.length === 0) {
    fail(404, `No outstanding hunk for field "${field}" on SKU "${drift.sku}".`);
  }

  let chosen: { h: FieldHunk; idx: number };
  if (input.baselineValue !== undefined || input.remoteValue !== undefined) {
    const bv = input.baselineValue ?? null;
    const rv = input.remoteValue ?? null;
    const norm = (v: string | null | undefined): string => v ?? '';
    const match = candidates.find(
      ({ h }) => norm(h.baselineValue) === norm(bv) && norm(h.remoteValue) === norm(rv),
    );
    if (!match) {
      fail(404, `No outstanding hunk for field "${field}" with the given values on SKU "${drift.sku}".`);
    }
    chosen = match!;
  } else if (candidates.length > 1) {
    fail(
      400,
      `Multiple outstanding hunks share field "${field}" on SKU "${drift.sku}". Supply baselineValue and remoteValue to disambiguate.`,
    );
  } else {
    chosen = candidates[0];
  }
  const hunk = chosen.h;

  // Held-aside cases (#257): new products resolve via the explicit import
  // workflow; reconcile holds only linked fields (unrelated fields on the
  // same product stay resolvable); unavailable page assignments hold accepts
  // but stay explicitly rejectable so local assignments are never silently
  // corrupted.
  const reconciledForHold =
    (drift.status as string) === 'in_reconcile'
      ? getReconciledFieldsForDrift(drift)
      : new Set<string>();
  const held = heldReasonForHunk(drift, parsed, field, {
    reconciledFields: reconciledForHold,
    hunk: { baselineValue: hunk.baselineValue, remoteValue: hunk.remoteValue },
  });
  if (held === 'unavailable_assignment' && decision === 'reject') {
    // Explicit keep-local for an unverified remote page: safe, binds the
    // same acknowledgement as any other reject below.
  } else if (held) {
    const reasonMsg =
      held === 'new_product'
        ? `Hunk for SKU "${drift.sku}" is held: genuinely new remote products import via POST /api/drift/${drift.id}/import-new (confirmed:true), not per-hunk accept.`
        : held === 'in_reconcile'
          ? `Hunk for field "${field}" on SKU "${drift.sku}" is held: it is linked to reconcile change set ${drift.reconcileChangeSetId ?? 'unknown'}. Approve, discard, or reopen the reconcile to settle it; unrelated fields stay resolvable.`
          : `Hunk for field "${field}" on SKU "${drift.sku}" is held: unavailable page assignments resolve explicitly, never by silent overwrite — the remote page has no stable live-store identity. Reject to keep local, or reconcile for manual merge.`;
    fail(409, reasonMsg);
  }

  if (!isSupportedHunkField(field)) {
    fail(400, `Unsupported drift field "${field}" for single-hunk apply.`);
  }

  // Staleness: a changed baseline or newer remote invalidates before apply.
  if (input.expectedRemoteHash != null && input.expectedRemoteHash !== drift.remoteHash) {
    fail(409, `Stale hunk: remote observation changed for SKU "${drift.sku}" (expected ${input.expectedRemoteHash}, found ${drift.remoteHash}). Re-review before applying.`);
  }
  const expectedBase = input.expectedBaselineCommit ?? null;
  if (expectedBase !== undefined && expectedBase !== null && expectedBase !== parsed.baselineCommit) {
    fail(
      409,
      `Stale hunk: baseline moved for SKU "${drift.sku}" (expected ${expectedBase ?? 'null'}, found ${parsed.baselineCommit ?? 'null'}). Re-review before applying.`,
    );
  }
  // Live baseline check: HEAD moved since detection.
  try {
    const git = new GitClient(workspacePath);
    if (git.isRepo() && parsed.baselineCommit) {
      const head = git.getHeadHash() || null;
      if (head && head !== parsed.baselineCommit) {
        fail(
          409,
          `Stale hunk: approved baseline moved for SKU "${drift.sku}" (recorded ${parsed.baselineCommit}, HEAD is ${head}). Re-check drift before applying.`,
        );
      }
    }
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw e;
    // Git read failures never block with false staleness; continue.
  }
  // Context staleness: page import or policy/catalog versions moved.
  try {
    const currentPageHash = getActivePageImportHash(workspaceId);
    const currentCtx = buildComparisonContext(currentPageHash);
    const recorded = parsed.context;
    if (recorded && isComparisonContextStale(recorded, currentCtx)) {
      fail(
        409,
        `Stale hunk: comparison context changed for SKU "${drift.sku}" (page import or policy version moved). Re-check drift before applying.`,
      );
    }
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw e;
  }

  const actor = input.actor ?? workspaceId;
  const nowIso = new Date().toISOString();

  if (decision === 'reject') {
    // Bind acknowledgement to reviewed field, state, and context.
    recordHunkAck({
      workspaceId,
      sku: drift.sku,
      field: hunk.field,
      baselineValue: hunk.baselineValue,
      remoteValue: hunk.remoteValue,
      remoteHash: drift.remoteHash,
      baselineCommit: parsed.baselineCommit,
      projectionVersion: parsed.projectionVersion,
      builtInPolicyVersion: parsed.context?.builtInPolicyVersion ?? SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
      fieldCatalogVersion: parsed.context?.fieldCatalogVersion ?? SHOP_SITE_FIELD_CATALOG_VERSION,
      pageImportHash: parsed.context?.pageImportHash ?? null,
      decision: 'rejected',
      actor,
    });

    const remaining = parsed.hunks.filter((_, i) => i !== chosen.idx);
    if (remaining.length === 0) {
      resolveDrift(drift.id, 'kept_local');
    } else {
      const nextDiff = {
        ...(parsed.raw as Record<string, unknown>),
        hunks: remaining,
      };
      updateDriftHunkState(drift.id, {
        localHash: drift.localHash,
        localJson: drift.localJson,
        diffJson: deterministicStringify(nextDiff),
      });
    }

    addAuditLog({
      workspaceId,
      entityType: 'drift_hunk',
      entityId: drift.id,
      action: 'drift_hunk_rejected',
      message: `Rejected remote ${field} for SKU "${drift.sku}" (kept local ${hunk.baselineValue ?? 'null'})`,
      detailsJson: JSON.stringify({
        sku: drift.sku,
        field,
        baselineValue: hunk.baselineValue,
        remoteValue: hunk.remoteValue,
        remoteHash: drift.remoteHash,
        baselineCommit: parsed.baselineCommit,
        decision: 'rejected',
        actor,
        at: nowIso,
      }),
    });

    return {
      driftId: drift.id,
      sku: drift.sku,
      field,
      decision: 'rejected',
      commitHash: null,
      remainingHunks: remaining.length,
      resolvedAll: remaining.length === 0,
    };
  }

  // Accept: preserve every unrelated field + existing identity.
  let baselineProduct: Product | null = null;
  let remoteProduct: Product | null = null;
  try {
    baselineProduct = drift.localJson ? (JSON.parse(drift.localJson) as Product) : null;
  } catch {
    fail(400, `Baseline product for SKU "${drift.sku}" is unreadable; re-check drift.`);
  }
  try {
    remoteProduct = JSON.parse(drift.remoteJson) as Product;
  } catch {
    fail(400, `Remote product for SKU "${drift.sku}" is unreadable; re-check drift.`);
  }
  if (!baselineProduct) {
    fail(409, `Hunk for SKU "${drift.sku}" is held: genuinely new remote products import via POST /api/drift/${drift.id}/import-new (confirmed:true), not per-hunk accept.`);
  }

  const merged = applySingleFieldHunk(baselineProduct!, remoteProduct!, field);

  // Filename-collision protection holds from this first accepting slice.
  const mergedFileName = (() => {
    try {
      // Effective name after this single-field merge.
      const explicit = normalizeFileName(
        (merged.customFields?.['FileName'] as unknown) ?? (merged.core?.seo?.fileName as unknown) ?? null,
      );
      if (explicit) return explicit;
      return resolveBaseFileName(merged);
    } catch {
      return null;
    }
  })();
  if (mergedFileName && isFilenameField(field)) {
    const owners = new Map<string, string>();
    try {
      for (const { sku, fileName } of listCatalogFilenameOwners()) {
        const key = fileName.toLowerCase();
        if (!owners.has(key)) owners.set(key, sku);
      }
    } catch {
      // Minimal DBs without the catalog index: fall through to preserve.
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
      // Change-set reads never block the accept path itself.
    }
    const disposition = resolveReimportFilename(mergedFileName, merged.sku, owners);
    if (disposition.action === 'hold_collision') {
      fail(
        409,
        `IMPORT_FILENAME_COLLISION: pulled FileName "${disposition.name}" for SKU ${merged.sku} is owned by ${disposition.ownerSku}. Repair through a reviewed change set; live pages are never renamed automatically.`,
      );
    }
  }

  // Write through the approved catalog path (same commit discipline).
  writeProductFile(workspacePath, merged);
  // Keep verified Category Page assignments indexed: verified page accepts
  // must land in product_pages with stable identities, and held (unverified)
  // accepts never reach this line.
  try {
    if (field === 'core.productOnPages') indexProductPageAssignments(merged);
  } catch {
    // Page indexing never blocks the accept path itself.
  }
  const mergedProjection = buildComparisonProjection(merged);
  const mergedHash = hashComparisonProjection(mergedProjection);
  const remoteProjection = buildComparisonProjection(remoteProduct!);
  const nowMatchesRemote = mergedHash === hashComparisonProjection(remoteProjection);

  let commitHash: string | null = null;
  const git = new GitClient(workspacePath);
  if (git.isRepo()) {
    git.add([skuToProductFilePath(merged.sku)]);
    if (git.status()) {
      git.commit(`Accept remote ${field} for ${merged.sku} (drift hunk)`);
      commitHash = git.getHeadHash() || null;
    } else {
      commitHash = git.getHeadHash() || parsed.baselineCommit;
    }
  }

  const existing = findProductBySku(merged.sku);
  if (existing) {
    updateProductIndex({
      sku: merged.sku,
      title: merged.core.name,
      status: merged.status,
      price: merged.core.price,
      inventoryQuantity: merged.core.inventory.quantityOnHand,
      primaryImage: merged.core.media.primary,
      productHash: mergedHash,
      lastPulledRemoteHash: drift.remoteHash,
      lastSyncedRemoteHash: nowMatchesRemote ? drift.remoteHash : existing.lastSyncedRemoteHash,
      lastSyncedAt: nowMatchesRemote ? nowIso : existing.lastSyncedAt,
      syncStatus: nowMatchesRemote ? 'synced' : 'drifted',
      hasAdvancedBlocks: Object.keys(merged.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
      description: merged.core.description,
      searchKeywords: merged.core.seo.searchKeywords,
      customFields: merged.customFields,
      ...(commitHash ? { lastApprovedCommit: commitHash } : {}),
    });
  }

  // Recompute remaining hunks against the new baseline so surviving
  // baselineValues are never stale.
  const newBaselineProjection = buildComparisonProjection(merged);
  const newHunks = diffComparisonProjections(newBaselineProjection, remoteProjection);
  // The accepted hunk must be gone; any reappearance means the merge did
  // not converge (fail closed rather than reporting false resolution).
  const acceptedStillDiffers = newHunks.some(
    (h) => h.field === field && (h.baselineValue ?? '') === (hunk.baselineValue ?? '') && (h.remoteValue ?? '') === (hunk.remoteValue ?? ''),
  );
  if (acceptedStillDiffers) {
    fail(500, `Acceptance did not converge for field "${field}" on SKU "${drift.sku}"; re-check drift.`);
  }

  if (newHunks.length === 0) {
    resolveDrift(drift.id, 'accepted_remote');
  } else {
    const nextDiff = {
      ...(parsed.raw as Record<string, unknown>),
      hunks: newHunks,
      baselineCommit: commitHash ?? parsed.baselineCommit,
      baselineDirty: false,
    };
    updateDriftHunkState(drift.id, {
      localHash: mergedHash,
      localJson: deterministicStringify(merged),
      diffJson: deterministicStringify(nextDiff),
    });
  }

  addAuditLog({
    workspaceId,
    entityType: 'drift_hunk',
    entityId: drift.id,
    action: 'drift_hunk_accepted',
    message: `Accepted remote ${field} for SKU "${drift.sku}" (${hunk.baselineValue ?? 'null'} → ${hunk.remoteValue ?? 'null'})`,
    detailsJson: JSON.stringify({
      sku: drift.sku,
      field,
      baselineValue: hunk.baselineValue,
      remoteValue: hunk.remoteValue,
      remoteHash: drift.remoteHash,
      baselineCommit: parsed.baselineCommit,
      resultingCommit: commitHash,
      catalogRef: skuToProductFilePath(merged.sku),
      decision: 'accepted',
      actor,
      at: nowIso,
    }),
  });

  return {
    driftId: drift.id,
    sku: drift.sku,
    field,
    decision: 'accepted',
    commitHash,
    remainingHunks: newHunks.length,
    resolvedAll: newHunks.length === 0,
  };
}
