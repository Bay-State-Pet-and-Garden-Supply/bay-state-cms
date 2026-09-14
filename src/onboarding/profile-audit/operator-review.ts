/**
 * Operator Review Surface for Profile Extraction Audit Gate (Issue #177 / Gate T4)
 *
 * Provides the four operator review pillars:
 * 1. Side-by-side field evidence per sample across all four configurations showing provenance.
 * 2. Missing-field explanations distinguishing absent from inapplicable from conflicted from failed.
 * 3. Accepted and rejected image contact sheets per sample with primary image flagged.
 * 4. Per-scope served-rate style summary for store owners with uncertainty and promotability verdicts.
 *
 * Deterministic and readable end-to-end without inspecting raw harness rows.
 */

import type {
  AuditManifest,
  AuditManifestSample,
  AuditScoredRow,
  FieldEvidenceCell,
  FieldEvidenceRow,
  FieldScoreDetail,
  HybridConflict,
  ImageContactSheet,
  ImageContactSheetItem,
  MissingFieldExplanation,
  MissingFieldReason,
  OperatorReviewSurfaceReport,
  ReplayConfiguration,
  SampleFieldEvidence,
  ScopeServedRateSummary,
} from '../../shared/schemas/profile-audit';
import type { ExtractionOutcome } from './types';

const CONFIGURATIONS: ReplayConfiguration[] = [
  'current_extraction',
  'current_strict_images',
  'structured_only',
  'hybrid_identity_first',
];

export const CONFIG_DISPLAY_NAMES: Record<ReplayConfiguration, string> = {
  current_extraction: '1. Baseline',
  current_strict_images: '2. Strict Images',
  structured_only: '3. Structured Only',
  hybrid_identity_first: '4. Hybrid (Identity-First)',
};

const CRITICAL_FIELDS = ['title', 'brand', 'price'];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Wilson Score Confidence Interval (Uncertainty Reporting)
// ─────────────────────────────────────────────────────────────────────────────

