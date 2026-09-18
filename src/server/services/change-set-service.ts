import fs from 'node:fs';
import path from 'node:path';
import {
  comparisonHashForProduct,
  buildComparisonProjection,
  diffComparisonProjections,
  hashComparisonProjection,
  CATALOG_COMPARISON_PROJECTION_VERSION,
} from '../../shopsite/catalog-comparison';
import { writeProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import {
  findChangeSetById, listChangeSets, listChangeSetItems,
  updateChangeSetStatus, deleteChangeSet,
} from '../../db/repositories/change-set-repo';
import {
  findProductBySku, insertProductIndex, updateProductIndex,
} from '../../db/repositories/product-index-repo';
import { reopenDriftForChangeSet, listLinkedDrifts, resolveDrift, findDriftById, updateDriftHunkState, releaseSingleReconcileDrift } from '../../db/repositories/drift-repo';
import { findHunkAck } from '../../db/repositories/drift-hunk-repo';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { getReconciledFieldsForDrift } from '../../shopsite/drift-reconcile-service';
import { SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION } from '../../shopsite/built-in-output-policy';
import { SHOP_SITE_FIELD_CATALOG_VERSION } from '../../shopsite/field-catalog';
import { getActivePageImportHash, getPageByName } from '../../db/repositories/page-repo';
import { readProductFile } from '../../git/workspace-files';
import { deterministicStringify } from '../../git/deterministic-json';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { GitClient } from '../../git/git-client';
import { validateChangeSet } from '../../validation/change-set-validation';
import type { ChangeSetRow, ChangeSetItemRow } from '../../db/repositories/change-set-repo';
import type { Product } from '../../shared/types';

/**
 * List change sets for a workspace.
 */
export function listWorkspaceChangeSets(workspaceId: string) {
  return listChangeSets(workspaceId);
}

/**
 * Get change set details with items.
 */
export function getChangeSetDetail(changeSetId: string): {
  changeSet: ChangeSetRow | null;
  items: ChangeSetItemRow[];
} {
  const changeSet = findChangeSetById(changeSetId);
  const items = changeSet ? listChangeSetItems(changeSetId) : [];
  return { changeSet, items };
}

/**
 * Approve a change set after validation:
 * - Writes deterministic product JSON files
 * - Updates product index
 * - Creates one Git commit
 */
export function approveChangeSet(
  changeSetId: string,
  workspacePath: string,
): { success: boolean; commitHash?: string; errors: string[] } {
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) {
    return { success: false, errors: ['Change set not found'] };
  }

  if (changeSet.status !== 'draft') {
    return { success: false, errors: [`Cannot approve change set in status "${changeSet.status}"`] };
  }

  // Validate first
  const validation = validateChangeSet(changeSetId);
  if (!validation.canApprove) {
    return {
      success: false,
      errors: [`Change set has ${validation.blockers} blocker(s) preventing approval`],
    };
  }

  const items = listChangeSetItems(changeSetId);
  const errors: string[] = [];
  const committedSkus: string[] = [];

  // Write product files and update index
  for (const item of items) {
    try {
      const product = JSON.parse(item.draftJson) as Product;
      writeProductFile(workspacePath, product);

      // Update product index
      const existing = findProductBySku(item.sku);
      // Canonical comparison hash owned by the import/check slice (#252):
      // approval writes the same value drift checking reads so approved
      // products compare equal. Approval never advances remote-observation
      // (lastPulledRemoteHash) or successful-sync (lastSyncedRemoteHash /
      // lastSyncedAt) pointers merely because local approved state changed —
      // those stay untouched here (update) or null (insert, unverified
      // pending recheck). Sync status moves to not_synced (local ahead).
      const productHash = comparisonHashForProduct(product);
      const hasAdvanced = product.shopsite.preserved.advancedBlocks
        && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0;
      const hasWarnings = item.validationStatus === 'warning' ? 1 : 0;

      if (existing) {
        updateProductIndex({
          sku: item.sku,
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash,
          hasAdvancedBlocks: hasAdvanced ? 1 : 0,
          hasWarnings,
          syncStatus: 'not_synced',
          lastApprovedCommit: undefined, // Will be set after commit
          description: product.core.description,
          searchKeywords: product.core.seo.searchKeywords,
          customFields: product.customFields,
        });
      } else {
        insertProductIndex({
          id: product.id,
          sku: item.sku,
          filePath: skuToProductFilePath(item.sku),
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash,
          lastApprovedCommit: null,
          lastPulledRemoteHash: null,
          lastSyncedRemoteHash: null,
          lastSyncedAt: null,
          syncStatus: 'not_synced',
          hasAdvancedBlocks: hasAdvanced ? 1 : 0,
          hasWarnings,
          createdAt: product.metadata.createdAt,
          updatedAt: product.metadata.updatedAt,
          description: product.core.description,
          searchKeywords: product.core.seo.searchKeywords,
          customFields: product.customFields,
        });
      }

      committedSkus.push(item.sku);
    } catch (err) {
      errors.push(`Failed to write product ${item.sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0 && committedSkus.length === 0) {
    return { success: false, errors };
  }

  // Git commit
  const git = new GitClient(workspacePath);
  const candidateFiles: string[] = ['products/', 'store/', '.gitignore'];

  // Only add changed product files
  for (const sku of committedSkus) {
    candidateFiles.push(skuToProductFilePath(sku));
  }

  const stagedFiles = candidateFiles.filter(f => fs.existsSync(path.join(workspacePath, f)));

  try {
    if (stagedFiles.length > 0) {
      git.add(stagedFiles);
    }
    const commitMessage = `Change set: ${changeSet.title} (${committedSkus.length} product(s))`;
    let commitHash: string;
    try {
      git.commit(commitMessage);
      commitHash = git.getHeadHash();
    } catch (commitErr) {
      const stdout = String((commitErr as any)?.stdout?.toString() ?? '');
      const stderr = String((commitErr as any)?.stderr?.toString() ?? '');
      const errMsg = `${commitErr instanceof Error ? commitErr.message : String(commitErr)} ${stdout} ${stderr}`;
      if (errMsg.includes('nothing added to commit') || errMsg.includes('nothing to commit') || errMsg.includes('working tree clean')) {
        commitHash = git.getHeadHash();
      } else {
        throw commitErr;
      }
    }

    // Update change set status
    updateChangeSetStatus(changeSetId, 'approved', commitHash);

    // Update product index with commit hash
    for (const sku of committedSkus) {
      try {
        updateProductIndex({ sku, lastApprovedCommit: commitHash });
      } catch { /* skip */ }
    }

        // Resolve linked reconcile drifts against the newly approved baseline
    // (#257 lifecycle): every drift linked to this change set is settled,
    // not just the first row. Recompute remaining hunks per SKU so surviving
    // values are never stale: fully merged drifts resolve, drifts with
    // remaining differences return to `open` (link cleared) with updated
    // hunk content instead of being silently cleared.
    try {
      const linked = listLinkedDrifts(changeSet.workspaceId, changeSetId);
      for (const linkedRow of linked) {
        try {
          settleLinkedDriftAfterApproval(changeSet.workspaceId, linkedRow.id, commitHash, workspacePath);
        } catch { /* per-drift best-effort; commit already landed */ }
      }
    } catch { /* skip */ }

    // Audit log
    addAuditLog({
      workspaceId: changeSet.workspaceId,
      entityType: 'change_set',
      entityId: changeSetId,
      action: 'approved',
      message: `Change set "${changeSet.title}" approved with ${committedSkus.length} product(s). Commit: ${commitHash}`,
      detailsJson: JSON.stringify({ committedSkus, commitHash, errors: errors.length > 0 ? errors : undefined }),
    });

    return { success: true, commitHash, errors };
  } catch (err) {
    return {
      success: false,
      errors: [`Git commit failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Discard/delete a change set in any status.
 * Cleans up old, approved, or abandoned change sets without restriction.
 * Reopens any linked drift rows so the same remote differences remain blocking.
 */
export function discardChangeSet(changeSetId: string): { success: boolean; reopenedDrift?: boolean } {
  const cs = findChangeSetById(changeSetId);
  if (!cs) return { success: false };
  const workspaceId = cs.workspaceId;
  const linkedBefore = cs.status === 'draft' ? listLinkedDrifts(workspaceId, changeSetId) : [];
  deleteChangeSet(changeSetId);

  // Reopen linked drift so remote differences stay blocking
  if (cs.status === 'draft') {
    reopenDriftForChangeSet(workspaceId, changeSetId);
    // Every reopened hunk stays answerable: one audit event per drift.
    for (const row of linkedBefore) {
      try {
        addAuditLog({
          workspaceId,
          entityType: 'drift',
          entityId: row.id,
          action: 'drift_reconcile_reopened',
          message: `Reopened reconcile for SKU "${row.sku}" back to open (change set ${changeSetId} discarded)`,
          detailsJson: JSON.stringify({
            sku: row.sku,
            changeSetId,
            decision: 'reopened',
            reason: 'change-set-discarded',
            actor: workspaceId,
            at: new Date().toISOString(),
          }),
        });
      } catch { /* audit best-effort */ }
    }
  }
  return { success: true, reopenedDrift: cs.status === 'draft' };
}

/**
 * Settle one reconcile-linked drift after its change set is approved (#257).
 *
 * The approved product file is the new baseline: diff it against the frozen
 * remote observation (minus explicit rejections, which stay suppressed) and
 * either resolve the drift when nothing visible remains or return it to
 * `open` with refreshed hunk content. Unrelated outstanding fields that the
 * operator did not reconcile are therefore never silently cleared — they
 * come back as open hunks with current before/after values.
 */
function settleLinkedDriftAfterApproval(
  workspaceId: string,
  driftId: string,
  commitHash: string,
  workspacePath: string,
): void {
  const drift = findDriftById(driftId);
  if (!drift || drift.workspaceId !== workspaceId) return;
  if (drift.status !== 'in_reconcile') return;
  const changeSetId = drift.reconcileChangeSetId;
  const reconciled = getReconciledFieldsForDrift(drift);

  let remote: Product;
  try {
    remote = JSON.parse(drift.remoteJson) as Product;
  } catch {
    return;
  }
  let newBaseline: Product;
  try {
    const loaded = readProductFile(workspacePath, drift.sku);
    if (!loaded) return;
    newBaseline = loaded;
  } catch {
    return;
  }

  const pageImportHash: string | null = (() => {
    try {
      return getActivePageImportHash(workspaceId);
    } catch {
      return null;
    }
  })();
  const resolvePageIdentity = (pageName: string): string | null => {
    try {
      const page = getPageByName(pageName);
      if (page && page.identityStatus === 'verified' && page.availability === 'available' && page.identityKey) {
        return `${page.identityKind}:${page.identityKey}`;
      }
    } catch {
      // No page index: fall back to name identity (missing identity path).
    }
    return null;
  };

  const newBaselineProj = buildComparisonProjection(newBaseline, { resolvePageIdentity, pageImportHash });
  const remoteProj = buildComparisonProjection(remote, { resolvePageIdentity, pageImportHash });
  const allHunks = diffComparisonProjections(newBaselineProj, remoteProj);
  const newBaselineHash = hashComparisonProjection(newBaselineProj);
  const baselineCommitKey = commitHash ?? '';
  const pageHashKey = pageImportHash ?? '';
  const visibleHunks = allHunks.filter((h) => {
    try {
      return !findHunkAck({
        workspaceId,
        sku: drift.sku,
        field: h.field,
        baselineValue: h.baselineValue ?? '',
        remoteValue: h.remoteValue ?? '',
        remoteHash: drift.remoteHash,
        baselineCommit: baselineCommitKey,
        projectionVersion: CATALOG_COMPARISON_PROJECTION_VERSION,
        builtInPolicyVersion: SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
        fieldCatalogVersion: SHOP_SITE_FIELD_CATALOG_VERSION,
        pageImportHash: pageHashKey,
      });
    } catch {
      return true;
    }
  });

  const nowIso = new Date().toISOString();
  if (visibleHunks.length === 0) {
    resolveDrift(drift.id, 'resolved');
    addAuditLog({
      workspaceId,
      entityType: 'drift',
      entityId: drift.id,
      action: 'drift_reconcile_approved',
      message: `Reconcile approved for SKU "${drift.sku}" via change set ${changeSetId ?? 'unknown'} — no hunks remain`,
      detailsJson: JSON.stringify({
        sku: drift.sku,
        changeSetId,
        reconciledFields: reconciled ? [...reconciled] : null,
        remainingHunks: 0,
        resultingCommit: commitHash,
        decision: 'reconciled',
        actor: workspaceId,
        at: nowIso,
      }),
    });
    return;
  }

  const parsed = parseDriftDiff(drift);
  const nextDiff = {
    ...((parsed.raw as Record<string, unknown>) ?? {}),
    hunks: visibleHunks,
    baselineCommit: commitHash ?? parsed.baselineCommit,
    baselineDirty: false,
  };
  updateDriftHunkState(drift.id, {
    localHash: newBaselineHash,
    localJson: deterministicStringify(newBaseline),
    diffJson: deterministicStringify(nextDiff),
  });
  releaseSingleReconcileDrift(drift.id, workspaceId);
  addAuditLog({
    workspaceId,
    entityType: 'drift',
    entityId: drift.id,
    action: 'drift_reconcile_approved',
    message: `Reconcile approved for SKU "${drift.sku}" via change set ${changeSetId ?? 'unknown'} — ${visibleHunks.length} hunk(s) remain open`,
    detailsJson: JSON.stringify({
      sku: drift.sku,
      changeSetId,
      reconciledFields: reconciled ? [...reconciled] : null,
      remainingFields: visibleHunks.map((h) => h.field),
      remainingHunks: visibleHunks.length,
      resultingCommit: commitHash,
      decision: 'reconciled',
      actor: workspaceId,
      at: nowIso,
    }),
  });
}
