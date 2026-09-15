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
import {
  type ComputeCostOptions,
  evaluateScopeGate,
} from './gate-arithmetic';
import {
  REPLAY_CONFIGURATIONS,
  CONFIG_DISPLAY_NAMES as SHARED_CONFIG_DISPLAY_NAMES,
  CRITICAL_FIELDS as SHARED_CRITICAL_FIELDS,
  computeWilsonScoreInterval as sharedWilsonScoreInterval,
  sanitizeCell as sharedSanitizeCell,
} from './shared-metrics';

const CONFIGURATIONS: ReplayConfiguration[] = [...REPLAY_CONFIGURATIONS];

/**
 * Canonical configuration display names (single source of truth in
 * shared-metrics.ts; fix #10). Re-exported here for back-compat.
 */
export const CONFIG_DISPLAY_NAMES: Record<ReplayConfiguration, string> = SHARED_CONFIG_DISPLAY_NAMES;

/**
 * Wilson score interval (single source of truth in shared-metrics.ts;
 * fix #9). Re-exported here for back-compat.
 */
export const computeWilsonScoreInterval = sharedWilsonScoreInterval;

const CRITICAL_FIELDS: string[] = SHARED_CRITICAL_FIELDS;
const sanitizeCell = sharedSanitizeCell;

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
  fallbackConfiguration?: ReplayConfiguration,
): ImageContactSheet {
  const configuration = (rowOrOutcome && 'configuration' in rowOrOutcome)
    ? rowOrOutcome.configuration
    : fallbackConfiguration;

  if (!rowOrOutcome) {
    return {
      sampleId: sample.sampleId,
      url: sample.url,
      domain: sample.domain,
      configuration,
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
    let role: string;
    if (lower.includes('icon') || lower.includes('social') || lower.includes('payment') || lower.includes('badge') || lower.includes('role_rejected')) {
      role = 'icon';
    } else if (lower.includes('duplicate')) {
      role = 'duplicate';
    } else if (lower.includes('unknown') || lower.includes('membership') || lower.includes('unrelated')) {
      role = 'unknown_membership';
    } else if (lower.includes('cap')) {
      role = 'cap_exceeded';
    } else if (lower.includes('not_usable')) {
      role = 'not_usable';
    } else {
      role = 'other_variant';
    }

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
    configuration,
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
  /** Cost-model inputs forwarded to computeScopeCostMetrics. */
  costOptions?: ComputeCostOptions;
}

export function computeScopeSummaries(
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  options: ComputeScopeSummariesOptions = {},
): Record<string, ScopeServedRateSummary> {
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
    // Single aggregation path: delegate to evaluateScopeGate (fix #13).
    // All identity-error/regression counting, served-rate computation,
    // Wilson-based identity accuracy, threshold checks, abstention-gaming
    // detection, and reason-string construction happen once in the gate.
    const gateOptions = {
      minSamplesForPromote: options.minSamplesForPromote,
      targetConfidence: options.targetConfidence,
      ...options.costOptions,
    };
    const verdict = evaluateScopeGate(scopeKey, scopeSamples, rows, gateOptions);

    // Project ScopePromotionVerdict → ScopeServedRateSummary.
    // No second loop, no copied reason strings — the verdict is authoritative.
    summaries[scopeKey] = {
      scope: verdict.scope,
      domain: verdict.domain,
      platform: verdict.platform,
      sampleCount: verdict.sampleCount,
      servedRate: verdict.servedRate.value,
      baselineServedRate: verdict.baselineServedRate,
      servedRateDelta: verdict.servedRateDelta,
      uncertainty: verdict.servedRate.uncertainty,
      confidenceInterval: {
        lower: verdict.servedRate.confidenceInterval.lower,
        upper: verdict.servedRate.confidenceInterval.upper,
      },
      // Identity accuracy: Wilson-based (from evaluateScopeGate), not the
      // previous plain-ratio fallback. Both surfaces now use one formula.
      identityAccuracy: verdict.identityAccuracy.value,
      acceptedIdentityErrors: verdict.acceptedIdentityErrors,
      meanFieldCorrectness: verdict.fieldCorrectness.value,
      baselineMeanFieldCorrectness: verdict.baselineFieldCorrectness,
      criticalFieldRegressionCount: verdict.criticalFieldRegressions,
      meanImagePrecision: verdict.imagePrecision.value,
      baselineMeanImagePrecision: verdict.baselineImagePrecision,
      meanImageRecall: verdict.imageRecall.value,
      primaryImageAccuracy: verdict.primaryImageAccuracy.value,
      evidenceGapCount: verdict.abstentionGaming.hybridEvidenceGaps,
      isPromotable: verdict.isPromotable,
      promotabilityVerdict: verdict.promotabilityVerdict,
      promotabilityReasons: verdict.promotabilityReasons,
      contractVerdict: verdict.verdict,
      thresholds: verdict.thresholds,
      abstentionGaming: verdict.abstentionGaming,
      costMetrics: verdict.costMetrics,
      uncertainties: {
        servedRate: verdict.servedRate,
        fieldCorrectness: verdict.fieldCorrectness,
        imagePrecision: verdict.imagePrecision,
        imageRecall: verdict.imageRecall,
      },
    };
  }

  return summaries;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Markdown Formatters (sanitizeCell: single source of truth in shared-metrics.ts)
// ─────────────────────────────────────────────────────────────────────────────

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
  const configLabel = sheet.configuration ? ` (${CONFIG_DISPLAY_NAMES[sheet.configuration] || sheet.configuration})` : '';
  lines.push(`### Image Contact Sheet: \`${sheet.sampleId}\`${configLabel}`);
  lines.push(`- **URL:** \`${sheet.url}\` | **Domain:** \`${sheet.domain}\`${sheet.configuration ? ` | **Configuration:** \`${sheet.configuration}\`` : ''}`);
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
      <h3 style="margin-top:0;">Contact Sheet: ${escapeHtml(sheet.sampleId)}${sheet.configuration ? ` <span style="font-size:14px;color:#94a3b8;">(${escapeHtml(CONFIG_DISPLAY_NAMES[sheet.configuration] || sheet.configuration)})</span>` : ''}</h3>
      <p style="color:#94a3b8;font-size:13px;">URL: <code>${escapeHtml(sheet.url)}</code> | Domain: <code>${escapeHtml(sheet.domain)}</code>${sheet.configuration ? ` | Configuration: <code>${escapeHtml(sheet.configuration)}</code>` : ''} | Discovered: ${sheet.totalDiscovered} | Accepted: ${sheet.admittedCount} | Rejected: ${sheet.rejectedCount}</p>
      
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
  /** Optional cost-model inputs (measured operator-minutes overrides, base
   * upkeep) forwarded to computeScopeCostMetrics. */
  costOptions?: ComputeCostOptions;
}): OperatorReviewSurfaceReport {
  const { manifest, rows, outcomesBySample, costOptions } = options;

  // 1. Compute Scope Summaries
  const scopeSummaries = computeScopeSummaries(manifest.samples, rows, { costOptions });

  // 2. Build Side-by-Side Field Evidences + per-configuration contact sheets
  const fieldEvidences: SampleFieldEvidence[] = [];
  const contactSheets: ImageContactSheet[] = [];
  const contactSheetsByConfiguration: Record<ReplayConfiguration, ImageContactSheet[]> = {
    current_extraction: [],
    current_strict_images: [],
    structured_only: [],
    hybrid_identity_first: [],
  };

  for (const sample of manifest.samples) {
    const sampleRows = rows.filter(r => r.sampleId === sample.sampleId);
    const sampleConflicts = sampleRows.find(r => r.configuration === 'hybrid_identity_first')?.conflicts || [];
    const evidence = buildSideBySideFieldEvidence(sample, sampleRows, sampleConflicts);
    fieldEvidences.push(evidence);

    // Fix #3: contact sheets for ALL four configurations (reusing
    // buildImageContactSheet). `contactSheets` stays hybrid-only for
    // back-compat; the per-config map is the complete view.
    // NOTE (round-2 P2): never substitute another configuration's row when the
    // requested config is absent — buildImageContactSheet(null) yields an
    // explicit empty gap sheet instead of a mislabeled row.
    for (const cfg of CONFIGURATIONS) {
      const cfgRow = sampleRows.find(r => r.configuration === cfg);
      const cfgOutcome = outcomesBySample?.[sample.sampleId]?.[cfg];
      const sheet = buildImageContactSheet(
        sample,
        cfgOutcome ?? cfgRow ?? null,
        cfg,
      );
      contactSheetsByConfiguration[cfg].push(sheet);
      if (cfg === 'hybrid_identity_first') contactSheets.push(sheet);
    }
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

  // Pillar 3: Image Contact Sheets (hybrid view; per-config map below)
  mdParts.push('## Image Contact Sheets');
  mdParts.push('');
  for (const cs of contactSheets) {
    mdParts.push(formatImageContactSheetMarkdown(cs));
  }

  // Per-configuration image evidence (fix #3): admitted/rejected counts for
  // every sample under every configuration, built with buildImageContactSheet.
  mdParts.push('## Per-Configuration Image Evidence');
  mdParts.push('');
  mdParts.push('> Contact sheets are built per configuration; the hybrid sheets above are the detailed view.');
  mdParts.push('');
  mdParts.push('| Sample | Configuration | Admitted | Rejected | Primary Acc |');
  mdParts.push('| :--- | :--- | :---: | :---: | :---: |');
  for (const cfg of CONFIGURATIONS) {
    for (const cs of contactSheetsByConfiguration[cfg]) {
      mdParts.push(`| ${cs.sampleId} | ${CONFIG_DISPLAY_NAMES[cfg]} | ${cs.admittedCount} | ${cs.rejectedCount} | ${(cs.primaryAccuracy * 100).toFixed(0)}% |`);
    }
  }
  mdParts.push('');

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
    contactSheetsByConfiguration,
    markdown,
    html,
  };
}
