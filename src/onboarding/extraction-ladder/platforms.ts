/**
 * Deterministic platform adapters for the PI-11 extraction ladder (layers
 * 1-3). Every adapter is a pure function over (html, finalUrl) or a fetch of
 * a public platform endpoint; none uses a browser or an LLM. Machine-readable
 * data is preferred over interpretation, and every extracted value carries
 * its method and source path downstream.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/29
 */
import { sha256Hex } from '../../shared/stable-id';

/**
 * Standard browser request headers. Mirrors the onboarding page-extractor's
 * constant (that module pulls in playwright + DB repos, which would break
 * vitest importability here); kept identical for consistent site responses.
 */
export const HTTP_EXTRACTION_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

/** Fetch-like function used by the ladder's HTTP layer (P0-1 seam). */
export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
  /** SHA-256 of these exact retained page bytes. */
  contentHash: string;
  /** Durable artifact containing these exact page bytes, when retained. */
  artifactId?: string | null;
}

/**
 * Fetch raw page HTML following redirects; records the final URL + hash.
 * `fetchFn` defaults to the global fetch so non-PI callers/tests are
 * unchanged; PI callers pass a policy-gateway-bound fetch (P0-1) so the
 * ladder's HTTP layer is the enforced network capability.
 */
export async function fetchPageHtml(url: string, signal: AbortSignal, timeoutMs: number, fetchFn: NetworkFetch = fetch): Promise<FetchedPage> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchFn(url, { headers: HTTP_EXTRACTION_HEADERS, redirect: 'follow', signal: combined });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();
  // Hard response-size cap (5 MB) — the policy gateway's gatewayFetch also
  // enforces this via maxResponseBytes when the caller injects it (P0-1);
  // this local guard covers the default (raw fetch) path too.
  if (html.length > 5_000_000) {
    throw new Error(`Response too large (${html.length} chars) for ${url}`);
  }
  return { html, finalUrl: response.url || url, status: response.status, contentHash: sha256Hex(html) };
}



export const PLATFORM_NAMES = ['shopify', 'woocommerce', 'nextjs', 'nuxt'] as const;
export type PlatformName = (typeof PLATFORM_NAMES)[number];
/** Platform detection from page markup; order matters (Shopify first). */
export function detectPlatform(html: string, _finalUrl: string): PlatformName | 'generic' {
  if (/\/cdn\/shop\//.test(html) || /Shopify\.theme/.test(html) || /shopify\.com\/s\//.test(html)) return 'shopify';
  if (/wp-content\/plugins\/woocommerce/.test(html) || /wc-store-v1|wc\/store/.test(html)) return 'woocommerce';
  if (/__NEXT_DATA__/.test(html) || /_next\/static/.test(html)) return 'nextjs';
  if (/window\.__NUXT__|__NUXT__=|__NUXT_DATA__/.test(html)) return 'nuxt';
  return 'generic';
}

export interface StructuredSignals {
  jsonLdProducts: Array<{
    name: string | null;
    sku: string | null;
    gtin: string | null;
    brand: string | null;
    size: string | null;
    images: string[];
  }>;
  metaTitle: string | null;
  ogTitle: string | null;
  ogImage: string | null;
  canonicalUrl: string | null;
  metaDescription: string | null;
  metaKeywords: string | null;
}

/** Meta content in either attribute order (property/name first or content first). */
function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const forward = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
  const match = html.match(forward);
  if (match) return match[1] || null;
  const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${key}["']`, 'i');
  const match2 = html.match(reversed);
  return match2 ? match2[1] || null : null;
}

function linkHref(html: string, rel: string): string | null {
  const forward = new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']+)["']`, 'i');
  const match = html.match(forward);
  if (match) return match[1] || null;
  const reversed = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${rel}["']`, 'i');
  const match2 = html.match(reversed);
  return match2 ? match2[1] || null : null;
}

interface JsonLdProduct {
  name?: unknown;
  sku?: unknown;
  gtin?: unknown;
  gtin8?: unknown;
  gtin12?: unknown;
  gtin13?: unknown;
  gtin14?: unknown;
  ean?: unknown;
  upc?: unknown;
  size?: unknown;
  brand?: unknown;
  image?: unknown;
}

/** Recursively collect Product-typed JSON-LD objects (bounded depth). */
function collectJsonLdProducts(node: unknown, out: JsonLdProduct[], depth = 0): void {
  if (depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdProducts(item, out, depth + 1);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => String(t ?? '') === 'Product')) {
    out.push(obj as JsonLdProduct);
  }
  // Recurse into every value — WebPage.mainEntity and ItemList.itemListElement
  // wrappers are the canonical embedding shapes for Product graphs.
  for (const value of Object.values(obj)) {
    collectJsonLdProducts(value, out, depth + 1);
  }
}

