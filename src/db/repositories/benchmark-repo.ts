import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../../shared/stable-id';

const now = () => new Date().toISOString();

// Row types

export interface BenchmarkDatasetRow {
  id: string;
  workspace_id: string;
  name: string;
  holdout_strategy: string;
  split_seed: number;
  total_examples: number;
  status: 'draft' | 'frozen' | 'retired';
  family_review_complete: number;
  family_reviewed_by: string | null;
  family_reviewed_at: string | null;
  dataset_hash: string | null;
  frozen_at: string | null;
  frozen_by: string | null;
  retired_at: string | null;
  source_config_hash: string | null;
  created_at: string;
}

export interface BenchmarkExampleRow {
  id: string;
  dataset_id: string;
  product_sku: string;
  product_family_id: string | null;
  split_group: 'train' | 'test' | 'holdout' | 'validation' | 'promotion_test';
  input_snapshot_json: string;
  gold_labels_json: string;
  example_hash: string;
  reviewer_id: string | null;
  adjudicated_by: string | null;
  source_run_id: string | null;
  source_config_hash: string | null;
  source_product_hash: string | null;
  is_contaminated?: number;
  contamination_version_id?: string | null;
  created_at: string;
}

export interface BenchmarkEvalRunRow {
  id: string;
  dataset_id: string;
  run_label: string;
  model_config_json: string | null;
  prediction_bundle_id: string | null;
  metrics_json: string;
  created_at: string;
}

export interface BenchmarkPredictionBundleRow {
  id: string;
  dataset_id: string;
  workspace_id: string;
  run_label: string;
  split_group: 'test' | 'holdout';
  predictions_json: string;
  bundle_hash: string;
  created_at: string;
}

export interface BenchmarkQualificationReceiptRow {
  id: string;
  dataset_id: string;
  dataset_hash: string;
  prediction_bundle_id: string;
  bundle_hash: string;
  holdout_size: number;
  coverage: number;
  min_class_support: number;
  violation_counts_json: string;
  primary_metric: string;
  delta_lower95: number;
  non_regression_floors_met: number;
  qualified: number;
  reasons_json: string;
  digest: string;
  generated_at: string;
  generated_by: string | null;
}

// ─── Datasets ──────────────────────────────────────────────────────────────────

export function createDataset(
  workspaceId: string,
  name: string,
  holdoutStrategy: string,
  splitSeed: number,
  sourceConfigHash: string | null = null,
): BenchmarkDatasetRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();
  const row: BenchmarkDatasetRow = {
    id,
    workspace_id: workspaceId,
    name,
    holdout_strategy: holdoutStrategy,
    split_seed: splitSeed,
    total_examples: 0,
    status: 'draft',
    family_review_complete: 0,
    family_reviewed_by: null,
    family_reviewed_at: null,
    dataset_hash: null,
    frozen_at: null,
    frozen_by: null,
    retired_at: null,
    source_config_hash: sourceConfigHash,
    created_at: createdAt,
  };

  db.query(`
    INSERT INTO benchmark_datasets (
      id, workspace_id, name, holdout_strategy, split_seed, total_examples,
      status, family_review_complete, family_reviewed_by, family_reviewed_at,
      dataset_hash, frozen_at, frozen_by, retired_at, source_config_hash, created_at
    ) VALUES (
      $id, $workspaceId, $name, $holdoutStrategy, $splitSeed, $totalExamples,
      $status, $familyReviewComplete, $familyReviewedBy, $familyReviewedAt,
      $datasetHash, $frozenAt, $frozenBy, $retiredAt, $sourceConfigHash, $createdAt
    )
  `).run({
    $id: row.id,
    $workspaceId: row.workspace_id,
    $name: row.name,
    $holdoutStrategy: row.holdout_strategy,
    $splitSeed: row.split_seed,
    $totalExamples: row.total_examples,
    $status: row.status,
    $familyReviewComplete: row.family_review_complete,
    $familyReviewedBy: row.family_reviewed_by,
    $familyReviewedAt: row.family_reviewed_at,
    $datasetHash: row.dataset_hash,
    $frozenAt: row.frozen_at,
    $frozenBy: row.frozen_by,
    $retiredAt: row.retired_at,
    $sourceConfigHash: row.source_config_hash,
    $createdAt: row.created_at,
  });

  return row;
}

