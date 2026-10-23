/**
 * ADR-0031 extraction-ladder wiring: enrich a page-extractor merged result
 * with deterministic platform/structured-data signals the extractor's own
 * layers do not produce, and attach an identity classification.
 *
 * Compatibility contract (ADR-0031):
 *  - ADDITIVE ONLY. Existing ExtractionData fields are never overwritten;
 *    only empty (null/undefined) fields may be filled.
 *  - LAYER ISOLATION. Every layer runs in its own try/catch; a failure in
 *    any ladder layer degrades to "no enrichment" and never fails the
 *    overall extraction.
 *  - NO NEW NETWORK BY DEFAULT. Enrichment parses only content already
 *    fetched by page-extractor (embedded JSON-LD/meta, __NEXT_DATA__,
 *    Nuxt hydration, WooCommerce embedded Store API payloads). The one
 *    network-requiring layer (Shopify product `.js` JSON) is wired but
 *    opt-in via `allowShopifyProductJson`, and when enabled it reuses the
 *    caller's injected fetch transport (same fetch surface + SSRF posture
 *    as the rest of page-extractor).
 */
import type { ExtractionData } from '../../shared/schemas/onboarding';
import {
  detectPlatform,
  gtinFromAny,
  parseNextJsData,
  parseNuxtData,
  parseStructuredSignals,
  parseWooCommerceStoreApi,
  shopifyProductUrl,
  fetchShopifyProductJson,
  type NetworkFetch,
} from './platforms';
import {
  classifyPageIdentity,
  type PageIdentityStatus,
} from './result-shape';

/** Default timeout for the opt-in Shopify product JSON fetch. Matches page-extractor's HTTP fetch timeout. */
const SHOPIFY_FETCH_TIMEOUT_MS = 15000;

/** Hard cap on additionalImages so platform galleries cannot flood curation. */
const MAX_ADDITIONAL_IMAGES = 16;

export interface LadderEnrichmentExpected {
  name?: string;
  brandHint?: string | null;
  /** Requested product GTIN/UPC — enables real exact-match identity classification. */
  gtin?: string;
}

export interface LadderEnrichmentOptions {
  /** The already-fetched page HTML (no refetch). */
  html: string;
  url: string;
  /** The merged extraction result; mutated additively in place. */
  data: ExtractionData;
  expected?: LadderEnrichmentExpected;
  /** Caller's fetch transport — required only for the opt-in Shopify layer. */
  fetchFn?: NetworkFetch;
  /**
   * Opt-in: allow ONE same-origin Shopify `/products/<handle>.js` GET through
   * the provided `fetchFn`. Default false (zero new network traffic).
   */
  allowShopifyProductJson?: boolean;
}

export interface LadderEnrichmentOutcome {
  /** Ladder layers that contributed (diagnostics only). */
  layersUsed: string[];
  /** ExtractionData fields filled by the ladder (already-empty ones only). */
  fills: string[];
  identityStatus: PageIdentityStatus;
  identityReasons: string[];
}

/**
 * Enrich a merged extraction result from deterministic ladder signals.
 * NEVER-THROWS CONTRACT: resolves for any input. Every layer runs under its
 * own guard, and all mutations of `data` — including the identity fields —
 * are guarded, so even a frozen/sealed target object only degrades enrichment
 * (fills skipped, identity assignment dropped) rather than throwing into the
 * extraction pipeline. The returned outcome is authoritative even when `data`
 * could not be mutated.
 */
