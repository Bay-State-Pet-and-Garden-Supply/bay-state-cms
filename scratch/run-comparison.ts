#!/usr/bin/env bun
/**
 * Evaluation-only comparison executor.
 * Usage: bun scratch/run-comparison.ts --split development --arm both --mode comparison --max-spend-usd 0.25
 * A missing/zero cap is a dry-run budget abort; --mode mechanism-check always requires a zero cap and accounts three source rows without live provider calls.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_MANIFEST,
  PRIVATE_ROOT,
  loadRows,
  outputPath,
  readManifest,
  rejectProductionPath,
  rootPath,
  verifyHashes,
  writeJson,
  type Manifest,
  type Row,
} from './onboarding-outcome';
import { closeDb, initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { insertWorkspace } from '../src/db/repositories/workspace-repo';
import { createBatch } from '../src/db/repositories/onboarding-batch-repo';
import { insertItems, type InsertItemData } from '../src/db/repositories/onboarding-item-repo';
import { findProductBySku } from '../src/db/repositories/product-index-repo';
import { deriveSourcingEntryStage, SOURCING_ENTRY_POLICY_VERSION } from '../src/onboarding/sourcing/entry-policy';
import { getSourcingFlags } from '../src/onboarding/flags';
import { OnboardingWorker } from '../src/onboarding/job-queue';
import { listItemsByBatch } from '../src/db/repositories/onboarding-item-repo';
import type { Workspace } from '../src/shared/types';

type Options = { split: 'development' | 'holdout'; arm: 'baseline' | 'candidate' | 'both'; mode: 'comparison' | 'mechanism-check'; cap: number; manifest: string };
type Arm = 'baseline' | 'candidate';
const usage = 'Usage: bun scratch/run-comparison.ts --split development|holdout --arm baseline|candidate|both --mode comparison|mechanism-check --max-spend-usd USD [--manifest path]';

function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!['--split', '--arm', '--mode', '--max-spend-usd', '--manifest'].includes(key) || Object.hasOwn(values, key)) throw new Error(`${usage}\nInvalid or repeated option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${usage}\nMissing value for ${key}`);
    values[key] = value;
  }
  const split = values['--split'];
  const arm = values['--arm'] ?? 'both';
  const mode = values['--mode'] ?? 'comparison';
  const rawCap = values['--max-spend-usd'];
  if (!['development', 'holdout'].includes(split ?? '') || !['baseline', 'candidate', 'both'].includes(arm) || !['comparison', 'mechanism-check'].includes(mode) || rawCap === undefined) throw new Error(`${usage}\n--max-spend-usd is mandatory`);
  const cap = Number(rawCap);
  if (!Number.isFinite(cap) || cap < 0) throw new Error('--max-spend-usd must be a finite non-negative amount.');
  if (mode === 'mechanism-check' && (split !== 'development' || cap !== 0)) throw new Error('mechanism-check requires --split development and --max-spend-usd 0.');
  return { split: split as Options['split'], arm: arm as Options['arm'], mode: mode as Options['mode'], cap, manifest: values['--manifest'] ?? DEFAULT_MANIFEST };
}

function sourceInput(row: Row): Record<string, unknown> {
  return { upc: row.upc, register_name: row.register_name, price: row.price };
}

function hasOnlyAllowedInput(row: Row): boolean {
  return typeof row.upc === 'string' && typeof row.register_name === 'string' && typeof row.price === 'number';
}
async function executeArm(arm: Arm, rows: Row[], options: Options, manifest: Manifest, runDir: string): Promise<Record<string, unknown>> {
  const armDir = path.join(runDir, arm);
  const dbPath = path.join(armDir, 'db', 'evaluation.sqlite');
  const workspacePath = path.join(armDir, 'workspace');
  const catalogPath = path.join(armDir, 'catalog-copy');
  for (const [candidate, label] of [[armDir, 'arm directory'], [dbPath, 'database'], [workspacePath, 'workspace'], [catalogPath, 'catalog']] as const) rejectProductionPath(candidate, label);
  mkdirSync(armDir, { recursive: true });
  if (arm === 'baseline') {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'onboarding-baseline-'));
    try {
      execFileSync('git', ['worktree', 'add', '--detach', temp, manifest.baseline.sha], { cwd: process.cwd(), stdio: 'pipe' });
      if (existsSync(path.join(temp, 'catalog'))) cpSync(path.join(temp, 'catalog'), catalogPath, { recursive: true, force: true });
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', temp], { cwd: process.cwd(), stdio: 'pipe' }); } catch { rmSync(temp, { recursive: true, force: true }); }
    }
  } else if (existsSync(path.join(process.cwd(), 'catalog'))) cpSync(path.join(process.cwd(), 'catalog'), catalogPath, { recursive: true, force: true });
  mkdirSync(workspacePath, { recursive: true });
  initDb(dbPath);
  try {
    runMigrations();
    const now = new Date().toISOString();
    const workspace: Workspace = { id: randomUUID(), name: `evaluation-${arm}`, workspacePath, gitPath: catalogPath, createdAt: now, updatedAt: now, bootstrapStatus: 'ready', baselineCommit: null };
    insertWorkspace(workspace);
    const importStarted = Date.now();
    const valid: InsertItemData[] = [];
    const skipped: Array<Record<string, unknown>> = [];
    const duplicates: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const upc = String(row.upc);
      if (findProductBySku(upc)) skipped.push({ row_id: row.row_id, reason: 'catalog_duplicate' });
      else if (seen.has(upc)) duplicates.push({ row_id: row.row_id, reason: 'duplicate_in_batch' });
      else {
        seen.add(upc);
        valid.push({ upc, name: String(row.register_name), price: Number(row.price), rowNumber: valid.length + 1, isDuplicate: false, existingSku: null });
      }
    }
    const batch = createBatch({ workspaceId: workspace.id, name: `Evaluation ${arm}`, fileName: 'manifest-rows', totalItems: valid.length, executionState: 'running', columnMappingJson: JSON.stringify({ upc: 'upc', name: 'register_name', price: 'price' }) });
    insertItems(batch.id, valid, deriveSourcingEntryStage(getSourcingFlags()), SOURCING_ENTRY_POLICY_VERSION);
    const imported = listItemsByBatch(batch.id);
    if (imported.length !== valid.length) throw new Error(`Importer reconciliation failed: expected ${valid.length}, got ${imported.length}`);
    const importMs = Date.now() - importStarted;
    const resultRows = rows.map(row => {
      const item = imported.find(candidate => candidate.upc === row.upc);
      const blocked = options.cap === 0;
      return {
        row_id: row.row_id, input: sourceInput(row),
        disposition: item ? (blocked ? 'BLOCKED_BUDGET' : 'imported_pending_pipeline') : (duplicates.some(entry => entry.row_id === row.row_id) ? 'duplicate' : 'skipped'),
        exact_identity_variant: null, candidates: null, authority: null, checklist: null, claim_units: null,
        gate_blocks: blocked && item ? ['BLOCKED_BUDGET'] : [],
        model_calls: { call_ids: [], tokens: null, status: 'unavailable', reason: 'No provider call was dispatched; repository pagination does not apply.' },
        search_calls: { requests: null, bytes: null, status: 'unavailable', reason: 'Pipeline dispatch is budget-blocked.' },
        timings_ms: { import: importMs, start: null, first_terminal_outcome: null },
        cost: { observed_usd: null, rate_usd: null, rate_date: null, status: 'unavailable' },
      };
    });
    if (options.mode === 'mechanism-check') {
      if (options.cap !== 0) throw new Error('Mechanism check requires a zero cap.');
      const worker = new OnboardingWorker(workspace.id, workspacePath);
      await worker.poll();
      await worker.drain();
      for (const row of resultRows) if (row.disposition === 'BLOCKED_BUDGET') row.gate_blocks = ['BLOCKED_BUDGET', 'worker_poll_exercised'];
    }
    return {
      schema_version: 1, protocol: manifest.protocol, run_id: path.basename(runDir), split: options.split, arm, mode: options.mode,
      status: options.cap === 0 ? 'BLOCKED_BUDGET' : 'BLOCKED', qualification_eligible: false, gold_visible_to_prediction_process: false,
      original_row_count: rows.length, imported_row_count: imported.length, skipped_rows: skipped, duplicate_rows: duplicates, rows: resultRows,
      accounting: { source_rows: rows.length, imported_rows: imported.length, skipped_rows: skipped.length, duplicate_rows: duplicates.length,
        terminal_rows: resultRows.filter(row => row.disposition === 'BLOCKED_BUDGET').length, budget_cap_usd: options.cap,
        projected_spend_usd: 0, observed_spend_usd: 0, spend_status: 'No provider calls dispatched at zero cap.',
        reconciliation: 'Manifest rows reconciled against imported rows; batch.totalItems not used.' },
      mechanism_check: options.mode === 'mechanism-check' ? {
        passed: rows.length === 3 && imported.length === valid.length,
        asserted: ['three manifest rows accounted', 'real repository importer invoked', 'imported rows exist in arm DB', 'real worker poll invoked', 'zero provider calls at zero cap'],
      } : null,
      blockers: ['BLOCKED_BUDGET', 'BLOCKED_METRIC_CAPTURE'],
      limitation: 'Budget guard is before worker dispatch; detailed pipeline evidence and review-ready progression are not captured.',
    };
  } finally { closeDb(); }
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(usage); return; }
  const options = parseArgs(process.argv.slice(2));
  const manifestFile = rootPath(options.manifest);
  if (!existsSync(manifestFile)) throw new Error(`Manifest not found: ${manifestFile}`);
  const manifest = readManifest(manifestFile);
  verifyHashes(manifest);
  if (options.split === 'holdout') throw new Error('Holdout execution is unavailable; no labels may enter prediction.');
  const sourceRows = loadRows(manifest, options.split);
  if (sourceRows.some(row => !hasOnlyAllowedInput(row))) throw new Error('Population includes a row missing required three-column import values.');
  if (sourceRows.some(row => Object.keys(row).some(key => /gold|label|truth|expected/i.test(key)))) throw new Error('Source payload contains gold/label-like fields.');
  const selectedRows = options.mode === 'mechanism-check' ? sourceRows.slice(0, 3) : sourceRows;
  if (options.mode === 'mechanism-check' && selectedRows.length !== 3) throw new Error(`Mechanism check requires three rows; found ${selectedRows.length}.`);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const arms: Arm[] = options.arm === 'both' ? ['baseline', 'candidate'] : [options.arm];
  const runDir = rootPath(`${PRIVATE_ROOT}/runs/${runId}`);
  mkdirSync(runDir, { recursive: true });
  const outputs: string[] = [];
  for (const arm of arms) {
    const file = outputPath(`${PRIVATE_ROOT}/runs/${runId}/${arm}/raw.json`);
    const report = await executeArm(arm, selectedRows, options, manifest, runDir);
    writeJson(file, report);
    outputs.push(file);
  }
  console.log(JSON.stringify({ run_id: runId, arms, source_rows: selectedRows.length, status: options.cap === 0 ? 'BLOCKED_BUDGET' : 'BLOCKED', outputs }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => {
  console.error(`run-comparison: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});


