import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import benchmarkRoutes from '../../server/routes/benchmark-routes';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import { createRun } from '../../db/repositories/classification-run-repo';
import {
  PRE_REVIEW_PREDICTION_SOURCE,
  REVIEWED_OUTCOME_PREDICTION_SOURCE,
  PRE_REVIEW_BUNDLE_VERSION,
  LEGACY_BUNDLE_VERSION,
} from '../../classification/benchmark-prediction';

const workspaceId = 'ws-benchmark-routes-test';
const CONFIG_HASH = 'e'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-routes-1';

describe('Benchmark HTTP routes', () => {
  let wsPath: string;
  let app: Hono;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `bench-routes-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();

    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Test Store', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()],
    );

    getDb().run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()],
    );

    app = new Hono();
    app.route('/api', benchmarkRoutes);
  });

  afterEach(() => {
    closeDb();
    try {
      fs.rmSync(wsPath, { recursive: true, force: true });
    } catch {
      /* ignore cleanup error */
    }
  });

  function seedRun(sku: string, productType: string, confidence = 0.9) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    const pid = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', ?, ?, ?, 'accepted', ?)`,
      [pid, run.id, sku, productType, JSON.stringify({ productTypeId: productType }), confidence, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', NULL, 0, ?)`,
      [randomUUID(), pid, now],
    );
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function setupFrozenDataset(): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Routes Eval Dataset', 'product_family', 42);
    benchmarkRepo.insertExample(
      dataset.id,
      'SKU-DOG',
      'fam-dog',
      'holdout',
      JSON.stringify({ sku: 'SKU-DOG', evidence: [{ snippet: 'Organic Dog Kibble' }] }),
      JSON.stringify({ productType: 'dog_food_dry', pageAssignments: [], fieldAssignments: [] }),
      { sourceConfigHash: CONFIG_HASH },
    );
    benchmarkRepo.insertExample(
      dataset.id,
      'SKU-CAT',
      'fam-cat',
      'holdout',
      JSON.stringify({ sku: 'SKU-CAT', evidence: [{ snippet: 'Crunchy Cat Treats' }] }),
      JSON.stringify({ productType: 'cat_treat', pageAssignments: [], fieldAssignments: [] }),
      { sourceConfigHash: CONFIG_HASH },
    );
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer-test');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer-test');
    return dataset.id;
  }

  it('POST /api/benchmark/datasets/:id/predict builds pre-review bundle when source is prereview_raw', async () => {
    seedRun('SKU-DOG', 'dog_food_dry');
    seedRun('SKU-CAT', 'cat_treat');
    const datasetId = setupFrozenDataset();

    const res = await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runLabel: 'PreReview Predictions',
        splitGroup: 'holdout',
        source: PRE_REVIEW_PREDICTION_SOURCE,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundleId: string;
      datasetId: string;
      splitGroup: string;
      predictionCount: number;
      bundleHash: string;
      source: string;
      bundleVersion: number;
    };
    expect(json.datasetId).toBe(datasetId);
    expect(json.predictionCount).toBe(2);
    expect(json.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
    expect(json.bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
    expect(json.bundleHash).toBeTruthy();
  });

  it('POST /api/benchmark/datasets/:id/predict builds legacy bundle when source is reviewed_outcome or omitted', async () => {
    seedRun('SKU-DOG', 'dog_food_dry');
    seedRun('SKU-CAT', 'cat_treat');
    const datasetId = setupFrozenDataset();

    const res = await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runLabel: 'Legacy Predictions',
        splitGroup: 'holdout',
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      bundleId: string;
      source: string;
      bundleVersion: number;
    };
    expect(json.source).toBe(REVIEWED_OUTCOME_PREDICTION_SOURCE);
    expect(json.bundleVersion).toBe(LEGACY_BUNDLE_VERSION);
  });

  it('GET /api/benchmark/datasets/:id exposes source provenance and qualification eligibility in predictionBundles', async () => {
    seedRun('SKU-DOG', 'dog_food_dry');
    seedRun('SKU-CAT', 'cat_treat');
    const datasetId = setupFrozenDataset();

    // Build one pre-review bundle and one legacy bundle
    await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runLabel: 'Raw Run', splitGroup: 'holdout', source: PRE_REVIEW_PREDICTION_SOURCE }),
    });
    await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runLabel: 'Reviewed Run', splitGroup: 'holdout' }),
    });

    const res = await app.request(`/api/benchmark/datasets/${datasetId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      predictionBundles: Array<{
        id: string;
        runLabel: string;
        source: string;
        bundleVersion: number;
        eligibleForRawAccuracyQualification: boolean;
      }>;
    };

    expect(data.predictionBundles.length).toBe(2);
    const rawBundle = data.predictionBundles.find(b => b.source === PRE_REVIEW_PREDICTION_SOURCE);
    expect(rawBundle).toBeDefined();
    expect(rawBundle!.bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
    expect(rawBundle!.eligibleForRawAccuracyQualification).toBe(true);

    const legacyBundle = data.predictionBundles.find(b => b.source === REVIEWED_OUTCOME_PREDICTION_SOURCE);
    expect(legacyBundle).toBeDefined();
    expect(legacyBundle!.bundleVersion).toBe(LEGACY_BUNDLE_VERSION);
    expect(legacyBundle!.eligibleForRawAccuracyQualification).toBe(false);
  });

  it('POST /api/benchmark/datasets/:id/eval exposes bundleProvenance, attribution, and rawAccuracyReport', async () => {
    seedRun('SKU-DOG', 'dog_food_dry');
    seedRun('SKU-CAT', 'cat_treat');
    const datasetId = setupFrozenDataset();

    const predRes = await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runLabel: 'Eval Predict', splitGroup: 'holdout', source: PRE_REVIEW_PREDICTION_SOURCE }),
    });
    const { bundleId } = (await predRes.json()) as { bundleId: string };

    const evalRes = await app.request(`/api/benchmark/datasets/${datasetId}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runLabel: 'Eval Run 1',
        splitGroup: 'holdout',
        predictionBundleId: bundleId,
      }),
    });

    expect(evalRes.status).toBe(200);
    const result = (await evalRes.json()) as {
      evalRunId: string;
      metrics: { productType: { top1Accuracy: number } };
      bundleProvenance: {
        source: string;
        bundleVersion: number;
        eligibleForRawAccuracyQualification: boolean;
      };
      attribution: {
        fixedPopulation: {
          eligible: number;
          correct: number;
          correctness: number;
          coverage: number;
        };
        support: {
          eligibleExamples: number;
        };
      };
      rawAccuracyReport: {
        eligible: boolean;
        source: string;
      };
    };

    expect(result.evalRunId).toBeTruthy();
    expect(result.metrics.productType.top1Accuracy).toBe(1);
    expect(result.bundleProvenance.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
    expect(result.bundleProvenance.eligibleForRawAccuracyQualification).toBe(true);
    expect(result.attribution.fixedPopulation.eligible).toBe(2);
    expect(result.attribution.fixedPopulation.correct).toBe(2);
    expect(result.rawAccuracyReport.eligible).toBe(true);
    expect(result.rawAccuracyReport.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
  });

  it('GET /api/benchmark/datasets/:id/results annotates evalRuns with bundle source and qualification eligibility', async () => {
    seedRun('SKU-DOG', 'dog_food_dry');
    seedRun('SKU-CAT', 'cat_treat');
    const datasetId = setupFrozenDataset();

    const predRes = await app.request(`/api/benchmark/datasets/${datasetId}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runLabel: 'For Results', splitGroup: 'holdout', source: PRE_REVIEW_PREDICTION_SOURCE }),
    });
    const { bundleId } = (await predRes.json()) as { bundleId: string };

    await app.request(`/api/benchmark/datasets/${datasetId}/eval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runLabel: 'Results Eval', splitGroup: 'holdout', predictionBundleId: bundleId }),
    });

    const res = await app.request(`/api/benchmark/datasets/${datasetId}/results`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      evalRuns: Array<{
        id: string;
        prediction_bundle_id: string;
        source: string;
        bundleVersion: number;
        eligibleForRawAccuracyQualification: boolean;
      }>;
    };

    expect(data.evalRuns.length).toBe(1);
    expect(data.evalRuns[0].source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
    expect(data.evalRuns[0].bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
    expect(data.evalRuns[0].eligibleForRawAccuracyQualification).toBe(true);
  });
});
