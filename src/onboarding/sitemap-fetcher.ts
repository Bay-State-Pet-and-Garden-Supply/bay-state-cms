/**
 * Sitemap fetcher for the onboarding Discovery stage.
 *
 * Discovers and parses sitemaps (or sitemap indexes) for a brand domain
 * and returns the flattened list of URLs they advertise.
 *
 * Discovery protocol (option C — full):
 *
 *   1. Try a list of *standard* sitemap paths in order on the origin
 *      (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`,
 *      `/sitemap.php`). The first one that returns a successful
 *      `urlset` or `sitemapindex` is used.
 *   2. If every standard path 404s / errors, fetch `/robots.txt` and
 *      look for `Sitemap:` directives. Each declared sitemap URL is
 *      then tried in order until one resolves to a real sitemap.
 *   3. Shopify stores commonly expose product listings at
 *      `/sitemap_products_1.xml` (and `_2`, `_3`, …). We try the
 *      first one as a final fallback after the standard paths and
 *      robots-driven URLs have been exhausted.
 *
 * Parsing rules:
 *
 *   - `<loc>([^<]+)</loc>` is extracted with a single global regex —
 *     no XML library is imported. This is intentional: sitemaps have
 *     a flat, well-known structure and a real parser would be heavier
 *     than the problem requires.
 *   - The presence of a `<sitemapindex>` root element tells us we
 *     have an index document; we then recurse into each child
 *     `<sitemap><loc>…</loc></sitemap>` URL up to a hard cap of
 *     `MAX_INDEX_DEPTH` to prevent run-away fan-out.
 *   - The presence of a `<urlset>` root element tells us we have a
 *     plain URL list, and we extract every `<url><loc>…</loc></url>`.
 *   - Documents that look like neither a urlset nor a sitemapindex
 *     are skipped with a warning so a misconfigured CDN doesn't
 *     silently break discovery.
 *   - `Content-Encoding: gzip` *and* the gzip magic bytes
 *     (`1f 8b`) on the body are both honored, because some servers
 *     ship pre-gzipped bodies without setting the header.
 *
 * Optional filtering:
 *
 *   - When `productUrlPattern` is a valid regex string, every
 *     extracted URL is matched against it (case-insensitive) and
 *     only matches survive. An invalid pattern logs a warning and
 *     disables filtering rather than throwing — a typo in a profile
 *     must not break the discovery pipeline.
 *
 * Caching:
 *
 *   - This function does NOT read or write the cache. The caller
 *     (`source-discovery.ts`) is expected to consult
 *     `sitemap-cache-repo.getCachedSitemapUrls()` first and to call
 *     this fetcher only when the cache is stale or missing. Successful
 *     results are written back to the cache by the caller via
 *     `sitemap-cache-repo.insertSitemapCache(domain, urls, sourceUrl)`.
 */

import { recordDomainStatus } from '../db/repositories/domain-status-repo';
import {
  reconcileSitemapUrls,
  normalizeDomain,
  type BrandUrlPageType,
  type ReconcileResult,
} from '../db/repositories/brand-url-index-repo';
import { recordRefreshRun } from '../db/repositories/sitemap-telemetry-repo';
import { isPrivateOrLinkLocalHost } from '../shared/ssrf';

// ── Public types ────────────────────────────────────────────────────────────

export interface SitemapUrlEntry {
  url: string;
  lastmod?: string | null;
  pageType?: BrandUrlPageType;
}

export interface SitemapFetchResult {
  urls: string[];
  /**
   * The actual sitemap URL that was fetched to produce the result set.
   * For sitemap indexes, this is the root URL of the index, not the
   * inner `<loc>`s that were followed. Empty string when no sitemap
   * was found.
   */
  sourceUrl: string;
  /** Detailed parsed URL entries with lastmod and inferred pageType */
  entries?: SitemapUrlEntry[];
  /** Reconciliation summary against brand_url_index if persisted */
  reconcileResult?: ReconcileResult;
}

interface FetchAttemptTracker {
  lastStatus: number | null;
  isBlocked: boolean;
  blockReason: string | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Per-fetch timeout (ms). Mirrors `HTTP_FETCH_TIMEOUT_MS` in `page-extractor.ts`. */
const FETCH_TIMEOUT_MS = 15000;

/** Hard cap on how many nested sitemap indexes we will follow. */
const MAX_INDEX_DEPTH = 3;

/**
 * User-Agent sent on every request. Mirrors the standard agent used by
 * `page-extractor.ts` so the same sites do not double-rotate us.
 */
const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Accept header set on every sitemap fetch. */
const ACCEPT_HEADER = 'application/xml, text/xml, */*';

/** Standard paths tried in order before falling back to robots.txt. */
const STANDARD_SITEMAP_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap.php',
];

