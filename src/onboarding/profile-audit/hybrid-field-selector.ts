/**
 * Hybrid Field Selector (Harness-Side Audit Arm)
 *
 * Implements the Configuration 4 hybrid measurement arm (Spec #173, #176):
 * 1. Resolves product and variant identity first using deterministic variant machinery.
 * 2. Extracts fields from custom selectors and structured sources independently.
 * 3. Compares values and surfaces conflicts with provenance instead of first-nonempty-wins.
 * 4. Applies strict image filtering with variant membership context.
 */

import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';
import type {
  VariantMatrix,
  VariantMatchDecision,
  NormalizedVariantCandidate,
} from '../../shared/schemas/variant-resolution';
import { parseVariantMatrix, matchVariantMatrix } from '../variant-resolver';
import { applyStrictImageFilter } from './strict-image-filter';

export interface RawExtractionLayers {
  custom: Record<string, string | string[]> | null;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  htmlHeuristics: Record<string, string | string[]>;
  images: string[];
}

export interface HybridConflict {
  field: string;
  selectorValue: string | null;
  structuredValue: string | null;
  resolution: string;
}

export interface HybridSelectionInput {
  raw: RawExtractionLayers;
  url: string;
  html: string;
  expected?: {
    name?: string;
    brandHint?: string | null;
    price?: string | null;
    gtin?: string | null;
    sku?: string | null;
  };
  variantMatrix?: VariantMatrix | null;
  variantDecision?: VariantMatchDecision | null;
}

export interface HybridSelectionResult {
  data: ExtractionData;
  conflicts: HybridConflict[];
  variantDecision: VariantMatchDecision | null;
  selectedCandidate: NormalizedVariantCandidate | null;
  fieldProvenance: Record<string, string>;
  admittedImages: string[];
  rejectedImages: string[];
  primaryImage: string | null;
}

