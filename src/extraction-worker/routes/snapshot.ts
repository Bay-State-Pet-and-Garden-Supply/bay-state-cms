/**
 * Snapshot route — POST /profile-tooling/snapshot
 *
 * Fetches a single page for Profile Builder diagnostics. Supports two runtimes:
 *
 *   - **static**:  Plain HTTP fetch + regex HTML extraction (no browser).
 *   - **rendered**: Headless Playwright Chromium with image/font/stylesheet
 *                   blocking, JS execution, and optional screenshot capture.
 *
 * All artifact files are written under:
 *   <cwd>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/
 *
 * The response always passes through SnapshotResponseSchema validation so the
 * caller receives a well-structured result even when warnings are present.
 * Errors are surfaced in the `warnings` array; uncaught exceptions return a
 * minimal SnapshotResponse with the error in warnings.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright';
import { SnapshotRequestSchema, SnapshotResponseSchema } from '../../shared/schemas/extraction-worker';
import type { SnapshotResponse, InteractionAction } from '../../shared/schemas/extraction-worker';
import type { NetworkCaptureArtifact } from '../../shared/schemas/extraction-worker';
import { isPrivateOrLinkLocal } from '../../shared/ssrf';
import { sha256Hex } from '../../shared/stable-id';
import { resolveArtifactDir, writeArtifact, generateJobId, extractDomainFromUrl } from '../artifacts';

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
const RENDERED_TIMEOUT_MS = 25_000;
const RENDERED_DWELL_MS = 2_000;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function findBalancedBrace(text: string, startIdx: number, maxChars = 800_000): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = startIdx; i < text.length && i < startIdx + maxChars; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) {
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Static HTML extraction helpers ──────────────────────────────────────────

function extractJsonLdFromHtml(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    try {
      const raw = match[1].trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === 'object') results.push(item as Record<string, unknown>);
        }
      } else if (data && typeof data === 'object') {
        results.push(data as Record<string, unknown>);
      }
    } catch {
      // skip invalid JSON blocks
    }
  }
  return results;
}


/**
 * Extract embedded Shopify product data objects from HTML using regex scanning.
 * Looks for patterns like:
 *   window.productJSON = { ... }
 *   var productJSON = { ... }
 *   window.ShopifyAnalytics = { ... }
 *   window.__INITIAL_STATE__ = { ... }
 */
function extractEmbeddedProductDataFromHtml(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const patterns = [
    { pattern: /window\.productJSON\s*=\s*/g, name: 'productJSON' },
    { pattern: /var\s+productJSON\s*=\s*/g, name: 'productJSON' },
    { pattern: /window\.ShopifyAnalytics\s*=\s*/g, name: 'ShopifyAnalytics' },
    { pattern: /window\.__INITIAL_STATE__\s*=\s*/g, name: '__INITIAL_STATE__' },
    { pattern: /let\s+meta\s*=\s*/g, name: 'meta' },
    { pattern: /var\s+meta\s*=\s*/g, name: 'meta' },
  ];

  for (const { pattern } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const assignEnd = match.index + match[0].length;
      const braceStart = html.indexOf('{', assignEnd);
      if (braceStart === -1) continue;
      const braceEnd = findBalancedBrace(html, braceStart);
      if (braceEnd === -1) continue;
      try {
        const raw = html.substring(braceStart, braceEnd + 1);
        let obj: unknown;
        try {
          obj = JSON.parse(raw);
        } catch {
          // Trailing commas are common in JS object literals but invalid in JSON.
          // Strip trailing commas before closing braces as a best-effort recovery.
          const cleaned = raw.replace(/,([ \t]*[\]}])/g, '$1');
          obj = JSON.parse(cleaned);
        }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          results.push(obj as Record<string, unknown>);
        }
      } catch {
        // skip unparseable blocks
      }
    }
  }

  return results;
}

function extractImageCandidatesFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  // Collect all <img> tags
  const imgRegex = /<img[\s\S]*?>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const getAttr = (name: string): string | null => {
      const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
      const m = tag.match(re);
      return m ? m[1] : null;
    };

    // Collect sources from multiple attributes
    const src = getAttr('src');
    const dataSrc = getAttr('data-src');
    const dataOriginal = getAttr('data-original');
    const srcset = getAttr('srcset');

    const rawSources = [src, dataSrc, dataOriginal];
    for (const raw of rawSources) {
      if (raw && isUsableImageSrc(raw) && !seen.has(raw)) {
        seen.add(raw);
        candidates.push(raw);
      }
    }

    // Parse srcset candidates
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url && isUsableImageSrc(url) && !seen.has(url)) {
          seen.add(url);
          candidates.push(url);
        }
      }
    }
  }

  return candidates;
}

