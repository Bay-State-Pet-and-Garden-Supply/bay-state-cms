/**
 * Page extractor using Playwright directly.
 * Extracts structured product data from manufacturer product pages
 * using a layered approach: Custom CSS selectors → JSON-LD → meta tags → microdata → HTML heuristics.
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { type ExtractionData, ExtractionDataSchema } from '../shared/schemas/onboarding';
import { findProfileByDomain, type ExtractorProfile } from '../db/repositories/extractor-profile-repo';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { recordDomainStatus } from '../db/repositories/domain-status-repo';
import { enrichUrlMetadata } from '../db/repositories/brand-url-index-repo';
import { validateExtraction, type ValidationResult } from './extraction-validator';
import { runProfileExtraction } from './profile-runner-client';
import {
  addImageSource,
  canonicalizeUrl,
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from './image-utils';
import { applyLadderEnrichment } from './extraction-ladder/enrich';

interface RawExtraction {
  custom: Record<string, string | string[]> | null;
  jsonLd: Record<string, unknown> | null;
  metaTags: Record<string, string>;
  microdata: Record<string, string>;
  htmlHeuristics: Record<string, string | string[]>;
  images: string[];
}

/**
 * Extract product identifiers (UPC, SKU, MPN, H1) from raw extraction layers
 * and enrich brand_url_index.
 */
function enrichBrandUrlFromRaw(url: string, raw: RawExtraction, title?: string | null, brand?: string | null): void {
  try {
    let upc: string | null = null;
    let sku: string | null = null;
    let mpn: string | null = null;

    if (raw.jsonLd) {
      const gtin = raw.jsonLd.gtin13 || raw.jsonLd.gtin12 || raw.jsonLd.gtin8 || raw.jsonLd.gtin || raw.jsonLd.productID;
      if (typeof gtin === 'string') upc = gtin.replace(/\D/g, '').trim();
      if (typeof raw.jsonLd.sku === 'string') sku = raw.jsonLd.sku.trim();
      if (typeof raw.jsonLd.mpn === 'string') mpn = raw.jsonLd.mpn.trim();
    }

    if (!upc && raw.microdata) {
      const mGtin = raw.microdata['gtin13'] || raw.microdata['gtin12'] || raw.microdata['gtin'] || raw.microdata['productID'];
      if (mGtin) upc = mGtin.replace(/\D/g, '').trim();
      if (!sku && raw.microdata['sku']) sku = raw.microdata['sku'].trim();
    }

    if (!sku && raw.metaTags) {
      const metaSku = raw.metaTags['product:retailer_item_id'] || raw.metaTags['product:sku'];
      if (metaSku) sku = metaSku.trim();
    }

    const h1 = typeof raw.htmlHeuristics?.['h1'] === 'string' ? raw.htmlHeuristics['h1'] : null;

    enrichUrlMetadata(url, {
      title: title || null,
      brand: brand || null,
      upc: upc || null,
      sku: sku || null,
      mpn: mpn || null,
      h1: h1 || null,
      jsonLdIdentifiers: raw.jsonLd,
      lastFetchedAt: new Date().toISOString(),
    });
  } catch {
    // Non-critical background enrichment
  }
}

