/**
 * Deterministic onboarding extraction ladder (ADR-0030 Phase 1 salvage of
 * PI-11 layers 1-4). Executes the cheapest reliable layer first and
 * escalates only when evidence is insufficient:
 *
 *   1. Direct HTTP retrieval.
 *   2. JSON-LD / microdata / Open Graph / canonical / meta structured data.
 *   3. Platform-specific public product representations (Shopify product
 *      JSON, WooCommerce Store API payloads, Next.js app state, Nuxt
 *      hydration state).
 *   4. Existing domain-specific extraction profiles (declared seam for the
 *      extraction worker's approved Domain Extractor Profiles).
 *
 * Layers 5-8 (rendered-browser capture, bounded interaction, managed
 * fallbacks, narrow LLM extraction) were deliberately NOT relocated — the
 * deterministic ladder never depends on them. The engine returns ONE
 * normalized evidence-backed result regardless of layers used; retrieval
 * success is always distinguished from correct product extraction via the
 * identity status.
 */
import * as cheerio from 'cheerio';
import type {
  PageExtractionResult,
  ExtractedFieldEvidence,
  ExtractedIdentifierEvidence,
  ExtractedImageCandidate,
} from './result-shape';
import {
  classifyPageIdentity,
  structuredSingleVariantProof,
  type PageExtractionContract,
} from './result-shape';
import {
  fetchPageHtml,
  parseStructuredSignals,
  detectPlatform,
  parseNextJsData,
  parseNuxtData,
  shopifyProductUrl,
  fetchShopifyProductJson,
  parseWooCommerceStoreApi,
  gtinFromAny,
  type FetchedPage,
} from './platforms';

export interface LadderOptions {
  /** Policy authorization checked before every arbitrary HTTP(S) destination. */
  networkGate?: (url: string, signal: AbortSignal) => Promise<{ allowed: boolean; code?: string; detail?: string }>;
  fetchPage?: typeof fetchPageHtml;
  fetchShopify?: typeof fetchShopifyProductJson;
  /**
   * Layer-4 seam: registered domain profiles (CSS-selector extractors).
   * Empty by default — the extraction worker's profiles are not wired into
   * Pi; a future slice registers approved profiles per domain.
   */
  profiles?: Array<{
    name: string;
    /** Optional durable identity/version for provenance bundles. */
    id?: string;
    version?: string | number;
    runtime?: 'static' | 'rendered';
    matches(url: string): boolean;
    extract(
      url: string,
      signal: AbortSignal,
      timeoutMs: number,
      expected?: { gtin?: string; name?: string; brandHint?: string | null },
    ): Promise<{
      fields: ExtractedFieldEvidence[];
      images: Array<{ url: string; sourcePath?: string; sourceArtifactId?: string | null; sourceContentHash?: string | null; variantRef?: string }>;
      profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered'; artifactId?: string | null; contentHash?: string | null };
    } | null>;
  }>;
}

export interface LadderRun {
  result: PageExtractionResult;
  layersUsed: string[];
  /** Approved profile selected by the ladder, when one matched. */
  profile?: { id: string; version: string | number; runtime?: 'static' | 'rendered'; artifactId?: string | null; contentHash?: string | null } | null;
}

/** Digits-only comparison of expected vs extracted GTINs. */
export function exactGtinMatch(expected: string | undefined, extractedGtins: Array<{ value: string }>): boolean {
  if (!expected) return false;
  const normalized = expected.replace(/\D/g, '');
  if (normalized.length === 0) return false;
  return extractedGtins.some((g) => g.value.replace(/\D/g, '') === normalized);
}

