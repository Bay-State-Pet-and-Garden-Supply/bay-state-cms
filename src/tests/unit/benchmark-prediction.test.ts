import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import {
  buildPredictionBundle,
  buildPreReviewPredictionBundle,
  capturePreReviewPrediction,
  canonicalPreReviewTypeId,
  adjudicateGoldProductType,
  isPreReviewBundleEnvelope,
  describeStoredBundleSource,
  assessPredictionSourceEligibility,
  computePredictionBundleHash,
  validatePredictionBundle,
  extractPredictionsForSku,
  loadPredictionBundle,
  PRE_REVIEW_PREDICTION_SOURCE,
  REVIEWED_OUTCOME_PREDICTION_SOURCE,
  PRE_REVIEW_BUNDLE_VERSION,
  LEGACY_BUNDLE_VERSION,
} from '../../classification/benchmark-prediction';
import { getRun } from '../../db/repositories/classification-run-repo';
import { calibrateThresholds, devPairsFromBundle } from '../../classification/confidence-calibrator';
import type { BenchmarkPredictionEntry } from '../../shared/schemas/classification';
import prereviewGoldset from '../fixtures/benchmark-prereview-goldset.json';

const workspaceId = 'ws-prediction-test';
const CONFIG_HASH = 'c'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-pred-1';