function mapDatasetRow(row: Record<string, any>): BenchmarkDatasetRow {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    name: String(row.name),
    holdout_strategy: String(row.holdout_strategy),
    split_seed: Number(row.split_seed),
    total_examples: Number(row.total_examples),
    status: String(row.status) as BenchmarkDatasetRow['status'],
    family_review_complete: Number(row.family_review_complete),
    family_reviewed_by: row.family_reviewed_by ? String(row.family_reviewed_by) : null,
    family_reviewed_at: row.family_reviewed_at ? String(row.family_reviewed_at) : null,
    dataset_hash: row.dataset_hash ? String(row.dataset_hash) : null,
    frozen_at: row.frozen_at ? String(row.frozen_at) : null,
    frozen_by: row.frozen_by ? String(row.frozen_by) : null,
    retired_at: row.retired_at ? String(row.retired_at) : null,
    source_config_hash: row.source_config_hash ? String(row.source_config_hash) : null,
    created_at: String(row.created_at),
  };
}

/** Scoped dataset lookup: returns the row only when it belongs to workspaceId. */
export function getDatasetForWorkspace(id: string, workspaceId: string): BenchmarkDatasetRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM benchmark_datasets WHERE id = $id AND workspace_id = $workspaceId')
    .get({ $id: id, $workspaceId: workspaceId }) as Record<string, any> | undefined;
  return row ? mapDatasetRow(row) : null;
}

export function getDataset(id: string): BenchmarkDatasetRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM benchmark_datasets WHERE id = $id').get({ $id: id }) as Record<string, any> | undefined;
  return row ? mapDatasetRow(row) : null;
}

export function listDatasets(workspaceId: string): BenchmarkDatasetRow[] {
  const db = getDb();
  const rows = db
    .query('SELECT * FROM benchmark_datasets WHERE workspace_id = $workspaceId ORDER BY created_at DESC')
    .all({ $workspaceId: workspaceId }) as Record<string, any>[];
  return rows.map(mapDatasetRow);
}

export function updateDatasetExampleCount(datasetId: string): void {
  const db = getDb();
  db.query(`
    UPDATE benchmark_datasets
    SET total_examples = (
      SELECT COUNT(*) FROM benchmark_examples WHERE dataset_id = $datasetId
    )
    WHERE id = $datasetId
  `).run({ $datasetId: datasetId });
}

export function markFamilyReviewComplete(datasetId: string, reviewerId: string): void {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'draft') {
    throw new Error(`Cannot review family grouping on a ${dataset.status} dataset.`);
  }
  db.query(`
    UPDATE benchmark_datasets
    SET family_review_complete = 1, family_reviewed_by = $reviewerId, family_reviewed_at = $at
    WHERE id = $datasetId
  `).run({ $reviewerId: reviewerId, $at: now(), $datasetId: datasetId });
}

/**
 * Freeze a draft dataset. Requires family grouping review and at least one
 * example. Computes and persists the content-addressed datasetHash over the
 * sorted example hashes; frozen datasets reject all future example mutations.
 */
export function freezeDataset(datasetId: string, reviewerId: string | null = null): BenchmarkDatasetRow {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'draft') {
    throw new Error(`Dataset is already ${dataset.status}.`);
  }
  if (dataset.family_review_complete !== 1) {
    throw new Error('Family grouping must be reviewed before freeze.');
  }
  const examples = getExamples(datasetId);
  if (examples.length === 0) {
    throw new Error('Cannot freeze a dataset with no examples.');
  }
  const exampleHashes = examples.map(e => e.example_hash).sort();
  // Content addressing must be stable across identical example sets, so the
  // random dataset id is excluded from the hash domain.
  const datasetHash = sha256Hex(JSON.stringify({ exampleHashes }));
  const frozenAt = now();
  db.query(`
    UPDATE benchmark_datasets
    SET status = 'frozen', dataset_hash = $datasetHash, frozen_at = $frozenAt, frozen_by = $reviewerId
    WHERE id = $datasetId
  `).run({ $datasetHash: datasetHash, $frozenAt: frozenAt, $reviewerId: reviewerId ?? null, $datasetId: datasetId });
  return getDataset(datasetId)!;
}