export async function runExtractionLadder(
  url: string,
  expected: { gtin?: string; name?: string; brandHint?: string | null },
  signal: AbortSignal,
  timeoutMs: number,
  options: LadderOptions = {},
): Promise<LadderRun> {
  const layersUsed: string[] = [];
  const fields: ExtractedFieldEvidence[] = [];
  const images: ExtractedImageCandidate[] = [];
  const gtins: ExtractedIdentifierEvidence[] = [];
  type SourceMetadata = {
    artifactId?: string | null;
    contentHash?: string | null;
    variantRef?: string | null;
    profileId?: string | null;
    profileVersion?: string | number | null;
  };
  let pageArtifactId: string | null = null;
  const conflicts: Array<{ field: string; summary: string }> = [];
  const fetchModes: string[] = [];
  const variantSignals: Array<{ kind: 'parent_page' | 'variant_mismatch' | 'variant_match' }> = [];
  let sku: string | null = null;
  let brand: string | null = null;
  let productName: string | null = null;
  let size: string | null = null;
  const packCount: number | null = null;
  let variant: { name?: string; id?: string; sku?: string } | null = null;
  let finalUrl = url;
  let contentHash: string | null = null;
  // P0-5 proof accumulator (round 3): proof strength is tracked by SOURCE.
  // A JSON-LD single-offer claim is CORROBORATION (structured) — it records
  // the page's self-declared single-variant state but NEVER settles exact
  // identity on its own. Only a platform payload that affirmatively sees
  // the variant set provides sufficient single-variant proof (the relocated
  // ladder has no rendered-browser layer). Absence of variant UI or signals
  // is never treated as proof.
  type VariantProofSource = 'platform' | 'structured' | 'none';
  const PROOF_STRENGTH: Record<Exclude<VariantProofSource, 'none'>, number> = {
    platform: 3,
    structured: 1,
  };
  let variantProofSource: VariantProofSource = 'none';
  const noteProof = (source: Exclude<VariantProofSource, 'none'>): void => {
    if (PROOF_STRENGTH[source] > (PROOF_STRENGTH[variantProofSource as Exclude<VariantProofSource, 'none'>] ?? 0)) {
      variantProofSource = source;
    }
  };
  const selectedVariantLinkage = (): boolean => variantSignals.some((s) => s.kind === 'variant_match');
  const authorizeNetwork = async (destination: string): Promise<void> => {
    if (!options.networkGate) return;
    const decision = await options.networkGate(destination, signal);
    if (!decision.allowed) throw new Error(`network denied${decision.code ? `: ${decision.code}` : ''}${decision.detail ? ` (${decision.detail})` : ''}`);
  };
  // P0-5 round 2: an affirmative contradiction — a platform payload revealing
  // multiple variants (parent_page) or a variant mismatch — invalidates any
  // proof claim. Structured corroboration never survives a layer that
  // actually sees the variant set.
  const contradictoryVariant = (): boolean =>
    variantSignals.some((s) => s.kind === 'parent_page' || s.kind === 'variant_mismatch');
  // Only platform sources are sufficient without a rendered-browser layer;
  // structured corroboration never produces exact identity on its own
  // (P0-5 round 3).
  const effectiveSingleVariantProof = (): boolean =>
    variantProofSource === 'platform' && !contradictoryVariant();

  const pageSource = (): SourceMetadata => ({ artifactId: pageArtifactId, contentHash });
  const addField = (field: string, value: string | null | undefined, method: string, sourcePath?: string, source: SourceMetadata = pageSource()): void => {
    if (value === null || value === undefined) return;
    const trimmed = String(value).trim();
    if (trimmed.length === 0) return;
    if (fields.some((f) => f.field === field && f.value === trimmed && f.method === method && f.variantRef === (source.variantRef ?? undefined))) return;
    fields.push({ field, value: trimmed.slice(0, 2000), method, sourcePath, sourceArtifactId: source.artifactId, sourceContentHash: source.contentHash, sourceProfileId: source.profileId, sourceProfileVersion: source.profileVersion, variantRef: source.variantRef });
  };

  const addGtin = (value: string, method: string, sourcePath?: string, source: SourceMetadata = pageSource()): void => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 6) return;
    if (gtins.some((g) => g.value.replace(/\D/g, '') === digits && g.method === method && g.variantRef === (source.variantRef ?? undefined))) return;
    const existing = gtins.find((g) => g.value.replace(/\D/g, '') !== digits);
    if (existing) {
      conflicts.push({ field: 'gtin', summary: `conflicting GTIN evidence: ${existing.value} vs ${digits}` });
    }
    gtins.push({ value: digits, method, sourcePath, sourceArtifactId: source.artifactId, sourceContentHash: source.contentHash, variantRef: source.variantRef });
  };

  // Nuxt hydration state (window.__NUXT__ / __NUXT_DATA__) can carry a full
  // variant list. Emit provenance + variantRef for EVERY variant entry — not
  // only variants[0] — including per-variant SKU/GTIN and field observations,
  // so downstream identity work never flattens the variant set.
  const emitNuxtProduct = (product: Record<string, unknown>): void => {
    addField('product_name', product.title as string | undefined, 'platform_api', '__NUXT__ product');
    if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NUXT__ product.sku');
    const productGtin = gtinFromAny(product);
    if (productGtin) addGtin(productGtin, 'platform_api', '__NUXT__ product.gtin');
    productName ??= typeof product.title === 'string' ? product.title : null;
    sku ??= typeof product.sku === 'string' ? product.sku : null;
    brand ??= typeof product.brand === 'string' ? product.brand : null;
    if (typeof product.brand === 'string') addField('brand', product.brand, 'platform_api', '__NUXT__ product.brand');
    const productImages = Array.isArray(product.images)
      ? product.images
          .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown; url?: unknown })?.src ?? (img as { url?: unknown })?.url))
          .filter((src): src is string => typeof src === 'string')
      : [];
    for (const image of productImages) {
      if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: '__NUXT__ product.images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
    if (Array.isArray(product.variants)) {
      const variantList = product.variants.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      const first = variantList[0];
      if (first) {
        variant = {
          id: typeof first.id === 'string' || typeof first.id === 'number' ? String(first.id) : undefined,
          name: typeof first.title === 'string' ? first.title : typeof first.name === 'string' ? first.name : undefined,
          sku: typeof first.sku === 'string' ? first.sku : undefined,
        };
        if (variantList.length > 1) {
          variantSignals.push({ kind: 'parent_page' });
        } else if (variantList.length === 1) {
          // Platform API affirmatively reports exactly one variant.
          noteProof('platform');
        }
      }
      variantList.forEach((v, index) => {
        const variantRef = typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id) : `nuxt-variant-${index}`;
        const variantSource: SourceMetadata = { ...pageSource(), variantRef };
        const variantPath = `__NUXT__ product.variants[${index}]`;
        const variantTitle = typeof v.title === 'string' ? v.title : typeof v.name === 'string' ? v.name : undefined;
        if (variantTitle) addField('variant_name', variantTitle, 'platform_api', `${variantPath}.title`, variantSource);
        if (typeof v.sku === 'string') {
          addField(index === 0 ? 'sku' : 'variant_sku', v.sku, 'platform_api', `${variantPath}.sku`, variantSource);
        }
        if (index === 0 && typeof v.option1 === 'string') addField('size', v.option1, 'platform_api', `${variantPath}.option1`, variantSource);
        const variantGtin = gtinFromAny(v);
        if (variantGtin) addGtin(variantGtin, 'platform_api', `${variantPath}.barcode`, variantSource);
      });
    }
  };

  // Layer 1 + 2: one HTTP fetch, then parse every embedded structured signal.
  let page: FetchedPage;
  try {
    // A raw default transport is never permitted without an explicit policy
    // gate. Injected transports are the provider-neutral seam and are expected
    // to be gateway-bound by their caller.
    if (!options.fetchPage && !options.networkGate) throw new Error('network policy gate required for default transport');
    await authorizeNetwork(url);
    page = await (options.fetchPage ?? fetchPageHtml)(url, signal, timeoutMs);
    if (options.networkGate && page.finalUrl !== url) await authorizeNetwork(page.finalUrl);
  } catch (error) {
    return {
      result: {
        requestedUrl: url,
        finalUrl: url,
        fetchModes: ['http'],
        contentHash: null,
        artifactRef: null,
        fields: [],
        gtins: [],
        sku: null,
        brand: null,
        productName: null,
        variant: null,
        size: null,
        packCount: null,
        images: [],
        conflicts: [
          { field: '_retrieval', summary: error instanceof Error ? error.message.slice(0, 300) : 'fetch failed' },
        ],
        identityStatus: 'insufficient_evidence',
        identityReasons: ['page could not be retrieved'],
        deterministicOnly: true,
      },
      layersUsed: ['http'],
      profile: null,
    };
  }
  layersUsed.push('http', 'structured_data');
  fetchModes.push('http', 'structured_data');
  finalUrl = page.finalUrl;
  contentHash = page.contentHash;
  pageArtifactId = page.artifactId ?? null;

  const signals = parseStructuredSignals(page.html);
  // JSON-LD single-offer = corroboration only (never sufficient on its own).
  if (structuredSingleVariantProof(page.html)) noteProof('structured');
  for (const product of signals.jsonLdProducts) {
    if (product.name) addField('product_name', product.name, 'json_ld', 'JSON-LD Product.name');
    if (product.sku) addField('sku', product.sku, 'json_ld', 'JSON-LD Product.sku');
    if (product.brand) addField('brand', product.brand, 'json_ld', 'JSON-LD Product.brand');
    if (product.gtin) addGtin(product.gtin, 'json_ld', 'JSON-LD Product.gtin');
    if (product.size) addField('size', product.size, 'json_ld', 'JSON-LD Product.size');
    for (const image of product.images) {
      if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: 'JSON-LD Product.image', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
    productName ??= product.name;
    sku ??= product.sku;
    brand ??= product.brand;
    size ??= product.size;
  }
  if (signals.metaTitle) addField('product_name', signals.metaTitle, 'meta', 'og:title');
  if (signals.metaDescription) addField('description', signals.metaDescription, 'meta', 'meta[name=description]');
  if (signals.ogImage) {
    if (!images.some((i) => i.url === signals.ogImage)) {
      images.push({ url: signals.ogImage, sourcePath: 'og:image', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
    }
  }
  productName ??= signals.ogTitle ?? signals.metaTitle;

  // Layer 3: platform-specific public product representations.
  layersUsed.push('platform_api');
  fetchModes.push('platform_api');
  const platform = detectPlatform(page.html, page.finalUrl);
  switch (platform) {
    case 'shopify': {
      const jsonUrl = shopifyProductUrl(page.finalUrl);
      if (jsonUrl) {
        try {
          await authorizeNetwork(jsonUrl);
          const productJson = await (options.fetchShopify ?? fetchShopifyProductJson)(jsonUrl, signal, timeoutMs);
          if (productJson.sourceUrl && options.networkGate) await authorizeNetwork(productJson.sourceUrl);
          layersUsed.push('shopify');
          const platformSource: SourceMetadata = {
            artifactId: productJson.sourceArtifactId,
            contentHash: productJson.sourceContentHash,
          };
          addField('product_name', productJson.title, 'platform_api', productJson.sourcePath ?? 'Shopify product JSON', platformSource);
          addField('brand', productJson.vendor ?? undefined, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.vendor`, platformSource);
          const gtin = gtinFromAny(productJson as unknown as Record<string, unknown>);
          if (gtin) addGtin(gtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.gtin`, platformSource);
          productName ??= productJson.title;
          brand ??= productJson.vendor ?? null;
          if (productJson.variants.length > 1) {
            variantSignals.push({ kind: 'parent_page' });
          } else if (productJson.variants.length === 1) {
            // Platform API affirmatively reports exactly one variant.
            noteProof('platform');
          }
          const first = productJson.variants[0];
          if (first) {
            variant = {
              id: String(first.id ?? ''),
              name: typeof first.title === 'string' ? first.title : undefined,
              sku: typeof first.sku === 'string' ? first.sku : undefined,
            };
            if (first.title) addField('variant_name', first.title, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].title`, { ...platformSource, variantRef: String(first.id) });
            if (first.option1) addField('size', first.option1, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].option1`, { ...platformSource, variantRef: String(first.id) });
            if (first.sku) addField('sku', first.sku, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].sku`, { ...platformSource, variantRef: String(first.id) });
            const firstGtin = gtinFromAny(first as unknown as Record<string, unknown>);
            if (firstGtin) addGtin(firstGtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[0].barcode`, { ...platformSource, variantRef: String(first.id) });
          }
          for (const v of productJson.variants) {
            const variantRef = String(v.id);
            if (v.sku && v.sku !== first?.sku) addField('variant_sku', v.sku, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[].sku`, { ...platformSource, variantRef });
            const variantGtin = gtinFromAny(v as unknown as Record<string, unknown>);
            if (variantGtin) addGtin(variantGtin, 'platform_api', `${productJson.sourcePath ?? 'Shopify product JSON'}.variants[].barcode`, { ...platformSource, variantRef });
          }
          for (const image of productJson.images) {
            if (!images.some((i) => i.url === image.src)) {
              images.push({ url: image.src, sourcePath: `${productJson.sourcePath ?? 'Shopify product JSON'}.images`, sourceArtifactId: platformSource.artifactId, sourceContentHash: platformSource.contentHash, variantRef: image.variant_ids[0] !== undefined ? String(image.variant_ids[0]) : undefined });
            }
          }
        } catch {
          layersUsed.push('shopify_failed');
          // Shopify-Hydrogen headless stores pair Shopify markers with
          // Next.js/Nuxt app state; the .js endpoint 404s but the embedded
          // state still carries the product (review PI-11-MAJOR-4).
          const nextFallback = parseNextJsData(page.html);
          if (nextFallback.product) {
            layersUsed.push('nextjs');
            const product = nextFallback.product;
            addField('product_name', product.title as string | undefined, 'platform_api', '__NEXT_DATA__ product');
            if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NEXT_DATA__ product.sku');
            const fallbackGtin = gtinFromAny(product);
            if (fallbackGtin) addGtin(fallbackGtin, 'platform_api', '__NEXT_DATA__ product.gtin');
            productName ??= typeof product.title === 'string' ? product.title : null;
            sku ??= typeof product.sku === 'string' ? product.sku : null;
            if (Array.isArray(product.variants)) {
              const firstVariant = product.variants.find((v) => !!v && typeof v === 'object') as Record<string, unknown> | undefined;
              if (firstVariant) {
                variant = {
                  id: typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined,
                  name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
                  sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
                };
                if (product.variants.length > 1) {
                  variantSignals.push({ kind: 'parent_page' });
                } else if (product.variants.length === 1) {
                  // Platform API affirmatively reports exactly one variant.
                  noteProof('platform');
                }
              }
            }
          } else {
            const nuxtFallback = parseNuxtData(page.html);
            if (nuxtFallback.product) {
              layersUsed.push('nuxt');
              emitNuxtProduct(nuxtFallback.product);
            }
          }
        }
      }
      break;
    }
    case 'woocommerce': {
      const wc = parseWooCommerceStoreApi(page.html, page.finalUrl);
      if (wc.product) {
        layersUsed.push('woocommerce');
        addField('product_name', wc.product.name ?? undefined, 'platform_api', 'WooCommerce Store API payload');
        addField('sku', wc.product.sku ?? undefined, 'platform_api', 'WooCommerce Store API payload');
        // Input Price Authority (ADR 0043): page prices are never collected.
        productName ??= wc.product.name;
        sku ??= wc.product.sku;
        for (const image of wc.product.images) {
          if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: 'WooCommerce Store API images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
        }
        for (const attr of wc.product.attributes) {
          addField(`attribute_${attr.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, attr.value, 'platform_api', 'WooCommerce Store API attributes');
        }
      } else {
        layersUsed.push('woocommerce_embedded_none');
      }
      break;
    }
    case 'nextjs': {
      const nextData = parseNextJsData(page.html);
      if (nextData.product) {
        layersUsed.push('nextjs');
        const product = nextData.product;
        addField('product_name', product.title as string | undefined, 'platform_api', '__NEXT_DATA__ product');
        if (typeof product.sku === 'string') addField('sku', product.sku, 'platform_api', '__NEXT_DATA__ product.sku');
        const gtin = gtinFromAny(product);
        if (gtin) addGtin(gtin, 'platform_api', '__NEXT_DATA__ product.gtin');
        productName ??= typeof product.title === 'string' ? product.title : null;
        sku ??= typeof product.sku === 'string' ? product.sku : null;
        brand ??= typeof product.brand === 'string' ? product.brand : typeof product.vendor === 'string' ? product.vendor : null;
        if (typeof product.brand === 'string') addField('brand', product.brand, 'platform_api', '__NEXT_DATA__ product.brand');
        const productImages = Array.isArray(product.images)
          ? product.images
              .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown; url?: unknown })?.src ?? (img as { url?: unknown })?.url))
              .filter((src): src is string => typeof src === 'string')
          : [];
        for (const image of productImages) {
          if (!images.some((i) => i.url === image)) images.push({ url: image, sourcePath: '__NEXT_DATA__ product.images', sourceArtifactId: pageArtifactId, sourceContentHash: contentHash });
        }
        if (Array.isArray(product.variants)) {
          const firstVariant = product.variants.find((v) => !!v && typeof v === 'object') as Record<string, unknown> | undefined;
          if (firstVariant) {
            variant = {
              id: typeof firstVariant.id === 'string' || typeof firstVariant.id === 'number' ? String(firstVariant.id) : undefined,
              name: typeof firstVariant.title === 'string' ? firstVariant.title : typeof firstVariant.name === 'string' ? firstVariant.name : undefined,
              sku: typeof firstVariant.sku === 'string' ? firstVariant.sku : undefined,
            };
            if (product.variants.length > 1) {
              variantSignals.push({ kind: 'parent_page' });
            } else if (product.variants.length === 1) {
              // Platform API affirmatively reports exactly one variant.
              noteProof('platform');
            }
          }
        }
      } else {
        layersUsed.push('nextjs_no_product');
      }
      break;
    }
    case 'nuxt': {
      const nuxtData = parseNuxtData(page.html);
      if (nuxtData.product) {
        layersUsed.push('nuxt');
        emitNuxtProduct(nuxtData.product);
      } else {
        layersUsed.push('nuxt_no_product');
      }
      break;
    }
    default:
      layersUsed.push('platform_none');
  }

  // Layer 4: registered domain profiles (CSS selector extractors).
  let profileMatched = false;
  let selectedProfile: LadderRun['profile'] = null;
  for (const profile of options.profiles ?? []) {
    if (!profile.matches(finalUrl)) continue;
    profileMatched = true;
    const matchedProfileBinding: LadderRun['profile'] = profile.id && profile.version !== undefined
      ? { id: profile.id, version: profile.version, runtime: profile.runtime }
      : null;
    layersUsed.push('profile_selector');
    fetchModes.push('profile_selector');
    try {
      const out = await profile.extract(finalUrl, signal, timeoutMs, expected);
      if (out) {
        selectedProfile = out.profile ?? matchedProfileBinding;
        const profileSource: SourceMetadata = {
          artifactId: out.profile?.artifactId ?? null,
          contentHash: out.profile?.contentHash ?? null,
          profileId: selectedProfile?.id ?? null,
          profileVersion: selectedProfile?.version ?? null,
        };
        for (const f of out.fields) {
          // Preserve the resolver-provided method/sourcePath/artifact/hash/
          // variantRef verbatim — never overwrite f.method with
          // profile_selector. Only tag profile_selector when the resolver
          // explicitly reports selector provenance (an explicit method or a
          // `profile:`-prefixed source path); structured/meta fallbacks keep
          // their true method and unknown origins stay 'profile_fallback'.
          const method = f.method && f.method.trim().length > 0
            ? f.method
            : (typeof f.sourcePath === 'string' && f.sourcePath.startsWith('profile:') ? 'profile_selector' : 'profile_fallback');
          addField(f.field, f.value, method, f.sourcePath, {
            ...profileSource,
            artifactId: f.sourceArtifactId ?? profileSource.artifactId,
            contentHash: f.sourceContentHash ?? profileSource.contentHash,
            variantRef: f.variantRef,
          });
        }
        for (const image of out.images) {
          if (!images.some((i) => i.url === image.url)) {
            images.push({ url: image.url, sourcePath: image.sourcePath, sourceArtifactId: image.sourceArtifactId ?? profileSource.artifactId, sourceContentHash: image.sourceContentHash ?? profileSource.contentHash, variantRef: image.variantRef });
          }
        }
      }
    } catch {
      selectedProfile = matchedProfileBinding;
      layersUsed.push('profile_failed');
    }
  }
  if (!profileMatched) {
    layersUsed.push('profile_miss');
  }

  // Promote recorded field evidence into the identity accumulators: layers
  // record fields with methods/source paths, but identity classification
  // consumes the canonical sku/productName/brand values. (This runs after
  // every layer, not just the profile layer.)
  sku ??= fields.find((f) => f.field === 'sku')?.value ?? null;
  productName ??= fields.find((f) => f.field === 'product_name')?.value ?? null;
  brand ??= fields.find((f) => f.field === 'brand')?.value ?? null;
  size ??= fields.find((f) => f.field === 'size')?.value ?? null;

  // Early exit (P0-5 round 3): settle only on AFFIRMATIVE proof — a platform
  // payload reporting exactly one variant, or positive selected-variant
  // linkage. Structured JSON-LD single-offer claims are CORROBORATION ONLY
  // and never settle the identity here (no rendered-browser layer exists in
  // this ladder to reveal client-state variants before exact_match). An
  // affirmative contradiction (parent_page/variant_mismatch) invalidates the
  // proof via effectiveSingleVariantProof().
  if (exactGtinMatch(expected.gtin, gtins) && fields.length >= 3 && (effectiveSingleVariantProof() || selectedVariantLinkage())) {
    return {
      result: assembleResult(),
      layersUsed: [...new Set(layersUsed)],
      profile: selectedProfile,
    };
  }

  // Layers 5-8 were not relocated (ADR-0030 Phase 1): when the
  // deterministic layers do not settle identity, the result falls through
  // with its accumulated fields and an honest non-exact identity status.

  return {
    result: assembleResult(),
    layersUsed: [...new Set(layersUsed)],
    profile: selectedProfile,
  };

  function assembleResult(): PageExtractionResult {
    const hasAnyField = fields.length > 0;
    const identity = classifyPageIdentity({
      requestedGtin: expected.gtin ?? '',
      extractedGtins: gtins.map((g) => g.value),
      sku,
      productName,
      expectedName: expected.name,
      variantSignals,
      hasAnyField,
      singleVariantProof: effectiveSingleVariantProof(),
      selectedVariantLinkage: selectedVariantLinkage(),
    });
    return {
      requestedUrl: url,
      finalUrl,
      fetchModes: [...new Set(fetchModes)],
      contentHash,
      // The page artifact is the source only for fields explicitly attached
      // to page bytes. Platform/profile observations carry their own metadata.
      artifactRef: pageArtifactId,
      fields,
      gtins,
      sku,
      brand,
      productName,
      variant,
      size,
      packCount,
      images: images.slice(0, 16),
      conflicts,
      identityStatus: identity.status,
      identityReasons: identity.reasons,
      // No LLM layer exists in the relocated ladder.
      deterministicOnly: true,
    };
  }
}