function isUsableImageSrc(src: string): boolean {
  const trimmed = src.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return false;
  if (trimmed.startsWith('blob:')) return false;
  // Reject SVGs by extension
  const path = trimmed.split(/[?#]/)[0];
  if (path.endsWith('.svg')) return false;
  return true;
}

function extractPageStructureSignalsFromHtml(html: string): string[] {
  const signals: string[] = [];

  // CSS class .product on any element
  if (/class\s*=\s*["'][^"']*\bproduct\b[^"']*["']/i.test(html)) {
    signals.push('css-class:product');
  }

  // data-product attribute
  if (/data-product\b/i.test(html)) signals.push('attr:data-product');

  // Shopify scripts
  if (/cdn\.shopify\.com/i.test(html)) signals.push('script:shopify');

  // JSON-LD Product type
  if (/"@type"\s*:\s*"Product"/i.test(html)) signals.push('jsonld:Product');

  // og:type = product
  if (/property\s*=\s*["']og:type["'][\s\S]*?content\s*=\s*["']product["']/i.test(html)) {
    signals.push('meta:og:type=product');
  }

  // Microdata Product scope
  if (/itemscope[\s\S]*?itemtype[\s\S]*?Product/i.test(html)) {
    signals.push('microdata:Product');
  }


  // add-to-cart form / button
  if (/add-to-cart|add_to_cart|data-product-id/i.test(html)) {
    signals.push('interaction:add-to-cart');
  }

  // Pinterest / rich-pin
  if (/pinterest/i.test(html)) signals.push('script:pinterest');

  return signals;
}

/**
 * Strip non-content tags from raw HTML to produce a minified page.
 * Removes: style, svg, noscript, header, footer, nav, script tags
 * and collapses whitespace.
 */
function stripNonContentTags(html: string): string {
  let result = html;
  // Remove comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  // Remove style blocks
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove svg blocks (including inner content)
  result = result.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // Remove noscript blocks
  result = result.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Remove header, footer, nav blocks
  result = result.replace(/<header[\s\S]*?<\/header>/gi, '');
  result = result.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  result = result.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  // Remove all script tags
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  // Collapse whitespace
  result = result.replace(/\s{2,}/g, ' ');
  result = result.replace(/>\s+</g, '><');
  return result.trim();
}

// ─── Rendered (Playwright) extraction helpers ─────────────────────────────────

// The evaluate callbacks are defined as string-wrapped functions to avoid
// tsx injecting `__name` runtime helpers that are unavailable in the
// Playwright browser evaluation context.

function makeJsonLdExtractor(): string {
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
        } catch (e) {
          // skip
        }
      }
      return results;
    })()`;
}

async function extractJsonLdFromPage(
  page: import('playwright').Page,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(makeJsonLdExtractor());
}

function makeEmbeddedProductDataExtractor(): string {
  return `
    (() => {
      const results = [];
      const w = window;
      if (w.productJSON && typeof w.productJSON === 'object') results.push(w.productJSON);
      if (w.ShopifyAnalytics && typeof w.ShopifyAnalytics === 'object') results.push(w.ShopifyAnalytics);
      if (w.__INITIAL_STATE__ && typeof w.__INITIAL_STATE__ === 'object') results.push(w.__INITIAL_STATE__);
      return results;
    })()`;
}

async function extractEmbeddedProductDataFromPage(
  page: import('playwright').Page,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(makeEmbeddedProductDataExtractor());
}

function makeImageCandidatesExtractor(): string {
  // Produces JavaScript source evaluated in the browser.
  // Using string split on space character instead of regex \\s+ to
  // avoid template-literal escaping issues with the backslash.
  return `
    (() => {
      const seen = new Set();
      const images = [];
      const imgEls = document.querySelectorAll('img');
      for (const img of imgEls) {
        const tryAdd = (src) => {
          if (!src) return;
          const t = src.trim();
          if (!t) return;
          const l = t.toLowerCase();
          if (l.startsWith('data:')) return;
          if (l.startsWith('blob:')) return;
          const p = l.split(/[?#]/)[0];
          if (p.endsWith('.svg')) return;
          if (seen.has(t)) return;
          seen.add(t);
          images.push(t);
        };
        tryAdd(img.getAttribute('src'));
        tryAdd(img.getAttribute('currentSrc'));
        tryAdd(img.getAttribute('data-src'));
        tryAdd(img.getAttribute('data-original'));
        tryAdd(img.getAttribute('data-lazy-src'));
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          for (const part of srcset.split(',')) {
            const url = part.trim().split(' ')[0];
            if (url && !url.startsWith('data:') && !seen.has(url)) {
              seen.add(url);
              images.push(url);
            }
          }
        }
      }
      return images;
    })()`;
}

async function extractImageCandidatesFromPage(
  page: import('playwright').Page,
  baseUrl: string,
): Promise<string[]> {
  const rawImages = await page.evaluate(makeImageCandidatesExtractor()) as string[];

  // Resolve relative URLs to absolute
  return rawImages.map((src: string) => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));
}

function makePageStructureSignalsExtractor(): string {
  return `
    (() => {
      const signals = [];
      if (document.querySelector('.product')) signals.push('css-class:product');
      if (document.querySelector('[data-product]')) signals.push('attr:data-product');
      const scripts = document.querySelectorAll('script[src]');
      for (const s of scripts) {
        if ((s.src || '').includes('cdn.shopify.com')) {
          signals.push('script:shopify');
          break;
        }
      }
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of ldScripts) {
        try {
          const data = JSON.parse(s.textContent || '{}');
          const hasProduct = (obj) => {
            if (obj && typeof obj === 'object') {
              if (obj['@type'] === 'Product') return true;
              if (Array.isArray(obj['@graph']) && obj['@graph'].some(hasProduct)) return true;
            }
            return false;
          };
          if (hasProduct(data)) {
            signals.push('jsonld:Product');
            break;
          }
        } catch (e) {}
      }
      const ogType = document.querySelector('meta[property="og:type"]');
      if (ogType && ogType.getAttribute('content') === 'product') signals.push('meta:og:type=product');
      if (document.querySelector('[itemscope][itemtype*="Product"]')) signals.push('microdata:Product');
      if (document.querySelector('meta[property="product:brand"]')) signals.push('meta:product:brand');
      if (document.querySelector('[data-product-id], .add-to-cart, .add_to_cart, [class*="add-to-cart"], [class*="add_to_cart"]')) signals.push('interaction:add-to-cart');
      const allS = document.querySelectorAll('script');
      for (const s of allS) {
        if ((s.src || '').includes('pinterest')) {
          signals.push('script:pinterest');
          break;
        }
      }
      return signals;
    })()`;
}

async function extractPageStructureSignalsFromPage(
  page: import('playwright').Page,
): Promise<string[]> {
  return page.evaluate(makePageStructureSignalsExtractor());
}

// ─── Snapshot execution ────────────────────────────────────────────────────────

/** A product-relevant network response captured during a rendered snapshot. */
interface CapturedNetworkResponse {
  url: string;
  status: number;
  responseContentType: string | null;
  jsonBody: unknown;
  timingMs: number | null;
  contentHash: string;
}

const MAX_CAPTURED_RESPONSES = 40;
const MAX_CAPTURE_BYTES = 2_000_000;
const MAX_AGGREGATE_CAPTURE_BYTES = 8_000_000;

/** Round-6 P1-4: per-subrequest response stream cap (fulfillPinnedSubrequest). */
const MAX_SUBREQUEST_RESPONSE_BYTES = 2_000_000;
/** Round-6 P1-4: aggregate bytes fulfilled across one snapshot's subrequests. */
const MAX_AGGREGATE_SUBREQUEST_BYTES = 8_000_000;
/** Round-6 P1-4: max request body copied into the worker path from the page. */
const MAX_SUBREQUEST_BODY_BYTES = 1_000_000;

/** Mutable per-snapshot budget shared with fulfillPinnedSubrequest. */
export interface SubrequestBudgetState {
  bytes: number;
}

/**
 * Read a Response body with a hard stream cap (no Content-Length trust):
 * chunked / missing-length bodies stop being read once the cap trips and the
 * error propagates fail-closed (the route is aborted by the caller).
 */
async function readBoundedBody(response: Response, cap: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > cap) {
    throw new Error(`subrequest response declares ${declared} bytes (cap ${cap})`);
  }
  if (!response.body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > cap) {
      throw new Error(`subrequest response exceeds ${cap} bytes (${fallback.length})`);
    }
    return fallback;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        throw new Error(`subrequest response exceeds ${cap} bytes (${total})`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks);
}

/** URLs that are never product evidence (cart/account/checkout/session...). */
const NON_PRODUCT_URL = /cart|checkout|account|customer|order|session|login|logout|wishlist|billing|payment|address|profile|subscription|api\/auth|sentry|logrocket|segment|amplitude|mixpanel|fullstory|mouseflow|taboola|telemetry|beacon/i;

/** Expanded tracker/analytics denylist (review PI-11-M1/n1). */
const TRACKER_URL = /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel|sentry|logrocket|segment|amplitude|mixpanel|fullstory|mouseflow|taboola|telemetry|beacon/i;

/** Keys whose values are never product evidence (credentials/personal data). */
const SENSITIVE_KEY = /token|password|secret|authorization|cookie|sessionid|email|phone|card|ccv|cvv|ssn|birthdate/i;

/**
 * Replace sensitive values in a captured payload (depth-bounded walk; the
 * shape is preserved, values are redacted). Requirement: do not persist
 * unrelated credentials or personal data.
 */
function redactSensitiveKeys(node: unknown, depth = 0): unknown {
  if (depth > 8) return node;
  if (Array.isArray(node)) {
    return node.map((item) => redactSensitiveKeys(item, depth + 1));
  }
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactSensitiveKeys(value, depth + 1);
  }
  return out;
}

/**
 * Install a Playwright response listener that captures product-relevant
 * XHR/fetch/GraphQL JSON responses. Filtering keeps analytics, media, and
 * oversized payloads out; only parsed JSON bodies are retained.
 */
async function installNetworkCapture(
  page: import('playwright').Page,
  sourcesAllowlist?: string[],
): Promise<{
  responses: CapturedNetworkResponse[];
  stop: () => void;
}> {
  const responses: CapturedNetworkResponse[] = [];
  let aggregateBytes = 0;
  const startedAt = Date.now();
  const onResponse = async (response: import('playwright').Response): Promise<void> => {
    if (responses.length >= MAX_CAPTURED_RESPONSES) return;
    const request = response.request();
    const type = request.resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    if (!contentType.includes('json')) return;
    const reqUrl = response.url();
    // P0-1: never capture responses from private/link-local destinations or
    // destinations outside the run's allowed source domains. Round-3: DNS
    // resolution applies to captured sub-resources too, and lookup failure
    // fails closed (an unresolvable destination is never captured).
    if (isPrivateOrLinkLocalUrl(reqUrl)) return;
    // Round-4 P1-4: pinned http captures present IP-literal URLs — match the
    // allowlist against the Host header identity in that case.
    if (!isDestinationAllowed(reqUrl, sourcesAllowlist, effectiveHostForIpLiteral(reqUrl, response.request().headers()['host']))) return;
    if ((await resolveDestinationAndCheck(reqUrl)) !== null) return;
    // Requirement: filter to relevant product data — never analytics,
    // cart/account/checkout/session, or personalization endpoints, and
    // never record query strings (session tokens live there).
    if (TRACKER_URL.test(reqUrl) || NON_PRODUCT_URL.test(reqUrl)) return;
    const cleanUrl = reqUrl.split('?')[0];
    try {
      const body = await response.body();
      if (body.byteLength > MAX_CAPTURE_BYTES) return;
      if (aggregateBytes + body.byteLength > MAX_AGGREGATE_CAPTURE_BYTES) return;
      const text = body.toString('utf8');
      const json = JSON.parse(text);
      aggregateBytes += body.byteLength;
      responses.push({
        url: cleanUrl,
        status: response.status(),
        responseContentType: headers['content-type'] ?? null,
        jsonBody: redactSensitiveKeys(json),
        timingMs: Date.now() - startedAt,
        contentHash: sha256Hex(text),
      });
    } catch {
      // Unparseable or oversized bodies are not product evidence.
    }
  };
  page.on('response', onResponse);
  return {
    responses,
    stop: () => page.off('response', onResponse),
  };
}

/**
 * Execute ONE bounded deterministic interaction (PI-11 layer 6). Actions are
 * exact-selector or exact-label driven; nothing here decides taxonomy,
 * image rights, or final product identity.
 */
async function performInteraction(
  page: import('playwright').Page,
  action: InteractionAction,
): Promise<{ performed: boolean; finalUrl: string; selectedOptions: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const selectedOptions: string[] = [];
  const settleMs = action.settleMs ?? 1_000;
  try {
    switch (action.type) {
      case 'click_selector': {
        if (!action.selector) {
          warnings.push('click_selector requires a selector');
          break;
        }
        // Exact constraints only: never allow selectors that reach purchase,
        // cart, or submission flows (review PI-11-m5).
        if (/cart|checkout|buy|purchase|submit|pay|place_order/i.test(action.selector)) {
          warnings.push(`selector ${action.selector} refused: purchase/cart selectors are out of scope`);
          break;
        }
        try {
          await page.click(action.selector, { timeout: 5_000 });
          await page.waitForTimeout(settleMs);
        } catch (err) {
          warnings.push(`click failed on ${action.selector}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'select_option': {
        if (!action.selector || !action.optionLabel) {
          warnings.push('select_option requires a selector and optionLabel');
          break;
        }
        try {
          const locator = page.locator(action.selector);
          const labels = await locator.locator('option').allTextContents();
          const values = await locator.locator('option').evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value ?? ''),
          );
          const target = action.optionLabel;
          const index = labels.findIndex(
            (label) => label.trim().toLowerCase() === target.toLowerCase(),
          );
          const valueMatch = values.findIndex((value) => value.toLowerCase() === target.toLowerCase());
          const matchIndex = index >= 0 ? index : valueMatch;
          if (matchIndex >= 0) {
            await locator.selectOption({ label: labels[matchIndex] });
            selectedOptions.push(labels[matchIndex].trim());
          } else {
            warnings.push(`no option matches ${target}`);
          }
          await page.waitForTimeout(settleMs);
        } catch (err) {
          warnings.push(`select failed on ${action.selector}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'open_accordion': {
        if (!action.selector) {
          warnings.push('open_accordion requires a selector');
          break;
        }
        try {
          const isDetails = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (el instanceof HTMLDetailsElement) {
              el.open = true;
              return true;
            }
            return false;
          }, action.selector);
          if (!isDetails) {
            await page.locator(action.selector).first().click({ timeout: 5_000 });
          }
          await page.waitForTimeout(settleMs);
        } catch (err) {
          warnings.push(`accordion open failed on ${action.selector}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }
      case 'dismiss_cookie': {
        // Only act inside a visible cookie/consent banner — never on
        // arbitrary confirm dialogs (review PI-11-m6).
        let bannerVisible = false;
        try {
          bannerVisible = await page
            .locator('[id*="cookie" i], [class*="cookie" i], [class*="consent" i], [class*="gdpr" i], [class*="banner" i]')
            .first()
            .isVisible({ timeout: 1_500 })
            .catch(() => false);
        } catch {
          bannerVisible = false;
        }
        if (!bannerVisible) {
          warnings.push('no cookie banner found; skipping dismissal');
          break;
        }
        let dismissed = false;
        try {
          await page.getByRole('button', { name: /accept|agree|allow/i }).first().click({ timeout: 3_000 });
          dismissed = true;
        } catch {
          // fall through to the next pattern
        }
        if (!dismissed) {
          try {
            await page.getByRole('button', { name: /got it|ok/i }).first().click({ timeout: 3_000 });
            dismissed = true;
          } catch {
            warnings.push('no cookie button found');
          }
        }
        await page.waitForTimeout(settleMs);
        break;
      }
    }
  } catch (err) {
    warnings.push(`interaction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { performed: warnings.length === 0, finalUrl: page.url(), selectedOptions, warnings };
}

/**
 * P0-1: worker-side destination floor for browser/static navigation. The
 * authoritative DNS-based SSRF check lives at the tool boundary (policy
 * gateway); this cheap static check rejects obvious private/link-local and
 * non-http(s) destinations for navigation redirects and captured network
 * responses. Kept self-contained so the worker never imports the gateway.
 */
export function isPrivateOrLinkLocalUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost') return true;
  if (hostname.endsWith('.local')) return true;
  const ip = hostname.replace(/^\[|\]$/g, '');
  return isPrivateOrLinkLocal(ip);
}

/** True when the hostname is a literal IP (v4 dotted or v6). */
function isIpLiteralHostname(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

/**
 * Round-4 P1-4: pure URL rewrite that closes the DNS-rebinding TOCTOU window
 * for http destinations. Given a validated PUBLIC address, rewrite an http
 * URL to the address literal so the connection is pinned to the exact
 * address that was validated (the caller must send a Host header with the
 * original hostname). Returns null when the URL is not pinnable — non-http
 * (TLS SNI prevents https pinning without an outbound proxy), an IP-literal
 * hostname (already pinned), or an empty address.
 */
export function pinHttpDestination(rawUrl: string, address: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (isIpLiteralHostname(parsed.hostname)) return null;
  if (!address) return null;
  const formatted = address.includes(':') ? `[${address}]` : address;
  return `http://${formatted}${parsed.pathname}${parsed.search}`;
}

/**
 * Round-4 P1-4: resolve a hostname to a single PUBLIC address suitable for
 * connection pinning. Returns null (deny) when ANY record is
 * private/link-local/loopback or when resolution fails (fail closed) — a
 * destination that cannot be proven public is never pinned.
 */
export async function resolvePublicAddress(hostname: string): Promise<string | null> {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    return null; // fail closed
  }
  if (records.length === 0) return null;
  if (records.some((record) => isPrivateOrLinkLocalUrl(`http://${record.address}/`))) return null;
  return records[0].address;
}

