/**
 * LLM-assisted CSS selector profile generation for the onboarding page
 * extractor.
 *
 * Goals:
 * - Generate candidate CSS selectors from a product page's minimized DOM.
 * - Ask the active LLM to pick the best selector for each product field.
 * - Validate the proposed selectors against the same page (and optionally
 *   the expected product name) before they are ever considered for
 *   promotion into `extractor_profiles`.
 *
 * Safety:
 * - The whole feature is opt-in via the `BAYSTATE_CMS_PROFILE_GENERATION_ENABLED`
 *   environment variable. When disabled, no LLM calls are made and
 *   `generateExtractorProfile` returns `null`.
 * - Validation rejects empty titles and text that the extraction-validator
 *   considers blocked/offline/mismatched.
 * - `readyForReview` is only `true` when confidence is high and no
 *   low-stability selectors were used. It is an ADVISORY signal that
 *   the proposal is ready for an operator to review. Promotion to
 *   `extractor_profiles` always requires explicit per-field human
 *   approval via `promoteGeneratedProfile`. Auto-promotion is
 *   forbidden.
 *
 * Companion audit table: `profile_generations` (see Phase 1). This module
 * itself does NOT write to `extractor_profiles`; promotion is handled by
 * a separate caller (Phase 3) so that the safety gate stays explicit.
 */

import * as cheerio from 'cheerio';
import { extractProductJsonFromHtml } from './shopify-json';
import type { Element } from 'domhandler';
import { getLlmConfig, callLlm, callLlmForTask, getLlmConfigForTask, MissingLlmTaskConfigError, type LlmConfig } from './llm-client';
import { redactTransportText } from '../classification/model-policy-gateway';
import {
  buildStableSelector,
  isLikelyGeneratedId,
  isSupportedSelectorSyntax,
  classSet,
  attrSelector,
  snippetOf,
  STABLE_DATA_ATTRS,
  SEMANTIC_HINT_SUBSTRINGS,
  type Stability,
} from '../shared/selector-utils';
import { validateExtraction, type ValidationResult } from './extraction-validator';
import { collectImageSourcesFromElement, cleanAndDeduplicateImages, addImageSource } from './image-utils';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A set of CSS selectors proposed by the LLM for a single product page.
 * All fields are optional except `titleSelector` (required at validation
 * time). The LLM may return `null` for fields it is not confident about.
 */
export interface GeneratedSelectorProfile {
  titleSelector: string | null;
  /**
   * Additional CSS selectors whose text content gets appended to the title
   * with a " — " separator. Used when the product name is split across
   * multiple elements (e.g. an h1 + a subheading div).
   */
  titleOptionalSelectors?: string[];
  descriptionSelector: string | null;
  brandSelector: string | null;
  imagesSelector: string | null;
  sitemapProductUrlPattern?: string | null;
  shopifyJSONPath: boolean;
  /** Custom field selectors (user-defined via visual picker), keyed by field name. */
  customSelectors?: Record<string, string>;
  /** Proposed variant/option selection strategy. The LLM suggests how to
   *  select the correct source-page variant for the product SKU. */
  variantSelectionStrategy?: {
    containerSelector: string | null;
    optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
    detectedOptions: string[];
    optionFields: string[];
  } | null;
}

export interface SeedPreview {
  title: string | null;
  description: string | null;
  images: string[];
  variantOptions: string[];
  strategy: 'shopify-json' | 'css';
  variantSelectionStrategy: GeneratedSelectorProfile['variantSelectionStrategy'];
}

/**
 * A single candidate element discovered in the minimized DOM. The
 * `stability` field tells callers how likely this selector is to keep
 * working across page revisions and other product pages on the same
 * domain.
 */
export interface SelectorCandidate {
  selector: string;
  tag: string;
  attributes: Record<string, string>;
  textSnippet: string;
  nearbyLabels: string[];
  kindHints: string[];
  stability: 'high' | 'medium' | 'low';
}

/**
 * Validation result for a proposed `GeneratedSelectorProfile`. The
 * caller (Phase 3 integration) decides whether to keep the result in
 * memory, re-run extraction, or insert an audit row.
 */
export interface GeneratedProfileValidation {
  valid: boolean;
  confidence: number;
  status: 'ok' | 'rejected' | 'failed';
  reason: string | null;
  fieldSamples: Record<string, string>;
  selectors: GeneratedSelectorProfile;
  /**
   * Advisory signal that the proposal has enough evidence to be
   * reviewed by a human operator. Set to `true` when confidence is
   * high and no low-stability selectors were used. It does NOT permit
   * automatic application; promotion always requires explicit
   * per-field human approval via `promoteGeneratedProfile`.
   */
  readyForReview: boolean;
}

/** Minimal expected context for validation. */
export interface GeneratorExpectedContext {
  name?: string | null;
  brandHint?: string | null;
  domain?: string | null;
  sourceUrl?: string | null;
}

// ─── Feature flag ───────────────────────────────────────────────────────────

const TRUTHY_VALUES = new Set(['true', '1', 'yes']);

/**
 * Returns `true`. Profile generation is on by default.
 *
 * During extraction (page-extractor.ts), the system may trigger
 * `maybeCreateGeneratedProfileProposal` to propose selector profiles
 * when extraction data is available. The on-demand route in
 * `onboarding-routes.ts` also calls this to gate access.
 *
 * The env var `BAYSTATE_CMS_PROFILE_GENERATION_ENABLED` can be set
 * to `false`, `0`, or `no` to disable; anything truthy or omitted
 * enables it.
 */
export function isProfileGenerationEnabled(): boolean {
  const raw = process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
  if (!raw) return true;
  return TRUTHY_VALUES.has(raw.trim().toLowerCase());
}

// ─── DOM minimization (Task 7) ──────────────────────────────────────────────

const NOISY_TAGS = [
  'style',
  'svg',
  'iframe',
  'noscript',
  'template',
  'header',
  'footer',
  'nav',
  'aside',
  'form',
  'button',
  'input',
  'select',
  'textarea',
];

