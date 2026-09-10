import { deterministicStringify, hashJson } from '../git/deterministic-json';
import { ShopSiteProductCodec } from './product-codec';
import { sanitizeXml } from './xml-sanitizer';
import { createDrift, type DriftRow } from '../db/repositories/drift-repo';
import { findProductBySku, insertProductIndex, updateProductIndex } from '../db/repositories/product-index-repo';
import { readProductFile, writeProductFile } from '../git/workspace-files';
import { skuToProductFilePath } from '../git/product-file-path';
import { GitClient } from '../git/git-client';
import type { Product } from '../shared/types';

export interface DriftDetectionResult {
  driftCount: number;
  drifts: DriftRow[];
  errors: string[];
}

export interface AcceptRemoteResult {
  product: Product;
  commitHash: string | null;
}

/**
 * Detect remote drift by comparing downloaded/parsed remote products
 * against the locally approved product state.
 */
export function detectDrift(
  workspaceId: string,
  workspacePath: string,
  remoteXml: string,
): DriftDetectionResult {
  const errors: string[] = [];
  const drifts: DriftRow[] = [];

  try {
    const cleanXml = sanitizeXml(remoteXml);
    const decoded = ShopSiteProductCodec.decode(cleanXml, { workspaceId });

    for (const remoteProduct of decoded.products) {
      const sku = remoteProduct.sku;
      if (!sku) continue;

      const localProduct = readProductFile(workspacePath, sku);
      const localHash = localProduct ? computeContentHash(localProduct) : null;
      const remoteHash = computeContentHash(remoteProduct);
      const indexRow = findProductBySku(sku);
      const lastSyncedHash = indexRow?.lastSyncedRemoteHash ?? null;

      // Remote has changed if its hash differs from the last synced version we had.
      // If we don't have a last synced hash yet, compare against the remote version directly.
      const remoteChanged = lastSyncedHash === null || lastSyncedHash !== remoteHash;

      if (localHash !== remoteHash && remoteChanged) {
        const drift = createDrift({
          workspaceId,
          sku,
          localHash,
          remoteHash,
          localJson: localProduct ? deterministicStringify(localProduct) : null,
          remoteJson: deterministicStringify(remoteProduct),
          diffJson: deterministicStringify({
            localSku: localProduct?.sku ?? null,
            remoteSku: sku,
            hasLocalProduct: !!localProduct,
            hasRemoteChanges: true,
          }),
        });
        drifts.push(drift);
      }

      if (indexRow) {
        const isSynced = localHash === remoteHash;
        let nextSyncStatus = indexRow.syncStatus;
        if (isSynced) {
          nextSyncStatus = 'synced';
        } else if (remoteChanged) {
          nextSyncStatus = 'drifted';
        } else {
          // Local changes exist, but remote didn't change: keep as not_synced (staged)
          nextSyncStatus = 'not_synced';
        }

        updateProductIndex({
          sku,
          lastPulledRemoteHash: remoteHash,
          syncStatus: nextSyncStatus,
          lastSyncedRemoteHash: isSynced ? remoteHash : indexRow.lastSyncedRemoteHash,
          lastSyncedAt: isSynced ? new Date().toISOString() : indexRow.lastSyncedAt,
        });
      }
    }

    return { driftCount: drifts.length, drifts, errors };
  } catch (err) {
    const msg = `Drift detection failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    return { driftCount: 0, drifts, errors };
  }
}

/**
 * Compute a deterministic hash of comparison-relevant product fields only.
 * Excludes transient fields (id, timestamps, pulled/synced hashes) that change
 * on every normalization and would cause false drift detection.
 */
function computeContentHash(product: Record<string, unknown>): string {
  const relevant: Record<string, unknown> = {
    sku: product.sku,
    status: product.status,
    core: product.core,
    customFields: product.customFields,
    shopsite: product.shopsite ? {
      source: (product.shopsite as Record<string, unknown>).source,
      xmlVersion: (product.shopsite as Record<string, unknown>).xmlVersion,
      preserved: (product.shopsite as Record<string, unknown>).preserved,
    } : undefined,
  };
  return hashJson(relevant);
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

  writeProductFile(workspacePath, remoteProduct);

  const productHash = hashJson(remoteProduct);
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
