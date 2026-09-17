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
import {
  REPLAY_CONFIGURATIONS,
  // Canonical display names (shared-metrics.ts, fix #10). Values match the
  // previously local table headers, so reviewable output is unchanged.
  CONFIG_DISPLAY_NAMES as configDisplayNames,
} from './shared-metrics';

export function computeConfigurationSummaries(
  rows: AuditScoredRow[],
): Record<ReplayConfiguration, ConfigurationSummary> {
  const configs: ReplayConfiguration[] = [...REPLAY_CONFIGURATIONS];

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
    const identBadge = r.identityResolution?.confusionDetected
      ? `⚠ confusion (${r.identityResolution.confusionType || r.identityVerdict})`
      : (r.identityVerdict === 'correct_match' ? '✓ correct' : `⚠ ${r.identityVerdict}`);
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

export function formatReviewableManifest(manifest: import('../../shared/schemas/profile-audit').AuditManifest): string {
  const meta = (manifest.metadata ?? {}) as Record<string, any>;
  const claimedStrata = (meta.claimedStrata as string[]) || [];
  const strataSummary = (meta.strataSummary as Record<string, any>) || {};
  const holdoutFamilies = (meta.holdoutFamilies as string[]) || [];
  const tuningFamilies = (meta.tuningFamilies as string[]) || [];

  const lines: string[] = [];
  lines.push('# Profile Extraction Audit Gate: Stratified Sampling Manifest');
  lines.push('');
  lines.push('## Manifest Overview');
  lines.push(`- **Domain:** \`${manifest.domain}\``);
  lines.push(`- **Generated At:** ${manifest.generatedAt}`);
  lines.push(`- **Total Samples:** ${manifest.samples.length}`);
  lines.push(`- **Total Claimed Strata:** ${claimedStrata.length}`);
  lines.push(`- **Confirmed Profile Samples:** ${meta.totalConfirmed ?? manifest.samples.filter(s => s.inventoryStatus === 'confirmed').length}`);
  lines.push(`- **Unreviewed Candidates:** ${meta.totalCandidates ?? manifest.samples.filter(s => s.inventoryStatus === 'candidate' && !s.isProfileBlocked).length}`);
  lines.push(`- **Profile-Blocked Items:** ${meta.totalBlocked ?? manifest.samples.filter(s => s.isProfileBlocked).length}`);
  lines.push(`- **Excluded Distributor Records:** ${meta.totalExcludedDistributorRecords ?? 0}`);
  lines.push(`- **Holdout Families Count:** ${holdoutFamilies.length}`);
  lines.push(`- **Holdout Families Untouched by Tuning:** ${meta.holdoutUntouched ? '✓ Yes' : '✗ No'}`);
  const independentCount = manifest.samples.filter(s => s.groundTruthSource === 'independent').length;
  const autoDerivedCount = manifest.samples.length - independentCount;
  lines.push(`- **Independently Labeled Samples:** ${independentCount} (groundTruthSource='independent'; safe for scoring)`);
  lines.push(`- **Auto-Derived Samples:** ${autoDerivedCount} (groundTruthSource='auto-derived'; CIRCULAR for scoring — labels lifted from the page bytes under test)`);
  lines.push('');
  lines.push("> **Labeling Provenance:** Samples WITHOUT a groundTruthOverrides entry derive labels from the same page bytes under test (JSON-LD/h1/sitemap metadata). Do not report auto-derived wins as independent-label quality — only 'independent' rows carry operator-curated labels.");
  lines.push('');

  lines.push('## Claimed Strata');
  lines.push('');
  lines.push('| Stratum | Platform | Page Structure Scope | Variant Shape | Family Bucket | Freshness Bucket | Samples | Freshness Range |');
  lines.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |');

  for (const stratum of claimedStrata) {
    const s = strataSummary[stratum] || {};
    const count = s.sampleCount ?? manifest.samples.filter(x => x.stratum === stratum).length;
    const minFresh = s.freshnessRange?.min || 'N/A';
    const maxFresh = s.freshnessRange?.max || 'N/A';
    const freshRange = minFresh === maxFresh ? minFresh : `${minFresh} .. ${maxFresh}`;

    lines.push(
      `| \`${stratum}\` | ${s.platform ?? 'generic'} | ${s.pageStructureScope ?? 'standard_pdp'} | ${s.variantShape ?? 'single_variant'} | ${s.familyBucket ?? '—'} | ${s.freshnessBucket ?? '—'} | ${count} | ${freshRange} |`,
    );
  }

  lines.push('');
  lines.push('## Product Family Partition');
  lines.push('');
  lines.push('> **Audit Holdout Guarantee:** Holdout product families are held out as entire families and remain completely untouched by profile tuning.');
  lines.push('');
  lines.push(`- **Holdout Families (${holdoutFamilies.length}):** ${holdoutFamilies.length > 0 ? holdoutFamilies.map(f => `\`${f}\``).join(', ') : 'None'}`);
  lines.push(`- **Tuning Families (${tuningFamilies.length}):** ${tuningFamilies.length > 0 ? tuningFamilies.map(f => `\`${f}\``).join(', ') : 'None'}`);
  lines.push('');

  lines.push('## Stratified Samples Inventory');
  lines.push('');
  lines.push('| Sample ID | Stratum | Type | Product Family | Holdout? | Platform | Freshness | Ground Truth | Artifact |');
  lines.push('| :--- | :--- | :---: | :--- | :---: | :--- | :---: | :---: | :---: |');

  for (const sample of manifest.samples) {
    const sampleTypeLabel = sample.sampleType === 'confirmed_profile_sample' || sample.inventoryStatus === 'confirmed'
      ? '★ Confirmed'
      : sample.isProfileBlocked
        ? '⛔ Blocked'
        : sample.sampleType === 'failure_sample' || sample.isFailureSample
          ? '⚠️ Failure'
          : 'Candidate';

    const holdoutBadge = sample.isHoldout ? '🔒 Holdout' : 'Tuning';
    const artifactBadge = sample.artifactRef ? '✓ Available' : '⚠ Missing (Gap)';
    const family = sample.productFamily || 'N/A';
    const freshness = sample.captureFreshness || 'missing';
    const gtBadge = sample.groundTruthSource === 'independent' ? '✓ independent' : '○ auto-derived (circular)';

    lines.push(
      `| ${sample.sampleId} | \`${sample.stratum}\` | ${sampleTypeLabel} | ${family} | ${holdoutBadge} | ${sample.platform ?? 'generic'} | ${freshness} | ${gtBadge} | ${artifactBadge} |`,
    );
  }

  return lines.join('\n');
}

export * from './operator-review';
