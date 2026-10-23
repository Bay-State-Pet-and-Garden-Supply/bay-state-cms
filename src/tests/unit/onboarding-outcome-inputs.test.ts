import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { loadRows, selectedPaths, verifyHashes, type Manifest, ROOT } from '../../../scratch/onboarding-outcome';

const temporary: string[] = [];
function tempRoot(): string {
  const directory = mkdtempSync(path.join(ROOT, '.onboarding-input-test-'));
  temporary.push(directory);
  return directory;
}
function manifest(development: string[], holdout: string[], commitments: Record<string, string> = {}): Manifest {
  return {
    schema_version: 1,
    protocol: 'onboarding-outcome-v1',
    status: 'BLOCKED',
    baseline: { ref: 'test', sha: 'test' },
    candidate: { comparison_freeze_sha: null },
    population: {
      real_import_required: true,
      private_payload_paths: [...development, ...holdout],
      split_payload_paths: { development, holdout },
      sha256_commitments: commitments,
    },
    freeze: { holdout_labels_available_to_fit: false },
    blockers: ['BLOCKED_PREREQUISITE'],
  };
}
function sha256(text: string): string { return createHash('sha256').update(text).digest('hex'); }
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('onboarding outcome split input isolation', () => {
  test('development selection reads and hashes only development while preserving imported values', () => {
    const directory = tempRoot();
    const dev = path.relative(ROOT, path.join(directory, 'development-input.json'));
    const holdout = path.relative(ROOT, path.join(directory, 'holdout-input.json'));
    expect(() => selectedPaths(manifest([holdout], [dev]))).toThrow(/wrong split/i);
    const payload = '[{"upc":"001234567890","register_name":"Leading-zero item","price":1.25,"row_id":"original-7"}]';
    writeFileSync(path.join(ROOT, dev), payload);

    const input = manifest([dev], [holdout], { [dev]: sha256(payload) });
    expect(selectedPaths(input, 'development')).toEqual([dev]);
    verifyHashes(input, 'development');
    expect(loadRows(input)).toEqual([{ upc: '001234567890', register_name: 'Leading-zero item', price: 1.25, row_id: 'original-7' }]);
  });

  test('rejects ambiguous declarations, opposite-split rows, labels and selected hash mismatches', () => {
    const directory = tempRoot();
    const dev = path.relative(ROOT, path.join(directory, 'development-input.json'));
    const holdout = path.relative(ROOT, path.join(directory, 'holdout-input.json'));
    expect(() => selectedPaths(manifest([dev], [dev]))).toThrow(/overlapping|ambiguous/i);
    writeFileSync(path.join(ROOT, dev), JSON.stringify([{ split: 'holdout', upc: '001', register_name: 'Item', price: 1 }]));
    expect(() => loadRows(manifest([dev], [holdout]), 'development')).toThrow(/opposite split/i);
    writeFileSync(path.join(ROOT, dev), JSON.stringify([{ upc: '001', register_name: 'Item', price: 1, expected: 'gold' }]));
    expect(() => loadRows(manifest([dev], [holdout]), 'development')).toThrow(/label-like/i);
    writeFileSync(path.join(ROOT, dev), '[]');
    expect(() => verifyHashes(manifest([dev], [holdout], { [dev]: '0'.repeat(64) }), 'development')).toThrow(/SHA-256 mismatch/i);
  });

  test('rejects production aliases and symlinks escaping the evaluation root', () => {
    const directory = tempRoot();
    const alias = path.relative(ROOT, path.join(directory, 'production.db'));
    writeFileSync(path.join(ROOT, alias), '[]');
    const holdout = path.relative(ROOT, path.join(directory, 'holdout-input.json'));
    expect(() => loadRows(manifest([alias], [holdout]))).toThrow(/production path\/alias/i);

    const outside = mkdtempSync(path.join(os.tmpdir(), 'onboarding-input-outside-'));
    temporary.push(outside);
    const outsideFile = path.join(outside, 'payload.json');
    writeFileSync(outsideFile, '[]');
    const link = path.join(directory, 'development-input.json');
    symlinkSync(outsideFile, link);
    const relativeLink = path.relative(ROOT, link);
    expect(() => loadRows(manifest([relativeLink], [holdout]))).toThrow(/symlink escapes/i);
  });
});