/** Script-content substrings that indicate a product-relevant script. */
const PRODUCT_SCRIPT_KEYWORDS = [
  'productJSON',
  'ShopifyAnalytics',
  'Shopify.theme',
  'window.Shopify',
  '"variants"',
  '"product"',
];
const PRICE_LIKE_FIELD = /(?:price|cost|sale)/i;

function removePagePriceFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) removePagePriceFields(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (PRICE_LIKE_FIELD.test(key)) {
      delete record[key];
    } else {
      removePagePriceFields(record[key]);
    }
  }
}

function removePriceMarkedElements($: cheerio.CheerioAPI): void {
  $('*').each((_, el) => {
    const attributes = (el as Element).attribs ?? {};
    const hasPriceMarker = Object.entries(attributes).some(([name, value]) =>
      PRICE_LIKE_FIELD.test(name) ||
      (/^(class|id|itemprop|property|name|data-testid|aria-label)$/i.test(name) && PRICE_LIKE_FIELD.test(value)),
    );
    if (hasPriceMarker) $(el).remove();
  });
}

function sanitizeJsonLd(content: string): string | null {
  try {
    const value: unknown = JSON.parse(content);
    removePagePriceFields(value);
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}


/** Hard cap on the minimized HTML returned to the LLM. */
const MAX_MINIMIZED_BYTES = 200_000;

/** Cap for the DOM payload sent to the LLM during proposal generation. */
const MAX_LLM_DOM_BYTES = 60_000;

/**
 * Strip noisy HTML and price-bearing data before sending a product page to
 * the LLM. Price fields, price-labeled DOM elements, and unparseable
 * price-bearing scripts are omitted.
 *
 * The output is taken from `<main>`, the first `.product`/`.pdp`/etc.
 * container, or `<body>` as a fallback.
 */
export function getMinimizedDom(html: string): string {
  if (!html || typeof html !== 'string') return '';
  const $ = cheerio.load(html);

  // Drop noisy tags entirely (children are discarded; these don't carry
  // product content we care about).
  for (const tag of NOISY_TAGS) {
    $(tag).remove();
  }
  removePriceMarkedElements($);

  // Strip scripts from the original DOM and append only sanitized product
  // data so a raw page script cannot carry a third-party price to the LLM.
  const keptScripts: string[] = [];
  $('script').each((_, el) => {
    const node = $(el);
    const type = (node.attr('type') ?? '').toLowerCase();
    const content = node.html() ?? '';
    if (type === 'application/ld+json') {
      const safeContent = sanitizeJsonLd(content);
      if (safeContent !== null) {
        keptScripts.push(`<script type="application/ld+json">${safeContent}</script>`);
      }
      node.remove();
      return;
    }
    if (PRODUCT_SCRIPT_KEYWORDS.some((kw) => content.includes(kw))) {
      const product = extractProductJsonFromHtml(content);
      if (product) {
        keptScripts.push(`<script>window.productJSON = ${JSON.stringify(product)};</script>`);
      } else if (!PRICE_LIKE_FIELD.test(content)) {
        keptScripts.push(`<script>${content}</script>`);
      }
    }
    node.remove();
  });

  // Try to scope to the most product-relevant container.
  let scopeHtml: string | null = null;
  const productScopeSelectors = [
    'main',
    '[itemtype*="Product"]',
    '.product',
    '.product-detail',
    '.pdp',
    '.product-page',
    '#product',
    '#product-detail',
    '.product-single',
    '.product-gallery',
    '.media-gallery',
    '[class*="product-single"]',
    '[class*="product__media"]',
    '[class*="media-gallery"]',
    '.product-media',
    '.product__wrapper',
  ];
  for (const sel of productScopeSelectors) {
    const found = $(sel).first();
    if (found.length > 0) {
      const html = found.html();
      if (html) {
        scopeHtml = html;
        break;
      }
    }
  }
  if (scopeHtml === null) {
    const body = $('body').first();
    scopeHtml = body.length > 0 ? (body.html() ?? '') : ($.html() ?? '');
  }

  let minimized = scopeHtml;
  if (keptScripts.length > 0) {
    minimized += '\n' + keptScripts.join('\n');
  }

  // Trim blank/whitespace runs to keep tokens compact.
  minimized = minimized.replace(/\s+/g, ' ').trim();

  if (minimized.length > MAX_MINIMIZED_BYTES) {
    minimized = minimized.slice(0, MAX_MINIMIZED_BYTES) + '<!--truncated-->';
  }

  return minimized;
}

// ─── Selector candidate generation (Task 8) ────────────────────────────────

const CANDIDATE_LIMIT = 100;


/** Find label-like text near the element (preceding siblings, parent labels). */
function nearbyLabelsOf(
  $: cheerio.CheerioAPI,
  el: Element,
): string[] {
  const labels: string[] = [];
  const node = $(el);

  // Closest label ancestor or sibling label.
  const closestLabel = node.closest('label');
  if (closestLabel.length > 0) {
    const txt = closestLabel.text().replace(/\s+/g, ' ').trim();
    if (txt) labels.push(txt.slice(0, 80));
  }

  // Preceding sibling text.
  const prev = node.prev();
  if (prev.length > 0) {
    const txt = prev.text().replace(/\s+/g, ' ').trim();
    if (txt && txt.length < 80) labels.push(txt);
  }

  // Preceding element in the same parent.
  const parent = node.parent();
  if (parent.length > 0) {
    const siblings = parent.children();
    const idx = siblings.index(el);
    if (idx > 0) {
      const prevSibling = siblings.get(idx - 1);
      if (prevSibling) {
        const txt = $(prevSibling).text().replace(/\s+/g, ' ').trim();
        if (txt && txt.length < 80) labels.push(txt);
      }
    }
  }

  return labels.slice(0, 3);
}


/** Decide which "kind" hints apply to an element. */
function kindHintsFor(
  $: cheerio.CheerioAPI,
  el: Element,
  text: string,
  classAndIdLower: string,
): string[] {
  const hints: string[] = [];
  const tag = ((el as { name?: string }).name ?? '').toLowerCase();
  if (tag === 'h1' || tag === 'h2') hints.push('title');
  if (text.length > 0 && text.length < 200) hints.push('text');
  if (tag === 'img') hints.push('image');
  if (tag === 'meta') hints.push('meta');

  const itemprop = $(el).attr('itemprop');
  if (itemprop === 'name') hints.push('title');
  if (itemprop === 'description') hints.push('description');
  if (itemprop === 'brand') hints.push('brand');
  if (itemprop === 'image') hints.push('image');

  for (const [kind, substrings] of Object.entries(SEMANTIC_HINT_SUBSTRINGS)) {
    if (kind === 'price') continue;
    if (substrings.some((sub) => classAndIdLower.includes(sub.toLowerCase()))) {
      hints.push(kind);
    }
  }

  return [...new Set(hints)];
}

/** Build the SelectorCandidate list for a given minimized HTML body. */
// fallow-ignore-next-line unused-export
export function buildSelectorCandidates(html: string, baseUrl?: string): SelectorCandidate[] {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);

  const seenSelectors = new Set<string>();
  const candidates: SelectorCandidate[] = [];

  function addCandidate(
    el: Element,
    forcedHints: string[] = [],
  ): void {
    if (candidates.length >= CANDIDATE_LIMIT) return;
    const { selector, stability } = buildStableSelector($, el);
    if (seenSelectors.has(selector)) return;
    seenSelectors.add(selector);

    const node = $(el);
    const tag = ((el as { name?: string }).name ?? 'div').toLowerCase();
    const attributes: Record<string, string> = {};
    const rawAttribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const [k, v] of Object.entries(rawAttribs)) {
      if (v === undefined) continue;
      attributes[k] = String(v);
    }
    const text = snippetOf($, el);
    const classAndIdLower = (
      (attributes.class ?? '') +
      ' ' +
      (attributes.id ?? '')
    ).toLowerCase();
    const hints = kindHintsFor($, el, text, classAndIdLower);
    if (forcedHints.length > 0) {
      for (const h of forcedHints) {
        if (!hints.includes(h)) hints.push(h);
      }
    }
    const nearbyLabels = nearbyLabelsOf($, el);

    candidates.push({
      selector,
      tag,
      attributes,
      textSnippet: text,
      nearbyLabels,
      kindHints: hints,
      stability,
    });
  }

  // Title candidates.
  $('h1, h2, [itemprop="name"]').each((_, el) => addCandidate(el, ['title']));
  $('[data-testid*="title" i], [data-test*="title" i]').each((_, el) =>
    addCandidate(el, ['title']),
  );
  $('[class*="title" i], [id*="title" i]').each((_, el) =>
    addCandidate(el, ['title']),
  );
  $('[class*="product-name" i], [class*="product-title" i]').each((_, el) =>
    addCandidate(el, ['title']),
  );

  // Description candidates.
  $('[itemprop="description"]').each((_, el) =>
    addCandidate(el, ['description']),
  );
  $('[class*="description" i], [id*="description" i]').each((_, el) =>
    addCandidate(el, ['description']),
  );
  $('[class*="product-info" i], [class*="details" i]').each((_, el) =>
    addCandidate(el, ['description']),
  );

  // Image candidates.
  $('img[itemprop="image"], [class*="product-image" i] img, [class*="gallery" i] img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('img[data-media-gallery], [data-product-media], [data-gallery-role]').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('[class*="product__media"] img, [class*="pdp-gallery"] img, [class*="swiper-wrapper"] img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('img[data-zoom], img[data-zoom-image], [data-gallery-wrapper] img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('[class*="pdp-carousel"] img, [class*="product-carousel"] img, [class*="media-gallery"] img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('[data-slider] img, [role="tabpanel"] img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('[class*="product-single"] img, [class*="product__media"] img, .media-gallery img, .product-gallery img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('img[data-media-id], .slick-slide img, .product__slides img, .product__media-item img, .swiper-slide img').each(
    (_, el) => addCandidate(el, ['image']),
  );
  $('[class*="product-media"] img, .product-single__thumbnail img, [class*="thumbnail"] img').each(
    (_, el) => addCandidate(el, ['image']),
  );

  return candidates.slice(0, CANDIDATE_LIMIT);
}

/**
 * Variant/option candidate discovered in the original HTML (not the
 * minimized DOM, because NOISY_TAGS strips select/button/input).
 */
export interface VariantOptionCandidate {
  containerSelector: string;
  optionType: 'dropdown' | 'button_group' | 'radio' | 'unknown';
  detectedOptions: string[];
  optionFields: string[];
  stability: 'high' | 'medium' | 'low';
}

const VARIANT_CANDIDATE_LIMIT = 20;

function buildVariantOptionCandidates(html: string, baseUrl?: string): VariantOptionCandidate[] {
  const $ = cheerio.load(html);
  const candidates: VariantOptionCandidate[] = [];
  const seenContainers = new Set<string>();

  function addVariantCandidate(
    containerEl: Element,
    optionType: VariantOptionCandidate['optionType'],
    labels: string[],
    fields: string[],
  ): void {
    if (candidates.length >= VARIANT_CANDIDATE_LIMIT) return;
    const { selector, stability } = buildStableSelector($, containerEl);
    if (seenContainers.has(selector)) return;
    seenContainers.add(selector);
    candidates.push({
      containerSelector: selector,
      optionType,
      detectedOptions: labels.slice(0, 12),
      optionFields: fields.slice(0, 4),
      stability,
    });
  }

  // Helper to infer option fields from class/id/nearby text
  function inferOptionFields(text: string): string[] {
    const lower = text.toLowerCase();
    const fields: string[] = [];
    if (/size|dimension|length/i.test(lower)) fields.push('size');
    if (/color|colour|swatch/i.test(lower)) fields.push('color');
    if (/flavour|flavor|taste|variety/i.test(lower)) fields.push('flavor');
    if (/style|material|pattern|scent|fragrance|bundle|theme|design/i.test(lower)) fields.push('style');
    return fields;
  }

  // 1. <select> dropdowns
  $('select').each((_, el) => {
    const $el = $(el);
    const options: string[] = [];
    $el.find('option').each((_, opt) => {
      const text = $(opt).text().trim();
      if (text && !/choose|select|please|size|option/i.test(text)) {
        options.push(text);
      }
    });
    // Skip the first option if it looks like a placeholder
    if (options.length >= 2) {
      const containerText = ($el.attr('class') || '') + ' ' + ($el.attr('id') || '') + ' ' + ($el.closest('[class*="option"i], [class*="variant"i], [class*="swatch"i], [class*="size"i], [class*="color"i]').length > 0 ? 'variant-option' : '');
      addVariantCandidate(el, 'dropdown', options, inferOptionFields(containerText));
    }
  });

  // 2. Button groups inside variant containers
  $('[class*="option"i] button, [class*="variant"i] button, [class*="swatch"i] button, [class*="size"i] button, [class*="color"i] button, [role="radiogroup"][class*="option"i] button, [role="radiogroup"][class*="variant"i] button').each((_, el) => {
    const $parent = $(el).parent();
    const parentEl = $parent.get(0) as Element | undefined;
    if (!parentEl) return;
    const { selector: parentSel } = buildStableSelector($, parentEl);
    if (seenContainers.has(parentSel)) return;
    const buttons = $parent.find('button, [role="button"]');
    if (buttons.length >= 2) {
      const labels: string[] = [];
      buttons.each((_, btn) => {
        const text = $(btn).text().trim() || $(btn).attr('aria-label') || $(btn).attr('value') || '';
        if (text) labels.push(text);
      });
      if (labels.length >= 2) {
        const containerText = ($parent.attr('class') || '') + ' ' + ($parent.attr('id') || '');
        addVariantCandidate(parentEl, 'button_group', labels, inferOptionFields(containerText));
      }
    }
  });

  // 3. Radio groups
  $('input[type="radio"]').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name) return;
    const $radios = $(`input[type="radio"][name="${name}"]`);
    if ($radios.length < 2) return;
    const $container = $el.closest('fieldset, div[class*="option"i], div[class*="variant"i], div[class*="swatch"i]');
    if ($container.length === 0) return;
    const containerEl = $container.get(0) as Element | undefined;
    if (!containerEl) return;
    const { selector: containerSel } = buildStableSelector($, containerEl);
    if (seenContainers.has(containerSel)) return;
    const labels: string[] = [];
    $radios.each((_, r) => {
      const label = $(r).closest('label').text().trim() || $(r).attr('aria-label') || '';
      if (label) labels.push(label);
    });
    if (labels.length >= 2) {
      const containerText = ($container.attr('class') || '') + ' ' + ($container.attr('id') || '');
      addVariantCandidate(containerEl, 'radio', labels, inferOptionFields(containerText));
    }
  });

  // 4. Data-attribute driven widgets
  $('[data-variant], [data-option], [data-swatch]').each((_, el) => {
    const $el = $(el);
    const $container = $el.closest('div[class*="option"i], div[class*="variant"i], div[class*="swatch"i], [class*="selector"i]');
    const containerEl: Element = $container.length > 0 ? $container.get(0) as Element : el;
    const { selector: containerSel } = buildStableSelector($, containerEl);
    if (seenContainers.has(containerSel)) return;
    const labels: string[] = [];
    $(containerEl).find('button, [role="button"], [data-value], [data-label]').each((_, child) => {
      const text = $(child).text().trim() || $(child).attr('data-value') || $(child).attr('data-label') || '';
      if (text && !labels.includes(text)) labels.push(text);
    });
    if (labels.length >= 2) {
      addVariantCandidate(containerEl, 'button_group', labels, []);
    }
  });

  // 5. Container-class driven
  $('[class*="product-option"i], [class*="variant-selector"i], [class*="option-selector"i], [class*="swatch-container"i], [class*="product-form__controls"i], [class*="product-options"i]').each((_, el) => {
    const { selector: containerSel } = buildStableSelector($, el);
    if (seenContainers.has(containerSel)) return;
    const $el = $(el);
    const labels: string[] = [];
    $el.find('button, [role="button"], a[href*="variant"]').each((_, child) => {
      const text = $(child).text().trim() || $(child).attr('aria-label') || '';
      if (text && !labels.includes(text)) labels.push(text);
    });
    // Also look for labels
    if (labels.length === 0) {
      $el.find('label').each((_, child) => {
        const text = $(child).text().trim();
        if (text) labels.push(text);
      });
    }
    if (labels.length >= 2) {
      const containerText = ($el.attr('class') || '') + ' ' + ($el.attr('id') || '');
      addVariantCandidate(el, 'button_group', labels, inferOptionFields(containerText));
    }
  });

  return candidates;
}

