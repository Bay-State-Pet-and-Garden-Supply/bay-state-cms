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
import { ORGILL_LOGIN } from '../html-scraper/login-config';
import {
  createCrawleeHtmlScraperEngine,
  getSharedHtmlScraperManager,
} from '../html-scraper/session-runner';
import { parseHtmlScraperCredentials } from '../html-scraper/credentials';
import {
  anyMatches,
  dedupeStrings,
  isAllowedHttpsUrl,
  loadHtml,
  resolveUrl,
  sameGtin,
  sameOrigin,
  textList,
} from '../html-scraper/html-utils';

/**
 * Orgill (`html_scraper + orgill`) connector (ADR 0014 Amendment B, M4 —
 * tier 2 authenticated storefront).
 *
 * ASP.NET wholesale portal at `https://www.orgill.com`. Search by the
 * normalized UPC/GTIN (`SearchResultN.aspx?ddlhQ={identifier}`) returns a
 * results grid; PDPs are reached via product-detail links. The found rule is
 * EXACT: the PDP's `#cphMainContent_ctl00_lblUPCCode` value must equal the
 * normalized lookup identifier — advisory name/brand similarity never
 * rescues a mismatch.
 *
 * Auth: a Playwright login against the fixed `index.aspx?tab=8` page (real
 * ASP.NET postback/viewstate stays browser-owned) establishes an in-memory
 * session via the M2 session runner (memory-only cookies, one re-login,
 * 15-minute TTL). If a fetched page still carries the login form
 * (`loginOrgillxs_UserName`), the connector reports a stable `auth_required`
 * code; runner-level auth failures surface as `auth_failed` / `auth_expired`.
 *
 * Excluded by policy: price, inventory/stock, material, NPK ratio, pallet
 * quantity, and arbitrary spec rows — even when present in the page.
 */
export const ORGILL_NAVIGATION_ORIGIN = 'https://www.orgill.com';

const ORGILL_ASSET_HOSTS = ['www.orgill.com', 'orgill.com', 'images.orgill.com', 'images1.orgill.com'];

/** Max product candidates followed per lookup (bounded, deterministic). */
const MAX_PDP_CANDIDATES = 3;

/** Auth-page markers on any orgill page (authenticated flows only): the
 * login form, or the 'please log in' interstitial used for anonymous
 * search attempts (`lblHomeError`). Over-detection is fail-closed safe:
 * an `auth_required` source_error blocks a lookup instead of risking a
 * wrong stocking verdict. */
const AUTH_PAGE_SELECTORS = [
  '#cphMainContent_ctl00_loginOrgillxs_UserName',
  '#cphMainContent_lblHomeError',
];

