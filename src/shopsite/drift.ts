import { deterministicStringify } from '../git/deterministic-json';
import { ShopSiteProductCodec } from './product-codec';
import { sanitizeXml } from './xml-sanitizer';
import {
  buildComparisonProjection,
  buildComparisonContext,
  comparisonHashForProduct,
  diffComparisonProjections,
  hashComparisonProjection,
  CATALOG_COMPARISON_PROJECTION_VERSION,
  type ComparisonContext,
  type ControlledValueConfig,
  type PageIdentityResolver,
} from './catalog-comparison';
import { SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION } from './built-in-output-policy';
import { SHOP_SITE_FIELD_CATALOG_VERSION } from './field-catalog';
import { clearMatchedOpenDrift, upsertDrift, type DriftRow } from '../db/repositories/drift-repo';
import { findHunkAck } from '../db/repositories/drift-hunk-repo';
import { findProductBySku, insertProductIndex, updateProductIndex, listCatalogFilenameOwners } from '../db/repositories/product-index-repo';
import { getActivePageImportHash, getPageByName } from '../db/repositories/page-repo';
import { listNonDiscardedChangeSetDrafts } from '../db/repositories/change-set-repo';
import { normalizeFileName, resolveBaseFileName, resolveReimportFilename } from './file-name';
import { readProductFile, writeProductFile } from '../git/workspace-files';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import type { Product } from '../shared/types';

export interface DriftDetectionResult {
  driftCount: number;
  drifts: DriftRow[];
  errors: string[];
  baselineCommit: string | null;
  baselineDirty: boolean;
  baselineSource: 'head' | 'working-tree';
  projectionVersion: string;
  context: ComparisonContext;
}

export interface AcceptRemoteResult {
  product: Product;
  commitHash: string | null;
}

export interface DetectDriftOptions {
  controlledByField?: Record<string, ControlledValueConfig>;
  resolvePageIdentity?: PageIdentityResolver;
  pageImportHash?: string | null;
}

/**
 * Detect remote drift by comparing downloaded/parsed remote products
 * against the pinned approved Git HEAD baseline.
 *
 * The working tree is never the baseline: dirty files do not move the
 * comparison, they are recorded as context (baselineDirty) so stale
 * comparisons can be invalidated. The legacy lastSyncedRemoteHash pointer
 * is observation-only and never gates drift — HEAD equality alone decides.
 *
 * Drift 1/6 (#250): rechecks are idempotent — identical remote data and
 * unchanged baseline context produce zero new rows via `upsertDrift`
 * (one outstanding finding per product per workspace, DB-enforced).
 */
