/**
 * Classification ownership (ADR 0041, issue #349).
 *
 * The single shared ownership contract for the Classification Engine: Brand
 * and other Protected Product Data are never classifier-owned outputs, even
 * when existing targets, profiles, universal attributes, mappings, provider
 * outputs, or revised targets mention them. Supplied Brand stays readable as
 * input evidence; it is never an assignment, replacement, or removal output.
 *
 * Every enforcement point (proposal production, review/correction
 * validation, draft projection, final application) consumes this module so
 * the rule cannot drift between callers. No caller reimplements the Brand
 * check locally.
 */
import type { AttributeMappingConfig } from '../shared/schemas/classification';

/** The classifier-owned Brand attribute identity. */
export const BRAND_ATTRIBUTE_ID = 'brand';

/** Category and Product Type are represented only by the canonical pair, never ordinary attributes. */
export function isCanonicalClassificationAttributeId(attributeId: string | null | undefined): boolean {
  return attributeId === 'category' || attributeId === 'product-type';
}

/** Fallback Brand catalog slot when no usable `brand` mapping exists. */
export const FALLBACK_BRAND_CATALOG_FIELD = 'ProductField16';

/** Attributable refusal code when a protected target reaches review/application. */
export const PROTECTED_TARGET_REFUSAL_CODE = 'protected_target_refused';

/**
 * Resolve the catalog field carrying Brand identity from the active
 * attribute mappings. A stale mapping or an empty catalog field is treated
 * as absent so ownership falls closed to the documented fallback slot
 * instead of a field that no longer exists in the live store XML.
 */
export function resolveBrandCatalogField(mappings: AttributeMappingConfig[]): string {
  const mapping = mappings.find(m => m.attributeId === BRAND_ATTRIBUTE_ID);
  if (!mapping || mapping.isStale) return FALLBACK_BRAND_CATALOG_FIELD;
  const field = mapping.catalogField?.trim();
  return field ? field : FALLBACK_BRAND_CATALOG_FIELD;
}

/**
 * Positive classification-role check for a semantic target or catalog field.
 * Unknown target meanings and cross-role mappings are protected, not merely
 * Brand-named targets. Missing mappings are diagnosed by the projection owner.
 */
export function isProtectedTargetId(
  targetId: string | null | undefined,
  mappings?: AttributeMappingConfig[],
): boolean {
  if (!targetId) return false;
  if (!Object.prototype.hasOwnProperty.call(CLASSIFICATION_ATTRIBUTE_FIELDS, targetId)) {
    return !isClassifierOwnedCatalogField(targetId) || isProtectedCatalogField(targetId, null, mappings);
  }
  const mapping = mappings?.find(m => m.attributeId === targetId);
  return !!mapping && isProtectedCatalogField(mapping.catalogField, targetId, mappings);
}
/**
 * True when a category_page proposal addresses a Brand page: the display
 * name starts with the `Brand -` prefix (the classifier never owns Brand
 * placement — verified identity or not, Brand pages are outside owned
 * scope). Reads the effective display name; identity alone never qualifies.
 */
export function isBrandPageProposal(pageName: string | null | undefined): boolean {
  return !!pageName && pageName.trim().toLowerCase().startsWith('brand -');
}

/**
 * Attributable refusal for a protected write: returns the code + reason
 * instead of applying or silently rerouting. A revised target or historical
 * Brand proposal can never authorize a protected write.
 */
export function protectedTargetRefusal(targetId: string | null): { code: string; reason: string } {
  return {
    code: PROTECTED_TARGET_REFUSAL_CODE,
    reason: `Classification cannot assign, replace, or remove protected target "${targetId ?? 'null'}" (Brand / Protected Product Data are never classifier-owned outputs).`,
  };
}

/**
 * Approved classifier output roles (issue #357, positive enforcement).
 *
 * The single centralized allowlist of catalog slots the classifier may
 * write, keyed by the AUTHENTICATED live Extra Fields label (Extra Fields
 * settings screenshots 2026-10-15 — see
 * docs/audits/extra-fields-certification-2026-10-15.md). Unknown,
 * uncertified-unnamed, native, pricing, Brand, and reserved slots are absent
 * by construction: a slot not listed here is never a classifier output.
 *
 * PF23 is `Facet - Flavor`; PF28 is `Facet - Material` — the reviewed
 * Flavor→Material correction writes PF28, never PF23. PF16 (`Facet -
 * Brand`), PF6 (`MAP Pricing`), PF1–PF15 commerce/unnamed slots, native
 * fulfillment slots, and PF31 (`Product Category`)/PF32 (`Product Cross
 * Sell`) carry live/commerce purposes outside classification ownership and
 * are therefore absent.
 */
