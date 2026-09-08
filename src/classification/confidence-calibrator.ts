/**
 * Confidence Calibrator & Review Tiers
 *
 * EVALUATION-ONLY (issue #17 F): Calibration is fitted ONLY from
 * example-level development-split predictions and can alter abstention or
 * review-priority tiers — it NEVER grants acceptance, reorders the queue, or
 * changes proposal/field output. Acceptance remains an explicit human
 * decision; the tiers below only route items into 'abstain' / 'review' /
 * 'auto' buckets where 'auto' still requires the normal review workflow to
 * confirm before any acceptance. Production quality telemetry MAY report
 * hypothetical tier distributions but must never call getReviewTier() /
 * shouldAbstain() to alter statuses or acceptance. Production `enabled` for
 * the confidenceCalibration feature remains gated behind the frozen Gold
 * qualification receipt + activation audit (feature-policy).
 */

import { createHash } from 'node:crypto';
import type { BenchmarkPredictionEntry } from '../shared/schemas/classification';

export interface CalibratedThresholds {
  productType: { abstainBelow: number; reviewAbove: number };
  categoryPage: { abstainBelow: number; reviewAbove: number };
  fieldAssignment: { abstainBelow: number; reviewAbove: number };
}

export const DEFAULT_THRESHOLDS: CalibratedThresholds = {
  productType: { abstainBelow: 0.35, reviewAbove: 0.85 },
  categoryPage: { abstainBelow: 0.30, reviewAbove: 0.80 },
  fieldAssignment: { abstainBelow: 0.25, reviewAbove: 0.75 },
};

export type ReviewTier = 'abstain' | 'review' | 'auto';

/** One development example-level prediction with its gold outcome. */
export interface DevPredictionPair {
  proposalType: 'primary_product_type' | 'category_page' | 'field_assignment';
  confidence: number;
  correct: boolean;
}

export interface CalibrateOptions {
  /** Target abstention rate on the development split. */
  targetAbstentionRate?: number;
  /** Confidence quantile for the 'auto' review tier (high-confidence band). */
  autoTierQuantile?: number;
}

