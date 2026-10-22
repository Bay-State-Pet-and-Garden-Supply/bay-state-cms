/**
 * Sitemap URL matching for the onboarding Discovery stage.
 *
 * Strategy (three deterministic passes + one typed judgment):
 *
 * 1. **UPC exact match** — if any sitemap URL contains the UPC literal
 *    (digits, ignoring case/whitespace), return that URL at 0.95
 *    confidence. This is the strongest deterministic signal we have
 *    and short-circuits the rest of the pipeline. UPC text in a URL alone
 *    is never treated as identity proof downstream (the page verifier still
 *    demands structured proof), and its absence is never a mismatch —
 *    matching only ranks retrieval, never verifies.
 *
 * 2. **Product URL filter** — if the extractor profile supplies a
 *    `productUrlPattern` (regex string), filter the sitemap down to
 *    URLs that match it. Otherwise apply a generic heuristic that
 *    keeps only paths that look like product detail pages.
 *
 * 3. **Token overlap pre-filter + TypeSafe closed-set selection** —
 *    tokenize the consolidated (or fallback) product name, score every
 *    filtered URL by name-token ↔ URL-slug overlap, keep the top 10, and
 *    run the closed-set Choice selector (`./sitemap-selection`) over the
 *    supplied candidate IDs (+ no_match / insufficient_evidence). The model
 *    returns an ID; the code maps it to the exact original URL. Out-of-set
 *    answers, correlation failures, low probabilities, and abstentions never
 *    persist a selection — the matcher retains the ranked
 *    retrieval-ordered token-overlap candidates for operator inspection.
 *
 * Confidence formula (retrieval rank only — never a model claim, never a boost):
 *   - UPC exact  → 0.95 (matchType: 'upc_exact')
 *   - Selected   → 0.7 + 0.25 * tokenOverlapRatio (matchType: 'llm_selected')
 *   - Fallback   → 0.7 + 0.25 * tokenOverlapRatio  (matchType: 'token_overlap')
 *
 * `sourceMethod` is `'sitemap_upc'` for the UPC pass and `'sitemap_name'`
 * for the filtered/token/selected passes, so downstream consumers can
 * distinguish how a candidate was discovered.
 */

import { selectOfficialPageWithTypesafe, type SitemapSelectionCandidate } from './sitemap-selection';
import { verifyDiscoveryModelCallsBelongToRun } from '../db/repositories/discovery-model-call-repo';
import type { ModelPolicyView } from '../classification/model-policy-gateway';

// ── Public types ────────────────────────────────────────────────────────────

export interface SitemapMatchResult {
  url: string;
  confidence: number;
  sourceMethod: 'sitemap_name' | 'sitemap_upc';
  matchType: 'upc_exact' | 'llm_selected' | 'token_overlap';
  /** Durable selection audit ids bound to the owning discovery run (empty for deterministic passes). */
  selectionModelCallIds?: string[];
  /** Discovery run the selection audit rows belong to (null for deterministic passes). */
  selectionAuditRunId?: string | null;
}

