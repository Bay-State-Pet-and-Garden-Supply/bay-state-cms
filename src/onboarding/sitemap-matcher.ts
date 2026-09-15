/**
 * Sitemap URL matching for the onboarding Discovery stage.
 *
 * Strategy (three passes):
 *
 * 1. **UPC exact match** — if any sitemap URL contains the UPC literal
 *    (digits, ignoring case/whitespace), return that URL at 0.95
 *    confidence. This is the strongest deterministic signal we have
 *    and short-circuits the rest of the pipeline.
 *
 * 2. **Product URL filter** — if the extractor profile supplies a
 *    `productUrlPattern` (regex string), filter the sitemap down to
 *    URLs that match it. Otherwise apply a generic heuristic that
 *    keeps only paths that look like product detail pages.
 *
 * 3. **Token overlap pre-filter + LLM selection** — tokenize the
 *    consolidated (or fallback) product name, score every filtered
 *    URL by name-token ↔ URL-slug overlap, keep the top 10, and let
 *    the LLM pick the best one (when 2+ candidates and an LLM is
 *    configured). The LLM pick receives a +0.15 confidence boost.
 *
 * Confidence formula:
 *   - UPC exact  → 0.95 (matchType: 'upc_exact')
 *   - LLM pick   → 0.7 + 0.25 * tokenOverlapRatio + 0.15 (matchType: 'llm_selected')
 *   - Fallback   → 0.7 + 0.25 * tokenOverlapRatio  (matchType: 'token_overlap')
 *
 * `sourceMethod` is `'sitemap_upc'` for the UPC pass and `'sitemap_name'`
 * for the filtered/token/LLM passes, so downstream consumers can
 * distinguish how a candidate was discovered.
 */

import { callLlmForTask, getLlmConfigForTask } from './llm-client';

// ── Public types ────────────────────────────────────────────────────────────

export interface SitemapMatchResult {
  url: string;
  confidence: number;
  sourceMethod: 'sitemap_name' | 'sitemap_upc';
  matchType: 'upc_exact' | 'llm_selected' | 'token_overlap';
}

/**
 * Optional extra context for the LLM sitemap selector.
 * When available, the prompt becomes much more specific about
 * the product identity, helping the LLM reject near-misses.
 */
export interface SitemapLlmContext {
  /** Raw register/row name (pre-consolidation). */
  itemName?: string;
  /** Brand hint from the spreadsheet / assignment. */
  brandHint?: string;
  /** Product UPC. */
  upc?: string;
  /** Expected price (when known from the spreadsheet). */
  price?: number | null;
  /** For each candidate URL, the token-overlap ratio [0-1]. */
  candidateOverlaps?: Map<string, number>;
  /** Known variant tokens extracted from the product name. */
  variantTokens?: string[];
}

// ── Stop words ──────────────────────────────────────────────────────────────
// Compact stop-word set tuned for product catalog matching. We do NOT want
// filler words (the, of, with) to dominate the token-overlap signal.
// Includes a few domain-specific noise words (dog, cat, pet) that are
// common across this catalog and rarely disambiguate a specific product.
const STOP_WORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by',
  'from', 'up', 'about', 'into', 'over', 'after',
  'dog', 'cat', 'pet', 'food', 'toy', 'treat',
]);

// Generic heuristic for product detail pages. Used when the extractor
// profile does not supply a more specific `productUrlPattern`.
const GENERIC_PRODUCT_PATH_RE =
  /\/(products?|p|shop|item|dp)\/?[^/]*$/i;

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Match a list of sitemap URLs against an onboarding item.
 *
 * @param sitemapUrls       Full list of URLs pulled from the domain's sitemap.
 * @param itemName          The raw catalog name from the spreadsheet row.
 * @param consolidatedName  Optional previously consolidated clean name hint
 *                          (may be null when no hint is available).
 * @param upc               The product UPC/barcode.
 * @param domain            The brand/retailer domain (for diagnostics).
 * @param productUrlPattern Optional regex string from the extractor profile.
 *                          When present, only URLs matching this pattern are
 *                          considered in the token/LLM pass. When absent, a
 *                          generic /products/|/p/|/shop/|/item/|/dp/ heuristic
 *                          is used.
 * @returns Up to 11 candidate matches (1 UPC-exact + up to 10 filtered).
 */
