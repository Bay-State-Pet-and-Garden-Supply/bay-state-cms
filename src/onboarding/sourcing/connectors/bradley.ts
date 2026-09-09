import type { CheerioAPI } from 'cheerio';
import {
  type DistributorConnector,
  type DistributorCatalogRecord,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
} from '../contracts';
import type { HtmlScraperConnectionConfig, HtmlScraperRequestBudget, HtmlScraperRuntimePolicy, ScraperFetchPage } from '../html-scraper/contracts';
import { HTML_SCRAPER_CEILINGS, parseHtmlScraperConnectionConfig } from '../html-scraper/contracts';
import {
  createCrawleeHtmlScraperEngine,
  getSharedHtmlScraperManager,
} from '../html-scraper/session-runner';
import {
  dedupeStrings,
  isAllowedHttpsUrl,
  loadHtml,
  resolveUrl,
  sameGtin,
  sameOrigin,
  utf8ByteLength,
} from '../html-scraper/html-utils';

/**
 * Bradley Caldwell (`html_scraper + bradley`) connector (ADR 0014
 * Amendment B, M3 — tier 1 public storefront).
 *
 * BigCommerce-headless storefront at `https://www.bradleycaldwell.com`.
 * Search by the normalized UPC/GTIN returns product cards whose overlay
 * anchor (`a[aria-label][href]`) links the PDP slug. The found rule is
 * EXACT: the PDP's `UPC` dt/dd value must equal the normalized lookup
 * identifier. The 6-digit BCI item number is extracted as `distributorSku`
 * only — it is NEVER a lookup authority (001135 is parser-regression only).
 *
 * Transport: Cheerio search + PDP; ONE Playwright fallback only when the
 * search response is a tiny static app shell (unrendered Next.js loading
 * state) — never an unbounded retry.
 *
 * Excluded by policy: price, availability/stock, pallet quantity, `Type`,
 * country/FOB, recommendation-card images, and arbitrary provider fields.
 */
export const BRADLEY_NAVIGATION_ORIGIN = 'https://www.bradleycaldwell.com';

const BRADLEY_ASSET_HOSTS = [
  'cdn11.bigcommerce.com',
  'cdn.bigcommerce.com',
  'bigcommerce.com',
  'www.bradleycaldwell.com',
  'bradleycaldwell.com',
];

/** Max product candidates followed per lookup (bounded, deterministic). */
const MAX_PDP_CANDIDATES = 3;

/** A static-shell is any search response under this byte floor (loading skeleton). */
const STATIC_SHELL_BYTE_FLOOR = 4096;

/** BigCommerce product-slug anchors end with `-<sku>` (nav links do not). */
const PRODUCT_LINK_RE = /^\/[a-z0-9-]+-\d+$/;

/** Injectable page fetcher (tests); production uses the bounded session runner. */
export interface BradleyConnectorDeps {
  fetchPage?: ScraperFetchPage;
  now?: () => string;
}

/** Which brand candidate won (issue #110 provenance). Null when unresolvable. */
export type BradleyBrandSource = 'adjacent_link' | 'spec' | 'json_ld';

export interface BradleyPdpData {
  upc: string | null;
  name: string | null;
  brand: string | null;
  /**
   * Which candidate supplied `brand`. Observed-null (`null`) flows into the
   * missing_brand hold downstream — never a guessed brand.
   */
  brandSource: BradleyBrandSource | null;
  distributorSku: string | null;
  mpn: string | null;
  weight: string | null;
  size: string | null;
  casePack: string | null;
  unitOfMeasure: string | null;
  description: string | null;
  ingredients: string | null;
  category: string | null;
  images: string[];
  /** Whether the page structurally looked like a PDP (h1 or spec list). */
  parsed: boolean;
}

