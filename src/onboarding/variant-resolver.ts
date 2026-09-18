import * as cheerio from 'cheerio';
import {
  VARIANT_PARSER_VERSION,
  computeIdentityMatrixHash,
  type VariantMatrix,
  type NormalizedVariantCandidate,
  type VariantMatchInput,
  type VariantMatchDecision,
  type VariantIdentifier,
  type VariantOption,
  type VariantImage,
} from '../shared/schemas/variant-resolution';

/** Operator selection receipt (stale-safe extraction, M4). */
export interface OperatorSelectionReceiptInput {
  resolutionId: string;
  identityMatrixHash: string;
  variantKey: string;
}

export type OperatorReceiptVerification =
  | { ok: true; candidate: NormalizedVariantCandidate; liveHash: string | null }
  | { ok: false; kind: 'stale' | 'missing'; liveHash: string | null };

/** Live identity hash for a matrix (null when unhashable — fail closed downstream). */
function liveMatrixHash(matrix: VariantMatrix): string | null {
  try {
    return computeIdentityMatrixHash(matrix);
  } catch {
    return null;
  }
}

/**
 * Verify an operator receipt against the live matrix: the identity hash
 * must still bind and the selected key must still exist. Shared by the
 * legacy worker gate and T4 policy execution so stale-selection handling
 * cannot drift between the two paths.
 */
// worker gate + policy execution + tests
export function verifyOperatorSelectionReceipt(
  matrix: VariantMatrix,
  receipt: OperatorSelectionReceiptInput,
): OperatorReceiptVerification {
  const liveHash = liveMatrixHash(matrix);
  if (liveHash !== receipt.identityMatrixHash) return { ok: false, kind: 'stale', liveHash };
  const candidate = matrix.candidates.find((c) => c.variantKey === receipt.variantKey);
  if (!candidate) return { ok: false, kind: 'missing', liveHash };
  return { ok: true, candidate, liveHash };
}

export interface VariantCandidate {
  url: string | null;
  title: string;
  platformId: string | null;
  options: string[];
  sku: string | null;
  barcode?: string | null;
  available: boolean;
}

export interface VariantResolutionResult {
  resolvedUrl: string;
  variantId: string | null;
  variantTitle: string | null;
  confidence: number;
  method: 'url_param' | 'jsonld' | 'shopify' | 'woocommerce' | 'single_variant' | 'none';
  totalVariants: number;
  ambiguous: boolean;
}

// used by tests
export const SIZE_ALIASES: Record<string, string[]> = {
  xs:        ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  sm:        ['small', 'sm'],
  md:        ['medium', 'med', 'md'],
  lg:        ['large', 'lg'],
  xl:        ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large', 'x small'],
  'x-small': ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  'x-large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'x small': ['x-small', 'xsmall', 'extra small', 'xtra small', 'x small'],
  'x large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'xlarge':  ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  small:     ['small', 'sm'],
  medium:    ['medium', 'med', 'md'],
  large:     ['large', 'lg'],
  'extra large': ['x-large', 'xlarge', 'x large', 'extra large', 'xtra large'],
  'extra small': ['x-small', 'xsmall', 'extra small', 'xtra small'],
};

// used by tests
export const COLOR_ALIASES: Record<string, string[]> = {
  lav: ['lavender', 'lav'],
  chkn: ['chicken', 'chkn'],
  turk: ['turkey', 'turk'],
  veg: ['veggies', 'vegetable', 'vegetables', 'veg'],
  smpl: ['sampler', 'smpl'],
  pkg: ['package', 'pkg'],
};

// used by tests
export function normalizeToken(s: string): string {
  return s.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ') // Strip dots not followed by a digit
    .trim();
}

export function tokenSet(s: string): Set<string> {
  return new Set(normalizeToken(s).split(/\s+/).filter(Boolean));
}

// used by tests
export function variantDescriptor(v: any): { text: string; tokens: Set<string> } {
  const parts: string[] = [];
  if (v?.title) parts.push(String(v.title));
  if (v?.public_title) parts.push(String(v.public_title));
  if (v?.name) parts.push(String(v.name));
  for (const key of ['option1', 'option2', 'option3']) {
    if (v?.[key]) parts.push(String(v[key]));
  }
  if (Array.isArray(v?.options)) {
    for (const opt of v.options) {
      if (typeof opt === 'string') parts.push(opt);
    }
  }
  if (v?.sku) parts.push(String(v.sku));
  const text = parts.join(' ').toLowerCase();
  return { text, tokens: tokenSet(parts.join(' ')) };
}

// used by tests
export function expandExpectedNameTokens(expected: string): Set<string> {
  const raw = normalizeToken(expected);
  const words = raw.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  for (const w of words) {
    expanded.add(w);
    const aliases = SIZE_ALIASES[w] || COLOR_ALIASES[w];
    if (aliases) {
      for (const a of aliases) {
        expanded.add(normalizeToken(a));
      }
    }
  }
  return expanded;
}

// used by tests
export function getExpectedSizeAliasForms(expected: string): Set<string> {
  const raw = normalizeToken(expected);
  const words = raw.split(/\s+/).filter(Boolean);
  const forms = new Set<string>();
  for (const w of words) {
    forms.add(w);
    const aliases = SIZE_ALIASES[w];
    if (aliases) {
      for (const a of aliases) {
        forms.add(normalizeToken(a));
      }
    }
  }
  return forms;
}

/**
 * Strategy 1: Extract variants from Schema.org JSON-LD hasVariant / ProductGroup
 */
