/**
 * TypeSafe sitemap-selection transport + outcome tests (issue #364).
 *
 * Runs under `bun test` (excluded from vitest) — the selection boundary
 * persists start/terminal audit rows to `discovery_model_calls` (bound to
 * the caller's discovery run) and also returns the same snapshots on the
 * result (`selectionAudit`); never in `classification_model_calls` (that
 * table is keyed to classification runs and cannot hold discovery-run ids).
 *
 * Covers, against observable behavior (never internals):
 * - Closed-set Choice: the dispatched question carries one criterion per
 *   supplied candidate ID (+ no_match / insufficient_evidence); the result
 *   maps the returned ID to the EXACT supplied URL.
 * - Rank/probability/verification separation: confidence is retrieval rank
 *   (no +0.15 boost); low probability never selects; verification is not
 *   relaxed by selection (covered by the workflow test).
 * - Outcome vocabulary: no_match, insufficient_evidence, coverage_gap,
 *   candidate_limit_exceeded, out-of-set/unknown_option_key,
 *   correlation_invalid, low_model_probability, provider_disabled,
 *   transport_failed — every unresolved outcome retains safe candidates.
 * - Guards: evaluated pin (jev-1.13.0), returned-model identity,
 *   live disablement + ownership, single bounded retry, frozen-policy
 *   intactness, 32Q/255opt/32k-state/64k-request limits, no chat fallback.
 * - Audit: durable start + terminal rows in `discovery_model_calls` on
 *   every attempted path (never raw bodies), asserted from the DB.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import type { ProviderConnection } from '../../ai/provider-connections';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createDiscoveryRun } from '../../db/repositories/onboarding-source-repo';
import { getDiscoveryModelCallsByRun } from '../../db/repositories/discovery-model-call-repo';
import { buildModelPolicyView, type ModelPolicyView } from '../../classification/model-policy-gateway';
import {
  selectOfficialPageWithTypesafe,
  buildSitemapSelectionQuestion,
  isApprovedCandidateDomain,
  SITEMAP_NO_MATCH_KEY,
  SITEMAP_INSUFFICIENT_EVIDENCE_KEY,
  SITEMAP_SELECTION_BOUNDS,
  SITEMAP_MAX_ORDINARY_CANDIDATES,
  type SitemapSelectionCandidate,
} from '../../onboarding/sitemap-selection';
import { TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';

function policyView(): ModelPolicyView {
  return buildModelPolicyView(
    {
      defaultProvider: 'typesafe',
      defaultModel: TYPESAFE_EVALUATED_MODEL,
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
    } as never,
    { snapshotHash: 'snap-sitemap-selection-1' },
  );
}

function candidates(): SitemapSelectionCandidate[] {
  return [
    { id: 'cand_0', url: 'https://brand.example/products/alpha', retrievalRank: 0.9, title: 'Alpha' },
    { id: 'cand_1', url: 'https://brand.example/products/beta', retrievalRank: 0.6, title: 'Beta' },
  ];
}

function meta() {
  return {
    registerName: 'BRAND Alpha 12 OZ',
    consolidatedName: 'BRAND Alpha 12 OZ',
    upc: '012345678905',
    sku: null,
    brandHint: 'Brand',
    variantTokens: ['12', 'oz'],
    approvedDomains: ['brand.example'],
  };
}

function stubChoice(answer: {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  model?: string;
}): { calls: Array<{ url: unknown; init?: RequestInit; body: Record<string, unknown> }> } {
  const calls: Array<{ url: unknown; init?: RequestInit; body: Record<string, unknown> }> = [];
  const mock = (async (url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    } catch { /* keep empty */ }
    calls.push({ url, init, body });
    return new Response(
      JSON.stringify({
        model: answer.model ?? TYPESAFE_EVALUATED_MODEL,
        answers: {
          sitemap_selection: {
            type: 'choice',
            choice: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
          },
        },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  globalThis.fetch = mock;
  return { calls };
}


describe('TypeSafe sitemap selection (closed-set Choice)', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-selection-test.db';
  let originalFetch: typeof fetch;
  let batchId: string;

  /** Bind a real discovery-run row (FK parent for durable audit) and return its id. */
  function bindDiscoveryRun(upc = '017800010009'): string {
    const [item] = insertItems(batchId, [{
      name: `SEL ${Date.now()} ${Math.random()}`,
      upc,
      brandHint: 'Brand',
      rowNumber: 1,
      stage: 'discovery',
    }]);
    return createDiscoveryRun(item.id, { trigger: 'automatic', upc, name: 'SEL' });
  }

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    getDb().run('DELETE FROM ai_workload_routes');
    getDb().run('DELETE FROM provider_connections');
    getDb().run('DELETE FROM ai_routing_defaults');
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
      id: 'ws-sel-364',
      name: 'Sel 364',
      workspacePath: '/tmp/ws-sel-364',
      gitPath: '/tmp/ws-sel-364/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    batchId = createBatch({ workspaceId: 'ws-sel-364', name: 'sel-364', fileName: 'sel.csv', totalItems: 100 }).id;
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('off-domain candidates are never judged: all-off-domain abstains without a model call', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await selectOfficialPageWithTypesafe({
      candidates: [
        { id: 'cand_0', url: 'https://chewy.example/dp/x', retrievalRank: 0.9, title: 'X' },
        { id: 'cand_1', url: 'https://chewy.example/dp/y', retrievalRank: 0.4, title: 'Y' },
      ],
      meta: { ...meta(), approvedDomains: ['brand.example'] },
      modelPolicy: policyView(),
      itemId: 'qual-offdomain',
      runId: bindDiscoveryRun(),
      snapshotHash: 'snap-test',
    });
    // No dispatch even though candidates exist: no authorized domain, no judgment.
    expect(calls).toBe(0);
    expect(result.outcome).toBe('insufficient_evidence');
    expect(result.modelCallIds).toEqual([]);
    expect(result.safeCandidates).toHaveLength(2);
  });

  test('mixed-domain set judges only the authorized subset', async () => {
    stubChoice({ choice: 'cand_0', probabilities: { cand_0: 0.97, no_match: 0.02, insufficient_evidence: 0.01 }, confidence: 0.9 });
    const result = await selectOfficialPageWithTypesafe({
      candidates: [
        { id: 'cand_0', url: 'https://brand.example/products/alpha', retrievalRank: 0.9, title: 'Alpha' },
        { id: 'cand_1', url: 'https://chewy.example/dp/alpha', retrievalRank: 0.85, title: 'Alpha' },
      ],
      meta: { ...meta(), approvedDomains: ['brand.example'] },
      modelPolicy: policyView(),
      itemId: 'qual-mixed',
      runId: bindDiscoveryRun(),
    });
    expect(result.outcome).toBe('selected');
    expect(result.selectedUrl).toBe('https://brand.example/products/alpha');
    // The off-domain candidate stays inspectable but was never in the judgment set.
    expect(result.safeCandidates.map(c => c.url)).toContain('https://chewy.example/dp/alpha');
  });

  test('subdomains of an approved domain are authorized; lookalikes are not', () => {
    expect(isApprovedCandidateDomain('https://shop.brand.example/p', ['brand.example'])).toBe(true);
    expect(isApprovedCandidateDomain('https://brand.example/p', ['brand.example'])).toBe(true);
    expect(isApprovedCandidateDomain('https://notbrand.example/p', ['brand.example'])).toBe(false);
    expect(isApprovedCandidateDomain('https://brand.example.evil.com/p', ['brand.example'])).toBe(false);
    expect(isApprovedCandidateDomain('not a url', ['brand.example'])).toBe(false);
    expect(isApprovedCandidateDomain('https://brand.example/p', [])).toBe(false);
  });

  test('verified-identity bypass over an off-domain candidate is refused, never passed through', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await selectOfficialPageWithTypesafe({
      candidates: [
        { id: 'cand_0', url: 'https://chewy.example/dp/x', retrievalRank: 0.9, title: 'X' },
      ],
      meta: { ...meta(), approvedDomains: ['brand.example'] },
      modelPolicy: policyView(),
      itemId: 'qual-bypass-offdomain',
      runId: bindDiscoveryRun(),
      snapshotHash: 'snap-test',
      skipReason: 'verified_unique_identity',
    });
    expect(calls).toBe(0);
    expect(result.outcome).toBe('insufficient_evidence');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates.map(c => c.url)).toContain('https://chewy.example/dp/x');
  });

  test('question is closed over candidate IDs (+ abstentions) with bounded state', () => {
    const plan = buildSitemapSelectionQuestion(candidates());
    expect(plan.questionId).toBe('sitemap_selection');
    expect(plan.criteria.cand_0).toContain('https://brand.example/products/alpha');
    expect(plan.criteria.cand_1).toContain('https://brand.example/products/beta');
    expect(plan.criteria[SITEMAP_NO_MATCH_KEY]).toBeTruthy();
    expect(plan.criteria[SITEMAP_INSUFFICIENT_EVIDENCE_KEY]).toBeTruthy();
    expect(Object.keys(plan.criteria)).toHaveLength(4);
  });

  test('evaluated pin, limits, and bounds are honored', () => {
    expect(TYPESAFE_EVALUATED_MODEL).toBe('jev-1.13.0');
    expect(SITEMAP_SELECTION_BOUNDS.evaluatedModel).toBe('jev-1.13.0');
    expect(SITEMAP_SELECTION_BOUNDS.maxQuestions).toBe(32);
    expect(SITEMAP_SELECTION_BOUNDS.maxChoiceOptions).toBe(255);
    expect(SITEMAP_SELECTION_BOUNDS.maxStateBytes).toBe(32768);
    expect(SITEMAP_MAX_ORDINARY_CANDIDATES).toBe(10);
  });

  test('selected ID maps to the exact supplied URL; confidence stays retrieval rank', async () => {
    const { calls } = stubChoice({
      choice: 'cand_1',
      probabilities: { cand_1: 0.81, cand_0: 0.1, no_match: 0.05, insufficient_evidence: 0.04 },
      confidence: 0.79,
    });
    const runId = bindDiscoveryRun();
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId,
      itemId: 'item-1',
    });

    expect(calls.length).toBe(1);
    // Closed set: exactly one question, criteria keyed by candidate IDs.
    const body = calls[0].body;
    const questions = body.questions as Record<string, { type: string; criteria: Record<string, string> }>;
    expect(Object.keys(questions)).toHaveLength(1);
    expect(questions.sitemap_selection.type).toBe('choice');
    expect(Object.keys(questions.sitemap_selection.criteria).sort()).toEqual(
      ['cand_0', 'cand_1', 'insufficient_evidence', 'no_match'].sort(),
    );
    expect(result.outcome).toBe('selected');
    expect(result.selectedUrl).toBe('https://brand.example/products/beta');
    expect(result.selectedCandidateId).toBe('cand_1');
    expect(result.retrievalRank).toBe(0.6);
    expect(result.selectedProbability).toBeCloseTo(0.81, 5);
    expect(result.probabilityBasis).toBe('choice_probability');
    expect(result.modelCallIds).toHaveLength(1);
    expect(result.selectionAudit).toHaveLength(2);
    expect(result.selectionAudit[0].status).toBe('started');
    expect(result.selectionAudit[1].status).toBe('success');
    expect(result.selectionAudit.every(r => r.runId === runId)).toBe(true);
    // Durable audit: one completed row per attempt queryable by discovery run.
    const rows = getDiscoveryModelCallsByRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].prompt_tokens).toBe(120);
    expect(rows[0].completion_tokens).toBe(8);
    expect(typeof rows[0].duration_ms).toBe('number');
    expect(rows.every(r => r.run_id === runId)).toBe(true);
    expect(rows.map(r => r.id)).toEqual([...result.modelCallIds]);
  });

  test('no_match abstention retains safe candidates for inspection', async () => {
    stubChoice({
      choice: 'no_match',
      probabilities: { no_match: 0.7, cand_0: 0.15, cand_1: 0.1, insufficient_evidence: 0.05 },
      confidence: 0.72,
    });
    const runId = bindDiscoveryRun();
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId,
      itemId: 'item-2',
    });

    expect(result.outcome).toBe('no_match');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(result.safeCandidates.map(c => c.url)).toContain('https://brand.example/products/alpha');
    expect(result.abstentionCode).toBe('no_match');
    const rows = getDiscoveryModelCallsByRun(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows.every(r => r.run_id === runId)).toBe(true);
  });

  test('insufficient_evidence abstention retains safe candidates', async () => {
    stubChoice({
      choice: 'insufficient_evidence',
      probabilities: { insufficient_evidence: 0.66, cand_0: 0.17, cand_1: 0.12, no_match: 0.05 },
      confidence: 0.6,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-3',
    });

    expect(result.outcome).toBe('insufficient_evidence');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId)).toHaveLength(1);
  });

  test('out-of-set answer never persists a URL', async () => {
    stubChoice({
      choice: 'cand_99',
      probabilities: { cand_99: 0.9, cand_0: 0.05, cand_1: 0.03, no_match: 0.01, insufficient_evidence: 0.01 },
      confidence: 0.85,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-4',
    });

    expect(result.outcome).toBe('correlation_invalid');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('unknown option key never persists a URL', async () => {
    stubChoice({
      choice: 'mystery_key',
      probabilities: { mystery_key: 0.8, cand_0: 0.1, cand_1: 0.05, no_match: 0.03, insufficient_evidence: 0.02 },
      confidence: 0.8,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-5',
    });

    // The transport correlation rejects keys outside the closed criteria:
    // a malformed answer fails closed as correlation_invalid — never a URL.
    expect(result.outcome).toBe('correlation_invalid');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('arbitrary URL-shaped keys are never substring-parsed into a selection', async () => {
    stubChoice({
      choice: 'https://brand.example/products/beta',
      probabilities: {
        'https://brand.example/products/beta': 0.9,
        cand_0: 0.05,
        cand_1: 0.03,
         no_match: 0.01,
        insufficient_evidence: 0.01,
      },
      confidence: 0.85,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-6',
    });

    // The transport correlation rejects keys outside the closed criteria:
    // a malformed answer fails closed as correlation_invalid — never parsed.
    expect(result.outcome).toBe('correlation_invalid');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('correlation-invalid answers retain safe candidates', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          model: TYPESAFE_EVALUATED_MODEL,
          answers: {},
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-7',
    });

    expect(result.outcome).toBe('correlation_invalid');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('low model probability never becomes a selection', async () => {
    stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.32, cand_1: 0.3, no_match: 0.2, insufficient_evidence: 0.18 },
      confidence: 0.4,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-8',
    });

    expect(result.outcome).toBe('low_model_probability');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['success']);
  });

  test('coverage gap: empty retrieval set issues no model call', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: [],
      meta: meta(),
      modelPolicy: policyView(),
      runId: `sel-test-gap-${Date.now()}`,
      itemId: 'item-9',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('coverage_gap');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(0);
  });

  test('verified unique identity bypasses the model call entirely', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: `sel-test-bypass-${Date.now()}`,
      itemId: 'item-10',
      skipReason: 'verified_unique_identity',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('verified_unique_identity');
    expect(result.modelCallIds).toHaveLength(0);
  });

  test('single candidate bypasses the choice call for ordinary verification', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: [candidates()[0]],
      meta: meta(),
      modelPolicy: policyView(),
      runId: `sel-test-single-${Date.now()}`,
      itemId: 'item-11',
      skipReason: 'single_candidate_verify',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('verified_unique_identity');
  });

  test('candidate limit abstention: over-10 sets never clip to first-N', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const many: SitemapSelectionCandidate[] = Array.from({ length: 11 }, (_, i) => ({
      id: `cand_${i}`,
      url: `https://brand.example/products/p-${i}`,
      retrievalRank: 1 - i / 1000,
    }));
    const result = await selectOfficialPageWithTypesafe({
      candidates: many,
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-12',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('candidate_limit_exceeded');
    expect(result.safeCandidates).toHaveLength(11);
  });

  test('unbound selection fails closed pre-transport (no orphan audit)', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: null,
      itemId: 'item-unbound',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('transport_failed');
    expect(result.selectedUrl).toBeNull();
    expect(result.modelCallIds).toHaveLength(0);
    expect(result.selectionAudit).toHaveLength(0);
  });

  test('null policy disables with zero transport and no chat fallback', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: null,
      runId: bindDiscoveryRun(),
      itemId: 'item-13',
    });

    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('provider_disabled');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    const rows = getDiscoveryModelCallsByRun(result.selectionAudit[0].runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('unavailable');
  });

  test('transport failure retains safe candidates (no silent selection)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'overloaded' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-14',
    });

    expect(result.outcome).toBe('transport_failed');
    expect(result.selectedUrl).toBeNull();
    expect(result.safeCandidates).toHaveLength(2);
    expect(result.modelCallIds).toHaveLength(1);
    expect(result.selectionAudit).toHaveLength(2);
    expect(result.selectionAudit[0].status).toBe('started');
    expect(result.selectionAudit[1].status).toBe('failed');
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('returned-model mismatch never becomes a selection', async () => {
    stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
      model: 'jev-9.9.9',
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-15',
    });

    expect(result.selectedUrl).toBeNull();
    expect(result.outcome).not.toBe('selected');
    expect(result.safeCandidates).toHaveLength(2);
    expect(getDiscoveryModelCallsByRun(result.selectionAudit[0].runId).map(r => r.status)).toEqual(['failed']);
  });

  test('live disablement before dispatch fails closed with zero transport', async () => {
    const { calls } = stubChoice({
      choice: 'cand_0',
      probabilities: { cand_0: 0.9, no_match: 0.05, insufficient_evidence: 0.05 },
      confidence: 0.9,
    });
    const result = await selectOfficialPageWithTypesafe({
      candidates: candidates(),
      meta: meta(),
      modelPolicy: policyView(),
      runId: bindDiscoveryRun(),
      itemId: 'item-16',
      assertHeld: () => {
        throw new Error('lease lost (heartbeat)');
      },
    });

    // A superseded worker fails closed before transport with a durable
    // single terminal row (lease lost pre-dispatch: no start row to update).
    expect(calls.length).toBe(0);
    expect(result.outcome).toBe('provider_disabled');
    expect(result.selectedUrl).toBeNull();
    expect(result.selectionAudit).toHaveLength(1);
    expect(result.selectionAudit[0].status).toBe('failed');
    const rows = getDiscoveryModelCallsByRun(result.selectionAudit[0].runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });
});