/**
 * Round-4 P1-4: true when a response URL is an IP-literal form that differs
 * from the logical (hostname-form) destination — i.e. the hop was pinned.
 */
function isPinnedResponseUrl(responseUrl: string, logicalUrl: string): boolean {
  try {
    const respHost = new URL(responseUrl).hostname.toLowerCase();
    const logicalHost = new URL(logicalUrl).hostname.toLowerCase();
    return isIpLiteralHostname(respHost) && respHost !== logicalHost;
  } catch {
    return false;
  }
}

/**
 * P0-1 (round 2): the run's allowed-source-domains apply to navigation
 * (initial + redirect hops) and captured sub-resources. An absent or empty
 * allowlist means the caller did not restrict sources (static floors still
 * apply); a non-empty allowlist requires an exact or subdomain-suffix match
 * (case-insensitive, `www.` normalized).
 */
function isDestinationAllowed(rawUrl: string, sourcesAllowlist: string[] | undefined, hostOverride?: string | null): boolean {
  if (!sourcesAllowlist || sourcesAllowlist.length === 0) return true;
  let hostname: string;
  try {
    // Round-4 P1-4: pinned http connections present an IP-literal URL; the
    // caller supplies the original hostname via the Host header, which is
    // authoritative for allowlist matching in that case.
    hostname = (hostOverride ?? new URL(rawUrl).hostname).toLowerCase();
  } catch {
    return false;
  }
  const normalize = (d: string): string => d.toLowerCase().replace(/^www\./, '');
  return sourcesAllowlist.some((entry) => {
    const normalized = normalize(entry);
    if (normalized.length === 0) return false;
    return hostname === normalized || hostname.endsWith('.' + normalized);
  });
}

