/**
 * Slice 2 — preparation summary schema tests (Vitest).
 *
 * Five fixed sections in order; no extra section/stage keys; bounded reason
 * labels; StageStatus/STAGE_ORDER untouched (length six).
 */
import { describe, it, expect } from 'vitest';
import {
  PreparationSummarySchema,
  PREPARATION_SECTION_KEYS,
  PREPARATION_SECTION_TITLES,
} from '../../shared/schemas/onboarding-preparation';
// NOTE: StageStatusEnum lives in shared/schemas/onboarding.ts, whose
// transitive named-zod chain vite-node cannot collect on this tree (same
// pre-existing breakage as the review suites). Its untouched-shape assertion
// lives in the Bun suite onboarding-preparation-read.test.ts instead.
import { STAGE_ORDER_V2 } from '../../shared/onboarding-stage-vocabulary';
import {
  buildUnavailablePreparationSummary,
  isPreparationSummaryEmpty,
  PREPARE_LISTING_SECTIONS,
} from '../../client/components/onboarding/prepare-listing-logic';

function validSummary() {
  return {
    schemaVersion: 1,
    sections: PREPARATION_SECTION_KEYS.map((key) => ({
      key,
      title: PREPARATION_SECTION_TITLES[key],
      state: 'unavailable' as const,
      reason: 'Not yet reported.',
    })),
  };
}

describe('preparation summary schema', () => {
  it('accepts exactly the five fixed sections in order', () => {
    const parsed = PreparationSummarySchema.safeParse(validSummary());
    expect(parsed.success).toBe(true);
  });

  it('rejects extra sections, reordered keys, and wrong schema versions', () => {
    const base = validSummary();
    expect(
      PreparationSummarySchema.safeParse({ ...base, sections: [...base.sections, base.sections[0]] }).success,
    ).toBe(false);
    const reordered = { ...base, sections: [...base.sections].reverse() };
    expect(PreparationSummarySchema.safeParse(reordered).success).toBe(false);
    expect(PreparationSummarySchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects unknown section states and overlong reasons', () => {
    const base = validSummary();
    const bad = {
      ...base,
      sections: base.sections.map((s, i) =>
        i === 0 ? { ...s, state: 'done_5_of_5' } : s,
      ),
    };
    expect(PreparationSummarySchema.safeParse(bad).success).toBe(false);
    const long = {
      ...base,
      sections: base.sections.map((s, i) => (i === 1 ? { ...s, reason: 'x'.repeat(161) } : s)),
    };
    expect(PreparationSummarySchema.safeParse(long).success).toBe(false);
  });

  it('leaves the six-stage order untouched (sections are not stages)', () => {
    expect(STAGE_ORDER_V2).toHaveLength(6);
    expect(PREPARATION_SECTION_KEYS).toHaveLength(5);
  });

  it('builds an honestly-empty unavailable summary (no completion invented)', () => {
    const summary = buildUnavailablePreparationSummary();
    expect(PreparationSummarySchema.safeParse(summary).success).toBe(true);
    expect(isPreparationSummaryEmpty(summary)).toBe(true);
    expect(PREPARE_LISTING_SECTIONS.map((s) => s.key)).toEqual([...PREPARATION_SECTION_KEYS]);
    // No percentage treating skipped/abstained as success exists anywhere here.
    expect(JSON.stringify(summary)).not.toMatch(/5\/5|percent|% complete/i);
  });
});
