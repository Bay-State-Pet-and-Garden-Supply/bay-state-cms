import { FamilyMemberOriginSchema, type FamilyMemberOrigin } from '../shared/schemas/storefront-family';
import { findFamilyOnboardingOrigin, listApprovedFamilyCatalogReceipts } from '../db/repositories/storefront-family-origin-repo';
import { findItemById } from '../db/repositories/onboarding-item-repo';
import { getRun, getAcceptedProposals } from '../db/repositories/classification-run-repo';
import { getCurrentItemEvidenceView } from '../onboarding/item-evidence';
import { validateReviewCompletionGate } from './review-completion-gate';
import { GitClient } from '../git/git-client';
import { skuToProductFilePath } from '../git/product-file-path';
import { ProductSchema, type Product } from '../shared/schemas/product';
import { hashCanonicalJson } from '../shared/stable-id';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import { getEffectivePrimaryProductTypeId } from './assignment-projection';
import { computeReviewedAuthorityHash } from './promotion-gate';

import { parseOunces } from '../validation/storefront-family-validation';
function approvedCatalogProduct(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
  origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }>;
}): { product: Product; classificationRunId: string; classificationHash: string; reviewedProductTypeId: string } | null {
  const receipt = listApprovedFamilyCatalogReceipts(input.workspaceId, input.sku).find((candidate) =>
    candidate.approvedCommit === input.origin.approvedCommit &&
    candidate.classificationRunId === input.origin.classificationRunId);
  if (!receipt?.classificationRunId) return null;
  const git = new GitClient(input.workspacePath);
  const filePath = skuToProductFilePath(input.sku);
  let committed: Product;
  let current: Product;
  try {
    committed = ProductSchema.parse(JSON.parse(git.readFileAtCommit(receipt.approvedCommit, filePath) ?? ''));
    current = ProductSchema.parse(JSON.parse(git.readFileAtHead(filePath) ?? ''));
  } catch {
    return null;
  }
  if (committed.sku !== input.sku || current.sku !== input.sku) return null;
  const productHash = comparisonHashForProduct(committed);
  if (productHash !== input.origin.productHash || comparisonHashForProduct(current) !== productHash) return null;
  const reviewedTypeHash = committed.shopsite.preserved.rawAttributes.reviewedTypeHash;
  if (typeof reviewedTypeHash !== 'string' || !reviewedTypeHash) return null;
  let productTypeId: string | null =
    typeof committed.shopsite.preserved.rawAttributes.nonFoodProductTypeId === 'string'
      ? committed.shopsite.preserved.rawAttributes.nonFoodProductTypeId
      : null;
  try {
    const pair = getAcceptedProposals(input.sku, receipt.classificationRunId)
      .find((proposal) => proposal.proposalType === 'product_classification');
    if (pair) productTypeId = getEffectivePrimaryProductTypeId(pair as Parameters<typeof getEffectivePrimaryProductTypeId>[0]);
  } catch {
    return null;
  }
  if (!productTypeId || computeReviewedAuthorityHash(productTypeId) !== reviewedTypeHash) return null;
  const classificationHash = hashCanonicalJson({
    version: 1, sku: input.sku, approvedCommit: receipt.approvedCommit,
    classificationRunId: receipt.classificationRunId, productTypeId, reviewedTypeHash,
  });
  if (classificationHash !== input.origin.classificationHash) return null;
  const run = getRun(receipt.classificationRunId);
  if (!run || run.workspaceId !== input.workspaceId || run.productSku !== input.sku ||
    (run.status !== 'completed' && run.status !== 'completed_with_abstentions')) return null;
  return { product: current, classificationRunId: receipt.classificationRunId, classificationHash, reviewedProductTypeId: productTypeId };
}
export type FamilyMemberOriginValidation =
  | { ok: true; classificationRunId: string | null; purchasable: boolean }
  | { ok: false; code: string; reason: string };

