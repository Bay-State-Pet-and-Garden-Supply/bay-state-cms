import { describe, it, expect } from 'vitest';
import {
  computeDepthStratifiedCalibration,
  type DepthStratifiedPredictionPair,
} from '../../classification/confidence-calibrator';

describe('Depth-Aware Calibration (P2.2)', () => {
  it('stratifies dev predictions by depth and computes accuracy, ancestor accuracy, and ECE', () => {
    const pairs: DepthStratifiedPredictionPair[] = [];

    // Depth 1: 12 examples (>= minSupport 10)
    for (let i = 0; i < 12; i++) {
      pairs.push({
        proposalType: 'primary_product_type',
        depth: 1,
        confidence: 0.8 + (i % 3) * 0.05,
        correct: i < 10, // 10/12 correct
        predictedId: i < 10 ? 'pets' : 'garden',
        goldId: 'pets',
        goldAncestorIds: ['root'],
        predictedAncestorIds: ['root'],
      });
    }

    // Depth 2: 15 examples (>= minSupport 10)
    for (let i = 0; i < 15; i++) {
      const isCorrect = i < 12;
      pairs.push({
        proposalType: 'primary_product_type',
        depth: 2,
        confidence: 0.7 + (i % 4) * 0.05,
        correct: isCorrect,
        predictedId: isCorrect ? 'dog' : 'cat',
        goldId: 'dog',
        goldAncestorIds: ['root', 'pets'],
        predictedAncestorIds: ['root', 'pets'],
      });
    }

    // Depth 3: 4 examples (< minSupport 10)
    for (let i = 0; i < 4; i++) {
      pairs.push({
        proposalType: 'primary_product_type',
        depth: 3,
        confidence: 0.6,
        correct: i === 0,
        predictedId: i === 0 ? 'dog_food' : 'dog_toy',
        goldId: 'dog_food',
        goldAncestorIds: ['root', 'pets', 'dog'],
        predictedAncestorIds: ['root', 'pets', 'dog'],
      });
    }

    const result = computeDepthStratifiedCalibration(pairs, { minSupport: 10 });

    expect(result.artifactDigest).toBeDefined();
    expect(result.artifactDigest).toMatch(/^[0-9a-f]{64}$/);

    // Check Depth 1
    const d1 = result.byDepth[1];
    expect(d1).toBeDefined();
    expect(d1.sampleCount).toBe(12);
    expect(d1.isSufficientSupport).toBe(true);
    expect(d1.exactAccuracy).toBeCloseTo(10 / 12, 2);
    expect(d1.ancestorAccuracy).toBe(1);
    expect(d1.treeDistanceError).toBeCloseTo(0.333, 2);
    expect(d1.ece).toBeDefined();

    // Check Depth 2
    const d2 = result.byDepth[2];
    expect(d2).toBeDefined();
    expect(d2.sampleCount).toBe(15);
    expect(d2.isSufficientSupport).toBe(true);
    expect(d2.exactAccuracy).toBeCloseTo(12 / 15, 2);
    expect(d2.ancestorAccuracy).toBe(1);

    // Check Depth 3 (insufficient support)
    const d3 = result.byDepth[3];
    expect(d3).toBeDefined();
    expect(d3.sampleCount).toBe(4);
    expect(d3.isSufficientSupport).toBe(false);
    // Falls back to global threshold
    expect(d3.calibratedThreshold).toEqual(result.globalThreshold);
  });

  it('produces reproducible digests across identical runs', () => {
    const pairs: DepthStratifiedPredictionPair[] = [
      {
        proposalType: 'primary_product_type',
        depth: 1,
        confidence: 0.9,
        correct: true,
        goldAncestorIds: ['root'],
        predictedAncestorIds: ['root'],
      },
    ];

    const res1 = computeDepthStratifiedCalibration(pairs);
    const res2 = computeDepthStratifiedCalibration(pairs);

    expect(res1.artifactDigest).toBe(res2.artifactDigest);
  });
});
