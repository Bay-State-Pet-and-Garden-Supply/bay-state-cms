// @ts-nocheck
/**
 * useProfileBuilderController — async orchestration hook for the profile builder.
 *
 * Owns all API call workflows, dispatches reducer actions, and exposes
 * a stable controller interface to presentational components.
 *
 * No Bun-only imports — safe for Vite/React frontend.
 */

import { useReducer, useEffect, useCallback, useMemo, useRef } from 'react';

/** Simple unique ID generator (no external dependency). */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
import { profileBuilderReducer, createInitialState, deriveFieldStatus } from '../profileBuilderReducer';
import {
  evaluateAllSelectorsLocally,
  evaluateSelectorLocally,
  evaluateTitleOptionalSelectors,
} from '../selectorEvaluation';
import { getFieldDefinition, ALL_STANDARD_FIELDS, CORE_FIELDS, STANDARD_CUSTOM_FIELDS } from '../fieldCatalog';
import type { FieldDefinition } from '../fieldCatalog';
import {
  draftToSavePayload,
  draftToValidatePayload,
  draftToTestPayload,
  draftToVersionPayload,
} from '../profileBuilderMapping';
import {
  getExtractorProfiles,
  saveExtractorProfile,
  testExtractorProfile,
  snapshotPageForBuilder,
  validateProfileDraft,
  generateSelectors as generateSelectorsApi,
} from '../../../onboarding-api';
import type { ProfileBuilderProps, ProfileBuilderController, ValidationSample } from '../profileBuilderTypes';
// story: e07s03 — click→ranked recipes (shared with ValuePreviewGrid)
import * as cheerio from 'cheerio';
import { buildStableSelector } from '../../../../shared/selector-utils';
import { cleanAndDeduplicateImages, parseSrcsetCandidates } from '../../../../onboarding/image-utils';

export type RankedRecipe = {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  source: 'jsonld' | 'css-stable' | 'shopify' | 'semantic' | 'generic';
  score: number;
};

function normalizeFieldKey(field: string): string {
  const f = field.toLowerCase().replace(/selector$/i, '').replace(/optionalselectors$/i, '').trim();
  if (f === 'images' || f === 'image' || f === 'mainimage' || f === 'photo') return 'image';
  if (f === 'title' || f === 'name' || f === 'productname') return 'title';
  if (f === 'price' || f === 'regularprice' || f === 'saleprice') return 'price';
  if (f === 'description' || f === 'desc' || f === 'body') return 'description';
  if (f === 'brand' || f === 'vendor' || f === 'manufacturer') return 'brand';
  return f;
}

/**
 * Rank candidate recipes for a field given a capture (dom+html) and optional clicked element text.
 * Field semantics: map field to appropriate tag/hint and jsonld property (title->name, description->description, price->offers.price, etc.)
 */