// ─── LLM integration (Task 9) ──────────────────────────────────────────────

// Page price selectors are never generated; the onboarding input is the only price authority.
const SELECTOR_PROFILE_KEYS = [
  'titleSelector',
  'descriptionSelector',
  'brandSelector',
  'imagesSelector',
  'shopifyJSONPath',
] as const;

/** Strip common markdown code fences around a JSON response. */
function stripCodeFences(raw: string): string {
  let text = raw.trim();
  // Remove leading fence like ```json or ```.
  const fenceMatch = text.match(/^```(?:json|JSON)?\s*\n?/);
  if (fenceMatch) {
    text = text.slice(fenceMatch[0].length);
  }
  // Remove trailing fence.
  if (text.endsWith('```')) {
    text = text.slice(0, -3).trim();
  }
  return text;
}



/**
 * Build the user prompt for the LLM. The prompt asks the model to
 * choose selectors from the candidate list rather than inventing new
 * ones — this dramatically improves selector stability and reduces
 * prompt-injection risk.
 */
function buildLlmPrompt(
  candidates: SelectorCandidate[],
  variantCandidates: VariantOptionCandidate[],
  minimizedDom: string,
  expected?: GeneratorExpectedContext,
): string {
  const expectedBlock = expected
    ? `\nExpected product (for context only — do not invent selectors for it):\n- Name: ${expected.name}\n- Brand: ${expected.brandHint ?? 'Unknown'}\n- Source URL: ${expected.sourceUrl ?? 'Unknown'}\n`
    : '';

  // Compress candidates to a compact representation.
  const compact = candidates.slice(0, 80).map((c, i) => {
    const attrs = Object.entries(c.attributes)
      .filter(([k]) => !k.startsWith('on') && k !== 'style')
      .map(([k, v]) => `${k}=${v.length > 40 ? v.slice(0, 40) + '…' : v}`)
      .join(' ');
    return `[${i}] <${c.tag}> ${c.selector} | stability=${c.stability} | hints=${c.kindHints.join(',')} | attrs: ${attrs.slice(0, 120)} | text: ${c.textSnippet.replace(/\n/g, ' ').slice(0, 80)}`;
  });

  // Variant candidates block
  let variantBlock = '';
  if (variantCandidates.length > 0) {
    const compact = variantCandidates.slice(0, 15).map((c, i) => {
      return `[${i}] ${c.containerSelector} | ${c.optionType} | ${c.optionFields.join(', ')} | ${c.detectedOptions.join(', ')}`;
    });
    variantBlock = `\nVARIANT/OPTION CANDIDATES (containerSelector — optionType — optionFields — detectedOptions):\n${compact.join('\n')}\n`;
  }

  const prompt = `You are a CSS selector expert. Write the best CSS selector for each product field for the product page below. The candidate list is provided as HINTS only — you MAY write a selector that is NOT in the candidate list when you can see a more stable or more accurate one in the minimized DOM. Prefer stable, semantic selectors (data-testid, itemprop, semantic class names) over positional pseudo-selectors (nth-of-type).${expectedBlock}

MINIMIZED PRODUCT DOM (HTML):
${minimizedDom}

SELECTOR CANDIDATES (index — tag — selector — hints — text) — hints only, not a constraint:
${compact.join('\n')}
${variantBlock}
INSTRUCTIONS:
- Output ONLY a single valid JSON object. No commentary, markdown fences, or code blocks.
- Do not include JavaScript, XPath, or browser-only pseudo-selectors (e.g., :has(), :is(), :where(), :focus, :hover).
- All selectors must be valid CSS that Cheerio can evaluate against static HTML.
- For each field, write the single most accurate selector. Set a field to null only if you genuinely cannot identify a good selector for it.
- titleSelector is required (return null for the whole object if no good title selector exists).
- imagesSelector should target the container that wraps ALL gallery images (multiple <img>), not a single hero image, when a gallery exists. If the DOM shows a Shopify media wrapper (e.g. .product__media-wrapper, .product-single__media, [data-product-media]), target it.
- brandSelector should target an element that contains the brand/vendor/manufacturer name.
- If you can see a Shopify product object embedded in a <script> (window.productJSON / productJSON / *_product_data / var meta = { product: ... }), set "shopifyJSONPath" to true and prefer that object for title/description/images; still provide CSS selectors as fallback.
- If one or more variant/option candidates correspond to the real product variant selectors, propose a "variantSelectionStrategy" object using the most stable "containerSelector" from the variant candidates. Set "optionType" to dropdown|button_group|radio|unknown. Copy the discovered "detectedOptions" and inferred "optionFields". If none is a real variant selector, set "variantSelectionStrategy" to null.
- An invalid or null "variantSelectionStrategy" does NOT invalidate the rest of the profile.
- If the product title is split across multiple elements (e.g. an h1 and a separate subheading div), set titleSelector to the primary element and add the secondary element selector(s) to titleOptionalSelectors (an array of strings). Their text content will be appended with " — " to form the full title.
- Look for additional product data in the DOM: ingredients list, nutrition table (guaranteed analysis), calorie content, weight/size, flavor/variety, SKU, dietary labels, life stage, and feeding guidelines. For any such data you can find a reliable CSS selector, propose a custom field in the "customSelectors" object with a normalized key name (e.g. "ingredients", "guaranteedAnalysis", "calories", "weight", "flavor", "sku", "dietaryLabels", "lifeStage", "feedingGuidelines").
- If the URL structure shows a consistent product page pattern (e.g., /products/product-name, /product/sku, /p/id), infer a sitemapProductUrlPattern regex string.

Return JSON with exactly these keys:
{
  "titleSelector": string|null,
  "titleOptionalSelectors": string[],
  "brandSelector": string|null,
  "descriptionSelector": string|null,
  "imagesSelector": string|null,
  "shopifyJSONPath": boolean,
  "sitemapProductUrlPattern": string|null,
  "customSelectors": object|null,
  "variantSelectionStrategy": {
    "containerSelector": string|null,
    "optionType": "dropdown"|"button_group"|"radio"|"unknown",
    "detectedOptions": string[],
    "optionFields": string[]
  } | null
}`;
  return prompt;
}