function normalizeCompare(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function selectHybridFields(input: HybridSelectionInput): HybridSelectionResult {
  const { raw, url, html, expected } = input;
  const conflicts: HybridConflict[] = [];
  const fieldProvenance: Record<string, string> = {};

  // Step 1: Resolve identity first
  let matrix = input.variantMatrix;
  if (matrix === undefined) {
    matrix = parseVariantMatrix(html, url);
  }

  let decision: VariantMatchDecision | null = input.variantDecision ?? null;
  let selectedCandidate: NormalizedVariantCandidate | null = null;

  if (matrix && matrix.candidates && matrix.candidates.length > 0) {
    if (!matrix.warnings) {
      matrix.warnings = [];
    }
    if (!decision && expected) {
      decision = matchVariantMatrix(matrix, {
        name: expected.name ?? '',
        brandHint: expected.brandHint ?? null,
        gtin: expected.gtin ?? null,
        sku: expected.sku ?? null,
        mpn: null,
      });
    }

    if (decision?.selectedVariantKey) {
      selectedCandidate =
        matrix.candidates.find(c => c.variantKey === decision!.selectedVariantKey) ?? null;
    } else if (matrix.candidates.length === 1) {
      selectedCandidate = matrix.candidates[0];
    }
  }

  // Helper to extract structured string for a given field
  function getStructuredField(field: 'title' | 'brand' | 'description' | 'price' | 'sku' | 'gtin'): {
    value: string | null;
    source: string;
  } {
    // If selected variant has specific SKU / price / GTIN, that is top priority structured signal
    if (selectedCandidate) {
      const skuId =
        selectedCandidate.identifiers?.find(i => i.kind === 'sku')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).sku ??
        selectedCandidate.identifiers?.find(i => i.kind === 'sku')?.normalizedValue;
      if (field === 'sku' && skuId) {
        return { value: String(skuId), source: 'variant-candidate' };
      }
      if (field === 'price' && selectedCandidate.price) {
        return { value: selectedCandidate.price, source: 'variant-candidate' };
      }
      const gtinId =
        selectedCandidate.identifiers?.find(i => i.kind === 'gtin')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).barcode ??
        selectedCandidate.identifiers?.find(i => i.kind === 'gtin')?.normalizedValue;
      if (field === 'gtin' && gtinId) {
        return { value: String(gtinId), source: 'variant-candidate' };
      }
    }

    if (field === 'title') {
      const jTitle = raw.jsonLd?.name as string | undefined;
      if (jTitle?.trim()) return { value: jTitle.trim(), source: 'json-ld' };
      if (raw.microdata?.name?.trim()) return { value: raw.microdata.name.trim(), source: 'microdata' };
      if (raw.metaTags?.['og:title']?.trim()) return { value: raw.metaTags['og:title'].trim(), source: 'meta' };
      if (typeof raw.htmlHeuristics?.title === 'string' && raw.htmlHeuristics.title.trim()) {
        return { value: raw.htmlHeuristics.title.trim(), source: 'html' };
      }
    }

    if (field === 'brand') {
      const jBrand = raw.jsonLd?.brand;
      const jBrandStr =
        typeof jBrand === 'string'
          ? jBrand
          : typeof jBrand === 'object' && jBrand !== null && 'name' in jBrand
            ? (jBrand as { name: string }).name
            : null;
      if (jBrandStr?.trim()) return { value: jBrandStr.trim(), source: 'json-ld' };
      if (raw.microdata?.brand?.trim()) return { value: raw.microdata.brand.trim(), source: 'microdata' };
      if (raw.metaTags?.['product:brand']?.trim()) return { value: raw.metaTags['product:brand'].trim(), source: 'meta' };
      if (typeof raw.htmlHeuristics?.brand === 'string' && raw.htmlHeuristics.brand.trim()) {
        return { value: raw.htmlHeuristics.brand.trim(), source: 'html' };
      }
    }

    if (field === 'description') {
      const jDesc = raw.jsonLd?.description as string | undefined;
      if (jDesc?.trim()) return { value: jDesc.trim(), source: 'json-ld' };
      if (raw.microdata?.description?.trim()) return { value: raw.microdata.description.trim(), source: 'microdata' };
      if (raw.metaTags?.['og:description']?.trim()) return { value: raw.metaTags['og:description'].trim(), source: 'meta' };
      if (raw.metaTags?.description?.trim()) return { value: raw.metaTags.description.trim(), source: 'meta' };
      if (typeof raw.htmlHeuristics?.description === 'string' && raw.htmlHeuristics.description.trim()) {
        return { value: raw.htmlHeuristics.description.trim(), source: 'html' };
      }
    }

    if (field === 'price') {
      const jOffers = raw.jsonLd?.offers as Record<string, unknown> | undefined;
      const jPrice = jOffers?.price ?? jOffers?.lowPrice;
      if (jPrice !== undefined && String(jPrice).trim()) {
        return { value: String(jPrice).trim(), source: 'json-ld' };
      }
      if (raw.microdata?.price?.trim()) return { value: raw.microdata.price.trim(), source: 'microdata' };
      if (raw.metaTags?.['product:price:amount']?.trim()) return { value: raw.metaTags['product:price:amount'].trim(), source: 'meta' };
    }

    if (field === 'sku') {
      const jSku = raw.jsonLd?.sku as string | undefined;
      if (jSku?.trim()) return { value: jSku.trim(), source: 'json-ld' };
      if (raw.microdata?.sku?.trim()) return { value: raw.microdata.sku.trim(), source: 'microdata' };
      if (raw.metaTags?.['product:retailer_item_id']?.trim()) return { value: raw.metaTags['product:retailer_item_id'].trim(), source: 'meta' };
    }

    if (field === 'gtin') {
      const gtin = raw.jsonLd?.gtin13 || raw.jsonLd?.gtin12 || raw.jsonLd?.gtin8 || raw.jsonLd?.gtin;
      if (typeof gtin === 'string' && gtin.trim()) return { value: gtin.trim(), source: 'json-ld' };
      const mGtin = raw.microdata?.gtin13 || raw.microdata?.gtin12 || raw.microdata?.gtin;
      if (typeof mGtin === 'string' && mGtin.trim()) return { value: mGtin.trim(), source: 'microdata' };
    }

    return { value: null, source: 'none' };
  }

  // Step 2 & 3: Merge fields and surface conflicts
  function resolveField(field: 'title' | 'brand' | 'description' | 'price' | 'sku' | 'gtin'): string | null {
    const rawCustomVal = raw.custom?.[field];
    const selectorVal =
      typeof rawCustomVal === 'string' && rawCustomVal.trim()
        ? rawCustomVal.trim()
        : null;

    const structured = getStructuredField(field);
    const structuredVal = structured.value;

    if (selectorVal && structuredVal) {
      const normSel = normalizeCompare(selectorVal);
      const normStr = normalizeCompare(structuredVal);

      // Conflict if they diverge beyond normalization
      if (normSel !== normStr && !normSel.includes(normStr) && !normStr.includes(normSel)) {
        conflicts.push({
          field,
          selectorValue: selectorVal,
          structuredValue: structuredVal,
          resolution: 'selector_preferred_with_conflict',
        });
      }
      fieldProvenance[field] = 'custom-selector';
      return selectorVal;
    }

    if (selectorVal) {
      fieldProvenance[field] = 'custom-selector';
      return selectorVal;
    }

    if (structuredVal) {
      fieldProvenance[field] = structured.source;
      return structuredVal;
    }

    return null;
  }

  const title = resolveField('title');
  const brand = resolveField('brand');
  const description = resolveField('description');
  const price = resolveField('price');
  const sku = resolveField('sku');
  const gtin = resolveField('gtin');

  // Step 4: Strict image filtering
  const rawCustomImages = (raw.custom?.images as string[]) || [];
  const rawGalleryImages = raw.images || [];
  const combinedRawImages = [...rawCustomImages, ...rawGalleryImages];

  // Also include variant candidate images
  if (selectedCandidate?.images) {
    for (const img of selectedCandidate.images) {
      const u = typeof img === 'string' ? img : img.url;
      if (u) combinedRawImages.unshift(u);
    }
  }

  const imageFilterResult = applyStrictImageFilter({
    images: combinedRawImages,
    baseUrl: url,
    variantMatrix: matrix,
    selectedVariantKey: decision?.selectedVariantKey ?? selectedCandidate?.variantKey ?? null,
  });

  const additionalImages = imageFilterResult.admittedImages.filter(
    u => u !== imageFilterResult.primaryImage,
  );

  const data: ExtractionData = ExtractionDataSchema.parse({
    title,
    brand,
    description,
    price,
    primaryImage: imageFilterResult.primaryImage,
    additionalImages,
    bulletPoints: Array.isArray(raw.htmlHeuristics?.bulletPoints)
      ? (raw.htmlHeuristics.bulletPoints as string[])
      : [],
    weight: typeof raw.jsonLd?.weight === 'string' ? raw.jsonLd.weight : null,
    seoFileName: null,
    searchKeywords: [title, brand, description].filter(Boolean).join(' ').slice(0, 200) || null,
    confidence: 1.0,
    fieldProvenance,
  });

  (data as Record<string, unknown>).sku = sku;
  (data as Record<string, unknown>).gtin = gtin;

  return {
    data,
    conflicts,
    variantDecision: decision,
    selectedCandidate,
    fieldProvenance,
    admittedImages: imageFilterResult.admittedImages,
    rejectedImages: imageFilterResult.rejectedImages,
    primaryImage: imageFilterResult.primaryImage,
  };
}