describe('Benchmark prediction bundles', () => {
  let wsPath: string;
  let dbPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `prediction-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
    );
    getDb().run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* row may already exist on re-init */ }
  });

  function seedRun(sku: string, productType: string | null, abstain = false, confidence = 0.85) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    if (abstain) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'reviewable_abstention', 'null', 0, 'pending', ?)`,
        [randomUUID(), run.id, sku, now]
      );
    } else if (productType) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', ?, ?, 'accepted', ?)`,
        [randomUUID(), run.id, sku, JSON.stringify(productType), confidence, now]
      );
      const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ?').get(run.id) as { id: string };
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
         VALUES (?, ?, 'accepted', NULL, 0, ?)`,
        [randomUUID(), pid.id, now]
      );
    }
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function frozenDataset(skus: string[]): string {
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Prediction Test', 'product_family', 42);
    skus.forEach((sku, i) => {
      benchmarkRepo.insertExample(dataset.id, sku, `fam-${i}`, 'holdout', '{}', JSON.stringify({ productType: sku === 'ABSTAIN' ? 'X' : sku, pageAssignments: [], fieldAssignments: [] }));
    });
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer');
    return dataset.id;
  }

  it('builds and persists a complete bundle bound to the gold examples', () => {
    seedRun('SKU-1', 'Dog Food');
    seedRun('SKU-2', 'Cat Food');
    const datasetId = frozenDataset(['SKU-1', 'SKU-2']);

    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' });
    expect(bundle.predictions.length).toBe(2);
    expect(bundle.bundleHash).toBe(computePredictionBundleHash(bundle.predictions));

    const persisted = benchmarkRepo.getPredictionBundle(bundle.id)!;
    expect(persisted.bundle_hash).toBe(bundle.bundleHash);
    expect(JSON.parse(persisted.predictions_json).length).toBe(2);
  });

  it('extracts the exact effective revised values from the reviewed run', () => {
    // Seed a run then revise the type via a live decision on a newer run.
    const firstRun = seedRun('SKU-REV', 'Dog Food');
    // Ensure the first run sorts strictly older (started_at ordering).
    getDb().run('UPDATE classification_runs SET started_at = ? WHERE id = ?', ['2020-01-01T00:00:00.000Z', firstRun.id]);
    const run = createRun(workspaceId, 'SKU-REV', CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', '"Dog Food"', 0.85, 'accepted', ?)`,
      [randomUUID(), run.id, 'SKU-REV', now]
    );
    const pid = getDb().query('SELECT id FROM classification_proposals WHERE run_id = ?').get(run.id) as { id: string };
    getDb().run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', '"Dog Food Dry"', 0, ?)`,
      [randomUUID(), pid.id, now]
    );
    getDb().run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);

    const entry = extractPredictionsForSku(workspaceId, 'SKU-REV');
    expect(entry).not.toBeNull();
    expect(entry!.productType).toBe('Dog Food Dry');
  });

  it('fails closed on a missing prediction for a gold example', () => {
    seedRun('SKU-1', 'Dog Food');
    // SKU-2 has no reviewed run at all.
    const datasetId = frozenDataset(['SKU-1', 'SKU-2']);
    expect(() => buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' }))
      .toThrow(/No reviewed-run prediction available/);
  });

  it('fails closed on duplicate example ids', () => {
    const predictions: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    const gold = [{ id: 'e1', productSku: 'SKU-1' }, { id: 'e2', productSku: 'SKU-2' }];
    const hash = computePredictionBundleHash(predictions);
    expect(() => validatePredictionBundle(predictions, gold, hash)).toThrow(/duplicate example id/);
  });

  it('fails closed on a wrong digest', () => {
    const predictions: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'SKU-1', productType: 'Dog Food', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    expect(() => validatePredictionBundle(predictions, [{ id: 'e1', productSku: 'SKU-1' }], 'f'.repeat(64)))
      .toThrow(/digest mismatch/);
  });

  it('loadPredictionBundle re-verifies the persisted digest and workspace', () => {
    seedRun('SKU-1', 'Dog Food');
    const datasetId = frozenDataset(['SKU-1']);
    const bundle = buildPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' });

    const loaded = loadPredictionBundle(workspaceId, datasetId, bundle.id, 'holdout');
    expect(loaded.bundleHash).toBe(bundle.bundleHash);

    expect(() => loadPredictionBundle('other-ws', datasetId, bundle.id, 'holdout')).toThrow(/different workspace/);
  });

  it('fits calibration thresholds ONLY from development-split example-level predictions (train/holdout excluded)', () => {
    // Seed reviewed runs for all SKUs so a complete bundle can be built.
    seedRun('DEV-1', 'Dog Food');
    seedRun('DEV-2', 'Cat Food');
    seedRun('TRAIN-1', 'Dog Food');
    seedRun('HOLD-1', 'Bird Food', false, 0.4);

    // Frozen dataset with train/test(dev)/holdout splits. The development split
    // for calibration is the middle 'test' partition (train|test|holdout).
    const dataset = benchmarkRepo.createDataset(workspaceId, 'Calibration Test', 'product_family', 42);
    const goldFor = (productType: string) => JSON.stringify({ productType, pageAssignments: [], fieldAssignments: [] });
    benchmarkRepo.insertExample(dataset.id, 'DEV-1', 'fam-dev-1', 'test', '{}', goldFor('Dog Food'));
    benchmarkRepo.insertExample(dataset.id, 'DEV-2', 'fam-dev-2', 'test', '{}', goldFor('Cat Food'));
    benchmarkRepo.insertExample(dataset.id, 'TRAIN-1', 'fam-train-1', 'train', '{}', goldFor('Dog Food'));
    benchmarkRepo.insertExample(dataset.id, 'HOLD-1', 'fam-hold-1', 'holdout', '{}', goldFor('Bird Food'));
    benchmarkRepo.updateDatasetExampleCount(dataset.id);
    benchmarkRepo.markFamilyReviewComplete(dataset.id, 'reviewer');
    benchmarkRepo.freezeDataset(dataset.id, 'reviewer');

    const bundle = buildPredictionBundle(workspaceId, dataset.id, { runLabel: 'Calibration', splitGroup: 'test' });
    // A development-split bundle contains ONLY the test/development examples.
    expect(bundle.predictions.length).toBe(2);

    // Production contract: calibration consumes the development-split bundle
    // (splitGroup 'test'); holdout predictions live in a separate holdout bundle
    // and must never reach the fitter.
    const holdoutBundle = buildPredictionBundle(workspaceId, dataset.id, { runLabel: 'Holdout', splitGroup: 'holdout' });
    expect(holdoutBundle.predictions.length).toBe(1);

    const devExamples = benchmarkRepo.getExamples(dataset.id, 'test');
    const devIds = new Set(devExamples.map((e) => String(e.id)));
    const holdoutIds = new Set(benchmarkRepo.getExamples(dataset.id, 'holdout').map((e) => String(e.id)));
    const goldByExample = new Map(
      benchmarkRepo.getExamples(dataset.id).map((e) => [String(e.id), { productType: (JSON.parse(e.gold_labels_json) as { productType: string }).productType }]),
    );

    // No holdout example may appear in the development bundle used for fitting,
    // and every development-bundle prediction belongs to a development example.
    expect(bundle.predictions.some((p) => holdoutIds.has(p.exampleId))).toBe(false);
    expect(bundle.predictions.every((p) => devIds.has(p.exampleId))).toBe(true);

    // The holdout bundle's predictions are structurally separate and must never
    // reach the fitter: their example ids are all holdout ids.
    expect(holdoutBundle.predictions.every((p) => holdoutIds.has(p.exampleId))).toBe(true);

    const devPairs = devPairsFromBundle(bundle.predictions, goldByExample);
    // Every fitted pair is derived from a development-split prediction (the pair
    // itself carries confidence/correctness only; the split gate is enforced at
    // the prediction-selection boundary above).
    expect(devPairs.length).toBe(2);
    expect(devPairs.every((p) => p.proposalType === 'primary_product_type')).toBe(true);

    const holdoutPairs = devPairsFromBundle(holdoutBundle.predictions, goldByExample);
    expect(holdoutPairs.length).toBe(1);

    const thresholds = calibrateThresholds(devPairs);
    expect(thresholds.productType.abstainBelow).toBeGreaterThanOrEqual(0);
    expect(thresholds.productType.reviewAbove).toBeGreaterThanOrEqual(thresholds.productType.abstainBelow);

    // Fitting on the development pairs alone is deterministic; contaminating the
    // fit with holdout predictions changes the thresholds, proving the split
    // gate is material and must be enforced at the call site.
    const devOnly = calibrateThresholds(devPairs);
    const contaminated = calibrateThresholds([...devPairs, ...holdoutPairs]);
    expect(devOnly).toEqual(calibrateThresholds(devPairs));
    expect(JSON.stringify(contaminated)).not.toBe(JSON.stringify(devOnly));
  });
});

