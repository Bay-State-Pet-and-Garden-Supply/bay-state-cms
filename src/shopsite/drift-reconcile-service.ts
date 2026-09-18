/**
 * Drift 4b (#257) — new-product, unavailable-assignment, and
 * reconcile-lifecycle workflows.
 *
 * The existing-product slice (#253) deliberately holds three cases aside:
 * genuinely new remote products, page assignments without a stable
 * live-store identity, and reconcile-linked rows. This service promotes
 * every held-aside case to a first-class workflow:
 *
 * - New remote products resolve via an explicit import workflow
 *   (`importNewProduct`) that is distinct from per-hunk acceptance and
 *   carries the same filename-collision and audit discipline.
 * - Page hunks are held per hunk, not per field: only remote values without
 *   a stable identity (`name:*`) hold as `unavailable_assignment`. Verified
 *   (`id:*`) page moves resolve like any other hunk. Held page accepts fail
 *   closed; explicit reject (keep local) and reconcile (manual merge) stay
 *   open so local assignments are never silently corrupted.
 * - Reconcile is field-selective: creation records an explicit field list in
 *   the frozen change-set draft (baseline + selected remote fields), and the
 *   reconciled set is derived from that frozen draft (base vs draft diff).
 *   Unrelated outstanding fields on the same product stay resolvable while
 *   linked fields flow through creation → rechecks → approval → discard →
 *   reopen, each step defined across every linked hunk.
 */

import { deterministicStringify, hashJson } from '../git/deterministic-json';
import {
  findDriftById,
  resolveDrift,
  linkDriftToChangeSet,
  releaseSingleReconcileDrift,
} from '../db/repositories/drift-repo';
import { addAuditLog } from '../db/repositories/audit-log-repo';
import {
  buildComparisonProjection,
  diffComparisonProjections,
  hashComparisonProjection,
} from './catalog-comparison';
import { parseDriftDiff, applySingleFieldHunk, isSupportedHunkField } from './drift-hunks';
import {
  createChangeSet,
  upsertChangeSetItem,
  listChangeSetItems,
} from '../db/repositories/change-set-repo';
import {
  findProductBySku,
  insertProductIndex,
  updateProductIndex,
  listCatalogFilenameOwners,
} from '../db/repositories/product-index-repo';
import { listNonDiscardedChangeSetDrafts } from '../db/repositories/change-set-repo';
import { indexProductPageAssignments } from '../db/repositories/page-repo';
import { normalizeFileName, resolveBaseFileName, resolveReimportFilename } from './file-name';
import { writeProductFile } from '../git/workspace-files';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import type { Product } from '../shared/types';

function fail(status: number, message: string): never {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  throw err;
}

/** Product kind: genuinely new remote products vs changed products. */
export type DriftProductKind = 'new' | 'changed';

export function productKindForDrift(parsed: { hasLocalProduct: boolean }): DriftProductKind {
  return parsed.hasLocalProduct ? 'changed' : 'new';
}

/**
 * Reconciled field set for an `in_reconcile` drift, derived from the frozen
 * linked change-set draft (base vs draft comparison diff).
 *
 * Returns null when the set cannot be determined (no link, missing change
 * set, unreadable payloads) — callers fail closed and hold every hunk until
 * the operator reopens. A non-reconcile row yields an empty set.
 */
export function getReconciledFieldsForDrift(drift: {
  status: string;
  reconcileChangeSetId: string | null;
}): Set<string> | null {
  if (drift.status !== 'in_reconcile') return new Set();
  const csId = drift.reconcileChangeSetId;
  if (!csId) return null;
  let items;
  try {
    items = listChangeSetItems(csId);
  } catch {
    return null;
  }
  if (!items || items.length === 0) return null;
  const fields = new Set<string>();
  try {
    for (const item of items) {
      let base: Product | null = null;
      let draft: Product | null = null;
      try {
        base = item.baseJson ? (JSON.parse(item.baseJson) as Product) : null;
      } catch {
        return null;
      }
      try {
        draft = JSON.parse(item.draftJson) as Product;
      } catch {
        return null;
      }
      if (!draft) return null;
      const baseProj = base ? buildComparisonProjection(base) : null;
      const draftProj = buildComparisonProjection(draft);
      for (const h of diffComparisonProjections(baseProj, draftProj)) {
        fields.add(h.field);
      }
    }
  } catch {
    return null;
  }
  return fields;
}

export interface CreateReconcileInput {
  driftId: string;
  /** Explicit subset of outstanding fields. Omitted/empty = all outstanding. */
  fields?: string[];
  actor?: string;
}

export interface CreateReconcileResult {
  driftId: string;
  sku: string;
  changeSetId: string;
  fields: string[];
  productKind: DriftProductKind;
}