// used by tests
export function extractVariantsFromJsonLd(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

  const candidates: VariantCandidate[] = [];

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      const items = data['@graph'] ? data['@graph'] : [data];

      for (const item of items) {
        if (item['@type'] === 'ProductGroup' || item['@type'] === 'Product') {
          const variants = item.hasVariant;
          if (Array.isArray(variants)) {
            for (const v of variants) {
              if (v['@type'] === 'Product') {
                const title = v.name || '';
                const platformId = v.sku || v.gtin || v.mpn || null;
                const sku = v.sku || null;
                const available = v.offers?.availability !== 'http://schema.org/OutOfStock';
                const url = v.url || v.offers?.url || null;

                // Simple option parsing from name (e.g. "Name - Option" or "Name (Option)")
                let options: string[] = [];
                if (title && item.name && title.startsWith(item.name)) {
                  const suffix = title.substring(item.name.length).replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '').trim();
                  if (suffix) {
                    options = suffix.split(/[\s,\-/]+/).filter(Boolean);
                  }
                }

                candidates.push({
                  url,
                  title,
                  platformId,
                  options,
                  sku,
                  available
                });
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return candidates;
}

/**
 * Strategy 2: Extract variants from Shopify productJSON script embeds
 */
// used by tests
export function extractVariantsFromShopify(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const candidates: VariantCandidate[] = [];

  // 1. Try script tag with id="ProductJson-..."
  $('script[id^="ProductJson-"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text() || '{}');
      if (Array.isArray(data.variants)) {
        for (const v of data.variants) {
          candidates.push(mapShopifyVariant(v));
        }
      }
    } catch {
      // ignore
    }
  });

  if (candidates.length > 0) return candidates;

  // 2. Scan script tags content using regexes
  $('script').each((_, el) => {
    const text = $(el).text();
    if (!text) return;

    // Look for window.productJSON = ... or var meta = { product: ... }
    const matchJson = text.match(/(?:window\.productJSON|productJSON)\s*=\s*({[\s\S]+?});/);
    if (matchJson) {
      try {
        const data = JSON.parse(matchJson[1]);
        if (Array.isArray(data.variants)) {
          for (const v of data.variants) {
            candidates.push(mapShopifyVariant(v));
          }
        }
      } catch {
        // ignore
      }
    }

    const matchMeta = text.match(/var\s+meta\s*=\s*({[\s\S]+?});/);
    if (matchMeta && candidates.length === 0) {
      try {
        const data = JSON.parse(matchMeta[1]);
        if (data.product && Array.isArray(data.product.variants)) {
          for (const v of data.product.variants) {
            candidates.push(mapShopifyVariant(v));
          }
        }
      } catch {
        // ignore
      }
    }
  });

  return candidates;
}

function mapShopifyVariant(v: any): VariantCandidate {
  const options: string[] = [];
  if (v.option1) options.push(v.option1);
  if (v.option2) options.push(v.option2);
  if (v.option3) options.push(v.option3);

  return {
    url: null, // Construct at return
    title: v.title || v.name || '',
    platformId: v.id ? String(v.id) : null,
    options,
    sku: v.sku || null,
    barcode: v.barcode ?? v.gtin ?? v.gtin12 ?? v.gtin13 ?? null,
    available: v.available !== false
  } as VariantCandidate;
}

/**
 * Strategy 3: Extract variants from WooCommerce data-product_variations attribute
 */
// used by tests
export function extractVariantsFromWooCommerce(html: string): VariantCandidate[] {
  const $ = cheerio.load(html);
  const candidates: VariantCandidate[] = [];

  const form = $('form.variations_form[data-product_variations]');
  if (form.length > 0) {
    try {
      const dataStr = form.attr('data-product_variations');
      if (dataStr) {
        const data = JSON.parse(dataStr);
        if (Array.isArray(data)) {
          for (const v of data) {
            const options: string[] = [];
            if (v.attributes) {
              for (const val of Object.values(v.attributes)) {
                if (val && typeof val === 'string') {
                  options.push(val);
                }
              }
            }
            candidates.push({
              url: v.variation_id ? `?variation_id=${v.variation_id}` : null,
              title: options.join(' / '),
              platformId: v.variation_id ? String(v.variation_id) : null,
              options,
              sku: v.sku || null,
              available: v.is_in_stock !== false
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return candidates;
}

/**
 * Diff register vs expected name to isolate variant tokens
 */
export function diffRegisterVsExpected(
  registerName: string,
  expectedName: string | null,
  brandHint: string | null
): Set<string> {
  const registerTokens = tokenSet(registerName);
  const expectedTokens = expectedName ? tokenSet(expectedName) : new Set<string>();

  const diff = new Set<string>();
  for (const t of registerTokens) {
    if (!expectedTokens.has(t)) {
      diff.add(t);
    }
  }

  // Strip brand hint tokens
  if (brandHint) {
    const brandTokens = tokenSet(brandHint);
    for (const bt of brandTokens) {
      diff.delete(bt);
    }
  }

  return diff;
}

/**
 * Score a candidate variant against variant hint tokens
 */
// used by tests
export function scoreVariantCandidate(
  v: VariantCandidate,
  hints: Set<string>
): number {
  let score = 0;
  const descText = `${v.title} ${v.options.join(' ')} ${v.sku || ''}`.toLowerCase();
  const descTokens = tokenSet(descText);

  // Token overlaps
  let matches = 0;
  for (const h of hints) {
    const expanded = expandExpectedNameTokens(h);
    for (const eh of expanded) {
      if (descTokens.has(eh)) {
        matches++;
        break; // Match for this hint token found
      }
    }
  }
  score += matches * 10;

  // Exact option matching: major boost
  for (const opt of v.options) {
    const optNorm = normalizeToken(opt);
    for (const h of hints) {
      const expanded = expandExpectedNameTokens(h);
      if (expanded.has(optNorm)) {
        score += 60;
      }
    }
  }

  // SKU matching
  if (v.sku) {
    const skuNorm = normalizeToken(v.sku);
    for (const h of hints) {
      if (skuNorm === normalizeToken(h)) {
        score += 40;
      }
    }
  }

  // Title match
  const titleNorm = normalizeToken(v.title);
  for (const h of hints) {
    const expanded = expandExpectedNameTokens(h);
    if (expanded.has(titleNorm)) {
      score += 30;
    }
  }

  return score;
}

/**
 * Shared Matching Core
 */
// used by tests
export function matchVariant(
  candidates: VariantCandidate[],
  registerName: string,
  expectedName: string | null,
  brandHint: string | null,
): { matched: VariantCandidate | null; confidence: number; ambiguous: boolean } {
  if (candidates.length === 0) {
    return { matched: null, confidence: 0, ambiguous: false };
  }

  const hints = diffRegisterVsExpected(registerName, expectedName, brandHint);
  const hasHints = hints.size > 0;

  // If no hints found, fallback to standard common token exclusion
  let tokensToUse = hints;
  if (!hasHints) {
    const regTokens = expandExpectedNameTokens(registerName);
    if (brandHint) {
      const brandTokens = tokenSet(brandHint);
      for (const bt of brandTokens) regTokens.delete(bt);
    }

    const variantTexts = candidates.map(c => `${c.title} ${c.options.join(' ')} ${c.sku || ''}`.toLowerCase());
    const baseShared = (() => {
      if (variantTexts.length === 0) return new Set<string>();
      const first = tokenSet(variantTexts[0]);
      const common = new Set<string>();
      for (const t of first) {
        if (variantTexts.every(vt => tokenSet(vt).has(t))) common.add(t);
      }
      return common;
    })();

    const distinguishingTokens = new Set<string>();
    for (const t of regTokens) {
      if (!baseShared.has(t)) distinguishingTokens.add(t);
    }
    tokensToUse = distinguishingTokens.size > 0 ? distinguishingTokens : regTokens;
  }

  let bestScore = 0;
  let secondScore = 0;
  let bestVariant: VariantCandidate | null = null;

  for (const v of candidates) {
    const s = scoreVariantCandidate(v, tokensToUse);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      bestVariant = v;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  if (!bestVariant || bestScore <= 0) {
    return { matched: null, confidence: 0, ambiguous: false };
  }

  // Margin of winner checking (strict 20% or tie protection)
  const isAmbiguous = bestScore === secondScore || (secondScore > 0 && (bestScore - secondScore) / bestScore < 0.2);

  if (isAmbiguous) {
    return { matched: null, confidence: bestScore / 100, ambiguous: true };
  }

  const confidence = Math.min(1.0, bestScore / 100);
  return { matched: bestVariant, confidence, ambiguous: false };
}

/**
 * Top-level resolveVariantUrl
 */
// used by tests
export async function resolveVariantUrl(
  baseUrl: string,
  registerName: string,
  expectedName: string | null,
  brandHint: string | null,
): Promise<VariantResolutionResult> {
  const resultTemplate = (method: VariantResolutionResult['method'], resolvedUrl = baseUrl, total = 0, variantId: string | null = null, variantTitle: string | null = null): VariantResolutionResult => ({
    resolvedUrl,
    variantId,
    variantTitle,
    confidence: 1.0,
    method,
    totalVariants: total,
    ambiguous: false
  });

  // Early returns
  try {
    const urlObj = new URL(baseUrl);
    if (urlObj.searchParams.has('variant')) {
      return resultTemplate('url_param', baseUrl, 1, urlObj.searchParams.get('variant'));
    }
    if (urlObj.searchParams.has('variation_id')) {
      return resultTemplate('url_param', baseUrl, 1, urlObj.searchParams.get('variation_id'));
    }
  } catch {
    return resultTemplate('none');
  }

  // Fetch page HTML
  let html: string;
  try {
    const response = await fetch(baseUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      return resultTemplate('none');
    }
    html = await response.text();
  } catch (err) {
    console.warn(`[variant-resolver] Failed to fetch page for variant resolution: ${baseUrl}`, err);
    return resultTemplate('none');
  }

  // Try Strategy Chain
  let candidates = extractVariantsFromJsonLd(html);
  let method: VariantResolutionResult['method'] = 'jsonld';

  if (candidates.length === 0) {
    candidates = extractVariantsFromShopify(html);
    method = 'shopify';
  }

  if (candidates.length === 0) {
    candidates = extractVariantsFromWooCommerce(html);
    method = 'woocommerce';
  }

  const total = candidates.length;
  if (total === 0) {
    return resultTemplate('none');
  }

  if (total === 1) {
    const single = candidates[0];
    const url = constructVariantUrl(baseUrl, single, method);
    return resultTemplate('single_variant', url, 1, single.platformId, single.title);
  }

  // Run matching
  const match = matchVariant(candidates, registerName, expectedName, brandHint);
  if (match.ambiguous) {
    return {
      resolvedUrl: baseUrl,
      variantId: null,
      variantTitle: null,
      confidence: match.confidence,
      method: 'none',
      totalVariants: total,
      ambiguous: true
    };
  }

  if (match.matched) {
    const url = constructVariantUrl(baseUrl, match.matched, method);
    return {
      resolvedUrl: url,
      variantId: match.matched.platformId,
      variantTitle: match.matched.title,
      confidence: match.confidence,
      method,
      totalVariants: total,
      ambiguous: false
    };
  }

  return resultTemplate('none', baseUrl, total);
}

function constructVariantUrl(base: string, v: VariantCandidate, method: string): string {
  if (v.url && (v.url.startsWith('http://') || v.url.startsWith('https://'))) {
    return v.url;
  }
  if (v.url && v.url.startsWith('?')) {
    const urlObj = new URL(base);
    const params = new URLSearchParams(v.url);
    for (const [key, val] of params.entries()) {
      urlObj.searchParams.set(key, val);
    }
    return urlObj.toString();
  }

  const urlObj = new URL(base);
  if (method === 'shopify' && v.platformId) {
    urlObj.searchParams.set('variant', v.platformId);
    return urlObj.toString();
  }
  if (method === 'woocommerce' && v.platformId) {
    urlObj.searchParams.set('variation_id', v.platformId);
    return urlObj.toString();
  }

  return base;
}

// ── Canonical variant-resolution contracts (Issue #90 M2) ─────────────────
// Additive, deterministic, no network — single matcher serving Discovery + worker.
export const MAX_NORMALIZED_VARIANTS = 250;
export const MAX_OPTIONS_PER_VARIANT = 8;
export const MAX_IDENTIFIERS_PER_VARIANT = 12;
export const MAX_IMAGES_PER_VARIANT = 32;
export const VARIANT_MATCH_SCORE_THRESHOLD = 60;
export const VARIANT_MATCH_MARGIN_RATIO = 0.2;

// Versioned alias dictionaries — exact normalized matching only, no substring.
export const CANONICAL_SIZE_ALIASES: Record<string, string[]> = {
  small: ['small', 'sm', 's'],
  large: ['large', 'lg', 'l'],
  mini: ['mini', 'mn'],
  medium: ['medium', 'med', 'md', 'm'],
  'x-small': ['x-small', 'xsmall', 'xs'],
  'x-large': ['x-large', 'xlarge', 'xl'],
};
// Reverse lookup: alias -> canonical
export const SIZE_ALIAS_TO_CANONICAL: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(CANONICAL_SIZE_ALIASES)) {
    for (const a of aliases) m[a] = canonical;
  }
  return m;
})();

import { normalizeGtin, validateGtin, canonicalGtinMatch } from '../shared/gtin';
export { normalizeGtin, validateGtin, canonicalGtinMatch };
export function normalizeSkuMpn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const nfkc = String(raw).normalize('NFKC').trim();
  if (!nfkc) return null;
  return nfkc.toLowerCase();
}
function normalizeAxis(raw: string): string {
  return String(raw).normalize('NFKC').trim().toLowerCase();
}
function normalizeOptionValue(raw: string): string {
  const t = String(raw).normalize('NFKC').trim().toLowerCase();
  // map alias to canonical for size-like options
  return SIZE_ALIAS_TO_CANONICAL[t] ?? t;
}
function stableVariantKey(platform: string, id: string | null, title: string, idx: number): string {
  const base = `${platform}:${id ?? 'idx'+idx}:${title}`.toLowerCase().replace(/\s+/g, '-');
  return base.slice(0, 256);
}

function makeIdentifiers(opts: { gtin?: string | null; sku?: string | null; mpn?: string | null; platformId?: string | null; barcode?: string | null; sourcePath: string }): VariantIdentifier[] {
  const out: VariantIdentifier[] = [];
  const gtinNorm = normalizeGtin(opts.gtin ?? opts.barcode ?? null);
  if (gtinNorm) out.push({ kind: 'gtin', value: String(opts.gtin ?? opts.barcode ?? gtinNorm), normalizedValue: gtinNorm, sourcePath: opts.sourcePath + '.gtin' });
  const skuNorm = normalizeSkuMpn(opts.sku);
  if (skuNorm) out.push({ kind: 'sku', value: String(opts.sku), normalizedValue: skuNorm, sourcePath: opts.sourcePath + '.sku' });
  const mpnNorm = normalizeSkuMpn(opts.mpn);
  if (mpnNorm && mpnNorm !== skuNorm) out.push({ kind: 'mpn', value: String(opts.mpn), normalizedValue: mpnNorm, sourcePath: opts.sourcePath + '.mpn' });
  if (opts.platformId) out.push({ kind: 'platform_id', value: String(opts.platformId), normalizedValue: String(opts.platformId).toLowerCase(), sourcePath: opts.sourcePath + '.platform_id' });
  return out.slice(0, MAX_IDENTIFIERS_PER_VARIANT);
}
function makeOptions(rawOptions: Array<{ axis: string; value: string }>, sourcePath: string): VariantOption[] {
  return rawOptions.filter(o => o.value && o.axis).slice(0, MAX_OPTIONS_PER_VARIANT).map(o => ({
    axis: o.axis,
    value: o.value,
    normalizedAxis: normalizeAxis(o.axis),
    normalizedValue: normalizeOptionValue(o.value),
    sourcePath,
  }));
}
function makeImages(raw: Array<{ url: string; role?: 'primary'|'gallery'; width?: number; height?: number }>, sourcePath: string): VariantImage[] {
  return raw.filter(i => i.url).slice(0, MAX_IMAGES_PER_VARIANT).map(i => ({
    url: i.url,
    role: (i.role ?? 'gallery') as 'primary'|'gallery',
    width: i.width,
    height: i.height,
    sourcePath,
  }));
}

// ── Adapters: each parses structured content already in memory ───────────

export function parseShopifyMatrix(htmlOrJson: string, parentUrl: string): VariantMatrix | null {
  // htmlOrJson may be pure JSON (from .js) or HTML containing productJSON
  let payload: any = null;
  const trimmed = htmlOrJson.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { payload = JSON.parse(trimmed); } catch { payload = null; }
    if (Array.isArray(payload)) payload = payload[0];
  }
  if (!payload) {
    const candidates = extractVariantsFromShopify(htmlOrJson);
    // fallback: try to extract productJSON script and parse via cheerio path already covered
    // Reconstruct a synthetic matrix from VariantCandidate
    if (candidates.length === 0) return null;
    const norm: NormalizedVariantCandidate[] = candidates.map((c, i) => ({
      variantKey: stableVariantKey('shopify', c.platformId, c.title, i),
      platformId: c.platformId,
      title: c.title || 'Variant ' + (i+1),
      identifiers: makeIdentifiers({ platformId: c.platformId, sku: c.sku, barcode: (c as any).barcode ?? null, gtin: (c as any).barcode ?? null, sourcePath: `shopify.variants[${i}]` }),
      options: makeOptions(c.options.map((o, oi) => ({ axis: `option${oi+1}`, value: o })), `shopify.variants[${i}].options`),
      available: c.available,
      price: null,
      currency: null,
      weight: null,
      dimensions: null,
      images: [],
      deepLink: c.url ? new URL(c.url, parentUrl).toString() : `${parentUrl}?variant=${c.platformId ?? ''}`,
      sourcePaths: { shopify: `shopify.variants[${i}]` },
    }));
    if (norm.length > MAX_NORMALIZED_VARIANTS) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'shopify', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: norm.slice(0, MAX_NORMALIZED_VARIANTS), warnings: ['too_many_variants'], createdAt: new Date().toISOString() };
    return { parserVersion: VARIANT_PARSER_VERSION, platform: 'shopify', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: norm, warnings: [], createdAt: new Date().toISOString() };
  }
  // Payload is Shopify product JSON (.js)
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  if (variants.length === 0) return null;
  const images: any[] = Array.isArray(payload.images) ? payload.images : [];
  const imageByVariant = new Map<string, string>();
  for (const img of images) {
    const vids: number[] = Array.isArray(img.variant_ids) ? img.variant_ids : [];
    for (const vid of vids) imageByVariant.set(String(vid), img.src);
  }
  const candidates: NormalizedVariantCandidate[] = variants.map((v: any, idx: number) => {
    const opts: Array<{axis:string;value:string}> = [];
    if (v.option1) opts.push({ axis: payload.options?.[0]?.name ?? 'option1', value: String(v.option1) });
    if (v.option2) opts.push({ axis: payload.options?.[1]?.name ?? 'option2', value: String(v.option2) });
    if (v.option3) opts.push({ axis: payload.options?.[2]?.name ?? 'option3', value: String(v.option3) });
    const price = v.price != null ? String(v.price) : null;
    const weight = v.weight != null ? String(v.weight) : null;
    const imgUrl = v.featured_image?.src ?? v.featured_image ?? v.image?.src ?? imageByVariant.get(String(v.id)) ?? null;
    const deepLink = `${parentUrl.split('?')[0].split('#')[0]}?variant=${v.id}`;
    return {
      variantKey: stableVariantKey('shopify', String(v.id), v.title ?? opts.map(o=>o.value).join(' / ') ?? String(v.id), idx),
      platformId: v.id != null ? String(v.id) : null,
      title: v.title ?? opts.map(o=>o.value).join(' / ') ?? String(v.id),
      identifiers: makeIdentifiers({ platformId: v.id != null ? String(v.id) : null, sku: v.sku ?? null, barcode: v.barcode ?? v.gtin ?? v.gtin12 ?? v.gtin13 ?? null, sourcePath: `shopify.variants[${idx}]` }),
      options: makeOptions(opts, `shopify.variants[${idx}].options`),
      available: v.available !== false,
      price: price ? (String(price).includes('.') ? price : String(parseInt(price,10)/100)) : null,
      currency: null,
      weight,
      dimensions: null,
      images: makeImages(imgUrl ? [{ url: imgUrl, role: 'primary' }] : [], `shopify.variants[${idx}].image`),
      deepLink,
      sourcePaths: { shopify: `shopify.variants[${idx}]` },
    };
  });
  if (candidates.length > MAX_NORMALIZED_VARIANTS) {
    return { parserVersion: VARIANT_PARSER_VERSION, platform: 'shopify', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: candidates.slice(0, MAX_NORMALIZED_VARIANTS), warnings: ['too_many_variants'], createdAt: new Date().toISOString() };
  }
  return { parserVersion: VARIANT_PARSER_VERSION, platform: 'shopify', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: [], createdAt: new Date().toISOString() };
}

export function parseJsonLdMatrix(html: string, parentUrl: string): VariantMatrix | null {
  const $ = cheerio.load(html);
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => { scripts.push($(el).text() || ''); return; });
  const allCandidates: NormalizedVariantCandidate[] = [];
  const warnings: string[] = [];
  let idxBase = 0;
  for (const script of scripts) {
    let data: any;
    try { data = JSON.parse(script); } catch { warnings.push('jsonld_parse_error'); continue; }
    const items: any[] = data['@graph'] ? data['@graph'] : [data];
    for (const item of items) {
      const type = item['@type'];
      const isGroup = type === 'ProductGroup' || (Array.isArray(type) && type.includes('ProductGroup'));
      const isProductWithVariants = type === 'Product' && Array.isArray(item.hasVariant);
      if (!isGroup && !isProductWithVariants) continue;
      const variants: any[] = Array.isArray(item.hasVariant) ? item.hasVariant : [];
      for (const v of variants) {
        if (!v || (v['@type'] !== 'Product' && !(Array.isArray(v['@type']) && v['@type'].includes('Product')))) continue;
        const additionalProps: any[] = Array.isArray(v.additionalProperty) ? v.additionalProperty : [];
        if (additionalProps.length > MAX_OPTIONS_PER_VARIANT) warnings.push('candidate_options_overflow');
        const opts: Array<{axis:string;value:string}> = additionalProps.filter((p:any)=>p.name && p.value).map((p:any)=>({ axis: String(p.name), value: String(p.value) }));
        // Fallback: derive options from variesBy + name suffix not implemented — rely on additionalProperty
        const gtin = v.gtin12 ?? v.gtin13 ?? v.gtin14 ?? v.gtin ?? v.gtin8 ?? null;
        const sku = v.sku ?? null;
        const mpn = v.mpn ?? null;
        const offersRaw: any = v.offers;
        const offer: any = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
        const url = v.url ?? offer?.url ?? null;
        const title = v.name ?? '';
        const price = offer?.price != null ? String(offer.price) : null;
        const currency = offer?.priceCurrency ?? null;
        const weight = v.weight?.value != null ? String(v.weight.value) : null;
        const image = typeof v.image === 'string' ? v.image : Array.isArray(v.image) ? v.image[0] : v.image?.url ?? null;
        const deepLink = url ? String(url) : `${parentUrl}?variant=jsonld-${idxBase}`;
        allCandidates.push({
          variantKey: stableVariantKey('jsonld', sku ?? gtin ?? String(idxBase), title, idxBase),
          platformId: sku ?? gtin ?? String(idxBase),
          title: title || `Variant ${idxBase+1}`,
          identifiers: makeIdentifiers({ gtin, sku, mpn, platformId: sku ?? gtin ?? null, sourcePath: `jsonld.hasVariant[${idxBase}]` }),
          options: makeOptions(opts, `jsonld.hasVariant[${idxBase}].additionalProperty`),
          available: (offer?.availability ?? '').toString().toLowerCase().includes('outofstock') ? false : true,
          price,
          currency,
          weight,
          dimensions: null,
          images: makeImages(image ? [{ url: image, role: 'primary' }] : [], `jsonld.hasVariant[${idxBase}].image`),
          deepLink,
          sourcePaths: { jsonld: `jsonld.hasVariant[${idxBase}]` },
        });
        idxBase++;
      }
      // Also handle Product isVariantOf with offers — single variant pages not needed for group
    }
  }
  if (allCandidates.length === 0) return null;
  if (allCandidates.length > MAX_NORMALIZED_VARIANTS) warnings.push('too_many_variants');
  return { parserVersion: VARIANT_PARSER_VERSION, platform: 'jsonld', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: allCandidates.slice(0, MAX_NORMALIZED_VARIANTS), warnings, createdAt: new Date().toISOString() };
}

export function parseWooMatrix(html: string, parentUrl: string): VariantMatrix | null {
  const $ = cheerio.load(html);
  const form = $('form.variations_form[data-product_variations]');
  if (form.length === 0) return null;
  const dataStr = form.attr('data-product_variations') ?? '';
  if (!dataStr) return null;
  // HTML entities decoded by cheerio attr
  let data: any;
  try { data = JSON.parse(dataStr); } catch { return null; }
  if (!Array.isArray(data) || data.length === 0) return null;
  const warnings: string[] = [];
  const candidates: NormalizedVariantCandidate[] = data.map((v: any, idx: number) => {
    const attrs: Record<string,string> = v.attributes ?? {};
    const rawAttrCount = Object.keys(attrs).length;
    if (rawAttrCount > MAX_OPTIONS_PER_VARIANT) warnings.push('candidate_options_overflow');
    const opts: Array<{axis:string;value:string}> = Object.entries(attrs).filter(([, val]) => val).map(([k, val]) => ({
      axis: k.replace(/^attribute_pa_/, '').replace(/^attribute_/, ''),
      value: String(val),
    }));
    const price = v.display_price != null ? String(v.display_price) : v.price != null ? String(v.price) : null;
    const weight = v.weight != null ? String(v.weight) : null;
    const img = v.image?.src ?? v.image?.url ?? null;
    const deepLink = v.variation_id ? `${parentUrl.split('?')[0].split('#')[0]}?variation_id=${v.variation_id}` : parentUrl;
    return {
      variantKey: stableVariantKey('woocommerce', String(v.variation_id ?? idx), opts.map(o=>o.value).join(' / ') || String(v.variation_id ?? idx), idx),
      platformId: v.variation_id != null ? String(v.variation_id) : null,
      title: opts.map(o=>o.value).join(' / ') || `Variant ${idx+1}`,
      identifiers: makeIdentifiers({ platformId: v.variation_id != null ? String(v.variation_id) : null, sku: v.sku ?? null, sourcePath: `woocommerce.variations[${idx}]` }),
      options: makeOptions(opts, `woocommerce.variations[${idx}].attributes`),
      available: v.is_in_stock !== false,
      price,
      currency: null,
      weight,
      dimensions: v.dimensions ? JSON.stringify(v.dimensions) : null,
      images: makeImages(img ? [{ url: img, role: 'primary' }] : [], `woocommerce.variations[${idx}].image`),
      deepLink,
      sourcePaths: { woocommerce: `woocommerce.variations[${idx}]` },
    };
  });
  if (candidates.length > MAX_NORMALIZED_VARIANTS) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'woocommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: candidates.slice(0, MAX_NORMALIZED_VARIANTS), warnings: [...warnings, 'too_many_variants'], createdAt: new Date().toISOString() };
  if (warnings.length>0) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'woocommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings, createdAt: new Date().toISOString() };
  return { parserVersion: VARIANT_PARSER_VERSION, platform: 'woocommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: [], createdAt: new Date().toISOString() };
}

export function parseBigCommerceMatrix(html: string, parentUrl: string): VariantMatrix | null {
  const candidates: NormalizedVariantCandidate[] = [];
  const bcMatch = html.match(/window\.bcvariants\s*=\s*(\[[\s\S]*?\]);/);
  const bcDataMatch = html.match(/window\.BCData\s*=\s*(\{[\s\S]*?\});/);
  if (!bcMatch) return null;
  let data: any;
  try { data = JSON.parse(bcMatch[1]); } catch { return null; }
  if (!Array.isArray(data) || data.length === 0) return null;
  const bcWarnings: string[] = [];
  for (let idx=0; idx<data.length; idx++) {
    const v = data[idx];
    const rawOpts: string[] = Array.isArray(v.options) ? v.options : [];
    if (rawOpts.length > MAX_OPTIONS_PER_VARIANT) bcWarnings.push('candidate_options_overflow');
    const opts: Array<{axis:string;value:string}> = rawOpts.map((val: string, oi: number) => ({ axis: `option${oi+1}`, value: String(val) }));
    const deepLink = `${parentUrl.split('?')[0].split('#')[0]}?sku=${encodeURIComponent(v.sku ?? v.id)}`;
    candidates.push({
      variantKey: stableVariantKey('bigcommerce', String(v.id), (v.options??[]).join(' / ') || String(v.id), idx),
      platformId: v.id != null ? String(v.id) : null,
      title: (v.options??[]).join(' / ') || String(v.id),
      identifiers: makeIdentifiers({ platformId: String(v.id), sku: v.sku ?? null, sourcePath: `bigcommerce.variants[${idx}]` }),
      options: makeOptions(opts, `bigcommerce.variants[${idx}].options`),
      available: true,
      price: v.price != null ? String(v.price) : null,
      currency: null,
      weight: null,
      dimensions: null,
      images: makeImages(v.image ? [{ url: v.image, role: 'primary' }] : [], `bigcommerce.variants[${idx}].image`),
      deepLink,
      sourcePaths: { bigcommerce: `bigcommerce.variants[${idx}]` },
    });
  }
  void bcDataMatch;
  const bcWarningsDedup = Array.from(new Set(bcWarnings));
  if (candidates.length > MAX_NORMALIZED_VARIANTS) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'bigcommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: candidates.slice(0, MAX_NORMALIZED_VARIANTS), warnings: [...bcWarningsDedup, 'too_many_variants'], createdAt: new Date().toISOString() };
  if (bcWarningsDedup.length>0) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'bigcommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: bcWarningsDedup, createdAt: new Date().toISOString() };
  return { parserVersion: VARIANT_PARSER_VERSION, platform: 'bigcommerce', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: [], createdAt: new Date().toISOString() };
}

export function parseMagentoMatrix(html: string, parentUrl: string): VariantMatrix | null {
  const keyIdx = html.indexOf('"jsonConfig"');
  if (keyIdx === -1) return null;
  const colonIdx = html.indexOf(':', keyIdx);
  if (colonIdx === -1) return null;
  const braceStart = html.indexOf('{', colonIdx);
  if (braceStart === -1) return null;
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd === -1) return null;
  const jsonText = html.slice(braceStart, braceEnd + 1);
  let cfg: any;
  try { cfg = JSON.parse(jsonText); } catch { return null; }
  const attrs: Record<string, any> = cfg.attributes ?? {};
  // Build productId -> options map
  const productOptions = new Map<string, Array<{axis:string;value:string}>>();
  for (const attrKey of Object.keys(attrs)) {
    const attr = attrs[attrKey];
    const axis: string = attr.label ?? attr.code ?? attrKey;
    for (const opt of (attr.options ?? [])) {
      const label: string = opt.label ?? String(opt.id);
      const products: string[] = Array.isArray(opt.products) ? opt.products.map(String) : [];
      for (const pid of products) {
        if (!productOptions.has(pid)) productOptions.set(pid, []);
        productOptions.get(pid)!.push({ axis, value: label });
      }
    }
  }
  if (productOptions.size === 0) return null;
  let idx = 0;
  const candidates: NormalizedVariantCandidate[] = [];
  for (const [pid, opts] of productOptions.entries()) {
    candidates.push({
      variantKey: stableVariantKey('magento', pid, opts.map(o=>o.value).join(' / ') || pid, idx),
      platformId: pid,
      title: opts.map(o=>o.value).join(' / ') || pid,
      identifiers: makeIdentifiers({ platformId: pid, sourcePath: `magento.jsonConfig[${idx}]` }),
      options: makeOptions(opts, `magento.jsonConfig[${idx}].options`),
      available: true,
      price: null,
      currency: null,
      weight: null,
      dimensions: null,
      images: [],
      deepLink: parentUrl,
      sourcePaths: { magento: `magento.jsonConfig[${idx}]` },
    });
    idx++;
  }
  const magWarnings: string[] = [];
  // Check overflow per product options before truncation
  for (const opts of productOptions.values()) {
    if (opts.length > MAX_OPTIONS_PER_VARIANT) { magWarnings.push('candidate_options_overflow'); break; }
  }
  const magWarningsDedup = Array.from(new Set(magWarnings));
  if (candidates.length > MAX_NORMALIZED_VARIANTS) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'magento', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates: candidates.slice(0, MAX_NORMALIZED_VARIANTS), warnings: [...magWarningsDedup, 'too_many_variants'], createdAt: new Date().toISOString() };
  if (magWarningsDedup.length>0) return { parserVersion: VARIANT_PARSER_VERSION, platform: 'magento', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: magWarningsDedup, createdAt: new Date().toISOString() };
  return { parserVersion: VARIANT_PARSER_VERSION, platform: 'magento', canonicalParentUrl: parentUrl, sourceFinalUrl: parentUrl, sourceContentHash: null, candidates, warnings: [], createdAt: new Date().toISOString() };
}

/** Ordered adapter registry — try Shopify .js/json first, then JSON-LD, Woo, BigCommerce, Magento. */
export function parseVariantMatrix(html: string, parentUrl: string): VariantMatrix | null {
  const shopify = parseShopifyMatrix(html, parentUrl);
  if (shopify && shopify.candidates.length > 0) return shopify;
  const jsonld = parseJsonLdMatrix(html, parentUrl);
  if (jsonld && jsonld.candidates.length > 0) return jsonld;
  const woo = parseWooMatrix(html, parentUrl);
  if (woo && woo.candidates.length > 0) return woo;
  const bc = parseBigCommerceMatrix(html, parentUrl);
  if (bc && bc.candidates.length > 0) return bc;
  const mag = parseMagentoMatrix(html, parentUrl);
  if (mag && mag.candidates.length > 0) return mag;
  return null;
}

// ── Deterministic matcher (§5.2) ───────────────────────────────────────────

export function deriveVariantTokens(name: string, brandHint?: string | null): string[] {
  if (!name) return [];
  const brandTokens = brandHint ? tokenSet(brandHint) : new Set<string>();
  const all = Array.from(tokenSet(name)).filter(t => !brandTokens.has(t) && t.length >= 2);
  // Keep only tokens that look like variant discriminators (size/color/numbers)
  // but per spec use versioned exact alias parser — keep distinct tokens not stop words.
  const stop = new Set(['and','or','the','with','for','from','pack','count']);
  return all.filter(t => !stop.has(t));
}

/** Normalize a supplied known platform variant ID for exact comparison. */
function normalizePlatformVariantId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = String(raw).trim().toLowerCase();
  return norm ? norm : null;
}

/** Candidates carrying an exact identifier of one kind, key-sorted for determinism. */
function candidatesWithIdentifier(
  matrix: VariantMatrix,
  kind: 'gtin' | 'sku' | 'mpn',
  normalizedValue: string,
): NormalizedVariantCandidate[] {
  return matrix.candidates
    .filter((c) => c.identifiers.some((i) => i.kind === kind && i.normalizedValue === normalizedValue))
    .sort((a, b) => a.variantKey.localeCompare(b.variantKey));
}

/** Candidates carrying an exact platform variant ID, key-sorted for determinism. */
function candidatesWithPlatformId(matrix: VariantMatrix, norm: string): NormalizedVariantCandidate[] {
  return matrix.candidates
    .filter((c) => (c.platformId ?? '').trim().toLowerCase() === norm)
    .sort((a, b) => a.variantKey.localeCompare(b.variantKey));
}

/** Variant key uniquely identified by a known platform variant ID, or null (absent/unknown/duplicate). */
function platformVariantIdUniqueKey(matrix: VariantMatrix, norm: string | null): string | null {
  if (!norm) return null;
  const hits = candidatesWithPlatformId(matrix, norm);
  return hits.length === 1 ? hits[0].variantKey : null;
}

/** Candidates matching the complete exact option tuple, key-sorted for determinism. */
function sortedTupleHits(
  candidates: NormalizedVariantCandidate[],
  allTokens: string[],
  expectedOptionsNorm: Array<{ axis: string; value: string }>,
): NormalizedVariantCandidate[] {
  return candidates
    .filter((c) => matchesCompleteOptionTuple(c, allTokens, expectedOptionsNorm))
    .sort((a, b) => a.variantKey.localeCompare(b.variantKey));
}

export function matchVariantMatrix(matrix: VariantMatrix | null, input: VariantMatchInput): VariantMatchDecision {
  if (!matrix || matrix.candidates.length === 0) {
    return { status: 'no_match', selectedVariantKey: null, reasonCodes: ['no_matrix'], matchedBy: 'none', diagnostics: ['no matrix'], rankedKeys: [] };
  }
  // Overflow flag: warnings includes too_many_variants OR candidates at cap with warning, or actual length > max
  if (matrix.warnings.includes('too_many_variants') || matrix.warnings.some(w => w.startsWith('too_many_variants')) || matrix.candidates.length > MAX_NORMALIZED_VARIANTS) {
    return { status: 'too_many_variants', selectedVariantKey: null, reasonCodes: ['too_many_variants'], matchedBy: 'none', diagnostics: [`too many variants: ${matrix.candidates.length}`], rankedKeys: matrix.candidates.map(c=>c.variantKey) };
  }
  // Per-candidate overflow warnings also fail-closed
  if (matrix.warnings.some(w => w.includes('overflow'))) {
    return { status: 'too_many_variants', selectedVariantKey: null, reasonCodes: ['candidate_overflow'], matchedBy: 'none', diagnostics: ['candidate field overflow — requires operator'], rankedKeys: matrix.candidates.map(c=>c.variantKey) };
  }
  // Duplicate/malformed variantKey check — fail-closed ambiguous
  {
    const seen = new Set<string>();
    for (const c of matrix.candidates) {
      if (!c.variantKey || seen.has(c.variantKey)) {
        return { status: 'ambiguous', selectedVariantKey: null, reasonCodes: ['duplicate_variant_key'], matchedBy: 'none', diagnostics: [`duplicate or malformed variantKey: ${c.variantKey}`], rankedKeys: matrix.candidates.map(x=>x.variantKey) };
      }
      seen.add(c.variantKey);
    }
  }
  const gtinNorm = normalizeGtin(input.gtin ?? null);
  const skuNorm = normalizeSkuMpn(input.sku ?? null);
  const mpnNorm = normalizeSkuMpn(input.mpn ?? null);
  // Known platform variant ID (T4): exact-only, weaker than GTIN/SKU/MPN.
  const platformVariantIdNorm = normalizePlatformVariantId((input as { platformVariantId?: string | null }).platformVariantId);
  const tokens = deriveVariantTokens(input.name, input.brandHint ?? null);
  // Merge explicit variantTokens if provided
  const explicitTokens = (input.variantTokens ?? []).map(t=> normalizeOptionValue(t)).filter(Boolean) as string[];
  const allTokens = Array.from(new Set([...tokens, ...explicitTokens]));
  const expectedOptionsNorm = (input.expectedOptions ?? []).map(o => ({ axis: normalizeAxis(o.axis), value: normalizeOptionValue(o.value) })).filter(o => o.axis && o.value);

  // 1. Unique exact GTIN — but verify consistency with supplied SKU/MPN if they map elsewhere
  if (gtinNorm) {
    const hits = candidatesWithIdentifier(matrix, 'gtin', gtinNorm);
    if (hits.length===1) {
      const gtinWinner = hits[0];
      // Consistency check: compare supplied trusted identifiers directly against winner's identifiers
      if (skuNorm) {
        const winnerSku = gtinWinner.identifiers.find(i => i.kind==='sku')?.normalizedValue ?? null;
        if (winnerSku && winnerSku !== skuNorm) {
          return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_gtin_sku'], matchedBy: 'none', diagnostics: [`gtin ${gtinNorm} winner sku ${winnerSku} mismatched supplied sku ${skuNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
        }
        const skuHits = candidatesWithIdentifier(matrix, 'sku', skuNorm);
        if (skuHits.length===1 && skuHits[0].variantKey !== gtinWinner.variantKey) {
          return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_gtin_sku'], matchedBy: 'none', diagnostics: [`gtin ${gtinNorm} vs sku ${skuNorm} point to different variants`], rankedKeys: hits.map(c=>c.variantKey) };
        }
        if (skuHits.length>1) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['duplicate_identifier'], matchedBy: 'none', diagnostics: [`duplicate sku ${skuNorm}`], rankedKeys: skuHits.map(c=>c.variantKey) };
      }
      if (mpnNorm) {
        const winnerMpn = gtinWinner.identifiers.find(i => i.kind==='mpn')?.normalizedValue ?? null;
        if (winnerMpn && winnerMpn !== mpnNorm) {
          return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_gtin_mpn'], matchedBy: 'none', diagnostics: [`gtin ${gtinNorm} winner mpn mismatched supplied mpn`], rankedKeys: hits.map(c=>c.variantKey) };
        }
        const mpnHits = candidatesWithIdentifier(matrix, 'mpn', mpnNorm);
        if (mpnHits.length===1 && mpnHits[0].variantKey !== gtinWinner.variantKey) {
          return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_gtin_mpn'], matchedBy: 'none', diagnostics: [`gtin ${gtinNorm} vs mpn maps to different variants`], rankedKeys: hits.map(c=>c.variantKey) };
        }
      }
      // Availability check for GTIN exact: unavailable only allowed with exact identifier (which we have — gtin itself)
      // A known platform variant ID pointing at a different variant conflicts: fail closed.
      const platformKey = platformVariantIdUniqueKey(matrix, platformVariantIdNorm);
      if (platformKey && platformKey !== gtinWinner.variantKey) {
        return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_gtin_platform_id'], matchedBy: 'none', diagnostics: [`gtin ${gtinNorm} vs platform variant id ${platformVariantIdNorm} point to different variants`], rankedKeys: [gtinWinner.variantKey, platformKey].sort() };
      }
      return { status:'resolved', selectedVariantKey: gtinWinner.variantKey, reasonCodes: ['gtin_exact'], matchedBy: 'gtin', diagnostics: [`gtin exact ${gtinNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
    }
    if (hits.length>1) {
      // duplicate GTIN — need independent SKU/MPN or complete exact option tuple pointing to same row
      if (skuNorm) {
        const skuHits = hits.filter(c=> c.identifiers.some(i=> i.kind==='sku' && i.normalizedValue===skuNorm));
        if (skuHits.length===1) return { status:'resolved', selectedVariantKey: skuHits[0].variantKey, reasonCodes: ['gtin_duplicate_sku_resolved'], matchedBy: 'sku', diagnostics: [`duplicate gtin resolved by sku ${skuNorm}`], rankedKeys: skuHits.map(c=>c.variantKey) };
      }
      if (mpnNorm) {
        const mpnHits = hits.filter(c=> c.identifiers.some(i=> i.kind==='mpn' && i.normalizedValue===mpnNorm));
        if (mpnHits.length===1) return { status:'resolved', selectedVariantKey: mpnHits[0].variantKey, reasonCodes: ['gtin_duplicate_mpn_resolved'], matchedBy: 'mpn', diagnostics: [`duplicate gtin resolved by mpn`], rankedKeys: mpnHits.map(c=>c.variantKey) };
      }
      // try complete exact option tuple (prefer typed expectedOptions when supplied)
      if (expectedOptionsNorm.length>0 || allTokens.length>0) {
        const tupleHits = sortedTupleHits(hits, allTokens, expectedOptionsNorm);
        if (tupleHits.length===1) {
          const winner = tupleHits[0];
          if (!winner.available) {
            const idMatches = winner.identifiers.some(i => (i.kind==='sku' && i.normalizedValue===skuNorm) || (i.kind==='mpn' && i.normalizedValue===mpnNorm));
            if (!idMatches) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['unavailable_no_identifier'], matchedBy: 'none', diagnostics: ['duplicate gtin tuple winner unavailable without sku/mpn identifier match to winner'], rankedKeys: tupleHits.map(c=>c.variantKey) };
          }
          return { status:'resolved', selectedVariantKey: winner.variantKey, reasonCodes: ['gtin_duplicate_options_resolved'], matchedBy: 'options', diagnostics: ['duplicate gtin resolved by complete option tuple'], rankedKeys: tupleHits.map(c=>c.variantKey) };
        }
      }
      return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['duplicate_identifier'], matchedBy: 'none', diagnostics: [`duplicate gtin ${gtinNorm} on ${hits.length} candidates`], rankedKeys: hits.map(c=>c.variantKey) };
    }
  }
  // 2. Unique trusted SKU
  if (skuNorm) {
    const hits = candidatesWithIdentifier(matrix, 'sku', skuNorm);
    if (hits.length===1) {
      const platformKey = platformVariantIdUniqueKey(matrix, platformVariantIdNorm);
      if (platformKey && platformKey !== hits[0].variantKey) {
        return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_sku_platform_id'], matchedBy: 'none', diagnostics: [`sku ${skuNorm} vs platform variant id ${platformVariantIdNorm} point to different variants`], rankedKeys: [hits[0].variantKey, platformKey].sort() };
      }
      return { status:'resolved', selectedVariantKey: hits[0].variantKey, reasonCodes: ['sku_exact'], matchedBy: 'sku', diagnostics: [`sku exact ${skuNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
    }
    if (hits.length>1) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['duplicate_identifier'], matchedBy: 'none', diagnostics: [`duplicate sku ${skuNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
  }
  if (mpnNorm) {
    const hits = candidatesWithIdentifier(matrix, 'mpn', mpnNorm);
    if (hits.length===1) {
      const platformKey = platformVariantIdUniqueKey(matrix, platformVariantIdNorm);
      if (platformKey && platformKey !== hits[0].variantKey) {
        return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['inconsistent_identifiers_mpn_platform_id'], matchedBy: 'none', diagnostics: [`mpn vs platform variant id ${platformVariantIdNorm} point to different variants`], rankedKeys: [hits[0].variantKey, platformKey].sort() };
      }
      return { status:'resolved', selectedVariantKey: hits[0].variantKey, reasonCodes: ['mpn_exact'], matchedBy: 'mpn', diagnostics: [`mpn exact`], rankedKeys: hits.map(c=>c.variantKey) };
    }
  }
  // 3. Exact known platform variant ID — weaker than GTIN/SKU/MPN.
  // Compared only against candidate variant IDs (never the parent product
  // ID, which cannot equal a variant ID). Precedence is structural: any
  // unique GTIN/SKU/MPN resolution — or a conflict with one — returns
  // from the steps above, so reaching here means no stronger identifier
  // decided the match.
  if (platformVariantIdNorm) {
    const hits = candidatesWithPlatformId(matrix, platformVariantIdNorm);
    if (hits.length>1) {
      return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['duplicate_identifier'], matchedBy: 'none', diagnostics: [`duplicate platform variant id ${platformVariantIdNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
    }
    if (hits.length===1) {
      return { status:'resolved', selectedVariantKey: hits[0].variantKey, reasonCodes: ['platform_id_exact'], matchedBy: 'platform_id', diagnostics: [`platform variant id exact ${platformVariantIdNorm}`], rankedKeys: hits.map(c=>c.variantKey) };
    }
  }
  // 3. Complete exact option tuple — requires expectedOptions if supplied, otherwise token-based but still requires availability signal
  {
    const hasExpected = expectedOptionsNorm.length>0;
    const tupleSource: string[] = hasExpected ? expectedOptionsNorm.map(o=> `${o.axis}=${o.value}`) : allTokens;
    if (tupleSource.length>0) {
      const tupleHits = sortedTupleHits(matrix.candidates, allTokens, expectedOptionsNorm);
      if (tupleHits.length===1) {
        // Availability: unavailable auto-select only with exact trusted identifier matching that candidate
        const winner = tupleHits[0];
        if (!winner.available) {
          const idMatches = winner.identifiers.some(i => (i.kind==='sku' && i.normalizedValue===skuNorm) || (i.kind==='mpn' && i.normalizedValue===mpnNorm) || (i.kind==='gtin' && i.normalizedValue===gtinNorm));
          if (!idMatches) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['unavailable_no_identifier'], matchedBy: 'none', diagnostics: ['exact tuple winner unavailable without identifier'], rankedKeys: tupleHits.map(c=>c.variantKey) };
        }
        return { status:'resolved', selectedVariantKey: winner.variantKey, reasonCodes: ['options_exact_tuple'], matchedBy: 'options', diagnostics: [`exact option tuple ${tupleSource.join(',')}`], rankedKeys: tupleHits.map(c=>c.variantKey) };
      }
      if (tupleHits.length>1) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['options_ambiguous_tuple'], matchedBy: 'none', diagnostics: [`ambiguous tuple ${tupleSource.join(',')}`], rankedKeys: tupleHits.map(c=>c.variantKey) };
      if (hasExpected && tupleHits.length===0) return { status:'no_match', selectedVariantKey: null, reasonCodes: ['options_no_match'], matchedBy: 'none', diagnostics: [`no candidate matches expectedOptions ${tupleSource.join(',')}`], rankedKeys: matrix.candidates.map(c=>c.variantKey) };
    }
  }
  // 4. Ranked scoring fallback — requires option/identifier signal and threshold+margin
  const scored = matrix.candidates.map(c => ({ key: c.variantKey, score: scoreCandidate(c, allTokens, input), candidate: c }));
  scored.sort((a,b)=> b.score - a.score || a.key.localeCompare(b.key));
  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < VARIANT_MATCH_SCORE_THRESHOLD) {
    return { status:'no_match', selectedVariantKey: null, reasonCodes: ['rank_below_threshold'], matchedBy: 'none', diagnostics: [`best score ${best?.score ?? 0} < threshold ${VARIANT_MATCH_SCORE_THRESHOLD}`], rankedKeys: scored.map(s=>s.key) };
  }
  // must have option/identifier signal — scoreCandidate gives 0 if no option token hit and no identifier hit, threshold guards it
  if (!hasOptionOrIdentifierSignal(best.candidate, allTokens, skuNorm, mpnNorm, gtinNorm)) {
    return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['rank_no_identifier_signal'], matchedBy: 'none', diagnostics: ['ranked winner lacks option/identifier signal'], rankedKeys: scored.map(s=>s.key) };
  }
  if (second && best.score === second.score) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['rank_tie'], matchedBy: 'none', diagnostics: ['rank tie'], rankedKeys: scored.map(s=>s.key) };
  if (second) {
    const margin = (best.score - second.score) / best.score;
    if (margin < VARIANT_MATCH_MARGIN_RATIO) return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['rank_margin_insufficient'], matchedBy: 'none', diagnostics: [`margin ${margin.toFixed(2)} < ${VARIANT_MATCH_MARGIN_RATIO}`], rankedKeys: scored.map(s=>s.key) };
  }
  // unavailable check — auto-select only when exact identifier matches that winner candidate (not just any identifier supplied)
  if (!best.candidate.available) {
    const winnerIdMatch = best.candidate.identifiers.some(i => (i.kind==='sku' && i.normalizedValue===skuNorm) || (i.kind==='mpn' && i.normalizedValue===mpnNorm) || (i.kind==='gtin' && i.normalizedValue===gtinNorm));
    if (!winnerIdMatch) {
      return { status:'ambiguous', selectedVariantKey: null, reasonCodes: ['unavailable_no_identifier'], matchedBy: 'none', diagnostics: ['best unavailable without identifier match to winner'], rankedKeys: scored.map(s=>s.key) };
    }
  }
  return { status:'resolved', selectedVariantKey: best.key, reasonCodes: ['ranked_resolved'], matchedBy: 'ranked', diagnostics: [`ranked score ${best.score}`], rankedKeys: scored.map(s=>s.key), score: best.score, margin: second ? (best.score-second.score)/best.score : 1 };
}