describe('Benchmark pre-review predictions (#294)', () => {
  let wsPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `prereview-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
    runMigrations();
    getDb().run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, 'Test WS', ?, '', ?, ?, 'complete')`,
      [workspaceId, wsPath, new Date().toISOString(), new Date().toISOString()]
    );
    getDb().run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, ?, '{}', ?)`,
      [CONFIG_SNAPSHOT_ID, workspaceId, CONFIG_HASH, new Date().toISOString()]
    );
  });

  afterEach(() => {
    closeDb();
    try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch { /* already removed */ }
  });

  function seedRaw(sku: string, rawType: string | null, opts: { confidence?: number; abstainReason?: string; revisedType?: string } = {}) {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    if (opts.abstainReason) {
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'reviewable_abstention', 'primary_product_type_proposal', ?, 0, 'pending', ?)`,
        [randomUUID(), run.id, sku, JSON.stringify({ reason: opts.abstainReason }), now]
      );
    } else if (rawType) {
      const pid = randomUUID();
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'primary_product_type', ?, ?, ?, 'pending', ?)`,
        [pid, run.id, sku, rawType, JSON.stringify({ productTypeId: rawType }), opts.confidence ?? 0.85, now]
      );
      if (opts.revisedType) {
        db.run(
          `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
           VALUES (?, ?, 'accepted', ?, 0, ?)`,
          [randomUUID(), pid, JSON.stringify({ productTypeId: opts.revisedType }), now]
        );
      }
    }
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
    return run;
  }

  function frozenHoldout(skus: string[]): string {
    const datasetId = benchmarkRepo.createDataset(workspaceId, 'Pre-review', 'product_family', 42).id;
    skus.forEach((sku, i) => {
      benchmarkRepo.insertExample(
        datasetId,
        sku,
        `fam-${i}`,
        'holdout',
        JSON.stringify({ sku, retainedFacts: [], evidence: [] }),
        JSON.stringify({ productType: sku, pageAssignments: [], fieldAssignments: [] }),
        { sourceConfigHash: CONFIG_HASH },
      );
    });
    benchmarkRepo.updateDatasetExampleCount(datasetId);
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');
    return datasetId;
  }

  it('freezes a labeled fixture dataset → captures raw outputs → evaluates the immutable bundle; reviewer corrections do not change reported accuracy', () => {
    // Freeze: representative fixture entries with adjudicated gold + retained inputs (no answers in inputs).
    const entries = (prereviewGoldset.entries as Array<{ sku: string; familyId: string; split: string; gold: unknown; evidence: unknown[] }>).slice(0, 4);
    const datasetId = benchmarkRepo.createDataset(workspaceId, 'Demo Freeze', 'product_family', 42).id;
    for (const entry of entries) {
      const gold = (entry.gold as { kind: string; typeId?: string }).kind === 'known-type'
        ? { productType: (entry.gold as { typeId: string }).typeId, pageAssignments: [], fieldAssignments: [] }
        : entry.gold;
      benchmarkRepo.insertExample(
        datasetId,
        entry.sku,
        entry.familyId,
        'holdout',
        JSON.stringify({ sku: entry.sku, retainedFacts: [], evidence: entry.evidence }),
        JSON.stringify(gold),
        { sourceConfigHash: CONFIG_HASH },
      );
    }
    benchmarkRepo.updateDatasetExampleCount(datasetId);
    benchmarkRepo.markFamilyReviewComplete(datasetId, 'reviewer');
    benchmarkRepo.freezeDataset(datasetId, 'reviewer');

    // Capture: current-provider raw outputs become the immutable bundle.
    for (const entry of entries) {
      const raw = entry as unknown as { sku: string; rawProposal?: { productTypeId: string }; rawAbstention?: { reason: string }; confidence: number };
      if (raw.rawAbstention) seedRaw(entry.sku, null, { abstainReason: raw.rawAbstention.reason });
      else seedRaw(entry.sku, raw.rawProposal!.productTypeId, { confidence: raw.confidence });
    }
    const bundle = buildPreReviewPredictionBundle(workspaceId, datasetId, { runLabel: 'Current Provider', splitGroup: 'holdout' });
    expect(bundle.bundleHash).toBe(computePredictionBundleHash(bundle.predictions));

    // Evaluate: snapshot + digest before the reviewer corrects anything.
    const before = loadPredictionBundle(workspaceId, datasetId, bundle.id, 'holdout');
    expect(before.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
    expect(before.bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
    const beforeHash = before.bundleHash;
    const beforeTypes = before.predictions.map(p => p.productType).join('|');

    // Review: corrections land as decisions on the live runs — answers, not predictions.
    const db = getDb();
    const now = new Date().toISOString();
    for (const row of db.query(`SELECT id FROM classification_proposals WHERE proposal_type = 'primary_product_type'`).all() as Array<{ id: string }>) {
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
         VALUES (?, ?, 'accepted', ?, 0, ?)`,
        [randomUUID(), row.id, JSON.stringify({ productTypeId: 'reviewer-corrected-type' }), now]
      );
    }

    // Replay: the immutable bundle is unchanged — corrections earn zero model accuracy.
    const after = loadPredictionBundle(workspaceId, datasetId, bundle.id, 'holdout');
    expect(after.bundleHash).toBe(beforeHash);
    expect(after.predictions.map(p => p.productType).join('|')).toBe(beforeTypes);
    expect(after.predictions.some(p => p.productType === 'reviewer-corrected-type')).toBe(false);
  });

  it('captures exact canonical IDs, run/config/evidence/model provenance, and per-example outcomes', () => {
    const run = seedRaw('SKU-P', 'dog_food_dry', { confidence: 0.9 });
    const entry = capturePreReviewPrediction({ runId: run.id, workspaceId, productSku: 'SKU-P' });
    expect(entry.productType).toBe('dog_food_dry');
    expect(entry.outcome).toBe('predicted');
    expect(entry.source).toBe(PRE_REVIEW_PREDICTION_SOURCE);
    expect(entry.bundleVersion).toBe(PRE_REVIEW_BUNDLE_VERSION);
    expect(entry.provenance?.runId).toBe(run.id);
    expect(entry.provenance?.configSnapshotHash).toBe(CONFIG_HASH);
    expect(entry.provenance?.evidenceCount).toBe(0);
    expect(canonicalPreReviewTypeId({ proposedValue: { productTypeId: 'dog_food_dry' }, targetId: 'legacy-id' })).toBe('dog_food_dry');
    expect(canonicalPreReviewTypeId({ proposedValue: 'cat_treat', targetId: null })).toBe('cat_treat');
  });

  it('candidate/baseline captures never read accepted revised values; later review edits cannot alter a captured bundle', () => {
    const run = seedRaw('SKU-R', 'dog_food_wet', { revisedType: 'dog_food_dry' });
    const captured = capturePreReviewPrediction({ runId: run.id, workspaceId, productSku: 'SKU-R' });
    // The reviewer-corrected answer is ignored: the raw output stands.
    expect(captured.productType).toBe('dog_food_wet');
    expect(captured.outcome).toBe('predicted');

    const stored = getRun(run.id)!;
    expect(stored.id).toBe(run.id);
    const datasetId = frozenHoldout(['SKU-R']);
    const bundle = buildPreReviewPredictionBundle(workspaceId, datasetId, { runLabel: 'P', splitGroup: 'holdout' });
    const hashBefore = bundle.bundleHash;

    // A second review revision lands after capture.
    const db = getDb();
    const pid = (db.query(`SELECT id FROM classification_proposals WHERE run_id = ?`).get(run.id) as { id: string }).id;
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', ?, 0, ?)`,
      [randomUUID(), pid, JSON.stringify({ productTypeId: 'cat_treat' }), new Date().toISOString()]
    );
    const reloaded = loadPredictionBundle(workspaceId, datasetId, bundle.id, 'holdout');
    expect(reloaded.bundleHash).toBe(hashBefore);
    expect(reloaded.predictions[0].productType).toBe('dog_food_wet');
  });

  it('keeps legacy reviewed-outcome bundles readable/labeled but ineligible to qualify raw accuracy', () => {
    const parsed: unknown = [{ exampleId: 'e1' }];
    expect(describeStoredBundleSource(parsed).source).toBe(REVIEWED_OUTCOME_PREDICTION_SOURCE);
    expect(describeStoredBundleSource(parsed).bundleVersion).toBe(LEGACY_BUNDLE_VERSION);
    expect(assessPredictionSourceEligibility(REVIEWED_OUTCOME_PREDICTION_SOURCE).eligible).toBe(false);
    expect(assessPredictionSourceEligibility(PRE_REVIEW_PREDICTION_SOURCE).eligible).toBe(true);

    // Legacy byte-for-byte hash semantics preserved: a reviewed-outcome array
    // hashes without any source marker, so historical digests still verify.
    const legacyPayload: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'SKU-L', productType: 'dog_food_dry', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    expect(computePredictionBundleHash(legacyPayload)).toBe(computePredictionBundleHash([...legacyPayload]));
    expect(isPreReviewBundleEnvelope(legacyPayload)).toBe(false);
  });
  it('supports gold states: known-type, no-fit, insufficient-evidence, unlabeled', () => {
    expect(adjudicateGoldProductType('dog_food_dry')).toEqual({ kind: 'known-type', typeId: 'dog_food_dry' });
    expect(adjudicateGoldProductType({ kind: 'no-fit' })).toEqual({ kind: 'no-fit', typeId: null });
    expect(adjudicateGoldProductType({ kind: 'insufficient-evidence' })).toEqual({ kind: 'insufficient-evidence', typeId: null });
    expect(adjudicateGoldProductType(null)).toEqual({ kind: 'unlabeled', typeId: null });
    expect(adjudicateGoldProductType({ kind: 'known-type', typeId: 'cat_treat' })).toEqual({ kind: 'known-type', typeId: 'cat_treat' });
  });

  it('treats service/validation failures as failed (no abstention credit) and semantic abstention as abstained', () => {
    const abstainRun = seedRaw('SKU-A', null, { abstainReason: 'no-fit: no configured product type matches' });
    const abstained = capturePreReviewPrediction({ runId: abstainRun.id, workspaceId, productSku: 'SKU-A' });
    expect(abstained.outcome).toBe('abstained');
    expect(abstained.abstained).toBe(true);
    expect(abstained.abstentionReason).toBe('no-fit: no configured product type matches');
    expect(abstained.failureCode).toBeNull();

    const failedRun = createRun(workspaceId, 'SKU-F', CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    getDb().run(`UPDATE classification_runs SET status = 'failed', error_message = 'boom' WHERE id = ?`, [failedRun.id]);
    const failed = capturePreReviewPrediction({ runId: failedRun.id, workspaceId, productSku: 'SKU-F' });
    expect(failed.outcome).toBe('failed');
    expect(failed.abstained).toBe(false);
    expect(typeof failed.failureCode).toBe('string');
  });

  it('covers replay: snapshot mismatches, dup/missing predictions, no-fit labels, dual abstentions, family leakage, legacy compatibility', () => {
    // Snapshot mismatch fails closed.
    seedRaw('SKU-S', 'dog_food_dry');
    const driftedId = benchmarkRepo.createDataset(workspaceId, 'Drift', 'product_family', 42).id;
    benchmarkRepo.insertExample(driftedId, 'SKU-S', 'fam-s', 'holdout', '{}', JSON.stringify({ productType: 'dog_food_dry', pageAssignments: [], fieldAssignments: [] }), { sourceConfigHash: 'd'.repeat(64) });
    benchmarkRepo.updateDatasetExampleCount(driftedId);
    benchmarkRepo.markFamilyReviewComplete(driftedId, 'reviewer');
    benchmarkRepo.freezeDataset(driftedId, 'reviewer');
    expect(() => buildPreReviewPredictionBundle(workspaceId, driftedId, { runLabel: 'P', splitGroup: 'holdout' })).toThrow(/Snapshot mismatch/);
    // Duplicate + missing predictions fail closed.
    const dup: BenchmarkPredictionEntry[] = [
      { exampleId: 'e1', productSku: 'S1', productType: 'a', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
      { exampleId: 'e1', productSku: 'S1', productType: 'a', pageAssignments: [], fieldAssignments: [], abstained: false, confidence: 0.9, claimTargets: [] },
    ];
    expect(() => validatePredictionBundle(dup, [{ id: 'e1', productSku: 'S1' }, { id: 'e2', productSku: 'S2' }], computePredictionBundleHash(dup))).toThrow(/duplicate example id/);
    expect(() => validatePredictionBundle(dup.slice(0, 1), [{ id: 'e1', productSku: 'S1' }, { id: 'e2', productSku: 'S2' }], computePredictionBundleHash(dup.slice(0, 1)))).toThrow(/incomplete/);

    // No-fit gold normalizes (evaluator sibling scores abstention-correct; here: contract holds).
    expect(adjudicateGoldProductType({ kind: 'no-fit' }).kind).toBe('no-fit');

    // Dual abstentions: both candidate and baseline runs abstain explicitly.
    const a1 = seedRaw('SKU-D1', null, { abstainReason: 'insufficient-evidence: missing label photo' });
    const a2 = seedRaw('SKU-D2', null, { abstainReason: 'insufficient-evidence: missing label photo' });
    expect(capturePreReviewPrediction({ runId: a1.id, workspaceId, productSku: 'SKU-D1' }).outcome).toBe('abstained');
    expect(capturePreReviewPrediction({ runId: a2.id, workspaceId, productSku: 'SKU-D2' }).outcome).toBe('abstained');

    // Family leakage: fixtures keep families together across dev/holdout.
    const splitsByFamily: Record<string, Record<string, true>> = {};
    for (const e of prereviewGoldset.entries as Array<{ familyId: string; split: string }>) {
      splitsByFamily[e.familyId] = splitsByFamily[e.familyId] ?? {};
      splitsByFamily[e.familyId][e.split] = true;
    }
    for (const family of Object.keys(splitsByFamily)) {
      expect(Object.keys(splitsByFamily[family]).length, `family ${family} leaks across splits`).toBe(1);
    }

    // Legacy compatibility: array payloads load as reviewed_outcome/0; unknown envelopes throw.
    expect(isPreReviewBundleEnvelope([{}])).toBe(false);
    expect(() => describeStoredBundleSource({ source: 'other', version: 9 })).toThrow(/unknown source\/version/);
  });
});
