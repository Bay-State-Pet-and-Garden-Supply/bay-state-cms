/**
 * Hybrid Field Selector (Harness-Side Audit Arm)
 *
 * Implements the Configuration 4 hybrid measurement arm (Spec #173, #176):
 * 1. Resolves product and variant identity first using deterministic variant machinery.
 *    Surfaces parent-page versus variant confusion explicitly in output.
 * 2. Extracts fields from custom selectors and structured sources independently.
 * 3. Compares values and surfaces conflicts with provenance instead of first-nonempty-wins,
 *    guaranteeing JSON-LD versus selector disagreements are never silently resolved.
 * 4. Applies strict image filtering after EVERY source contributes (variant, custom,
 *    JSON-LD, microdata, meta, gallery), flagging primary and recording admitted and rejected sets.
 * 5. Production merge order and additive enrichment contract stay untouched.
 * 6. Image-rights verification stays untouched and out of this arm.
 */

import { type ExtractionData, ExtractionDataSchema } from '../../shared/schemas/onboarding';
import type {
  VariantMatrix,
  VariantMatchDecision,
  NormalizedVariantCandidate,
} from '../../shared/schemas/variant-resolution';
import type {
  HybridConflict,
  HybridIdentityResolution,
} from '../../shared/schemas/profile-audit';
import { parseVariantMatrix, matchVariantMatrix } from '../variant-resolver';
import { canonicalGtinMatch } from '../../shared/gtin';
import { applyStrictImageFilter, type StrictImageCandidate } from './strict-image-filter';

export interface RawExtractionLayers {
  custom: Record<string, string | string[]> | null;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  htmlHeuristics: Record<string, string | string[]>;
  images: string[];
}

export type { HybridConflict, HybridIdentityResolution };

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
  identityResolution: HybridIdentityResolution;
  fieldProvenance: Record<string, string>;
  admittedImages: string[];
  rejectedImages: string[];
  primaryImage: string | null;
  imageRejectionReasons: Record<string, string>;
}

function normalizeCompare(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePrice(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[^\d.]/g, '').trim();
}

function cleanGtin(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\D/g, '').trim();
}

function stripHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