export async function matchSitemapUrls(
  sitemapUrls: string[],
  itemName: string,
  consolidatedName: string | null,
  upc: string,
  domain: string,
  productUrlPattern?: string | null,
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
  variantTokens?: string[],
): Promise<SitemapMatchResult[]> {
  const results: SitemapMatchResult[] = [];

  console.log(
    `[SitemapMatcher] Matching ${sitemapUrls.length} sitemap URLs for UPC ${upc} on domain ${domain} ` +
      `(consolidated name: ${consolidatedName ? `"${consolidatedName}"` : 'unavailable'})`,
  );

  if (sitemapUrls.length === 0) {
    console.log(`[SitemapMatcher] No sitemap URLs to match for UPC ${upc} — returning empty result.`);
    return results;
  }

  // ── Pass 1: UPC exact match ──────────────────────────────────────────
  const upcHit = findUpcExactHit(sitemapUrls, upc);
  if (upcHit) {
    console.log(`[SitemapMatcher] UPC exact match for ${upc}: ${upcHit}`);
    results.push({
      url: upcHit,
      confidence: 0.95,
      sourceMethod: 'sitemap_upc',
      matchType: 'upc_exact',
    });
  } else {
    console.log(`[SitemapMatcher] No UPC exact match for ${upc} in ${sitemapUrls.length} URLs.`);
  }

  // ── Pass 2: Product URL filter ───────────────────────────────────────
  const productUrls = filterProductUrls(sitemapUrls, productUrlPattern);
  console.log(
    `[SitemapMatcher] Product URL filter: ${productUrls.length} of ${sitemapUrls.length} URLs survive ` +
      `(pattern: ${productUrlPattern || 'generic heuristic'}).`,
  );

  if (productUrls.length === 0) {
    console.log(`[SitemapMatcher] No product URLs survived filter for UPC ${upc}; returning early.`);
    return results;
  }

  // ── Pass 3: Token overlap pre-filter + LLM selection ────────────────
  const matchName = consolidatedName || itemName;
  // Exclude the domain name (and any token it fully contains) from
  // matching — every page on mywoof.com mentions "woof".
  const domainBaseName = extractDomainBaseName(domain);
  const tokens = tokenizeName(matchName, domainBaseName);
  console.log(
    `[SitemapMatcher] Tokenized "${matchName}" → ${tokens.length} tokens` +
      (domainBaseName ? ` (excluded domain name: "${domainBaseName}")` : '') +
      `: [${tokens.join(', ')}]`,
  );

  if (tokens.length === 0) {
    console.log(
      `[SitemapMatcher] No usable tokens from name for UPC ${upc}; returning only UPC-exact result.`,
    );
    return results;
  }

  const scored = productUrls
    .map(url => ({ url, overlap: computeTokenOverlap(url, tokens) }))
    .filter(c => c.overlap.ratio > 0)
    .sort((a, b) => b.overlap.ratio - a.overlap.ratio)
    .slice(0, 10);

  console.log(
    `[SitemapMatcher] Top ${scored.length} candidates by token overlap for UPC ${upc}:` +
      scored
        .slice(0, 5)
        .map(c => `\n  · ${c.url} (ratio=${c.overlap.ratio.toFixed(2)}, matches=${c.overlap.matches}/${tokens.length})`)
        .join(''),
  );

  if (scored.length === 0) {
    console.log(`[SitemapMatcher] No candidates with positive token overlap for UPC ${upc}.`);
    return results;
  }

  // Try LLM selection first (when 2+ candidates and an LLM is configured).
  // Build rich context from the available product info so the LLM can make
  // a more informed decision and reject non-product pages.
  const effectiveVariantTokens = (variantTokens && variantTokens.length > 0) ? variantTokens : deriveVariantTokensForMatcher(matchName, domain);
  const llmContext: SitemapLlmContext = {
    itemName,
    upc,
    candidateOverlaps: new Map(scored.map(c => [c.url, c.overlap.ratio])),
    variantTokens: effectiveVariantTokens,
  };
  const selectedUrl = await selectWithLlm(scored.map(c => c.url), matchName, llmContext, modelPolicy);

  if (selectedUrl) {
    console.log(`[SitemapMatcher] LLM selected ${selectedUrl} for UPC ${upc}.`);
    const picked = scored.find(c => c.url === selectedUrl);
    if (picked) {
      const confidence = clamp01(0.7 + 0.25 * picked.overlap.ratio + 0.15);
      results.push({
        url: picked.url,
        confidence,
        sourceMethod: 'sitemap_name',
        matchType: 'llm_selected',
      });
    }
    return results;
  }

  // Fallback: emit the top-3 token-overlap candidates so downstream
  // consumers still see multiple options when the LLM is unavailable.
  const fallbackCount = Math.min(scored.length, 3);
  console.log(
    `[SitemapMatcher] LLM unavailable or returned no pick; using top ${fallbackCount} token-overlap ` +
      `candidate(s) for UPC ${upc}.`,
  );
  for (const candidate of scored.slice(0, fallbackCount)) {
    results.push({
      url: candidate.url,
      confidence: clamp01(0.7 + 0.25 * candidate.overlap.ratio),
      sourceMethod: 'sitemap_name',
      matchType: 'token_overlap',
    });
  }
  return results;
}

