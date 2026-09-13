/**
 * Validate route — POST /profile-tooling/validate
 *
 * Runs a proposed or approved domain extractor profile across a set of sample
 * URLs and returns per-sample field validation results.
 *
 * This is VALIDATION EVIDENCE only — it does NOT decide Profile Health.
 * The Bun server owns profile health decisions.
 *
 * Supports two runtimes from profileDraft.runtime:
 *   - **static**:  Plain HTTP fetch + Cheerio-based CSS selector evaluation (no browser).
 *   - **rendered**: Headless Playwright Chromium with JS execution for selector extraction.
 *
 * Artifact files are written under:
 *   <cwd>/.baystate-cms/artifacts/profile-builder/<domain>/<job-id>/
 *
 * Errors are surfaced in per-sample results; never throws uncaught errors.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import {
  ValidateRequestSchema,
  ValidateResponseSchema,
  type ValidateRequest,
  type ValidateResponse,
  type ValidationSampleResult,
  type VariantSelectionStrategy,
} from '../../shared/schemas/extraction-worker';
import { resolveArtifactDir, writeArtifact, generateJobId, extractDomainFromUrl } from '../artifacts';
import { isPrivateOrLinkLocalHost } from '../../shared/ssrf';
import {
  cleanAndDeduplicateImages,
  collectImageSourcesFromElement,
} from '../../onboarding/image-utils';

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

// ─── HTML text extraction by CSS selector ──────────────────────────────────────

/**
 * Evaluate a CSS selector against HTML using Cheerio and extract text content
 * from the first matched element. Handles compound selectors, custom elements,
 * combinators, and pseudo-classes that the old regex approach could not.
 * Returns null for zero matches or invalid/unparseable CSS.
 */
