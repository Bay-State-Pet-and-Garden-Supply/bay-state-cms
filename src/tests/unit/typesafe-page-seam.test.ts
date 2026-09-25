/**
 * TypeSafe Jev Category Page Seam Verification (Issue #299 / AC 1–10).
 *
 * Full seam verification with HTTP mocked across:
 * - Singleton Jev integration with governed route and cohort blocked (AC 1)
 * - Reviewed Primary Product Type gate and verified page catalog gate (AC 2)
 * - Duplicate page names resolving to canonical Page IDs without cross-mapping (AC 3)
 * - Single mode Choice + semantic abstentions (no_match, insufficient_evidence, candidate limit > 253) (AC 4)
 * - Multiple mode Noul questions per page (independent P(yes), batching <= 32, fail closed) (AC 5)
 * - Deterministic rules: specificity / Shop All suppression, brand-page shortcut, cross-species safety, validator (AC 6)
 * - Restricted page evidence packet (no unrelated claims) (AC 7)
 * - Lineage: audited classification_model_calls and isBulkAcceptable: false (AC 8)
 * - Immutable benchmark prediction & gold contracts evaluated by identity; name-only gold marked ineligible (AC 9)
 * - Stage-isolated baseline/challenger comparison helper (compareSingletonPagePredictions) (AC 10)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import {
  resolvePageDecision,
  buildProposalsFromPageDecision,
  NO_MATCH_CHOICE_KEY,
  INSUFFICIENT_EVIDENCE_CHOICE_KEY,
  JEV_PAGE_QUESTION_ID,
} from '../../classification/page-decision';
import { processPageTarget } from '../../classification/curation-target-processor';
import { buildPageEvidencePacket } from '../../classification/evidence-targeting';
import {
  computeMetrics,
  compareSingletonPagePredictions,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import { evaluateClassificationReadiness } from '../../classification/config-validation';
import {
  buildModelExecutionPlan,
  buildRuntimeRuleVersions,
} from '../../classification/model-operation-registry';
import { CLASSIFICATION_POLICY_STAGES } from '../../classification/classification-policy-service';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type {
  ClassificationEvidence,
  ModelPolicyConfigV2,
  BenchmarkPredictionEntry,
} from '../../shared/schemas/classification';
import type { RuntimeClassificationSnapshot, PageSnapshotRecord } from '../../classification/runtime-snapshot';

describe('TypeSafe Jev Category Page Seam Verification (Issue #299)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-page-seam';

  const pageRecords: PageSnapshotRecord[] = [
    { pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food', parentPageId: 'page-dog-food', verified: true },
    { pageId: 'page-wet-dog-food', pageName: 'Wet Dog Food', parentPageId: 'page-dog-food', verified: true },
    { pageId: 'page-dog-food', pageName: 'Dog Food', parentPageId: null, verified: true },
    { pageId: 'page-shop-all-dogs', pageName: 'Dogs - Shop All', parentPageId: null, verified: true },
    { pageId: 'page-cat-food', pageName: 'Cat Food', parentPageId: null, verified: true },
    { pageId: 'page-fromm', pageName: 'Brand - Fromm', parentPageId: null, verified: true },
    { pageId: 'page-dog-accessories', pageName: 'Accessories', parentPageId: 'page-dog-dept', verified: true },
    { pageId: 'page-cat-accessories', pageName: 'Accessories', parentPageId: 'page-cat-dept', verified: true },
    { pageId: 'page-dog-dept', pageName: 'Dog Department', parentPageId: null, verified: true },
    { pageId: 'page-cat-dept', pageName: 'Cat Department', parentPageId: null, verified: true },
  ];

  const pageOptions: ResolvedTargetOption[] = pageRecords.map(r => ({
    value: r.pageId,
    label: r.pageName,
  }));

  const pageTarget: ResolvedTarget = {
    config: {
      id: 'category_pages',
      label: 'Category Pages',
      kind: 'pages',
      catalogField: 'ProductOnPages',
      selectionMode: 'multiple',
      confidenceThreshold: 0.7,
      guidancePrompt: 'Select category pages for product',
    },
    options: pageOptions,
  } as unknown as ResolvedTarget;

  const sampleEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-page-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-FOOD-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/fromm-dry',
      sourceField: 'title',
      snippet: 'Fromm Gold Adult Dry Dog Food 26 lb',
      value: 'Fromm Gold Adult Dry Dog Food 26 lb',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-page-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-FOOD-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/fromm-dry',
      sourceField: 'description',
      snippet: 'Premium wholesome nutrition with real meat and whole grains for adult dogs.',
      value: 'Premium wholesome nutrition with real meat and whole grains for adult dogs.',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-3',
      runId: 'run-page-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-FOOD-1',
      attributeId: 'species',
      source: 'visual_product_evidence',
      reliability: 'high',
      sourceUrl: 'https://example.com/fromm.jpg',
      sourceField: 'species',
      snippet: 'Dog',
      value: 'Dog',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-4',
      runId: 'run-page-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-FOOD-1',
      attributeId: null,
      source: 'catalog_manager_guidance',
      reliability: 'high',
      sourceUrl: 'https://example.com/brands',
      sourceField: 'resolved_brand',
      snippet: 'Fromm',
      value: { brandName: 'Fromm' },
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    // Unrelated claim evidence that must NOT be passed to Jev
    {
      id: 'ev-claim-unrelated',
      runId: 'run-page-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-FOOD-1',
      attributeId: 'claim_organic',
      source: 'official_product_page',
      reliability: 'medium',
      sourceUrl: 'https://example.com/claim',
      sourceField: 'unrelated_claim',
      snippet: 'Certified 100% Organic Ingredients Batch 994',
      value: 'Certified 100% Organic Ingredients Batch 994',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
  ];

  const cloudJevPolicy: ModelPolicyConfigV2 = {
    defaultProvider: 'typesafe',
    defaultModel: 'jev-1.13.0',
    providerLocalities: {
      typesafe: 'cloud',
    },
    stageOverrides: {
      category_page_proposals: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        fallbackProvider: null,
        fallbackModel: null,
      },
      page_assignment: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        fallbackProvider: null,
        fallbackModel: null,
      },
    },
    textDataSharing: 'cloud_allowed',
    imageDataSharing: 'local_only',
    mlFeatures: {
      productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
    },
  };

  const policyView = buildModelPolicyView(cloudJevPolicy);
  const runtimeRuleVersions = buildRuntimeRuleVersions();
  const modelExecutionPlan = buildModelExecutionPlan(policyView);

  const snapshot: RuntimeClassificationSnapshot = {
    schemaVersion: 2,
    snapshotHash: 'hash-page-test-catalog',
    catalogHash: 'hash-page-test-catalog',
    curationTargets: [
      { id: 'product_type', label: 'Product Type', kind: 'product_type', catalogField: 'ProductField24', selectionMode: 'single', confidenceThreshold: 0.7, guidancePrompt: 'Select product type', enabled: true, mandatory: true },
      { id: 'category_pages', label: 'Category Pages', kind: 'pages', catalogField: 'ProductOnPages', selectionMode: 'multiple', confidenceThreshold: 0.7, guidancePrompt: 'Select category pages', enabled: true, mandatory: false },
    ],
    productType: { state: 'verified' },
    pages: {
      state: 'verified',
      catalogHash: 'hash-page-test-catalog',
      records: pageRecords,
    },
    modelPolicy: cloudJevPolicy,
    runtimeRuleVersions,
    modelExecutionPlan,
  } as unknown as RuntimeClassificationSnapshot;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'test-typesafe-key',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);
  });

  afterEach(() => {
    closeDb();
    globalThis.fetch = originalFetch;
  });

  // ── Criterion 1: Governed route & capability (singleton permitted, cohort blocked)
  describe('Criterion 1: Governed route and capability configuration', () => {
    it('declares category_page_proposals route as supported for systemone in CLASSIFICATION_POLICY_STAGES', () => {
      const stage = CLASSIFICATION_POLICY_STAGES.find(s => s.id === 'category_page_proposals');
      expect(stage).toBeDefined();
      expect(stage?.supportedTransports).toContain('systemone');
      expect(stage?.adapterStatus).toBe('supported');
    });

    it('reports cohortSupported: true in evaluateClassificationReadiness for Jev category pages', () => {
      const config = {
        modelPolicy: cloudJevPolicy,
        curationTargets: [
          {
            id: 'target_pages',
            kind: 'page',
            label: 'Category Pages',
            enabled: true,
            mandatory: false,
            catalogField: 'ProductOnPages',
          },
        ],
      };

      const report = evaluateClassificationReadiness(config, {});
      expect(report.capabilities.categoryPages.cohortSupported).toBe(true);
    });

    it('abstains in processPageTarget when the frozen product-line snapshot is incomplete', async () => {
      const run = createRun(workspaceId, 'SKU-1', null, 'hash-page-test-catalog');

      const result = await processPageTarget(
        pageTarget,
        {
          sku: 'SKU-1',
          evidence: sampleEvidence,
          allProposals: [],
          acceptedProposals: [],
        },
        {
          runId: run.id,
          snapshot,
          productLineContext: {
            siblingSkus: ['SKU-1', 'SKU-2'],
            sharedAttributes: {},
          },
        } as any,
      );

      expect(result.proposals).toEqual([]);
      expect(result.message).toContain('Cohort page coordination abstained: the frozen product-line snapshot is incomplete');
    });
  });

  // ── Criterion 2: Reviewed Product Type authority & verified catalog gates
  describe('Criterion 2: Reviewed Product Type and verified Page catalog gates', () => {
    it('abstains when reviewedProductTypeId is missing and product_type is an enabled target', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        reviewedProductTypeId: null,
      });

      expect(decision.outcome).toBe('abstained');
      expect(decision.abstentionCode).toBe('no_reviewed_product_type');
      expect(decision.pages).toEqual([]);
    });

    it('abstains when snapshot.pages.state is not verified', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      const unverifiedSnapshot: RuntimeClassificationSnapshot = {
        ...snapshot,
        pages: {
          state: 'unverified',
          catalogHash: null,
          records: [],
        },
      } as unknown as RuntimeClassificationSnapshot;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot: unverifiedSnapshot,
        modelPolicy: policyView,
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('abstained');
      expect(decision.abstentionCode).toBe('no_verified_pages');
      expect(decision.pages).toEqual([]);
    });
  });

  // ── Criterion 3: Duplicate page names resolving to canonical Page IDs
  describe('Criterion 3: Duplicate page names resolving to canonical Page IDs without cross-mapping', () => {
    it('resolves duplicate "Accessories" name to exact canonical pageId using path and hierarchy context', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      let capturedBody: any = null;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(capturedBody.questions as Record<string, any>)) {
          if (q.instructions?.includes('Accessories') && q.instructions?.includes('Dog Department')) {
            answers[qid] = { type: 'noul', noul: 0.91 };
          } else if (q.instructions?.includes('Accessories') && q.instructions?.includes('Cat Department')) {
            answers[qid] = { type: 'noul', noul: 0.05 };
          } else {
            answers[qid] = { type: 'noul', noul: 0.10 };
          }
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      const assignedDogAcc = decision.pages.find(p => p.pageId === 'page-dog-accessories');
      const assignedCatAcc = decision.pages.find(p => p.pageId === 'page-cat-accessories');
      expect(assignedDogAcc).toBeDefined();
      expect(assignedDogAcc?.pageName).toBe('Accessories');
      expect(assignedCatAcc).toBeUndefined();
    });
  });

  // ── Criterion 4: Single mode Choice + explicit abstentions
  describe('Criterion 4: Single mode Choice + semantic abstentions', () => {
    it('proposes matching page when Choice selects a candidate page with high probability', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      let capturedBody: any = null;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        const q = capturedBody.questions[JEV_PAGE_QUESTION_ID];
        const criteriaKeys = Object.keys(q.criteria);
        const probabilities: Record<string, number> = {};
        const remainingCount = criteriaKeys.length - 1;
        const remainder = 0.12 / remainingCount;
        for (const key of criteriaKeys) {
          probabilities[key] = key === 'page_opt_0' ? 0.88 : remainder;
        }
        probabilities[NO_MATCH_CHOICE_KEY] = 1 - 0.88 - (remainingCount - 1) * remainder;

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              [JEV_PAGE_QUESTION_ID]: {
                type: 'choice',
                choice: 'page_opt_0',
                probabilities,
                confidence: 0.95,
              },
            },
            usage: { input_tokens: 80, output_tokens: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'single',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      expect(decision.pages.length).toBe(1);
      expect(decision.pages[0].pageId).toBe('page-dry-dog-food');
      expect(decision.selectedProbability).toBe(0.88);
      expect(decision.pages[0].isBrandShortcut).toBe(false);
    });

    it('abstains with no_match when Choice selects abstain_no_match', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const capturedBody = JSON.parse(init?.body as string);
        const q = capturedBody.questions[JEV_PAGE_QUESTION_ID];
        const criteriaKeys = Object.keys(q.criteria);
        const probabilities: Record<string, number> = {};
        const remainingCount = criteriaKeys.length - 1;
        const remainder = 0.10 / remainingCount;
        for (const key of criteriaKeys) {
          probabilities[key] = key === NO_MATCH_CHOICE_KEY ? 0.90 : remainder;
        }
        probabilities[INSUFFICIENT_EVIDENCE_CHOICE_KEY] = 1 - 0.90 - (remainingCount - 1) * remainder;

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              [JEV_PAGE_QUESTION_ID]: {
                type: 'choice',
                choice: NO_MATCH_CHOICE_KEY,
                probabilities,
                confidence: 0.92,
              },
            },
            usage: { input_tokens: 80, output_tokens: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'single',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('abstained');
      expect(decision.abstentionCode).toBe('no_match');
      expect(decision.pages).toEqual([]);
    });

    it('abstains with candidate_limit_exceeded when candidate count > 253 without making model call', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      // Construct > 253 page options and records
      const manyRecords: PageSnapshotRecord[] = Array.from({ length: 260 }, (_, i) => ({
        pageId: `page-gen-${i}`,
        pageName: `Category Page ${i}`,
        parentPageId: null,
        verified: true,
      }));
      const manyOptions: ResolvedTargetOption[] = manyRecords.map(r => ({
        value: r.pageId,
        label: r.pageName,
      }));

      const largeSnapshot: RuntimeClassificationSnapshot = {
        ...snapshot,
        pages: {
          state: 'verified',
          catalogHash: 'hash-large',
          records: manyRecords,
        },
      } as unknown as RuntimeClassificationSnapshot;

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: { ...pageTarget, options: manyOptions } as ResolvedTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot: largeSnapshot,
        modelPolicy: policyView,
        selectionMode: 'single',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(fetchCalled).toBe(false);
      expect(decision.outcome).toBe('abstained');
      expect(decision.abstentionCode).toBe('candidate_limit_exceeded');
      expect(decision.pages).toEqual([]);
    });
  });

  // ── Criterion 5: Multiple mode Noul questions per page
  describe('Criterion 5: Multiple mode Noul questions per page (batching <= 32, independent P(yes))', () => {
    it('evaluates independent P(yes) probabilities without cross-candidate renormalization', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(body.questions as Record<string, any>)) {
          if (q.instructions.includes('category page "Dry Dog Food"')) {
            answers[qid] = { type: 'noul', noul: 0.85 };
          } else if (q.instructions.includes('category page "Wet Dog Food"')) {
            answers[qid] = { type: 'noul', noul: 0.75 };
          } else {
            answers[qid] = { type: 'noul', noul: 0.10 };
          }
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      const dryPage = decision.pages.find(p => p.pageId === 'page-dry-dog-food');
      const wetPage = decision.pages.find(p => p.pageId === 'page-wet-dog-food');
      expect(dryPage).toBeDefined();
      expect(dryPage?.selectedProbability).toBe(0.85);
      expect(wetPage).toBeDefined();
      expect(wetPage?.selectedProbability).toBe(0.75);
      // Both exceed threshold 0.70 and their raw probabilities sum to > 1.0 (no renormalization)
      expect((dryPage?.selectedProbability ?? 0) + (wetPage?.selectedProbability ?? 0)).toBeGreaterThan(1.0);
    });

    it('batches questions into groups <= 32 and fails closed if any batch fails', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      // Construct 35 pages (will be split into batch 1 with 32 questions and batch 2 with 3 questions)
      const records35: PageSnapshotRecord[] = Array.from({ length: 35 }, (_, i) => ({
        pageId: `page-batch-${i}`,
        pageName: `Category Batch ${i}`,
        parentPageId: null,
        verified: true,
      }));
      const options35: ResolvedTargetOption[] = records35.map(r => ({
        value: r.pageId,
        label: r.pageName,
      }));

      const batchSnapshot: RuntimeClassificationSnapshot = {
        ...snapshot,
        pages: {
          state: 'verified',
          catalogHash: 'hash-35',
          records: records35,
        },
      } as unknown as RuntimeClassificationSnapshot;

      let callCount = 0;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        callCount++;
        const body = JSON.parse(init?.body as string);
        expect(Object.keys(body.questions).length).toBeLessThanOrEqual(32);
        if (callCount >= 2) {
          // Fail the second batch (including retry)
          return new Response(JSON.stringify({ error: 'SystemOne temporary 500 error' }), { status: 500 });
        }
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const qid of Object.keys(body.questions)) {
          answers[qid] = { type: 'noul', noul: 0.80 };
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: { ...pageTarget, options: options35 } as ResolvedTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot: batchSnapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      // Fails closed on incomplete batch
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(decision.outcome).toBe('failed');
      expect(decision.pages).toEqual([]);
    });
  });

  // ── Criterion 6: Deterministic rules (Shop All suppression, brand shortcut, species safety)
  describe('Criterion 6: Deterministic rules', () => {
    it('suppresses generic Shop All parent page when specific child page is present', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(body.questions as Record<string, any>)) {
          if (q.instructions.includes('category page "Dry Dog Food"')) {
            answers[qid] = { type: 'noul', noul: 0.90 };
          } else if (q.instructions.includes('category page "Dogs - Shop All"')) {
            answers[qid] = { type: 'noul', noul: 0.85 };
          } else {
            answers[qid] = { type: 'noul', noul: 0.10 };
          }
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      const dryPage = decision.pages.find(p => p.pageId === 'page-dry-dog-food');
      const shopAllPage = decision.pages.find(p => p.pageId === 'page-shop-all-dogs');
      expect(dryPage).toBeDefined();
      expect(shopAllPage).toBeUndefined(); // Suppressed due to specificity
    });

    it('assigns brand-page shortcut with isBrandShortcut: true in multiple mode', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      let requestedBrandQuestion = false;
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(body.questions as Record<string, any>)) {
          if (q.instructions.includes('category page "Brand - Fromm"')) requestedBrandQuestion = true;
          answers[qid] = {
            type: 'noul',
            noul: q.instructions.includes('category page "Dry Dog Food"') ? 0.90 : 0.10,
          };
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence, // has resolved_brand = 'Fromm'
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      const brandPage = decision.pages.find(p => p.pageId === 'page-fromm');
      expect(brandPage).toBeDefined();
      expect(brandPage?.isBrandShortcut).toBe(true);
      // Brand shortcut was handled deterministically without calling Jev for that page
      expect(requestedBrandQuestion).toBe(false);
    });

    it('filters out cross-species pages so dog products never get cat pages', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(body.questions as Record<string, any>)) {
          if (q.instructions.includes('category page "Dry Dog Food"')) {
            answers[qid] = { type: 'noul', noul: 0.95 };
          } else if (q.instructions.includes('category page "Cat Food"')) {
            answers[qid] = { type: 'noul', noul: 0.90 };
          } else {
            answers[qid] = { type: 'noul', noul: 0.10 };
          }
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence, // species is 'Dog'
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.outcome).toBe('predicted');
      const catPage = decision.pages.find(p => p.pageId === 'page-cat-food');
      expect(catPage).toBeUndefined(); // Filtered by cross-species safety
    });
  });

  // ── Criterion 7: Restricted page evidence packet
  describe('Criterion 7: Restricted page evidence packet', () => {
    it('restricts evidence packet to title, description, species, resolved_brand and excludes unrelated claims', () => {
      const packet = buildPageEvidencePacket(sampleEvidence, {
        pageContextSourceFields: ['title', 'description', 'page_name', 'category', 'species', 'productForm', 'productType', 'brand', 'resolved_brand'],
        pageContextAttributeIds: ['species', 'brand'],
        sourceField: null,
        speciesValue: 'Dog',
      });

      const includedIds = new Set(packet.evidenceIds);
      expect(includedIds.has('ev-1')).toBe(true); // title
      expect(includedIds.has('ev-2')).toBe(true); // description
      expect(includedIds.has('ev-3')).toBe(true); // species
      expect(includedIds.has('ev-4')).toBe(true); // brand
      expect(includedIds.has('ev-claim-unrelated')).toBe(false); // unrelated claim excluded
    });
  });

  // ── Criterion 8: Lineage & Proposals
  describe('Criterion 8: Lineage and proposal building', () => {
    it('persists model calls in classification_model_calls and sets isBulkAcceptable: false', async () => {
      const run = createRun(workspaceId, 'SKU-DOG-FOOD-1', null, 'hash-page-test-catalog');

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const [qid, q] of Object.entries(body.questions as Record<string, any>)) {
          answers[qid] = {
            type: 'noul',
            noul: q.instructions.includes('category page "Dry Dog Food"') ? 0.88 : 0.10,
          };
        }

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 50, output_tokens: 5 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as any;

      const policyView = buildModelPolicyView(cloudJevPolicy);
      const decision = await resolvePageDecision({
        target: pageTarget,
        evidence: sampleEvidence,
        sku: 'SKU-DOG-FOOD-1',
        runId: run.id,
        snapshot,
        modelPolicy: policyView,
        selectionMode: 'multiple',
        reviewedProductTypeId: 'Dry Dog Food',
      });

      expect(decision.modelCallIds.length).toBeGreaterThan(0);
      const calls = getModelCallsByRun(run.id);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].status).toBe('success');
      expect(calls[0].provider).toBe('typesafe');

      const proposals = buildProposalsFromPageDecision(decision, 'SKU-DOG-FOOD-1', run.id, 'hash-page-test-catalog');
      expect(proposals.length).toBeGreaterThan(0);
      for (const prop of proposals) {
        expect(prop.isBulkAcceptable).toBe(false); // Always non-bulk-acceptable for Jev
        expect(prop.derivation).toBeDefined();
      }

      const modelProp = proposals.find(p => (p.proposedValue as any).pageId === 'page-dry-dog-food');
      expect(modelProp?.derivation?.kind).toBe('systemone_judgment');
      const brandProp = proposals.find(p => (p.proposedValue as any).pageId === 'page-fromm');
      expect(brandProp?.derivation?.kind).toBe('deterministic_enrichment');
    });
  });

  // ── Criterion 9: Benchmark evaluator identity evaluation vs legacy name-only
  describe('Criterion 9: Immutable benchmark prediction & gold contracts evaluated by identity', () => {
    it('evaluates pages by canonical page ID when categoryPageIds and verifiedImportProvenance are present', () => {
      const gold: GoldExampleForEvaluation[] = [
        {
          id: 'ex-1',
          productSku: 'SKU-1',
          goldLabels: {
            productType: 'Dry Dog Food',
            categoryPageIds: ['page-dry-dog-food', 'page-fromm'],
            verifiedImportProvenance: 'import-prov-hash-1',
            pageAssignments: [],
            fieldAssignments: [],
          },
          evidenceText: 'dog food fromm dry',
        },
      ];

      const predictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: 'Dry Dog Food',
          pageIds: ['page-dry-dog-food', 'page-fromm'],
          verifiedImportProvenance: 'import-prov-hash-1',
          fieldAssignments: [],
          abstained: false,
          confidence: 0.9,
          claimTargets: [],
          pageAssignments: ['Dry Dog Food', 'Brand - Fromm'],
        },
      ];

      const metrics = computeMetrics(gold, predictions);
      expect(metrics.pages.evaluatedByIdentity).toBe(true);
      expect(metrics.pages.eligibleToQualifyJev).toBe(true);
      expect(metrics.pages.blocked).toBe(false);
      expect(metrics.pages.exactSetAccuracy).toBe(1.0);
      expect(metrics.pages.precisionAtK).toBe(1.0);
      expect(metrics.pages.recallAtK).toBe(1.0);
    });

    it('marks pages blocked and ineligible when gold only has pageNames without verified page IDs', () => {
      const gold: GoldExampleForEvaluation[] = [
        {
          id: 'ex-legacy',
          productSku: 'SKU-LEGACY',
          goldLabels: {
            productType: 'Dry Dog Food',
            pageAssignments: [{ pageName: 'Dry Dog Food', pageId: null }], // Missing verified page ID and provenance
            fieldAssignments: [],
          },
          evidenceText: 'dog food',
        },
      ];

      const predictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-legacy',
          productSku: 'SKU-LEGACY',
          productType: 'Dry Dog Food',
          pageAssignments: ['Dry Dog Food'],
          fieldAssignments: [],
          abstained: false,
          confidence: 0.9,
          claimTargets: [],
        },
      ];

      const metrics = computeMetrics(gold, predictions);
      expect(metrics.pages.evaluatedByIdentity).toBe(false);
      expect(metrics.pages.eligibleToQualifyJev).toBe(false);
      expect(metrics.pages.blocked).toBe(true);
      expect(metrics.pages.blockedReason).toBe('blocked_missing_verified_page_gold');
    });
  });

  // ── Criterion 10: Stage-isolated comparison helper (compareSingletonPagePredictions)
  describe('Criterion 10: Stage-isolated comparison helper', () => {
    it('compares baseline and challenger predictions honestly over common reviewed product type', () => {
      const gold: GoldExampleForEvaluation[] = [
        {
          id: 'ex-match',
          productSku: 'SKU-1',
          goldLabels: {
            productType: 'Dry Dog Food',
            categoryPageIds: ['page-dry-dog-food'],
            verifiedImportProvenance: 'prov-1',
            pageAssignments: [],
            fieldAssignments: [],
          },
          evidenceText: 'dog food',
        },
        {
          id: 'ex-recovered',
          productSku: 'SKU-2',
          goldLabels: {
            productType: 'Dry Dog Food',
            categoryPageIds: ['page-dry-dog-food'],
            verifiedImportProvenance: 'prov-1',
            pageAssignments: [],
            fieldAssignments: [],
          },
          evidenceText: 'dog food',
        },
        {
          id: 'ex-unlabeled',
          productSku: 'SKU-3',
          goldLabels: {
            productType: 'Dry Dog Food',
            categoryPageIds: [],
            verifiedImportProvenance: 'prov-1',
            pageAssignments: [],
            fieldAssignments: [],
          },
          evidenceText: 'dog food',
        },
      ];

      const baselinePredictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-match',
          productSku: 'SKU-1',
          productType: 'Dry Dog Food',
          pageIds: ['page-dry-dog-food'],
          verifiedImportProvenance: 'prov-1',
          fieldAssignments: [],
          abstained: false,
          confidence: 0.9,
          claimTargets: [],
          pageAssignments: ['Dry Dog Food'],
        },
        {
          exampleId: 'ex-recovered',
          productSku: 'SKU-2',
          productType: 'Dry Dog Food',
          pageIds: [],
          abstained: true,
          confidence: null,
          claimTargets: [],
          verifiedImportProvenance: 'prov-1',
          fieldAssignments: [],
          pageAssignments: [],
        },
      ];

      const challengerPredictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-match',
          productSku: 'SKU-1',
          productType: 'Dry Dog Food',
          pageIds: ['page-dry-dog-food'],
          verifiedImportProvenance: 'prov-1',
          fieldAssignments: [],
          abstained: false,
          confidence: 0.9,
          claimTargets: [],
          pageAssignments: ['Dry Dog Food'],
        },
        {
          exampleId: 'ex-recovered',
          productSku: 'SKU-2',
          productType: 'Dry Dog Food',
          pageIds: ['page-dry-dog-food'],
          verifiedImportProvenance: 'prov-1',
          fieldAssignments: [],
          abstained: false,
          confidence: 0.9,
          claimTargets: [],
          pageAssignments: ['Dry Dog Food'],
        },
      ];

      const report = compareSingletonPagePredictions(gold, challengerPredictions, baselinePredictions);

      expect(report.evaluatedByIdentity).toBe(true);
      expect(report.eligibleToQualifyJev).toBe(true);
      expect(report.eligibleCount).toBe(2); // ex-match and ex-recovered (ex-unlabeled excluded from eligible)
      expect(report.unlabeledCount).toBe(1);
      expect(report.candidateExactMatches).toBe(2);
      expect(report.baselineExactMatches).toBe(1);
      expect(report.recoveredBaselineAbstentions).toBe(1);
      expect(report.harmedBaselineSuccesses).toBe(0);
      expect(report.exactSetDeltaMean).toBe(0.5); // (2 - 1) / 2
      expect(report.examples.length).toBe(2);
    });
  });
});