/**
 * Shopify-specific fallbacks. Most Shopify stores expose at least
 * `/sitemap_products_1.xml` even when no other sitemap is reachable.
 * We try the first one and, if the response is a valid urlset, accept
 * it. Higher-numbered shards (`_2.xml`, `_3.xml`, …) are NOT iterated
 * because the index document (when present) already covers them.
 */
const SHOPIFY_SITEMAP_PATHS = [
  '/sitemap_products_1.xml',
];

/** Magic bytes that prefix any gzip stream. */
const GZIP_MAGIC = [0x1f, 0x8b];

// ── Main entry point ────────────────────────────────────────────────────────

/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Infer page type from URL string and optional productUrlPattern.
 */
function inferPageType(url: string, pattern: RegExp | null): BrandUrlPageType {
  if (pattern && pattern.test(url)) return 'product';
  const lower = url.toLowerCase();
  if (/\/(products?|items?|dp|p|goods|catalog)\//i.test(lower)) return 'product';
  if (/\/(collections?|category|categories|department|dept)\//i.test(lower)) return 'category';
  if (/\/(blogs?|news|articles?|pages?|about|contact|policies?)\//i.test(lower)) return 'article';
  return 'product';
}

/**
 * Discover, fetch, and parse the sitemap for a brand domain.
 * Automatically reconciles observed URLs into `brand_url_index` and records refresh history.
 */
export async function fetchAndParseSitemap(
  domain: string,
  productUrlPattern?: string | null,
  fetchFn: NetworkFetch = fetch,
  options?: { persistIndex?: boolean; allowRenderedFallback?: boolean },
): Promise<SitemapFetchResult> {
  const origin = normalizeOrigin(domain);
  const normDomain = normalizeDomain(domain);
  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  if (!origin) {
    console.warn(`[SitemapFetcher] Cannot derive origin from "${domain}" — returning empty result.`);
    return { urls: [], sourceUrl: '' };
  }

  console.log(`[SitemapFetcher] Discovering sitemap for ${origin}`);

  const pattern = compilePattern(productUrlPattern);
  const shouldPersist = options?.persistIndex !== false;
  // When a policy-bound injected transport is supplied, do not launch
  // Camoufox rendered fallback — it would bypass the policy gateway.
  // Default: allow rendered fallback only when using the global fetch.
  const allowRenderedFallback = options?.allowRenderedFallback ?? (fetchFn === (fetch as unknown as NetworkFetch));

  let matchedResult: { entries: SitemapUrlEntry[]; sourceUrl: string } | null = null;
  const tracker: FetchAttemptTracker = {
    lastStatus: null,
    isBlocked: false,
    blockReason: null,
  };

  // ── Step 1: try standard sitemap paths ────────────────────────────────
  for (const path of STANDARD_SITEMAP_PATHS) {
    const url = origin + path;
    const result = await tryFetchSitemap(url, 0, fetchFn, tracker);
    if (result) {
      matchedResult = result;
      break;
    }
  }

  // ── Step 2: try robots.txt Sitemap: directives ────────────────────────
  if (!matchedResult) {
    console.log(
      `[SitemapFetcher] All standard paths failed for ${origin}; falling back to /robots.txt.`,
    );
    const robotsUrls = await parseRobotsSitemaps(origin + '/robots.txt', fetchFn, tracker);
    for (const robotsUrl of robotsUrls) {
      const result = await tryFetchSitemap(robotsUrl, 0, fetchFn, tracker);
      if (result) {
        matchedResult = result;
        break;
      }
    }
  }

  // ── Step 3: try Shopify-specific paths ────────────────────────────────
  if (!matchedResult) {
    for (const path of SHOPIFY_SITEMAP_PATHS) {
      const url = origin + path;
      const result = await tryFetchSitemap(url, 0, fetchFn, tracker);
      if (result) {
        matchedResult = result;
        break;
      }
    }
  }

  // ── Step 4: Camoufox anti-detect browser fallback (if bot-blocked) ────
  if (!matchedResult && tracker.isBlocked && allowRenderedFallback) {
    console.log(
      `[SitemapFetcher] Standard HTTP fetch blocked by bot protection for ${origin}; attempting Camoufox rendered fallback...`,
    );
    try {
      matchedResult = await tryFetchSitemapRendered(origin);
      if (matchedResult && matchedResult.entries.length > 0) {
        console.log(
          `[SitemapFetcher] Camoufox rendered fallback succeeded for ${origin} (${matchedResult.entries.length} URLs resolved).`,
        );
      }
    } catch (err) {
      console.warn(`[SitemapFetcher] Rendered fallback failed for ${origin}:`, err);
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;

  if (matchedResult && matchedResult.entries.length > 0) {
    // Enrich entries with page type
    const enrichedEntries: SitemapUrlEntry[] = matchedResult.entries.map((e) => ({
      ...e,
      pageType: inferPageType(e.url, pattern),
    }));

    const urls = enrichedEntries.map((e) => e.url);
    const filteredUrls = applyPattern(urls, pattern);
    const productCount = enrichedEntries.filter((e) => e.pageType === 'product').length;

    try { recordDomainStatus(stripWww(origin), 'ok'); } catch { /* non-critical */ }

    let reconcileResult: ReconcileResult | undefined;
    if (shouldPersist) {
      try {
        reconcileResult = reconcileSitemapUrls(
          normDomain,
          enrichedEntries,
          matchedResult.sourceUrl,
          completedAt,
        );
      } catch (err) {
        console.error(`[SitemapFetcher] Failed to reconcile URLs for ${normDomain}:`, err);
      }

      try {
        recordRefreshRun({
          domain: normDomain,
          started_at: startedAt,
          completed_at: completedAt,
          status: 'success',
          source_url: matchedResult.sourceUrl,
          total_urls_observed: enrichedEntries.length,
          product_urls_eligible: productCount,
          added_count: reconcileResult?.addedCount ?? 0,
          updated_count: reconcileResult?.updatedCount ?? 0,
          inactivated_count: reconcileResult?.inactivatedCount ?? 0,
          duration_ms: durationMs,
          error_message: null,
          http_status: 200,
        });
      } catch (err) {
        console.error(`[SitemapFetcher] Failed to record refresh history for ${normDomain}:`, err);
      }
    }

    console.log(
      `[SitemapFetcher] Sitemap resolved for ${origin} via ${matchedResult.sourceUrl} (${filteredUrls.length}/${urls.length} URLs eligible).`,
    );

    return {
      urls: filteredUrls,
      sourceUrl: matchedResult.sourceUrl,
      entries: enrichedEntries,
      reconcileResult,
    };
  }

  // Failed to discover sitemap
  console.log(`[SitemapFetcher] No sitemap discovered for ${origin}.`);
  try {
    recordDomainStatus(
      normDomain,
      tracker.isBlocked ? 'blocked' : 'offline',
      tracker.isBlocked
        ? tracker.blockReason || 'Site blocked crawler (HTTP 403 / Cloudflare Challenge)'
        : 'No sitemap discovered',
    );
  } catch { /* non-critical */ }

  if (shouldPersist) {
    try {
      recordRefreshRun({
        domain: normDomain,
        started_at: startedAt,
        completed_at: completedAt,
        status: tracker.isBlocked ? 'blocked' : 'failed',
        source_url: null,
        total_urls_observed: 0,
        product_urls_eligible: 0,
        added_count: 0,
        updated_count: 0,
        inactivated_count: 0,
        duration_ms: durationMs,
        error_message: tracker.isBlocked
          ? tracker.blockReason || 'Site blocked crawler (HTTP 403 / Cloudflare Challenge)'
          : 'No sitemap discovered',
        http_status: tracker.lastStatus,
      });
    } catch { /* best effort */ }
  }

  return { urls: [], sourceUrl: '' };
}

// ── Sitemap fetching helpers ───────────────────────────────────────────────

/**
 * Fetch a single sitemap URL and recurse into child sitemaps if the
 * document turns out to be a `<sitemapindex>`.
 *
 * Returns `null` when the URL does not yield a parseable sitemap
 * (network error, 404, non-XML body, neither urlset nor sitemapindex).
 * The caller uses `null` to decide whether to try the next candidate.
 *
 * @param url      The sitemap URL to fetch.
 * @param depth    Current recursion depth. 0 at the root; capped at
 *                 `MAX_INDEX_DEPTH` to bound fan-out.
 * @param pattern  Compiled product URL pattern, or `null` when no
 *                 filtering is requested.
 */
async function tryFetchSitemap(
  url: string,
  depth: number,
  fetchFn: NetworkFetch = fetch,
  tracker?: FetchAttemptTracker,
): Promise<{ urls: string[]; entries: SitemapUrlEntry[]; sourceUrl: string } | null> {
  const body = await fetchSitemapBody(url, fetchFn, tracker);
  if (body === null) return null;

  const detected = detectSitemapKind(body);
  if (detected === null) {
    console.log(`[SitemapFetcher] ${url} is not a recognizable sitemap; skipping.`);
    return null;
  }

  if (detected === 'index') {
    if (depth >= MAX_INDEX_DEPTH) {
      console.warn(
        `[SitemapFetcher] Sitemap index at ${url} exceeds max depth ${MAX_INDEX_DEPTH}; skipping children.`,
      );
      return { urls: [], entries: [], sourceUrl: url };
    }
    const childUrls = extractAllLocs(body);
    console.log(
      `[SitemapFetcher] ${url} is a sitemap index with ${childUrls.length} child sitemap(s); recursing (depth ${depth + 1}).`,
    );
    const collected: SitemapUrlEntry[] = [];
    for (const child of childUrls) {
      const childResult = await tryFetchSitemap(child, depth + 1, fetchFn, tracker);
      if (childResult) {
        for (const e of childResult.entries) collected.push(e);
      }
    }
    const deduped = dedupeEntries(collected);
    return { urls: deduped.map((e) => e.url), entries: deduped, sourceUrl: url };
  }

  // detected === 'urlset'
  const entries = extractAllUrlEntries(body);
  const deduped = dedupeEntries(entries);
  return { urls: deduped.map((e) => e.url), entries: deduped, sourceUrl: url };
}

// ── Network helpers ────────────────────────────────────────────────────────

/**
 * Fetch a sitemap URL and return its decoded body as a string, or
 * `null` when the response is unusable (non-2xx, non-XML content type,
 * network error, malformed body, etc.).
 *
 * Honors `Content-Encoding: gzip` and the gzip magic bytes for
 * pre-compressed bodies served without the header.
 */
async function fetchSitemapBody(
  url: string,
  fetchFn: NetworkFetch = fetch,
  tracker?: FetchAttemptTracker,
): Promise<string | null> {
  let hostname = '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(`[SitemapFetcher] Denied non-HTTP(S) URL ${url}`);
      return null;
    }
    hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }

  if (await isPrivateOrLinkLocalHost(hostname)) {
    console.warn(`[SitemapFetcher] SSRF block: denied private/link-local hostname "${hostname}" for ${url}`);
    return null;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': ACCEPT_HEADER,
      },
      // Bun's `fetch` accepts `signal` on the init object.
      // Relax TLS authorization to handle expired or altname-mismatched manufacturer SSL certificates.
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    } as RequestInit);
  } catch (err) {
    console.warn(`[SitemapFetcher] Network error fetching ${url}:`, err);
    return null;
  }

  if (!response.ok) {
    if (tracker) {
      tracker.lastStatus = response.status;
      const isCloudflare =
        response.headers.get('server')?.toLowerCase().includes('cloudflare') ||
        response.headers.get('cf-mitigated') === 'challenge';
      const isPhp403 = url.endsWith('.php') && response.status === 403 && !isCloudflare;
      if (!isPhp403 && (response.status === 403 || response.status === 401 || isCloudflare)) {
        tracker.isBlocked = true;
        tracker.blockReason = isCloudflare
          ? 'Site blocked crawler (Cloudflare Bot Challenge / HTTP 403)'
          : `Site blocked crawler (HTTP ${response.status})`;
      }
    }
    console.log(`[SitemapFetcher] ${url} → HTTP ${response.status}; skipping.`);
    return null;
  }

  // Reject obvious non-XML content types so we don't try to parse an
  // HTML error page as a sitemap. Missing/empty content types fall
  // through; we let the body-level check decide.
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType && !looksLikeXmlContentType(contentType)) {
    console.log(
      `[SitemapFetcher] ${url} → Content-Type "${contentType}" does not look like XML; skipping.`,
    );
    return null;
  }

  // Read the body as a Uint8Array. When fetch decompresses a gzip response
  // transparently, the body is already plain text XML even if the server
  // sent a Content-Encoding: gzip header. We check the gzip magic bytes
  // (0x1f 0x8b) to ensure we only run gunzip on actual gzip compressed bytes.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    console.log(`[SitemapFetcher] ${url} returned an empty body; skipping.`);
    return null;
  }

  if (isGzipBytes(bytes)) {
    try {
      return new TextDecoder('utf-8').decode(gunzip(bytes));
    } catch (err) {
      console.warn(`[SitemapFetcher] Failed to gunzip body from ${url}:`, err);
      // Fallback: try plain text decode if gunzip fails
      try {
        return new TextDecoder('utf-8').decode(bytes);
      } catch {
        return null;
      }
    }
  }

  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (err) {
    console.warn(`[SitemapFetcher] Failed to decode body from ${url}:`, err);
    return null;
  }
}