function buildBradleyPolicy(config: HtmlScraperConnectionConfig | null): HtmlScraperRuntimePolicy {
  return {
    providerId: 'bradley',
    navigationOrigin: BRADLEY_NAVIGATION_ORIGIN,
    assetHosts: BRADLEY_ASSET_HOSTS,
    responseCapBytes: config?.responseCapBytes ?? HTML_SCRAPER_CEILINGS.responseCapBytes,
    maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
    requestTimeoutMs: config?.requestTimeoutMs ?? HTML_SCRAPER_CEILINGS.requestTimeoutMs,
    requestsPerMinute: config?.requestsPerMinute ?? HTML_SCRAPER_CEILINGS.publicRequestsPerMinute,
    sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
    retryCount: HTML_SCRAPER_CEILINGS.retryCount,
    allowBrowserFallback: true,
  };
}

function makeDefaultFetcher(connectionId: string, policy: HtmlScraperRuntimePolicy): ScraperFetchPage {
  // SHARED per-connection manager (ADR 0014 Amendment B): one login per
  // 15-minute session window per connection, reused across every item
  // lookup. Memory-only cookies; never closed per lookup — the process owns
  // the browser/session lifetime (Playwright exits with the parent). The
  // request cap is a PER-LOOKUP budget (this fetcher is created per lookup)
  // so a shared manager never accumulates a lifetime request count.
  const manager = getSharedHtmlScraperManager(connectionId, createCrawleeHtmlScraperEngine);
  const budget: HtmlScraperRequestBudget = { used: 0 };
  return async function defaultFetchPage(url, opts) {
    const result = await manager.fetchHtml({
      connectionId,
      providerId: policy.providerId,
      url,
      policy,
      budget,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      browserRequired: opts.browserRequired ?? false,
      waitForSelectors: opts.waitForSelectors ?? [],
    });
    if (result.ok) return { ok: true, html: result.html, finalUrl: result.finalUrl };
    return { ok: false, code: result.code, message: result.message };
  };
}

/** Search-result candidate PDP links (absolute, same-origin, deduped). */
export function parseBradleySearchCandidates(html: string): string[] {
  const $ = loadHtml(html);
  const urls: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (PRODUCT_LINK_RE.test(href)) {
      const abs = resolveUrl(href, BRADLEY_NAVIGATION_ORIGIN);
      if (abs && sameOrigin(abs, BRADLEY_NAVIGATION_ORIGIN)) urls.push(abs);
    }
  });
  return dedupeStrings(urls).slice(0, MAX_PDP_CANDIDATES);
}

function specValue($: CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $('dt').each((_i, el) => {
    const strong = $(el).find('strong').first();
    if (strong.length && strong.text().replace(/\s+/g, ' ').trim() === label) {
      const value = $(el).next('dd').text().replace(/\s+/g, ' ').trim();
      if (value) found = value;
    }
  });
  return found;
}

function labeledListItem($: CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $('li').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'i'));
    if (m && m[1].trim()) found = m[1].trim();
  });
  return found;
}

function firstProseBlock($: CheerioAPI, heading: string): string | null {
  let found: string | null = null;
  $('.prose').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.startsWith(heading) && text.length > heading.length + 20) {
      found = text.slice(heading.length).trim();
      return false;
    }
    return undefined;
  });
  return found;
}

