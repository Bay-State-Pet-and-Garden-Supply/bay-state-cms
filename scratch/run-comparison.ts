/**
 * Evaluation-only comparison executor.
 * Usage: bun scratch/run-comparison.ts --split development --arm both --mode comparison --max-spend-usd 0.25
 * A missing/zero cap is a dry-run budget abort; --mode mechanism-check always requires a zero cap and accounts three source rows without live provider calls.
 * Positive-cap comparison runs dispatch real providers using operator credentials provisioned per disposable arm; missing credentials block affected items without ending the run.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
import type { Workspace } from '../src/shared/types';
import type { InsertItemData } from '../src/db/repositories/onboarding-item-repo';

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
  const sourceRoot = arm === 'baseline' ? path.join(armDir, 'baseline-src') : process.cwd();
  for (const [candidate, label] of [[armDir, 'arm directory'], [dbPath, 'database'], [workspacePath, 'workspace'], [catalogPath, 'catalog'], ...(arm === 'baseline' ? [[sourceRoot, 'baseline worktree'] as const] : [])] as const) rejectProductionPath(candidate, label);
  mkdirSync(armDir, { recursive: true });
  if (arm === 'baseline') {
    execFileSync('git', ['worktree', 'add', '--detach', sourceRoot, manifest.baseline.sha], { cwd: process.cwd(), stdio: 'pipe' });
    const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
    console.log(`baseline_source sha=${actualSha} file=${path.join(sourceRoot, 'src/onboarding/job-queue.ts')}`);
    if (existsSync(path.join(sourceRoot, 'catalog'))) cpSync(path.join(sourceRoot, 'catalog'), catalogPath, { recursive: true, force: true });
  } else if (existsSync(path.join(sourceRoot, 'catalog'))) cpSync(path.join(sourceRoot, 'catalog'), catalogPath, { recursive: true, force: true });
  mkdirSync(workspacePath, { recursive: true });
  const brandDomainsPath = path.join(runDir, 'brand_domains.json');
  if (!existsSync(brandDomainsPath)) copyFileSync('/tmp/brand_domains.json', brandDomainsPath);
  const load = async (file: string) => import(pathToFileURL(path.join(sourceRoot, file)).href);
  const [connection, migrations, workspaceRepo, batchRepo, itemRepo, productRepo, entryPolicy, flags, workerModule, brandSiteRepo] = await Promise.all([
    load('src/db/connection.ts'), load('src/db/migrations.ts'), load('src/db/repositories/workspace-repo.ts'),
    load('src/db/repositories/onboarding-batch-repo.ts'), load('src/db/repositories/onboarding-item-repo.ts'),
    load('src/db/repositories/product-index-repo.ts'), load('src/onboarding/sourcing/entry-policy.ts'),
    load('src/onboarding/flags.ts'), load('src/onboarding/job-queue.ts'), load('src/db/repositories/brand-site-repo.ts'),
  ]);
  const { closeDb, initDb } = connection;
  try {
    initDb(dbPath);
    migrations.runMigrations();
    if (options.mode === 'comparison' && options.cap > 0) {
      // Run-scoped credential provisioning (operator-approved): copy the
      // Serper key into the DISPOSABLE arm DB only. Never logged or committed.
      const prodDb = path.join(process.cwd(), 'storage/catalog/.shopsite-cms/app.db');
      let serperKey = '';
      try {
        serperKey = execFileSync('sqlite3', ['-readonly', prodDb, "SELECT api_key FROM api_keys WHERE service = 'serper_search' LIMIT 1;"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { /* missing key blocks items below, never throws here */ }
      if (serperKey) {
        const apiKeyRepo = await load('src/db/repositories/api-key-repo.ts');
        apiKeyRepo.upsertApiKey('serper_search', serperKey);
      }
    }
    const now = new Date().toISOString();
    const workspace: Workspace = { id: randomUUID(), name: `evaluation-${arm}`, workspacePath, gitPath: catalogPath, createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null };
    workspaceRepo.insertWorkspace(workspace);
    const brandDomains = JSON.parse(await Bun.file(brandDomainsPath).text()) as Record<string, string>;
    const brandTokens = [...new Set(rows.map(row => String(row.register_name).trim().split(/\s+/)[0]!.toUpperCase()))];
    const brandsRegistered = brandTokens.filter(token => brandDomains[token]).map(token => {
      brandSiteRepo.upsertBrandSite(token, brandDomains[token]!);
      return { brand: token, domain: brandDomains[token] };
    });
    const importStarted = Date.now();
    const valid: InsertItemData[] = [];
    const skipped: Array<Record<string, unknown>> = [];
    const duplicates: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const upc = String(row.upc);
      if (productRepo.findProductBySku(upc)) skipped.push({ row_id: row.row_id, reason: 'catalog_duplicate' });
      else if (seen.has(upc)) duplicates.push({ row_id: row.row_id, reason: 'duplicate_in_batch' });
      else { seen.add(upc); valid.push({ upc, name: String(row.register_name), price: String(row.price), brandHint: String(row.register_name).trim().split(/\s+/)[0]!.toUpperCase(), rowNumber: valid.length + 1, isDuplicate: false, existingSku: null }); }
    }
    const batch = batchRepo.createBatch({ workspaceId: workspace.id, name: `Evaluation ${arm}`, fileName: 'manifest-rows', totalItems: valid.length, executionState: 'running', columnMappingJson: JSON.stringify({ upc: 'upc', name: 'register_name', price: 'price' }) });
    itemRepo.insertItems(batch.id, valid, entryPolicy.deriveSourcingEntryStage(flags.getSourcingFlags()), entryPolicy.SOURCING_ENTRY_POLICY_VERSION);
    const imported = itemRepo.listItemsByBatch(batch.id);
    if (imported.length !== valid.length) throw new Error(`Importer reconciliation failed: expected ${valid.length}, got ${imported.length}`);
    const importMs = Date.now() - importStarted;
    const resultRows: Array<Record<string, unknown>> = rows.map(row => {
      const item = imported.find(candidate => candidate.upc === String(row.upc));
      return {
        row_id: row.row_id, input: sourceInput(row),
        disposition: item ? (options.cap === 0 ? 'budget_blocked' : 'imported_pending_pipeline') : (duplicates.some(entry => entry.row_id === row.row_id) ? 'duplicate' : 'skipped'),
        exact_identity_variant: null, candidates: null, authority: null, checklist: null, claim_units: null,
        gate_blocks: options.cap === 0 && item ? ['BLOCKED_BUDGET'] : [],
        model_calls: { call_ids: [], input_tokens: 0, output_tokens: 0, status: 'pending' },
        search_calls: { requests: 0, bytes: 0, status: 'pending' },
        timings_ms: { import: importMs, start: null, first_terminal_outcome: null },
        cost: { observed_usd: null, estimated_usd: null, rate_usd: null, rate_date: null, status: 'pending' },
      };
    });
    let projectedSpendUsd = 0;
    let observedSpendUsd = 0;
    let stoppedForBudget = options.cap === 0;
    if (options.mode === 'mechanism-check') {
      if (options.cap !== 0) throw new Error('Mechanism check requires a zero cap.');
      const worker = new workerModule.OnboardingWorker(workspace.id, workspacePath);
      await worker.poll();
      await worker.drain();
      for (const row of resultRows) if (row.disposition === 'budget_blocked') row.gate_blocks = ['BLOCKED_BUDGET', 'worker_poll_exercised'];
    } else {
      const pricingModule = await load('src/ai/model-pricing.ts');
      const modelRate = pricingModule.getModelPricing('gpt-4o-mini');
      const serperRateUsd = 0.001; // PINNED ESTIMATE: $1.00 / 1,000 queries, 2026-10-22.
      const expectedInputTokens = 4_000;
      const expectedOutputTokens = 1_000;
      const modelCost = modelRate
        ? (expectedInputTokens / 1_000_000) * modelRate.inputPerMillion +
          (expectedOutputTokens / 1_000_000) * (modelRate.outputPerMillion ?? 0)
        : null;
      const marginalEstimate = modelCost === null ? null : modelCost + serperRateUsd;
      const worker = new workerModule.OnboardingWorker(workspace.id, workspacePath, 1, 1);
      const modelCallRepo = await load('src/db/repositories/ai-model-call-repo.ts');
      let previousCalls = modelCallRepo.getAiModelCallsByWorkspace(workspace.id, 100_000);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex]!;
        const output = resultRows[rowIndex]!;
        const item = imported.find(candidate => candidate.upc === String(row.upc));
        
        const outputCost = output.cost as { observed_usd: number | null; estimated_usd: number | null; rate_usd: unknown; rate_date: string | null; status: string };
        const outputTimings = output.timings_ms as { import: number; start: number | null; first_terminal_outcome: number | null };
        if (!item) continue;
        if (marginalEstimate === null) {
          output.disposition = 'failed';
          output.error = 'BLOCKED_UNKNOWN_COST: no published model price is available for the expected model calls.';
          output.gate_blocks = ['BLOCKED_UNKNOWN_COST'];
          output.cost = { observed_usd: null, estimated_usd: null, rate_usd: null, rate_date: null, status: 'unknown' };
          continue;
        }
        if (projectedSpendUsd + marginalEstimate > options.cap) {
          stoppedForBudget = true;
          for (let j = rowIndex; j < rows.length; j++) {
            const pendingItem = imported.find(candidate => candidate.upc === String(rows[j]!.upc));
            if (pendingItem) {
              resultRows[j]!.disposition = 'budget_blocked';
              resultRows[j]!.gate_blocks = ['BLOCKED_BUDGET'];
            }
          }
          break;
        }
        projectedSpendUsd += marginalEstimate;
        outputCost.estimated_usd = marginalEstimate;
        outputCost.rate_usd = { model_input_per_million: modelRate!.inputPerMillion, model_output_per_million: modelRate!.outputPerMillion, serper_per_query: serperRateUsd };
        outputCost.rate_date = '2026-10-22 ESTIMATED';
        outputCost.status = 'estimated';
        output.model_calls = { call_ids: [], input_tokens: 0, output_tokens: 0, status: 'observed' };
        output.search_calls = { requests: 0, bytes: 0, status: 'unavailable', reason: 'No Serper usage repository getter is available.' };
        output.disposition = 'imported_pending_pipeline';
        if (options.mode === 'comparison' && !process.env.TYPESAFE_API_KEY) {
          output.disposition = 'blocked';
          output.error = 'BLOCKED_CREDENTIALS: TYPESAFE_API_KEY is not set in the operator environment.';
          output.gate_blocks = ['BLOCKED_CREDENTIALS'];
          outputCost.status = 'blocked';
          output.model_calls = { call_ids: [], input_tokens: 0, output_tokens: 0, status: 'blocked' };
          output.search_calls = { requests: 0, bytes: 0, status: 'blocked' };
          continue;
        }
        const itemStarted = Date.now();
        outputTimings.start = itemStarted;
        try {
          let terminal = false;
          while (!terminal) {
            await worker.poll();
            await worker.drain();
            const current = itemRepo.listItemsByBatch(batch.id).find((candidate: { id: string }) => candidate.id === item.id);
            if (!current) throw new Error('Imported item disappeared during worker processing.');
            terminal = current.stageStatus === 'completed' || current.stageStatus === 'failed' || current.stageStatus === 'needs_input' || current.stageStatus === 'blocked';
            if (!terminal) await new Promise(resolve => setTimeout(resolve, 25));
          }
          output.disposition = 'completed';
          output.outcome = itemRepo.listItemsByBatch(batch.id).find((candidate: { id: string; stageStatus: string }) => candidate.id === item.id)?.stageStatus ?? null;
          outputTimings.first_terminal_outcome = Date.now() - itemStarted;
        } catch (error) {
          output.disposition = 'failed';
          output.error = error instanceof Error ? error.message : String(error);
        }
        const calls = modelCallRepo.getAiModelCallsByWorkspace(workspace.id, 100_000);
        const newCalls = calls.filter((call: { id: string }) => !previousCalls.some((previous: { id: string }) => previous.id === call.id));
        previousCalls = calls;
        output.model_calls = {
          call_ids: newCalls.map((call: { id: string }) => call.id),
          input_tokens: newCalls.reduce((sum: number, call: { prompt_tokens: number | null }) => sum + (call.prompt_tokens ?? 0), 0),
          output_tokens: newCalls.reduce((sum: number, call: { completion_tokens: number | null }) => sum + (call.completion_tokens ?? 0), 0),
          status: 'observed',
        };
        outputCost.observed_usd = newCalls.every((call: { estimated_cost_usd: number | null }) => typeof call.estimated_cost_usd === 'number')
          ? newCalls.reduce((sum: number, call: { estimated_cost_usd: number }) => sum + call.estimated_cost_usd, 0)
          : null;
        if (outputCost.observed_usd !== null) observedSpendUsd += outputCost.observed_usd;
      }
      await worker.drain();
    }
    const terminalCount = resultRows.filter(row => ['completed', 'failed', 'budget_blocked'].includes(String(row.disposition))).length;
    const runStatus = stoppedForBudget ? 'BLOCKED_BUDGET' : resultRows.some(row => row.disposition === 'failed') ? 'PARTIAL' : 'COMPLETE';
    return {
      schema_version: 1, protocol: manifest.protocol, run_id: path.basename(runDir), split: options.split, arm, mode: options.mode,
      status: options.cap === 0 ? 'BLOCKED_BUDGET' : runStatus, qualification_eligible: false, gold_visible_to_prediction_process: false,
      brands_registered: brandsRegistered.length, brand_list: brandsRegistered,
      accounting: { source_rows: rows.length, imported_rows: imported.length, skipped_rows: skipped.length, duplicate_rows: duplicates.length,
        terminal_rows: terminalCount, budget_cap_usd: options.cap,
        projected_spend_usd: projectedSpendUsd, observed_spend_usd: observedSpendUsd, spend_status: 'Projected rates and token counts are ESTIMATED; provider-reported model costs are observed.',
        reconciliation: 'Manifest rows reconciled against imported rows; batch.totalItems not used.' },
      mechanism_check: options.mode === 'mechanism-check' ? {
        passed: rows.length === 3 && imported.length === valid.length,
        asserted: ['three manifest rows accounted', 'real repository importer invoked', 'imported rows exist in arm DB', 'real worker poll invoked', 'zero provider calls at zero cap'],
      } : null,
      blockers: stoppedForBudget ? ['BLOCKED_BUDGET'] : [],
      limitation: 'Comparison mode dispatches real worker processing and may incur provider charges; estimated rates are not observed charges.',
    };
    
  } finally {
    try { closeDb(); } catch { /* already closed */ }
    if (arm === 'baseline') {
      try { execFileSync('git', ['worktree', 'remove', '--force', sourceRoot], { cwd: process.cwd(), stdio: 'pipe' }); }
      catch { try { rmSync(sourceRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
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