/** Validate a stored family source binding without ever rebinding by SKU. */
export function resolveApprovedCatalogFamilyOrigin(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
}): {
  origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }>;
  product: Product;
  reviewedProductTypeId: string;
} | null {
  for (const receipt of listApprovedFamilyCatalogReceipts(input.workspaceId, input.sku)) {
    if (!receipt.classificationRunId) continue;
    const filePath = skuToProductFilePath(input.sku);
    const git = new GitClient(input.workspacePath);
    let product: Product;
    try {
      product = ProductSchema.parse(JSON.parse(git.readFileAtCommit(receipt.approvedCommit, filePath) ?? ''));
    } catch {
      continue;
    }
    const productHash = comparisonHashForProduct(product);
    const reviewedTypeHash = product.shopsite.preserved.rawAttributes.reviewedTypeHash;
    if (typeof reviewedTypeHash !== 'string' || !reviewedTypeHash) continue;
    const storedTypeId: string | null =
      typeof product.shopsite.preserved.rawAttributes.nonFoodProductTypeId === 'string'
        ? product.shopsite.preserved.rawAttributes.nonFoodProductTypeId
        : null;
    let productTypeId: string | null = storedTypeId;
    try {
      const pair = getAcceptedProposals(input.sku, receipt.classificationRunId)
        .find((proposal) => proposal.proposalType === 'product_classification');
      if (pair) productTypeId = getEffectivePrimaryProductTypeId(pair as Parameters<typeof getEffectivePrimaryProductTypeId>[0]);
    } catch {
      continue;
    }
    if (!productTypeId || computeReviewedAuthorityHash(productTypeId) !== (reviewedTypeHash as string)) continue;
    const classificationHash = hashCanonicalJson({
      version: 1, sku: input.sku, approvedCommit: receipt.approvedCommit,
      classificationRunId: receipt.classificationRunId, productTypeId, reviewedTypeHash,
    });
    const origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }> = {
      kind: 'catalog', approvedCommit: receipt.approvedCommit, productHash,
      classificationRunId: receipt.classificationRunId, classificationHash,
    };
    const verified = approvedCatalogProduct({ ...input, origin });
    if (verified) return { origin, product: verified.product, reviewedProductTypeId: verified.reviewedProductTypeId };
  }
  return null;
}
export interface ApprovedCatalogFamilyProjection {
  origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }>;
  product: Product;
  classificationRunId: string;
  reviewedProductTypeId: string;
  reviewedTypeHash: string;
  evidenceHash: string;
  purchasable: boolean;
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  sizeRaw: string | null;
  ounces: number | null;
  retailUnit: string | null;
  packCountDeclared: boolean;
  packCount: number | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}


function projectCatalogProduct(
  source: { origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }>; product: Product; reviewedProductTypeId: string },
): ApprovedCatalogFamilyProjection | null {
  const attrs = source.product.shopsite.preserved.rawAttributes;
  const reviewedTypeHash = attrs.reviewedTypeHash;
  if (typeof reviewedTypeHash !== 'string' || !reviewedTypeHash) return null;
  const sizeRaw = textOf(source.product.core.weight);
  const intAttr = (key: string): number | null => {
    const value = attrs[key];
    return typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
  };
  return {
    ...source,
    classificationRunId: source.origin.classificationRunId!,
    reviewedTypeHash,
    evidenceHash: source.origin.productHash,
    purchasable: source.product.status === 'active',
    brand: textOf(source.product.customFields.ProductField16),
    recipe: textOf(source.product.customFields.ProductField24),
    flavor: textOf(source.product.customFields.ProductField23),
    species: textOf(source.product.customFields.ProductField17),
    lifeStage: textOf(source.product.customFields.ProductField18),
    form: textOf(source.product.customFields.ProductField22),
    sizeRaw,
    ounces: parseOunces(sizeRaw),
    retailUnit: textOf(attrs.retailUnit),
    packCountDeclared: attrs.packCountDeclared === 'true',
    packCount: intAttr('packCount'),
    model: textOf(attrs.nonFoodModel),
    material: textOf(attrs.nonFoodMaterial),
    function: textOf(attrs.nonFoodFunction),
    safetyDose: textOf(attrs.nonFoodSafetyDose),
    strength: textOf(attrs.nonFoodStrength),
    fit: textOf(attrs.nonFoodFit),
    colorRaw: textOf(attrs.nonFoodColorRaw),
    countRaw: textOf(attrs.nonFoodCountRaw),
    countQuantity: intAttr('nonFoodCountQuantity'),
  };
}

