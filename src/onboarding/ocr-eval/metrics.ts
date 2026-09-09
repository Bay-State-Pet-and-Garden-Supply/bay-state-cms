/**
 * Packaging-OCR evaluation metrics + rollout gate (packaging-OCR overhaul
 * P3-T1 / P3-T3).
 *
 * Pure module — no DB, no transport. Consumes per-item results from
 * `runner.ts` and produces a comparison report per candidate vs the
 * baseline model, plus the pre-registered rollout gate from
 * docs/runbooks/packaging-ocr-model-rollout.md.
 *
 * Metric conventions:
 * - UPC match is digit-exact (labels and predictions are already digit
 *   normalized by the OCR coercion path).
 * - String fields compare case-folded + trimmed.
 * - Array fields count as a match when the label/prediction set-overlap
 *   Jaccard index ≥ ARRAY_JACCARD_MATCH_THRESHOLD.
 * - Hallucination rate: predicted non-null where the label is null, divided
 *   by the number of labeled-null scalar fields among SUCCESSFUL parses
 *   (failed attempts can never yield a hallucination, so counting their
 *   labeled-null fields would only deflate the rate for broken candidates).
 */

import { wilsonInterval } from './stats';
import type { GoldenOcrExpected } from './golden-dataset';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

/** Set-overlap Jaccard at/above which an array field counts as matched. */
export const ARRAY_JACCARD_MATCH_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

/** Scalar (string|null) OCR fields eligible for labeling. */
export const OCR_SCALAR_FIELDS = [
  'productName', 'brand', 'upc', 'flavorVariety', 'color', 'material',
  'size', 'weight', 'count', 'lifeStage', 'breedSize', 'productForm',
  'packagingType', 'npkRatio',
] as const;

export type OcrScalarField = (typeof OCR_SCALAR_FIELDS)[number];

/** Array-valued OCR fields eligible for labeling. */
export const OCR_ARRAY_FIELDS = [
  'species', 'healthConcernFunction', 'dietaryLabels',
  'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
] as const;

export type OcrArrayField = (typeof OCR_ARRAY_FIELDS)[number];

function normString(v: string): string {
  return v.trim().toLowerCase();
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(normString).filter(Boolean));
  const sb = new Set(b.map(normString).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const v of sa) if (sb.has(v)) intersection += 1;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Digit-exact UPC comparison (both sides expected to be digits-only). The
 *  expected label accepts undefined because labels are Partial — an omitted
 *  UPC label is simply "no expected value" (false, like null). */
export function upcMatches(predicted: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false;
  if (!predicted) return false;
  return predicted.replace(/\D/g, '') === expected.replace(/\D/g, '');
}

