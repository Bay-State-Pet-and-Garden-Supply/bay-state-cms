import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { resolveApprovedCatalogFamilyOrigin, validateFamilyMemberOrigin } from '../../classification/storefront-family-origin';
import { computeReviewedAuthorityHash } from '../../classification/promotion-gate';
import { comparisonHashForProduct } from '../../shopsite/catalog-comparison';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { writeProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { approveChangeSet } from '../../server/services/change-set-service';
import type { FamilyMemberOrigin } from '../../shared/schemas/storefront-family';
import type { Product } from '../../shared/types';

/** Seeds truthful catalog authority for integration family tests only. */
export function approveFamilyCatalogProduct(input: {
  workspaceId: string;
  workspacePath: string;
  product: Product;
  productTypeId: string;
}): { product: Product; runId: string; origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }> } {
  const product = structuredClone(input.product);
  // ProductDisabled=checked decodes as draft; approved family catalog members must be live to sell.
  product.status = 'active';
  const reviewedTypeHash = computeReviewedAuthorityHash(input.productTypeId);
  if (!reviewedTypeHash) throw new Error(`Family catalog authority hash unavailable for ${input.product.sku}`);
  product.shopsite.preserved.rawAttributes.reviewedTypeHash = reviewedTypeHash;
  product.shopsite.preserved.rawAttributes.nonFoodProductTypeId = input.productTypeId;
  writeProductFile(input.workspacePath, product);

  const run = createRun(input.workspaceId, product.sku, null, null, {
    sourceKind: 'catalog_product',
    sourceProductHash: comparisonHashForProduct(product),
  });
  completeRun(run.id, 'completed');

  const git = new GitClient(input.workspacePath);
  const changeSet = createChangeSet({
    workspaceId: input.workspaceId,
    title: `Reviewed family catalog product ${product.sku}`,
    baseCommit: git.getHeadHash(),
  });
  const draftJson = deterministicStringify(product);
  upsertChangeSetItem({
    changeSetId: changeSet.id,
    sku: product.sku,
    operation: 'update',
    draftJson,
    baseJson: draftJson,
    draftHash: hashJson(product),
    classificationRunId: run.id,
  });
  const approved = approveChangeSet(changeSet.id, input.workspacePath);
  if (!approved.success) throw new Error(`Family catalog authority approval failed for ${product.sku}`);

  const resolved = resolveApprovedCatalogFamilyOrigin({
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    sku: product.sku,
  });
  if (!resolved) throw new Error(`Family catalog authority did not resolve for ${product.sku}`);
  const validation = validateFamilyMemberOrigin({
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    sku: product.sku,
    origin: resolved.origin,
  });
  if (!validation.ok) throw new Error(`Family catalog authority validation failed: ${validation.code}`);
  return { product: resolved.product, runId: run.id, origin: resolved.origin };
}
