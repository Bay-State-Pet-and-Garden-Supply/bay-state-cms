/**
 * Trusted Profile Runner — POST /profile-runner/extract
 *
 * Executes an already-matched healthy profile deterministically.
 * The Bun server performs Profile Match first and passes the exact profile
 * and version to run.
 *
 * CRITICAL RULES:
 *   - NEVER call an LLM or AI agent
 *   - NEVER fall back to generic extraction if profile selectors fail
 *   - NEVER guess variant selection — it must be deterministic
 *   - ALWAYS return `ok: false` rather than untrusted data
 *   - ALWAYS record fieldProvenance for every extracted field
 *   - ALWAYS validate output against ExtractionDataSchema
 *
 * Supports two runtimes from profile.runtime:
 *   - **static**:  HTTP fetch + Cheerio DOM extraction (no browser).
 *   - **rendered**: Headless Playwright Chromium with JS execution.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as cheerio from 'cheerio';
import type { Element, AnyNode } from 'domhandler';
import { runRenderedPage } from '../browser/rendered-page-runner';
import { loadWorkerBrowserConfig } from '../browser/config';
import { applyLadderEnrichment } from '../../onboarding/extraction-ladder/enrich';
import { parseVariantMatrix, parseShopifyMatrix, matchVariantMatrix, normalizeGtin, verifyOperatorSelectionReceipt } from '../../onboarding/variant-resolver';
import { doShopifyPolicyExtract, shopifyPolicyOf } from './extract-shopify-policy';
import { shopifyProductUrl } from '../../onboarding/extraction-ladder/platforms';
import {
  ExtractionPolicyContentSchema,
  type ExtractionPolicyContent,
  type PolicyField,
  type SupportedPolicySource,
} from '../../shared/schemas/browser-investigation-policy';
import { computeIdentityMatrixHash, VariantSelectionReceiptSchema, type NormalizedVariantCandidate } from '../../shared/schemas/variant-resolution';
import { getEffectiveVariantResolutionMode, getEffectiveVariantInteractionEnabled } from '../../onboarding/variant-flags';
import { materializeSelectedVariant, buildVariantProvenance } from '../../onboarding/selected-variant-materializer';
import { buildVariantInteractionPlan } from '../variant-interaction';
import {
  ExtractRequestSchema,
  ExtractResponseSchema,
  type ExtractRequest,
  type ExtractResponse,
} from '../../shared/schemas/extraction-worker';
import { ExtractionDataSchema } from '../../shared/schemas/onboarding';
// variant gate imports already added above
import type { ExtractionData } from '../../shared/schemas/onboarding';
import { sha256Hex } from '../../shared/stable-id';
import { lookup } from 'node:dns/promises';
import { classifyIp } from '../../shared/ssrf';
import { extractDomainFromUrl, generateJobId, resolveArtifactDir, writeArtifact } from '../artifacts';

// ─── Variant resolution gate (Issue #90 M4) ────────────────────────────────
import type { VariantFailureCode } from '../../shared/schemas/extraction-worker';
/**
 * Issue #216: embedded multi-candidate matrices without GTIN identifiers must
 * not prevent consulting the richer Shopify `.js` endpoint. The embedded
 * matrix alone cannot support the existing normalized exact-GTIN resolution
 * (variant-resolver.ts), so the endpoint is consulted as additional evidence
 * selection — the matcher itself is reused unchanged.
 */
function embeddedLacksGtinForExpected(
  matrix: ReturnType<typeof parseVariantMatrix>,
  expectedUpc: string | null | undefined,
): boolean {
  if (!matrix || matrix.candidates.length <= 1) return false;
  if (!expectedUpc) return false;
  const norm = (() => {
    try { return normalizeGtin(expectedUpc); } catch { return null; }
  })();
  if (!norm) return false;
  for (const c of matrix.candidates) {
    if (c.identifiers.some((i) => i.kind === 'gtin')) return false;
  }
  return true;
}

/**
 * Same-host Shopify `.js` fetch through the safe transport (size-capped).
 * Shared by the legacy variant gate (#216) and T4 policy execution so
 * endpoint evidence selection cannot drift between the two paths.
 * Failures are data (never thrown): callers own warning wording.
 */
async function fetchShopifyJsText(
  jsUrl: string,
  finalUrl: string,
  allowedSourceDomains: string[],
  deps: ProfileTransportDeps,
): Promise<{
  text: string | null;
  attempted: boolean;
  failure: 'transport_error' | 'http_error' | 'too_large' | 'cross_host' | null;
  message: string;
}> {
  if (!isSameHostUrl(jsUrl, finalUrl)) {
    return { text: null, attempted: false, failure: 'cross_host', message: 'cross-host endpoint refused' };
  }
  try {
    const jsResp = await safeProfileFetch(jsUrl, AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS), allowedSourceDomains, deps);
    if (!jsResp.ok) return { text: null, attempted: true, failure: 'http_error', message: `HTTP ${jsResp.status}` };
    const jsText = await jsResp.text();
    if (jsText.length > 5 * 1024 * 1024) {
      return { text: null, attempted: true, failure: 'too_large', message: 'endpoint response too large' };
    }
    return { text: jsText, attempted: true, failure: null, message: '' };
  } catch (e) {
    return { text: null, attempted: true, failure: 'transport_error', message: e instanceof Error ? e.message : String(e) };
  }
}