/**
 * Decompress a gzip byte buffer using `Bun.gunzipSync` when running
 * inside the Bun runtime, falling back to `node:zlib` in environments
 * (notably vitest under Node) where `Bun` is not a global. The
 * production runtime is always Bun, so the fast path is taken there.
 */
function gunzip(bytes: Uint8Array): Uint8Array {
  // `Bun` is declared as a global by `@types/bun` so the runtime
  // check is just a narrow guard for test environments that don't
  // load it. In production we always take the Bun.gunzipSync path.
  const bunGlobal = (globalThis as { Bun?: { gunzipSync?: (b: Uint8Array) => Uint8Array } }).Bun;
  if (bunGlobal && typeof bunGlobal.gunzipSync === 'function') {
    return bunGlobal.gunzipSync(bytes);
  }
  // Fallback path for Node-based test runners. Lazy-imported so the
  // Bun production path never has to load `node:zlib`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlib = require('node:zlib') as typeof import('node:zlib');
  return new Uint8Array(zlib.gunzipSync(bytes));
}

/**
 * Parse `/robots.txt` and return any URLs declared via `Sitemap:`
 * directives. Returns an empty array when the file is missing, empty,
 * or unparseable; never throws.
 */
async function parseRobotsSitemaps(
  robotsUrl: string,
  fetchFn: NetworkFetch = fetch,
  tracker?: FetchAttemptTracker,
): Promise<string[]> {
  try {
    const host = new URL(robotsUrl).hostname.replace(/^\[|\]$/g, '');
    if (await isPrivateOrLinkLocalHost(host)) {
      console.warn(`[SitemapFetcher] SSRF block: denied private/link-local hostname "${host}" for robots.txt ${robotsUrl}`);
      return [];
    }
  } catch {
    return [];
  }

  let body: string | null = null;
  try {
    const response = await fetchFn(robotsUrl, {
      headers: {
        'User-Agent': HTTP_USER_AGENT,
        'Accept': 'text/plain, text/*, */*;q=0.1',
      },
      tls: { rejectUnauthorized: false },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    } as RequestInit);
    if (!response.ok) {
      if (tracker) {
        tracker.lastStatus = response.status;
        const isCloudflare =
          response.headers.get('server')?.toLowerCase().includes('cloudflare') ||
          response.headers.get('cf-mitigated') === 'challenge';
        if (response.status === 403 || response.status === 401 || isCloudflare) {
          tracker.isBlocked = true;
          tracker.blockReason = isCloudflare
            ? 'Site blocked crawler (Cloudflare Bot Challenge / HTTP 403)'
            : `Site blocked crawler (HTTP ${response.status})`;
        }
      }
      console.log(`[SitemapFetcher] robots.txt ${robotsUrl} → HTTP ${response.status}.`);
      return [];
    }
    body = await response.text();
  } catch (err) {
    console.warn(`[SitemapFetcher] robots.txt fetch failed (${robotsUrl}):`, err);
    return [];
  }

  if (!body) return [];

  const sitemaps: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Sitemap directive is case-insensitive on the directive name.
    const match = line.match(/^sitemap\s*:\s*(.+)$/i);
    if (match) {
      const candidate = match[1].trim();
      if (candidate) sitemaps.push(candidate);
    }
  }
  console.log(
    `[SitemapFetcher] robots.txt ${robotsUrl} declared ${sitemaps.length} Sitemap directive(s).`,
  );
  return sitemaps;
}