/** PageExtractionContract adapter over the ladder (drop-in for the tool). */
export function createLadderExtractionContract(options: LadderOptions = {}): PageExtractionContract {
  return {
    name: 'extraction_ladder',
    version: '1.0.0',
    async extract(request: {
      url: string;
      expected?: { gtin?: string; name?: string; brandHint?: string | null };
      signal: AbortSignal;
      timeoutMs: number;
      profile?: { selectors: Record<string, string | null>; runtime: 'static' | 'rendered' };
    }): Promise<PageExtractionResult> {
      const { result } = await runExtractionLadder(request.url, request.expected ?? {}, request.signal, request.timeoutMs, options);
      return result;
    },
    async extractWithProfile(request: {
      url: string;
      expected?: { gtin?: string; name?: string; brandHint?: string | null };
      signal: AbortSignal;
      timeoutMs: number;
      profile: { selectors: Record<string, string | null>; runtime: 'static' | 'rendered' };
    }): Promise<PageExtractionResult> {
      // This is the deterministic profile-runner seam: unlike `extract`, it
      // never invokes the ladder's fallback layers and only reports values
      // selected by the supplied profile. A profile fetch is a privileged
      // network operation: callers must provide both an authorized gate and
      // an explicitly injected transport. Never fall back to global fetch.
      if (request.profile.runtime !== 'rendered' && (!options.networkGate || !options.fetchPage)) {
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          fetchModes: ['profile_unsupported'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'profile extraction requires an authorized network gate and transport' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['profile extraction transport is not policy-authorized'],
          deterministicOnly: true,
        };
      }
      if (request.profile.runtime === 'rendered') {
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          fetchModes: ['profile_unsupported'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'rendered profile requires the browser profile runner; unsupported by this ladder seam' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['rendered profile runtime is unsupported by this static ladder seam'],
          deterministicOnly: true,
        };
      }
      const profileFetchPage = options.fetchPage;
      const authorizeProfileNetwork = async (destination: string): Promise<void> => {
        const decision = await options.networkGate!(destination, request.signal);
        if (!decision.allowed) throw new Error(`network denied${decision.code ? `: ${decision.code}` : ''}${decision.detail ? ` (${decision.detail})` : ''}`);
      };
      await authorizeProfileNetwork(request.url);
      const page = await profileFetchPage!(request.url, request.signal, request.timeoutMs);
      // A gateway-bound transport validates redirects itself. For arbitrary
      // injected transports, still authorize the observed final hop before
      // accepting or exposing any selector value.
      if (page.finalUrl !== request.url) await authorizeProfileNetwork(page.finalUrl);
      if (!page.contentHash || !/^[0-9a-f]{64}$/u.test(page.contentHash) || !page.artifactId && !page.contentHash) {
        return {
          requestedUrl: request.url,
          finalUrl: page.finalUrl,
          fetchModes: ['profile_failed'],
          contentHash: null,
          artifactRef: null,
          fields: [],
          gtins: [],
          sku: null,
          brand: null,
          productName: null,
          variant: null,
          size: null,
          packCount: null,
          images: [],
          conflicts: [{ field: '_profile', summary: 'profile source bytes were not retained with a valid content hash' }],
          identityStatus: 'insufficient_evidence',
          identityReasons: ['profile source provenance unavailable'],
          deterministicOnly: true,
        };
      }
      const source = { sourceArtifactId: page.artifactId ?? null, sourceContentHash: page.contentHash };
      const $ = cheerio.load(page.html);
      const selector = (key: string): string | null => request.profile.selectors[key] ?? null;
      const text = (key: string): string | null => {
        const sel = selector(key);
        if (!sel) return null;
        try { return $(sel).first().text().trim() || null; } catch { return null; }
      };
      const productName = text('titleSelector');
      const fields: ExtractedFieldEvidence[] = productName
        ? [{ field: 'product_name', value: productName, method: 'profile_selector', sourcePath: selector('titleSelector') ?? undefined, ...source }]
        : [];
      const description = text('descriptionSelector');
      if (description) fields.push({ field: 'description', value: description, method: 'profile_selector', sourcePath: selector('descriptionSelector') ?? undefined, ...source });
      const brand = text('brandSelector');
      if (brand) fields.push({ field: 'brand', value: brand, method: 'profile_selector', sourcePath: selector('brandSelector') ?? undefined, ...source });
      const images: ExtractedImageCandidate[] = [];
      const imageSelector = selector('imagesSelector');
      if (imageSelector) {
        try {
          $(imageSelector).find('img').each((_index, element) => {
            const src = $(element).attr('src') ?? $(element).attr('data-src');
            if (src) images.push({ url: new URL(src, page.finalUrl).toString(), sourcePath: imageSelector, ...source });
          });
        } catch { /* invalid selectors are an incompatible profile */ }
      }
      const expectedName = request.expected?.name?.trim().toLowerCase();
      const identityStatus = productName && expectedName && productName.toLowerCase().includes(expectedName)
        ? 'exact_match' as const
        : productName ? 'probable_match' as const : 'insufficient_evidence' as const;
      return {
        requestedUrl: request.url,
        finalUrl: page.finalUrl,
        fetchModes: ['profile_selector'],
        contentHash: page.contentHash,
        artifactRef: page.artifactId ?? null,
        fields,
        gtins: [],
        sku: null,
        brand,
        productName,
        variant: null,
        size: null,
        packCount: null,
        images,
        conflicts: [],
        identityStatus,
        identityReasons: productName ? [] : ['active profile title selector produced no value'],
        deterministicOnly: true,
      };
    },
  };
}

/** Re-exported for consumers that classify product-like payloads directly. */
