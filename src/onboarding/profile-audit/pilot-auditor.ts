/**
 * Pilot Auditor Orchestrator
 *
 * Runs an end-to-end pilot proving the audit seams on a single domain
 * with retained page artifacts (Spec #173, Issue #174):
 * 1. Builds / loads sample manifest from sitemap inventory + representative suite + snapshots.
 * 2. Replays byte-identical artifacts through all four configurations with zero network refetch.
 * 3. Scores rows with per-field correctness, image P/R + primary accuracy, identity verdicts,
 *    and machine-readable failure codes.
 * 4. Produces summary statistics and a reviewable markdown table.
 */

import type {
  PilotAuditOptions,
  PilotAuditResult,
  AuditScoredRow,
  ReplayConfiguration,
} from './types';
import { buildAuditManifest } from './manifest-builder';
import { replaySample } from './replay-runner';
import { scoreExtraction } from './scorer';
import { computeConfigurationSummaries, formatReviewableTable } from './reviewable-table';
import { normalizeDomain } from '../../db/repositories/brand-url-index-repo';
import { REPLAY_CONFIGURATIONS } from './shared-metrics';

export async function runPilotAudit(options: PilotAuditOptions): Promise<PilotAuditResult> {
  const normDomain = normalizeDomain(options.domain);

  // 1. Build or use provided manifest
  const manifest = options.manifest ?? await buildAuditManifest({
    domain: normDomain,
    artifactRoot: options.artifactRoot,
    candidateLimit: options.sampleLimit ?? 2,
  });

  // 2. Resolve Profile
  let profile = options.profile;
  if (profile === undefined) {
    try {
      const { findProfileByDomain } = await import('../../db/repositories/extractor-profile-repo');
      profile = findProfileByDomain(normDomain);
    } catch {
      profile = null;
    }
  }

  // 3. Replay and Score all samples
  const rows: AuditScoredRow[] = [];
  const configs: ReplayConfiguration[] = [...REPLAY_CONFIGURATIONS];

  const outcomesBySample: Record<string, Record<ReplayConfiguration, import('./types').ExtractionOutcome>> = {};

  for (const sample of manifest.samples) {
    // Fix #5: thread recordLatency from the pilot options into replay so
    // cost columns are measured when requested. Default false preserves
    // replay determinism (same-artifact-in → same-scored-row-out); the
    // production pilot script enables measurement explicitly.
    const outcomes = await replaySample(sample, profile, {
      artifactRoot: options.artifactRoot,
      recordLatency: options.recordLatency ?? false,
    });
    outcomesBySample[sample.sampleId] = outcomes;

    for (const config of configs) {
      const outcome = outcomes[config];
      const scoredRow = scoreExtraction(outcome, sample);
      rows.push(scoredRow);
    }
  }

  // 4. Summaries & Reviewable Table
  const summaryByConfiguration = computeConfigurationSummaries(rows);
  const reviewableTable = formatReviewableTable(rows);

  // 5. Operator Review Surface (Issue #177 / Gate T4)
  const { generateOperatorReviewReport } = await import('./operator-review');
  const reviewReport = generateOperatorReviewReport({
    manifest,
    rows,
    outcomesBySample,
    costOptions: {
      operatorMinutesOverride: options.operatorMinutesOverride,
      baseOperatorMinutes: options.baseOperatorMinutes,
    },
  });

  // 6. Gate Arithmetic & Per-Scope Promotion Report (Issue #178 / Gate T5)
  const { generatePromotionReport } = await import('./promotion-report');
  const promotionReport = generatePromotionReport({
    manifest,
    rows,
    gateOptions: {
      operatorMinutesOverride: options.operatorMinutesOverride,
      baseOperatorMinutes: options.baseOperatorMinutes,
    },
  });

  // 7. Evidence-Chosen Adapter Strategy Report (Issue #192 / Audit Follow-Through T8)
  const { generateAdapterStrategyReport } = await import('./adapter-strategy-report');
  const strategyReport = generateAdapterStrategyReport({
    manifest,
    rows,
    gateReport: promotionReport,
    options: {
      operatorMinutesOverride: options.operatorMinutesOverride,
      baseOperatorMinutes: options.baseOperatorMinutes,
      workspaceFlows: options.workspaceFlows,
    },
  });

  return {
    domain: normDomain,
    executedAt: new Date().toISOString(),
    manifest,
    rows,
    summaryByConfiguration,
    reviewableTable,
    scopeSummaries: reviewReport.scopeSummaries,
    operatorReviewReport: reviewReport.markdown,
    fieldEvidences: reviewReport.fieldEvidences,
    contactSheets: reviewReport.contactSheets,
    promotionReport: promotionReport.markdown,
    perScopePromotionReport: promotionReport,
    adapterStrategyReport: strategyReport.markdown,
    perScopeStrategyReport: strategyReport,
  };
}