/** ASP.NET product-page links used by search result templates. */
const PRODUCT_DETAIL_HREF_RE = /\/ProductDetail\.aspx|\/index\.aspx\?[^#]*\bsku=\d+(?:&|$)/i;

/** Injectable page fetcher (tests); production uses the bounded session runner. */
export interface OrgillConnectorDeps {
  fetchPage?: ScraperFetchPage;
  now?: () => string;
}

export interface OrgillPdpData {
  upc: string | null;
  name: string | null;
  brand: string | null;
  distributorSku: string | null;
  mpn: string | null;
  weight: string | null;
  dimensions: string | null;
  description: string | null;
  category: string | null;
  features: string[];
  casePack: string | null;
  unitOfMeasure: string | null;
  images: string[];
  /** Whether the page structurally looked like a PDP (name/upc/sku present). */
  parsed: boolean;
}

function buildOrgillPolicy(config: HtmlScraperConnectionConfig | null): HtmlScraperRuntimePolicy {
  return {
    providerId: 'orgill',
    navigationOrigin: ORGILL_NAVIGATION_ORIGIN,
    assetHosts: ORGILL_ASSET_HOSTS,
    responseCapBytes: config?.responseCapBytes ?? HTML_SCRAPER_CEILINGS.responseCapBytes,
    maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
    requestTimeoutMs: config?.requestTimeoutMs ?? HTML_SCRAPER_CEILINGS.requestTimeoutMs,
    requestsPerMinute: config?.requestsPerMinute ?? HTML_SCRAPER_CEILINGS.authRequestsPerMinute,
    sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
    retryCount: HTML_SCRAPER_CEILINGS.retryCount,
    allowBrowserFallback: true,
  };
}

/**
 * Production fetcher: ONE session manager per lookup so the authenticated
 * session is reused across the search + PDP fetches, then closed.
 */
function makeDefaultFetcher(
  connectionId: string,
  policy: HtmlScraperRuntimePolicy,
  credentials: { username: string; password: string },
): { fetchPage: ScraperFetchPage; close: () => Promise<void> } {
  // SHARED per-connection manager (ADR 0014 Amendment B): one login per
  // 15-minute session window per connection, reused across every item
  // lookup. Memory-only cookies; never closed per lookup — the process owns
  // the browser/session lifetime (Playwright exits with the parent). The
  // request cap is a PER-LOOKUP budget (this fetcher is created per lookup)
  // so a shared manager never accumulates a lifetime request count.
  const manager = getSharedHtmlScraperManager(connectionId, createCrawleeHtmlScraperEngine);
  const budget: HtmlScraperRequestBudget = { used: 0 };
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    const result = await manager.fetchHtml({
      connectionId,
      providerId: policy.providerId,
      url,
      policy,
      budget,
      loginConfig: ORGILL_LOGIN,
      credentials,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      browserRequired: opts.browserRequired ?? false,
      waitForSelectors: opts.waitForSelectors ?? [],
    });
    if (result.ok) {
      // Runner-level re-login already happened on auth signals; a page that
      // STILL carries the login form (production engine does not yet emit
      // `login_page`) is an auth-required condition, not a product result.
      if (anyMatches(result.html, AUTH_PAGE_SELECTORS)) {
        return { ok: false, code: 'auth_required', message: 'orgill returned the login form instead of content' };
      }
      return { ok: true, html: result.html, finalUrl: result.finalUrl };
    }
    // Stable runner codes (auth_failed/auth_expired/origin_blocked/cancelled/
    // timeout/body_too_large/unexpected) propagate as-is.
    return { ok: false, code: result.code, message: result.message };
  };
  // Per-lookup close would defeat session reuse; the shared manager's
  // lifetime is the process's.
  return { fetchPage, close: async () => {} };
}

/** Search-result candidate PDP links (absolute, same-origin, deduped). */
export function parseOrgillSearchCandidates(html: string): string[] {
  const $ = loadHtml(html);
  const urls: string[] = [];
  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') ?? '';
    if (PRODUCT_DETAIL_HREF_RE.test(href)) {
      const abs = resolveUrl(href, ORGILL_NAVIGATION_ORIGIN);
      if (abs && sameOrigin(abs, ORGILL_NAVIGATION_ORIGIN)) urls.push(abs);
    }
  });
  return dedupeStrings(urls).slice(0, MAX_PDP_CANDIDATES);
}

/**
 * Legacy-YAML sibling-chain extractor: a `<strong>` whose text contains the
 * label fragment, then `parent::div/following-sibling::div`.
 */
/**
 * New storefront template (observed live 2026-08-15): label/value pairs
 * render as plain `div`/`table` rows ("Retail UPC: 755625321923") AND as one
 * combined meta block ("Item No.: 7618085 Y Vendor: LANDSCAPERS SELECT Model
 * NO.: 34609 Retail UPC: …"). Extract a label's value: standalone pair first
 * (value must not contain another meta label), then the combined block
 * (value bounded at the next known label, trailing single-letter flags
 * stripped — e.g. the " Y" after an item number). FIRST match in document
 * order: the product's own info precedes the Similar/Recommended widgets.
 */
const ORGILL_META_LABEL_RE = /Item No|Vendor|Model NO|Retail UPC|Shelf Pack|Country of Origin|Weight\(lb\)|Estimated Cubic Size|Available|Minimum Purchase|Catalog Page/i;
function orgillMetaValue($: CheerioAPI, label: string): string | null {
  // Escaped label; the page renders "Item No.: …" / "Model NO.: …" with a
  // DOT after the label, so an optional dot precedes the colon in both
  // patterns ("Retail UPC: …" has none and still matches).
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Pass 1: standalone pair — "Label: value" with no other meta label inside.
  const pairRe = new RegExp(`^${esc}\\.?:\\s*(.+)$`);
  for (const el of $('div, table').toArray()) {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = text.match(pairRe);
    if (m && m[1].trim() && !ORGILL_META_LABEL_RE.test(m[1])) {
      return m[1].trim().replace(/\s+[A-Z]$/, '');
    }
  }
  // Pass 2: combined meta block — value bounded at the next known label.
  const blockRe = new RegExp(
    `${esc}\\.?:\\s*([^:]+?)(?=\\s+(?:Item No|Vendor|Model NO|Retail UPC|Shelf Pack|Country of Origin|Weight\\(lb\\)|Estimated Cubic Size|Available|Minimum Purchase|Catalog Page)\\s*[:.]|$)`,
  );
  for (const el of $('div, table').toArray()) {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = text.match(blockRe);
    if (m && m[1].trim()) {
      return m[1].trim().replace(/\s+[A-Z]$/, '');
    }
  }
  return null;
}