function tierThresholds(pairs: DevPredictionPair[], options: CalibrateOptions): { abstainBelow: number; reviewAbove: number } {
  const targetAbstention = options.targetAbstentionRate ?? 0.15;
  const autoQuantile = options.autoTierQuantile ?? 0.9;

  if (pairs.length === 0) {
    return { abstainBelow: 0.3, reviewAbove: 0.8 };
  }

  const confidences = pairs.map(p => p.confidence).sort((a, b) => a - b);

  // Abstain floor: the confidence below which the abstention rate would exceed
  // the target (fit to the development split only).
  const abstainIdx = Math.min(confidences.length - 1, Math.floor(confidences.length * targetAbstention));
  const abstainBelow = confidences[abstainIdx];

  // Review 'auto' tier: the upper quantile of observed confidence. This is a
  // review-priority hint, never an acceptance decision.
  const autoIdx = Math.min(confidences.length - 1, Math.floor(confidences.length * autoQuantile));
  const reviewAbove = Math.max(confidences[autoIdx], abstainBelow + 0.05);

  return {
    abstainBelow: round(abstainBelow),
    reviewAbove: round(reviewAbove),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Fit calibration thresholds from development-split example-level predictions
 * only. Returns per-type thresholds that control abstention and review-priority
 * routing.
 */
export function calibrateThresholds(
  devPairs: DevPredictionPair[],
  options: CalibrateOptions = {},
): CalibratedThresholds {
  const byType = {
    'primary_product_type': devPairs.filter(p => p.proposalType === 'primary_product_type'),
    'category_page': devPairs.filter(p => p.proposalType === 'category_page'),
    'field_assignment': devPairs.filter(p => p.proposalType === 'field_assignment'),
  };

  return {
    productType: tierThresholds(byType['primary_product_type'], options),
    categoryPage: tierThresholds(byType['category_page'], options),
    fieldAssignment: tierThresholds(byType['field_assignment'], options),
  };
}

/** Build dev pairs from a prediction bundle + gold outcomes (pure). */
export function devPairsFromBundle(
  predictions: BenchmarkPredictionEntry[],
  goldByExample: ReadonlyMap<string, { productType: string | null }>,
): DevPredictionPair[] {
  const pairs: DevPredictionPair[] = [];
  for (const prediction of predictions) {
    const gold = goldByExample.get(prediction.exampleId);
    if (!gold?.productType) continue;
    if (prediction.abstained || prediction.productType === null || prediction.confidence === null || prediction.confidence === undefined) {
      continue;
    }
    pairs.push({
      proposalType: 'primary_product_type',
      confidence: prediction.confidence,
      correct: prediction.productType === gold.productType,
    });
  }
  return pairs;
}

export function shouldAbstain(
  confidence: number,
  proposalType: string,
  thresholds: CalibratedThresholds = DEFAULT_THRESHOLDS,
): boolean {
  const t = thresholdsFor(proposalType, thresholds);
  return confidence < t.abstainBelow;
}

/**
 * Review-tier routing. 'auto' is a review-priority hint: the item is routed to
 * the fast-review bucket, but a human/standard review workflow still confirms
 * before anything is accepted. Calibration never bypasses review.
 */
export function getReviewTier(
  confidence: number,
  proposalType: string,
  thresholds: CalibratedThresholds = DEFAULT_THRESHOLDS,
): ReviewTier {
  const t = thresholdsFor(proposalType, thresholds);
  if (confidence < t.abstainBelow) return 'abstain';
  if (confidence >= t.reviewAbove) return 'auto';
  return 'review';
}

function thresholdsFor(proposalType: string, thresholds: CalibratedThresholds): { abstainBelow: number; reviewAbove: number } {
  if (proposalType === 'primary_product_type') return thresholds.productType;
  if (proposalType === 'category_page') return thresholds.categoryPage;
  if (proposalType === 'field_assignment') return thresholds.fieldAssignment;
  return thresholds.fieldAssignment;
}

export interface DepthStratifiedPredictionPair {
  proposalType: 'primary_product_type' | 'category_page' | 'field_assignment';
  depth: number;
  confidence: number;
  correct: boolean;
  predictedId?: string;
  goldId?: string;
  goldAncestorIds?: string[];
  predictedAncestorIds?: string[];
}

export interface DepthStratifiedCalibrationOptions {
  minSupport?: number;
  targetAbstentionRate?: number;
  autoTierQuantile?: number;
}

export interface DepthCalibrationStats {
  sampleCount: number;
  isSufficientSupport: boolean;
  exactAccuracy: number;
  ancestorAccuracy: number;
  treeDistanceError: number;
  ece: number;
  calibratedThreshold: { abstainBelow: number; reviewAbove: number };
}

export interface DepthStratifiedCalibrationResult {
  artifactDigest: string;
  globalThreshold: { abstainBelow: number; reviewAbove: number };
  byDepth: Record<number, DepthCalibrationStats>;
}

export function computeDepthStratifiedCalibration(
  pairs: DepthStratifiedPredictionPair[],
  options: DepthStratifiedCalibrationOptions = {},
): DepthStratifiedCalibrationResult {
  const minSupport = options.minSupport ?? 10;
  const globalThreshold = tierThresholds(pairs, options);

  const digest = createHash('sha256')
    .update(JSON.stringify(pairs.map(p => ({
      proposalType: p.proposalType,
      depth: p.depth,
      confidence: p.confidence,
      correct: p.correct,
      goldAncestorIds: p.goldAncestorIds,
      predictedAncestorIds: p.predictedAncestorIds,
      goldId: p.goldId,
      predictedId: p.predictedId,
    }))))
    .digest('hex');

  const byDepthMap = new Map<number, DepthStratifiedPredictionPair[]>();
  for (const pair of pairs) {
    const list = byDepthMap.get(pair.depth) ?? [];
    list.push(pair);
    byDepthMap.set(pair.depth, list);
  }

  const byDepth: Record<number, DepthCalibrationStats> = {};
  for (const [depth, bucket] of byDepthMap.entries()) {
    const sampleCount = bucket.length;
    const isSufficientSupport = sampleCount >= minSupport;
    const exactAccuracy = bucket.filter(p => p.correct).length / sampleCount;

    let ancestorMatches = 0;
    let totalTreeDistance = 0;

    for (const p of bucket) {
      const goldAncestors = p.goldAncestorIds ?? [];
      const predAncestors = p.predictedAncestorIds ?? [];
      const isAncestorMatch = p.correct || (goldAncestors.length > 0 && goldAncestors.join('/') === predAncestors.join('/'));
      if (isAncestorMatch) {
        ancestorMatches++;
      }

      if (p.correct) {
        // distance 0
      } else {
        const goldPath = [...goldAncestors, ...(p.goldId ? [p.goldId] : [])];
        const predPath = [...predAncestors, ...(p.predictedId ? [p.predictedId] : [])];
        let lcaIndex = 0;
        while (lcaIndex < goldPath.length && lcaIndex < predPath.length && goldPath[lcaIndex] === predPath[lcaIndex]) {
          lcaIndex++;
        }
        const distGold = goldPath.length - lcaIndex;
        const distPred = predPath.length - lcaIndex;
        totalTreeDistance += distGold + distPred;
      }
    }

    const ancestorAccuracy = sampleCount > 0 ? ancestorMatches / sampleCount : 1;
    const treeDistanceError = sampleCount > 0 ? totalTreeDistance / sampleCount : 0;

    // ECE across 10 bins
    const numBins = 10;
    let totalEce = 0;
    for (let b = 0; b < numBins; b++) {
      const binMin = b / numBins;
      const binMax = (b + 1) / numBins;
      const inBin = bucket.filter(p => p.confidence >= binMin && (b === numBins - 1 ? p.confidence <= binMax : p.confidence < binMax));
      if (inBin.length > 0) {
        const binAcc = inBin.filter(p => p.correct).length / inBin.length;
        const binConf = inBin.reduce((acc, p) => acc + p.confidence, 0) / inBin.length;
        totalEce += (inBin.length / sampleCount) * Math.abs(binAcc - binConf);
      }
    }

    const calibratedThreshold = isSufficientSupport
      ? tierThresholds(bucket, options)
      : globalThreshold;

    byDepth[depth] = {
      sampleCount,
      isSufficientSupport,
      exactAccuracy,
      ancestorAccuracy,
      treeDistanceError,
      ece: totalEce,
      calibratedThreshold,
    };
  }

  return {
    artifactDigest: digest,
    globalThreshold,
    byDepth,
  };
}