export function retireDataset(datasetId: string): BenchmarkDatasetRow {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'frozen') throw new Error('Only a frozen dataset can be retired.');
  db.query('UPDATE benchmark_datasets SET status = \'retired\', retired_at = $at WHERE id = $datasetId')
    .run({ $at: now(), $datasetId: datasetId });
  return getDataset(datasetId)!;
}

// ─── Examples ──────────────────────────────────────────────────────────────────

export function insertExample(
  datasetId: string,
  productSku: string,
  productFamilyId: string | null,
  splitGroup: string,
  inputSnapshotJson: string,
  goldLabelsJson: string,
  options?: {
    reviewerId?: string | null;
    adjudicatedBy?: string | null;
    sourceRunId?: string | null;
    sourceConfigHash?: string | null;
    sourceProductHash?: string | null;
  },
): string {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'draft') {
    throw new Error(`Frozen (${dataset.status}) datasets are immutable: cannot insert examples.`);
  }
  const id = randomUUID();
  const exampleHash = sha256Hex(JSON.stringify({
    productSku,
    productFamilyId,
    splitGroup,
    inputSnapshotJson,
    goldLabelsJson,
    sourceRunId: options?.sourceRunId ?? null,
    sourceConfigHash: options?.sourceConfigHash ?? null,
    sourceProductHash: options?.sourceProductHash ?? null,
  }));
  db.query(`
    INSERT INTO benchmark_examples (
      id, dataset_id, product_sku, product_family_id, split_group, input_snapshot_json,
      gold_labels_json, example_hash, reviewer_id, adjudicated_by, source_run_id,
      source_config_hash, source_product_hash, created_at
    ) VALUES (
      $id, $datasetId, $productSku, $productFamilyId, $splitGroup, $inputSnapshotJson,
      $goldLabelsJson, $exampleHash, $reviewerId, $adjudicatedBy, $sourceRunId,
      $sourceConfigHash, $sourceProductHash, $createdAt
    )
  `).run({
    $id: id,
    $datasetId: datasetId,
    $productSku: productSku,
    $productFamilyId: productFamilyId,
    $splitGroup: splitGroup,
    $inputSnapshotJson: inputSnapshotJson,
    $goldLabelsJson: goldLabelsJson,
    $exampleHash: exampleHash,
    $reviewerId: options?.reviewerId ?? null,
    $adjudicatedBy: options?.adjudicatedBy ?? null,
    $sourceRunId: options?.sourceRunId ?? null,
    $sourceConfigHash: options?.sourceConfigHash ?? null,
    $sourceProductHash: options?.sourceProductHash ?? null,
    $createdAt: now(),
  });
  return id;
}

function mapExampleRow(row: Record<string, any>, hideGold = false): BenchmarkExampleRow {
  return {
    id: String(row.id),
    dataset_id: String(row.dataset_id),
    product_sku: String(row.product_sku),
    product_family_id: row.product_family_id ? String(row.product_family_id) : null,
    split_group: String(row.split_group) as BenchmarkExampleRow['split_group'],
    input_snapshot_json: String(row.input_snapshot_json),
    gold_labels_json: hideGold ? '{}' : String(row.gold_labels_json),
    example_hash: String(row.example_hash),
    reviewer_id: row.reviewer_id ? String(row.reviewer_id) : null,
    adjudicated_by: row.adjudicated_by ? String(row.adjudicated_by) : null,
    source_run_id: row.source_run_id ? String(row.source_run_id) : null,
    source_config_hash: row.source_config_hash ? String(row.source_config_hash) : null,
    source_product_hash: row.source_product_hash ? String(row.source_product_hash) : null,
    is_contaminated: row.is_contaminated != null ? Number(row.is_contaminated) : 0,
    contamination_version_id: row.contamination_version_id ? String(row.contamination_version_id) : null,
    created_at: String(row.created_at),
  };
}

export function getExamples(datasetId: string, splitGroup?: string, options?: { hideGold?: boolean }): BenchmarkExampleRow[] {
  const db = getDb();
  let rows: Record<string, any>[];
  if (splitGroup) {
    rows = db
      .query('SELECT * FROM benchmark_examples WHERE dataset_id = $datasetId AND split_group = $splitGroup')
      .all({ $datasetId: datasetId, $splitGroup: splitGroup }) as Record<string, any>[];
  } else {
    rows = db.query('SELECT * FROM benchmark_examples WHERE dataset_id = $datasetId').all({ $datasetId: datasetId }) as Record<string, any>[];
  }
  const shouldHide = options?.hideGold ?? false;
  return rows.map((r) => mapExampleRow(r, shouldHide));
}

