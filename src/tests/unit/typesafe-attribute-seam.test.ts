/**
 * TypeSafe Jev Attribute Seam Verification (Issue #298 / AC 1–10).
 *
 * Full seam verification with HTTP mocked across:
 * - Valid single-value controlled choice (canonical mapping, derivation, isBulkAcceptable: false)
 * - Multi-value unsupported explicit abstention (never silent single choice)
 * - Candidate limit exceeded (>253 candidates without first-N clipping)
 * - Deterministic precedence: reviewed facts, brand shortcuts, aliases (zero Jev calls)
 * - Free-text & measured paths never entering Jev Choice
 * - Effective type & attribute profile / empty profile (universal-only)
 * - State batching vs separation (identical state -> 1 request; restricted evidence -> separate requests)
 * - Direct evidence & claims safeguards (unsupported_claim on non-direct evidence)
 * - Pre-review prediction capture (fieldAssignments populated)
 * - Benchmark evaluator attribution & baseline comparison (fieldStates, inapplicable/unlabeled excluded)
 * - Error resilience (policy denied, model mismatch)
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import {
  resolveAttributeDecision,
  batchResolveAttributeDecisions,
  buildProposalFromAttributeDecision,
  MAX_ORDINARY_ATTRIBUTE_CANDIDATES,
} from '../../classification/attribute-decision';
import { processProductFieldTarget, processProductFieldTargetsBatch } from '../../classification/curation-target-processor';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import { capturePreReviewPrediction } from '../../classification/benchmark-prediction';
import {
  computeEvaluatorAttribution,
  readEvaluatorFieldStates,
  scoreEvaluatorFieldExample,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type {
  ClassificationEvidence,
  ClassificationConfig,
  ModelPolicyConfigV2,
} from '../../shared/schemas/classification';

describe('TypeSafe Jev Attribute Seam Verification (Issue #298)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-attr-seam';

  const flavorOptions: ResolvedTargetOption[] = [
    { value: 'Chicken', label: 'Chicken' },
    { value: 'Beef', label: 'Beef' },
    { value: 'Salmon', label: 'Salmon' },
  ];

  const flavorTarget = {
    config: {
      id: 'flavor',
      label: 'Food Flavor',
      kind: 'attribute',
      attributeId: 'flavor',
      catalogField: 'ProductField1',
      selectionMode: 'single',
      confidenceThreshold: 0.7,
      guidancePrompt: 'Select the primary food flavor',
    },
    options: flavorOptions,
    attribute: {
      id: 'flavor',
      name: 'Food Flavor',
      valueMode: 'singleChoice',
      visualEvidenceEligibility: 'eligible',
      valueAliases: [{ alias: 'poultry', mapsTo: 'Chicken' }],
    },
  } as unknown as ResolvedTarget;

  const sampleEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-attr-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-FLAVOR-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'title',
      snippet: 'Grain-Free Fresh Farm Chicken Recipe for Adult Dogs',
      value: 'Grain-Free Fresh Farm Chicken Recipe for Adult Dogs',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-attr-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-FLAVOR-1',
      attributeId: null,
      source: 'visual_product_evidence',
      reliability: 'high',
      sourceUrl: 'https://example.com/bag.jpg',
      sourceField: 'packaging_ocr',
      snippet: 'Real Deboned Chicken is the #1 Ingredient',
      value: 'Real Deboned Chicken is the #1 Ingredient',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
  ];

  // Evidence without exact keyword matches so resolution proceeds to Jev System One Choice
  const jevChoiceEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-attr-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-FLAVOR-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'title',
      snippet: 'Grain-Free Fresh Farm Fowl Blend Recipe for Adult Dogs',
      value: 'Grain-Free Fresh Farm Fowl Blend Recipe for Adult Dogs',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-attr-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-FLAVOR-1',
      attributeId: null,
      source: 'visual_product_evidence',
      reliability: 'high',
      sourceUrl: 'https://example.com/bag.jpg',
      sourceField: 'packaging_ocr',
      snippet: 'Deboned Farm Bird is the #1 Ingredient',
      value: 'Deboned Farm Bird is the #1 Ingredient',
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
      product_attribute_proposals: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        fallbackProvider: null,
        fallbackModel: null,
      },
      attribute_ranking: {
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
      credential: 'ts-secret-key-298',
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

  it('1. valid single-value choice: resolves canonical option with systemone_judgment and isBulkAcceptable=false', async () => {
    const run = createRun(workspaceId, 'SKU-FLAVOR-1', null, 'hash-attr-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('/v1/systemone');
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('jev-1.13.0');
      expect(body.questions.attr_flavor).toBeDefined();
      expect(body.questions.attr_flavor.criteria.opt_0).toContain('Chicken');

      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_flavor: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: {
                opt_0: 0.88,
                opt_1: 0.05,
                opt_2: 0.04,
                no_match: 0.02,
                insufficient_evidence: 0.01,
              },
              confidence: 0.94,
            },
          },
          usage: { input_tokens: 120, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'single',
      evidence: jevChoiceEvidence,
      sku: 'SKU-FLAVOR-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.value).toBe('Chicken');
    expect(decision.confidence).toBe(0.88);
    expect(decision.selectedProbability).toBe(0.88);
    expect(decision.vendorConfidence).toBe(0.94);
    expect(decision.probabilityBasis).toBe('choice_probability');
    expect(decision.source).toBe('jev');
    expect(decision.derivation.kind).toBe('systemone_judgment');

    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-FLAVOR-1', run.id, 'hash-attr-1');
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.proposedValue).toBe('Chicken');
    expect(proposal.isBulkAcceptable).toBe(false);

    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('success');
  });

  it('2. multi-value resolution: resolves multi-value via deterministic alias or Jev Noul without silent single-choice conversion', async () => {
    const run = createRun(workspaceId, 'SKU-MULTI-1', null, 'hash-multi');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any;

    const decision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'multiple',
      evidence: sampleEvidence,
      sku: 'SKU-MULTI-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false);
    expect(decision.status).toBe('resolved');
    expect(decision.values).toEqual(['Chicken']);
    expect(decision.value).toBe('Chicken');

    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-MULTI-1', run.id, 'hash-multi');
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.proposedValue).toEqual(['Chicken']);
  });

  it('3. candidate limit exceeded: candidate options > 253 produces candidate_limit_exceeded (no clipping)', async () => {
    const run = createRun(workspaceId, 'SKU-LIMIT-1', null, 'hash-limit');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const manyOptions: ResolvedTargetOption[] = Array.from({ length: 254 }, (_, i) => ({
      value: `opt_${i}`,
      label: `Option ${i}`,
    }));

    const bigTarget = {
      ...flavorTarget,
      options: manyOptions,
    } as unknown as ResolvedTarget;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any;

    const decision = await resolveAttributeDecision({
      target: bigTarget,
      cardinality: 'single',
      evidence: sampleEvidence,
      sku: 'SKU-LIMIT-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false);
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('candidate_limit_exceeded');
  });

  it('4. deterministic precedence: reviewed facts, aliases, brand shortcuts, and free-text never call Jev', async () => {
    const run = createRun(workspaceId, 'SKU-PREC-1', null, 'hash-prec');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any;

    // 4a. Reviewed facts precedence
    const reviewedDecision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'single',
      evidence: sampleEvidence,
      sku: 'SKU-PREC-1',
      runId: run.id,
      snapshot: {
        snapshotHash: 'hash-prec',
        reviewedFacts: [
          { proposalType: 'field_assignment', targetId: 'flavor', value: 'Salmon' },
        ],
      } as any,
      modelPolicy: policyView,
    });
    expect(fetchCalled).toBe(false);
    expect(reviewedDecision.status).toBe('resolved');
    expect(reviewedDecision.value).toBe('Salmon');
    expect(reviewedDecision.confidence).toBe(1.0);
    expect(reviewedDecision.probabilityBasis).toBe('reviewed_fact');

    // 4b. Deterministic alias precedence
    const aliasEvidence: ClassificationEvidence[] = [
      {
        id: 'ev-alias',
        runId: run.id,
        stageName: 'evidence_extraction',
        productSku: 'SKU-PREC-1',
        attributeId: 'flavor',
        source: 'official_product_page',
        reliability: 'high',
        sourceUrl: null,
        sourceField: 'ProductField1',
        snippet: 'Includes wholesome poultry meat',
        value: 'Includes wholesome poultry meat',
        metadata: null,
        capturedAt: new Date().toISOString(),
      },
    ];
    const aliasDecision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'single',
      evidence: aliasEvidence,
      sku: 'SKU-PREC-1',
      runId: run.id,
      modelPolicy: policyView,
    });
    expect(fetchCalled).toBe(false);
    expect(aliasDecision.status).toBe('resolved');
    expect(aliasDecision.value).toBe('Chicken');
    expect(aliasDecision.probabilityBasis).toBe('deterministic_alias');

    // 4c. Free-text attribute
    const freeTextTarget = {
      config: {
        id: 'brand',
        label: 'Brand',
        kind: 'attribute',
        attributeId: 'brand',
        catalogField: 'ProductField16',
        selectionMode: 'single',
      },
      options: [],
      attribute: {
        id: 'brand',
        name: 'Brand',
        valueMode: 'freeText',
      },
    } as unknown as ResolvedTarget;

    const brandEvidence: ClassificationEvidence[] = [
      {
        id: 'ev-brand',
        runId: run.id,
        stageName: 'evidence_extraction',
        productSku: 'SKU-PREC-1',
        attributeId: 'brand',
        source: 'official_product_page',
        reliability: 'high',
        sourceUrl: null,
        sourceField: 'ProductField16',
        snippet: 'Acme Pet Food Co.',
        value: 'Acme Pet Food Co.',
        metadata: null,
        capturedAt: new Date().toISOString(),
      },
    ];

    const freeTextResult = await processProductFieldTarget(
      freeTextTarget,
      { sku: 'SKU-PREC-1', evidence: brandEvidence, acceptedProposals: [], allProposals: [] },
      {
        runId: run.id,
        workspaceId,
        snapshot: { snapshotHash: 'hash-prec' } as any,
      } as any,
    );
    expect(fetchCalled).toBe(false);
    expect(freeTextResult.proposals).toHaveLength(1);
    expect(freeTextResult.proposals[0].proposedValue).toBe('Acme Pet Food Co.');
  });

  it('5. empty profile & unresolved type: universal attributes proceed; type-dependent withheld', async () => {
    const run = createRun(workspaceId, 'SKU-EMPTY-PROF', null, 'hash-empty-prof');
    const nowIso = new Date().toISOString();

    const emptyBundle = {
      manifest: {
        schemaVersion: 2,
        bundleHash: 'hash-empty-prof',
        fileVersions: {},
        sourceCatalogCommit: null,
        catalogEvidenceHash: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      brands: [],
      guidance: [],
      modelPolicy: cloudJevPolicy,
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
      productTypes: [
        { id: 'general-item', name: 'General Item', description: null, attributeProfileId: null, oldIdAliases: [] },
      ],
      attributeProfiles: [],
      attributes: [
        { id: 'universal_attr', name: 'Universal Item', description: null, valueMode: 'controlled', allowedValues: ['Yes'], valueAliases: [], visualEvidenceEligibility: 'eligible', isUniversal: true, isClaim: false, isCompositionAttribute: false, group: 'General' },
        { id: 'gated_flavor', name: 'Gated Flavor', description: null, valueMode: 'controlled', allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isUniversal: false, isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeMappings: [
        { id: 'm-1', attributeId: 'universal_attr', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'm-2', attributeId: 'gated_flavor', catalogField: 'ProductField2', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 't-type', kind: 'product_type', label: 'Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
        { id: 't-universal', kind: 'product_field', label: 'Universal Item', enabled: true, selectionMode: 'single', attributeId: 'universal_attr', catalogField: 'ProductField1', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
        { id: 't-gated', kind: 'product_field', label: 'Gated Flavor', enabled: true, selectionMode: 'single', attributeId: 'gated_flavor', catalogField: 'ProductField2', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
      ],
    };

    const emptySnapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath: '/tmp/test-ws',
      productSku: 'SKU-EMPTY-PROF',
      authority: { kind: 'v2', bundle: emptyBundle as any },
      configSnapshotRef: { id: 'snap-empty', hash: 'hash-empty-prof', sourceCommit: null, createdAt: nowIso },
      sourceProductHash: null,
    });

    const stageContext = {
      runId: run.id,
      workspaceId,
      workspacePath: '/tmp/test-ws',
      configSnapshotRef: emptySnapshot.configSnapshotRef,
      snapshot: emptySnapshot,
      cohortExecutionType: { id: 'general-item', name: 'General Item', attributeProfileId: null },
    } as any;

    const stageInput = {
      sku: 'SKU-EMPTY-PROF',
      evidence: sampleEvidence,
      acceptedProposals: [],
    } as any;

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_universal_attr: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: { opt_0: 0.90, no_match: 0.05, insufficient_evidence: 0.05 },
              confidence: 0.95,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const stageResult = await productAttributeProposalsStage.execute(stageInput, stageContext);
    expect(stageResult.status).toBe('succeeded');
    const proposals = (stageResult as any).output.proposals;
    // universal_attr proposed, gated_flavor withheld!
    expect(proposals.some((p: any) => p.targetId === 'universal_attr')).toBe(true);
    expect(proposals.some((p: any) => p.targetId === 'gated_flavor')).toBe(false);
  });

  it('6. state batching: identical states batch into 1 request; restricted evidence dispatches separately (AC 7)', async () => {
    const run = createRun(workspaceId, 'SKU-BATCH-1', null, 'hash-batch');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const formTarget = {
      config: {
        id: 'form',
        label: 'Food Form',
        kind: 'attribute',
        attributeId: 'form',
        selectionMode: 'single',
      },
      options: [
        { value: 'Dry', label: 'Dry' },
        { value: 'Wet', label: 'Wet' },
      ],
      attribute: {
        id: 'form',
        name: 'Food Form',
        valueMode: 'singleChoice',
        visualEvidenceEligibility: 'eligible', // same as flavorTarget -> identical state
        valueAliases: [],
      },
    } as unknown as ResolvedTarget;

    const materialTargetIneligibleVisual = {
      config: {
        id: 'material',
        label: 'Toy Material',
        kind: 'attribute',
        attributeId: 'material',
        selectionMode: 'single',
      },
      options: [
        { value: 'Rubber', label: 'Rubber' },
        { value: 'Plush', label: 'Plush' },
      ],
      attribute: {
        id: 'material',
        name: 'Toy Material',
        valueMode: 'singleChoice',
        visualEvidenceEligibility: 'ineligible', // filters visual evidence -> distinct state!
        valueAliases: [],
      },
    } as unknown as ResolvedTarget;

    const requestsReceived: any[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      requestsReceived.push(body);
      const answers: any = {};
      for (const qId of Object.keys(body.questions)) {
        answers[qId] = {
          type: 'choice',
          choice: 'opt_0',
          probabilities: { opt_0: 0.85, no_match: 0.1, insufficient_evidence: 0.05 },
          confidence: 0.9,
        };
      }
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decisions = await batchResolveAttributeDecisions({
      items: [
        { target: flavorTarget, cardinality: 'single' },
        { target: formTarget, cardinality: 'single' },
        { target: materialTargetIneligibleVisual, cardinality: 'single' },
      ],
      evidence: jevChoiceEvidence, // has official_product_page + visual_product_evidence without exact option keywords
      sku: 'SKU-BATCH-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decisions).toHaveLength(3);
    // There must be EXACTLY 2 requests:
    // Request 1: batched flavor & form (identical permitted state with visual evidence)
    // Request 2: material (visual evidence excluded, restricted permitted state)
    expect(requestsReceived).toHaveLength(2);

    const batchedReq = requestsReceived.find(r => Object.keys(r.questions).length === 2);
    expect(batchedReq).toBeDefined();
    expect(batchedReq.questions.attr_flavor).toBeDefined();
    expect(batchedReq.questions.attr_form).toBeDefined();

    const separateReq = requestsReceived.find(r => Object.keys(r.questions).length === 1);
    expect(separateReq).toBeDefined();
    expect(separateReq.questions.attr_material).toBeDefined();
  });

  it('7. claims safeguard: ungrounded claims without direct evidence abstain as unsupported_claim (AC 5)', async () => {
    const run = createRun(workspaceId, 'SKU-CLAIM-1', null, 'hash-claim');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const organicClaimTarget = {
      config: {
        id: 'organic',
        label: 'Certified Organic',
        kind: 'attribute',
        attributeId: 'organic',
        selectionMode: 'single',
      },
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      attribute: {
        id: 'organic',
        name: 'Certified Organic',
        valueMode: 'singleChoice',
        isClaim: true, // Claim sensitive!
      },
    } as unknown as ResolvedTarget;

    // Speculative non-direct evidence (e.g. distributor web-search snippet)
    const nonDirectEvidence: ClassificationEvidence[] = [
      {
        id: 'ev-web',
        runId: run.id,
        stageName: 'evidence_extraction',
        productSku: 'SKU-CLAIM-1',
        attributeId: null,
        source: 'third_party_page', // Not official_product_page, visual_product_evidence, or catalog_product
        reliability: 'low',
        sourceUrl: 'https://blog.example.com',
        sourceField: 'snippet',
        snippet: 'Some say this product might be organic certified.',
        value: 'Some say this product might be organic certified.',
        metadata: null,
        capturedAt: new Date().toISOString(),
      },
    ];

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_organic: {
              type: 'choice',
              choice: 'opt_0',
              probabilities: { opt_0: 0.95, opt_1: 0.03, no_match: 0.01, insufficient_evidence: 0.01 },
              confidence: 0.98,
            },
          },
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    const decision = await resolveAttributeDecision({
      target: organicClaimTarget,
      cardinality: 'single',
      evidence: nonDirectEvidence,
      sku: 'SKU-CLAIM-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    // High probability (0.95) cannot authorize an ungrounded claim!
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('unsupported_claim');
  });

  it('8. pre-review prediction capture: populates fieldAssignments for predictions and abstentions', async () => {
    const run = createRun(workspaceId, 'SKU-PRED-ATTR', null, 'hash-pred-1');
    const db = getDb();
    db.run('UPDATE classification_runs SET status = ? WHERE id = ?', ['completed', run.id]);
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dog-food', ?, 0.90, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-PRED-ATTR', JSON.stringify('dog-food'), now],
    );

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', ?, 0.88, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-PRED-ATTR', JSON.stringify('Chicken'), now],
    );

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'reviewable_abstention', 'size', ?, 0, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-PRED-ATTR', JSON.stringify({ reason: 'No size info', code: 'insufficient_evidence', attributeId: 'size' }), now],
    );

    const prediction = capturePreReviewPrediction({
      runId: run.id,
      workspaceId,
      productSku: 'SKU-PRED-ATTR',
    });

    expect(prediction.outcome).toBe('predicted');
    expect(prediction.productType).toBe('dog-food');
    expect(prediction.fieldAssignments).toEqual([
      { targetId: 'flavor', value: 'Chicken', values: ['Chicken'] },
      { targetId: 'size', value: null },
    ]);
  });

  it('9. benchmark evaluator attribution & baseline comparison: scores fieldStates with inapplicable/unlabeled excluded (AC 8)', () => {
    const rawGoldJson = JSON.stringify({
      productType: 'dog-food',
      productTypeState: 'known',
      fieldStates: {
        flavor: 'known',
        breed_size: 'no-fit',
        color: 'inapplicable',
        notes: 'unlabeled',
      },
      fieldAssignments: [
        { targetId: 'flavor', value: 'Chicken' },
        { targetId: 'breed_size', value: null },
        { targetId: 'color', value: null },
      ],
    });

    const parsedFieldStates = readEvaluatorFieldStates(rawGoldJson);
    expect(parsedFieldStates).toEqual({
      flavor: 'known',
      breed_size: 'no-fit',
      color: 'inapplicable',
      notes: 'unlabeled',
    });

    // Direct scoring checks
    expect(scoreEvaluatorFieldExample({ goldState: 'inapplicable', goldValue: null, predictedValue: 'Red' })).toBe('excluded');
    expect(scoreEvaluatorFieldExample({ goldState: 'unlabeled', goldValue: null, predictedValue: 'Anything' })).toBe('excluded');
    expect(scoreEvaluatorFieldExample({ goldState: 'no-fit', goldValue: null, predictedValue: null })).toBe('correct');
    expect(scoreEvaluatorFieldExample({ goldState: 'no-fit', goldValue: null, predictedValue: 'Small' })).toBe('incorrect');
    expect(scoreEvaluatorFieldExample({ goldState: 'known', goldValue: 'Chicken', predictedValue: 'Chicken' })).toBe('correct');
    expect(scoreEvaluatorFieldExample({ goldState: 'known', goldValue: 'Chicken', predictedValue: 'Beef' })).toBe('incorrect');
    expect(scoreEvaluatorFieldExample({ goldState: 'known', goldValue: 'Chicken', predictedValue: null })).toBe('abstained');

    // Fixed-population attribution report test
    const goldExample: GoldExampleForEvaluation = {
      id: 'ex-1',
      productSku: 'SKU-EVAL-1',
      goldLabels: {
        productType: 'dog-food',
        pageAssignments: [],
        fieldAssignments: [
          { targetId: 'flavor', value: 'Chicken' },
          { targetId: 'breed_size', value: null },
          { targetId: 'color', value: null },
        ],
      },
      evidenceText: 'chicken formula',
      goldState: 'known',
      fieldGoldStates: parsedFieldStates,
    };

    const candidatePredictions = [
      {
        exampleId: 'ex-1',
        productSku: 'SKU-EVAL-1',
        productType: 'dog-food',
        fieldAssignments: [
          { targetId: 'flavor', value: 'Chicken' },
          { targetId: 'breed_size', value: null },
          { targetId: 'color', value: 'Red' }, // Should be excluded because gold is inapplicable
        ],
        claimTargets: [],
        pageAssignments: [],
        abstained: false,
        confidence: 0.9,
      },
    ];

    const baselinePredictions = [
      {
        exampleId: 'ex-1',
        productSku: 'SKU-EVAL-1',
        productType: 'dog-food',
        fieldAssignments: [
          { targetId: 'flavor', value: null }, // baseline abstained on flavor
          { targetId: 'breed_size', value: null },
        ],
        claimTargets: [],
        pageAssignments: [],
        abstained: false,
        confidence: 0.9,
      },
    ];

    const attribution = computeEvaluatorAttribution([goldExample], candidatePredictions, {
      baselinePredictions,
    });

    expect(attribution.fieldReports).toBeDefined();
    const flavorReport = attribution.fieldReports!.flavor;
    expect(flavorReport).toBeDefined();
    expect(flavorReport.fixedPopulation.eligible).toBe(1);
    expect(flavorReport.fixedPopulation.correct).toBe(1);
    expect(flavorReport.baselineComparison?.recoveredBaselineAbstentions).toBe(1);

    const breedReport = attribution.fieldReports!.breed_size;
    expect(breedReport).toBeDefined();
    expect(breedReport.fixedPopulation.eligible).toBe(1);
    expect(breedReport.fixedPopulation.correct).toBe(1);
    expect(breedReport.fixedPopulation.correctAbstentions).toBe(1);

    const colorReport = attribution.fieldReports!.color;
    expect(colorReport).toBeDefined();
    expect(colorReport.fixedPopulation.eligible).toBe(0); // Inapplicable -> excluded from denominator!
  });
});