/**
 * Create a reconcile change set for manual merge. Accepts an explicit field
 * subset so selected-field reconciliation is never blocked by unrelated
 * outstanding fields: the frozen draft carries baseline + selected remote
 * fields only, and unselected hunks stay resolvable via the normal hunk
 * path while linked fields resolve through approval/discard/reopen.
 */
export function createReconcileChangeSet(
  workspaceId: string,
  workspacePath: string,
  input: CreateReconcileInput,
): CreateReconcileResult {
  const drift = findDriftById(input.driftId);
  if (!drift) fail(404, 'Drift record not found.');
  if (drift!.workspaceId !== workspaceId) fail(404, 'Drift record not found.');
  if (drift!.status !== 'open') {
    fail(400, `Drift status is "${drift!.status}", not open. Reopen or approve the linked reconcile first.`);
  }

  const parsed = parseDriftDiff(drift!);
  const kind = productKindForDrift(parsed);
  const outstanding = parsed.hunks.map((h) => h.field);
  if (outstanding.length === 0) {
    fail(400, `No outstanding hunks for SKU "${drift!.sku}". Re-check drift before reconciling.`);
  }

  let selected: string[];
  if (input.fields == null || input.fields.length === 0) {
    selected = [...new Set(outstanding)];
  } else {
    selected = [...new Set(input.fields.map((f) => String(f)))];
    for (const f of selected) {
      if (!outstanding.includes(f)) {
        fail(404, `No outstanding hunk for field "${f}" on SKU "${drift!.sku}". Re-check drift before reconciling.`);
      }
    }
  }

  let baseline: Product | null = null;
  let remote: Product | null = null;
  try {
    baseline = drift!.localJson ? (JSON.parse(drift!.localJson) as Product) : null;
  } catch {
    fail(400, `Baseline product for SKU "${drift!.sku}" is unreadable; re-check drift.`);
  }
  try {
    remote = JSON.parse(drift!.remoteJson) as Product;
  } catch {
    fail(400, `Remote product for SKU "${drift!.sku}" is unreadable; re-check drift.`);
  }

  const actor = input.actor ?? workspaceId;
  const nowIso = new Date().toISOString();
  const isNew = kind === 'new' || !baseline;

  // Draft construction: new products carry the whole remote product as a
  // `create`; existing products carry baseline + selected remote fields so
  // unselected fields never join the frozen selection.
  let draft: Product;
  let operation: string;
  if (isNew) {
    draft = remote!;
    operation = 'create';
  } else {
    operation = 'update';
    draft = baseline!;
    for (const field of selected) {
      if (!isSupportedHunkField(field) && field !== 'core.productOnPages' && field !== 'sku') {
        fail(400, `Unsupported drift field "${field}" for reconcile.`);
      }
      if (field === 'sku') {
        fail(400, 'SKU is identity and is never reconciled field-by-field.');
      }
      try {
        draft = applySingleFieldHunk(draft, remote!, field);
      } catch (e) {
        fail(400, e instanceof Error ? e.message : String(e));
      }
    }
  }

  // Filename-collision protection: a reconciled draft that would claim a
  // name owned by another SKU holds before any link is created.
  try {
    const owners = new Map<string, string>();
    for (const { sku, fileName } of listCatalogFilenameOwners()) {
      const key = fileName.toLowerCase();
      if (!owners.has(key)) owners.set(key, sku);
    }
    for (const { sku, draftJson } of listNonDiscardedChangeSetDrafts(workspaceId)) {
      try {
        const base = resolveBaseFileName(JSON.parse(draftJson) as Product);
        const key = base.toLowerCase();
        if (!owners.has(key)) owners.set(key, sku);
      } catch {
        continue;
      }
    }
    const effective = (() => {
      try {
        const explicit = normalizeFileName(
          (draft.customFields?.['FileName'] as unknown) ?? (draft.core?.seo?.fileName as unknown) ?? null,
        );
        return explicit || resolveBaseFileName(draft);
      } catch {
        return null;
      }
    })();
    if (effective) {
      const disposition = resolveReimportFilename(effective, draft.sku, owners);
      if (disposition.action === 'hold_collision') {
        fail(
          409,
          `IMPORT_FILENAME_COLLISION: reconciled FileName "${disposition.name}" for SKU ${draft.sku} is owned by ${disposition.ownerSku}. Repair through a reviewed change set; live pages are never renamed automatically.`,
        );
      }
    }
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw e;
    // Owner-index reads never block reconcile creation itself.
  }

  let baseCommit: string | null = parsed.baselineCommit;
  try {
    const git = new GitClient(workspacePath);
    if (git.isRepo()) baseCommit = git.getHeadHash() || parsed.baselineCommit;
  } catch {
    // Keep recorded baseline on git read failure.
  }

  const cs = createChangeSet({
    workspaceId,
    title: `Drift reconcile: ${drift!.sku} (${selected.length} field(s))`,
    description: `Manual merge for drift. SKU: ${drift!.sku}. Fields: ${selected.join(', ')}. Frozen baseline: ${parsed.baselineCommit ?? 'unknown'}.`,
    baseCommit: baseCommit ?? 'unknown',
  });
  upsertChangeSetItem({
    changeSetId: cs.id,
    sku: drift!.sku,
    operation,
    draftJson: deterministicStringify(draft),
    baseJson: drift!.localJson,
    draftHash: hashJson(draft),
  });

  linkDriftToChangeSet(drift!.id, cs.id, 'in_reconcile');

  addAuditLog({
    workspaceId,
    entityType: 'drift',
    entityId: drift!.id,
    action: 'created_reconcile_change_set',
    message: `Created reconcile change set for SKU "${drift!.sku}" (${selected.length} field(s): ${selected.join(', ')})`,
    detailsJson: JSON.stringify({
      sku: drift!.sku,
      changeSetId: cs.id,
      status: 'in_reconcile',
      fields: selected,
      productKind: kind,
      operation,
      baselineCommit: parsed.baselineCommit,
      remoteHash: drift!.remoteHash,
      decision: 'reconciled',
      actor,
      at: nowIso,
    }),
  });

  return { driftId: drift!.id, sku: drift!.sku, changeSetId: cs.id, fields: selected, productKind: kind };
}

