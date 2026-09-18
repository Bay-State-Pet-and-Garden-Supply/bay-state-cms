import type { ExtractionData } from '../shared/schemas/onboarding';
import type { NormalizedVariantCandidate } from '../shared/schemas/variant-resolution';

/**
 * Apply authoritative variant fields onto a base extraction result.
 * Only variant-specific fields are overwritten; product-level fields remain when variant lacks value.
 */
export interface MaterializeOptions {
  base: ExtractionData;
  selected: NormalizedVariantCandidate;
  receipt: { variantKey?: string; selectedVariantKey?: string; identityMatrixHash: string; parserVersion: number };
}

/**
 * Declared variant provenance for one selected candidate: per-option and
 * per-identifier endpoint source paths plus the variant key. Identifiers
 * stay in variantProvenance with their own source paths — never sibling
 * values. Shared by the legacy materializer and T4 Shopify policy
 * execution so the two paths cannot drift on provenance shape.
 */
// fallow-ignore-next-line unused-export — worker policy execution + tests
export function buildVariantProvenance(
  selected: NormalizedVariantCandidate,
  existing: Record<string, string> = {},
): Record<string, string> {
  const variantProvenance: Record<string, string> = { ...existing };
  for (const opt of selected.options) {
    variantProvenance[`variantAttributes.${opt.normalizedAxis}`] = opt.sourcePath;
  }
  for (const ident of selected.identifiers) {
    variantProvenance[`identifiers.${ident.kind}:${ident.normalizedValue}`] = ident.sourcePath;
  }
  variantProvenance.variantKey = selected.sourcePaths
    ? Object.values(selected.sourcePaths)[0]
    : 'variant-selected';
  return variantProvenance;
}

export function materializeSelectedVariant(options: MaterializeOptions): ExtractionData {
  const { base, selected, receipt } = options;
  const variantKey = receipt.selectedVariantKey ?? receipt.variantKey ?? selected.variantKey;
  const out: ExtractionData = { ...base, additionalImages: [...base.additionalImages] };
  // Preserve original selectedVariant provenance before overlay
  const existingSelected = (base as any).selectedVariant;
  // Variant-authoritative fields — only chosen candidate's values
  // Retain product identity when variant title is option-only label (e.g., "Small" or "Small Breed"): detect from candidate options, not length heuristic
  if (selected.title) {
    const baseTitle = (base.title ?? '').trim();
    const variantTitle = selected.title.trim();
    const normTitle = variantTitle.toLowerCase();
    const optionNorms = selected.options.map((o) => o.normalizedValue.toLowerCase());
    const optionSet = new Set(optionNorms);
    const optionTokens = new Set(optionNorms.flatMap((v) => v.split(/\s+/).filter(Boolean)));
    const titleTokens = normTitle.split(/[\s\/\-,]+/).filter(Boolean);
    const isOptionOnly =
      optionSet.has(normTitle) ||
      (titleTokens.length > 0 && titleTokens.every((t) => optionTokens.has(t)));
    if (baseTitle && isOptionOnly) {
      // Preserve product identity for option-only labels; append only if missing
      if (!baseTitle.toLowerCase().includes(normTitle)) {
        out.title = `${baseTitle} - ${variantTitle}`;
      } else {
        out.title = baseTitle;
      }
    } else {
      out.title = variantTitle;
    }
    out.fieldProvenance = { ...out.fieldProvenance, title: 'variant-selected' };
  }
  if (selected.price) {
    out.price = selected.price;
    out.fieldProvenance = { ...out.fieldProvenance, price: 'variant-selected' };
  }
  // primary image: variant primary only — never sibling/pallet; base gallery that could contain sibling images is not retained (only selected candidate gallery) to avoid cross-variant contamination; product-level images are carried via selected candidate's gallery when the matrix marks them product-level
  const primary = selected.images.find((i) => i.role === 'primary');
  if (primary) {
    out.primaryImage = primary.url;
    out.fieldProvenance = { ...out.fieldProvenance, primaryImage: 'variant-selected' };
    const gallery = selected.images.filter((i) => i.role === 'gallery').map((i) => i.url);
    out.additionalImages = [...gallery].slice(0, 16);
  }
  // weight/dimensions/currency — authoritative when present, otherwise leave base unchanged
  if (selected.weight) (out as any).weight = selected.weight;
  if (selected.dimensions) (out as any).dimensions = selected.dimensions;
  if (selected.currency) (out as any).currency = selected.currency;
  // identifiers: carry chosen candidate identifiers in provenance; do not copy sibling values
  const variantProvenance = buildVariantProvenance(selected, (out as any).variantProvenance ?? {});
  (out as any).variantProvenance = variantProvenance;
  // Identifiers are NOT attached under selectedVariant (VariantSelectionReceiptSchema lacks identifiers) — they remain in variantProvenance only, which declares them; selectedVariant carries only the receipt fields
  (out as any).selectedVariant = {
    ...(existingSelected ?? {}),
    variantKey,
    selectedVariantKey: variantKey,
    identityMatrixHash: receipt.identityMatrixHash,
    parserVersion: receipt.parserVersion,
    deepLink: selected.deepLink,
    matchedBy: 'variant-selected',
  };
  (out as any).variantAttributes = Object.fromEntries(selected.options.map((o) => [o.normalizedAxis, o.value]));
  return out;
}
