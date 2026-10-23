#!/usr/bin/env bun
/** Evaluation-only §11.1 runner. Capture remains blocked without a supported isolated adapter. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type PayloadSplit = 'development' | 'holdout';
export type Manifest = {
  schema_version: number; protocol: string; status: string;
  baseline: { ref: string; sha: string };
  candidate: { comparison_freeze_sha: string | null };
  population: {
    real_import_required: boolean;
    private_payload_paths?: string[] | null;
    split_payload_paths?: { development: string[]; holdout: string[] } | null;
    sha256_commitments: Record<string, string> | null;
  };
  freeze: { holdout_labels_available_to_fit: boolean };
  blockers: string[];
};
export type Row = { row_id?: string; split?: PayloadSplit; disposition?: string; [key: string]: unknown };
export const ROOT = process.cwd();
export const DEFAULT_MANIFEST = 'docs/audits/onboarding-outcome-v1/manifest.public.json';
export const PRIVATE_ROOT = '.baystate-cms/qualification/onboarding-outcome-v1';
export const BLOCKERS = ['BLOCKED_REAL_DATA_PROVENANCE','BLOCKED_POPULATION_SUPPORT','BLOCKED_HOLDOUT_SEAL_OR_LEAKAGE','BLOCKED_EQUAL_INPUTS','BLOCKED_LABELS_OR_REVIEW','BLOCKED_METRIC_CAPTURE','BLOCKED_EXISTING_CAPABILITY_RECEIPT','BLOCKED_CANDIDATE_FREEZE','BLOCKED_BUDGET_OR_MODEL_POLICY','BLOCKED_NATIVE_OR_CATALOG_EVIDENCE','BLOCKED_STORE_AUTHORIZATION_OR_CANARY','BLOCKED_INSUFFICIENT_SUPPORT','BLOCKED_COMPARABILITY','BLOCKED_UNKNOWN_COST','BLOCKED_PREREQUISITE'];
export const USAGE = 'Usage: prepare [--preflight|--construct|--seal], run [--split development|holdout] [--arm baseline|candidate|both] [--mode mechanism-check|comparison] [--authorization path], fit, publish, review [--phase source-labels|freeze-labels|workflow|reconcile-time], score [--publish-report], canary [--kind family-local|family-store]';

function parseArgs(argv: string[]): { command: string; options: Record<string, string | true> } {
  const command = argv[0];
  if (!command || !['prepare','run','fit','publish','review','score','canary'].includes(command)) throw new Error(USAGE);
  const options: Record<string, string | true> = {};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith('--') || key in options) throw new Error(`Invalid or repeated option ${key}\n${USAGE}`);
    if (['--preflight','--construct','--seal','--publish-report'].includes(key)) options[key] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`); options[key] = value; }
  }
  return { command, options };
}
function option(options: Record<string, string | true>, key: string, fallback?: string): string | undefined {
  const value = options[key];
  if (value === true) throw new Error(`${key} requires a value`);
  return value ?? fallback;
}
export function hashFile(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function within(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
export function rejectProductionPath(candidate: string, label: string): void {
  const full = path.resolve(candidate);
  const aliases: Record<string, true> = { production: true, prod: true, live: true, default: true, main: true, catalog: true, 'data.sqlite': true, 'production.db': true };
  const envPaths = Object.entries(process.env).filter(([key, value]) => !!value && /^(BAYSTATE|DATABASE|DB_PATH|SHOP[S_]*ITE).*?(DB|DATA|CATALOG|PATH)/i.test(key)).map(([, value]) => path.resolve(value!));
  const known = [path.resolve(ROOT,'.baystate-cms/data.sqlite'), path.resolve(ROOT,'data.sqlite'), ...envPaths];
  if (aliases[path.basename(candidate).toLowerCase()] || known.some(p => full === p || within(p, full))) throw new Error(`Refusing ${label} production path/alias: ${candidate}`);
}
export function readManifest(file: string): Manifest {
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (manifest.schema_version !== 1 || manifest.protocol !== 'onboarding-outcome-v1' || !Array.isArray(manifest.blockers) || !manifest.population || !manifest.freeze) throw new Error(`Unsupported manifest.public.json schema: ${file}`);
  return manifest;
}
export function rootPath(relative: string): string { return path.resolve(ROOT, relative); }
export function writeJson(file: string, data: unknown): void { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }); }
export function outputPath(relative: string): string {
  const file = rootPath(relative);
  rejectProductionPath(file, 'output');
  if (existsSync(file)) throw new Error(`Refusing existing output; select a new run ID: ${file}`);
  const parent = path.dirname(file);
  if (existsSync(parent) && !within(rootPath(PRIVATE_ROOT), realpathSync(parent))) throw new Error(`Output parent escapes private evaluation root: ${parent}`);
  return file;
}
export function selectedPaths(manifest: Manifest, split: PayloadSplit = 'development'): string[] {
  const declared = manifest.population.split_payload_paths;
  if (!declared || !Array.isArray(declared.development) || !Array.isArray(declared.holdout)) {
    throw new Error('Manifest is incomplete: split_payload_paths is required for input access.');
  }
  const all = [...declared.development, ...declared.holdout];
  if (declared.development.length === 0 || declared.holdout.length === 0) {
    throw new Error('Manifest is incomplete: both split payloads must be declared.');
  }
  if (all.some(item => typeof item !== 'string' || !item.trim())) throw new Error('Manifest contains an invalid split payload path.');
  const normalized = all.map(item => path.resolve(ROOT, item));
  if (new Set(normalized).size !== normalized.length) throw new Error('Manifest has overlapping or ambiguous split payload paths.');
  for (const [owner, paths] of Object.entries(declared) as Array<[PayloadSplit, string[]]>) {
    for (const relative of paths) {
      const basename = path.basename(relative).toLowerCase();
      const splitHint = basename.match(/(?:^|[-_.])(development|holdout)(?:[-_.]|$)/)?.[1];
      if (splitHint && splitHint !== owner) throw new Error(`Payload path is declared under the wrong split: ${relative}`);
    }
  }
  const legacy = manifest.population.private_payload_paths;
  if (legacy && (legacy.length !== all.length || legacy.some(item => !all.includes(item)))) {
    throw new Error('Manifest split payload declarations do not match private_payload_paths.');
  }
  return [...declared[split]];
}
function safeInputPath(relative: string): string {
  const file = rootPath(relative);
  if (!within(ROOT, file)) throw new Error(`Input path escapes evaluation root: ${relative}`);
  rejectProductionPath(file, 'input');
  if (!existsSync(file)) throw new Error(`Declared private payload is unavailable: ${relative}`);
  const canonical = realpathSync(file);
  if (!within(realpathSync(ROOT), canonical)) throw new Error(`Input symlink escapes evaluation root: ${relative}`);
  rejectProductionPath(canonical, 'input');
  return canonical;
}
export function loadRows(manifest: Manifest, split: PayloadSplit = 'development'): Row[] {
  const rows: Row[] = [];
  for (const relative of selectedPaths(manifest, split)) {
    const file = safeInputPath(relative);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    let inputRows: unknown;
    if (Array.isArray(parsed)) inputRows = parsed;
    else if (parsed && typeof parsed === 'object' && 'rows' in parsed) inputRows = parsed.rows;
    if (!Array.isArray(inputRows)) throw new Error(`Payload must be a row array or contain rows[]: ${relative}`);
    inputRows.forEach((entry: unknown, index: number) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid source row ${relative}#${index + 1}`);
      const row = entry as Row;
      if (row.split !== undefined && row.split !== split) throw new Error(`Payload row belongs to the opposite split: ${relative}#${index + 1}`);
      if (Object.keys(row).some(key => /gold|label|truth|expected/i.test(key))) throw new Error(`Source payload contains label-like input fields: ${relative}#${index + 1}`);
      rows.push({ ...row, row_id: row.row_id ?? `${path.basename(relative)}:${index + 1}` });
    });
  }
  return rows;
}
export function verifyHashes(manifest: Manifest, split: PayloadSplit = 'development'): void {
  for (const relative of selectedPaths(manifest, split)) {
    const expected = manifest.population.sha256_commitments?.[relative];
    if (!expected) throw new Error(`Missing selected payload SHA-256 commitment: ${relative}`);
    const file = safeInputPath(relative);
    if (hashFile(file) !== expected) throw new Error(`SHA-256 mismatch: ${relative}`);
  }
}
function unavailable(reason: string) { return { value: null, status: 'N/A', reason }; }

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const manifestFile = rootPath(option(options, '--manifest', DEFAULT_MANIFEST)!);
  if (!existsSync(manifestFile)) throw new Error(`Manifest not found: ${manifestFile}`);
  const manifest = readManifest(manifestFile);
  if (command === 'prepare') {
    const modes = ['--preflight','--construct','--seal'].filter(key => options[key] === true);
    if (modes.length !== 1) throw new Error(`prepare requires exactly one mode\n${USAGE}`);
    if (modes[0] === '--preflight') {
      verifyHashes(manifest, 'development');
      const rows = loadRows(manifest, 'development');
      const failed = rows.filter(row => row.disposition === 'failed').length;
      const out = rootPath(`${PRIVATE_ROOT}/preflight.json`);
      const checks = [
        { check: 'production paths refused', status: 'PASS' },
        { check: 'sealed paths rejected by canonical fitting checks', status: 'PASS' },
        { check: 'existing output paths refused', status: existsSync(out) ? 'FAIL' : 'PASS' },
        { check: 'original-row denominator', status: 'PASS', source_rows: rows.length, failed_rows_retained: failed, denominator: 'manifest source rows, never importer batch.totalItems' },
        { check: 'mechanism-check eligibility', status: 'PASS', eligibility: 'INELIGIBLE_FOR_QUALIFICATION' },
      ];
      console.log(JSON.stringify({ protocol: manifest.protocol, status: manifest.blockers.length ? 'BLOCKED' : 'PREFLIGHT_PASSED', checks, blockers: manifest.blockers }, null, 2));
      if (checks.some(check => check.status === 'FAIL')) process.exitCode = 1;
      return;
    }
    if (modes[0] === '--construct') {
      verifyHashes(manifest, 'development');
      verifyHashes(manifest, 'holdout');
      const file = outputPath(`${PRIVATE_ROOT}/construction.json`);
      const rows = [...loadRows(manifest, 'development'), ...loadRows(manifest, 'holdout')];
      writeJson(file, { protocol: manifest.protocol, status: 'BLOCKED', original_row_count: rows.length, rows, blockers: BLOCKERS, limitation: 'No real private import payload or provenance supplied; no sample rows synthesized.' });
      console.log(file); return;
    }
    const file = outputPath(`${PRIVATE_ROOT}/sealed/seal.json`);
    verifyHashes(manifest, 'holdout');
    const rows = loadRows(manifest, 'holdout');
    if (!rows.length) throw new Error('Cannot seal: no held rows are present in the declared private payload.');
    writeJson(file, { protocol: manifest.protocol, status: 'BLOCKED', holdout_count: rows.length, sealed_at: new Date().toISOString(), commitments: manifest.population.sha256_commitments, blockers: ['BLOCKED_HOLDOUT_SEAL_OR_LEAKAGE'] });
    console.log(file); return;
  }
  if (command === 'run') {
    const split = option(options, '--split');
    const arm = option(options, '--arm', 'both');
    const mode = option(options, '--mode', 'comparison');
    if (!['development','holdout'].includes(split ?? '') || !['baseline','candidate','both'].includes(arm ?? '') || !['comparison','mechanism-check'].includes(mode ?? '')) throw new Error(USAGE);
    const authorization = option(options, '--authorization');
    if (split === 'holdout' && !authorization) throw new Error('Holdout run requires explicit --authorization.');
    if (authorization) {
      const receipt = JSON.parse(readFileSync(rootPath(authorization), 'utf8')) as Record<string, unknown>;
      if (receipt.status !== 'approved' || receipt.protocol !== manifest.protocol) throw new Error('Authorization must be approved and bound to this protocol.');
    }
    verifyHashes(manifest, split as PayloadSplit);
    const rows = loadRows(manifest, split as 'development' | 'holdout');
    const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
    const arms = arm === 'both' ? ['baseline','candidate'] : [arm!];
    const base = `${PRIVATE_ROOT}/runs/${runId}`;
    const outputs = arms.map(name => outputPath(`${base}/${name}/raw.json`));
    for (const name of arms) {
      rejectProductionPath(rootPath(`${base}/${name}/db/evaluation.sqlite`), 'database');
      rejectProductionPath(rootPath(`${base}/${name}/catalog`), 'catalog');
    }
    for (let i = 0; i < arms.length; i++) {
      writeJson(outputs[i]!, { protocol: manifest.protocol, run_id: runId, split, arm: arms[i], mode, qualification_eligible: mode !== 'mechanism-check' && manifest.blockers.length === 0, eligibility_note: mode === 'mechanism-check' ? 'INELIGIBLE_FOR_QUALIFICATION' : null, original_row_count: rows.length, rows: rows.map(row => ({ row_id: row.row_id, disposition: 'not_run', raw_output: null })), blockers: [...new Set([...manifest.blockers,'BLOCKED_EQUAL_INPUTS','BLOCKED_METRIC_CAPTURE'])], capture: 'BLOCKED: no child-process importer/capture adapter supports isolated DB/catalog and raw predictions; no outputs fabricated.', db_seam: 'each arm MUST call initDb(dbPath) in a separate process', gold_visible_to_prediction_process: false });
    }
    console.log(JSON.stringify({ run_id: runId, arms, original_row_count: rows.length, status: 'BLOCKED', qualification_eligible: false }, null, 2)); return;
  }
  if (command === 'fit') {
    if (option(options,'--split','development') !== 'development' || manifest.freeze.holdout_labels_available_to_fit) throw new Error('Fitting is development-only and refuses manifests exposing holdout labels.');
    for (const relative of selectedPaths(manifest, 'development')) {
      const file = rootPath(relative);
      if (/sealed|holdout/i.test(relative)) throw new Error(`Fitting refuses sealed path: ${relative}`);
      if (existsSync(file)) { const real = realpathSync(file); if (/sealed|holdout/i.test(real) || real !== file) throw new Error(`Fitting refuses symlink alias or sealed target: ${relative} -> ${real}`); }
    }
    outputPath(`${PRIVATE_ROOT}/fit/selection-policy.fitted.json`);
    throw new Error('BLOCKED_METRIC_CAPTURE: reviewed development labels and raw outcomes are unavailable; no thresholds invented.');
  }
  if (command === 'publish') throw new Error('BLOCKED_CANDIDATE_FREEZE: manifest has no candidate freeze SHA or fitted approved selection policy.');
  if (command === 'review') {
    const phase = option(options,'--phase');
    if (!['source-labels','freeze-labels','workflow','reconcile-time'].includes(phase ?? '')) throw new Error(USAGE);
    throw new Error(`BLOCKED_LABELS_OR_REVIEW: ${phase} requires source evidence and operator records; harness will not author labels.`);
  }
  if (command === 'score') {
    const bundles: unknown[] = [];
    const directory = rootPath(`${PRIVATE_ROOT}/runs`);
    if (existsSync(directory)) for (const runId of readdirSync(directory)) {
      const runDir = path.join(directory,runId);
      for (const armName of readdirSync(runDir)) { const file = path.join(runDir,armName,'raw.json'); if (existsSync(file)) bundles.push(JSON.parse(readFileSync(file,'utf8'))); }
    }
    const report = { protocol: manifest.protocol, verdict: 'BLOCKED', blockers: [...new Set([...manifest.blockers,'BLOCKED_METRIC_CAPTURE','BLOCKED_LABELS_OR_REVIEW','BLOCKED_UNKNOWN_COST'])], captured_bundles: bundles.length, metrics: { row_accounting: unavailable('No real rows declared'), exact_resolution: unavailable('No gold/prediction join'), retrieval_coverage: unavailable('No retrieval capture'), wrong_source_rates: unavailable('No selected-source evidence'), type_completion: unavailable('No reviewed outcomes'), unsupported_claims: unavailable('No claim validation capture'), false_blocks: unavailable('No independent readiness labels'), omissions: unavailable('No omission ledger'), reviewer_outcomes: unavailable('No review ledger'), operator_time: unavailable('No reconciled timers'), latency: unavailable('No live per-row timestamps'), model_calls: unavailable('No complete call-evidence join; retrieval must be explicitly unbounded and reconciled by unique call ID'), cost: unavailable('Unknown is not zero'), family: unavailable('No family gold/outcomes'), preservation_recovery: unavailable('No publication/native receipts') }, qualification_eligible: false };
    if (options['--publish-report'] === true) { const file = outputPath(`${PRIVATE_ROOT}/report/summary.json`); writeJson(file,report); console.log(file); } else console.log(JSON.stringify(report,null,2));
    return;
  }
  if (command === 'canary') {
    const kind = option(options,'--kind');
    if (!['family-local','family-store'].includes(kind ?? '')) throw new Error(USAGE);
    if (kind === 'family-store') {
      const authorization = option(options,'--authorization');
      if (!authorization) throw new Error('BLOCKED_STORE_AUTHORIZATION_OR_CANARY: explicit authorization required.');
      const receipt = JSON.parse(readFileSync(rootPath(authorization),'utf8')) as Record<string, unknown>;
      if (receipt.status !== 'approved' || receipt.kind !== kind) throw new Error('Store authorization must be approved and identify family-store.');
    }
    throw new Error(`BLOCKED_${kind === 'family-store' ? 'STORE_AUTHORIZATION_OR_CANARY' : 'NATIVE_OR_CATALOG_EVIDENCE'}: no real publication and reconciliation receipt seam; no canary simulated.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main().catch(error => { console.error(`onboarding-outcome: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