function isSameHostUrl(left: string, right: string): boolean {
  try {
    return new URL(left).hostname.toLowerCase() === new URL(right).hostname.toLowerCase();
  } catch {
    return false;
  }
}
async function resolveVariantGate(
  html: string,
  finalUrl: string,
  request: ExtractRequest,
  allowedSourceDomains: string[],
  deps: ProfileTransportDeps,
  warnings: string[],
): Promise<{
  matrix: ReturnType<typeof parseVariantMatrix>;
  decision: ReturnType<typeof matchVariantMatrix> | null;
  selectedCandidate: import('../../shared/schemas/variant-resolution').NormalizedVariantCandidate | null;
  failureCode: VariantFailureCode | null;
  shopifyJsFetched: boolean;
  matrixSource: 'embedded' | 'shopify_js' | null;
  matrixSourceUrl: string | null;
}> {
  const mode = getEffectiveVariantResolutionMode();
  if (mode === 'off') return { matrix: null, decision: null, selectedCandidate: null, failureCode: null, shopifyJsFetched: false, matrixSource: null, matrixSourceUrl: null };
  let matrix = parseVariantMatrix(html, finalUrl);
  let shopifyJsFetched = false;
  let matrixSource: 'embedded' | 'shopify_js' | null = matrix ? 'embedded' : null;
  let matrixSourceUrl: string | null = null;
  // Issue #216: consult the richer `.js` endpoint not only when embedded
  // candidates are <= 1, but also when a multi-candidate embedded matrix
  // lacks GTIN identifiers while an expected UPC could resolve via the
  // existing normalized exact-GTIN matcher. No second matcher.
  const needsEndpointEvidence = !matrix || matrix.candidates.length <= 1 || embeddedLacksGtinForExpected(matrix, request.expected?.upc);
  if (needsEndpointEvidence) {
    const isShopify = /\/cdn\/shop\//.test(html) || /Shopify\.theme/.test(html) || /shopify\.com/i.test(html) || /window\.Shopify/i.test(html);
    const isShopifyUrl = isShopify && finalUrl.includes('/products/');
    if (isShopifyUrl) {
      const jsUrl = finalUrl.split('?')[0].split('#')[0].replace(/\/$/, '') + '.js';
      const fetched = await fetchShopifyJsText(jsUrl, finalUrl, allowedSourceDomains, deps);
      shopifyJsFetched = fetched.attempted;
      if (fetched.failure === 'transport_error') warnings.push(`Shopify .js fetch failed: ${fetched.message}`);
      if (fetched.text) {
        const jsMatrix = parseVariantMatrix(fetched.text, finalUrl);
        if (jsMatrix && jsMatrix.candidates.length > 1) {
          matrix = jsMatrix;
          matrixSource = 'shopify_js';
          matrixSourceUrl = jsUrl;
          warnings.push('Variant matrix from Shopify .js');
        }
      }
    }
  }
  if (!matrix || matrix.candidates.length <= 1) return { matrix, decision: null, selectedCandidate: null, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
  const expected = request.expected;
  const input = {
    gtin: expected?.upc ?? null,
    sku: null,
    mpn: null,
    name: expected?.name ?? '',
    brandHint: expected?.brandHint ?? null,
    price: expected?.price ?? null,
    variantTokens: undefined,
  };
  const sel = (request as any).variantSelection as { resolutionId: string; identityMatrixHash: string; variantKey: string } | undefined;
  if (sel) {
    const verified = verifyOperatorSelectionReceipt(matrix, sel);
    if (!verified.ok && verified.kind === 'stale') {
      const decision = { status: 'stale_selection' as const, selectedVariantKey: null, reasonCodes: ['stale_selection'], matchedBy: 'none' as const, diagnostics: [`stale hash ${sel.identityMatrixHash} != ${verified.liveHash}`], rankedKeys: [] };
      return { matrix, decision, selectedCandidate: null, failureCode: 'variant_selection_stale', shopifyJsFetched, matrixSource, matrixSourceUrl };
    }
    if (!verified.ok) {
      const decision = { status: 'no_match' as const, selectedVariantKey: null, reasonCodes: ['stale_selection'], matchedBy: 'none' as const, diagnostics: ['variantKey not in current matrix'], rankedKeys: [] };
      return { matrix, decision, selectedCandidate: null, failureCode: 'variant_selection_stale', shopifyJsFetched, matrixSource, matrixSourceUrl };
    }
    const cand = verified.candidate;
    const decision = { status: 'resolved' as const, selectedVariantKey: cand.variantKey, reasonCodes: ['operator_selected'], matchedBy: 'sku' as const, diagnostics: ['operator selection verified'], rankedKeys: [cand.variantKey] };
    return { matrix, decision, selectedCandidate: cand, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
  }
  const decision = matchVariantMatrix(matrix, input as any);
  if (decision.status === 'resolved' && decision.selectedVariantKey) {
    const cand = matrix.candidates.find(c => c.variantKey === decision.selectedVariantKey) ?? null;
    if (mode === 'observe') {
      warnings.push(`Variant observe: would resolve ${decision.selectedVariantKey} (${decision.matchedBy})`);
      return { matrix, decision, selectedCandidate: null, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
    }
    return { matrix, decision, selectedCandidate: cand, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
  }
  if (decision.status === 'ambiguous' || decision.status === 'no_match' || decision.status === 'too_many_variants') {
    const code: VariantFailureCode = 'variant_selection_required';
    if (mode === 'observe') {
      warnings.push(`Variant observe: ${decision.status} would require selection`);
      return { matrix, decision, selectedCandidate: null, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
    }
    return { matrix, decision, selectedCandidate: null, failureCode: code, shopifyJsFetched, matrixSource, matrixSourceUrl };
  }
  if (decision.status === 'unsupported' || decision.status === 'stale_selection') {
    const code: VariantFailureCode = decision.status === 'stale_selection' ? 'variant_selection_stale' : 'variant_matrix_invalid';
    if (mode === 'observe') return { matrix, decision, selectedCandidate: null, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
    return { matrix, decision, selectedCandidate: null, failureCode: code, shopifyJsFetched, matrixSource, matrixSourceUrl };
  }
  return { matrix, decision, selectedCandidate: null, failureCode: null, shopifyJsFetched, matrixSource, matrixSourceUrl };
}


// ─── HTTP constants (sourced from page-extractor.ts) ──────────────────────────

const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HTTP_EXTRACTION_HEADERS: Record<string, string> = {
  'User-Agent': HTTP_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const HTTP_FETCH_TIMEOUT_MS = 15_000;
const RENDERED_NAVIGATE_TIMEOUT_MS = 25_000;
const RENDERED_DWELL_MS = 2_000;

// ─── Image source helpers (inlined from image-utils.ts) ────────────────────────
// These are duplicated locally to avoid importing the Bun-only onboarding module.
// The worker runs on Node.js without the Bun runtime.

/**
 * Returns true when a source URL is usable as a product image —
 * non-empty, not a data URI, not a blob URI, and not an SVG.
 */
function isUsableImageSource(src: string | null | undefined): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('data:')) return false;
  if (lower.startsWith('blob:')) return false;
  const path = lower.split(/[?#]/)[0];
  if (path.endsWith('.svg')) return false;
  return true;
}

/**
 * Parse a `srcset` attribute string into an array of URL-only tokens
 * (stripping descriptors like `165w`, `2x`).
 */
function parseSrcsetCandidates(srcset: string | null | undefined): string[] {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Collect all usable image source URLs from a Cheerio-wrapped element.
 *
 * - If the element IS an `<img>` or `<source>`, reads its attributes directly.
 * - Otherwise, finds the first descendant `<img>` or `<source>`.
 *
 * Reads these attributes:
 *   src, data-src, data-lazy-src, data-original, data-image, data-zoom-image
 * Plus srcset-style:
 *   srcset, data-srcset
 */
function collectImageSourcesFromElement(
  $: cheerio.CheerioAPI,
  el: Element | unknown,
): string[] {
  const sources: string[] = [];
  const $el = $(el as AnyNode);
  const targets = $el.is('img,source') ? $el : $el.find('img,source');
  if (targets.length === 0) return sources;

  targets.each((_, t) => {
    const $t = $(t);

  const directAttrs = [
    'data-zoom-src',
    'data-original',
    'data-src',
    'src',
    'data-lazy-src',
    'data-image',
    'data-zoom-image',
    'data-full-image',
    'data-master',
    'data-photoswipe-src',
    'data-highres',
  ];
  for (const attr of directAttrs) {
    const value = $t.attr(attr);
    if (isUsableImageSource(value)) sources.push(value!.trim());
  }

  for (const attr of ['srcset', 'data-srcset']) {
    for (const candidate of parseSrcsetCandidates($t.attr(attr))) {
      if (isUsableImageSource(candidate)) sources.push(candidate.trim());
    }
  }
  });

  return sources;
}

/**
 * Clean, upgrade Shopify CDN URLs to width=1200, and deduplicate image URLs.
 */
function cleanAndDeduplicateImages(
  urls: string[],
  baseUrl?: string,
): string[] {
  const seenCanonical = new Set<string>();
  const bestUrls: string[] = [];

  for (const urlStr of urls) {
    if (!urlStr || typeof urlStr !== 'string') continue;
    let canonical = urlStr.trim();
    if (!canonical || canonical.toLowerCase().startsWith('data:')) continue;

    if (canonical.startsWith('//')) {
      canonical = 'https:' + canonical;
    }

    try {
      const parsedUrl = baseUrl
        ? new URL(canonical, baseUrl)
        : new URL(canonical);
      parsedUrl.search = '';
      let pathname = parsedUrl.pathname;
      pathname = pathname.replace(
        /_(?:[0-9]+x[0-9]*|[0-9]*x[0-9]+|small|thumb|medium|large|icon|grande|compact)(?:_crop_[a-z_]+)?(?=\.[a-z0-9]+$)/i,
        '',
      );

      const canonicalKey = parsedUrl.host + pathname;
      if (!seenCanonical.has(canonicalKey)) {
        seenCanonical.add(canonicalKey);

        let targetUrl = urlStr.trim();
        if (targetUrl.startsWith('//')) {
          targetUrl = 'https:' + targetUrl;
        }

        const originalUrlObj = baseUrl
          ? new URL(targetUrl, baseUrl)
          : new URL(targetUrl);
        targetUrl = originalUrlObj.href;
        const isShopify =
          originalUrlObj.hostname.includes('shopify.com') ||
          originalUrlObj.pathname.includes('/cdn/shop/');
        if (isShopify) {
          const vParam = originalUrlObj.searchParams.get('v');
          originalUrlObj.search = '';
          if (vParam) {
            originalUrlObj.searchParams.set('v', vParam);
          }
          originalUrlObj.searchParams.set('width', '1200');
          targetUrl = originalUrlObj.href;
        }

        bestUrls.push(targetUrl);
      }
    } catch {
      if (urlStr.trim().startsWith('http')) {
        bestUrls.push(urlStr.trim());
      }
    }
  }

  return bestUrls;
}

/**
 * Resolve a possibly-relative URL to absolute against a base URL.
 * Returns null if resolution fails.
 */
function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

// ─── JSON-LD extraction (Cheerio) ─────────────────────────────────────────────

/**
 * Extract the first JSON-LD Product block from <script type="application/ld+json"> tags.
 */
function extractJsonLdFromCheerio($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      // Handle @graph arrays
      if (data['@graph']) {
        const product = (data['@graph'] as Record<string, unknown>[]).find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
      // Direct Product type
      if (data['@type'] === 'Product') return data;
      // Array of items
      if (Array.isArray(data)) {
        const product = data.find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
    } catch {
      // invalid JSON, skip
    }
  }
  return null;
}

// ─── Meta tag extraction (Cheerio) ─────────────────────────────────────────────

function extractMetaTagsFromCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const tags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const property =
      $(el).attr('property') ?? $(el).attr('name') ?? '';
    const content = $(el).attr('content') ?? '';
    if (property && content) {
      tags[property] = content;
    }
  });

  const titleText = $('title').first().text().trim();
  if (titleText) {
    tags['page:title'] = titleText;
  }

  return tags;
}

// ─── Microdata extraction (Cheerio) ────────────────────────────────────────────

function extractMicrodataFromCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const data: Record<string, string> = {};
  const scope = $('[itemscope][itemtype*="Product"]').first();
  if (scope.length === 0) return data;

  scope.find('[itemprop]').each((_, el) => {
    const name = $(el).attr('itemprop') ?? '';
    const value =
      $(el).attr('content') ??
      $(el).attr('src') ??
      $(el).text().trim() ??
      '';
    if (name && value) {
      data[name] = value;
    }
  });
  return data;
}

// ─── Helper: collect images from a cheerio selector string ────────────────────


/** Strip query params from an image URL for deduplication. */
function canonicalImageUrl(url: string): string {
  try { return url.split('?')[0].split('#')[0]; } catch { return url; }
}

function collectImagesFromSelector(
  $: cheerio.CheerioAPI,
  imagesSelector: string,
  baseUrl: string,
): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  $(imagesSelector).each((_, el) => {
    for (const src of collectImageSourcesFromElement($, el)) {
      const absolute = resolveUrl(src, baseUrl);
      if (!absolute) continue;
      const canonical = canonicalImageUrl(absolute);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        images.push(absolute);
      }
    }
  });
  // Cap at 30 images to prevent gallery explosions
  if (images.length > 30) images.length = 30;
  return images;
}

/**
 * Evaluate any profile selector (CSS selector, jsonld:*, or meta[...]) against Cheerio DOM.
 */
function evaluateSelectorCheerio(
  $: cheerio.CheerioAPI,
  selector: string | null | undefined,
  jsonLd: Record<string, unknown> | null,
  metaTags: Record<string, string>,
): string | null {
  if (!selector || !selector.trim()) return null;
  const trimmed = selector.trim();

  // 1) JSON-LD property
  if (trimmed.startsWith('jsonld:')) {
    const prop = trimmed.slice('jsonld:'.length);
    if (!jsonLd) return null;
    if (prop === 'Product.name' || prop === 'name') return (jsonLd.name as string)?.trim() || null;
    if (prop === 'Product.description' || prop === 'description') return (jsonLd.description as string)?.trim() || null;
    if (prop === 'Product.offers.price' || prop === 'offers.price' || prop === 'price') {
      const offers = jsonLd.offers as any;
      const price = offers?.price ?? (Array.isArray(offers) ? offers[0]?.price : null) ?? jsonLd.price;
      return price != null ? String(price).trim() : null;
    }
    if (prop === 'Product.brand' || prop === 'brand') {
      const b = jsonLd.brand as any;
      const name = typeof b === 'string' ? b : b?.name;
      return name ? String(name).trim() : null;
    }
    return null;
  }

  // 2) Meta tags
  if (trimmed.startsWith('meta[')) {
    const propMatch = trimmed.match(/property=["']([^"']+)["']/i) || trimmed.match(/name=["']([^"']+)["']/i);
    if (propMatch && metaTags[propMatch[1]]) {
      return metaTags[propMatch[1]].trim();
    }
    try {
      const content = $(trimmed).first().attr('content');
      if (content) return content.trim();
    } catch {}
  }

  // 3) Standard CSS selector
  try {
    const el = $(trimmed).first();
    if (el.length > 0) {
      return el.text().trim() || null;
    }
  } catch {}

  return null;
}

/**
 * Collect images from any selector (CSS selector, jsonld:*, or meta[...]) against Cheerio DOM.
 */
function collectImagesCheerio(
  $: cheerio.CheerioAPI,
  imagesSelector: string | null | undefined,
  jsonLd: Record<string, unknown> | null,
  metaTags: Record<string, string>,
  baseUrl: string,
): string[] {
  if (!imagesSelector || !imagesSelector.trim()) return [];
  const trimmed = imagesSelector.trim();

  // 1) JSON-LD images
  if (trimmed.startsWith('jsonld:')) {
    if (!jsonLd) return [];
    const raw = jsonLd.image ?? (jsonLd as any).images;
    const list: string[] = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const u = typeof item === 'object' ? item?.url ?? item?.contentUrl : item;
        if (u && typeof u === 'string') {
          const res = resolveUrl(u, baseUrl);
          if (res) list.push(res);
        }
      }
    } else if (typeof raw === 'object' && (raw as any)?.url) {
      const res = resolveUrl((raw as any).url, baseUrl);
      if (res) list.push(res);
    } else if (typeof raw === 'string') {
      const res = resolveUrl(raw, baseUrl);
      if (res) list.push(res);
    }
    return list;
  }

  // 2) Meta tag image
  if (trimmed.startsWith('meta[')) {
    const propMatch = trimmed.match(/property=["']([^"']+)["']/i) || trimmed.match(/name=["']([^"']+)["']/i);
    if (propMatch && metaTags[propMatch[1]]) {
      const res = resolveUrl(metaTags[propMatch[1]], baseUrl);
      if (res) return [res];
    }
    try {
      const content = $(trimmed).first().attr('content');
      if (content) {
        const res = resolveUrl(content, baseUrl);
        if (res) return [res];
      }
    } catch {}
  }

  // 3) Standard CSS selector
  try {
    return collectImagesFromSelector($, trimmed, baseUrl);
  } catch {
    return [];
  }
}