/** Standard browser User-Agent used for HTTP and Playwright fetches. */
const HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Standard headers used for HTTP extraction. Exported for multi-sample validation. */
export const HTTP_EXTRACTION_HEADERS: Record<string, string> = {
  'User-Agent': HTTP_USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

/** Timeout (ms) for HTTP fetches. */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const HTTP_FETCH_TIMEOUT_MS = 15000;

/** Detailed result returned by the HTTP extraction path. */
export interface HttpExtractionDetailed {
  /** The merged, layered extraction result. */
  data: ExtractionData;
  /** Raw HTML fetched from the URL. */
  html: string;
  /** The raw, per-layer extraction payloads (custom/jsonLd/metaTags/...). */
  raw: RawExtraction;
  /**
   * True if the custom selector layer produced any non-empty value for the
   * known product fields. Used by the profile-generation trigger to detect
   * "stale" profiles that should be regenerated.
   */
  customHadAnyValue: boolean;
}

/**
 * Return `true` if a custom-selector extraction produced at least one
 * non-empty value across the known product fields.
 */
function customSelectorsHadAnyValue(
  custom: Record<string, string | string[]> | null,
): boolean {
  if (!custom) return false;
  for (const value of Object.values(custom)) {
    if (Array.isArray(value)) {
      if (value.length > 0) return true;
    } else if (typeof value === 'string' && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Options for HTTP fast-path extraction.
 */
export interface ExtractHttpDetailedOptions {
  /**
   * When true, skips writing extracted metadata (title, identifiers, status,
   * timestamp) to brand_url_index and brand_url_fts. Required by audit replay
   * to guarantee pure zero-catalog-write execution (Spec #183, Issue #187).
   */
  skipCatalogWrites?: boolean;
}

/**
 * Pure parsing seam: extracts product data directly from page HTML string
 * without network I/O or catalog database writes (Spec #183, Issue #187).
 *
 * Guarantees:
 * 1. Zero catalog writes: no updates to brand_url_index, brand_url_fts, or any SQLite table.
 * 2. Deterministic ladder enrichment: additive-only structured signal extraction.
 * 3. Never throws: degrades gracefully on parsing errors.
 */
// fallow-ignore-next-line unused-export
export async function extractProductFromHtml(
  html: string,
  url: string,
  profile?: ExtractorProfile | null,
  expected?: { name?: string; brandHint?: string | null; price?: string | null; gtin?: string },
  fetchFn?: NetworkFetch,
): Promise<HttpExtractionDetailed> {
  const $ = cheerio.load(html);

  // Layer 0: Custom CSS Selectors
  let custom: Record<string, string | string[]> | null = null;
  if (profile) {
    custom = extractCustomSelectorsCheerio($, profile);
  }

  // Layer 1: JSON-LD
  const jsonLd = extractJsonLdCheerio($);

  // Layer 2: Meta Tags
  const metaTags = extractMetaTagsCheerio($);

  // Layer 3: Microdata
  const microdata = extractMicrodataCheerio($);

  // Layer 4: HTML Heuristics
  const htmlHeuristics = extractHtmlHeuristicsCheerio($);

  // Layer 5: Image Gallery
  const images = extractImagesCheerio($, url);

  const raw: RawExtraction = {
    custom,
    jsonLd,
    metaTags,
    microdata,
    htmlHeuristics,
    images,
  };

  const merged = mergeExtractionLayers(raw, url, expected);

  // ADR-0031: deterministic ladder enrichment (additive-only). Fills fields
  // the layers above left empty from embedded platform/structured signals
  // and attaches identityStatus/identityReasons. Failures inside the
  // enrichment degrade to "no enrichment" by contract — but guard anyway so
  // an unexpected throw can never fail extraction.
  try {
    await applyLadderEnrichment({
      html,
      url,
      data: merged,
      expected: expected
        ? { name: expected.name, brandHint: expected.brandHint, price: expected.price, gtin: (expected as { gtin?: string }).gtin }
        : undefined,
      fetchFn,
    });
  } catch (enrichErr) {
    console.warn('[PageExtractor] Ladder enrichment failed (non-blocking):', enrichErr instanceof Error ? enrichErr.message : enrichErr);
  }

  return {
    data: merged,
    html,
    raw,
    customHadAnyValue: customSelectorsHadAnyValue(custom),
  };
}

/**
 * Fast-path HTTP extraction using Cheerio. Fetches the page markup and
 * extracts structured data without launching a browser. Returns the
 * detailed diagnostics needed by the profile-generation trigger.
 */
// fallow-ignore-next-line unused-export
export async function extractViaHttpDetailed(
  url: string,
  profile?: ExtractorProfile | null,
  expected?: { name?: string; brandHint?: string | null; price?: string | null; gtin?: string },
  fetchFn: NetworkFetch = fetch,
  options?: ExtractHttpDetailedOptions,
): Promise<HttpExtractionDetailed> {
  // P0-1 (round 2): the transport accepts an injected fetch so the Product
  // Intelligence layer can bind this function to the policy gateway's
  // gatewayFetch (SSRF floor, redirect re-validation, size/type limits,
  // audit). Non-PI callers keep the default global fetch.
  const response = await fetchFn(url, {
    headers: HTTP_EXTRACTION_HEADERS,
    signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP fetch failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const detailed = await extractProductFromHtml(html, url, profile, expected, fetchFn);

  if (!options?.skipCatalogWrites) {
    enrichBrandUrlFromRaw(url, detailed.raw, detailed.data.title, detailed.data.brand);
  }

  return detailed;
}

/**
 * Fast-path HTTP extraction using Cheerio. Thin wrapper over
 * `extractViaHttpDetailed` that returns only the merged data.
 */
async function extractViaHttp(
  url: string,
  profile?: ExtractorProfile | null,
  expected?: { name?: string; brandHint?: string | null; price?: string | null; gtin?: string },
): Promise<ExtractionData> {
  const detailed = await extractViaHttpDetailed(url, profile, expected);
  return detailed.data;
}

/**
 * Extract product data from a URL using a two-tier approach:
 * HTTP Cheerio extraction (fast & lightweight) with fallback to Playwright stealth execution.
 * Returns validated ExtractionData with field provenance tracking.
 */
export class VariantExtractionError extends Error {
  failureCode: string;
  matrixDecision?: unknown;
  constructor(failureCode: string, message: string, matrixDecision?: unknown) {
    super(message);
    this.name = 'VariantExtractionError';
    this.failureCode = failureCode;
    this.matrixDecision = matrixDecision;
  }
}

export async function extractProductData(
  url: string,
  expected?: { name: string; brandHint?: string | null; price?: string | null; gtin?: string; variantSelection?: { resolutionId: string; identityMatrixHash: string; variantKey: string } }
): Promise<ExtractionData> {
  let domain = '';
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch { /* skip */ }
  const profile = domain ? findProfileByDomain(domain) : null;

  // Determine if it is a known official brand site
  const isKnownBrand = domain && expected?.brandHint
    ? findBrandSites(expected.brandHint).some(s => domain.includes(s.domain) || s.domain.includes(domain))
    : false;

  // 1. When a profile exists, use Playwright first (captures JS-rendered content like galleries)
  // 2. Fall back to fast HTTP/Cheerio if Playwright is unavailable
  if (!profile) {
    // No profile — try HTTP first for speed
    console.log(`[PageExtractor] Trying fast HTTP extraction for: ${url}`);
    let httpDetailed: HttpExtractionDetailed | null = null;
    try {
      httpDetailed = await extractViaHttpDetailed(url, null, expected);
      const httpResult = httpDetailed.data;
      if (expected) {
        const validation = validateExtraction(httpResult, {
          name: expected.name,
          brandHint: expected.brandHint,
          domain: domain,
        });
        if (validation.valid) {
          console.log(`[PageExtractor] HTTP extraction succeeded and passed validation (confidence: ${validation.confidence})`);
          if (domain) recordDomainStatus(domain, 'ok');
          let result = httpResult;
          if (expected?.price) {
            // Spreadsheet price wins when present...
            result.price = expected.price;
            result = { ...result };
            result.fieldProvenance = { ...result.fieldProvenance, price: 'spreadsheet-import' };
          }
          // ...otherwise a ladder-enriched page price survives untouched
          // (ADR-0031: enrichment is never nulled out post-hoc).
          return result;
        }
      } else if (httpResult.title) {
        return httpResult;
      }
    } catch (err) {
      console.warn(`[PageExtractor] HTTP extraction threw an error:`, err);
    }
  }

  // ── Profile-based extraction: delegate to extraction worker ──────────
  // The worker uses Crawlee + Camoufox (anti-detect Firefox) to render the
  // page and run the profile's CSS selectors. This respects ADR 0009 (browser
  // tooling lives in the worker, not the Bun server).
  if (profile && expected) {
    console.log(`[PageExtractor] Delegating profile extraction to worker for: ${url}`);
    const workerResult = await runProfileExtraction({
      sourceUrl: url,
      profile,
      expected: {
        name: expected.name,
        brandHint: expected.brandHint,
        price: expected.price,
        // ADR-0031: forwarded so the worker-side ladder enrichment can run
        // real identity classification (ExtractRequest.expected.upc).
        upc: expected.gtin || null,
      },
      variantSelection: (expected as any)?.variantSelection,
    });

    if (workerResult.ok && workerResult.data.title) {
      console.log(`[PageExtractor] Worker extraction succeeded for: ${url}`);
      if (domain) recordDomainStatus(domain, 'ok');

      // Spreadsheet price override — applied ONLY when the spreadsheet
      // actually carries a price. A ladder-enriched page price must survive
      // with its provenance intact (ADR-0031).
      const result = workerResult.data;
      if (expected?.price) {
        result.price = expected.price;
        result.fieldProvenance = { ...result.fieldProvenance, price: 'spreadsheet-import' };
      }

      return result;
    }

    // Worker failed — preserve structured variant failure codes + canonical matrix for job-queue gate (M4)
    if (!workerResult.ok && (workerResult as any).failureCode) {
      const code = (workerResult as any).failureCode as string;
      const msg = `variant:${code}:${workerResult.error}`;
      console.warn(`[PageExtractor] Worker extraction failed (variant gate): ${msg}`);
      if (domain) recordDomainStatus(domain, 'offline', msg);
      const payload: any = (workerResult as any).matrixDecision ? { ...(workerResult as any).matrixDecision } : {};
      // carry full matrix/candidates/hash so job-queue can persist selectable evidence (not zero hash [])
      const vm: any = (workerResult as any).variantMatrix ?? (workerResult as any).matrix ?? null;
      payload.candidates = (workerResult as any).candidates ?? (workerResult as any).matrixDecision?.candidates ?? vm?.candidates ?? payload.candidates ?? [];
      payload.identityMatrixHash = (workerResult as any).identityMatrixHash ?? (workerResult as any).matrixDecision?.identityMatrixHash ?? vm?.identityMatrixHash ?? payload.identityMatrixHash;
      payload.matrix = vm ?? (workerResult as any).matrixDecision?.matrix ?? payload.matrix;
      payload.variantMatrix = vm ?? payload.variantMatrix;
      throw new VariantExtractionError(code, msg, payload);
    }
    let errorDetail: string;
    if (!workerResult.ok) {
      errorDetail = workerResult.error;
    } else {
      errorDetail = 'Worker returned ok:false with no title';
    }
    console.warn(`[PageExtractor] Worker extraction failed: ${errorDetail}`);

    if (workerResult.warnings.length > 0) {
      console.warn(`[PageExtractor] Worker warnings: ${workerResult.warnings.join('; ')}`);
    }

    if (domain) {
      // Check if warnings indicate a Cloudflare block
      const hasBlockWarning = workerResult.warnings.some(
        (w) =>
          w.toLowerCase().includes('cloudflare') ||
          w.toLowerCase().includes('blocked') ||
          w.toLowerCase().includes('just a moment'),
      );
      recordDomainStatus(domain, hasBlockWarning ? 'blocked' : 'offline', errorDetail);
    }

    throw new Error(errorDetail);
  }

  // ── No-profile fallback: try Playwright directly in-process ───────────
  // This path is only reached when there is no profile (and HTTP extraction
  // did not succeed). It runs all extraction layers (JSON-LD, meta, etc.)
  // as a best-effort fallback.
  console.log(`[PageExtractor] Falling back to direct Playwright extraction for: ${url}`);

  // 2. Fallback to Playwright stealth mode
  let rawExtraction: RawExtraction | null = null;
  // Captured by task 15 — only populated when extraction succeeds and
  // validation passes. Used as input to the optional Playwright path of
  // the profile generation trigger.
  let playwrightHtml: string | null = null;
  let playwrightCustomHadAnyValue = false;

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const timeoutMs = isKnownBrand ? 40000 : 25000;

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // No route blocking — load all resources for accurate extraction
    const extractTask = async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs - 5000 });
      await page.waitForTimeout(2000);
      // Debug: log page title to verify page loaded correctly
      const pageTitle = await page.title();
      if (!pageTitle || pageTitle.includes('Just a moment') || pageTitle.includes('Cloudflare') || pageTitle.includes('Attention Required')) {
        console.error(`[PageExtractor] WARNING: Page may be blocked. Title: "${pageTitle}" URL: ${url}`);
      }

      // When profile exists, extract via profile selectors only (no fallback layers)
      let custom: Record<string, string | string[]> | null = null;
      if (profile) {
        try {
          custom = await extractCustomSelectors(page, profile);
        } catch (err) {
          console.error('[PageExtractor] Custom selector extraction failed:', err);
        }
        // No productJSON extraction — profile extraction is selector-only
      } else {
        // No profile — try all extraction layers
        try { custom = profile ? await extractCustomSelectors(page, profile) : null; } catch {}
        // Legacy productJSON extraction removed — superseded by the ADR-0031 ladder enrichment.
      }
      rawExtraction = {
        custom,
        jsonLd: null,
        metaTags: {},
        microdata: {},
        htmlHeuristics: {},
        images: [],
      };
      playwrightCustomHadAnyValue = customSelectorsHadAnyValue(custom);

      // Task 15: capture rendered HTML for the optional Playwright path of
      // the profile generation trigger. Captured only when extraction
      // succeeded, so a later failure does not produce a half-rendered
      // HTML snapshot.
      try {
        playwrightHtml = await page.content();
      } catch (captureErr) {
        console.warn('[PageExtractor] Failed to capture Playwright HTML for profile generation:', captureErr);
        playwrightHtml = null;
      }
    };

    await Promise.race([
      extractTask(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Page extraction timed out (${timeoutMs / 1000}s)`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    console.warn(`[PageExtractor] Playwright extraction failed or timed out: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch { /* ignore */ }
  }

  if (!rawExtraction) {
    if (domain) {
      recordDomainStatus(domain, 'offline', 'Failed to render or connect via HTTP and Playwright');
    }
    throw new Error(`Failed to extract data from ${url}`);
  }

  const result = mergeExtractionLayers(rawExtraction, url, expected);

  // 3. Post-extraction — skip validation when profile exists (curation handles it)
  if (expected && !profile) {
    const validation = validateExtraction(result, {
      name: expected.name,
      brandHint: expected.brandHint,
      domain: domain,
    });
    if (domain) {
      recordDomainStatus(domain, validation.status, validation.reason);
    }

    if (!validation.valid) {
      throw new Error(`Extraction validation failed: ${validation.reason}`);
    }

    // Assign spreadsheet price to result, completely bypassing supplemental price lookups or web pricing
    result.price = expected?.price || null;
    if (expected?.price) {
      result.fieldProvenance.price = 'spreadsheet-import';
    } else {
      delete result.fieldProvenance.price;
    }
  }

  // Price assignment for profile-based extractions (validation skipped)
  if (expected && profile) {
    result.price = expected?.price || null;
    if (expected?.price) {
      result.fieldProvenance.price = 'spreadsheet-import';
    } else {
      delete result.fieldProvenance.price;
    }
  }

  return result;
}

// ─── Cheerio Extractor Helpers ────────────────────────────────────────────────

function extractCustomSelectorsCheerio(
  $: cheerio.CheerioAPI,
  profile: ExtractorProfile
): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};
  
  if (profile.titleSelector) {
    data.title = $(profile.titleSelector).first().text().trim() || '';
    // If titleOptionalSelectors are configured, extract their text and append
    if (profile.titleOptionalSelectors?.length && data.title) {
      const extras = profile.titleOptionalSelectors
        .map(sel => $(sel).first().text().trim())
        .filter(Boolean)
        .join(' — ');
      if (extras) {
        data.title += ' — ' + extras;
      }
    }
  }
  if (profile.priceSelector) {
    data.price = $(profile.priceSelector).first().text().trim() || '';
  }
  if (profile.descriptionSelector) {
    data.description = $(profile.descriptionSelector).first().text().trim() || '';
  }
  if (profile.brandSelector) {
    data.brand = $(profile.brandSelector).first().text().trim() || '';
  }
  if (profile.imagesSelector) {
    const images: string[] = [];
    const seen = new Set<string>();
    $(profile.imagesSelector).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        if (!seen.has(src)) {
          seen.add(src);
          images.push(src);
        }
      }
    });
    data.images = images;
  }

  // Extract custom selectors
  if (profile.customSelectors) {
    for (const [fieldName, selector] of Object.entries(profile.customSelectors)) {
      if (!selector) continue;
      try {
        const val = $(selector).first().text().trim();
        if (val) {
          const cf = ((data as Record<string, unknown>).customFields as Record<string, string>) ?? {};
          cf[fieldName] = val;
          (data as Record<string, unknown>).customFields = cf;
        }
      } catch { /* skip bad selectors */ }
    }
  }

  return data;
}

