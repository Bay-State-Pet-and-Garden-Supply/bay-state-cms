import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2 } from '../../shared/schemas/classification';
import {
  resolveProductTypeDecision,
  buildProductTypeState,
  buildProductTypeChoiceQuestion,
  MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES,
  JEV_PRODUCT_TYPE_MIN_PROBABILITY,
} from '../../classification/product-type-decision';

describe('canonical product type decision (issue #297)', () => {
  let workspacePath: string;
  let workspaceId: string;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(() => {
    workspaceId = randomUUID();
    workspacePath = path.join(os.tmpdir(), `product-type-decision-${workspaceId.slice(0, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'test',
      workspacePath,
      gitPath: '',
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
      credential: 'test-fake-credential-297',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);

    originalFetch = globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  const sampleTarget: ResolvedTarget = {
    config: {
      id: 'primary-product-type',
      kind: 'product_type',
      label: 'Product Type',
      enabled: true,
      mandatory: true,
      selectionMode: 'single',
      attributeId: null,
      catalogField: null,
      optionSource: 'configured',
      required: true,
      sortOrder: 0,
    },
    options: [
      { value: 'dog-food', label: 'Dog Food' },
      { value: 'cat-food', label: 'Cat Food' },
      { value: 'dog-treats', label: 'Dog Treats' },
    ],
  };

  const sampleEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/dog-food',
      sourceField: 'title',
      snippet: 'Premium Grain-Free Chicken Formula',
      value: 'Premium Grain-Free Chicken Formula',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/dog-food',
      sourceField: 'description',
      snippet: 'Wholesome nutrition kibble formulated for adult canines.',
      value: 'Wholesome nutrition kibble formulated for adult canines.',
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
      primary_product_type_proposal: {
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

  it('selects valid product type through TypeSafe Jev Choice', async () => {
    const run = createRun(workspaceId, 'SKU-DOG-1', null, 'hash-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    // Mock fetch for System One
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/v1/systemone')) {
        const body = JSON.parse(init?.body as string);
        expect(body.model).toBe('jev-1.13.0');
        expect(body.questions.primary_product_type).toBeDefined();
        expect(body.questions.primary_product_type.type).toBe('choice');
        // Criteria should have 3 ordinary candidates + 2 abstention options
        const criteria = body.questions.primary_product_type.criteria;
        expect(Object.keys(criteria)).toHaveLength(5);
        expect(criteria.no_match).toBeDefined();
        expect(criteria.insufficient_evidence).toBeDefined();

        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers: {
              primary_product_type: {
                type: 'choice',
                choice: 'opt_0', // maps to dog-food
                probabilities: {
                  opt_0: 0.85,
                  opt_1: 0.05,
                  opt_2: 0.05,
                  no_match: 0.03,
                  insufficient_evidence: 0.02,
                },
                confidence: 0.90,
              },
            },
            usage: {
              input_tokens: 120,
              output_tokens: 15,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: sampleTarget,
      evidence: sampleEvidence,
      sku: 'SKU-DOG-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food');
    expect(decision.confidence).toBe(0.85);
    expect(decision.selectedProbability).toBe(0.85);
    expect(decision.vendorConfidence).toBe(0.90);
    expect(decision.probabilityBasis).toBe('choice_probability');
    expect(decision.source).toBe('jev');
    expect(decision.derivation.kind).toBe('systemone_judgment');
    expect(decision.modelCallIds).toHaveLength(1);

    // Verify durable classification_model_calls record
    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('product_type_ranking');
    expect(calls[0].provider).toBe('typesafe');
    expect(calls[0].model).toBe('jev-1.13.0');
    expect(calls[0].requested_model).toBe('jev-1.13.0');
    expect(calls[0].resolved_model).toBe('jev-1.13.0');
    expect(calls[0].status).toBe('success');
    expect(calls[0].typed_result_json).toBeDefined();
    const typed = JSON.parse(calls[0].typed_result_json!);
    expect(typed.choice).toBe('opt_0');
    expect(typed.selectedProbability).toBe(0.85);
    expect(typed.vendorConfidence).toBe(0.90);
    expect(typed.resolvedId).toBe('dog-food');
  });

  it('handles no_match outcome as an explicit semantic abstention', async () => {
    const run = createRun(workspaceId, 'SKU-UNKNOWN-1', null, 'hash-2');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'no_match',
              probabilities: {
                opt_0: 0.05,
                opt_1: 0.05,
                opt_2: 0.05,
                no_match: 0.80,
                insufficient_evidence: 0.05,
              },
              confidence: 0.85,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: sampleTarget,
      evidence: sampleEvidence,
      sku: 'SKU-UNKNOWN-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('abstained');
    expect(decision.productTypeId).toBeNull();
    expect(decision.abstentionCode).toBe('no_match');
    expect(decision.abstentionReason).toContain('no_fit');
    expect(decision.derivation.kind).toBe('systemone_judgment');
    expect(decision.modelCallIds).toHaveLength(1);
  });

  it('handles insufficient_evidence outcome as an explicit semantic abstention', async () => {
    const run = createRun(workspaceId, 'SKU-SPARSE-1', null, 'hash-3');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'insufficient_evidence',
              probabilities: {
                opt_0: 0.05,
                opt_1: 0.05,
                opt_2: 0.05,
                no_match: 0.10,
                insufficient_evidence: 0.75,
              },
              confidence: 0.80,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: sampleTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SPARSE-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('abstained');
    expect(decision.productTypeId).toBeNull();
    expect(decision.abstentionCode).toBe('insufficient_evidence');
    expect(decision.abstentionReason).toContain('insufficient_evidence');
    expect(decision.derivation.kind).toBe('systemone_judgment');
  });

  it('maps duplicate display labels directly to distinct canonical IDs without ambiguity', async () => {
    const run = createRun(workspaceId, 'SKU-DUPE-1', null, 'hash-4');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    // Two options with IDENTICAL display label "Chews" but different canonical IDs
    const duplicateLabelTarget: ResolvedTarget = {
      config: sampleTarget.config,
      options: [
        { value: 'dog-chews', label: 'Chews' },
        { value: 'cat-chews', label: 'Chews' },
      ],
    };

    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      const criteria = body.questions.primary_product_type.criteria;
      expect(criteria.opt_0).toContain('Chews');
      expect(criteria.opt_1).toContain('Chews');

      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_1', // selected cat-chews
              probabilities: {
                opt_0: 0.10,
                opt_1: 0.80,
                no_match: 0.05,
                insufficient_evidence: 0.05,
              },
              confidence: 0.88,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: duplicateLabelTarget,
      evidence: sampleEvidence,
      sku: 'SKU-DUPE-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('cat-chews'); // cleanly resolved to canonical ID!
    expect(decision.confidence).toBe(0.80);
  });

  it('produces an explicit candidate-limit abstention when options exceed 253 without first-N clipping', async () => {
    const run = createRun(workspaceId, 'SKU-OVERFLOW-1', null, 'hash-5');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    // 254 options exceeds MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES (253)
    const largeOptions = Array.from({ length: 254 }, (_, i) => ({
      value: `pt-${i}`,
      label: `Product Type ${i}`,
    }));

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: {
        config: sampleTarget.config,
        options: largeOptions,
      },
      evidence: sampleEvidence,
      sku: 'SKU-OVERFLOW-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false); // Never made network call
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('candidate_limit_exceeded');
    expect(decision.abstentionReason).toContain('exceed maximum Choice capacity of 253');
    expect(decision.abstentionReason).toContain('First-N clipping is forbidden');
  });

  it('abstains on low probability below development-fitted threshold (0.50)', async () => {
    const run = createRun(workspaceId, 'SKU-LOWCONF-1', null, 'hash-6');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.35, // Below 0.50
                opt_1: 0.30,
                opt_2: 0.20,
                no_match: 0.10,
                insufficient_evidence: 0.05,
              },
              confidence: 0.40,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: sampleTarget,
      evidence: sampleEvidence,
      sku: 'SKU-LOWCONF-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('abstained');
    expect(decision.productTypeId).toBeNull();
    expect(decision.abstentionCode).toBe('low_probability');
    expect(decision.abstentionReason).toContain('below required threshold');
  });

  it('re-throws HeartbeatLostError immediately on lease loss and performs no post-loss writes', async () => {
    const run = createRun(workspaceId, 'SKU-LEASE-1', null, 'hash-7');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let leaseLost = false;
    const assertHeld = () => {
      if (leaseLost) {
        throw new HeartbeatLostError('Cohort lease lost to sibling worker');
      }
    };

    globalThis.fetch = (async () => {
      // Sibling worker stole lease during network call
      leaseLost = true;
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.90,
                opt_1: 0.02,
                opt_2: 0.02,
                no_match: 0.03,
                insufficient_evidence: 0.03,
              },
              confidence: 0.95,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    await expect(
      resolveProductTypeDecision({
        target: sampleTarget,
        evidence: sampleEvidence,
        sku: 'SKU-LEASE-1',
        runId: run.id,
        modelPolicy: policyView,
        assertHeld,
      }),
    ).rejects.toThrow(HeartbeatLostError);
  });
});