export function computeWilsonScoreInterval(
  successes: number,
  total: number,
  z: number = 1.96,
): { rate: number; lower: number; upper: number; marginOfError: number } {
  if (total <= 0) {
    return { rate: 0, lower: 0, upper: 0, marginOfError: 0 };
  }
  const clampedSuccesses = Math.max(0, Math.min(total, successes));
  const p = clampedSuccesses / total;
  const z2 = z * z;
  const n = total;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;

  const lower = Math.max(0, center - spread);
  const upper = Math.min(1, center + spread);
  const marginOfError = spread;

  return {
    rate: p,
    lower,
    upper,
    marginOfError,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Missing-Field Explanation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Explains why a field is missing, distinguishing:
 * - 'absent': Field is unavailable on the source page (page never carried it).
 * - 'inapplicable': Field does not apply to this scope, product family, or variant shape.
 * - 'conflicted': Multiple sources disagreed on the value, causing conflict or suppression.
 * - 'failed': Field was available on the page, but extraction failed to capture it.
 */
export function explainMissingField(
  field: string,
  fieldScore?: Partial<FieldScoreDetail> | null,
  spec?: { available?: boolean; inapplicable?: boolean; notes?: string } | null,
  conflict?: HybridConflict | null,
): MissingFieldExplanation {
  const isAvailable = spec?.available ?? fieldScore?.available ?? false;
  const isInapplicable = Boolean(
    spec?.inapplicable ||
    fieldScore?.inapplicable ||
    fieldScore?.status === 'inapplicable' ||
    spec?.notes?.toLowerCase().includes('inapplicable')
  );

  const conflictDetails = conflict
    ? (conflict.disagreementReason || `Selector (${conflict.selectorSource || 'custom'}): "${conflict.selectorValue}" vs Structured (${conflict.structuredSource || 'structured'}): "${conflict.structuredValue}"`)
    : (fieldScore?.conflictDetails ?? null);

  let reason: MissingFieldReason;
  let explanation: string;

  if (conflict || fieldScore?.status === 'conflict' || conflictDetails) {
    reason = 'conflicted';
    explanation = conflictDetails
      ? `Conflicted: Disagreement between sources (${conflictDetails})`
      : 'Conflicted: Disagreement between selector and structured sources';
  } else if (isInapplicable) {
    reason = 'inapplicable';
    explanation = spec?.notes || fieldScore?.missingExplanation || 'Inapplicable: Field does not apply to this product scope or variant shape';
  } else if (!isAvailable) {
    reason = 'absent';
    explanation = spec?.notes || fieldScore?.missingExplanation || 'Absent from page: Source page does not carry this field (unavailable)';
  } else {
    reason = 'failed';
    explanation = fieldScore?.missingExplanation || 'Extraction failed: Field is present on page but extractor captured no value';
  }

  return {
    field,
    reason,
    explanation,
    available: isAvailable,
    inapplicable: isInapplicable || undefined,
    notes: spec?.notes,
    conflictDetails,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Side-by-Side Field Evidence Builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildSideBySideFieldEvidence(
  sample: AuditManifestSample,
  rowsForSample: AuditScoredRow[],
  conflicts?: HybridConflict[],
): SampleFieldEvidence {
  const rowsByConfig = new Map<ReplayConfiguration, AuditScoredRow>();
  for (const r of rowsForSample) {
    rowsByConfig.set(r.configuration, r);
  }

  // Determine all evaluated field names
  const fieldNameSet = new Set<string>(CRITICAL_FIELDS);
  for (const f of Object.keys(sample.groundTruth.fields)) {
    fieldNameSet.add(f);
  }
  for (const r of rowsForSample) {
    for (const f of Object.keys(r.fieldScores)) {
      fieldNameSet.add(f);
    }
  }

  const identityVerdicts: Record<ReplayConfiguration, import('../../shared/schemas/profile-audit').IdentityVerdict> = {
    current_extraction: rowsByConfig.get('current_extraction')?.identityVerdict ?? 'unidentified',
    current_strict_images: rowsByConfig.get('current_strict_images')?.identityVerdict ?? 'unidentified',
    structured_only: rowsByConfig.get('structured_only')?.identityVerdict ?? 'unidentified',
    hybrid_identity_first: rowsByConfig.get('hybrid_identity_first')?.identityVerdict ?? 'unidentified',
  };

  const fields: FieldEvidenceRow[] = [];
  const missingFieldExplanations: Array<{
    configuration: ReplayConfiguration;
    field: string;
    reason: MissingFieldReason;
    explanation: string;
  }> = [];

  const sampleConflicts = conflicts || rowsByConfig.get('hybrid_identity_first')?.conflicts || [];

  for (const field of Array.from(fieldNameSet)) {
    const spec = sample.groundTruth.fields[field];
    const available = spec ? Boolean(spec.available) : false;
    const inapplicable = Boolean(spec?.inapplicable || spec?.notes?.toLowerCase().includes('inapplicable'));
    const expectedValue = spec?.expectedValue ?? null;

    const cells: Record<ReplayConfiguration, FieldEvidenceCell> = {} as any;
    const extractedValues: string[] = [];

    for (const cfg of CONFIGURATIONS) {
      const row = rowsByConfig.get(cfg);
      const score = row?.fieldScores[field];
      const cfgConflict = cfg === 'hybrid_identity_first'
        ? sampleConflicts.find(c => c.field === field)
        : null;

      const rawVal = score?.extractedValue ?? null;
      if (rawVal !== null && rawVal !== '') {
        extractedValues.push(rawVal);
      }

      const isCorrect = Boolean(score?.correct);
      const status = score?.status ?? (available ? 'missing' : 'unavailable');
      const provenance = score?.provenance || (rawVal ? 'unknown' : 'none');

      let missingReason: MissingFieldReason | null = null;
      let missingExplanation: string | null = null;

      if (!rawVal || status === 'conflict' || status === 'missing' || status === 'unavailable' || status === 'inapplicable') {
        const exp = explainMissingField(field, score, spec, cfgConflict);
        missingReason = exp.reason;
        missingExplanation = exp.explanation;

        missingFieldExplanations.push({
          configuration: cfg,
          field,
          reason: exp.reason,
          explanation: exp.explanation,
        });
      }

      cells[cfg] = {
        configuration: cfg,
        value: rawVal,
        provenance,
        status,
        isCorrect,
        missingReason,
        missingExplanation,
        conflictDetails: score?.conflictDetails ?? cfgConflict?.disagreementReason ?? null,
      };
    }

    // Check if there is disagreement across configurations
    const uniqueValues = new Set(extractedValues);
    const disagreementDetected = uniqueValues.size > 1 || (extractedValues.length > 0 && extractedValues.length < CONFIGURATIONS.length);

    // Pick winner configuration only when disagreement was detected
    let winnerConfiguration: ReplayConfiguration | undefined;
    if (disagreementDetected) {
      if (cells.hybrid_identity_first.isCorrect) {
        winnerConfiguration = 'hybrid_identity_first';
      } else {
        const winningCfg = CONFIGURATIONS.find(c => cells[c].isCorrect);
        if (winningCfg) winnerConfiguration = winningCfg;
      }
    }

    fields.push({
      field,
      expectedValue,
      available,
      inapplicable: inapplicable || undefined,
      cells,
      disagreementDetected,
      winnerConfiguration,
    });
  }

  return {
    sampleId: sample.sampleId,
    url: sample.url,
    domain: sample.domain,
    scope: sample.pageStructureScope || 'standard_pdp',
    identityVerdicts,
    fields,
    missingFieldExplanations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Image Contact Sheet Builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildImageContactSheet(
  sample: AuditManifestSample,
  rowOrOutcome?: AuditScoredRow | ExtractionOutcome | null,
): ImageContactSheet {
  if (!rowOrOutcome) {
    return {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      totalDiscovered: 0,
      admittedCount: 0,
      rejectedCount: 0,
      primaryImage: null,
      primaryAccuracy: 0,
      acceptedImages: [],
      rejectedImages: [],
    };
  }

  let admittedImages: string[];
  let rejectedImages: string[];
  let primaryImage: string | null;
  let primaryAccuracy: number;
  let rejectionReasons: Record<string, string> = {};

  if ('imageScores' in rowOrOutcome) {
    // Scored row
    admittedImages = rowOrOutcome.imageScores.admittedImages || [];
    rejectedImages = rowOrOutcome.imageScores.rejectedImages || [];
    primaryImage = rowOrOutcome.imageScores.primaryImage;
    primaryAccuracy = rowOrOutcome.imageScores.primaryAccuracy;
    rejectionReasons = rowOrOutcome.imageScores.rejectionReasons
      || (rowOrOutcome as any).imageRejectionReasons
      || {};
  } else {
    // ExtractionOutcome
    admittedImages = rowOrOutcome.admittedImages || [];
    rejectedImages = rowOrOutcome.rejectedImages || [];
    primaryImage = rowOrOutcome.primaryImage;
    rejectionReasons = rowOrOutcome.imageRejectionReasons || {};

    const expPrimary = sample.groundTruth.images.primaryImage;
    if (expPrimary && primaryImage) {
      primaryAccuracy = primaryImage === expPrimary || primaryImage.includes(expPrimary) || expPrimary.includes(primaryImage) ? 1 : 0;
    } else if (expPrimary && !primaryImage) {
      primaryAccuracy = 0;
    } else {
      primaryAccuracy = 1;
    }
  }

  const expectedAdmissible = new Set(sample.groundTruth.images.admissibleImages || []);
  const expectedPrimary = sample.groundTruth.images.primaryImage;

  // Determine exactly which image is primary (at most 1)
  let primaryIdx = -1;
  if (primaryImage) {
    primaryIdx = admittedImages.findIndex(
      url => url === primaryImage || (primaryImage && (url.endsWith(primaryImage) || primaryImage.endsWith(url))),
    );
    if (primaryIdx === -1 && admittedImages.length > 0) {
      primaryIdx = 0;
    }
  }

  const acceptedList: ImageContactSheetItem[] = admittedImages.map((url, idx) => {
    const isPrimary = idx === primaryIdx;
    return {
      url,
      isPrimary,
      status: 'accepted',
      role: isPrimary ? 'primary hero' : 'gallery',
      isExpectedAdmissible: expectedAdmissible.size === 0 || expectedAdmissible.has(url),
      isExpectedPrimary: expectedPrimary ? expectedPrimary === url : undefined,
    };
  });

  const rejectedList: ImageContactSheetItem[] = rejectedImages.map(url => {
    const reason = rejectionReasons[url] || 'Filtered by strict image role/variant/dedupe rule';
    const lower = reason.toLowerCase();
    const role = lower.includes('icon') || lower.includes('social') || lower.includes('payment') || lower.includes('badge')
      ? 'icon'
      : (lower.includes('duplicate') ? 'duplicate' : 'other_variant');

    return {
      url,
      isPrimary: false,
      status: 'rejected',
      rejectionReason: reason,
      role,
      isExpectedAdmissible: expectedAdmissible.has(url),
      isExpectedPrimary: expectedPrimary ? expectedPrimary === url : false,
    };
  });

  return {
    sampleId: sample.sampleId,
    url: sample.url,
    domain: sample.domain,
    totalDiscovered: acceptedList.length + rejectedList.length,
    admittedCount: acceptedList.length,
    rejectedCount: rejectedList.length,
    primaryImage,
    primaryAccuracy,
    acceptedImages: acceptedList,
    rejectedImages: rejectedList,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Per-Scope Summary Calculator
// ─────────────────────────────────────────────────────────────────────────────

export interface ComputeScopeSummariesOptions {
  minSamplesForPromote?: number;
  targetConfidence?: number;
}

export function computeScopeSummaries(
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: ComputeScopeSummariesOptions = {},
): Record<string, ScopeServedRateSummary> {
  const minSamples = options.minSamplesForPromote ?? 3;
  let z = 1.96;
  if (options.targetConfidence !== undefined) {
    if (options.targetConfidence > 1) {
      z = options.targetConfidence;
    } else if (options.targetConfidence >= 0.99) {
      z = 2.576;
    } else if (options.targetConfidence >= 0.95) {
      z = 1.96;
    } else if (options.targetConfidence >= 0.90) {
      z = 1.645;
    } else if (options.targetConfidence >= 0.80) {
      z = 1.282;
    }
  }

  // Group samples by scope: pageStructureScope (e.g. standard_pdp, tabbed_pdp)
  const samplesByScope = new Map<string, AuditManifestSample[]>();
  for (const s of samples) {
    const scopeKey = s.pageStructureScope || 'standard_pdp';
    if (!samplesByScope.has(scopeKey)) {
      samplesByScope.set(scopeKey, []);
    }
    samplesByScope.get(scopeKey)!.push(s);
  }

  const summaries: Record<string, ScopeServedRateSummary> = {};

  for (const [scopeKey, scopeSamples] of samplesByScope.entries()) {
    const sampleCount = scopeSamples.length;
    const sampleIdSet = new Set(scopeSamples.map(s => s.sampleId));

    const baselineRows = rows.filter(r => sampleIdSet.has(r.sampleId) && r.configuration === 'current_extraction');
    const hybridRows = rows.filter(r => sampleIdSet.has(r.sampleId) && r.configuration === 'hybrid_identity_first');

    // Helper: is a sample considered served?
    const isSampleServed = (r: AuditScoredRow, sample: AuditManifestSample): boolean => {
      if (r.identityVerdict !== 'correct_match' || r.isEvidenceGap) return false;
      // All available critical fields must be correct
      for (const field of CRITICAL_FIELDS) {
        const spec = sample.groundTruth.fields[field];
        if (spec?.available && !spec.inapplicable) {
          const fScore = r.fieldScores[field];
          if (!fScore || !fScore.correct) return false;
        }
      }
      return true;
    };

    let baselineServedCount = 0;
    for (const r of baselineRows) {
      const sample = scopeSamples.find(s => s.sampleId === r.sampleId);
      if (sample && isSampleServed(r, sample)) baselineServedCount++;
    }

    let hybridServedCount = 0;
    let acceptedIdentityErrors = 0;
    let criticalFieldRegressions = 0;
    let sumHybridFieldCorrectness = 0;
    let sumBaselineFieldCorrectness = 0;
    let sumHybridImagePrecision = 0;
    let sumBaselineImagePrecision = 0;
    let sumHybridImageRecall = 0;
    let sumHybridPrimaryAcc = 0;
    let hybridEvidenceGaps = 0;

    for (const r of hybridRows) {
      const sample = scopeSamples.find(s => s.sampleId === r.sampleId);
      if (sample && isSampleServed(r, sample)) hybridServedCount++;

      if (r.isEvidenceGap) {
        hybridEvidenceGaps++;
      } else {
        if (r.identityVerdict !== 'correct_match' || r.identityResolution?.confusionDetected) {
          acceptedIdentityErrors++;
        }
      }

      sumHybridFieldCorrectness += r.fieldCorrectnessScore;
      sumHybridImagePrecision += r.imageScores.precision;
      sumHybridImageRecall += r.imageScores.recall;
      sumHybridPrimaryAcc += r.imageScores.primaryAccuracy;

      // Check critical field regression against baseline
      const bRow = baselineRows.find(b => b.sampleId === r.sampleId);
      if (bRow) {
        for (const cf of CRITICAL_FIELDS) {
          const bScore = bRow.fieldScores[cf];
          const hScore = r.fieldScores[cf];
          if (bScore?.correct === true && hScore?.correct !== true) {
            criticalFieldRegressions++;
          }
        }
      }
    }

    for (const b of baselineRows) {
      sumBaselineFieldCorrectness += b.fieldCorrectnessScore;
      sumBaselineImagePrecision += b.imageScores.precision;
    }

    const baselineServedRate = sampleCount > 0 ? baselineServedCount / sampleCount : 0;
    const hybridServedStats = computeWilsonScoreInterval(hybridServedCount, sampleCount, z);
    const hybridServedRate = hybridServedStats.rate;
    const servedRateDelta = hybridServedRate - baselineServedRate;

    const meanFieldCorrectness = hybridRows.length > 0 ? sumHybridFieldCorrectness / hybridRows.length : 0;
    const baselineMeanFieldCorrectness = baselineRows.length > 0 ? sumBaselineFieldCorrectness / baselineRows.length : 0;
    const meanImagePrecision = hybridRows.length > 0 ? sumHybridImagePrecision / hybridRows.length : 0;
    const baselineMeanImagePrecision = baselineRows.length > 0 ? sumBaselineImagePrecision / baselineRows.length : 0;
    const meanImageRecall = hybridRows.length > 0 ? sumHybridImageRecall / hybridRows.length : 0;
    const primaryImageAccuracy = hybridRows.length > 0 ? sumHybridPrimaryAcc / hybridRows.length : 0;

    const nonGapCount = hybridRows.filter(r => !r.isEvidenceGap).length;
    const identityAccuracy = nonGapCount > 0
      ? (nonGapCount - acceptedIdentityErrors) / nonGapCount
      : (hybridRows.length > 0 ? 0 : 1);

    // Promotability Verdict Evaluation
    const hasZeroIdentityErrors = acceptedIdentityErrors === 0;
    const hasNoCriticalRegressions = criticalFieldRegressions === 0;
    const hasImageQualityWin = meanImagePrecision >= baselineMeanImagePrecision;
    const hasFieldQualityWin = meanFieldCorrectness >= baselineMeanFieldCorrectness;
    const baselineEvidenceGaps = baselineRows.filter(b => b.isEvidenceGap).length;
    const hasNoAbstentionGaming = hybridEvidenceGaps <= baselineEvidenceGaps;
    const hasServedRateWin = hybridServedRate >= baselineServedRate;
    const isSufficientSample = sampleCount >= minSamples;

    let isPromotable = false;
    let promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
    const promotabilityReasons: string[] = [];

    if (!hasZeroIdentityErrors) {
      promotabilityReasons.push(`Blocked: ${acceptedIdentityErrors} identity errors (wrong product or variant confusion) detected`);
    }
    if (!hasNoCriticalRegressions) {
      promotabilityReasons.push(`Blocked: ${criticalFieldRegressions} critical field regressions versus baseline on title/brand/price`);
    }
    if (!hasImageQualityWin) {
      promotabilityReasons.push('Blocked: Mean image precision regressed below baseline');
    }
    if (!hasFieldQualityWin) {
      promotabilityReasons.push('Blocked: Mean field correctness regressed below baseline');
    }
    if (!hasNoAbstentionGaming) {
      promotabilityReasons.push('Blocked: Evidence gaps exceeded baseline (abstention gaming detected)');
    }
    if (!hasServedRateWin) {
      promotabilityReasons.push('Blocked: Hybrid served rate regressed below baseline');
    }

    if (promotabilityReasons.length > 0) {
      promotabilityVerdict = 'BLOCKED';
    } else if (!isSufficientSample) {
      promotabilityVerdict = 'NEEDS_REVIEW';
      promotabilityReasons.push(`Needs review: Sample count (${sampleCount}) is below standard gate threshold (minimum ${minSamples} required)`);
    } else {
      isPromotable = true;
      promotabilityVerdict = 'PROMOTABLE';
      promotabilityReasons.push('✓ Zero observed identity errors (100% correct identity match)');
      promotabilityReasons.push('✓ Zero critical-field regressions on title, brand, or price');
      promotabilityReasons.push(`✓ Improved image precision (${(meanImagePrecision * 100).toFixed(1)}% vs ${(baselineMeanImagePrecision * 100).toFixed(1)}% baseline)`);
      promotabilityReasons.push(`✓ Maintained or improved field completeness (${(meanFieldCorrectness * 100).toFixed(1)}%)`);
      promotabilityReasons.push('✓ Zero evidence-gap inflation / no abstention gaming');
    }

    const domain = scopeSamples[0]?.domain;
    const platform = scopeSamples[0]?.platform;

    summaries[scopeKey] = {
      scope: scopeKey,
      domain,
      platform,
      sampleCount,
      servedRate: hybridServedRate,
      baselineServedRate,
      servedRateDelta,
      uncertainty: hybridServedStats.marginOfError,
      confidenceInterval: {
        lower: hybridServedStats.lower,
        upper: hybridServedStats.upper,
      },
      identityAccuracy,
      acceptedIdentityErrors,
      meanFieldCorrectness,
      baselineMeanFieldCorrectness,
      criticalFieldRegressionCount: criticalFieldRegressions,
      meanImagePrecision,
      baselineMeanImagePrecision,
      meanImageRecall,
      primaryImageAccuracy,
      evidenceGapCount: hybridEvidenceGaps,
      isPromotable,
      promotabilityVerdict,
      promotabilityReasons,
    };
  }

  return summaries;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Markdown Formatters
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeCell(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function safeResolveUrl(url: string, baseUrl?: string): string {
  try {
    if (baseUrl && (baseUrl.startsWith('http://') || baseUrl.startsWith('https://'))) {
      return new URL(url, baseUrl).href;
    }
    return new URL(url).href;
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatPerScopeSummaryTable(
  scopeSummaries: Record<string, ScopeServedRateSummary>,
): string {
  const lines: string[] = [];
  lines.push('## Per-Scope Served-Rate Summary');
  lines.push('');
  lines.push('> **Store Owner Decision Summary:** Evaluates promotability per page-structure scope. A scope advances only when it demonstrates zero accepted identity errors, zero critical-field regressions, improved image and field quality, and no abstention gaming.');
  lines.push('');
  lines.push(
    '| Scope | Platform | Samples | Baseline Served Rate | Hybrid Served Rate | Delta | 95% CI | Identity Acc | Field Correctness | Regressions | Img Precision | Primary Acc | Promotability Verdict |',
  );
  lines.push(
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |',
  );

  for (const s of Object.values(scopeSummaries)) {
    const deltaStr = s.servedRateDelta >= 0
      ? `▲ +${(s.servedRateDelta * 100).toFixed(1)}%`
      : `▼ ${(s.servedRateDelta * 100).toFixed(1)}%`;

    const ciStr = `±${(s.uncertainty * 100).toFixed(1)}%`;
    const verdictBadge = s.promotabilityVerdict === 'PROMOTABLE'
      ? '✅ **PROMOTABLE**'
      : s.promotabilityVerdict === 'BLOCKED'
        ? '⛔ **BLOCKED**'
        : '⚠️ **NEEDS REVIEW**';

    lines.push(
      `| **\`${s.scope}\`** | ${s.platform ?? 'generic'} | ${s.sampleCount} | ${(s.baselineServedRate * 100).toFixed(1)}% | **${(s.servedRate * 100).toFixed(1)}%** | ${deltaStr} | ${ciStr} | ${(s.identityAccuracy * 100).toFixed(1)}% (${s.acceptedIdentityErrors} err) | ${(s.meanFieldCorrectness * 100).toFixed(1)}% | ${s.criticalFieldRegressionCount} | ${(s.meanImagePrecision * 100).toFixed(1)}% | ${(s.primaryImageAccuracy * 100).toFixed(1)}% | ${verdictBadge} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function formatSideBySideFieldEvidenceTable(evidence: SampleFieldEvidence): string {
  const lines: string[] = [];
  lines.push(`### Sample: \`${evidence.sampleId}\` — Side-by-Side Field Evidence`);
  lines.push(`- **URL:** \`${evidence.url}\` | **Scope:** \`${evidence.scope}\` | **Domain:** \`${evidence.domain}\``);
  lines.push(`- **Identity Verdicts:** Baseline: \`${evidence.identityVerdicts.current_extraction}\` | Strict Img: \`${evidence.identityVerdicts.current_strict_images}\` | Structured Only: \`${evidence.identityVerdicts.structured_only}\` | Hybrid: \`${evidence.identityVerdicts.hybrid_identity_first}\``);
  lines.push('');
  lines.push(
    '| Field | Ground Truth | 1. Baseline | 2. Current + Strict | 3. Structured Only | 4. Hybrid (Identity-First) | Disagreement? |',
  );
  lines.push(
    '| :--- | :--- | :--- | :--- | :--- | :--- | :---: |',
  );

  for (const f of evidence.fields) {
    const gtStr = f.available
      ? `"${sanitizeCell(f.expectedValue ?? 'N/A')}" *(available)*`
      : f.inapplicable
        ? `*[INAPPLICABLE]*`
        : `*[ABSENT]* *(unavailable)*`;

    const formatCell = (c: FieldEvidenceCell): string => {
      if (c.value !== null && c.value !== '') {
        const val = sanitizeCell(c.value.length > 40 ? c.value.slice(0, 37) + '...' : c.value);
        const matchIcon = c.isCorrect ? '✓' : '✗';
        const conflictTag = c.status === 'conflict'
          ? ` <br>⚠️ *Conflict${c.conflictDetails ? `: ${sanitizeCell(c.conflictDetails.length > 50 ? c.conflictDetails.slice(0, 47) + '...' : c.conflictDetails)}` : ''}*`
          : '';
        return `"${val}" <br>*(${sanitizeCell(c.provenance)})* ${matchIcon}${conflictTag}`;
      }
      const reasonTag = c.missingReason ? `\`[${c.missingReason.toUpperCase()}]\`` : '`[MISSING]`';
      return `${reasonTag} <br>*(${sanitizeCell(c.provenance)})*`;
    };

    const bCell = formatCell(f.cells.current_extraction);
    const sCell = formatCell(f.cells.current_strict_images);
    const oCell = formatCell(f.cells.structured_only);
    const hCell = formatCell(f.cells.hybrid_identity_first);
    const disagree = f.disagreementDetected ? '⚠️ Yes' : '—';

    lines.push(
      `| **${f.field}** | ${gtStr} | ${bCell} | ${sCell} | ${oCell} | ${hCell} | ${disagree} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function formatMissingFieldsSummary(evidences: SampleFieldEvidence[]): string {
  const missingByReason: Record<MissingFieldReason, Array<{ sampleId: string; field: string; explanation: string; configuration: ReplayConfiguration }>> = {
    absent: [],
    inapplicable: [],
    conflicted: [],
    failed: [],
  };

  for (const ev of evidences) {
    for (const item of ev.missingFieldExplanations) {
      missingByReason[item.reason].push({
        sampleId: ev.sampleId,
        field: item.field,
        explanation: item.explanation,
        configuration: item.configuration,
      });
    }
  }

  const lines: string[] = [];
  lines.push('## Missing Fields Truth Table');
  lines.push('');
  lines.push('> **Audit Completeness Discipline:** Every missing field is categorized into one of four mutually exclusive states:');
  lines.push('> - **Absent:** Naturally absent from the source page; the page never carried it.');
  lines.push('> - **Inapplicable:** Does not apply to the specific product scope or variant shape.');
  lines.push('> - **Conflicted:** Selector and structured sources disagreed, requiring manual review.');
  lines.push('> - **Failed:** Present on the page, but the extractor failed to capture it.');
  lines.push('');
  lines.push('| Category | Total Occurrences | Explanation & Impact | Sample Examples |');
  lines.push('| :--- | :---: | :--- | :--- |');

  const absentTotal = missingByReason.absent.length;
  const absentDistinct = new Set(missingByReason.absent.map(m => `${m.sampleId}:${m.field}`)).size;
  const absentSamples = Array.from(new Set(missingByReason.absent.map(m => `\`${m.sampleId}:${m.field}\``))).slice(0, 3).join(', ') || 'None';
  lines.push(`| **Absent (Unavailable)** | ${absentTotal} (${absentDistinct} unique) | Page does not contain this field; does not penalize score | ${absentSamples} |`);

  const inappTotal = missingByReason.inapplicable.length;
  const inappDistinct = new Set(missingByReason.inapplicable.map(m => `${m.sampleId}:${m.field}`)).size;
  const inappSamples = Array.from(new Set(missingByReason.inapplicable.map(m => `\`${m.sampleId}:${m.field}\``))).slice(0, 3).join(', ') || 'None';
  lines.push(`| **Inapplicable** | ${inappTotal} (${inappDistinct} unique) | Field not applicable for product or variant shape; exempt from penalty | ${inappSamples} |`);

  const conflictTotal = missingByReason.conflicted.length;
  const conflictDistinct = new Set(missingByReason.conflicted.map(m => `${m.sampleId}:${m.field}`)).size;
  const conflictSamples = Array.from(new Set(missingByReason.conflicted.map(m => `\`${m.sampleId}:${m.field}\``))).slice(0, 3).join(', ') || 'None';
  lines.push(`| **Conflicted** | ${conflictTotal} (${conflictDistinct} unique) | Cross-source disagreement surfaced; requires review | ${conflictSamples} |`);

  const failedTotal = missingByReason.failed.length;
  const failedDistinct = new Set(missingByReason.failed.map(m => `${m.sampleId}:${m.field}`)).size;
  const failedSamples = Array.from(new Set(missingByReason.failed.map(m => `\`${m.sampleId}:${m.field}\``))).slice(0, 3).join(', ') || 'None';
  lines.push(`| **Extraction Failed** | ${failedTotal} (${failedDistinct} unique) | Present on page but missed by extractor; penalizes score | ${failedSamples} |`);

  lines.push('');
  return lines.join('\n');
}

export function formatImageContactSheetMarkdown(sheet: ImageContactSheet): string {
  const lines: string[] = [];
  lines.push(`### Image Contact Sheet: \`${sheet.sampleId}\``);
  lines.push(`- **URL:** \`${sheet.url}\` | **Domain:** \`${sheet.domain}\``);
  lines.push(`- **Total Discovered:** ${sheet.totalDiscovered} | **Accepted:** ${sheet.admittedCount} | **Rejected:** ${sheet.rejectedCount} | **Primary Image Accuracy:** ${(sheet.primaryAccuracy * 100).toFixed(0)}%`);
  lines.push('');

  lines.push('#### Accepted Images');
  if (sheet.acceptedImages.length === 0) {
    lines.push('_No images accepted._');
  } else {
    lines.push('| # | Flag | Image URL | Role | Ground Truth Status |');
    lines.push('| :---: | :---: | :--- | :---: | :---: |');
    sheet.acceptedImages.forEach((img, i) => {
      const flag = img.isPrimary ? '⭐ **[PRIMARY]**' : '🖼️ `[GALLERY]`';
      const gtStatus = img.isExpectedPrimary
        ? '✓ Expected Primary'
        : img.isExpectedAdmissible
          ? '✓ Expected Admissible'
          : '⚠️ Extra Admitted';
      lines.push(`| ${i + 1} | ${flag} | \`${sanitizeCell(img.url)}\` | ${img.role} | ${gtStatus} |`);
    });
  }

  lines.push('');
  lines.push('#### Rejected Images');
  if (sheet.rejectedImages.length === 0) {
    lines.push('_No images rejected._');
  } else {
    lines.push('| # | Image URL | Rejection Reason | Role / Pattern |');
    lines.push('| :---: | :--- | :--- | :--- |');
    sheet.rejectedImages.forEach((img, i) => {
      lines.push(`| ${i + 1} | \`${sanitizeCell(img.url)}\` | \`${sanitizeCell(img.rejectionReason ?? 'filtered')}\` | ${img.role} |`);
    });
  }

  lines.push('');
  return lines.join('\n');
}

export function formatHtmlContactSheet(sheet: ImageContactSheet): string {
  const acceptedCards = sheet.acceptedImages.map((img, i) => {
    const primaryBadge = img.isPrimary
      ? '<span style="background:#f59e0b;color:#000;padding:2px 6px;border-radius:4px;font-weight:bold;font-size:11px;">⭐ PRIMARY</span>'
      : '<span style="background:#10b981;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;">GALLERY</span>';

    const resolvedUrl = safeResolveUrl(img.url, sheet.url);
    const filename = img.url.split('/').pop() || img.url;

    return `
      <div style="border:2px solid ${img.isPrimary ? '#f59e0b' : '#10b981'};border-radius:8px;padding:8px;background:#1e293b;color:#f8fafc;width:220px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:#94a3b8;">#${i + 1}</span>
          ${primaryBadge}
        </div>
        <div style="height:140px;display:flex;align-items:center;justify-content:center;background:#0f172a;border-radius:4px;overflow:hidden;">
          <img src="${escapeHtml(resolvedUrl)}" alt="Accepted Image ${i + 1}" style="max-height:100%;max-width:100%;object-fit:contain;" loading="lazy" onerror="this.src='';this.alt='Image preview unavailable';" />
        </div>
        <div style="font-size:11px;word-break:break-all;color:#cbd5e1;" title="${escapeHtml(img.url)}">${escapeHtml(filename)}</div>
      </div>
    `;
  }).join('');

  const rejectedCards = sheet.rejectedImages.map((img, i) => {
    const resolvedUrl = safeResolveUrl(img.url, sheet.url);
    const filename = img.url.split('/').pop() || img.url;

    return `
      <div style="border:2px solid #ef4444;border-radius:8px;padding:8px;background:#1e293b;color:#f8fafc;width:220px;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;color:#94a3b8;">#${i + 1}</span>
          <span style="background:#ef4444;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;">REJECTED</span>
        </div>
        <div style="height:140px;display:flex;align-items:center;justify-content:center;background:#0f172a;border-radius:4px;overflow:hidden;opacity:0.6;">
          <img src="${escapeHtml(resolvedUrl)}" alt="Rejected Image ${i + 1}" style="max-height:100%;max-width:100%;object-fit:contain;" loading="lazy" onerror="this.src='';this.alt='Rejected image';" />
        </div>
        <div style="font-size:11px;color:#fca5a5;font-weight:600;">${escapeHtml(img.rejectionReason || 'Filtered')}</div>
        <div style="font-size:10px;word-break:break-all;color:#94a3b8;" title="${escapeHtml(img.url)}">${escapeHtml(filename)}</div>
      </div>
    `;
  }).join('');

  return `
    <div style="font-family:system-ui,sans-serif;margin-bottom:32px;padding:16px;background:#0f172a;border-radius:12px;color:#f8fafc;">
      <h3 style="margin-top:0;">Contact Sheet: ${escapeHtml(sheet.sampleId)}</h3>
      <p style="color:#94a3b8;font-size:13px;">URL: <code>${escapeHtml(sheet.url)}</code> | Discovered: ${sheet.totalDiscovered} | Accepted: ${sheet.admittedCount} | Rejected: ${sheet.rejectedCount}</p>
      
      <h4 style="color:#34d399;margin-bottom:12px;">Accepted Images (${sheet.admittedCount})</h4>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
        ${acceptedCards || '<p style="color:#64748b;">No accepted images.</p>'}
      </div>

      <h4 style="color:#f87171;margin-bottom:12px;">Rejected Images (${sheet.rejectedCount})</h4>
      <div style="display:flex;flex-wrap:wrap;gap:12px;">
        ${rejectedCards || '<p style="color:#64748b;">No rejected images.</p>'}
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Full Operator Review Surface Report Generator
// ─────────────────────────────────────────────────────────────────────────────

export function generateOperatorReviewReport(options: {
  manifest: AuditManifest;
  rows: AuditScoredRow[];
  outcomesBySample?: Record<string, Record<ReplayConfiguration, ExtractionOutcome>>;
}): OperatorReviewSurfaceReport {
  const { manifest, rows, outcomesBySample } = options;

  // 1. Compute Scope Summaries
  const scopeSummaries = computeScopeSummaries(manifest.samples, rows);

  // 2. Build Side-by-Side Field Evidences
  const fieldEvidences: SampleFieldEvidence[] = [];
  const contactSheets: ImageContactSheet[] = [];

  for (const sample of manifest.samples) {
    const sampleRows = rows.filter(r => r.sampleId === sample.sampleId);
    const sampleConflicts = sampleRows.find(r => r.configuration === 'hybrid_identity_first')?.conflicts || [];
    const evidence = buildSideBySideFieldEvidence(sample, sampleRows, sampleConflicts);
    fieldEvidences.push(evidence);

    // Build contact sheet from hybrid configuration
    const hybridRow = sampleRows.find(r => r.configuration === 'hybrid_identity_first') || sampleRows[0];
    const outcome = outcomesBySample?.[sample.sampleId]?.hybrid_identity_first;
    const contactSheet = buildImageContactSheet(sample, outcome || hybridRow);
    contactSheets.push(contactSheet);
  }

  // 3. Assemble Markdown Report
  const mdParts: string[] = [];
  mdParts.push(`# Profile Extraction Audit Gate: Operator Review Surface`);
  mdParts.push(`**Domain:** \`${manifest.domain}\` | **Generated At:** ${manifest.generatedAt} | **Samples:** ${manifest.samples.length}`);
  mdParts.push('');

  // Pillar 4: Per-Scope Summary
  mdParts.push(formatPerScopeSummaryTable(scopeSummaries));

  // Pillar 2: Missing Fields Breakdown
  mdParts.push(formatMissingFieldsSummary(fieldEvidences));

  // Pillar 1: Side-by-Side Field Evidence
  mdParts.push('## Side-by-Side Field Evidence per Sample');
  mdParts.push('');
  for (const ev of fieldEvidences) {
    mdParts.push(formatSideBySideFieldEvidenceTable(ev));
  }

  // Pillar 3: Image Contact Sheets
  mdParts.push('## Image Contact Sheets');
  mdParts.push('');
  for (const cs of contactSheets) {
    mdParts.push(formatImageContactSheetMarkdown(cs));
  }

  const markdown = mdParts.join('\n');

  // 4. Assemble HTML Report
  const htmlParts: string[] = [];
  htmlParts.push(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Operator Review: ${escapeHtml(manifest.domain)}</title></head><body style="background:#020617;color:#f8fafc;font-family:system-ui,sans-serif;padding:24px;">`);
  htmlParts.push(`<h1>Operator Review: ${escapeHtml(manifest.domain)}</h1>`);
  for (const cs of contactSheets) {
    htmlParts.push(formatHtmlContactSheet(cs));
  }
  htmlParts.push(`</body></html>`);
  const html = htmlParts.join('\n');

  return {
    domain: manifest.domain,
    generatedAt: manifest.generatedAt,
    totalSamples: manifest.samples.length,
    totalScopes: Object.keys(scopeSummaries).length,
    scopeSummaries,
    fieldEvidences,
    contactSheets,
    markdown,
    html,
  };
}
