/**
 * Benchmark Routes
 *
 * Workspace-scoped endpoints for the frozen-Gold lifecycle:
 * - export (draft dataset from the exact reviewed runs);
 * - family-review (required before freeze);
 * - freeze (immutable, content-addressed);
 * - predict (persist a complete prediction bundle BEFORE evaluation);
 * - eval (pure over frozen gold + bundle; reports insufficient_sample when the
 *   holdout population cannot meet the approved gate; page gold reports
 *   blocked_missing_verified_page_gold).
 */

import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import { exportBenchmark } from '../../classification/benchmark-exporter';
import { evaluateBenchmark } from '../../classification/benchmark-evaluator';
import {
  buildPredictionBundle,
  buildPreReviewPredictionBundle,
  describeStoredBundleSource,
  PRE_REVIEW_PREDICTION_SOURCE,
  REVIEWED_OUTCOME_PREDICTION_SOURCE,
  PRE_REVIEW_BUNDLE_VERSION,
  LEGACY_BUNDLE_VERSION,
} from '../../classification/benchmark-prediction';
import {
  assessPredictionSourceEligibility,
  reportRawAccuracyQualification,
} from '../../classification/benchmark-qualification';

const route = new Hono();

/**
 * Shared route guards (extraction for the 4-group/70-line clone family).
 * Error strings, codes, and status codes are preserved verbatim so route
 * paths/status codes/error codes/auth behavior is unchanged.
 */
function requireBenchmarkWorkspace(c: any) {
  const workspace = getCurrentWorkspace();
  if (!workspace) return { workspace: null, error: c.json({ error: 'No workspace loaded.' }, 400) } as const;
  return { workspace, error: null } as const;
}

function requireWorkspaceDataset(c: any) {
  const workspace = getCurrentWorkspace();
  if (!workspace) return { workspace: null, datasetId: null, dataset: null, error: c.json({ error: 'No workspace loaded.' }, 400) } as const;
  const datasetId = c.req.param('id');
  const dataset = benchmarkRepo.getDatasetForWorkspace(datasetId, workspace.id);
  if (!dataset) return { workspace, datasetId, dataset: null, error: c.json({ error: 'Dataset not found.' }, 404) } as const;
  return { workspace, datasetId, dataset, error: null } as const;
}

async function readBenchmarkBody(c: any): Promise<Record<string, any>> {
  return c.req.json().catch(() => ({}));
}

function benchmarkFailure(c: any, err: unknown, status: 409 | 500 = 409) {
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: msg }, status);
}

/**
 * POST /api/benchmark/export
 * Export reviewed classification decisions into a draft benchmark dataset.
 */
route.post('/benchmark/export', async (c) => {
  const { workspace, error } = requireBenchmarkWorkspace(c);
  if (!workspace) return error;

  const body = await readBenchmarkBody(c);
  const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined;
  if (!name) return c.json({ error: 'name is required.' }, 400);
  const holdoutPercent = typeof body.holdoutPercent === 'number' ? body.holdoutPercent : 20;
  const splitSeed = typeof body.splitSeed === 'number' ? body.splitSeed : undefined;
  const minDecisionsPerSku = typeof body.minDecisionsPerSku === 'number' ? body.minDecisionsPerSku : 1;

  try {
    const result = exportBenchmark(workspace.id, {
      name,
      holdoutPercent,
      splitSeed,
      minDecisionsPerSku,
    });
    return c.json(result);
  } catch (err: unknown) {
    return benchmarkFailure(c, err, 500);
  }
});

/**
 * GET /api/benchmark/datasets
 * List benchmark datasets for the active workspace.
 */
route.get('/benchmark/datasets', (c) => {
  const { workspace, error } = requireBenchmarkWorkspace(c);
  if (!workspace) return error;
  return c.json({ datasets: benchmarkRepo.listDatasets(workspace.id) });
});

/**
 * GET /api/benchmark/datasets/:id
 * Workspace-scoped dataset detail with split distribution and eval runs.
 */