// ── XML helpers ────────────────────────────────────────────────────────────

/**
 * Detect whether a body is a sitemap index, a regular urlset, or
 * neither. Detection is based on the presence of the corresponding
 * root element tag. The check is case-insensitive and tolerant of
 * XML processing instructions / BOMs.
 */
function detectSitemapKind(body: string): 'index' | 'urlset' | null {
  // Look for the first opening root tag. Strip a leading BOM if any
  // so we don't accidentally match against the byte-order mark as text.
  const cleaned = body.replace(/^\uFEFF/, '').trimStart();
  if (!cleaned) return null;
  // `<sitemapindex` is more specific than `<urlset`, so check it first.
  if (/<sitemapindex[\s>]/i.test(cleaned)) return 'index';
  if (/<urlset[\s>]/i.test(cleaned)) return 'urlset';
  return null;
}

/**
 * Unescape standard XML entities in sitemap URLs.
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extract every `<loc>…</loc>` payload in document order.
 * The regex is intentionally narrow — anything containing `<` inside
 * the tag would be malformed XML anyway. Decodes XML entities like `&amp;`.
 */
function extractAllLocs(body: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = decodeXmlEntities(match[1].trim());
    if (value) out.push(value);
  }
  return out;
}

/**
 * Extract every `<url>` block payload with `<loc>` and optional `<lastmod>`.
 */
