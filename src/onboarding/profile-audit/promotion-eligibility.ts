/**
 * Profile Extraction Audit: Shared Promotion Eligibility Helper (Issue #185 / T1 Prefactor)
 *
 * Single source of truth for:
 * 1. Usable-observation counting: which observations count toward gate consideration.
 * 2. Provenance inspection: what label provenance (independent vs auto-derived, holdout, reviewed) is carried.
 * 3. Blocked-reason construction: collates threshold failures, abstention gaming, sample size bounds, and provenance.
 * 4. Recommendation text: consistent action guidance per contract promotion verdict.
 * 5. Unified promotion eligibility decision: evaluates whether a scope qualifies for contract work.
 *
 * This prefactor establishes the shared seam with current behavior pinned by characterization
 * so that subsequent trust fixes (T2+) change decisions in exactly one place.
 */

import type {
  AuditManifestSample,
  AuditScoredRow,
  ContractPromotionVerdict,
  GateThresholdCheck,
  AbstentionGamingCheck,
  ScopeCostMetrics,
  GroundTruthSource,
} from '../../shared/schemas/profile-audit';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Usable Observation Counting
// ─────────────────────────────────────────────────────────────────────────────

export interface UsableObservationCounts {
  /** Total sample count in the manifest scope. */
  sampleCount: number;
  /** Alias for total sample count in the manifest scope. */
  totalSampleCount: number;
  /**
   * Count of usable scored observations that qualify for gate consideration
   * (complete, eligible baseline and candidate pairs with non-gapped evidence).
   */
  usableObservationCount: number;
  /** Count of samples with missing artifacts or evidence gaps in baseline or candidate. */
  evidenceGapCount: number;
  /** Whether any sample has an evidence gap. */
  hasEvidenceGaps: boolean;
  /** Whether all samples in the scope have missing or gapped evidence. */
  isAllEvidenceGaps: boolean;
  /** Baseline scored rows matching the samples. */
  baselineRows: AuditScoredRow[];
  /** Candidate/hybrid scored rows matching the samples. */
  hybridRows: AuditScoredRow[];
  /** Set of sample IDs matching the scope. */
  sampleIdSet: Set<string>;
  /** Whether the usable observation count satisfies minSamples and is positive. */
  isSufficientSample: boolean;
}

/**
 * Counts and resolves usable observations for a given scope.
 *
 * Single source of truth for observation qualification across gate evaluation
 * and promotion reporting. Counts complete, eligible baseline and candidate
 * observation pairs without evidence gaps.
 */
