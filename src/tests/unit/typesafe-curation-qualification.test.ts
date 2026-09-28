/**
 * Jev Curation Workflow Qualification & Release Verification (Issue #302).
 *
 * Verifies all 10 acceptance criteria:
 * - Criterion 1: Full supported path end-to-end (AI compute connection -> route preview/apply
 *   -> frozen product type -> attributes & cohort pages -> review/correction -> immutable report)
 * - Criterion 2: Representative family-separated evaluation gold set (assortments, 0 leakage, adjudicated)
 * - Criterion 3: Per-capability question/threshold policies & qualification gates
 * - Criterion 4: Baseline vs Jev offline comparison report (correctness, coverage, regressions, field/page sets, telemetry)
 * - Criterion 5: Bounded opt-in live-provider contract check guarantees
 * - Criterion 6: Staged canaries in order with final human review & non-bulk-acceptable proposals
 * - Criterion 7: Connection disablement & route change semantics (no retry, no implicit fallback, provenance intact)
 * - Criterion 8: Compatibility with other providers, deterministic rules, frozen snapshots, and legacy reads
 * - Criterion 9: Operator documentation & confidence concepts
 * - Criterion 10: Specific blocker reporting when prerequisites are missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertProviderConnection, getProviderConnection } from '../../db/repositories/provider-connection-repo';
import { createRun, getRun, completeRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import { resolveProductTypeDecision } from '../../classification/product-type-decision';
import {
  resolveAttributeDecision,
  buildProposalFromAttributeDecision,
} from '../../classification/attribute-decision';
import { coordinateCohortPagesWithJev } from '../../classification/page-decision';
import {
  previewClassificationPolicy,
  CLASSIFICATION_POLICY_STAGES,
} from '../../classification/classification-policy-service';
import {
  buildModelExecutionPlan,
  buildRuntimeRuleVersions,
} from '../../classification/model-operation-registry';
import {
  evaluateQualificationGate,
  reportRawAccuracyQualification,
  assessPredictionSourceEligibility,
  QUALIFIED_RAW_PREDICTION_SOURCE,
  LEGACY_REVIEWED_OUTCOME_SOURCE,
} from '../../classification/benchmark-qualification';
import {
  computeSetMetrics,
  parseValueSet,
  evaluateCohortPipelineEffects,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import {
  evaluateJevOfflineComparison,
  assessProductionQualification,
  REQUIRED_COMPATIBILITY_SUITE_IDS,
  OPERATOR_RUNBOOK_PATH,
  type QualificationGoldset,
} from '../../classification/jev-qualification-service';
import {
  buildPreReviewPredictionBundle,
  capturePreReviewPrediction,
  PRE_REVIEW_PREDICTION_SOURCE,
  PRE_REVIEW_BUNDLE_VERSION,
  parseQualificationGoldOnly,
  buildQualificationPredictionsFromCode,
  captureQualificationPredictionsLive,
  buildQualificationCandidateQuestionSet,
  qualificationTaxonomiesFromFrozenSnapshot,
  QUALIFICATION_PREDICTOR_VERSION,
  QUALIFICATION_SOURCE_LIVE_CAPTURED,
  QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR,
  QUALIFICATION_SOURCE_BLOCKED,
  QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT,
  QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT,
  type QualificationGoldOnlyEntry,
  type QualificationTaxonomies,
} from '../../classification/benchmark-prediction';
import {
  detectFamilySplitLeakage,
  detectFamilyDevHoldoutStraddle,
  verifyFamilySeparation,
  buildFrozenTaxonomyCandidates,
  findGoldOutsideFrozenTaxonomy,
} from '../../classification/benchmark-exporter';
import {
  findPredictionsOutsideFrozenTaxonomy,
  verifyFrozenTaxonomySnapshotShape,
} from '../../classification/benchmark-evaluator';
import { runLiveContractCheck } from '../../../scripts/typesafe-live-contract-check';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2, BenchmarkPredictionEntry, EvalMetrics } from '../../shared/schemas/classification';

/**
 * Load the frozen GOLD-ONLY fixture and capture the current baseline +
 * candidate classification paths from code (mirrors
 * scripts/typesafe-curation-qualification.ts). Tests score the captured
 * artifact — never stored predictions. Candidate option sets come from the
 * fixture's frozen taxonomy snapshot (never the union of gold labels).
 */
function loadExecutedQualificationGoldset(): QualificationGoldset {
  const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const goldEntries = parseQualificationGoldOnly(raw);
  const artifact = buildQualificationPredictionsFromCode(goldEntries, raw.frozenTaxonomy ?? undefined);
  return {
    version: raw.version,
    description: raw.description,
    adjudicatedBy: raw.adjudicatedBy,
    verifiedPageImport: raw.verifiedPageImport,
    frozenTaxonomy: raw.frozenTaxonomy ?? null,
    entries: goldEntries.map(e => {
      const p = artifact.predictions.find(x => x.sku === e.sku);
      if (!p) throw new Error(`Missing executed prediction for "${e.sku}".`);
      return {
        sku: e.sku,
        familyId: e.familyId,
        split: e.split,
        assortment: e.assortment,
        gold: e.gold,
        evidence: e.evidence,
        baseline: { ...p.baseline },
        candidate: { ...p.candidate },
      };
    }),
  };
}

/**
 * Shared fixture builders (complexity extraction only — test behavior
 * identical). Hoists the inline SystemOne mock, evidence, and target
 * fixtures out of the Criterion bodies so the test arrows stay below the
 * complexity thresholds.
 */
function qualificationChoiceAnswerFor(criteriaKeys: string[]) {
  const remainingKeys = criteriaKeys.slice(1);
  const remainder = remainingKeys.length > 0 ? (1 - 0.94) / remainingKeys.length : 0;
  const probabilities: Record<string, number> = {
    [criteriaKeys[0]]: 0.94,
  };
  for (const rk of remainingKeys) {
    probabilities[rk] = remainder;
  }
  return {
    type: 'choice',
    choice: criteriaKeys[0],
    probabilities,
    confidence: 0.94,
  };
}

function qualificationNoulAnswerFor(key: string) {
  const isMatch = key.includes('Chicken') || key.includes('Duck') || key.includes('val_0') || key.includes('val_1');
  return {
    type: 'noul',
    noul: isMatch ? 0.92 : 0.05,
  };
}