export const CLASSIFIER_OWNED_CATALOG_FIELDS: Record<string, string> = {
  ProductField17: 'Facet - Pet Type',
  ProductField18: 'Facet - Lifestage',
  ProductField19: 'Facet - Pet Size',
  ProductField20: 'Facet - Special Diet',
  ProductField21: 'Facet - Health Feature',
  ProductField22: 'Facet - Food Form',
  ProductField23: 'Facet - Flavor',
  ProductField24: 'Facet - Category',
  ProductField25: 'Facet - Product Type',
  ProductField26: 'Facet - Product Feature',
  ProductField27: 'Facet - Size',
  ProductField28: 'Facet - Material',
  ProductField29: 'Facet - Color',
  ProductField30: 'Facet - Packaging Type',
};

/** Approved ShopSite destinations for the two members of Product Classification. */
export const CANONICAL_CLASSIFICATION_CATALOG_FIELDS: Readonly<Record<'category' | 'product-type', string>> = {
  category: 'ProductField24',
  'product-type': 'ProductField25',
};

export type CanonicalClassificationOutputRole = keyof typeof CANONICAL_CLASSIFICATION_CATALOG_FIELDS;

/** True only for the certified destination assigned to this canonical pair role. */
export function isApprovedCanonicalClassificationBinding(
  role: string,
  catalogField: string | null | undefined,
  mappings?: Array<{ attributeId: string; catalogField?: string | null; isStale?: boolean }>,
): role is CanonicalClassificationOutputRole {
  if (!catalogField || !Object.prototype.hasOwnProperty.call(CANONICAL_CLASSIFICATION_CATALOG_FIELDS, role)) {
    return false;
  }
  return CANONICAL_CLASSIFICATION_CATALOG_FIELDS[role as CanonicalClassificationOutputRole] === catalogField
    && isClassifierOwnedCatalogField(catalogField)
    && !isProtectedCatalogField(catalogField, null, mappings);
}

/**
 * True when a catalog slot is an approved classifier output role (issue
 * #357): present in CLASSIFIER_OWNED_CATALOG_FIELDS with its authenticated
 * live label. Unknown, uncertified-unnamed, native, pricing, Brand, and
 * reserved slots fail closed (false). Uses exact slot identity, never a
 * numeric range.
 */
export function isClassifierOwnedCatalogField(catalogField: string | null | undefined): boolean {
  if (!catalogField) return false;
  return Object.prototype.hasOwnProperty.call(CLASSIFIER_OWNED_CATALOG_FIELDS, catalogField);
}

/**
 * Certified semantic bindings from the governed seed and authenticated field
 * records. Category and Product Type are written only as an atomic canonical
 * pair projection, never through ordinary field-assignment mappings.
 */
const CLASSIFICATION_ATTRIBUTE_FIELDS: Readonly<Record<string, string>> = {
  species: 'ProductField17',
  'life-stage': 'ProductField18',
  'breed-size': 'ProductField19',
  'dietary-features': 'ProductField20',
  'health-benefits': 'ProductField21',
  'food-form': 'ProductField22',
  flavor: 'ProductField23',
  'product-feature': 'ProductField26',
  size: 'ProductField27',
  material: 'ProductField28',
  color: 'ProductField29',
  'packaging-type': 'ProductField30',
};

/**
 * Native ShopSite slots the classifier must never write through a mapping
 * (issue #355, criterion 4). These are built-in output fields with dedicated
 * codec emitters (delivery-relevant defaults, identity, operational data) —
 * a mapping that points a semantic attribute at one would reroute business
 * classification into native fulfillment/identity data. `ProductField*`
 * slots are the only mapping-eligible targets (Brand slot included — it is
 * refused separately as protected, never eligible).
 *
 * Retained for provenance: isProtectedCatalogField below now derives from
 * the positive CLASSIFIER_OWNED_CATALOG_FIELDS table plus the Brand-slot
 * rule, and these lists document the previously enumerated denylist.
 */
export const NATIVE_CATALOG_SLOTS = [
  'ProductType',
  'MinimumQuantity',
  'GTIN',
  'GoogleGTIN',
  'Google_GTIN',
] as const;