export function rankCandidates(capture: { dom: string; html: string }, rawField: string, clickedElementText?: string): RankedRecipe[] {
  const html = (capture.html ?? capture.dom ?? '') as string;
  const dom = (capture.dom ?? html) as string;
  const lower = html.toLowerCase();
  const field = normalizeFieldKey(rawField);
  const _clickedNorm = clickedElementText ? clickedElementText.toLowerCase().replace(/\s+/g, ' ').trim() : '';
  const candidates: RankedRecipe[] = [];

  // 1) [data-testid] etc. — high stability CSS attributes
  const hasStableAttr = /data-testid|data-test|data-cy|data-qa/.test(lower);
  if (hasStableAttr) {
    try {
      const $ = cheerio.load(dom);
      const el = $('[data-testid],[data-test],[data-cy],[data-qa]').get(0) as unknown as import('domhandler').Element | undefined;
      if (el) {
        const built = buildStableSelector($, el);
        candidates.push({ selector: built.selector, stability: built.stability, source: 'css-stable', score: 90 });
      } else {
        candidates.push({ selector: '[data-testid="product"]', stability: 'high', source: 'css-stable', score: 90 });
      }
    } catch {
      candidates.push({ selector: '[data-testid="product"]', stability: 'high', source: 'css-stable', score: 90 });
    }
  }

  // 3) E-Commerce & Shopify platform patterns
  const isShopify = lower.includes('shopify') || lower.includes('cdn.shopify');
  if (isShopify) {
    if (field === 'title') {
      candidates.push({ selector: 'h1.product-title, h1.product__title, .product__title h1, h1[class*="title" i]', stability: 'medium', source: 'shopify', score: 70 });
    } else if (field === 'price') {
      candidates.push({ selector: '.price-item--regular, .product__price, span.money', stability: 'medium', source: 'shopify', score: 70 });
    } else if (field === 'description') {
      candidates.push({ selector: '.product__description, .product-single__description, .rte', stability: 'medium', source: 'shopify', score: 70 });
    } else if (field === 'brand') {
      candidates.push({ selector: '.product__vendor, .vendor', stability: 'medium', source: 'shopify', score: 70 });
    } else if (field === 'image') {
      candidates.push({ selector: '.product__media img, .product-single__photos img', stability: 'medium', source: 'shopify', score: 70 });
    }
  }

  // 4) Semantic class/id patterns
  const semanticHints: Record<string, { hint: string; tag: string; selector: string }> = {
    title: { hint: 'product-title', tag: 'h1', selector: 'h1.product-title' },
    description: { hint: 'description', tag: 'div', selector: '.product-description, .description' },
    price: { hint: 'price', tag: 'span', selector: '.price, span.price' },
    brand: { hint: 'brand', tag: 'span', selector: '.product-brand, .brand' },
    image: { hint: 'product-image', tag: 'img', selector: '.product-gallery img, img.product-image' },
  };
  const sem = semanticHints[field] ?? { hint: field, tag: 'span', selector: `.${field}` };
  if (lower.includes(sem.hint) || (field === 'title' && lower.includes('product-title'))) {
    candidates.push({ selector: sem.selector, stability: 'medium', source: 'semantic', score: 60 });
  } else if (field === 'title' && lower.includes('pdp-title')) {
    candidates.push({ selector: 'h1.pdp-title', stability: 'medium', source: 'semantic', score: 60 });
  }

  // 5) Generic fallback — low score (always produced as final fallback)
  const genericTag = field === 'price' ? 'span' : field === 'image' ? 'img' : field === 'description' ? 'div' : 'h1';
  candidates.push({ selector: genericTag, stability: 'low', source: 'generic', score: 10 });

  // 6) Meta tag fallback (OpenGraph) if present
  if (field === 'title' && lower.includes('og:title')) {
    candidates.push({ selector: 'meta[property="og:title"]', stability: 'medium', source: 'semantic', score: 50 });
  } else if (field === 'description' && lower.includes('og:description')) {
    candidates.push({ selector: 'meta[property="og:description"]', stability: 'medium', source: 'semantic', score: 50 });
  } else if (field === 'image' && lower.includes('og:image')) {
    candidates.push({ selector: 'meta[property="og:image"]', stability: 'medium', source: 'semantic', score: 50 });
  }

  // Deduplicate by selector preserving order
  const seen = new Set<string>();
  const deduped: RankedRecipe[] = [];
  for (const c of candidates) {
    if (!seen.has(c.selector)) {
      seen.add(c.selector);
      deduped.push(c);
    }
  }

  return deduped.sort((a, b) => b.score - a.score);
}

export function normalizeImageUrl(url: string, baseUrl?: string): string {
  if (!url) return '';
  let cleaned = url.trim();
  if (cleaned.startsWith('//')) {
    cleaned = `https:${cleaned}`;
  } else if (cleaned.startsWith('/') && baseUrl) {
    try {
      const b = new URL(baseUrl);
      cleaned = `${b.origin}${cleaned}`;
    } catch {}
  }
  return cleaned;
}

// Fast LRU/Map cache for parsed Cheerio DOM trees to eliminate redundant parsing
const cheerioDocCache = new Map<string, cheerio.CheerioAPI>();

export function getParsedCheerio(html: string): cheerio.CheerioAPI {
  if (!html) return cheerio.load('');
  const key = `${html.length}:${html.slice(0, 120)}:${html.slice(-120)}`;
  let doc = cheerioDocCache.get(key);
  if (!doc) {
    if (cheerioDocCache.size >= 40) {
      cheerioDocCache.clear();
    }
    doc = cheerio.load(html);
    cheerioDocCache.set(key, doc);
  }
  return doc;
}

/**
 * Instant local eval for extracting full image arrays across captures.
 */
