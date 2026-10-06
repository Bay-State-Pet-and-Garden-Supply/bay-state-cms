/**
 * Preserved live-store content tags surfaced to classification as bounded
 * context evidence. Kept dependency-free so both the evidence extractor and
 * the targeting layer can share it without pulling each other's graphs
 * (evidence-targeting must stay loadable outside Bun).
 *
 * These tags never match a target (`attributeId` stays null): they are free
 * content blobs, not controlled values. Consumers treat them as context only.
 */
export const PRESERVED_CONTENT_TAGS = [
  'Specifications',
  'MaterialsOrIngredients',
  'HowToUse',
  'MerchantProductInstructions',
  'MoreInfoMetaDescription',
  'MoreInfoMetaKeywords',
  'OneLineAdvertisement',
  'MoreInfoTitle',
  'SizeAndFitGuide',
  'Warranty',
  'Returns',
  'ShippingDetails',
  'ItemSize',
] as const;

/** Per-snippet cap for preserved content evidence (cheap, bounded prompts). */
export const PRESERVED_CONTENT_SNIPPET_CAP = 1_200;

/** Pick the whitelisted non-empty preserved content fields for one product. */
export function buildPreservedContentFields(
  preservedUnknown: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of PRESERVED_CONTENT_TAGS) {
    const value = preservedUnknown[tag];
    if (typeof value === 'string' && value.trim().length > 0) {
      out[tag] = value;
    }
  }
  return out;
}