/**
 * Live Extra Fields slots the classifier must never write because their
 * certified live purpose contradicts classification output (issue #355,
 * authenticated Extra Fields screenshots 2026-10-15 — see
 * docs/audits/extra-fields-certification-2026-10-15.md).
 *
 * - `ProductField13` is `Upsell - Lightbox`: a category identifier written
 *   there would corrupt merchandising upsell data.
 * - `ProductField14` has no configured display name (uncertified-unnamed):
 *   writing a breadcrumb projection into an unnamed slot is unverified
 *   output.
 * - `ProductField8` is `Custom Tab #1`: the stale workspace
 *   `nutrition → ProductField8` mapping (retired in v9 as not_exported)
 *   would route ingredient HTML into a display tab. Refused until a
 *   governed release re-certifies the binding.
 * - `ProductField1` has no configured display name (uncertified-unnamed):
 *   the promoter's arrival-date fallback would stamp new-date markers into
 *   an unnamed slot. Refused as a classification write; the owning module
 *   (`src/onboarding/draft-promoter.ts`) must resolve an `arrival_date`
 *   mapping or skip the stamp.
 * - `ProductField2`, `ProductField3`, `ProductField4` have no configured
 *   display name either (uncertified-unnamed — same screenshot, empty
 *   inputs). No mapping, target, or literal exists in any authority today,
 *   but absence is not enforcement: a future mapping could target them, so
 *   they are refused alongside the other unnamed slots.
 * - `ProductField5` (`Banner - Overlay Text`), `ProductField6` (`MAP
 *   Pricing`), `ProductField7` (`Child - Short Name`), `ProductField9`
 *   (`Custom Tab #2`), `ProductField10` (`Custom Tab #3`), `ProductField11`
 *   (`Special Order`), `ProductField12` (`Temporarily out of Stock`),
 *   `ProductField15` (`In Store Pick-up`) carry certified listing/commerce
 *   purposes outside classification ownership and are refused by the same
 *   positive rule (absent from CLASSIFIER_OWNED_CATALOG_FIELDS).
 * - `ProductField31` (`Product Category`) stays occupied-live-only and
 *   `ProductField32` (`Product Cross Sell`) is UPC-list commerce data:
 *   both absent from the approved table and refused.
 *
 * Like the Brand slot, these refuse at edit time (field-mapping-editor) and
 * apply time (catalog application + promoter) — never silently rerouted.
 *
 * Retained for provenance: enforcement now derives from the positive table
 * above (a slot not listed there is refused), so these constants document
 * rather than implement the refusal.
 */
export const MISROUTED_CATALOG_SLOTS = [
  'ProductField13',
  'ProductField14',
  'ProductField8',
  'ProductField1',
  'ProductField2',
  'ProductField3',
  'ProductField4',
] as const;

/**
 * True when a RESOLVED catalog field is off-limits for classification output
 * (issue #357, positive enforcement): the field is absent from
 * CLASSIFIER_OWNED_CATALOG_FIELDS — Brand identity (PF16), MAP Pricing
 * (PF6), all PF1–15 commerce/unnamed slots, native built-in slots, PF31/32
 * reserved slots, and unknown/unverified slots all fail closed. The Brand
 * attribute identity (`brand`) never reaches output; a mapping entry for it
 * routes Brand identity into PF16, so mapping `brand` to any slot stays
 * refused. The active `arrival_date` mapping (PF7 in fixture/test
 * authorities) is a PROMOTION-owned listing stamp resolved by its owning
 * module (`src/onboarding/draft-promoter.ts`), never a classifier-reviewed
 * proposal output — it is refused here so semantic field proposals cannot
 * reroute through it.
 *
 * Call signature is unchanged for parallel consumers (OutputConsumers).
 */
export function isProtectedCatalogField(
  catalogField: string | null | undefined,
  attributeId?: string | null,
  mappings?: Array<{ attributeId: string; catalogField?: string | null; isStale?: boolean }>,
): boolean {
  if (!catalogField) return true;
  const resolvedField = catalogField.trim();
  if (!isClassifierOwnedCatalogField(resolvedField)) return true;
  if (attributeId != null && (
    !Object.prototype.hasOwnProperty.call(CLASSIFICATION_ATTRIBUTE_FIELDS, attributeId)
    || CLASSIFICATION_ATTRIBUTE_FIELDS[attributeId] !== resolvedField
  )) return true;
  // Brand slot from the supplied mappings (v1 or v2 shape — structural read);
  // stale/empty falls closed to the documented fallback, mirroring
  // resolveBrandCatalogField without its v1-only type. A semantic attribute
  // resolved into the Brand slot refuses even when the slot itself is
  // otherwise well-formed.
  const brandMapping = mappings?.find(m => m.attributeId === BRAND_ATTRIBUTE_ID);
  const brandField = brandMapping && !brandMapping.isStale && brandMapping.catalogField?.trim()
    ? brandMapping.catalogField.trim()
    : FALLBACK_BRAND_CATALOG_FIELD;
  if (resolvedField === brandField) return true;
  return false;
}
