/**
 * Source discovery over locally indexed official brand domains.
 *
 * Brands and their official domains are configured ahead of time by the
 * operator (`brand_sites`, Settings → Domain Configuration). There is NO
 * external web-search/SERP dependence: discovery resolves candidates from
 *
 *   1. **Step 0 — local brand URL index** (`brand_url_index`, populated by
 *      sitemap sync / Shopify catalog ingest): exact UPC/SKU, token and
 *      LLM-selected matches (`local-brand-url-finder.ts`). A high-confidence
 *      match validated by HEAD/GET short-circuits everything else.
 *   2. **Sitemap pass**: fetch (cache-first) the mapped domain's sitemap and
 *      run the matcher's passes (UPC exact, product URL filter, token overlap
 *      + LLM selection) against the indexed URLs.
 *
 * Items that match a distributor record never enter Discovery at all — the
 * sourcing engine routes them straight to Extraction.
 */

import { findBrandSites } from '../db/repositories/brand-site-repo';
import type { InsertSourceData } from '../db/repositories/onboarding-source-repo';
import { getCachedSitemapUrls, insertSitemapCache } from '../db/repositories/sitemap-cache-repo';
import { fetchAndParseSitemap } from './sitemap-fetcher';
import { matchSitemapUrls, type SitemapMatchResult } from './sitemap-matcher';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { isKnownRetailerOrDistributorDomain } from './discovery/retailer-domain-list';
import { scoreBrandDomainMatch } from './discovery/official-domain';
import { resolveVariantsForCandidates } from './variant-url-resolver';
import { findLocalBrandCandidates } from './local-brand-url-finder';
import { getActiveUrlsForDomain } from '../db/repositories/brand-url-index-repo';
import { recordDiscoveryEvent } from '../db/repositories/sitemap-telemetry-repo';
import { deriveVariantTokens } from './variant-resolver';
import { productUrlIdentityKey, hasVariantParam } from './product-url-identity';

/** Minimal structural fetch signature — lets Product Intelligence inject the
 *  policy-gateway bound transport (P0-1); onboarding keeps the global fetch. */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Discover candidate product page URLs from the brand's locally indexed
 * official domain (brand_url_index + sitemap). Never throws for "missing
 * search key" style setup — when no candidates can be produced the caller
 * parks the item via its standard needs_input outcomes.
 */
export interface DiscoveryVariantResolution {
  status: string;
  selectedKey: string | null;
  candidatesCount: number;
  overflow: boolean;
  warnings: string[];
  identityHash: string | null;
  matrixCandidates?: import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[];
}

