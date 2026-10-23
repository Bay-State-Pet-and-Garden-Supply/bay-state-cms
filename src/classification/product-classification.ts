/**
 * Canonical Product Classification (ADR 0041, issue #350).
 *
 * One Product Classification = Category + Product Type. The pair is valid
 * iff the product type exists AND its approved `categoryId` mapping matches
 * the pair's category. An internal identifier references exactly that same
 * combination — never a second semantic decision.
 *
 * Profiles stay keyed by Product Type (Type → attributeProfileId → profile);
 * Category does not select profiles. This module is the single shared
 * ownership point for pair validity; every enforcement point (proposal
 * production, review validation, projection, application, readiness) reads
 * the pair through here.
 */


/** One canonical Product Classification: Category + Product Type. */
export interface ProductClassification {
  categoryId: string;
  productTypeId: string;
}

/** Per-component outcome: explicit supported value or explicit unresolved reason. */
export type ClassificationComponentOutcome =
  | { status: 'supported'; value: string }
  | { status: 'unresolved'; reason: string };

/** A classification result addressing BOTH core components. */
export interface CanonicalClassificationResult {
  category: ClassificationComponentOutcome;
  productType: ClassificationComponentOutcome;
}

/** Attributable refusal code when a pair is not an approved combination. */
export const INVALID_CLASSIFICATION_PAIR_CODE = 'invalid_classification_pair';

/** Configuration gap code when a type has no approved category mapping. */
export const UNMAPPED_TYPE_CATEGORY_CODE = 'unmapped_product_type_category';

export interface BundleView {
  productTypes: Array<{ id: string; categoryId?: string | null; websiteValues?: WebsiteClassificationValues | null }>;
  categories: Array<{ id: string }>;
}

/** Exact externally approved ShopSite classification field values. */
export interface WebsiteClassificationValues {
  category: string;
  productType: string;
}

export type WebsiteClassificationResolution =
  | { status: 'resolved'; values: WebsiteClassificationValues }
  | { status: 'unresolved'; code: string; reason: string };

export const UNMAPPED_WEBSITE_CLASSIFICATION_CODE = 'unmapped_website_classification';
export const AMBIGUOUS_WEBSITE_CLASSIFICATION_CODE = 'ambiguous_website_classification';

/**
 * Resolve the exact approved website values from canonical internal IDs.
 * Refuses unknown, mismatched, incomplete, or ambiguous mappings; internal
 * identifiers are never returned as website values.
 */
export function resolveWebsiteClassification(
  pair: ProductClassification,
  bundle: BundleView,
): WebsiteClassificationResolution {
  const category = bundle.categories.find(candidate => candidate.id === pair.categoryId);
  if (!category || !pair.categoryId) {
    return { status: 'unresolved', code: INVALID_CLASSIFICATION_PAIR_CODE, reason: 'Category is not configured.' };
  }
  const matches = bundle.productTypes.filter(candidate => candidate.id === pair.productTypeId);
  if (matches.length !== 1) {
    return { status: 'unresolved', code: matches.length === 0 ? INVALID_CLASSIFICATION_PAIR_CODE : AMBIGUOUS_WEBSITE_CLASSIFICATION_CODE,
      reason: matches.length === 0 ? 'Product Type is not configured.' : 'Product Type identifier is ambiguous.' };
  }
  const type = matches[0];
  if (type.categoryId !== pair.categoryId) {
    return { status: 'unresolved', code: INVALID_CLASSIFICATION_PAIR_CODE, reason: 'Product Type does not belong to the supplied Category.' };
  }
  const websiteValues = type.websiteValues;
  if (!websiteValues || !websiteValues.category.trim() || !websiteValues.productType.trim()) {
    return { status: 'unresolved', code: UNMAPPED_WEBSITE_CLASSIFICATION_CODE, reason: 'Product Type has no complete approved website mapping.' };
  }
  const duplicate = bundle.productTypes.some(candidate =>
    candidate.id !== type.id
    && candidate.websiteValues?.category === websiteValues.category
    && candidate.websiteValues?.productType === websiteValues.productType,
  );
  if (duplicate) {
    return { status: 'unresolved', code: AMBIGUOUS_WEBSITE_CLASSIFICATION_CODE, reason: 'Website classification mapping is ambiguous.' };
  }
  return {
    status: 'resolved',
    values: { category: websiteValues.category, productType: websiteValues.productType },
  };
}

/**
 * Resolve the approved Category for a Product Type through its mapping.
 * Returns null when the type is unknown or unmapped (configuration gap —
 * never silent invention; the caller reports UNMAPPED_TYPE_CATEGORY_CODE).
 */
export function resolveTypeCategory(productTypeId: string, bundle: BundleView): string | null {
  const type = bundle.productTypes.find(candidate => candidate.id === productTypeId);
  const categoryId = type?.categoryId;
  return typeof categoryId === 'string' && categoryId.length > 0 ? categoryId : null;
}

/**
 * True iff the pair is an approved configured combination: the category
 * exists and the type's approved mapping equals the pair's category. No
 * taxonomy label or combination is invented — anything else is invalid.
 */
export function isApprovedClassificationPair(pair: ProductClassification, bundle: BundleView): boolean {
  if (!pair.categoryId || !pair.productTypeId) return false;
  if (!bundle.categories.some(category => category.id === pair.categoryId)) return false;
  return resolveTypeCategory(pair.productTypeId, bundle) === pair.categoryId;
}

/**
 * Build the per-component result for a pair: each component is supported
 * (known + mapping-consistent) or explicitly unresolved with a reason.
 */
export function resolveClassificationResult(
  pair: { categoryId: string | null; productTypeId: string | null },
  bundle: BundleView,
): CanonicalClassificationResult {
  const categoryKnown = typeof pair.categoryId === 'string' && pair.categoryId.length > 0
    && bundle.categories.some(category => category.id === pair.categoryId);
  const mappedCategory = typeof pair.productTypeId === 'string' && pair.productTypeId.length > 0
    ? resolveTypeCategory(pair.productTypeId, bundle)
    : null;
  const category: ClassificationComponentOutcome = !pair.categoryId
    ? { status: 'unresolved', reason: 'Category is missing.' }
    : !categoryKnown
      ? { status: 'unresolved', reason: `Category "${pair.categoryId}" is not configured.` }
      : mappedCategory !== pair.categoryId
        ? { status: 'unresolved', reason: `Category "${pair.categoryId}" does not match the approved mapping.` }
        : { status: 'supported', value: pair.categoryId };
  const productType: ClassificationComponentOutcome = !pair.productTypeId
    ? { status: 'unresolved', reason: 'Product Type is missing.' }
    : !mappedCategory
      ? { status: 'unresolved', reason: `Product Type "${pair.productTypeId}" has no approved Category mapping.` }
      : pair.categoryId && mappedCategory !== pair.categoryId
        ? { status: 'unresolved', reason: `Product Type "${pair.productTypeId}" belongs to Category "${mappedCategory}", not "${pair.categoryId}".` }
        : { status: 'supported', value: pair.productTypeId };
  return { category, productType };
}

/** True when both core components are supported (the pair is complete). */
export function isCompleteClassification(result: CanonicalClassificationResult): boolean {
  return result.category.status === 'supported' && result.productType.status === 'supported';
}