const SYSTEM_PROMPT =
  'You are a precise assistant that returns ONLY valid JSON. No markdown, no commentary, no code fences.';

function shapeFromParsed(parsed: unknown): GeneratedSelectorProfile | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const out: GeneratedSelectorProfile = {
    titleSelector: null,
    descriptionSelector: null,
    brandSelector: null,
    imagesSelector: null,
    sitemapProductUrlPattern: null,
    shopifyJSONPath: false,
  };
  for (const key of SELECTOR_PROFILE_KEYS) {
    // shopifyJSONPath is a boolean handled separately below
    if (key === 'shopifyJSONPath') continue;
    const raw = obj[key];
    if (raw === null || raw === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) {
      out[key] = null;
      continue;
    }
    if (!isSupportedSelectorSyntax(trimmed)) return null;
    out[key] = trimmed;
  }
  // Parse variantSelectionStrategy
  const rawStrategy = obj.variantSelectionStrategy;
  if (rawStrategy === null || rawStrategy === undefined) {
    out.variantSelectionStrategy = null;
  } else if (typeof rawStrategy === 'object' && !Array.isArray(rawStrategy)) {
    const strategy = rawStrategy as Record<string, unknown>;
    const parsed: Required<NonNullable<GeneratedSelectorProfile['variantSelectionStrategy']>> = {
      containerSelector: null,
      optionType: 'unknown',
      detectedOptions: [],
      optionFields: [],
    };
    // containerSelector
    if (typeof strategy.containerSelector === 'string' && strategy.containerSelector.trim()) {
      if (isSupportedSelectorSyntax(strategy.containerSelector.trim())) {
        parsed.containerSelector = strategy.containerSelector.trim();
      }
    }
    // optionType
    if (typeof strategy.optionType === 'string' && ['dropdown', 'button_group', 'radio', 'unknown'].includes(strategy.optionType)) {
      parsed.optionType = strategy.optionType as 'dropdown' | 'button_group' | 'radio' | 'unknown';
    }
    // detectedOptions
    if (Array.isArray(strategy.detectedOptions)) {
      parsed.detectedOptions = strategy.detectedOptions.filter((o): o is string => typeof o === 'string').slice(0, 20);
    }
    // optionFields
    if (Array.isArray(strategy.optionFields)) {
      parsed.optionFields = strategy.optionFields.filter((f): f is string => typeof f === 'string').slice(0, 8);
    }
    out.variantSelectionStrategy = parsed;
  } else {
    out.variantSelectionStrategy = null;
  }
  // Parse shopifyJSONPath boolean
  if (typeof obj.shopifyJSONPath === 'boolean') {
    out.shopifyJSONPath = obj.shopifyJSONPath;
  }

  // Parse titleOptionalSelectors (array of CSS selectors appended to the title)
  const rawOptional = obj.titleOptionalSelectors;
  if (Array.isArray(rawOptional)) {
    const valid = (rawOptional as unknown[])
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0 && isSupportedSelectorSyntax(s.trim()))
      .map(s => s.trim());
    if (valid.length > 0) {
      out.titleOptionalSelectors = valid;
    }
  }

  // Parse sitemapProductUrlPattern
  if (typeof obj.sitemapProductUrlPattern === 'string' && obj.sitemapProductUrlPattern.trim()) {
    out.sitemapProductUrlPattern = obj.sitemapProductUrlPattern.trim();
  }

  // Parse customSelectors (record of string -> string)
  const rawCustom = obj.customSelectors;
  if (rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)) {
    const parsedCustom: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawCustom)) {
      if (typeof value === 'string' && value.trim() && isSupportedSelectorSyntax(value.trim())) {
        parsedCustom[key] = value.trim();
      }
    }
    if (Object.keys(parsedCustom).length > 0) {
      out.customSelectors = parsedCustom;
    }
  }

  if (!out.titleSelector) return null;
  return out;
}