// ── Pass 1: UPC exact match ────────────────────────────────────────────────

/**
 * Return the first URL that contains the UPC literal (case- and
 * whitespace-insensitive), or `null` if no URL matches.
 *
 * We try a couple of variants: the UPC as-is, and the UPC with any
 * non-digit padding (dashes, spaces) stripped. This catches both
 * `https://shop.com/upc/850067859598` and `https://shop.com/p/850067859598.html`.
 *
 * Performance optimization:
 * Direct string search with `url.includes(stripped)` short-circuits exact digit matches
 * without executing regex replacements or allocating string objects.
 */
function findUpcExactHit(sitemapUrls: string[], upc: string): string | null {
  const needle = upc.trim();
  if (!needle) return null;
  const stripped = needle.replace(/\D+/g, '');

  for (const url of sitemapUrls) {
    if (!url) continue;
    if (url.includes(needle)) return url;
    if (stripped && url.includes(stripped)) return url;
    if (stripped && url.replace(/\D+/g, '').includes(stripped)) {
      return url;
    }
  }
  return null;
}

// ── Pass 2: Product URL filter ─────────────────────────────────────────────

/**
 * Filter the sitemap down to URLs that look like product detail pages.
 * The optional `productUrlPattern` from the extractor profile wins when
 * present; otherwise we use a generic regex heuristic.
 *
 * Invalid regex strings are logged and fall back to the generic
 * heuristic so a typo in a profile doesn't silently zero out the
 * matching pipeline.
 */