export function markExampleContaminated(exampleId: string, versionId: string): void {
  const db = getDb();
  db.query(`
    UPDATE benchmark_examples
    SET is_contaminated = 1, contamination_version_id = $versionId
    WHERE id = $exampleId
  `).run({ $versionId: versionId, $exampleId: exampleId });
}

/** Immutability guard used by tests: any direct mutation of a frozen example must fail. */
export function updateExampleGoldLabels(datasetId: string, exampleId: string, goldLabelsJson: string): void {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'draft') {
    throw new Error(`Frozen (${dataset.status}) datasets are immutable: cannot modify examples.`);
  }
  db.query('UPDATE benchmark_examples SET gold_labels_json = $gold WHERE id = $id')
    .run({ $gold: goldLabelsJson, $id: exampleId });
}

export function deleteExample(datasetId: string, exampleId: string): void {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'draft') {
    throw new Error(`Frozen (${dataset.status}) datasets are immutable: cannot delete examples.`);
  }
  db.query('DELETE FROM benchmark_examples WHERE id = $id').run({ $id: exampleId });
}

// ─── Prediction Bundles ────────────────────────────────────────────────────────

export function createPredictionBundle(
  datasetId: string,
  workspaceId: string,
  runLabel: string,
  splitGroup: 'test' | 'holdout',
  predictionsJson: string,
  bundleHash: string,
  id?: string,
): BenchmarkPredictionBundleRow {
  const db = getDb();
  const dataset = getDataset(datasetId);
  if (!dataset) throw new Error('Dataset not found.');
  if (dataset.status !== 'frozen') {
    throw new Error(`Predictions require a frozen dataset; dataset is ${dataset.status}.`);
  }
  const bundleId = id ?? randomUUID();
  const createdAt = now();
  db.query(`
    INSERT INTO benchmark_prediction_bundles (
      id, dataset_id, workspace_id, run_label, split_group, predictions_json, bundle_hash, created_at
    ) VALUES (
      $id, $datasetId, $workspaceId, $runLabel, $splitGroup, $predictionsJson, $bundleHash, $createdAt
    )
  `).run({
    $id: bundleId,
    $datasetId: datasetId,
    $workspaceId: workspaceId,
    $runLabel: runLabel,
    $splitGroup: splitGroup,
    $predictionsJson: predictionsJson,
    $bundleHash: bundleHash,
    $createdAt: createdAt,
  });
  return {
    id: bundleId,
    dataset_id: datasetId,
    workspace_id: workspaceId,
    run_label: runLabel,
    split_group: splitGroup,
    predictions_json: predictionsJson,
    bundle_hash: bundleHash,
    created_at: createdAt,
  };
}

export function getPredictionBundle(id: string): BenchmarkPredictionBundleRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM benchmark_prediction_bundles WHERE id = $id').get({ $id: id }) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    dataset_id: String(row.dataset_id),
    workspace_id: String(row.workspace_id),
    run_label: String(row.run_label),
    split_group: String(row.split_group) as 'test' | 'holdout',
    predictions_json: String(row.predictions_json),
    bundle_hash: String(row.bundle_hash),
    created_at: String(row.created_at),
  };
}

export function listPredictionBundles(datasetId: string, splitGroup?: 'test' | 'holdout'): BenchmarkPredictionBundleRow[] {
  const db = getDb();
  const rows = splitGroup
    ? db.query('SELECT * FROM benchmark_prediction_bundles WHERE dataset_id = $datasetId AND split_group = $splitGroup ORDER BY created_at DESC')
      .all({ $datasetId: datasetId, $splitGroup: splitGroup }) as Record<string, any>[]
    : db.query('SELECT * FROM benchmark_prediction_bundles WHERE dataset_id = $datasetId ORDER BY created_at DESC')
      .all({ $datasetId: datasetId }) as Record<string, any>[];
  return rows.map(row => ({
    id: String(row.id),
    dataset_id: String(row.dataset_id),
    workspace_id: String(row.workspace_id),
    run_label: String(row.run_label),
    split_group: String(row.split_group) as 'test' | 'holdout',
    predictions_json: String(row.predictions_json),
    bundle_hash: String(row.bundle_hash),
    created_at: String(row.created_at),
  }));
}