function strongLabelSibling($: CheerioAPI, fragment: string): string | null {
  let found: string | null = null;
  $('strong').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text.toLowerCase().includes(fragment.toLowerCase())) {
      const sibling = $(el).parent().next();
      if (sibling.length) {
        const value = sibling.text().replace(/\s+/g, ' ').trim();
        if (value) {
          found = value;
          return false;
        }
      }
    }
    return undefined;
  });
  return found;
}

function labeledListItem($: CheerioAPI, label: string): string | null {
  let found: string | null = null;
  $('li').each((_i, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const m = text.match(new RegExp(`^${label}:\\s*(.+)$`, 'i'));
    if (m && m[1].trim()) {
      found = m[1].trim();
      return false;
    }
    return undefined;
  });
  return found;
}

/** Recognizable ASP.NET search page: results container, no-results container, or a product link. */
export function isOrgillSearchPage(html: string): boolean {
  const $ = loadHtml(html);
  return (
    $('#cphMainContent_ctl00_pnlSearchResults').length > 0 ||
    $('#cphMainContent_ctl00_pnlNoResults').length > 0 ||
    // New template (2026-08-15): results/no-results header + counter text.
    $('#cphMainContent_ctl00_lblSearchedHeaderText').length > 0 ||
    /Viewing\s+\d+\s*-\s*\d+\s+of\s+\d+\s+results/i.test($('body').text()) ||
    parseOrgillSearchCandidates(html).length > 0
  );
}