function jsonLdString(obj: JsonLdProduct, key: string): string | null {
  const raw = obj[key as keyof JsonLdProduct];
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : (raw as { name?: unknown })?.name;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 2000) : null;
}

function jsonLdImages(image: unknown): string[] {
  if (typeof image === 'string') return [image];
  if (Array.isArray(image)) {
    return image
      .map((item) => (typeof item === 'string' ? item : (item as { url?: unknown })?.url))
      .filter((item): item is string => typeof item === 'string');
  }
  if (image && typeof image === 'object') {
    const url = (image as { url?: unknown }).url;
    if (typeof url === 'string') return [url];
  }
  return [];
}

/** Parse JSON-LD, Open Graph, canonical, and meta signals from raw HTML. */
export function parseStructuredSignals(html: string): StructuredSignals {
  const jsonLdProducts: StructuredSignals['jsonLdProducts'] = [];
  const scriptBlocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of scriptBlocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const collected: JsonLdProduct[] = [];
      collectJsonLdProducts(parsed, collected);
      for (const product of collected) {
        jsonLdProducts.push({
          name: jsonLdString(product, 'name'),
          sku: jsonLdString(product, 'sku'),
          gtin:
            jsonLdString(product, 'gtin') ??
            jsonLdString(product, 'gtin13') ??
            jsonLdString(product, 'gtin12') ??
            jsonLdString(product, 'gtin8') ??
            jsonLdString(product, 'gtin14') ??
            jsonLdString(product, 'ean') ??
            jsonLdString(product, 'upc'),
          brand: jsonLdString(product, 'brand'),
          size: jsonLdString(product, 'size'),
          images: jsonLdImages(product.image),
        });
      }
    } catch {
      // Malformed JSON-LD blocks are ignored — deterministic parsing only.
    }
  }

  return {
    jsonLdProducts,
    metaTitle: metaContent(html, 'property', 'og:title') ?? metaContent(html, 'name', 'title'),
    ogTitle: metaContent(html, 'property', 'og:title'),
    ogImage: metaContent(html, 'property', 'og:image'),
    canonicalUrl: linkHref(html, 'canonical'),
    metaDescription: metaContent(html, 'name', 'description'),
    metaKeywords: metaContent(html, 'name', 'keywords'),
  };
}

export interface ShopifyProductJson {
  /** Provenance belongs to this payload, not the HTML page that discovered it. */
  sourceArtifactId?: string | null;
  sourceContentHash?: string | null;
  sourcePath?: string;
  sourceUrl?: string;
  id: string | number;
  title: string;
  vendor: string | null;
  product_type: string | null;
  handle: string;
  variants: Array<{
    id: string | number;
    title: string;
    sku: string | null;
    /** Variant GTIN/barcode when the platform exposes one. */
    barcode?: string | null;
    available: boolean | null;
    option1: string | null;
    option2: string | null;
    option3: string | null;
  }>;
  images: Array<{ src: string; variant_ids: Array<string | number> }>;
  options: Array<{ name: string; values: string[] }> | null;
}

/** Map a /products/<handle> URL to its public product JSON endpoint. */
export function shopifyProductUrl(productUrl: string): string | null {
  try {
    const parsed = new URL(productUrl);
    const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
    if (!match) return null;
    return `${parsed.origin}/products/${match[1]}.js`;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, signal: AbortSignal, timeoutMs: number, fetchFn: NetworkFetch = fetch): Promise<{ value: unknown; contentHash: string; finalUrl: string }> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchFn(url, { headers: HTTP_EXTRACTION_HEADERS, redirect: 'follow', signal: combined });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const body = await response.text();
  return { value: JSON.parse(body), contentHash: sha256Hex(body), finalUrl: response.url || url };
}

/** Fetch Shopify's public product JSON (deterministic platform API). */
export async function fetchShopifyProductJson(url: string, signal: AbortSignal, timeoutMs: number, fetchFn: NetworkFetch = fetch): Promise<ShopifyProductJson> {
  const fetched = await fetchJson(url, signal, timeoutMs, fetchFn);
  const parsed = fetched.value as Partial<ShopifyProductJson>;
  if (typeof parsed.title !== 'string' || !Array.isArray(parsed.variants)) {
    throw new Error('Shopify product JSON missing expected fields');
  }
  return {
    id: parsed.id ?? '',
    title: parsed.title,
    vendor: parsed.vendor ?? null,
    product_type: parsed.product_type ?? null,
    handle: parsed.handle ?? '',
    variants: parsed.variants.map((variant) => ({
      id: variant.id ?? '',
      title: variant.title ?? '',
      sku: variant.sku ?? null,
      barcode: variant.barcode ?? null,
      available: variant.available ?? null,
      option1: variant.option1 ?? null,
      option2: variant.option2 ?? null,
      option3: variant.option3 ?? null,
    })),
    images: (parsed.images ?? []).map((image) => ({
      src: image.src,
      variant_ids: image.variant_ids ?? [],
    })),
    options: parsed.options ?? null,
    sourceContentHash: fetched.contentHash,
    sourcePath: 'Shopify product JSON payload',
    sourceUrl: fetched.finalUrl,
  };
}