function extractJsonLdCheerio($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const scripts: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).text() || '');
  });

  for (const script of scripts) {
    try {
      const data = JSON.parse(script);
      if (data['@graph']) {
        const product = (data['@graph'] as Record<string, unknown>[]).find(
          (item: Record<string, unknown>) => item['@type'] === 'Product',
        );
        if (product) return product;
      }
      if (data['@type'] === 'Product') return data;
      if (Array.isArray(data)) {
        const product = data.find((item: Record<string, unknown>) => item['@type'] === 'Product');
        if (product) return product;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function extractMetaTagsCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const tags: Record<string, string> = {};
  $('meta').each((_, el) => {
    const property = $(el).attr('property') ?? $(el).attr('name') ?? '';
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

function extractMicrodataCheerio($: cheerio.CheerioAPI): Record<string, string> {
  const data: Record<string, string> = {};
  const scope = $('[itemscope][itemtype*="Product"]').first();
  if (scope.length === 0) return data;

  scope.find('[itemprop]').each((_, el) => {
    const name = $(el).attr('itemprop') ?? '';
    const value = $(el).attr('content')
      ?? $(el).attr('src')
      ?? $(el).text().trim()
      ?? '';
    if (name && value) {
      data[name] = value;
    }
  });
  return data;
}

function extractHtmlHeuristicsCheerio($: cheerio.CheerioAPI): Record<string, string | string[]> {
  const data: Record<string, string | string[]> = {};

  const titleSelectors = [
    'h1.product-title', 'h1.product-name', 'h1.pdp-title',
    '[data-testid="product-title"]', '[data-product-name]',
    '.product-info h1', '.product-detail h1', '.pdp-header h1',
    '#product-title', '#productTitle', '#product-name',
    'h1',
  ];

  for (const sel of titleSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.title = text;
      break;
    }
  }

  const descSelectors = [
    '.product-description', '.pdp-description', '#product-description',
    '[data-testid="product-description"]', '.product-detail__description',
    '.product-info__description',
  ];

  for (const sel of descSelectors) {
    const text = $(sel).first().text().trim();
    if (text && text.length > 20) {
      data.description = text;
      break;
    }
  }

  const bulletSelectors = [
    '.product-features li', '.product-highlights li',
    '.pdp-features li', '#product-features li',
    '[data-testid="product-features"] li',
  ];

  for (const sel of bulletSelectors) {
    const list: string[] = [];
    $(sel).each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) list.push(txt);
    });
    if (list.length > 0) {
      data.bulletPoints = list;
      break;
    }
  }

  const priceSelectors = [
    '.product-price', '.pdp-price', '#product-price',
    '[data-testid="product-price"]', '.price-current',
    '.price', '[itemprop="price"]',
  ];

  for (const sel of priceSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      const match = text.match(/\$?(\d+\.?\d*)/);
      if (match) {
        data.price = match[0];
        break;
      }
    }
  }

  const brandSelectors = [
    '.product-brand', '.pdp-brand', '#product-brand',
    '[data-testid="product-brand"]', '[itemprop="brand"]',
    '.brand-name', '.manufacturer',
  ];

  for (const sel of brandSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.brand = text;
      break;
    }
  }

  const weightSelectors = [
    '[data-testid="product-weight"]', '.product-weight',
    '.pdp-weight',
  ];

  for (const sel of weightSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      data.weight = text;
      break;
    }
  }

  return data;
}



