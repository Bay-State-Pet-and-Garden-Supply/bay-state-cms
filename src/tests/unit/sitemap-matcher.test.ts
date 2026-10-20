/**
 * Unit tests for `src/onboarding/sitemap-matcher.ts` (TypeSafe closed-set
 * selection, issue #364).
 *
 * Runs under `bun test` (excluded from vitest: `bun:sqlite` in this
 * harness). Covers the deterministic passes (UPC exact, URL
 * filter, token overlap) plus the closed Choice: ID→URL mapping,
 * out-of-set/unknown answers, abstentions, low-probability,
 * single-candidate bypass, and the policy-disabled zero-transport
 * fallback. Attempted selections persist durable start/terminal rows to
 * `discovery_model_calls` (bound to the caller's discovery run), asserted
 * from the DB.
 *
 * The test harness spins up a dedicated test DB, seeds a TypeSafe
 * credential so the Choice has a dispatch route, and stubs
 * `globalThis.fetch` to capture SystemOne requests.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import type { ProviderConnection } from '../../ai/provider-connections';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import { matchSitemapUrls, extractSlug, rankSitemapCandidates } from '../../onboarding/sitemap-matcher';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createDiscoveryRun } from '../../db/repositories/onboarding-source-repo';
import { getDiscoveryModelCallsByRun } from '../../db/repositories/discovery-model-call-repo';

describe('Sitemap Matcher', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-matcher-test.db';
  let originalFetch: typeof fetch;
  let batchId: string;

  /** Bind a real discovery-run row (FK parent for durable audit) and return its id. */
  function bindDiscoveryRun(upc: string): string {
    const [item] = insertItems(batchId, [{
      name: `MATCHER ${Date.now()} ${Math.random()}`,
      upc,
      brandHint: 'mywoof',
      rowNumber: 1,
      stage: 'discovery',
    }]);
    return createDiscoveryRun(item.id, { trigger: 'automatic', upc, name: 'MATCHER' });
  }

  /** Stub the TypeSafe SystemOne transport: answer the closed Choice by key. */
  function stubSystemOneChoice(answer: {
    choice: string;
    probabilities: Record<string, number>;
    confidence: number;
  }): { calls: unknown[] } {
    const calls: unknown[] = [];
    const mock = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            sitemap_selection: {
              type: 'choice',
              choice: answer.choice,
              probabilities: answer.probabilities,
              confidence: answer.confidence,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
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
    // AI Compute isolation: a stale DB file (e.g. left by a killed `bun
    // test` process whose afterAll unlink never ran) may carry
    // provider_connections rows, workload routes, or routing defaults that
    // flip isAiComputeConfigured() on. AI Compute is authoritative once
    // configured, so reset to the pristine-install state — the seeded
    // builtins/defaults re-seed lazily via ensureSeededDefaults() and the
    // legacy api_keys chain below only resolves on pristine installs.
    getDb().run('DELETE FROM ai_workload_routes');
    getDb().run('DELETE FROM provider_connections');
    getDb().run('DELETE FROM ai_routing_defaults');
    // Seed a usable TypeSafe connection so the closed-set Choice has a
    // dispatch route; tests override fetch per-case with stubSystemOneChoice.
    const conn: ProviderConnection = {
      id: 'typesafe-jev',
      label: 'TypeSafe Jev (Cloud)',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      credential: 'fixturekey',
      trustZone: 'cloud',
      approvedHost: 'api.typesafe.ai',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 5000,
    };
    upsertProviderConnection(conn);
    insertWorkspace({
      id: 'ws-matcher-364',
      name: 'Matcher 364',
      workspacePath: '/tmp/ws-matcher-364',
      gitPath: '/tmp/ws-matcher-364/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    batchId = createBatch({ workspaceId: 'ws-matcher-364', name: 'matcher-364', fileName: 'matcher.csv', totalItems: 100 }).id;
  });

  /** TypeSafe-routed policy view (protected sitemap_selection routing). */
  function typesafeRoutedView() {
    return buildModelPolicyView(
      {
        defaultProvider: 'typesafe',
        defaultModel: 'jev-1.13.0',
        providerLocalities: { typesafe: 'cloud' },
        stageOverrides: {},
        imageDataSharing: 'local_only',
        textDataSharing: 'cloud_allowed',
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
    // Default stub: the SystemOne transport fails closed (500) so tests
    // that do not stub a Choice exercise the unresolved → ranked-retrieval
    // path with no selection.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'no stub' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    test('findUpcExactHit matches canonical GTIN zero-padding variations in sitemap URLs', async () => {
      const sitemaps = [
        'https://example.com/products/850067859598-dog-chew',
      ];
      // Search with 13-digit EAN zero-padded version
      const res = await matchSitemapUrls(sitemaps, 'Foo', null, '0850067859598', 'example.com');
      expect(res).toHaveLength(1);
      expect(res[0].matchType).toBe('upc_exact');
      expect(res[0].url).toBe('https://example.com/products/850067859598-dog-chew');
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

  test('TypeSafe selection maps the chosen ID to the exact URL with rank-only confidence (no boost)', async () => {
    const upc = '850000000000';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
      'https://mywoof.com/products/lavender-spray',
    ];

    // Closed-set Choice answers with the candidate ID; the code maps the
    // ID to the exact supplied URL.
    const { calls } = stubSystemOneChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.82, cand_1: 0.1, cand_2: 0.05, no_match: 0.02, insufficient_evidence: 0.01 },
      confidence: 0.8,
    });
    const policyView = typesafeRoutedView();

    const runId = bindDiscoveryRun(upc);
    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
      [],
      { runId, snapshotHash: 'snap-matcher-364' },
    );

    expect(calls.length).toBe(1);
    expect(result.length).toBe(1);
    expect(result[0].url).toBe(urls[0]);
    expect(result[0].matchType).toBe('llm_selected');
    expect(result[0].sourceMethod).toBe('sitemap_name');
    // Retrieval rank only: 0.7 + 0.25 * overlap. Only "poomergency" of the
    // two name tokens appears in the slug (overlap 0.5 → 0.825) — a Choice
    // probability never inflates confidence.
    expect(result[0].confidence).toBeCloseTo(0.825, 5);
    // Durable audit: one completed success row bound to the discovery run.
    expect(getDiscoveryModelCallsByRun(runId).map(r => r.status)).toEqual(['success']);
  });

  test('out-of-set Choice answer never persists a URL — ranked candidates retained', async () => {
    const upc = '850000000000';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender-balm',
    ];

    // TypeSafe answers a key outside the supplied closed set.
    stubSystemOneChoice({
      choice: 'cand_99',
      probabilities: { cand_99: 0.9, cand_0: 0.05, cand_1: 0.03, no_match: 0.01, insufficient_evidence: 0.01 },
      confidence: 0.85,
    });
    const policyView = typesafeRoutedView();

    const runId = bindDiscoveryRun(upc);
    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
      [],
      { runId, snapshotHash: 'snap-matcher-364' },
    );

    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
    // Durable audit: the attempted selection failed closed with one failed row.
    expect(getDiscoveryModelCallsByRun(runId).map(r => r.status)).toEqual(['failed']);
  });

  test('no model call for a single candidate — ordinary verification instead', async () => {
    const upc = '850067859598';
    const urls = ['https://mywoof.com/products/poomergency'];

    const { calls } = stubSystemOneChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.85,
    });
    const policyView = typesafeRoutedView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    // With only one candidate there is nothing to choose between: no model
    // call is issued and the ranked token-overlap candidate passes through
    // to ordinary verification.
    expect(calls.length).toBe(0);
    expect(result.length).toBe(1);
    expect(result[0].matchType).toBe('token_overlap');
  });

  test('arbitrary URL text in the answer is never substring-parsed into a selection', async () => {
    const upc = '850000000000';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    // The closed Choice answers with candidate IDs only. A key that is not a
    // supplied candidate ID (even one shaped like a URL) cannot persist a
    // selection — ranked retrieval candidates are retained instead.
    stubSystemOneChoice({
      choice: 'https://mywoof.com/products/lavender',
      probabilities: {
        'https://mywoof.com/products/lavender': 0.9,
        cand_0: 0.05,
        cand_1: 0.03,
        no_match: 0.01,
        insufficient_evidence: 0.01,
      },
      confidence: 0.85,
    });
    const policyView = typesafeRoutedView();

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

  test('no_match abstention retains safe ranked candidates for inspection', async () => {
    const upc = '850000000000';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    stubSystemOneChoice({
      choice: 'no_match',
      probabilities: { no_match: 0.78, cand_0: 0.1, cand_1: 0.07, insufficient_evidence: 0.05 },
      confidence: 0.75,
    });
    const policyView = typesafeRoutedView();

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
    expect(result.length).toBeGreaterThan(0);
  });

  test('low model probability never becomes a selection — ranked candidates retained', async () => {
    const upc = '850000000000';
    const urls = [
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    stubSystemOneChoice({
      choice: 'cand_1',
      probabilities: { cand_1: 0.32, cand_0: 0.3, no_match: 0.2, insufficient_evidence: 0.18 },
      confidence: 0.4,
    });
    const policyView = typesafeRoutedView();

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

  test('falls back to ranked token-overlap candidates when the provider is disabled', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];

    // Force provider-disabled by omitting the frozen policy: sitemap_selection
    // is protected, so omission fails closed to ranked retrieval with zero
    // transport — never legacy chat routing.
    const { calls } = stubSystemOneChoice({
      choice: 'cand_1',
      probabilities: { cand_1: 0.8, cand_0: 0.1, cand_2: 0.05, no_match: 0.03, insufficient_evidence: 0.02 },
      confidence: 0.8,
    });

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
    expect(result[0].sourceMethod).toBe('sitemap_name');
  });

  test('an explicit null policy disables TypeSafe sitemap selection with zero transport', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/widget',
      'https://mywoof.com/products/poomergency',
      'https://mywoof.com/products/lavender',
    ];
    const { calls } = stubSystemOneChoice({
      choice: 'cand_1',
      probabilities: { cand_1: 0.8, cand_0: 0.1, cand_2: 0.05, no_match: 0.03, insufficient_evidence: 0.02 },
      confidence: 0.8,
    });

    // Product Intelligence passes modelPolicy:null so sitemap selection is
    // disabled behind the PI gateway (issue #17 pass 1b) — the matcher must
    // fall back to token overlap with zero transport.
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
    // No policy at all (omitted): sitemap_selection is protected, so the
    // omission must fail closed to token overlap, never legacy routing.
    const sysChoice = stubSystemOneChoice({
      choice: 'cand_1',
      probabilities: { cand_1: 0.8, cand_0: 0.1, cand_2: 0.05, no_match: 0.03, insufficient_evidence: 0.02 },
      confidence: 0.8,
    });
    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
    );

    expect(sysChoice.calls.length).toBe(0);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/poomergency');
  });

  test('unique exact identity bypasses the Choice with zero transport', async () => {
    const upc = '850067859598';
    const urls = [
      'https://mywoof.com/products/woof-poomergency-lavender',
      'https://mywoof.com/products/woof-poomergency',
      'https://mywoof.com/products/woof-lavender',
    ];
    const sysChoice = stubSystemOneChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, cand_1: 0.05, cand_2: 0.03, no_match: 0.01, insufficient_evidence: 0.01 },
      confidence: 0.9,
    });
    const policyView = typesafeRoutedView();

    const result = await matchSitemapUrls(
      urls,
      'WOOF POOMERGENCY LAVENDER',
      null,
      upc,
      'mywoof.com',
      null,
      policyView,
    );

    // One candidate holds the full name-token overlap; the Choice is
    // bypassed (verified_unique_identity) and ranked retrieval is retained.
    expect(sysChoice.calls.length).toBe(0);
    expect(result.every(r => r.matchType === 'token_overlap')).toBe(true);
    expect(result[0].url).toBe('https://mywoof.com/products/woof-poomergency-lavender');
  });
  // ── extractSlug regression: fast string slicing vs WHATWG URL ─────────
  // Contract: sitemap <loc> candidates are absolute URLs (sitemaps.org spec).
  // The optimized `extractSlug` uses manual string slicing for speed and is
  // only guaranteed for absolute http(s):// URLs. For relative /
  // protocol-relative / malformed inputs the behavior intentionally diverges
  // from `new URL(...)` — those inputs never occur in the sitemap pipeline.
  describe('rankSitemapCandidates — shared production ranking (v2 eval uses the same path)', () => {
    const urls = (n: number, prefix = 'https://brand.example/products/item') =>
      Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
    const rank = (us: string[], name = 'Acme Chicken Dinner 5 lb', upc = '000000000000', domain = 'brand.example') =>
      rankSitemapCandidates(us, name, null, upc, domain);

    test('UPC exact hit short-circuits with upcExact=true and no other candidates', () => {
      const out = rank(['https://brand.example/a', 'https://brand.example/p/072705114265', 'https://brand.example/b'], 'Acme X', '072705114265');
      expect(out).toEqual([{ url: 'https://brand.example/p/072705114265', overlapRatio: 1, overlapMatches: 1, upcExact: true }]);
    });

    test('non-product URLs are filtered before scoring', () => {
      const out = rank([
        'https://brand.example/about-us',
        'https://brand.example/products/acme-chicken-dinner',
      ], 'Acme Chicken Dinner');
      expect(out.map(c => c.url)).toEqual(['https://brand.example/products/acme-chicken-dinner']);
    });

    test('empty sitemap, no usable tokens, and no positive overlap all return []', () => {
      expect(rank([])).toEqual([]);
      expect(rank(['https://brand.example/products/x'], '', '000')).toEqual([]);
      expect(rank(['https://brand.example/products/completely-unrelated'], 'Acme Chicken Dinner')).toEqual([]);
    });

    test('overlap orders descending and the set is bounded at ten', () => {
      const out = rank([
        ...urls(12, 'https://brand.example/products/acme-chicken-dinner'),
        'https://brand.example/products/unrelated-xyz',
      ]);
      expect(out.length).toBeLessThanOrEqual(10);
      const ratios = out.map(c => c.overlapRatio);
      expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
      expect(ratios[0]).toBeGreaterThan(0);
    });

    test('single ranked candidate is the deterministic-bypass shape (no model needed downstream)', () => {
      const out = rank(['https://brand.example/products/acme-chicken-dinner-5-lb'], 'Acme Chicken Dinner 5 lb');
      expect(out).toHaveLength(1);
      expect(out[0].overlapRatio).toBeGreaterThan(0);
      expect(out[0].upcExact).toBe(false);
    });

    test('off-domain URLs with positive overlap survive ranking (domain gate lives in the selector, not ranking)', () => {
      const out = rank(['https://chewy.example/dp/acme-chicken-dinner-5-lb'], 'Acme Chicken Dinner 5 lb', '000000000000', 'brand.example');
      // Ranking is domain-blind by design: a positive-overlap off-domain
      // candidate MUST survive ranking so the selector's approved-domain
      // gate has something to refuse. Filtering here would hide the case.
      expect(out).toHaveLength(1);
      expect(out[0].url).toBe('https://chewy.example/dp/acme-chicken-dinner-5-lb');
      expect(out[0].overlapRatio).toBeGreaterThan(0);
    });
  });

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
      // UPC with dashes should match stripped digits via includes fast path
      const urls = ['https://mywoof.com/p/850067859598.html', 'https://mywoof.com/products/other'];
      const result = await matchSitemapUrls(urls, 'Other Product', null, '850-0678-59598', 'mywoof.com');
      expect(result.some(r => r.url === urls[0])).toBe(true);
    });
  });
});