// ─── Seed preview (Task A3) ────────────────────────────────────────────────

/**
 * Build a lightweight preview of what a generated profile would extract
 * from the page. Tries Shopify JSON first (when the profile has detected
 * a `shopifyJSONPath`), then falls back to CSS selectors.
 */
export function buildSeedPreview(
  html: string,
  profile: GeneratedSelectorProfile,
  sourceUrl: string,
): SeedPreview {
  // Try Shopify JSON first if the profile indicated it has one
  if (profile.shopifyJSONPath) {
    const productJSON = extractProductJsonFromHtml(html);
    if (productJSON) {
      const title = productJSON.title ?? null;
      const description = productJSON.body_html
        ? productJSON.body_html.replace(/<[^>]*>/g, '').trim()
        : (productJSON.description ?? null);
      const images: string[] = [];
      if (Array.isArray(productJSON.images)) {
        for (const img of productJSON.images) {
          const src = img.src ?? img.url ?? img;
          if (typeof src === 'string') {
            try {
              images.push(new URL(src, sourceUrl).href);
            } catch { images.push(src); }
          }
        }
      }
      const variantOptions: string[] = [];
      if (Array.isArray(productJSON.options)) {
        for (const opt of productJSON.options) {
          if (Array.isArray(opt.values)) {
            for (const v of opt.values) {
              if (typeof v === 'string' && !variantOptions.includes(v)) variantOptions.push(v);
            }
          }
        }
      }
      return {
        title,
        description: description?.slice(0, 500) ?? null,
        images,
        variantOptions,
        strategy: 'shopify-json',
        variantSelectionStrategy: profile.variantSelectionStrategy ?? null,
      };
    }
  }

  // Fall back to CSS selectors
  try {
    const $ = cheerio.load(html);
    let title = profile.titleSelector ? $(profile.titleSelector).first().text().trim() || null : null;
    if (title && profile.titleOptionalSelectors?.length) {
      const extras = profile.titleOptionalSelectors
        .map(sel => $(sel).first().text().trim())
        .filter(Boolean)
        .join(' — ');
      if (extras) title += ' — ' + extras;
    }
    const description = profile.descriptionSelector ? $(profile.descriptionSelector).first().text().trim().slice(0, 500) || null : null;
    let images: string[] = [];
    if (profile.imagesSelector) {
      const seen = new Set<string>();
      $(profile.imagesSelector).each((_, el) => {
        for (const src of collectImageSourcesFromElement($, el)) {
          addImageSource(src, seen, images);
        }
      });
      images = cleanAndDeduplicateImages(images, sourceUrl);
    }
    const variantOptions = profile.variantSelectionStrategy?.detectedOptions ?? [];
    return {
      title,
      description,
      images: images.slice(0, 10),
      variantOptions,
      strategy: 'css',
      variantSelectionStrategy: profile.variantSelectionStrategy ?? null,
    };
  } catch {
    return {
      title: null,
      description: null,
      images: [],
      variantOptions: [],
      strategy: 'css',
      variantSelectionStrategy: null,
    };
  }
}