/** Whether one field's prediction matches its hand label. Returns null when the label does not cover the field. */
export function fieldMatches(
  field: string,
  predicted: PackagingOcrData | null,
  expected: GoldenOcrExpected,
): boolean | null {
  const inLabel = Object.prototype.hasOwnProperty.call(expected, field);
  if (!inLabel) return null;
  const labelValue = (expected as Record<string, unknown>)[field];
  const predRecord = predicted as unknown as Record<string, unknown> | null;
  const predValue = predRecord ? predRecord[field] : undefined;

  if (field === 'upc') {
    // Labeled-null UPC must be scored like every other labeled-null scalar
    // BEFORE delegating to upcMatches, whose digit-exact comparison
    // hard-fails whenever the label is null (a null prediction on a
    // null label is a match; a non-null prediction is a hallucination).
    if (labelValue === null) return predValue == null || predValue === '';
    return upcMatches(predValue as string | null | undefined, labelValue as string | null);
  }
  if ((OCR_ARRAY_FIELDS as readonly string[]).includes(field)) {
    const expArr = Array.isArray(labelValue) ? labelValue as string[] : [];
    const predArr = Array.isArray(predValue) ? predValue as string[] : [];
    return jaccard(expArr, predArr) >= ARRAY_JACCARD_MATCH_THRESHOLD && !(expArr.length === 0 && predArr.length > 0);
  }
  // Scalar string|null
  if (labelValue === null) return predValue == null || predValue === '';
  if (typeof labelValue !== 'string') return null;
  if (predValue == null || typeof predValue !== 'string' || predValue.trim() === '') return false;
  return normString(predValue) === normString(labelValue);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface OcrItemOutcome {
  entryId: string;
  /** Coded failure reason when ok=false ('unparseable_json', …). */
  reasonCode?: string;
  ok: boolean;
  latencyMs: number;
  data?: PackagingOcrData | null;
}

export interface OcrFieldMatchStats {
  matched: number;
  comparable: number;
  rate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
}

export interface OcrComparisonReport {
  candidateModel: string;
  baselineModel: string;
  samples: number;
  /** Per-field normalized match stats over entries whose labels cover the field. */
  fieldMatch: Record<string, OcrFieldMatchStats>;
  /** Convenience alias of fieldMatch.upc.rate (digit-exact UPC accuracy). */
  upcAccuracy: number | null;
  hallucinationRate: number | null;
  emptyRate: number;
  parseSuccessRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  failureReasonCounts: Record<string, number>;
  vsBaseline: {
    hasBaseline: boolean;
    upcAccuracyDelta: number | null;
    hallucinationRateDelta: number | null;
    emptyRateDelta: number | null;
    parseSuccessRateDelta: number | null;
    latencyP50DeltaMs: number | null;
    latencyP95DeltaMs: number | null;
    baselineLatencyP50Ms: number | null;
    baselineLatencyP95Ms: number | null;
  };
}

function percentile(sortedValues: number[], p: number): number | null {
  if (sortedValues.length === 0) return null;
  const idx = Math.min(sortedValues.length - 1, Math.ceil(p * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

/**
 * Aggregate per-item outcomes for ONE candidate into an OcrComparisonReport.
 * When `baselineReport` is supplied, `vsBaseline` carries deltas
 * (candidate − baseline); otherwise deltas stay null with hasBaseline=false.
 */
export function aggregateCandidateReport(
  candidateModel: string,
  outcomes: OcrItemOutcome[],
  options: {
    baselineModel?: string;
    baselineReport?: OcrComparisonReport;
    datasetEntries?: Array<{ id: string; expected: GoldenOcrExpected }>;
  } = {},
): OcrComparisonReport {
  const baselineModel = options.baselineModel ?? 'unknown';
  const samples = outcomes.length;

  const entryById = new Map((options.datasetEntries ?? []).map(e => [e.id, e.expected]));

  // Field match rates — only over entries that label the field.
  const fieldMatch: Record<string, OcrFieldMatchStats> = {};
  const allFields = [...OCR_SCALAR_FIELDS, ...OCR_ARRAY_FIELDS] as string[];
  for (const field of allFields) {
    let matched = 0;
    let comparable = 0;
    for (const outcome of outcomes) {
      const expected = entryById.get(outcome.entryId);
      if (!expected) continue;
      const m = fieldMatches(field, outcome.data ?? null, expected);
      if (m === null) continue;
      comparable += 1;
      if (m) matched += 1;
    }
    const rate = comparable > 0 ? matched / comparable : null;
    const interval = comparable > 0 ? wilsonInterval(matched / comparable, comparable) : { lower: 0, upper: 0 };
    fieldMatch[field] = {
      matched,
      comparable,
      rate,
      wilsonLower: comparable > 0 ? interval.lower : null,
      wilsonUpper: comparable > 0 ? interval.upper : null,
    };
  }

  // Hallucination rate over labeled-null scalar fields, accumulated ONLY
  // over successful (ok) parses — a failed attempt has no data and can
  // never yield a hallucination, so including its labeled-null fields in
  // the denominator deflates the rate for broken candidates.
  let hallucinations = 0;
  let labelNullFields = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const expected = entryById.get(outcome.entryId);
    if (!expected) continue;
    const predRecord = (outcome.data ?? null) as unknown as Record<string, unknown> | null;
    for (const field of OCR_SCALAR_FIELDS) {
      // Only explicitly labeled-null scalars enter the denominator. With the
      // Partial label schema, an OMITTED (undefined) key means "not hand
      // labeled" — counting it would treat unlabeled arrays/omissions as
      // asserted-absence labels and skew the rate.
      if (expected[field] !== null) continue;
      labelNullFields += 1;
      const v = predRecord ? predRecord[field] : undefined;
      if (v != null && !(Array.isArray(v) && v.length === 0) && v !== '') hallucinations += 1;
    }
  }
  const hallucinationRate = labelNullFields > 0 ? hallucinations / labelNullFields : null;

  // Empty-rate: failed attempts OR attempts with no non-empty payload field.
  let empties = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.data) {
      empties += 1;
      continue;
    }
    const rec = outcome.data as unknown as Record<string, unknown>;
    const anyPopulated = allFields.some(f => {
      const v = rec[f];
      if (v == null || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    });
    if (!anyPopulated) empties += 1;
  }
  const emptyRate = samples > 0 ? empties / samples : 0;

  const parseSuccesses = outcomes.filter(o => o.ok).length;
  const parseSuccessRate = samples > 0 ? parseSuccesses / samples : 0;

  const latencies = outcomes.map(o => o.latencyMs).sort((a, b) => a - b);
  const latencyP50Ms = percentile(latencies, 0.5) ?? 0;
  const latencyP95Ms = percentile(latencies, 0.95) ?? 0;

  const failureReasonCounts: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.ok) continue;
    const code = o.reasonCode ?? 'unknown';
    failureReasonCounts[code] = (failureReasonCounts[code] ?? 0) + 1;
  }

  // vsBaseline deltas (candidate − baseline).
  const base = options.baselineReport ?? null;
  const hasBaseline = Boolean(base);
  const delta = (a: number | null, b: number | null | undefined): number | null =>
    a === null || b == null ? null : a - b;

  return {
    candidateModel,
    baselineModel,
    samples,
    fieldMatch,
    upcAccuracy: fieldMatch.upc?.rate ?? null,
    hallucinationRate,
    emptyRate,
    parseSuccessRate,
    latencyP50Ms,
    latencyP95Ms,
    failureReasonCounts,
    vsBaseline: {
      hasBaseline,
      upcAccuracyDelta: delta(fieldMatch.upc?.rate ?? null, base?.fieldMatch.upc?.rate ?? null),
      hallucinationRateDelta: delta(hallucinationRate, base?.hallucinationRate ?? null),
      emptyRateDelta: delta(emptyRate, base?.emptyRate ?? null),
      parseSuccessRateDelta: delta(parseSuccessRate, base?.parseSuccessRate ?? null),
      latencyP50DeltaMs: delta(latencyP50Ms, base?.latencyP50Ms ?? null),
      latencyP95DeltaMs: delta(latencyP95Ms, base?.latencyP95Ms ?? null),
      baselineLatencyP50Ms: base?.latencyP50Ms ?? null,
      baselineLatencyP95Ms: base?.latencyP95Ms ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Rollout gate (pre-registered thresholds — see the runbook)
// ---------------------------------------------------------------------------

export interface OcrRolloutThresholds {
  /** Frozen golden set must contain at least this many images. */
  minSamples: number;
  /** Candidate UPC accuracy may not drop more than this below baseline. */
  upcAccuracyTolerance: number;
  /** Empty-rate may not exceed baseline by more than this. */
  emptyRateTolerance: number;
  /** Absolute floor on schema-valid JSON parse success. */
  minParseSuccessRate: number;
  /** Candidate p95 latency may not exceed baseline p95 × this ratio. */
  latencyP95RatioMax: number;
}

/**
 * Pre-registered thresholds (docs/runbooks/packaging-ocr-model-rollout.md).
 * These were recorded BEFORE any harness results existed; do not tune them
 * after seeing numbers — re-registering requires editing the runbook first.
 */
export const DEFAULT_ROLLOUT_THRESHOLDS: OcrRolloutThresholds = {
  minSamples: 30,
  upcAccuracyTolerance: 0.02,
  emptyRateTolerance: 0.01,
  minParseSuccessRate: 0.95,
  latencyP95RatioMax: 2,
};

export interface OcrRolloutGateResult {
  pass: boolean;
  failures: string[];
}

/**
 * Evaluate the pre-registered rollout gate against a candidate report.
 * Enforces minimum sample size; every unmet criterion produces one coded
 * failure string. Hallucination-rate criterion requires the candidate's
 * rate ≤ baseline's (delta ≤ 0); it is waived only when NEITHER side has a
 * computable rate (no labeled-null fields), which cannot happen on a real
 * golden set but keeps the gate total.
 */
export function evaluateRolloutGate(
  report: OcrComparisonReport,
  thresholds: OcrRolloutThresholds = DEFAULT_ROLLOUT_THRESHOLDS,
): OcrRolloutGateResult {
  const failures: string[] = [];

  if (report.samples < thresholds.minSamples) {
    failures.push(`min_sample_size: ${report.samples} < ${thresholds.minSamples}`);
  }
  const upcDelta = report.vsBaseline.upcAccuracyDelta;
  if (upcDelta === null) {
    failures.push('upc_accuracy: no comparable baseline UPC accuracy');
  } else if (upcDelta < -thresholds.upcAccuracyTolerance) {
    failures.push(`upc_accuracy_delta ${upcDelta.toFixed(4)} < -${thresholds.upcAccuracyTolerance}`);
  }
  const hallucDelta = report.vsBaseline.hallucinationRateDelta;
  if (report.hallucinationRate !== null && hallucDelta !== null && hallucDelta > 0) {
    failures.push(`hallucination_rate_delta ${hallucDelta.toFixed(4)} > 0`);
  } else if (report.hallucinationRate !== null && hallucDelta === null) {
    failures.push('hallucination_rate: no baseline rate to compare against');
  }
  const emptyDelta = report.vsBaseline.emptyRateDelta;
  if (emptyDelta === null) {
    failures.push('empty_rate: no comparable baseline empty rate');
  } else if (emptyDelta > thresholds.emptyRateTolerance) {
    failures.push(`empty_rate_delta ${emptyDelta.toFixed(4)} > ${thresholds.emptyRateTolerance}`);
  }
  if (report.parseSuccessRate < thresholds.minParseSuccessRate) {
    failures.push(`parse_success_rate ${report.parseSuccessRate.toFixed(4)} < ${thresholds.minParseSuccessRate}`);
  }
  const baseP95 = report.vsBaseline.baselineLatencyP95Ms;
  if (baseP95 == null || baseP95 <= 0) {
    failures.push('latency_p95: no baseline p95 latency');
  } else if (report.latencyP95Ms > thresholds.latencyP95RatioMax * baseP95) {
    failures.push(
      `latency_p95_ratio ${(report.latencyP95Ms / baseP95).toFixed(3)} > ${thresholds.latencyP95RatioMax}`,
    );
  }

  return { pass: failures.length === 0, failures };
}