export function detectDrift(
  workspaceId: string,
  workspacePath: string,
  remoteXml: string,
  options?: DetectDriftOptions,
): DriftDetectionResult {
  const errors: string[] = [];
  const drifts: DriftRow[] = [];

  const git = new GitClient(workspacePath);
  const isRepo = git.isRepo();
  let baselineCommit: string | null = null;
  let baselineDirty = false;
  let baselineSource: 'head' | 'working-tree' = isRepo ? 'head' : 'working-tree';
  if (isRepo) {
    try {
      const head = git.getHeadHash();
      baselineCommit = head || null;
    } catch {
      baselineCommit = null;
    }
    try {
      baselineDirty = git.status().length > 0;
    } catch {
      baselineDirty = false;
    }
    if (!baselineCommit) baselineSource = 'working-tree';
  }

  let pageImportHash: string | null = options?.pageImportHash ?? null;
  if (options?.pageImportHash === undefined) {
    try {
      pageImportHash = getActivePageImportHash(workspaceId);
    } catch {
      pageImportHash = null;
    }
  }
  const context = buildComparisonContext(pageImportHash);

  let resolvePageIdentity: PageIdentityResolver | undefined = options?.resolvePageIdentity;
  if (!resolvePageIdentity) {
    resolvePageIdentity = (pageName: string): string | null => {
      try {
        const page = getPageByName(pageName);
        if (page && page.identityStatus === 'verified' && page.availability === 'available' && page.identityKey) {
          return `${page.identityKind}:${page.identityKey}`;
        }
      } catch {
        // No page index available: fall back to name identity (missing identity path).
      }
      return null;
    };
  }

  try {
    const cleanXml = sanitizeXml(remoteXml);
    const decoded = ShopSiteProductCodec.decode(cleanXml, { workspaceId });

    for (const remoteProduct of decoded.products) {
      const sku = remoteProduct.sku;
      if (!sku) continue;

      const baselineProduct = readPinnedBaseline(workspacePath, sku, baselineSource);
      const baselineProjection = baselineProduct
        ? buildComparisonProjection(baselineProduct, {
            controlledByField: options?.controlledByField,
            resolvePageIdentity,
            pageImportHash,
          })
        : null;
      const remoteProjection = buildComparisonProjection(remoteProduct, {
        controlledByField: options?.controlledByField,
        resolvePageIdentity,
        pageImportHash,
      });
      const localHash = baselineProjection ? hashComparisonProjection(baselineProjection) : null;
      const remoteHash = hashComparisonProjection(remoteProjection);
      const indexRow = findProductBySku(sku);

      // Pinned HEAD equality decides match; lastSynced is direction-only
      // (never a competing baseline): when HEAD != remote but remote hasn't
      // moved since the last successful sync, local approved state moved
      // (staged, unpushed) — preserve `not_synced` and create no drift.
      const isSynced = localHash !== null && localHash === remoteHash;
      const remoteUnmoved =
        indexRow?.lastSyncedRemoteHash != null && indexRow.lastSyncedRemoteHash === remoteHash;

      if (isSynced) {
        // Drift 1/6 (#250): reverting to baseline clears findings that no
        // longer differ — but only on an actual comparison match. A known
        // outstanding difference is never reported as a match. `in_reconcile`
        // rows are preserved so reconcile links never break via auto-clear.
        clearMatchedOpenDrift(workspaceId, sku);
      } else if (indexRow && remoteUnmoved) {
        // Local ahead (unpushed approval): no new drift, keep staged signal.
      } else {
        const allHunks = diffComparisonProjections(baselineProjection, remoteProjection);
        // Drift 4/6 (#253): every outstanding finding carries field identity —
        // a product row with zero hunks says nothing and is never stored.
        // Explicit rejections suppress only their reviewed hunk (same field,
        // values, remote hash, baseline, and comparison context) without
        // asserting remote equality; a changed baseline, newer remote, or
        // changed context invalidates the acknowledgement and the hunk
        // reappears.
        const baselineCommitKey = baselineCommit ?? '';
        const pageHashKey = context.pageImportHash ?? '';
        const visibleHunks = allHunks.filter((h) => {
          try {
            return !findHunkAck({
              workspaceId,
              sku,
              field: h.field,
              baselineValue: h.baselineValue ?? '',
              remoteValue: h.remoteValue ?? '',
              remoteHash,
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
        if (visibleHunks.length === 0) {
          // All differences acknowledged (or none): no outstanding work to
          // store, but never report a match — sync stays drifted, not synced.
          // Clear any stale open row so identical rechecks stay flat.
          if (allHunks.length > 0) {
            clearMatchedOpenDrift(workspaceId, sku);
          }
        } else {
          // Drift 1/6 (#250): identical rechecks are no-ops (zero new rows,
          // existing unresolved differences stay visible); a newer remote
          // state supersedes obsolete outstanding work in place.
          const outcome = upsertDrift({
            workspaceId,
            sku,
            localHash,
            remoteHash,
            localJson: baselineProduct ? deterministicStringify(baselineProduct) : null,
            remoteJson: deterministicStringify(remoteProduct),
            diffJson: deterministicStringify({
              localSku: baselineProduct?.sku ?? null,
              remoteSku: sku,
              hasLocalProduct: !!baselineProduct,
              hasRemoteChanges: true,
              hunks: visibleHunks,
              baselineCommit,
              baselineSource,
              baselineDirty,
              projectionVersion: CATALOG_COMPARISON_PROJECTION_VERSION,
              context,
            }),
          });
          if (outcome.kind !== 'noop') {
            drifts.push(outcome.row);
          }
        }
      }

      if (indexRow) {
        let nextSyncStatus: string;
        if (isSynced) nextSyncStatus = 'synced';
        else if (remoteUnmoved) nextSyncStatus = 'not_synced';
        else nextSyncStatus = 'drifted';
        updateProductIndex({
          sku,
          lastPulledRemoteHash: remoteHash,
          syncStatus: nextSyncStatus,
          lastSyncedRemoteHash: isSynced ? remoteHash : indexRow.lastSyncedRemoteHash,
          lastSyncedAt: isSynced ? new Date().toISOString() : indexRow.lastSyncedAt,
        });
      }
    }

    return {
      driftCount: drifts.length,
      drifts,
      errors,
      baselineCommit,
      baselineDirty,
      baselineSource,
      projectionVersion: CATALOG_COMPARISON_PROJECTION_VERSION,
      context,
    };
  } catch (err) {
    const msg = `Drift detection failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    return {
      driftCount: 0,
      drifts,
      errors,
      baselineCommit,
      baselineDirty,
      baselineSource,
      projectionVersion: CATALOG_COMPARISON_PROJECTION_VERSION,
      context,
    };
  }
}

/**
 * Read the pinned baseline product: HEAD content when the workspace is a
 * Git repo with a HEAD, otherwise the working-tree file. Missing files at
 * HEAD mean no baseline (genuinely new remote product), never a fallback
 * to dirty working-tree content when HEAD exists.
 */
function readPinnedBaseline(
  workspacePath: string,
  sku: string,
  baselineSource: 'head' | 'working-tree',
): Product | null {
  if (baselineSource === 'head') {
    try {
      const git = new GitClient(workspacePath);
      const content = git.readFileAtHead(skuToProductFilePath(sku));
      if (content) return JSON.parse(content) as Product;
      return null;
    } catch {
      return null;
    }
  }
  try {
    return readProductFile(workspacePath, sku);
  } catch {
    return null;
  }
}

/**
 * Accept the remote version for a drift row by writing it to the canonical
 * product JSON file and creating a Git commit. This intentionally changes the
 * approved local catalog state; users who want to inspect first should use the
 * create_change_set action instead.
 */
export function acceptRemoteForDrift(workspacePath: string, drift: DriftRow): AcceptRemoteResult {
  const remoteProduct = JSON.parse(drift.remoteJson) as Product;
  if (!remoteProduct.sku) {
    throw new Error('Cannot accept remote product without SKU.');
  }

  // Issue #106 SEQUENCE 2e: collision-aware re-import. A pulled FileName
  // owned by ANOTHER sku holds with IMPORT_FILENAME_COLLISION — no write,
  // no live-page rename. Operator repair goes through the normal reviewed
  // flow (change set), never a healed-heuristic.
  const pulledName = normalizeFileName(
    (remoteProduct.customFields?.['FileName'] as unknown) ??
      (remoteProduct.core?.seo?.fileName as unknown) ?? null,
  );
  if (pulledName) {
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
      for (const { sku, draftJson } of listNonDiscardedChangeSetDrafts(drift.workspaceId)) {
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
    const disposition = resolveReimportFilename(pulledName, remoteProduct.sku, owners);
    if (disposition.action === 'hold_collision') {
      throw new Error(
        `IMPORT_FILENAME_COLLISION: pulled FileName "${disposition.name}" for SKU ${remoteProduct.sku} is owned by ${disposition.ownerSku}. Repair through a reviewed change set; live pages are never renamed automatically.`,
      );
    }
  }

  writeProductFile(workspacePath, remoteProduct);

  // Canonical comparison value owned by the import/check slice (#256):
  // drift acceptance writes the same hash drift checking reads, so an
  // accepted product compares equal on the next check. drift.remoteHash is
  // already canonical (written by detectDrift); productHash must match that
  // language. Accepting means local now equals the observed remote, so both
  // the observation pointer and the successful-sync pointer advance to the
  // canonical remote hash together with a synced status.
  const productHash = comparisonHashForProduct(remoteProduct);
  const existing = findProductBySku(remoteProduct.sku);
  if (existing) {
    updateProductIndex({
      sku: remoteProduct.sku,
      title: remoteProduct.core.name,
      status: remoteProduct.status,
      price: remoteProduct.core.price,
      inventoryQuantity: remoteProduct.core.inventory.quantityOnHand,
      primaryImage: remoteProduct.core.media.primary,
      productHash,
      lastPulledRemoteHash: drift.remoteHash,
      lastSyncedRemoteHash: drift.remoteHash,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
      hasAdvancedBlocks: Object.keys(remoteProduct.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
      description: remoteProduct.core.description,
      searchKeywords: remoteProduct.core.seo.searchKeywords,
      customFields: remoteProduct.customFields,
    });
  } else {
    insertProductIndex({
      id: remoteProduct.id,
      sku: remoteProduct.sku,
      filePath: skuToProductFilePath(remoteProduct.sku),
      title: remoteProduct.core.name,
      status: remoteProduct.status,
      price: remoteProduct.core.price,
      inventoryQuantity: remoteProduct.core.inventory.quantityOnHand,
      primaryImage: remoteProduct.core.media.primary,
      productHash,
      lastApprovedCommit: null,
      lastPulledRemoteHash: drift.remoteHash,
      lastSyncedRemoteHash: drift.remoteHash,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
      hasAdvancedBlocks: Object.keys(remoteProduct.shopsite.preserved.advancedBlocks).length > 0 ? 1 : 0,
      hasWarnings: 0,
      createdAt: remoteProduct.metadata.createdAt,
      updatedAt: remoteProduct.metadata.updatedAt,
      description: remoteProduct.core.description,
      searchKeywords: remoteProduct.core.seo.searchKeywords,
      customFields: remoteProduct.customFields,
    });
  }

  let commitHash: string | null = null;
  const git = new GitClient(workspacePath);
  if (git.isRepo()) {
    git.add([skuToProductFilePath(remoteProduct.sku)]);
    const status = git.status();
    if (status) {
      git.commit(`Accept remote ShopSite drift: ${remoteProduct.sku}`);
      commitHash = git.getHeadHash();
      updateProductIndex({ sku: remoteProduct.sku, lastApprovedCommit: commitHash });
    }
  }

  return { product: remoteProduct, commitHash };
}
