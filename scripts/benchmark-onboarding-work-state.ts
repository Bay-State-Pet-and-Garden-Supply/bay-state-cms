import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Database } from 'bun:sqlite';
import { initDb, getDb, closeDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { insertWorkspace } from '../src/db/repositories/workspace-repo';
import { createBatch } from '../src/db/repositories/onboarding-batch-repo';
import { insertItems } from '../src/db/repositories/onboarding-item-repo';
import { getBatchWorkState, getBatchWorkStateCounts } from '../src/onboarding/onboarding-work-state';
import type { OnboardingWorkStateFilters } from '../src/shared/schemas/onboarding-work-state';

// ─── SQL Normalization Engine ────────────────────────────────────────────────

export function normalizeSqlToStatementId(sql: string): string {
  const s = sql.trim().replace(/\s+/g, ' ');
  if (/SELECT\s+\*\s+FROM\s+onboarding_items\s+WHERE\s+batch_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_ONBOARDING_ITEMS_BY_BATCH_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+onboarding_review_state\s+WHERE\s+batch_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_ONBOARDING_REVIEW_STATE_BY_BATCH_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+curation_cohorts\s+WHERE\s+batch_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_CURATION_COHORTS_BY_BATCH_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+curation_cohort_members\s+WHERE\s+cohort_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_CURATION_COHORT_MEMBERS_BY_COHORT_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+\(\s*SELECT\s+e\.\*,\s*ROW_NUMBER\(\)\s+OVER/i.test(s) || /onboarding_extractions\s+e/i.test(s)) {
    return 'SELECT_ONBOARDING_EXTRACTIONS_LATEST_BINDINGS_BY_ITEM_IDS';
  }
  if (/SELECT\s+\*\s+FROM\s+onboarding_batches\s+WHERE\s+id\s*=\s*\?/i.test(s)) {
    return 'SELECT_ONBOARDING_BATCH_BY_ID';
  }
  if (/SELECT\s+status,\s*skus_json\s+FROM\s+change_sets\s+WHERE\s+workspace_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_CHANGE_SETS_BY_WORKSPACE_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+onboarding_sources\s+WHERE\s+item_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_ONBOARDING_SOURCES_BY_ITEM_ID';
  }
  if (/SELECT\s+\*\s+FROM\s+onboarding_variant_resolutions\s+WHERE\s+onboarding_item_id\s+IN/i.test(s)) {
    return 'SELECT_ONBOARDING_VARIANT_RESOLUTIONS_CURRENT_BY_ITEM_IDS';
  }
  if (/SELECT\s+status\s+FROM\s+classification_cohort_runs\s+WHERE\s+cohort_id\s+IN/i.test(s)) {
    return 'SELECT_CLASSIFICATION_COHORT_RUN_STATUS_BY_ITEM_ID';
  }
  if (/SELECT\s+id\s+FROM\s+classification_runs\s+WHERE\s+onboarding_item_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_CLASSIFICATION_RUN_BY_ITEM_ID';
  }
  if (/SELECT\s+stage_name,\s*status\s+FROM\s+classification_stage_results\s+WHERE\s+run_id\s*=\s*\?/i.test(s)) {
    return 'SELECT_CLASSIFICATION_STAGE_RESULTS_BY_RUN_ID';
  }

  // Sanitized deterministic ID hash for any other query (never leaking raw SQL or values)
  const hash = createHash('sha256').update(s).digest('hex').slice(0, 8).toUpperCase();
  return `SQL_STATEMENT_${hash}`;
}

export interface QueryStatsTracker {
  statementCounts: Map<string, number>;
  totalStatements: number;
  totalRowsReturned: number;
  reset: () => void;
  getSnapshot: () => {
    totalStatements: number;
    totalRowsReturned: number;
    statementBreakdown: Array<{ statementId: string; count: number }>;
  };
}

export function instrumentDatabase(db: Database): QueryStatsTracker {
  const statementCounts = new Map<string, number>();
  let totalStatements = 0;
  let totalRowsReturned = 0;

  function record(sql: string, rowsCount: number) {
    const id = normalizeSqlToStatementId(sql);
    statementCounts.set(id, (statementCounts.get(id) ?? 0) + 1);
    totalStatements += 1;
    totalRowsReturned += rowsCount;
  }

  const origQuery = db.query.bind(db);
  const origPrepare = db.prepare.bind(db);

  (db as any).query = function (sql: string) {
    const stmt = origQuery(sql);
    const origGet = stmt.get.bind(stmt);
    const origAll = stmt.all.bind(stmt);

    stmt.get = function (...args: any[]) {
      const res = origGet(...args);
      record(sql, res ? 1 : 0);
      return res;
    };
    stmt.all = function (...args: any[]) {
      const res = origAll(...args);
      record(sql, Array.isArray(res) ? res.length : 0);
      return res;
    };
    return stmt;
  };

  (db as any).prepare = function (sql: string) {
    const stmt = origPrepare(sql);
    const origGet = stmt.get.bind(stmt);
    const origAll = stmt.all.bind(stmt);

    stmt.get = function (...args: any[]) {
      const res = origGet(...args);
      record(sql, res ? 1 : 0);
      return res;
    };
    stmt.all = function (...args: any[]) {
      const res = origAll(...args);
      record(sql, Array.isArray(res) ? res.length : 0);
      return res;
    };
    return stmt;
  };

  return {
    statementCounts,
    totalStatements,
    totalRowsReturned,
    reset: () => {
      statementCounts.clear();
      totalStatements = 0;
      totalRowsReturned = 0;
    },
    getSnapshot: () => ({
      totalStatements,
      totalRowsReturned,
      statementBreakdown: Array.from(statementCounts.entries())
        .map(([statementId, count]) => ({ statementId, count }))
        .sort((a, b) => b.count - a.count),
    }),
  };
}

// ─── Synthetic Batch Generator ──────────────────────────────────────────────

export function seedSyntheticBatch(workspaceId: string, batchId: string, size: number) {
  const db = getDb();

  // Distribution:
  // sourcing: ~5%
  // discovery: ~20%
  // extraction: ~20%
  // curation: ~30%
  // review: ~15%
  // promotion: ~10%
  const numSourcing = Math.max(1, Math.round(size * 0.05));
  const numDiscovery = Math.max(2, Math.round(size * 0.20));
  const numExtraction = Math.max(2, Math.round(size * 0.20));
  const numCuration = Math.max(3, Math.round(size * 0.30));
  const numReview = Math.max(2, Math.round(size * 0.15));
  const numPromotion = size - (numSourcing + numDiscovery + numExtraction + numCuration + numReview);

  const stages: Array<'route_sources' | 'find_product_page' | 'collect_details' | 'prepare_listing' | 'review_listings' | 'create_drafts'> = [];
  for (let i = 0; i < numSourcing; i++) stages.push('route_sources');
  for (let i = 0; i < numDiscovery; i++) stages.push('find_product_page');
  for (let i = 0; i < numExtraction; i++) stages.push('collect_details');
  for (let i = 0; i < numCuration; i++) stages.push('prepare_listing');
  for (let i = 0; i < numReview; i++) stages.push('review_listings');
  for (let i = 0; i < numPromotion; i++) stages.push('create_drafts');

  const itemsToInsert = stages.map((stage, idx) => {
    const upc = `000000${String(idx + 1).padStart(6, '0')}`;
    const familyIndex = Math.floor(idx / 5);
    const sizeStr = ['5 lb', '15 lb', '30 lb', '40 lb', '12.5 oz'][idx % 5];
    const name = `Acme Dog Food Line ${familyIndex} Formula, ${sizeStr}`;
    return {
      upc,
      name,
      brandHint: 'Acme Pet Food',
      departmentHint: 'Dog Food',
      rowNumber: idx + 1,
    };
  });

  const inserted = insertItems(batchId, itemsToInsert);
  const now = new Date().toISOString();

  // Populate stage attributes and linked tables in bulk transaction
  db.transaction(() => {
    const updateItemStmt = db.prepare(`
      UPDATE onboarding_items
      SET stage = ?, stage_status = ?, source_url = ?, source_type = ?,
          extraction_data_json = ?, curation_data_json = ?, sourcing_decision_json = ?
      WHERE id = ?
    `);

    const insertSourceStmt = db.prepare(`
      INSERT INTO onboarding_sources (id, item_id, url, title, snippet, domain, confidence, is_selected, source_method, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertExtractionStmt = db.prepare(`
      INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, source_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertReviewStmt = db.prepare(`
      INSERT INTO onboarding_review_state (item_id, batch_id, reviewed_at, reviewed_by, approved_at, approved_by, approval_origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertVariantResStmt = db.prepare(`
      INSERT INTO onboarding_variant_resolutions (id, onboarding_item_id, resolution_id, identity_matrix_hash, parser_version, status, candidates_count, selected_variant_key, decision_origin, resolved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertRunStmt = db.prepare(`
      INSERT INTO classification_runs (id, onboarding_item_id, status, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertStageStmt = db.prepare(`
      INSERT INTO classification_stage_results (id, run_id, stage_name, status, result_json, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < inserted.length; i++) {
      const item = inserted[i];
      const stage = stages[i];

      if (stage === 'route_sources') {
        const status = i % 2 === 0 ? 'needs_input' : 'pending';
        updateItemStmt.run(stage, status, null, null, null, null, JSON.stringify({ outcome: 'sourcing_in_progress' }), item.id);
      } else if (stage === 'find_product_page') {
        const status = i % 3 === 0 ? 'needs_input' : 'pending';
        updateItemStmt.run(stage, status, null, null, null, null, null, item.id);
        // Insert 1-3 discovery sources
        const numSources = (i % 3) + 1;
        for (let s = 0; s < numSources; s++) {
          insertSourceStmt.run(
            randomUUID(),
            item.id,
            `https://www.acmepet.com/products/item-${i}-s${s}`,
            item.name,
            'High quality pet food',
            'acmepet.com',
            0.85,
            s === 0 ? 1 : 0,
            'sitemap_upc',
            '{}',
            now,
          );
        }
      } else if (stage === 'collect_details') {
        const isOfficial = i % 2 === 0;
        const sourceType = isOfficial ? 'official_page' : 'distributor_record';
        const sourceUrl = isOfficial ? `https://www.acmepet.com/products/item-${i}` : null;
        const extractionData = {
          title: item.name,
          brand: 'Acme Pet Food',
          description: 'Nutritious dog food with natural ingredients',
          primaryImage: 'https://www.acmepet.com/img/item.jpg',
        };
        updateItemStmt.run(stage, 'completed', sourceUrl, sourceType, JSON.stringify(extractionData), null, null, item.id);
        insertExtractionStmt.run(
          randomUUID(),
          item.id,
          sourceUrl,
          JSON.stringify(extractionData),
          'profile',
          0.95,
          sourceType,
          now,
        );
      } else if (stage === 'prepare_listing') {
        const runId = randomUUID();
        const curationData = {
          curatedTitle: item.name,
          curatedBrand: 'Acme Pet Food',
          classificationRunId: runId,
        };
        updateItemStmt.run(stage, 'pending', `https://www.acmepet.com/products/item-${i}`, 'official_page', '{}', JSON.stringify(curationData), null, item.id);
        insertRunStmt.run(runId, item.id, 'completed', null, now, now);
        const stageNames = ['packaging_ocr', 'evidence_extraction', 'name_consolidation', 'category_page_proposals', 'attribute_applicability'];
        for (const stg of stageNames) {
          insertStageStmt.run(randomUUID(), runId, stg, 'completed', '{}', now, now);
        }
      } else if (stage === 'review_listings') {
        const isApproved = i % 3 === 0;
        const isReviewed = isApproved || (i % 3 === 1);
        updateItemStmt.run(stage, isApproved ? 'completed' : 'pending', `https://www.acmepet.com/products/item-${i}`, 'official_page', '{}', JSON.stringify({ curatedTitle: item.name }), null, item.id);
        insertReviewStmt.run(
          item.id,
          batchId,
          isReviewed ? now : null,
          isReviewed ? 'operator-1' : null,
          isApproved ? now : null,
          isApproved ? 'approver-1' : null,
          'manual_ui',
          now,
          now,
        );
      } else if (stage === 'create_drafts') {
        updateItemStmt.run(stage, 'completed', `https://www.acmepet.com/products/item-${i}`, 'official_page', '{}', JSON.stringify({ curatedTitle: item.name }), null, item.id);
        insertReviewStmt.run(item.id, batchId, now, 'operator-1', now, 'approver-1', 'manual_ui', now, now);
      }

      // Variant resolutions for subset
      if (i % 5 === 0) {
        insertVariantResStmt.run(
          randomUUID(),
          item.id,
          randomUUID(),
          createHash('sha256').update(`matrix-${i}`).digest('hex'),
          1,
          'resolved',
          3,
          `var-${i}`,
          'automatic',
          now,
          now,
        );
      }
    }

    // Insert curation cohorts for multi-member families
    const insertCohortStmt = db.prepare(`
      INSERT INTO curation_cohorts (id, workspace_id, batch_id, group_label, status, membership_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCohortMemberStmt = db.prepare(`
      INSERT INTO curation_cohort_members (cohort_id, onboarding_item_id, ordinal, is_primary)
      VALUES (?, ?, ?, ?)
    `);

    const familyCount = Math.ceil(inserted.length / 5);
    for (let f = 0; f < familyCount; f++) {
      const cohortId = randomUUID();
      const familyMembers = inserted.slice(f * 5, (f + 1) * 5);
      if (familyMembers.length > 0) {
        insertCohortStmt.run(
          cohortId,
          workspaceId,
          batchId,
          `Acme Line ${f}`,
          'ready',
          createHash('sha256').update(`cohort-${f}`).digest('hex'),
          now,
          now,
        );
        for (let m = 0; m < familyMembers.length; m++) {
          insertCohortMemberStmt.run(cohortId, familyMembers[m].id, m, m === 0 ? 1 : 0);
        }
      }
    }

    // Insert change sets for workspace
    const insertChangeSetStmt = db.prepare(`
      INSERT INTO change_sets (id, workspace_id, status, skus_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const promotedSkus = inserted.filter((_, idx) => stages[idx] === 'create_drafts').map(it => it.upc);
    if (promotedSkus.length > 0) {
      insertChangeSetStmt.run(randomUUID(), workspaceId, 'draft', JSON.stringify(promotedSkus), now, now);
    }
  })();
}

// ─── Statistics Calculation ──────────────────────────────────────────────────

export interface LatencyStats {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  mean_ms: number;
  stddev_ms: number;
}

export function computeLatencyStats(timings: number[]): LatencyStats {
  const sorted = [...timings].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return { p50_ms: 0, p95_ms: 0, p99_ms: 0, min_ms: 0, max_ms: 0, mean_ms: 0, stddev_ms: 0 };
  }

  const p50 = sorted[Math.floor(n * 0.50)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const p99 = sorted[Math.floor(n * 0.99)];
  const min = sorted[0];
  const max = sorted[n - 1];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const variance = sorted.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n;
  const stddev = Math.sqrt(variance);

  return {
    p50_ms: Number(p50.toFixed(3)),
    p95_ms: Number(p95.toFixed(3)),
    p99_ms: Number(p99.toFixed(3)),
    min_ms: Number(min.toFixed(3)),
    max_ms: Number(max.toFixed(3)),
    mean_ms: Number(mean.toFixed(3)),
    stddev_ms: Number(stddev.toFixed(3)),
  };
}

// ─── Benchmark Runner ────────────────────────────────────────────────────────

export interface BenchmarkWorkloadResult {
  batchSize: number;
  workload: 'counts' | 'unfiltered_page' | 'ready_for_review' | 'needs_attention';
  latency: LatencyStats;
  sql: {
    totalStatements: number;
    totalRowsReturned: number;
    statementBreakdown: Array<{ statementId: string; count: number }>;
  };
  payload: {
    responseBytes: number;
  };
  memory: {
    heapUsedDeltaBytes: number;
    peakRssBytes: number;
  };
}

export interface WorkStateBaselineReport {
  meta: {
    timestamp: string;
    bunVersion: string;
    platform: string;
    iterations: number;
    warmup: number;
  };
  benchmarks: BenchmarkWorkloadResult[];
}

export function runWorkStateBenchmark(
  sizes: number[] = [50, 500, 5000],
  warmupCount = 10,
  iterationsCount = 100,
  jsonOutputPath?: string,
): WorkStateBaselineReport {
  const tempDir = path.join(os.tmpdir(), `baystate-cms-ws-bench-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, 'bench.db');

  initDb(dbPath);
  runMigrations();

  const db = getDb();
  const tracker = instrumentDatabase(db);

  const workspaceId = randomUUID();
  insertWorkspace({
    id: workspaceId,
    name: 'benchmark-workspace',
    workspacePath: tempDir,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  const workloads: Array<{ name: 'counts' | 'unfiltered_page' | 'ready_for_review' | 'needs_attention'; run: (batchId: string) => unknown }> = [
    {
      name: 'counts',
      run: (batchId) => getBatchWorkStateCounts(batchId),
    },
    {
      name: 'unfiltered_page',
      run: (batchId) => getBatchWorkState(batchId, { limit: 50, offset: 0 }),
    },
    {
      name: 'ready_for_review',
      run: (batchId) => getBatchWorkState(batchId, { category: 'ready_for_review', limit: 50 }),
    },
    {
      name: 'needs_attention',
      run: (batchId) => getBatchWorkState(batchId, { category: 'needs_attention', limit: 50 }),
    },
  ];

  const results: BenchmarkWorkloadResult[] = [];

  for (const size of sizes) {
    console.log(`\nGenerating synthetic batch of ${size} items...`);
    const batch = createBatch({
      workspaceId,
      name: `Batch ${size}`,
      fileName: `batch_${size}.xlsx`,
      totalItems: size,
    });

    seedSyntheticBatch(workspaceId, batch.id, size);

    for (const wl of workloads) {
      // Warmup
      for (let w = 0; w < warmupCount; w++) {
        wl.run(batch.id);
      }

      // Measured iterations
      tracker.reset();
      const timings: number[] = [];
      let payloadBytes = 0;
      const initialHeap = process.memoryUsage().heapUsed;

      for (let iter = 0; iter < iterationsCount; iter++) {
        const start = performance.now();
        const res = wl.run(batch.id);
        const dur = performance.now() - start;
        timings.push(dur);

        if (iter === 0) {
          payloadBytes = Buffer.byteLength(JSON.stringify(res), 'utf8');
        }
      }

      const latency = computeLatencyStats(timings);
      const snapshot = tracker.getSnapshot();
      // Calculate per-request statement count
      const perRequestStatements = Math.round(snapshot.totalStatements / iterationsCount);
      const perRequestRows = Math.round(snapshot.totalRowsReturned / iterationsCount);
      const perRequestBreakdown = snapshot.statementBreakdown.map(sb => ({
        statementId: sb.statementId,
        count: Math.max(1, Math.round(sb.count / iterationsCount)),
      }));

      const finalMem = process.memoryUsage();
      const heapDelta = Math.max(0, finalMem.heapUsed - initialHeap);

      results.push({
        batchSize: size,
        workload: wl.name,
        latency,
        sql: {
          totalStatements: perRequestStatements,
          totalRowsReturned: perRequestRows,
          statementBreakdown: perRequestBreakdown,
        },
        payload: {
          responseBytes: payloadBytes,
        },
        memory: {
          heapUsedDeltaBytes: heapDelta,
          peakRssBytes: finalMem.rss,
        },
      });
    }
  }

  closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  const report: WorkStateBaselineReport = {
    meta: {
      timestamp: new Date().toISOString(),
      bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
      platform: process.platform,
      iterations: iterationsCount,
      warmup: warmupCount,
    },
    benchmarks: results,
  };

  // Output formatting
  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log('         WORK-STATE QUERY & LATENCY BASELINE BENCHMARK RESULTS (G0.3)                          ');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`Iterations: ${iterationsCount} | Warmup: ${warmupCount} | Platform: ${process.platform}\n`);

  console.log('┌──────┬──────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬─────────────┐');
  console.log('│ Size │ Workload         │ p50 (ms) │ p95 (ms) │ p99 (ms) │ Mean(ms) │ SQL Stmts│ Payload(KB) │');
  console.log('├──────┼──────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼─────────────┤');
  for (const b of results) {
    const sSize = String(b.batchSize).padStart(4);
    const sWl = b.workload.padEnd(16);
    const sp50 = b.latency.p50_ms.toFixed(2).padStart(8);
    const sp95 = b.latency.p95_ms.toFixed(2).padStart(8);
    const sp99 = b.latency.p99_ms.toFixed(2).padStart(8);
    const sMean = b.latency.mean_ms.toFixed(2).padStart(8);
    const sSql = String(b.sql.totalStatements).padStart(8);
    const sPayload = (b.payload.responseBytes / 1024).toFixed(1).padStart(11);
    console.log(`│ ${sSize} │ ${sWl} │ ${sp50} │ ${sp95} │ ${sp99} │ ${sMean} │ ${sSql} │ ${sPayload} │`);
  }
  console.log('└──────┴──────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴─────────────┘\n');

  if (jsonOutputPath) {
    fs.mkdirSync(path.dirname(jsonOutputPath), { recursive: true });
    fs.writeFileSync(jsonOutputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`Baseline JSON artifact written to: ${jsonOutputPath}\n`);
  }

  return report;
}

// ─── CLI Entrypoint ──────────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('benchmark-onboarding-work-state.ts')) {
  const args = process.argv.slice(2);
  let sizes = [50, 500, 5000];
  let warmup = 10;
  let iterations = 100;
  let jsonPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sizes' && args[i + 1]) {
      sizes = args[++i].split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    } else if (args[i] === '--warmup' && args[i + 1]) {
      warmup = parseInt(args[++i], 10);
    } else if (args[i] === '--iterations' && args[i + 1]) {
      iterations = parseInt(args[++i], 10);
    } else if (args[i] === '--json' && args[i + 1]) {
      jsonPath = path.resolve(args[++i]);
    }
  }

  try {
    runWorkStateBenchmark(sizes, warmup, iterations, jsonPath);
    process.exit(0);
  } catch (err) {
    console.error('Work-state benchmark execution error:', err);
    process.exit(1);
  }
}