route.get('/benchmark/datasets/:id', (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const examples = benchmarkRepo.getExamples(datasetId);
  const trainCount = examples.filter(e => e.split_group === 'train').length;
  const testCount = examples.filter(e => e.split_group === 'test').length;
  const holdoutCount = examples.filter(e => e.split_group === 'holdout').length;

  const evalRuns = benchmarkRepo.getEvalRuns(datasetId);
  const predictionBundles = benchmarkRepo.listPredictionBundles(datasetId);
  const receipts = benchmarkRepo.listQualificationReceipts(datasetId);

  return c.json({
    dataset,
    splitDistribution: { train: trainCount, test: testCount, holdout: holdoutCount },
    evalRuns,
    predictionBundles: predictionBundles.map(b => {
      let source: string = REVIEWED_OUTCOME_PREDICTION_SOURCE;
      let bundleVersion: number = LEGACY_BUNDLE_VERSION;
      try {
        const parsed = JSON.parse(b.predictions_json);
        const desc = describeStoredBundleSource(parsed);
        source = desc.source;
        bundleVersion = desc.bundleVersion;
      } catch {
        /* best-effort fallback to legacy reviewed-outcome */
      }
      const eligibility = assessPredictionSourceEligibility(source, bundleVersion);
      return {
        id: b.id,
        runLabel: b.run_label,
        splitGroup: b.split_group,
        bundleHash: b.bundle_hash,
        source,
        bundleVersion,
        eligibleForRawAccuracyQualification: eligibility.eligible,
        createdAt: b.created_at,
      };
    }),
    qualificationReceipts: receipts.map(r => ({
      id: r.id,
      digest: r.digest,
      qualified: r.qualified === 1,
      holdoutSize: r.holdout_size,
      deltaLower95: r.delta_lower95,
      reasons: JSON.parse(r.reasons_json),
    })),
  });
});

/**
 * POST /api/benchmark/datasets/:id/family-review
 * Record reviewed family grouping (required before freeze).
 */
route.post('/benchmark/datasets/:id/family-review', async (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const body = await readBenchmarkBody(c);
  const reviewerId = typeof body.reviewerId === 'string' && body.reviewerId.length > 0 ? body.reviewerId : 'reviewer';

  try {
    benchmarkRepo.markFamilyReviewComplete(datasetId, reviewerId);
    return c.json({ ok: true });
  } catch (err: unknown) {
    return benchmarkFailure(c, err);
  }
});

/**
 * POST /api/benchmark/datasets/:id/freeze
 * Freeze the dataset (immutable, content-addressed). Requires family review.
 */
route.post('/benchmark/datasets/:id/freeze', async (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const body = await readBenchmarkBody(c);
  const reviewerId = typeof body.reviewerId === 'string' && body.reviewerId.length > 0 ? body.reviewerId : 'reviewer';

  try {
    const frozen = benchmarkRepo.freezeDataset(datasetId, reviewerId);
    return c.json({ ok: true, dataset: frozen });
  } catch (err: unknown) {
    return benchmarkFailure(c, err);
  }
});

/**
 * POST /api/benchmark/datasets/:id/predict
 * Build and persist a complete prediction bundle from the exact reviewed runs.
 */
route.post('/benchmark/datasets/:id/predict', async (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const body = await readBenchmarkBody(c);
  const runLabel = typeof body.runLabel === 'string' && body.runLabel.length > 0
    ? body.runLabel
    : `Predictions ${new Date().toISOString().slice(0, 19)}`;
  const splitGroup = body.splitGroup === 'test' ? 'test' : 'holdout';

  const isPreReview = body.source === PRE_REVIEW_PREDICTION_SOURCE;

  try {
    const bundle = isPreReview
      ? buildPreReviewPredictionBundle(workspace.id, datasetId, {
          runLabel,
          splitGroup,
          claimTargets: Array.isArray(body.claimTargets) ? body.claimTargets : undefined,
        })
      : buildPredictionBundle(workspace.id, datasetId, {
          runLabel,
          splitGroup,
          claimTargets: Array.isArray(body.claimTargets) ? body.claimTargets : undefined,
        });
    return c.json({
      bundleId: bundle.id,
      datasetId: bundle.datasetId,
      splitGroup: bundle.splitGroup,
      predictionCount: bundle.predictions.length,
      bundleHash: bundle.bundleHash,
      source: isPreReview ? PRE_REVIEW_PREDICTION_SOURCE : REVIEWED_OUTCOME_PREDICTION_SOURCE,
      bundleVersion: isPreReview ? PRE_REVIEW_BUNDLE_VERSION : LEGACY_BUNDLE_VERSION,
    });
  } catch (err: unknown) {
    return benchmarkFailure(c, err);
  }
});