function extractImagesCheerio($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  const specificSelectors = [
    '.product-image img', '.pdp-image img', '.product-gallery img',
    '[data-testid="product-image"] img', '#product-images img',
    '.product-media img', '.gallery img', '.product-photo img',
    'img[itemprop="image"]',
  ];

  const fallbackSelectors = [
    'main img', '#content img', '.content img',
  ];

  const collectFromSelector = (sel: string) => {
    $(sel).each((_, el) => {
      for (const src of collectImageSourcesFromElement($, el)) {
        addImageSource(src, seen, images);
      }
    });
  };

  // Try product-scoped selectors first, collecting src/srcset from only
  // those matched elements. Do not scan every img[srcset] on the page:
  // many Shopify themes render recommendation/product-card carousels with
  // srcsets before the PDP media, which polluted additionalImages for Woof.
  for (const sel of specificSelectors) {
    collectFromSelector(sel);
  }

  // If no images found from specific product selectors, use bounded content
  // fallbacks. Srcset parsing is still scoped to those fallback matches.
  if (images.length === 0) {
    for (const sel of fallbackSelectors) {
      collectFromSelector(sel);
    }
  }

  return images.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}


// ─── Layer 0: Custom Selector Helper ──────────────────────────────────────────

async function extractCustomSelectors(
  page: import('playwright').Page,
  profile: ExtractorProfile,
): Promise<Record<string, string | string[]>> {
  return page.evaluate((prof) => {
    const data: Record<string, string | string[]> = {};
    
    if (prof.titleSelector) {
      const el = document.querySelector(prof.titleSelector);
      data.title = el?.textContent?.trim() || '';
      // If titleOptionalSelectors are configured, extract their text and append
      if (prof.titleOptionalSelectors?.length && data.title) {
        const extras = prof.titleOptionalSelectors
          .map((sel: string) => {
            const subEl = document.querySelector(sel);
            return subEl?.textContent?.trim() || '';
          })
          .filter(Boolean)
          .join(' — ');
        if (extras) {
          data.title += ' — ' + extras;
        }
      }
    }
    if (prof.priceSelector) {
      const el = document.querySelector(prof.priceSelector);
      data.price = el?.textContent?.trim() || '';
    }
    if (prof.descriptionSelector) {
      const el = document.querySelector(prof.descriptionSelector);
      data.description = el?.textContent?.trim() || '';
    }
    if (prof.brandSelector) {
      const el = document.querySelector(prof.brandSelector);
      data.brand = el?.textContent?.trim() || '';
    }
    // Custom selectors
    if (prof.customSelectors) {
      const cFields: Record<string, string> = {};
      for (const [fieldName, selector] of Object.entries(prof.customSelectors)) {
        if (!selector) continue;
        try {
          const el = document.querySelector(selector);
          if (el) cFields[fieldName] = el.textContent?.trim() || '';
        } catch { /* skip bad selectors */ }
      }
      if (Object.keys(cFields).length > 0) (data as Record<string, unknown> & { customFields?: Record<string,string> }).customFields = cFields;
    }
    if (prof.imagesSelector) {
      const parseSrcsetCandidates = (srcset: string | null | undefined): string[] => {
        if (!srcset) return [];
        return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
      };
      const isUsableImageSource = (src: string | null | undefined): src is string => {
        if (!src) return false;
        const trimmed = src.trim();
        if (!trimmed) return false;
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('data:')) return false;
        if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
        return true;
      };
      const imageSourcesForElement = (el: Element): string[] => {
        const sources: string[] = [];
        const targets = el instanceof HTMLImageElement || el instanceof HTMLSourceElement
          ? [el]
          : Array.from(el.querySelectorAll('img,source'));
        for (const target of targets) {
          if (target instanceof HTMLImageElement && isUsableImageSource(target.currentSrc)) sources.push(target.currentSrc.trim());
          for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
            const value = target.getAttribute(attr);
            if (isUsableImageSource(value)) sources.push(value.trim());
          }
          for (const attr of ['srcset', 'data-srcset']) {
            for (const candidate of parseSrcsetCandidates(target.getAttribute(attr))) {
              if (isUsableImageSource(candidate)) sources.push(candidate.trim());
            }
          }
        }
        return sources;
      };

      const seen = new Set<string>();
      data.images = Array.from(document.querySelectorAll(prof.imagesSelector))
        .flatMap(imageSourcesForElement)
        .filter(src => {
          if (seen.has(src)) return false;
          seen.add(src);
          return true;
        });
    }
    
    return data;
  }, profile);
}