export async function applyLadderEnrichment(options: LadderEnrichmentOptions): Promise<LadderEnrichmentOutcome> {
  const { html, url, data } = options;
  const layersUsed: string[] = [];
  const fills: string[] = [];
  const gtins: Array<{ value: string }> = [];
  const variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }> = [];
  let platformVariantCount: number | undefined;
  /** SKU observed by platform layers — feeds identity classification only. */
  let observedSku: string | null = null;

  /** Fill a field ONLY when its current value is empty; record provenance. */
  const fill = (field: 'title' | 'brand' | 'description', value: unknown, provenanceKey: string): void => {
    if (value === null || value === undefined) return;
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!text) return;
    const current = data[field];
    if (current !== null && current !== undefined && String(current).trim().length > 0) return;
    data[field] = text;
    data.fieldProvenance[field] = provenanceKey;
    fills.push(field);
  };

  const appendImages = (candidates: Array<string | { src?: unknown; url?: unknown }>, sourcePath: string): void => {
    const existing = new Set(
      [data.primaryImage, ...data.additionalImages]
        .filter((u): u is string => !!u)
        .map((u) => normalizeImageForDedupe(u)),
    );
    for (const candidate of candidates) {
      if (data.additionalImages.length >= MAX_ADDITIONAL_IMAGES) return;
      const raw = typeof candidate === 'string' ? candidate : candidate?.src ?? candidate?.url;
      if (typeof raw !== 'string' || raw.length === 0) continue;
      let absolute: string;
      try {
        absolute = new URL(raw, url).toString();
      } catch {
        continue;
      }
      if (!absolute.startsWith('http')) continue;
      if (existing.has(normalizeImageForDedupe(absolute))) continue;
      existing.add(normalizeImageForDedupe(absolute));
      data.additionalImages.push(absolute);
      if (data.fieldProvenance.additionalImages === undefined) {
        data.fieldProvenance.additionalImages = sourcePath;
      }
    }
  };

  // ── Layer 2 (embedded structured signals) ────────────────────────────────
  try {
    const signals = parseStructuredSignals(html);
    layersUsed.push('structured_data');
    for (const product of signals.jsonLdProducts) {
      if (product.gtin) gtins.push({ value: product.gtin.replace(/\D/g, '') });
    }
    const firstName = signals.jsonLdProducts.find((p) => p.name)?.name ?? null;
    fill('title', firstName, 'ladder-json-ld');
    fill('title', signals.metaTitle, 'ladder-meta');
    const firstBrand = signals.jsonLdProducts.find((p) => p.brand)?.brand ?? null;
    fill('brand', firstBrand, 'ladder-json-ld');
    fill('description', signals.metaDescription, 'ladder-meta');
    // Input Price Authority (ADR 0043): page prices are never extracted.
  } catch {
    layersUsed.push('structured_data_failed');
  }

  // ── Layer 3 (platform payloads embeddable without extra network) ─────────
  try {
    const platform = detectPlatform(html, url);
    if (platform === 'nextjs') {
      const next = parseNextJsData(html);
      if (next.product) {
        layersUsed.push('platform_nextjs');
        const product = next.product;
        fill('title', typeof product.title === 'string' ? product.title : undefined, 'ladder-nextjs');
        fill('brand', typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : undefined, 'ladder-nextjs');
        if (typeof product.sku === 'string' && product.sku.trim()) observedSku = product.sku.trim();
        const gtin = gtinFromAny(product);
        if (gtin) gtins.push({ value: gtin });
        const images = Array.isArray(product.images)
          ? (product.images as unknown[]).map((img): string | { src?: unknown; url?: unknown } => {
              if (typeof img === 'string') return img;
              const rec = (img ?? {}) as { src?: unknown; url?: unknown };
              return (typeof rec.src === 'string' ? rec.src : undefined) ?? (rec.url as string | undefined) ?? '';
            })
          : [];
        appendImages(images, 'ladder-nextjs');
        platformVariantCount = countVariants(product.variants);
      }
    } else if (platform === 'nuxt') {
      const nuxt = parseNuxtData(html);
      if (nuxt.product) {
        layersUsed.push('platform_nuxt');
        const product = nuxt.product;
        fill('title', typeof product.title === 'string' ? product.title : undefined, 'ladder-nuxt');
        fill('brand', typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : undefined, 'ladder-nuxt');
        if (typeof product.sku === 'string' && product.sku.trim()) observedSku = product.sku.trim();
        const gtin = gtinFromAny(product);
        if (gtin) gtins.push({ value: gtin });
        const images = Array.isArray(product.images)
          ? (product.images as unknown[]).map((img): string | { src?: unknown; url?: unknown } => {
              if (typeof img === 'string') return img;
              const rec = (img ?? {}) as { src?: unknown; url?: unknown };
              return (typeof rec.src === 'string' ? rec.src : undefined) ?? (rec.url as string | undefined) ?? '';
            })
          : [];
        appendImages(images, 'ladder-nuxt');
        platformVariantCount = countVariants(product.variants);
      }
    } else if (platform === 'woocommerce') {
      const wc = parseWooCommerceStoreApi(html, url);
      if (wc.product) {
        layersUsed.push('platform_woocommerce');
        fill('title', wc.product.name, 'ladder-woocommerce');
        fill('description', wc.product.description, 'ladder-woocommerce');
        // Input Price Authority (ADR 0043): page prices are never extracted.
        if (wc.product.sku) observedSku = wc.product.sku;
        appendImages(wc.product.images, 'ladder-woocommerce');
      }
    } else if (platform === 'shopify') {
      // The maintained replacement for the deprecated in-page productJSON
      // path: Shopify exposes variants only through the public `.js`
      // endpoint, which is a NETWORK call. Opt-in only (ADR-0031).
      if (options.allowShopifyProductJson && options.fetchFn) {
        const jsonUrl = shopifyProductUrl(url);
        if (jsonUrl) {
          try {
            const productJson = await fetchShopifyProductJson(jsonUrl, AbortSignal.timeout(SHOPIFY_FETCH_TIMEOUT_MS), SHOPIFY_FETCH_TIMEOUT_MS, options.fetchFn);
            layersUsed.push('platform_shopify');
            fill('title', productJson.title, 'ladder-shopify');
            fill('brand', productJson.vendor ?? undefined, 'ladder-shopify');
            // Input Price Authority (ADR 0043): page prices are never extracted.
            const firstBarcode = productJson.variants[0]?.barcode;
            if (firstBarcode) gtins.push({ value: firstBarcode.replace(/\D/g, '') });
            platformVariantCount = productJson.variants.length;
            appendImages(productJson.images.map((img) => img.src), 'ladder-shopify');
          } catch {
            layersUsed.push('shopify_failed');
          }
        }
      } else {
        layersUsed.push('shopify_skipped_no_optin');
      }
    }
  } catch {
    layersUsed.push('platform_layer_failed');
  }

  if (platformVariantCount !== undefined && platformVariantCount > 1) {
    variantSignals.push({ kind: 'parent_page' });
  }

  // ── Identity classification (additive diagnostics) ───────────────────────
  let identity: { status: PageIdentityStatus; reasons: string[] };
  try {
    identity = classifyPageIdentity({
      requestedGtin: options.expected?.gtin?.replace(/\D/g, '') ?? '',
      extractedGtins: gtins.map((g) => g.value),
      sku: observedSku,
      productName: data.title ?? null,
      expectedName: options.expected?.name,
      variantSignals,
      hasAnyField: Boolean(data.title),
      // Platform payloads affirmatively reporting exactly one variant are
      // positive proof; nothing here can prove selected-variant linkage.
      singleVariantProof: platformVariantCount === 1,
      selectedVariantLinkage: false,
    });
  } catch {
    identity = { status: 'insufficient_evidence', reasons: ['identity classification failed'] };
  }
  // Guarded mutation (never-throws contract): a frozen/sealed target must not
  // turn enrichment into an extraction failure — the returned outcome stays
  // authoritative even when these assignments are dropped.
  try {
    data.identityStatus = identity.status;
    data.identityReasons = identity.reasons;
  } catch { /* target rejects mutation */ }

  return { layersUsed: [...new Set(layersUsed)], fills, identityStatus: identity.status, identityReasons: identity.reasons };
}

function countVariants(variants: unknown): number | undefined {
  return Array.isArray(variants) ? variants.filter((v) => !!v && typeof v === 'object').length : undefined;
}

/** Loose URL dedupe key: lowercase, strip protocol + query + fragment. Image-only — do not reuse for product URL identity. */
function normalizeImageForDedupe(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, '').split(/[?#]/)[0];
}
/** @deprecated use normalizeImageForDedupe — kept for backwards compat */
function normalizeForDedupe(url: string): string {
  return normalizeImageForDedupe(url);
}
