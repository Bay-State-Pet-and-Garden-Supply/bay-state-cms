/**
 * Offline qualification regression for the official-page selector (issue #374).
 *
 * Runs the frozen dev corpus through the selector contract (closed-set IDs,
 * exact-URL mapping, abstention vocabulary) with a stubbed Choice transport.
 * Asserts the fixed population: every row counted exactly once, coverage vs
 * selector accounting separated (9/14 retrieval coverage, 9/9 selector-correct
 * given coverage, 5/5 correct abstentions), zero harness failures. Also
 * asserts the holdout corpus stays sealed (family-disjoint from dev, never
 * executed here) and that both corpus bytes are frozen (sha256 of file bytes
 * matches the digests pinned in the dev-fitted task policy).
 *
 * Runs under `bun test` (matches the sitemap-selection suite's runner).
 */
import crypto from 'node:crypto';
import fs, { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { assertConnectionEnabledForDispatch, type ProviderConnection } from '../../ai/provider-connections';
import { buildModelPolicyView, type ModelPolicyView } from '../../classification/model-policy-gateway';
import {
  selectOfficialPageWithTypesafe,
  type SitemapSelectionCandidate,
} from '../../onboarding/sitemap-selection';
import { TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { holdoutUnsealReviewId } from '../../../scripts/sitemap-selection-qualification';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createDiscoveryRun } from '../../db/repositories/onboarding-source-repo';

const DEV_PATH = 'src/tests/fixtures/sitemap-selection-qualification/dev-corpus.json';
const HOLDOUT_PATH = 'src/tests/fixtures/sitemap-selection-qualification/holdout-corpus.json';

interface QualRow {
  id: string;
  familyId: string;
  category: string;
  registerName: string;
  consolidatedName: string;
  upc: string | null;
  sku: string | null;
  brandHint: string | null;
  variantTokens: string[];
  approvedDomains: string[];
  retrievalIncludesGold: boolean;
  gold: { kind: 'confirm'; url: string } | { kind: 'abstain'; reason: string };
  goldExactPath: boolean;
  simulatedModelChoice: string | null;
  candidates: Array<{ id: string; url: string; retrievalRank: number; title?: string }>;
}

interface CorpusFile {
  corpusId: string;
  frozenVersions: Record<string, string>;
  rows: QualRow[];
}

function loadCorpus(p: string): CorpusFile {
  const raw = fs.readFileSync(path.join(process.cwd(), p), 'utf8');
  const parsed = JSON.parse(raw) as CorpusFile;
  return parsed;
}

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
    { snapshotHash: 'snap-sitemap-qualification-offline' },
  );
}

/** Stub fetch: answers from the row's frozen simulatedModelChoice (offline mechanics check). */
let currentChoice: { choice: string; probabilities: Record<string, number> } | null = null;
const fetchCalls: Array<unknown> = [];