function matchesCompleteOptionTuple(candidate: NormalizedVariantCandidate, tokens: string[], expectedOptionsNorm: Array<{axis:string;value:string}> = []): boolean {
  if (expectedOptionsNorm.length>0) {
    // Require exactly one value for every required axis — every expected axis/value must be present, and candidate option count must match
    if (candidate.options.length !== expectedOptionsNorm.length) return false;
    for (const exp of expectedOptionsNorm) {
      const candOpt = candidate.options.find(o => o.normalizedAxis === exp.axis);
      if (!candOpt || candOpt.normalizedValue !== exp.value) return false;
    }
    return true;
  }
  if (tokens.length===0) return false;
  // Axisless fallback: require every token present and candidate has exactly tokens.length options (complete tuple)
  // This prevents incomplete single-token matching a multi-option candidate
  const candVals = new Set(candidate.options.map(o=> o.normalizedValue));
  for (const t of tokens) if (!candVals.has(normalizeOptionValue(t))) return false;
  // Require candidate option count equals token count to be a complete tuple
  if (candidate.options.length !== tokens.length) return false;
  return true;
}
function scoreCandidate(c: NormalizedVariantCandidate, tokens: string[], input: VariantMatchInput): number {
  let s = 0;
  const candVals = new Set(c.options.map(o=> o.normalizedValue));
  const candTitleTokens = tokenSet(c.title);
  for (const t of tokens) {
    const nt = normalizeOptionValue(t);
    if (candVals.has(nt)) s += 60;
    else if (candTitleTokens.has(nt)) s += 30;
  }
  // price proximity bonus small
  if (input.price) {
    const p = parseFloat(String(input.price));
    const cp = c.price ? parseFloat(c.price) : NaN;
    if (!isNaN(p) && !isNaN(cp) && Math.abs(p-cp) < 0.01) s += 10;
    else if (!isNaN(p) && !isNaN(cp) && Math.abs(p-cp) < 1) s += 2;
  }
  // availability penalty
  if (!c.available) s -= 20;
  return Math.max(0, s);
}
function hasOptionOrIdentifierSignal(c: NormalizedVariantCandidate, tokens: string[], sku: string|null, mpn: string|null, gtin: string|null): boolean {
  const candVals = new Set(c.options.map(o=> o.normalizedValue));
  for (const t of tokens) if (candVals.has(normalizeOptionValue(t))) return true;
  if (sku && c.identifiers.some(i=> i.kind==='sku' && i.normalizedValue===sku)) return true;
  if (mpn && c.identifiers.some(i=> i.kind==='mpn' && i.normalizedValue===mpn)) return true;
  if (gtin && c.identifiers.some(i=> i.kind==='gtin' && i.normalizedValue===gtin)) return true;
  return false;
}

