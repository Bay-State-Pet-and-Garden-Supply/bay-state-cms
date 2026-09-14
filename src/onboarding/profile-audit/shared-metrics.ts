/**
 * Shared Audit-Harness Metrics (Profile-Audit One-Pass Fixes #9/#11/#13)
 *
 * Single home for the helpers and constants previously duplicated across
 * gate-arithmetic.ts, operator-review.ts, promotion-report.ts, and
 * reviewable-table.ts:
 * - REPLAY_CONFIGURATIONS + CONFIG_DISPLAY_NAMES (fix #10)
 * - CRITICAL_FIELDS, computeWilsonScoreInterval, sanitizeCell,
 *   isSampleServed + resolveZForConfidence (fix #9, fix #13)
 * - OPERATOR_MINUTE_COEFFICIENTS and other named gate constants (fix #11)
 *   (the retired fiat latency stand-ins were deleted in round-2: unmeasured
 *   rows report 0 + 'unmeasured' provenance, never a fiat estimate)
 * - getFamilyBucket / getFreshnessBucket sampled-dimension helpers (fix #4)
 * - getDeterministicScoredRowIdentity wall-clock exclusion (fix #8)
 *
 * NOTE (fix #13 — single source of truth): computeScopeSummaries
 * (operator-review.ts) and evaluateScopeGate (gate-arithmetic.ts) MUST both
 * derive served/identity accuracy through isSampleServed() and confidence
 * intervals through resolveZForConfidence()/computeWilsonScoreInterval() here.
 * Do not re-implement served logic or the z-value ladder in either consumer.
 */

import type {
  AuditManifestSample,
  AuditScoredRow,
  ReplayConfiguration,
} from '../../shared/schemas/profile-audit';

// ─────────────────────────────────────────────────────────────────────────────
// Replay configurations + display names (fix #10)
// ─────────────────────────────────────────────────────────────────────────────

/** The four replay configurations, in canonical presentation order. */
export const REPLAY_CONFIGURATIONS: ReplayConfiguration[] = [
  'current_extraction',
  'current_strict_images',
  'structured_only',
  'hybrid_identity_first',
];

/**
 * Canonical display names for the four configurations.
 *
 * NOTE: the side-by-side evidence table (operator-review.ts) and the
 * reviewable summary table (reviewable-table.ts) use shorter/longer
 * presentation-specific column headers pinned by existing reviewable-output
 * tests; those literals stay at their call sites. This map is the canonical
 * name for any NEW surface — do not invent a third spelling.
 */
export const CONFIG_DISPLAY_NAMES: Record<ReplayConfiguration, string> = {
  current_extraction: '1. Baseline (Current)',
  current_strict_images: '2. Current + Strict Images',
  structured_only: '3. Structured Signals Only',
  hybrid_identity_first: '4. Hybrid (Identity-First + Strict)',
};

/** Fields where a hybrid-vs-baseline regression blocks promotion. */
export const CRITICAL_FIELDS = ['title', 'brand', 'price'];

// ─────────────────────────────────────────────────────────────────────────────
// Uncertainty helpers (fix #9: deduped from gate-arithmetic/operator-review)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes Wilson Score interval for binomial proportions (e.g. served rate,
 * identity accuracy, primary image accuracy).
 */
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

/**
 * Resolves the z-value ladder from a target confidence level (deduped from
 * computeScopeSummaries/evaluateScopeGate). Values above 1 are treated as a
 * literal z-value passthrough.
 */
export function resolveZForConfidence(targetConfidence?: number): number {
  if (targetConfidence === undefined) return 1.96;
  if (targetConfidence > 1) return targetConfidence;
  if (targetConfidence >= 0.99) return 2.576;
  if (targetConfidence >= 0.95) return 1.96;
  if (targetConfidence >= 0.90) return 1.645;
  if (targetConfidence >= 0.80) return 1.282;
  return 1.96;
}

/**
 * Served-row predicate shared by computeScopeSummaries and evaluateScopeGate
 * (fix #13): a sample is served only when identity matched, the row is not an
 * evidence gap, and every available non-inapplicable critical field scored
 * correct.
 */
export function isSampleServed(row: AuditScoredRow, sample: AuditManifestSample): boolean {
  if (row.identityVerdict !== 'correct_match' || row.isEvidenceGap) return false;
  for (const field of CRITICAL_FIELDS) {
    const spec = sample.groundTruth.fields[field];
    if (spec?.available && !spec.inapplicable) {
      const fScore = row.fieldScores[field];
      if (!fScore || !fScore.correct) return false;
    }
  }
  return true;
}