/**
 * Round-4 P1-4: for IP-literal URLs (pinned http connections), the allowlist
 * identity comes from the request's Host header; hostname-form URLs use their
 * own hostname. Returns null when the URL is not an IP literal.
 */
function effectiveHostForIpLiteral(rawUrl: string, hostHeader: string | undefined): string | null {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    if (!isIpLiteralHostname(hostname)) return null;
    return hostHeader ? hostHeader.split(':')[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * P0-1 (round 2): DNS-based private-address resolution for navigation. The
 * literal-URL floor cannot see hostnames that resolve to private ranges, so
 * the navigation destination is resolved via the system resolver and denied
 * when ANY address is private/link-local/loopback. Resolution failure does
 * not by itself deny (the literal floor already ran); the authoritative
 * DNS SSRF check remains at the tool-boundary gateway.
 */
/**
 * Round-3 finding 3: shared DNS destination check for navigation (initial +
 * redirect hops) AND intercepted sub-requests/captured responses. Returns a
 * denial reason or null. FAILS CLOSED: a DNS lookup error (NXDOMAIN,
 * timeout, resolver failure) DENIES the destination — an unresolvable
 * hostname is never allowed to proceed on the assumption it might be public.
 * Literal IPs are handled by the literal floor (isPrivateOrLinkLocalUrl) and
 * skip DNS.
 */
export async function resolveDestinationAndCheck(rawUrl: string): Promise<string | null> {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null; // unparseable/non-http — the literal floor already rejects it
  }
  const isIpLiteral = isIpLiteralHostname(hostname);
  if (isIpLiteral) return null;
  try {
    const records = await lookup(hostname, { all: true });
    if (records.some((record) => isPrivateOrLinkLocalUrl(`http://${record.address}/`))) {
      return `Blocked destination resolving to a private address: ${rawUrl}`;
    }
    return null;
  } catch {
    return `Blocked destination: DNS resolution failed for ${hostname} (fail closed): ${rawUrl}`;
  }
}

async function isNavigationBlocked(rawUrl: string, sourcesAllowlist: string[] | undefined): Promise<string | null> {
  if (isPrivateOrLinkLocalUrl(rawUrl)) {
    return `Blocked private/link-local destination: ${rawUrl}`;
  }
  if (!isDestinationAllowed(rawUrl, sourcesAllowlist)) {
    return `Blocked destination outside allowed source domains: ${rawUrl}`;
  }
  const dnsBlocked = await resolveDestinationAndCheck(rawUrl);
  if (dnsBlocked) return dnsBlocked;
  return null;
}

/**
 * Round-4 P1-4: fetch one logical http(s) destination with the connection
 * PINNED for http. The http URL is rewritten to the validated public IP
 * literal and the original hostname is sent as the Host header, so the
 * connection is made to the exact address that passed validation — a
 * rebinding hostname cannot answer public at validation time and private at
 * connection time. https URLs cannot be pinned (TLS SNI requires the real
 * hostname) and are fetched as-is after their caller-side validation;
 * returns { pinned: true } only for pinned http fetches.
 *
 * Throws when an http hostname cannot be proven public (fail closed — the
 * caller treats it as a blocked destination).
 */
async function fetchPinned(
  logicalUrl: string,
  timeoutMs: number,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {},
): Promise<{ response: Response; pinned: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(logicalUrl);
  } catch {
    return { response: await fetch(logicalUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }), pinned: false };
  }
  const headers: Record<string, string> = { ...HTTP_EXTRACTION_HEADERS, ...(init.headers ?? {}) };
  let fetchUrl = logicalUrl;
  let pinned = false;
  if (parsed.protocol === 'http:' && !isIpLiteralHostname(parsed.hostname)) {
    const address = await resolvePublicAddress(parsed.hostname);
    if (address === null) {
      throw new Error(`Cannot pin ${logicalUrl} to a validated public address`);
    }
    const pinnedUrl = pinHttpDestination(logicalUrl, address);
    if (pinnedUrl) {
      fetchUrl = pinnedUrl;
      headers.Host = parsed.hostname;
      pinned = true;
    }
  }
  const response = await fetch(fetchUrl, {
    method: init.method ?? 'GET',
    headers,
    body: init.body ?? undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  return { response, pinned };
}

/**
 * Round-5 P1-3: close the DNS-rebinding TOCTOU for HTTP BROWSER SUBREQUESTS.
 * Top-level navigation is already pinned (round-4); subrequests (XHR/fetch/
 * scripts/subresources) previously did a DNS preflight and then
 * route.continue(), letting Chromium open its own connection/resolution. This
 * helper fetches an http subrequest through the PINNED transport (validated
 * IP literal + Host header) so no browser-side connection is ever made to the
 * destination. Returns null when the request is NOT pinnable (https — TLS SNI
 * requires the real hostname — or an IP-literal host); the caller keeps
 * route.continue() for those, with the existing preflight checks. Throws when
 * the destination cannot be proven public or the fetch fails (fail closed —
 * the caller aborts the route).
 */
export async function fulfillPinnedSubrequest(
  requestInfo: {
    url: string;
    method?: string | null;
    headers?: Record<string, string> | null;
    body?: Buffer | string | null;
  },
  deps: {
    resolveFn?: (hostname: string) => Promise<string | null>;
    fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    /** Per-response stream cap (defaults to MAX_SUBREQUEST_RESPONSE_BYTES). */
    maxResponseBytes?: number;
    /** Request-body cap (defaults to MAX_SUBREQUEST_BODY_BYTES). */
    maxBodyBytes?: number;
    /** Shared per-snapshot aggregate counter (defaults to no aggregate cap). */
    budget?: SubrequestBudgetState;
    /** Aggregate cap across the shared budget (defaults to MAX_AGGREGATE_SUBREQUEST_BYTES). */
    maxAggregateBytes?: number;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | null> {
  const timeoutMs = deps.timeoutMs ?? HTTP_FETCH_TIMEOUT_MS;
  const resolveFn = deps.resolveFn ?? resolvePublicAddress;
  const fetchFn = deps.fetchFn ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const maxResponseBytes = deps.maxResponseBytes ?? MAX_SUBREQUEST_RESPONSE_BYTES;
  const maxBodyBytes = deps.maxBodyBytes ?? MAX_SUBREQUEST_BODY_BYTES;
  const maxAggregateBytes = deps.maxAggregateBytes ?? MAX_AGGREGATE_SUBREQUEST_BYTES;
  let parsed: URL;
  try {
    parsed = new URL(requestInfo.url);
  } catch {
    throw new Error(`Cannot pin invalid subrequest URL: ${requestInfo.url}`);
  }
  if (parsed.protocol !== 'http:' || isIpLiteralHostname(parsed.hostname)) {
    // https cannot be pinned (TLS SNI needs the real hostname) — the caller
    // keeps the preflight + route.continue() path (documented residual).
    // IP-literal hosts are already address-bound; nothing to pin.
    return null;
  }
  const address = await resolveFn(parsed.hostname);
  if (address === null) {
    throw new Error(`Subrequest destination ${parsed.hostname} cannot be proven public (fail closed)`);
  }
  const pinnedUrl = pinHttpDestination(requestInfo.url, address);
  if (pinnedUrl === null) {
    throw new Error(`Subrequest ${requestInfo.url} could not be pinned to ${address}`);
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestInfo.headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection' || lower === 'accept-encoding') continue;
    headers[key] = value;
  }
  headers.Host = parsed.hostname;
  const body = requestInfo.body ? (Buffer.isBuffer(requestInfo.body) ? requestInfo.body : Buffer.from(String(requestInfo.body))) : undefined;
  // Round-6 P1-4: cap the request body BEFORE any network call — an oversized
  // page request is denied without the transport (or even the resolver) being
  // touched.
  if (body && body.length > maxBodyBytes) {
    throw new Error(`subrequest body exceeds ${maxBodyBytes} bytes (${body.length})`);
  }
  const response = await fetchFn(pinnedUrl, {
    method: requestInfo.method ?? 'GET',
    headers,
    // Uint8Array is a clean BodyInit (TS libs don't accept Buffer<TArrayBuffer>).
    body: body && body.length > 0 ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const responseBody = await readBoundedBody(response, maxResponseBytes);
  // Round-6 P1-4: aggregate per-snapshot budget — the response was already
  // read (single-response cap bounds that), but the page never receives it
  // once the aggregate cap trips.
  if (deps.budget && deps.budget.bytes + responseBody.length > maxAggregateBytes) {
    throw new Error(`aggregate subrequest budget exceeded (${deps.budget.bytes + responseBody.length} > ${maxAggregateBytes})`);
  }
  if (deps.budget) deps.budget.bytes += responseBody.length;
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') return;
    responseHeaders[key] = value;
  });
  return { status: response.status, headers: responseHeaders, body: responseBody };
}

async function doStaticSnapshot(
  url: string,
  captureScreenshot: boolean,
  captureNetwork: boolean,
  domain: string,
  jobId: string,
  sourcesAllowlist?: string[],
): Promise<SnapshotResponse> {
  const warnings: string[] = [];
  const artifactDir = resolveArtifactDir(domain, jobId);


  // Fetch — P0-1: private/link-local destinations and destinations outside
  // the run's allowed source domains are denied up front, redirects are
  // followed manually with every hop re-checked (allowlist + DNS), so a
  // public start URL cannot tunnel navigation to a private destination.
  // Round-4 P1-4: every http hop is additionally PINNED to the validated
  // public address (see fetchPinned) so a rebinding hostname cannot answer
  // public at validation time and private at connection time. Redirects are
  // resolved against the LOGICAL (hostname-form) URL so every hop re-enters
  // the full validation loop.
  let response: Response | undefined;
  let html: string;
  // Logical (hostname-form) destination: updated per redirect hop; the
  // initial value is read by the blocked-first-hop early return.
  let currentUrl = url;
  try {
    let redirects = 0;
    for (;;) {
      const blocked = await isNavigationBlocked(currentUrl, sourcesAllowlist);
      if (blocked) {
        warnings.push(blocked);
        return buildSnapshotResponse({
          url,
          finalUrl: currentUrl,
          htmlRef: null,
          screenshotRef: null,
          jsonLd: [],
          embeddedProductData: [],
          imageCandidates: [],
          pageStructureSignals: [],
          warnings,
          networkResponses: [],
          interaction: null,
          networkRef: null,
        });
      }
      const hopResult = await fetchPinned(currentUrl, HTTP_FETCH_TIMEOUT_MS);
      const hop = hopResult.response;
      if (hop.status >= 300 && hop.status < 400) {
        const location = hop.headers.get('location');
        if (!location) {
          warnings.push(`Redirect without Location at ${currentUrl}`);
          break;
        }
        redirects += 1;
        if (redirects > 5) {
          warnings.push(`Too many redirects from ${url}`);
          break;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      response = hop;
      break;
    }
    if (!response) {
      warnings.push(`Static fetch failed: no response after redirect handling`);
      return buildSnapshotResponse({
        url,
        finalUrl: currentUrl,
        htmlRef: null,
        screenshotRef: null,
        jsonLd: [],
        embeddedProductData: [],
        imageCandidates: [],
        pageStructureSignals: [],
        warnings,
        networkResponses: [],
        interaction: null,
        networkRef: null,
      });
    }
    if (!response.ok) {
      warnings.push(`HTTP fetch returned ${response.status} ${response.statusText}`);
    }
    html = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Static fetch failed: ${msg}`);
    return buildSnapshotResponse({
      url,
      finalUrl: url,
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings,
      networkResponses: [],
      interaction: null,
      networkRef: null,
    });
  }

  // Round-4 P1-4: when the fetch was pinned, response.url is the IP-literal
  // form — report the logical (hostname-form) destination as the final URL.
  const finalUrl = isPinnedResponseUrl(response.url, currentUrl) ? currentUrl : response.url || url;

  // Write raw HTML artifact
  const htmlRef = writeArtifact(artifactDir, 'page.html', html);

  // Extraction phases
  const jsonLd = extractJsonLdFromHtml(html);
  const embeddedProductData = extractEmbeddedProductDataFromHtml(html);

  // Resolve image URLs against base
  const baseUrl = finalUrl;
  const rawImageCandidates = extractImageCandidatesFromHtml(html);
  const imageCandidates = rawImageCandidates.map(src => {
    try {
      return new URL(src, baseUrl).href;
    } catch {
      return src;
    }
  }).filter(src => src.startsWith('http'));

  const pageStructureSignals = extractPageStructureSignalsFromHtml(html);

  // Build minified HTML artifact
  const minified = stripNonContentTags(html);
  writeArtifact(artifactDir, 'page.min.html', minified);

  // Static mode cannot capture screenshots or network
  const screenshotRef: string | null = null;
  if (captureScreenshot) {
    warnings.push('Screenshot capture requires rendered runtime, skipping');
  }
  if (captureNetwork) {
    warnings.push('Network capture requires rendered runtime, skipping');
  }

  return buildSnapshotResponse({
    url,
    finalUrl,
    htmlRef,
    screenshotRef,
    jsonLd,
    embeddedProductData,
    imageCandidates,
    pageStructureSignals,
    warnings,
    networkResponses: [],
    interaction: null,
    networkRef: null,
  });
}

async function doRenderedSnapshot(
  url: string,
  captureScreenshot: boolean,
  captureNetwork: boolean,
  interaction: InteractionAction | null,
  domain: string,
  jobId: string,
  sourcesAllowlist?: string[],
): Promise<SnapshotResponse> {
  const warnings: string[] = [];
  const artifactDir = resolveArtifactDir(domain, jobId);


  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to launch Playwright: ${msg}`);
    return buildSnapshotResponse({
      url,
      finalUrl: url,
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings,
      networkResponses: [],
      interaction: null,
      networkRef: null,
    });
  }

  let finalUrl = url;
  let htmlRef: string | null = null;
  let screenshotRef: string | null = null;
  let networkRef: string | null = null;
  let jsonLd: Record<string, unknown>[] = [];
  let embeddedProductData: Record<string, unknown>[] = [];
  let imageCandidates: string[] = [];
  let pageStructureSignals: string[] = [];
  let interactionResult: SnapshotResponse['interaction'] = null;
  let networkCapture: { responses: CapturedNetworkResponse[]; stop: () => void } | null = null;
  // Round-6 P1-4: aggregate bytes fulfilled across this snapshot's pinned
  // http subrequests — shared with fulfillPinnedSubrequest so the budget
  // spans the whole snapshot (and aborts the route on overflow).
  const subrequestBudget: SubrequestBudgetState = { bytes: 0 };

  try {
    const context = await browser.newContext({
      userAgent: HTTP_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Block resource types (types inlined below).
    await page.route('**/*', async (route) => {
      const req = route.request();
      const type = req.resourceType();
      const reqUrl = req.url();
      const isTracker =
        /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(reqUrl);

      // P0-1: abort navigation/sub-resources to private or link-local
      // destinations and to hosts outside the run's allowed source domains
      // (defense in depth on top of the tool-boundary gateway check; redirect
      // hops and sub-requests are covered here too). Round-3: DNS resolution
      // applies to intercepts as well, and lookup failure fails closed.
      // Round-4 P1-4: pinned http connections present IP-literal URLs — the
      // allowlist identity comes from the Host header in that case.
      if (isPrivateOrLinkLocalUrl(reqUrl)) {
        await route.abort();
        return;
      }
      if (!isDestinationAllowed(reqUrl, sourcesAllowlist, effectiveHostForIpLiteral(reqUrl, req.headers()['host']))) {
        await route.abort();
        return;
      }
      if ((await resolveDestinationAndCheck(reqUrl)) !== null) {
        await route.abort();
        return;
      }

      if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet' || isTracker) {
        await route.abort();
        return;
      }
      // Round-5 P1-3: http SUBREQUESTS ride the PINNED transport (validated
      // IP literal + Host header) instead of route.continue() — Chromium never
      // opens its own connection to the destination, so the DNS-rebinding
      // TOCTOU is closed for intercepted http requests. https keeps
      // route.continue() with the preflight checks above (TLS SNI makes
      // pinning impossible — documented residual at resolveDestinationAndCheck).
      try {
        const fulfill = await fulfillPinnedSubrequest({
          url: reqUrl,
          method: req.method(),
          headers: req.headers(),
          body: req.postDataBuffer(),
        }, { budget: subrequestBudget });
        if (fulfill === null) {
          await route.continue();
        } else {
          // The fulfilled response passes through the capture onResponse path
          // (Playwright dispatches a response event) with the original logical
          // URL, so product evidence filtering keeps working.
          await route.fulfill(fulfill);
        }
      } catch (error) {
        warnings.push(`blocked subrequest ${reqUrl}: ${error instanceof Error ? error.message : String(error)}`);
        await route.abort();
      }
    });

    // PI-11: capture product-relevant network responses during navigation.
    if (captureNetwork) {
      networkCapture = await installNetworkCapture(page, sourcesAllowlist);
    }

    // Navigate — P0-1: deny private/link-local destinations, destinations
    // outside the allowed source domains, and hostnames that resolve to
    // private addresses before the browser touches them (the route handler
    // above also aborts them).
    const blocked = await isNavigationBlocked(url, sourcesAllowlist);
    if (blocked) {
      warnings.push(blocked);
    } else {
      try {
        // Round-4 P1-4: for http destinations, PIN the navigation to the
        // validated public address (IP-literal URL + Host header) so a
        // rebinding hostname cannot answer public at validation time and
        // private at connection time. https destinations cannot be pinned
        // (TLS SNI requires the real hostname) — they rely on the
        // re-validation above immediately before goto plus the per-request
        // route checks; the residual TOCTOU window for https is documented
        // at resolveDestinationAndCheck.
        let gotoUrl = url;
        let gotoHeaders: Record<string, string> | undefined;
        let pinnedNavigation = false;
        let allowGoto = true;
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' && !isIpLiteralHostname(parsed.hostname)) {
          const address = await resolvePublicAddress(parsed.hostname);
          if (address === null) {
            warnings.push(`Navigation denied: ${url} cannot be pinned to a validated public address`);
            allowGoto = false;
          } else {
            const pinned = pinHttpDestination(url, address);
            if (pinned) {
              gotoUrl = pinned;
              gotoHeaders = { Host: parsed.hostname };
              pinnedNavigation = true;
            }
          }
        }
        if (allowGoto) {
          if (gotoHeaders) {
            // Playwright applies Host via page-level extra headers; the
            // pinned connection then presents the original hostname.
            await page.setExtraHTTPHeaders(gotoHeaders);
          }
          await page.goto(gotoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: RENDERED_TIMEOUT_MS,
          });
          // Report the logical (hostname-form) destination, not the pinned
          // IP-literal URL, as the canonical final URL.
          finalUrl = pinnedNavigation ? url : page.url();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Navigation failed: ${msg}`);
      }
    }

    // Dwell for dynamic content
    await page.waitForTimeout(RENDERED_DWELL_MS);

    // PI-11: one bounded deterministic interaction before re-capture.
    if (interaction) {
      const result = await performInteraction(page, interaction);
      interactionResult = {
        action: interaction,
        performed: result.performed,
        finalUrl: result.finalUrl,
        selectedOptions: result.selectedOptions,
        warnings: result.warnings,
      };
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings.map((w) => `interaction: ${w}`));
      }
      if (result.finalUrl) {
        finalUrl = result.finalUrl;
      }
    }

    // Capture full-page HTML (post-interaction when an interaction ran)
    try {
      const html = await page.content();
      htmlRef = writeArtifact(artifactDir, 'page.html', html);

      // Write minified HTML
      const minified = stripNonContentTags(html);
      writeArtifact(artifactDir, 'page.min.html', minified);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to capture page HTML: ${msg}`);
    }

    // Capture screenshot
    if (captureScreenshot) {
      try {
        const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
        screenshotRef = writeArtifact(artifactDir, 'screenshot.png', screenshotBuffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Screenshot capture failed: ${msg}`);
      }
    }

    // Extraction phases — all via page.evaluate
    try {
      jsonLd = await extractJsonLdFromPage(page);
    } catch (err) {
      warnings.push(`JSON-LD extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      embeddedProductData = await extractEmbeddedProductDataFromPage(page);
    } catch (err) {
      warnings.push(`Embedded product data extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      imageCandidates = await extractImageCandidatesFromPage(page, finalUrl);
    } catch (err) {
      warnings.push(`Image candidate extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      pageStructureSignals = await extractPageStructureSignalsFromPage(page);
    } catch (err) {
      warnings.push(`Page structure signal extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // PI-11: stop capture, write the combined payload artifact, and map the
    // schema-safe subset (timing/hash stay in the artifact file only).
    if (networkCapture) {
      networkCapture.stop();
      if (networkCapture.responses.length > 0) {
        networkRef = writeArtifact(
          artifactDir,
          'network.json',
          JSON.stringify(networkCapture.responses),
        );
      } else {
        warnings.push('Network capture requested but no product-relevant JSON responses observed');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Rendered snapshot error: ${msg}`);
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore close errors
    }
  }

  const networkResponses: NetworkCaptureArtifact[] = networkCapture
    ? networkCapture.responses.map((r) => ({
        url: r.url,
        status: r.status,
        responseContentType: r.responseContentType,
        jsonBody: r.jsonBody,
      }))
    : [];

  return buildSnapshotResponse({
    url,
    finalUrl,
    htmlRef,
    screenshotRef,
    jsonLd,
    embeddedProductData,
    imageCandidates,
    pageStructureSignals,
    warnings,
    networkResponses,
    interaction: interactionResult,
    networkRef,
  });
}

// ─── Response builder ──────────────────────────────────────────────────────────

interface SnapshotInput {
  url: string;
  finalUrl: string;
  htmlRef: string | null;
  screenshotRef: string | null;
  jsonLd: Record<string, unknown>[];
  embeddedProductData: Record<string, unknown>[];
  imageCandidates: string[];
  pageStructureSignals: string[];
  warnings: string[];
  networkResponses: NetworkCaptureArtifact[];
  interaction: SnapshotResponse['interaction'];
  networkRef: string | null;
}

function buildSnapshotResponse(input: SnapshotInput): SnapshotResponse {
  // Deduplicate warnings
  const warnings = [...new Set(input.warnings)];

  // Parse through Zod to ensure schema compliance
  const parsed = SnapshotResponseSchema.parse({
    url: input.url,
    finalUrl: input.finalUrl,
    htmlRef: input.htmlRef,
    screenshotRef: input.screenshotRef,
    jsonLd: input.jsonLd,
    embeddedProductData: input.embeddedProductData,
    imageCandidates: input.imageCandidates,
    pageStructureSignals: input.pageStructureSignals,
    warnings,
    networkResponses: input.networkResponses,
    interaction: input.interaction,
    networkRef: input.networkRef,
  });

  return parsed;
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /profile-tooling/snapshot
 *
 * Parses the JSON body, dispatches to the appropriate runtime, and
 * responds with a validated SnapshotResponse.
 */
export function handleSnapshot(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = SnapshotRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map(p => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data;
      const domain = extractDomainFromUrl(request.url);
      const jobId = generateJobId();

      let result: SnapshotResponse;

      if (request.runtime === 'static') {
        result = await doStaticSnapshot(
          request.url,
          request.captureScreenshot,
          request.captureNetwork ?? false,
          domain,
          jobId,
          request.sourcesAllowlist,
        );
      } else {
        result = await doRenderedSnapshot(
          request.url,
          request.captureScreenshot,
          request.captureNetwork ?? false,
          request.interaction ?? null,
          domain,
          jobId,
          request.sourcesAllowlist,
        );
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
    
      // Build a minimal valid response
      const fallback = SnapshotResponseSchema.parse({
        url: '',
        finalUrl: '',
        htmlRef: null,
        screenshotRef: null,
        jsonLd: [],
        embeddedProductData: [],
        imageCandidates: [],
        pageStructureSignals: [],
        warnings: [`Internal error: ${msg}`],
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });

  req.on('error', (err: Error) => {
    const fallback = SnapshotResponseSchema.parse({
      url: '',
      finalUrl: '',
      htmlRef: null,
      screenshotRef: null,
      jsonLd: [],
      embeddedProductData: [],
      imageCandidates: [],
      pageStructureSignals: [],
      warnings: [`Request error: ${err.message}`],
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
  });
}