function installStubFetch(): void {
  (globalThis as Record<string, unknown>).fetch = (async (_url: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    } catch {
      /* keep empty */
    }
    fetchCalls.push(body);
    return new Response(
      JSON.stringify({
        model: TYPESAFE_EVALUATED_MODEL,
        answers: {
          sitemap_selection: {
            type: 'choice',
            choice: currentChoice?.choice ?? 'insufficient_evidence',
            probabilities: currentChoice?.probabilities ?? {},
            confidence: 0.5,
          },
        },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('sitemap-selection qualification corpora (offline, #374)', () => {
  const testDbPath = '/tmp/baystate-cms-sitemap-qual-374-test.db';
  let originalFetch: typeof fetch;
  let qualBatchId: string;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(testDbPath);
    runMigrations();
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
      id: 'ws-sitemap-qual-374',
      name: 'Sitemap Qual 374',
      workspacePath: '/tmp/ws-sitemap-qual-374',
      gitPath: '/tmp/ws-sitemap-qual-374/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    qualBatchId = createBatch({ workspaceId: 'ws-sitemap-qual-374', name: 'sitemap-qual-374', fileName: 'qual.csv', totalItems: 100 }).id;
    installStubFetch();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    try {
      unlinkSync(testDbPath);
    } catch {
      /* ok */
    }
  });

  test('dev corpus is frozen and family-separated from holdout', () => {
    const dev = loadCorpus(DEV_PATH);
    const holdout = loadCorpus(HOLDOUT_PATH);
    expect(dev.rows).toHaveLength(14);
    expect(holdout.rows).toHaveLength(10);
    const devFamilySeen: Record<string, true> = {};
    for (const r of dev.rows) devFamilySeen[r.familyId] = true;
    expect(Object.keys(devFamilySeen)).toHaveLength(14);
    const holdFamilySeen: Record<string, true> = {};
    for (const r of holdout.rows) holdFamilySeen[r.familyId] = true;
    expect(Object.keys(holdFamilySeen)).toHaveLength(10);
    for (const f of Object.keys(holdFamilySeen)) expect(devFamilySeen[f]).toBeUndefined();
    // Hard-negative / insufficient / missing-gold coverage present in dev.
    const catSeen: Record<string, true> = {};
    for (const r of dev.rows) catSeen[r.category] = true;
    for (const need of ['deterministic_exact', 'hard_negative_wrong_recipe', 'hard_negative_wrong_domain', 'insufficient', 'missing_gold']) {
      expect(catSeen[need]).toBe(true);
    }
    for (const r of dev.rows) {
      if (r.gold.kind === 'confirm' && r.retrievalIncludesGold) {
        expect(r.candidates.map(c => c.url)).toContain(r.gold.url);
      }
    }
    // Corpus bytes are frozen: sha256 of the file bytes MUST match the
    // digests pinned in the dev-fitted task policy. A corpus edit that
    // changes bytes without updating the policy fails here.
    const policy = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'docs/audits/sitemap-selection-qualification/task-policy.json'), 'utf8'),
    ) as {
      publishedBeforeHoldoutInspection: boolean;
      activation: string;
      sha256: string;
      holdoutSha256: string;
      fitExecutedAt: string;
      fitExecutedBeforeFreezeNote: string;
      frozenRecordedAt: string;
      frozenCommit: string;
    };
    expect(policy.publishedBeforeHoldoutInspection).toBe(true);
    expect(typeof policy.fitExecutedAt).toBe('string');
    expect(policy.fitExecutedAt.length).toBeGreaterThan(0);
    expect(policy.fitExecutedBeforeFreezeNote).toContain('BEFORE');
    expect(policy.fitExecutedBeforeFreezeNote).toContain('holdout seal ordering');
    expect(typeof policy.frozenRecordedAt).toBe('string');
    expect(policy.frozenRecordedAt.length).toBeGreaterThan(0);
    expect(typeof policy.frozenCommit).toBe('string');
    expect(policy.frozenCommit.length).toBeGreaterThan(0);
    expect(policy.activation.startsWith('OFF')).toBe(true);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), DEV_PATH))).digest('hex')).toBe(policy.sha256);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(process.cwd(), HOLDOUT_PATH))).digest('hex')).toBe(policy.holdoutSha256);
    expect(dev.frozenVersions).toEqual({
      prompt: 'jev-sitemap-selection-v2',
      rule: 'sitemap-selection-rules-v1',
      model: 'jev-1.13.0',
      policy: 'sitemap-selection-task-policy-v1-dev',
    });
  });

  test('dev corpus selector accounting is 9/14 coverage, 9/9 given coverage, 5/5 abstentions', async () => {
    const dev = loadCorpus(DEV_PATH);
    let covered = 0;
    let confirmCovered = 0;
    let correctSelections = 0;
    let abstainRows = 0;
    let correctAbstentions = 0;
    const failures: string[] = [];
    for (const row of dev.rows) {
      // Frozen stub: winner 0.82, remainder spread across every other key so
      // the Choice distribution sums to 1.00 (transport validates ±0.01).
      if (row.simulatedModelChoice === null) {
        currentChoice = null; // deterministic path expected; any fetch call is a harness failure
      } else {
        const keys = [...row.candidates.map(c => c.id), 'no_match', 'insufficient_evidence'];
        const losers = keys.filter(k => k !== row.simulatedModelChoice);
        const probs: Record<string, number> = {};
        const loserShare = losers.length > 0 ? 0.18 / losers.length : 0;
        for (const k of keys) probs[k] = k === row.simulatedModelChoice ? 0.82 : loserShare;
        currentChoice = { choice: row.simulatedModelChoice, probabilities: probs };
      }
      fetchCalls.length = 0;
      try {
        const cands: SitemapSelectionCandidate[] = row.candidates.map(c => ({
          id: c.id,
          url: c.url,
          retrievalRank: c.retrievalRank,
          title: c.title ?? null,
          upc: row.upc,
          sku: row.sku,
        }));
        // Deterministic exact path: frozen exact-path rows skip the model call.
        // Single-candidate sets are ordinary verification work (no Choice call).
        const skipReason = row.goldExactPath
          ? 'verified_unique_identity'
          : row.candidates.length === 1
            ? 'single_candidate_verify'
            : null;
        // Discovery-run binding (mirrors sitemap-matcher.test.ts's
        // bindDiscoveryRun): the selector fail-closes unbound attempts to
        // transport_failed so orphan audit rows are never created. A real
        // discovery-run row is the FK parent for durable audit here.
        const [qualItem] = insertItems(qualBatchId, [{
          name: `QUAL ${row.id}`,
          upc: row.upc ?? '',
          brandHint: row.brandHint ?? undefined,
          rowNumber: 1,
          stage: 'discovery',
        }]);
        const qualRunId = createDiscoveryRun(qualItem.id, { trigger: 'automatic', upc: row.upc ?? '', name: `QUAL ${row.id}` });
        const result = await selectOfficialPageWithTypesafe({
          runId: qualRunId,
          candidates: cands,
          meta: {
            registerName: row.registerName,
            consolidatedName: row.consolidatedName,
            upc: row.upc,
            sku: row.sku,
            brandHint: row.brandHint,
            variantTokens: row.variantTokens,
            approvedDomains: row.approvedDomains,
          },
          modelPolicy: policyView(),
          itemId: `qual-${row.id}`,
          snapshotHash: 'snap-sitemap-qualification-offline',
          skipReason,
        });
        if (skipReason !== null && fetchCalls.length > 0) {
          failures.push(`${row.id}: deterministic/single-candidate path issued a model call`);
        }
        if (row.retrievalIncludesGold) covered += 1;
        if (row.gold.kind === 'confirm' && row.retrievalIncludesGold) {
          confirmCovered += 1;
          const goldUrl = row.gold.url;
          const ok =
            result.selectedUrl === goldUrl ||
            (result.outcome === 'verified_unique_identity' && cands.some(c => c.url === goldUrl));
          if (ok) correctSelections += 1;
          else failures.push(`${row.id}: expected selection of gold URL, got outcome=${result.outcome} url=${result.selectedUrl}`);
        } else if (row.gold.kind === 'abstain') {
          abstainRows += 1;
          const abstained = result.outcome !== 'selected' && result.outcome !== 'verified_unique_identity';
          if (abstained) correctAbstentions += 1;
          else failures.push(`${row.id}: expected abstention, got outcome=${result.outcome} url=${result.selectedUrl}`);
        } else {
          failures.push(`${row.id}: gold confirmable but not retrieved — coverage failure outside the fixed accounting`);
        }
      } catch (err) {
        failures.push(`${row.id}: harness_error ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      }
    }
    expect(failures).toEqual([]);
    // Fixed-population accounting cited in the qualification report §2.
    expect(dev.rows).toHaveLength(14);
    expect(covered).toBe(9);
    expect(confirmCovered).toBe(9);
    expect(correctSelections).toBe(9);
    expect(abstainRows).toBe(5);
    expect(correctAbstentions).toBe(5);
  });

  test('holdout RUN stays sealed without HOLDOUT_UNSEAL and unseals with an auditable review id', () => {
    // Refusal path: no token, no empty token, and whitespace-only token all
    // keep the holdout RUN sealed — unsealing must never be a source edit.
    expect(holdoutUnsealReviewId({})).toBeNull();
    expect(holdoutUnsealReviewId({ HOLDOUT_UNSEAL: '' })).toBeNull();
    expect(holdoutUnsealReviewId({ HOLDOUT_UNSEAL: '   ' })).toBeNull();
    // Authorized path: the reviewer approval id is returned verbatim so the
    // harness can record it in the report (auditable authorization).
    expect(holdoutUnsealReviewId({ HOLDOUT_UNSEAL: 'review-374-unseal-01' })).toBe('review-374-unseal-01');
  });

  test('production default path is OFF: seed mlFeatures disabled and disabled connection refuses dispatch', () => {
    // Default-config assertion for the production path (mirrors the qual
    // harness all-disabled policy view): the shipped seed resolves every
    // ML feature to disabled, so nothing is active by default.
    for (const feature of ['productionRetrieval', 'pageReranking', 'confidenceCalibration', 'productionEmbeddings'] as const) {
      expect(BayStatePetGardenSeed.modelPolicy.mlFeatures[feature].state).toBe('disabled');
    }
    // Disabled connection halts before any network use — the gate the live
    // Choice dispatch must pass through.
    const disabledConn: ProviderConnection = {
      id: 'qual-offline-conn',
      label: 'Qualification offline (disabled)',
      transport: 'systemone',
      baseUrl: 'http://localhost:1/',
      credential: null,
      trustZone: 'this_device',
      enabled: false,
    };
    let threw: unknown = null;
    try {
      assertConnectionEnabledForDispatch(disabledConn, TYPESAFE_EVALUATED_MODEL);
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect((threw as Error).message).toContain('is disabled');
  });
});