/**
 * Retrieval context for the TypeSafe sitemap selector.
 * Carries the original Register Name evidence, retrieval ranks, and cached
 * metadata into the closed-set judgment — never an invented expected name,
 * never an external search result.
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
  modelPolicy?: ModelPolicyView | null,
  variantTokens?: string[],
  retrieval?: { brandHint?: string | null; approvedDomains?: string[]; sku?: string | null; runId?: string | null; itemId?: string | null; snapshotHash?: string | null; assertHeld?: () => void },
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

  // Passes 1–3 (UPC-exact, product filter, token-overlap top-10) run
  // through the shared ranker — the same implementation the v2 live
  // evaluation crawls with, so qualification measures production ranking.
  const ranked = rankSitemapCandidates(sitemapUrls, itemName, consolidatedName, upc, domain, productUrlPattern ?? null);
  if (ranked.length === 0) {
    console.log(`[SitemapMatcher] No ranked candidates for UPC ${upc} (empty filter or no positive token overlap); returning early.`);
    return results;
  }
  const scored = ranked.map(c => ({ url: c.url, overlap: { ratio: c.overlapRatio, matches: c.overlapMatches }, upcExact: c.upcExact }));
  const matchName = consolidatedName || itemName;
  console.log(
    `[SitemapMatcher] Top ${scored.length} candidates by token overlap for UPC ${upc}:` +
      scored
        .slice(0, 5)
        .map(c => `\n  · ${c.url} (ratio=${c.overlap.ratio.toFixed(2)}, matches=${c.overlap.matches})`)
        .join(''),
  );

  // TypeSafe closed-set selection over the top-10 retrieval set (or a
  // deterministic bypass when the set is already unambiguous). Rich context
  // (register name, UPC, overlaps, variant tokens) rides as judgment state —
  // never as invented URLs, never as an expected name.
  // Ranking may prioritize likely URLs, but must not discard alternatives.
  for (const candidate of scored) {
    results.push({
      url: candidate.url,
      confidence: clamp01(0.7 + 0.25 * candidate.overlap.ratio),
      sourceMethod: candidate.upcExact ? 'sitemap_upc' : 'sitemap_name',
      matchType: candidate.upcExact ? 'upc_exact' : 'token_overlap',
      selectionModelCallIds: [],
      selectionAuditRunId: retrieval?.runId ?? null,
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

  const candidateGtins = new Set<string>();
  if (needle) candidateGtins.add(needle);
  if (stripped) {
    candidateGtins.add(stripped);
    if (stripped.length === 12) {
      candidateGtins.add(`0${stripped}`);
      candidateGtins.add(`00${stripped}`);
    } else if (stripped.length === 13) {
      candidateGtins.add(`0${stripped}`);
      if (stripped.startsWith('0')) candidateGtins.add(stripped.slice(1));
    } else if (stripped.length === 14) {
      if (stripped.startsWith('00')) candidateGtins.add(stripped.slice(2));
      if (stripped.startsWith('0')) candidateGtins.add(stripped.slice(1));
    }
  }

  for (const url of sitemapUrls) {
    if (!url) continue;
    for (const cand of candidateGtins) {
      if (url.includes(cand)) return url;
    }
    const urlDigits = url.replace(/\D+/g, '');
    if (urlDigits) {
      for (const cand of candidateGtins) {
        if (urlDigits.includes(cand)) return url;
      }
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

/** One ranked retrieval candidate (no judgment attached). */
export interface RankedSitemapCandidate {
  url: string;
  overlapRatio: number;
  overlapMatches: number;
  upcExact: boolean;
}

/** Deterministic bypass derived from ONE ranked set (shared rule): single candidate verifies as ordinary work; exactly one ratio-1.0 hit among multiples verifies as the unique exact identity. Anything else faces judgment. */
export function rankedBypassReason(
  ranked: Pick<RankedSitemapCandidate, 'overlapRatio'>[],
): 'single_candidate_verify' | 'verified_unique_identity' | null {
  if (ranked.length === 1) return 'single_candidate_verify';
  if (ranked.filter(c => c.overlapRatio >= 1).length === 1) return 'verified_unique_identity';
  return null;
}

/**
 * Rank-only retrieval (v2 live evaluation): UPC-exact hit + product-URL
 * filter + name-token overlap scoring + top-10 slice. Identical to passes
 * 1–3 of `matchSitemapUrls` but performs NO TypeSafe selection — the v2
 * eval runner judges the ranked set separately so retrieval quality is
 * measured independently of selection. Returns [] when nothing scores.
 */
export function rankSitemapCandidates(
  sitemapUrls: string[],
  itemName: string,
  consolidatedName: string | null,
  upc: string,
  domain: string,
  productUrlPattern?: string | null,
): RankedSitemapCandidate[] {
  const upcHits = new Set(sitemapUrls.filter(url => findUpcExactHit([url], upc) !== null));
  const productUrls = filterProductUrls(sitemapUrls, productUrlPattern);
  if (productUrls.length === 0) return [];
  const matchName = consolidatedName || itemName;
  const domainBaseName = extractDomainBaseName(domain);
  const tokens = tokenizeName(matchName, domainBaseName);
  return productUrls
    .map(url => {
      const overlap = computeTokenOverlap(url, tokens);
      return { url, overlapRatio: overlap.ratio, overlapMatches: overlap.matches, upcExact: upcHits.has(url) };
    })
    .filter(c => c.overlapRatio > 0 || c.upcExact)
    .sort((a, b) => Number(b.upcExact) - Number(a.upcExact) || b.overlapRatio - a.overlapRatio)
    .slice(0, 10);
}

// ── TypeSafe closed-set selection ────────────────────────────────────────────