export function selectHybridFields(input: HybridSelectionInput): HybridSelectionResult {
  const { raw, url, html, expected } = input;
  const conflicts: HybridConflict[] = [];
  const fieldProvenance: Record<string, string> = {};

  // ── Step 1: Resolve identity first with deterministic variant machinery ───
  let matrix = input.variantMatrix;
  if (matrix === undefined) {
    matrix = parseVariantMatrix(html, url);
  }

  // Derive raw parent title from page heuristics/metadata
  const rawParentTitle =
    (typeof raw.custom?.title === 'string' && raw.custom.title.trim() ? raw.custom.title.trim() : null) ??
    (typeof raw.jsonLd?.name === 'string' && raw.jsonLd.name.trim() ? raw.jsonLd.name.trim() : null) ??
    (typeof raw.metaTags?.['og:title'] === 'string' && raw.metaTags['og:title'].trim() ? raw.metaTags['og:title'].trim() : null) ??
    (typeof raw.htmlHeuristics?.title === 'string' && raw.htmlHeuristics.title.trim() ? raw.htmlHeuristics.title.trim() : null);

  let decision: VariantMatchDecision | null = input.variantDecision ?? null;
  let selectedCandidate: NormalizedVariantCandidate | null = null;

  if (matrix && matrix.candidates && matrix.candidates.length > 0) {
    if (!matrix.warnings) {
      matrix.warnings = [];
    }
    for (const c of matrix.candidates) {
      if (!c.options) c.options = [];
      if (!c.identifiers) c.identifiers = [];
    }
    if (!decision && expected) {
      decision = matchVariantMatrix(matrix, {
        name: expected.name ?? rawParentTitle ?? '',
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

  // ── Step 1b: Parent-page versus variant confusion detection ───────────────
  let confusionDetected = false;
  let confusionType: 'parent_vs_variant' | 'ambiguous_variant' | 'wrong_variant_selected' | 'unresolved_parent' | null = null;
  let confusionDetails: string | null = null;

  const totalCandidates = matrix?.candidates?.length ?? 0;
  const isMultiVariant = totalCandidates > 1;

  if (isMultiVariant) {
    if (!selectedCandidate) {
      // Multi-variant page, but no variant could be resolved
      confusionDetected = true;
      confusionType = decision?.status === 'ambiguous' ? 'ambiguous_variant' : 'unresolved_parent';
      confusionDetails = `Multi-variant parent page has ${totalCandidates} variant candidates, but no variant could be resolved (decision status: ${decision?.status ?? 'unmatched'}).`;
    } else {
      // Candidate was resolved, check for parent-page vs variant divergence
      const candidateTitle = selectedCandidate.title?.trim();
      const normCand = normalizeCompare(candidateTitle);
      const normParent = normalizeCompare(rawParentTitle);

      const selCustomTitle = typeof raw.custom?.title === 'string' ? raw.custom.title.trim() : null;
      const normSelTitle = normalizeCompare(selCustomTitle);

      // Check if selector extracted generic parent title while resolved variant has specific variant title
      if (selCustomTitle && candidateTitle && normSelTitle !== normCand && normCand.includes(normSelTitle) && normCand.length > normSelTitle.length) {
        confusionDetected = true;
        confusionType = 'parent_vs_variant';
        confusionDetails = `Selector extracted parent-page title "${selCustomTitle}", but resolved variant has specific identity "${candidateTitle}".`;
      } else if (rawParentTitle && candidateTitle && normParent !== normCand && !normParent.includes(normCand) && !normCand.includes(normParent)) {
        confusionDetected = true;
        confusionType = 'parent_vs_variant';
        confusionDetails = `Page parent title "${rawParentTitle}" diverges from selected variant title "${candidateTitle}".`;
      }

      // Check if selector extracted a container/parent SKU different from variant SKU
      const candidateSku =
        selectedCandidate.identifiers?.find(i => i.kind === 'sku')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).sku;
      const selCustomSku = typeof raw.custom?.sku === 'string' ? raw.custom.sku.trim() : null;
      if (selCustomSku && candidateSku && normalizeCompare(selCustomSku) !== normalizeCompare(candidateSku)) {
        confusionDetected = true;
        confusionType = 'parent_vs_variant';
        confusionDetails = `Selector extracted parent SKU "${selCustomSku}", which contradicts resolved variant SKU "${candidateSku}".`;
      }

      // Check if selector extracted a container/parent GTIN different from variant GTIN
      const candidateGtin =
        selectedCandidate.identifiers?.find(i => i.kind === 'gtin')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).barcode;
      const selCustomGtin = typeof raw.custom?.gtin === 'string' ? raw.custom.gtin.trim() : null;
      if (selCustomGtin && candidateGtin && !canonicalGtinMatch(selCustomGtin, candidateGtin)) {
        confusionDetected = true;
        confusionType = 'parent_vs_variant';
        confusionDetails = `Selector extracted parent GTIN "${selCustomGtin}", which contradicts resolved variant GTIN "${candidateGtin}".`;
      }
    }
  } else if (expected?.name && matrix && totalCandidates > 0 && !selectedCandidate) {
    confusionDetected = true;
    confusionType = 'parent_vs_variant';
    confusionDetails = `Expected variant "${expected.name}" could not be matched among page candidates.`;
  }

  const identityResolution: HybridIdentityResolution = {
    status: selectedCandidate
      ? (isMultiVariant ? 'resolved_variant' : 'single_variant')
      : (isMultiVariant
        ? (decision?.status === 'ambiguous' ? 'ambiguous_variant' : 'parent_page')
        : (matrix ? 'single_variant' : 'no_matrix')),
    parentPageUrl: url,
    totalCandidates,
    selectedVariantKey: selectedCandidate?.variantKey ?? null,
    selectedCandidateTitle: selectedCandidate?.title ?? null,
    parentTitle: rawParentTitle ?? null,
    matchedBy: decision?.matchedBy ?? (totalCandidates === 1 ? 'single_variant' : null),
    confusionDetected,
    confusionType,
    confusionDetails,
  };

  // ── Step 2: Structured field extraction helper ────────────────────────────
  function getStructuredField(field: 'title' | 'brand' | 'description' | 'price' | 'sku' | 'gtin'): {
    value: string | null;
    source: string;
  } {
    // If selected variant has specific SKU / price / GTIN / title, that is top priority structured signal
    if (selectedCandidate) {
      if (field === 'title' && selectedCandidate.title?.trim()) {
        return { value: selectedCandidate.title.trim(), source: 'variant-candidate' };
      }
      const skuId =
        selectedCandidate.identifiers?.find(i => i.kind === 'sku')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).sku ??
        selectedCandidate.identifiers?.find(i => i.kind === 'sku')?.normalizedValue;
      if (field === 'sku' && skuId) {
        return { value: String(skuId).trim(), source: 'variant-candidate' };
      }
      if (field === 'price' && selectedCandidate.price) {
        return { value: String(selectedCandidate.price).trim(), source: 'variant-candidate' };
      }
      const gtinId =
        selectedCandidate.identifiers?.find(i => i.kind === 'gtin')?.value ??
        (selectedCandidate as unknown as Record<string, unknown>).barcode ??
        selectedCandidate.identifiers?.find(i => i.kind === 'gtin')?.normalizedValue;
      if (field === 'gtin' && gtinId) {
        return { value: String(gtinId).trim(), source: 'variant-candidate' };
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

  // ── Step 3: Compare values deterministically and surface disagreements ───
  function resolveField(field: 'title' | 'brand' | 'description' | 'price' | 'sku' | 'gtin'): string | null {
    const rawCustomVal = raw.custom?.[field];
    const selectorVal =
      typeof rawCustomVal === 'string' && rawCustomVal.trim()
        ? rawCustomVal.trim()
        : null;

    const structured = getStructuredField(field);
    const structuredVal = structured.value;

    if (selectorVal && structuredVal) {
      let isDisagreement: boolean;

      if (field === 'price') {
        const selP = normalizePrice(selectorVal);
        const strP = normalizePrice(structuredVal);
        isDisagreement = Boolean(selP && strP && selP !== strP);
      } else if (field === 'gtin') {
        const selG = cleanGtin(selectorVal);
        const strG = cleanGtin(structuredVal);
        isDisagreement = Boolean(selG && strG && !canonicalGtinMatch(selG, strG));
      } else if (field === 'description') {
        const selD = normalizeCompare(stripHtml(selectorVal));
        const strD = normalizeCompare(stripHtml(structuredVal));
        // Descriptions differ if neither contains the other or lengths diverge heavily
        isDisagreement = selD !== strD && !selD.includes(strD) && !strD.includes(selD);
      } else {
        const normSel = normalizeCompare(selectorVal);
        const normStr = normalizeCompare(structuredVal);
        isDisagreement = normSel !== normStr;
      }

      if (isDisagreement) {
        conflicts.push({
          field,
          selectorValue: selectorVal,
          structuredValue: structuredVal,
          structuredSource: structured.source,
          selectorSource: 'custom-selector',
          resolution: 'selector_preferred_with_conflict',
          severity: (field === 'title' || field === 'price' || field === 'sku' || field === 'gtin') ? 'critical' : 'warning',
          disagreementReason: `Selector value "${selectorVal}" disagrees with ${structured.source} value "${structuredVal}"`,
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

    fieldProvenance[field] = 'none';
    return null;
  }

  const title = resolveField('title');
  const brand = resolveField('brand');
  const description = resolveField('description');
  const price = resolveField('price');
  const sku = resolveField('sku');
  const gtin = resolveField('gtin');

  // ── Step 4: Strict image filtering after EVERY source contributes ──────────
  const rawContributedImages: StrictImageCandidate[] = [];

  // 1. Variant candidate images (priority 1 for primary image if variant candidate exists)
  if (selectedCandidate?.images) {
    for (let i = 0; i < selectedCandidate.images.length; i++) {
      const img = selectedCandidate.images[i];
      const u = typeof img === 'string' ? img : img.url;
      const r = typeof img === 'object' && img.role ? img.role : (i === 0 ? 'primary' : 'gallery');
      if (u) rawContributedImages.push({ url: u, source: 'variant-candidate', role: r });
    }
  }

  // 2. Custom primaryImage selector if present (priority 2 if variant candidate has no images)
  if (typeof raw.custom?.primaryImage === 'string' && raw.custom.primaryImage.trim()) {
    rawContributedImages.push({
      url: raw.custom.primaryImage.trim(),
      source: 'custom-selector',
      role: 'primary',
    });
  }

  // 3. Custom selector images
  const rawCustomImages = (raw.custom?.images as string[]) || [];
  for (let i = 0; i < rawCustomImages.length; i++) {
    const u = rawCustomImages[i];
    if (u) rawContributedImages.push({ url: u, source: 'custom-selector', role: i === 0 ? 'primary' : 'gallery' });
  }

  // 4. JSON-LD images
  if (raw.jsonLd?.image) {
    const jImgs = Array.isArray(raw.jsonLd.image) ? raw.jsonLd.image : [raw.jsonLd.image];
    for (let i = 0; i < jImgs.length; i++) {
      const item = jImgs[i];
      const u = typeof item === 'string' ? item : (item as { url?: string; contentUrl?: string })?.url || (item as { url?: string; contentUrl?: string })?.contentUrl;
      if (u && typeof u === 'string') {
        rawContributedImages.push({ url: u, source: 'json-ld', role: i === 0 ? 'primary' : 'gallery' });
      }
    }
  }

  // 5. Microdata images
  if (raw.microdata?.image && typeof raw.microdata.image === 'string') {
    rawContributedImages.push({ url: raw.microdata.image, source: 'microdata', role: 'gallery' });
  }

  // 6. Meta tag images
  if (raw.metaTags?.['og:image']) {
    rawContributedImages.push({ url: raw.metaTags['og:image'], source: 'meta', role: 'gallery' });
  }
  if (raw.metaTags?.['twitter:image']) {
    rawContributedImages.push({ url: raw.metaTags['twitter:image'], source: 'meta', role: 'gallery' });
  }

  // 7. General HTML gallery heuristics
  if (raw.images) {
    for (const u of raw.images) {
      if (u && typeof u === 'string') {
        rawContributedImages.push({ url: u, source: 'html-gallery', role: 'gallery' });
      }
    }
  }

  const imageFilterResult = applyStrictImageFilter({
    images: rawContributedImages,
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
    identityResolution,
    fieldProvenance,
    admittedImages: imageFilterResult.admittedImages,
    rejectedImages: imageFilterResult.rejectedImages,
    primaryImage: imageFilterResult.primaryImage,
    imageRejectionReasons: imageFilterResult.rejectionReasons,
  };
}