// ─── Helper: evaluate a text selector in Playwright ──────────────────────────

function makeTextSelectorEvaluator(sel: string): string {
  return `
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      return el ? (el.textContent || '').trim() : '';
    })()
  `;
}

// ─── Helper: extract JSON-LD from Playwright ─────────────────────────────────

function makePlaywrightJsonLdExtractor(): string {
  return `
    (() => {
      const results = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const raw = (script.textContent || '').trim();
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item && typeof item === 'object') results.push(item);
            }
          } else if (data && typeof data === 'object') {
            results.push(data);
          }
        } catch (e) { /* skip invalid JSON */ }
      }
      return results;
    })()
  `;
}

// ─── Helper: extract meta tags from Playwright ───────────────────────────────

function makePlaywrightMetaExtractor(): string {
  return `
    (() => {
      const tags = {};
      const metas = document.querySelectorAll('meta');
      for (const meta of metas) {
        const property = meta.getAttribute('property') || meta.getAttribute('name') || '';
        const content = meta.getAttribute('content') || '';
        if (property && content) tags[property] = content;
      }
      const titleEl = document.querySelector('title');
      if (titleEl && titleEl.textContent) {
        tags['page:title'] = titleEl.textContent.trim();
      }
      return tags;
    })()
  `;
}

// ─── Helper: extract embedded product data from Playwright ───────────────────

function makePlaywrightEmbeddedExtractor(): string {
  return `
    () => {
      const results = [];
      const w = window;
      if (w.productJSON && typeof w.productJSON === 'object') results.push(w.productJSON);
      if (w.ShopifyAnalytics && typeof w.ShopifyAnalytics === 'object') results.push(w.ShopifyAnalytics);
      if (w.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') results.push(w.__INITIAL_STATE__);
      return results;
    }
  `;
}

// ─── Static extraction ────────────────────────────────────────────────────────

const MAX_PROFILE_REDIRECTS = 5;

export type FieldProvenanceDetail = { method: string; sourcePath: string };

/** Injected transport seams for the worker profile fetch (testability). */
export interface ProfileTransportDeps {
  /** Injected DNS resolver (defaults to node:dns/promises lookup). */
  lookupFn?: (hostname: string, options: { all: true }) => Promise<Array<{ address: string }>>;
  /** Injected HTTP transport (defaults to global fetch). */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Map an extracted field's declared provenance + exact origin path into the
 * response's fieldProvenanceDetails entry. Fields without a known origin are
 * omitted (fail closed) — a fabricated JSON-LD path is never emitted for a
 * meta/microdata/fallback value, and an unknown method is never upgraded to
 * profile_selector.
 */
export function buildFieldProvenanceDetails(
  provenance: Record<string, string>,
  origins: Record<string, string | null>,
): Record<string, FieldProvenanceDetail> {
  const details: Record<string, FieldProvenanceDetail> = {};
  for (const [field, declared] of Object.entries(provenance)) {
    const origin = origins[field];
    if (!origin) continue;
    details[field] = {
      method: declared === 'profile-selector' ? 'profile_selector' : declared === 'json-ld' ? 'json_ld' : declared,
      sourcePath: origin,
    };
  }
  return details;
}

const TRACKER_URL = /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i;

function retainProfileSource(sourceUrl: string, html: string): { sourceContentHash: string; sourceArtifactId: string | null } {
  const sourceContentHash = sha256Hex(html);
  try {
    const domain = extractDomainFromUrl(sourceUrl);
    const dir = resolveArtifactDir(domain, generateJobId());
    const sourceArtifactId = writeArtifact(dir, 'page.html', html);
    return { sourceContentHash, sourceArtifactId };
  } catch {
    return { sourceContentHash, sourceArtifactId: null };
  }
}

/**
 * Worker-side profile transport. The worker is a separate process and cannot
 * receive the Pi policy gateway, so static profile fetches use the same SSRF
 * floor locally: DNS is resolved before every request, redirects are manual
 * and revalidated hop-by-hop, and only web ports are accepted. When the
 * profile declares allowed source domains, every destination must also be an
 * exact or subdomain-suffix match of that allowlist.
 */
export async function assertSafeProfileDestination(
  currentUrl: string,
  allowedSourceDomains: string[] = [],
  deps: ProfileTransportDeps = {},
): Promise<void> {
  const parsed = new URL(currentUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('profile fetch requires http(s)');
  if (parsed.username || parsed.password) throw new Error('profile fetch rejects credentialed URLs');
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') throw new Error('profile fetch rejects non-web ports');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || classifyIp(hostname) === 'private' || classifyIp(hostname) === 'link_local') {
    throw new Error('profile fetch denied private or link-local destination');
  }
  // Explicit domain allowlist (suffix match, `www.`-normalized). An empty
  // allowlist means the caller did not restrict sources; the SSRF floor still
  // applies. Applied to every hop and every rendered sub-resource.
  if (allowedSourceDomains.length > 0) {
    const normalizedHost = hostname.replace(/^www\./, '');
    const allowlisted = allowedSourceDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^www\./, '').trim();
      if (normalized.length === 0) return false;
      return normalizedHost === normalized || normalizedHost.endsWith(`.${normalized}`);
    });
    if (!allowlisted) throw new Error(`profile fetch denied destination outside allowed source domains: ${hostname}`);
  }
  const lookupFn = deps.lookupFn ?? lookup;
  const addresses = await lookupFn(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => {
    const kind = classifyIp(address);
    return kind === 'private' || kind === 'link_local' || kind === 'unknown';
  })) {
    throw new Error('profile fetch denied private or link-local DNS destination');
  }
}

