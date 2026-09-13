/**
 * Reviewable Table Formatter
 *
 * Formats scored rows and configuration summaries into a clean, reviewable
 * GitHub-flavored markdown table for operators and engineers.
 */

import type {
  AuditScoredRow,
  ConfigurationSummary,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';

export function computeConfigurationSummaries(
  rows: AuditScoredRow[],
): Record<ReplayConfiguration, ConfigurationSummary> {
  const configs: ReplayConfiguration[] = [
    'current_extraction',
    'current_strict_images',
    'structured_only',
    'hybrid_identity_first',
  ];

  const summaries: Partial<Record<ReplayConfiguration, ConfigurationSummary>> = {};

  for (const config of configs) {
    const configRows = rows.filter(r => r.configuration === config);
    const total = configRows.length;
    if (total === 0) {
      summaries[config] = {
        configuration: config,
        totalSamples: 0,
        correctIdentityRate: 0,
        meanFieldCorrectness: 0,
        meanImagePrecision: 0,
        meanImageRecall: 0,
        primaryImageAccuracy: 0,
        evidenceGapCount: 0,
        failureCodeCounts: {},
      };
      continue;
    }

    let correctIdentities = 0;
    let sumFieldCorrectness = 0;
    let sumImagePrecision = 0;
    let sumImageRecall = 0;
    let sumPrimaryAcc = 0;
    let evidenceGaps = 0;
    const failureCodeCounts: Record<string, number> = {};

    for (const r of configRows) {
      if (r.identityVerdict === 'correct_match') correctIdentities++;
      sumFieldCorrectness += r.fieldCorrectnessScore;
      sumImagePrecision += r.imageScores.precision;
      sumImageRecall += r.imageScores.recall;
      sumPrimaryAcc += r.imageScores.primaryAccuracy;
      if (r.isEvidenceGap) evidenceGaps++;

      for (const code of r.failureCodes) {
        failureCodeCounts[code] = (failureCodeCounts[code] || 0) + 1;
      }
    }

    summaries[config] = {
      configuration: config,
      totalSamples: total,
      correctIdentityRate: correctIdentities / total,
      meanFieldCorrectness: sumFieldCorrectness / total,
      meanImagePrecision: sumImagePrecision / total,
      meanImageRecall: sumImageRecall / total,
      primaryImageAccuracy: sumPrimaryAcc / total,
      evidenceGapCount: evidenceGaps,
      failureCodeCounts,
    };
  }

  return summaries as Record<ReplayConfiguration, ConfigurationSummary>;
}

export function formatReviewableTable(rows: AuditScoredRow[]): string {
  const summaries = computeConfigurationSummaries(rows);

  const lines: string[] = [];
  lines.push('# Profile Extraction Audit Gate: Pilot Replay & Scoring');
  lines.push('');
  lines.push('## Executive Summary by Configuration');
  lines.push('');
  lines.push(
    '| Configuration | Samples | Correct Identity | Field Correctness | Image Precision | Image Recall | Primary Image Acc | Evidence Gaps | Top Failure Codes |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  const configDisplayNames: Record<ReplayConfiguration, string> = {
    current_extraction: '1. Baseline (Current)',
    current_strict_images: '2. Current + Strict Images',
    structured_only: '3. Structured Signals Only',
    hybrid_identity_first: '4. Hybrid (Identity-First + Strict)',
  };

  for (const [cfg, s] of Object.entries(summaries) as Array<[ReplayConfiguration, ConfigurationSummary]>) {
    const topFailures = Object.entries(s.failureCodeCounts)
      .filter(([code]) => code !== 'NONE')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([code, count]) => `${code} (${count})`)
      .join(', ') || 'None';

    lines.push(
      `| **${configDisplayNames[cfg]}** | ${s.totalSamples} | ${(s.correctIdentityRate * 100).toFixed(1)}% | ${(s.meanFieldCorrectness * 100).toFixed(1)}% | ${(s.meanImagePrecision * 100).toFixed(1)}% | ${(s.meanImageRecall * 100).toFixed(1)}% | ${(s.primaryImageAccuracy * 100).toFixed(1)}% | ${s.evidenceGapCount} | ${topFailures} |`,
    );
  }

  lines.push('');
  lines.push('## Detailed Sample Breakdown');
  lines.push('');
  lines.push(
    '| Sample | URL | Configuration | Identity | Field Score | Img P / R | Primary Img | Failure Codes | Gap? |',
  );
  lines.push(
    '| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- | :---: |',
  );

  for (const r of rows) {
    const slug = r.url.split('/').filter(Boolean).pop() || r.sampleId;
    const cfgName = r.configuration.replace('_extraction', '').replace('_', ' ');
    const identBadge = r.identityVerdict === 'correct_match' ? '✓ correct' : `⚠ ${r.identityVerdict}`;
    const fieldScoreStr = `${(r.fieldCorrectnessScore * 100).toFixed(0)}%`;
    const imgPR = `${(r.imageScores.precision * 100).toFixed(0)}% / ${(r.imageScores.recall * 100).toFixed(0)}%`;
    const primaryImgBadge = r.imageScores.primaryAccuracy === 1 ? '✓' : '✗';
    const failureList = r.failureCodes.join(', ');
    const gapBadge = r.isEvidenceGap ? '⚠️ GAP' : 'no';

    lines.push(
      `| ${r.sampleId} | \`${slug}\` | ${cfgName} | ${identBadge} | ${fieldScoreStr} | ${imgPR} | ${primaryImgBadge} | \`${failureList}\` | ${gapBadge} |`,
    );
  }

  return lines.join('\n');
}