export async function discoverSources(
  upc: string,
  name: string,
  brandHint?: string | null,
  options?: {
    price?: number | null;
    /**
     * P0-1 (round 3): injected transports so Product Intelligence can bind
     * every HTTP call in the discovery chain to the policy gateway.
     * networkFetch is redirect-aware for sitemap; variantNetworkFetch is single-hop manual for variant pages (resolver owns redirect loop per-hop with 500ms).
     * variantNetworkFetch defaults to networkFetch for backwards compat in tests.
     */
    networkFetch?: NetworkFetch;
    variantNetworkFetch?: NetworkFetch;
    /**
     * Frozen classification model-policy view (issue #17 item A). Protected
     * LLM page-selection calls route through it.
     */
    modelPolicy?: import('../classification/model-policy-gateway').ModelPolicyView | null;
    /**
     * Ticket #123: frozen single-brand domain boundary. When present,
     * discovery runs ONLY these domains (already validated at strategy
     * approval) instead of reloading live brand mappings — a running
     * generation can never expand to a newly mapped domain, and there is
     * no cross-domain short-circuit. Legacy callers omit it (live
     * mappings preserved exactly).
     */
    frozenDomains?: string[];
  }
): Promise<{
  candidates: InsertSourceData[];
  consolidatedName: string | null;
  noDomainMapped?: boolean;
  variantResolution?: DiscoveryVariantResolution | null;
}> {
  // Retrieve pre-mapped brand domains from database — unless the caller
  // pins a frozen boundary (ticket #123: strategy-driven collection uses
  // the generation's frozen approved domains, never live mappings).
  const activeBrandHint = brandHint;
  const activeBrandDomains: string[] = [];
  if (options?.frozenDomains !== undefined) {
    for (const raw of options.frozenDomains) {
      const bareDomain = cleanDomainString(raw);
      if (bareDomain && !activeBrandDomains.includes(bareDomain)) {
        activeBrandDomains.push(bareDomain);
      }
    }
  } else if (activeBrandHint) {
    const knownSites = findBrandSites(activeBrandHint);
    for (const site of knownSites) {
      const bareDomain = cleanDomainString(site.domain);
      if (bareDomain && !activeBrandDomains.includes(bareDomain)) {
        activeBrandDomains.push(bareDomain);
      }
    }
  }

  // A known brand with no official domain mapped halts discovery before any
  // lookup: the operator must map a domain in Settings first (needs_input_setup).
  if (activeBrandHint && activeBrandHint.trim() && activeBrandDomains.length === 0) {
    console.log(`[SourceDiscovery] Brand "${activeBrandHint}" has no official domain configured. Halting discovery.`);
    return {
      candidates: [],
      consolidatedName: null,
      noDomainMapped: true,
    };
  }

  const candidates: InsertSourceData[] = [];

  // ── Step 0: Priority Local Brand URL Index Lookup ────────────────────────
  // For EVERY operator-configured official domain of the brand (a brand may
  // legitimately own several), attempt cheap local discovery against its
  // indexed URLs in configuration order; the first validated high-confidence
  // match (confidence >= 0.85) short-circuits the sitemap matcher below.
  // Validation failures fall through to the next domain, ultimately to the
  // full sitemap pass.
  for (const brandDomain of activeBrandDomains) {
    const activeUrls = getActiveUrlsForDomain(brandDomain);
    if (activeUrls.length === 0) {
      try {
        await fetchSitemapForDiscovery(brandDomain, options?.networkFetch);
      } catch { /* best effort */ }
    }

    let localMatches: Awaited<ReturnType<typeof findLocalBrandCandidates>>;
    try {
      localMatches = await findLocalBrandCandidates(
        brandDomain,
        {
          upc,
          name,
          brandHint: activeBrandHint,
          price: options?.price,
        },
        { modelPolicy: options?.modelPolicy }
      );
    } catch (err) {
      console.warn(`[SourceDiscovery] Local candidate search failed for ${brandDomain}:`, err);
      continue;
    }

    const topLocal = localMatches[0];
    if (!topLocal || topLocal.confidence < 0.85) continue;

    console.log(`[SourceDiscovery] \u2713 High-confidence local sitemap match for UPC ${upc} on ${brandDomain} (${topLocal.url}, confidence: ${topLocal.confidence.toFixed(2)}). Validating URL...`);

    let isValid = true;
    const fetchFn = options?.networkFetch;
    if (!fetchFn) {
      // No policy-gateway transport for local short-circuit validation — fail closed without global fetch
      isValid = topLocal.matchType === 'upc_exact';
    } else {
    try {
      const checkRes = await fetchFn(topLocal.url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!checkRes.ok && checkRes.status !== 405) {
        const getRes = await fetchFn(topLocal.url, {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(6000),
        });
        if (!getRes.ok) isValid = false;
      }
    } catch {
        if (topLocal.matchType !== 'upc_exact') {
          isValid = false;
        }
      }
    }

    if (!isValid) {
      console.log(`[SourceDiscovery] Local candidate ${topLocal.url} failed validation. Falling through to sitemap matching.`);
      continue;
    }

    console.log(`[SourceDiscovery] \u2713 Local match validated for ${topLocal.url}. Short-circuiting sitemap matching.`);

    const localCandidates: InsertSourceData[] = localMatches.map((m) => {
      const rankSignals = buildRankSignals(activeBrandHint, brandDomain);
      return {
        url: m.url,
        title: m.title || null,
        snippet: sitemapSnippetFor(m.matchType),
        domain: brandDomain,
        confidence: m.confidence,
        sourceMethod: m.sourceMethod as InsertSourceData['sourceMethod'],
        ...(rankSignals ? { metadataJson: JSON.stringify(rankSignals) } : {}),
      };
    });

    try {
      recordDiscoveryEvent({
        upc,
        domain: brandDomain,
        satisfied_locally: 1,
        candidate_url: topLocal.url,
        confidence: topLocal.confidence,
        source_method: topLocal.sourceMethod,
      });
    } catch { /* best effort */ }

    // Route local high-confidence candidates through bounded variant resolver
    // so variantResolution is reported even on short-circuit. Preserves
    // high-confidence short-circuit semantics — no sitemap fetch, just variant
    // deep-link resolution. Observe vs active handling is delegated to resolver.
    const variantTokensForLocal = deriveVariantTokens(name, brandHint ?? null);
    let localVariantResolution: DiscoveryVariantResolution | null = null;
    let resolvedLocalCandidates = localCandidates;
    try {
      const vr = await resolveVariantsForCandidates({
        candidates: localCandidates,
        upc,
        rawName: name,
        expectedName: name,
        brandHint: activeBrandHint ?? null,
        brandDomains: activeBrandDomains,
        price: options?.price,
        fetchFn: options?.variantNetworkFetch ?? options?.networkFetch,
        variantTokens: variantTokensForLocal.length > 0 ? variantTokensForLocal : undefined,
      });
      // In observe mode resolver does not mutate URLs; in active it may synthesize deep links.
      // Keep short-circuit: cap to top 10 similarly to sitemap path, but do not re-run sitemap matcher.
      resolvedLocalCandidates = vr.candidates.length > 0 ? vr.candidates : localCandidates;
      if (vr.resolution) {
        localVariantResolution = {
          status: vr.resolution.status,
          selectedKey: vr.resolution.selectedKey,
          candidatesCount: vr.resolution.candidatesCount,
          overflow: vr.resolution.overflow,
          warnings: vr.resolution.warnings,
          identityHash: vr.resolution.identityHash,
          matrixCandidates: (vr.resolution as any).matrixCandidates,
        };
      }
      // Cap to top 10 to preserve ranking semantics
      resolvedLocalCandidates = resolvedLocalCandidates
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10)
        .map(c => ({ ...c, confidence: Math.max(0, Math.min(1, c.confidence)) }));
    } catch (e) {
      console.warn(`[SourceDiscovery] Local variant resolution failed for ${brandDomain}:`, e);
    }

    return {
      candidates: resolvedLocalCandidates,
      // Expected name comes from the imported spreadsheet row only;
      // discovery never synthesizes or persists an expected name.
      consolidatedName: null,
      variantResolution: localVariantResolution,
    };
  }

  // ── Sitemap pass ──────────────────────────────────────────────────────
  // Fetch (cache-first) EVERY mapped official domain's sitemap and run the
  // three-pass matcher (UPC exact, product URL filter, token overlap + LLM
  // selection) against the indexed URLs using the item's spreadsheet name.
  // Candidates from all domains are merged and deduplicated by URL.
  // Sitemap failures NEVER throw — they surface as zero candidates for that
  // domain only.
  const consolidatedName: string | null = null;

  const seenCandidateUrls = new Set<string>();
  // Derive deterministic variant tokens for SitemapLlmContext and variant resolution
  const variantTokensForDiscovery = deriveVariantTokens(name, brandHint ?? null);
  for (const brandDomain of activeBrandDomains) {
    let prepared: Awaited<ReturnType<typeof fetchSitemapForDiscovery>>;
    try {
      prepared = await fetchSitemapForDiscovery(brandDomain, options?.networkFetch);
    } catch (err) {
      console.warn(`[SourceDiscovery] Sitemap fetch failed for ${brandDomain}:`, err);
      continue;
    }
    if (!prepared || prepared.urls.length === 0) continue;
    try {
      const matches = await matchSitemapUrls(
        prepared.urls,
        name,
        consolidatedName,
        upc,
        brandDomain,
        prepared.productUrlPattern,
        options?.modelPolicy,
        variantTokensForDiscovery.length > 0 ? variantTokensForDiscovery : undefined,
      );
      for (const match of matches) {
        const candidate = convertSitemapMatchToCandidate(match);
        // Identity-key dedupe: variant deep links distinct, tracking-only collapse — case-sensitive sku preservation
        let identityKey: string;
        try { identityKey = productUrlIdentityKey(candidate.url); } catch { identityKey = candidate.url.toLowerCase(); }
        if (seenCandidateUrls.has(identityKey)) continue;
        seenCandidateUrls.add(identityKey);
        candidates.push(candidate);
      }
    } catch (err) {
      console.warn(
        `[SourceDiscovery] Sitemap matching failed for ${brandDomain}:`,
        err,
      );
    }
  }

  // Run variant resolution on the candidates before ranking — structured result with resolution summary.
  const variantResult = await resolveVariantsForCandidates({
    candidates,
    upc,
    rawName: name,
    expectedName: consolidatedName || name,
    brandHint: activeBrandHint ?? null,
    brandDomains: activeBrandDomains,
    price: options?.price,
    fetchFn: options?.variantNetworkFetch ?? options?.networkFetch,
    variantTokens: variantTokensForDiscovery.length > 0 ? variantTokensForDiscovery : undefined,
  });
  const variantResolved = variantResult.candidates;
  const variantResolution: DiscoveryVariantResolution | null = variantResult.resolution ? {
    status: variantResult.resolution.status,
    selectedKey: variantResult.resolution.selectedKey,
    candidatesCount: variantResult.resolution.candidatesCount,
    overflow: variantResult.resolution.overflow,
    warnings: variantResult.resolution.warnings,
    identityHash: variantResult.resolution.identityHash,
    matrixCandidates: (variantResult.resolution as any).matrixCandidates,
  } : null;

  // Sort by confidence descending and cap to the top 10.
  const topCandidates = selectTopCandidates(variantResolved, 10).map(c => ({
    ...c,
    confidence: Math.max(0, Math.min(1, c.confidence))
  }));

  // ── Log meaningful discovery results ──────────────────────────────────
  if (topCandidates.length > 0) {
    const top = topCandidates[0];
    console.log(`[SourceDiscovery] Found ${topCandidates.length} source candidates for UPC ${upc}. Top result: ${top.url} (confidence: ${(top.confidence * 100).toFixed(0)}%, domain: ${top.domain})`);

    if (topCandidates.length > 1) {
      const runnersUp = topCandidates.slice(1, 4).map(c =>
        `  · ${c.url} (${(c.confidence * 100).toFixed(0)}%, ${c.domain})`
      );
      console.log(`[SourceDiscovery] Runner-up sources for UPC ${upc}:\n${runnersUp.join('\n')}`);
    }
  } else {
    console.log(`[SourceDiscovery] No matching source URLs found for UPC ${upc}. Search name used: "${name}"`);
  }

  try {
    recordDiscoveryEvent({
      upc,
      domain: topCandidates[0]?.domain ?? activeBrandDomains[0] ?? null,
      satisfied_locally: 0,
      candidate_url: topCandidates[0]?.url || null,
      confidence: topCandidates[0]?.confidence || null,
      source_method: topCandidates[0]?.sourceMethod || null,
    });
  } catch { /* best effort */ }

  return {
    candidates: topCandidates,
    consolidatedName,
    variantResolution,
  };
}