// ─── Layer 1: JSON-LD ──────────────────────────────────────────────────────────

async function extractJsonLd(page: import('playwright').Page): Promise<Record<string, unknown> | null> {
  const scripts = await page.$$eval(
    'script[type="application/ld+json"]',
    (els) => els.map(el => el.textContent ?? ''),
  );

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
        const product = data.find((item: Record<string, unknown>) => item['@type'] === 'Product');
        if (product) return product;
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  return null;
}

// ─── Layer 2: Meta Tags ────────────────────────────────────────────────────────

async function extractMetaTags(page: import('playwright').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const tags: Record<string, string> = {};
    const metas = document.querySelectorAll('meta');

    for (const meta of metas) {
      const property = meta.getAttribute('property') ?? meta.getAttribute('name') ?? '';
      const content = meta.getAttribute('content') ?? '';
      if (property && content) {
        tags[property] = content;
      }
    }

    // Also grab <title>
    const titleEl = document.querySelector('title');
    if (titleEl?.textContent) {
      tags['page:title'] = titleEl.textContent.trim();
    }

    return tags;
  });
}

// ─── Layer 3: Microdata ────────────────────────────────────────────────────────

async function extractMicrodata(page: import('playwright').Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const data: Record<string, string> = {};
    const scope = document.querySelector('[itemscope][itemtype*="Product"]');
    if (!scope) return data;

    const props = scope.querySelectorAll('[itemprop]');
    for (const prop of props) {
      const name = prop.getAttribute('itemprop') ?? '';
      const value = prop.getAttribute('content')
        ?? (prop as HTMLImageElement).src
        ?? prop.textContent?.trim()
        ?? '';
      if (name && value) {
        data[name] = value;
      }
    }
    return data;
  });
}