/** Pure PDP parser (fixture-testable; never throws on unknown markup). */
export function parseOrgillPdp(html: string): OrgillPdpData {
  const $ = loadHtml(html);
  // New template (2026-08-15) renders the name in the productDetailsDiv
  // row; the lblDescriptionxs/lblDescription/h1/data-product-name chains
  // stay as fallbacks.
  const name = $('#cphMainContent_ctl00_productDetailsDiv .col-sm-8.col-md-7').first().text().replace(/\s+/g, ' ').trim()
    || $('#cphMainContent_ctl00_lblDescriptionxs').first().text().replace(/\s+/g, ' ').trim()
    || $('#cphMainContent_ctl00_lblDescription').first().text().replace(/\s+/g, ' ').trim()
    || $('h1').first().text().replace(/\s+/g, ' ').trim()
    || $('[data-product-name]').first().text().replace(/\s+/g, ' ').trim();
  const brand = orgillMetaValue($, 'Vendor')
    || $('#cphMainContent_ctl00_lblVendorName').first().text().replace(/\s+/g, ' ').trim();
  // New template (2026-08-15): labeled rows/block ("Retail UPC: …", "Item
  // No.: …", "Model NO.: …"); lblUPCCode/lblRetailUpc/strong pairs stay as
  // fallbacks.
  const upc = orgillMetaValue($, 'Retail UPC')
    || $('#cphMainContent_ctl00_lblUPCCode').first().text().replace(/\s+/g, ' ').trim()
    || $('#cphMainContent_ctl00_lblRetailUpc').first().text().replace(/\s+/g, ' ').trim()
    || strongLabelSibling($, 'Retail UPC')
    || labeledListItem($, 'UPC');
  const distributorSku = orgillMetaValue($, 'Item No')
    || $('#cphMainContent_ctl00_lblOrgillItemNumber').first().text().replace(/\s+/g, ' ').trim();
  const mpn = orgillMetaValue($, 'Model NO')
    || $('#cphMainContent_ctl00_lblModelNumber').first().text().replace(/\s+/g, ' ').trim();
  const casePack = orgillMetaValue($, 'Shelf Pack') ?? strongLabelSibling($, 'Case Pack') ?? strongLabelSibling($, 'Case Qty');
  const features = textList(html, '#cphMainContent_ctl00_lblProductDetails li, #cphMainContent_ctl00_lblProductDetailsxs span li, .detail-row span li, #cphMainContent_ctl00_lblFeatures li, .product-features li');
  // Live storefront (2026-08-15) renders the overview paragraph inside
  // lblProductOverview; the legacy long/short labels stay as fallbacks.
  const description = $('#cphMainContent_ctl00_lblProductOverview .text-details-description').first().text().replace(/\s+/g, ' ').trim()
    || $('#cphMainContent_ctl00_lblLongDescription').first().text().replace(/\s+/g, ' ').trim()
    || $('#cphMainContent_ctl00_lblShortDescription').first().text().replace(/\s+/g, ' ').trim()
    || $('.product-description').first().text().replace(/\s+/g, ' ').trim();
  const category = $('#cphMainContent_ctl00_lblDepartment').first().text().replace(/\s+/g, ' ').trim()
    || $('.breadcrumb li:last-child a').first().text().replace(/\s+/g, ' ').trim();
  const images: string[] = [];
  $("img[src*='orgill.com']").each((_i, el) => {
    // New template (2026-08-15) serves images from images1.orgill.com with
    // a Windows-style backslash path — normalize before resolution.
    const src = ($(el).attr('src') ?? '').replace(/\\/g, '/');
    // Never menu/chrome artwork (the new template ships those from
    // /Content/ImageGallery/menu/...).
    if (/\/Content\/ImageGallery\/menu\//i.test(src)) return;
    if (src && isAllowedHttpsUrl(resolveUrl(src, ORGILL_NAVIGATION_ORIGIN) ?? src, ORGILL_ASSET_HOSTS)) {
      images.push(resolveUrl(src, ORGILL_NAVIGATION_ORIGIN) ?? src);
    }
  });
  const parsed = Boolean(name) || Boolean(upc) || Boolean(distributorSku);
  return {
    upc: upc || null,
    name: name || null,
    brand: brand || null,
    distributorSku: distributorSku || null,
    mpn: mpn || null,
    weight: orgillMetaValue($, 'Weight(lb)') ?? strongLabelSibling($, 'Weight(lb):') ?? strongLabelSibling($, 'Weight'),
    // Live (2026-08-15): Shipping Unit Dimensions renders as labeled
    // Width(in)/Height(in)/Length(in) rows — assemble W x H x L.
    dimensions:
      (() => {
        const w = strongLabelSibling($, 'Width(in)');
        const h = strongLabelSibling($, 'Height(in)');
        const l = strongLabelSibling($, 'Length(in)');
        if (w && h && l) return `${w} x ${h} x ${l}`;
        return strongLabelSibling($, 'Dimension');
      })(),
    description: description || null,
    category: category || null,
    features,
    casePack: casePack || null,
    unitOfMeasure: strongLabelSibling($, 'Unit of Measure') ?? strongLabelSibling($, 'Unit of Meas.') ?? strongLabelSibling($, 'UOM'),
    images: dedupeStrings(images).slice(0, 50),
    parsed,
  };
}

function trimToLimit(value: string | null): string | null {
  if (!value) return null;
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

function buildRecord(identifier: string, p: OrgillPdpData, sourceUrl: string, observedAt: string): DistributorCatalogRecord {
  const attributes: Record<string, string> = {};
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
    features: p.features.slice(0, 30),
    category: p.category,
    dimensions: p.dimensions,
    casePack: p.casePack,
    unitOfMeasure: p.unitOfMeasure,
    ingredients: null,
    attributes,
    imageUrls: p.images,
    sourceUrl,
    catalogVersion: null,
    observedAt,
    expiresAt: null,
  };
}

export class OrgillConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId = 'orgill';
  readonly requiresSecret = true;

  constructor(private readonly deps: OrgillConnectorDeps = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no 8-14 digit UPC/GTIN to look up' };
    }

    // Strict credentials (defense-in-depth: the engine resolves + persists
    // secret_missing before invoking; the connector re-checks the shape).
    const parsedSecret = parseHtmlScraperCredentials(request.secret);
    if (!parsedSecret.ok) {
      return { outcome: 'source_error', code: parsedSecret.code, message: parsedSecret.code === 'secret_missing' ? 'orgill credentials are not configured' : 'orgill credentials are malformed' };
    }
    const credentials = parsedSecret.credentials;

    const config = parseHtmlScraperConnectionConfig(request.connection.configuration);
    if (config === null && Object.keys(request.connection.configuration ?? {}).length > 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'html_scraper connection configuration is invalid' };
    }
    const policy = buildOrgillPolicy(config);
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

    const defaultRunner = this.deps.fetchPage ? null : makeDefaultFetcher(request.connection.id, policy, credentials);
    const fetchPage = this.deps.fetchPage ?? defaultRunner!.fetchPage;
    try {
      const searchUrl = `${ORGILL_NAVIGATION_ORIGIN}/SearchResultN.aspx?ddlhQ=${encodeURIComponent(identifier)}`;
      let search = await fetchPage(searchUrl, { signal, deadlineAt });
      if (!search.ok) {
        return { outcome: 'source_error', code: search.code, message: `orgill search failed: ${search.message}` };
      }
      // A search response that is still a login page → auth_required.
      if (anyMatches(search.html, AUTH_PAGE_SELECTORS)) {
        return { outcome: 'source_error', code: 'auth_required', message: 'orgill returned the login form instead of search results' };
      }
      // A structurally unrecognized search response is a source error, not
      // a stocking verdict (the page may be a redirect/challenge shell) —
      // UNLESS it is a direct product page: the storefront now resolves a
      // single-match search straight to the SKU page
      // (index.aspx?tab=7&sku=…, observed live 2026-08-15).
      const tryMatchPdp = (html: string, finalUrl: string): SourcingLookupResult | null => {
        if (anyMatches(html, AUTH_PAGE_SELECTORS)) {
          return { outcome: 'source_error', code: 'auth_required', message: 'orgill returned the login form instead of a product page' };
        }
        // Product-page gate (new + legacy templates): a RESULTS page carries
        // the same Item No./Vendor label pairs inside its candidate cards,
        // so a direct-PDP match is only attempted when the response actually
        // IS a product page. The no-results page has none of these markers.
        if (!/cphMainContent_ctl00_(?:productDetailsDiv|lblDescriptionxs|lblOrgillItemNumber|lblUPCCode|lblRetailUpc)/.test(html)) {
          return null;
        }
        const parsed = parseOrgillPdp(html);
        if (!parsed.parsed) return null;
        if (parsed.upc && sameGtin(parsed.upc, identifier)) {
          const record = buildRecord(identifier, parsed, sameOrigin(finalUrl, ORGILL_NAVIGATION_ORIGIN) ? finalUrl : searchUrl, observedAt);
          const matchedFields = [
            'matchedIdentifier',
            ...(record.name ? ['name'] : []),
            ...(record.brand ? ['brand'] : []),
            ...(record.distributorSku ? ['distributorSku'] : []),
            ...(record.manufacturerPartNumber ? ['manufacturerPartNumber'] : []),
            ...(record.weight ? ['weight'] : []),
            ...(record.dimensions ? ['dimensions'] : []),
            ...(record.attributes.packCount ? ['packCount'] : []),
            ...(record.casePack ? ['casePack'] : []),
            ...(record.unitOfMeasure ? ['unitOfMeasure'] : []),
            ...(record.description ? ['description'] : []),
            ...(record.features.length > 0 ? ['features'] : []),
            ...(record.category ? ['category'] : []),
            ...(record.imageUrls.length > 0 ? ['imageUrls'] : []),
            ...(record.sourceUrl ? ['sourceUrl'] : []),
          ];
          const warnings: string[] = [];
          if (record.imageUrls.length === 0) warnings.push('no display-only image candidates found on the PDP');
          return { outcome: 'found', record, matchedFields, warnings };
        }
        return { outcome: 'not_stocked', reason: `wrong variant: product page for ${identifier} does not carry the exact UPC/GTIN` };
      };
      const directMatch = tryMatchPdp(search.html, search.finalUrl);
      if (directMatch) {
        return directMatch;
      }
      if (!isOrgillSearchPage(search.html)) {
        return { outcome: 'source_error', code: 'unexpected_markup', message: 'orgill search response is not a recognizable results page' };
      }

      const candidates = parseOrgillSearchCandidates(search.html);
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
        const matched = tryMatchPdp(pdp.html, pdp.finalUrl);
        if (!matched) continue;
        parsedAny = true;
        if (matched.outcome === 'found') {
          return matched;
        }
      }

      if (parsedAny) {
        return { outcome: 'not_stocked', reason: `wrong variant: product page for ${identifier} does not carry the exact UPC/GTIN` };
      }
      if (transportError) {
        return { outcome: 'source_error', code: transportError.code, message: `orgill PDP fetch failed: ${transportError.message}` };
      }
      return { outcome: 'source_error', code: 'unexpected_markup', message: 'no orgill product page could be parsed' };
    } finally {
      await defaultRunner?.close();
    }
  }
}
