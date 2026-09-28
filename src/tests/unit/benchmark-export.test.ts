import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createRun } from '../../db/repositories/classification-run-repo';
import {
  exportBenchmark,
  buildFrozenTaxonomyCandidates,
  findGoldOutsideFrozenTaxonomy,
  assertGoldWithinFrozenTaxonomy,
  verifyFamilySeparation,
} from '../../classification/benchmark-exporter';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';

const workspaceId = 'ws-benchmark-test';
const CONFIG_HASH = 'a'.repeat(64);
const CONFIG_SNAPSHOT_ID = 'snapshot-bench-1';

describe('Benchmark Export', () => {
  let wsPath: string;
  let dbPath: string;

  beforeEach(() => {
    wsPath = path.join(os.tmpdir(), `benchmark-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

    // Config snapshot binding required by the config-drift exclusion.
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

  function seedDecision(sku: string, proposalType: string, proposedValue: string, revisedValue: string | null = null, decisionStatus: string = 'accepted') {
    const db = getDb();
    const run = createRun(workspaceId, sku, CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    const proposalId = randomUUID();
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      [proposalId, run.id, sku, proposalType, JSON.stringify(proposedValue), 0.9, now]
    );

    const decisionId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [decisionId, proposalId, decisionStatus, revisedValue ? JSON.stringify(revisedValue) : null, now]
    );

    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);
  }

  it('should export benchmark from reviewed decisions', () => {
    seedDecision('SKU-1', 'primary_product_type', 'Dog Food');
    seedDecision('SKU-2', 'primary_product_type', 'Cat Food');

    const result = exportBenchmark(workspaceId, { name: 'Test Dataset', minDecisionsPerSku: 1 });

    expect(result.exported).toBeGreaterThanOrEqual(2);
    expect(result.datasetId).toBeDefined();

    const examples = benchmarkRepo.getExamples(result.datasetId);
    const sku1 = examples.find(e => e.product_sku === 'SKU-1');
    expect(sku1).toBeDefined();
    const gold1 = JSON.parse(sku1!.gold_labels_json);
    expect(gold1.productType).toBe('Dog Food');
    // Examples are content-addressed and carry the exact source run.
    expect(sku1!.example_hash).toBeTruthy();
    expect(sku1!.source_config_hash).toBe(CONFIG_HASH);
    expect(sku1!.source_run_id).toBeTruthy();
  });

  it('should split by product family, not random SKU', () => {
    seedDecision('BRAND-A-1', 'primary_product_type', 'Dog Food');
    seedDecision('BRAND-A-2', 'primary_product_type', 'Dog Food');
    seedDecision('BRAND-B-1', 'primary_product_type', 'Cat Food');

    const result = exportBenchmark(workspaceId, { name: 'Family Test', minDecisionsPerSku: 1, splitSeed: 42, holdoutPercent: 20 });

    const examples = benchmarkRepo.getExamples(result.datasetId);
    const splitA1 = examples.find(e => e.product_sku === 'BRAND-A-1')?.split_group;
    const splitA2 = examples.find(e => e.product_sku === 'BRAND-A-2')?.split_group;

    expect(splitA1).toBe(splitA2);
  });

  it('should use revised values as gold labels', () => {
    seedDecision('SKU-REV', 'primary_product_type', 'Dog Food', 'Dog Food Dry');

    const result = exportBenchmark(workspaceId, { name: 'Revised Test', minDecisionsPerSku: 1 });

    const examples = benchmarkRepo.getExamples(result.datasetId);
    const skuRev = examples.find(e => e.product_sku === 'SKU-REV');
    const gold = JSON.parse(skuRev!.gold_labels_json);
    expect(gold.productType).toBe('Dog Food Dry');
  });

  it('should respect minDecisionsPerSku filter', () => {
    const db = getDb();
    const seedIntoRun = (sku: string, runId: string, proposalType: string, proposedValue: string) => {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, 0.9, 'accepted', ?)`,
        [randomUUID(), runId, sku, proposalType, JSON.stringify(proposedValue), now]
      );
      const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ? ORDER BY rowid DESC LIMIT 1').get(runId) as { id: string };
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
         VALUES (?, ?, 'accepted', NULL, 0, ?)`,
        [randomUUID(), pid.id, now]
      );
    };
    const runA = createRun(workspaceId, 'SKU-A', CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    seedIntoRun('SKU-A', runA.id, 'primary_product_type', 'Dog Food');
    seedIntoRun('SKU-A', runA.id, 'category_page', 'Pets');
    seedIntoRun('SKU-A', runA.id, 'category_page', 'Dogs'); // 3 decisions
    const runB = createRun(workspaceId, 'SKU-B', CONFIG_SNAPSHOT_ID, CONFIG_HASH, { sourceKind: 'catalog_product' });
    seedIntoRun('SKU-B', runB.id, 'primary_product_type', 'Cat Food'); // 1 decision
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id IN (?, ?)`, [runA.id, runB.id]);

    const result = exportBenchmark(workspaceId, { name: 'Filter Test', minDecisionsPerSku: 2 });

    const examples = benchmarkRepo.getExamples(result.datasetId);
    const skus = examples.map(e => e.product_sku);
    expect(skus).toContain('SKU-A');
    expect(skus).not.toContain('SKU-B');
  });

  it('should produce deterministic splits with same seed', () => {
    seedDecision('SKU-1', 'primary_product_type', 'A');
    seedDecision('SKU-2', 'primary_product_type', 'B');
    seedDecision('SKU-3', 'primary_product_type', 'C');
    seedDecision('SKU-4', 'primary_product_type', 'D');

    const result1 = exportBenchmark(workspaceId, { name: 'Seed Test 1', minDecisionsPerSku: 1, splitSeed: 123 });
    const result2 = exportBenchmark(workspaceId, { name: 'Seed Test 2', minDecisionsPerSku: 1, splitSeed: 123 });

    const examples1 = benchmarkRepo.getExamples(result1.datasetId).map(e => e.split_group);
    const examples2 = benchmarkRepo.getExamples(result2.datasetId).map(e => e.split_group);
    expect(examples1).toEqual(examples2);
  });

  it('should exclude runs without a verifiable config snapshot (config drift)', () => {
    const db = getDb();
    const run = createRun(workspaceId, 'SKU-NO-CONFIG', null, null, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', '"Dog Food"', 0.9, 'accepted', ?)`,
      [randomUUID(), run.id, 'SKU-NO-CONFIG', now]
    );
    const pid = db.query('SELECT id FROM classification_proposals WHERE run_id = ?').get(run.id) as { id: string };
    const decisionId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, revised_value_json, has_revised_target, created_at)
       VALUES (?, ?, 'accepted', NULL, 0, ?)`,
      [decisionId, pid.id, now]
    );
    db.run(`UPDATE classification_runs SET status = 'completed' WHERE id = ?`, [run.id]);

    const result = exportBenchmark(workspaceId, { name: 'Drift Test', minDecisionsPerSku: 1 });
    expect(result.configDriftSkipped).toBeGreaterThanOrEqual(1);
    const skus = benchmarkRepo.getExamples(result.datasetId).map(e => e.product_sku);
    expect(skus).not.toContain('SKU-NO-CONFIG');
  });

  it('should exclude Page labels until verified Page identity exists', () => {
    seedDecision('SKU-PAGES', 'category_page', 'Dog Food Dry');

    const result = exportBenchmark(workspaceId, { name: 'Pages Test', minDecisionsPerSku: 1 });
    expect(result.pageLabelsExcluded).toBe(true);

    // Without a verified page import, the SKU has no gold labels at all.
    const examples = benchmarkRepo.getExamples(result.datasetId);
    expect(examples.find(e => e.product_sku === 'SKU-PAGES')).toBeUndefined();
  });

  it('should handle empty reviewed history gracefully', () => {
    const result = exportBenchmark(workspaceId, { name: 'Empty Test', minDecisionsPerSku: 1 });

    expect(result.exported).toBe(0);
    const examples = benchmarkRepo.getExamples(result.datasetId);
    expect(examples).toEqual([]);
  });

  describe('frozen-taxonomy candidates (never the gold union)', () => {
    const frozen = {
      snapshotHash: 'd'.repeat(64),
      source: 'test frozen snapshot',
      capturedAt: '2026-09-28T00:00:00.000Z',
      productTypes: [
        { id: 'dog_food_dry', label: 'Dry Dog Food' },
        { id: 'dog_food_wet', label: 'Wet Dog Food' },
      ],
      attributeTargets: [
        { targetId: 'flavor', cardinality: 'single' as const, options: ['Beef', 'Chicken'] },
      ],
      pages: [{ pageId: 'page-dry-dog-food', pageName: 'Dry Dog Food' }],
    };

    function goldEntry(sku: string, typeId: string | null, flavor: string | null) {
      return {
        sku,
        gold: {
          productType: { kind: typeId ? 'known-type' : 'no-fit', typeId },
          fieldAssignments: flavor ? [{ targetId: 'flavor', value: flavor }] : [],
          categoryPages: { pageIds: ['page-dry-dog-food'], pageAssignments: [] },
        },
      };
    }

    it('derives candidate sets from the frozen snapshot only', () => {
      const candidates = buildFrozenTaxonomyCandidates(frozen);
      expect(candidates.productTypes.map(t => t.id)).toEqual(['dog_food_dry', 'dog_food_wet']);
      expect(candidates.attributeTargets[0].options).toEqual(['Beef', 'Chicken']);
      expect(candidates.pages.map(p => p.pageId)).toEqual(['page-dry-dog-food']);
    });

    it('accepts gold within the frozen pool and rejects gold outside it', () => {
      expect(findGoldOutsideFrozenTaxonomy([goldEntry('S1', 'dog_food_dry', 'Chicken')], frozen)).toHaveLength(0);
      assertGoldWithinFrozenTaxonomy([goldEntry('S1', 'dog_food_dry', 'Chicken')], frozen);

      const findings = findGoldOutsideFrozenTaxonomy([goldEntry('S2', 'novel_type', 'Venison')], frozen);
      expect(findings.length).toBeGreaterThan(0);
      expect(() => assertGoldWithinFrozenTaxonomy([goldEntry('S2', 'novel_type', 'Venison')], frozen)).toThrow();
    });
  });

  describe('true family separation (shared identity plus near-duplicates)', () => {
    function entry(sku: string, familyId: string, split: string, snippet: string) {
      return { sku, familyId, split, evidence: [{ snippet }] };
    }

    it('passes clean families and fails straddling or near-duplicate splits', () => {
      const clean = verifyFamilySeparation([
        entry('A1', 'fam-a', 'dev', 'Acme Organic Chicken Adult Dry Dog Food 5 lb bag'),
        entry('A2', 'fam-a', 'dev', 'Acme Organic Chicken Adult Dry Dog Food 15 lb bag'),
        entry('B1', 'fam-b', 'holdout', 'Northland Blend Premium Wild Bird Seed 20 lb bag with sunflower kernels'),
      ]);
      expect(clean.passed).toBe(true);
      expect(clean.familiesChecked).toBe(2);

      const straddle = verifyFamilySeparation([
        entry('A1', 'fam-a', 'dev', 'Acme Organic Chicken Adult Dry Dog Food 5 lb bag'),
        entry('A2', 'fam-a', 'holdout', 'Acme Organic Chicken Adult Dry Dog Food 30 lb bag giant breed'),
      ]);
      expect(straddle.passed).toBe(false);
      expect(straddle.leakedFamilies.map(f => f.familyId)).toEqual(['fam-a']);

      const nearDup = verifyFamilySeparation([
        entry('A1', 'fam-a', 'dev', 'Acme Organic Chicken Adult Dry Dog Food 5 lb bag'),
        entry('X1', 'fam-x', 'holdout', 'Acme Organic Chicken Adult Dry Dog Food 5 lb bag'),
      ]);
      expect(nearDup.passed).toBe(false);
      expect(nearDup.nearDuplicatePairs.length).toBe(1);
    });
  });
});