/** Latest bundle for a dataset+split (used when the caller omits a bundle id). */
export function getLatestPredictionBundle(datasetId: string, splitGroup: 'test' | 'holdout'): BenchmarkPredictionBundleRow | null {
  const bundles = listPredictionBundles(datasetId, splitGroup);
  return bundles[0] ?? null;
}

// ─── Eval Runs ─────────────────────────────────────────────────────────────────

export function insertEvalRun(
  datasetId: string,
  runLabel: string,
  modelConfigJson: string | null,
  metricsJson: string,
  predictionBundleId: string | null = null,
): string {
  const db = getDb();
  const id = randomUUID();
  db.query(`
    INSERT INTO benchmark_eval_runs (
      id, dataset_id, run_label, model_config_json, prediction_bundle_id, metrics_json, created_at
    ) VALUES (
      $id, $datasetId, $runLabel, $modelConfigJson, $predictionBundleId, $metricsJson, $createdAt
    )
  `).run({
    $id: id,
    $datasetId: datasetId,
    $runLabel: runLabel,
    $modelConfigJson: modelConfigJson,
    $predictionBundleId: predictionBundleId,
    $metricsJson: metricsJson,
    $createdAt: now(),
  });
  return id;
}

function mapEvalRunRow(row: Record<string, any>): BenchmarkEvalRunRow {
  return {
    id: String(row.id),
    dataset_id: String(row.dataset_id),
    run_label: String(row.run_label),
    model_config_json: row.model_config_json ? String(row.model_config_json) : null,
    prediction_bundle_id: row.prediction_bundle_id ? String(row.prediction_bundle_id) : null,
    metrics_json: String(row.metrics_json),
    created_at: String(row.created_at),
  };
}

export function getEvalRuns(datasetId: string): BenchmarkEvalRunRow[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM benchmark_eval_runs WHERE dataset_id = $datasetId ORDER BY created_at DESC').all({
    $datasetId: datasetId,
  }) as Record<string, any>[];
  return rows.map(mapEvalRunRow);
}

// ─── Qualification Receipts ────────────────────────────────────────────────────

export function insertQualificationReceipt(receipt: {
  datasetId: string;
  datasetHash: string;
  predictionBundleId: string;
  bundleHash: string;
  holdoutSize: number;
  coverage: number;
  minClassSupport: number;
  violations: { crossSpecies: number; claimSafety: number; controlledValue: number };
  primaryMetric: string;
  deltaLower95: number;
  nonRegressionFloorsMet: boolean;
  qualified: boolean;
  reasons: string[];
  digest: string;
  generatedBy: string | null;
}): string {
  const db = getDb();
  const id = randomUUID();
  const generatedAt = now();
  db.query(`
    INSERT INTO benchmark_qualification_receipts (
      id, dataset_id, dataset_hash, prediction_bundle_id, bundle_hash, holdout_size,
      coverage, min_class_support, violation_counts_json, primary_metric, delta_lower95,
      non_regression_floors_met, qualified, reasons_json, digest, generated_at, generated_by
    ) VALUES (
      $id, $datasetId, $datasetHash, $predictionBundleId, $bundleHash, $holdoutSize,
      $coverage, $minClassSupport, $violationCountsJson, $primaryMetric, $deltaLower95,
      $nonRegressionFloorsMet, $qualified, $reasonsJson, $digest, $generatedAt, $generatedBy
    )
  `).run({
    $id: id,
    $datasetId: receipt.datasetId,
    $datasetHash: receipt.datasetHash,
    $predictionBundleId: receipt.predictionBundleId,
    $bundleHash: receipt.bundleHash,
    $holdoutSize: receipt.holdoutSize,
    $coverage: receipt.coverage,
    $minClassSupport: receipt.minClassSupport,
    $violationCountsJson: JSON.stringify(receipt.violations),
    $primaryMetric: receipt.primaryMetric,
    $deltaLower95: receipt.deltaLower95,
    $nonRegressionFloorsMet: receipt.nonRegressionFloorsMet ? 1 : 0,
    $qualified: receipt.qualified ? 1 : 0,
    $reasonsJson: JSON.stringify(receipt.reasons),
    $digest: receipt.digest,
    $generatedAt: generatedAt,
    $generatedBy: receipt.generatedBy,
  });
  return id;
}

