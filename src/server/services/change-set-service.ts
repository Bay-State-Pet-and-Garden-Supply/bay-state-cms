import fs from 'node:fs';
import path from 'node:path';
import {
  comparisonHashForProduct,
  buildComparisonProjection,
  diffComparisonProjections,
  hashComparisonProjection,
  CATALOG_COMPARISON_PROJECTION_VERSION,
} from '../../shopsite/catalog-comparison';
import { writeProductFile, readProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import {
  findChangeSetById, listChangeSets, listChangeSetItems,
  updateChangeSetStatus, deleteChangeSet,
  saveLinkedManifest, findLinkedManifest, markLinkedManifestCommitted, markLinkedManifestRecovered,
} from '../../db/repositories/change-set-repo';
import { getDb } from '../../db/connection';
import { findStorefrontFamilyPlanByChangeSetId } from '../../db/repositories/storefront-family-plan-repo';
import {
  findProductBySku, insertProductIndex, updateProductIndex, restoreProductIndexSnapshot,
} from '../../db/repositories/product-index-repo';
import { replaceProductPageJoins, getProductPageAssignments, getActivePageImportHash, getPageByName, restoreProductPageJoins } from '../../db/repositories/page-repo';
import { findHunkAck } from '../../db/repositories/drift-hunk-repo';
import { reopenDriftForChangeSet, listLinkedDrifts, resolveDrift, findDriftById, updateDriftHunkState, releaseSingleReconcileDrift, listOutstandingDriftForSku } from '../../db/repositories/drift-repo';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { getReconciledFieldsForDrift } from '../../shopsite/drift-reconcile-service';
import { SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION } from '../../shopsite/built-in-output-policy';
import { SHOP_SITE_FIELD_CATALOG_VERSION } from '../../shopsite/field-catalog';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { hashCanonicalJson, sha256Hex } from '../../shared/stable-id';
import { addAuditLog, hasEntityAction } from '../../db/repositories/audit-log-repo';
import { GitClient } from '../../git/git-client';
import { validateChangeSet, precheckLinkedConsistencyGroup } from '../../validation/change-set-validation';
import { hashNativeReferences, extractSubproductSkus } from '../../shopsite/product-codec';
import { LinkedManifestSchema, type LinkedManifest } from '../../shared/schemas/change-set';
import { finalizeStorefrontFamilyPlanApproval } from '../../classification/storefront-family-plan-service';
import type { ChangeSetRow, ChangeSetItemRow } from '../../db/repositories/change-set-repo';
import type { Product } from '../../shared/types';
import { ProductSchema } from '../../shared/schemas/product';

/**
 * Parse persisted linked-manifest bytes through the shared schema at every
 * entry point (detail/recovery/export/digest). Syntactically valid but
 * shape-invalid JSON (e.g. a manifest missing `reads`) returns null so
 * callers emit the controlled refusal instead of throwing mid-iteration.
 */
function parseLinkedManifest(manifestJson: string): LinkedManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  const parsed = LinkedManifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/**
 * List change sets for a workspace.
 */
export function listWorkspaceChangeSets(workspaceId: string) {
  return listChangeSets(workspaceId);
}

/**
 * Get change set details with items plus linked-approval state (issue #363
 * §7): while publication/recovery is incomplete, review/readiness/export
 * surfaces report the actual state instead of implying a complete group.
 */
export function getChangeSetDetail(changeSetId: string): {
  changeSet: ChangeSetRow | null;
  items: ChangeSetItemRow[];
  linkedManifest: LinkedManifest | null;
  linkedStatus: 'none' | 'pending' | 'committed' | 'recovered';
  linkedComplete: boolean;
} {
  const changeSet = findChangeSetById(changeSetId);
  const items = changeSet ? listChangeSetItems(changeSetId) : [];
  let linkedManifest: LinkedManifest | null = null;
  let linkedStatus: 'none' | 'pending' | 'committed' | 'recovered' = 'none';
  if (changeSet) {
    try {
      const row = findLinkedManifest(changeSetId);
      if (row) {
        linkedStatus = row.status;
        try {
          linkedManifest = parseLinkedManifest(row.manifestJson);
        } catch {
          linkedManifest = null;
        }
      }
    } catch {
      linkedManifest = null;
      linkedStatus = 'none';
    }
  }
  const linkedComplete = changeSet?.status === 'approved'
    && !!changeSet.approvedCommit
    && (linkedStatus === 'committed' || linkedStatus === 'recovered');
  return { changeSet, items, linkedManifest, linkedStatus, linkedComplete };
}

/**
 * Failure-injection hooks for the linked approval path (issue #363
 * behavioral tests only; production passes none). Each hook raises a
 * deterministic error at its phase so recovery honesty is observable at
 * the real SQLite/Git seam.
 */
export interface LinkedApprovalFailureHooks {
  beforeWrite?: boolean;
  betweenWrites?: boolean;
  beforeStaging?: boolean;
  beforeCommit?: boolean;
  afterCommitBeforeCompletion?: boolean;
  beforeReceipt?: boolean;
}
/**
 * Refusal detail for validation-gated approvals: names the specific blocker
 * codes instead of hiding them behind the count. The count stays first so
 * existing count-matching assertions keep passing.
 */
function validationBlockerDetail(validation: { items: Array<{ sku: string; results: Array<{ severity: string; code: string; message: string }> }> }): string {
  const codes = validation.items.flatMap((entry) =>
    entry.results
      .filter((r) => r.severity === 'blocker')
      .map((r) => `[${r.code}] ${entry.sku}: ${r.message}`),
  );
  return codes.length > 0 ? ` — ${codes.slice(0, 5).join('; ')}` : '';
}

/**
 * Operation-specific landed-commit identification (finding 3): when a crash
 * lands the commit but loses the manifest commit hash, the durable pending
 * snapshot still names this operation (pre-HEAD + exact subject). A HEAD
 * that advanced past pre-HEAD carrying the exact subject is this
 * operation's commit. Checked before any pending-snapshot rollback.
 */
function findLandedOperationCommit(
  changeSetId: string,
  workspacePath: string,
): { commitHash: string; digest: string } | null {
  const manifestRow = (() => { try { return findLinkedManifest(changeSetId); } catch { return null; } })();
  if (manifestRow?.commitHash) {
    const gitProbe = new GitClient(workspacePath);
    if (gitProbe.commitExists(manifestRow.commitHash)) {
      return { commitHash: manifestRow.commitHash, digest: manifestDigestOf(manifestRow.manifestJson) };
    }
    return null;
  }
  if (!manifestRow?.snapshotJson || manifestRow.status !== 'pending') return null;
  const durable = deserializeOwnedSnapshot(manifestRow.snapshotJson);
  if (!durable?.pendingSubject || !durable.pendingPreHead) return null;
  const git = new GitClient(workspacePath);
  const head = git.getHeadHash();
  if (!head || head === durable.pendingPreHead || !git.commitExists(head)) return null;
  const subject = git.readCommitSubject(head);
  if (subject !== durable.pendingSubject) return null;
  return { commitHash: head, digest: manifestDigestOf(manifestRow.manifestJson) };
}

/**
 * Pending-write recovery through the operator retry path (finding 4):
 * restore interrupted uncommitted writes from the durable snapshot BEFORE
 * any precheck compares worktree bytes against recorded bases. Returns
 * true when a restore ran so callers re-read live state after recovery.
 */
function recoverPendingUncommittedWrites(changeSetId: string, workspacePath: string): boolean {
  const manifestRow = (() => { try { return findLinkedManifest(changeSetId); } catch { return null; } })();
  if (!manifestRow?.snapshotJson || manifestRow.status !== 'pending' || manifestRow.commitHash) return false;
  if (findLandedOperationCommit(changeSetId, workspacePath)) return false;
  const durable = deserializeOwnedSnapshot(manifestRow.snapshotJson);
  if (!durable) return false;
  const parsed = parseLinkedManifest(manifestRow.manifestJson);
  const changeSkus: string[] = parsed ? parsed.writes.map((w) => w.sku) : [];
  if (changeSkus.length === 0) {
    for (const rel of durable.ownedFileBytes.keys()) {
      const base = rel.split('/').pop() ?? rel;
      changeSkus.push(base.replace(/\.json$/, ''));
    }
  }
  try {
    restoreOwnedWrites(workspacePath, changeSkus, [...durable.ownedFileBytes.keys()], durable);
  } catch { /* restore best-effort; gates below still report honestly */ }
  return true;
}
/**
 * Best-effort HEAD read for the durable pending identity (finding 3).
 * Null when the repo has no HEAD yet; callers persist null, never throw.
 */
function gitHeadHash(workspacePath: string): string | null {
  try {
    const head = new GitClient(workspacePath).getHeadHash();
    return head ? head : null;
  } catch {
    return null;
  }
}

/**
 * Approve a change set (issue #363).
 *
 * Standalone change sets (no inter-SKU Subproducts references) keep the
 * original partial-success behavior: per-SKU `errors.push/continue`, commit
 * the subset that wrote, succeed when at least one SKU committed. Linked
 * consistency groups (members reference each other) approve atomically: one
 * invalid dep blocks the group, any write failure restores owned files.
 */
export function approveChangeSet(
  changeSetId: string,
  workspacePath: string,
  hooks?: LinkedApprovalFailureHooks,
): { success: boolean; commitHash?: string; errors: string[]; warnings?: string[] } {
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) {
    return { success: false, errors: ['Change set not found'] };
  }

  if (changeSet.status !== 'draft') {
    // Idempotent recovery: an approved set whose commit exists finishes
    // post-commit completion against that same commit instead of failing
    // or creating another commit.
    if (changeSet.status === 'approved' && changeSet.approvedCommit) {
      const recovered = recoverLinkedApproval(changeSetId, workspacePath, hooks);
      if (recovered.success) {
        return { success: true, commitHash: recovered.commitHash ?? changeSet.approvedCommit, errors: [] };
      }
      return { success: false, errors: recovered.errors };
    }
    return { success: false, errors: [`Cannot approve change set in status "${changeSet.status}"`] };
  }

  const items = listChangeSetItems(changeSetId);
  // Shared draft parse: standalone approvals keep per-SKU errors/continue;
  // the linked path below treats any parse failure atomically.
  const parsed: Array<{ sku: string; product: Product; item: ChangeSetItemRow }> = [];
  const parseErrors: string[] = [];
  for (const item of items) {
    try {
      parsed.push({ sku: item.sku, product: JSON.parse(item.draftJson) as Product, item });
    } catch {
      parseErrors.push(`Failed to parse draft JSON for product ${item.sku}`);
    }
  }

  // Family plans require the linked approval/finalization path even when a
  // dissolution clears every Subproducts reference from its resulting drafts.
  const linked = parsed.some(({ sku, product }) =>
    extractSubproductSkus(product).some((ref) => ref !== sku),
  ) || Boolean(findStorefrontFamilyPlanByChangeSetId(changeSetId));
  if (!linked) {
    return approveStandaloneChangeSet(changeSet, workspacePath, parsed, parseErrors);
  }

  if (parseErrors.length > 0) {
    return { success: false, errors: parseErrors };
  }
  // Crash-safe retry order (findings 3/4/5): before any pre-mutation gate,
  // check for an already-landed operation commit and complete it first.
  // Reads the durable pending snapshot's operation identity (pre-HEAD +
  // subject), never the in-memory state a real crash loses.
  const landedOp = findLandedOperationCommit(changeSetId, workspacePath);
  if (landedOp) {
    const completed = completePostCommit(changeSet, workspacePath, landedOp.commitHash, landedOp.digest, 'recovered', hooks);
    return { success: completed.success, commitHash: completed.commitHash, errors: completed.errors };
  }
  // Pending uncommitted operations recover first (finding 4): restore the
  // interrupted operator's writes from the durable snapshot, then run the
  // gates against the restored state instead of refusing on partial bytes.
  recoverPendingUncommittedWrites(changeSetId, workspacePath);
  // Whole-group recheck + standard validation before any mutation. One
  // invalid dep blocks the group. The precheck reads read-dep pointers
  // from the product index, which can lag (fresh databases, baseline-only
  // setups) while the base-commit bytes already bind the dep — refresh
  // stale read-dep pointers from the base commit BEFORE the precheck so a
  // lagging index never fails a bound dep (empty hash still blocks below).
  refreshReadDepIndexPointers(changeSetId, workspacePath);
  const group = precheckLinkedConsistencyGroup(changeSetId);
  if (!group.ok) {
    const first = group.issues.filter((i) => i.severity === 'blocker').slice(0, 5);
    return {
      success: false,
      errors: first.map((i) => `[${i.code}] ${i.message}`),
    };
  }
  // Complete validation includes family-specific gates (notably adopted
  // dissolution classification validation) and must run before any writes.
  const validation = validateChangeSet(changeSetId);
  if (!validation.canApprove) {
    return {
      success: false,
      errors: [`Change set has ${validation.blockers} blocker(s) preventing approval${validationBlockerDetail(validation)}`],
    };
  }

  const changeSkus = group.changeSkus;
  const targetFiles = [...new Set(changeSkus.map((sku) => skuToProductFilePath(sku)))];
  // Approval never writes .gitignore: it enters the commit scope only if an
  // owned write below dirties it (never today); operator edits stay out.
  // Operation identity (finding 3) is captured BEFORE mutation so a real
  // crash can identify the landed commit from the durable snapshot alone.
  const pendingSubject = linkedCommitSubject(changeSet.title, group.changeSkus.length);
  const preHead = gitHeadHash(workspacePath);
  const snapshot = snapshotOwnedWorkspace(workspacePath, changeSkus, targetFiles, { preHead, subject: pendingSubject });
  const manifest = buildLinkedManifest(changeSet, items, group, workspacePath);
  const digest = manifestDigest(manifest);
  const git = new GitClient(workspacePath);
  let landedCommit: string | null = null;
  try {
    if (hooks?.beforeWrite) throw new Error('Injected pre-write failure for linked approval honesty test.');
    // Persist the manifest + durable pre-mutation snapshot BEFORE mutation so
    // interrupted runs (including real process crashes with no in-memory
    // snapshot) recover honestly (pending vs committed vs recovered) and can
    // restore owned writes from the persisted snapshot bytes.
    saveLinkedManifest({
      changeSetId, workspaceId: changeSet.workspaceId,
      manifestJson: deterministicStringify(manifest), status: 'pending',
      snapshotJson: serializeOwnedSnapshot(snapshot),
    });
    // Write phase: page joins resolve BEFORE the file write per SKU; a
    // rejected join or write/index failure aborts the whole group.
    let written = 0;
    for (const entry of parsed) {
      if (hooks?.betweenWrites && written > 0) {
        throw new Error(`Injected mid-write failure for linked approval honesty test (after ${written} write(s)).`);
      }
      const sku = entry.sku;
      const product = entry.product;
      try {
        replaceProductPageJoins(sku, product.core.productOnPages ?? []);
      } catch (err) {
        throw new Error(`Failed to sync page joins for ${sku}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      writeProductFile(workspacePath, product);

      const existing = findProductBySku(sku);
      // Canonical comparison hash owned by the import/check slice (#252):
      // approval writes the same value drift checking reads so approved
      // products compare equal. Approval never advances remote-observation
      // (lastPulledRemoteHash) or successful-sync (lastSyncedRemoteHash /
      // lastSyncedAt) pointers merely because local approved state changed —
      // those stay untouched here (update) or null (insert, unverified
      // pending recheck). Sync status moves to not_synced (local ahead).
      const productHash = comparisonHashForProduct(product);
      const hasAdvancedBlocks = product.shopsite.preserved.advancedBlocks
        && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0;
      const hasWarnings = entry.item.validationStatus === 'warning' ? 1 : 0;

      if (existing) {
        updateProductIndex({
          sku,
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash,
          hasAdvancedBlocks: hasAdvancedBlocks ? 1 : 0,
          hasWarnings,
          syncStatus: 'not_synced',
          lastApprovedCommit: undefined, // Set after commit
          description: product.core.description,
          searchKeywords: product.core.seo.searchKeywords,
          customFields: product.customFields,
        });
      } else {
        insertProductIndex({
          id: product.id,
          sku,
          filePath: skuToProductFilePath(sku),
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
          hasAdvancedBlocks: hasAdvancedBlocks ? 1 : 0,
          hasWarnings,
          createdAt: product.metadata.createdAt,
          updatedAt: product.metadata.updatedAt,
          description: product.core.description,
          searchKeywords: product.core.seo.searchKeywords,
          customFields: product.customFields,
        });
      }
      written += 1;
    }

    if (hooks?.beforeStaging) throw new Error('Injected pre-staging failure for linked approval honesty test.');
    // Exact-file staging: only operation-owned paths enter the commit.
    const existingTargets = targetFiles.filter((f) => fs.existsSync(path.join(workspacePath, f)));
    if (existingTargets.length > 0) {
      git.add(existingTargets);
    }
    if (hooks?.beforeCommit) {
      // Simulate the pre-commit crash AFTER staging: restore owned files to
      // their exact pre-approval index entries (worktree bytes restored
      // below), then report failure with the set unapproved.
      try {
        git.restoreStagedEntries(snapshot.indexEntries);
      } catch { /* best-effort */ }
      throw new Error('Injected pre-commit failure for linked approval honesty test.');
    }

    // A genuine no-op binds the existing complete commit without creating
    // an unnecessary commit. The message equals the durable pending subject
    // (finding 3) so crash-window identification stays exact.
    const commitMessage = pendingSubject;
    let commitHash: string;
    try {
      const dirty = existingTargets.length > 0 ? git.statusForPaths(existingTargets) : '';
      if (!dirty) {
        commitHash = git.getHeadHash();
        if (!commitHash) throw new Error('No HEAD commit exists for no-op approval.');
      } else {
        git.commitPaths(commitMessage, existingTargets);
        commitHash = git.getHeadHash();
      }
    } catch (commitErr) {
      let rawStdout = '';
      let rawStderr = '';
      if (commitErr && typeof commitErr === 'object') {
        if ('stdout' in commitErr) {
          const stdoutValue = commitErr.stdout;
          if (typeof stdoutValue === 'string') rawStdout = stdoutValue;
          else if (stdoutValue && typeof stdoutValue.toString === 'function') rawStdout = String(stdoutValue);
        }
        if ('stderr' in commitErr) {
          const stderrValue = commitErr.stderr;
          if (typeof stderrValue === 'string') rawStderr = stderrValue;
          else if (stderrValue && typeof stderrValue.toString === 'function') rawStderr = String(stderrValue);
        }
      }
      const raw = `${commitErr instanceof Error ? commitErr.message : String(commitErr)} ${rawStdout} ${rawStderr}`;
      if (raw.includes('nothing added to commit') || raw.includes('nothing to commit') || raw.includes('working tree clean') || raw.includes('requires at least one pathspec')) {
        commitHash = git.getHeadHash();
      } else {
        throw commitErr;
      }
    }
    landedCommit = commitHash;
    if (hooks?.afterCommitBeforeCompletion) {
      // Post-commit interruption: the commit exists, status/index/audit
      // stay pending until recovery completes against the same commit.
      // Return directly — the generic catch below is pre-commit only and
      // must not restore the worktree or revert the manifest to pending.
      try {
        markLinkedManifestCommitted(changeSetId, commitHash);
      } catch { /* best-effort */ }
      try {
        const pendingManifest = findLinkedManifest(changeSetId);
        if (pendingManifest) {
          saveLinkedManifest({
            changeSetId, workspaceId: changeSet.workspaceId,
            manifestJson: pendingManifest.manifestJson, status: 'committed', commitHash,
          });
        }
      } catch { /* best-effort */ }
      return {
        success: false,
        errors: [`Injected post-commit interruption for linked approval honesty test (commit ${commitHash.slice(0, 12)} exists; recovery required).`],
      };
    }
    return completePostCommit(changeSet, workspacePath, commitHash, digest, 'approved', hooks);
  } catch (err) {
    if (landedCommit) {
      // The commit landed but completion threw (e.g. the injected
      // post-commit receipt failure): keep the manifest committed so
      // recovery completes against this same commit, and leave the
      // worktree alone — it already matches the landed commit.
      try {
        const pendingManifest = findLinkedManifest(changeSetId);
        if (pendingManifest) {
          saveLinkedManifest({
            changeSetId, workspaceId: changeSet.workspaceId,
            manifestJson: pendingManifest.manifestJson, status: 'committed', commitHash: landedCommit,
          });
        } else {
          saveLinkedManifest({
            changeSetId, workspaceId: changeSet.workspaceId,
            manifestJson: deterministicStringify(manifest), status: 'committed', commitHash: landedCommit,
            snapshotJson: serializeOwnedSnapshot(snapshot),
          });
        }
      } catch { /* manifest persistence best-effort */ }
      return {
        success: false,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
    // No partial commit: restore owned writes from the persisted snapshot
    // when the in-memory one is unavailable (real crash windows), leave the
    // set unapproved, and keep the pending manifest with its durable
    // snapshot so a later retry restores honestly too.
    try {
      const persisted = findLinkedManifest(changeSetId)?.snapshotJson;
      const durable = persisted ? deserializeOwnedSnapshot(persisted) : null;
      restoreOwnedWrites(workspacePath, changeSkus, targetFiles, durable ?? snapshot);
    } catch { /* restore best-effort; honesty is in the returned error */ }
    try {
      saveLinkedManifest({
        changeSetId, workspaceId: changeSet.workspaceId,
        manifestJson: deterministicStringify(manifest), status: 'pending',
        snapshotJson: serializeOwnedSnapshot(snapshot),
      });
    } catch { /* manifest persistence best-effort */ }
    return {
      success: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

/**
 * Standalone approval: the pre-#363 partial-success path, preserved verbatim
 * outside linked operations. Per-SKU errors.push/continue; commits the
 * subset that wrote; succeeds when at least one SKU committed. No linked
 * manifest, snapshot, or group gate — no inter-SKU deps exist by construction.
 */
function approveStandaloneChangeSet(
  changeSet: ChangeSetRow,
  workspacePath: string,
  parsed: Array<{ sku: string; product: Product; item: ChangeSetItemRow }>,
  parseErrors: string[],
): { success: boolean; commitHash?: string; errors: string[] } {
  const changeSetId = changeSet.id;
  // Validate first
  const validation = validateChangeSet(changeSetId);
  if (!validation.canApprove) {
    return {
      success: false,
      errors: [`Change set has ${validation.blockers} blocker(s) preventing approval${validationBlockerDetail(validation)}`],
    };
  }

  const errors: string[] = [...parseErrors];
  const committedSkus: string[] = [];

  // Write product files and update index. Page joins resolve BEFORE the
  // file write: a rejected page assignment must never leave an approved
  // file mutated while the SKU is excluded from the commit.
  for (const entry of parsed) {
    try {
      const product = entry.product;
      try {
        replaceProductPageJoins(entry.sku, product.core.productOnPages ?? []);
      } catch (err) {
        errors.push(`Failed to sync page joins for ${entry.sku}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      writeProductFile(workspacePath, product);

      const existing = findProductBySku(entry.sku);
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
      const hasWarnings = entry.item.validationStatus === 'warning' ? 1 : 0;

      if (existing) {
        updateProductIndex({
          sku: entry.sku,
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
          sku: entry.sku,
          filePath: skuToProductFilePath(entry.sku),
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

      committedSkus.push(entry.sku);
    } catch (err) {
      errors.push(`Failed to write product ${entry.sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0 && committedSkus.length === 0) {
    return { success: false, errors };
  }

  // Git commit — scoped to this change set's targets ONLY (P2 #22):
  // pre-staged unrelated files stay in the index and out of the commit.
  const git = new GitClient(workspacePath);
  const targetFiles: string[] = [];
  for (const sku of committedSkus) {
    targetFiles.push(skuToProductFilePath(sku));
  }
  if (fs.existsSync(path.join(workspacePath, '.gitignore'))) {
    targetFiles.push('.gitignore');
  }
  const stagedFiles = targetFiles.filter(f => fs.existsSync(path.join(workspacePath, f)));

  try {
    if (stagedFiles.length > 0) {
      git.add(stagedFiles);
    }
    const commitMessage = `Change set: ${changeSet.title} (${committedSkus.length} product(s))`;
    let commitHash: string;
    try {
      git.commitPaths(commitMessage, stagedFiles);
      commitHash = git.getHeadHash();
    } catch (commitErr) {
      const errRecord: Record<string, unknown> = typeof commitErr === 'object' && commitErr !== null ? commitErr as Record<string, unknown> : {};
      const stdout = typeof errRecord['stdout'] === 'string' ? errRecord['stdout'] : '';
      const stderr = typeof errRecord['stderr'] === 'string' ? errRecord['stderr'] : '';
      const errMsg = `${commitErr instanceof Error ? commitErr.message : String(commitErr)} ${stdout} ${stderr}`;
      if (errMsg.includes('nothing added to commit') || errMsg.includes('nothing to commit') || errMsg.includes('working tree clean') || errMsg.includes('requires at least one pathspec')) {
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


export interface LinkedApprovalResult {
  success: boolean;
  commitHash?: string;
  errors: string[];
  recovered: boolean;
}

export interface LinkedExportLoad {
  products: Product[];
  manifest: LinkedManifest;
  commitHash: string;
}

interface ProductIndexSnapshot {
  id: string;
  sku: string;
  filePath: string;
  title: string;
  status: string;
  price: string | null;
  inventoryQuantity: number | null;
  primaryImage: string | null;
  productHash: string;
  lastApprovedCommit: string | null;
  lastPulledRemoteHash: string | null;
  lastSyncedRemoteHash: string | null;
  lastSyncedAt: string | null;
  syncStatus: string;
  hasAdvancedBlocks: number;
  hasWarnings: number;
  createdAt: string;
  updatedAt: string;
  description?: string | null;
  searchKeywords?: string | null;
  customFields?: Record<string, string>;
}

interface PageJoinSnapshot {
  pageId: string | null;
  pageName: string;
}

interface GitIndexEntry {
  mode: string;
  hash: string;
}

interface OwnedWorkspaceSnapshot {
  ownedFileBytes: Map<string, string | null>;
  indexBefore: Map<string, ProductIndexSnapshot | null>;
  pageJoinsBefore: Map<string, PageJoinSnapshot[]>;
  // Exact staged index entries per owned path at snapshot time (issue #363
  // finding 2): null means the path had no staged entry. Restoring these
  // reinstates pre-existing staged content instead of resetting paths.
  indexEntries: Array<[string, GitIndexEntry | null]>;
  // Crash-window commit identification (issue #363 finding 3): the HEAD
  // before mutation plus the exact subject the operation commit will carry.
  // Recovery treats a newer HEAD with this subject (and matching content)
  // as the landed operation commit — never rolls it back.
  pendingPreHead: string | null;
  pendingSubject: string | null;
}

/**
 * Exact commit subject for a linked approval (issue #363 finding 3): the
 * durable operation-specific identity persisted before mutation and checked
 * before any pending-snapshot rollback.
 */
function linkedCommitSubject(changeSetTitle: string, productCount: number): string {
  return `Change set: ${changeSetTitle} (${productCount} product(s))`;
}
function serializeOwnedSnapshot(snapshot: OwnedWorkspaceSnapshot): string {
  return deterministicStringify({
    ownedFileBytes: [...snapshot.ownedFileBytes.entries()],
    indexBefore: [...snapshot.indexBefore.entries()],
    pageJoinsBefore: [...snapshot.pageJoinsBefore.entries()],
    indexEntries: snapshot.indexEntries,
    pendingPreHead: snapshot.pendingPreHead,
    pendingSubject: snapshot.pendingSubject,
  });
}

function deserializeOwnedSnapshot(raw: string): OwnedWorkspaceSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {
      ownedFileBytes?: Array<[string, string | null]>;
      indexBefore?: Array<[string, ProductIndexSnapshot | null]>;
      pageJoinsBefore?: Array<[string, PageJoinSnapshot[]]>;
      indexEntries?: Array<[string, GitIndexEntry | null]>;
      pendingPreHead?: string | null;
      pendingSubject?: string | null;
    };
    if (!parsed || !Array.isArray(parsed.ownedFileBytes)) return null;
    return {
      ownedFileBytes: new Map(parsed.ownedFileBytes),
      indexBefore: new Map(Array.isArray(parsed.indexBefore) ? parsed.indexBefore : []),
      pageJoinsBefore: new Map(Array.isArray(parsed.pageJoinsBefore) ? parsed.pageJoinsBefore : []),
      indexEntries: Array.isArray(parsed.indexEntries) ? parsed.indexEntries : [],
      pendingPreHead: typeof parsed.pendingPreHead === 'string' ? parsed.pendingPreHead : null,
      pendingSubject: typeof parsed.pendingSubject === 'string' ? parsed.pendingSubject : null,
    };
  } catch {
    return null;
  }
}

function snapshotOwnedWorkspace(
  workspacePath: string,
  changeSkus: string[],
  ownedFiles: string[],
  opts?: { preHead?: string | null; subject?: string | null },
): OwnedWorkspaceSnapshot {
  const ownedFileBytes = new Map<string, string | null>();
  for (const sku of changeSkus) {
    const rel = skuToProductFilePath(sku);
    const full = path.join(workspacePath, rel);
    ownedFileBytes.set(rel, fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : null);
  }
  const pageJoinsBefore = new Map<string, PageJoinSnapshot[]>();
  const indexBefore = new Map<string, ProductIndexSnapshot | null>();
  for (const sku of changeSkus) {
    try {
      pageJoinsBefore.set(sku, getProductPageAssignments(sku));
    } catch {
      pageJoinsBefore.set(sku, []);
    }
    try {
      const row = findProductBySku(sku);
      indexBefore.set(sku, row ? { ...row } : null);
    } catch {
      indexBefore.set(sku, null);
    }
  }
  let indexEntries: Array<[string, GitIndexEntry | null]> = ownedFiles.map((rel) => [rel, null]);
  try {
    const staged = new GitClient(workspacePath).readStagedEntries(ownedFiles);
    indexEntries = ownedFiles.map((rel) => [rel, staged.get(rel) ?? null]);
  } catch { /* index capture best-effort; worktree snapshot already durable */ }
  return {
    ownedFileBytes, indexBefore, pageJoinsBefore, indexEntries,
    pendingPreHead: opts?.preHead ?? null,
    pendingSubject: opts?.subject ?? null,
  };
}

function restoreOwnedWrites(
  workspacePath: string,
  changeSkus: string[],
  ownedFiles: string[],
  snapshot: OwnedWorkspaceSnapshot,
): void {
  for (const entry of snapshot.ownedFileBytes) {
    const rel = entry[0];
    const bytes = entry[1];
    const full = path.join(workspacePath, rel);
    if (bytes === null) {
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch { /* best-effort */ }
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, bytes, 'utf-8');
    }
  }
  // Exact-index restore (finding 2): reinstate the captured staged entries
  // per owned path. Paths with no captured entry are unstaged without
  // touching the worktree; unrelated staged entries are never touched.
  const git = new GitClient(workspacePath);
  try {
    const entries = snapshot.indexEntries.length > 0
      ? snapshot.indexEntries
      : ownedFiles.map((rel): [string, GitIndexEntry | null] => [rel, null]);
    git.restoreStagedEntries(entries);
  } catch { /* index restore best-effort; worktree already restored */ }
  for (const sku of changeSkus) {
    const before = snapshot.pageJoinsBefore.get(sku) ?? [];
    try {
      restoreProductPageJoins(sku, before);
    } catch { /* join restore best-effort */ }
  }
  for (const sku of changeSkus) {
    const before = snapshot.indexBefore.get(sku);
    try {
      restoreProductIndexSnapshot(before === undefined ? null : before, sku);
    } catch { /* index restore best-effort */ }
  }
}

/**
 * Refresh stale read-dep index pointers from the base commit BEFORE the
 * linked precheck (issue #363): approval writes only changed members, so
 * an unchanged dep's row may carry a null/stale commit from a lagging
 * index while the base-commit bytes already bind it. Binds nothing itself —
 * the manifest still binds at-commit bytes; this only repairs the row
 * pointer the precheck reads. Empty hash still blocks below.
 */
function refreshReadDepIndexPointers(changeSetId: string, workspacePath: string): void {
  let changeSet: ChangeSetRow;
  let items: ChangeSetItemRow[];
  try {
    changeSet = findChangeSetById(changeSetId)!;
    if (!changeSet) return;
    items = listChangeSetItems(changeSetId);
  } catch { return; }
  const changeSkuSet = new Set(items.map((i) => i.sku));
  const refs = new Set<string>();
  for (const item of items) {
    try {
      const draft = JSON.parse(item.draftJson) as Product;
      for (const ref of extractSubproductSkus(draft)) refs.add(ref);
    } catch { /* unparseable drafts block in precheck below */ }
  }
  const readSkus = [...refs].filter((ref) => !changeSkuSet.has(ref)).sort();
  for (const sku of readSkus) {
// Refresh the read dep's index pointer: approval wrote only changed
// members, so an unchanged dep's row may carry a null/stale commit from
// a lagging index while the base-commit bytes already bind it. The
// manifest still binds the at-commit bytes (productHash); this only
// repairs the row pointer the loader and staleness rechecks read.
try {
  const rel = skuToProductFilePath(sku);
  const wsBase = changeSet.baseCommit || null;
  if (workspacePath && wsBase) {
    try {
      const git = new GitClient(workspacePath);
      if (git.commitExists(wsBase)) {
        const atBase = git.readFileAtCommit(wsBase, rel);
        if (atBase) {
          const parsedBase: unknown = JSON.parse(atBase);
          const validatedBase = ProductSchema.safeParse(parsedBase);
          if (validatedBase.success) {
            const bp = validatedBase.data;
            if (findProductBySku(sku)) {
              updateProductIndex({ sku, lastApprovedCommit: wsBase, productHash: comparisonHashForProduct(bp) });
            } else {
              insertProductIndex({
                id: bp.id, sku, filePath: rel, title: bp.core.name, status: bp.status,
                price: bp.core.price, inventoryQuantity: bp.core.inventory.quantityOnHand,
                primaryImage: bp.core.media.primary, productHash: comparisonHashForProduct(bp),
                lastApprovedCommit: wsBase, lastPulledRemoteHash: null,
                lastSyncedRemoteHash: null, lastSyncedAt: null, syncStatus: 'not_synced',
                hasAdvancedBlocks: bp.shopsite.preserved.advancedBlocks
                  && Object.keys(bp.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
                hasWarnings: 0, createdAt: bp.metadata.createdAt, updatedAt: bp.metadata.updatedAt,
                description: bp.core.description, searchKeywords: bp.core.seo.searchKeywords,
                customFields: bp.customFields,
              });
            }
          }
        }
      }
    } catch { /* pointer repair best-effort; empty hash still blocks below */ }
  }
} catch { /* pointer repair best-effort */ }
  }
}

export function buildLinkedManifest(
  changeSet: ChangeSetRow,
  items: ChangeSetItemRow[],
  group: { changeSkus: string[]; readSkus: string[] },
  workspacePath?: string,
): LinkedManifest {
  // True approved bases (issue #363): each write binds the live approved
  // file bytes read at manifest time — a stale base staged earlier is caught
  // by the precheck AND bound into the manifest (baseHash/baseApprovedCommit
  // reflect live state, not the stale staged baseJson). Unreadable live
  // files bind a sentinel rather than silently keeping stale bytes.
  const liveBySku = new Map<string, { liveHash: string; liveNative: string; liveCommit: string | null; missing: boolean }>();
  if (workspacePath) {
    for (const item of items) {
      try {
        const live = readProductFile(workspacePath, item.sku);
        if (!live) {
          liveBySku.set(item.sku, { liveHash: '', liveNative: '', liveCommit: null, missing: true });
          continue;
        }
        const row = findProductBySku(item.sku);
        liveBySku.set(item.sku, {
          liveHash: comparisonHashForProduct(live),
          liveNative: hashNativeReferences(live),
          liveCommit: row?.lastApprovedCommit ?? null,
          missing: false,
        });
      } catch {
        liveBySku.set(item.sku, { liveHash: '', liveNative: '', liveCommit: null, missing: true });
      }
    }
  }
  const writes: LinkedManifest['writes'] = [];
  for (const item of items) {
    const product = JSON.parse(item.draftJson) as Product;
    const bound = liveBySku.get(item.sku);
    const base = item.baseJson ? (JSON.parse(item.baseJson) as Product) : null;
    const indexRow = findProductBySku(item.sku);
    writes.push({
      sku: item.sku,
      operation: item.operation,
      filePath: skuToProductFilePath(item.sku),
      draftHash: hashJson(product),
      productHash: comparisonHashForProduct(product),
      nativeReferenceHash: bound && !bound.missing ? bound.liveNative : hashNativeReferences(product),
      baseHash: bound && !bound.missing ? bound.liveHash : (base ? comparisonHashForProduct(base) : null),
      baseApprovedCommit: bound ? bound.liveCommit : (indexRow?.lastApprovedCommit ?? null),
      pageNames: [...(product.core.productOnPages ?? [])].sort(),
    });
  }
  writes.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const reads: LinkedManifest['reads'] = [];
  for (const sku of group.readSkus) {

    const row = findProductBySku(sku);
    const rel = skuToProductFilePath(sku);
    // Read deps bind immutable approved commit content (finding 6): the
    // base commit the group approves against, never mutable worktree bytes
    // an uncommitted child edit could have dirtied. Unapproved deps refuse
    // before mutation — an unreadable-at-base dep blocks the group.
    let productHash = '';
    let nativeReferenceHash = '';
    let depCommit: string | null = null;
    const anchor = changeSet.baseCommit || null;
    if (workspacePath && anchor) {
      try {
        const git = new GitClient(workspacePath);
        if (git.commitExists(anchor)) {
          const atBase = git.readFileAtCommit(anchor, rel);
          if (atBase) {
            const parsedBase: unknown = JSON.parse(atBase);
            const validated = ProductSchema.safeParse(parsedBase);
            if (validated.success) {
              productHash = comparisonHashForProduct(validated.data);
              nativeReferenceHash = hashNativeReferences(validated.data);
              depCommit = anchor;
            }
          }
        }
      } catch {
        productHash = '';
        nativeReferenceHash = '';
        depCommit = null;
      }
    }
    reads.push({
      sku,
      filePath: rel,
      productHash,
      nativeReferenceHash,
      lastApprovedCommit: depCommit ?? row?.lastApprovedCommit ?? null,
    });
  }
  return {
    version: 1,
    changeSetId: changeSet.id,
    workspaceId: changeSet.workspaceId,
    baseCommit: changeSet.baseCommit,
    writes,
    reads,
    createdAt: new Date().toISOString(),
  };
}

function manifestDigest(manifest: LinkedManifest): string {
  return hashCanonicalJson({
    version: manifest.version,
    changeSetId: manifest.changeSetId,
    workspaceId: manifest.workspaceId,
    baseCommit: manifest.baseCommit,
    writes: manifest.writes,
    reads: manifest.reads,
  });
}

function manifestDigestOf(manifestJson: string): string {
  const parsed = parseLinkedManifest(manifestJson);
  if (!parsed) return sha256Hex(manifestJson);
  return manifestDigest(parsed);
}

function completePostCommit(
  changeSet: ChangeSetRow,
  workspacePath: string,
  commitHash: string,
  digest: string,
  action: 'approved' | 'recovered-after-interrupt' | 'recovered',
  hooks?: LinkedApprovalFailureHooks,
): { success: boolean; commitHash?: string; errors: string[]; warnings?: string[] } {
  if (hooks?.beforeReceipt) {
    throw new Error('Injected post-commit receipt failure for linked approval honesty test.');
  }
  updateChangeSetStatus(changeSet.id, 'approved', commitHash);
  const items = listChangeSetItems(changeSet.id);
  const changeSkus = items.map((i) => i.sku);
  const failures: string[] = [];
  for (const sku of changeSkus) {
    try {
      if (findProductBySku(sku)) {
        updateProductIndex({ sku, lastApprovedCommit: commitHash });
      } else {
        // Fresh databases (or baseline-only setups) may carry the approved
        // file with no index row yet: rebuild the row from the landed
        // commit bytes so the commit pointer is recorded exactly once.
        const atCommit = new GitClient(workspacePath).readFileAtCommit(commitHash, skuToProductFilePath(sku));
        if (!atCommit) {
          failures.push(`Index pointer for "${sku}" not recorded (missing at landed commit); re-check before export.`);
          continue;
        }
        const parsedCommit: unknown = JSON.parse(atCommit);
        const validatedCommit = ProductSchema.safeParse(parsedCommit);
        if (!validatedCommit.success) {
          failures.push(`Index pointer for "${sku}" not recorded (approved bytes failed product validation); re-check before export.`);
          continue;
        }
        const product = validatedCommit.data;
        insertProductIndex({
          id: product.id,
          sku,
          filePath: skuToProductFilePath(sku),
          title: product.core.name,
          status: product.status,
          price: product.core.price,
          inventoryQuantity: product.core.inventory.quantityOnHand,
          primaryImage: product.core.media.primary,
          productHash: comparisonHashForProduct(product),
          lastApprovedCommit: commitHash,
          lastPulledRemoteHash: null,
          lastSyncedRemoteHash: null,
          lastSyncedAt: null,
          syncStatus: 'not_synced',
          hasAdvancedBlocks: product.shopsite.preserved.advancedBlocks
            && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
          hasWarnings: 0,
          createdAt: product.metadata.createdAt,
          updatedAt: product.metadata.updatedAt,
          description: product.core.description,
          searchKeywords: product.core.seo.searchKeywords,
          customFields: product.customFields,
        });
      }
    } catch (err) {
      failures.push(`Index pointer for "${sku}" not recorded (${err instanceof Error ? err.message : String(err)}); re-check before export.`);
    }
  }
  try {
    const linked = listLinkedDrifts(changeSet.workspaceId, changeSet.id);
    for (const linkedRow of linked) {
      try {
        settleLinkedDriftAfterApproval(changeSet.workspaceId, linkedRow.id, commitHash, workspacePath);
      } catch (err) {
        failures.push(`Drift settlement for "${linkedRow.sku}" not recorded (${err instanceof Error ? err.message : String(err)}); re-check before export.`);
      }
    }
  } catch (err) {
    failures.push(`Drift settlement not verified (${err instanceof Error ? err.message : String(err)}); re-check before export.`);
  }
  try {
    if (!hasEntityAction(changeSet.workspaceId, 'change_set', changeSet.id, 'approved')) {
      addAuditLog({
        workspaceId: changeSet.workspaceId,
        entityType: 'change_set',
        entityId: changeSet.id,
        action: 'approved',
        message: `Change set "${changeSet.title}" approved with ${changeSkus.length} product(s). Commit: ${commitHash}`,
        detailsJson: JSON.stringify({ committedSkus: changeSkus, commitHash, manifestDigest: digest }),
      });
    }
  } catch (err) {
    failures.push(`Approval audit not recorded (${err instanceof Error ? err.message : String(err)}); state is approved but unaudited.`);
  }
  let manifestMarked = false;
  let manifestMarkError: string | null = null;
  try {
    if (action === 'approved') markLinkedManifestCommitted(changeSet.id, commitHash);
    else markLinkedManifestRecovered(changeSet.id, commitHash);
    manifestMarked = true;
    // Family plans reach "applied" only here: the approved commit and its
    // complete commit/index receipt exist before this call. Draft staging
    // stays "accepted" with a linked change set; never applied on write.
    finalizeStorefrontFamilyPlanApproval(changeSet.id, changeSet.workspaceId, commitHash);
  } catch (err) {
    manifestMarkError = err instanceof Error ? err.message : String(err);
  }
  if (failures.length > 0 || !manifestMarked) {
    // Durable incomplete (finding 7): unlock export ONLY on required success.
    // Keep the manifest pending so the loader keeps export blocked; return
    // retry-required failure, never a warnings-only success over missing
    // pointers. A failed mark re-mark is itself required completion.
    if (manifestMarkError) {
      failures.push(`Linked manifest status not recorded (${manifestMarkError}); commit ${commitHash.slice(0, 12)} exists — recover to re-mark.`);
    }
    try {
      const current = findLinkedManifest(changeSet.id);
      if (current && current.status !== 'pending') {
        saveLinkedManifest({
          changeSetId: changeSet.id, workspaceId: changeSet.workspaceId,
          manifestJson: current.manifestJson, status: 'pending', commitHash,
        });
      }
    } catch { /* incomplete marking best-effort; failure return still blocks */ }
    return {
      success: false, commitHash,
      errors: [...failures, 'Post-commit completion is incomplete; export stays blocked — retry recovery before export.'],
    };
  }
  return { success: true, commitHash, errors: [] };
}

/**
 * Retry/restart recovery for an interrupted linked approval (issue #363):
 * when the complete Git commit exists, finish index/status/audit/receipt
 * completion against that same commit; never another commit.
 */
export function recoverLinkedApproval(
  changeSetId: string,
  workspacePath: string,
  hooks?: LinkedApprovalFailureHooks,
): LinkedApprovalResult & { warnings?: string[] } {
  if (hooks?.beforeReceipt) {
    return {
      success: false, recovered: false,
      errors: ['Injected post-commit receipt failure for linked approval honesty test.'],
    };
  }
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) return { success: false, errors: ['Change set not found'], recovered: false };
  const manifestRow = findLinkedManifest(changeSetId);
  // Crash-window check first (finding 3): an operation commit that landed
  // without its manifest hash completes against that commit — never rolls
  // back owned files that already match the landed commit.
  const landedOp = findLandedOperationCommit(changeSetId, workspacePath);
  if (landedOp) {
    const manifest = manifestRow?.manifestJson ? parseLinkedManifest(manifestRow.manifestJson) : null;
    if (!manifest) {
      return { success: false, errors: ['Linked manifest is unreadable; refusing recovery.'], recovered: false };
    }
    const landed = completePostCommit(changeSet, workspacePath, landedOp.commitHash, manifestDigest(manifest), 'recovered', hooks);
    return { success: landed.success, commitHash: landed.commitHash, errors: landed.errors, recovered: landed.success };
  }
  // Crash window with no commit yet: a durable pending snapshot restores
  // owned writes honestly (exact index entries, finding 2), then reports
  // incomplete (never silent success).
  if (manifestRow && !manifestRow.commitHash && manifestRow.snapshotJson && manifestRow.status === 'pending') {
    const durable = deserializeOwnedSnapshot(manifestRow.snapshotJson);
    if (durable) {
      const parsed = parseLinkedManifest(manifestRow.manifestJson);
      const changeSkus: string[] = parsed ? parsed.writes.map((w) => w.sku) : [];
      if (changeSkus.length === 0) {
        for (const rel of durable.ownedFileBytes.keys()) {
          const base = rel.split('/').pop() ?? rel;
          changeSkus.push(base.replace(/\.json$/, ''));
        }
      }
      try {
        restoreOwnedWrites(workspacePath, changeSkus, [...durable.ownedFileBytes.keys()], durable);
      } catch { /* restore best-effort; honesty is in the returned error */ }
    }
    return {
      success: false, recovered: false,
      errors: [`Change set "${changeSet.title}" has no complete commit; publication/recovery is incomplete and export stays unavailable.`],
    };
  }
  if (!manifestRow?.commitHash) {
    if (changeSet.status === 'approved' && changeSet.approvedCommit) {
      const gitProbe = new GitClient(workspacePath);
      if (gitProbe.commitExists(changeSet.approvedCommit)) {
        const completed = completePostCommit(changeSet, workspacePath, changeSet.approvedCommit, manifestDigestOf(manifestRow?.manifestJson ?? '{}'), 'recovered', hooks);
        return { success: completed.success, commitHash: completed.commitHash, errors: completed.errors, recovered: completed.success };
      }
    }
    return {
      success: false, recovered: false,
      errors: [`Change set "${changeSet.title}" has no complete commit; publication/recovery is incomplete and export stays unavailable.`],
    };
  }
  const git = new GitClient(workspacePath);
  if (!git.commitExists(manifestRow.commitHash)) {
    return {
      success: false, recovered: false,
      errors: [`Linked manifest references commit ${manifestRow.commitHash.slice(0, 12)} which does not exist; export stays unavailable.`],
    };
  }
  const manifest = parseLinkedManifest(manifestRow.manifestJson);
  if (!manifest) {
    return { success: false, errors: ['Linked manifest is unreadable; refusing recovery.'], recovered: false };
  }
  const completed = completePostCommit(changeSet, workspacePath, manifestRow.commitHash, manifestDigest(manifest), 'recovered', hooks);
  return { success: completed.success, commitHash: completed.commitHash, errors: completed.errors, recovered: completed.success };
}

/**
 * Immutable approved-export loader (issue #363 §6).
 */
export function loadApprovedLinkedExport(
  changeSetId: string,
  workspacePath: string,
): { ok: true; load: LinkedExportLoad } | { ok: false; error: string; incomplete: boolean } {
  const changeSet = findChangeSetById(changeSetId);
  if (!changeSet) return { ok: false, error: 'Change set not found', incomplete: false };
  if (changeSet.status === 'approved' || changeSet.status === 'draft') {
    // Operator retry through the export path (findings 4/7): restore pending
    // uncommitted writes before recovery, then recover idempotently against
    // the landed commit. Incomplete completion stays blocked — the loader
    // never discards recovery warnings into a successful export.
    recoverPendingUncommittedWrites(changeSetId, workspacePath);
    const recovered = recoverLinkedApproval(changeSetId, workspacePath);
    if (!recovered.success) {
      if (!recovered.recovered) {
        return { ok: false, error: recovered.errors.join('; ') || 'Publication/recovery is incomplete and export stays unavailable.', incomplete: true };
      }
      return { ok: false, error: `${recovered.errors.join('; ')}; export stays blocked — retry recovery before export.`, incomplete: true };
    }
    if (changeSet.status === 'approved' && changeSet.approvedCommit) {
      const gitProbe = new GitClient(workspacePath);
      if (!gitProbe.commitExists(changeSet.approvedCommit)) {
        return { ok: false, error: `Approved commit ${changeSet.approvedCommit.slice(0, 12)} does not exist; export stays unavailable until recovery completes.`, incomplete: true };
      }
    }
  }
  const fresh = findChangeSetById(changeSetId);
  if (!fresh) return { ok: false, error: 'Change set not found', incomplete: false };
  if (fresh.status !== 'approved' || !fresh.approvedCommit) {
    return {
      ok: false, incomplete: true,
      error: `Change set must be approved before export (status "${fresh.status}"); partial or unapproved operations cannot export.`,
    };
  }
  const manifestRow = findLinkedManifest(changeSetId);
  if (!manifestRow) {
    return {
      ok: false, incomplete: true,
      error: `Change set ${changeSetId.slice(0, 8)} has no linked manifest; publication/recovery is incomplete — export stays unavailable.`,
    };
  }
  const manifest = parseLinkedManifest(manifestRow.manifestJson);
  if (!manifest) {
    // Corruption is a 400-class signal, not a retryable 409: no recovery
    // pass can re-read an unreadable manifest.
    return { ok: false, error: 'Linked manifest is unreadable; refusing export.', incomplete: false };
  }
  const git = new GitClient(workspacePath);
  if (!git.commitExists(fresh.approvedCommit)) {
    return {
      ok: false, incomplete: true,
      error: `Approved commit ${fresh.approvedCommit.slice(0, 12)} does not exist; export stays unavailable until recovery completes.`,
    };
  }
  for (const read of manifest.reads) {
    const atCommit = git.readFileAtCommit(fresh.approvedCommit, read.filePath);
    if (atCommit === null) {
      return {
        ok: false, incomplete: true,
        error: `Unchanged member "${read.sku}" is missing at approved commit ${fresh.approvedCommit.slice(0, 12)}; the group is incomplete — resolve before export.`,
      };
    }
    try {
      const approvedProduct = ProductSchema.parse(JSON.parse(atCommit));
      // No empty-hash skips: an empty manifest hash means the dep was never
      // verifiably bound — the group is incomplete, never silently current.
      if (!read.productHash || comparisonHashForProduct(approvedProduct) !== read.productHash) {
        return {
          ok: false, incomplete: true,
          error: `Unchanged member "${read.sku}" moved after approval; the group is stale — re-approve before export.`,
        };
      }
    } catch {
      return { ok: false, incomplete: true, error: `Unchanged member "${read.sku}" is unreadable at the approved commit.` };
    }
    if (listOutstandingDriftForSku(fresh.workspaceId, read.sku).length > 0) {
      return {
        ok: false, incomplete: true,
        error: `Unchanged member "${read.sku}" carries unresolved drift; resolve before export.`,
      };
    }
  }
  const products: Product[] = [];
  for (const write of manifest.writes) {
    const atCommit = git.readFileAtCommit(fresh.approvedCommit, write.filePath);
    if (atCommit === null) {
      return {
        ok: false, incomplete: true,
        error: `Approved product "${write.sku}" is missing at commit ${fresh.approvedCommit.slice(0, 12)}; recovery is incomplete.`,
      };
    }
    try {
      products.push(ProductSchema.parse(JSON.parse(atCommit)));
    } catch {
      return { ok: false, incomplete: true, error: `Approved product "${write.sku}" is unreadable at the approved commit.` };
    }
  }
  products.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return { ok: true, load: { products, manifest, commitHash: fresh.approvedCommit } };
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
 * Discard many draft change sets in one atomic call (P2 #25).
 *
 * All-or-nothing: every id must resolve to a draft owned by `workspaceId`,
 * else the whole batch rejects and nothing is deleted. Each discarded set
 * reuses `discardChangeSet` (drift reopen + audit) inside one transaction
 * so a 50-draft clear is a single round trip with elapsed instrumentation
 * at the call site.
 */
export function discardDraftChangeSets(
  changeSetIds: string[],
  workspaceId: string,
): { success: boolean; discarded?: string[]; reason?: string } {
  const rows = changeSetIds.map(id => findChangeSetById(id));
  const missing = changeSetIds.find((id, i) => !rows[i] || rows[i]!.id !== id);
  if (missing) {
    return { success: false, reason: `unknown change set id: ${missing}` };
  }
  const bad = (rows as Array<NonNullable<(typeof rows)[number]>>)
    .find(row => row.workspaceId !== workspaceId || row.status !== 'draft');
  if (bad) {
    return { success: false, reason: `not a workspace draft: ${bad.id}` };
  }
  const db = getDb();
  const discarded: string[] = [];
  db.transaction(() => {
    for (const id of changeSetIds) {
      discardChangeSet(id);
      discarded.push(id);
    }
  })();
  return { success: true, discarded };
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