function extractAllUrlEntries(body: string): SitemapUrlEntry[] {
  const entries: SitemapUrlEntry[] = [];
  const urlBlockRegex = /<url[\s>]([\s\S]*?)<\/url>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = urlBlockRegex.exec(body)) !== null) {
    const block = blockMatch[1];
    const locMatch = /<loc>([^<]+)<\/loc>/i.exec(block);
    if (!locMatch) continue;
    const url = decodeXmlEntities(locMatch[1].trim());
    if (!url) continue;

    const lastmodMatch = /<lastmod>([^<]+)<\/lastmod>/i.exec(block);
    const lastmod = lastmodMatch ? lastmodMatch[1].trim() : null;

    entries.push({ url, lastmod });
  }

  // Fallback if <url> blocks were not well-formed but <loc> tags exist
  if (entries.length === 0) {
    const locs = extractAllLocs(body);
    for (const loc of locs) {
      entries.push({ url: loc });
    }
  }

  return entries;
}

/**
 * Deduplicate URL entries while preserving first-encountered order and latest lastmod.
 * Uses product URL identity key so tracking-only duplicates collapse while
 * variant-distinct URLs (?variant=, ?variation_id=, ?sku=, attribute_*) remain distinct.
 */
function dedupeEntries(entries: SitemapUrlEntry[]): SitemapUrlEntry[] {
  // Lazy import to avoid circular deps at module load; fallback to lowerCase on error.
  let identityKey: (u: string) => string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./product-url-identity') as typeof import('./product-url-identity');
    identityKey = mod.productUrlIdentityKey;
  } catch {
    identityKey = (u: string) => u.toLowerCase();
  }
  const seen = new Map<string, SitemapUrlEntry>();
  for (const entry of entries) {
    let key: string;
    try { key = identityKey(entry.url); } catch { key = entry.url.toLowerCase(); }
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entry);
    } else if (!existing.lastmod && entry.lastmod) {
      existing.lastmod = entry.lastmod;
    }
  }
  return Array.from(seen.values());
}

