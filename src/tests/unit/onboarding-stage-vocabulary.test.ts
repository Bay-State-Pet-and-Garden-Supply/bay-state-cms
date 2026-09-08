/**
 * Slice 1 — vocabulary authority tests (Vitest, pure).
 */
import { describe, it, expect } from 'vitest';
import {
  STAGE_ORDER_V1,
  STAGE_ORDER_V2,
  V1_TO_V2,
  V2_TO_V1,
  STAGE_V2_LABELS,
  STEP_ZERO_VIEW_ID,
  StageVocabularyError,
  assertStageBijection,
  toCanonicalStage,
  toStoredStage,
  parseV2StageInput,
  isStageV1String,
  isStageV2String,
  isStepZeroView,
  stageV2Index,
} from '../../shared/onboarding-stage-vocabulary';

describe('stage vocabulary bijection', () => {
  it('asserts a six-entry order-sensitive bijection without throwing', () => {
    expect(() => assertStageBijection()).not.toThrow();
    expect(STAGE_ORDER_V1).toHaveLength(6);
    expect(STAGE_ORDER_V2).toHaveLength(6);
  });

  it('maps every v1 value to exactly one v2 value and back', () => {
    for (const v1 of STAGE_ORDER_V1) {
      const v2 = V1_TO_V2[v1];
      expect(STAGE_ORDER_V2).toContain(v2);
      expect(V2_TO_V1[v2]).toBe(v1);
    }
  });

  it('never orders alphabetically (order is explicit execution order)', () => {
    expect([...STAGE_ORDER_V2].sort()).not.toEqual([...STAGE_ORDER_V2]);
  });

  it('labels every v2 stage exactly once', () => {
    expect(Object.keys(STAGE_V2_LABELS).sort()).toEqual([...STAGE_ORDER_V2].sort());
    expect(STAGE_V2_LABELS['route_sources']).toBe('Check source options');
    expect(STAGE_V2_LABELS['review_listings']).toBe('Review listings');
  });

  it('indexes stages by explicit position', () => {
    expect(stageV2Index('route_sources')).toBe(0);
    expect(stageV2Index('create_drafts')).toBe(5);
  });
});

describe('step zero rejection', () => {
  it('identifies the brand-setup view but rejects it as a stage everywhere', () => {
    expect(isStepZeroView(STEP_ZERO_VIEW_ID)).toBe(true);
    expect(isStageV1String(STEP_ZERO_VIEW_ID)).toBe(false);
    expect(isStageV2String(STEP_ZERO_VIEW_ID)).toBe(false);
    expect(STAGE_ORDER_V2).not.toContain(STEP_ZERO_VIEW_ID as never);
    for (const fn of [toCanonicalStage, toStoredStage, parseV2StageInput]) {
      try {
        fn(STEP_ZERO_VIEW_ID);
        expect.unreachable('Step 0 must be rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(StageVocabularyError);
        expect((err as StageVocabularyError).code).toBe('step_zero_not_a_stage');
      }
    }
  });
});

describe('version strictness', () => {
  it('accepts canonical v2 in v2 input and stored v1 in storage mapping', () => {
    expect(parseV2StageInput('find_product_page')).toBe('find_product_page');
    expect(toStoredStage('find_product_page')).toBe('discovery');
    expect(toCanonicalStage('sourcing')).toBe('route_sources');
  });

  it('rejects v1 values in v2 input with invalid_version (never silent)', () => {
    for (const v1 of STAGE_ORDER_V1) {
      try {
        parseV2StageInput(v1);
        expect.unreachable(`v1 value ${v1} must be rejected in v2 input`);
      } catch (err) {
        expect((err as StageVocabularyError).code).toBe('invalid_version');
      }
    }
  });

  it('rejects unknown/mixed values without coercing to the first stage', () => {
    for (const bad of ['SOURCING', ' sourcing', '', 'review_listings ', 'sourcing/discovery', 'publish', 42, null, undefined, {}]) {
      expect(() => toCanonicalStage(bad)).toThrow(StageVocabularyError);
      expect(() => toStoredStage(bad)).toThrow(StageVocabularyError);
      expect(() => parseV2StageInput(bad)).toThrow(StageVocabularyError);
    }
  });
});
