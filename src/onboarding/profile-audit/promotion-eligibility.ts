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
   * Count of usable scored observations that qualify for gate consideration.
   * In this T1 prefactor, matches sampleCount. T2 will refine this to complete,
   * eligible baseline and candidate pairs with reviewed evidence.
   */
  usableObservationCount: number;
  /** Baseline scored rows matching the samples. */
  baselineRows: AuditScoredRow[];
  /** Candidate/hybrid scored rows matching the samples. */
  hybridRows: AuditScoredRow[];
  /** Set of sample IDs matching the scope. */
  sampleIdSet: Set<string>;
  /** Whether the usable observation count satisfies minSamples. */
  isSufficientSample: boolean;
}

/**
 * Counts and resolves usable observations for a given scope.
 *
 * Single source of truth for observation qualification across gate evaluation
 * and promotion reporting.
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

  // In this T1 prefactor, usableObservationCount matches total manifest sampleCount.
  // T2 will refine this to count complete, eligible pairs.
  const usableObservationCount = totalSampleCount;
  const isSufficientSample = usableObservationCount >= minSamples;

  return {
    sampleCount,
    totalSampleCount,
    usableObservationCount,
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
   * In T1 prefactor, always true (no verdict changes). T2 will enforce
   * reviewed, versioned labels and non-circular ground truth.
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
    };
  }

  const totalCount = samples.length;
  const hasIndependentLabels = independentCount > 0;
  const isAllAutoDerived = totalCount > 0 && autoDerivedCount === totalCount;

  // In T1 prefactor, provenance does not alter verdicts. T2 will enforce gates.
  const isProvenanceValidForPromotion = true;
  const provenanceReasons: string[] = [];

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
  } = input;

  const isSufficientSample = sampleCount >= minSamples;
  const promotabilityReasons: string[] = [];

  let verdict: ContractPromotionVerdict;
  let promotabilityVerdict: 'PROMOTABLE' | 'BLOCKED' | 'NEEDS_REVIEW';
  let isPromotable: boolean;

  if (!allThresholdsPassed || abstentionGaming.gamingDetected) {
    verdict = 'NO_GO';
    promotabilityVerdict = 'BLOCKED';
    isPromotable = false;

    const blockedReasons = buildBlockedReasons(thresholds, abstentionGaming, {
      provenanceReasons: input.labelProvenance?.provenanceReasons,
    });
    promotabilityReasons.push(...blockedReasons);
  } else if (!isSufficientSample) {
    verdict = 'NEEDS_REVIEW';
    promotabilityVerdict = 'NEEDS_REVIEW';
    isPromotable = false;
    promotabilityReasons.push(
      `Needs Review: Sample count (${sampleCount}) is below standard gate threshold (minimum ${minSamples} required) to prove superiority within confidence margin`,
    );
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
      `✓ Maintained or improved field completeness (${(hybridFieldStatsMean * 100).toFixed(1)}%)`,
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
