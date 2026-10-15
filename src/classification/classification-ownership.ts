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
 * True when a proposal target identity is classifier-protected: the Brand
 * attribute itself, or any catalog field that carries Brand identity (the
 * mapped Brand slot or its fallback). Both directions are covered — a
 * mapped catalog-field target and a bare attribute target.
 */
export function isProtectedTargetId(
  targetId: string | null | undefined,
  mappings?: AttributeMappingConfig[],
): boolean {
  if (!targetId) return false;
  if (targetId === BRAND_ATTRIBUTE_ID) return true;
  const brandField = mappings ? resolveBrandCatalogField(mappings) : FALLBACK_BRAND_CATALOG_FIELD;
  if (targetId === brandField) return true;
  const mapped = mappings?.find(m => m.attributeId === BRAND_ATTRIBUTE_ID);
  if (mapped && !mapped.isStale && mapped.catalogField && targetId === mapped.catalogField) return true;
  return targetId.toLowerCase().includes('brand');
}
/**
 * True when a category_page proposal addresses a Brand page: the display
 * name starts with the `Brand -` prefix (the classifier never owns Brand
 * placement — verified identity or not, Brand pages are outside owned
 * scope). Reads the effective display name; identity alone never qualifies.
 */
export function isBrandPageProposal(pageName: string | null | undefined): boolean {
  return !!pageName && pageName.toLowerCase().startsWith('brand -');
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
 * Native ShopSite slots the classifier must never write through a mapping
 * (issue #355, criterion 4). These are built-in output fields with dedicated
 * codec emitters (delivery-relevant defaults, identity, operational data) —
 * a mapping that points a semantic attribute at one would reroute business
 * classification into native fulfillment/identity data. `ProductField*`
 * slots are the only mapping-eligible targets (Brand slot included — it is
 * refused separately as protected, never eligible).
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
 *   there would corrupt merchandising upsell data. The v10
 *   `canonical-category-id → ProductField13` mapping is therefore refused.
 * - `ProductField14` has no configured display name (uncertified-unnamed):
 *   writing a breadcrumb projection into an unnamed slot is unverified
 *   output. The v10 `canonical-breadcrumb → ProductField14` mapping is
 *   therefore refused.
 * - `ProductField8` is `Custom Tab #1`: the stale workspace
 *   `nutrition → ProductField8` mapping (retired in v9/v10 as not_exported)
 *   would route ingredient HTML into a display tab. Refused until a
 *   governed release re-certifies the binding.
 * - `ProductField1` has no configured display name (uncertified-unnamed):
 *   the promoter's arrival-date fallback would stamp new-date markers into
 *   an unnamed slot. Refused as a classification write; the owning module
 *   (`src/onboarding/draft-promoter.ts`) must resolve an `arrival_date`
 *   mapping or skip the stamp.
 *
 * Like the Brand slot, these refuse at edit time (field-mapping-editor) and
 * apply time (catalog application + promoter) — never silently rerouted.
 */
export const MISROUTED_CATALOG_SLOTS = [
  'ProductField13',
  'ProductField14',
  'ProductField8',
  'ProductField1',
] as const;

/**
 * True when a RESOLVED catalog field is off-limits for classification output
 * (issue #355): the Brand identity slot (unless the attribute itself is the
 * Brand attribute, which never reaches output anyway) or a native
 * built-in slot. Guards the mapping layer against rerouting a semantic
 * target into Brand/identity/operational/fulfillment data.
 */
export function isProtectedCatalogField(
  catalogField: string | null | undefined,
  attributeId?: string | null,
  mappings?: Array<{ attributeId: string; catalogField?: string | null; isStale?: boolean }>,
): boolean {
  if (!catalogField) return false;
  if ((NATIVE_CATALOG_SLOTS as readonly string[]).includes(catalogField)) return true;
  if ((MISROUTED_CATALOG_SLOTS as readonly string[]).includes(catalogField)) return true;
  if (attributeId === BRAND_ATTRIBUTE_ID) return false;
  // Brand slot from the supplied mappings (v1 or v2 shape — structural read);
  // stale/empty falls closed to the documented fallback, mirroring
  // resolveBrandCatalogField without its v1-only type.
  const brandMapping = mappings?.find(m => m.attributeId === BRAND_ATTRIBUTE_ID);
  const brandField = brandMapping && !brandMapping.isStale && brandMapping.catalogField?.trim()
    ? brandMapping.catalogField.trim()
    : FALLBACK_BRAND_CATALOG_FIELD;
  return catalogField === brandField;
}
