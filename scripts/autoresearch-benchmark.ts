#!/usr/bin/env bun
/**
 * Classification-engine benchmark runner (autoresearch harness).
 *
 * Measures the deterministic ShopSite-field classification path end to end:
 * loads the frozen bay-state-v9 dev corpus (scaled to a fixed replica count
 * by scripts/autoresearch-fixture.ts), executes the REAL deterministic-floor
 * capture (`buildQualificationPredictionsFromCode` — the shipped
 * matchKeywordOptions / matchAttributeOptions matcher precedence over product
 * types, attributes, and pages) plus the REAL offline scorer
 * (`evaluateJevOfflineComparison`), and verifies the scored artifact hash
 * against the pinned commitment to prove the workload actually ran.
 *
 * Deterministic: no network, no wall-clock dependence, fixed replica count.
 * Timing uses a median-of-repeats scheme; the runner reports the median wall
 * time per full pass as the primary metric (lower is better).
 *
 * The shipped dev-replay loader binds manifest/gold/taxonomy to a single
 * public artifact directory and only accepts known public basenames, so the
 * scaled workload is materialized into one temp directory:
 * `development-gold.json` + `taxonomy.json` are allowlisted basenames (no
 * manifest re-declaration needed; the copied manifest's sha pins still verify
 * the byte-identical taxonomy copy while absent siblings are skipped).
 *
 * Usage:
 *   bun scripts/autoresearch-benchmark.ts [--replicas=40] [--repeats=7]
 *
 * Emits (stdout, single lines):
 *   METRIC classification_pass_ms=<median ms per full capture+score pass>
 *   METRIC baseline_product_type_correctness=<baseline PT correctness>
 *   METRIC baseline_attribute_correctness=<baseline attribute correctness>
 *   METRIC baseline_page_correctness=<baseline page exact-match>
 *   METRIC artifact_hash=<sha256 of the scored deterministic artifact>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDevReplayInputs } from '../src/classification/jev-benchmark-replay';
import {
  buildQualificationPredictionsFromCode,
  withFrozenAuthorityDetails,
} from '../src/classification/benchmark-prediction';
import { evaluateJevOfflineComparison } from '../src/classification/jev-qualification-service';

const root = path.resolve(import.meta.dir, '..');
const flag = (name: string): string | null => {
  const eq = process.argv.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};
// Pinned commitment: the deterministic artifact hash for the default
// workload (replicas=40 over the frozen v9 corpus). Any code change that
// alters matcher behavior changes this hash and fails the harness loudly
// instead of silently benchmarking different work. Re-pinned deliberately
// for the `code-executed-v8` identity (P1-1: the digest now also covers the
// capture-time source-input commitment; matcher behavior unchanged).
const PINNED: Record<string, string> = {
  '40': '898d950f6b0a7d7b7f85e736be032efb8a4f6c90ca3800d3d07e4fa6c761b49e',
};

const replicas = Number(flag('--replicas') ?? '40');
const repeats = Number(flag('--repeats') ?? '7');
if (!Number.isInteger(replicas) || replicas < 1 || replicas > 1000) throw new Error(`--replicas out of range: ${replicas}`);
if (!Number.isInteger(repeats) || repeats < 3 || repeats > 51) throw new Error(`--repeats out of range: ${repeats}`);

const V9 = path.join(root, 'docs/audits/jev-representative-v9');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-workload-'));
{
  const proc = Bun.spawnSync(['bun', 'scripts/autoresearch-fixture.ts', `--replicas=${replicas}`,
    `--out=${path.join(workDir, 'development-gold.json')}`], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (proc.exitCode !== 0) throw new Error(`fixture generation failed (exit ${proc.exitCode}).`);
  fs.copyFileSync(path.join(V9, 'taxonomy.json'), path.join(workDir, 'taxonomy.json'));
  fs.copyFileSync(path.join(V9, 'development-manifest-v9.json'), path.join(workDir, 'manifest.json'));
}

const inputs = loadDevReplayInputs({
  manifestPath: path.join(workDir, 'manifest.json'),
  goldPath: path.join(workDir, 'development-gold.json'),
  taxonomyPath: path.join(workDir, 'taxonomy.json'),
});
const taxa = withFrozenAuthorityDetails(inputs.frozenSnapshot, inputs.authorityDetails);

buildQualificationPredictionsFromCode(inputs.goldEntries, taxa);

const samples: number[] = [];
let artifactHash = '';
let pt = 0;
let attr = 0;
let pages = 0;
for (let i = 0; i < repeats; i++) {
  const t0 = performance.now();
  const artifact = buildQualificationPredictionsFromCode(inputs.goldEntries, taxa);
  const goldset = {
    version: 'autoresearch-v1',
    description: 'autoresearch classification-engine benchmark (deterministic floor, dev)',
    adjudicatedBy: 'autoresearch-harness',
    verifiedPageImport: 0,
    frozenTaxonomy: inputs.frozenSnapshot,
    entries: inputs.goldEntries.map(e => {
      const p = artifact.predictions.find(x => x.sku === e.sku);
      if (!p) throw new Error(`missing prediction for ${e.sku}`);
      return {
        sku: e.sku,
        familyId: e.familyId,
        split: e.split,
        assortment: 'assortment' in e ? e.assortment : undefined,
        gold: e.gold,
        evidence: e.evidence,
        baseline: { ...p.baseline },
        candidate: { ...p.candidate },
      };
    }),
  };
  const report = evaluateJevOfflineComparison(goldset as never, 'dev');
  samples.push(performance.now() - t0);
  artifactHash = artifact.artifactHash;
  pt = report.productType.rawCorrectness.baseline;
  attr = report.attributes.rawCorrectness.baseline;
  pages = report.categoryPages.setMetrics.exactMatch.baseline;
}

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)]!;

const pinned = PINNED[String(replicas)];
if (pinned && pinned !== 'REPLACEME' && !artifactHash.startsWith(pinned.slice(0, 16))) {
  throw new Error(`artifact drift: scored ${artifactHash.slice(0, 16)}…, pinned ${pinned.slice(0, 16)}… (workload changed — re-pin deliberately, never silently).`);
}

console.log(`METRIC classification_pass_ms=${median.toFixed(2)}`);
console.log(`METRIC baseline_product_type_correctness=${pt.toFixed(4)}`);
console.log(`METRIC baseline_attribute_correctness=${attr.toFixed(4)}`);
console.log(`METRIC baseline_page_correctness=${pages.toFixed(4)}`);
console.log(`METRIC artifact_hash=${artifactHash.slice(0, 16)}`);
console.error(`entries=${inputs.entryCount} repeats=${repeats} medianMs=${median.toFixed(2)} hash=${artifactHash.slice(0, 16)}`);