function buildQualificationMockFetch(): typeof fetch {
  return (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    const questions = body.questions;
    const answers: Record<string, any> = {};

    for (const [key, q] of Object.entries(questions) as [string, any][]) {
      if (q.type === 'choice') {
        answers[key] = qualificationChoiceAnswerFor(Object.keys(q.criteria));
      } else if (q.type === 'noul') {
        answers[key] = qualificationNoulAnswerFor(key);
      }
    }

    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 120, output_tokens: 30 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

function makeQualificationPtTarget(): unknown {
  const ptOptions = [
    { value: 'dog_food_dry', label: 'Dry Dog Food' },
    { value: 'dog_food_wet', label: 'Wet Dog Food' },
  ];
  return {
    config: {
      id: 'primary_product_type',
      label: 'Primary Product Type',
      kind: 'product_type',
      attributeId: null,
      catalogField: 'ProductType',
      selectionMode: 'single',
      confidenceThreshold: 0.7,
    },
    options: ptOptions,
    attribute: null,
  };
}

function makeQualificationSnapshot(
  workspaceId: string,
  runtimeRuleVersions: unknown,
  modelExecutionPlan: unknown,
  defaultPolicyConfig: unknown,
): unknown {
  return {
    schemaVersion: 2,
    id: 'snap-qual-1',
    workspaceId,
    snapshotHash: 'hash-snap-qual-1',
    catalogHash: 'hash-snap-qual-1',
    curationTargets: [
      { id: 'primary_product_type', label: 'Primary Product Type', kind: 'product_type', catalogField: 'ProductField24', selectionMode: 'single', confidenceThreshold: 0.7, guidancePrompt: 'Select product type', enabled: true, mandatory: true },
      { id: 'category_pages', label: 'Category Pages', kind: 'pages', catalogField: 'ProductOnPages', selectionMode: 'multiple', confidenceThreshold: 0.7, guidancePrompt: 'Select category pages', enabled: true, mandatory: false },
    ],
    productType: { state: 'verified' },
    pages: {
      state: 'verified',
      catalogHash: 'hash-snap-qual-1',
      records: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food', verified: true, active: true }],
    },
    modelPolicy: defaultPolicyConfig,
    runtimeRuleVersions,
    modelExecutionPlan,
    createdAt: new Date().toISOString(),
  };
}

function makeQualificationFlavorTarget(): unknown {
  return {
    config: {
      id: 'target_flavor',
      label: 'Flavors',
      kind: 'product_field',
      attributeId: 'flavor',
      catalogField: 'ProductField1',
      selectionMode: 'multiple',
      confidenceThreshold: 0.7,
    },
    options: [
      { value: 'Chicken', label: 'Chicken' },
      { value: 'Duck', label: 'Duck' },
      { value: 'Beef', label: 'Beef' },
    ],
    attribute: {
      id: 'flavor',
      name: 'Flavors',
      valueMode: 'controlled',
      visualEvidenceEligibility: 'eligible',
    },
  };
}

function makeQualificationEvidence(runId: string, productSku: string): unknown[] {
  return [
    {
      id: 'ev-qual-1',
      runId,
      stageName: 'evidence_extraction',
      productSku,
      attributeId: null,
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/kibble',
      sourceField: 'title',
      snippet: 'Fromm Gold Adult Canine Kibble Chicken & Duck Recipe',
      value: 'Fromm Gold Adult Canine Kibble Chicken & Duck Recipe',
      metadata: null,
      capturedAt: new Date().toISOString(),
    },
  ];
}

describe('Issue #302: TypeSafe Jev Curation Qualification and Release', () => {
  const originalFetch = globalThis.fetch;
  let wsPath: string;
  let dbPath: string;
  const workspaceId = 'ws-qual-test-302';

  const defaultPolicyConfig: ModelPolicyConfigV2 = {
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
      product_attribute_proposals: {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        fallbackProvider: null,
        fallbackModel: null,
      },
      category_page_proposals: {
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
    wsPath = path.join(os.tmpdir(), `qual-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();

    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Qual WS', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()],
    );

    // Seed TypeSafe Connection
    upsertProviderConnection({
      id: 'typesafe',
      label: 'TypeSafe Cloud Provider',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      credential: 'live-test-credential-xyz',
      trustZone: 'cloud',
      approvedHost: 'api.typesafe.ai',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 5000,
      inferenceTimeoutMs: 15000,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    if (fs.existsSync(wsPath)) fs.rmSync(wsPath, { recursive: true, force: true });
  });

  // ── Criterion 1: Full Supported Path End-to-End ─────────────────────────────
  describe('Criterion 1: Full supported path end-to-end', () => {
    it('executes connection -> route apply -> frozen PT -> attributes & cohort pages -> review -> immutable report', async () => {
      // 1. Verify AI Compute connection
      const conn = getProviderConnection('typesafe');
      expect(conn).not.toBeNull();
      expect(conn?.transport).toBe('systemone');
      expect(conn?.enabled).toBe(true);

      // 2. Governed route verification
      const stages = CLASSIFICATION_POLICY_STAGES;
      const ptStageDef = stages.find(s => s.id === 'primary_product_type_proposal');
      const attrStageDef = stages.find(s => s.id === 'product_attribute_proposals');
      const pageStageDef = stages.find(s => s.id === 'category_page_proposals');
      expect(ptStageDef?.supportedTransports).toContain('systemone');
      expect(attrStageDef?.supportedTransports).toContain('systemone');
      expect(pageStageDef?.supportedTransports).toContain('systemone');

      const policyView = buildModelPolicyView(defaultPolicyConfig);
      expect(policyView.defaultProvider).toBe('typesafe');
      expect(policyView.stageOverrides.primary_product_type_proposal?.model).toBe('jev-1.13.0');
      expect(policyView.stageOverrides.product_attribute_proposals?.model).toBe('jev-1.13.0');
      expect(policyView.stageOverrides.category_page_proposals?.model).toBe('jev-1.13.0');

      // 3. Frozen Product Type proposal with Jev
      const run = createRun(
        workspaceId,
        'SKU-QUAL-FULL-01',
        null,
        'hash-snap-qual-1',
      );

      const ptTarget = makeQualificationPtTarget() as unknown as ResolvedTarget;

      const evidence = makeQualificationEvidence(run.id, 'SKU-QUAL-FULL-01') as unknown as ClassificationEvidence[];

      // Mock SystemOne HTTP endpoint for Product Type, Attributes, and Cohort Pages
      globalThis.fetch = buildQualificationMockFetch();

      const runtimeRuleVersions = buildRuntimeRuleVersions();
      const modelExecutionPlan = buildModelExecutionPlan(policyView);

      const snapshot = makeQualificationSnapshot(workspaceId, runtimeRuleVersions, modelExecutionPlan, defaultPolicyConfig);

      const ptDecision = await resolveProductTypeDecision({
        target: ptTarget,
        evidence,
        sku: 'SKU-QUAL-FULL-01',
        runId: run.id,
        modelPolicy: policyView,
      });

      expect(ptDecision.status).toBe('resolved');
      expect(ptDecision.productTypeId).toBe('dog_food_dry');
      expect(ptDecision.confidence).toBe(0.94);

      // Verify model call provenance recorded
      const ptCalls = getModelCallsByRun(run.id);
      expect(ptCalls).toHaveLength(1);
      expect(ptCalls[0].provider).toBe('typesafe');
      expect(ptCalls[0].model).toBe('jev-1.13.0');

      // 4. Attribute proposals stage (multi-value flavors)
      const flavorTarget = makeQualificationFlavorTarget() as unknown as ResolvedTarget;

      const attrDecision = await resolveAttributeDecision({
        target: flavorTarget,
        cardinality: 'multiple',
        evidence,
        sku: 'SKU-QUAL-FULL-01',
        runId: run.id,
        modelPolicy: policyView,
        productContext: { productType: 'dog_food_dry' },
      });

      expect(attrDecision.status).toBe('resolved');
      expect(attrDecision.values).toEqual(['Chicken', 'Duck']);

      const attrProposal = buildProposalFromAttributeDecision(attrDecision, run.id, 'SKU-QUAL-FULL-01');
      expect(attrProposal.isBulkAcceptable).toBe(false);

      // 5. Cohort Category Pages proposal stage
      const sampleProducts = [
        {
          sku: 'SKU-QUAL-FULL-01',
          name: 'Fromm Gold Adult Dry Dog Food',
          evidence: [{ id: 'ev-1', text: 'Fromm Gold Adult Dry Dog Food' }],
          effectiveProductType: 'dog_food_dry',
          reviewedProductType: 'dog_food_dry',
        },
      ] as any;
      const samplePages = [
        { id: 'page-dry-dog-food', name: 'Dry Dog Food', parentName: null, active: true, species: 'dog', verifiedImportId: 'imp-1' },
      ];

      const cohortPageResults = await coordinateCohortPagesWithJev(
        {
          groupId: 'grp-fromm-full',
          products: sampleProducts,
          pages: samplePages,
          selectionMode: 'single',
          maxPages: 2,
          modelPolicy: policyView,
          snapshot: snapshot as any,
        },
        { allowSingleProduct: true },
      );

      const pageRes = cohortPageResults.get('SKU-QUAL-FULL-01');
      expect(pageRes?.status).toBe('assigned');
      if (pageRes?.status === 'assigned') {
        expect(pageRes.pages[0].pageId).toBe('page-dry-dog-food');
        expect(pageRes.source).toBe('typesafe');
      }

      // 6. Review & correction by operator
      getDb().run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES ('prop-qual-1', ?, 'SKU-QUAL-FULL-01', 'primary_product_type', 'primary_product_type', ?, 0.94, 'pending', ?)`,
        [run.id, JSON.stringify('dog_food_dry'), new Date().toISOString()],
      );

      getDb().run(
        `INSERT INTO classification_proposal_decisions (
           id, proposal_id, decision, reviewer_id, revised_value_json, created_at
         ) VALUES (?, ?, 'accepted', 'store-manager', ?, ?)`,
        ['dec-1', 'prop-qual-1', JSON.stringify('dog_food_dry'), new Date().toISOString()],
      );

      const decisionRow = getDb().query(
        `SELECT * FROM classification_proposal_decisions WHERE id = ?`,
      ).get('dec-1') as any;
      expect(decisionRow.decision).toBe('accepted');
      expect(JSON.parse(decisionRow.revised_value_json)).toBe('dog_food_dry');

      // 7. Immutable pre-review capture (never reads reviewer decisions)
      completeRun(run.id, 'completed');
      const capture = capturePreReviewPrediction({
        runId: run.id,
        workspaceId,
        productSku: 'SKU-QUAL-FULL-01',
      });
      expect(capture.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
      expect(capture.bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
      expect(capture.productType).toBe('dog_food_dry');
      expect(capture.outcome).toBe('predicted');

      // 8. Raw accuracy qualification report
      const qualReport = reportRawAccuracyQualification({
        datasetId: 'ds-qual-1',
        datasetHash: 'hash-ds-1',
        predictionBundleId: 'bundle-qual-1',
        bundleHash: 'bhash-1',
        holdoutSize: 10,
        metrics: {
          productType: { top1Accuracy: 1, coverage: 1, perClassSupport: { dog_food_dry: 10 } },
          safety: { crossSpeciesCount: 0, claimSafetyViolations: 0, controlledValueViolations: 0 },
          pairedDelta: { primaryMetric: 'productType.top1Accuracy', deltaLower95: 0.1 },
          calibration: { ece: 0.05 },
          pages: { blocked: false },
        } as any,
        qualification: {
          qualified: true,
          reasons: [],
          gate: { predictionSource: PRE_REVIEW_PREDICTION_SOURCE, bundleVersion: PRE_REVIEW_BUNDLE_VERSION } as any,
        },
        source: PRE_REVIEW_PREDICTION_SOURCE,
        bundleVersion: PRE_REVIEW_BUNDLE_VERSION,
      });

      expect(qualReport.eligible).toBe(true);
      expect(qualReport.status).toBe('qualified');
    });
  });

  // ── Criterion 2: Representative Family-Separated Evaluation Goldset ─────────
  describe('Criterion 2: Representative family-separated evaluation gold set', () => {
    it('verifies goldset coverage of all required assortments and zero split leakage', () => {
      const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
      expect(fs.existsSync(fixturePath)).toBe(true);

      const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const goldEntries = parseQualificationGoldOnly(raw);

      expect(goldEntries.length).toBeGreaterThanOrEqual(15);
      expect(raw.adjudicatedBy).toBeTruthy();

      // Gold-only contract: the frozen fixture carries adjudicated gold +
      // evidence and NEVER stored baseline/candidate predictions. Reports
      // must execute predictions from code instead of replaying the fixture.
      for (const entryRaw of raw.entries as Array<Record<string, unknown>>) {
        expect('baseline' in entryRaw).toBe(false);
        expect('candidate' in entryRaw).toBe(false);
      }

      // Check required assortments
      const assortments = new Set(goldEntries.map(e => e.assortment));
      expect(assortments.has('food')).toBe(true);
      expect(assortments.has('treats')).toBe(true);
      expect(assortments.has('toys')).toBe(true);
      expect(assortments.has('animal-care')).toBe(true);
      expect(assortments.has('garden')).toBe(true);
      expect(assortments.has('pest-control')).toBe(true);
      expect(assortments.has('confusing-neighbor')).toBe(true);
      expect(assortments.has('unknown-type')).toBe(true);
      expect(assortments.has('incomplete-evidence')).toBe(true);
      expect(assortments.has('mixed-cohort')).toBe(true);

      // Verify family-split isolation (0 leakage)
      const assignments = goldEntries.map(e => ({
        familyId: e.familyId,
        splitGroup: e.split,
      }));
      const leakage = detectFamilySplitLeakage(assignments);
      expect(leakage).toHaveLength(0);
      // Dev-aware boundary: the shared helper only recognizes train/test as
      // dev-side, so the dev/holdout goldset vocabulary needs its own check.
      expect(detectFamilyDevHoldoutStraddle(assignments)).toHaveLength(0);

      // True family split: no split-suffixed ids (`*-dev` / `*-holdout`) as
      // distinct families — one underlying product owns one family id.
      for (const e of goldEntries) {
        expect(e.familyId).not.toMatch(/-dev$/);
        expect(e.familyId).not.toMatch(/-holdout$/);
      }

      // Acme kibble variants/sizes share ONE family in ONE split; the Fromm
      // cohort pair shares ONE family in ONE split; distinct GardenPro pest
      // products own distinct families.
      const kibble = goldEntries.filter(e => e.sku.startsWith('QUAL-DOG-KIBBLE-'));
      expect(kibble.length).toBe(3);
      expect(new Set(kibble.map(e => e.familyId)).size).toBe(1);
      expect(new Set(kibble.map(e => e.split)).size).toBe(1);
      const fromm = goldEntries.filter(e => e.sku.startsWith('QUAL-COHORT-FROMM-'));
      expect(fromm.length).toBe(2);
      expect(new Set(fromm.map(e => e.familyId)).size).toBe(1);
      expect(new Set(fromm.map(e => e.split)).size).toBe(1);
      const yardInsect = goldEntries.find(e => e.sku === 'QUAL-PEST-01');
      const waspHornet = goldEntries.find(e => e.sku === 'QUAL-PEST-HOLDOUT-01');
      expect(yardInsect!.familyId).not.toBe(waspHornet!.familyId);

      // Real family-leakage verification: shared identity plus
      // near-duplicate detection across splits produces a passing proof.
      const proof = verifyFamilySeparation(goldEntries);
      expect(proof.passed).toBe(true);
      expect(proof.leakedFamilies).toHaveLength(0);
      expect(proof.nearDuplicatePairs).toHaveLength(0);
      expect(proof.familiesChecked).toBeGreaterThan(0);

      // Frozen-taxonomy candidates: the option pool comes from the frozen
      // snapshot, never the union of gold labels.
      expect(raw.frozenTaxonomy).toBeTruthy();
      expect(verifyFrozenTaxonomySnapshotShape(raw.frozenTaxonomy)).toHaveLength(0);
      expect(findGoldOutsideFrozenTaxonomy(goldEntries, raw.frozenTaxonomy)).toHaveLength(0);
      const candidates = buildFrozenTaxonomyCandidates(raw.frozenTaxonomy);
      const goldTypeIds = new Set(
        goldEntries.map(e => e.gold.productType.typeId).filter((id): id is string => !!id),
      );
      // Strict superset proves the pool was not derived from gold labels.
      expect(candidates.productTypes.length).toBeGreaterThan(goldTypeIds.size);
      for (const typeId of goldTypeIds) {
        expect(candidates.productTypes.some(t => t.id === typeId)).toBe(true);
      }
      // Executed predictions select within the frozen pool.
      const executed = loadExecutedQualificationGoldset();
      const checkEntries = executed.entries.flatMap(e => [
        {
          productType: e.baseline.productType,
          fieldAssignments: e.baseline.fieldAssignments,
          pageIds: e.baseline.pageIds,
        },
        {
          productType: e.candidate.productType,
          fieldAssignments: e.candidate.fieldAssignments,
          pageIds: e.candidate.pageIds,
        },
      ]);
      expect(findPredictionsOutsideFrozenTaxonomy(checkEntries, raw.frozenTaxonomy)).toHaveLength(0);

      // Verify gold states are adjudicated and not empty catalog defaults
      for (const e of goldEntries) {
        expect(['known-type', 'no-fit', 'insufficient-evidence', 'unlabeled']).toContain(e.gold.productType.kind);
        if (e.gold.productType.kind === 'known-type') {
          expect(e.gold.productType.typeId).toBeTruthy();
        }
      }
    });
  });

  // ── Criterion 3: Question/Threshold Policies & Qualification Gates ──────────
  describe('Criterion 3: Question/threshold policies and qualification gates', () => {
    it('enforces non-regression floors, source eligibility, and fails closed on failures', () => {
      const metrics: EvalMetrics = {
        productType: {
          top1Accuracy: 0.95,
          macroF1: 0.94,
          confusionPairs: [],
          support: 50,
          coverage: 0.90,
          perClassSupport: { dog_food_dry: 25, cat_treat: 25 },
        },
        calibration: { ece: 0.04, bins: [] },
        safety: {
          crossSpeciesCount: 0,
          crossSpeciesExamples: [],
          claimSafetyViolations: 0,
          controlledValueViolations: 0,
        },
        pairedDelta: {
          primaryMetric: 'productType.top1Accuracy',
          deltaMean: 0.15,
          deltaLower95: 0.08,
          deltaUpper95: 0.22,
          bootstrapRuns: 1000,
        },
        pages: {
          precisionAtK: 0.95,
          recallAtK: 0.95,
          exactSetAccuracy: 0.95,
          blocked: false,
          blockedReason: null,
        },
        fields: { targetAccuracy: {}, targetSupport: {} },
        abstention: { abstainedPercent: 0.10, accuracyOfNonAbstained: 0.95 },
        operations: { correctionsPerHundred: 5 },
      };

      // Fails when sample size is insufficient
      const resSmall = evaluateQualificationGate(metrics, 10, {
        requiredHoldout: 200,
        predictionSource: QUALIFIED_RAW_PREDICTION_SOURCE,
        bundleVersion: 1,
      });
      expect(resSmall.qualified).toBe(false);
      expect(resSmall.reasons.some(r => r.includes('insufficient_sample'))).toBe(true);

      // Fails when service failures occurred (service failure != semantic abstention)
      const resFailures = evaluateQualificationGate(metrics, 250, {
        requiredHoldout: 200,
        predictionSource: QUALIFIED_RAW_PREDICTION_SOURCE,
        bundleVersion: 1,
        failureCount: 2,
      });
      expect(resFailures.qualified).toBe(false);
      expect(resFailures.reasons.some(r => r.includes('prediction_failures'))).toBe(true);

      // Legacy reviewed-outcome source is ineligible for raw accuracy
      const eligibility = assessPredictionSourceEligibility(LEGACY_REVIEWED_OUTCOME_SOURCE, 0);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons[0]).toContain('legacy_reviewed_outcome_ineligible');
    });
  });

  // ── Criterion 4: Baseline vs Jev Offline Comparison Report ──────────────────
  describe('Criterion 4: Baseline vs Jev offline comparison report', () => {
    it('produces stage-isolated and end-to-end outcomes with telemetry and disclaimers', () => {
      // Predictions are captured from the current classification code paths,
      // then scored — the fixture contributes gold + evidence + the frozen
      // taxonomy pool only. Without live credentials the deterministic build
      // records a real baseline floor and a blocked candidate: the report
      // shape stays intact but evidences NO candidate quality (fail-closed).
      const goldset = loadExecutedQualificationGoldset();

      const report = evaluateJevOfflineComparison(goldset);

      expect(report.evaluatedExamples).toBe(16);
      for (const entry of goldset.entries) {
        expect(entry.candidate.failureCode).toBe('jev_credentials_absent');
        expect(entry.baseline.failureCode).toBeNull();
      }
      // Blocked candidate sides count as service failures: the report can
      // never present an unevidenced candidate as qualified.
      expect(report.summary.zeroServiceFailures).toBe(false);
      expect(report.productType.serviceFailures.candidate).toBe(16);

      // Telemetry: measured in-process decision latencies are honest compute
      // timings (frequently 0-2ms offline — never presented as model serving
      // latency), and cost estimates stay present via evaluator defaults.
      for (const side of [report.telemetry.latency.baseline, report.telemetry.latency.candidate]) {
        expect(Number.isFinite(side.meanMs)).toBe(true);
        expect(Number.isFinite(side.p50Ms)).toBe(true);
        expect(Number.isFinite(side.p95Ms)).toBe(true);
        expect(side.p95Ms).toBeGreaterThanOrEqual(side.meanMs);
      }
      expect(report.telemetry.estimatedCostUsd.candidate).toBeGreaterThan(0);

      // Operator time disclaimer must be explicit
      expect(report.telemetry.operatorTimeNote).toContain('do not constitute measured operator-time gains');

      // End-to-end pipeline effects
      expect(report.endToEndPipeline.totalMembers).toBe(16);
    });
  });

  // ── Criterion 5: Bounded Opt-In Live-Provider Contract Check ────────────────
  describe('Criterion 5: Bounded opt-in live-provider contract check', () => {
    it('refuses to pass live check when credentials or explicit flag are missing', () => {
      const assessmentWithoutKey = assessProductionQualification({
        hasTypeSafeApiKey: false,
        liveContractCheckExecuted: false,
        liveContractCheckSuccess: false,
        canaryProductTypeReviewed: false,
        canaryAttributesReviewed: false,
        canaryCohortPagesReviewed: false,
      });

      expect(assessmentWithoutKey.status).toBe('blocked');
      expect(assessmentWithoutKey.checklist.liveCredentialsProvisioned).toBe(false);
      expect(assessmentWithoutKey.checklist.liveContractCheckPassed).toBe(false);
      expect(assessmentWithoutKey.blockers.some(b => b.code === 'missing_typesafe_api_key')).toBe(true);
    });
  });

  // ── Criterion 6: Staged Canaries in Order ───────────────────────────────────
  describe('Criterion 6: Staged canaries in order with final human review', () => {
    it('enforces non-bulk-acceptable proposals and human review across all stages', () => {
      const assessment = assessProductionQualification({
        hasTypeSafeApiKey: true,
        liveContractCheckExecuted: true,
        liveContractCheckSuccess: true,
        canaryProductTypeReviewed: false,
        canaryAttributesReviewed: false,
        canaryCohortPagesReviewed: false,
      });

      // Must remain provisionally qualified / blocked until all 3 canary stages are reviewed
      expect(assessment.status).not.toBe('qualified');
      expect(assessment.blockers.some(b => b.code === 'canary_product_type_unreviewed')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'canary_attributes_unreviewed')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'canary_cohort_pages_unreviewed')).toBe(true);
    });
  });

  // ── Criterion 7: Disabling the Connection & Route Changes ───────────────────
  describe('Criterion 7: Connection disablement and route changes', () => {
    it('stops subsequent dispatch when disabled with zero retry and no implicit fallback', async () => {
      // Disable connection
      upsertProviderConnection({
        id: 'typesafe',
        label: 'TypeSafe Cloud Provider',
        transport: 'systemone',
        baseUrl: 'https://api.typesafe.ai/v1',
        credential: 'live-test-credential-xyz',
        trustZone: 'cloud',
        approvedHost: 'api.typesafe.ai',
        approvedPort: 443,
        enabled: false, // DISABLED
        connectTimeoutMs: 5000,
        inferenceTimeoutMs: 15000,
      });

      let fetchAttempted = false;
      globalThis.fetch = (async () => {
        fetchAttempted = true;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;

      const run = createRun(
        workspaceId,
        'SKU-DIS-01',
        null,
        'hash-snap-dis',
      );

      const policyView = buildModelPolicyView(defaultPolicyConfig);
      const ptTarget = {
        config: { id: 'primary_product_type', label: 'Primary Product Type', kind: 'product_type', attributeId: null, catalogField: 'ProductType', selectionMode: 'single', confidenceThreshold: 0.7 },
        options: [{ value: 'dog_food_dry', label: 'Dry Dog Food' }],
        attribute: null,
      } as unknown as ResolvedTarget;

      // When connection is disabled, resolveProductTypeDecision should fail closed
      await expect(
        resolveProductTypeDecision({
          target: ptTarget,
          evidence: [],
          sku: 'SKU-DIS-01',
          runId: run.id,
          modelPolicy: policyView,
        }),
      ).rejects.toThrow();

      // Zero fetch calls attempted to network
      expect(fetchAttempted).toBe(false);

      // Changing route config in workspace does not rewrite existing in-flight run provenance
      const inFlightRun = getRun(run.id);
      expect(inFlightRun?.configSnapshotHash).toBe('hash-snap-dis');
    });
  });

  // ── Criterion 8: Compatibility Verification ────────────────────────────────
  describe('Criterion 8: Compatibility verification', () => {
    it('preserves other providers, deterministic rules, and legacy artifact reads', () => {
      // 1. Ollama/OpenAI provider support in policy service
      const stages = CLASSIFICATION_POLICY_STAGES;
      for (const st of stages) {
        expect(st.supportedTransports).toContain('ollama-native');
        expect(st.supportedTransports).toContain('openai-compatible');
        expect(st.supportedTransports).toContain('systemone');
      }

      // 2. Legacy reviewed-outcome bundle reading
      const legacyEligibility = assessPredictionSourceEligibility('reviewed_outcome', 0);
      expect(legacyEligibility.eligible).toBe(false);
      expect(legacyEligibility.reasons[0]).toContain('reviewed-outcome artifacts stay readable');

      // 3. Raw prediction eligibility
      const rawEligibility = assessPredictionSourceEligibility('prereview_raw', 1);
      expect(rawEligibility.eligible).toBe(true);
      expect(rawEligibility.reasons).toHaveLength(0);
    });
  });

  // ── Criterion 10: Blocker Reporting for Production Qualification ───────────
  describe('Criterion 10: Blocker reporting for missing production prerequisites', () => {
    it('accurately identifies and reports incomplete qualification status', () => {
      // Without live credentials the deterministic capture records a blocked
      // candidate (never simulated quality), so offline evidence itself is
      // dirty and the assessment is blocked — never provisionally qualified.
      const offlineReport = evaluateJevOfflineComparison(loadExecutedQualificationGoldset());

      const assessment = assessProductionQualification({
        hasTypeSafeApiKey: false,
        liveContractCheckExecuted: false,
        liveContractCheckSuccess: false,
        canaryProductTypeReviewed: false,
        canaryAttributesReviewed: false,
        canaryCohortPagesReviewed: false,
        offlineComparisonReport: offlineReport,
      });

      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.length).toBeGreaterThan(0);
      expect(assessment.blockers.some(b => b.code === 'offline_evaluation_failed')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'service_failures_detected')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'missing_typesafe_api_key')).toBe(true);
      expect(assessment.summary).toContain('Production qualification is blocked');
    });
  });

  // ── Fail-closed qualification gates (assessProductionQualification blocker fix) ──
  describe('Fail-closed production qualification gates', () => {
    const operationalPass = {
      hasTypeSafeApiKey: true,
      liveContractCheckExecuted: true,
      liveContractCheckSuccess: true,
      canaryProductTypeReviewed: true,
      canaryAttributesReviewed: true,
      canaryCohortPagesReviewed: true,
    };

    function loadGoodReport() {
      // Scores predictions executed from the current code paths — the same
      // artifact shape the qualification runner produces.
      return evaluateJevOfflineComparison(loadExecutedQualificationGoldset());
    }

    it('never returns qualified when operational flags pass but verification evidence is absent', () => {
      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: loadGoodReport(),
      });

      expect(assessment.status).not.toBe('qualified');
      expect(assessment.blockers.some(b => b.code === 'family_separation_unverified')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      expect(assessment.blockers.some(b => b.code === 'operator_docs_missing')).toBe(true);
      expect(assessment.checklist.familySeparationPassed).toBe(false);
      expect(assessment.checklist.compatibilityVerified).toBe(false);
      expect(assessment.checklist.operatorDocumentationPublished).toBe(false);
    });

    it('blocks (never provisional) when the comparison report is missing', () => {
      const assessment = assessProductionQualification({ ...operationalPass });

      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.some(b => b.code === 'comparison_report_missing')).toBe(true);
      expect(assessment.checklist.comparisonReportComplete).toBe(false);
      expect(assessment.checklist.offlineEvaluationPassed).toBe(false);
    });

    it('blocks (never provisional) when offline evaluation fails', () => {
      const bad = loadGoodReport();
      bad.summary.candidateOutperformsBaseline = false;

      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: bad,
      });

      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.some(b => b.code === 'offline_evaluation_failed')).toBe(true);
      expect(assessment.checklist.offlineEvaluationPassed).toBe(false);
    });

    it('blocks (never provisional) on candidate service failures', () => {
      const bad = loadGoodReport();
      bad.summary.zeroServiceFailures = false;
      bad.productType.serviceFailures = { baseline: 0, candidate: 1 };

      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: bad,
      });

      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.some(b => b.code === 'service_failures_detected')).toBe(true);
    });

    it('blocks (never provisional) on harmful regressions', () => {
      const bad = loadGoodReport();
      bad.summary.zeroHarmfulRegressionsOnHoldout = false;
      bad.productType.harmfulRegressions = 1;

      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: bad,
      });

      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.some(b => b.code === 'harmful_regressions_detected')).toBe(true);
    });
  });

  // ── Evidence-driven qualification gates (family, compatibility, docs) ─────
  describe('Evidence-driven qualification gates', () => {
    const operationalPass = {
      hasTypeSafeApiKey: true,
      liveContractCheckExecuted: true,
      liveContractCheckSuccess: true,
      canaryProductTypeReviewed: true,
      canaryAttributesReviewed: true,
      canaryCohortPagesReviewed: true,
    };

    function loadGoldEntries(): QualificationGoldOnlyEntry[] {
      const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
      return parseQualificationGoldOnly(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    }

    function buildValidEvidence() {
      const familySeparationProof = verifyFamilySeparation(loadGoldEntries());
      const compatibilityReceipt = {
        suites: REQUIRED_COMPATIBILITY_SUITE_IDS.map(suiteId => ({
          suiteId,
          commit: 'evidence-commit-abc1234',
          passed: true as const,
          executedAt: null,
        })),
        recordedAt: new Date().toISOString(),
      };
      const runbookPath = path.resolve(import.meta.dir, '../../../docs/runbooks/typesafe-jev-curation-rollout.md');
      const operatorDocsReceipt = {
        runbookPath: OPERATOR_RUNBOOK_PATH,
        contentHash: createHash('sha256').update(fs.readFileSync(runbookPath)).digest('hex'),
        publishedAt: null,
      };
      return { familySeparationProof, compatibilityReceipt, operatorDocsReceipt };
    }

    it('returns qualified when offline evidence is clean and all receipts are valid', () => {
      // Gate-wiring premise: explicitly clean offline evidence (the executed
      // candidate quality itself is owned by the predictor workstream; this
      // test proves the gates clear on clean evidence + valid receipts).
      const report = evaluateJevOfflineComparison(loadExecutedQualificationGoldset());
      report.summary.candidateOutperformsBaseline = true;
      report.summary.zeroHarmfulRegressionsOnHoldout = true;
      report.summary.zeroServiceFailures = true;
      report.productType.harmfulRegressions = 0;
      report.attributes.harmfulRegressions = 0;
      report.categoryPages.harmfulRegressions = 0;
      report.productType.serviceFailures = { baseline: 0, candidate: 0 };
      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: report,
        ...buildValidEvidence(),
      });

      expect(assessment.status).toBe('qualified');
      expect(assessment.blockers).toHaveLength(0);
      expect(assessment.checklist.offlineEvaluationPassed).toBe(true);
      expect(assessment.checklist.comparisonReportComplete).toBe(true);
      expect(assessment.checklist.familySeparationPassed).toBe(true);
      expect(assessment.checklist.compatibilityVerified).toBe(true);
      expect(assessment.checklist.operatorDocumentationPublished).toBe(true);
    });

    it('keeps the family blocker on a failing proof and passes the other receipt gates', () => {
      const evidence = buildValidEvidence();
      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        familySeparationProof: { ...evidence.familySeparationProof, passed: false },
      });

      expect(assessment.status).not.toBe('qualified');
      expect(assessment.blockers.some(b => b.code === 'family_separation_unverified')).toBe(true);
      expect(assessment.checklist.familySeparationPassed).toBe(false);
      expect(assessment.checklist.compatibilityVerified).toBe(true);
      expect(assessment.checklist.operatorDocumentationPublished).toBe(true);
    });

    it('keeps the compatibility blocker when a required suite is missing or failing', () => {
      const evidence = buildValidEvidence();
      const missing = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        compatibilityReceipt: {
          ...evidence.compatibilityReceipt,
          suites: evidence.compatibilityReceipt.suites.slice(0, 3),
        },
      });
      expect(missing.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      expect(missing.checklist.compatibilityVerified).toBe(false);

      const failing = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        compatibilityReceipt: {
          ...evidence.compatibilityReceipt,
          suites: evidence.compatibilityReceipt.suites.map(suite =>
            suite.suiteId === 'deterministic-rules' ? { ...suite, passed: false as const } : suite,
          ),
        },
      });
      expect(failing.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      expect(failing.checklist.compatibilityVerified).toBe(false);
    });

    it('keeps the operator-docs blocker on a wrong path or malformed hash', () => {
      const evidence = buildValidEvidence();
      const wrongPath = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        operatorDocsReceipt: { ...evidence.operatorDocsReceipt, runbookPath: 'docs/runbooks/other.md' },
      });
      expect(wrongPath.blockers.some(b => b.code === 'operator_docs_missing')).toBe(true);
      expect(wrongPath.checklist.operatorDocumentationPublished).toBe(false);

      const badHash = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        operatorDocsReceipt: { ...evidence.operatorDocsReceipt, contentHash: 'not-a-hash' },
      });
      expect(badHash.blockers.some(b => b.code === 'operator_docs_missing')).toBe(true);
      expect(badHash.checklist.operatorDocumentationPublished).toBe(false);
    });

    it('detects true leakage: shared identity and near-duplicates fail verification', () => {
      const entries = loadGoldEntries();
      const straddling = entries.map(e =>
        e.sku === 'QUAL-DOG-KIBBLE-03' ? { ...e, split: 'holdout' as const } : e,
      );
      const leaked = verifyFamilySeparation(straddling);
      expect(leaked.passed).toBe(false);
      expect(leaked.leakedFamilies.some(f => f.familyId === 'fam-acme-kibble')).toBe(true);

      const catTreat = entries.find(e => e.sku === 'QUAL-CAT-TREAT-01');
      expect(catTreat).toBeTruthy();
      const duplicated = [
        ...entries,
        {
          ...catTreat!,
          sku: 'QUAL-CAT-TREAT-COPY-01',
          familyId: 'fam-beacon-treats-copy',
          split: 'holdout' as const,
        },
      ];
      const nearDup = verifyFamilySeparation(duplicated);
      expect(nearDup.passed).toBe(false);
      expect(nearDup.nearDuplicatePairs.length).toBeGreaterThan(0);
    });
  });

  // ── Honest captured qualification predictions (Issue #293 blocker fix) ─────
  describe('Honest captured qualification predictions', () => {
    function loadGoldFixture(): { entries: QualificationGoldOnlyEntry[]; frozenTaxonomy: unknown } {
      const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
      const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      return { entries: parseQualificationGoldOnly(raw), frozenTaxonomy: raw.frozenTaxonomy ?? null };
    }

    function loadGoldEntries(): QualificationGoldOnlyEntry[] {
      return loadGoldFixture().entries;
    }

    /** Tiny synthetic gold set (detector-safe) for live-capture shape tests. */
    function tinyQualificationEntries(): QualificationGoldOnlyEntry[] {
      return [
        {
          sku: 'TINY-DOG-01',
          familyId: 'fam-tiny',
          split: 'dev',
          assortment: 'food',
          gold: {
            productType: { kind: 'known-type', typeId: 'dog_food_dry' },
            fieldAssignments: [
              { targetId: 'flavor', value: 'Chicken', state: 'known' },
              { targetId: 'animal_type', values: ['dog'], state: 'known' },
            ],
            categoryPages: {
              pageIds: ['page-dry-dog-food'],
              pageAssignments: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
            },
          },
          evidence: [
            { source: 'official_page', snippet: 'Acme Chicken Dry Dog Food for adult dogs', reliability: 'high', attributeId: null },
          ],
        },
        {
          sku: 'TINY-UNKNOWN-01',
          familyId: 'fam-tiny-unknown',
          split: 'dev',
          assortment: 'food',
          gold: {
            productType: { kind: 'known-type', typeId: 'cat_treat' },
            fieldAssignments: [
              { targetId: 'flavor', value: 'Beef', state: 'known' },
            ],
            categoryPages: {
              pageIds: ['page-dry-dog-food'],
              pageAssignments: [],
            },
          },
          evidence: [
            { source: 'official_page', snippet: 'Mystery kibble bits for small pets', reliability: 'low', attributeId: null },
          ],
        },
      ];
    }

    function tinyQualificationTaxonomies(): QualificationTaxonomies {
      return {
        productTypes: [
          { id: 'dog_food_dry', label: 'Dry Dog Food' },
          { id: 'cat_treat', label: 'Cat Treat' },
        ],
        attributeTargets: [
          { targetId: 'flavor', cardinality: 'single', options: ['Chicken', 'Beef'] },
          { targetId: 'animal_type', cardinality: 'multiple', options: ['dog', 'cat'] },
        ],
        pages: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
      };
    }

    it('produces deterministic immutable artifacts from gold + evidence', () => {
      const { entries, frozenTaxonomy } = loadGoldFixture();
      const first = buildQualificationPredictionsFromCode(entries, frozenTaxonomy as never);
      const second = buildQualificationPredictionsFromCode(entries, frozenTaxonomy as never);

      expect(first.predictorVersion).toBe(QUALIFICATION_PREDICTOR_VERSION);
      expect(first.entryCount).toBe(entries.length);
      expect(first.captureMode).toBe('deterministic_floor');
      expect(first.taxonomySource).toBe('frozen_snapshot');
      expect(first.frozenTaxonomyHash).toBe((frozenTaxonomy as { snapshotHash: string }).snapshotHash);
      expect(first.artifactHash).toBe(second.artifactHash);
      expect(first.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      for (const p of first.predictions) {
        expect(typeof p.baseline.abstained).toBe('boolean');
        expect(typeof p.candidate.abstained).toBe('boolean');
      }

      // Legacy gold-union fallback stays available and is labeled as such.
      const fallback = buildQualificationPredictionsFromCode(entries);
      expect(fallback.taxonomySource).toBe('gold_union');
      expect(fallback.frozenTaxonomyHash).toBeNull();
      expect(fallback.artifactHash).toBe(buildQualificationPredictionsFromCode(entries).artifactHash);

      // A present-but-malformed taxonomy input fails closed (never a silent substitution).
      expect(() => buildQualificationPredictionsFromCode(entries, { bogus: true } as never)).toThrow();
    });

    it('ignores legacy stored predictions: mutating them cannot change the report', () => {
      const { entries, frozenTaxonomy } = loadGoldFixture();
      const baseline = buildQualificationPredictionsFromCode(entries, frozenTaxonomy as never);
      // Simulate a legacy fixture copy that still embeds authored answers:
      // the loader must strip them and the executed artifact must be identical.
      const legacyCopy = JSON.parse(JSON.stringify(entries)) as Array<Record<string, unknown>>;
      for (const e of legacyCopy) {
        e.baseline = { productType: 'dog_toy', abstained: false, fieldAssignments: [], pageIds: [], confidence: 0.99 };
        e.candidate = { productType: 'dog_toy', abstained: false, fieldAssignments: [], pageIds: [], confidence: 0.99 };
      }
      const reparsed = parseQualificationGoldOnly({ entries: legacyCopy });
      const fromLegacy = buildQualificationPredictionsFromCode(reparsed, frozenTaxonomy as never);
      expect(fromLegacy.artifactHash).toBe(baseline.artifactHash);
    });

    it('records a blocked candidate without credentials: never simulated into a passing number', () => {
      const { entries, frozenTaxonomy } = loadGoldFixture();
      const artifact = buildQualificationPredictionsFromCode(entries, frozenTaxonomy as never);

      expect(artifact.captureMode).toBe('deterministic_floor');
      for (const p of artifact.predictions) {
        expect(p.baseline.source).toBe(QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR);
        expect(p.baseline.failureCode).toBeNull();
        expect(p.candidate.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(p.candidate.blockedCode).toBe(QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT);
        expect(p.candidate.failureCode).toBe(QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT);
        expect(p.candidate.abstained).toBe(true);
        expect(p.candidate.productType).toBeNull();
        expect(p.candidate.requestedModel).toBeNull();
        expect(p.candidate.resolvedModel).toBeNull();
        expect(p.candidate.usage).toBeNull();
      }

      // The evaluator counts blocked candidate sides as service failures, so
      // the deterministic report fails closed and evidences no candidate quality.
      const report = evaluateJevOfflineComparison(loadExecutedQualificationGoldset());
      expect(report.summary.zeroServiceFailures).toBe(false);
      expect(report.productType.serviceFailures.candidate).toBe(entries.length);

      const assessment = assessProductionQualification({
        hasTypeSafeApiKey: false,
        liveContractCheckExecuted: false,
        liveContractCheckSuccess: false,
        canaryProductTypeReviewed: false,
        canaryAttributesReviewed: false,
        canaryCohortPagesReviewed: false,
        offlineComparisonReport: report,
      });
      expect(assessment.status).toBe('blocked');
      expect(assessment.blockers.some(b => b.code === 'service_failures_detected')).toBe(true);
    });

    it('builds shipped Jev questions covering the frozen pool (wiring/shape, no network)', () => {
      const { entries, frozenTaxonomy } = loadGoldFixture();
      const taxa = qualificationTaxonomiesFromFrozenSnapshot(frozenTaxonomy as never);
      const entry = entries[0];
      const set = buildQualificationCandidateQuestionSet(entry, taxa);

      // Product-type Choice covers every frozen option plus both abstentions.
      const typeKeys = Object.keys(set.productTypePlan.criteria);
      for (const t of taxa.productTypes) {
        expect(set.productTypePlan.keyToIdMap.get(set.productTypePlan.idToKeyMap.get(t.id)!)).toBe(t.id);
      }
      expect(typeKeys).toContain('no_match');
      expect(typeKeys).toContain('insufficient_evidence');

      // Attribute plans exist exactly for gold-adjudicated targets.
      const goldTargets = new Set((entry.gold.fieldAssignments ?? []).map(f => f.targetId));
      expect(new Set(set.attributePlans.map(p => p.targetId))).toEqual(goldTargets);
      for (const plan of set.attributePlans) {
        if (plan.cardinality === 'multiple') {
          expect(plan.noulPlans?.length).toBe(plan.resolved.options.length);
        } else {
          expect(Object.keys(plan.choicePlan!.criteria).length).toBeGreaterThanOrEqual(plan.resolved.options.length);
        }
      }

      // Page Choice covers every frozen page plus both abstentions.
      expect(set.pagePlan).not.toBeNull();
      const pageKeys = Object.keys(set.pagePlan!.criteria);
      for (const p of taxa.pages) {
        expect(set.pagePlan!.keyToIdMap.get(set.pagePlan!.idToKeyMap.get(p.pageId)!)).toBe(p.pageId);
      }
      expect(pageKeys).toContain('abstain_no_match');
      expect(pageKeys).toContain('abstain_insufficient_evidence');
    });

    /**
     * Mocked SystemOne transport answering from the request bodies (complete
     * distributions over every criteria key, argmax == choice — the shape the
     * real validator requires). Mocked HTTP is transport-shape only: the
     * builders, extraction, mapping, floors, and selection policy under test
     * are the shipped ones.
     */
    function mockJevFetchBehavior(behavior: { choiceProb: number; noulProb: number }): { mock: typeof fetch; calls: () => number } {
      let calls = 0;
      const mock = (async (_url: unknown, init: { body: string }) => {
        calls += 1;
        const body = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> };
        const answers: Record<string, unknown> = {};
        for (const [qid, q] of Object.entries(body.questions)) {
          if (q.type === 'choice') {
            const keys = Object.keys(q.criteria ?? {});
            const top = keys[0];
            // Valid-but-below-floor: the winner stays the argmax (pigeonhole
            // forces 3-option winners above 1/3 — still under every 0.50
            // shipped floor), so the transport accepts and the floors abstain.
            let topProb = behavior.choiceProb;
            let rest = (1 - topProb) / Math.max(1, keys.length - 1);
            if (rest >= topProb) {
              topProb = Math.min(0.49, rest + 0.01);
              rest = (1 - topProb) / Math.max(1, keys.length - 1);
            }
            const probabilities: Record<string, number> = {};
            for (const k of keys) probabilities[k] = k === top ? topProb : rest;
            answers[qid] = { type: 'choice', choice: top, probabilities, confidence: 0.9 };
          } else {
            answers[qid] = { type: 'noul', noul: behavior.noulProb };
          }
        }
        return new Response(
          JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 10 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      return { mock, calls: () => calls };
    }

    it('captures live Jev judgments through the shipped transport + floors (mocked HTTP, no real network)', async () => {
      const { mock, calls } = mockJevFetchBehavior({ choiceProb: 0.85, noulProb: 0.95 });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = mock;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          { jev: { apiKey: 'test-key-12345678' } },
          tinyQualificationTaxonomies(),
        );
        expect(calls()).toBeGreaterThan(0);
        expect(artifact.captureMode).toBe('live_captured');
        expect(artifact.entryCount).toBe(2);
        const first = artifact.predictions.find(p => p.sku === 'TINY-DOG-01')!;
        expect(first.candidate.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(first.candidate.productType).toBe('dog_food_dry');
        expect(first.candidate.abstained).toBe(false);
        expect(first.candidate.confidence).toBeCloseTo(0.85, 4);
        expect(first.candidate.fieldAssignments).toEqual([
          { targetId: 'animal_type', values: ['dog', 'cat'] },
          { targetId: 'flavor', value: 'Chicken' },
        ]);
        expect(first.candidate.pageIds).toEqual(['page-dry-dog-food']);
        expect(first.candidate.requestedModel).toBe('jev-1.13.0');
        expect(first.candidate.resolvedModel).toBe('jev-1.13.0');
        expect(first.candidate.provider).toBe('typesafe');
        expect(first.candidate.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
        expect(first.candidate.failureCode).toBeNull();
        // The baseline without an opted-in route stays the deterministic floor.
        expect(first.baseline.source).toBe(QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR);
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('records live floors as abstentions, not failures (mocked HTTP)', async () => {
      const { mock } = mockJevFetchBehavior({ choiceProb: 0.3, noulProb: 0.1 });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = mock;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          { jev: { apiKey: 'test-key-12345678' } },
          tinyQualificationTaxonomies(),
        );
        const first = artifact.predictions.find(p => p.sku === 'TINY-DOG-01')!;
        // The live path executed (model spoke: resolvedModel present) and its
        // outcome — below every shipped floor — is an honest abstention.
        expect(first.candidate.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(first.candidate.abstained).toBe(true);
        expect(first.candidate.productType).toBeNull();
        expect(first.candidate.fieldAssignments).toEqual([]);
        expect(first.candidate.pageIds).toEqual([]);
        expect(first.candidate.confidence).toBe(0);
        expect(first.candidate.failureCode).toBeNull();
        expect(first.candidate.resolvedModel).toBe('jev-1.13.0');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('blocks the baseline chat leg without provider credentials and never touches the network', async () => {
      let fetchCalls = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error('network must not be used without credentials');
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          { baselineRoute: { provider: 'ollama', model: 'qual-test-model' } },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(0);
        expect(artifact.captureMode).toBe('live_captured');
        // The evidence-void entry needs the chat leg and has no credentials:
        // blocked with a coded reason. Fully matcher-resolved entries (if
        // any) stay the deterministic floor — never a mixed guess.
        const unknown = artifact.predictions.find(p => p.sku === 'TINY-UNKNOWN-01')!;
        expect(unknown.baseline.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(unknown.baseline.blockedCode).toBe(QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT);
        expect(unknown.baseline.failureCode).toBe(QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT);
        for (const p of artifact.predictions) {
          const allowed: Array<string | undefined> = [
            QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR,
            QUALIFICATION_SOURCE_BLOCKED,
          ];
          expect(allowed).toContain(p.baseline.source);
          if (p.baseline.source === QUALIFICATION_SOURCE_BLOCKED) {
            expect(p.baseline.blockedCode).toBe(QUALIFICATION_BLOCKED_BASELINE_CREDENTIALS_ABSENT);
          }
          expect(p.candidate.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
          expect(p.candidate.blockedCode).toBe(QUALIFICATION_BLOCKED_JEV_CREDENTIALS_ABSENT);
        }
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('executes the incumbent ranker path when credentials exist and records its real outcome (mocked HTTP, zero transport)', async () => {
      // Dummy local credential (detector-safe): proves the existing-store
      // resolution, not a real model account.
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      let fetchCalls = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error('incumbent ranker must not transport without run-bound audit provenance');
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          { baselineRoute: { provider: 'ollama', model: 'qual-ollama-model' } },
          tinyQualificationTaxonomies(),
        );
        // The ranker fail-closes before transport without run-bound audit
        // provenance (its own design — qualification never fabricates runs),
        // so no HTTP happens; the capture records the executed path outcome.
        expect(fetchCalls).toBe(0);
        const unknown = artifact.predictions.find(p => p.sku === 'TINY-UNKNOWN-01')!;
        expect(unknown.baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(unknown.baseline.abstained).toBe(true);
        expect(unknown.baseline.productType).toBeNull();
        expect(unknown.baseline.requestedModel).toBe('qual-ollama-model');
        expect(unknown.baseline.provider).toBe('ollama');
        // resolvedModel null is the reading rule: no model judgment spoke —
        // an abstention recorded from the executed incumbent path.
        expect(unknown.baseline.resolvedModel).toBeNull();
        expect(unknown.baseline.usage).toBeNull();
        expect(unknown.baseline.failureCode).toBeNull();
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    const liveJevKey = process.env.TYPESAFE_API_KEY ?? '';
    const itLive = liveJevKey.length >= 8 ? it : it.skip;
    itLive('captures live Jev judgments against frozen gold evidence (opt-in keyed live capture, real network)', async () => {
      const artifact = await captureQualificationPredictionsLive(
        tinyQualificationEntries().slice(0, 1),
        { jev: { apiKey: liveJevKey, timeoutMs: 30_000 } },
        tinyQualificationTaxonomies(),
      );
      expect(artifact.captureMode).toBe('live_captured');
      const first = artifact.predictions[0].candidate;
      expect(first.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
      expect(first.requestedModel).toBeTruthy();
      expect(first.resolvedModel).toBeTruthy();
      expect(first.usage).not.toBeNull();
    }, 90_000);

    it('live contract check succeeds against a mocked transport and refuses without a key (no network)', async () => {
      const fetchBefore = globalThis.fetch;
      try {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              model: 'jev-1.13.0',
              answers: {
                mentions_dog_food: { type: 'noul', noul: 0.9 },
                topic: {
                  type: 'choice',
                  choice: 'pet_food',
                  probabilities: { pet_food: 0.9, shipping: 0.1 },
                  confidence: 0.85,
                },
                primary_product_type: {
                  type: 'choice',
                  choice: 'opt_0',
                  probabilities: { opt_0: 0.85, opt_1: 0.05, no_match: 0.05, insufficient_evidence: 0.05 },
                  confidence: 0.8,
                },
              },
              usage: { input_tokens: 120, output_tokens: 30 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )) as unknown as typeof fetch;

        const ok = await runLiveContractCheck({ apiKey: 'test-key-12345678' });
        expect(ok.ok).toBe(true);
        if (ok.ok) {
          expect(ok.returnedModel).toBe('jev-1.13.0');
          expect(ok.calls).toBe(1);
        }
      } finally {
        globalThis.fetch = fetchBefore;
      }

      const refused = await runLiveContractCheck({ apiKey: '' });
      expect(refused.ok).toBe(false);
    });

    it('runner --json scores executed predictions and wires receipts (no network)', () => {
      const runnerPath = path.resolve(import.meta.dir, '../../../scripts/typesafe-curation-qualification.ts');
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) cleanEnv[k] = v;
      }
      cleanEnv.TYPESAFE_API_KEY = '';
      cleanEnv.TYPESAFE_LIVE_CHECK = '0';
      delete cleanEnv.TYPESAFE_CANARY_RECEIPTS_PATH;
      delete cleanEnv.TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED;
      delete cleanEnv.TYPESAFE_CANARY_ATTRIBUTES_REVIEWED;
      delete cleanEnv.TYPESAFE_CANARY_COHORT_PAGES_REVIEWED;

      const proc = Bun.spawnSync(['bun', runnerPath, '--json'], {
        env: cleanEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(proc.exitCode).toBe(0);
      const out = JSON.parse(proc.stdout.toString()) as {
        comparisonReport: { evaluatedExamples: number };
        assessment: { status: string };
        predictionArtifact: { artifactHash: string };
        predictionProvenance: {
          predictorVersion: string;
          captureMode: string;
          taxonomySource: string;
          sources: { baseline: Record<string, number>; candidate: Record<string, number> };
        };
        liveCheck: { requested: boolean; executed: boolean; success: boolean };
        canary: { productTypeReviewed: boolean; attributesReviewed: boolean; cohortPagesReviewed: boolean };
      };
      const fixtureRaw = JSON.parse(fs.readFileSync(
        path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json'),
        'utf8',
      )) as { frozenTaxonomy: unknown };
      const local = buildQualificationPredictionsFromCode(loadGoldEntries(), fixtureRaw.frozenTaxonomy as never);
      expect(out.predictionProvenance.predictorVersion).toBe(QUALIFICATION_PREDICTOR_VERSION);
      expect(out.predictionProvenance.captureMode).toBe('deterministic_floor');
      expect(out.predictionProvenance.taxonomySource).toBe('frozen_snapshot');
      expect(out.predictionProvenance.sources.baseline).toEqual({ deterministic_floor: 16 });
      expect(out.predictionProvenance.sources.candidate).toEqual({ blocked: 16 });
      expect(out.predictionArtifact.artifactHash).toBe(local.artifactHash);
      expect(out.comparisonReport.evaluatedExamples).toBe(16);
      // Deterministic-only evidence cannot qualify candidate quality.
      expect(out.assessment.status).toBe('blocked');
      expect(out.liveCheck.executed).toBe(false);
      expect(out.liveCheck.success).toBe(false);
      expect(out.canary.productTypeReviewed).toBe(false);

      // Explicit canary receipts flow into the assessment instead of literals.
      const withCanary = Bun.spawnSync(['bun', runnerPath, '--json'], {
        env: {
          ...cleanEnv,
          TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED: '1',
          TYPESAFE_CANARY_ATTRIBUTES_REVIEWED: '1',
          TYPESAFE_CANARY_COHORT_PAGES_REVIEWED: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(withCanary.exitCode).toBe(0);
      const canaryOut = JSON.parse(withCanary.stdout.toString()) as typeof out;
      expect(canaryOut.canary.productTypeReviewed).toBe(true);
      expect(canaryOut.canary.attributesReviewed).toBe(true);
      expect(canaryOut.canary.cohortPagesReviewed).toBe(true);
    });
  });
});