// ─── Layer 4: HTML Heuristics ──────────────────────────────────────────────────

async function extractHtmlHeuristics(page: import('playwright').Page): Promise<Record<string, string | string[]>> {
  return page.evaluate(() => {
    const data: Record<string, string | string[]> = {};

    // Product title selectors (priority order)
    const titleSelectors = [
      'h1.product-title', 'h1.product-name', 'h1.pdp-title',
      '[data-testid="product-title"]', '[data-product-name]',
      '.product-info h1', '.product-detail h1', '.pdp-header h1',
      '#product-title', '#productTitle', '#product-name',
      'h1',
    ];

    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.title = el.textContent.trim();
        break;
      }
    }

    // Description
    const descSelectors = [
      '.product-description', '.pdp-description', '#product-description',
      '[data-testid="product-description"]', '.product-detail__description',
      '.product-info__description',
    ];

    for (const sel of descSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim() && el.textContent.trim().length > 20) {
        data.description = el.textContent.trim();
        break;
      }
    }

    // Bullet points / features
    const bulletSelectors = [
      '.product-features li', '.product-highlights li',
      '.pdp-features li', '#product-features li',
      '[data-testid="product-features"] li',
    ];

    for (const sel of bulletSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        data.bulletPoints = Array.from(els).map(el => el.textContent?.trim() ?? '').filter(Boolean);
        break;
      }
    }

    // Price
    const priceSelectors = [
      '.product-price', '.pdp-price', '#product-price',
      '[data-testid="product-price"]', '.price-current',
      '.price', '[itemprop="price"]',
    ];

    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        const priceText = el.textContent.trim();
        // Extract price number
        const match = priceText.match(/\$?(\d+\.?\d*)/);
        if (match) {
          data.price = match[0];
          break;
        }
      }
    }

    // Brand
    const brandSelectors = [
      '.product-brand', '.pdp-brand', '#product-brand',
      '[data-testid="product-brand"]', '[itemprop="brand"]',
      '.brand-name', '.manufacturer',
    ];

    for (const sel of brandSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.brand = el.textContent.trim();
        break;
      }
    }

    // Weight
    const weightSelectors = [
      '[data-testid="product-weight"]', '.product-weight',
      '.pdp-weight',
    ];

    for (const sel of weightSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) {
        data.weight = el.textContent.trim();
        break;
      }
    }

    return data;
  });
}