/** Resolve the latest currently approved catalog origin and its shared factor projection. */
export function projectApprovedCatalogFamilyOrigin(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
}): ApprovedCatalogFamilyProjection | null {
  const source = resolveApprovedCatalogFamilyOrigin(input);
  return source ? projectCatalogProduct(source) : null;
}

/** Resolve exactly the stored catalog binding; never fall back to another receipt for the SKU. */
export function projectBoundCatalogFamilyOrigin(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
  origin: Extract<FamilyMemberOrigin, { kind: 'catalog' }>;
}): ApprovedCatalogFamilyProjection | null {
  const verified = approvedCatalogProduct(input);
  if (!verified) return null;
  return projectCatalogProduct({
    origin: input.origin,
    product: verified.product,
    reviewedProductTypeId: verified.reviewedProductTypeId,
  });
}

export function validateFamilyMemberOrigin(input: {
  workspaceId: string;
  workspacePath: string;
  sku: string;
  origin: FamilyMemberOrigin | undefined;
}): FamilyMemberOriginValidation {
  const parsed = FamilyMemberOriginSchema.safeParse(input.origin);
  if (!parsed.success) return { ok: false, code: 'family_origin_missing', reason: 'This family member has no bound source origin. Re-stage it from an identified current item or approved catalog product.' };
  const origin = parsed.data;
  if (origin.kind === 'catalog') {
    const approved = approvedCatalogProduct({ ...input, origin });
    if (!approved) return { ok: false, code: 'catalog_origin_unverified', reason: 'The approved commit, current product, or reviewed classification authority no longer matches this member.' };
    return { ok: true, classificationRunId: approved.classificationRunId, purchasable: approved.product.status === 'active' };
  }
  const row = findFamilyOnboardingOrigin(input.workspaceId, origin.itemId);
  if (!row || row.sku !== input.sku) return { ok: false, code: 'onboarding_origin_mismatch', reason: 'The bound onboarding item is missing, belongs to another workspace, or has a different SKU.' };
  const item = findItemById(origin.itemId);
  const run = getRun(origin.runId);
  const evidence = getCurrentItemEvidenceView(input.workspaceId, origin.itemId).evidence;
  if (!item || !evidence || !run || run.workspaceId !== input.workspaceId || run.productSku !== input.sku ||
    (run.status !== 'completed' && run.status !== 'completed_with_abstentions') ||
    row.runId !== origin.runId || row.runCurrentnessHash !== origin.runCurrentnessHash ||
    row.evidenceId !== origin.evidenceId || row.evidenceHash !== origin.evidenceHash ||
    evidence.id !== origin.evidenceId || evidence.evidenceHash !== origin.evidenceHash) {
    return { ok: false, code: 'onboarding_origin_stale', reason: 'The bound onboarding run or accepted evidence is no longer the current item-local source.' };
  }
  const gate = validateReviewCompletionGate({ workspaceId: input.workspaceId, onboardingItemId: origin.itemId, productSku: input.sku, activeRunId: origin.runId });
  if (!gate.ok) return { ok: false, code: gate.code, reason: gate.reason };
  let curation: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(row.curationJson ?? '');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid');
    curation = raw as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'onboarding_authority_invalid', reason: 'Current item authority is unreadable; refresh and review the item before using it in a family.' };
  }
  if (curation.purchasable !== true && curation.purchasable !== false) {
    return { ok: false, code: 'purchasability_unknown', reason: 'Purchasability has no current explicit item decision. Record an honest item decision before using this member.' };
  }
  return { ok: true, classificationRunId: origin.runId, purchasable: curation.purchasable };
}

/** Stable hash of the bound approved classification projection. */
export function familyCatalogClassificationHash(value: unknown): string {
  return hashCanonicalJson(value);
}
