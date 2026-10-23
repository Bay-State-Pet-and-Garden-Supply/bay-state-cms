/**
 * Extract Shopify productJSON from raw HTML using VM-safe parsing.
 *
 * This is a pure module with no project dependencies — it only imports
 * `node:vm` for safe execution of JS object literals embedded in script
 * tags. It should NOT import from `../db/`, `../shared/`, or any other
 * project module.
 */

import * as vm from 'node:vm';

/**
 * Patterns for assignment sites that may carry a Shopify product object.
 * Captures the LHS identifier so we can recognise
 *   - `window.productJSON = { ... }`
 *   - `productJSON = { ... }`
 *   - `let mntn_product_data = { ... }`  (and other `*_product_data`)
 *   - `window.<something>Bundles.push({ ... })`  (object argument)
 *   - `var meta = { "product": { ... } }`         (ShopifyAnalytics meta)
 */
const PRODUCT_JSON_ASSIGNMENT_PATTERNS: { regex: RegExp; identifier: number; kind: 'assign' | 'push' | 'meta' }[] = [
  // window.productJSON = { ... }  or  productJSON = { ... }
  { regex: /window\.productJSON\s*=\s*/g, identifier: 0, kind: 'assign' },
  { regex: /\bproductJSON\s*=\s*/g, identifier: 0, kind: 'assign' },
  // *_product_data = { ... }  (e.g. mntn_product_data = { ... })
  { regex: /[A-Za-z_$][\w$]*_product_data\s*=\s*/g, identifier: 0, kind: 'assign' },
  // window.<x>Bundles.push({ ... })  (object argument only)
  { regex: /window\.[A-Za-z_$][\w$]*Bundles\.push\s*\(\s*\{/g, identifier: 0, kind: 'push' },
  // var meta = { "product": { ... } }   -> unwrap .product
  { regex: /\bvar\s+meta\s*=\s*\{/g, identifier: 0, kind: 'meta' },
];

/**
 * Walk a brace-balanced object literal starting at `startIdx` (the
 * position of the opening `{`). Returns the inclusive end index of the
 * matching `}`, or -1 if no balanced close is found within `maxChars`.
 */
function findObjectEnd(html: string, startIdx: number, maxChars = 800_000): number {
  let openBraces = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = startIdx; i < html.length && i < startIdx + maxChars; i++) {
    const char = html[i];
    if (escape) { escape = false; continue; }
    if (char === '\\') { escape = true; continue; }
    if (inString) {
      if (char === quoteChar) inString = false;
      continue;
    }
    if (char === '"' || char === "'") { inString = true; quoteChar = char; continue; }
    if (char === '`') { inString = true; quoteChar = '`'; continue; }
    if (char === '{') openBraces++;
    else if (char === '}') {
      openBraces--;
      if (openBraces === 0) return i;
    }
  }
  return -1;
}

/**
 * Find all top-level object-literal candidates that look like a Shopify
 * product object (have a `variants` array). Each candidate is returned
 * with a `quality` score so callers can prefer objects whose variants
 * carry `featured_image` / `featured_media` / `image` data.
 */
export interface ProductJsonCandidate {
  obj: any;
  quality: number;
  source: 'productJSON' | 'product_data' | 'bundles' | 'meta';
}

function collectProductJsonCandidates(html: string): ProductJsonCandidate[] {
  const candidates: ProductJsonCandidate[] = [];
  const seen = new Set<number>();

  for (const pattern of PRODUCT_JSON_ASSIGNMENT_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(html)) !== null) {
      const assignEnd = match.index + match[0].length;
      // For the "Bundles.push({ ... })" pattern the regex already ends
      // with the opening `{`; for assign / meta patterns we need to find
      // the next `{` after the assignment.
      let braceStart: number;
      if (pattern.kind === 'push') {
        braceStart = match.index + match[0].length - 1;
      } else {
        braceStart = html.indexOf('{', assignEnd);
      }
      if (braceStart === -1) continue;
      if (seen.has(braceStart)) continue;
      seen.add(braceStart);

      const braceEnd = findObjectEnd(html, braceStart);
      if (braceEnd === -1) continue;

      const jsBlock = html.substring(braceStart, braceEnd + 1);
      let parsed: any;
      try {
        parsed = vm.runInNewContext('(' + jsBlock + ')', {});
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;

      let obj: any = parsed;
      if (pattern.kind === 'meta') {
        // ShopifyAnalytics meta wraps the product under .product
        obj = parsed.product ?? parsed;
      }
      if (!Array.isArray(obj.variants) || obj.variants.length === 0) continue;

      // Quality: how richly the variants carry image data?
      let quality = 0;
      let withImage = 0;
      for (const v of obj.variants) {
        if (v && typeof v === 'object') {
          if (v.featured_image || v.featured_media || v.image) withImage++;
        }
      }
      quality = withImage * 10 + obj.variants.length;
      // Boost the canonical productJSON assignment but only if it
      // already has image data on its variants.
      if (pattern.kind === 'assign' && match[0].includes('productJSON') && withImage > 0) {
        quality += 5;
      }

      candidates.push({
        obj,
        quality,
        source: pattern.kind === 'meta'
          ? 'meta'
          : pattern.kind === 'push'
            ? 'bundles'
            : match[0].includes('_product_data')
              ? 'product_data'
              : 'productJSON',
      });
    }
  }

  return candidates;
}

/**
 * Remove price-like fields from third-party platform data before it leaves
 * this parser. Variant matching needs identifiers, options, availability,
 * and images; product prices always come from the onboarding input.
 */
function removePriceLikeFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) removePriceLikeFields(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (/(?:price|cost|sale)/i.test(key)) {
      delete record[key];
    } else {
      removePriceLikeFields(record[key]);
    }
  }
}

/**
 * Return the best Shopify product object embedded in the HTML, or null
 * if none can be parsed. Prefers objects whose variants carry
 * `featured_image` / `featured_media` / `image` over a bare
 * `window.productJSON` whose variants are just id/title.
 */
export function extractProductJsonFromHtml(html: string): Record<string, any> | null {
  const candidates = collectProductJsonCandidates(html);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.quality - a.quality);
  const product = candidates[0].obj;
  removePriceLikeFields(product);
  return product;
}