function mapReceiptRow(row: Record<string, any>): BenchmarkQualificationReceiptRow {
  return {
    id: String(row.id),
    dataset_id: String(row.dataset_id),
    dataset_hash: String(row.dataset_hash),
    prediction_bundle_id: String(row.prediction_bundle_id),
    bundle_hash: String(row.bundle_hash),
    holdout_size: Number(row.holdout_size),
    coverage: Number(row.coverage),
    min_class_support: Number(row.min_class_support),
    violation_counts_json: String(row.violation_counts_json),
    primary_metric: String(row.primary_metric),
    delta_lower95: Number(row.delta_lower95),
    non_regression_floors_met: Number(row.non_regression_floors_met),
    qualified: Number(row.qualified),
    reasons_json: String(row.reasons_json),
    digest: String(row.digest),
    generated_at: String(row.generated_at),
    generated_by: row.generated_by ? String(row.generated_by) : null,
  };
}

export function getQualificationReceipt(id: string): BenchmarkQualificationReceiptRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM benchmark_qualification_receipts WHERE id = $id').get({ $id: id }) as Record<string, any> | undefined;
  return row ? mapReceiptRow(row) : null;
}

export function listQualificationReceipts(datasetId: string): BenchmarkQualificationReceiptRow[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM benchmark_qualification_receipts WHERE dataset_id = $datasetId ORDER BY generated_at DESC').all({
    $datasetId: datasetId,
  }) as Record<string, any>[];
  return rows.map(mapReceiptRow);
}

/**
 * Production wiring (M9 review note c): the verified receipt set is sourced
 * from the persisted qualification receipts — only digests of qualified
 * receipts count as verified. Feature policy never fabricates verification.
 */
export function getVerifiedReceiptDigests(): Set<string> {
  const db = getDb();
  const rows = db
    .query('SELECT digest FROM benchmark_qualification_receipts WHERE qualified = 1')
    .all() as Array<{ digest: string }>;
  return new Set(rows.map(r => r.digest));
}

/**
 * Safety-gate baseline for provider recommendation regression checks.
 * Stored per dataset; additive table. Returns null when no baseline has been
 * recorded yet (caller must then apply absolute-only gating).
 * story: e03s01
 */
export interface BenchmarkSafetyBaseline {
  wrongProductRate: number | null;
  wrongVariantRate: number | null;
  falsePassRate: number | null;
  traceabilityCoverage: number | null;
}

function ensureBaselineTable(): void {
  getDb().run(`
    CREATE TABLE IF NOT EXISTS benchmark_baselines (
      dataset_id TEXT PRIMARY KEY,
      wrong_product_rate REAL,
      wrong_variant_rate REAL,
      false_pass_rate REAL,
      traceability_coverage REAL,
      updated_at TEXT NOT NULL
    )
  `);
}

export function getBenchmarkBaseline(datasetId: string): BenchmarkSafetyBaseline | null {
  ensureBaselineTable();
  const row = getDb()
    .query('SELECT * FROM benchmark_baselines WHERE dataset_id = $id')
    .get({ $id: datasetId }) as Record<string, any> | undefined;
  if (!row) return null;
  return {
    wrongProductRate: row.wrong_product_rate ?? null,
    wrongVariantRate: row.wrong_variant_rate ?? null,
    falsePassRate: row.false_pass_rate ?? null,
    traceabilityCoverage: row.traceability_coverage ?? null,
  };
}

/**
 * Persist the v1 baseline safety rates for a dataset so subsequent benchmark
 * runs can enforce non-regression (blocker #1: write path). Idempotent — a
 * later baseline overwrites the prior one for the same dataset.
 * story: e03s01
 */
/**
 * Metadata-only read path (#302 step 2). Aggregates counts/splits/status/
 * hashes/attribution presence ONLY — never selects gold/input-snapshot
 * payload columns (input_snapshot_json, gold_labels_json, example_hash,
 * product_sku) or any sensitive table. The caller supplies an explicit
 * read-only connection dependency (e.g. an independent readonly driver);
 * this function never calls getDb()/initDb and never migrates or writes.
 * Workspace-scoped: a dataset id from another workspace reads as null.
 */
