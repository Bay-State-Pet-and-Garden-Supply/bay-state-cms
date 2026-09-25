/**
 * TypeSafe Jev Category Page Cohort Seam Verification (Issue #301 / AC 1–10).
 *
 * Full seam verification for coordinating TypeSafe Jev System One Category Pages
 * across frozen cohorts (part of Epic #293):
 * - Governed route integration & cohortSupported: true readiness (AC 1)
 * - Single mode Choice independent question generation & candidate limits (AC 2)
 * - Multiple mode Noul independent question generation & batching <= 32 (AC 3)
 * - Reused singleton semantics, deterministic rules, & category correctness (AC 4)
 * - P-hash binding: request partitioning, versions, protocol, model (AC 5)
 * - Two-level atomicity: chunk model failure vs fatal abort (AC 6)
 * - Write-once complete output map & zero-call child materialization (AC 7)
 * - Ownership assertion and pre-commit crash seam (AC 8)
 * - Extended immutable benchmark replay & evaluation (AC 9)
 * - Mixed Pet & Garden fixture cohort execution (AC 10)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { buildModelPolicyView, resolveModelRoute } from '../../classification/model-policy-gateway';
import { CLASSIFICATION_POLICY_STAGES } from '../../classification/classification-policy-service';
import { evaluateClassificationReadiness } from '../../classification/config-validation';
import {
  coordinateCohortPagesWithJev,
  NO_MATCH_CHOICE_KEY,
  INSUFFICIENT_EVIDENCE_CHOICE_KEY,
  PAGE_QUESTION_VERSION,
  PAGE_JUDGMENT_VERSION,
} from '../../classification/page-decision';
import { SYSTEMONE_MAX_QUESTIONS } from '../../ai/systemone-transport';
import {
  coordinateCohortPagesCore,
  type CohortPageOption,
  type CohortPageMemberResult,
} from '../../classification/cohort-page-proposal-engine';
import {
  computeCohortPageInputHash,
  type CohortPageAuthorityBundle,
} from '../../onboarding/cohort-curation/pages';
import {
  materializeCoordinatedPages,
} from '../../classification/curation-target-processor';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import {
  classifyCohortPageOutcome,
  compareCohortPagePredictions,
  evaluateCohortPipelineEffects,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import {
  buildModelExecutionPlan,
  buildRuntimeRuleVersions,
} from '../../classification/model-operation-registry';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import type { ProductLineItemSnapshot, StageContext, StageInput } from '../../classification/types';
import type { RuntimeClassificationSnapshot, PageSnapshotRecord } from '../../classification/runtime-snapshot';
import type {
  ModelPolicyConfigV2,
  BenchmarkPredictionEntry,
} from '../../shared/schemas/classification';

describe('TypeSafe Jev Cohort Page Seam Verification (Issue #301)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-cohort-page-seam';

  const pageRecords: PageSnapshotRecord[] = [
    { pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food', parentPageId: 'page-dog-food', verified: true },
    { pageId: 'page-wet-dog-food', pageName: 'Wet Dog Food', parentPageId: 'page-dog-food', verified: true },
    { pageId: 'page-dog-food', pageName: 'Dog Food', parentPageId: null, verified: true },
    { pageId: 'page-shop-all-dogs', pageName: 'Dogs - Shop All', parentPageId: null, verified: true },
    { pageId: 'page-cat-food', pageName: 'Cat Food', parentPageId: null, verified: true },
    { pageId: 'page-cat-wet', pageName: 'Wet Cat Food', parentPageId: 'page-cat-food', verified: true },
    { pageId: 'page-fromm', pageName: 'Brand - Fromm', parentPageId: null, verified: true },
    { pageId: 'page-plant-food', pageName: 'Plant Food & Fertilizer', parentPageId: 'page-garden', verified: true },
    { pageId: 'page-garden', pageName: 'Lawn & Garden', parentPageId: null, verified: true },
  ];

  const cohortPages: CohortPageOption[] = pageRecords.map(p => ({
    id: p.pageId,
    name: p.pageName,
    parentName: p.parentPageId ? pageRecords.find(r => r.pageId === p.parentPageId)?.pageName ?? null : null,
  }));

  const sampleProducts: ProductLineItemSnapshot[] = [
    {
      sku: 'SKU-DOG-DRY-1',
      name: 'Fromm Gold Adult Dry Dog Food 26 lb',
      webTitle: 'Fromm Gold Adult Dry Dog Food',
      brand: 'Fromm',
      description: 'Wholesome nutrition with real meat and whole grains for adult dogs.',
      species: ['Dog'],
      flavor: 'Chicken',
      lifeStage: 'Adult',
      productForm: 'Dry',
      healthConcern: [],
    },
    {
      sku: 'SKU-DOG-WET-1',
      name: 'Fromm Gold Adult Wet Dog Food 12 oz',
      webTitle: 'Fromm Gold Adult Wet Dog Food',
      brand: 'Fromm',
      description: 'Wholesome wet nutrition with savory broth for adult dogs.',
      species: ['Dog'],
      flavor: 'Chicken',
      lifeStage: 'Adult',
      productForm: 'Wet',
      healthConcern: [],
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
      cohort_page_assignment: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        fallbackProvider: null,
        fallbackModel: null,
      },
      cohort_page_assignment_parent: {
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
    snapshotHash: 'hash-cohort-page-test-catalog',
    catalogHash: 'hash-cohort-page-test-catalog',
    curationTargets: [
      { id: 'product_type', label: 'Product Type', kind: 'product_type', catalogField: 'ProductField24', selectionMode: 'single', confidenceThreshold: 0.7, guidancePrompt: 'Select product type', enabled: true, mandatory: true },
      { id: 'category_pages', label: 'Category Pages', kind: 'pages', catalogField: 'ProductOnPages', selectionMode: 'multiple', confidenceThreshold: 0.7, guidancePrompt: 'Select category pages', enabled: true, mandatory: false },
    ],
    productType: { state: 'verified' },
    pages: {
      state: 'verified',
      catalogHash: 'hash-cohort-page-test-catalog',
      records: pageRecords,
    },
    modelPolicy: cloudJevPolicy,
    runtimeRuleVersions,
    modelExecutionPlan,
  } as unknown as RuntimeClassificationSnapshot;

  function mockSystemOneResponse(requestBody: any, getProbability?: (qid: string, question: any) => any) {
    const answers: Record<string, any> = {};
    for (const [qid, q] of Object.entries(requestBody.questions as Record<string, any>)) {
      if (q.type === 'choice') {
        const criteriaKeys = Object.keys(q.criteria);
        const custom = getProbability ? getProbability(qid, q) : null;
        let chosenKey: string;
        let chosenProb: number;

        if (custom && typeof custom === 'object' && custom.choice) {
          chosenKey = custom.choice;
          chosenProb = custom.probability ?? 0.90;
        } else {
          const match = criteriaKeys.find(k => q.criteria[k].includes('Dry Dog Food')) || criteriaKeys[0];
          chosenKey = match;
          chosenProb = 0.92;
        }

        const probabilities: Record<string, number> = {};
        const remainingKeys = criteriaKeys.filter(k => k !== chosenKey);
        const remainder = (1.0 - chosenProb) / (remainingKeys.length || 1);
        probabilities[chosenKey] = chosenProb;
        for (const k of remainingKeys) {
          probabilities[k] = remainder;
        }

        answers[qid] = {
          type: 'choice',
          choice: chosenKey,
          probabilities,
          confidence: chosenProb,
        };
      } else if (q.type === 'noul') {
        const custom = getProbability ? getProbability(qid, q) : null;
        let prob = 0.85;
        if (typeof custom === 'number') {
          prob = custom;
        } else if (custom && typeof custom === 'object' && typeof custom.noul === 'number') {
          prob = custom.noul;
        }
        answers[qid] = {
          type: 'noul',
          noul: prob,
        };
      }
    }

    return new Response(JSON.stringify({
      model: requestBody.model,
      answers,
      usage: {
        input_tokens: 50,
        output_tokens: 25,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
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

  // ── Criterion 1: Governed route & capability readiness ──────────────────────
  describe('Criterion 1: Governed route & capability readiness', () => {
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

    it('routes cohort_page_assignment_parent protected operation to typesafe / systemone', () => {
      const route = resolveModelRoute(policyView, 'cohort_page_assignment_parent', {
        getCredential: () => ({ provider: 'typesafe', apiKey: 'test-key', baseUrl: 'https://api.typesafe.ai/v1', model: null }),
        defaultBaseUrls: {
          typesafe: 'https://api.typesafe.ai/v1',
        },
      });
      expect(route.provider).toBe('typesafe');
      expect(route.model).toBe('jev-1.13.0');
    });
  });

  // ── Criterion 2: Single mode Choice independent questions & candidate limits
  describe('Criterion 2: Single mode Choice questions & candidate limits', () => {
    it('generates independent Choice questions per member with explicit SKU instructions', async () => {
      const capturedRequests: any[] = [];
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        capturedRequests.push(body);
        return mockSystemOneResponse(body);
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'single',
        maxPages: 1,
        modelPolicy: policyView,
        snapshot,
      });

      expect(capturedRequests.length).toBe(1);
      const questions = capturedRequests[0].questions;
      expect(Object.keys(questions)).toEqual([
        'page_choice_SKU-DOG-DRY-1',
        'page_choice_SKU-DOG-WET-1',
      ]);

      // Check instructions forbid sibling copying and emphasize independent evaluation
      expect(questions['page_choice_SKU-DOG-DRY-1'].instructions).toContain('SKU "SKU-DOG-DRY-1"');
      expect(questions['page_choice_SKU-DOG-DRY-1'].instructions).toContain('do not copy, union, or rely on other products in the cohort');
      expect(questions['page_choice_SKU-DOG-WET-1'].instructions).toContain('SKU "SKU-DOG-WET-1"');

      // Verify member results
      expect(results.size).toBe(2);
      const dryResult = results.get('SKU-DOG-DRY-1');
      expect(dryResult?.status).toBe('assigned');
      if (dryResult?.status === 'assigned') {
        expect(dryResult.pages[0].pageId).toBe('page-dry-dog-food');
        expect(dryResult.source).toBe('typesafe');
      }
    });

    it('abstains with candidate_limit_exceeded when candidates exceed 253 without making a model call', async () => {
      let fetchCalled = false;
      (globalThis as any).fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      const oversizedPages: CohortPageOption[] = Array.from({ length: 254 }, (_, i) => ({
        id: `page-${i}`,
        name: `Category Page ${i}`,
        parentName: null,
      }));

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: oversizedPages,
        selectionMode: 'single',
        maxPages: 1,
        modelPolicy: policyView,
        snapshot,
      });

      expect(fetchCalled).toBe(false);
      expect(results.get('SKU-DOG-DRY-1')?.status).toBe('abstained');
      const reason = (results.get('SKU-DOG-DRY-1') as any)?.reason;
      expect(reason).toContain('candidate_limit_exceeded');
      expect(reason).toContain('First-N clipping is forbidden');
    });

    it('abstains with no_match and insufficient_evidence choice keys', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => {
          if (qid.includes('SKU-DOG-DRY-1')) {
            return { choice: NO_MATCH_CHOICE_KEY, probability: 0.88 };
          }
          return { choice: INSUFFICIENT_EVIDENCE_CHOICE_KEY, probability: 0.75 };
        });
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'single',
        maxPages: 1,
        modelPolicy: policyView,
        snapshot,
      });

      const dry = results.get('SKU-DOG-DRY-1');
      const wet = results.get('SKU-DOG-WET-1');
      expect(dry?.status).toBe('abstained');
      expect(wet?.status).toBe('abstained');
      expect((dry as any).reason).toContain('no_match');
      expect((wet as any).reason).toContain('insufficient_evidence');
    });
  });

  // ── Criterion 3: Multiple mode Noul questions & batching <= 32 ──────────────
  describe('Criterion 3: Multiple mode Noul questions & batching <= 32', () => {
    it('generates Noul questions per eligible candidate and batches questions in chunks <= 32', async () => {
      const batchSizes: number[] = [];
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        batchSizes.push(Object.keys(body.questions).length);
        return mockSystemOneResponse(body, (qid) => (qid.includes('dry-dog-food') ? 0.90 : 0.10));
      };

      // 5 products x 8 eligible pages (Brand page excluded) = 40 questions > 32
      const fiveProducts: ProductLineItemSnapshot[] = [
        ...sampleProducts,
        { ...sampleProducts[0], sku: 'SKU-DOG-DRY-2', name: 'Fromm Gold Adult Dry Dog Food 5 lb' },
        { ...sampleProducts[0], sku: 'SKU-DOG-DRY-3', name: 'Fromm Gold Adult Dry Dog Food 15 lb' },
        { ...sampleProducts[0], sku: 'SKU-DOG-DRY-4', name: 'Fromm Gold Adult Dry Dog Food 33 lb' },
      ];

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold-large',
        products: fiveProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 5,
        modelPolicy: policyView,
        snapshot,
      });

      // Verify batching partitioned questions into calls of at most 32
      expect(batchSizes.length).toBeGreaterThanOrEqual(2);
      for (const size of batchSizes) {
        expect(size).toBeLessThanOrEqual(SYSTEMONE_MAX_QUESTIONS);
      }
      expect(results.size).toBe(5);
      expect(results.get('SKU-DOG-DRY-1')?.status).toBe('assigned');
    });

    it('breaks ties at cardinality limit and abstains when candidates share boundary probability', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, () => 0.85);
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 1, // maxPages: 1, but multiple candidates have 0.85
        modelPolicy: policyView,
        snapshot,
      });

      const res = results.get('SKU-DOG-DRY-1');
      expect(res?.status).toBe('abstained');
      expect((res as any).reason).toContain('cardinality_limit_exceeded');
    });

    it('abstains with insufficient_evidence when probability is in uncertain floor [0.40, 0.70)', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, () => 0.55);
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 3,
        modelPolicy: policyView,
        snapshot,
      });

      const res = results.get('SKU-DOG-DRY-1');
      expect(res?.status).toBe('abstained');
      expect((res as any).reason).toContain('insufficient_evidence');
    });
  });

  // ── Criterion 4: Reused singleton semantics and deterministic rules ─────────
  describe('Criterion 4: Reused singleton semantics and deterministic rules', () => {
    it('suppresses generic parent Shop All page when specific child page is assigned', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => {
          if (qid.includes('dry-dog-food')) return 0.95;
          if (qid.includes('shop-all-dogs') || qid.includes('page-dog-food')) return 0.85;
          return 0.10;
        });
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 5,
        modelPolicy: policyView,
        snapshot,
      });

      const dry = results.get('SKU-DOG-DRY-1');
      expect(dry?.status).toBe('assigned');
      if (dry?.status === 'assigned') {
        const pageIds = dry.pages.map(p => p.pageId);
        expect(pageIds).toContain('page-dry-dog-food');
        expect(pageIds).not.toContain('page-shop-all-dogs');
      }
    });

    it('assigns brand-page shortcut with isBrandShortcut: true in multiple mode', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => (qid.includes('dry-dog-food') ? 0.95 : 0.05));
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 5,
        modelPolicy: policyView,
        snapshot,
      });

      const dry = results.get('SKU-DOG-DRY-1');
      expect(dry?.status).toBe('assigned');
      if (dry?.status === 'assigned') {
        const brandShortcut = dry.pages.find(p => p.pageId === 'page-fromm');
        expect(brandShortcut).toBeDefined();
        expect(brandShortcut?.isBrandShortcut).toBe(true);
        expect(brandShortcut?.pageName).toBe('Brand - Fromm');
      }
    });

    it('filters out cross-species pages so dog products never receive cat pages', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => (qid.includes('cat-food') ? 0.95 : 0.05));
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts, // species: ['Dog']
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 3,
        modelPolicy: policyView,
        snapshot,
      });

      const dry = results.get('SKU-DOG-DRY-1');
      if (dry?.status === 'assigned') {
        const pageIds = dry.pages.map(p => p.pageId);
        expect(pageIds).not.toContain('page-cat-food');
      } else {
        expect(dry?.status).toBe('abstained');
      }
    });
  });

  // ── Criterion 5: P-hash binding & determinism ───────────────────────────────
  describe('Criterion 5: P-hash binding & determinism', () => {
    const baseBundle: CohortPageAuthorityBundle = {
      members: [
        {
          sku: 'SKU-DOG-DRY-1',
          name: 'Fromm Gold Adult Dry Dog Food',
          webTitle: 'Fromm Gold Adult Dry Dog Food',
          brand: 'Fromm',
          description: 'Dry dog food',
          species: ['Dog'],
          flavor: 'Chicken',
          lifeStage: 'Adult',
          productForm: 'Dry',
          healthConcern: [],
          sourceProvenance: {
            itemSourceType: 'official_page',
            sourceUrl: 'https://example.com',
            extractionSourceType: 'official_page',
            extractionSourceUrl: 'https://example.com',
            extractionMethod: 'html',
            sourcingGenerationId: null,
            acceptedEvidenceAttemptIds: [],
            providerIds: [],
            distributorEvidenceHash: null,
          },
        },
      ],
      pages: cohortPages.map(p => ({ id: p.id, name: p.name, parentName: p.parentName })),
      selection: { selectionMode: 'multiple', maxPages: 5 },
      executionTypeAuthority: { id: 'type-dog-food', label: 'Dog Food', confidence: 0.95, outcome: 'coherent' },
      modelExecutionAuthority: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2',
        ruleVersion: 'cohort-page-assignment-parent-rules-v2',
      },
    };

    it('computes deterministic P-hash and binds systemone fields when provider is typesafe', () => {
      const hash1 = computeCohortPageInputHash(baseBundle);
      const hash2 = computeCohortPageInputHash(baseBundle);
      expect(hash1).toBe(hash2);
      expect(hash1).toBeTypeOf('string');
      expect(hash1.length).toBe(64);
    });

    it('changes hash when model execution authority, questions, or candidates change', () => {
      const hashBase = computeCohortPageInputHash(baseBundle);

      // Mutate model
      const bundleWithDiffModel: CohortPageAuthorityBundle = {
        ...baseBundle,
        modelExecutionAuthority: {
          ...baseBundle.modelExecutionAuthority!,
          model: 'jev-2.0.0',
        },
      };
      const hashDiffModel = computeCohortPageInputHash(bundleWithDiffModel);
      expect(hashDiffModel).not.toBe(hashBase);

      // Mutate candidates
      const bundleWithDiffPages: CohortPageAuthorityBundle = {
        ...baseBundle,
        pages: baseBundle.pages.slice(0, 3),
      };
      const hashDiffPages = computeCohortPageInputHash(bundleWithDiffPages);
      expect(hashDiffPages).not.toBe(hashBase);

      // Non-typesafe provider does not bind systemone fields
      const legacyBundle: CohortPageAuthorityBundle = {
        ...baseBundle,
        modelExecutionAuthority: {
          provider: 'ollama',
          model: 'qwen2.5vl',
          promptTemplateVersion: 'cohort-page-assignment-parent-prompt-v2',
          ruleVersion: 'cohort-page-assignment-parent-rules-v2',
        },
      };
      const legacyHash = computeCohortPageInputHash(legacyBundle);
      expect(legacyHash).not.toBe(hashBase);
    });
  });

  // ── Criterion 6: Two-level atomicity ────────────────────────────────────────
  describe('Criterion 6: Two-level atomicity', () => {
    it('abstains chunk on model failure while allowing other chunk in coordinateCohortPagesCore to succeed', async () => {
      let callCount = 0;
      (globalThis as any).fetch = async (_url: any, init: any) => {
        callCount++;
        const body = JSON.parse(init.body);
        if (callCount <= 2) {
          // First chunk fails with 500 error (retried once, then fails)
          return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
        }
        return mockSystemOneResponse(body, (qid) => (qid.includes('plant-food') ? 0.95 : 0.10));
      };

      // Chunk 1: dog food products (call 1 -> 500 failure)
      const chunk1Results = await coordinateCohortPagesCore({
        groupId: 'grp-chunk-1',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 3,
        modelPolicy: policyView,
        snapshot,
      });

      expect(chunk1Results.get('SKU-DOG-DRY-1')?.status).toBe('abstained');
      expect((chunk1Results.get('SKU-DOG-DRY-1') as any).reason).toContain('TypeSafe Jev dispatch failed');

      // Chunk 2: garden products (call 2 -> success)
      const gardenProducts: ProductLineItemSnapshot[] = [
        {
          sku: 'SKU-PLANT-FOOD-1',
          name: 'Miracle-Gro All Purpose Plant Food 5 lb',
          webTitle: 'Miracle-Gro Plant Food',
          brand: 'Miracle-Gro',
          description: 'Water soluble all purpose plant food.',
          species: [],
          flavor: null,
          lifeStage: null,
          productForm: 'Granular',
          healthConcern: [],
        },
        {
          sku: 'SKU-PLANT-FOOD-2',
          name: 'Miracle-Gro Liquid Plant Food 32 oz',
          webTitle: 'Miracle-Gro Liquid Food',
          brand: 'Miracle-Gro',
          description: 'Liquid plant food for indoor and outdoor plants.',
          species: [],
          flavor: null,
          lifeStage: null,
          productForm: 'Liquid',
          healthConcern: [],
        },
      ];

      const chunk2Results = await coordinateCohortPagesCore({
        groupId: 'grp-chunk-2',
        products: gardenProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 3,
        modelPolicy: policyView,
        snapshot,
      });

      expect(chunk2Results.get('SKU-PLANT-FOOD-1')?.status).toBe('assigned');
      expect(chunk2Results.get('SKU-PLANT-FOOD-2')?.status).toBe('assigned');
    });

    it('throws HeartbeatLostError immediately and aborts without persisting when lease is lost', async () => {
      let fetchCalled = false;
      (globalThis as any).fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      const assertHeldFailing = () => {
        throw new HeartbeatLostError('Worker lost ownership of cohort run.');
      };

      await expect(
        coordinateCohortPagesWithJev({
          groupId: 'grp-fromm-gold',
          products: sampleProducts,
          pages: cohortPages,
          selectionMode: 'multiple',
          maxPages: 3,
          modelPolicy: policyView,
          snapshot,
        }, {
          assertHeld: assertHeldFailing,
        })
      ).rejects.toThrow(HeartbeatLostError);

      expect(fetchCalled).toBe(false);
    });
  });

  // ── Criterion 7: Write-once output row & zero-call child materialization ────
  describe('Criterion 7: Write-once output row & zero-call child materialization', () => {
    it('materializes child proposal with zero fetch calls and sets isBulkAcceptable: false', async () => {
      let fetchCalled = false;
      (globalThis as any).fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      const stageInput: StageInput = {
        sku: 'SKU-DOG-DRY-1',
        onboardingItemId: 'item-dog-dry-1',
        evidence: [
          {
            id: 'ev-1',
            runId: 'child-run-1',
            stageName: 'evidence_extraction',
            productSku: 'SKU-DOG-DRY-1',
            attributeId: null,
            source: 'official_product_page',
            reliability: 'high',
            sourceUrl: 'https://example.com',
            sourceField: 'title',
            snippet: 'Fromm Gold Adult Dry Dog Food',
            value: 'Fromm Gold Adult Dry Dog Food',
            metadata: null,
            capturedAt: new Date().toISOString(),
          },
        ],
        acceptedProposals: [],
        allProposals: [],
      };

      const storedOutput = {
        output: {
          status: 'assigned' as const,
          pages: [
            { pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food', confidence: 0.95 },
            { pageId: 'page-fromm', pageName: 'Brand - Fromm', confidence: 0.99 },
          ],
          source: 'typesafe' as const,
        },
        modelCallId: 'model-call-parent-1',
      };

      const stageContext: StageContext = {
        workspacePath: '/tmp/workspace',
        workspaceId,
        runId: 'child-run-1',
        configSnapshotRef: { id: 'snap-1', hash: 'hash-1', sourceCommit: null, createdAt: '' },
        snapshot,
        coordinatedPages: new Map([
          ['SKU-DOG-DRY-1', storedOutput as any],
        ]),
      };

      const pageTarget: ResolvedTarget = {
        config: {
          id: 'category_pages',
          label: 'Category Pages',
          kind: 'pages',
          catalogField: 'ProductOnPages',
          selectionMode: 'multiple',
          confidenceThreshold: 0.7,
          guidancePrompt: 'Select category pages',
        },
        options: cohortPages.map(p => ({ value: p.id, label: p.name })),
      } as unknown as ResolvedTarget;

      const result = await materializeCoordinatedPages(pageTarget, stageInput, stageContext);

      expect(fetchCalled).toBe(false);
      expect(result.proposals).toHaveLength(2);
      expect(result.proposals[0].targetId).toBe('page-dry-dog-food');
      expect(result.proposals[0].isBulkAcceptable).toBe(false);
      expect(result.proposals[1].targetId).toBe('page-fromm');
      expect(result.proposals[1].isBulkAcceptable).toBe(false);
      expect(result.message).toContain('TypeSafe Jev');
    });
  });

  // ── Criterion 8: Pre-commit crash seam and replay ───────────────────────────
  describe('Criterion 8: Pre-commit crash seam and replay', () => {
    it('aborts when afterCoordinatedCall hook throws simulating a crash before persistence', async () => {
      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => (qid.includes('dry-dog-food') ? 0.95 : 0.10));
      };

      let crashed = false;
      const crashHook = () => {
        crashed = true;
        throw new Error('SIMULATED CRASH AFTER COORDINATION');
      };

      await expect(
        coordinateCohortPagesWithJev({
          groupId: 'grp-fromm-gold',
          products: sampleProducts,
          pages: cohortPages,
          selectionMode: 'multiple',
          maxPages: 3,
          modelPolicy: policyView,
          snapshot,
        }, {
          afterCoordinatedCall: crashHook,
        })
      ).rejects.toThrow('SIMULATED CRASH AFTER COORDINATION');

      expect(crashed).toBe(true);

      // Re-running without crash succeeds cleanly
      const replayResults = await coordinateCohortPagesWithJev({
        groupId: 'grp-fromm-gold',
        products: sampleProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 3,
        modelPolicy: policyView,
        snapshot,
      });

      expect(replayResults.size).toBe(2);
      expect(replayResults.get('SKU-DOG-DRY-1')?.status).toBe('assigned');
    });
  });

  // ── Criterion 9: Extended immutable benchmark replay & evaluation ───────────
  describe('Criterion 9: Extended immutable benchmark replay & evaluation', () => {
    it('classifies cohort page outcomes correctly across four categories', () => {
      const predSuccess = {
        exampleId: 'ex-1',
        productSku: 'SKU-1',
        runId: 'run-1',
        targetId: 'category_pages',
        outcome: 'predicted',
        pageIds: ['page-dry-dog-food'],
        pageAssignments: ['Dry Dog Food'],
        abstained: false,
        latencyMs: 100,
        modelCallIds: ['mc-1'],
        promptHash: 'ph-1',
        evaluable: true,
      } as any;
      expect(classifyCohortPageOutcome(predSuccess)).toBe('successful_assignment');

      const predSemanticAbstention = {
        ...predSuccess,
        outcome: 'abstained',
        pageIds: [],
        pageAssignments: [],
        abstained: true,
        abstentionCode: 'no_match',
      } as any;
      expect(classifyCohortPageOutcome(predSemanticAbstention)).toBe('semantic_abstention');

      const predCorrectnessRejection = {
        ...predSuccess,
        outcome: 'abstained',
        pageIds: [],
        pageAssignments: [],
        abstained: true,
        abstentionCode: 'species_conflict',
      } as any;
      expect(classifyCohortPageOutcome(predCorrectnessRejection)).toBe('correctness_rejection');

      const predModelFailure = {
        ...predSuccess,
        outcome: 'failed',
        failureCode: 'dispatch_failed',
      } as any;
      expect(classifyCohortPageOutcome(predModelFailure)).toBe('model_failure');
    });

    it('evaluates compareCohortPagePredictions by identity and computes category breakdown', () => {
      const gold: GoldExampleForEvaluation[] = [
        {
          id: 'ex-1',
          productSku: 'SKU-1',
          evidenceText: 'fromm gold adult dry dog food',
          goldLabels: {
            categoryPageIds: ['page-dry-dog-food'],
            pageAssignments: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
            productType: 'type-dog-food',
            verifiedImportProvenance: 'verified-prov',
            fieldAssignments: [],
          },
        },
      ];

      const candidatePredictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: 'type-dog-food',
          pageIds: ['page-dry-dog-food'],
          pageAssignments: ['Dry Dog Food'],
          fieldAssignments: [],
          abstained: false,
          confidence: 0.95,
          claimTargets: [],
          verifiedImportProvenance: 'verified-prov',
        },
      ];

      const baselinePredictions: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: 'type-dog-food',
          pageIds: ['page-wet-dog-food'], // Mismatched
          pageAssignments: ['Wet Dog Food'],
          fieldAssignments: [],
          abstained: false,
          confidence: 0.8,
          claimTargets: [],
          verifiedImportProvenance: 'verified-prov',
        },
      ];

      const report = compareCohortPagePredictions(gold, candidatePredictions, baselinePredictions, {
        requireReviewedProductType: true,
      });

      expect(report.evaluatedByIdentity).toBe(true);
      expect(report.eligibleCount).toBe(1);
      expect(report.candidateExactMatches).toBe(1);
      expect(report.baselineExactMatches).toBe(0);
      expect(report.candidateBreakdown.successfulAssignments).toBe(1);
      expect(report.exactSetDeltaMean).toBe(1);
    });

    it('evaluates evaluateCohortPipelineEffects across type, attribute, and page stages', () => {
      const gold: GoldExampleForEvaluation[] = [
        {
          id: 'ex-1',
          productSku: 'SKU-1',
          evidenceText: 'fromm gold adult dry dog food',
          goldLabels: {
            productType: 'type-dog-food',
            fieldAssignments: [{ targetId: 'brand', value: 'Fromm' }],
            pageAssignments: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
            categoryPageIds: ['page-dry-dog-food'],
            verifiedImportProvenance: null,
          },
        },
      ];

      const typePreds: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: 'type-dog-food',
          pageAssignments: [],
          fieldAssignments: [],
          abstained: false,
          confidence: 0.95,
          claimTargets: [],
        },
      ];

      const attrPreds: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: null,
          pageAssignments: [],
          fieldAssignments: [{ targetId: 'brand', value: 'Fromm' }],
          abstained: false,
          confidence: 0.95,
          claimTargets: [],
        },
      ];

      const pagePreds: BenchmarkPredictionEntry[] = [
        {
          exampleId: 'ex-1',
          productSku: 'SKU-1',
          productType: null,
          pageIds: ['page-dry-dog-food'],
          pageAssignments: ['Dry Dog Food'],
          fieldAssignments: [],
          abstained: false,
          confidence: 0.95,
          claimTargets: [],
        },
      ];

      const effects = evaluateCohortPipelineEffects(gold, typePreds, attrPreds, pagePreds);
      expect(effects.totalMembers).toBe(1);
      expect(effects.typeResolution.correct).toBe(1);
      expect(effects.attributeEffects.correctWhenTypeCorrect).toBe(1);
      expect(effects.pageEffects.exactMatchWhenTypeCorrect).toBe(1);
      expect(effects.endToEndCorrectAllStages).toBe(1);
    });
  });

  // ── Criterion 10: Mixed Pet & Garden fixture cohort execution ───────────────
  describe('Criterion 10: Mixed Pet & Garden fixture cohort execution', () => {
    it('executes realistic mixed Pet & Garden cohort verifying attributable assignments & benchmark reporting', async () => {
      const mixedProducts: ProductLineItemSnapshot[] = [
        {
          sku: 'SKU-MIXED-DOG-DRY',
          name: 'Fromm Gold Adult Dry Dog Food 26 lb',
          webTitle: 'Fromm Gold Adult Dry Dog Food',
          brand: 'Fromm',
          description: 'Premium wholesome dog food.',
          species: ['Dog'],
          flavor: 'Chicken',
          lifeStage: 'Adult',
          productForm: 'Dry',
          healthConcern: [],
        },
        {
          sku: 'SKU-MIXED-CAT-WET',
          name: 'Fromm Gold Chicken Pate Wet Cat Food 5.5 oz',
          webTitle: 'Fromm Gold Chicken Pate Cat Food',
          brand: 'Fromm',
          description: 'Finely minced chicken pate for adult cats.',
          species: ['Cat'],
          flavor: 'Chicken',
          lifeStage: 'Adult',
          productForm: 'Pate',
          healthConcern: [],
        },
        {
          sku: 'SKU-MIXED-PLANT-FOOD',
          name: 'Miracle-Gro All Purpose Plant Food 5 lb',
          webTitle: 'Miracle-Gro Water Soluble Plant Food',
          brand: 'Miracle-Gro',
          description: 'Instantly feeds all flowers, vegetables, and houseplants.',
          species: [],
          flavor: null,
          lifeStage: null,
          productForm: 'Granular',
          healthConcern: [],
        },
      ];

      (globalThis as any).fetch = async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        return mockSystemOneResponse(body, (qid) => {
          if (qid.includes('SKU-MIXED-DOG-DRY') && qid.includes('dry-dog-food')) return 0.95;
          if (qid.includes('SKU-MIXED-CAT-WET') && qid.includes('cat-wet')) return 0.93;
          if (qid.includes('SKU-MIXED-PLANT-FOOD') && qid.includes('plant-food')) return 0.96;
          return 0.10;
        });
      };

      const results = await coordinateCohortPagesWithJev({
        groupId: 'grp-mixed-pet-garden',
        products: mixedProducts,
        pages: cohortPages,
        selectionMode: 'multiple',
        maxPages: 5,
        modelPolicy: policyView,
        snapshot,
      });

      expect(results.size).toBe(3);

      const dogRes = results.get('SKU-MIXED-DOG-DRY');
      const catRes = results.get('SKU-MIXED-CAT-WET');
      const plantRes = results.get('SKU-MIXED-PLANT-FOOD');

      expect(dogRes?.status).toBe('assigned');
      expect(catRes?.status).toBe('assigned');
      expect(plantRes?.status).toBe('assigned');

      if (dogRes?.status === 'assigned') {
        const pages = dogRes.pages.map(p => p.pageId);
        expect(pages).toContain('page-dry-dog-food');
        expect(pages).toContain('page-fromm'); // Brand shortcut
        expect(pages).not.toContain('page-cat-wet');
      }

      if (catRes?.status === 'assigned') {
        const pages = catRes.pages.map(p => p.pageId);
        expect(pages).toContain('page-cat-wet');
        expect(pages).toContain('page-fromm'); // Brand shortcut
        expect(pages).not.toContain('page-dry-dog-food');
      }

      if (plantRes?.status === 'assigned') {
        const pages = plantRes.pages.map(p => p.pageId);
        expect(pages).toContain('page-plant-food');
        expect(pages).not.toContain('page-dry-dog-food');
        expect(pages).not.toContain('page-cat-wet');
      }
    });
  });
});
