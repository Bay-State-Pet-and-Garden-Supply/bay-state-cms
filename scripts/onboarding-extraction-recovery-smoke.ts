#!/usr/bin/env bun
/**
 * Controlled R4 smoke: real worker/repository fixtures, local HTML only,
 * browser/model dispatch denied by test doubles, and no external spend.
 *
 * Run with: bun scripts/onboarding-extraction-recovery-smoke.ts
 */
import { spawnSync } from 'node:child_process';

const suites = [
  'src/tests/unit/extraction-identity-worker.test.ts',
  'src/tests/unit/page-extractor-ladder-wiring.test.ts',
  'src/tests/unit/accepted-item-evidence-db.test.ts',
];
const result = spawnSync('bun', ['test', ...suites], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