export interface BenchmarkMetadataDb {
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface BenchmarkDatasetMetadata {
  id: string;
  workspace_id: string;
  name: string;
  holdout_strategy: string;
  split_seed: number;
  total_examples: number;
  status: string;
  dataset_hash: string | null;
  frozen_at: string | null;
  source_config_hash: string | null;
  created_at: string;
  splitCounts: Record<string, number>;
  attribution: { reviewed: number; adjudicated: number; total: number };
}

const DATASET_METADATA_SQL =
  'SELECT id, workspace_id, name, holdout_strategy, split_seed, total_examples, status, dataset_hash, frozen_at, source_config_hash, created_at FROM benchmark_datasets WHERE id = $id AND workspace_id = $workspaceId';
const EXAMPLE_SPLIT_COUNTS_SQL =
  'SELECT split_group, COUNT(*) AS n FROM benchmark_examples WHERE dataset_id = $datasetId GROUP BY split_group';
const EXAMPLE_ATTRIBUTION_SQL =
  'SELECT SUM(CASE WHEN reviewer_id IS NOT NULL THEN 1 ELSE 0 END) AS reviewed, SUM(CASE WHEN adjudicated_by IS NOT NULL THEN 1 ELSE 0 END) AS adjudicated, COUNT(*) AS total FROM benchmark_examples WHERE dataset_id = $datasetId';

export function getDatasetMetadataOnly(
  db: BenchmarkMetadataDb,
  datasetId: string,
  workspaceId: string,
): BenchmarkDatasetMetadata | null {
  if (!workspaceId) return null;
  const row = db.query(DATASET_METADATA_SQL).get({ $id: datasetId, $workspaceId: workspaceId }) as Record<string, unknown> | undefined;
  if (!row) return null;
  const splits = db.query(EXAMPLE_SPLIT_COUNTS_SQL).all({ $datasetId: datasetId }) as Array<{
    split_group: string;
    n: number;
  }>;
  const attribution = db.query(EXAMPLE_ATTRIBUTION_SQL).get({ $datasetId: datasetId }) as {
    reviewed: number;
    adjudicated: number;
    total: number;
  };
  const splitCounts: Record<string, number> = {};
  for (const s of splits) splitCounts[String(s.split_group)] = Number(s.n);
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    name: String(row.name),
    holdout_strategy: String(row.holdout_strategy),
    split_seed: Number(row.split_seed),
    total_examples: Number(row.total_examples),
    status: String(row.status),
    dataset_hash: row.dataset_hash ? String(row.dataset_hash) : null,
    frozen_at: row.frozen_at ? String(row.frozen_at) : null,
    source_config_hash: row.source_config_hash ? String(row.source_config_hash) : null,
    created_at: String(row.created_at),
    splitCounts,
    attribution: {
      reviewed: Number(attribution?.reviewed ?? 0),
      adjudicated: Number(attribution?.adjudicated ?? 0),
      total: Number(attribution?.total ?? 0),
    },
  };
}

export function recordBenchmarkBaseline(datasetId: string, rates: BenchmarkSafetyBaseline): void {
  ensureBaselineTable();
  getDb()
    .query(
      `INSERT INTO benchmark_baselines (dataset_id, wrong_product_rate, wrong_variant_rate, false_pass_rate, traceability_coverage, updated_at)
     VALUES ($id, $wpr, $wvr, $fpr, $tc, $ts)
     ON CONFLICT(dataset_id) DO UPDATE SET
       wrong_product_rate = excluded.wrong_product_rate,
       wrong_variant_rate = excluded.wrong_variant_rate,
       false_pass_rate = excluded.false_pass_rate,
       traceability_coverage = excluded.traceability_coverage,
       updated_at = excluded.updated_at`,
    )
    .run({
      $id: datasetId,
      $wpr: rates.wrongProductRate ?? null,
      $wvr: rates.wrongVariantRate ?? null,
      $fpr: rates.falsePassRate ?? null,
      $tc: rates.traceabilityCoverage ?? null,
      $ts: new Date().toISOString(),
    });
}
