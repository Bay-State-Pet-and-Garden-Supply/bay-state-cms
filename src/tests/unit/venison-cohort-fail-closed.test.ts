/**
 * Issue #304 — venison cohort fail-closed regression (candidate fix 1:
 * family-aware ranker context).
 *
 * Three pins at the existing public seams (no private-helper assertions,
 * no test-only production interfaces):
 *
 * 1. Sibling context is prompt context only: the Jev Choice request body
 *    carries the framed family context (assert the sibling verdict text is
 *    in the dispatched state). The ranker may still misfire wet — sibling
 *    outcomes never suppress another SKU's classification, so the model's
 *    own wet verdict stands as resolved. The Jev call still writes its
 *    `classification_model_calls` row (ranker observability).
 * 2. Own-SKU reviewed precedence: a reviewed dry pair resolves through the
 *    same boundary as a 1.0 evidence_match before keyword/LLM/Jev, with
 *    zero transport/model-call rows, and curates through.
 * 3. Sibling context is context only: a NON-unanimous sibling set never
 *    vetoes a model pick, and a unanimous consensus never force-types an
 *    abstaining member (no inheritance).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { resolveProductTypeDecision } from '../../classification/product-type-decision';
import { processProductTypeTarget } from '../../classification/curation-target-processor';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2 } from '../../shared/schemas/classification';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { StageContext, StageInput } from '../../classification/types';

describe('venison cohort fail-closed (issue #304)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-venison-304';

  const options = [
    { value: 'dog-food-dry', label: 'Dry Dog Food' },
    { value: 'dog-food-wet', label: 'Wet Dog Food' },
  ];

  const target = {
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
    options,
    attribute: null,
  } as unknown as ResolvedTarget;

  // Terse 4LB distributor-title packet: brand + title only, no Dry/Wet/Food
  // tokens. Keyword matching abstains on it (no confident option hit).
  const terseEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-ven-1',
      runId: 'run-venison',
      stageName: 'evidence_extraction',
      productSku: 'SKU-VENISON-4LB',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: null,
      sourceField: 'title',
      snippet: 'OPEN FARM DOG ANCIENT GRAINS VENISON 4LBS',
      value: 'OPEN FARM DOG ANCIENT GRAINS VENISON 4LBS',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-ven-2',
      runId: 'run-venison',
      stageName: 'evidence_extraction',
      productSku: 'SKU-VENISON-4LB',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: null,
      sourceField: 'brand',
      snippet: 'Open Farm',
      value: 'Open Farm',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
  ];

  const siblingDry = {
    siblings: [{ productTypeId: 'dog-food-dry', label: 'Dry Dog Food', confidence: 0.85 }],
  };

  const cloudJevPolicy: ModelPolicyConfigV2 = {
    defaultProvider: 'typesafe',
    defaultModel: 'jev-1.13.0',
    providerLocalities: { typesafe: 'cloud' },
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

  /** Captured Jev request bodies, in dispatch order. */
  let dispatchedBodies: string[];

  /** Jev transport answering WET with high probability (the stable misfire). */
  function misfiringWetTransport(): void {
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === 'string') dispatchedBodies.push(init.body);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            primary_product_type: {
              type: 'choice',
              choice: 'opt_1',
              probabilities: {
                opt_0: 0.05,
                opt_1: 0.85,
                no_match: 0.05,
                insufficient_evidence: 0.05,
              },
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 150, output_tokens: 12 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    dispatchedBodies = [];
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'fixture304',
      enabled: true,
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'healthy',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as unknown as Parameters<typeof upsertProviderConnection>[0]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
  });

  it('terse packet + unanimous dry siblings → sibling context rides the ranker prompt; wet ranker misfire stands (no veto, ranker call audited)', async () => {
    const run = createRun(workspaceId, 'SKU-VENISON-4LB', null, 'hash-venison');
    misfiringWetTransport();

    const decision = await resolveProductTypeDecision({
      target,
      evidence: terseEvidence,
      sku: 'SKU-VENISON-4LB',
      runId: run.id,
      modelPolicy: buildModelPolicyView(cloudJevPolicy),
      siblingContext: siblingDry,
    });

    // Sibling context is rendered into the ranker prompt as framed family
    // context (advisory string), never as inherited facts.
    expect(dispatchedBodies).toHaveLength(1);
    expect(dispatchedBodies[0]).toContain('Dry Dog Food');
    expect(dispatchedBodies[0]).toContain('dog-food-dry');
    // Sibling outcomes never suppress this SKU: the model's own wet verdict
    // stands — no confident-wrong abstention via a family veto.
    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food-wet');
    // The ranker invocation is observable: one audited model-call row.
    expect(decision.modelCallIds).toHaveLength(1);
    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe('product_type_ranking');
    expect(calls[0].status).toBe('success');
  });

  it('reviewer-corrected dry pair resolves 1.0 evidence_match before keyword/LLM/Jev (no model call)', async () => {
    const run = createRun(workspaceId, 'SKU-VENISON-4LB', null, 'hash-venison-reviewed');
    // No transport stubbed: any model call would throw through fetch.
    globalThis.fetch = (() => {
      throw new Error('no transport expected for reviewed precedence');
    }) as unknown as typeof fetch;

    const decision = await resolveProductTypeDecision({
      target,
      evidence: terseEvidence,
      sku: 'SKU-VENISON-4LB',
      runId: run.id,
      modelPolicy: buildModelPolicyView(cloudJevPolicy),
      reviewedPair: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
      siblingContext: siblingDry,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food-dry');
    expect(decision.confidence).toBe(1.0);
    expect(decision.derivation.kind).toBe('evidence_match');
    expect(decision.modelCallIds).toHaveLength(0);
    expect(getModelCallsByRun(run.id)).toHaveLength(0);
    // Issue #304 member pipeline seam: the same reviewer-corrected pair,
    // carried on the member's own frozen snapshot, curates through
    // `processProductTypeTarget` — the corrected pair resolves on the 1.0
    // evidence_match path and flows toward curation with zero transport and
    // no evidence surgery. Sibling context stays advisory-only: no veto is
    // reintroduced here (divergent-sibling non-inheritance stays pinned by
    // the surrounding tests).
    const reviewedSnapshot = {
      workspaceId,
      productSku: 'SKU-VENISON-4LB',
      snapshotHash: 'hash-venison-reviewed',
      modelPolicy: cloudJevPolicy,
      productTypes: [{ id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' }],
      categories: [{ id: 'dog-food', name: 'Dog Food' }],
      reviewedFacts: [
        {
          proposalId: 'prior-pair',
          decisionId: 'prior-pair-decision',
          runId: 'prior-run',
          workspaceId,
          productSku: 'SKU-VENISON-4LB',
          proposalType: 'product_classification',
          targetId: 'dog-food-dry',
          value: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
          configSnapshotHash: null,
          sourceHash: null,
          createdAt: new Date().toISOString(),
        },
      ],
    } as unknown as RuntimeClassificationSnapshot; // seam fixture: only own-SKU reviewed-pair + type-mapping fields are read
    const seamInput = {
      sku: 'SKU-VENISON-4LB',
      evidence: terseEvidence,
      acceptedProposals: [],
      allProposals: [],
    } satisfies StageInput;
    const seamContext = {
      workspacePath: 'venison-304',
      workspaceId,
      configSnapshotRef: { id: 'cfg-venison', hash: 'cfg-hash-venison', sourceCommit: null, createdAt: new Date().toISOString() },
      snapshot: reviewedSnapshot,
      runId: run.id,
    } satisfies StageContext;
    const seamResult = await processProductTypeTarget(target, seamInput, seamContext);

    expect(seamResult.proposals).toHaveLength(1);
    expect(seamResult.proposals[0].proposalType).toBe('product_classification');
    expect(seamResult.proposals[0].targetId).toBe('dog-food-dry');
    expect(seamResult.proposals[0].proposedValue).toMatchObject({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' });
    expect(seamResult.proposals[0].confidence).toBe(1.0);
    expect(seamResult.proposals[0].derivation).toMatchObject({ kind: 'evidence_match' });
    // Still zero transport through the seam: no model-call rows recorded.
    expect(getModelCallsByRun(run.id)).toHaveLength(0);
  });

  it('sibling context never force-types: no unanimous consensus and no own evidence → ranker outcome stands', async () => {
    const run = createRun(workspaceId, 'SKU-VENISON-4LB', null, 'hash-venison-split');
    misfiringWetTransport();

    const decision = await resolveProductTypeDecision({
      target,
      evidence: terseEvidence,
      sku: 'SKU-VENISON-4LB',
      runId: run.id,
      modelPolicy: buildModelPolicyView(cloudJevPolicy),
      siblingContext: {
        siblings: [
          { productTypeId: 'dog-food-dry', label: 'Dry Dog Food', confidence: 0.85 },
          { productTypeId: 'dog-food-wet', label: 'Wet Dog Food', confidence: 0.8 },
        ],
      },
    });

    // Divergent siblings: no consensus authority — the (wrong) model pick
    // stands as the model's own verdict, honoring "never force-type the member".
    expect(decision.status).toBe('resolved');
    expect(decision.productTypeId).toBe('dog-food-wet');
    expect(getModelCallsByRun(run.id)).toHaveLength(1);
  });
});