function filterProductUrls(
  sitemapUrls: string[],
  productUrlPattern?: string | null,
): string[] {
  if (productUrlPattern) {
    try {
      // Same logic as compilePattern in sitemap-fetcher: plain strings
      // become path-prefix patterns (e.g. "products" → /products/).
      const REGEX_SPECIAL = /[\^$.*+?()[\]{}|]/;
      const source = REGEX_SPECIAL.test(productUrlPattern)
        ? productUrlPattern
        : `/${productUrlPattern.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
      const re = new RegExp(source, 'i');
      return sitemapUrls.filter(u => re.test(u));
    } catch (err) {
      console.warn(
        `[SitemapMatcher] Invalid productUrlPattern "${productUrlPattern}" — falling back to generic heuristic.`,
        err,
      );
    }
  }
  return sitemapUrls.filter(u => GENERIC_PRODUCT_PATH_RE.test(u));
}

// ── Pass 3 helpers: tokenize + overlap ──────────────────────────────────────

/**
 * Extract the base name from a domain for token exclusion.
 * E.g. "mywoof.com" → "mywoof", "www.example.co.uk" → "example".
 */
function extractDomainBaseName(domain: string): string | null {
  const cleaned = domain.replace(/^www\./, '').toLowerCase();
  const parts = cleaned.split('.');
  if (parts.length < 2) return null;
  // Take the part right before the TLD (2LD for most, 3LD for .co.uk etc.)
  // Simple heuristic: use the first segment that's not a known SLD.
  const knownSecondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  for (let i = parts.length - 1; i >= 1; i--) {
    if (!knownSecondLevel.has(parts[i])) {
      return parts[i - 1];
    }
  }
  return parts[0];
}

/**
 * Tokenize a product name for overlap matching.
 * - Lowercases
 * - Splits on non-word characters
 * - Filters tokens shorter than 3 chars
 * - Removes common stop words
 */
function tokenizeName(name: string, domainBaseName?: string | null): string[] {
  if (!name) return [];
  const tokens = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));

  // Exclude tokens that appear inside the domain name (or that fully
  // contain it). E.g. when matching against mywoof.com, the token
  // "woof" matches every blog slug so we strip it.
  if (domainBaseName) {
    const dn = domainBaseName.toLowerCase();
    return tokens.filter(t => !dn.includes(t) && !t.includes(dn));
  }
  return tokens;
}

/**
 * Extract the URL slug: the last non-empty path segment, with the
 * file extension stripped. Falls back to the full path when the
 * URL has no recognizable path.
 *
 * Performance optimization:
 * Fast string slicing avoids constructing a WHATWG `URL` object (~4x faster execution
 * and zero heap allocations for object parsing).
 *
 * Contract: sitemap `<loc>` candidates are absolute URLs (sitemaps.org spec;
 * `sitemap-fetcher` guarantees this). The fast path is only valid for
 * absolute `http(s)://` URLs. This intentionally differs from
 * `new URL(...)` for relative URLs, protocol-relative URLs (`//cdn/...`),
 * dot segments (`/a/./b/../c`), and malformed inputs — those inputs
 * never occur in the sitemap pipeline and are handled via a raw-string
 * fallback for robustness. See `sitemap-matcher.test.ts` regression
 * coverage for the parity cases.
 */
export function extractSlug(url: string): string {
  if (!url) return '';
  let path = url;
  const protoIdx = path.indexOf('://');
  if (protoIdx !== -1) {
    const slashIdx = path.indexOf('/', protoIdx + 3);
    path = slashIdx !== -1 ? path.slice(slashIdx) : '/';
  }
  const queryOrHashIdx = path.search(/[?#]/);
  if (queryOrHashIdx !== -1) {
    path = path.slice(0, queryOrHashIdx);
  }
  // Trim trailing slashes (unless path is "/")
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  const lastSlash = path.lastIndexOf('/');
  const last = lastSlash !== -1 ? path.slice(lastSlash + 1) : path;
  if (!last) return path;
  return last.replace(/\.(html?|php|aspx?)$/i, '');
}

/**
 * Score a URL slug against name tokens.
 *
 * URL slugs are machine-generated — the product name always appears
 * as a substring (e.g. "poomergency" → slug "poomergency-lavender").
 * Returns a ratio in [0, 1] (matches / totalTokens).
 */
function computeTokenOverlap(
  url: string,
  tokens: string[],
): { ratio: number; matches: number } {
  if (tokens.length === 0) return { ratio: 0, matches: 0 };
  const slug = extractSlug(url).toLowerCase();
  if (!slug) return { ratio: 0, matches: 0 };

  // URL slugs are machine-generated — the product name always appears
  // as a substring. Bidirectional matching causes false positives
  // (e.g. slug "all" matching token "yellow"). We only check if the
  // name token is a substring of the slug.
  let matches = 0;
  for (const token of tokens) {
    if (slug.includes(token)) {
      matches++;
    }
  }

  return { ratio: matches / tokens.length, matches };
}

// ── LLM selection ──────────────────────────────────────────────────────────

/**
 * Ask the LLM to pick the best URL from a short list.
 * Returns the picked URL (must be in the input list), or `null` when
 * the LLM is unconfigured / the call fails / the response is unparseable
 * / the LLM explicitly says "null" (no good match).
 *
 * Uses the `discovery_candidate_selection` task (→ `sitemap_selection`
 * operation, alias `product_url_selection`) governed by the workspace
 * classification model policy. Falls back silently to the top token-overlap
 * candidate upstream so a missing LLM/policy denial never throws.
 *
 * @param candidates  The candidate URLs (up to 10).
 * @param productName The consolidated (or fallback) product name.
 * @param context     Optional extra identity context (brand, UPC, price,
 *                    token overlap data, variant tokens). When provided,
 *                    the prompt becomes a more specific matching question
 *                    with explicit reject rules.
 */
async function selectWithLlm(
  candidates: string[],
  productName: string,
  context?: SitemapLlmContext,
  modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null,
): Promise<string | null> {
  if (candidates.length < 2) {
    // With 0 or 1 candidate, there is nothing to disambiguate.
    return null;
  }

  // Resolve config first (without making a call) so we can short-circuit
  // when no LLM is configured. This avoids hitting the network just to
  // log "no LLM configured" downstream.
  let config: ReturnType<typeof getLlmConfigForTask>;
  try {
    config = getLlmConfigForTask('discovery_candidate_selection', {
      allowFallback: true,
      modelPolicy,
    });
  } catch (err) {
    console.warn(
      `[SitemapMatcher] getLlmConfigForTask threw — falling back to token overlap:`,
      err,
    );
    return null;
  }
  if (!config) {
    console.log(`[SitemapMatcher] No LLM configured — using token overlap fallback.`);
    return null;
  }

  const numbered = candidates
    .map((u, i) => {
      const overlap = context?.candidateOverlaps?.get(u);
      const overlapNote =
        overlap !== undefined
          ? ` (name-token overlap: ${(overlap * 100).toFixed(0)}%)`
          : '';
      return `${i + 1}. ${u}${overlapNote}`;
    })
    .join('\n');

  // Build a richer product identity section when context is provided.
  const productDetailLines: string[] = [];
  if (context?.itemName) {
    productDetailLines.push(`Register name: "${context.itemName}"`);
  }
  productDetailLines.push(`Consolidated name: "${productName}"`);
  if (context?.brandHint) {
    productDetailLines.push(`Brand: "${context.brandHint}"`);
  }
  if (context?.upc) {
    productDetailLines.push(`UPC: ${context.upc}`);
  }
  if (context?.price !== undefined && context.price !== null) {
    productDetailLines.push(`Expected price: $${context.price}`);
  }
  if (context?.variantTokens && context.variantTokens.length > 0) {
    productDetailLines.push(
      `Known variant tokens (size/color/flavor): ${context.variantTokens.join(', ')}`,
    );
  }
  const productDetail = productDetailLines.join('\n');

  const prompt =
    `You must select the correct product page URL from the list below, or return "null" if none matches exactly.` +
    `\n\n` +
    `--- PRODUCT IDENTITY ---\n` +
    `${productDetail}\n` +
    `\n` +
    `--- RULES ---\n` +
    `1. Choose ONLY a product detail page. NEVER choose a category listing, collection, search result, blog post, information page, or homepage.` +
    `\n` +
    `2. The URL must be the exact product page for the product described above, not a similar or related product.` +
    `\n` +
    `3. If none of the URLs looks like the exact product page, return the literal string "null". Do NOT guess.` +
    `\n` +
    `4. Return ONLY one of: the exact URL (no numbering, no explanation) or the literal string "null".` +
    `\n` +
    `--- CANDIDATE URLs (with name-token overlap % as a hint) ---\n` +
    `${numbered}`;

  const systemPrompt =
    'You are a precise product cataloging assistant. Your job is to pick the SINGLE correct product page URL ' +
    'for the described product from the list, or say "null" if no URL is the exact product. ' +
    'Never guess. Never pick a category, collection, search results, or blog page.';

  let raw: string | null;
  try {
    raw = await callLlmForTask('discovery_candidate_selection', prompt, systemPrompt, {
      allowFallback: true,
      temperature: 0,
      modelPolicy,
    });
  } catch (err) {
    console.warn(
      `[SitemapMatcher] LLM call failed for "${productName}" — falling back to token overlap:`,
      err,
    );
    return null;
  }

  if (!raw) return null;

  // Handle explicit "null" response — the LLM says none of the URLs match.
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'null' || trimmed === '"null"' || trimmed === "'null'") {
    console.log(
      `[SitemapMatcher] LLM explicitly returned null for "${productName}" — no URL is the exact product page.`,
    );
    return null;
  }

  // Normalize the LLM response: strip whitespace, trailing punctuation,
  // and matching surrounding quotes.
  const cleaned = raw
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, '')
    .replace(/[).,;]+$/, '');

  // Find the candidate that the LLM response refers to. We accept an
  // exact match first; if the model added numbering or wrapping, fall
  // back to substring containment.
  const exact = candidates.find(u => u === cleaned);
  if (exact) return exact;

  const substring = candidates.find(u => cleaned.includes(u) || u.includes(cleaned));
  if (substring) return substring;

  console.warn(
    `[SitemapMatcher] LLM response "${raw}" did not match any candidate URL — falling back to token overlap.`,
  );
  return null;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Derive deterministic variant tokens for SitemapLlmContext without widening scope. */
function deriveVariantTokensForMatcher(matchName: string, _domain: string): string[] | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./variant-resolver') as typeof import('./variant-resolver');
    if (typeof mod.deriveVariantTokens === 'function') {
      const toks = mod.deriveVariantTokens(matchName, null);
      return toks.length > 0 ? toks.slice(0, 8) : undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}
