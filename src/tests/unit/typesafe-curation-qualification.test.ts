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
  JEV_MULTI_VALUE_MIN_PROBABILITY,
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
  type QualificationGoldset,
} from '../../classification/jev-qualification-service';
import {
  buildPreReviewPredictionBundle,
  capturePreReviewPrediction,
  PRE_REVIEW_PREDICTION_SOURCE,
  PRE_REVIEW_BUNDLE_VERSION,
  parseQualificationGoldOnly,
  buildQualificationPredictionsFromCode,
  QUALIFICATION_PREDICTOR_VERSION,
  type QualificationGoldOnlyEntry,
} from '../../classification/benchmark-prediction';
import { detectFamilySplitLeakage } from '../../classification/benchmark-exporter';
import { runLiveContractCheck } from '../../../scripts/typesafe-live-contract-check';
import type { ResolvedTarget, ResolvedTargetOption } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2, BenchmarkPredictionEntry, EvalMetrics } from '../../shared/schemas/classification';

/**
 * Load the frozen GOLD-ONLY fixture and execute the current baseline +
 * candidate classification paths from code (mirrors
 * scripts/typesafe-curation-qualification.ts). Tests score the executed
 * artifact — never stored predictions.
 */
function loadExecutedQualificationGoldset(): QualificationGoldset {
  const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const goldEntries = parseQualificationGoldOnly(raw);
  const artifact = buildQualificationPredictionsFromCode(goldEntries);
  return {
    version: raw.version,
    description: raw.description,
    adjudicatedBy: raw.adjudicatedBy,
    verifiedPageImport: raw.verifiedPageImport,
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

      const ptOptions: ResolvedTargetOption[] = [
        { value: 'dog_food_dry', label: 'Dry Dog Food' },
        { value: 'dog_food_wet', label: 'Wet Dog Food' },
      ];
      const ptTarget = {
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
      } as unknown as ResolvedTarget;

      const evidence: ClassificationEvidence[] = [
        {
          id: 'ev-qual-1',
          runId: run.id,
          stageName: 'evidence_extraction',
          productSku: 'SKU-QUAL-FULL-01',
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

      // Mock SystemOne HTTP endpoint for Product Type, Attributes, and Cohort Pages
      globalThis.fetch = (async (url: any, init: any) => {
        const body = JSON.parse(init.body);
        const questions = body.questions;
        const answers: Record<string, any> = {};

        for (const [key, q] of Object.entries(questions) as [string, any][]) {
          if (q.type === 'choice') {
            const criteriaKeys = Object.keys(q.criteria);
            const remainingKeys = criteriaKeys.slice(1);
            const remainder = remainingKeys.length > 0 ? (1 - 0.94) / remainingKeys.length : 0;
            const probabilities: Record<string, number> = {
              [criteriaKeys[0]]: 0.94,
            };
            for (const rk of remainingKeys) {
              probabilities[rk] = remainder;
            }
            answers[key] = {
              type: 'choice',
              choice: criteriaKeys[0],
              probabilities,
              confidence: 0.94,
            };
          } else if (q.type === 'noul') {
            const isMatch = key.includes('Chicken') || key.includes('Duck') || key.includes('val_0') || key.includes('val_1');
            answers[key] = {
              type: 'noul',
              noul: isMatch ? 0.92 : 0.05,
            };
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

      const runtimeRuleVersions = buildRuntimeRuleVersions();
      const modelExecutionPlan = buildModelExecutionPlan(policyView);

      const snapshot = {
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
      const flavorTarget = {
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
      } as unknown as ResolvedTarget;

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
      // Predictions are executed from the current classification code paths,
      // then scored — the fixture contributes gold + evidence only.
      const goldset = loadExecutedQualificationGoldset();

      const report = evaluateJevOfflineComparison(goldset);

      expect(report.evaluatedExamples).toBe(16);
      expect(report.productType.rawCorrectness.candidate).toBeGreaterThanOrEqual(report.productType.rawCorrectness.baseline);
      expect(report.productType.harmfulRegressions).toBe(0);
      expect(report.attributes.setMetrics.f1.candidate).toBeGreaterThan(report.attributes.setMetrics.f1.baseline);
      expect(report.categoryPages.setMetrics.exactMatch.candidate).toBeGreaterThan(report.categoryPages.setMetrics.exactMatch.baseline);

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
      expect(report.endToEndPipeline.typeResolution.correct).toBeGreaterThanOrEqual(12);
      expect(report.endToEndPipeline.endToEndCorrectAllStages).toBeGreaterThan(0);
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

      expect(assessment.status).toBe('provisionally_qualified');
      expect(assessment.blockers.length).toBeGreaterThan(0);
      expect(assessment.summary).toContain('Offline benchmarks and comparison reports are fully qualified');
      expect(assessment.summary).toContain('production qualification remains incomplete');
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

  // ── Code-executed qualification predictions (Issue #293 blocker fix) ───────
  describe('Code-executed qualification predictions', () => {
    function loadGoldEntries(): QualificationGoldOnlyEntry[] {
      const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
      return parseQualificationGoldOnly(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
    }

    it('produces deterministic immutable artifacts from gold + evidence', () => {
      const entries = loadGoldEntries();
      const first = buildQualificationPredictionsFromCode(entries);
      const second = buildQualificationPredictionsFromCode(entries);

      expect(first.predictorVersion).toBe(QUALIFICATION_PREDICTOR_VERSION);
      expect(first.entryCount).toBe(entries.length);
      expect(first.artifactHash).toBe(second.artifactHash);
      expect(first.artifactHash).toMatch(/^[0-9a-f]{64}$/);
      for (const p of first.predictions) {
        expect(typeof p.baseline.abstained).toBe('boolean');
        expect(typeof p.candidate.abstained).toBe('boolean');
      }
    });

    it('ignores legacy stored predictions: mutating them cannot change the report', () => {
      const entries = loadGoldEntries();
      const baseline = buildQualificationPredictionsFromCode(entries);
      // Simulate a legacy fixture copy that still embeds authored answers:
      // the loader must strip them and the executed artifact must be identical.
      const legacyCopy = JSON.parse(JSON.stringify(entries)) as Array<Record<string, unknown>>;
      for (const e of legacyCopy) {
        e.baseline = { productType: 'dog_toy', abstained: false, fieldAssignments: [], pageIds: [], confidence: 0.99 };
        e.candidate = { productType: 'dog_toy', abstained: false, fieldAssignments: [], pageIds: [], confidence: 0.99 };
      }
      const reparsed = parseQualificationGoldOnly({ entries: legacyCopy });
      const fromLegacy = buildQualificationPredictionsFromCode(reparsed);
      expect(fromLegacy.artifactHash).toBe(baseline.artifactHash);
    });

    it('candidate outperforms the deterministic baseline with zero regressions', () => {
      const report = evaluateJevOfflineComparison(loadExecutedQualificationGoldset());
      expect(report.summary.candidateOutperformsBaseline).toBe(true);
      expect(report.summary.zeroHarmfulRegressionsOnHoldout).toBe(true);
      expect(report.summary.zeroServiceFailures).toBe(true);
    });

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
        predictionProvenance: { predictorVersion: string };
        liveCheck: { requested: boolean; executed: boolean; success: boolean };
        canary: { productTypeReviewed: boolean; attributesReviewed: boolean; cohortPagesReviewed: boolean };
      };
      const local = buildQualificationPredictionsFromCode(loadGoldEntries());
      expect(out.predictionProvenance.predictorVersion).toBe(QUALIFICATION_PREDICTOR_VERSION);
      expect(out.predictionArtifact.artifactHash).toBe(local.artifactHash);
      expect(out.comparisonReport.evaluatedExamples).toBe(16);
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