// ── Pattern + URL helpers ───────────────────────────────────────────────────

/**
 * Compile the optional product URL pattern. Returns `null` when no
 * pattern is given or when the pattern fails to compile. We never
 * throw here because a typo in a profile should not break the
 * sitemap pipeline.
 */
function compilePattern(productUrlPattern?: string | null): RegExp | null {
  if (!productUrlPattern) return null;
  try {
    // If the pattern contains no regex special chars, treat it as a
    // URL path-prefix segment (e.g. "products" → match /products/ in
    // the URL path). This prevents substring false-positives like
    // blog slugs that happen to contain the word "products".
    const REGEX_SPECIAL = /[\^$.*+?()[\]{}|]/;
    const source = REGEX_SPECIAL.test(productUrlPattern)
      ? productUrlPattern
      : `/${productUrlPattern.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
    return new RegExp(source, 'i');
  } catch (err) {
    console.warn(
      `[SitemapFetcher] Invalid productUrlPattern "${productUrlPattern}" — disabling URL filter.`,
      err,
    );
    return null;
  }
}

/**
 * Filter the URL list against the compiled pattern. Returns the
 * input unchanged when no pattern is set.
 */
function applyPattern(urls: string[], pattern: RegExp | null): string[] {
  if (!pattern) return urls;
  return urls.filter(u => pattern.test(u));
}

/**
 * Normalize the input domain into a usable `https://origin` string
 * (no trailing slash). Accepts:
 *   - bare domains        `example.com`
 *   - domains with scheme `https://example.com/`
 *   - domains with paths  `https://example.com/foo`
 *   - leading `www.`      preserved (we want to hit the same host
 *                          the user typed)
 *
 * Returns an empty string when the input cannot be coerced.
 */
function normalizeOrigin(domain: string): string {
  if (!domain) return '';
  let candidate = domain.trim();
  if (!candidate) return '';
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname;
    if (!host) return '';
    // We deliberately keep the user-provided path/scheme on purpose,
    // but sitemaps are always at the origin, so we strip the path
    // and any auth, and force https.
    return `https://${host}`;
  } catch {
    return '';
  }
}

/**
 * Strip an optional `www.` prefix for use with `recordDomainStatus`,
 * which normalizes domains in the same way as `domain-status-repo`.
 */
function stripWww(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/**
 * Deduplicate a list of URLs while preserving first-encountered order.
 * Comparison is case-insensitive on the full URL because the same
 * page can appear in a sitemap index and its child sitemap with
 * different casing conventions.
 */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * Return true if a Content-Type header looks like an XML document.
 * Accepts `application/xml`, `text/xml`, and the `+xml` suffix
 * convention (e.g. `application/atom+xml`).
 */
function looksLikeXmlContentType(contentType: string): boolean {
  if (contentType.includes('xml')) return true;
  // Some servers return `text/plain` for XML bodies; we accept that
  // as a fallback because the body-level check still runs.
  if (contentType.startsWith('text/plain')) return true;
  return false;
}

/**
 * Return true if the first two bytes of `bytes` are the gzip magic
 * header (`1f 8b`). Used to detect pre-compressed bodies served
 * without a `Content-Encoding: gzip` header.
 */
function isGzipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    bytes[0] === GZIP_MAGIC[0] &&
    bytes[1] === GZIP_MAGIC[1]
  );
}

