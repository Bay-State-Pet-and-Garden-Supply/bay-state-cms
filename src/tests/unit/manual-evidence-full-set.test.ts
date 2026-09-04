// Ticket #104 (parent #101) — full manual fact set, pure unit lane (vitest).
// Test-first: canonical field-values builder, family-inheritance comparison,
// title-consolidation manual eligibility, and prompt wiring. DB-free.
import { describe, test, expect } from 'vitest';
import {
  buildManualEvidenceFieldValues,
  isManualFieldValueInherited,
  normalizeManualEvidenceText,
  MANUAL_EVIDENCE_INHERITANCE_CONTAINMENT_MIN_LENGTH,
} from '../../onboarding/manual-evidence-eligibility';
// NOTE: consolidateProductTitle + the stage are exercised in the bun DB
// lane (manual-evidence-title-source-db.test.ts, own test:db segment for
// mock isolation) — those modules transitively import bun:sqlite, which
// vitest cannot collect. The prompt builder is dependency-free: tested here.
import { buildPerItemPrompt } from '../../onboarding/title-prompt-template';

describe('canonical manual field values (submit/gate round-trip)', () => {
  test('trims scalars, drops empties, keeps non-empty arrays', () => {
    expect(
      buildManualEvidenceFieldValues({
        title: '  Butcher Pup Chicken  ',
        brand: '  ',
        description: null,
        bulletPoints: ['  Grain free  ', '   ', 'High protein'],
        weight: null,
        dimensions: undefined,
        primaryImage: 'https://cdn.example.com/p.jpg',
        additionalImages: [],
      }),
    ).toEqual({
      title: 'Butcher Pup Chicken',
      bulletPoints: ['Grain free', 'High protein'],
      primaryImage: 'https://cdn.example.com/p.jpg',
    });
  });

  test('empty payload builds an empty map (round-trip stable)', () => {
    expect(buildManualEvidenceFieldValues({})).toEqual({});
    expect(
      buildManualEvidenceFieldValues({ title: 'T', weight: '0.75', additionalImages: ['https://cdn.example.com/a.jpg'] }),
    ).toEqual({ title: 'T', weight: '0.75', additionalImages: ['https://cdn.example.com/a.jpg'] });
  });
});

describe('family-inheritance comparison (no network, snapshot only)', () => {
  test('normalization trims, collapses whitespace, casefolds', () => {
    expect(normalizeManualEvidenceText('  Chicken   RECIPE\nTreats  ')).toBe('chicken recipe treats');
  });

  test('normalized equality fires regardless of length', () => {
    expect(isManualFieldValueInherited('Grain-Free Bites', 'our family page: GRAIN-FREE   bites for all dogs')).toBe(false);
    expect(isManualFieldValueInherited('Grain-Free Bites', 'grain-free bites')).toBe(true);
  });

  test('containment fires only for non-trivial values', () => {
    const snapshot = 'The Butcher\u2019s Pup family treats page: chicken recipe grain-free bites for small dogs, oven baked daily';
    expect(isManualFieldValueInherited('Chicken Recipe Grain-Free Bites For Small Dogs', snapshot)).toBe(true);
    expect(isManualFieldValueInherited('Treats', snapshot)).toBe(false);
    expect(`min length is documented: ${MANUAL_EVIDENCE_INHERITANCE_CONTAINMENT_MIN_LENGTH}`).toContain('24');
  });

  test('null snapshot, empty value, and unrelated text never fire', () => {
    expect(isManualFieldValueInherited('Chicken Recipe', null)).toBe(false);
    expect(isManualFieldValueInherited('   ', 'chicken recipe')).toBe(false);
    expect(isManualFieldValueInherited('Salmon Dinner', 'chicken recipe treats page')).toBe(false);
  });
});

describe('title prompt carries the manual signal', () => {
  test('manual title renders as an operator-verified line; absent stays absent', () => {
    const withManual = buildPerItemPrompt({ name: 'BUTCHER PUP TREATS', manualTitle: 'Butcher\u2019s Pup Chicken Recipe' });
    expect(withManual).toMatch(/Operator-Verified Manual Title: "Butcher\u2019s Pup Chicken Recipe"/);
    const withoutManual = buildPerItemPrompt({ name: 'BUTCHER PUP TREATS' });
    expect(withoutManual).not.toMatch(/Operator-Verified Manual Title/);
  });
});