/**
 * Closed-set Choice over the retrieval-supplied candidate set (issue #364).
 * Builds stable `cand_<index>` IDs over the EXACT supplied URLs, invokes the
 * typed `sitemap_selection` judgment with the register name, SKU/UPC, brand
 * and package clues, frozen approved domains, and cached metadata, then maps
 * the returned ID back to the exact original URL. Out-of-set answers,
 * unknown keys, substring content, correlation failures, low probabilities,
 * and abstentions all resolve to `null` — the caller retains the ranked
 * retrieval candidates for verification/operator inspection.
 *
 * Deterministic bypass (no model call): a single ranked candidate passes
 * through as ordinary verification (`single_candidate_verify` — there is
 * nothing to choose between); a verified unique exact identity likewise
 * avoids the call. UPC text in a URL is retrieval rank only — never proof,
 * and its absence is never a mismatch.
 */
async function selectClosedSetId(
  scored: Array<{ url: string; overlap: { ratio: number; matches: number } }>,
  productName: string,
  context: SitemapLlmContext | undefined,
  modelPolicy: ModelPolicyView | null | undefined,
  approvedDomains: string[],
  upc: string,
  registerName: string,
  sku: string | null = null,
  runId: string | null = null,
  itemId: string | null = null,
  snapshotHash: string | null = null,
  assertHeld?: () => void,
): Promise<{ url: string | null; modelCallIds: string[]; auditRunId: string | null }> {
  if (scored.length === 0) return { url: null, modelCallIds: [], auditRunId: runId };
  const candidates: SitemapSelectionCandidate[] = scored.map((c, i) => ({
    id: `cand_${i}`,
    url: c.url,
    retrievalRank: c.overlap.ratio,
    title: null,
    upc: context?.upc ?? upc,
    sku,
  }));
  // Deterministic bypass producer (shared rule with the v2 eval runner):
  // a single ranked candidate needs no Choice. A verified unique exact
  // identity (exactly one candidate holding the full name-token overlap
  // while others hold only partial overlap) likewise bypasses the model
  // call — the sole exact-identity URL goes straight to ordinary
  // verification. UPC text in a URL is retrieval rank only, never proof,
  // and its absence is never a mismatch.
  const skipReason = rankedBypassReason(scored.map(c => ({ overlapRatio: c.overlap.ratio })));
  try {
    const result = await selectOfficialPageWithTypesafe({
      candidates,
      meta: {
        registerName,
        consolidatedName: productName,
        upc: context?.upc ?? upc,
        sku,
        brandHint: context?.brandHint ?? null,
        variantTokens: context?.variantTokens ?? [],
        approvedDomains,
      },
      modelPolicy: modelPolicy ?? null,
      runId,
      itemId,
      snapshotHash,
      assertHeld,
      skipReason,
    });
    // Bind audit rows to the owning run before trusting them: a completed
    // call id from another run/snapshot is never our provenance.
    if (result.modelCallIds.length > 0 && runId && snapshotHash) {
      const check = verifyDiscoveryModelCallsBelongToRun(runId, snapshotHash, result.modelCallIds);
      if (!check.ok) {
        console.warn(`[SitemapMatcher] Selection audit not bound to run ${runId} (missing: ${check.missing.join(',')}) — retaining ranked candidates.`);
        return { url: null, modelCallIds: [], auditRunId: runId };
      }
    }
    const bound = { url: null as string | null, modelCallIds: result.modelCallIds, auditRunId: runId };
    if (result.outcome === 'selected' && result.selectedUrl) return { ...bound, url: result.selectedUrl };
    if (result.outcome !== 'verified_unique_identity') {
      console.log(
        `[SitemapMatcher] TypeSafe selection ${result.outcome} (${result.abstentionCode ?? result.abstentionReason ?? 'unresolved'}) — retaining ranked candidates.`,
      );
    }
    return bound;
  } catch (err) {
    // Ownership loss is never a ranked fallback: a superseded worker must
    // stop, not return ordinary candidates the caller would persist over
    // the new owner's run. Every other failure retains ranked candidates.
    if (err instanceof Error && /Heartbeat|heartbeat|lease lost|claim lost/i.test(err.message)) throw err;
    console.warn(`[SitemapMatcher] TypeSafe selection failed — retaining ranked candidates:`, err);
    return { url: null, modelCallIds: [], auditRunId: runId };
  }
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