// ─── Camoufox Rendered Fallback Helpers ─────────────────────────────────────

/**
 * Helper to parse `Sitemap:` directives from raw robots.txt text.
 */
function parseRobotsDirectives(body: string): string[] {
  if (!body) return [];
  const sitemaps: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^sitemap\s*:\s*(.+)$/i);
    if (match) {
      const candidate = match[1].trim();
      if (candidate) sitemaps.push(candidate);
    }
  }
  return sitemaps;
}

/**
 * Extract child sitemap URLs from rendered HTML/XML content.
 */
function extractRenderedChildSitemaps(content: string, origin: string): string[] {
  let domainHost = '';
  try {
    domainHost = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    domainHost = origin.replace(/^www\./, '');
  }

  const childUrls: string[] = [];
  const seen = new Set<string>();

  const locRegex = /<loc>(?:<!\[CDATA\[)?(https?:\/\/[^<\]\s]+)(?:\]\]>)?<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRegex.exec(content)) !== null) {
    const rawUrl = decodeXmlEntities(m[1].trim());
    if (rawUrl.includes('sitemap') || rawUrl.endsWith('.xml')) {
      if (!seen.has(rawUrl)) {
        seen.add(rawUrl);
        childUrls.push(rawUrl);
      }
    }
  }

  const hrefRegex = /href=["'](https?:\/\/[^"'\s]+)["']/gi;
  while ((m = hrefRegex.exec(content)) !== null) {
    const rawUrl = decodeXmlEntities(m[1].trim());
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.replace(/^www\./, '');
      if ((host === domainHost || host.endsWith('.' + domainHost)) && (rawUrl.includes('sitemap') || rawUrl.endsWith('.xml'))) {
        if (!seen.has(rawUrl)) {
          seen.add(rawUrl);
          childUrls.push(rawUrl);
        }
      }
    } catch {}
  }

  return childUrls;
}

/**
 * Extract product / page URLs from rendered HTML/XML content.
 */
function extractRenderedUrls(content: string, origin: string): SitemapUrlEntry[] {
  let domainHost = '';
  try {
    domainHost = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    domainHost = origin.replace(/^www\./, '');
  }

  const xmlEntries = extractAllUrlEntries(content);
  if (xmlEntries.length > 0) {
    return xmlEntries;
  }

  const locRegex = /<loc>(?:<!\[CDATA\[)?(https?:\/\/[^<\]\s]+)(?:\]\]>)?<\/loc>/gi;
  const entries: SitemapUrlEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = locRegex.exec(content)) !== null) {
    const url = decodeXmlEntities(m[1].trim());
    if (url && !seen.has(url) && !url.includes('sitemap') && !url.endsWith('.xml')) {
      seen.add(url);
      entries.push({ url });
    }
  }

  if (entries.length > 0) {
    return entries;
  }

  const hrefRegex = /href=["'](https?:\/\/[^"'\s]+)["']/gi;
  while ((m = hrefRegex.exec(content)) !== null) {
    const url = decodeXmlEntities(m[1].trim());
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === domainHost || host.endsWith('.' + domainHost)) {
        if (!url.endsWith('.xml') && !url.includes('sitemap') && !seen.has(url)) {
          seen.add(url);
          entries.push({ url });
        }
      }
    } catch {}
  }

  return entries;
}

/**
 * Rendered sitemap fetcher using Camoufox (anti-detect Firefox).
 * Invoked as an automatic fallback when standard HTTP fetch is blocked by Cloudflare / bot protection (HTTP 403).
 */