// ─── Ranking-signal metadata ─────────────────────────────────────────────────

/**
 * Rank-signal metadata for a candidate (epic #46 follow-up, phase 6):
 * why this candidate was promoted/demoted — explainable discovery.
 */
function buildRankSignals(
  brandHint: string | null | undefined,
  domain: string,
): { rankSignals: { strongBrandDomainMatch: boolean; brandDomainMatchScore: number; knownRetailerDomain: boolean } } | null {
  const brandDomainMatchScore = scoreBrandDomainMatch(brandHint, domain);
  const knownRetailerDomain = isKnownRetailerOrDistributorDomain(domain);
  if (brandDomainMatchScore < 0.5 && !knownRetailerDomain) return null;
  return {
    rankSignals: {
      strongBrandDomainMatch: brandDomainMatchScore >= 0.5,
      brandDomainMatchScore,
      knownRetailerDomain,
    },
  };
}

// ─── Sitemap discovery helpers ────────────────────────────────────────────────

/**
 * Result of a sitemap fetch. `urls` is the flat list of URLs from the
 * sitemap (possibly filtered by `productUrlPattern`); `productUrlPattern`
 * is propagated so the matcher can re-use the same filter on its
 * cached copy; `sourceUrl` is the original sitemap URL that produced
 * the result (used as the cache's `source_url` audit trail).
 */
