/**
 * Shared image source collection, URL canonicalization, and deduping
 * helpers used by both the production page extractor and the profile
 * governance validation pipeline.
 *
 * Extracted from `page-extractor.ts` to eliminate the divergence
 * between what production extraction returns and what governance
 * validation previews show.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

// ─── srcset parsing ────────────────────────────────────────────────────────

/**
 * Parse a `srcset` attribute string into an array of URL-only tokens
 * (stripping descriptors like `165w`, `2x`).
 */
// fallow-ignore-next-line unused-export
export function parseSrcsetCandidates(
  srcset: string | null | undefined,
): string[] {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map(s => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// ─── source filtering ──────────────────────────────────────────────────────

/**
 * Returns `true` when a source URL is usable as a product image —
 * non-empty, not a data URI, and not an SVG.
 */
/** @expected-unused */
export function isUsableImageSource(
  src: string | null | undefined,
): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('data:')) return false;
  if (lower.split(/[?#]/)[0].endsWith('.svg')) return false;
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return false;
  return true;
}

// ─── Cheerio element image collection ──────────────────────────────────────

/**
 * Collect all usable image source URLs from a Cheerio element.
 *
 * - If the element IS an `<img>` or `<source>`, reads its attributes
 *   directly.
 * - Otherwise, finds the first descendant `<img>` or `<source>`.
 *
 * Reads these attributes:
 *   `src`, `data-src`, `data-lazy-src`, `data-original`,
 *   `data-image`, `data-zoom-image`
 * Plus srcset-style:
 *   `srcset`, `data-srcset`
 */
export function collectImageSourcesFromElement(
  $: cheerio.CheerioAPI,
  el: Element | any,
): string[] {
  const sources: string[] = [];
  const $el = $(el);
  const $targets = $el.is('img,source')
    ? $el
    : $el.find('img,source');
  if ($targets.length === 0) return sources;

  $targets.each((_, t) => {
    const $t = $(t);
    const directAttrs = [
      'src',
      'data-src',
      'data-lazy-src',
      'data-original',
      'data-image',
      'data-zoom-image',
    ];
    for (const attr of directAttrs) {
      const value = $t.attr(attr);
      if (isUsableImageSource(value)) sources.push(value!.trim());
    }

    for (const attr of ['srcset', 'data-srcset']) {
      for (const candidate of parseSrcsetCandidates($t.attr(attr))) {
        if (isUsableImageSource(candidate)) sources.push(candidate.trim());
      }
    }
  });

  return sources;
}

// ─── dedup helper ──────────────────────────────────────────────────────────

/**
 * Add a source URL to an image list iff it is usable and has not
 * been seen before (exact URL match). Mutates both `seen` and `images`.
 */
export function addImageSource(
  src: string,
  seen: Set<string>,
  images: string[],
): void {
  if (!isUsableImageSource(src)) return;
  const trimmed = src.trim();
  if (seen.has(trimmed)) return;
  seen.add(trimmed);
  images.push(trimmed);
}

// ─── URL canonicalization ──────────────────────────────────────────────────

/**
 * Strip Shopify-style size suffixes from image pathnames to derive a
 * canonical key for deduplication.
 *
 * Handles: `_80x80`, `_150x150_crop_center`, `_small`, `_thumb`,
 * `_medium`, `_large`, `_icon`, `_grande`, `_compact` and numeric
 * variants like `_800x`.
 *
 * The optional crop-position suffix is constrained to known Shopify
 * transformation qualifiers (e.g. `_crop_center`, `_crop_top_left`)
 * via `(?:_crop_[a-z_]+)?`.  A previously permissive pattern
 * `(?:_[a-z0-9-_]+)?` matched gallery image indices (`_1`, `_2`,
 * `_1-Lavender_…`) after size-like patterns in uploaded filenames,
 * collapsing distinct gallery photos into a single canonical key.
 */
export function canonicalizeUrl(
  urlStr: string,
  baseUrl?: string,
): string {
  try {
    let canonical = urlStr.trim();
    if (canonical.startsWith('//')) {
      canonical = 'https:' + canonical;
    }
    const parsedUrl = baseUrl
      ? new URL(canonical, baseUrl)
      : new URL(canonical);
    parsedUrl.search = '';
    let pathname = parsedUrl.pathname;

    // BigCommerce CDN: /products/{productId}/{imageId}/ or UUID
    if (parsedUrl.host.includes('bigcommerce.com') || pathname.includes('/images/stencil/')) {
      const bcMatch = pathname.match(/\/products\/(\d+)\/(\d+)/i);
      if (bcMatch) {
        return `${parsedUrl.host}/products/${bcMatch[1]}/${bcMatch[2]}`;
      }
      const uuidMatch = pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        return `${parsedUrl.host}/${uuidMatch[1]}`;
      }
    }

    // BigCommerce stencil dimensions: /images/stencil/{dimensions}/ -> /images/stencil/
    pathname = pathname.replace(/\/images\/stencil\/(?:\d+x\d+|original)\//i, '/images/stencil/');
    pathname = pathname.replace(
      /_(?:[0-9]+x[0-9]*|[0-9]*x[0-9]+|small|thumb|medium|large|icon|grande|compact)(?:_crop_[a-z_]+)?(?=\.[a-z0-9]+$)/i,
      '',
    );
    return parsedUrl.host + pathname;
  } catch {
    return urlStr;
  }
}

// ─── canonical dedup + normalization ───────────────────────────────────────

/**
 * Deduplicate a set of image URLs by canonical host + pathname (size
 * suffixes stripped). For Shopify CDN URLs the output is normalized
 * to `width=1200` while preserving the `v` cache-busting parameter.
 * For BigCommerce stencil URLs the output is normalized to `1280x1280`.
 *
 * The first-accepted URL per canonical group wins. Callers that need
 * a "highest resolution wins" policy should pre-sort `urls` before
 * calling this function.
 */
export function cleanAndDeduplicateImages(
  urls: string[],
  baseUrl?: string,
): string[] {
  const seenCanonical = new Set<string>();
  const bestUrls: string[] = [];

  for (const urlStr of urls) {
    if (!urlStr || typeof urlStr !== 'string') continue;
    let canonical = urlStr.trim();
    if (!canonical || canonical.toLowerCase().startsWith('data:')) continue;
    if (!isUsableImageSource(canonical)) continue;

    if (canonical.startsWith('//')) {
      canonical = 'https:' + canonical;
    }

    try {
      const canonicalKey = canonicalizeUrl(canonical, baseUrl);
      if (!seenCanonical.has(canonicalKey)) {
        seenCanonical.add(canonicalKey);

        let targetUrl = urlStr.trim();
        if (targetUrl.startsWith('//')) {
          targetUrl = 'https:' + targetUrl;
        }

        const originalUrlObj = baseUrl
          ? new URL(targetUrl, baseUrl)
          : new URL(targetUrl);
        targetUrl = originalUrlObj.href;
        const isShopify =
          originalUrlObj.hostname.includes('shopify.com') ||
          originalUrlObj.pathname.includes('/cdn/shop/');
        if (isShopify) {
          const vParam = originalUrlObj.searchParams.get('v');
          originalUrlObj.search = '';
          if (vParam) {
            originalUrlObj.searchParams.set('v', vParam);
          }
          originalUrlObj.searchParams.set('width', '1200');
          targetUrl = originalUrlObj.href;
        }

        const isBigCommerce = originalUrlObj.pathname.includes('/images/stencil/');
        if (isBigCommerce) {
          targetUrl = targetUrl.replace(/\/images\/stencil\/(?:\d+x\d+|original)\//i, '/images/stencil/1280x1280/');
        }

        bestUrls.push(targetUrl);
      }
    } catch {
      if (urlStr.trim().startsWith('http')) {
        bestUrls.push(urlStr.trim());
      }
    }
  }

  return bestUrls;
}