export interface ReopenReconcileResult {
  driftId: string;
  sku: string;
  changeSetId: string | null;
}

/**
 * Explicit reopen: release one `in_reconcile` drift back to `open` without
 * deleting its change set. Hunk content is preserved; every linked hunk
 * becomes resolvable again through the normal per-hunk path. Discard (which
 * deletes the change set) reopens through the same transition.
 */
export function reopenReconcileDrift(
  workspaceId: string,
  driftId: string,
  actor?: string,
): ReopenReconcileResult {
  const drift = findDriftById(driftId);
  if (!drift) fail(404, 'Drift record not found.');
  if (drift!.workspaceId !== workspaceId) fail(404, 'Drift record not found.');
  if (drift!.status !== 'in_reconcile') {
    fail(400, `Drift status is "${drift!.status}", not in_reconcile. Only reconcile-linked findings reopen.`);
  }
  const csId = drift!.reconcileChangeSetId;
  const released = releaseSingleReconcileDrift(drift!.id, workspaceId);
  if (released !== 1) {
    fail(409, `Drift for SKU "${drift!.sku}" is no longer reconcile-linked. Re-check drift before reopening.`);
  }
  const who = actor ?? workspaceId;
  addAuditLog({
    workspaceId,
    entityType: 'drift',
    entityId: drift!.id,
    action: 'drift_reconcile_reopened',
    message: `Reopened reconcile for SKU "${drift!.sku}" back to open${csId ? ` (change set ${csId} kept for reference)` : ''}`,
    detailsJson: JSON.stringify({
      sku: drift!.sku,
      changeSetId: csId,
      decision: 'reopened',
      actor: who,
      at: new Date().toISOString(),
    }),
  });
  return { driftId: drift!.id, sku: drift!.sku, changeSetId: csId };
}

export interface ImportNewProductInput {
  driftId: string;
  expectedRemoteHash?: string | null;
  confirmed?: boolean;
  actor?: string;
}

export interface ImportNewProductResult {
  driftId: string;
  sku: string;
  commitHash: string | null;
  productKind: DriftProductKind;
}

/**
 * Explicit new-product workflow: imports one genuinely new remote product
 * (no local baseline) into the approved catalog. Distinct from per-hunk
 * acceptance by construction — hunk resolution stays held for new products
 * and directs here. Carries staleness checks, filename-collision holds,
 * catalog-index insertion, page-assignment indexing, and a decision audit
 * with actor, time, and catalog reference.
 */