interface SitemapFetched {
  urls: string[];
  productUrlPattern: string | null;
  sourceUrl: string;
}

/**
 * Cache-first sitemap fetch for a brand domain.
 *
 * Consults `getCachedSitemapUrls` first; on a cache miss, looks up the
 * extractor profile's `sitemapProductUrlPattern` to use as a URL filter
 * and calls `fetchAndParseSitemap` to discover and parse the sitemap.
 * Successful fresh fetches are persisted via `insertSitemapCache` so
 * the next call short-circuits the network round-trip.
 *
 * Never throws — any error (cache miss without a network, profile
 * lookup failure, fetch error, cache write failure) is logged as a
 * warning and surfaces as a `null` return value.
 */
async function fetchSitemapForDiscovery(
  domain: string,
  networkFetch?: NetworkFetch,
): Promise<SitemapFetched | null> {
  try {
    const cached = getCachedSitemapUrls(domain);
    if (cached) {
      const profile = findProfileByDomain(domain);
      return {
        urls: cached,
        productUrlPattern: profile?.sitemapProductUrlPattern ?? null,
        sourceUrl: '',
      };
    }

    // Cache miss — fetch (and best-effort cache) the sitemap.
    const profile = findProfileByDomain(domain);
    const productUrlPattern = profile?.sitemapProductUrlPattern ?? null;
    if (!networkFetch) {
      console.warn(`[SourceDiscovery] No networkFetch (policy gateway) for ${domain} — skipping sitemap fetch (fail closed)`);
      return { urls: [], productUrlPattern, sourceUrl: '' };
    }
    const result = await fetchAndParseSitemap(domain, productUrlPattern, networkFetch, {
      allowRenderedFallback: false,
    });
    if (result.urls.length > 0) {
      try {
        insertSitemapCache(domain, result.urls, result.sourceUrl);
      } catch (cacheErr) {
        // Cache write failures are not fatal — the URLs are still
        // usable for this run; the next call will just re-fetch.
        console.warn(
          `[SourceDiscovery] Failed to cache sitemap for ${domain}:`,
          cacheErr,
        );
      }
    }
    return {
      urls: result.urls,
      productUrlPattern,
      sourceUrl: result.sourceUrl,
    };
  } catch (err) {
    console.warn(
      `[SourceDiscovery] Sitemap fetch failed for ${domain}:`,
      err,
    );
    return null;
  }
}