// ─── Layer 5: Image Extraction ─────────────────────────────────────────────────

async function extractImages(page: import('playwright').Page, baseUrl: string): Promise<string[]> {
  const rawImages = await page.evaluate(() => {
    const images: string[] = [];
    const seen = new Set<string>();

    const specificSelectors = [
      '.product-image img', '.pdp-image img', '.product-gallery img',
      '[data-testid="product-image"] img', '#product-images img',
      '.product-media img', '.gallery img', '.product-photo img',
      'img[itemprop="image"]',
    ];

    const fallbackSelectors = [
      'main img', '#content img', '.content img',
    ];

    const parseSrcsetCandidates = (srcset: string | null | undefined): string[] => {
      if (!srcset) return [];
      return srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    };
    const isUsableImageSource = (src: string | null | undefined): src is string => {
      if (!src) return false;
      const trimmed = src.trim();
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('data:')) return false;
      if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
      return true;
    };
    const imageSourcesForElement = (el: Element): string[] => {
      const target = el instanceof HTMLImageElement || el instanceof HTMLSourceElement
        ? el
        : el.querySelector('img,source');
      if (!target) return [];

      const sources: string[] = [];
      if (target instanceof HTMLImageElement && isUsableImageSource(target.currentSrc)) sources.push(target.currentSrc.trim());
      for (const attr of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-zoom-image']) {
        const value = target.getAttribute(attr);
        if (isUsableImageSource(value)) sources.push(value.trim());
      }
      for (const attr of ['srcset', 'data-srcset']) {
        for (const candidate of parseSrcsetCandidates(target.getAttribute(attr))) {
          if (isUsableImageSource(candidate)) sources.push(candidate.trim());
        }
      }
      return sources;
    };
    const hasLargeEnoughDimensions = (el: Element): boolean => {
      const img = el instanceof HTMLImageElement ? el : el.querySelector('img');
      if (!img) return true;
      const naturalWidth = img.naturalWidth || parseInt(img.getAttribute('width') ?? '0');
      const naturalHeight = img.naturalHeight || parseInt(img.getAttribute('height') ?? '0');
      return naturalWidth > 100 || naturalHeight > 100 || (!naturalWidth && !naturalHeight);
    };
    const collectFromSelector = (sel: string) => {
      for (const el of document.querySelectorAll(sel)) {
        if (!hasLargeEnoughDimensions(el)) continue;
        for (const src of imageSourcesForElement(el)) {
          if (!seen.has(src)) {
            seen.add(src);
            images.push(src);
          }
        }
      }
    };

    for (const sel of specificSelectors) {
      collectFromSelector(sel);
    }

    if (images.length === 0) {
      for (const sel of fallbackSelectors) {
        collectFromSelector(sel);
      }
    }

    return images;
  });

  // Resolve relative URLs to absolute
  return rawImages.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}


// Helper functions size/color aliases moved to variant-resolver.ts for Discovery-time resolution.

// ─── Merge Layers ──────────────────────────────────────────────────────────────

