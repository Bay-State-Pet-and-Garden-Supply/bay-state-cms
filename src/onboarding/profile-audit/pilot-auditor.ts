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
  const configs: ReplayConfiguration[] = [
    'current_extraction',
    'current_strict_images',
    'structured_only',
    'hybrid_identity_first',
  ];

  for (const sample of manifest.samples) {
    const outcomes = await replaySample(sample, profile, {
      artifactRoot: options.artifactRoot,
    });

    for (const config of configs) {
      const outcome = outcomes[config];
      const scoredRow = scoreExtraction(outcome, sample);
      rows.push(scoredRow);
    }
  }

  // 4. Summaries & Reviewable Table
  const summaryByConfiguration = computeConfigurationSummaries(rows);
  const reviewableTable = formatReviewableTable(rows);

  return {
    domain: normDomain,
    executedAt: new Date().toISOString(),
    manifest,
    rows,
    summaryByConfiguration,
    reviewableTable,
  };
}
