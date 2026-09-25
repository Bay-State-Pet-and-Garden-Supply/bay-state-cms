#!/usr/bin/env bun
/**
 * TypeSafe Jev Curation Workflow Qualification Runner (Issue #302).
 *
 * Runs the offline evaluation comparing current-provider baseline vs TypeSafe Jev,
 * checks live API credentials / executes bounded contract checks if opt-in,
 * evaluates staged canaries, and reports production qualification status.
 *
 * Usage:
 *   bun scripts/typesafe-curation-qualification.ts [--split dev|holdout] [--json]
 *   TYPESAFE_LIVE_CHECK=1 TYPESAFE_API_KEY=... bun scripts/typesafe-curation-qualification.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateJevOfflineComparison,
  assessProductionQualification,
  type QualificationGoldset,
} from '../src/classification/jev-qualification-service';

const GOLDSET_PATH = path.resolve(
  import.meta.dir,
  '../src/tests/fixtures/benchmark-jev-qualification-goldset.json',
);

const isJson = process.argv.includes('--json');
const splitArg = process.argv.find(a => a.startsWith('--split='))?.split('=')[1] as 'dev' | 'holdout' | undefined;

if (!fs.existsSync(GOLDSET_PATH)) {
  console.error(`Goldset fixture not found at ${GOLDSET_PATH}`);
  process.exit(1);
}

const raw = fs.readFileSync(GOLDSET_PATH, 'utf8');
const goldset = JSON.parse(raw) as QualificationGoldset;

const comparisonReport = evaluateJevOfflineComparison(goldset, splitArg);

const hasKey = Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.length >= 8);
const isLiveCheckRequested = process.env.TYPESAFE_LIVE_CHECK === '1';

const assessment = assessProductionQualification({
  hasTypeSafeApiKey: hasKey,
  liveContractCheckExecuted: isLiveCheckRequested && hasKey,
  liveContractCheckSuccess: false, // Live contract check requires explicit live execution run
  canaryProductTypeReviewed: false,
  canaryAttributesReviewed: false,
  canaryCohortPagesReviewed: false,
  offlineComparisonReport: comparisonReport,
});

if (isJson) {
  console.log(JSON.stringify({ comparisonReport, assessment }, null, 2));
  process.exit(0);
}

console.log('======================================================================');
console.log('   TYPESAFE JEV CURATION WORKFLOW QUALIFICATION REPORT (ISSUE #302)   ');
console.log('======================================================================\n');

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
console.log(`  Note: ${comparisonReport.telemetry.operatorTimeNote}\n`);

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
