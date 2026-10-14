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
