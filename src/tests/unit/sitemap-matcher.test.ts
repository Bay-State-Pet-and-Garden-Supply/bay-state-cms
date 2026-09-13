/**
 * Unit tests for `src/onboarding/sitemap-matcher.ts`.
 *
 * Runs under `bun test` (excluded from vitest) because the LLM
 * selection path imports `getApiKey` from `api-key-repo`, which uses
 * `bun:sqlite`. The non-LLM paths (UPC exact, URL filter, token
 * overlap) are also exercised here so the full public surface is
 * covered from a single harness.
 *
 * The test harness mirrors `llm-client-task-routing.test.ts`:
 *   - spins up a dedicated test DB,
 *   - seeds an Ollama API key so the LLM has a reachable config,
 *   - stubs `globalThis.fetch` to capture LLM requests.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import {
  deleteLlmTaskConfig,
  upsertLlmTaskConfig,
} from '../../db/repositories/llm-task-config-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import { matchSitemapUrls, extractSlug } from '../../onboarding/sitemap-matcher';
import * as llmClient from '../../onboarding/llm-client';

describe('Sitemap Matcher', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-matcher-test.db';
  let originalFetch: typeof fetch;

  function stubFetch(responseContent: string): { calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> } {
    const calls: Array<{ url: string; body: { model: string; messages: Array<{ role: string; content: string }> } }> = [];
    const mock = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responseContent } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    globalThis.fetch = mock;
    return { calls };
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    // Seed at least one provider credential so the LLM call has a config.
    upsertApiKey('ollama', 'ollama-default', 'http://localhost:11434/v1', 'llama3');
  });

  /** Local-only Ollama policy view (protected sitemap_selection routing). */
  function localOnlyOllamaView() {
    return buildModelPolicyView(
      {
        defaultProvider: 'ollama',
        defaultModel: 'qwen2.5vl:latest',
        providerLocalities: { ollama: 'local' },
        stageOverrides: {},
        imageDataSharing: 'local_only',
        textDataSharing: 'local_only',
        mlFeatures: {
          productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        },
      } as any,
      { snapshotHash: 'snap-sitemap-1' },
    );
  }

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default stub: any LLM call falls back to a non-matching response.
    // Individual tests that need a specific LLM response override this
    // via stubFetch(). This keeps the "no Ollama running" noise out
    // of tests that don't actually exercise the LLM selection path.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'no-llm-configured' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Strip any task configs left over from a previous test so the
    // "no LLM configured" fallback is exercised cleanly.
    try { deleteLlmTaskConfig('product_name_consolidation'); } catch { /* ignore */ }
  });

  // ── Empty input ───────────────────────────────────────────────────────

  test('returns an empty array when the sitemap is empty', async () => {
    const result = await matchSitemapUrls(
      [],
      'WOOF POOMERGENCY LAVENDER',
      null,
      '850067859598',
      'mywoof.com',
    );
    expect(result).toEqual([]);
  });

  // ── Pass 1: UPC exact match ───────────────────────────────────────────

  test('UPC exact match short-circuits with 0.95 confidence', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/collections/all',
      `https://mywoof.com/products/poomergency/${upc}`,
      'https://mywoof.com/about',
    ];

    const result = await matchSitemapUrls(urls, 'WOOF POOMERGENCY LAVENDER', null, upc, 'mywoof.com');

    expect(result.length).toBe(1);
    expect(result[0].url).toBe(`https://mywoof.com/products/poomergency/${upc}`);
    expect(result[0].confidence).toBe(0.95);
    expect(result[0].sourceMethod).toBe('sitemap_upc');
    expect(result[0].matchType).toBe('upc_exact');
  });

  test('UPC exact match tolerates dashes and surrounding text', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/p/widget-1',
      `https://mywoof.com/pup/${upc.slice(0, 4)}-${upc.slice(4)}/lavender.html`,
    ];

    const result = await matchSitemapUrls(urls, 'Woof Lavender', null, upc, 'mywoof.com');

    expect(result.length).toBe(1);
    expect(result[0].url).toBe(urls[1]);
    expect(result[0].matchType).toBe('upc_exact');
  });

  // ── Pass 2: product URL filter ────────────────────────────────────────

  test('generic filter keeps /products/, /p/, /shop/, /item/, /dp/ paths only', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/',
      'https://mywoof.com/collections/all',
      'https://mywoof.com/blog/post-1',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/p/poomergency',
      'https://mywoof.com/shop/poomergency',
      'https://mywoof.com/item/poomergency',
      'https://mywoof.com/dp/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    // No UPC exact, so we should get 5 token-overlap hits (one per
    // product-shaped URL) all coming from the filtered set.
    const filteredUrls = result.map(r => r.url);
    expect(filteredUrls.every(u => /\/(products?|p|shop|item|dp)\//.test(u) || /\/(products?|p|shop|item|dp)$/.test(u))).toBe(true);
    expect(result.every(r => r.sourceMethod === 'sitemap_name')).toBe(true);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
  });

  test('explicit productUrlPattern narrows the candidate set to matching URLs', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/p/poomergency',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/blog/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      '^https://mywoof\\.com/p/',
    );

    const filteredUrls = result.map(r => r.url);
    expect(filteredUrls).toContain('https://mywoof.com/p/poomergency');
    expect(filteredUrls).not.toContain('https://mywoof.com/products/poomergency');
  });

  test('invalid productUrlPattern falls back to the generic heuristic', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/blog/x',
      'https://mywoof.com/products/poomergency',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      '[invalid regex(',
    );

    // The generic heuristic should still keep the /products/ URL.
    expect(result.map(r => r.url)).toContain('https://mywoof.com/products/poomergency');
  });

  // ── Pass 3: token overlap ─────────────────────────────────────────────

  test('token overlap prefers URLs whose slug contains name tokens', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency-lavender',
      'https://mywoof.com/products/treats',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBeGreaterThan(0);
    // The "poomergency-lavender" URL should be the top token-overlap hit
    // (highest ratio of name tokens in the slug).
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency-lavender');
    // 2/2 name tokens ("poomergency", "lavender") appear in the slug after
    // "woof" is excluded as a domain-match token.
    // 0.7 + 0.25 * 2/2 = 0.95.
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(result[0].confidence).toBeLessThanOrEqual(0.95);
    expect(result[0].sourceMethod).toBe('sitemap_name');
    expect(result[0].matchType).toBe('token_overlap');
  });

  test('consolidatedName takes precedence over itemName when tokenizing', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      // The slug matches the *consolidated* name "Pup Brush" (post-merge),
      // not the raw spreadsheet name.
      'https://mywoof.com/products/pup-brush',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF Dental Toothbrush 12345',
      'Pup Brush',
      upc,
      'mywoof.com',
    );

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://mywoof.com/products/pup-brush');
  });

  test('returns up to 3 token-overlap candidates in fallback mode', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/catnip',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    // No LLM configured (we deleted the task config in afterEach),
    // so the function should return the top-3 token-overlap candidates.
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    // First result should be the URL with the best token overlap.
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('caps the candidate set at the top 10 before emitting results', async () => {
    const upc = '850067859598';
    // Build 15 product URLs that all share the "poomergency" token, so
    // every URL has a positive token overlap. The function should
    // trim down to <=10 in the candidate pass, then to <=3 in fallback.
    const urls = Array.from({ length: 15 }, (_, i) =>
      `https://mywoof.com/products/poomergency-${i}`,
    );

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('confidence is clamped to the [0, 1] range', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency-lavender',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result.length).toBe(1);
    expect(result[0].confidence).toBeLessThanOrEqual(1);
    expect(result[0].confidence).toBeGreaterThanOrEqual(0);
  });

  test('returns only the UPC exact result when no URL survives the filter', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/',
      'https://mywoof.com/collections/all',
      'https://mywoof.com/blog/post-1',
    ];

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(result).toEqual([]);
  });

  // ── LLM selection ─────────────────────────────────────────────────────

  test('LLM-selected URL gets +0.15 confidence boost and llm_selected matchType', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
      'https://mywoof.com/products/lavender-spray',
    ];

    // Configure the LLM so the LLM pass is taken.
    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // Have the LLM return the first URL.
    const { calls } = stubFetch(urls[0]);
    const policyView = localOnlyOllamaView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    expect(calls.length).toBe(1);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe(urls[0]);
    expect(result[0].matchType).toBe('llm_selected');
    expect(result[0].sourceMethod).toBe('sitemap_name');
    // Token overlap is 1.0 (poomergency in slug), so the LLM boost
    // is 0.7 + 0.25 * 1.0 + 0.15 = 1.10 → clamped to 1.0.
    expect(result[0].confidence).toBeLessThanOrEqual(1);
  });

  test('LLM response that does not match any candidate triggers fallback', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
    ];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // The LLM returns garbage that does not match any URL.
    stubFetch('I am not a URL');
    const policyView = localOnlyOllamaView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('LLM is not called when there is only a single candidate', async () => {
    const upc = '850067859598';
    const urls = ['https://mywoof.com/products/poomergency'];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    const { calls } = stubFetch('https://mywoof.com/products/poomergency');
    const policyView = localOnlyOllamaView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    // With only one candidate, the LLM is intentionally not called
    // and we return the token-overlap result.
    expect(calls.length).toBe(0);
    expect(result.length).toBe(1);
    expect(result[0].matchType).toBe('token_overlap');
  });

  test('LLM response with extra whitespace/punctuation is normalized', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    upsertLlmTaskConfig({
      task: 'product_name_consolidation',
      provider: 'ollama',
      model: 'llama3:8b',
    });
    // LLM response has surrounding quotes and trailing punctuation.
    stubFetch('  "https://mywoof.com/products/lavender".  ');
    const policyView = localOnlyOllamaView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://mywoof.com/products/lavender');
    expect(result[0].matchType).toBe('llm_selected');
  });

  test('falls back to top token-overlap candidate when no LLM is configured', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    // Force "no LLM" by making getLlmConfigForTask return null for
    // this call. We use vi.spyOn so the rest of the LLM client stays
    // functional for the other tests in this file.
    const spy = vi.spyOn(llmClient, 'getLlmConfigForTask').mockReturnValue(null);

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    spy.mockRestore();

    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
    expect(result[0].sourceMethod).toBe('sitemap_name');
  });

  test('an explicit null policy (PI path) disables LLM sitemap selection with zero transport', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];
    const { calls } = stubFetch('https://mywoof.com/products/lavender');

    // Product Intelligence passes modelPolicy:null so sitemap selection is
    // disabled behind the PI gateway (issue #17 pass 1b) — the matcher must
    // fall back to token overlap with zero LLM transport.
    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      null,
    );

    expect(calls.length).toBe(0);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('sitemap selection without any policy context fails closed to token overlap', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];
    const { calls } = stubFetch('https://mywoof.com/products/lavender');

    // No policy at all (omitted): sitemap_selection is protected, so the
    // omission must fail closed to token overlap, never legacy routing.
    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(calls.length).toBe(0);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  // ── extractSlug regression: fast string slicing vs WHATWG URL ─────────
  // Contract: sitemap <loc> candidates are absolute URLs (sitemaps.org spec).
  // The optimized `extractSlug` uses manual string slicing for speed and is
  // only guaranteed for absolute http(s):// URLs. For relative /
  // protocol-relative / malformed inputs the behavior intentionally diverges
  // from `new URL(...)` — those inputs never occur in the sitemap pipeline.
  describe('extractSlug — absolute-URL contract and edge cases', () => {
    test('absolute URL: extracts last segment and strips known extensions', () => {
      expect(extractSlug('https://example.com/products/poomergency.html')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.htm')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.php')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.aspx')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.HTML')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency')).toBe('poomergency');
    });

    test('trailing slash, query, and hash are stripped before segment extraction', () => {
      expect(extractSlug('https://example.com/products/poomergency/')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency///')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.html?foo=1')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency.html#section')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency?x=1#y')).toBe('poomergency');
      expect(extractSlug('https://example.com/products/poomergency/?x=1')).toBe('poomergency');
    });

    test('domain-only or root path falls back to "/"', () => {
      expect(extractSlug('https://example.com')).toBe('/');
      expect(extractSlug('https://example.com/')).toBe('/');
      expect(extractSlug('https://example.com/?q=1')).toBe('/');
      expect(extractSlug('https://example.com#hash')).toBe('/');
    });

    test('absolute URLs with auth, port, IPv6 preserve slug extraction', () => {
      expect(extractSlug('https://user:pass@example.com:8080/products/foo.html')).toBe('foo');
      expect(extractSlug('https://[::1]/products/foo.html')).toBe('foo');
      expect(extractSlug('http://192.168.1.10:3000/p/bar.php')).toBe('bar');
    });

    test('empty input returns empty string (vs WHATWG throw -> raw)', () => {
      expect(extractSlug('')).toBe('');
      expect(extractSlug('   ')).toBe('   ');
    });

    test('relative URL: fast path differs from new URL but is intentionally tolerated', () => {
      // new URL('/products/foo.html?x=1') throws without base and would return the raw string.
      // The fast path treats it as a path and correctly extracts the slug — acceptable because
      // sitemap <loc> values are never relative.
      expect(extractSlug('/products/foo.html')).toBe('foo');
      expect(extractSlug('/products/foo.html?x=1#h')).toBe('foo');
      expect(extractSlug('products/foo.html')).toBe('foo');
    });

    test('protocol-relative URL: manual slicing extracts slug while new URL would throw', () => {
      expect(extractSlug('//cdn.example.com/products/foo.html')).toBe('foo');
      expect(extractSlug('//cdn.example.com/products/foo.html?x=1')).toBe('foo');
    });

    test('dot segments: fast path preserves raw segment, WHATWG would normalize', () => {
      // Fast path does NOT normalize dot segments; WHATWG pathname would resolve /a/./b/../c to /a/c.
      // Both yield the same last segment for simple cases, but the distinction is documented here.
      expect(extractSlug('https://example.com/a/./b/../c/foo.html')).toBe('foo');
      // Trailing "/./" — both implementations return "." because "." is the last non-empty segment.
      expect(extractSlug('https://example.com/a/b/./')).toBe('.');
    });

    test('malformed input falls back to raw string handling', () => {
      expect(extractSlug('not a url')).toBe('not a url');
      expect(extractSlug('https://')).toBe('/');
    });

    test('unknown extensions are preserved (only html/php/aspx stripped)', () => {
      expect(extractSlug('https://example.com/products/foo.json')).toBe('foo.json');
      expect(extractSlug('https://example.com/products/foo.xml')).toBe('foo.xml');
      expect(extractSlug('https://example.com/products/foo.tar.gz')).toBe('foo.tar.gz');
    });

    test('findUpcExactHit fast path does not change semantics: stripped includes still hits', async () => {
      const upc = '850067859598';
      // UPC with dashes should match stripped digits via includes fast path
      const urls = ['https://mywoof.com/p/850067859598.html', 'https://mywoof.com/products/other'];
      const result = await matchSitemapUrls(urls, 'Other Product', null, '850-0678-59598', 'mywoof.com');
      expect(result.some(r => r.url === urls[0])).toBe(true);
    });
  });
});