export function parseWooCommerceStoreApi(
  html: string,
  finalUrl: string,
): {
  product: {
    name: string | null;
    sku: string | null;
    description: string | null;
    images: string[];
    attributes: Array<{ name: string; value: string }>;
  } | null;
  endpointUrl: string | null;
} {
  // Scan application/json scripts for embedded wc/store product payloads.
  const scriptBlocks = html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of scriptBlocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const product = candidates.find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          'id' in candidate &&
          ('name' in candidate || 'sku' in candidate),
      ) as Record<string, unknown> | undefined;
      if (product && typeof product.name === 'string') {
        const images = Array.isArray(product.images)
          ? product.images
              .map((img) => (typeof img === 'string' ? img : (img as { src?: unknown })?.src))
              .filter((src): src is string => typeof src === 'string')
          : [];
        const attributes = Array.isArray(product.attributes)
          ? product.attributes
              .filter((attr): attr is Record<string, unknown> => !!attr && typeof attr === 'object')
              .map((attr) => ({
                name: typeof attr.name === 'string' ? attr.name : '',
                // Store API shape: attributes carry `terms` (name/slug), not `value`.
                value: Array.isArray(attr.terms)
                  ? (attr.terms as Array<{ name?: unknown }>)
                      .map((term) => (typeof term?.name === 'string' ? term.name : ''))
                      .filter((name) => name.length > 0)
                      .join(', ')
                  : typeof attr.value === 'string'
                    ? attr.value
                    : '',
              }))
              .filter((attr) => attr.name.length > 0)
          : [];
        return {
          product: {
            name: product.name as string,
            sku: typeof product.sku === 'string' ? product.sku : null,
            description: typeof product.description === 'string' ? product.description : null,
            images,
            attributes,
          },
          endpointUrl: null,
        };
      }
    } catch {
      // Malformed JSON blocks are ignored — deterministic parsing only.
    }
  }
  const endpointUrl = (() => {
    try {
      return `${new URL(finalUrl).origin}/wp-json/wc/store/v1/products`;
    } catch {
      return null;
    }
  })();
  return { product: null, endpointUrl };
}

/** Recursive product-like object finder (title + sku/gtin/variants/handle). */
export function findProductLike(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductLike(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (node === null || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.title === 'string' && ('sku' in obj || 'gtin' in obj || 'variants' in obj || 'handle' in obj)) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    const found = findProductLike(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export interface NextData {
  props: Record<string, unknown> | null;
  pageProps: Record<string, unknown> | null;
  product: Record<string, unknown> | null;
}

/** Parse Next.js __NEXT_DATA__ application state (no RSC payloads yet). */
export function parseNextJsData(html: string): NextData {
  const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { props: null, pageProps: null, product: null };
  try {
    const parsed = JSON.parse(match[1]) as { props?: Record<string, unknown> };
    const props = parsed.props ?? null;
    const pageProps = (props?.pageProps as Record<string, unknown> | undefined) ?? null;
    const product = findProductLike(pageProps ?? props ?? {});
    return { props, pageProps, product };
  } catch {
    return { props: null, pageProps: null, product: null };
  }
}

export interface NuxtData {
  product: Record<string, unknown> | null;
}

/** Parse Nuxt hydration state — Nuxt 2 (window.__NUXT__) and Nuxt 3/4
 *  (__NUXT_DATA__ devalue-encoded array; plain objects inside decode to
 *  findProductLike-friendly records). */
export function parseNuxtData(html: string): NuxtData {
  const nuxt2 = html.match(/window\.__NUXT__=([\s\S]*?)<\/script>/);
  if (nuxt2) {
    try {
      const raw = nuxt2[1].replace(/;\s*$/, '');
      const parsed = JSON.parse(raw);
      return { product: findProductLike(parsed) };
    } catch {
      // fall through to the Nuxt 3/4 attempt
    }
  }
  const nuxt3 = html.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nuxt3) {
    try {
      const parsed = JSON.parse(nuxt3[1]);
      return { product: findProductLike(parsed) };
    } catch {
      return { product: null };
    }
  }
  return { product: null };
}

/** Normalize a GTIN-ish value from any product payload. */
export function gtinFromAny(obj: Record<string, unknown>): string | null {
  const raw = obj.gtin ?? obj.GTIN ?? obj.gtin13 ?? obj.gtin12 ?? obj.gtin8 ?? obj.gtin14 ?? obj.ean ?? obj.upc ?? obj.barcode;
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}