export function evaluateImagesInstant(capture: { html: string; url?: string }, selector: string): string[] {
  if (!capture || !capture.html || !selector) return [];
  const rawUrls: string[] = [];
  try {
    const $ = getParsedCheerio(capture.html);

    // 1) JSON-LD images
    if (selector.startsWith('jsonld:')) {
      const prop = selector.slice('jsonld:'.length);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const txt = $(el).html() ?? '';
          const json = JSON.parse(txt);
          const obj = Array.isArray(json) ? json[0] : (json['@graph'] ? json['@graph'].find((g: any) => g['@type'] === 'Product' || g['name'] || g['image']) ?? json['@graph'][0] : json);
          if (!obj) return;
          if (prop === 'Product.image' || prop === 'image') {
            const raw = obj.image ?? obj.images;
            if (Array.isArray(raw)) {
              for (const item of raw) {
                const u = typeof item === 'object' ? item?.url ?? item?.contentUrl : item;
                if (u && typeof u === 'string') rawUrls.push(u);
              }
            } else if (typeof raw === 'object' && raw?.url) {
              rawUrls.push(raw.url);
            } else if (typeof raw === 'string') {
              rawUrls.push(raw);
            }
          }
        } catch {}
      });
    } else if (selector.startsWith('meta[')) {
      // 2) Meta tags
      const content = $(selector).attr('content');
      if (content) rawUrls.push(content.trim());
    } else {
      // 3) DOM Elements & containers
      const els = $(selector);
      if (els.length > 0) {
        els.each((_, el) => {
          const $el = $(el);
          const imgElements = $el.is('img') ? [$el] : $el.find('img').toArray().map((i) => $(i));
          for (const img of imgElements) {
            // Direct attributes (prioritize zoom / full resolution attributes)
            const direct = img.attr('data-zoom-src') || img.attr('data-original') || img.attr('data-src') || img.attr('src');
            if (direct) rawUrls.push(direct.trim());

            // Srcset (traverse in reverse so largest resolution candidates are processed first)
            const srcset = img.attr('srcset') || img.attr('data-srcset');
            if (srcset) {
              const candidates = parseSrcsetCandidates(srcset);
              for (let i = candidates.length - 1; i >= 0; i--) {
                rawUrls.push(candidates[i]);
              }
            }
          }
        });
      }
    }
  } catch {}

  return cleanAndDeduplicateImages(rawUrls, capture.url);
}

/**
 * Instant local eval for value previews across HTML captures.
 */
export function evaluateValuesInstant(capture: { html: string }, selector: string): string | null {
  if (!capture || !capture.html || !selector) return null;
  try {
    const $ = getParsedCheerio(capture.html);

    // 1) JSON-LD selector handling
    if (selector.startsWith('jsonld:')) {
      const prop = selector.slice('jsonld:'.length);
      let found: string | null = null;
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const txt = $(el).html() ?? '';
          const json = JSON.parse(txt);
          const obj = Array.isArray(json) ? json[0] : (json['@graph'] ? json['@graph'].find((g: any) => g['@type'] === 'Product' || g['name']) ?? json['@graph'][0] : json);
          if (!obj) return;
          if (prop === 'Product.name' && obj.name) found = String(obj.name).trim();
          else if (prop === 'Product.description' && obj.description) found = String(obj.description).trim();
          else if (prop === 'Product.offers.price') {
            const p = obj.offers?.price ?? obj.offers?.[0]?.price ?? obj.price;
            if (p) found = String(p).trim();
          } else if (prop === 'Product.brand') {
            const b = obj.brand?.name ?? obj.brand;
            if (b) found = String(b).trim();
          } else if (prop === 'Product.image') {
            const img = Array.isArray(obj.image) ? obj.image[0] : (typeof obj.image === 'object' ? obj.image?.url : obj.image);
            if (img) found = normalizeImageUrl(String(img).trim());
          }
        } catch {}
      });
      if (found) return found;
    }

    // 2) Meta tag selector handling
    if (selector.startsWith('meta[')) {
      const content = $(selector).attr('content');
      if (content) return normalizeImageUrl(content.trim());
    }

    // 3) DOM elements
    const els = $(selector);
    if (els.length === 0) return null;

    const first = els.first();
    // If it's an image element or contains an img
    const imgEl = first.is('img') ? first : first.find('img').first();
    if (imgEl.length > 0 && imgEl.is('img')) {
      const src = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('srcset') || imgEl.attr('data-srcset');
      if (src) {
        const cleaned = src.split(',')[0].split(' ')[0].trim();
        return normalizeImageUrl(cleaned) || null;
      }
    }

    const text = first.text().replace(/\s+/g, ' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

const captureCache = new Map<string, string>();

async function fetchSuiteCaptures(urls: string[]): Promise<Array<{ url: string; html: string }>> {
  const out: Array<{ url: string; html: string }> = [];
  const needed = urls.filter((u) => Boolean(u) && !captureCache.has(u));

  if (needed.length > 0) {
    await Promise.all(
      needed.map(async (u) => {
        try {
          const r = await fetch('/api/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: u, runtime: 'static' }),
          });
          const j = (await r.json()) as { ok: boolean; dom?: string };
          if (r.ok && j.ok && j.dom) {
            captureCache.set(u, j.dom);
          }
        } catch {}
      }),
    );
  }

  for (const u of urls) {
    if (captureCache.has(u)) {
      out.push({ url: u, html: captureCache.get(u)! });
    }
  }
  return out;
}

