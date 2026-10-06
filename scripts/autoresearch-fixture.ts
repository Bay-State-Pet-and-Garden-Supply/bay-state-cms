#!/usr/bin/env bun
/**
 * Classification-engine benchmark fixture generator (autoresearch harness).
 *
 * Scales the frozen bay-state-v9 representative dev corpus into a larger,
 * fully deterministic workload by deriving synthetic entries from the real
 * 23 gold entries: each replica keeps the same evidence text (so the
 * deterministic matchers do identical work) with a unique SKU/familyId so
 * bundle hashing, split checks, and family separation stay valid.
 *
 * No network, no time-of-day dependence, no randomness: SKU suffixes encode
 * the replica index. Output is deterministic byte-for-byte given the same
 * inputs (key order + JSON shape fixed; no timestamps inside).
 *
 * Usage:
 *   bun scripts/autoresearch-fixture.ts --replicas=<N> --out=<path>
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const flag = (name: string): string | null => {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};

const replicasRaw = flag('--replicas') ?? '40';
const outArg = flag('--out');
const replicas = Number(replicasRaw);
if (!Number.isInteger(replicas) || replicas < 1 || replicas > 1000) {
  throw new Error(`--replicas must be an integer in [1, 1000] (got "${replicasRaw}").`);
}
if (!outArg) throw new Error('fixture generator requires --out=<path>.');

const V9 = path.join(root, 'docs/audits/jev-representative-v9');
const gold = JSON.parse(fs.readFileSync(path.join(V9, 'development-gold-v9.json'), 'utf8')) as {
  entries: Array<Record<string, unknown> & { sku: string; familyId: string }>;
};

const scaled = [];
for (let r = 0; r < replicas; r++) {
  for (const entry of gold.entries) {
    const suffix = `-R${String(r).padStart(3, '0')}`;
    scaled.push({ ...entry, sku: `${entry.sku}${suffix}`, familyId: `${entry.familyId}${suffix}` });
  }
}
const doc = { ...gold, entries: scaled };
const outPath = path.resolve(root, outArg);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
console.error(`wrote ${scaled.length} entries (${gold.entries.length} x ${replicas}) to ${outArg}`);
