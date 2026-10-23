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
  evaluateJevOfflineComparison,
  assessProductionQualification,
  evaluateJevQualificationGate,
  evaluationStatusText,
  measuredPercent,
  REQUIRED_COMPATIBILITY_SUITE_IDS,
  OPERATOR_RUNBOOK_PATH,
  type QualificationGoldset,
  type QualificationGoldEntry,
} from '../../classification/jev-qualification-service';
import {
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
  QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
  QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED,
  QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
  QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE,
  QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_REASON,
  blockedQualificationPrediction,
  type QualificationGoldOnlyEntry,
  type QualificationTaxonomies,
} from '../../classification/benchmark-prediction';
import {
  detectFamilySplitLeakage,
  detectFamilyDevHoldoutStraddle,
  verifyFamilySeparation,
  buildFrozenTaxonomyCandidates,
  findGoldOutsideFrozenTaxonomy,
  FAMILY_SEPARATION_PROOF_VERSION,
} from '../../classification/benchmark-exporter';
import {
  findPredictionsOutsideFrozenTaxonomy,
  verifyFrozenTaxonomySnapshotShape,
} from '../../classification/benchmark-evaluator';
import { runLiveContractCheck } from '../../../scripts/typesafe-live-contract-check';
import { upsertApiKey } from '../../db/repositories/api-key-repo';
import { createDevAttemptGuard } from '../../classification/jev-benchmark-replay';
import { captureGuardedJevForTest } from '../helpers/qualification-capture';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { ClassificationEvidence, ModelPolicyConfigV2, EvalMetrics } from '../../shared/schemas/classification';

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

      // 6. Review & correction by operator. The pre-review capture reads the
      // immutable canonical pair (`product_classification` carrying the full
      // {categoryId, productTypeId} pair) — never reviewer decisions, never
      // a bare legacy `primary_product_type` string.
      getDb().run(
        `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES ('prop-qual-1', ?, 'SKU-QUAL-FULL-01', 'product_classification', 'dog_food_dry', ?, 0.94, 'pending', ?)`,
        [run.id, JSON.stringify({ categoryId: 'dog_food', productTypeId: 'dog_food_dry', matchedWords: [] }), new Date().toISOString()],
      );

      getDb().run(
        `INSERT INTO classification_proposal_decisions (
           id, proposal_id, decision, reviewer_id, revised_value_json, created_at
         ) VALUES (?, ?, 'accepted', 'store-manager', ?, ?)`,
        ['dec-1', 'prop-qual-1', JSON.stringify({ categoryId: 'dog_food', productTypeId: 'dog_food_dry', matchedWords: [] }), new Date().toISOString()],
      );

      const decisionRow = getDb().query(
        `SELECT * FROM classification_proposal_decisions WHERE id = ?`,
      ).get('dec-1') as any;
      expect(decisionRow.decision).toBe('accepted');
      expect(JSON.parse(decisionRow.revised_value_json)).toEqual({ categoryId: 'dog_food', productTypeId: 'dog_food_dry', matchedWords: [] });

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
      // latency). Missing pricing stays unknown; no synthetic defaults.
      for (const side of [report.telemetry.latency.baseline, report.telemetry.latency.candidate]) {
        expect(Number.isFinite(side.meanMs)).toBe(true);
        expect(Number.isFinite(side.p50Ms)).toBe(true);
        expect(Number.isFinite(side.p95Ms)).toBe(true);
        expect(side.p95Ms!).toBeGreaterThanOrEqual(side.meanMs!);
      }
      expect(report.telemetry.estimatedCostUsd.candidate).toBeNull();

      // Operator time disclaimer must be explicit
      expect(report.telemetry.operatorTimeNote).toContain('do not constitute measured operator-time gains');

      // End-to-end pipeline effects
      expect(report.endToEndPipeline.totalMembers).toBe(16);
    });

    it('keeps missing telemetry unknown and separates provider outages from semantic abstention recovery', () => {
      const goldset = loadExecutedQualificationGoldset();
      const entry = goldset.entries.find(entry => entry.gold.productType.kind === 'no-fit')!;
      entry.baseline.failureCode = 'provider_unavailable';
      entry.baseline.abstained = true;
      entry.baseline.productType = null;
      entry.candidate = { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0, failureCode: null };
      delete entry.baseline.latencyMs;
      delete entry.baseline.costUsd;
      const report = evaluateJevOfflineComparison({ ...goldset, entries: [entry] });
      expect(report.productType.rawCorrectness.baseline).toBe(0);
      expect(report.productType.serviceFailures.baseline).toBe(1);
      expect(report.productType.recoveredAbstentions).toBe(0);
      expect(report.telemetry.estimatedCostUsd.baseline).toBeNull();
      expect(report.telemetry.latency.baseline.meanMs).toBeNull();
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

  it('scores only the matching semantic abstention and excludes unlabeled rows from type accuracy', () => {
    const goldset = loadExecutedQualificationGoldset();
    const template = goldset.entries[0];
    const semantic: QualificationGoldEntry = { ...template, gold: { ...template.gold, productType: { kind: 'no-fit', typeId: null } },
      baseline: { ...template.baseline, productType: null, abstained: true, failureCode: null, abstentionCode: 'insufficient_evidence' },
      candidate: { ...template.candidate, productType: null, abstained: true, failureCode: null, abstentionCode: 'low_probability' } };
    goldset.entries = [semantic];
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness).toEqual({ baseline: 0, candidate: 0, delta: 0 });
    semantic.candidate.abstentionCode = 'no_match';
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness.candidate).toBe(1);
    goldset.entries.push({ ...semantic, sku: 'UNLABELED-FIXTURE', gold: { ...semantic.gold, productType: { kind: 'unlabeled', typeId: null } },
      candidate: { ...semantic.candidate, productType: 'unsupported', abstained: false } });
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness.candidate).toBe(1);
    goldset.entries[0] = { ...semantic, gold: { ...semantic.gold, productType: { kind: 'insufficient-evidence', typeId: null } } };
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness.candidate).toBe(0);
    goldset.entries[0].candidate.abstentionCode = 'insufficient_evidence';
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness.candidate).toBe(1);
    goldset.entries[0].candidate.abstentionCode = undefined;
    expect(evaluateJevOfflineComparison(goldset).productType.rawCorrectness.candidate).toBe(0);
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

    function qualificationHeadCommit(): string {
      try {
        const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
        const head = proc.stdout.toString().trim();
        if (proc.exitCode === 0 && /^[0-9a-f]{4,64}$/i.test(head)) return head;
      } catch {
        // Fall through to explicit test binding below.
      }
      return 'test-qualified-commit-head';
    }

    function buildValidEvidence() {
      const familySeparationProof = verifyFamilySeparation(loadGoldEntries());
      // Commit-bound (issue #302): the receipt commit MUST equal the
      // explicitly qualified commit — never a placeholder that clears gates.
      const compatibilityExpectedCommit = qualificationHeadCommit();
      const compatibilityReceipt = {
        suites: REQUIRED_COMPATIBILITY_SUITE_IDS.map(suiteId => ({
          suiteId,
          commit: compatibilityExpectedCommit,
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
      return { familySeparationProof, compatibilityReceipt, compatibilityExpectedCommit, operatorDocsReceipt,
        policiesPublishedBeforeHoldout: true, connectionDisablementVerified: true };
    }

    it('returns qualified when offline evidence is clean and all receipts are valid', () => {
      // Artificial gate-wiring population only; never a retained live qualification artifact.
      const goldset = loadExecutedQualificationGoldset();
      const template = goldset.entries.find(entry => entry.gold.productType.kind === 'known-type')!;
      goldset.entries = Array.from({ length: 220 }, (_, index) => ({ ...template, sku: `STAT-FIXTURE-${index}`, familyId: `stat-fixture-${index}`, split: 'holdout' as const,
        // Complete adjudication markers (fixture bytes untouched): the
        // conservative gate refuses marker-less holdout rows fail-closed.
        gold: { ...template.gold, categoryPages: { ...template.gold.categoryPages, state: 'known' as const, completeness: 'complete' as const } },
        baseline: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0, failureCode: null },
        candidate: { productType: template.gold.productType.typeId, abstained: false,
          fieldAssignments: template.gold.fieldAssignments, pageIds: template.gold.categoryPages.pageIds, confidence: 0.9, failureCode: null },
      }));
      const report = evaluateJevOfflineComparison(goldset);
      const statisticalGate = evaluateJevQualificationGate(goldset, { predictionSource: 'prereview_raw', bundleVersion: 1, snapshotMatched: true });
      expect(statisticalGate.reasons).toEqual([]);
      expect(statisticalGate.qualified).toBe(true);
      const assessment = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: report,
        offlineQualificationGate: statisticalGate,
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

    it('cannot qualify a tiny holdout by supplying all operational sign-offs', () => {
      const goldset = loadExecutedQualificationGoldset();
      const gate = evaluateJevQualificationGate(goldset, { predictionSource: 'prereview_raw', bundleVersion: 1, snapshotMatched: true });
      expect(gate.qualified).toBe(false);
      expect(gate.reasons.some(reason => reason.startsWith('insufficient_sample'))).toBe(true);
      const report = evaluateJevOfflineComparison(goldset);
      report.summary.candidateOutperformsBaseline = true;
      report.summary.zeroHarmfulRegressionsOnHoldout = true;
      report.summary.zeroServiceFailures = true;
      report.productType.harmfulRegressions = report.attributes.harmfulRegressions = report.categoryPages.harmfulRegressions = 0;
      report.productType.serviceFailures = report.attributes.serviceFailures = report.categoryPages.serviceFailures = { baseline: 0, candidate: 0 };
      for (const offlineQualificationGate of [undefined, gate]) {
        const assessment = assessProductionQualification({ ...operationalPass, ...buildValidEvidence(), offlineComparisonReport: report, offlineQualificationGate });
        expect(assessment.status).toBe('blocked');
        expect(assessment.checklist.offlineEvaluationPassed).toBe(false);
        expect(assessment.blockers.some(blocker => blocker.code.startsWith('statistical_gate_'))).toBe(true);
      }
    });

    it('does not infer policy publication, disablement or holdout evaluation from implemented code', () => {
      const report = evaluateJevOfflineComparison(loadExecutedQualificationGoldset());
      report.holdoutCount = 0;
      const assessment = assessProductionQualification({ ...operationalPass, ...buildValidEvidence(),
        policiesPublishedBeforeHoldout: undefined, connectionDisablementVerified: undefined, offlineComparisonReport: report });
      expect(assessment.checklist.policiesPublished).toBe(false);
      expect(assessment.checklist.connectionDisablementVerified).toBe(false);
      expect(assessment.blockers.map(b => b.code)).toContain('policy_publication_unverified');
      expect(assessment.blockers.map(b => b.code)).toContain('connection_disablement_unverified');
      expect(assessment.blockers.map(b => b.code)).toContain('holdout_evaluation_missing');
      expect(assessment.status).not.toBe('qualified');
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

    it('keeps the compatibility blocker on commit mismatch (stale green receipt cannot qualify new code)', () => {
      const evidence = buildValidEvidence();
      const stale = assessProductionQualification({
        ...operationalPass,
        offlineComparisonReport: evaluateJevOfflineComparison(loadExecutedQualificationGoldset()),
        ...evidence,
        compatibilityReceipt: {
          ...evidence.compatibilityReceipt,
          suites: evidence.compatibilityReceipt.suites.map(suite => ({
            ...suite,
            commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          })),
        },
      });
      expect(stale.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      expect(stale.checklist.compatibilityVerified).toBe(false);
      expect(stale.blockers.find(b => b.code === 'compatibility_unverified')?.message).toContain('expected');
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
      // REAL frozen mapping (issue #302): type → profile → applicable
      // attributes (no invariants here so the live-transport tests exercise
      // Jev Noul/Choice for both targets; universals proceed without a type).
      return {
        productTypes: [
          { id: 'dog_food_dry', label: 'Dry Dog Food', attributeProfileId: 'dog_food_dry-profile' },
          { id: 'cat_treat', label: 'Cat Treat', attributeProfileId: 'cat_treat-profile' },
        ],
        attributeTargets: [
          { targetId: 'flavor', cardinality: 'single', options: ['Chicken', 'Beef'] },
          { targetId: 'animal_type', cardinality: 'multiple', options: ['dog', 'cat'], isUniversal: true },
        ],
        pages: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
        typeAttributeProfiles: {
          dog_food_dry: 'dog_food_dry-profile',
          cat_treat: 'cat_treat-profile',
        },
        attributeProfiles: [
          {
            id: 'dog_food_dry-profile',
            productTypeId: 'dog_food_dry',
            attributes: [
              { attributeId: 'flavor', cardinality: 'single', required: false, applicabilityConditions: [] },
              { attributeId: 'animal_type', cardinality: 'multiple', required: false, applicabilityConditions: [] },
            ],
          },
          {
            id: 'cat_treat-profile',
            productTypeId: 'cat_treat',
            attributes: [
              { attributeId: 'flavor', cardinality: 'single', required: false, applicabilityConditions: [] },
              { attributeId: 'animal_type', cardinality: 'multiple', required: false, applicabilityConditions: [] },
            ],
          },
        ],
        universalAttributeIds: ['animal_type'],
        invariantAttributesByType: {},
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

      // Replay fidelity (no gold leakage): attribute plans cover the APPLICABLE
      // frozen attributes for the frozen effective type — never the
      // gold-adjudicated targets. Without a resolved type (pure wiring proof)
      // all frozen attributes are built (gold-free, wiring-only); live capture
      // narrows to the applicable set after resolving Product Type first.
      const frozenTargets = new Set(taxa.attributeTargets.map(t => t.targetId));
      expect(new Set(set.attributePlans.map(p => p.targetId))).toEqual(frozenTargets);
      // With an explicit frozen type, applicability narrows via the REAL
      // frozen mapping (still gold-free): dog_food_dry admits flavor +
      // life_stage + animal_type, and the animal_type invariant resolves
      // deterministically (excluded from Jev questions) — never all frozen.
      const withType = buildQualificationCandidateQuestionSet(entry, taxa, 'dog_food_dry');
      expect(new Set(withType.attributePlans.map(p => p.targetId))).toEqual(new Set(['flavor', 'life_stage']));
      // Missing mapping fails closed (blocked, never broadened to all).
      const taxaWithoutMapping = { ...taxa, attributeProfiles: null, typeAttributeProfiles: null } as never;
      expect(() => buildQualificationCandidateQuestionSet(entry, taxaWithoutMapping, 'dog_food_dry')).toThrow(
        new RegExp(QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE),
      );
      // PAGE ABSTENTION PARITY: explicit null type abstains pages exactly like
      // production — never a constructed Choice. Constants mirror
      // page-decision.ts checkProductTypeAuthority verbatim.
      expect(QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_CODE).toBe('no_reviewed_product_type');
      expect(QUALIFICATION_PAGE_ABSTENTION_NO_REVIEWED_TYPE_REASON).toBe(
        'No reviewed Primary Product Type. Page assignment requires an accepted Product Type and a verified Page catalog.',
      );
      const nullType = buildQualificationCandidateQuestionSet(entry, taxa, null);
      expect(nullType.pagePlan).toBeNull();
      expect(new Set(nullType.attributePlans.map(p => p.targetId))).toEqual(new Set(['animal_type']));
      // Applicability fail-closed at capture: a mapping-absent taxonomy blocks
      // the deterministic baseline (coded reason, never floor guesses).
      const blockedArtifact = buildQualificationPredictionsFromCode([entry], taxaWithoutMapping);
      expect(blockedArtifact.predictions[0].baseline.blockedCode).toBe(
        QUALIFICATION_BLOCKED_APPLICABILITY_UNRESOLVABLE,
      );
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

    it('scores fixed-population attributes over the applicable set: inapplicable extras lower precision', () => {
      // dog_food_dry admits flavor + life_stage (+ invariant animal_type);
      // organic/material are inapplicable. An extra organic proposal must be
      // visible as a false positive (precision down by design), while an
      // abstention with uncovered applicable targets counts as a miss (not wrong).
      const goldset = loadExecutedQualificationGoldset();
      const clean = evaluateJevOfflineComparison(goldset);
      const withExtra = evaluateJevOfflineComparison({
        ...goldset,
        entries: goldset.entries.map(e =>
          e.sku === 'QUAL-DOG-KIBBLE-01'
            ? {
              ...e,
              candidate: {
                ...e.candidate,
                fieldAssignments: [
                  ...e.candidate.fieldAssignments,
                  { targetId: 'organic', value: 'Yes' },
                  { targetId: 'material', value: 'Rubber' },
                ],
              },
            }
            : e,
        ),
      });
      expect(withExtra.attributes.setMetrics.precision.candidate).toBeLessThan(
        clean.attributes.setMetrics.precision.candidate,
      );
      expect(withExtra.attributes.setMetrics.f1.candidate).toBeLessThanOrEqual(
        clean.attributes.setMetrics.f1.candidate,
      );
      expect(withExtra.attributes.incorrectProposals.candidate).toBeGreaterThanOrEqual(
        clean.attributes.incorrectProposals.candidate,
      );
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
        const artifact = await captureGuardedJevForTest(
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
          { targetId: 'animal_type', values: ['dog', 'cat'], outcome: 'predicted', probability: 0.95,
            candidateProbabilities: { dog: 0.95, cat: 0.95 }, probabilityDigest: expect.any(String) },
          { targetId: 'flavor', value: 'Chicken', outcome: 'predicted', probability: 0.85 },
        ]);
        // Provenance digest binds the actual canonical probabilities (format, not a frozen hash).
        const predictedNoul = first.candidate.fieldAssignments.find(f => f.targetId === 'animal_type') as unknown as Record<string, unknown>;
        expect(predictedNoul.probabilityDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(first.candidate.pageIds).toEqual(['page-dry-dog-food']);
        expect(first.candidate.pageOutcome).toBe('predicted');
        expect(first.candidate.pageAbstentionCode).toBeNull();
        expect(first.candidate.pageProbability).toBeCloseTo(0.85, 4);
        expect(first.candidate.requestedModel).toBe('jev-1.13.0');
        expect(first.candidate.resolvedModel).toBe('jev-1.13.0');
        expect(first.candidate.provider).toBe('typesafe');
        // PRODUCT-TYPE-FIRST replay dispatches in two phases (type first with
        // the rich type state, then applicable attributes/pages with the rich
        // attribute state): usage sums across both live dispatches.
        expect(first.candidate.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
        expect(first.candidate.failureCode).toBeNull();
        // `live_captured` guarantees a model spoke (resolvedModel + usage present).
        expect(first.candidate.resolvedModel).toBeTruthy();
        expect(first.candidate.usage).not.toBeNull();
        // The baseline without an opted-in route stays the deterministic floor.
        expect(first.baseline.source).toBe(QUALIFICATION_SOURCE_DETERMINISTIC_FLOOR);
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('blocks candidate requests when explicit credentials have no bound budget or deadline', async () => {
      let fetchCalls = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error('Unwired candidate must not dispatch.');
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          { jev: { apiKey: 'test-key-12345678' } },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(0);
        for (const prediction of artifact.predictions) {
          expect(prediction.candidate.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
          expect(prediction.candidate.blockedCode).toBe('jev_runtime_guard_unwired');
        }
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('records live floors as abstentions, not failures (mocked HTTP)', async () => {
      const { mock } = mockJevFetchBehavior({ choiceProb: 0.3, noulProb: 0.1 });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = mock;
      try {
        const artifact = await captureGuardedJevForTest(
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
        // Below-floor answers ride as unresolved proof (never bare empties):
        // the universal Noul target proves nothing at 0.1 — outcome stays
        // unresolved (never credited) while carrying the shipped policy's
        // actual code plus canonical probabilities, and pages abstain for the
        // missing effective type with the production code.
        expect(first.candidate.fieldAssignments).toEqual([
          { targetId: 'animal_type', outcome: 'unresolved', abstentionCode: 'no_match', probability: null,
            candidateProbabilities: { dog: 0.1, cat: 0.1 }, probabilityDigest: expect.any(String) },
        ]);
        expect(first.candidate.pageIds).toEqual([]);
        expect(first.candidate.pageOutcome).toBe('abstained-semantic');
        expect(first.candidate.pageAbstentionCode).toBe('no_reviewed_product_type');
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
        // Fully silent attempt: no per-entry side executed a model judgment,
        // so the aggregate mode stays the floor (credentials alone are not
        // provenance — per-side `source` fields carry the blocked outcome).
        expect(artifact.captureMode).toBe('deterministic_floor');
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

    it('refuses an incumbent credential reference that does not identify the resolved credential', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      let fetchCalls = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        });
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          { baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:unrelated-provider', isolatedStore: dbPath } },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(0);
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(artifact.predictions[0].baseline.blockedCode).toBe('baseline_credential_reference_mismatch');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('bounds incumbent HTTP attempts including the ranker JSON repair request', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      let fetchCalls = 0;
      let attempts = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return Response.json({
          choices: [{ message: { content: 'not valid JSON' } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        });
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => attempts < 1 && (++attempts > 0) },
            baselineDeadlineSignal: new AbortController().signal,
          },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(1);
        expect(attempts).toBe(1);
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(artifact.predictions[0].baseline.blockedCode).toBe('baseline_attempt_budget_exhausted');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('preserves unknown incumbent token usage rather than reporting zero', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({
        model: 'qual-ollama-model',
        choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
      })) as unknown as typeof fetch;
      let attempts = 0;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 10 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(artifact.predictions[0].baseline.usage).toEqual({ inputTokens: null, outputTokens: null });
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('records the provider-returned incumbent model instead of assuming the requested route', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({
        model: 'qual-ollama-model-revision-2',
        choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      })) as unknown as typeof fetch;
      let attempts = 0;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 10 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(artifact.predictions[0].baseline.requestedModel).toBe('qual-ollama-model');
        expect(artifact.predictions[0].baseline.resolvedModel).toBe('qual-ollama-model-revision-2');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('does not qualify an incumbent returned-model identity that the provider omitted', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({
        choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      })) as unknown as typeof fetch;
      let attempts = 0;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 10 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(artifact.predictions[0].baseline.blockedCode).toBe('baseline_model_identity_unverified');
        expect(artifact.predictions[0].baseline.resolvedModel).toBeNull();
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('binds the resolved incumbent credential source into prediction artifact identity', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({
        model: 'qual-ollama-model',
        choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      })) as unknown as typeof fetch;
      let attempts = 0;
      const capture = (credentialRef: string) => captureQualificationPredictionsLive(
        tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
        {
          baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef, isolatedStore: dbPath },
          baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 20 },
          baselineDeadlineSignal: AbortSignal.timeout(30_000),
        },
        tinyQualificationTaxonomies(),
      );
      try {
        const legacy = await capture('api_keys:ollama');
        upsertProviderConnection({
          id: 'ollama', label: 'Isolated incumbent connection fixture', transport: 'openai-compatible',
          baseUrl: 'http://localhost:11434', credential: 'qual-test-ollama-key', trustZone: 'this_device',
          approvedHost: 'localhost', approvedPort: 11434, enabled: true,
        });
        const connection = await capture('provider_connections:ollama');
        expect(legacy.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(connection.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(connection.artifactHash).not.toBe(legacy.artifactHash);
        expect(legacy.predictions[0].baseline.credentialRef).toBe('api_keys:ollama');
        expect(connection.predictions[0].baseline.credentialRef).toBe('provider_connections:ollama');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('cancels an incumbent waiting for a local slot without waiting for another request to finish', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const previousLimit = process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;
      process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = '1';
      const fetchBefore = globalThis.fetch;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) { entered.resolve(); await release.promise; }
        return Response.json({
          model: 'qual-ollama-model',
          choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        });
      }) as unknown as typeof fetch;
      const capture = (signal: AbortSignal, suffix = '') => captureQualificationPredictionsLive(
        tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01').map(entry => ({ ...entry, sku: entry.sku + suffix })),
        {
          baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
          baselineAttemptBudget: { tryConsumeAttempt: () => true },
          baselineDeadlineSignal: signal,
        },
        tinyQualificationTaxonomies(),
      );
      const holding = capture(new AbortController().signal);
      let waiting: ReturnType<typeof capture> | undefined;
      try {
        await entered.promise;
        const deadline = new AbortController();
        waiting = capture(deadline.signal, '-queued');
        await new Promise(resolve => setTimeout(resolve, 0));
        deadline.abort();
        const result = await Promise.race([
          waiting.then(artifact => ({ kind: 'settled' as const, artifact })),
          Bun.sleep(150).then(() => ({ kind: 'still_waiting' as const })),
        ]);
        expect(result.kind).toBe('settled');
        if (result.kind === 'settled') {
          expect(result.artifact.predictions[0].baseline.blockedCode).toBe('baseline_deadline_exceeded');
        }
        expect(fetchCalls).toBe(1);
      } finally {
        release.resolve();
        await holding;
        await waiting;
        globalThis.fetch = fetchBefore;
        if (previousLimit === undefined) delete process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;
        else process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY = previousLimit;
      }
    });

    it('does not hide a later incumbent service failure behind an earlier successful stage', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return fetchCalls === 1 ? Response.json({
          model: 'qual-ollama-model',
          choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        }) : new Response('Synthetic service failure', { status: 502 });
      }) as unknown as typeof fetch;
      let attempts = 0;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 10 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBeGreaterThan(1);
        expect(artifact.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
        expect(artifact.predictions[0].baseline.failureCode).toBe(QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED);
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('refuses an incumbent whose declared isolated store does not match the active evaluation context', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return Response.json({
          model: 'qual-ollama-model',
          choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        });
      }) as unknown as typeof fetch;
      let attempts = 0;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama',
              isolatedStore: '/tmp/unrelated-evaluation-store.db' },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 10 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(0);
        expect(attempts).toBe(0);
        expect(artifact.predictions[0].baseline.blockedCode).toBe('baseline_store_context_mismatch');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('binds incumbent endpoint configuration even when provider, model and credential reference are unchanged', async () => {
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({
        model: 'qual-ollama-model',
        choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
        usage: { prompt_tokens: 40, completion_tokens: 8 },
      })) as unknown as typeof fetch;
      let attempts = 0;
      const capture = () => captureQualificationPredictionsLive(
        tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
        {
          baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
          baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 20 },
          baselineDeadlineSignal: AbortSignal.timeout(30_000),
        },
        tinyQualificationTaxonomies(),
      );
      try {
        const first = await capture();
        upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11435', 'qual-ollama-model');
        const second = await capture();
        expect(first.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(second.predictions[0].baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(second.artifactHash).not.toBe(first.artifactHash);
        expect(second.predictions[0].baseline.routeIdentityHash).not.toBe(first.predictions[0].baseline.routeIdentityHash);
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('enforces an expired incumbent deadline even before a delayed timer callback can run', async () => {
      closeDb();
      initDb(':memory:');
      runMigrations();
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls += 1;
        return Response.json({
          model: 'qual-ollama-model',
          choices: [{ message: { content: JSON.stringify({ values: ['Dry Dog Food'], confidence: 0.85 }) } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
        });
      }) as unknown as typeof fetch;
      const guard = createDevAttemptGuard({ maxHttpAttempts: 10, hardDeadlineMs: 1 });
      try {
        const until = performance.now() + 10;
        while (performance.now() < until) { /* Deliberately delay the timer with bounded CPU work. */ }
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: ':memory:' },
            baselineAttemptBudget: guard,
            baselineDeadlineSignal: guard.signal,
          },
          tinyQualificationTaxonomies(),
        );
        expect(fetchCalls).toBe(0);
        expect(guard.audit().consumed).toBe(0);
        expect(artifact.predictions[0].baseline.blockedCode).toBe('baseline_deadline_exceeded');
      } finally {
        guard.dispose();
        globalThis.fetch = fetchBefore;
      }
    });

    it('executes the incumbent ranker path when credentials exist and records its real outcome (mocked HTTP, real transport)', async () => {
      // Dummy local credential (detector-safe): proves the existing-store
      // resolution, not a real model account.
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      let fetchCalls = 0;
      let attempts = 0;
      const fetchBefore = globalThis.fetch;
      // Mocked OpenAI-compatible chat transport (shape only — the decision
      // boundaries, audit rows, mapping, and floors under test are the
      // shipped ones). Returns a confident single pick for every stage so the
      // incumbent genuinely speaks; usage proves the model spoke.
      globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
        fetchCalls += 1;
        const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
        const prompt = body.messages.map(m => m.content).join('\n');
        // Pick the first allowed option visible in the prompt (labels are the
        // frozen option values for tiny taxonomies).
        const pick = prompt.includes('Dry Dog Food') ? 'Dry Dog Food'
          : prompt.includes('Chicken') ? 'Chicken'
          : prompt.includes('dog') ? 'dog'
          : 'Dry Dog Food';
        return new Response(
          JSON.stringify({
            model: 'qual-ollama-model',
            choices: [{ message: { content: JSON.stringify({ values: [pick], confidence: 0.85, scores: [0.85] }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries(),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 20 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        // REAL transport with run-bound audit rows: the ephemeral benchmark
        // run lets the legacy chat ranker path speak (mocked HTTP, no real
        // network), so fetch happens and the audit rows terminalize.
        expect(fetchCalls).toBeGreaterThan(0);
        const unknown = artifact.predictions.find(p => p.sku === 'TINY-UNKNOWN-01')!;
        // `live_captured` guarantees a model spoke (resolvedModel + usage
        // present) — a provider-selected-but-silent outcome would be `blocked`,
        // never live_captured.
        expect(unknown.baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(unknown.baseline.requestedModel).toBeTruthy();
        expect(unknown.baseline.resolvedModel).toBeTruthy();
        expect(unknown.baseline.usage).not.toBeNull();
        expect(unknown.baseline.provider).toBe('ollama');
        expect(unknown.baseline.failureCode).toBeNull();
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });
    it('re-attempts pages after a live type recovery unlocks a real type (mocked HTTP, real transport)', async () => {
      // (a) The deterministic matcher leaves type AND pages unresolved for
      // the unknown entry (missing-type page abstention); the live type
      // boundary recovers a real type, so pages MUST be re-attempted even
      // though the pre-computed needs.pages was false under the stale null
      // type — the old missing-type abstention never carries across.
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      let attempts = 0;
      const fetchBefore = globalThis.fetch;
      let pageAttempts = 0;
      globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
        const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
        const prompt = body.messages.map(m => m.content).join('\n');
        if (prompt.includes('Dry Dog Food') && !prompt.includes('Chicken')) pageAttempts += 1;
        const pick = prompt.includes('Dry Dog Food') && !prompt.includes('Chicken') ? 'Dry Dog Food'
          : prompt.includes('Dry Dog Food') ? 'Dry Dog Food'
          : prompt.includes('Chicken') ? 'Chicken'
          : prompt.includes('dog') ? 'dog'
          : 'Dry Dog Food';
        return new Response(
          JSON.stringify({
            model: 'qual-ollama-model',
            choices: [{ message: { content: JSON.stringify({ values: [pick], confidence: 0.85, scores: [0.85] }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      try {
        const artifact = await captureQualificationPredictionsLive(
          tinyQualificationEntries().filter(entry => entry.sku === 'TINY-UNKNOWN-01'),
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 20 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          tinyQualificationTaxonomies(),
        );
        const baseline = artifact.predictions[0].baseline;
        expect(baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        expect(baseline.abstained).toBe(false);
        expect(pageAttempts).toBeGreaterThan(0);
        expect(baseline.pageIds).toEqual(['page-dry-dog-food']);
        expect(baseline.pageOutcome).toBe('predicted');
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('baseline matcher honors frozen alias settings; live boundary carries profile cardinality + authority (mocked HTTP)', async () => {
      // (b)+(c) An alias-only mention matches deterministically only with the
      // frozen authority attached (stub matches direct text alone), and the
      // live leg executes the profile-adjusted cardinality through the same
      // authority resolution (single-slot value, never a multi pick).
      const taxaBase: QualificationTaxonomies = {
        productTypes: [{ id: 'dog_food_dry', label: 'Dry Dog Food', attributeProfileId: 'dog_food_dry-profile' }],
        attributeTargets: [{ targetId: 'flavor', cardinality: 'multiple', options: ['Chicken', 'Beef'] }],
        pages: [],
        typeAttributeProfiles: { dog_food_dry: 'dog_food_dry-profile' },
        attributeProfiles: [{
          id: 'dog_food_dry-profile',
          productTypeId: 'dog_food_dry',
          attributes: [{ attributeId: 'flavor', cardinality: 'single', required: false, applicabilityConditions: [] }],
        }],
        universalAttributeIds: [],
        invariantAttributesByType: {},
      };
      const aliasEntry: QualificationGoldOnlyEntry = {
        sku: 'TINY-ALIAS-01',
        familyId: 'fam-tiny-alias',
        split: 'dev',
        assortment: 'food',
        gold: {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: [{ targetId: 'flavor', value: 'Chicken', state: 'known' }],
          categoryPages: { pageIds: [], pageAssignments: [] },
        },
        evidence: [{ source: 'official_page', snippet: 'Acme poultry Dry Dog Food for adult dogs', reliability: 'high', attributeId: null }],
      };
      const withAliases = {
        ...taxaBase,
        frozenAuthorityDetails: {
          catalogFieldByTarget: { flavor: 'ProductField18' },
          attributeConfigByTarget: {
            flavor: {
              valueAliases: [{ alias: 'poultry', mapsTo: 'Chicken' }],
              isClaim: false,
              isCompositionAttribute: false,
              visualEvidenceEligibility: 'eligible' as const,
            },
          },
        },
      } satisfies QualificationTaxonomies;
      const bareFloor = buildQualificationPredictionsFromCode([aliasEntry], taxaBase);
      expect(bareFloor.predictions[0].baseline.fieldAssignments).toEqual([]);
      const aliasFloor = buildQualificationPredictionsFromCode([aliasEntry], withAliases);
      expect(aliasFloor.predictions[0].baseline.fieldAssignments).toEqual([{ targetId: 'flavor', value: 'Chicken' }]);
      expect(aliasFloor.artifactHash).not.toBe(bareFloor.artifactHash);
      // Live leg: the evidence below has NO direct/alias match, so the
      // deterministic precedence inside the boundary cannot resolve first —
      // the mock ranker speaks through the profile-adjusted single
      // cardinality.
      upsertApiKey('ollama', 'qual-test-ollama-key', 'http://localhost:11434', 'qual-ollama-model');
      const fetchBefore = globalThis.fetch;
      let attempts = 0;
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            model: 'qual-ollama-model',
            choices: [{ message: { content: JSON.stringify({ values: ['Chicken', 'Beef'], confidence: 0.85, scores: [0.9, 0.3] }) } }],
            usage: { prompt_tokens: 40, completion_tokens: 8 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
      try {
        const liveEntry: QualificationGoldOnlyEntry = {
          ...aliasEntry,
          sku: 'TINY-ALIAS-02',
          evidence: [{ source: 'official_page', snippet: 'Acme Dry Dog Food for adult dogs', reliability: 'high', attributeId: null }],
        };
        const artifact = await captureQualificationPredictionsLive(
          [liveEntry],
          {
            baselineRoute: { provider: 'ollama', model: 'qual-ollama-model', credentialRef: 'api_keys:ollama', isolatedStore: dbPath },
            baselineAttemptBudget: { tryConsumeAttempt: () => ++attempts <= 20 },
            baselineDeadlineSignal: AbortSignal.timeout(30_000),
          },
          withAliases,
        );
        const baseline = artifact.predictions[0].baseline;
        expect(baseline.source).toBe(QUALIFICATION_SOURCE_LIVE_CAPTURED);
        const flavor = baseline.fieldAssignments.find(f => f.targetId === 'flavor');
        // Profile says single: one value even though the ranker returned two.
        expect(flavor?.value).toBe('Chicken');
        expect(flavor?.values).toBeUndefined();
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('live capture commitment covers the frozen inputs (gold-free, evidence-sensitive)', async () => {
      // (e) The capture-time commitment is computed from the frozen snapshot
      // of the loaded inputs: gold relabels leave it untouched, evidence
      // changes move it, and the artifact verifies against it.
      const taxa = tinyQualificationTaxonomies();
      const entries = tinyQualificationEntries();
      const base = await captureQualificationPredictionsLive(entries, {}, taxa);
      expect(base.sourceInputsHash).toMatch(/^[0-9a-f]{64}$/);
      const relabeled = entries.map(entry => ({
        ...entry,
        gold: { ...entry.gold, productType: { kind: 'known-type' as const, typeId: 'changed-type' } },
      }));
      const relabeledArtifact = await captureQualificationPredictionsLive(relabeled, {}, taxa);
      expect(relabeledArtifact.sourceInputsHash).toBe(base.sourceInputsHash);
      const revised = entries.map(entry => entry.sku === 'TINY-DOG-01'
        ? { ...entry, evidence: [{ source: 'revised', snippet: 'changed evidence snippet', reliability: 'high', attributeId: null }] }
        : entry);
      const revisedArtifact = await captureQualificationPredictionsLive(revised, {}, taxa);
      expect(revisedArtifact.sourceInputsHash).not.toBe(base.sourceInputsHash);
    });

    it('development CLI execution excludes holdout predictions before inference', () => {
      const command = Bun.spawnSync(['bun', 'scripts/typesafe-curation-qualification.ts', '--split=dev', '--json'], {
        cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
      });
      const report = JSON.parse(command.stdout.toString()) as { predictionArtifact: { predictions: Array<{ sku: string }> } };
      expect(report.predictionArtifact.predictions.length).toBeGreaterThan(0);
      expect(report.predictionArtifact.predictions.some(prediction => /HOLDOUT|COHORT-FROMM/.test(prediction.sku))).toBe(false);
    });

    const liveJevKey = process.env.TYPESAFE_API_KEY ?? '';
    const itLive = process.env.TYPESAFE_LIVE_CAPTURE_TEST === '1' && liveJevKey.length >= 8 ? it : it.skip;
    itLive('captures live Jev judgments against frozen gold evidence (opt-in keyed live capture, real network)', async () => {
      const artifact = await captureGuardedJevForTest(
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

    it('runner --json wires family/compat/docs receipts (no network)', () => {
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
      delete cleanEnv.TYPESAFE_COMPAT_RECEIPTS_PATH;
      delete cleanEnv.TYPESAFE_COMPAT_RECEIPT_JSON;

      type ReceiptOut = {
        assessment: {
          status: string;
          blockers: Array<{ code: string }>;
          checklist: {
            familySeparationPassed: boolean;
            compatibilityVerified: boolean;
            operatorDocumentationPublished: boolean;
          };
        };
        family: { proof: { proofVersion: string; passed: boolean } | null };
        compatibility: { receipt: { suites: Array<{ suiteId: string }> } | null; source: string; runtimeWorktreeClean: boolean };
        operatorDocs: { receipt: { runbookPath: string; contentHash: string } | null };
      };

      // Default offline: family + docs verified live, compat absent-blocker,
      // overall still blocked on candidate quality (deterministic floor only).
      const proc = Bun.spawnSync(['bun', runnerPath, '--json'], {
        env: cleanEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(proc.exitCode).toBe(0);
      const out = JSON.parse(proc.stdout.toString()) as ReceiptOut;
      expect(out.family.proof?.proofVersion).toBe(FAMILY_SEPARATION_PROOF_VERSION);
      expect(out.family.proof?.passed).toBe(true);
      expect(out.assessment.checklist.familySeparationPassed).toBe(true);
      expect(out.operatorDocs.receipt?.runbookPath).toBe(OPERATOR_RUNBOOK_PATH);
      expect(out.operatorDocs.receipt?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      const runbookBytes = fs.readFileSync(
        path.resolve(import.meta.dir, '../../../docs/runbooks/typesafe-jev-curation-rollout.md'),
      );
      expect(out.operatorDocs.receipt?.contentHash).toBe(
        createHash('sha256').update(runbookBytes).digest('hex'),
      );
      expect(out.assessment.checklist.operatorDocumentationPublished).toBe(true);
      expect(out.compatibility.receipt).toBeNull();
      expect(out.assessment.checklist.compatibilityVerified).toBe(false);
      expect(out.assessment.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      expect(out.assessment.status).toBe('blocked');

      // Valid compat receipts file clears the compat gate (only that gate).
      // Commit-bound (issue #302): the receipt commit must equal the
      // explicitly qualified commit (TYPESAFE_QUALIFIED_COMMIT) — never a
      // placeholder. A stale commit retains the blocker.
      const qualifiedCommit = `test-qualified-${Date.now().toString(36)}`;
      const receiptsPath = path.join(os.tmpdir(), `compat-receipts-${Date.now()}.json`);
      fs.writeFileSync(
        receiptsPath,
        JSON.stringify({
          suites: REQUIRED_COMPATIBILITY_SUITE_IDS.map(suiteId => ({
            suiteId,
            commit: qualifiedCommit,
            passed: true,
            executedAt: null,
          })),
          recordedAt: new Date().toISOString(),
        }),
      );
      try {
        const withCompat = Bun.spawnSync(['bun', runnerPath, '--json'], {
          env: { ...cleanEnv, TYPESAFE_COMPAT_RECEIPTS_PATH: receiptsPath, TYPESAFE_QUALIFIED_COMMIT: qualifiedCommit },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(withCompat.exitCode).toBe(0);
        const compatOut = JSON.parse(withCompat.stdout.toString()) as ReceiptOut;
        expect(compatOut.assessment.checklist.compatibilityVerified).toBe(compatOut.compatibility.runtimeWorktreeClean);
        expect(compatOut.assessment.blockers.some(b => b.code === 'compatibility_unverified')).toBe(false);
        expect(compatOut.compatibility.receipt?.suites).toHaveLength(4);

        // Inline env JSON receipt works the same way.
        const withEnv = Bun.spawnSync(['bun', runnerPath, '--json'], {
          env: { ...cleanEnv, TYPESAFE_COMPAT_RECEIPT_JSON: fs.readFileSync(receiptsPath, 'utf8'), TYPESAFE_QUALIFIED_COMMIT: qualifiedCommit },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(withEnv.exitCode).toBe(0);
        const envOut = JSON.parse(withEnv.stdout.toString()) as ReceiptOut;
        expect(envOut.assessment.checklist.compatibilityVerified).toBe(envOut.compatibility.runtimeWorktreeClean);
        expect(envOut.compatibility.source).toBe('env TYPESAFE_COMPAT_RECEIPT_JSON');

        // Stale commit (receipt bound to an older commit than qualified) retains the blocker.
        const staleEnv = Bun.spawnSync(['bun', runnerPath, '--json'], {
          env: { ...cleanEnv, TYPESAFE_COMPAT_RECEIPT_JSON: fs.readFileSync(receiptsPath, 'utf8'), TYPESAFE_QUALIFIED_COMMIT: `${qualifiedCommit}-newer` },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(staleEnv.exitCode).toBe(0);
        const staleOut = JSON.parse(staleEnv.stdout.toString()) as ReceiptOut;
        expect(staleOut.assessment.checklist.compatibilityVerified).toBe(false);
        expect(staleOut.assessment.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      } finally {
        fs.rmSync(receiptsPath, { force: true });
      }

      // Malformed compat file retains the blocker instead of crashing or passing.
      const badPath = path.join(os.tmpdir(), `compat-receipts-bad-${Date.now()}.json`);
      fs.writeFileSync(badPath, '{not valid json');
      try {
        const bad = Bun.spawnSync(['bun', runnerPath, '--json'], {
          env: { ...cleanEnv, TYPESAFE_COMPAT_RECEIPTS_PATH: badPath },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(bad.exitCode).toBe(0);
        const badOut = JSON.parse(bad.stdout.toString()) as ReceiptOut;
        expect(badOut.compatibility.receipt).toBeNull();
        expect(badOut.assessment.checklist.compatibilityVerified).toBe(false);
        expect(badOut.assessment.blockers.some(b => b.code === 'compatibility_unverified')).toBe(true);
      } finally {
        fs.rmSync(badPath, { force: true });
      }
    });
  });

  describe('Qualification blocked-side contract', () => {
    it('marks blocked sides with coded reasons mirrored as failure codes', () => {
      const dispatchBlocked = blockedQualificationPrediction(
        QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED,
        'dispatch boom',
      );
      expect(dispatchBlocked.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
      expect(dispatchBlocked.blockedCode).toBe(QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED);
      expect(dispatchBlocked.failureCode).toBe(QUALIFICATION_BLOCKED_LIVE_DISPATCH_FAILED);
      expect(dispatchBlocked.blockedDetail).toBe('dispatch boom');
      expect(dispatchBlocked.abstained).toBe(true);
      expect(dispatchBlocked.productType).toBeNull();

      const constructionBlocked = blockedQualificationPrediction(
        QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED,
        'bad taxonomy',
      );
      expect(constructionBlocked.source).toBe(QUALIFICATION_SOURCE_BLOCKED);
      expect(constructionBlocked.blockedCode).toBe(QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED);
      expect(constructionBlocked.failureCode).toBe(QUALIFICATION_BLOCKED_QUESTION_CONSTRUCTION_FAILED);
    });

    it('binds live family-separation proofs to the canonical proof version', () => {
      const fixturePath = path.resolve(import.meta.dir, '../fixtures/benchmark-jev-qualification-goldset.json');
      const entries = parseQualificationGoldOnly(JSON.parse(fs.readFileSync(fixturePath, 'utf8')));
      const proof = verifyFamilySeparation(entries);
      expect(proof.proofVersion).toBe(FAMILY_SEPARATION_PROOF_VERSION);
      expect(proof.passed).toBe(true);
    });
  });

  describe('gold-state scoring contract (step 1)', () => {
    function qualEntry(overrides: Partial<QualificationGoldEntry>): QualificationGoldEntry {
      return {
        sku: 'sku-1',
        familyId: 'fam-1',
        split: 'holdout',
        assortment: 'food',
        gold: {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: [],
          categoryPages: { pageIds: [], pageAssignments: [] },
        },
        evidence: [{ source: 'official_product_page', snippet: 'x', reliability: 'high', attributeId: null }],
        baseline: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0 },
        candidate: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0 },
        ...overrides,
      } as QualificationGoldEntry;
    }
    function qualGoldset(entries: QualificationGoldEntry[]): QualificationGoldset {
      return { version: 1, description: 't', adjudicatedBy: 't', entries };
    }

    it('rejects invalid qualification gold states during parsing', () => {
      expect(() => parseQualificationGoldOnly({ entries: [{ sku: 's', familyId: 'f', split: 'dev', assortment: 'a', gold: { productType: { kind: 'bogus', typeId: null }, fieldAssignments: [], categoryPages: { pageIds: [], pageAssignments: [] } }, evidence: [] }] })).toThrow();
      expect(() => parseQualificationGoldOnly({ entries: [{ sku: 's', familyId: 'f', split: 'dev', assortment: 'a', gold: { productType: { kind: 'known-type', typeId: 't' }, fieldAssignments: [{ targetId: 'flavor', state: 'bogus' }], categoryPages: { pageIds: [], pageAssignments: [] } }, evidence: [] }] })).toThrow();
      expect(() => parseQualificationGoldOnly({ entries: [{ sku: 's', familyId: 'f', split: 'dev', assortment: 'a', gold: { productType: { kind: 'known-type', typeId: 't' }, fieldAssignments: [], categoryPages: { pageIds: [], pageAssignments: [], state: 'bogus' } }, evidence: [] }] })).toThrow();
    });

    it('scores type-unlabeled but attr-known gold on attributes (independent of type labeling)', () => {
      const entry = qualEntry({
        gold: {
          productType: { kind: 'unlabeled', typeId: null },
          fieldAssignments: [{ targetId: 'flavor', value: 'Chicken', state: 'known' }],
          categoryPages: { pageIds: [], pageAssignments: [] },
        },
        baseline: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0 },
        candidate: { productType: null, abstained: true, fieldAssignments: [{ targetId: 'flavor', value: 'Chicken' }], pageIds: [], confidence: 0.9 },
      });
      const report = evaluateJevOfflineComparison(qualGoldset([entry]));
      expect(report.attributes.rawCorrectness.candidate).toBe(1);
    });

    it('requires coded abstention match: wrong/uncoded refusals are not correct', () => {
      const noFit = qualEntry({
        gold: {
          productType: { kind: 'no-fit', typeId: null },
          fieldAssignments: [],
          categoryPages: { pageIds: [], pageAssignments: [] },
        },
      });
      const wrongCode = qualEntry({
        gold: noFit.gold,
        candidate: { productType: null, abstained: true, abstentionCode: 'wrong_code', fieldAssignments: [], pageIds: [], confidence: 0 },
      });
      const uncoded = qualEntry({
        gold: noFit.gold,
        candidate: { productType: null, abstained: false, fieldAssignments: [], pageIds: [], confidence: 0, failureCode: 'boom' },
      });
      const report = evaluateJevOfflineComparison(qualGoldset([wrongCode, uncoded]));
      expect(report.productType.rawCorrectness.candidate).toBe(0);
    });

    it('excludes unknown/partial pages but counts explicit known-empty pages', () => {
      const unknownPage = qualEntry({
        gold: {
          productType: { kind: 'known-type', typeId: 't' },
          fieldAssignments: [],
          categoryPages: { pageIds: [], pageAssignments: [], state: 'unknown', completeness: 'unknown' },
        },
      });
      const knownEmpty = qualEntry({
        sku: 'sku-2',
        gold: {
          productType: { kind: 'known-type', typeId: 't' },
          fieldAssignments: [],
          categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
        },
      });
      const report = evaluateJevOfflineComparison(qualGoldset([unknownPage, knownEmpty]));
      // Unknown page entry excluded; known-empty entry evaluated and exactly matched (both empty).
      expect(report.categoryPages.rawCorrectness.candidate).toBe(1);
    });

    // ── Step-1 completion: code-path proof tests (mocked HTTP / executed
    // floors — never hand-authored prediction stand-ins) ──

    function step1Taxa(): QualificationTaxonomies {
      return {
        productTypes: [
          { id: 'dog_food_dry', label: 'Dry Dog Food', attributeProfileId: 'dog-profile' },
        ],
        attributeTargets: [
          { targetId: 'flavor', cardinality: 'single', options: ['Chicken', 'Beef'] },
          { targetId: 'animal_type', cardinality: 'multiple', options: ['dog', 'cat'], isUniversal: true },
        ],
        pages: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
        typeAttributeProfiles: { dog_food_dry: 'dog-profile' },
        attributeProfiles: [
          {
            id: 'dog-profile',
            productTypeId: 'dog_food_dry',
            attributes: [
              { attributeId: 'flavor', cardinality: 'single', required: false, applicabilityConditions: [] },
              { attributeId: 'animal_type', cardinality: 'multiple', required: false, applicabilityConditions: [] },
            ],
          },
        ],
        universalAttributeIds: ['animal_type'],
        invariantAttributesByType: {},
      };
    }

    function step1Entry(sku: string, gold: QualificationGoldOnlyEntry['gold'], snippet: string): QualificationGoldOnlyEntry {
      return {
        sku,
        familyId: `fam-${sku}`,
        split: 'holdout',
        assortment: 'food',
        gold,
        evidence: [{ source: 'official_page', snippet, reliability: 'high', attributeId: null }],
      };
    }

    function mockStep1Fetch(flavorChoice: { kind: 'code'; code: string; prob: number } | { kind: 'first'; prob: number }, noulProb: number): typeof fetch {
      return (async (_url: unknown, init: { body: string }) => {
        const body = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> };
        const answers: Record<string, unknown> = {};
        for (const [qid, q] of Object.entries(body.questions)) {
          if (q.type === 'choice') {
            const keys = Object.keys(q.criteria ?? {});
            const want = qid === 'attr_flavor'
              ? (flavorChoice.kind === 'code' ? flavorChoice.code : keys[0])
              : keys[0];
            const prob = qid === 'attr_flavor' ? flavorChoice.prob : 0.9;
            const probabilities: Record<string, number> = {};
            for (const k of keys) probabilities[k] = k === want ? prob : (1 - prob) / Math.max(1, keys.length - 1);
            answers[qid] = { type: 'choice', choice: want, probabilities, confidence: 0.9 };
          } else {
            answers[qid] = { type: 'noul', noul: noulProb };
          }
        }
        return new Response(
          JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 10 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch;
    }

    async function captureStep1AttrScenario(
      flavorGoldState: 'no-fit' | 'insufficient-evidence',
      flavorChoice: { kind: 'code'; code: string; prob: number } | { kind: 'first'; prob: number },
    ): Promise<{ candidateCorrect: number; candidate: QualificationGoldEntry['candidate'] }> {
      const entry = step1Entry('STEP1-ATTR-01', {
        productType: { kind: 'no-fit', typeId: null },
        fieldAssignments: [{ targetId: 'flavor', state: flavorGoldState }],
        categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
      }, 'Acme generic goods parcel');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = mockStep1Fetch(flavorChoice, 0.1);
      try {
        const artifact = await captureGuardedJevForTest(
          [entry], { jev: { apiKey: 'test-key-12345678' } }, step1Taxa(),
        );
        const p = artifact.predictions.find(x => x.sku === entry.sku)!;
        const goldset: QualificationGoldset = {
          version: 1, description: 't', adjudicatedBy: 't',
          entries: [{ ...entry, gold: entry.gold, evidence: entry.evidence, baseline: { ...p.baseline }, candidate: { ...p.candidate } }],
        };
        const report = evaluateJevOfflineComparison(goldset);
        return { candidateCorrect: report.attributes.rawCorrectness.candidate, candidate: p.candidate };
      } finally {
        globalThis.fetch = fetchBefore;
      }
    }

    it('credits coded no-match vs insufficient-evidence but never wrong/uncoded/low-probability refusals (live capture)', async () => {
      // Same empty value set in every scenario — only the coded proof differs.
      const matched = await captureStep1AttrScenario('no-fit', { kind: 'code', code: 'no_match', prob: 0.9 });
      expect(matched.candidateCorrect).toBe(1);
      expect(matched.candidate.fieldAssignments).toContainEqual(
        { targetId: 'flavor', outcome: 'abstained-semantic', abstentionCode: 'no_match', probability: 0.9 },
      );

      const insuff = await captureStep1AttrScenario('insufficient-evidence', { kind: 'code', code: 'insufficient_evidence', prob: 0.9 });
      expect(insuff.candidateCorrect).toBe(1);

      const wrongCode = await captureStep1AttrScenario('no-fit', { kind: 'code', code: 'insufficient_evidence', prob: 0.9 });
      expect(wrongCode.candidateCorrect).toBe(0);

      const uncoded = await captureStep1AttrScenario('no-fit', { kind: 'first', prob: 0.1 });
      expect(uncoded.candidateCorrect).toBe(0);

      const lowProb = await captureStep1AttrScenario('no-fit', { kind: 'code', code: 'no_match', prob: 0.2 });
      expect(lowProb.candidateCorrect).toBe(0);
    });

    it('never credits Noul silence as semantic abstention (live capture)', async () => {
      const entry = step1Entry('STEP1-NOUL-01', {
        productType: { kind: 'known-type', typeId: 'dog_food_dry' },
        fieldAssignments: [
          { targetId: 'animal_type', state: 'no-fit' },
          { targetId: 'flavor', state: 'unlabeled' },
        ],
        categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
      }, 'Acme generic goods parcel');
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = mockStep1Fetch({ kind: 'code', code: 'no_match', prob: 0.9 }, 0.1);
      try {
        const artifact = await captureGuardedJevForTest(
          [entry], { jev: { apiKey: 'test-key-12345678' } }, step1Taxa(),
        );
        const p = artifact.predictions.find(x => x.sku === entry.sku)!;
        // Noul silence is unresolved, never abstained-semantic: the shipped
        // policy's actual code rides along but only an abstained-semantic
        // outcome can ever credit no-fit/insufficient-evidence gold.
        expect(p.candidate.fieldAssignments).toContainEqual(
          { targetId: 'animal_type', outcome: 'unresolved', abstentionCode: 'no_match', probability: null,
            candidateProbabilities: { dog: 0.1, cat: 0.1 }, probabilityDigest: expect.any(String) },
        );
        const goldset: QualificationGoldset = {
          version: 1, description: 't', adjudicatedBy: 't',
          entries: [{ ...entry, evidence: entry.evidence, baseline: { ...p.baseline }, candidate: { ...p.candidate } }],
        };
        expect(evaluateJevOfflineComparison(goldset).attributes.rawCorrectness.candidate).toBe(0);
      } finally {
        globalThis.fetch = fetchBefore;
      }
    });

    it('evaluates known-empty pages with extras penalized; partial/unknown excluded (executed floor)', () => {
      const snippet = 'Acme Dry Dog Food Xylophone Gadget kibble';
      const taxa = { ...step1Taxa(), pages: [{ pageId: 'page-x', pageName: 'Xylophone Gadget' }] };
      const entries = (['known', 'partial', 'unknown'] as const).map((marker, i) => step1Entry(`STEP1-PAGE-0${i}`, {
        productType: { kind: 'known-type', typeId: 'dog_food_dry' },
        fieldAssignments: [],
        categoryPages: marker === 'known'
          ? { pageIds: [], pageAssignments: [], state: 'known' as const, completeness: 'complete' as const }
          : marker === 'partial'
            ? { pageIds: ['page-x'], pageAssignments: [{ pageId: 'page-x', pageName: 'Xylophone Gadget' }], state: 'partial' as const, completeness: 'partial' as const }
            : { pageIds: [], pageAssignments: [], state: 'unknown' as const, completeness: 'unknown' as const },
      }, snippet));
      const artifact = buildQualificationPredictionsFromCode(entries, taxa);
      const goldset: QualificationGoldset = {
        version: 1, description: 't', adjudicatedBy: 't',
        entries: entries.map(e => {
          const p = artifact.predictions.find(x => x.sku === e.sku)!;
          return { ...e, evidence: e.evidence, baseline: { ...p.baseline }, candidate: { ...p.candidate } };
        }),
      };
      const report = evaluateJevOfflineComparison(goldset);
      // Only the known-empty entry evaluates; the floor's predicted extra is incorrect (not skipped).
      expect(report.categoryPages.rawCorrectness.baseline).toBe(0);
      expect(report.categoryPages.incorrectProposals.baseline).toBe(1);
    });

    it('scores type-unlabeled but attr-known gold from the executed floor (independent of type labeling)', () => {
      const entry = step1Entry('STEP1-UNLABELED-01', {
        productType: { kind: 'unlabeled', typeId: null },
        fieldAssignments: [
          { targetId: 'flavor', value: 'Chicken', state: 'known' },
          { targetId: 'animal_type', values: ['dog'], state: 'known' },
        ],
        categoryPages: { pageIds: [], pageAssignments: [] },
      }, 'Acme Chicken Dry Dog Food casserole');
      const artifact = buildQualificationPredictionsFromCode([entry], step1Taxa());
      const p = artifact.predictions[0];
      const goldset: QualificationGoldset = {
        version: 1, description: 't', adjudicatedBy: 't',
        entries: [{ ...entry, evidence: entry.evidence, baseline: { ...p.baseline }, candidate: { ...p.candidate } }],
      };
      expect(evaluateJevOfflineComparison(goldset).attributes.rawCorrectness.baseline).toBe(1);
    });

    it('keeps legacy marker-less bytes readable but refuses them at qualification; invalid states throw', () => {
      const parsed = parseQualificationGoldOnly({ entries: [step1Entry('STEP1-LEGACY-01', {
        productType: { kind: 'known-type', typeId: 'dog_food_dry' },
        fieldAssignments: [{ targetId: 'flavor', value: 'Chicken' } as never],
        categoryPages: { pageIds: [], pageAssignments: [] },
      }, 'Acme Chicken casserole')] });
      expect(parsed).toHaveLength(1);
      const goldset: QualificationGoldset = {
        version: 1, description: 't', adjudicatedBy: 't',
        entries: parsed.map(e => ({
          ...e, split: 'holdout' as const,
          baseline: { productType: 'dog_food_dry', abstained: false, fieldAssignments: [{ targetId: 'flavor', value: 'Chicken' }], pageIds: [], confidence: 0.9 },
          candidate: { productType: 'dog_food_dry', abstained: false, fieldAssignments: [{ targetId: 'flavor', value: 'Chicken' }], pageIds: [], confidence: 0.9 },
        })),
      };
      const gate = evaluateJevQualificationGate(goldset, { predictionSource: 'prereview_raw', bundleVersion: 1, snapshotMatched: true });
      expect(gate.qualified).toBe(false);
      expect(gate.reasons.some(r => r.startsWith('incomplete_gold_contract'))).toBe(true);
      expect(() => parseQualificationGoldOnly({ entries: [step1Entry('STEP1-BAD-01', {
        productType: { kind: 'known-type', typeId: 't' },
        fieldAssignments: [{ targetId: 'flavor', state: 'bogus' }],
        categoryPages: { pageIds: [], pageAssignments: [] },
      }, 'x')] })).toThrow();
    });

    it('never credits partial/unknown pages end-to-end; exposes eligible/unevaluated (floor capture)', () => {
      // DEV-pilot regression: 25 entries with partial/unknown page gold showed
      // outer pages 0 eligible yet endToEndPipeline pages-match 11. A predicted
      // subset that equals known page ids must NOT earn exact-match when the
      // gold was only partially adjudicated.
      const taxa = { ...step1Taxa(), pages: [{ pageId: 'page-x', pageName: 'Xylophone Gadget' }] };
      const snippet = 'Acme Chicken Dry Dog Food Xylophone Gadget kibble';
      const fields = [
        { targetId: 'flavor', value: 'Chicken', state: 'known' },
        { targetId: 'animal_type', values: ['dog'], state: 'known' },
      ];
      const entries = [
        step1Entry('STEP1-E2E-01', {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: fields,
          categoryPages: { pageIds: ['page-x'], pageAssignments: [{ pageId: 'page-x', pageName: 'Xylophone Gadget' }], state: 'known' as const, completeness: 'complete' as const },
        }, snippet),
        step1Entry('STEP1-E2E-02', {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: fields,
          categoryPages: { pageIds: ['page-x'], pageAssignments: [{ pageId: 'page-x', pageName: 'Xylophone Gadget' }], state: 'partial' as const, completeness: 'partial' as const },
        }, snippet),
        step1Entry('STEP1-E2E-03', {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: fields,
          categoryPages: { pageIds: [], pageAssignments: [], state: 'unknown' as const, completeness: 'unknown' as const },
        }, snippet),
        step1Entry('STEP1-E2E-04', {
          productType: { kind: 'unlabeled', typeId: null },
          fieldAssignments: fields,
          categoryPages: { pageIds: [], pageAssignments: [] },
        }, snippet),
      ];
      const artifact = buildQualificationPredictionsFromCode(entries, taxa);
      const goldset: QualificationGoldset = {
        version: 1, description: 't', adjudicatedBy: 't',
        entries: entries.map(e => {
          const p = artifact.predictions.find(x => x.sku === e.sku)!;
          // Score the executed floor values on both sides (captured output, not hand-authored).
          return { ...e, evidence: e.evidence, baseline: { ...p.baseline }, candidate: { ...p.baseline } };
        }),
      };
      const report = evaluateJevOfflineComparison(goldset);
      const pipeline = report.endToEndPipeline;
      // The partial entry predicts the known subset exactly yet earns nothing.
      expect(pipeline.pageEffects.exactMatchWhenTypeCorrect).toBe(1);
      expect(pipeline.pageEffects.eligible).toBe(2);
      expect(pipeline.pageEffects.unevaluated).toBe(2);
      expect(pipeline.pageEffects.failed).toBe(0);
      // Only the fully-known entry is all-stages correct.
      expect(pipeline.endToEndCorrectAllStages).toBe(1);
      // Type-unlabeled entry: attributes still score, type unevaluated, never end-to-end.
      expect(pipeline.typeResolution.unevaluated).toBe(1);
      expect(pipeline.attributeEffects.eligible).toBe(8);
      expect(pipeline.attributeEffects.unevaluated).toBe(0);
    });

    it('reports not-evaluated (never 0%-wrong) when no page gold is completely adjudicated', () => {
      const entries = ['STEP1-NE-01', 'STEP1-NE-02'].map((sku, i) => qualEntry({
        sku,
        gold: {
          productType: { kind: 'known-type', typeId: 't' },
          fieldAssignments: [],
          categoryPages: i === 0
            ? { pageIds: ['page-x'], pageAssignments: [{ pageId: 'page-x', pageName: 'X' }], state: 'partial', completeness: 'partial' }
            : { pageIds: [], pageAssignments: [], state: 'unknown', completeness: 'unknown' },
        },
        candidate: { productType: 't', abstained: false, fieldAssignments: [], pageIds: ['page-x'], confidence: 0.9 },
      }));
      const report = evaluateJevOfflineComparison(qualGoldset(entries));
      // Dry-JSON shape carries the status; the misleading 0.0% lines are a presentation concern only.
      const dryJson = JSON.parse(JSON.stringify(report));
      expect(dryJson.categoryPages.evaluation).toEqual({ eligible: 0, unevaluated: 2, status: 'not_evaluated' });
      expect(dryJson.categoryPages.rawCorrectness.candidate).toBe(0);
      expect(evaluationStatusText(report.categoryPages.evaluation, 'page sets'))
        .toBe('not evaluated (0 complete adjudicated page sets)');
      expect(measuredPercent(report.categoryPages.rawCorrectness.candidate, report.categoryPages.evaluation)).toBe('n/a');
      expect(measuredPercent(0.955, { eligible: 25, unevaluated: 0, status: 'measured' })).toBe('95.5%');
      expect(evaluationStatusText(report.attributes.evaluation, 'attribute targets'))
        .toBe('not evaluated (0 complete adjudicated attribute targets)');
    });

    it('reports type not-evaluated for unlabeled-only gold without weakening the gate', () => {
      const entries = [qualEntry({
        sku: 'STEP1-NE-TYPE-01',
        gold: {
          productType: { kind: 'unlabeled', typeId: null },
          fieldAssignments: [{ targetId: 'flavor', value: 'Chicken', state: 'known' }],
          categoryPages: { pageIds: [], pageAssignments: [] },
        },
      })];
      const report = evaluateJevOfflineComparison(qualGoldset(entries));
      expect(report.productType.evaluation).toEqual({ eligible: 0, unevaluated: 1, status: 'not_evaluated' });
      expect(evaluationStatusText(report.productType.evaluation, 'product type labels'))
        .toBe('not evaluated (0 complete adjudicated product type labels)');
      // Empty qualifying gold still cannot qualify.
      const gate = evaluateJevQualificationGate(qualGoldset(entries), { predictionSource: 'prereview_raw', bundleVersion: 1, snapshotMatched: true });
      expect(gate.qualified).toBe(false);
    });

    it('rejects malformed v2 field value shapes before any scoring (actual species pattern)', () => {
      const malformed = (field: unknown) => ({
        entries: [step1Entry('STEP1-SHAPE-01', {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: [field as never],
          categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
        } as never, 'Acme kibble')],
      });
      // Actual v2 development pattern: array in the scalar slot.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: ['Dog', 'Cat'] }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: ['Dog'] }))).toThrow();
      // Scalar slot takes objects/numbers/blanks; values slot takes nested/non-string/empty.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: 42 }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: { v: 'Dog' } }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', values: ['Dog', 42] }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', values: [] }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', values: 'Dog' }))).toThrow();
      // Both slots together conflict, even when each is well-typed.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: 'Dog', values: ['Dog'] }))).toThrow();
      // Known with neither slot is accidental, not an explicit empty.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known' }))).toThrow();
      // Non-known states cannot assign values.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'no-fit', values: ['Dog'] }))).toThrow();
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'unlabeled', value: 'Dog' }))).toThrow();
      // Unknown reader versions fail closed (never silently tolerated).
      const flaggedUnknown = malformed({ targetId: 'species', state: 'known', value: ['Dog'] });
      (flaggedUnknown.entries[0] as unknown as Record<string, unknown>).readerVersion = 'v9';
      expect(() => parseQualificationGoldOnly(flaggedUnknown)).toThrow();
      // A malformed prototype can never reach scoring to fake a passed result.
      expect(() => parseQualificationGoldOnly(malformed({ targetId: 'species', state: 'known', value: ['Dog', 'Cat'] }))).toThrow();
    });

    it('accepts canonical scalar XOR nonempty values; legacy stays readable but ineligible', () => {
      const shape = (field: unknown) => ({
        entries: [step1Entry('STEP1-SHAPE-02', {
          productType: { kind: 'known-type', typeId: 'dog_food_dry' },
          fieldAssignments: [field as never],
          categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
        } as never, 'Acme kibble')],
      });
      expect(parseQualificationGoldOnly(shape({ targetId: 'species', state: 'known', value: 'Dog' }))).toHaveLength(1);
      expect(parseQualificationGoldOnly(shape({ targetId: 'species', state: 'known', values: ['Dog', 'Cat'] }))).toHaveLength(1);
      // Explicit legacy reader version: old bytes parse but never qualify.
      const legacyRaw = shape({ targetId: 'species', state: 'no-fit', values: ['Dog'] });
      (legacyRaw.entries[0] as unknown as Record<string, unknown>).readerVersion = 'legacy';
      const parsed = parseQualificationGoldOnly(legacyRaw);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].readerVersion).toBe('legacy');
      const goldset: QualificationGoldset = {
        version: 1, description: 't', adjudicatedBy: 't',
        entries: parsed.map(e => ({
          ...e, split: 'holdout' as const,
          baseline: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0 },
          candidate: { productType: null, abstained: true, fieldAssignments: [], pageIds: [], confidence: 0 },
        })),
      };
      const gate = evaluateJevQualificationGate(goldset, { predictionSource: 'prereview_raw', bundleVersion: 1, snapshotMatched: true });
      expect(gate.qualified).toBe(false);
      expect(gate.reasons.some(r => r.startsWith('incomplete_gold_contract'))).toBe(true);
      // Root-level legacy flag covers whole old fixtures the same way.
      const rootLegacy = shape({ targetId: 'species', state: 'known', value: ['Dog'] });
      (rootLegacy as unknown as Record<string, unknown>).readerVersion = 'legacy';
      const rootParsed = parseQualificationGoldOnly(rootLegacy);
      expect(rootParsed[0].readerVersion).toBe('legacy');
    });

    it('binds coded outcome metadata into the artifact hash without leaking gold labels', () => {
      const taxa = step1Taxa();
      const goldA: QualificationGoldOnlyEntry['gold'] = {
        productType: { kind: 'known-type', typeId: 'dog_food_dry' },
        fieldAssignments: [{ targetId: 'flavor', value: 'Chicken', state: 'known' }],
        categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
      };
      const goldB: QualificationGoldOnlyEntry['gold'] = {
        productType: { kind: 'known-type', typeId: 'dog_food_dry' },
        fieldAssignments: [{ targetId: 'flavor', value: 'Beef', state: 'known' }],
        categoryPages: { pageIds: [], pageAssignments: [], state: 'known', completeness: 'complete' },
      };
      const a = buildQualificationPredictionsFromCode([step1Entry('STEP1-HASH-01', goldA, 'Acme Chicken Dry Dog Food casserole')], taxa);
      const b = buildQualificationPredictionsFromCode([step1Entry('STEP1-HASH-01', goldB, 'Acme Chicken Dry Dog Food casserole')], taxa);
      // Identical evidence → identical predictions + hash: gold labels never leak in.
      // (latencyMs is wall-clock telemetry excluded from the hash by design; normalize it for the equality proof.)
      expect(a.artifactHash).toBe(b.artifactHash);
      const withoutLatency = (predictions: typeof a.predictions) =>
        predictions.map(p => ({
          ...p,
          baseline: { ...p.baseline, latencyMs: 0 },
          candidate: { ...p.candidate, latencyMs: 0 },
        }));
      expect(withoutLatency(a.predictions)).toEqual(withoutLatency(b.predictions));
      const c = buildQualificationPredictionsFromCode([step1Entry('STEP1-HASH-01', goldA, 'Acme Beef Dry Dog Food stew')], taxa);
      expect(c.artifactHash).not.toBe(a.artifactHash);
      expect(a.predictorVersion).toBe(QUALIFICATION_PREDICTOR_VERSION);
    });
  });
});