function mergeExtractionLayers(
  raw: RawExtraction,
  sourceUrl: string,
  expected?: { name?: string; brandHint?: string | null; price?: string | null; gtin?: string },
): ExtractionData {
  const provenance: Record<string, string> = {};
  let confidenceScore = 0;
  let confidenceFactors = 0;

  // Helper: pick first non-null value, tracking provenance
  function pick(field: string, ...sources: Array<[string | undefined | null, string]>): string | null {
    for (const [value, source] of sources) {
      if (value && value.trim()) {
        provenance[field] = source;
        return value.trim();
      }
    }
    return null;
  }

  // Legacy Shopify variant matching removed — the deprecated in-page
  // productJSON payload was always null, so this code was unreachable.
  // Variant-aware extraction is owned by the ADR-0031 ladder enrichment.

  // Title
  let title = pick('title',
    [raw.custom?.title as string, 'custom-selector'],
    [raw.jsonLd?.name as string, 'json-ld'],
    [raw.microdata.name, 'microdata'],
    [raw.metaTags['og:title'], 'meta'],
    [raw.htmlHeuristics.title as string, 'html'],
    [raw.metaTags['page:title'], 'meta'],
  );

  if (title) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Brand
  const jsonLdBrand = raw.jsonLd?.brand as Record<string, unknown> | string | undefined;
  const brandFromJsonLd = typeof jsonLdBrand === 'string'
    ? jsonLdBrand
    : (jsonLdBrand as Record<string, unknown>)?.name as string | undefined;

  const brand = pick('brand',
    [raw.custom?.brand as string, 'custom-selector'],
    [brandFromJsonLd, 'json-ld'],
    [raw.microdata.brand, 'microdata'],
    [raw.htmlHeuristics.brand as string, 'html'],
    [raw.metaTags['product:brand'], 'meta'],
  );
  if (brand) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Description
  const description = pick('description',
    [raw.custom?.description as string, 'custom-selector'],
    [raw.jsonLd?.description as string, 'json-ld'],
    [raw.microdata.description, 'microdata'],
    [raw.metaTags['og:description'], 'meta'],
    [raw.metaTags.description, 'meta'],
    [raw.htmlHeuristics.description as string, 'html'],
  );
  if (description) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Price
  const jsonLdPrice = raw.jsonLd?.offers as Record<string, unknown> | undefined;
  const priceFromJsonLd = jsonLdPrice?.price as string | undefined
    ?? (jsonLdPrice as Record<string, unknown>)?.lowPrice as string | undefined;

  let price = pick('price',
    [raw.custom?.price as string, 'custom-selector'],
    [priceFromJsonLd, 'json-ld'],
    [raw.microdata.price, 'microdata'],
    [raw.metaTags['product:price:amount'], 'meta'],
    [raw.htmlHeuristics.price as string, 'html'],
  );

  // Clean raw price text to numeric representation if extracted via custom-selector
  if (price && provenance.price === 'custom-selector') {
    const match = price.match(/\$?(\d+\.?\d*)/);
    if (match) {
      price = match[0];
    }
  }

  if (price) { confidenceScore++; confidenceFactors++; } else { confidenceFactors++; }

  // Images
  const rawAllImages = (raw.custom?.images as string[]) ?? [];
  const customImages = cleanAndDeduplicateImages(rawAllImages, sourceUrl);
  const extractedImages = raw.images || [];
  const combinedImages = [...customImages, ...extractedImages];
  const allImages = cleanAndDeduplicateImages(combinedImages, sourceUrl);

  let primaryImage: string | null = null;
  let provenanceSrc = 'json-ld';

  // 1. Fall back to custom selector or structured data
  if (!primaryImage) {
    if (customImages.length > 0) {
      primaryImage = customImages[0];
      provenanceSrc = 'custom-selector';
    } else {
      const primaryImageCandidates = [
        raw.jsonLd?.image as string | string[] | undefined,
        raw.metaTags['og:image'],
        raw.microdata.image,
      ];

      for (const candidate of primaryImageCandidates) {
        if (candidate) {
          primaryImage = Array.isArray(candidate) ? candidate[0] : candidate;
          provenanceSrc = 'json-ld';
          break;
        }
      }
    }
  }

  // 2. Normalize primaryImage protocol/relative paths and width if Shopify CDN
  if (primaryImage) {
    try {
      const imgUrlObj = new URL(primaryImage, sourceUrl);
      primaryImage = imgUrlObj.href;
      if (imgUrlObj.hostname.includes('shopify.com') || imgUrlObj.pathname.includes('/cdn/shop/')) {
        const vParam = imgUrlObj.searchParams.get('v');
        imgUrlObj.search = '';
        if (vParam) imgUrlObj.searchParams.set('v', vParam);
        imgUrlObj.searchParams.set('width', '1200');
        primaryImage = imgUrlObj.href;
      }
    } catch {
      if (primaryImage.startsWith('//')) {
        primaryImage = 'https:' + primaryImage;
      }
    }
  }

  // Use HTML-extracted images if no structured/variant primary image found
  if (!primaryImage && allImages.length > 0) {
    primaryImage = allImages[0];
    provenanceSrc = 'html';
  }

  if (primaryImage) {
    provenance.primaryImage = provenanceSrc;
    confidenceScore++; 
    confidenceFactors++; 
  } else { 
    confidenceFactors++; 
  }

  // Exclude primaryImage from allImages to get additionalImages
  const primaryCanonical = primaryImage ? canonicalizeUrl(primaryImage, sourceUrl) : '';
  const additionalImages = allImages.filter(img => {
    return canonicalizeUrl(img, sourceUrl) !== primaryCanonical;
  });

  // Bullet points
  const bulletPoints = (raw.htmlHeuristics.bulletPoints as string[] | undefined) ?? [];
  if (bulletPoints.length > 0) provenance.bulletPoints = 'html';

  // Weight
  const weight = pick('weight',
    [raw.jsonLd?.weight as string, 'json-ld'],
    [raw.microdata.weight, 'microdata'],
    [raw.htmlHeuristics.weight as string, 'html'],
  );

  // SEO filename from URL path
  let seoFileName: string | null = null;
  try {
    const urlPath = new URL(sourceUrl).pathname;
    const lastSegment = urlPath.split('/').filter(Boolean).pop();
    if (lastSegment && !lastSegment.match(/^\d+$/)) {
      seoFileName = lastSegment.replace(/\.\w+$/, ''); // strip extension
      provenance.seoFileName = 'url';
    }
  } catch { /* skip */ }

  // Search keywords from title + brand + description
  const keywordParts = [title, brand, description].filter(Boolean);
  const searchKeywords = keywordParts.length > 0
    ? keywordParts.join(' ').substring(0, 200)
    : null;
  if (searchKeywords) provenance.searchKeywords = 'derived';

  // Calculate overall confidence
  const confidence = confidenceFactors > 0 ? confidenceScore / confidenceFactors : 0;

  // Transfer custom fields from profile selector extraction
  let customFields: Record<string, string> = {};
  if (raw.custom && typeof raw.custom === 'object' && 'customFields' in raw.custom) {
    const cf = (raw.custom as Record<string, unknown> & { customFields?: unknown }).customFields;
    if (cf && typeof cf === 'object') customFields = cf as Record<string, string>;
  }

  return ExtractionDataSchema.parse({
    title,
    brand,
    description,
    bulletPoints,
    primaryImage,
    additionalImages,
    price,
    weight,
    dimensions: null,
    seoFileName,
    searchKeywords,
    sourceUrl,
    confidence,
    fieldProvenance: provenance,
    packagingTitle: null,
    packagingOcrData: null,
    customFields,
  });
}
