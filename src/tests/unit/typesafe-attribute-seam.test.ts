import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
/**
 * TypeSafe Jev Attribute Seam Verification (Issue #298 / AC 1–10).
 *
 * Full seam verification with HTTP mocked across:
 * - Valid single-value controlled choice (canonical mapping, derivation, isBulkAcceptable: false)
 * - Multi-value deterministic resolution without silent single-choice conversion
 * - Candidate limit exceeded (>253 candidates without first-N clipping)
 * - Deterministic aliases take precedence over model resolution
 * - State batching vs separation (identical state -> 1 request; restricted evidence -> separate requests)
 * - Direct evidence & claims safeguards (unsupported_claim on non-direct evidence)
 * - Benchmark evaluator attribution & baseline comparison (fieldStates, inapplicable/unlabeled excluded)
 */

import { SystemOneRequestSchema, type SystemOneAnswer, type SystemOneRequest } from '../../shared/schemas/systemone';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import type { ProviderConnection } from '../../ai/provider-connections';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import {
  resolveAttributeDecision,
  batchResolveAttributeDecisions,
  buildProposalFromAttributeDecision,
} from '../../classification/attribute-decision';
import {
  computeEvaluatorAttribution,
  readEvaluatorFieldStates,
  scoreEvaluatorFieldExample,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import { resolveTargetsFromSnapshot, type ResolvedTarget, type ResolvedTargetOption } from '../../classification/curation-target-resolver';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import type {
  ClassificationEvidence,
  ModelPolicyConfigV2,
} from '../../shared/schemas/classification';


function choiceAnswerForCriterion(
  criteria: Record<string, unknown>,
  expectedLabel: string,
  selectedProbability = 0.85,
  vendorConfidence = 0.9,
): SystemOneAnswer {
  const selectedKey = Object.entries(criteria).find(([, label]) =>
    typeof label === 'string' && label.toLowerCase().includes(expectedLabel.toLowerCase()),
  )?.[0];
  if (!selectedKey) {
    throw new Error(`Expected ${expectedLabel} criterion in ${JSON.stringify(criteria)}`);
  }
  const otherKeys = Object.keys(criteria).filter(key => key !== selectedKey);
  const residualProbability = (1 - selectedProbability) / otherKeys.length;
  return {
    type: 'choice',
    choice: selectedKey,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map(key => [key, key === selectedKey ? selectedProbability : residualProbability]),
    ),
    confidence: vendorConfidence,
  };
}

function parseSystemOneRequest(init: RequestInit | undefined): SystemOneRequest {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON SystemOne request body');
  return SystemOneRequestSchema.parse(JSON.parse(init.body));
}


type FetchFixture = (...args: Parameters<typeof fetch>) => Promise<Response>;

function installFetchFixture(handler: FetchFixture): void {
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const input = args[0];
      const requestUrl = input instanceof Request ? input.url : String(input);
      expect(requestUrl).toContain('api.typesafe.ai/v1/systemone');
      return handler(...args);
    },
    { preconnect: () => undefined },
  );
}

function rejectUnexpectedFetch(): void {
  installFetchFixture(async () => {
    throw new Error('Unexpected external request in deterministic fixture');
  });
}
/**
 * Shared fixture builder (complexity extraction only — test behavior
 * identical). Hoists the repeated SystemOne JSON Response envelope out of
 * the per-criterion fetch mocks.
 */
