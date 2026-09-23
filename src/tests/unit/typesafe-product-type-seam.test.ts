/**
 * TypeSafe Jev Product Type Seam Verification (Issue #297 / Criterion 10).
 *
 * Full seam verification with HTTP mocked across:
 * - valid types (canonical ID resolution)
 * - no-fit (explicit semantic abstention)
 * - insufficient evidence (explicit semantic abstention)
 * - duplicate labels (request-local key resolution to canonical IDs)
 * - option limits (> 253 candidate limit abstention without clipping)
 * - policy denial (cloud locality / provider not permitted)
 * - model mismatch (returned model differs from requested model)
 * - transient attempts (429 retry backoff and recovery)
 * - disablement (connection enabled: false rejected before transport)
 * - ownership loss (HeartbeatLostError rethrown without post-loss writes)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun, getRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { resolveProductTypeDecision, MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES } from '../../classification/product-type-decision';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2 } from '../../shared/schemas/classification';

describe('TypeSafe Jev Product Type Seam Verification (Criterion 10)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-seam-test';

  const defaultOptions: ResolvedTargetOption[] = [
    { value: 'dog-food', label: 'Dog Food' },
    { value: 'cat-food', label: 'Cat Food' },
    { value: 'bird-seed', label: 'Bird Seed' },
  ];

  const defaultTarget = {
    config: {
      id: 'primary_product_type',
      label: 'Primary Product Type',
      kind: 'product_type',
      attributeId: null,
      catalogField: 'ProductType',
      selectionMode: 'single',
      confidenceThreshold: 0.7,
      guidancePrompt: 'Classify primary product type',
    },
    options: defaultOptions,
    attribute: null,
  } as unknown as ResolvedTarget;

  const sampleEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-seam-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-SEAM-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'title',
      snippet: 'Premium Grain-Free Chicken Formula',
      value: 'Premium Grain-Free Chicken Formula',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-seam-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-SEAM-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
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

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'ts-secret-key-297',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
  });

  it('1. valid types: resolves canonical ID with separate probability and confidence basis', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-VALID', null, 'hash-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('/v1/systemone');
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('jev-1.13.0');
      expect(body.questions.primary_product_type.criteria.opt_0).toContain('Dog Food');

      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.82,
                opt_1: 0.08,
                opt_2: 0.05,
                no_match: 0.03,
                insufficient_evidence: 0.02,
              },
              confidence: 0.91,
            },
          },
          usage: { input_tokens: 150, output_tokens: 12 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-VALID',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food');
    expect(decision.confidence).toBe(0.82);
    expect(decision.selectedProbability).toBe(0.82);
    expect(decision.vendorConfidence).toBe(0.91);
    expect(decision.probabilityBasis).toBe('choice_probability');
    expect(decision.source).toBe('jev');
    expect(decision.derivation.kind).toBe('systemone_judgment');

    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('success');
    expect(calls[0].requested_model).toBe('jev-1.13.0');
    expect(calls[0].resolved_model).toBe('jev-1.13.0');
    expect(calls[0].typed_result_json).toBeDefined();
  });

  it('2. no-fit: handles no_match as explicit semantic abstention', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-NOFIT', null, 'hash-2');
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
              confidence: 0.88,
            },
          },
          usage: { input_tokens: 120, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-NOFIT',
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

  it('3. insufficient evidence: handles insufficient_evidence as explicit semantic abstention', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-INSUFFICIENT', null, 'hash-3');
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
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-INSUFFICIENT',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('abstained');
    expect(decision.productTypeId).toBeNull();
    expect(decision.abstentionCode).toBe('insufficient_evidence');
    expect(decision.abstentionReason).toContain('insufficient_evidence');
    expect(decision.derivation.kind).toBe('systemone_judgment');
  });

  it('4. duplicate labels: maps request-local keys directly to unique canonical IDs', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-DUPE', null, 'hash-4');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const duplicateTarget = {
      config: defaultTarget.config,
      options: [
        { value: 'dog-chews', label: 'Chews' },
        { value: 'cat-chews', label: 'Chews' },
      ],
      attribute: null,
    } as unknown as ResolvedTarget;

    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init?.body as string);
      const criteria = body.questions.primary_product_type.criteria;
      expect(criteria.opt_0).toBe('Chews');
      expect(criteria.opt_1).toBe('Chews');

      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_1',
              probabilities: {
                opt_0: 0.10,
                opt_1: 0.85,
                no_match: 0.02,
                insufficient_evidence: 0.03,
              },
              confidence: 0.90,
            },
          },
          usage: { input_tokens: 110, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: duplicateTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-DUPE',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('cat-chews');
    expect(decision.confidence).toBe(0.85);
  });

  it('5. option limits: produces explicit candidate-limit abstention for >253 candidates without first-N clipping', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-LIMIT', null, 'hash-5');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}');
    }) as any;

    const largeOptions: ResolvedTargetOption[] = Array.from({ length: 254 }, (_, i) => ({
      value: `pt-${i}`,
      label: `Product Type ${i}`,
    }));

    const decision = await resolveProductTypeDecision({
      target: { ...defaultTarget, options: largeOptions },
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-LIMIT',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false);
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('candidate_limit_exceeded');
    expect(decision.abstentionReason).toContain('exceed maximum Choice capacity');
  });

  it('6. policy denial: denies cloud locality when textDataSharing forbids cloud', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-DENIED', null, 'hash-6');

    const deniedPolicy: ModelPolicyConfigV2 = {
      ...cloudJevPolicy,
      textDataSharing: 'local_only',
    };
    const policyView = buildModelPolicyView(deniedPolicy);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}');
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-DENIED',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false);
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('policy_denied');

    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('policy_denied');
  });

  it('7. model mismatch: fails closed when returned model differs from requested model', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-MISMATCH', null, 'hash-7');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-unauthorized-substitute',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.80,
                opt_1: 0.10,
                opt_2: 0.05,
                no_match: 0.03,
                insufficient_evidence: 0.02,
              },
              confidence: 0.90,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-MISMATCH',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('failed');
    expect(decision.productTypeId).toBeNull();
    expect(decision.abstentionCode).toBe('service_failure');

    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('failed');
  });

  it('8. transient attempts: retries 429 once with backoff and records attempt', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-RETRY', null, 'hash-8');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: 'rate limit' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
        });
      }
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.85,
                opt_1: 0.05,
                opt_2: 0.05,
                no_match: 0.03,
                insufficient_evidence: 0.02,
              },
              confidence: 0.92,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveProductTypeDecision({
      target: defaultTarget,
      evidence: sampleEvidence,
      sku: 'SKU-SEAM-RETRY',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(attempts).toBe(2);
    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food');
  });

  it('9. disablement: fails closed before transport when connection is disabled', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-DISABLED', null, 'hash-9');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'ts-secret-key-297',
      enabled: false,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}');
    }) as any;

    await expect(
      resolveProductTypeDecision({
        target: defaultTarget,
        evidence: sampleEvidence,
        sku: 'SKU-SEAM-DISABLED',
        runId: run.id,
        modelPolicy: policyView,
      }),
    ).rejects.toThrow();

    expect(fetchCalled).toBe(false);
  });

  it('10. ownership loss: rethrows HeartbeatLostError immediately with no post-loss writes', async () => {
    const run = createRun(workspaceId, 'SKU-SEAM-LEASE', null, 'hash-10');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let assertHeldCallCount = 0;
    const assertHeld = () => {
      assertHeldCallCount += 1;
      if (assertHeldCallCount >= 3) {
        throw new HeartbeatLostError('Heartbeat lost for run ' + run.id);
      }
    };

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_0',
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
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    await expect(
      resolveProductTypeDecision({
        target: defaultTarget,
        evidence: sampleEvidence,
        sku: 'SKU-SEAM-LEASE',
        runId: run.id,
        modelPolicy: policyView,
        assertHeld,
      }),
    ).rejects.toThrow(HeartbeatLostError);

    // After ownership loss, the started call must NOT have been completed as success
    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('started');
  });
});
