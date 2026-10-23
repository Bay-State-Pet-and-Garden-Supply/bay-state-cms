/**
 * Evaluation-only runner: import only the selected development split, preflight
 * every requested arm, then release arms to a bounded worker stopping at review.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_MANIFEST,
  PRIVATE_ROOT,
  loadRows,
  outputPath,
  readManifest,
  rejectProductionPath,
  rootPath,
  hashFile,
  verifyHashes,
  writeJson,
  type Row,
} from './onboarding-outcome';
import { preflightComparisonArm, releaseComparisonArm, type ArmBootstrapOptions, type ArmPreflightResult, type ArmResult, type PopulationRow } from './comparison-arm';
import { captureComparisonArm, unavailableComparisonCapture, writeComparisonCapture, type ComparisonCaptureBundle } from './comparison-capture';
import { projectComparisonRows, type ComparisonInput } from './comparison-report';
import { closeDb, initDb } from '../src/db/connection';
import { readQualificationFreeze } from './comparison-runtime';

const CREDENTIAL_ENV_KEYS = ['SERPER_API_KEY', 'TYPESAFE_API_KEY'] as const;

type Options = { split: 'development' | 'holdout'; arm: 'baseline' | 'candidate' | 'both'; mode: 'comparison' | 'mechanism-check'; cap: number; manifest: string; freeze?: string; privateRoot?: string; workspace?: string; rowIds?: string[] };
type Arm = 'baseline' | 'candidate';
const usage = 'Usage: bun scratch/run-comparison.ts --split development|holdout --arm baseline|candidate|both --mode comparison|mechanism-check --max-spend-usd USD [--manifest path] --freeze path --private-root path --workspace path [--row-id DEV-0001 ...]';

function parseArgs(argv: string[]): Options {
  const values: Record<string, string> = {};
  const rowIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === '--row-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${usage}\nMissing value for ${key}`);
      rowIds.push(value);
      continue;
    }
    if (!['--split', '--arm', '--mode', '--max-spend-usd', '--manifest', '--freeze', '--private-root', '--workspace'].includes(key) || Object.hasOwn(values, key)) throw new Error(`${usage}\nInvalid or repeated option: ${key}`);
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
  if (!Number.isFinite(cap) || cap < 0 || cap > 3) throw new Error('--max-spend-usd must be a finite amount from 0 through 3.');
  if (mode === 'mechanism-check' && (split !== 'development' || cap !== 0)) throw new Error('mechanism-check requires --split development and --max-spend-usd 0.');
  return {
    split: split as Options['split'], arm: arm as Options['arm'], mode: mode as Options['mode'], cap,
    manifest: values['--manifest'] ?? DEFAULT_MANIFEST, freeze: values['--freeze'],
    privateRoot: values['--private-root'], workspace: values['--workspace'],
    rowIds: rowIds.length ? [...new Set(rowIds)] : undefined,
  };
}


export async function runArmBarrier<T, R>(
  arms: readonly Arm[],
  preflight: (arm: Arm) => Promise<{ prepared?: T; denial?: string }>,
  release: (arm: Arm, prepared: T) => Promise<R>,
  releaseEnabled = true,
): Promise<{ preflight: Array<{ arm: Arm; prepared?: T; denial?: string }>; results: Array<{ arm: Arm; result: R }> }> {
  const checked: Array<{ arm: Arm; prepared?: T; denial?: string }> = [];
  for (const arm of arms) checked.push({ arm, ...(await preflight(arm)) });
  if (!releaseEnabled || checked.some(item => !item.prepared || item.denial)) return { preflight: checked, results: [] };
  const results: Array<{ arm: Arm; result: R }> = [];
  for (const item of checked) results.push({ arm: item.arm, result: await release(item.arm, item.prepared!) });
  return { preflight: checked, results };
}

function hasOnlyAllowedInput(row: Row): boolean {
  return typeof row.upc === 'string' && typeof row.register_name === 'string' && typeof row.price === 'number';
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(usage); return; }
  const options = parseArgs(process.argv.slice(2));
  const manifestFile = rootPath(options.manifest);
  if (!existsSync(manifestFile)) throw new Error(`Manifest not found: ${manifestFile}`);
  const manifest = readManifest(manifestFile);
  if (options.split === 'holdout') throw new Error('Holdout execution is unavailable; no labels may enter prediction.');
  if (!options.freeze || !options.workspace) throw new Error('A committed runtime freeze and declared workspace path are required.');
  if (!manifest.candidate.comparison_freeze_sha) throw new Error('Manifest has no committed candidate comparison freeze.');
  const freezePath = rootPath(options.freeze);
  if (hashFile(freezePath).toLowerCase() !== manifest.candidate.comparison_freeze_sha.toLowerCase()) throw new Error('Runtime freeze does not match the manifest commitment.');
  verifyHashes(manifest, options.split);
  const sourceRows = loadRows(manifest, options.split);
  if (sourceRows.some(row => Object.keys(row).some(key => /gold|label|truth|expected/i.test(key)))) throw new Error('Source payload contains gold/label-like fields.');
  const selectedRows = options.mode === 'mechanism-check' ? sourceRows.slice(0, 3) : options.rowIds ? sourceRows.filter(row => typeof row.row_id === 'string' && options.rowIds!.includes(row.row_id)) : sourceRows;
  if (options.rowIds && selectedRows.length !== options.rowIds.length) throw new Error(`Row filter matched ${selectedRows.length} of ${options.rowIds.length} requested rows.`);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const arms: Arm[] = options.arm === 'both' ? ['baseline', 'candidate'] : [options.arm];
  const privateRoot = rootPath(options.privateRoot ?? PRIVATE_ROOT);
  const workspacePath = rootPath(options.workspace);
  const runDir = rootPath(`${PRIVATE_ROOT}/runs/${runId}`);
  mkdirSync(runDir, { recursive: true });
  const byArm = new Map<Arm, ArmBootstrapOptions>();
  for (const arm of arms) {
    const armDir = path.join(runDir, arm);
    rejectProductionPath(armDir, 'evaluation path');
    mkdirSync(path.join(armDir, 'db'), { recursive: true });
    byArm.set(arm, {
      arm, freezePath, privateRoot, workspacePath, destinationRoot: path.join(armDir, 'runtime'),
      dbPath: path.join(armDir, 'db', 'evaluation.sqlite'),
    });
  }
  // Operator-attested brand hints for the predeclared pilot (source-reviewed 2026-10-22).
  // NOT inferred: dev rows carry no brand field, and first-token guessing misattributes
  // (e.g. DEV-0039 "PURE" is actually NutriSource). Unlisted rows enter with no hint.
  const ATTESTED_BRAND_HINTS: Record<string, string> = { 'DEV-0015': 'WOOF' };
  const seenUpcs = new Set<string>();
  const population = selectedRows.flatMap(row => {
    if (!hasOnlyAllowedInput(row) || typeof row.upc !== 'string' ||
      (typeof row.disposition === 'string' && ['invalid', 'duplicate', 'skipped_existing'].includes(row.disposition)) ||
      seenUpcs.has(row.upc)) return [];
    seenUpcs.add(row.upc);
    return [{ upc: row.upc, register_name: row.register_name as string, price: row.price as number, brandHint: typeof row.row_id === 'string' ? ATTESTED_BRAND_HINTS[row.row_id] ?? null : null }];
  });
  // Credential files: one 0600 temp file per arm under the private run dir,
  // carrying ONLY declared env keys. Never logged, never committed, removed after release.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const credDir = mkdtempSync(path.join(tmpdir(), 'qual-creds-'));
  try { require('node:fs').chmodSync(credDir, 0o700); } catch { /* best effort */ }
  const credentialFdByArm = new Map<Arm, number>();
  const { openSync, writeSync, closeSync } = await import('node:fs');
  for (const arm of arms) {
    const supplied: Record<string, string> = {};
    for (const key of CREDENTIAL_ENV_KEYS) if (process.env[key]) supplied[key] = process.env[key]!;
    const credPath = path.join(credDir, `${arm}.json`);
    writeFileSync(credPath, JSON.stringify(supplied), { mode: 0o600 });
    const readFd = openSync(credPath, 'r');
    byArm.get(arm)!.credentialFd = readFd;
  }
  const barrier = await runArmBarrier<NonNullable<ArmPreflightResult['prepared']>, ArmResult>(
    arms,
    async arm => {
      const result = await preflightComparisonArm(byArm.get(arm)!, population);
      return { prepared: result.prepared, denial: result.denial };
    },
    (arm, prepared) => releaseComparisonArm(byArm.get(arm)!, prepared),
    options.cap > 0 && options.mode === 'comparison',
  );
  for (const fd of credentialFdByArm.values()) try { closeSync(fd); } catch { /* already closed */ }
  rmSync(credDir, { recursive: true, force: true });
  const outputs: string[] = [];
  const results = barrier.results.length
    ? barrier.results.map(({ result }) => result)
    : barrier.preflight.map(({ arm, prepared, denial }) => ({
      arm, stop: denial ? 'preflight_denied' as const : 'denied' as const,
      imported: prepared?.imported ?? 0, polls: 0,
      state: prepared ? { phase: 'held', batchId: prepared.batchId, itemIds: prepared.itemIds, executionState: 'paused' } : null,
      denial: denial ?? 'Release is disabled for zero-spend mechanism checks.',
    }));
  const freeze = await readQualificationFreeze(freezePath);
  const reportRows: Record<string, unknown>[] = [];
  for (const report of results) {
    const file = outputPath(`${PRIVATE_ROOT}/runs/${runId}/${report.arm}/raw.json`);
    writeJson(file, { schema_version: 3, protocol: manifest.protocol, run_id: runId, split: options.split, ...report });
    outputs.push(file);
    const prepared = barrier.preflight.find(entry => entry.arm === report.arm)?.prepared;
    const inputs: ComparisonInput[] = selectedRows.map(row => ({
      row_id: typeof row.row_id === 'string' ? row.row_id : undefined,
      upc: typeof row.upc === 'string' ? row.upc : null,
      register_name: typeof row.register_name === 'string' ? row.register_name : null,
      price: typeof row.price === 'number' ? row.price : null,
      source_disposition: typeof row.disposition === 'string' ? row.disposition : null,
      import_disposition: typeof row.disposition === 'string' && ['invalid', 'skipped_existing', 'duplicate', 'missing_output'].includes(row.disposition)
        ? row.disposition as ComparisonInput['import_disposition']
        : hasOnlyAllowedInput(row) ? 'imported' : 'invalid',
    }));
    if (!prepared) {
      reportRows.push({ arm: report.arm, report: projectComparisonRows(inputs, [], [], {
        measurementMode: freeze.mode, paired: arms.length === 2,
        terminalStop: report.stop === 'no-progress' ? 'no_progress' : report.stop === 'deadline' ? 'deadline_exceeded' :
          report.stop === 'failed' ? 'failed' : report.stop === 'denied' || report.stop === 'preflight_denied' ? 'policy_or_budget_denied' : undefined,
      }), capture_completeness: 'unavailable', unavailable: ['arm_not_prepared'] });
      continue;
    }
    initDb(byArm.get(report.arm)!.dbPath);
    try {
      let bundle: ComparisonCaptureBundle;
      try {
        bundle = captureComparisonArm({
          runId, arm: report.arm, mode: freeze.mode, batchId: prepared.batchId,
          workspaceId: freeze.workspaceId, sourceRows: inputs, originalRows: selectedRows,
        });
      } catch {
        bundle = unavailableComparisonCapture({ runId, arm: report.arm, mode: freeze.mode, sourceRows: inputs, originalRows: selectedRows, reason: 'repository_reader_failed' });
      }
      await writeComparisonCapture(outputPath(`${PRIVATE_ROOT}/runs/${runId}/${report.arm}/capture.json`), bundle);
      reportRows.push({ arm: report.arm, report: projectComparisonRows(inputs, bundle.items, bundle.sources, {
        measurementMode: freeze.mode, costs: bundle.budget_journal.effects, paired: arms.length === 2,
        terminalStop: report.stop === 'no-progress' ? 'no_progress' : report.stop === 'deadline' ? 'deadline_exceeded' :
          report.stop === 'failed' ? 'failed' : report.stop === 'denied' || report.stop === 'preflight_denied' ? 'policy_or_budget_denied' : undefined,
      }), capture_completeness: bundle.completeness, unavailable: bundle.unavailable });
    } finally {
      closeDb();
    }
  }
  if (reportRows.length) {
    const canonical = outputPath(`${PRIVATE_ROOT}/runs/${runId}/comparison-report.json`);
    writeJson(canonical, { schema_version: 1, run_id: runId, mode: freeze.mode, arms: reportRows, paired_status: reportRows.length !== arms.length || reportRows.some(row => row.capture_completeness !== 'complete') ? 'blocked' : 'reported' });
    outputs.push(canonical);
  }
  const finished = results.every(result => result.stop === 'review_ready' || result.stop === 'needs_input');
  const denied = results.some(result => result.stop === 'preflight_denied' || result.stop === 'denied');
  console.log(JSON.stringify({ run_id: runId, arms, source_rows: selectedRows.length, status: denied ? 'DENIED' : finished ? 'STOPPED_AT_TYPED_OUTCOME' : 'INCOMPLETE', per_arm: results, outputs }, null, 2));
  if (!finished) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => {
  console.error(`run-comparison: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});