/**
 * Use the active LLM to propose a selector profile for the given
 * product page. Returns `null` when the feature is disabled, no LLM is
 * configured, the LLM call fails, or the response cannot be parsed
 * into a valid `GeneratedSelectorProfile`.
 */
export async function generateExtractorProfile(
  _url: string,
  html: string,
  expected?: GeneratorExpectedContext,
): Promise<GeneratedSelectorProfile | null> {
  if (!isProfileGenerationEnabled()) return null;

  // Profile generation must use the explicit `profile_generation`
  // task config and fail closed when none exists. The page-extractor
  // audit row distinguishes this missing-config case from other LLM
  // failures, so the operator can see that the model needs to be
  // configured before generation can be enabled.
  let config: LlmConfig | null;
  try {
    config = getLlmConfigForTask('profile_generation', { allowFallback: false });
  } catch (err) {
    if (err instanceof MissingLlmTaskConfigError) {
      console.warn('[ProfileGenerator] No LLM config for profile_generation task');
      return null;
    }
    throw err;
  }
  if (!config) {
    console.warn('[ProfileGenerator] LLM config resolved to null for profile_generation');
    return null;
  }

  // Build minimized DOM once, used for both candidate extraction and LLM prompt
  let minimized = '';
  try {
    minimized = getMinimizedDom(html);
  } catch {
    minimized = '';
  }

  const llmDom = minimized
    ? (minimized.length > MAX_LLM_DOM_BYTES
        ? minimized.slice(0, MAX_LLM_DOM_BYTES) + '<!--truncated-->'
        : minimized)
    : '';

  let candidates: SelectorCandidate[];
  try {
    candidates = buildSelectorCandidates(minimized, _url);
  } catch {
    candidates = [];
  }

  // Build variant option candidates from original HTML (NOT minimized — NOISY_TAGS strips select/button/input)
  let variantCandidates: VariantOptionCandidate[] = [];
  try {
    variantCandidates = buildVariantOptionCandidates(html, _url);
  } catch (err) {
    console.warn('[ProfileGenerator] Variant discovery failed:', err);
    variantCandidates = [];
  }

  const prompt = buildLlmPrompt(candidates, variantCandidates, llmDom, expected);

  let raw: string | null;
  try {
    raw = await callLlmForTask('profile_generation', prompt, SYSTEM_PROMPT, { allowFallback: false });
  } catch (err) {
    console.warn('[ProfileGenerator] LLM call failed:', redactTransportText(err instanceof Error ? err.message : String(err)));
    return null;
  }
  if (raw == null) {
    console.warn('[ProfileGenerator] LLM returned null (no error thrown)');
    return null;
  }

  const cleaned = stripCodeFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.warn('[ProfileGenerator] Failed to parse LLM response as JSON:', cleaned.slice(0, 500));
    return null;
  }
  const shaped = shapeFromParsed(parsed);
  if (!shaped) {
    console.warn('[ProfileGenerator] shapeFromParsed returned null — LLM response missing/invalid titleSelector');
  }
  return shaped;
}