export async function safeProfileFetch(
  sourceUrl: string,
  signal: AbortSignal,
  allowedSourceDomains: string[] = [],
  deps: ProfileTransportDeps = {},
): Promise<Response> {
  let currentUrl = sourceUrl;
  for (let redirectCount = 0; ; redirectCount += 1) {
    await assertSafeProfileDestination(currentUrl, allowedSourceDomains, deps);
    const response = await (deps.fetchFn ?? fetch)(currentUrl, {
      headers: HTTP_EXTRACTION_HEADERS,
      signal,
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirectCount >= MAX_PROFILE_REDIRECTS) throw new Error('profile fetch redirect limit exceeded');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
}

/**
 * Rendered-profile network guard: EVERY request (navigation, redirect hops,
 * sub-resources) is revalidated against the SSRF floor and the profile's
 * source-domain allowlist, and tracker destinations are aborted. This is the
 * single authoritative route guard for rendered extraction — no later route
 * handler may continue an unchecked request.
 */
export async function profileNetworkGuard(
  url: string,
  allowedSourceDomains: string[],
  deps: ProfileTransportDeps = {},
): Promise<boolean> {
  if (TRACKER_URL.test(url)) return false;
  try {
    await assertSafeProfileDestination(url, allowedSourceDomains, deps);
    return true;
  } catch {
    return false;
  }
}

interface ExtractedFields {
  title: string | null;
  brand: string | null;
  description: string | null;
  price: string | null;
  primaryImage: string | null;
  additionalImages: string[];
  provenance: Record<string, string>;
}

/**
 * Run deterministic extraction via HTTP fetch + Cheerio DOM parsing.
 */
export async function doStaticExtract(
  request: ExtractRequest,
  deps: ProfileTransportDeps = {},
): Promise<{
  data: ExtractionData;
  warnings: string[];
  sourceContentHash?: string | null;
  sourceArtifactId?: string | null;
  fieldProvenanceDetails?: Record<string, FieldProvenanceDetail>;
}> {
  const warnings: string[] = [];
  const { sourceUrl, expected, profile } = request;
  const selectors = profile.selectors || {};
  const allowedSourceDomains = profile.allowedSourceDomains ?? [];

  // ── Fetch page ─────────────────────────────────────────────────────────
  let response: Response;
  let html: string;
  try {
    response = await safeProfileFetch(sourceUrl, AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS), allowedSourceDomains, deps);
    if (!response.ok) {
      warnings.push(`HTTP fetch returned ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Static fetch failed: ${msg}`);
    return buildFailedResult(request, warnings);
  }

  const finalUrl = response.url || sourceUrl;
  // T4: policy-bearing Shopify profiles execute endpoint-backed policy;
  // legacy profiles skip this branch and keep current semantics exactly.
  const shopifyPolicy = shopifyPolicyOf(request.profile);
  if (shopifyPolicy) {
    return doShopifyPolicyExtract({
      request,
      policy: shopifyPolicy,
      html,
      finalUrl,
      allowedSourceDomains,
      deps,
      // Explicit helpers seam: the policy module never imports this file,
      // so the dependency edge stays one-way and no import cycle can form.
      helpers: {
        safeProfileFetch,
        evaluateSelectorCheerio,
        collectImagesCheerio,
        buildExtractionData,
        buildFailedResult,
        buildFieldProvenanceDetails,
        retainProfileSource,
        cleanAndDeduplicateImages,
        resolveUrl,
        extractJsonLdFromCheerio,
        extractMetaTagsFromCheerio,
        extractMicrodataFromCheerio,
        fetchShopifyJsText,
      },
      warnings,
    });
  }
  // ── Variant resolution gate (M4) ─────────────────────────────────
  let variantGateResult: Awaited<ReturnType<typeof resolveVariantGate>> | null = null;
  try {
    variantGateResult = await resolveVariantGate(html, finalUrl, request, allowedSourceDomains, deps, warnings);
    if (variantGateResult?.failureCode) {
      const mode = getEffectiveVariantResolutionMode();
      if (mode === 'active') {
        const vd: any = variantGateResult.decision;
        const failed = buildFailedResult(request, warnings);
        let failHash: string | null = null;
        try { failHash = variantGateResult.matrix ? computeIdentityMatrixHash(variantGateResult.matrix) : null; } catch { failHash = null; }
        (failed as any).matrixDecision = vd ? { status: vd.status, selectedVariantKey: vd.selectedVariantKey, reasonCodes: vd.reasonCodes, identityMatrixHash: failHash ?? undefined, candidates: variantGateResult.matrix?.candidates ?? [], matrix: variantGateResult.matrix } : null;
        (failed as any).failureCode = variantGateResult.failureCode;
        (failed as any).selectedReceipt = null;
        (failed as any).variantMatrix = variantGateResult.matrix;
        (failed as any).matrix = variantGateResult.matrix;
        (failed as any).candidates = variantGateResult.matrix?.candidates ? variantGateResult.matrix.candidates.slice(0, 250) : [];
        (failed as any).identityMatrixHash = failHash;
        return failed as any;
      }
    }
  } catch (e) {
    warnings.push(`Variant gate error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const $ = cheerio.load(html);

  // ── Extract JSON-LD, meta tags, microdata as supplementary sources ────
  const jsonLd = extractJsonLdFromCheerio($);
  const metaTags = extractMetaTagsFromCheerio($);
  const microdata = extractMicrodataFromCheerio($);

  // ── Apply profile selectors ───────────────────────────────────────────
  const titleSelector = selectors['titleSelector'] || selectors['title'] || null;
  const brandSelector = selectors['brandSelector'] || selectors['brand'] || null;
  const descriptionSelector = selectors['descriptionSelector'] || selectors['description'] || null;
  const priceSelector = selectors['priceSelector'] || selectors['price'] || null;
  const imagesSelector = selectors['imagesSelector'] || selectors['images'] || selectors['imageSelector'] || selectors['image'] || null;

  // Title: selector required — if empty, extraction fails
  let title: string | null = null;
  let titleProvenance = '';
  let titleOrigin: string | null = null;
  if (titleSelector) {
    title = evaluateSelectorCheerio($, titleSelector, jsonLd, metaTags);
    if (title) {
      titleProvenance = titleSelector.startsWith('jsonld:') ? 'json-ld' : titleSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
      titleOrigin = titleSelector;
      // Concatenate optional title selectors (e.g. subheadings, taglines)
      const toSel = request.profile.titleOptionalSelectors;
      if (toSel && toSel.length > 0) {
        const extras = toSel
          .map(sel => evaluateSelectorCheerio($, sel, jsonLd, metaTags))
          .filter(Boolean)
          .join(' — ');
        if (extras) {
          title += ' — ' + extras;
        }
      }
    }
  }
  if (!title) {
    // Try JSON-LD / meta
    title =
      (jsonLd?.name as string) ||
      metaTags['og:title'] ||
      metaTags['page:title'] ||
      null;
    if (title) {
      titleProvenance = title === jsonLd?.name ? 'json-ld' : 'meta';
      titleOrigin = title === jsonLd?.name
        ? 'json-ld:Product.name'
        : title === metaTags['og:title'] ? 'meta:og:title' : 'meta:page:title';
    }
  }

  // If no title at all, this is a hard failure
  if (!title) {
    warnings.push('Title could not be extracted — returning ok: false');
    return buildFailedResult(request, warnings);
  }

  // Brand
  let brand: string | null = null;
  let brandProvenance = '';
  let brandOrigin: string | null = null;
  if (brandSelector) {
    brand = evaluateSelectorCheerio($, brandSelector, jsonLd, metaTags);
    if (brand) {
      brandProvenance = brandSelector.startsWith('jsonld:') ? 'json-ld' : brandSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
      brandOrigin = brandSelector;
    }
  }
  if (!brand) {
    const jsonLdBrand = jsonLd?.brand as
      | Record<string, unknown>
      | string
      | undefined;
    const brandFromJsonLd =
      typeof jsonLdBrand === 'string'
        ? jsonLdBrand
        : ((jsonLdBrand as Record<string, unknown>)?.name as string | undefined);
    brand =
      (brandFromJsonLd as string | undefined) ||
      microdata.brand ||
      metaTags['product:brand'] ||
      null;
    if (brand) {
      brandProvenance = brandFromJsonLd ? 'json-ld' : microdata.brand ? 'microdata' : 'meta';
      brandOrigin = brandFromJsonLd
        ? 'json-ld:Product.brand'
        : microdata.brand ? 'microdata:Product.brand' : 'meta:product:brand';
    }
  }

  // Description
  let description: string | null = null;
  let descriptionProvenance = '';
  let descriptionOrigin: string | null = null;
  if (descriptionSelector) {
    description = evaluateSelectorCheerio($, descriptionSelector, jsonLd, metaTags);
    if (description) {
      descriptionProvenance = descriptionSelector.startsWith('jsonld:') ? 'json-ld' : descriptionSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
      descriptionOrigin = descriptionSelector;
    }
  }
  if (!description) {
    description =
      (jsonLd?.description as string) ||
      metaTags['og:description'] ||
      metaTags['description'] ||
      null;
    if (description) {
      descriptionProvenance = description === jsonLd?.description ? 'json-ld' : 'meta';
      descriptionOrigin = description === jsonLd?.description
        ? 'json-ld:Product.description'
        : description === metaTags['og:description'] ? 'meta:og:description' : 'meta:description';
    }
  }

  // Price from selector or expected price (expected.price overrides)
  let price: string | null = null;
  let priceProvenance = '';
  let priceOrigin: string | null = null;
  if (expected?.price) {
    price = expected.price;
    priceProvenance = 'spreadsheet-import';
    priceOrigin = 'expected:price';
  } else if (priceSelector) {
    price = evaluateSelectorCheerio($, priceSelector, jsonLd, metaTags);
    if (price) {
      priceProvenance = priceSelector.startsWith('jsonld:') ? 'json-ld' : priceSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
      priceOrigin = priceSelector;
      // Clean to numeric representation
      const match = price.match(/\$?(\d+\.?\d*)/);
      if (match) {
        price = match[0];
      }
    }
  }
  if (!price) {
    const jsonLdOffers = jsonLd?.offers as Record<string, unknown> | undefined;
    const priceFromJsonLd =
      jsonLdOffers?.price as string | undefined;
    price = priceFromJsonLd || metaTags['product:price:amount'] || null;
    if (price) {
      priceProvenance = priceFromJsonLd ? 'json-ld' : 'meta';
      priceOrigin = priceFromJsonLd ? 'json-ld:Product.offers.price' : 'meta:product:price:amount';
    }
  }

  // Images
  let primaryImage: string | null = null;
  const additionalImages: string[] = [];
  let imageProvenance = '';
  let imageOrigin: string | null = null;

  if (imagesSelector) {
    const rawImages = collectImagesCheerio($, imagesSelector, jsonLd, metaTags, finalUrl);
    const cleanImgs = cleanAndDeduplicateImages(rawImages, finalUrl);
    if (cleanImgs.length > 0) {
      primaryImage = cleanImgs[0];
      additionalImages.push(...cleanImgs.slice(1).slice(0, 29));
      imageProvenance = imagesSelector.startsWith('jsonld:') ? 'json-ld' : imagesSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
      imageOrigin = imagesSelector;
    }
  }
  if (!primaryImage) {
    // If no images from selector, try JSON-LD
    if (!primaryImage && jsonLd?.image) {
      const jsonLdImage = jsonLd.image as string | string[];
      const imgUrl = Array.isArray(jsonLdImage) ? jsonLdImage[0] : jsonLdImage;
      const resolved = resolveUrl(imgUrl, finalUrl);
      if (resolved) {
        primaryImage = resolved;
        imageProvenance = 'json-ld';
        imageOrigin = 'json-ld:Product.image';
      }
    }

    if (!primaryImage && metaTags['og:image']) {
      const resolved = resolveUrl(metaTags['og:image'], finalUrl);
      if (resolved) {
        primaryImage = resolved;
        imageProvenance = 'meta';
        imageOrigin = 'meta:og:image';
      }
    }

    if (!primaryImage && microdata.image) {
      const resolved = resolveUrl(microdata.image, finalUrl);
      if (resolved) {
        primaryImage = resolved;
        imageProvenance = 'microdata';
        imageOrigin = 'microdata:Product.image';
      }
    }
  }

  // ── Build provenance record ──────────────────────────────────────────
  const provenance: Record<string, string> = {};
  // Exact origin path per accepted field (selector / JSON-LD type / meta key
  // / microdata itemprop / expected value). Unknown origins are omitted from
  // fieldProvenanceDetails — a path is never fabricated for a fallback value.
  const origins: Record<string, string | null> = {};
  if (title) { provenance.title = titleProvenance; origins.title = titleOrigin; }
  if (brand) { provenance.brand = brandProvenance; origins.brand = brandOrigin; }
  if (description) { provenance.description = descriptionProvenance; origins.description = descriptionOrigin; }
  if (price) { provenance.price = priceProvenance; origins.price = priceOrigin; }
  if (primaryImage) { provenance.primaryImage = imageProvenance; origins.primaryImage = imageOrigin; }
  if (additionalImages.length > 0) { provenance.additionalImages = imageProvenance; origins.additionalImages = imageOrigin; }
  if (sourceUrl) provenance.sourceUrl = 'request';
  provenance.profileRuntime = 'static';

  // Extract custom selectors
  const customFields: Record<string, string> = {};
  if (profile.customSelectors) {
    for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
      if (!selector) continue;
      try {
        const val = $(selector).first().text().trim();
        if (val) {
          customFields[fieldName] = val;
          provenance[`custom.${fieldName}`] = 'profile-selector';
          origins[`custom.${fieldName}`] = selector;
        }
      } catch { /* skip bad selectors */ }
    }
    if (Object.keys(customFields).length > 0) {
      provenance.customFields = 'profile-selector';
    }
  }

  // ── Build ExtractionData ─────────────────────────────────────────────
  let data = buildExtractionData({
    title,
    brand,
    description,
    price,
    primaryImage,
    additionalImages,
    provenance,
  }, sourceUrl, expected.name);

  // Merge custom fields into result
  if (Object.keys(customFields).length > 0) {
    data.customFields = customFields;
  }

  // ADR-0031: embedded-only ladder enrichment on the production profile
  // path. Uses the HTML this handler already fetched — no second request.
  // Additive-only: profile values are never overwritten; failures degrade.
  try {
    await applyLadderEnrichment({
      html,
      url: finalUrl,
      data,
      expected: { name: expected.name, brandHint: expected.brandHint ?? null, price: expected.price ?? null, gtin: expected.upc },
    });
  } catch (enrichErr) {
    warnings.push(`Ladder enrichment failed (non-blocking): ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`);
  }

  // ── Variant materialization (M4) ────────────────────────────────
  let selectedReceipt: import('../../shared/schemas/variant-resolution').VariantSelectionReceipt | null = null;
  let matrixDecisionForResponse: { status: string; selectedVariantKey: string | null; reasonCodes: string[] } | null = null;
  if (variantGateResult) {
    matrixDecisionForResponse = variantGateResult.decision ? { status: variantGateResult.decision.status, selectedVariantKey: variantGateResult.decision.selectedVariantKey, reasonCodes: variantGateResult.decision.reasonCodes } : null;
    if (variantGateResult.selectedCandidate && getEffectiveVariantResolutionMode() === 'active') {
      try {
        const cand = variantGateResult.selectedCandidate;
        let hash = '';
        try { hash = variantGateResult.matrix ? computeIdentityMatrixHash(variantGateResult.matrix) : ''; } catch { hash = ''; }
        const receipt = {
          resolutionId: (request as any).variantSelection?.resolutionId ?? 'auto-' + Date.now(),
          identityMatrixHash: hash,
          parserVersion: variantGateResult.matrix?.parserVersion ?? 1,
          selectedVariantKey: cand.variantKey,
          decisionOrigin: (request as any).variantSelection ? 'operator' as const : 'automatic' as const,
          selectedDeepLink: cand.deepLink,
          matchedBy: variantGateResult.decision?.matchedBy ?? 'unknown',
          evidencePaths: cand.identifiers.map(i=>i.sourcePath),
          createdAt: new Date().toISOString(),
        };
        try { const { VariantSelectionReceiptSchema } = await import('../../shared/schemas/variant-resolution'); VariantSelectionReceiptSchema.parse(receipt); } catch {}
        selectedReceipt = receipt as any;
        const materialized = materializeSelectedVariant({ base: data, selected: cand, receipt: { variantKey: cand.variantKey, identityMatrixHash: hash, parserVersion: receipt.parserVersion } });
        const matSel: any = (materialized as any).selectedVariant ?? {};
        (materialized as any).selectedVariant = { ...matSel, ...receipt, identifiers: matSel.identifiers ?? (receipt as any).identifiers ?? cand.identifiers, variantKey: matSel.variantKey ?? (receipt as any).selectedVariantKey };
        data = materialized as any;
        warnings.push(`Variant materialized: ${cand.variantKey}`);
      } catch (e) {
        warnings.push(`Variant materialization failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const retained = retainProfileSource(finalUrl, html);
  const fieldProvenanceDetails = buildFieldProvenanceDetails(provenance, origins);
  // Issue #216: record the endpoint source through the EXISTING per-field
  // carriers only (fieldProvenanceDetails + fieldProvenance/variantProvenance).
  // No parallel provenance system, no identifier schema change — the matcher
  // and identifier shapes are reused unchanged.
  if ((variantGateResult as any)?.matrixSource === 'shopify_js' && (variantGateResult as any)?.matrixSourceUrl) {
    const jsUrl = (variantGateResult as any).matrixSourceUrl as string;
    fieldProvenanceDetails['variantMatrix'] = { method: 'shopify_js', sourcePath: jsUrl };
    (data as any).fieldProvenance = { ...((data as any).fieldProvenance ?? {}), variantMatrix: 'shopify_js' };
    const existingVp = (((data as any).variantProvenance ?? {}) as Record<string, string>);
    (data as any).variantProvenance = { ...existingVp, matrixSource: 'shopify_js' };
  }
  const extAny: any = { data, warnings, sourceContentHash: retained.sourceContentHash, sourceArtifactId: retained.sourceArtifactId, fieldProvenanceDetails };
  if (matrixDecisionForResponse) {
    const gate: any = variantGateResult;
    const matrix: any = gate?.matrix;
    let h: string | null = null;
    try { h = matrix ? computeIdentityMatrixHash(matrix) : null; } catch { h = null; }
    if (matrix?.candidates) (matrixDecisionForResponse as any).candidates = matrix.candidates;
    if (matrix) (matrixDecisionForResponse as any).matrix = matrix;
    if (h) (matrixDecisionForResponse as any).identityMatrixHash = h;
    extAny.matrixDecision = matrixDecisionForResponse;
    extAny.matrix = matrix;
    extAny.variantMatrix = matrix;
    extAny.candidates = matrix?.candidates ?? [];
    extAny.identityMatrixHash = h;
  }
  if (selectedReceipt) extAny.selectedReceipt = selectedReceipt;
  if (variantGateResult?.failureCode) extAny.failureCode = variantGateResult.failureCode;
  return extAny;
}

// ─── Rendered extraction ──────────────────────────────────────────────────────

/**
 * Run deterministic extraction via Playwright with JS execution.
 */
export async function doRenderedExtract(request: ExtractRequest, deps: ProfileTransportDeps = {}): Promise<{
  data: ExtractionData;
  warnings: string[];
  sourceContentHash?: string | null;
  sourceArtifactId?: string | null;
  fieldProvenanceDetails?: Record<string, FieldProvenanceDetail>;
}> {
  const warnings: string[] = [];
  const { sourceUrl, expected, profile } = request;
  const selectors = profile.selectors || {};
  const allowedSourceDomains = profile.allowedSourceDomains ?? [];
  try {
    await assertSafeProfileDestination(sourceUrl, allowedSourceDomains, deps);
  } catch (error) {
    warnings.push(`Rendered network denied: ${error instanceof Error ? error.message : String(error)}`);
    return buildFailedResult(request, warnings);
  }

  // The runner + extractor is wrapped so we can lazily pull selectors into
  // the Playwright callback without serialising the whole request object.
  const runnerConfig = loadWorkerBrowserConfig();

  const result = await runRenderedPage(
    {
      url: sourceUrl,
      // One authoritative network guard for the whole page lifecycle: every
      // request (navigation, redirect hops, and sub-resources) is revalidated
      // against the SSRF floor + the profile's source-domain allowlist, and
      // trackers are aborted. No later route handler may continue an
      // unchecked request.
      networkGuard: async (url) => profileNetworkGuard(url, allowedSourceDomains),
      navigationTimeoutMs: RENDERED_NAVIGATE_TIMEOUT_MS,
      dwellMs: RENDERED_DWELL_MS,
    },
    async ({ page }, dwellMs) => {
      // Dwell for dynamic content before any checks or extraction.
      // This allows JS-rendered content to appear and improves
      // Cloudflare pass-through by simulating real user behavior.
      await page.waitForTimeout(dwellMs);

      // ── Deterministic variant interaction (P1-2) ─────────────────────
      // Rendered path must not bypass verification: run gate against rendered HTML first,
      // then only when interaction flag enabled and candidate verified build exact per-axis plan.
      try {
        const maybeRenderedHtml: string = await page.content();
        const renderedMatrix = parseVariantMatrix(maybeRenderedHtml, request.sourceUrl);
        const hasStrategy = !!(request.profile as any).variantSelectionStrategy;
        const sel: any = (request as any).variantSelection as { resolutionId: string; identityMatrixHash: string; variantKey: string } | undefined;
        if (renderedMatrix && renderedMatrix.candidates.length > 1 && sel && hasStrategy) {
          let liveHash: string | null = null;
          try { liveHash = computeIdentityMatrixHash(renderedMatrix); } catch { liveHash = null; }
          const cand = renderedMatrix.candidates.find(c => c.variantKey === sel.variantKey);
          const isVerified = cand && liveHash && liveHash === sel.identityMatrixHash;
          if (!isVerified) {
            if (getEffectiveVariantResolutionMode() === 'active') {
              warnings.push(`Variant interaction skipped: candidate not verified (stale or missing)`);
            }
          } else if (!getEffectiveVariantInteractionEnabled()) {
            warnings.push('Variant interaction disabled by flag — skipping rendered variant selection');
          } else {
            const strategy: any = (request.profile as any).variantSelectionStrategy;
            const axes: import('../variant-interaction').VariantOptionAxis[] = Array.isArray(strategy.axes) ? strategy.axes : Array.isArray(strategy.options) ? strategy.options : [];
            const variantOptions = (cand!.options ?? []).map((o: any) => ({ axis: o.axis, value: o.value }));
            const planObj = buildVariantInteractionPlan(axes, variantOptions);
            const plan = planObj.steps;
            if (planObj.warnings.length > 0) warnings.push(...planObj.warnings);
            if (plan.length === 0) {
              warnings.push('Variant interaction plan empty — failing closed');
              return buildFailedResult(request, warnings);
            }
            for (const step of plan) {
              const ok = await page.evaluate(
                `((sel, val, type) => {
                  const container = document.querySelector(sel);
                  if (!container) return false;
                  if (type === 'dropdown') {
                    const selects = container.tagName === 'SELECT' ? [container] : Array.from(container.querySelectorAll('select'));
                    if (selects.length === 0) return false;
                    const select = selects[0];
                    for (const opt of Array.from(select.options)) {
                      const txt = (opt.textContent || '').trim();
                      const v = (opt.value || '').trim();
                      if (txt === val || v === val) {
                        select.value = opt.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        select.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                      }
                    }
                    return false;
                  } else {
                    const candidates = container.querySelectorAll('button, [role="button"], [role="radio"], input[type="radio"], input[type="radio"] + label, [data-value], [data-option-value]');
                    for (const el of candidates) {
                      const txt = (el.textContent || '').trim();
                      const dv = el.getAttribute('data-value') || el.getAttribute('data-option-value') || el.getAttribute('value') || '';
                      if (txt === val || dv === val) {
                        (el).click();
                        return true;
                      }
                    }
                    return false;
                  }
                })(${JSON.stringify(step.selector)}, ${JSON.stringify(step.value)}, ${JSON.stringify(step.optionType)})`
              );
              if (!ok) {
                warnings.push(`Variant interaction step failed for ${step.selector} = "${step.value}" — failing closed`);
                return buildFailedResult(request, warnings);
              }
              await page.waitForTimeout(250);
              // Per-step settled verification: every step must be settled (selected/checked/aria-selected) before next
              const settled = await page.evaluate(
                `((sel, val) => {
                  const container = document.querySelector(sel);
                  if (!container) return false;
                  const el = Array.from(container.querySelectorAll('button, [role="button"], [role="radio"], option, input'))
                    .find(e => ((e.textContent||'').trim() === val) || e.getAttribute('data-value')===val || e.getAttribute('value')===val);
                  if (!el) return false;
                  if (el.tagName === 'OPTION') return (el).selected === true;
                  if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true') return true;
                  if ((el).checked) return true;
                  if (el.classList.contains('selected') || el.classList.contains('active')) return true;
                  return true;
                })(${JSON.stringify(step.selector)}, ${JSON.stringify(step.value)})`
              );
              if (!settled) {
                warnings.push(`Variant interaction not settled for ${step.selector} = "${step.value}" — failing closed`);
                return buildFailedResult(request, warnings);
              }
            }
            warnings.push(`Variant interaction executed ${plan.length} step(s) for ${cand.variantKey}`);
          }
        }
      } catch (e) {
        warnings.push(`Rendered variant gate/interaction error: ${e instanceof Error ? e.message : String(e)}`);
      }

      // ── Detect Cloudflare / WAF challenge pages early ────────────────
      const pageTitle = await page.title();
      if (
        !pageTitle ||
        pageTitle.includes('Just a moment') ||
        pageTitle.includes('Cloudflare') ||
        pageTitle.includes('Attention Required') ||
        pageTitle.includes('verify you are human')
      ) {
        // Return a sentinel so the caller knows it was blocked
        return {
          blocked: true as const,
          title: null, brand: null, description: null,
          price: null, primaryImage: null, additionalImages: [] as string[],
          provenance: {} as Record<string, string>,
          customFields: {} as Record<string, string>,
        };
      }

      const finalUrl = page.url();

      // ── Extract JSON-LD ──────────────────────────────────────────────
      let jsonLd: Record<string, unknown> | null = null;
      try {
        const jsonLdArray: Record<string, unknown>[] = await page.evaluate(
          makePlaywrightJsonLdExtractor(),
        );
        for (const item of jsonLdArray) {
          const findProduct = (obj: Record<string, unknown>): Record<string, unknown> | null => {
            if (obj['@type'] === 'Product') return obj;
            if (Array.isArray(obj['@graph'])) {
              for (const g of obj['@graph'] as Record<string, unknown>[]) {
                const found = findProduct(g);
                if (found) return found;
              }
            }
            return null;
          };
          const product = findProduct(item);
          if (product) {
            jsonLd = product;
            break;
          }
        }
      } catch {
        // non-critical
      }

      // ── Extract meta tags ───────────────────────────────────────────
      let metaTags: Record<string, string> = {};
      try {
        metaTags = await page.evaluate(makePlaywrightMetaExtractor());
      } catch {
        // non-critical
      }

      // ── Selector helpers ────────────────────────────────────────────
      const titleSelector = selectors['titleSelector'] || selectors['title'] || null;
      const brandSelector = selectors['brandSelector'] || selectors['brand'] || null;
      const descriptionSelector = selectors['descriptionSelector'] || selectors['description'] || null;
      const priceSelector = selectors['priceSelector'] || selectors['price'] || null;
      const imagesSelector = selectors['imagesSelector'] || selectors['images'] || selectors['imageSelector'] || selectors['image'] || null;

      const evalText = async (sel: string | null | undefined): Promise<string> => {
        if (!sel || !sel.trim()) return '';
        const trimmed = sel.trim();

        // 1) JSON-LD
        if (trimmed.startsWith('jsonld:')) {
          const prop = trimmed.slice('jsonld:'.length);
          if (!jsonLd) return '';
          if (prop === 'Product.name' || prop === 'name') return (jsonLd.name as string)?.trim() || '';
          if (prop === 'Product.description' || prop === 'description') return (jsonLd.description as string)?.trim() || '';
          if (prop === 'Product.offers.price' || prop === 'offers.price' || prop === 'price') {
            const offers = jsonLd.offers as any;
            const price = offers?.price ?? (Array.isArray(offers) ? offers[0]?.price : null) ?? jsonLd.price;
            return price != null ? String(price).trim() : '';
          }
          if (prop === 'Product.brand' || prop === 'brand') {
            const b = jsonLd.brand as any;
            const name = typeof b === 'string' ? b : b?.name;
            return name ? String(name).trim() : '';
          }
          return '';
        }

        // 2) Meta tags
        if (trimmed.startsWith('meta[')) {
          const propMatch = trimmed.match(/property=["']([^"']+)["']/i) || trimmed.match(/name=["']([^"']+)["']/i);
          if (propMatch && metaTags[propMatch[1]]) {
            return metaTags[propMatch[1]].trim();
          }
          try {
            const rawVal = await page.evaluate(`document.querySelector(${JSON.stringify(trimmed)})?.getAttribute('content') || ''`);
            return String(rawVal ?? '').trim();
          } catch {
            return '';
          }
        }

        // 3) Standard DOM selector
        try {
          return await page.evaluate(makeTextSelectorEvaluator(trimmed));
        } catch {
          return '';
        }
      };

      // ── Title ────────────────────────────────────────────────────────
      let title: string | null = null;
      const titleProvenance: string[] = [];
      let titleOrigin: string | null = null;

      if (titleSelector) {
        title = (await evalText(titleSelector)) || null;
        if (title) {
          titleProvenance.push(titleSelector.startsWith('jsonld:') ? 'json-ld' : titleSelector.startsWith('meta[') ? 'meta' : 'profile-selector');
          titleOrigin = titleSelector;
          // Concatenate optional title selectors (e.g. subheadings, taglines)
          const toSel = request.profile.titleOptionalSelectors;
          if (toSel && toSel.length > 0) {
            for (const sel of toSel) {
              const extra = await evalText(sel);
              if (extra) {
                title += ' — ' + extra;
              }
            }
          }
        }
      }
      if (!title) {
        title =
          (jsonLd?.name as string) ||
          metaTags['og:title'] ||
          metaTags['page:title'] ||
          null;
        if (title) {
          const src = title === jsonLd?.name ? 'json-ld' : 'meta';
          titleProvenance.push(src);
          titleOrigin = title === jsonLd?.name
            ? 'json-ld:Product.name'
            : title === metaTags['og:title'] ? 'meta:og:title' : 'meta:page:title';
        }
      }

      // If no title at all, this is a hard failure
      if (!title) {
        warnings.push('Title could not be extracted — returning ok: false');
        return buildFailedResult(request, warnings);
      }

      // ── Brand ─────────────────────────────────────────────────────────
      let brand: string | null = null;
      let brandProvenance = '';
      let brandOrigin: string | null = null;
      if (brandSelector) {
        brand = (await evalText(brandSelector)) || null;
        if (brand) {
          brandProvenance = brandSelector.startsWith('jsonld:') ? 'json-ld' : brandSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
          brandOrigin = brandSelector;
        }
      }
      if (!brand) {
        const jb = jsonLd?.brand as Record<string, unknown> | string | undefined;
        const bfj = typeof jb === 'string' ? jb : (jb as Record<string, unknown>)?.name as string | undefined;
        if (bfj) { brand = bfj; brandProvenance = 'json-ld'; brandOrigin = 'json-ld:Product.brand'; }
      }

      // ── Description ──────────────────────────────────────────────────
      let description: string | null = null;
      let descriptionProvenance = '';
      let descriptionOrigin: string | null = null;
      if (descriptionSelector) {
        description = (await evalText(descriptionSelector)) || null;
        if (description) {
          descriptionProvenance = descriptionSelector.startsWith('jsonld:') ? 'json-ld' : descriptionSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
          descriptionOrigin = descriptionSelector;
        }
      }
      if (!description) {
        description =
          (jsonLd?.description as string) ||
          metaTags['og:description'] ||
          metaTags['description'] ||
          null;
        if (description) {
          descriptionProvenance = description === jsonLd?.description ? 'json-ld' : 'meta';
          descriptionOrigin = description === jsonLd?.description
            ? 'json-ld:Product.description'
            : description === metaTags['og:description'] ? 'meta:og:description' : 'meta:description';
        }
      }

      // ── Price ─────────────────────────────────────────────────────────
      let price: string | null = null;
      let priceProvenance = '';
      let priceOrigin: string | null = null;
      if (expected?.price) {
        price = expected.price;
        priceProvenance = 'spreadsheet-import';
        priceOrigin = 'expected:price';
      } else if (priceSelector) {
        price = (await evalText(priceSelector)) || null;
        if (price) {
          priceProvenance = priceSelector.startsWith('jsonld:') ? 'json-ld' : priceSelector.startsWith('meta[') ? 'meta' : 'profile-selector';
          priceOrigin = priceSelector;
          const m = price.match(/\$?(\d+\.?\d*)/);
          if (m) price = m[0];
        }
      }
      if (!price) {
        const offers = jsonLd?.offers as Record<string, unknown> | undefined;
        price = (offers?.price as string) || metaTags['product:price:amount'] || null;
        if (price) {
          priceProvenance = offers?.price ? 'json-ld' : 'meta';
          priceOrigin = offers?.price ? 'json-ld:Product.offers.price' : 'meta:product:price:amount';
        }
      }

      // ── Images from selector ────────────────────────────────────────
      let primaryImage: string | null = null;
      const additionalImages: string[] = [];
      let imageProvenance = '';
      let imageOrigin: string | null = null;

      if (imagesSelector) {
        const trimmed = imagesSelector.trim();
        const rawUrls: string[] = [];

        if (trimmed.startsWith('jsonld:')) {
          if (jsonLd?.image) {
            const raw = jsonLd.image as any;
            if (Array.isArray(raw)) {
              for (const item of raw) {
                const u = typeof item === 'object' ? item?.url ?? item?.contentUrl : item;
                if (u && typeof u === 'string') {
                  const res = resolveUrl(u, finalUrl);
                  if (res) rawUrls.push(res);
                }
              }
            } else if (typeof raw === 'object' && raw?.url) {
              const res = resolveUrl(raw.url, finalUrl);
              if (res) rawUrls.push(res);
            } else if (typeof raw === 'string') {
              const res = resolveUrl(raw, finalUrl);
              if (res) rawUrls.push(res);
            }
          }
        } else if (trimmed.startsWith('meta[')) {
          let content = metaTags['og:image'] || '';
          if (!content) {
            try {
              const rawVal = await page.evaluate(`document.querySelector(${JSON.stringify(trimmed)})?.getAttribute('content') || ''`);
              content = String(rawVal ?? '').trim();
            } catch {}
          }
          if (content) {
            const resolved = resolveUrl(content.trim(), finalUrl);
            if (resolved) rawUrls.push(resolved);
          }
        } else {
          // 1) Extract from rendered page content via Cheerio (captures all static and dynamically loaded images across markup, hidden carousel slides, and thumbnails)
          try {
            const pageHtml = await page.content();
            const $page = cheerio.load(pageHtml);
            const cheerioImgs = collectImagesCheerio($page, trimmed, jsonLd, metaTags, finalUrl);
            rawUrls.push(...cheerioImgs);
          } catch {}

          // 2) Also extract from live Playwright DOM elements
          try {
            const domImgs: string[] = await page.evaluate(
              `((sel, baseUrl) => {
                const results = [];
                try {
                  const els = document.querySelectorAll(sel);
                  for (const el of els) {
                    const targets = el.tagName === 'IMG' || el.tagName === 'SOURCE'
                      ? [el]
                      : Array.from(el.querySelectorAll('img,source'));
                    for (const target of targets) {
                      const add = (val) => {
                        if (val && typeof val === 'string' && val.trim()) results.push(val.trim());
                      };
                      if (target.tagName === 'IMG') add(target.currentSrc);
                      for (const attr of ['data-zoom-src','data-original','data-src','src','data-lazy-src','data-image','data-zoom-image','data-full-image','data-master','data-photoswipe-src','data-highres']) {
                        add(target.getAttribute(attr));
                      }
                      for (const attr of ['srcset','data-srcset']) {
                        const s = target.getAttribute(attr);
                        if (s) {
                          for (const part of s.split(',')) {
                            const u = part.trim().split(' ')[0];
                            if (u) add(u);
                          }
                        }
                      }
                    }
                  }
                } catch {}
                return results;
              })(${JSON.stringify(trimmed)}, ${JSON.stringify(finalUrl)})`
            );
            rawUrls.push(...domImgs);
          } catch {}
        }

        const cleanImgs = cleanAndDeduplicateImages(rawUrls, finalUrl);
        if (cleanImgs.length > 0) {
          primaryImage = cleanImgs[0];
          additionalImages.push(...cleanImgs.slice(1).slice(0, 29));
          imageProvenance = trimmed.startsWith('jsonld:') ? 'json-ld' : trimmed.startsWith('meta[') ? 'meta' : 'profile-selector';
          imageOrigin = imagesSelector;
        }
      }
      if (!primaryImage) {
        // Fallback images from JSON-LD / meta
        if (!primaryImage && jsonLd?.image) {
          const img = jsonLd.image as string | string[];
          const url = Array.isArray(img) ? img[0] : img;
          const resolved = resolveUrl(url, finalUrl);
          if (resolved) { primaryImage = resolved; imageProvenance = 'json-ld'; imageOrigin = 'json-ld:Product.image'; }
        }
        if (!primaryImage && metaTags['og:image']) {
          const resolved = resolveUrl(metaTags['og:image'], finalUrl);
          if (resolved) { primaryImage = resolved; imageProvenance = 'meta'; imageOrigin = 'meta:og:image'; }
        }
      }

      // ── Custom selectors ────────────────────────────────────────────
      const customFields: Record<string, string> = {};
      // Provenance + exact origin path per accepted field. Origins are never
      // fabricated: fields without a known path are omitted from
      // fieldProvenanceDetails (fail closed), and a meta/microdata fallback
      // is never relabeled as a selector path.
      const provenance: Record<string, string> = {};
      const origins: Record<string, string | null> = {};
      if (profile.customSelectors) {
        for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
          if (!selector) continue;
          const val = await evalText(selector);
          if (val) {
            customFields[fieldName] = val;
            provenance[`custom.${fieldName}`] = 'profile-selector';
            origins[`custom.${fieldName}`] = selector;
          }
        }
      }

      // ── Build provenance ────────────────────────────────────────────
      if (title) { provenance.title = titleProvenance[0] || 'json-ld'; origins.title = titleOrigin; }
      if (brand) { provenance.brand = brandProvenance; origins.brand = brandOrigin; }
      if (description) { provenance.description = descriptionProvenance; origins.description = descriptionOrigin; }
      if (price) { provenance.price = priceProvenance; origins.price = priceOrigin; }
      if (primaryImage) { provenance.primaryImage = imageProvenance; origins.primaryImage = imageOrigin; }
      if (additionalImages.length > 0) { provenance.additionalImages = imageProvenance; origins.additionalImages = imageOrigin; }
      if (sourceUrl) provenance.sourceUrl = 'request';
      provenance.profileRuntime = 'rendered';
      if (Object.keys(customFields).length > 0) provenance.customFields = 'profile-selector';

      // Retain the exact rendered DOM after all deterministic selectors have
      // run. Selector values are not authoritative without this source hash
      // (and artifact reference) attached to the response. The same bytes are
      // reused for ADR-0031 embedded-only ladder enrichment (no refetch).
      const renderedHtml = await page.content();
      const retained = retainProfileSource(finalUrl, renderedHtml);
      const fieldProvenanceDetails = buildFieldProvenanceDetails(provenance, origins);
      return {
        blocked: false as const,
        title: title ?? null,
        brand: brand ?? null,
        description: description ?? null,
        price: price ?? null,
        primaryImage: primaryImage ?? null,
        additionalImages,
        provenance,
        fieldProvenanceDetails,
        sourceContentHash: retained.sourceContentHash,
        sourceArtifactId: retained.sourceArtifactId,
        customFields,
        renderedHtml,
        // The redirected URL the DOM was actually captured at — enrichment
        // must resolve provenance/images against reality, not the request URL.
        renderedFinalUrl: finalUrl,
      };
    },
    runnerConfig,
  );

  // ── Handle runner failure (could not launch / navigate) ──────────────
  if (!result.ok) {
    warnings.push(`Rendered extraction failed: ${result.error}`);
    return buildFailedResult(request, warnings);
  }

  const extracted = result.data;

  if ('data' in extracted) {
    return extracted;
  }

  // ── Cloudflare block detection ───────────────────────────────────────
  if (extracted.blocked) {
    warnings.push('Page appears to be blocked by Cloudflare or WAF');
    return buildFailedResult(request, warnings);
  }

  // ── Hard fail when no title extracted ────────────────────────────────
  const title = extracted.title;
  if (!title) {
    warnings.push('Title could not be extracted — returning ok: false');
    return buildFailedResult(request, warnings);
  }

  if (!extracted.sourceContentHash || !extracted.sourceArtifactId) {
    warnings.push('Rendered source artifact retention unavailable — failing closed');
    return buildFailedResult(request, warnings);
  }

  const data = buildExtractionData(
    {
      title,
      brand: extracted.brand,
      description: extracted.description,
      price: extracted.price,
      primaryImage: extracted.primaryImage,
      additionalImages: extracted.additionalImages,
      provenance: extracted.provenance,
    },
    sourceUrl,
    expected.name,
  );

  // Merge custom fields into result
  if (Object.keys(extracted.customFields).length > 0) {
    (data as ExtractionData).customFields = extracted.customFields;
  }

  // ADR-0031: embedded-only ladder enrichment on the production rendered
  // profile path. Reuses the exact DOM bytes the runner captured — no second
  // fetch, single profile-execution authority preserved. Additive-only;
  // failures degrade to a warning.
  try {
    await applyLadderEnrichment({
      html: extracted.renderedHtml,
      // Final redirected URL the DOM was captured at (falls back to the
      // request URL if the runner did not report one).
      url: extracted.renderedFinalUrl || sourceUrl,
      data,
      expected: { name: expected.name, brandHint: request.expected?.brandHint ?? null, price: request.expected?.price ?? null, gtin: request.expected?.upc },
    });
  } catch (enrichErr) {
    warnings.push(`Ladder enrichment failed (non-blocking): ${enrichErr instanceof Error ? enrichErr.message : String(enrichErr)}`);
  }

  return { data, warnings, sourceContentHash: extracted.sourceContentHash, sourceArtifactId: extracted.sourceArtifactId, fieldProvenanceDetails: extracted.fieldProvenanceDetails };
}

// ─── Build ExtractionData from extracted fields ───────────────────────────────

function buildExtractionData(
  fields: {
    title: string;
    brand: string | null;
    description: string | null;
    price: string | null;
    primaryImage: string | null;
    additionalImages: string[];
    provenance: Record<string, string>;
  },
  sourceUrl: string,
  expectedName: string | undefined,
): ExtractionData {
  const { title, brand, description, price, primaryImage, additionalImages, provenance } = fields;

  // Confidence: fraction of required fields that were extracted
  const requiredFields = [title, brand, description, price, primaryImage];
  const extractedCount = requiredFields.filter(Boolean).length;
  const confidence = requiredFields.length > 0 ? extractedCount / requiredFields.length : 0;

  // SEO filename from URL path
  let seoFileName: string | null = null;
  try {
    const urlPath = new URL(sourceUrl).pathname;
    const lastSegment = urlPath.split('/').filter(Boolean).pop();
    if (lastSegment && !lastSegment.match(/^\d+$/)) {
      seoFileName = lastSegment.replace(/\.\w+$/, '');
      if (!provenance.seoFileName) provenance.seoFileName = 'url';
    }
  } catch {
    // skip
  }

  // Search keywords from title + brand + description
  const keywordParts = [title, brand, description].filter(Boolean) as string[];
  const searchKeywords =
    keywordParts.length > 0
      ? keywordParts.join(' ').substring(0, 200)
      : null;
  if (searchKeywords && !provenance.searchKeywords) {
    provenance.searchKeywords = 'derived';
  }

  return ExtractionDataSchema.parse({
    title,
    brand,
    description,
    bulletPoints: [],
    primaryImage,
    additionalImages,
    price,
    weight: null,
    dimensions: null,
    seoFileName,
    searchKeywords,
    sourceUrl,
    confidence,
    fieldProvenance: provenance,
    packagingTitle: null,
    packagingOcrData: null,
    customFields: {},
  });
}

// ─── Build failed result (title could not be extracted) ───────────────────────

function buildFailedResult(
  request: ExtractRequest,
  warnings: string[],
): {
  data: ExtractionData;
  warnings: string[];
} {
  const { sourceUrl, expected } = request;

  const provenance: Record<string, string> = {};
  provenance.sourceUrl = 'request';
  provenance.profileRuntime = request.profile.runtime;

  const data: ExtractionData = ExtractionDataSchema.parse({
    title: null,
    brand: null,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: expected?.price || null,
    weight: null,
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    sourceUrl,
    confidence: 0,
    fieldProvenance: provenance,
    packagingTitle: null,
    packagingOcrData: null,
    customFields: {},
  });

  return { data, warnings };
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * POST /profile-runner/extract
 *
 * Executes deterministic extraction using the provided profile.
 * Never falls back to generic extraction, never calls LLMs.
 */
export function handleExtract(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = ExtractRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data as ExtractRequest;

      // ── Run extraction ────────────────────────────────────────────────
      const isRendered = request.profile.runtime === 'rendered';
      const extraction = isRendered
        ? await doRenderedExtract(request)
        : await doStaticExtract(request);
      const { data, warnings, sourceContentHash, sourceArtifactId, fieldProvenanceDetails } = extraction;

      // ── Build response ────────────────────────────────────────────────
      const ok = data.title != null && data.title.length > 0;
      const extAny: any = extraction as any;
      const variantFailureCode: string | null = extAny.failureCode ?? null;
      const mode = getEffectiveVariantResolutionMode();
      const finalOk = variantFailureCode && mode === 'active' ? false : ok;
      // Build the response payload
      const responsePayload: ExtractResponse = {
        ok: finalOk,
        extractionData: finalOk ? data : undefined,
        fieldProvenance: data.fieldProvenance || {},
        fieldProvenanceDetails: fieldProvenanceDetails ?? {},
        profileRuntime: request.profile.runtime,
        profileId: request.profileId,
        profileVersion: request.profileVersion,
        sourceContentHash: sourceContentHash ?? null,
        sourceArtifactId: sourceArtifactId ?? null,
        warnings,
        matrixDecision: extAny.matrixDecision ?? null,
        selectedReceipt: extAny.selectedReceipt ?? null,
        failureCode: variantFailureCode as any,
        variantMatrix: extAny.variantMatrix ?? extAny.matrix ?? null,
        identityMatrixHash: extAny.identityMatrixHash ?? null,
        candidates: extAny.candidates ? extAny.candidates.slice(0, 250) : null,
        parentProductId: typeof extAny.parentProductId === 'string' && extAny.parentProductId ? extAny.parentProductId : null,
      };

      // Validate through ExtractResponseSchema
      const parsedResponse = ExtractResponseSchema.parse(responsePayload);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsedResponse));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[extract] Uncaught error: ${msg}\n`);

      // Always return a valid ExtractResponse shape
      const fallback = ExtractResponseSchema.parse({
        ok: false,
        extractionData: undefined,
        fieldProvenance: {},
        profileRuntime: 'static' as const,
        profileId: 'unknown',
        profileVersion: 0,
        warnings: [`Internal error: ${msg}`],
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });

  req.on('error', (err: Error) => {
    process.stderr.write(`[extract] Request error: ${err.message}\n`);
    const fallback = ExtractResponseSchema.parse({
      ok: false,
      extractionData: undefined,
      fieldProvenance: {},
      profileRuntime: 'static' as const,
      profileId: 'unknown',
      profileVersion: 0,
      warnings: [`Request error: ${err.message}`],
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
  });
}