function breadcrumbText($: CheerioAPI): string | null {
  const nav = $('nav[aria-label="breadcrumb"]').first();
  if (nav.length === 0) return null;
  const crumbs = nav
    .find('li')
    .map((_i, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t && t !== 'Home');
  return crumbs.length > 0 ? crumbs.join(' / ') : null;
}

/** Product gallery images: only URLs whose path contains the BCI SKU (excludes recommendations). */
function galleryImages($: CheerioAPI, sku: string | null): string[] {
  if (!sku) return [];
  const out: string[] = [];
  $('img').each((_i, el) => {
    const src = $(el).attr('src') ?? '';
    if (src.includes(`/${sku}`)) out.push(src);
  });
  return dedupeStrings(out).filter((u) => isAllowedHttpsUrl(u, BRADLEY_ASSET_HOSTS)).slice(0, 50);
}

/**
 * Ordered brand candidates (issue #110). Bradley H1s are typically
 * brandless, with the brand in the small link directly above the title —
 * but layouts shift, so fall back through spec/manufacturer fields and
 * JSON-LD vendor metadata. First non-empty value wins, WITH its source for
 * provenance. Returns { brand: null, brandSource: null } when unresolvable
 * (observed-null — the missing_brand hold downstream, never a guess).
 * Never throws on unknown markup.
 */
function bradleyBrand($: CheerioAPI): { brand: string | null; brandSource: BradleyBrandSource | null } {
  const h1 = $('h1').first();
  if (h1.length) {
    const adjacent = h1.prev('p').find('a').first().text().replace(/\s+/g, ' ').trim();
    if (adjacent) return { brand: adjacent, brandSource: 'adjacent_link' };
  }
  const specBrand = specValue($, 'Brand') ?? specValue($, 'Manufacturer');
  if (specBrand) return { brand: specBrand, brandSource: 'spec' };
  const jsonLd = jsonLdBrand($);
  if (jsonLd) return { brand: jsonLd, brandSource: 'json_ld' };
  return { brand: null, brandSource: null };
}

/** Vendor-structured brand from JSON-LD blocks (string or { name }). */
function jsonLdBrand($: CheerioAPI): string | null {
  let found: string | null = null;
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (found) return false;
    const raw = $(el).contents().text();
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of candidates) {
        const brand = (node as { brand?: unknown } | null)?.brand;
        const name = typeof brand === 'string' ? brand : (brand as { name?: unknown } | null)?.name;
        if (typeof name === 'string' && name.replace(/\s+/g, ' ').trim()) {
          found = name.replace(/\s+/g, ' ').trim();
          return false;
        }
      }
    } catch {
      // Malformed JSON-LD is not brand evidence — keep scanning.
    }
    return undefined;
  });
  return found;
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parseBradleyPdp(html: string): BradleyPdpData {
  const $ = loadHtml(html);
  const h1 = $('h1').first();
  const name = h1.length ? h1.text().replace(/\s+/g, ' ').trim() : '';
  const { brand, brandSource } = bradleyBrand($);
  const distributorSku = specValue($, 'BCI Item Number');
  const upc = specValue($, 'UPC');
  const casePack = specValue($, 'Case Pack');
  const parsed = h1.length > 0 || Boolean(upc) || Boolean(distributorSku);
  return {
    upc,
    name: name || null,
    brand: brand || null,
    brandSource,
    distributorSku,
    mpn: specValue($, 'Manufacturer #'),
    weight: labeledListItem($, 'Weight'),
    size: specValue($, 'Size'),
    casePack,
    unitOfMeasure: specValue($, 'Unit of Measure'),
    description: firstProseBlock($, 'Description'),
    ingredients: labeledListItem($, 'Ingredients'),
    category: breadcrumbText($),
    images: galleryImages($, distributorSku),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: BradleyPdpData, sourceUrl: string, observedAt: string): DistributorCatalogRecord {
  const attributes: Record<string, string> = {};
  if (p.size) attributes.size = p.size;
  if (p.casePack && /^\d+$/.test(p.casePack.trim())) attributes.packCount = p.casePack.trim();
  return {
    matchedIdentifier: identifier,
    distributorUpc: p.upc,
    gtin: null,
    distributorSku: p.distributorSku,
    name: trimToLimit(p.name),
    description: trimToLimit(p.description),
    brand: trimToLimit(p.brand),
    manufacturerPartNumber: p.mpn,
    weight: p.weight,
    features: [],
    category: p.category,
    dimensions: null,
    casePack: p.casePack,
    unitOfMeasure: p.unitOfMeasure,
    ingredients: p.ingredients,
    attributes,
    imageUrls: p.images,
    sourceUrl,
    catalogVersion: null,
    observedAt,
    expiresAt: null,
  };
}

export class BradleyConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId = 'bradley';
  readonly requiresSecret = false;

  constructor(private readonly deps: BradleyConnectorDeps = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no 8-14 digit UPC/GTIN to look up' };
    }

    const config = parseHtmlScraperConnectionConfig(request.connection.configuration);
    if (config === null && Object.keys(request.connection.configuration ?? {}).length > 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'html_scraper connection configuration is invalid' };
    }
    const policy = buildBradleyPolicy(config);
    const fetchPage = this.deps.fetchPage ?? makeDefaultFetcher(request.connection.id, policy);
    const signal = request.signal;
    const deadlineAt = request.deadlineAt;
    const observedAt = (this.deps.now ?? (() => new Date().toISOString()))();

    // Pre-abort/expired-deadline starts no transport at all.
    if (signal.aborted) {
      return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled before start' };
    }
    if (new Date(deadlineAt).getTime() <= Date.now()) {
      return { outcome: 'source_error', code: 'timeout', message: 'deadline expired before start' };
    }

    const searchUrl = `${BRADLEY_NAVIGATION_ORIGIN}/search?term=${encodeURIComponent(identifier)}`;
    let search = await fetchPage(searchUrl, { signal, deadlineAt });
    if (!search.ok) {
      return { outcome: 'source_error', code: search.code, message: `bradley search failed: ${search.message}` };
    }
    // Recognized static app shell → exactly ONE browser fallback.
    if (utf8ByteLength(search.html) < STATIC_SHELL_BYTE_FLOOR) {
      search = await fetchPage(searchUrl, { signal, deadlineAt, browserRequired: true });
      if (!search.ok) {
        return { outcome: 'source_error', code: search.code, message: `bradley search (browser) failed: ${search.message}` };
      }
      if (utf8ByteLength(search.html) < STATIC_SHELL_BYTE_FLOOR) {
        return { outcome: 'source_error', code: 'unexpected_markup', message: 'bradley search returned an unrendered static shell' };
      }
    }

    const candidates = parseBradleySearchCandidates(search.html);
    if (candidates.length === 0) {
      return { outcome: 'not_stocked', reason: `no exact match: no product results for identifier ${identifier}` };
    }

    let parsedAny = false;
    let transportError: { code: string; message: string } | null = null;
    for (const url of candidates) {
      if (signal.aborted) {
        return { outcome: 'source_error', code: 'cancelled', message: 'lookup cancelled' };
      }
      const pdp = await fetchPage(url, { signal, deadlineAt });
      if (!pdp.ok) {
        transportError = { code: pdp.code, message: pdp.message };
        continue;
      }
      const parsed = parseBradleyPdp(pdp.html);
      if (!parsed.parsed) continue;
      parsedAny = true;
      if (parsed.upc && sameGtin(parsed.upc, identifier)) {
        const finalUrl = sameOrigin(pdp.finalUrl, BRADLEY_NAVIGATION_ORIGIN) ? pdp.finalUrl : url;
        const record = buildRecord(identifier, parsed, finalUrl, observedAt);
        const matchedFields = [
          'matchedIdentifier',
          ...(record.name ? ['name'] : []),
          ...(record.brand ? ['brand'] : []),
          ...(record.distributorSku ? ['distributorSku'] : []),
          ...(record.manufacturerPartNumber ? ['manufacturerPartNumber'] : []),
          ...(record.weight ? ['weight'] : []),
          ...(record.attributes.size ? ['size'] : []),
          ...(record.attributes.packCount ? ['packCount'] : []),
          ...(record.casePack ? ['casePack'] : []),
          ...(record.unitOfMeasure ? ['unitOfMeasure'] : []),
          ...(record.description ? ['description'] : []),
          ...(record.ingredients ? ['ingredients'] : []),
          ...(record.imageUrls.length > 0 ? ['imageUrls'] : []),
          ...(record.sourceUrl ? ['sourceUrl'] : []),
        ];
        const warnings: string[] = [];
        if (record.imageUrls.length === 0) warnings.push('no display-only image candidates found on the PDP');
        return { outcome: 'found', record, matchedFields, warnings };
      }
    }

    if (parsedAny) {
      return { outcome: 'not_stocked', reason: `wrong variant: product page for ${identifier} does not carry the exact UPC/GTIN` };
    }
    if (transportError) {
      return { outcome: 'source_error', code: transportError.code, message: `bradley PDP fetch failed: ${transportError.message}` };
    }
    return { outcome: 'source_error', code: 'unexpected_markup', message: 'no bradley product page could be parsed' };
  }
}