/**
 * Convert a single `SitemapMatchResult` from the matcher into the
 * generic `InsertSourceData` shape used by the pipeline. The
 * snippet is a short, human-readable label that records *how* the
 * URL was selected so the discovery drawer can show why a sitemap
 * URL is being surfaced. Title is null because the sitemap only
 * carries URLs — the extraction stage is what produces a title.
 */
function convertSitemapMatchToCandidate(
  match: SitemapMatchResult,
): InsertSourceData {
  return {
    url: match.url,
    title: null,
    snippet: sitemapSnippetFor(match.matchType),
    domain: extractDomain(match.url),
    confidence: match.confidence,
    sourceMethod: match.sourceMethod,
  };
}

function sitemapSnippetFor(matchType: string): string {
  switch (matchType) {
    case 'upc_exact':
      return 'Sitemap match: UPC exact';
    case 'sku_exact':
      return 'Sitemap match: SKU exact';
    case 'llm_selected':
      return 'Sitemap match: LLM-selected by product name';
    case 'token_overlap':
    default:
      return 'Sitemap match: name-token overlap';
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Pick the top N candidates by confidence (plain descending sort).
 */
function selectTopCandidates<T extends { confidence: number }>(
  candidates: T[],
  limit: number,
): T[] {
  if (candidates.length <= limit) return [...candidates];
  return [...candidates]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Extract domain from a URL.
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Clean a brand site domain to return only the bare domain name.
 */
function cleanDomainString(domainStr: string): string {
  const cleaned = domainStr.trim().toLowerCase();
  try {
    const urlString = cleaned.match(/^https?:\/\//i) ? cleaned : `https://${cleaned}`;
    const parsed = new URL(urlString);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return cleaned.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  }
}