// fallow-ignore-next-line unused-export — used by tests
export function evaluateSelectorText(html: string, selector: string): string | null {
  const sel = selector?.trim();
  if (!sel) return null;
  try {
    const $ = cheerio.load(html);
    const els = $(sel);
    if (els.length === 0) return null;
    const text = $(els[0]).text().replace(/\s+/g, ' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Evaluate a CSS selector against HTML using Cheerio and collect usable image
 * source URLs from matched elements and their descendant `<img>` elements.
 * Returns an empty array for zero matches, invalid CSS, or no images found.
 */
// fallow-ignore-next-line unused-export — used by tests
export function evaluateSelectorImageUrls(
  html: string,
  selector: string,
  baseUrl?: string,
): string[] {
  const sel = selector?.trim();
  if (!sel) return [];
  try {
    const $ = cheerio.load(html);
    const rawUrls: string[] = [];
    $(sel).each((_idx, el) => {
      rawUrls.push(...collectImageSourcesFromElement($, el));
    });

    // Extraction Preview canonicalizes responsive src/srcset variants by
    // host + pathname before presenting images. Use the same normalization
    // here so validation reports product images, not every responsive width.
    return cleanAndDeduplicateImages(rawUrls, baseUrl);
  } catch {
    return [];
  }
}

// ─── Image URL extraction helpers ──────────────────────────────────────────────

/**
 * Returns true if the image source URL is likely a usable (non-SVG, non-data) image.
 */
function isUsableImageUrl(src: string): boolean {
  const trimmed = src.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return false;
  if (trimmed.startsWith('blob:')) return false;
  const path = trimmed.split(/[?#]/)[0];
  if (path.endsWith('.svg')) return false;
  return true;
}

/**
 * Extract all usable image source URLs from an HTML string.
 */
function extractAllImageSources(html: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  const imgRegex = /<img[\s\S]*?>/gi;
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const getAttr = (name: string): string | null => {
      const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
      const m = tag.match(re);
      return m ? m[1] : null;
    };

    for (const raw of [getAttr('src'), getAttr('data-src'), getAttr('data-original'), getAttr('data-lazy-src')]) {
      if (raw && isUsableImageUrl(raw) && !seen.has(raw)) {
        seen.add(raw);
        urls.push(raw);
      }
    }

    // Parse srcset
    const srcset = getAttr('srcset') || getAttr('data-srcset');
    if (srcset) {
      for (const part of srcset.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url && isUsableImageUrl(url) && !seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      }
    }
  }

  return urls;
}

// ─── Word overlap scoring ──────────────────────────────────────────────────────

/**
 * Compute the fraction of words from `expected` that appear in `extracted`.
 * Words are lowercased, stripped of non-alphanumeric characters, and split on whitespace.
 */
function computeWordOverlap(extracted: string, expected: string): number {
  const tokenize = (s: string): Set<string> => {
    return new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(Boolean),
    );
  };

  const extractedTokens = tokenize(extracted);
  const expectedTokens = tokenize(expected);

  if (expectedTokens.size === 0) return 1; // empty expected → trivially matching

  let overlap = 0;
  for (const token of extractedTokens) {
    if (expectedTokens.has(token)) overlap++;
  }

  return overlap / expectedTokens.size;
}

// ─── Per-sample field validation ───────────────────────────────────────────────

interface SampleValidationInput {
  sampleUrl: string;
  confirmed: boolean;
  expectedName?: string;
  upc?: string;
  spreadsheetHints: Record<string, string>;
  html: string;
  baseUrl: string;
  selectors: Record<string, string | null>;
  imageRules: Record<string, unknown>;
  variantSelectionStrategy: VariantSelectionStrategy | null;
}

/**
 * Apply selectors against the page HTML and score each field result.
 */
function validateSample(input: SampleValidationInput): ValidationSampleResult {
  const {
    sampleUrl,
    confirmed,
    expectedName,
    html,
    baseUrl,
    selectors,
    imageRules,
    variantSelectionStrategy,
  } = input;

  const fieldResults: Record<
    string,
    { status: 'pass' | 'warning' | 'fail'; extractedValue: string | null; warnings: string[] }
  > = {};

  // ── Process each selector ───────────────────────────────────────────────
  for (const [fieldName, selector] of Object.entries(selectors)) {
    if (!selector) {
      fieldResults[fieldName] = {
        status: 'fail',
        extractedValue: null,
        warnings: ['Selector is null or empty'],
      };
      continue;
    }

    try {
      // ── Images field: evaluate selector for image sources ────────────
      const isImages =
        fieldName === 'imagesSelector' ||
        fieldName === 'images' ||
        fieldName === 'imageSelector' ||
        fieldName === 'image';

      if (isImages) {
        const imageUrls = evaluateSelectorImageUrls(html, selector, baseUrl);
        const warnings: string[] = [];
        if (imageUrls.length === 0) {
          warnings.push(`Selector "${selector}" matched no images`);
        }
        fieldResults[fieldName] = {
          status: warnings.length > 0 ? 'fail' : 'pass',
          extractedValue: `${imageUrls.length} images found`,
          warnings,
        };
        continue;
      }

      // ── Text field: evaluate selector for text content ─────────────
      const extracted = evaluateSelectorText(html, selector);

      if (!extracted) {
        fieldResults[fieldName] = {
          status: 'fail',
          extractedValue: null,
          warnings: [`Selector "${selector}" matched no elements`],
        };
        continue;
      }

      const warnings: string[] = [];

      // ── Title field: word-overlap check ──────────────────────────────
      const isTitle =
        fieldName === 'titleSelector' ||
        fieldName === 'title' ||
        fieldName === 'nameSelector' ||
        fieldName === 'name';

      if (isTitle && expectedName) {
        const overlap = computeWordOverlap(extracted, expectedName);
        if (overlap <= 0.15) {
          warnings.push(
            `Word overlap with expected name is ${(overlap * 100).toFixed(0)}% (threshold: 15%)`,
          );
        }
      }

      // ── Price field: check numeric content ────────────────────────────
      const isPrice =
        fieldName === 'priceSelector' ||
        fieldName === 'price';

      if (isPrice) {
        const hasNumericPrice = /\d+\.?\d*/.test(extracted);
        if (!hasNumericPrice) {
          warnings.push('Extracted price does not contain numeric value');
        }
      }

      // ── Default text field ──────────────────────────────────────────
      const truncatedValue =
        extracted.length > 500
          ? extracted.substring(0, 500) + '...'
          : extracted;

      fieldResults[fieldName] = {
        status: warnings.length > 0 ? 'warning' : 'pass',
        extractedValue: truncatedValue,
        warnings,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fieldResults[fieldName] = {
        status: 'fail',
        extractedValue: null,
        warnings: [`Selector extraction error: ${msg}`],
      };
    }
  }

  // ── Image validation ────────────────────────────────────────────────────
  let candidateCount = 0;
  let primaryImageMatch = false;
  const imageWarnings: string[] = [];

  try {
    const allImages = extractAllImageSources(html);
    const nonSvgImages = allImages.filter((url) => {
      const path = url.split(/[?#]/)[0].toLowerCase();
      return !path.endsWith('.svg');
    });

    candidateCount = nonSvgImages.length;
    primaryImageMatch = candidateCount > 0;

    if (imageRules && Object.keys(imageRules).length > 0 && candidateCount === 0) {
      imageWarnings.push('No non-SVG image candidates found for image rules');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    imageWarnings.push(`Image validation error: ${msg}`);
  }

  // ── Variant validation ──────────────────────────────────────────────────
  let variantResult: {
    selected: boolean;
    variantTitle: string | null;
    error: string | null;
    containerSelector: string | null;
    optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown' | null;
    detectedOptions: string[];
    optionFields: string[];
    strategyValid: boolean;
  } | null;

  if (!variantSelectionStrategy || !variantSelectionStrategy.containerSelector) {
    variantResult = null;
  } else {
    const containerEl = evaluateSelectorText(html, variantSelectionStrategy.containerSelector);
    const containerFound = containerEl !== null && containerEl !== '';
    const hasOptions = variantSelectionStrategy.detectedOptions.length > 0;
    const strategyValid = containerFound && hasOptions;

    variantResult = {
      selected: strategyValid,
      variantTitle: null,
      error: strategyValid ? null : containerFound ? 'Strategy has no detected options' : 'containerSelector did not resolve on sample page',
      containerSelector: variantSelectionStrategy.containerSelector,
      optionType: variantSelectionStrategy.optionType ?? 'unknown',
      detectedOptions: variantSelectionStrategy.detectedOptions ?? [],
      optionFields: variantSelectionStrategy.optionFields ?? [],
      strategyValid,
    };
  }

  return {
    sampleUrl,
    confirmed,
    fieldResults,
    imageResults: {
      primaryImageMatch,
      candidateCount,
      warnings: imageWarnings,
    },
    variantResult,
  };
}

// ─── Sanitize URL for use as a file-name segment ──────────────────────────────

function sanitizeUrlSegment(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 120);
}

function sanitizeUrlForError(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/[^@]+@/, '//[REDACTED]@');
  }
}

// ─── Static sample fetch ───────────────────────────────────────────────────────

async function validateSampleStatic(
  sample: {
    url: string;
    confirmed: boolean;
    expectedName?: string;
    upc?: string;
    spreadsheetHints: Record<string, string>;
  },
  selectors: Record<string, string | null>,
  imageRules: Record<string, unknown>,
  variantSelectionStrategy: VariantSelectionStrategy | null,
  domain: string,
  jobId: string,
): Promise<ValidationSampleResult> {
  const artifactDir = resolveArtifactDir(domain, jobId);

  process.stderr.write(`[validate] static fetch: ${sample.url}\n`);

  let html = '';
  try {
    let currentFetchUrl = sample.url;
    let response: Response | null = null;

    for (let hop = 0; hop < 5; hop++) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(currentFetchUrl);
      } catch {
        throw new Error(`Invalid URL: ${sanitizeUrlForError(currentFetchUrl)}`);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Unsupported protocol ${parsedUrl.protocol}`);
      }
      if (parsedUrl.username || parsedUrl.password) {
        throw new Error('URL contains credentials');
      }
      const host = parsedUrl.hostname.replace(/^\[|\]$/g, '').trim();
      if (await isPrivateOrLinkLocalHost(host)) {
        throw new Error(`SSRF blocked: URL points to a private or link-local address ${host}`);
      }

      response = await fetch(currentFetchUrl, {
        headers: HTTP_EXTRACTION_HEADERS,
        signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect missing location header on ${sanitizeUrlForError(currentFetchUrl)}`);
        try {
          currentFetchUrl = new URL(location, currentFetchUrl).toString();
          continue;
        } catch {
          throw new Error(`Invalid redirect target URL ${location}`);
        }
      }
      break;
    }

    if (response && response.status >= 300 && response.status < 400) {
      throw new Error('Too many redirects (max 5)');
    }

    if (!response || !response.ok) {
      process.stderr.write(
        `[validate] HTTP ${response?.status ?? 'error'} for ${sample.url}\n`,
      );
    }
    if (response && response.ok) {
      html = await response.text();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[validate] static fetch failed for ${sample.url}: ${msg}\n`);

    return {
      sampleUrl: sample.url,
      confirmed: sample.confirmed,
      fieldResults: {},
      imageResults: {
        primaryImageMatch: false,
        candidateCount: 0,
        warnings: [`Static fetch error: ${msg}`],
      },
      variantResult: null,
    };
  }

  // Write per-sample HTML artifact
  if (html) {
    try {
      writeArtifact(artifactDir, `sample-${sanitizeUrlSegment(sample.url)}.html`, html);
    } catch (err) {
      process.stderr.write(
        `[validate] failed to write HTML artifact for ${sample.url}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return validateSample({
    sampleUrl: sample.url,
    confirmed: sample.confirmed,
    expectedName: sample.expectedName,
    upc: sample.upc,
    spreadsheetHints: sample.spreadsheetHints,
    html,
    baseUrl: sample.url,
    selectors,
    imageRules,
    variantSelectionStrategy,
  });
}

// ─── Rendered sample fetch (Playwright) ────────────────────────────────────────

async function validateSampleRendered(
  sample: {
    url: string;
    confirmed: boolean;
    expectedName?: string;
    upc?: string;
    spreadsheetHints: Record<string, string>;
  },
  selectors: Record<string, string | null>,
  imageRules: Record<string, unknown>,
  variantSelectionStrategy: VariantSelectionStrategy | null,
  domain: string,
  jobId: string,
): Promise<ValidationSampleResult> {
  const artifactDir = resolveArtifactDir(domain, jobId);

  process.stderr.write(`[validate] rendered fetch: ${sample.url}\n`);

  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(sample.url);
    } catch {
      throw new Error(`Invalid URL: ${sample.url}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Unsupported protocol ${parsedUrl.protocol}`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error('URL contains credentials');
    }
    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '').trim();
    if (await isPrivateOrLinkLocalHost(host)) {
      throw new Error(`SSRF blocked: URL points to a private or link-local address ${host}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[validate] rendered fetch blocked for ${sample.url}: ${msg}\n`);

    return {
      sampleUrl: sample.url,
      confirmed: sample.confirmed,
      fieldResults: {},
      imageResults: {
        primaryImageMatch: false,
        candidateCount: 0,
        warnings: [`Rendered fetch error: ${msg}`],
      },
      variantResult: null,
    };
  }

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
    process.stderr.write(`[validate] failed to launch Playwright: ${msg}\n`);

    return {
      sampleUrl: sample.url,
      confirmed: sample.confirmed,
      fieldResults: {},
      imageResults: {
        primaryImageMatch: false,
        candidateCount: 0,
        warnings: [`Failed to launch Playwright: ${msg}`],
      },
      variantResult: null,
    };
  }

  let html = '';

  try {
    const context = await browser.newContext({
      userAgent: HTTP_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Block resource types and enforce SSRF check on every request (including redirects)
    await page.route('**/*', async (route) => {
      const req = route.request();
      const reqUrl = req.url();

      try {
        const parsedReqUrl = new URL(reqUrl);
        if (parsedReqUrl.protocol !== 'http:' && parsedReqUrl.protocol !== 'https:') {
          await route.abort();
          return;
        }
        if (parsedReqUrl.username || parsedReqUrl.password) {
          await route.abort();
          return;
        }
        const reqHost = parsedReqUrl.hostname.replace(/^\[|\]$/g, '').trim();
        if (await isPrivateOrLinkLocalHost(reqHost)) {
          await route.abort();
          return;
        }
      } catch {
        await route.abort();
        return;
      }

      const type = req.resourceType();
      const isTracker =
        /analytics|google-analytics|doubleclick|facebook|hotjar|klaviyo|pixel/i.test(reqUrl);

      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media' ||
        type === 'stylesheet' ||
        isTracker
      ) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // Navigate
    try {
      await page.goto(sample.url, {
        waitUntil: 'domcontentloaded',
        timeout: RENDERED_TIMEOUT_MS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[validate] navigation failed for ${sample.url}: ${msg}\n`);
    }

    // Dwell for dynamic content
    await page.waitForTimeout(RENDERED_DWELL_MS);

    // Capture page HTML
    try {
      html = await page.content();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[validate] failed to capture HTML for ${sample.url}: ${msg}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[validate] rendered sample error for ${sample.url}: ${msg}\n`);
  } finally {
    try {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // ignore close errors
    }
  }

  // Write per-sample HTML artifact
  if (html) {
    try {
      writeArtifact(artifactDir, `sample-${sanitizeUrlSegment(sample.url)}.html`, html);
    } catch (err) {
      process.stderr.write(
        `[validate] failed to write HTML artifact for ${sample.url}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return validateSample({
    sampleUrl: sample.url,
    confirmed: sample.confirmed,
    expectedName: sample.expectedName,
    upc: sample.upc,
    spreadsheetHints: sample.spreadsheetHints,
    html: html || '',
    baseUrl: sample.url,
    selectors,
    imageRules,
    variantSelectionStrategy,
  });
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /profile-tooling/validate
 *
 * Parses the JSON body, validates each sample against the profile draft,
 * and returns per-sample validation results with a summary.
 */
export function handleValidate(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = ValidateRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data as ValidateRequest;
      const { profileDraft, samples } = request;
      const domain =
        profileDraft.domain || extractDomainFromUrl(samples[0].url);
      const jobId = generateJobId();
      const isRendered = profileDraft.runtime === 'rendered';

      // Validate each sample sequentially
      const results: ValidationSampleResult[] = [];
      for (const sample of samples) {
        const sampleInput = {
          url: sample.url,
          confirmed: sample.confirmed,
          expectedName: sample.expectedName,
          upc: sample.upc,
          spreadsheetHints: sample.spreadsheetHints as Record<string, string>,
        };

        const result = isRendered
          ? await validateSampleRendered(
              sampleInput,
              profileDraft.selectors,
              profileDraft.imageRules,
              profileDraft.variantSelectionStrategy,
              domain,
              jobId,
            )
          : await validateSampleStatic(
              sampleInput,
              profileDraft.selectors,
              profileDraft.imageRules,
              profileDraft.variantSelectionStrategy,
              domain,
              jobId,
            );

        results.push(result);
      }

      // ── Compute summary ─────────────────────────────────────────────
      const sampleCount = results.length;
      const confirmedSampleCount = results.filter((r) => r.confirmed).length;
      const passingSamples = results.filter((r) => {
        const fields = Object.values(r.fieldResults);
        return fields.length > 0 && fields.every((f) => f.status !== 'fail');
      }).length;
      const failingSamples = results.filter((r) => {
        const fields = Object.values(r.fieldResults);
        return fields.some((f) => f.status === 'fail');
      }).length;
      const variantSamplesPassing = results.filter((r) => {
        if (!r.variantResult) return true; // no variant strategy → trivially passing
        return r.variantResult.strategyValid !== false;
      }).length;

      const response: ValidateResponse = {
        summary: {
          sampleCount,
          confirmedSampleCount,
          passingSamples,
          failingSamples,
          variantSamplesPassing,
        },
        results,
      };

      // Validate output through Zod
      const parsedResponse = ValidateResponseSchema.parse(response);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(parsedResponse));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[validate] Uncaught error: ${msg}\n`);

      const fallback = ValidateResponseSchema.parse({
        summary: {
          sampleCount: 0,
          confirmedSampleCount: 0,
          passingSamples: 0,
          failingSamples: 0,
          variantSamplesPassing: 0,
        },
        results: [],
      });

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });

  req.on('error', (err: Error) => {
    process.stderr.write(`[validate] Request error: ${err.message}\n`);
    const fallback = ValidateResponseSchema.parse({
      summary: {
        sampleCount: 0,
        confirmedSampleCount: 0,
        passingSamples: 0,
        failingSamples: 0,
        variantSamplesPassing: 0,
      },
      results: [],
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fallback));
  });
}

// ─── Exports for testing ────────────────────────────────────────────────────────