function systemOneJsonResponse(
  answers: Record<string, SystemOneAnswer>,
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 100, output_tokens: 10 },
): Response {
  return new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers,
      usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('TypeSafe Jev Attribute Seam Verification (Issue #298)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-attr-seam';
  let workspacePath: string;

  const flavorOptions: ResolvedTargetOption[] = [
    { value: 'Chicken', label: 'Chicken' },
    { value: 'Beef', label: 'Beef' },
    { value: 'Salmon', label: 'Salmon' },
  ];

  let flavorTarget: ResolvedTarget;

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

  function fixtureBundle(flavorValues = flavorOptions.map(option => option.value)) {
    const primaryProductTypeTarget = BayStatePetGardenSeed.curationTargets.find(target => target.kind === 'product_type')!;
    const attributes: BayStateSeed['attributes'] = [
      { id: 'flavor', name: 'Food Flavor', allowedValues: flavorValues, valueAliases: [{ alias: 'poultry', mapsTo: flavorValues[0]! }], visualEvidenceEligibility: 'eligible', isClaim: false },
      { id: 'food-form', name: 'Food Form', allowedValues: ['Dry', 'Wet'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false },
      { id: 'material', name: 'Toy Material', allowedValues: ['Rubber', 'Plush'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: false },
      { id: 'dietary-features', name: 'Certified Organic', allowedValues: ['Organic', 'Conventional'], valueAliases: [], visualEvidenceEligibility: 'ineligible', isClaim: true },
    ].map(attribute => ({
      ...attribute, description: null, valueMode: 'controlled', canonicalUnit: null,
      isCompositionAttribute: false, group: null, isUniversal: false,
    })) as BayStateSeed['attributes'];
    const fields: Record<string, string> = {
      flavor: 'ProductField23', 'food-form': 'ProductField22', material: 'ProductField28', 'dietary-features': 'ProductField20',
    };
    return generateCandidate({
      ...BayStatePetGardenSeed, name: 'TypeSafe attribute fixture', revision: 'typesafe-attribute-fixture',
      categories: [{ id: 'pet-supplies', name: 'Pet Supplies', description: null }],
      productTypes: [{ id: 'pet-food', name: 'Pet Food', description: null, categoryId: 'pet-supplies' }],
      attributes,
      profileTemplates: [{ id: 'pet-profile', name: 'Pet attributes', productTypeIds: ['pet-food'], attributes: attributes.map(attribute => ({ attributeId: attribute.id })) }],
      mappings: attributes.map(attribute => ({ id: `${attribute.id}-map`, attributeId: attribute.id, catalogField: fields[attribute.id]!, serialization: { kind: 'scalar', prefix: '', suffix: '' } })),
      curationTargets: [primaryProductTypeTarget, ...attributes.map((attribute, index) => ({
        id: attribute.id, kind: 'product_field' as const, label: attribute.name, enabled: true, mandatory: false,
        selectionMode: 'single' as const, attributeId: attribute.id, catalogField: fields[attribute.id]!,
        optionSource: 'configured' as const, required: false, sortOrder: index,
      }))],
      brands: [], guidance: [], modelPolicy: cloudJevPolicy,
      dataSharing: {
        imagePolicy: 'local_only', textPolicy: 'cloud_allowed',
        sensitiveDataFiltering: true, retentionDays: 90,
      },
    }, {
      schemaVersion: 1, sourceTreeHash: '0'.repeat(64), productFileCount: 0, parseFailureCount: 0,
      parseFailures: [], fieldRegistry: { entryCount: 0, xmlFields: [] }, fields: [], pages: [],
    }).bundle;
  }

  function createFixtureRun(sku: string, flavorValues?: string[]) {
    const bundle = fixtureBundle(flavorValues);
    const snapshot = buildRuntimeSnapshot({
      workspaceId, workspacePath, productSku: sku,
      authority: { kind: 'v2', bundle }, sourceProductHash: null,
      configSnapshotRef: { id: `config-${sku}`, hash: bundle.manifest.bundleHash, sourceCommit: null, createdAt: bundle.manifest.createdAt },
    });
    const stored = persistRuntimeSnapshot(snapshot);
    return { ...createRun(workspaceId, sku, stored.id, stored.hash), snapshot };
  }

  function evidenceForRun(run: ReturnType<typeof createFixtureRun>, evidence: ClassificationEvidence[]) {
    return evidence.map(record => ({ ...record, runId: run.id, productSku: run.snapshot.productSku }));
  }

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-attributes-'));
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId, name: 'TypeSafe attribute fixture', workspacePath, gitPath: '',
      createdAt: BayStatePetGardenSeed.createdAt, updatedAt: BayStatePetGardenSeed.createdAt,
      bootstrapStatus: 'complete', baselineCommit: null,
    });
    rejectUnexpectedFetch();
    const fixtureConnection = {
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'fixture298',
      enabled: true,
    } satisfies ProviderConnection;
    upsertProviderConnection(fixtureConnection);
    const run = createFixtureRun('FIXTURE-TARGET');
    flavorTarget = resolveTargetsFromSnapshot(run.snapshot).productFields.find(target => target.config.attributeId === 'flavor')!;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('1. valid single-value choice: resolves canonical option with systemone_judgment and isBulkAcceptable=false', async () => {
    const run = createFixtureRun('SKU-FLAVOR-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    installFetchFixture(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      expect(u).toContain('/v1/systemone');
      const body = parseSystemOneRequest(init);
      expect(body.model).toBe('jev-1.13.0');
      const question = body.questions.attr_flavor;
      expect(question).toBeDefined();
      if (!question || question.type !== 'choice') throw new Error('Expected flavor choice question');
      expect(Object.values(question.criteria).some(label => typeof label === 'string' && label.includes('Chicken'))).toBe(true);
      expect(question.criteria).toHaveProperty('no_match');
      expect(question.criteria).toHaveProperty('insufficient_evidence');

      return systemOneJsonResponse(
        {
          attr_flavor: choiceAnswerForCriterion(question.criteria, 'Chicken', 0.88, 0.94),
        },
        { input_tokens: 120, output_tokens: 10 },
      );
    });

    const decision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'single',
      evidence: evidenceForRun(run, jevChoiceEvidence),
      sku: 'SKU-FLAVOR-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });
    expect(decision.status, `Expected a resolved Jev decision; received ${JSON.stringify(decision)}`).toBe('resolved');
    expect(decision.value).toBe('Chicken');
    expect(decision.confidence).toBe(0.88);
    expect(decision.selectedProbability).toBe(0.88);
    expect(decision.vendorConfidence).toBe(0.94);
    expect(decision.probabilityBasis).toBe('choice_probability');
    expect(decision.source).toBe('jev');
    expect(decision.derivation.kind).toBe('systemone_judgment');

    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-FLAVOR-1', run.id, run.snapshot.snapshotHash);
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.proposedValue).toBe('Chicken');
    expect(proposal.isBulkAcceptable).toBe(false);

    const calls = getModelCallsByRun(run.id);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('success');
  });

  it('2. multi-value resolution: resolves multi-value via deterministic alias or Jev Noul without silent single-choice conversion', async () => {
    const run = createFixtureRun('SKU-MULTI-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let fetchCalled = false;
    installFetchFixture(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const decision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'multiple',
      evidence: evidenceForRun(run, sampleEvidence),
      sku: 'SKU-MULTI-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });

    expect(fetchCalled).toBe(false);
    expect(decision.status).toBe('resolved');
    expect(decision.values).toEqual(['Chicken']);
    expect(decision.value).toBe('Chicken');

    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-MULTI-1', run.id, run.snapshot.snapshotHash);
    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.proposedValue).toEqual(['Chicken']);
  });

  it('3. candidate limit exceeded: candidate options > 253 produces candidate_limit_exceeded (no clipping)', async () => {
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const manyOptions: ResolvedTargetOption[] = Array.from({ length: 254 }, (_, i) => ({
      value: `opt_${i}`,
      label: `Option ${i}`,
    }));

    const run = createFixtureRun('SKU-LIMIT-1', manyOptions.map(option => option.value));
    const bigTarget = resolveTargetsFromSnapshot(run.snapshot).productFields.find(target => target.config.attributeId === 'flavor')!;

    expect(bigTarget.options, 'Candidate-limit fixture must be present in the captured runtime snapshot').toHaveLength(254);

    let fetchCalled = false;
    installFetchFixture(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    const decision = await resolveAttributeDecision({
      target: bigTarget,
      cardinality: 'single',
      evidence: evidenceForRun(run, sampleEvidence),
      sku: 'SKU-LIMIT-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });
    expect(decision.status, `Expected candidate-limit abstention; received ${JSON.stringify(decision)}`).toBe('abstained');
    expect(decision.abstentionCode).toBe('candidate_limit_exceeded');
    expect(fetchCalled).toBe(false);
  });

  it('4. deterministic aliases resolve without a model request', async () => {
    const run = createFixtureRun('SKU-PREC-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let fetchCalled = false;
    installFetchFixture(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

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
        sourceField: 'ProductField23',
        snippet: 'Includes wholesome poultry meat',
        value: 'Includes wholesome poultry meat',
        metadata: null,
        capturedAt: new Date().toISOString(),
      },
    ];
    const aliasDecision = await resolveAttributeDecision({
      target: flavorTarget,
      cardinality: 'single',
      evidence: evidenceForRun(run, aliasEvidence),
      sku: 'SKU-PREC-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });
    expect(fetchCalled).toBe(false);
    expect(aliasDecision.status).toBe('resolved');
    expect(aliasDecision.value).toBe('Chicken');
    expect(aliasDecision.probabilityBasis).toBe('deterministic_alias');

  });

  it('6. state batching: identical states batch into 1 request; restricted evidence dispatches separately (AC 7)', async () => {
    const run = createFixtureRun('SKU-BATCH-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const targets = resolveTargetsFromSnapshot(run.snapshot).productFields;
    const formTarget = targets.find(target => target.config.attributeId === 'food-form')!;
    const materialTargetIneligibleVisual = targets.find(target => target.config.attributeId === 'material')!;

    const requestsReceived: SystemOneRequest[] = [];
    installFetchFixture(async (url: string | URL | Request, init?: RequestInit) => {
      const body = parseSystemOneRequest(init);
      requestsReceived.push(body);
      const answers: Record<string, SystemOneAnswer> = {};
      const expectedLabels: Record<string, string> = {
        attr_flavor: 'Chicken',
        'attr_food-form': 'Dry',
        attr_material: 'Rubber',
      };
      for (const [qId, question] of Object.entries(body.questions)) {
        const expectedLabel = expectedLabels[qId];
        if (!expectedLabel) throw new Error(`Unexpected question ${qId}`);
        if (question.type !== 'choice') throw new Error(`Expected choice question ${qId}`);
        answers[qId] = choiceAnswerForCriterion(question.criteria, expectedLabel);
      }
      return systemOneJsonResponse(answers);
    });

    const decisions = await batchResolveAttributeDecisions({
      items: [
        { target: flavorTarget, cardinality: 'single' },
        { target: formTarget, cardinality: 'single' },
        { target: materialTargetIneligibleVisual, cardinality: 'single' },
      ],
      evidence: evidenceForRun(run, jevChoiceEvidence), // has official_product_page + visual_product_evidence without exact option keywords
      sku: 'SKU-BATCH-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });
    expect(
      decisions.map(decision => ({ targetId: decision.targetId, status: decision.status, value: decision.value, abstentionCode: decision.status === 'abstained' ? decision.abstentionCode : null })),
      `Expected valid batched Jev choices; received ${JSON.stringify(decisions)}`,
    ).toEqual([
      { targetId: 'flavor', status: 'resolved', value: 'Chicken', abstentionCode: null },
      { targetId: 'food-form', status: 'resolved', value: 'Dry', abstentionCode: null },
      { targetId: 'material', status: 'resolved', value: 'Rubber', abstentionCode: null },
    ]);
    // There must be EXACTLY 2 requests:
    // Request 1: batched flavor & form (identical permitted state with visual evidence)
    // Request 2: material (visual evidence excluded, restricted permitted state)
    expect(requestsReceived).toHaveLength(2);

    const batchedReq = requestsReceived.find(r => Object.keys(r.questions).length === 2);
    if (!batchedReq) throw new Error('Expected the shared-state flavor/food-form request');
    expect(batchedReq.questions.attr_flavor).toBeDefined();
    expect(batchedReq.questions['attr_food-form']).toBeDefined();

    const separateReq = requestsReceived.find(r => Object.keys(r.questions).length === 1);
    if (!separateReq) throw new Error('Expected the restricted-evidence material request');
    expect(separateReq.questions.attr_material).toBeDefined();
  });

  it('7. claims safeguard: ungrounded claims without direct evidence abstain as unsupported_claim (AC 5)', async () => {
    const run = createFixtureRun('SKU-CLAIM-1');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    const organicClaimTarget = resolveTargetsFromSnapshot(run.snapshot).productFields.find(target => target.config.attributeId === 'dietary-features')!;

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

    installFetchFixture(async () => systemOneJsonResponse({
      'attr_dietary-features': {
        type: 'choice',
        choice: 'opt_0',
        probabilities: { opt_0: 0.95, opt_1: 0.03, no_match: 0.01, insufficient_evidence: 0.01 },
        confidence: 0.98,
      },
    }));

    const decision = await resolveAttributeDecision({
      target: organicClaimTarget,
      cardinality: 'single',
      evidence: evidenceForRun(run, nonDirectEvidence),
      sku: 'SKU-CLAIM-1',
      runId: run.id,
      snapshot: run.snapshot,
      modelPolicy: policyView,
    });

    // High probability (0.95) cannot authorize an ungrounded claim!
    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('unsupported_claim');
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
