#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { PRIVATE_ROOT, ROOT } from './onboarding-outcome';

const temp = mkdtempSync(path.join(ROOT, '.onboarding-outcome-smoke-'));
let runId: string | undefined;
try {
  const developmentPath = path.join(temp, 'development-input.json');
  const holdoutPath = path.join(temp, 'holdout-input.json');
  const relativeDevelopment = path.relative(ROOT, developmentPath);
  const relativeHoldout = path.relative(ROOT, holdoutPath);
  const rows = [0, 1, 2].map(index => ({ upc: `00000000000${index}`, register_name: `Controlled item ${index}`, price: index + 1 }));
  const payload = JSON.stringify(rows);
  writeFileSync(developmentPath, payload);
  const manifestPath = path.join(temp, 'manifest.json');
  const manifest = {
    schema_version: 1,
    protocol: 'onboarding-outcome-v1',
    status: 'BLOCKED',
    baseline: { ref: 'unused for candidate-only mechanism check', sha: 'unused' },
    candidate: { comparison_freeze_sha: null },
    population: {
      real_import_required: true,
      private_payload_paths: [relativeDevelopment, relativeHoldout],
      split_payload_paths: { development: [relativeDevelopment], holdout: [relativeHoldout] },
      sha256_commitments: { [relativeDevelopment]: createHash('sha256').update(payload).digest('hex') },
    },
    freeze: { holdout_labels_available_to_fit: false },
    blockers: ['BLOCKED_PREREQUISITE'],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = spawnSync('bun', [
    'scratch/run-comparison.ts', '--split', 'development', '--arm', 'candidate',
    '--mode', 'mechanism-check', '--max-spend-usd', '0', '--manifest', manifestPath,
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BAYSTATE_OUTCOME_SMOKE: randomUUID() } });
  if (result.status !== 0) throw new Error(`Development CLI input smoke failed (${result.status}): ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout) as { run_id?: string; source_rows?: number; mechanism_passed?: boolean };
  runId = report.run_id;
  if (report.source_rows !== 3 || report.mechanism_passed !== true) throw new Error(`Development CLI did not complete the controlled mechanism check: ${result.stdout}`);
  console.log(JSON.stringify({ status: 'PASS', source_rows: report.source_rows, absent_holdout_was_not_needed: true }));
} finally {
  if (runId) rmSync(path.join(ROOT, PRIVATE_ROOT, 'runs', runId), { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
}