export function importNewRemoteProduct(
  workspaceId: string,
  workspacePath: string,
  input: ImportNewProductInput,
): ImportNewProductResult {
  const drift = findDriftById(input.driftId);
  if (!drift) fail(404, 'Drift record not found.');
  if (drift!.workspaceId !== workspaceId) fail(404, 'Drift record not found.');
  if (drift!.status !== 'open') {
    fail(400, `Drift status is "${drift!.status}", not open.`);
  }
  const parsed = parseDriftDiff(drift!);
  if (parsed.hasLocalProduct || drift!.localJson != null) {
    fail(
      409,
      `SKU "${drift!.sku}" already exists locally; it is a changed product, not a new one. Resolve it hunk by hunk instead of importing.`,
    );
  }
  if (input.confirmed !== true) {
    fail(400, 'Importing a genuinely new remote product requires explicit confirmation: pass confirmed:true.');
  }
  if (input.expectedRemoteHash != null && input.expectedRemoteHash !== drift!.remoteHash) {
    fail(
      409,
      `Stale new-product import: remote observation changed for SKU "${drift!.sku}" (expected ${input.expectedRemoteHash}, found ${drift!.remoteHash}). Re-review before importing.`,
    );
  }

  let remote: Product;
  try {
    remote = JSON.parse(drift!.remoteJson) as Product;
  } catch {
    fail(400, `Remote product for SKU "${drift!.sku}" is unreadable; re-check drift.`);
  }
  if (!remote!.sku) {
    fail(400, 'Cannot import a remote product without SKU.');
  }

  const actor = input.actor ?? workspaceId;
  const nowIso = new Date().toISOString();

  // Filename-collision protection holds before any write.
  const pulledName = normalizeFileName(
    (remote!.customFields?.['FileName'] as unknown) ?? (remote!.core?.seo?.fileName as unknown) ?? null,
  );
  if (pulledName) {
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
      // Change-set reads never block the import path itself.
    }
    const disposition = resolveReimportFilename(pulledName, remote!.sku, owners);
    if (disposition.action === 'hold_collision') {
      fail(
        409,
        `IMPORT_FILENAME_COLLISION: pulled FileName "${disposition.name}" for SKU ${remote!.sku} is owned by ${disposition.ownerSku}. Repair through a reviewed change set; live pages are never renamed automatically.`,
      );
    }
  }

  writeProductFile(workspacePath, remote!);
  try {
    indexProductPageAssignments(remote!);
  } catch {
    // Page indexing never blocks the import itself.
  }

  const productHash = hashComparisonProjection(buildComparisonProjection(remote!));
  const existing = findProductBySku(remote!.sku);
  if (existing) {
    updateProductIndex({
      sku: remote!.sku,
      title: remote!.core.name,
      status: remote!.status,
      price: remote!.core.price,
      inventoryQuantity: remote!.core.inventory.quantityOnHand,
      primaryImage: remote!.core.media.primary,
      productHash,
      lastPulledRemoteHash: drift!.remoteHash,
      lastSyncedRemoteHash: drift!.remoteHash,
      lastSyncedAt: nowIso,
      syncStatus: 'synced',
      hasAdvancedBlocks: Object.keys(remote!.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
      description: remote!.core.description,
      searchKeywords: remote!.core.seo.searchKeywords,
      customFields: remote!.customFields,
    });
  } else {
    insertProductIndex({
      id: remote!.id,
      sku: remote!.sku,
      filePath: skuToProductFilePath(remote!.sku),
      title: remote!.core.name,
      status: remote!.status,
      price: remote!.core.price,
      inventoryQuantity: remote!.core.inventory.quantityOnHand,
      primaryImage: remote!.core.media.primary,
      productHash,
      lastApprovedCommit: null,
      lastPulledRemoteHash: drift!.remoteHash,
      lastSyncedRemoteHash: drift!.remoteHash,
      lastSyncedAt: nowIso,
      syncStatus: 'synced',
      hasAdvancedBlocks: Object.keys(remote!.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
      hasWarnings: 0,
      createdAt: remote!.metadata.createdAt,
      updatedAt: remote!.metadata.updatedAt,
      description: remote!.core.description,
      searchKeywords: remote!.core.seo.searchKeywords,
      customFields: remote!.customFields,
    });
  }

  let commitHash: string | null = null;
  const git = new GitClient(workspacePath);
  if (git.isRepo()) {
    git.add([skuToProductFilePath(remote!.sku)]);
    const status = git.status();
    if (status) {
      git.commit(`Import genuinely new remote product ${remote!.sku} (drift)`);
      commitHash = git.getHeadHash();
    } else {
      commitHash = git.getHeadHash() || null;
    }
    try {
      updateProductIndex({ sku: remote!.sku, lastApprovedCommit: commitHash });
    } catch {
      // Index best-effort; commit already landed.
    }
  }

  resolveDrift(drift!.id, 'accepted_remote');

  addAuditLog({
    workspaceId,
    entityType: 'drift',
    entityId: drift!.id,
    action: 'drift_new_product_imported',
    message: `Imported genuinely new remote product SKU "${remote!.sku}" into the approved catalog`,
    detailsJson: JSON.stringify({
      sku: remote!.sku,
      productKind: 'new',
      remoteHash: drift!.remoteHash,
      baselineCommit: parsed.baselineCommit,
      resultingCommit: commitHash,
      catalogRef: skuToProductFilePath(remote!.sku),
      decision: 'accepted',
      actor,
      at: nowIso,
    }),
  });

  return { driftId: drift!.id, sku: remote!.sku, commitHash, productKind: 'new' };
}