async function tryFetchSitemapRendered(
  origin: string,
): Promise<{ entries: SitemapUrlEntry[]; sourceUrl: string } | null> {
  const normOrigin = origin.toLowerCase().replace(/\/+$/, '');
  const overallDeadline = Date.now() + 25000; // 25s hard deadline per domain

  let launchContextFactory: any;
  let browserConfigLoader: any;

  try {
    launchContextFactory = await import('../extraction-worker/browser/camoufox-launch');
    browserConfigLoader = await import('../extraction-worker/browser/config');
  } catch (err) {
    console.warn('[SitemapFetcher] Camoufox extraction worker modules not available:', err);
    return null;
  }

  const config = browserConfigLoader.loadWorkerBrowserConfig();
  const launchCtx = await launchContextFactory.createLaunchContext(config);
  let browser: any = null;

  try {
    browser = await launchCtx.launcher.launch(launchCtx.launchOptions);
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
    });
    const page = await context.newPage();

    const candidatePaths = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/robots.txt',
    ];

    for (const path of candidatePaths) {
      if (Date.now() >= overallDeadline) {
        console.warn(`[SitemapFetcher] [Camoufox] Deadline exceeded for ${origin}; skipping remaining paths.`);
        break;
      }

      const targetUrl = normOrigin + path;
      try {
        const targetHost = new URL(targetUrl).hostname.replace(/^\[|\]$/g, '');
        if (await isPrivateOrLinkLocalHost(targetHost)) continue;
        console.log(`[SitemapFetcher] [Camoufox] Navigating to ${targetUrl}...`);
        const resp = await page.goto(targetUrl, {
          waitUntil: 'commit',
          timeout: 8000,
        });
        await page.waitForTimeout(1500);

        const status = resp?.status();
        if (status && status >= 400 && status !== 403) {
          continue;
        }

        const title = (await page.title()).toLowerCase();
        if (title.includes('just a moment') || title.includes('attention required') || title.includes('cloudflare')) {
          console.log(`[SitemapFetcher] [Camoufox] Waiting for Turnstile challenge on ${targetUrl}...`);
          await page.waitForTimeout(3000);
        }

        const content = await page.content();
        if (!content || content.length < 50) continue;

        if (path === '/robots.txt') {
          const bodyText = await page.innerText('body').catch(() => content);
          const robotsSitemaps = parseRobotsDirectives(bodyText);
          for (const sitemapUrl of robotsSitemaps.slice(0, 2)) {
            if (Date.now() >= overallDeadline) break;
            const normSitemap = decodeXmlEntities(sitemapUrl);
            try {
              const smHost = new URL(normSitemap).hostname.replace(/^\[|\]$/g, '');
              if (await isPrivateOrLinkLocalHost(smHost)) continue;
            } catch { continue; }
            console.log(`[SitemapFetcher] [Camoufox] Navigating to robots sitemap ${normSitemap}...`);
            const sResp = await page.goto(normSitemap, { waitUntil: 'commit', timeout: 8000 });
            await page.waitForTimeout(1500);
            if (sResp && sResp.status() < 400) {
              const sContent = await page.content();
              const urls = extractRenderedUrls(sContent, normOrigin);
              if (urls.length > 0) {
                return { entries: urls, sourceUrl: normSitemap };
              }
            }
          }
          continue;
        }

        const children = extractRenderedChildSitemaps(content, normOrigin);
        if (children.length > 0) {
          console.log(`[SitemapFetcher] [Camoufox] Discovered ${children.length} child sitemaps in index at ${targetUrl}`);
          const collected: SitemapUrlEntry[] = [];
          const productChildren = children.filter((c: string) => /product|item|catalog|shop/i.test(c));
          const toFetch = (productChildren.length > 0 ? productChildren : children).slice(0, 8);

          for (const childUrl of toFetch) {
            if (Date.now() >= overallDeadline) break;
            const normChild = childUrl.startsWith('http://') ? childUrl.replace('http://', 'https://') : childUrl;
            try {
              const childHost = new URL(normChild).hostname.replace(/^\[|\]$/g, '');
              if (await isPrivateOrLinkLocalHost(childHost)) continue;
              console.log(`[SitemapFetcher] [Camoufox] Fetching child sitemap ${normChild}...`);
              const cResp = await page.goto(normChild, { waitUntil: 'commit', timeout: 8000 });
              await page.waitForTimeout(1500);
              if (cResp && cResp.status() < 400) {
                const cContent = await page.content();
                const childUrls = extractRenderedUrls(cContent, normOrigin);
                for (const u of childUrls) collected.push(u);
              }
            } catch (e) {
              console.warn(`[SitemapFetcher] [Camoufox] Failed to fetch child ${normChild}:`, e);
            }
          }

          const deduped = dedupeEntries(collected);
          if (deduped.length > 0) {
            return { entries: deduped, sourceUrl: targetUrl };
          }
        }

        const urls = extractRenderedUrls(content, normOrigin);
        if (urls.length > 0) {
          return { entries: urls, sourceUrl: targetUrl };
        }
      } catch (err) {
        console.warn(`[SitemapFetcher] [Camoufox] Navigation error on ${targetUrl}:`, err);
      }
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return null;
}

// (No additional public exports; only `fetchAndParseSitemap` is part
// of the contract described in the task.)