/**
 * POST /api/benchmark/datasets/:id/eval
 * Evaluate a frozen dataset against a persisted prediction bundle. Reports
 * insufficient_sample when the holdout cannot meet the approved gate and
 * blocked_missing_verified_page_gold when Page gold exists without verified
 * Page identity.
 */
route.post('/benchmark/datasets/:id/eval', async (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const body = await readBenchmarkBody(c);
  const runLabel = typeof body.runLabel === 'string' && body.runLabel.length > 0
    ? body.runLabel
    : `Eval ${new Date().toISOString().slice(0, 19)}`;
  const splitGroup = body.splitGroup === 'holdout' ? 'holdout' : 'test';
  const predictionBundleId = typeof body.predictionBundleId === 'string' ? body.predictionBundleId : undefined;
  const baselineBundleId = typeof body.baselineBundleId === 'string' ? body.baselineBundleId : undefined;

  try {
    const result = await evaluateBenchmark(datasetId, {
      runLabel,
      splitGroup,
      predictionBundleId,
      baselineBundleId,
    }, workspace.id);
    const rawAccuracyReport = reportRawAccuracyQualification({
      datasetId,
      datasetHash: dataset.dataset_hash ?? '',
      predictionBundleId: result.predictionBundleId,
      bundleHash: result.bundleHash,
      holdoutSize: result.holdoutSize,
      metrics: result.metrics,
      qualification: result.qualification,
      source: result.bundleProvenance.source,
      bundleVersion: result.bundleProvenance.bundleVersion,
    });
    return c.json({
      evalRunId: result.evalRunId,
      metrics: result.metrics,
      qualification: result.qualification,
      holdoutSize: result.holdoutSize,
      predictionBundleId: result.predictionBundleId,
      bundleHash: result.bundleHash,
      receiptDigest: result.receiptDigest,
      bundleProvenance: result.bundleProvenance,
      baselineBundleProvenance: result.baselineBundleProvenance,
      attribution: result.attribution,
      rawAccuracyReport,
      insufficientSample: result.qualification.reasons.some(r => r.startsWith('insufficient_sample')),
      pageGoldBlocked: result.metrics.pages.blocked,
    });
  } catch (err: unknown) {
    return benchmarkFailure(c, err);
  }
});

/**
 * GET /api/benchmark/datasets/:id/results
 * List evaluation results for a workspace-owned dataset.
 */
route.get('/benchmark/datasets/:id/results', (c) => {
  const { workspace, datasetId, dataset, error } = requireWorkspaceDataset(c);
  if (!workspace || !dataset) return error;

  const evalRuns = benchmarkRepo.getEvalRuns(datasetId).map(run => {
    let source: string | null = null;
    let bundleVersion: number | null = null;
    let eligibleForRawAccuracyQualification = false;
    if (run.prediction_bundle_id) {
      const bundle = benchmarkRepo.getPredictionBundle(run.prediction_bundle_id);
      if (bundle) {
        try {
          const parsed = JSON.parse(bundle.predictions_json);
          const desc = describeStoredBundleSource(parsed);
          source = desc.source;
          bundleVersion = desc.bundleVersion;
          eligibleForRawAccuracyQualification = assessPredictionSourceEligibility(source as any, bundleVersion).eligible;
        } catch {
          /* best-effort fallback when bundle is not parseable */
        }
      }
    }
    return {
      ...run,
      source,
      bundleVersion,
      eligibleForRawAccuracyQualification,
    };
  });
  return c.json({ evalRuns });
});

export default route;