export function resolveUsableObservations(
  samples: AuditManifestSample[],
  rows: AuditScoredRow[],
  minSamples: number,
): UsableObservationCounts {
  const sampleCount = samples.length;
  const totalSampleCount = sampleCount;
  const sampleIdSet = new Set(samples.map(s => s.sampleId));

  const baselineRows = rows.filter(
    r => sampleIdSet.has(r.sampleId) && r.configuration === 'current_extraction',
  );
  const hybridRows = rows.filter(
    r => sampleIdSet.has(r.sampleId) && r.configuration === 'hybrid_identity_first',
  );

  let usableObservationCount = 0;
  let evidenceGapCount = 0;

  for (const s of samples) {
    const b = baselineRows.find(r => r.sampleId === s.sampleId);
    const h = hybridRows.find(r => r.sampleId === s.sampleId);
    if (b && h && !b.isEvidenceGap && !h.isEvidenceGap) {
      usableObservationCount++;
    } else {
      evidenceGapCount++;
    }
  }

  const hasEvidenceGaps = evidenceGapCount > 0;
  const isAllEvidenceGaps = sampleCount > 0 && evidenceGapCount === sampleCount;
  const isSufficientSample = usableObservationCount >= minSamples && usableObservationCount > 0;

  return {
    sampleCount,
    totalSampleCount,
    usableObservationCount,
    evidenceGapCount,
    hasEvidenceGaps,
    isAllEvidenceGaps,
    baselineRows,
    hybridRows,
    sampleIdSet,
    isSufficientSample,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Provenance Inspection
// ─────────────────────────────────────────────────────────────────────────────

export interface LabelProvenanceInspection {
  totalCount: number;
  independentCount: number;
  autoDerivedCount: number;
  unspecifiedCount: number;
  holdoutCount: number;
  confirmedCount: number;
  candidateCount: number;
  hasIndependentLabels: boolean;
  isAllAutoDerived: boolean;
  /**
   * Enforces reviewed, versioned labels and non-circular ground truth (Issue #188 / T2).
   * Auto-derived rows are circular (self-consistency only) and cannot qualify for promotion.
   */
  isProvenanceValidForPromotion: boolean;
  provenanceReasons: string[];
  bySampleId: Record<
    string,
    {
      groundTruthSource?: GroundTruthSource;
      isHoldout?: boolean;
      holdoutFamilyName?: string | null;
      inventoryStatus: 'confirmed' | 'candidate';
      isReviewed?: boolean;
      labelVersion?: string | null;
    }
  >;
}

/**
 * Inspects label provenance across manifest samples.
 *
 * Single source of truth for checking whether labels are independently labeled
 * or circular/auto-derived, and tracking holdout partitions.
 */
export function inspectLabelProvenance(
  samples: AuditManifestSample[],
): LabelProvenanceInspection {
  let independentCount = 0;
  let autoDerivedCount = 0;
  let unspecifiedCount = 0;
  let holdoutCount = 0;
  let confirmedCount = 0;
  let candidateCount = 0;

  const bySampleId: LabelProvenanceInspection['bySampleId'] = {};

  for (const s of samples) {
    if (s.groundTruthSource === 'independent') {
      independentCount++;
    } else if (s.groundTruthSource === 'auto-derived') {
      autoDerivedCount++;
    } else {
      unspecifiedCount++;
    }

    if (s.isHoldout) holdoutCount++;
    if (s.inventoryStatus === 'confirmed') confirmedCount++;
    if (s.inventoryStatus === 'candidate') candidateCount++;

    bySampleId[s.sampleId] = {
      groundTruthSource: s.groundTruthSource,
      isHoldout: s.isHoldout,
      holdoutFamilyName: s.holdoutFamilyName,
      inventoryStatus: s.inventoryStatus,
      isReviewed: s.isReviewed,
      labelVersion: s.labelVersion,
    };
  }

  const totalCount = samples.length;
  const hasIndependentLabels = independentCount > 0;
  const isAllAutoDerived = totalCount > 0 && autoDerivedCount === totalCount;

  // Enforce non-circular ground truth for promotion (Issue #188 / T2).
  // Auto-derived rows may appear in exploratory reports but never qualify for promotion.
  // Unspecified provenance (legacy rows with no groundTruthSource) also cannot
  // qualify: only explicitly independent, reviewed labels promote.
  const isProvenanceValidForPromotion = totalCount > 0 ? hasIndependentLabels : true;
  const provenanceReasons: string[] = [];

  if (totalCount > 0 && !hasIndependentLabels) {
    if (isAllAutoDerived) {
      provenanceReasons.push(
        `Needs Review: Scope contains only auto-derived labels (${autoDerivedCount}/${totalCount} samples); auto-derived labels are circular and exploratory only; independent reviewed labels required for promotion`,
      );
    } else if (unspecifiedCount === totalCount) {
      provenanceReasons.push(
        `Needs Review: Scope contains only unspecified label provenance (${unspecifiedCount}/${totalCount} samples); legacy rows without groundTruthSource cannot qualify; independent reviewed labels required for promotion`,
      );
    } else {
      provenanceReasons.push(
        `Needs Review: No independent reviewed labels found in scope (${independentCount} independent of ${totalCount} samples); independent reviewed labels required for promotion`,
      );
    }
  }

  return {
    totalCount,
    independentCount,
    autoDerivedCount,
    unspecifiedCount,
    holdoutCount,
    confirmedCount,
    candidateCount,
    hasIndependentLabels,
    isAllAutoDerived,
    isProvenanceValidForPromotion,
    provenanceReasons,
    bySampleId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Blocked-Reason Construction & Recommendation Formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockedReasonOptions {
  sampleCount?: number;
  minSamples?: number;
  provenanceReasons?: string[];
}

/**
 * Collates blocking reasons from failed thresholds and abstention gaming checks,
 * ensuring clean deduplication.
 */
export function buildBlockedReasons(
  thresholds: GateThresholdCheck[],
  abstentionGaming: AbstentionGamingCheck,
  options?: BlockedReasonOptions,
): string[] {
  const reasons: string[] = [];

  for (const t of thresholds) {
    if (!t.passed) {
      reasons.push(t.reason);
    }
  }

  for (const r of abstentionGaming.reasons) {
    const formatted = r.startsWith('Blocked:') ? r : `Blocked: ${r}`;
    if (!reasons.includes(formatted) && !reasons.includes(r)) {
      reasons.push(formatted);
    }
  }

  if (options?.provenanceReasons) {
    for (const pr of options.provenanceReasons) {
      if (!reasons.includes(pr)) reasons.push(pr);
    }
  }

  return reasons;
}

/**
 * Formats the authoritative recommendation string for a contract promotion verdict.
 */
export function formatPromotionRecommendation(verdict: ContractPromotionVerdict): string {
  switch (verdict) {
    case 'GO':
      return '**PROCEED TO CONTRACT WORK.** This scope has proven superior quality, zero identity errors, improved image filtering, and bounded maintenance. Ready for ladder-wiring ADR revision.';
    case 'NO_GO':
      return '**REMAIN SELECTOR-LED WITH SCOPED EXCEPTIONS.** Do not force into hybrid arm until blocking regressions and errors are resolved.';
    case 'NEEDS_REVIEW':
      return '**EXPAND STRATIFIED SAMPLE.** Increase sample size to achieve sufficient statistical confidence before triggering contract work.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Unified Promotion Eligibility Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface PromotionEligibilityInput {
  scope: string;
  sampleCount: number;
  minSamples: number;
  allThresholdsPassed: boolean;
  thresholds: GateThresholdCheck[];
  abstentionGaming: AbstentionGamingCheck;
  costMetrics: ScopeCostMetrics;
  hybridPrecisionMean: number;
  baselineMeanImagePrecision: number;
  hybridFieldStatsMean: number;
  usableObservations?: UsableObservationCounts;
  labelProvenance?: LabelProvenanceInspection;
  /** Sample IDs of usable scored pairs failing the per-observation label contract (review finding 1). */
  provenanceViolations?: string[];
  baselineServedRate?: number;
  hybridServedRate?: number;
}

export interface PromotionEligibilityResult {
  verdict: ContractPromotionVerdict;
  isPromotable: boolean;
  promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
  promotabilityReasons: string[];
  recommendation: string;
}

/**
 * Evaluates scope promotion eligibility and collates verdicts, reasons, and recommendations.
 *
 * Single authoritative helper for both gate evaluation and promotion reporting.
 */
export function buildPromotabilityReasons(
  input: PromotionEligibilityInput,
): {
  verdict: ContractPromotionVerdict;
  promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
  isPromotable: boolean;
  promotabilityReasons: string[];
} {
  const {
    sampleCount,
    minSamples,
    allThresholdsPassed,
    thresholds,
    abstentionGaming,
    costMetrics,
    hybridPrecisionMean,
    baselineMeanImagePrecision,
    hybridFieldStatsMean,
    usableObservations,
    labelProvenance,
    provenanceViolations,
    baselineServedRate,
    hybridServedRate,
  } = input;

  const usableCount = usableObservations !== undefined ? usableObservations.usableObservationCount : sampleCount;
  const isSufficientSample = usableObservations !== undefined
    ? usableObservations.isSufficientSample
    : sampleCount >= minSamples;

  const promotabilityReasons: string[] = [];

  let verdict: ContractPromotionVerdict;
  let promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
  let isPromotable: boolean;

  // Zero-quality baseline equality check (Issue #188 / T2)
  const isZeroQualityBaselineEquality =
    (baselineMeanImagePrecision === 0 && hybridPrecisionMean === 0) ||
    (baselineMeanImagePrecision === 0 && hybridPrecisionMean === 0 && hybridFieldStatsMean === 0) ||
    (input.baselineMeanImagePrecision === 0 && input.hybridPrecisionMean === 0 && input.hybridFieldStatsMean === 0) ||
    (baselineServedRate !== undefined && hybridServedRate !== undefined && baselineServedRate === 0 && hybridServedRate === 0);

  if (abstentionGaming.gamingDetected) {
    verdict = 'NO_GO';
    promotabilityVerdict = 'BLOCKED';
    isPromotable = false;

    const blockedReasons = buildBlockedReasons(thresholds, abstentionGaming, {
      provenanceReasons: input.labelProvenance?.provenanceReasons,
    });
    promotabilityReasons.push(...blockedReasons);
  } else if (usableObservations?.isAllEvidenceGaps || (sampleCount > 0 && usableCount === 0)) {
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    const gapCount = usableObservations?.evidenceGapCount ?? sampleCount;
    promotabilityReasons.push(
      `Needs Review: All page artifacts are missing or gapped (${gapCount}/${sampleCount} samples with evidence gaps); 0 usable scored observation pairs available (minimum ${minSamples} required)`,
    );
  } else if (labelProvenance && !labelProvenance.isProvenanceValidForPromotion) {
    // Evidence before measurement: without valid provenance the scope cannot be
    // judged, so it needs review even when thresholds also fail (Issue #188 / T2).
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    if (labelProvenance.provenanceReasons.length > 0) {
      promotabilityReasons.push(...labelProvenance.provenanceReasons);
    } else {
      promotabilityReasons.push(
        'Needs Review: Label provenance is not valid for promotion; independent reviewed labels required for promotion',
      );
    }
  } else if (!isSufficientSample) {
    // Evidence before measurement: too few usable observation pairs to judge,
    // regardless of threshold outcomes.
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    if (usableObservations && usableObservations.evidenceGapCount > 0) {
      promotabilityReasons.push(
        `Needs Review: Usable observation count (${usableCount}) is below standard gate threshold (minimum ${minSamples} required) due to missing or gapped page evidence (${usableObservations.evidenceGapCount} evidence gaps)`,
      );
    } else {
      promotabilityReasons.push(
        `Needs Review: Sample count (${usableCount}) is below standard gate threshold (minimum ${minSamples} required) to prove superiority within confidence margin`,
      );
    }
  } else if (provenanceViolations && provenanceViolations.length > 0) {
    // Per-observation label contract (review finding 1): exploratory rows
    // must not count toward promotion, even beside independent labels.
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    const shown = provenanceViolations.slice(0, 5).join(', ');
    const more = provenanceViolations.length > 5 ? ', …' : '';
    promotabilityReasons.push(
      `Needs Review: ${provenanceViolations.length} participating observation(s) lack independently reviewed, versioned labels (${shown}${more}); auto-derived, unreviewed, or unversioned rows are exploratory only and cannot support promotion`,
    );
  } else if (!allThresholdsPassed || isZeroQualityBaselineEquality) {
    verdict = 'NO_GO';
    promotabilityVerdict = 'BLOCKED';
    isPromotable = false;

    const blockedReasons = buildBlockedReasons(thresholds, abstentionGaming, {
      provenanceReasons: input.labelProvenance?.provenanceReasons,
    });
    if (isZeroQualityBaselineEquality) {
      const zeroReason = 'Blocked: Equality with zero-quality baseline; promotion requires demonstrated quality and improvement';
      if (!blockedReasons.some(r => r.includes('zero-quality') || r.includes('Zero-quality'))) {
        blockedReasons.push(zeroReason);
      }
    }
    promotabilityReasons.push(...blockedReasons);
  } else {
    verdict = 'GO';
    promotabilityVerdict = 'PROMOTABLE';
    isPromotable = true;
    promotabilityReasons.push('✓ Zero observed identity errors (100% correct identity match)');
    promotabilityReasons.push('✓ Zero critical-field regressions on title, brand, or price');
    promotabilityReasons.push(
      `✓ Improved image precision (${(hybridPrecisionMean * 100).toFixed(1)}% vs ${(baselineMeanImagePrecision * 100).toFixed(1)}% baseline)`,
    );
    promotabilityReasons.push(
      `✓ Demonstrated field completeness improvement (${(hybridFieldStatsMean * 100).toFixed(1)}%)`,
    );
    promotabilityReasons.push('✓ Zero evidence-gap inflation / no abstention gaming');
    promotabilityReasons.push(
      `✓ Bounded maintenance: ${costMetrics.hybridOperatorMinutes.toFixed(1)} mins vs ${costMetrics.baselineOperatorMinutes.toFixed(1)} mins baseline`,
    );
  }

  return {
    verdict,
    promotabilityVerdict,
    isPromotable,
    promotabilityReasons,
  };
}

export function evaluatePromotionEligibility(
  input: PromotionEligibilityInput,
): PromotionEligibilityResult {
  const result = buildPromotabilityReasons(input);
  const recommendation = formatPromotionRecommendation(result.verdict);

  return {
    ...result,
    recommendation,
  };
}