async function postGenerateDraft(captures: Array<{ url: string; html: string }>, _domain: string): Promise<unknown> {
  const r = await fetch('/api/profile-builder/generate-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suiteUrls: captures.map((c) => c.url), snapshotHtmls: captures.map((c) => c.html), sourceUrl: captures[0]?.url ?? '', runtime: 'rendered' }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'generate-draft failed');
  return j;
}

/**
 * Normalize a domain string for matching:
 * lowercase, trim, strip leading www.
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/**
 * Find the profile whose domain matches the given input.
 */
function findMatchingProfile(
  profiles: Array<{ domain: string }>,
  rawDomain: string,
): { domain: string } | null {
  const needle = normalizeDomain(rawDomain);
  if (!needle) return null;
  return profiles.find((p) => normalizeDomain(p.domain) === needle) ?? null;
}

export function useProfileBuilderController(
  props: ProfileBuilderProps,
): ProfileBuilderController {
  const [state, dispatch] = useReducer(
    profileBuilderReducer,
    { initialDomain: props.initialDomain, initialProductUrl: props.initialProductUrl },
    createInitialState,
  );

  // Track whether we've auto-seeded the initial URL as a validation sample
  const seededRef = useRef(false);

  // ── Load profiles on mount ──────────────────────────────────────────────
  const loadProfiles = useCallback(async () => {
    dispatch({ type: 'profiles/loadStarted' });
    try {
      const result = await getExtractorProfiles();
      dispatch({ type: 'profiles/loadSucceeded', profiles: result.extractorProfiles });
    } catch (err) {
      dispatch({
        type: 'profiles/loadFailed',
        error: err instanceof Error ? err.message : 'Failed to load profiles',
      });
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // ── Domain matching (when profiles change or domain changes) ──────────
  useEffect(() => {
    const rawDomain = state.draft.domain;
    if (!rawDomain || state.profiles.length === 0) return;

    const match = findMatchingProfile(state.profiles, rawDomain);
    if (match) {
      const profile = state.profiles.find((p) => p.id === (match as any).id) ?? match as any;
      if ('id' in profile) {
        dispatch({ type: 'activeProfile/set', profile });
        dispatch({ type: 'draft/hydrateFromProfile', profile });
      }
    } else {
      dispatch({ type: 'activeProfile/set', profile: null });
    }
  }, [state.draft.domain, state.profiles]);

  // ── Auto-seed validation sample from initial URL or sync from props ────
  const validationSamplesKey = props.validationSamples ? props.validationSamples.join(',') : '';
  useEffect(() => {
    const suiteUrls = props.validationSamples;
    if (suiteUrls && suiteUrls.length > 0) {
      const mapped: ValidationSample[] = suiteUrls.map((u) => ({
        id: u,
        url: u,
        confirmed: true,
      }));
      dispatch({ type: 'samples/set', samples: mapped });
      return;
    }

    if (seededRef.current) return;
    const url = state.draft.productUrl;
    if (!url || state.samples.length > 0) return;
    if (state.requests.loadProfiles.loading) return;
    seededRef.current = true;
    dispatch({ type: 'sample/add', sample: { id: generateId(), url, confirmed: true } });
  }, [validationSamplesKey, state.draft.productUrl]);

  // Load DOM captures for all validation sample URLs so multi-page candidate matrix has real HTML
  const sampleUrlsKey = state.samples.map((s) => s.url).filter(Boolean).sort().join(',');
  useEffect(() => {
    const urls = state.samples.map((s) => s.url).filter(Boolean);
    if (urls.length === 0) return;
    let cancelled = false;

    void (async () => {
      try {
        const captures = await fetchSuiteCaptures(urls);
        if (cancelled) return;
        const sampleCaptures: Record<string, { html: string; dom: string }> = {};
        for (const cap of captures) {
          sampleCaptures[cap.url] = { html: cap.html, dom: cap.html };
        }
        for (const s of state.samples) {
          if (sampleCaptures[s.url]) {
            sampleCaptures[s.id] = sampleCaptures[s.url];
          }
        }
        dispatch({ type: 'sampleCaptures/set', sampleCaptures });
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [sampleUrlsKey]);

  // e08 tracer — workspace-driven initialProductUrl / initialCapture (canonical capture per sample)
  useEffect(() => {
    const url = (props as unknown as { initialProductUrl?: string }).initialProductUrl;
    if (!url || url === state.draft.productUrl) return;
    dispatch({ type: 'productUrl/set', url });
    seededRef.current = false;
  }, [ (props as unknown as { initialProductUrl?: string }).initialProductUrl, state.draft.productUrl]);

  useEffect(() => {
    const cap = (props as unknown as { initialCapture?: { dom: string; screenshotBase64: string; runtime: string; hash: string; capturedAt: string; url: string } | null }).initialCapture;
    if (!cap || !cap.dom) return;
    if (cap.url !== state.draft.productUrl) dispatch({ type: 'productUrl/set', url: cap.url });
    dispatch({ type: 'snapshot/succeeded', snapshot: { url: cap.url, dom: cap.dom, screenshotBase64: cap.screenshotBase64, screenshotRef: null, runtime: cap.runtime, hash: cap.hash, capturedAt: cap.capturedAt } as unknown as never });
    dispatch({ type: 'pageHtml/set', html: cap.dom });
  }, [ (props as unknown as { initialCapture?: unknown }).initialCapture]);

  // ── Domain setter ───────────────────────────────────────────────────────
  const setDomain = useCallback((domain: string) => {
    dispatch({ type: 'domain/set', domain });
  }, []);

  // ── Product URL setter ──────────────────────────────────────────────────
  const setProductUrl = useCallback((url: string) => {
    dispatch({ type: 'productUrl/set', url });
  }, []);

  // ── Runtime setter ──────────────────────────────────────────────────────
  const setRuntime = useCallback((runtime: 'static' | 'rendered') => {
    dispatch({ type: 'runtime/set', runtime });
  }, []);

  // ── Snapshot (single capture artifact — e07s03) ───────────────────────
  // Single capture (DOM + screenshot + runtime + hash, networkidle+1s) is the source of truth.
  // Independent HTML-fetch hop deleted — previously raced with snapshot.
  const captureSnapshot = useCallback(async () => {
    const url = state.draft.productUrl;
    if (!url) return;

    dispatch({ type: 'snapshot/start' });
    try {
      const res = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, runtime: state.draft.runtime }),
      });
      const data = (await res.json()) as { ok: boolean; dom?: string; screenshotBase64?: string; runtime?: string; hash?: string; capturedAt?: string; error?: string };
      if (!res.ok || !data.ok || !data.dom) {
        dispatch({ type: 'snapshot/failed', error: data.error ?? 'Snapshot failed' });
        return;
      }
      const snapshot = {
        url,
        dom: data.dom,
        screenshotBase64: (data as any).screenshotBase64 ?? '',
        screenshotRef: (data as any).screenshotRef ?? null,
        runtime: data.runtime ?? state.draft.runtime,
        hash: data.hash ?? '',
        capturedAt: data.capturedAt ?? new Date().toISOString(),
      };
      dispatch({ type: 'snapshot/succeeded', snapshot: snapshot as unknown as any });
      dispatch({ type: 'pageHtml/set', html: data.dom });
      const localResults = evaluateAllSelectorsLocally(data.dom, state.draft, ALL_STANDARD_FIELDS as FieldDefinition[]);
      for (const [key, evalResult] of Object.entries(localResults)) {
        dispatch({ type: 'field/selectorEvaluated', key, result: evalResult });
      }
    } catch (err) {
      dispatch({ type: 'snapshot/failed', error: err instanceof Error ? err.message : 'Snapshot failed' });
    }
  }, [state.draft.productUrl, state.draft.runtime, state.draft])

  // ── Selector update ─────────────────────────────────────────────────────
  const updateSelector = useCallback(
    (key: string, selector: string) => {
      dispatch({ type: 'field/selectorChanged', key, selector });

      // Locally evaluate if pageHtml is available.
      if (state.pageHtml) {
        const fieldDef = getFieldDefinition(key);
        if (fieldDef) {
          const result = evaluateSelectorLocally(state.pageHtml, selector, fieldDef);
          dispatch({ type: 'field/selectorEvaluated', key, result });
        }
      }
    },
    [state.pageHtml],
  );

  // ── Title optional operations ───────────────────────────────────────────
  const addTitleOptionalSelector = useCallback(
    (selector?: string) => {
      dispatch({ type: 'titleOptional/add', selector: selector ?? '' });
    },
    [],
  );

  const updateTitleOptionalSelector = useCallback(
    (index: number, selector: string) => {
      dispatch({ type: 'titleOptional/update', index, selector });
    },
    [],
  );

  const removeTitleOptionalSelector = useCallback(
    (index: number) => {
      dispatch({ type: 'titleOptional/remove', index });
    },
    [],
  );

  // paste-HTML generator deleted (e07s03) — local DOMParser eval stays as instant preview — not evidence (see captureSnapshot comment).

  // ── Custom field operations ─────────────────────────────────────────────
  const addCustomField = useCallback((name: string) => {
    dispatch({ type: 'customField/add', key: name });
  }, []);

  const removeCustomField = useCallback((key: string) => {
    dispatch({ type: 'customField/remove', key });
  }, []);

  // ── Preview ─────────────────────────────────────────────────────────────
  const runPreview = useCallback(async () => {
    dispatch({ type: 'preview/start' });
    try {
      const payload = draftToTestPayload(state.draft);
      const result = await testExtractorProfile(payload);

      if (result.success) {
        dispatch({ type: 'preview/succeeded', extracted: result.extracted });
      } else {
        dispatch({ type: 'preview/failed', error: 'Preview returned no data' });
      }
    } catch (err) {
      dispatch({
        type: 'preview/failed',
        error: err instanceof Error ? err.message : 'Preview failed',
      });
    }
  }, [state.draft]);

  // ── Sample operations ───────────────────────────────────────────────────
  const addSample = useCallback((url: string) => {
    const sample: ValidationSample = {
      id: generateId(),
      url,
      confirmed: false,
    };
    dispatch({ type: 'sample/add', sample });
  }, []);

  const updateSample = useCallback(
    (id: string, patch: Partial<ValidationSample>) => {
      dispatch({ type: 'sample/update', id, patch });
    },
    [],
  );

  const removeSample = useCallback((id: string) => {
    dispatch({ type: 'sample/remove', id });
  }, []);

  // ── Validation ──────────────────────────────────────────────────────────
  const runValidation = useCallback(async () => {
    if (state.samples.length === 0) return;

    dispatch({ type: 'validation/start' });
    try {
      const payload = draftToValidatePayload(state.draft, state.samples);
      const result = await validateProfileDraft(payload);

      if (result.ok && result.data) {
        dispatch({ type: 'validation/succeeded', validation: result.data });

        // Update field statuses based on validation.
        for (const fieldKey of Object.keys(state.fields)) {
          const localResult = state.fields[fieldKey];
          const status = deriveFieldStatus({
            selector: localResult.selector,
            localResult: undefined,
            previewResult: state.extractionPreview,
            validation: result.data,
            fieldKey,
          }) as 'unassigned' | 'assigned' | 'tested' | 'warning' | 'failed' | 'validated';
          dispatch({
            type: 'field/selectorEvaluated',
            key: fieldKey,
            result: {
              status,
              extractedPreview: localResult.extractedPreview ?? null,
              matchCount: localResult.matchCount ?? 0,
              warnings: localResult.warnings,
            },
          });
        }
      } else {
        dispatch({
          type: 'validation/failed',
          error: result.error ?? 'Validation failed',
        });
      }
    } catch (err) {
      dispatch({
        type: 'validation/failed',
        error: err instanceof Error ? err.message : 'Validation failed',
      });
    }
  }, [state.draft, state.samples, state.fields, state.extractionPreview]);

  // ── Save ────────────────────────────────────────────────────────────────
  const saveProfile = useCallback(async () => {
    if (!state.draft.domain.trim()) {
      dispatch({ type: 'save/failed', error: 'Domain is required.' });
      return;
    }
    dispatch({ type: 'save/start' });
    try {
      // The version row carries the COMPLETE executable configuration
      // (core + custom selectors + variant strategy + runtime + supporting
      // settings) plus the version-bound explicit image-review attestation.
      // Activation rebuilds the profile from this same snapshot, so saving
      // here never discards configured custom-field or variant behavior.
      const sampleIds = state.samples.map(s => s.id);
      const versionPayload = draftToVersionPayload(state.draft, state.imagePreviewsReviewed, { sampleCount: sampleIds.length });
      const snapHash = (state.snapshot as any)?.hash as string | undefined;
      const artifactHashes = snapHash ? [snapHash].sort() : sampleIds.slice().sort();
      const provenance = { provider: 'client', model: 'manual', configId: 'manual' };
      const res = await fetch('/api/profile-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: versionPayload.domain, selectors: versionPayload.selectors, runtime: versionPayload.runtime, sampleIds, artifactHashes, validationSummary: versionPayload.validationSummary, provenance, approver: 'operator', reason: 'save' }),
      });
      const data = await res.json().catch(() => ({})) as any;
      if (!res.ok || !data?.id) {
        dispatch({ type: 'save/failed', error: data?.error ?? 'Version create failed' });
        return;
      }
      const payload = draftToSavePayload(state.draft);
      const legacy = await saveExtractorProfile(payload).catch(() => null);
      dispatch({ type: 'save/succeeded', profile: (legacy as any)?.profile ?? { id: data.id, domain: state.draft.domain } });
      (props.onSaved as any)?.(data);
    } catch (err) {
      dispatch({ type: 'save/failed', error: err instanceof Error ? err.message : 'Save failed' });
    }
  }, [state.draft, state.samples, state.snapshot, state.imagePreviewsReviewed, props.onSaved]);

  // ── Image review attestation ──────────────────────────────────────────
  const setImageReviewed = useCallback((reviewed: boolean) => {
    dispatch({ type: 'imageReview/set', reviewed });
  }, []);

  // ── Reset ───────────────────────────────────────────────────────────────
  const resetDraft = useCallback(() => {
    dispatch({ type: 'draft/reset' });
  }, []);

  // ── Selector Generation ────────────────────────────────────────────────
  const generateSelectors = useCallback(async () => {
    const snapshot = state.snapshot as unknown as { dom?: string; htmlRef?: string; jsonLd?: unknown[]; embeddedProductData?: unknown[]; warnings?: unknown[] } | null;
    if (!snapshot) return;
    const dom = (snapshot as any).dom ?? (snapshot as any).htmlRef;
    if (!dom) return;
    const htmlRef = dom;

    // Build the field list from CORE_FIELDS, STANDARD_CUSTOM_FIELDS, and custom fields
    const fields: Array<{
      key: string;
      label: string;
      origin: 'core' | 'standard_custom' | 'draft_custom';
      valueType: 'text' | 'html' | 'url' | 'image' | 'list';
      multiple: boolean;
      description: string | null;
    }> = [];
    const allFieldDefs = CORE_FIELDS.concat(STANDARD_CUSTOM_FIELDS);
    for (const f of allFieldDefs) {
      const origin = f.outputTarget === 'core' ? 'core' : 'standard_custom';
      // Map fieldCatalog value types to the Zod-accepted generation value types
      const valueType = f.valueType === 'image' ? 'image' : f.valueType === 'array' ? 'list' : 'text';
      fields.push({
        key: f.key,
        label: f.label,
        origin,
        valueType,
        multiple: f.cardinality === 'multiple',
        description: null,
      });
    }

    dispatch({
      type: 'selectorGenerationStarted',
      payload: { htmlRef, requestedFieldKeys: fields.map((f) => f.key) },
    });

    try {
      const result = await generateSelectorsApi({
        htmlRef,
        sourceUrl: state.draft.productUrl,
        runtime: state.draft.runtime,
        fields,
        snapshotContext: {
          jsonLd: (snapshot as any).jsonLd ?? [],
          embeddedProductData: (snapshot as any).embeddedProductData ?? [],
          imageCandidates: (((snapshot as any).imageCandidates ?? []) as string[]).map((url: string) => ({ url }) as any),
          pageStructureSignals: [],
          warnings: (snapshot as any).warnings ?? [],
        } as any,
      });

      if (result.ok) {
        dispatch({ type: 'selectorGenerationSucceeded', payload: result.data });
      } else {
        dispatch({ type: 'selectorGenerationFailed', payload: result.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      console.error('[ProfileBuilder] Generate selectors error:', msg);
      dispatch({
        type: 'selectorGenerationFailed',
        payload: {
          code: 'INTERNAL_ERROR',
          message: msg,
          retryable: true,
        },
      });
    }
  }, [state.snapshot, state.draft.productUrl, state.draft.runtime]);

  const generateDraftFromSuite = useCallback(async (suiteUrls: string[]) => {
    if (suiteUrls.length === 0) return;
    const urls = suiteUrls.slice(0, 3);
    dispatch({ type: 'selectorGenerationStarted', payload: { htmlRef: urls[0], requestedFieldKeys: [] } });
    try {
      const captures = await fetchSuiteCaptures(urls);
      const suiteRes = await postGenerateDraft(captures, state.draft.domain);
      dispatch({ type: 'selectorGenerationSucceeded', payload: suiteRes });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Suite draft failed';
      dispatch({ type: 'selectorGenerationFailed', payload: { code: 'SUITE_FAILED', message: msg, retryable: true } });
    }
  }, [state.draft.domain]);

  const acceptSelectorSuggestion = useCallback((fieldKey: string) => {
    dispatch({ type: 'selectorSuggestionAccepted', payload: { fieldKey } });
  }, []);

  const rejectSelectorSuggestion = useCallback((fieldKey: string) => {
    dispatch({ type: 'selectorSuggestionRejected', payload: { fieldKey } });
  }, []);

  const acceptCustomFieldSuggestion = useCallback((key: string) => {
    dispatch({ type: 'customFieldSuggestionAccepted', payload: { key } });
  }, []);

  const rejectCustomFieldSuggestion = useCallback((key: string) => {
    dispatch({ type: 'customFieldSuggestionRejected', payload: { key } });
  }, []);

  // ── Category toggle ────────────────────────────────────────────────────
  const toggleCategory = useCallback((category: any) => {
    dispatch({ type: 'category/toggle', category });
  }, []);

  // ── Assemble controller (memoize for stable identity) ──────────────────
  const controller = useMemo<ProfileBuilderController>(
    () => ({
      state,

      setDomain,
      setProductUrl,
      setRuntime,
      loadProfiles,
      captureSnapshot,
      updateSelector,
      addTitleOptionalSelector,
      updateTitleOptionalSelector,
      removeTitleOptionalSelector,
      // paste-HTML generator deleted (e07s03)
      addCustomField,
      removeCustomField,
      runPreview,
      addSample,
      updateSample,
      removeSample,
      runValidation,
      saveProfile,
      setImageReviewed,
      resetDraft,
      generateSelectors,
      generateDraftFromSuite,
      acceptSelectorSuggestion,
      rejectSelectorSuggestion,
      acceptCustomFieldSuggestion,
      rejectCustomFieldSuggestion,
      toggleCategory,
    }),
    [
      state,
      setDomain,
      setProductUrl,
      setRuntime,
      loadProfiles,
      captureSnapshot,
      updateSelector,
      addTitleOptionalSelector,
      updateTitleOptionalSelector,
      removeTitleOptionalSelector,
      addCustomField,
      removeCustomField,
      runPreview,
      addSample,
      updateSample,
      removeSample,
      runValidation,
      saveProfile,
      setImageReviewed,
      resetDraft,
      generateSelectors,
      generateDraftFromSuite,
      acceptSelectorSuggestion,
      rejectSelectorSuggestion,
      acceptCustomFieldSuggestion,
      rejectCustomFieldSuggestion,
      toggleCategory,
    ],
  );

  return controller;
}
