#!/usr/bin/env bun
/**
 * TypeSafe Jev Curation Workflow Qualification Runner (Issue #302, blocker fix #293).
 *
 * Offline evaluation compares current deterministic baseline vs TypeSafe Jev
 * candidate paths over a frozen GOLD-ONLY fixture
 * (`src/tests/fixtures/benchmark-jev-qualification-goldset.json` carries
 * adjudicated gold labels + evidence — never stored predictions). Both
 * prediction sides are EXECUTED from the current classification code
 * (`buildQualificationPredictionsFromCode`) into an immutable,
 * hash-bound artifact, and that artifact is what gets scored by the existing
 * evaluator (`evaluateJevOfflineComparison`). Legacy fixture copies that
 * still embed `baseline`/`candidate` keys load fine — those keys are ignored
 * and never scored.
 *
 * Live evidence is wired, not hardcoded: `--live-check` (or
 * TYPESAFE_LIVE_CHECK=1) with a provisioned TYPESAFE_API_KEY executes the
 * real bounded contract script as a subprocess and feeds its actual result
 * into the qualification assessment. Staged-canary sign-offs are read from
 * an explicit receipts file (TYPESAFE_CANARY_RECEIPTS_PATH) or
 * TYPESAFE_CANARY_*_REVIEWED env flags — defaulting to unreviewed
 * (fail-closed) when absent.
 *
 * Usage:
 *   bun scripts/typesafe-curation-qualification.ts [--split dev|holdout] [--json] [--live-check] [--model jev-1.13.0] [--artifact-out path]
 *   TYPESAFE_LIVE_CHECK=1 TYPESAFE_API_KEY=... bun scripts/typesafe-curation-qualification.ts --live-check
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateJevOfflineComparison,
  assessProductionQualification,
  type QualificationGoldset,
} from '../src/classification/jev-qualification-service';
import {
  parseQualificationGoldOnly,
  buildQualificationPredictionsFromCode,
  QUALIFICATION_PREDICTOR_VERSION,
} from '../src/classification/benchmark-prediction';

const GOLDSET_PATH = path.resolve(
  import.meta.dir,
  '../src/tests/fixtures/benchmark-jev-qualification-goldset.json',
);
const LIVE_CHECK_PATH = path.resolve(import.meta.dir, './typesafe-live-contract-check.ts');

const isJson = process.argv.includes('--json');
const isLiveCheckFlag = process.argv.includes('--live-check');
const splitArg = process.argv.find(a => a.startsWith('--split='))?.split('=')[1] as 'dev' | 'holdout' | undefined;
const modelArg = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];
const artifactOutArg = process.argv.find(a => a.startsWith('--artifact-out='))?.split('=')[1];

if (!fs.existsSync(GOLDSET_PATH)) {
  console.error(`Goldset fixture not found at ${GOLDSET_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(GOLDSET_PATH, 'utf8'));
// Fail-closed on legacy authored predictions: they may exist in older copies
// for readability, but they must never be scored. The loader strips them;
// this notice makes any such copy visible instead of silently trusted.
if (Array.isArray(raw.entries) && raw.entries.some((e: unknown) => {
  const r = e as Record<string, unknown>;
  return 'baseline' in r || 'candidate' in r;
})) {
  console.error(
    'Note: fixture copy embeds legacy baseline/candidate predictions; ignoring them — predictions will be executed from code.',
  );
}
const goldEntries = parseQualificationGoldOnly(raw);

// 1. Execute the current baseline + Jev candidate paths into an immutable artifact.
const artifact = buildQualificationPredictionsFromCode(goldEntries);

// 2. Score the executed artifact with the existing evaluator (unchanged).
const goldset: QualificationGoldset = {
  version: raw.version,
  description: raw.description,
  adjudicatedBy: raw.adjudicatedBy,
  verifiedPageImport: raw.verifiedPageImport,
  entries: goldEntries.map(e => {
    const p = artifact.predictions.find(x => x.sku === e.sku);
    if (!p) throw new Error(`Missing executed prediction for gold entry "${e.sku}".`);
    return {
      sku: e.sku,
      familyId: e.familyId,
      split: e.split,
      assortment: e.assortment,
      gold: e.gold,
      evidence: e.evidence,
      baseline: { ...p.baseline },
      candidate: { ...p.candidate },
    };
  }),
};

const comparisonReport = evaluateJevOfflineComparison(goldset, splitArg);

if (artifactOutArg) {
  fs.writeFileSync(artifactOutArg, JSON.stringify(artifact, null, 2));
}

// 3. Wire the REAL live-contract check result (opt-in, never required for CI).
const hasKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.length >= 8);
const liveCheckRequested = isLiveCheckFlag || process.env.TYPESAFE_LIVE_CHECK === '1';
let liveContractCheckExecuted = false;
let liveContractCheckSuccess = false;
let liveCheckDetail: string;
if (!liveCheckRequested) {
  liveCheckDetail = 'not requested (pass --live-check with TYPESAFE_API_KEY to run the bounded live check)';
} else if (!hasKey) {
  liveCheckDetail = 'requested but TYPESAFE_API_KEY is not provisioned; refusing to run';
} else {
  const proc = Bun.spawnSync(
    ['bun', LIVE_CHECK_PATH, ...(modelArg ? [`--model=${modelArg}`] : [])],
    {
      env: { ...process.env, TYPESAFE_LIVE_CHECK: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  liveContractCheckExecuted = true;
  const stdoutText = proc.stdout.toString().trim();
  try {
    const parsed = JSON.parse(stdoutText) as { ok?: unknown };
    liveContractCheckSuccess = proc.exitCode === 0 && parsed.ok === true;
    liveCheckDetail = liveContractCheckSuccess
      ? `executed via ${path.basename(LIVE_CHECK_PATH)}: ok=true (exit 0)`
      : `executed via ${path.basename(LIVE_CHECK_PATH)}: ok=false (exit ${proc.exitCode}) ${(proc.stderr.toString() || stdoutText).slice(0, 300)}`;
  } catch {
    liveCheckDetail = `executed via ${path.basename(LIVE_CHECK_PATH)}: unparseable output (exit ${proc.exitCode}) ${(proc.stderr.toString() || stdoutText).slice(0, 300)}`;
  }
}

// 4. Staged-canary sign-offs from explicit operator receipts (fail-closed default).
function readCanaryReceipts(): { productType: boolean; attributes: boolean; cohortPages: boolean; source: string } {
  const receipts: { productType: boolean; attributes: boolean; cohortPages: boolean; source: string } = {
    productType: false,
    attributes: false,
    cohortPages: false,
    source: 'none provided (unreviewed)',
  };
  const receiptsPath = process.env.TYPESAFE_CANARY_RECEIPTS_PATH;
  if (receiptsPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(receiptsPath, 'utf8')) as {
        productTypeReviewed?: unknown;
        attributesReviewed?: unknown;
        cohortPagesReviewed?: unknown;
      };
      receipts.productType = parsed.productTypeReviewed === true;
      receipts.attributes = parsed.attributesReviewed === true;
      receipts.cohortPages = parsed.cohortPagesReviewed === true;
      receipts.source = `file ${receiptsPath}`;
    } catch (err) {
      console.error(
        `Warning: TYPESAFE_CANARY_RECEIPTS_PATH unreadable (${err instanceof Error ? err.message : String(err)}); treating canaries as unreviewed.`,
      );
      receipts.source = `unreadable file ${receiptsPath} (unreviewed)`;
    }
  }
  if (process.env.TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED === '1') receipts.productType = true;
  if (process.env.TYPESAFE_CANARY_ATTRIBUTES_REVIEWED === '1') receipts.attributes = true;
  if (process.env.TYPESAFE_CANARY_COHORT_PAGES_REVIEWED === '1') receipts.cohortPages = true;
  if (
    receipts.source === 'none provided (unreviewed)' &&
    (process.env.TYPESAFE_CANARY_PRODUCT_TYPE_REVIEWED === '1' ||
      process.env.TYPESAFE_CANARY_ATTRIBUTES_REVIEWED === '1' ||
      process.env.TYPESAFE_CANARY_COHORT_PAGES_REVIEWED === '1')
  ) {
    receipts.source = 'env TYPESAFE_CANARY_*_REVIEWED';
  }
  return receipts;
}
const canary = readCanaryReceipts();

const assessment = assessProductionQualification({
  hasTypeSafeApiKey: hasKey,
  liveContractCheckExecuted,
  liveContractCheckSuccess,
  canaryProductTypeReviewed: canary.productType,
  canaryAttributesReviewed: canary.attributes,
  canaryCohortPagesReviewed: canary.cohortPages,
  offlineComparisonReport: comparisonReport,
});

const predictionProvenance = {
  predictorVersion: QUALIFICATION_PREDICTOR_VERSION,
  artifactHash: artifact.artifactHash,
  predictedAt: artifact.predictedAt,
  entryCount: artifact.entryCount,
  fixtureVersion: raw.version,
  fixturePath: GOLDSET_PATH,
  offlineLatencyNote:
    'Offline latencies are measured in-process decision compute, not live model serving; live latency/cost are proven via the bounded live-contract check and staged canaries.',
};
const liveCheckProvenance = {
  requested: liveCheckRequested,
  executed: liveContractCheckExecuted,
  success: liveContractCheckSuccess,
  detail: liveCheckDetail,
};
const canaryProvenance = {
  productTypeReviewed: canary.productType,
  attributesReviewed: canary.attributes,
  cohortPagesReviewed: canary.cohortPages,
  source: canary.source,
};

if (isJson) {
  console.log(JSON.stringify({
    comparisonReport,
    assessment,
    predictionArtifact: artifact,
    predictionProvenance,
    liveCheck: liveCheckProvenance,
    canary: canaryProvenance,
  }, null, 2));
  process.exit(0);
}

console.log('======================================================================');
console.log('   TYPESAFE JEV CURATION WORKFLOW QUALIFICATION REPORT (ISSUE #302)   ');
console.log('======================================================================\n');

console.log(`Predictions:      executed from code (${predictionProvenance.predictorVersion}, artifact ${artifact.artifactHash.slice(0, 12)}… over ${artifact.entryCount} gold entries)`);
console.log(`Live check:       ${liveCheckDetail}`);
console.log(`Canary receipts:  ${canary.source} (PT=${canary.productType} Attr=${canary.attributes} Pages=${canary.cohortPages})\n`);

console.log(`Evaluated Examples: ${comparisonReport.evaluatedExamples} (Dev: ${comparisonReport.devCount}, Holdout: ${comparisonReport.holdoutCount})`);
console.log(`Adjudicated By:     ${goldset.adjudicatedBy}\n`);

console.log('--- 1. PRIMARY PRODUCT TYPE COMPARISON ---');
console.log(`  Raw Correctness: Baseline ${(comparisonReport.productType.rawCorrectness.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.productType.rawCorrectness.candidate * 100).toFixed(1)}% (Delta: ${comparisonReport.productType.rawCorrectness.delta > 0 ? '+' : ''}${(comparisonReport.productType.rawCorrectness.delta * 100).toFixed(1)}%)`);
console.log(`  Coverage:        Baseline ${(comparisonReport.productType.coverage.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.productType.coverage.candidate * 100).toFixed(1)}%`);
console.log(`  Incorrect:       Baseline ${comparisonReport.productType.incorrectProposals.baseline} | Jev ${comparisonReport.productType.incorrectProposals.candidate}`);
console.log(`  Regressions:     ${comparisonReport.productType.harmfulRegressions}`);
console.log(`  Recovered:       ${comparisonReport.productType.recoveredAbstentions}`);
console.log(`  Service Failures:${comparisonReport.productType.serviceFailures.candidate}\n`);

console.log('--- 2. CONTROLLED ATTRIBUTES COMPARISON ---');
console.log(`  Raw Correctness: Baseline ${(comparisonReport.attributes.rawCorrectness.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.attributes.rawCorrectness.candidate * 100).toFixed(1)}%`);
console.log(`  Set F1 Score:    Baseline ${comparisonReport.attributes.setMetrics.f1.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.f1.candidate.toFixed(3)}`);
console.log(`  Set Precision:   Baseline ${comparisonReport.attributes.setMetrics.precision.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.precision.candidate.toFixed(3)}`);
console.log(`  Set Recall:      Baseline ${comparisonReport.attributes.setMetrics.recall.baseline.toFixed(3)} | Jev ${comparisonReport.attributes.setMetrics.recall.candidate.toFixed(3)}`);
console.log(`  Exact Match:     Baseline ${(comparisonReport.attributes.setMetrics.exactMatch.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.attributes.setMetrics.exactMatch.candidate * 100).toFixed(1)}%\n`);

console.log('--- 3. CATEGORY PAGES & COHORTS COMPARISON ---');
console.log(`  Page Exact Match:Baseline ${(comparisonReport.categoryPages.setMetrics.exactMatch.baseline * 100).toFixed(1)}% | Jev ${(comparisonReport.categoryPages.setMetrics.exactMatch.candidate * 100).toFixed(1)}%`);
console.log(`  Page F1 Score:   Baseline ${comparisonReport.categoryPages.setMetrics.f1.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.f1.candidate.toFixed(3)}`);
console.log(`  Page Precision:  Baseline ${comparisonReport.categoryPages.setMetrics.precision.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.precision.candidate.toFixed(3)}`);
console.log(`  Page Recall:     Baseline ${comparisonReport.categoryPages.setMetrics.recall.baseline.toFixed(3)} | Jev ${comparisonReport.categoryPages.setMetrics.recall.candidate.toFixed(3)}\n`);

console.log('--- 4. END-TO-END PIPELINE EFFECTS ---');
console.log(`  Total Evaluated: ${comparisonReport.endToEndPipeline.totalMembers}`);
console.log(`  Correct Type:    ${comparisonReport.endToEndPipeline.typeResolution.correct}`);
console.log(`  Attrs Correct:   ${comparisonReport.endToEndPipeline.attributeEffects.correctWhenTypeCorrect}`);
console.log(`  Pages Match:     ${comparisonReport.endToEndPipeline.pageEffects.exactMatchWhenTypeCorrect}`);
console.log(`  All Stages OK:   ${comparisonReport.endToEndPipeline.endToEndCorrectAllStages}\n`);

console.log('--- 5. LATENCY & COST TELEMETRY ---');
console.log(`  Mean Latency:    Baseline ${comparisonReport.telemetry.latency.baseline.meanMs}ms | Jev ${comparisonReport.telemetry.latency.candidate.meanMs}ms`);
console.log(`  P95 Latency:     Baseline ${comparisonReport.telemetry.latency.baseline.p95Ms}ms | Jev ${comparisonReport.telemetry.latency.candidate.p95Ms}ms`);
console.log(`  Estimated Cost:  Baseline $${comparisonReport.telemetry.estimatedCostUsd.baseline.toFixed(4)} | Jev $${comparisonReport.telemetry.estimatedCostUsd.candidate.toFixed(4)}`);
console.log(`  Note: ${comparisonReport.telemetry.operatorTimeNote}`);
console.log(`  Note: ${predictionProvenance.offlineLatencyNote}\n`);

console.log('--- 6. PRODUCTION QUALIFICATION ASSESSMENT ---');
console.log(`  Status: ${assessment.status.toUpperCase()}`);
console.log(`  Summary: ${assessment.summary}\n`);

if (assessment.blockers.length > 0) {
  console.log('  Active Operational Blockers:');
  for (const b of assessment.blockers) {
    console.log(`    [Criterion ${b.criterion} - ${b.area}] ${b.code}:`);
    console.log(`      ${b.message}`);
    console.log(`      -> Action: ${b.actionRequired}`);
  }
  console.log('');
}

console.log('======================================================================');
