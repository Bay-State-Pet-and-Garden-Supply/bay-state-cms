import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import {
  evaluateBenchmark,
  computeEvaluatorAttribution,
  EVALUATOR_GOLD_STATE_KNOWN,
  EVALUATOR_GOLD_STATE_NO_FIT,
  EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
  EVALUATOR_GOLD_STATE_UNLABELED,
  type GoldExampleForEvaluation,
} from '../../classification/benchmark-evaluator';
import {
  buildPredictionBundle,
} from '../../classification/benchmark-prediction';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';

const workspaceId = 'ws-eval-test';
const CONFIG_HASH = 'b'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-eval-1';

describe('Benchmark Evaluator', () => {
  let wsPath: string;
  let dbPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `eval-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();

    const db = getDb();
    try {
      db.run(
        `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
         VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
        [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
      );
    } catch { /* row may already exist on re-init */ }
    getDb().run(
      `INSERT INTO classification_config_snapshots
         (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  function seedProductRun(sku: string, proposedType: string, proposedPages: string[], isAbstained = false) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();

    if (isAbstained) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'reviewable_abstention', 'null', 0, 'pending', ?)`,
        [randomUUID(), run.id, sku, now]
      );
    } else {
      if (proposedType) {
        db.run(
          `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
           VALUES (?, ?, ?, 'primary_product_type', ?, 0.9, 'accepted', ?)`,
          [randomUUID(), run.id, sku, JSON.stringify(proposedType), now]
        );
        const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?').get(run.id, 'primary_product_type') as { id: string };
        const decisionId = randomUUID();
        db.run(
          `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
           VALUES (?, ?, 'accepted', NULL, 0, ?)`,
          [decisionId, pid.id, now]
        );
      }
      for (const page of proposedPages) {
        db.run(
          `INSERT INTO classification_proposals (id, run_id, product_sku, target_id, proposal_type, proposed_value_json, confidence, status, created_at)
           VALUES (?, ?, ?, ?, 'category_page', ?, 0.8, 'accepted', ?)`,
          [randomUUID(), run.id, sku, page, JSON.stringify(page), now]
        );
        const pagePid = db.query('SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ? AND target_id = ?').get(run.id, 'category_page', page) as { id: string };
        const pageDecisionId = randomUUID();
        db.run(
          `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
           VALUES (?, ?, 'accepted', NULL, 0, ?)`,
          [pageDecisionId, pagePid.id, now]
        );
      }
    }

    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function prepareFrozenDataset(name: string, examples: Array<{ sku: string; family: string; split: 'train' | 'test' | 'holdout'; gold: unknown }>): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, name, 'product_family', 42);
    for (const example of examples) {
      benchmarkRepo.insertExample(
        dataset.id,
        example.sku,
        example.family,
        example.split,
        JSON.stringify({ evidence: [{ snippet: `${example.sku} product` }] }),
        JSON.stringify(example.gold),
      );
    }
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer-1');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer-1');
    return dataset.id;
  }

  it('should evaluate metrics from a frozen dataset + persisted prediction bundle', async () => {
    seedProductRun('SKU-1', 'Dog Food Dry', []);
    seedProductRun('SKU-2', 'Cat Food', []);

    const datasetId = prepareFrozenDataset('Test Dataset', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food Dry', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'SKU-2', family: 'fam-2', split: 'test', gold: { productType: 'Cat Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Predictions', splitGroup: 'test' });
    expect(bundle.predictions.length).toBe(2);

    const { metrics, qualification, predictionBundleId } = await evaluateBenchmark(datasetId, {
      runLabel: 'Test Eval',
      splitGroup: 'test',
      predictionBundleId: bundle.id,
    });

    expect(metrics.productType.top1Accuracy).toBe(1);
    expect(metrics.productType.coverage).toBe(1);
    expect(metrics.safety.crossSpeciesCount).toBe(0);
    expect(metrics.abstention.abstainedPercent).toBe(0);
    expect(predictionBundleId).toBe(bundle.id);
    // Limited population cannot qualify production ML.
    expect(qualification.qualified).toBe(false);
    expect(qualification.reasons.some(r => r.startsWith('insufficient_sample'))).toBe(true);
  });

  it('should detect cross-species violations', async () => {
    // Run predicts a Cat page for a dog product.
    seedProductRun('DOG-1', 'Dog Food', ['Cat Food Dry']);
    seedProductRun('DOG-2', 'Dog Food', []);

    const datasetId = prepareFrozenDataset('Species Test', [
      { sku: 'DOG-1', family: 'fam-dog', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'DOG-2', family: 'fam-dog', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Cross Species', splitGroup: 'test' });
    const { metrics } = await evaluateBenchmark(datasetId, { runLabel: 'Cross Species Eval', splitGroup: 'test', predictionBundleId: bundle.id });

    expect(metrics.safety.crossSpeciesCount).toBeGreaterThan(0);
  });

  it('reports blocked_missing_verified_page_gold when Page gold exists', async () => {
    const datasetId = prepareFrozenDataset('Page Gold Test', [
      {
        sku: 'SKU-P1',
        family: 'fam-p1',
        split: 'test',
        gold: { productType: 'Dog Food', pageAssignments: [{ pageName: 'Dog Food' }], fieldAssignments: [] },
      },
    ]);
    // No reviewed run exists for SKU-P1, so a bundle cannot be built — this
    // demonstrates the fail-closed prediction gate. For the blocked flag, we
    // evaluate a manually persisted bundle instead.
    const predictions = [{
      exampleId: '',
      productSku: 'SKU-P1',
      productType: 'Dog Food',
      pageAssignments: ['Dog Food'],
      fieldAssignments: [],
      abstained: false,
      confidence: 0.9,
      claimTargets: [],
    }];
    const goldExamples = benchmarkRepo.getExamples(datasetId, 'test');
    predictions[0].exampleId = goldExamples[0].id;

    const { computePredictionBundleHash, validatePredictionBundle } = await import('../../classification/benchmark-prediction');
    const bundleHash = computePredictionBundleHash(predictions);
    validatePredictionBundle(predictions, goldExamples.map(e => ({ id: e.id, productSku: e.product_sku })), bundleHash);
    benchmarkRepo.createPredictionBundle(datasetId, workspaceId, 'Manual', 'test', JSON.stringify(predictions), bundleHash);

    const { metrics } = await evaluateBenchmark(datasetId, { runLabel: 'Blocked Eval', splitGroup: 'test' });
    expect(metrics.pages.blocked).toBe(true);
    expect(metrics.pages.blockedReason).toBe('blocked_missing_verified_page_gold');
  });

  it('fails closed when no prediction bundle exists', async () => {
    const datasetId = prepareFrozenDataset('No Bundle', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);

    await expect(evaluateBenchmark(datasetId, { runLabel: 'Eval', splitGroup: 'test' })).rejects.toThrow(/No prediction bundle found/);
  });

  it('fails closed on a wrong-digest persisted bundle', async () => {
    const datasetId = prepareFrozenDataset('Wrong Digest', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food', pageAssignments: [], fieldAssignments: [] } },
    ]);
    benchmarkRepo.createPredictionBundle(datasetId, workspaceId, 'Bad', 'test', JSON.stringify([{
      exampleId: 'x',
      productSku: 'SKU-1',
      productType: 'Dog Food',
      pageAssignments: [],
      fieldAssignments: [],
      abstained: false,
      confidence: 0.9,
      claimTargets: [],
    }]), 'f'.repeat(64));

    await expect(evaluateBenchmark(datasetId, { runLabel: 'Eval', splitGroup: 'test' })).rejects.toThrow(/digest mismatch/);
  });

  it('produces deterministic paired bootstrap intervals for identical inputs', async () => {
    seedProductRun('SKU-1', 'Dog Food Dry', []);
    seedProductRun('SKU-2', 'Cat Food', []);

    const datasetId = prepareFrozenDataset('Bootstrap Test', [
      { sku: 'SKU-1', family: 'fam-1', split: 'test', gold: { productType: 'Dog Food Dry', pageAssignments: [], fieldAssignments: [] } },
      { sku: 'SKU-2', family: 'fam-2', split: 'test', gold: { productType: 'Cat Food', pageAssignments: [], fieldAssignments: [] } },
    ]);
    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'Bootstrap', splitGroup: 'test' });

    const first = await evaluateBenchmark(datasetId, { runLabel: 'Eval A', splitGroup: 'test', predictionBundleId: bundle.id });
    const second = await evaluateBenchmark(datasetId, { runLabel: 'Eval B', splitGroup: 'test', predictionBundleId: bundle.id });

    expect(first.metrics.pairedDelta.deltaLower95).toBe(second.metrics.pairedDelta.deltaLower95);
    expect(first.metrics.pairedDelta.deltaUpper95).toBe(second.metrics.pairedDelta.deltaUpper95);
    expect(first.metrics.pairedDelta.bootstrapRuns).toBeGreaterThan(0);
  });

  it('computes truthful fixed-population metrics across gold states and distinguishes failed calls from abstentions', () => {
    const gold: GoldExampleForEvaluation[] = [
      // 1. known-type: correct prediction
      {
        id: 'e1',
        productSku: 'SKU-1',
        goldLabels: { productType: 'dog_food_dry', pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_KNOWN,
        evidenceText: 'dog food',
      },
      // 2. known-type: incorrect prediction
      {
        id: 'e2',
        productSku: 'SKU-2',
        goldLabels: { productType: 'cat_food_wet', pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_KNOWN,
        evidenceText: 'cat food',
      },
      // 3. known-type: semantic abstention
      {
        id: 'e3',
        productSku: 'SKU-3',
        goldLabels: { productType: 'dog_toy', pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_KNOWN,
        evidenceText: 'chew bone',
      },
      // 4. no-fit: explicit semantic abstention -> correct (correct abstention)
      {
        id: 'e4',
        productSku: 'SKU-4',
        goldLabels: { productType: null, pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_NO_FIT,
        evidenceText: 'reptile lamp',
      },
      // 5. no-fit: service/validation failure -> failed (failed calls CANNOT earn abstention correctness)
      {
        id: 'e5',
        productSku: 'SKU-5',
        goldLabels: { productType: null, pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_NO_FIT,
        evidenceText: 'reptile fogger',
      },
      // 6. insufficient-evidence: explicit semantic abstention -> correct
      {
        id: 'e6',
        productSku: 'SKU-6',
        goldLabels: { productType: null, pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
        evidenceText: '',
      },
      // 7. insufficient-evidence: incorrect forced prediction -> incorrect
      {
        id: 'e7',
        productSku: 'SKU-7',
        goldLabels: { productType: null, pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_INSUFFICIENT_EVIDENCE,
        evidenceText: 'unclear',
      },
      // 8. unlabeled target -> excluded from fixed population
      {
        id: 'e8',
        productSku: 'SKU-8',
        goldLabels: { productType: null, pageAssignments: [], fieldAssignments: [] },
        goldState: EVALUATOR_GOLD_STATE_UNLABELED,
        evidenceText: 'pending review',
      },
    ];

    const predictions: any[] = [
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'dog_food_dry', outcome: 'predicted' },
      { exampleId: 'e2', productSku: 'SKU-2', productType: 'dog_food_wet', outcome: 'predicted' },
      { exampleId: 'e3', productSku: 'SKU-3', productType: null, abstained: true, outcome: 'abstained' },
      { exampleId: 'e4', productSku: 'SKU-4', productType: null, abstained: true, outcome: 'abstained' },
      { exampleId: 'e5', productSku: 'SKU-5', productType: null, outcome: 'failed', failureCode: 'call_failed' },
      { exampleId: 'e6', productSku: 'SKU-6', productType: null, abstained: true, outcome: 'abstained' },
      { exampleId: 'e7', productSku: 'SKU-7', productType: 'some_random_type', outcome: 'predicted' },
      { exampleId: 'e8', productSku: 'SKU-8', productType: 'dog_toy', outcome: 'predicted' },
    ];

    const report = computeEvaluatorAttribution(gold, predictions, { splitGroup: 'test', requiredClassSupport: 1 });

    // Gold state breakdown
    expect(report.goldStates.known).toBe(3);
    expect(report.goldStates.noFit).toBe(2);
    expect(report.goldStates.insufficientEvidence).toBe(2);
    expect(report.goldStates.unlabeled).toBe(1);

    // Fixed population: e8 (unlabeled) is EXCLUDED.
    // Eligible total = 7 (e1 through e7).
    const fp = report.fixedPopulation;
    expect(fp.eligible).toBe(7);
    // Correct: e1 (known match) + e4 (no-fit abstained) + e6 (insufficient-evidence abstained) = 3
    expect(fp.correct).toBe(3);
    expect(fp.correctAbstentions).toBe(2);
    // Incorrect: e2 (mismatch) + e7 (forced prediction on insufficient-evidence) = 2
    expect(fp.incorrect).toBe(2);
    // Honest abstention on known type: e3 = 1
    expect(fp.abstainedSemantic).toBe(1);
    // Failed: e5 (call failure cannot earn abstention correctness) = 1
    expect(fp.failed).toBe(1);
    expect(report.failedPredictions.length).toBe(1);
    expect(report.failedPredictions[0].exampleId).toBe('e5');
    expect(report.failedPredictions[0].failureCode).toBe('call_failed');

    // Rates:
    // correctness = correct / eligible = 3/7
    expect(fp.correctness).toBeCloseTo(3 / 7, 4);
    // errorRate = incorrect / eligible = 2/7
    expect(fp.errorRate).toBeCloseTo(2 / 7, 4);
    // coverage = (eligible - failed - missing) / eligible = 6/7
    expect(fp.coverage).toBeCloseTo(6 / 7, 4);
    // conditional accuracy = correct / (correct + incorrect + abstainedSemantic) = 3 / 6 = 0.5
    expect(fp.conditionalAccuracy).toBeCloseTo(3 / 6, 4);
  });

  it('compares candidate against baseline, tracking recovered abstentions, harmed successes, dual abstentions, and coverage shift', () => {
    const gold: GoldExampleForEvaluation[] = [
      { id: 'e1', productSku: 'S1', goldLabels: { productType: 'T1', pageAssignments: [], fieldAssignments: [] }, goldState: EVALUATOR_GOLD_STATE_KNOWN, evidenceText: '' },
      { id: 'e2', productSku: 'S2', goldLabels: { productType: 'T2', pageAssignments: [], fieldAssignments: [] }, goldState: EVALUATOR_GOLD_STATE_KNOWN, evidenceText: '' },
      { id: 'e3', productSku: 'S3', goldLabels: { productType: 'T3', pageAssignments: [], fieldAssignments: [] }, goldState: EVALUATOR_GOLD_STATE_KNOWN, evidenceText: '' },
      { id: 'e4', productSku: 'S4', goldLabels: { productType: 'T4', pageAssignments: [], fieldAssignments: [] }, goldState: EVALUATOR_GOLD_STATE_KNOWN, evidenceText: '' },
    ];

    // Baseline:
    // e1: abstained
    // e2: correct (T2)
    // e3: correct (T3)
    // e4: abstained
    const baseline: any[] = [
      { exampleId: 'e1', productSku: 'S1', productType: null, abstained: true, outcome: 'abstained' },
      { exampleId: 'e2', productSku: 'S2', productType: 'T2', outcome: 'predicted' },
      { exampleId: 'e3', productSku: 'S3', productType: 'T3', outcome: 'predicted' },
      { exampleId: 'e4', productSku: 'S4', productType: null, abstained: true, outcome: 'abstained' },
    ];

    // Candidate:
    // e1: correct (T1) -> recovered baseline abstention!
    // e2: incorrect ('WRONG') -> harmed baseline success!
    // e3: correct (T3) -> retained success!
    // e4: abstained -> dual abstention!
    const candidate: any[] = [
      { exampleId: 'e1', productSku: 'S1', productType: 'T1', outcome: 'predicted' },
      { exampleId: 'e2', productSku: 'S2', productType: 'WRONG', outcome: 'predicted' },
      { exampleId: 'e3', productSku: 'S3', productType: 'T3', outcome: 'predicted' },
      { exampleId: 'e4', productSku: 'S4', productType: null, abstained: true, outcome: 'abstained' },
    ];

    const report = computeEvaluatorAttribution(gold, candidate, {
      splitGroup: 'test',
      baselinePredictions: baseline,
    });

    const comp = report.baselineComparison;
    expect(comp).not.toBeNull();
    expect(comp!.recoveredBaselineAbstentions).toBe(1);
    expect(comp!.recoveredExampleIds).toEqual(['e1']);
    expect(comp!.harmedBaselineSuccesses).toBe(1);
    expect(comp!.harmedExampleIds).toEqual(['e2']);
    expect(comp!.retainedSuccesses).toBe(1);
    expect(comp!.dualAbstentions).toBe(1);
    expect(comp!.dualAbstainedExampleIds).toEqual(['e4']);

    // Overlap-only paired deltas cannot conceal coverage shifts:
    expect(comp!.candidateCoverage).toBe(1);
    expect(comp!.baselineCoverage).toBe(1);
    expect(comp!.coverageShift).toBe(0);
  });

  it('detects family leakage across splits and snapshot mismatches', () => {
    const gold: GoldExampleForEvaluation[] = [
      {
        id: 'e1',
        productSku: 'S1',
        goldLabels: { productType: 'T1', pageAssignments: [], fieldAssignments: [] },
        evidenceText: '',
        familyId: 'fam-leaking',
        splitGroup: 'test',
        sourceProductHash: 'hash-aaa',
      },
    ];

    const predictions: any[] = [
      {
        exampleId: 'e1',
        productSku: 'S1',
        productType: 'T1',
        outcome: 'predicted',
        provenance: { sourceProductHash: 'hash-bbb' },
      },
    ];

    const allSplitExamples = [
      { familyId: 'fam-leaking', splitGroup: 'test' },
      { familyId: 'fam-leaking', splitGroup: 'holdout' },
    ];

    const report = computeEvaluatorAttribution(gold, predictions, {
      splitGroup: 'test',
      allSplitExamples,
    });

    expect(report.familyLeakage.leaked).toBe(true);
    expect(report.familyLeakage.findings.length).toBe(1);
    expect(report.familyLeakage.findings[0].familyId).toBe('fam-leaking');

    expect(report.snapshotMismatches.length).toBe(1);
    expect(report.snapshotMismatches[0].exampleId).toBe('e1');
    expect(report.snapshotMismatches[0].field).toBe('sourceProductHash');
    expect(report.snapshotMismatches[0].goldValue).toBe('hash-aaa');
    expect(report.snapshotMismatches[0].predictionValue).toBe('hash-bbb');
  });
});