/** Markdown/HTML cell sanitizer shared by operator-review/promotion-report. */
export function sanitizeCell(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Named gate constants (fix #11: no magic numbers at call sites)
// ─────────────────────────────────────────────────────────────────────────────

// NOTE (round-2 P2): the retired fiat latency stand-ins (120/135/95/150ms)
// previously lived here as DEFAULT_LATENCIES_MS. They are deleted — not
// merely unexported — so no consumer can mistake them for live inputs and
// lint cannot rot on an unused binding. Git history preserves the values.
// computeScopeCostMetrics reports unmeasured rows as 0 + 'unmeasured'
// provenance (fix #5), never a fiat estimate.

/**
 * Coefficients for the MODELED operator-maintenance formula (fix #6/#11).
 * Operator minutes are modeled estimates, never measurements, unless a
 * measured override is supplied via ComputeCostOptions.operatorMinutesOverride.
 * Formulas:
 * - current_extraction: BASE_MAINTENANCE + defects * DEFECT_REPAIR
 * - current_strict_images: BASE_MAINTENANCE*STRICT_BASE_FACTOR + defects * DEFECT_REPAIR_STRICT
 * - structured_only: STRUCTURED_BASE + missingCount * STRUCTURED_MISSING_FIELD
 * - hybrid_identity_first: HYBRID_BASE_TRIAGE + conflicts*HYBRID_CONFLICT
 *   + unresolved*HYBRID_UNRESOLVED_VARIANT + identityErrors*HYBRID_IDENTITY_ERROR
 */
export const OPERATOR_MINUTE_COEFFICIENTS = {
  /** Selector-drift upkeep for selector-led configs (minutes/domain). */
  BASE_MAINTENANCE_MINUTES: 15.0,
  /** Strict-images config carries ~80% of baseline selector upkeep. */
  STRICT_BASE_FACTOR: 0.8,
  /** Repair minutes per defect (identity error or missing available field). */
  DEFECT_REPAIR_MINUTES: 3.0,
  /** Repair minutes per defect under the strict-images config. */
  DEFECT_REPAIR_MINUTES_STRICT: 2.5,
  /** Structured-only has zero selector upkeep; fixed review overhead. */
  STRUCTURED_BASE_MINUTES: 3.0,
  /** Review minutes per missing available field (structured-only). */
  STRUCTURED_MISSING_FIELD_MINUTES: 1.0,
  /** Fixed conflict-triage overhead for hybrid. */
  HYBRID_BASE_TRIAGE_MINUTES: 2.0,
  /** Triage minutes per selector-vs-structured conflict. */
  HYBRID_CONFLICT_MINUTES: 2.0,
  /** Triage minutes per unresolved/ambiguous variant. */
  HYBRID_UNRESOLVED_VARIANT_MINUTES: 3.0,
  /** Triage minutes per accepted identity error. */
  HYBRID_IDENTITY_ERROR_MINUTES: 5.0,
} as const;

/** Minimum samples for a GO verdict (gate option override supported). */
export const MIN_SAMPLES_FOR_PROMOTE_DEFAULT = 3;

/**
 * Image-recall floor as a fraction of the measured baseline recall
 * (derived from baseline rows per scope — never a fiat absolute).
 */
export const IMAGE_RECALL_FLOOR_FACTOR = 0.9;

/** Number of hash buckets for the sampled product-family dimension. */
export const FAMILY_BUCKET_COUNT = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Sampled stratum dimensions (fix #4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable product-family bucket for the stratum key (FNV-1a 32-bit, same
 * construction as splitForFamily). Bucketing (not the raw family id) keeps
 * stratum cardinality bounded while making family coverage a sampled
 * dimension. Holdout partitioning still hashes the FULL family id via
 * splitForFamily — buckets never replace the holdout guarantee.
 */
export function getFamilyBucket(familyId: string, bucketCount: number = FAMILY_BUCKET_COUNT): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < familyId.length; i++) {
    hash ^= familyId.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return `family-bucket-${(hash >>> 0) % Math.max(1, bucketCount)}`;
}

/**
 * Stable capture-freshness bucket (UTC calendar quarter) for the stratum key,
 * e.g. "freshness-2026-q3". Deterministic from the recorded captureFreshness;
 * unparseable/missing freshness maps to "freshness-unknown" (still a sampled
 * bucket, never dropped). Per-sample ISO freshness recording is unchanged.
 */
export function getFreshnessBucket(freshnessIso: string | null | undefined): string {
  if (!freshnessIso) return 'freshness-unknown';
  const d = new Date(freshnessIso);
  if (isNaN(d.getTime())) return 'freshness-unknown';
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `freshness-${d.getUTCFullYear()}-q${quarter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Determinism identity (fix #8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic identity for a scored row.
 *
 * Replay is refetch-free (same artifact bytes in → same extraction out), but
 * wall-clock latencyMs (performance.now(), only recorded when
 * recordLatency:true) is NON-DETERMINISTIC by construction. Scored-row
 * identity/determinism comparisons MUST use this helper — which excludes
 * wall-clock latency — and never raw row equality. Guarantee:
 * same-artifact-in → same-scored-row-out, excluding wall-clock timing.
 */
export function getDeterministicScoredRowIdentity(row: AuditScoredRow): string {
  const { latencyMs: _wallClockLatencyMs, ...deterministicRest } = row;
  void _wallClockLatencyMs;
  return JSON.stringify(deterministicRest);
}
