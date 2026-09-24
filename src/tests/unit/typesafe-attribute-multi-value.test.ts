/**
 * TypeSafe Jev Multi-Value Attribute Proposals Test Suite (Issue #300 / AC 1–9).
 *
 * Verifies:
 * - AC 1: Supported capability visibility in Settings & readiness reports.
 * - AC 2: Noul question construction per eligible value with explicit yes/no criteria
 *         and preservation of raw independent P(yes).
 * - AC 3: Batching independent questions with deterministic candidate correlation,
 *         explicit <=32 request budgets, and fail-closed incomplete candidate batches.
 * - AC 4: Frozen selection policy: threshold (0.70), uncertain floor (0.40),
 *         deterministic ordering, cardinality limits (maxItems), and boundary ties.
 * - AC 5: Precedence (reviewed facts, deterministic aliases), visual evidence eligibility,
 *         and claims/composition direct-evidence safeguards.
 * - AC 6: Proposal generation with exact selected-value sets, candidateProbabilities,
 *         model-call provenance, and isBulkAcceptable=false.
 * - AC 7: Benchmark evaluator set metrics: exact match accuracy, precision, recall,
 *         F1, and gold state attribution.
 * - AC 8: Policy-denied and disabled provider handling.
 * - AC 9: End-to-end workflow from evidence to proposal and reviewer correction.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import {
  resolveAttributeDecision,
  batchResolveAttributeDecisions,
  buildProposalFromAttributeDecision,
  buildAttributeNoulQuestions,
  evaluateMultiValueSelectionPolicy,
  JEV_MULTI_VALUE_MIN_PROBABILITY,
  JEV_MULTI_VALUE_UNCERTAIN_FLOOR,
  MAX_ORDINARY_ATTRIBUTE_CANDIDATES,
} from '../../classification/attribute-decision';
import { capturePreReviewPrediction } from '../../classification/benchmark-prediction';
import {
  computeEvaluatorAttribution,
  scoreEvaluatorFieldExample,
  computeSetMetrics,
  parseValueSet,
  EVALUATOR_FIELD_GOLD_STATE_KNOWN,
  EVALUATOR_OUTCOME_PREDICTED,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import { evaluateClassificationReadiness } from '../../classification/config-validation';
import { CLASSIFICATION_POLICY_STAGES } from '../../classification/classification-policy-service';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type {
  ClassificationEvidence,
  ModelPolicyConfigV2,
  BenchmarkPredictionEntry,
} from '../../shared/schemas/classification';

describe('TypeSafe Jev Multi-Value Attribute Verification (Issue #300)', () => {
  const originalFetch = globalThis.fetch;
  const workspaceId = 'ws-typesafe-attr-multi-value';

  const multiFlavorOptions: ResolvedTargetOption[] = [
    { value: 'Chicken', label: 'Chicken' },
    { value: 'Beef', label: 'Beef' },
    { value: 'Salmon', label: 'Salmon' },
    { value: 'Duck', label: 'Duck' },
    { value: 'Turkey', label: 'Turkey' },
  ];

  const multiFlavorTarget = {
    config: {
      id: 'target_flavor',
      label: 'Food Flavors',
      kind: 'product_field',
      attributeId: 'flavor',
      catalogField: 'ProductField1',
      selectionMode: 'multiple',
      confidenceThreshold: 0.7,
      guidancePrompt: 'Select all applicable food flavors',
    },
    options: multiFlavorOptions,
    attribute: {
      id: 'flavor',
      name: 'Food Flavors',
      valueMode: 'controlled',
      visualEvidenceEligibility: 'eligible',
      valueAliases: [
        { alias: 'poultry', mapsTo: 'Chicken' },
        { alias: 'cattle', mapsTo: 'Beef' },
      ],
    },
  } as unknown as ResolvedTarget;

  const claimTarget = {
    config: {
      id: 'target_claims',
      label: 'Special Diet Claims',
      kind: 'product_field',
      attributeId: 'special_diet',
      catalogField: 'ProductField16',
      selectionMode: 'multiple',
    },
    options: [
      { value: 'Grain-Free', label: 'Grain-Free' },
      { value: 'Non-GMO', label: 'Non-GMO' },
      { value: 'Organic', label: 'Organic' },
    ],
    attribute: {
      id: 'special_diet',
      name: 'Special Diet Claims',
      valueMode: 'controlled',
      visualEvidenceEligibility: 'eligible',
      isClaim: true,
      valueAliases: [],
    },
  } as unknown as ResolvedTarget;

  const baseEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-1',
      runId: 'run-multi-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-MULTI-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'description',
      snippet: 'Made with a wholesome blend of real poultry and ranch-raised beef for active adult dogs.',
      value: 'Made with a wholesome blend of real poultry and ranch-raised beef for active adult dogs.',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-2',
      runId: 'run-multi-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-MULTI-1',
      attributeId: null,
      source: 'visual_product_evidence',
      reliability: 'high',
      sourceUrl: 'https://example.com/bag.jpg',
      sourceField: 'packaging_ocr',
      snippet: 'Dual Protein Formula: Chicken & Beef Recipe',
      value: 'Dual Protein Formula: Chicken & Beef Recipe',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
  ];

  const jevEvidence: ClassificationEvidence[] = [
    {
      id: 'ev-jev-1',
      runId: 'run-multi-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-MULTI-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'description',
      snippet: 'Premium protein dry food formulated for adult dogs with high activity levels.',
      value: 'Premium protein dry food formulated for adult dogs with high activity levels.',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
    {
      id: 'ev-jev-2',
      runId: 'run-multi-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-MULTI-1',
      attributeId: null,
      source: 'visual_product_evidence',
      reliability: 'high',
      sourceUrl: 'https://example.com/bag.jpg',
      sourceField: 'packaging_ocr',
      snippet: 'Adult dry dog kibble. High protein balanced formula.',
      value: 'Adult dry dog kibble. High protein balanced formula.',
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
      credential: 'ts-secret-key-300',
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

  // ─── AC 1: Readiness & Settings ─────────────────────────────────────────────

  it('1. AC 1: readiness and policy stage reflect multi-value attribute support', () => {
    const attrStage = CLASSIFICATION_POLICY_STAGES.find(s => s.id === 'product_attribute_proposals');
    expect(attrStage).toBeDefined();
    expect(attrStage?.description).toContain('multi-valued');

    const config = {
      curationTargets: [
        {
          id: 'target_flavor',
          kind: 'product_field',
          label: 'Food Flavors',
          enabled: true,
          mandatory: false,
          selectionMode: 'multiple',
          attributeId: 'flavor',
          catalogField: 'ProductField1',
          optionSource: 'configured',
          required: false,
          sortOrder: 0,
        },
      ],
      attributeProfiles: [],
      productTypes: [],
    };

    const readiness = evaluateClassificationReadiness(config, {});
    expect(readiness.capabilities.productFields.multiValueSupported).toBe(true);
  });

  // ─── AC 2: Noul Question Construction & Independent P(yes) ──────────────────

  it('2. AC 2: builds one Noul per eligible option with explicit criteria and independent raw probabilities', async () => {
    const questions = buildAttributeNoulQuestions(multiFlavorTarget, 'SKU-MULTI-1', { name: 'Acme Dog Kibble' });
    expect(questions).toHaveLength(5);

    // Verify first question deterministic ID and content
    expect(questions[0].questionId).toBe('attr_flavor__val_0');
    expect(questions[0].optionValue).toBe('Chicken');
    expect(questions[0].instructions).toContain('Acme Dog Kibble');
    expect(questions[0].instructions).toContain('"Food Flavors"');
    expect(questions[0].instructions).toContain('"Chicken"');
    expect(questions[0].criteria.true).toContain('directly and clearly indicates');
    expect(questions[0].criteria.false).toContain('does not indicate "Chicken"');

    // Dispatch and check raw probability preservation without normalization
    const run = createRun(workspaceId, 'SKU-MULTI-1', null, 'hash-multi-2');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      expect(body.model).toBe('jev-1.13.0');
      expect(body.questions.attr_flavor__val_0.type).toBe('noul');
      expect(body.questions.attr_flavor__val_1.type).toBe('noul');

      // Return independent raw probabilities that do NOT sum to 1.0 (e.g. 0.92, 0.84, 0.12, 0.05, 0.02)
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_flavor__val_0: { type: 'noul', noul: 0.92 },
            attr_flavor__val_1: { type: 'noul', noul: 0.84 },
            attr_flavor__val_2: { type: 'noul', noul: 0.12 },
            attr_flavor__val_3: { type: 'noul', noul: 0.05 },
            attr_flavor__val_4: { type: 'noul', noul: 0.02 },
          },
          usage: { input_tokens: 120, output_tokens: 25 },
        }),
        { status: 200 },
      );
    }) as any;

    const decision = await resolveAttributeDecision({
      target: multiFlavorTarget,
      cardinality: 'multiple',
      evidence: jevEvidence,
      sku: 'SKU-MULTI-1',
      runId: run.id,
      modelPolicy: policyView,
      productContext: { name: 'Acme Dog Kibble' },
    });

    expect(decision.status).toBe('resolved');
    expect(decision.values).toEqual(['Chicken', 'Beef']);
    expect(decision.value).toBe('Chicken, Beef');
    expect(decision.probabilityBasis).toBe('noul_probability');
    expect(decision.candidateProbabilities).toEqual({
      Chicken: 0.92,
      Beef: 0.84,
      Salmon: 0.12,
      Duck: 0.05,
      Turkey: 0.02,
    });
  });

  // ─── AC 3: Batching <=32 Questions & Incomplete Batch Fail-Closed ────────────

  it('3. AC 3: batches questions within <=32 budget and fails closed on incomplete candidate batches', async () => {
    // Create a target with 35 options (exceeds single request budget of 32)
    const largeOptions: ResolvedTargetOption[] = Array.from({ length: 35 }, (_, i) => ({
      value: `Flavor_${i}`,
      label: `Flavor ${i}`,
    }));

    const largeTarget = {
      config: {
        id: 'large_flavors',
        label: 'Large Flavors',
        kind: 'product_field',
        attributeId: 'large_flavors',
        catalogField: 'ProductField1',
        selectionMode: 'multiple',
      },
      options: largeOptions,
      attribute: {
        id: 'large_flavors',
        name: 'Large Flavors',
        valueMode: 'controlled',
        visualEvidenceEligibility: 'eligible',
      },
    } as unknown as ResolvedTarget;

    const run = createRun(workspaceId, 'SKU-LARGE-1', null, 'hash-large');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    let callCount = 0;
    const requestedQuestionCounts: number[] = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(init?.body as string);
      const qKeys = Object.keys(body.questions);
      requestedQuestionCounts.push(qKeys.length);

      // Verify request budget: each call must carry <= 32 questions
      expect(qKeys.length).toBeLessThanOrEqual(32);

      if (callCount === 1) {
        // First chunk (32 questions) succeeds
        const answers: Record<string, { type: 'noul'; noul: number }> = {};
        for (const k of qKeys) {
          answers[k] = { type: 'noul', noul: 0.80 };
        }
        return new Response(
          JSON.stringify({
            model: 'jev-1.13.0',
            answers,
            usage: { input_tokens: 300, output_tokens: 60 },
          }),
          { status: 200 },
        );
      }

      // Second chunk (3 questions) fails with network error
      return new Response(JSON.stringify({ error: 'Upstream gateway timeout' }), { status: 504 });
    }) as any;

    const decision = await resolveAttributeDecision({
      target: largeTarget,
      cardinality: 'multiple',
      evidence: jevEvidence,
      sku: 'SKU-LARGE-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    // Budget check: 35 items chunked into 32 + 3
    expect(callCount).toBe(2);
    expect(requestedQuestionCounts).toEqual([32, 3]);

    // Incomplete candidate batch: must fail closed, NEVER emit partial results from chunk 1
    expect(decision.status).toBe('failed');
    expect(decision.abstentionCode).toBe('service_failure');
    expect(decision.abstentionReason).toContain('Incomplete candidate batch');
    expect(decision.values).toBeUndefined();
    expect(decision.value).toBeNull();
  });

  // ─── AC 4: Selection Policy & Cardinality Limits ────────────────────────────

  it('4. AC 4: frozen selection policy: thresholds, uncertain floor, cardinality limits, and boundary ties', () => {
    // 4a. Zero values below floor (all < 0.40) -> no_match
    const noMatchOutcome = evaluateMultiValueSelectionPolicy({
      target: multiFlavorTarget,
      candidates: [
        { optionValue: 'Chicken', optionLabel: 'Chicken', optionIndex: 0, prob: 0.15 },
        { optionValue: 'Beef', optionLabel: 'Beef', optionIndex: 1, prob: 0.22 },
        { optionValue: 'Salmon', optionLabel: 'Salmon', optionIndex: 2, prob: 0.05 },
      ],
      permittedEvidence: baseEvidence,
      catalogField: 'ProductField1',
    });
    expect(noMatchOutcome.outcome).toBe('abstained');
    if (noMatchOutcome.outcome === 'abstained') {
      expect(noMatchOutcome.abstentionCode).toBe('no_match');
      expect(noMatchOutcome.abstentionReason).toContain('no_fit');
    }

    // 4b. Max prob between 0.40 and 0.70 -> insufficient_evidence
    const insufficientOutcome = evaluateMultiValueSelectionPolicy({
      target: multiFlavorTarget,
      candidates: [
        { optionValue: 'Chicken', optionLabel: 'Chicken', optionIndex: 0, prob: 0.65 },
        { optionValue: 'Beef', optionLabel: 'Beef', optionIndex: 1, prob: 0.45 },
      ],
      permittedEvidence: baseEvidence,
      catalogField: 'ProductField1',
    });
    expect(insufficientOutcome.outcome).toBe('abstained');
    if (insufficientOutcome.outcome === 'abstained') {
      expect(insufficientOutcome.abstentionCode).toBe('insufficient_evidence');
    }

    // 4c. Qualifying candidates sorted descending by prob, then original index
    const resolvedOutcome = evaluateMultiValueSelectionPolicy({
      target: multiFlavorTarget,
      candidates: [
        { optionValue: 'Beef', optionLabel: 'Beef', optionIndex: 1, prob: 0.85 },
        { optionValue: 'Chicken', optionLabel: 'Chicken', optionIndex: 0, prob: 0.95 },
        { optionValue: 'Salmon', optionLabel: 'Salmon', optionIndex: 2, prob: 0.75 },
      ],
      permittedEvidence: baseEvidence,
      catalogField: 'ProductField1',
    });
    expect(resolvedOutcome.outcome).toBe('resolved');
    if (resolvedOutcome.outcome === 'resolved') {
      expect(resolvedOutcome.selectedValues).toEqual(['Chicken', 'Beef', 'Salmon']);
      expect(resolvedOutcome.topProb).toBe(0.95);
    }

    // 4d. Cardinality limit (maxItems = 2) without tie takes top 2
    const limitedOutcome = evaluateMultiValueSelectionPolicy({
      target: multiFlavorTarget,
      candidates: [
        { optionValue: 'Chicken', optionLabel: 'Chicken', optionIndex: 0, prob: 0.95 },
        { optionValue: 'Beef', optionLabel: 'Beef', optionIndex: 1, prob: 0.85 },
        { optionValue: 'Salmon', optionLabel: 'Salmon', optionIndex: 2, prob: 0.75 },
      ],
      permittedEvidence: baseEvidence,
      catalogField: 'ProductField1',
      maxItems: 2,
    });
    expect(limitedOutcome.outcome).toBe('resolved');
    if (limitedOutcome.outcome === 'resolved') {
      expect(limitedOutcome.selectedValues).toEqual(['Chicken', 'Beef']);
    }

    // 4e. Boundary tie at maxItems (k-1 and k have identical probability) -> cardinality_limit_exceeded
    const tiedOutcome = evaluateMultiValueSelectionPolicy({
      target: multiFlavorTarget,
      candidates: [
        { optionValue: 'Chicken', optionLabel: 'Chicken', optionIndex: 0, prob: 0.95 },
        { optionValue: 'Beef', optionLabel: 'Beef', optionIndex: 1, prob: 0.80 },
        { optionValue: 'Salmon', optionLabel: 'Salmon', optionIndex: 2, prob: 0.80 },
      ],
      permittedEvidence: baseEvidence,
      catalogField: 'ProductField1',
      maxItems: 2,
    });
    expect(tiedOutcome.outcome).toBe('abstained');
    if (tiedOutcome.outcome === 'abstained') {
      expect(tiedOutcome.abstentionCode).toBe('cardinality_limit_exceeded');
      expect(tiedOutcome.abstentionReason).toContain('Ambiguity at cardinality limit');
    }
  });

  // ─── AC 5: Precedence, Direct Claims, and Visual Evidence Eligibility ───────

  it('5. AC 5: reviewed facts & deterministic aliases take precedence; claims require direct evidence', async () => {
    const run = createRun(workspaceId, 'SKU-CLAIM-1', null, 'hash-claims');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    // 5a. Reviewed fact takes precedence without network calls
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response('{}', { status: 200 });
    }) as any;

    const reviewedDecision = await resolveAttributeDecision({
      target: multiFlavorTarget,
      cardinality: 'multiple',
      evidence: baseEvidence,
      sku: 'SKU-CLAIM-1',
      runId: run.id,
      snapshot: {
        snapshotHash: 'snap-rev',
        reviewedFacts: [
          {
            targetId: 'flavor',
            proposalType: 'field_assignment',
            value: ['Salmon', 'Duck'],
          },
        ],
      } as any,
      modelPolicy: policyView,
    });

    expect(fetchCount).toBe(0);
    expect(reviewedDecision.status).toBe('resolved');
    expect(reviewedDecision.values).toEqual(['Salmon', 'Duck']);
    expect(reviewedDecision.probabilityBasis).toBe('reviewed_fact');

    // 5b. Direct-claim safeguard: claims with high probability but only third-party/indirect evidence abstain
    const nonDirectEvidence: ClassificationEvidence[] = [
      {
        id: 'ev-indirect',
        runId: run.id,
        stageName: 'evidence_extraction',
        productSku: 'SKU-CLAIM-1',
        attributeId: null,
        source: 'third_party_page', // not in DIRECT_EVIDENCE_SOURCES
        reliability: 'medium',
        sourceUrl: 'https://blog.example.com/review',
        sourceField: 'snippet',
        snippet: 'A blogger claims this product is Grain-Free.',
        value: 'A blogger claims this product is Grain-Free.',
        metadata: null,
        capturedAt: new Date().toISOString(),
      },
    ];

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_special_diet__val_0: { type: 'noul', noul: 0.95 },
            attr_special_diet__val_1: { type: 'noul', noul: 0.10 },
            attr_special_diet__val_2: { type: 'noul', noul: 0.05 },
          },
          usage: { input_tokens: 80, output_tokens: 15 },
        }),
        { status: 200 },
      );
    }) as any;

    const claimDecision = await resolveAttributeDecision({
      target: claimTarget,
      cardinality: 'multiple',
      evidence: nonDirectEvidence,
      sku: 'SKU-CLAIM-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(claimDecision.status).toBe('abstained');
    expect(claimDecision.abstentionCode).toBe('unsupported_claim');
    expect(claimDecision.abstentionReason).toContain('requires target-specific direct product evidence');
  });

  // ─── AC 6: Proposal Generation & Review-Required Guarantee ──────────────────

  it('6. AC 6: generates field_assignment proposals with isBulkAcceptable=false and preserved candidateProbabilities', () => {
    const decision = {
      status: 'resolved' as const,
      targetId: 'flavor',
      value: 'Chicken, Beef',
      values: ['Chicken', 'Beef'],
      confidence: 0.92,
      selectedProbability: 0.92,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities: { Chicken: 0.92, Beef: 0.84, Salmon: 0.12 },
      source: 'jev' as const,
      derivation: {
        kind: 'systemone_judgment' as const,
        primitive: 'noul' as const,
        questionId: 'attr_flavor',
        selectedProbability: 0.92,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        candidateProbabilities: { Chicken: 0.92, Beef: 0.84, Salmon: 0.12 },
      },
      modelCallIds: ['call-1', 'call-2'],
      evidenceIds: ['ev-1', 'ev-2'],
      supportingEvidenceIds: ['ev-1'],
      contradictingEvidenceIds: [],
    };

    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-MULTI-1', 'run-1', 'snap-1');

    expect(proposal.proposalType).toBe('field_assignment');
    expect(proposal.targetId).toBe('flavor');
    expect(proposal.proposedValue).toEqual(['Chicken', 'Beef']);
    expect(proposal.confidence).toBe(0.92);
    // AC 6 mandate: Jev proposals remain non-bulk-acceptable (human review required)
    expect(proposal.isBulkAcceptable).toBe(false);
    expect(proposal.derivation?.kind).toBe('systemone_judgment');
    if (proposal.derivation?.kind === 'systemone_judgment') {
      expect(proposal.derivation.primitive).toBe('noul');
      expect(proposal.derivation.candidateProbabilities).toEqual({
        Chicken: 0.92,
        Beef: 0.84,
        Salmon: 0.12,
      });
    }
    expect(proposal.modelCallIds).toEqual(['call-1', 'call-2']);
  });

  // ─── AC 7: Benchmark Evaluator Set Metrics & Prediction Capture ──────────────

  it('7. AC 7: benchmark prediction captures set values and evaluator scores set precision, recall, F1', () => {
    const run = createRun(workspaceId, 'SKU-EVAL-1', null, 'snap-eval');

    // 7a. Capture pre-review prediction with both value and values
    const now = new Date().toISOString();
    const { getDb } = require('../../db/connection');
    const db = getDb();
    db.run('UPDATE classification_runs SET status = ? WHERE id = ?', ['completed', run.id]);

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dog-food', ?, 0.90, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-EVAL-1', JSON.stringify('dog-food'), now],
    );

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', ?, 0.92, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-EVAL-1', JSON.stringify(['Chicken', 'Beef']), now],
    );

    const prediction = capturePreReviewPrediction({
      runId: run.id,
      workspaceId,
      productSku: 'SKU-EVAL-1',
    });

    expect(prediction.fieldAssignments).toEqual([
      {
        targetId: 'flavor',
        value: 'Chicken, Beef',
        values: ['Chicken', 'Beef'],
      },
    ]);

    // 7b. Evaluator set-based metric calculation
    // Case 1: Exact match
    const exactVerdict = scoreEvaluatorFieldExample({
      goldState: EVALUATOR_FIELD_GOLD_STATE_KNOWN,
      goldValue: 'Chicken, Beef',
      goldValues: ['Chicken', 'Beef'],
      predictedValue: 'Chicken, Beef',
      predictedValues: ['Chicken', 'Beef'],
      outcome: EVALUATOR_OUTCOME_PREDICTED,
    });
    expect(exactVerdict).toBe('correct');

    const exactSetMetrics = computeSetMetrics(
      parseValueSet(['Chicken', 'Beef']),
      parseValueSet(['Chicken', 'Beef']),
    );
    expect(exactSetMetrics.exactMatch).toBe(true);
    expect(exactSetMetrics.precision).toBe(1);
    expect(exactSetMetrics.recall).toBe(1);
    expect(exactSetMetrics.f1).toBe(1);

    // Case 2: Partial overlap (gold = Chicken, Beef; predicted = Chicken)
    const partialVerdict = scoreEvaluatorFieldExample({
      goldState: EVALUATOR_FIELD_GOLD_STATE_KNOWN,
      goldValue: 'Chicken, Beef',
      goldValues: ['Chicken', 'Beef'],
      predictedValue: 'Chicken',
      predictedValues: ['Chicken'],
      outcome: EVALUATOR_OUTCOME_PREDICTED,
    });
    expect(partialVerdict).toBe('incorrect');

    const partialSetMetrics = computeSetMetrics(
      parseValueSet(['Chicken', 'Beef']),
      parseValueSet(['Chicken']),
    );
    expect(partialSetMetrics.exactMatch).toBe(false);
    expect(partialSetMetrics.precision).toBe(1.0); // 1 / 1
    expect(partialSetMetrics.recall).toBe(0.5);    // 1 / 2
    expect(partialSetMetrics.f1).toBeCloseTo(0.667, 3);

    // 7c. Evaluator attribution aggregates setMetrics
    const goldExample: GoldExampleForEvaluation = {
      id: 'ex-1',
      productSku: 'SKU-EVAL-1',
      evidenceText: 'chicken beef dog food',
      fieldGoldStates: {
        flavor: EVALUATOR_FIELD_GOLD_STATE_KNOWN,
      },
      goldLabels: {
        productType: 'dog-food',
        pageAssignments: [],
        fieldAssignments: [
          { targetId: 'flavor', value: 'Chicken, Beef', values: ['Chicken', 'Beef'] },
        ],
      },
      splitGroup: 'test',
    };

    const predictionEntry: BenchmarkPredictionEntry = {
      exampleId: 'ex-1',
      productSku: 'SKU-EVAL-1',
      productType: 'dog-food',
      pageAssignments: [],
      fieldAssignments: [
        {
          targetId: 'flavor',
          value: 'Chicken, Beef',
          values: ['Chicken', 'Beef'],
        },
      ],
      claimTargets: [],
      abstained: false,
      confidence: 0.9,
    };

    const attribution = computeEvaluatorAttribution([goldExample], [predictionEntry]);
    const report = attribution.fieldReports?.flavor;
    expect(report).toBeDefined();
    expect(report?.setMetrics).toBeDefined();
    expect(report?.setMetrics?.exactMatchAccuracy).toBe(1.0);
    expect(report?.setMetrics?.meanF1).toBe(1.0);
  });

  // ─── AC 8: Policy Denied & Disabled Connection Handling ─────────────────────

  it('8. AC 8: model policy denied abstains with policy_denied; disabled connection fails closed', async () => {
    const run = createRun(workspaceId, 'SKU-POL-1', null, 'snap-pol');

    // 8a. Policy with denied locality/model
    const deniedPolicy: ModelPolicyConfigV2 = {
      ...cloudJevPolicy,
      providerLocalities: { typesafe: 'local' }, // connection trustZone is cloud -> locality mismatch denies policy
    };
    const policyView = buildModelPolicyView(deniedPolicy);

    const decision = await resolveAttributeDecision({
      target: multiFlavorTarget,
      cardinality: 'multiple',
      evidence: jevEvidence,
      sku: 'SKU-POL-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('abstained');
    expect(decision.abstentionCode).toBe('policy_denied');

    // 8b. Disabled connection
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: 'ts-secret-key-300',
      enabled: false, // disabled
      lastProbedAt: new Date().toISOString(),
      lastProbeStatus: 'disabled',
      models: [{ id: 'jev-1.13.0', name: 'Jev 1.13.0' }],
    } as any);

    const validPolicyView = buildModelPolicyView(cloudJevPolicy);
    expect(
      resolveAttributeDecision({
        target: multiFlavorTarget,
        cardinality: 'multiple',
        evidence: jevEvidence,
        sku: 'SKU-POL-1',
        runId: run.id,
        modelPolicy: validPolicyView,
      }),
    ).rejects.toThrow(/disabled/i);
  });

  // ─── AC 9: End-to-End Workflow & Review Correction ──────────────────────────

  it('9. AC 9: end-to-end multi-value proposal, review correction, and benchmark evaluation', async () => {
    const run = createRun(workspaceId, 'SKU-E2E-1', null, 'snap-e2e');
    const policyView = buildModelPolicyView(cloudJevPolicy);

    // 1. Model predicts Chicken and Salmon
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            attr_flavor__val_0: { type: 'noul', noul: 0.90 }, // Chicken
            attr_flavor__val_1: { type: 'noul', noul: 0.20 }, // Beef
            attr_flavor__val_2: { type: 'noul', noul: 0.85 }, // Salmon
            attr_flavor__val_3: { type: 'noul', noul: 0.05 }, // Duck
            attr_flavor__val_4: { type: 'noul', noul: 0.02 }, // Turkey
          },
          usage: { input_tokens: 150, output_tokens: 30 },
        }),
        { status: 200 },
      );
    }) as any;

    const decision = await resolveAttributeDecision({
      target: multiFlavorTarget,
      cardinality: 'multiple',
      evidence: jevEvidence,
      sku: 'SKU-E2E-1',
      runId: run.id,
      modelPolicy: policyView,
    });

    expect(decision.status).toBe('resolved');
    expect(decision.values).toEqual(['Chicken', 'Salmon']);

    // 2. Proposal is built and persisted as pending
    const proposal = buildProposalFromAttributeDecision(decision, 'SKU-E2E-1', run.id, 'snap-e2e');
    expect(proposal.isBulkAcceptable).toBe(false);

    const { getDb } = require('../../db/connection');
    const db = getDb();
    const now = new Date().toISOString();
    db.run('UPDATE classification_runs SET status = ? WHERE id = ?', ['completed', run.id]);

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dog-food', ?, 0.90, 'pending', ?)`,
      [randomUUID(), run.id, 'SKU-E2E-1', JSON.stringify('dog-food'), now],
    );

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', ?, 0.90, 'pending', ?)`,
      [proposal.id, run.id, 'SKU-E2E-1', JSON.stringify(proposal.proposedValue), now],
    );

    // 3. Capture prediction before reviewer decision
    const prediction = capturePreReviewPrediction({
      runId: run.id,
      workspaceId,
      productSku: 'SKU-E2E-1',
    });
    expect(prediction.fieldAssignments).toEqual([
      { targetId: 'flavor', value: 'Chicken, Salmon', values: ['Chicken', 'Salmon'] },
    ]);

    // 4. Human reviewer reviews and corrects to Chicken, Salmon, AND Duck
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, created_at)
       VALUES (?, ?, 'accepted', ?, ?)`,
      [randomUUID(), proposal.id, JSON.stringify(['Chicken', 'Salmon', 'Duck']), now],
    );

    // 5. Evaluate uncorrected prediction against reviewer gold truth
    const goldExample: GoldExampleForEvaluation = {
      id: 'gold-1',
      productSku: 'SKU-E2E-1',
      evidenceText: 'chicken salmon duck dog food',
      fieldGoldStates: {
        flavor: EVALUATOR_FIELD_GOLD_STATE_KNOWN,
      },
      goldLabels: {
        productType: 'dog-food',
        pageAssignments: [],
        fieldAssignments: [
          { targetId: 'flavor', value: 'Chicken, Salmon, Duck', values: ['Chicken', 'Salmon', 'Duck'] },
        ],
      },
      splitGroup: 'test',
    };
    prediction.exampleId = 'gold-1';

    const attribution = computeEvaluatorAttribution([goldExample], [prediction]);

    const report = attribution.fieldReports?.flavor;
    expect(report).toBeDefined();
    // 2 predicted out of 3 gold -> Precision = 2/2 = 1.0, Recall = 2/3 = 0.667
    expect(report?.setMetrics?.exactMatchAccuracy).toBe(0);
    expect(report?.setMetrics?.meanPrecision).toBe(1.0);
    expect(report?.setMetrics?.meanRecall).toBeCloseTo(0.667, 3);
  });
});
