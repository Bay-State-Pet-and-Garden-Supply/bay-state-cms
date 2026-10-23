/**
 * Drift 4b (#257) — new-product, unavailable-assignment, and
 * reconcile-lifecycle workflows.
 *
 * New remote products must enter through onboarding so their price comes from
 * the store manager's input; direct store imports are refused.
 *
 * - Page hunks are held per hunk. Pages without a stable store identity stay
 *   held; verified page moves can be reviewed individually.
 * - Reconcile drafts include only selected supported fields. Unselected
 *   changes remain available for separate review, and linked changes stay
 *   held until the change set is approved, discarded, or reopened.
 */

import { deterministicStringify, hashJson } from '../git/deterministic-json';
import {
  findDriftById,
  linkDriftToChangeSet,
  releaseSingleReconcileDrift,
} from '../db/repositories/drift-repo';
import { addAuditLog } from '../db/repositories/audit-log-repo';
import {
  buildComparisonProjection,
  diffComparisonProjections,
} from './catalog-comparison';
import { parseDriftDiff, applySingleFieldHunk, isSupportedHunkField } from './drift-hunks';
import {
  createChangeSet,
  upsertChangeSetItem,
  listChangeSetItems,
} from '../db/repositories/change-set-repo';
import { listCatalogFilenameOwners } from '../db/repositories/product-index-repo';
import { listNonDiscardedChangeSetDrafts } from '../db/repositories/change-set-repo';
import { normalizeFileName, resolveBaseFileName, resolveReimportFilename } from './file-name';
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
  if (kind === 'new' || !baseline) {
    fail(409, 'Add new products through onboarding so their price comes from your input.');
  }
  let draft: Product = baseline;
  const operation = 'update';
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
 * A remote-only product has no onboarding price authority. Keep the endpoint
 * explicit so older clients receive a clear refusal instead of importing it.
 */
export function importNewRemoteProduct(
  workspaceId: string,
  _workspacePath: string,
  input: ImportNewProductInput,
): ImportNewProductResult {
  const drift = findDriftById(input.driftId);
  if (!drift || drift.workspaceId !== workspaceId) fail(404, 'Drift record not found.');
  if (drift.status !== 'open') fail(400, `Drift status is "${drift.status}", not open.`);
  fail(409, 'Add new products through onboarding so their price comes from your input.');
}