// ─── Validation (Task 10) ──────────────────────────────────────────────────

/**
 * HTML. Title is required; description, brand, and images are optional
 * and contribute to confidence when present.
 *
 * If `expected` is provided, the extracted title is passed through
 * `validateExtraction`; `blocked`, `offline`, and `mismatch` results
 * cause the entire profile to fail closed.
 */
export function validateGeneratedProfile(
  html: string,
  selectors: GeneratedSelectorProfile,
  expected?: GeneratorExpectedContext,
): GeneratedProfileValidation {
  const fieldSamples: Record<string, string> = {};
  let confidence = 0;
  let lowStabilityUsed = false;
  const reasons: string[] = [];

  if (!html || typeof html !== 'string') {
    return {
      valid: false,
      confidence: 0,
      status: 'failed',
      reason: 'Empty HTML input',
      fieldSamples: {},
      selectors,
      readyForReview: false,
    };
  }

  if (!selectors.titleSelector || !isSupportedSelectorSyntax(selectors.titleSelector)) {
    return {
      valid: false,
      confidence: 0,
      status: 'rejected',
      reason: 'titleSelector is missing or uses unsupported syntax',
      fieldSamples: {},
      selectors,
      readyForReview: false,
    };
  }

  const $ = cheerio.load(html);

  // Title (required).
  let titleText = $(selectors.titleSelector).first().text().trim();
  if (!titleText) {
    return {
      valid: false,
      confidence: 0,
      status: 'rejected',
      reason: 'titleSelector produced empty text',
      fieldSamples: {},
      selectors,
      readyForReview: false,
    };
  }
  // Concatenate optional title selectors if present
  if (selectors.titleOptionalSelectors?.length) {
    const extras = selectors.titleOptionalSelectors
      .map(sel => $(sel).first().text().trim())
      .filter(Boolean)
      .join(' — ');
    if (extras) {
      titleText += ' — ' + extras;
    }
  }
  fieldSamples.title = titleText;

  // Cross-check with the selector's own stability (rebuild to inspect).
  // We can't reuse buildStableSelector against a string selector, so we
  // approximate by inspecting the selector itself.
  if (/:nth-of-type\(/i.test(selectors.titleSelector)) lowStabilityUsed = true;

  // Optional: description.
  if (selectors.descriptionSelector) {
    if (!isSupportedSelectorSyntax(selectors.descriptionSelector)) {
      reasons.push('descriptionSelector uses unsupported syntax');
    } else {
      const descText = $(selectors.descriptionSelector).first().text().trim();
      if (descText && descText.length > 20) {
        fieldSamples.description = descText.slice(0, 200);
      } else if (descText) {
        fieldSamples.description = descText;
      } else {
        reasons.push('descriptionSelector produced empty text');
      }
      if (/:nth-of-type\(/i.test(selectors.descriptionSelector)) lowStabilityUsed = true;
    }
  }

  // Optional: images.
  if (selectors.imagesSelector) {
    if (!isSupportedSelectorSyntax(selectors.imagesSelector)) {
      reasons.push('imagesSelector uses unsupported syntax');
    } else {
      const imageCount = $(selectors.imagesSelector).length;
      if (imageCount > 0) {
        fieldSamples.imagesCount = String(imageCount);
      } else {
        reasons.push('imagesSelector matched no elements');
      }
      if (/:nth-of-type\(/i.test(selectors.imagesSelector)) lowStabilityUsed = true;
    }
  }

  // Expected-name cross-check.
  if (expected) {
    const sourceUrl = expected.sourceUrl ?? '';
    const validationInput: Partial<{ title: string; sourceUrl: string }> = {
      title: titleText,
      sourceUrl,
    };
    const result: ValidationResult = validateExtraction(validationInput, {
      name: expected.name ?? titleText,
      brandHint: expected.brandHint ?? null,
      domain: expected.domain ?? null,
    });
    if (result.status === 'blocked') {
      return {
        valid: false,
        confidence: 0,
        status: 'rejected',
        reason: `Expected-validation flagged as blocked: ${result.reason ?? ''}`.trim(),
        fieldSamples,
        selectors,
        readyForReview: false,
      };
    }
    if (result.status === 'offline') {
      return {
        valid: false,
        confidence: 0,
        status: 'rejected',
        reason: `Expected-validation flagged as offline: ${result.reason ?? ''}`.trim(),
        fieldSamples,
        selectors,
        readyForReview: false,
      };
    }
    if (result.status === 'mismatch') {
      return {
        valid: false,
        confidence: 0,
        status: 'rejected',
        reason: `Expected-validation flagged as mismatch: ${result.reason ?? ''}`.trim(),
        fieldSamples,
        selectors,
        readyForReview: false,
      };
    }
  }

  // Confidence: title (0.45) + description (0.15) + images (0.10) + expected name overlap (0.10)
  confidence = 0;
  if (selectors.titleSelector) confidence += 0.45;
  if (selectors.descriptionSelector) confidence += 0.15;
  if (selectors.imagesSelector) confidence += 0.10;
  if (expected?.name) confidence += 0.10;
  // Cap at 1.0 and round to avoid floating point precision issues
  confidence = Math.round(Math.min(1.0, confidence) * 100) / 100;

  const valid = confidence >= 0.5 && reasons.length === 0;
  const readyForReview = confidence >= 0.8 && !lowStabilityUsed;

  return {
    valid,
    confidence,
    status: valid ? 'ok' : 'rejected',
    reason: reasons.length > 0 ? reasons.join('; ') : null,
    fieldSamples,
    selectors,
    readyForReview,
  };
}

// ─── Trigger decision (Task 13) ──────────────────────────────────────────

/** Minimum page-extraction confidence required to consider generation. */
const MIN_TRIGGER_CONFIDENCE = 0.5;

export interface ProfileGenerationTriggerInput {
  /** Domain being processed (lowercase, no www.). May be empty. */
  domain: string;
  /** Existing extractor profile for the domain, if any. Reserved for
   *  future triggers; currently unused by the trigger function. */
  existingProfile?: unknown;
  /** Merged extraction result that just passed validation. */
  extractionResult: { title?: string | null; brand?: string | null; description?: string | null };
  /** Validation result from the extraction. */
  validationResult: ValidationResult;
  /** True if the custom-selector layer produced any non-empty value. */
  customHadAnyValue: boolean;
}

/**
 * Pure decision function: should we attempt to generate a new selector
 * profile for this extraction? The function is deliberately
 * conservative — false-negatives (missed opportunities) are fine,
 * false-positives (silently breaking good extractions) are not.
 *
 * Returns `true` only when:
 *  1. The feature flag is enabled (`BAYSTATE_CMS_PROFILE_GENERATION_ENABLED`).
 *  2. The extraction validation status is `ok` (not blocked/offline/mismatch).
 *  3. The extraction returned a non-empty title.
 *  4. The custom-selector layer was empty or stale (no current selectors
 *     or the existing profile selectors are unlikely to have produced
 *     the validated title).
 *  5. There is a concrete improvement target: a missing description.
 *  6. The extraction confidence is above `MIN_TRIGGER_CONFIDENCE`.
 */
// fallow-ignore-next-line unused-export
export function shouldAttemptProfileGeneration(
  input: ProfileGenerationTriggerInput,
): boolean {
  if (!isProfileGenerationEnabled()) return false;
  if (!input.validationResult || input.validationResult.status !== 'ok') return false;
  if (input.validationResult.confidence < MIN_TRIGGER_CONFIDENCE) return false;
  if (!input.extractionResult.title || !input.extractionResult.title.trim()) return false;

  // If the existing custom-selector layer actually produced values for
  // the validated title (or other validated fields), there is no need
  // to regenerate — the profile is working.
  if (input.customHadAnyValue) {
    return false;
  }

  // Even with no profile, we need a concrete improvement target. If the
  // page is missing a title, we never get this far (validation would
  // have failed).
  const hasImprovementTarget =
    !input.extractionResult.description;
  if (!hasImprovementTarget) return false;

  return true;
}

// ─── Multi-sample validation (Task 16) ───────────────────────────────────

/** A pre-fetched HTML sample from the same domain for cross-page validation. */
export interface ValidationSample {
  url: string;
  html: string;
  expected?: GeneratorExpectedContext;
}

export interface MultiSampleValidationResult {
  /** Total samples evaluated (including failed ones). */
  total: number;
  /** Number of samples that passed validation. */
  passed: number;
  /** Detailed per-sample outcomes. */
  samples: Array<{
    url: string;
    valid: boolean;
    confidence: number;
    reason: string | null;
  }>;
  /**
   * True if at least `MIN_MULTI_SAMPLE_PASS` samples passed. This is
   * an ADVISORY signal to the operator that a profile has been
   * validated across multiple same-domain pages. It does NOT mean
   * the profile will be applied automatically — promotion always requires
   * explicit per-field human approval via `promoteGeneratedProfile`.
   * Auto-promotion is forbidden.
   */
  readyForReview: boolean;
}

/** Minimum number of successful same-domain samples required to be
 * flagged as `readyForReview`. */
const MIN_MULTI_SAMPLE_PASS = 2;

/**
 * Validate a `GeneratedSelectorProfile` against multiple pre-fetched
 * same-domain HTML samples. Returns per-sample outcomes and a
 * `readyForReview` flag that requires at least
 * `MIN_MULTI_SAMPLE_PASS` successful samples.
 *
 * `readyForReview` is an advisory signal only. Promotion to
 * `extractor_profiles` always requires an explicit per-field
 * approval object passed by a human operator (see
 * `promoteGeneratedProfile`). It does NOT trigger any write.
 *
 * This function is pure (no DB writes, no network) so it can be tested
 * in isolation. The caller is expected to fetch the samples with the
 * same HTTP headers used by the page extractor.
 */
// fallow-ignore-next-line unused-export
export function validateProfileAcrossSamples(
  selectors: GeneratedSelectorProfile,
  samples: ValidationSample[],
): MultiSampleValidationResult {
  const perSample = samples.map((sample) => {
    const result = validateGeneratedProfile(sample.html, selectors, sample.expected);
    return {
      url: sample.url,
      valid: result.valid,
      confidence: result.confidence,
      reason: result.reason,
    };
  });

  const passed = perSample.filter((s) => s.valid).length;
  const readyForReview = passed >= MIN_MULTI_SAMPLE_PASS;
  return {
    total: samples.length,
    passed,
    samples: perSample,
    readyForReview,
  };
}


