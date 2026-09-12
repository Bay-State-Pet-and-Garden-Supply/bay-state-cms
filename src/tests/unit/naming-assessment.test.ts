/**
 * Issue #106 SEQUENCE 1a — pure naming assessment (TDD).
 *
 * One pure assessment used by Review and both Promotion checks, assessing
 * the ACTUAL FINAL draft title. DB-free by design (vitest-safe).
 */
import { describe, it, expect } from 'vitest';
import {
  countBrandOccurrences,
  isProductCapacity,
  assessNamingInvariants,
  type NamingAssessmentInput,
} from '../../onboarding/naming-assessment';

function base(overrides: Partial<NamingAssessmentInput> = {}): NamingAssessmentInput {
  return {
    title: 'Acme Adult Dog Food 5 LB',
    brand: 'Acme',
    brandEvidence: 'present',
    measurementTokens: [{ axis: 'weight', value: '5 LB' }],
    measurementApplicable: true,
    ownColor: null,
    familyColors: [],
    siblingTitles: [],
    ...overrides,
  };
}

describe('countBrandOccurrences', () => {
  it('counts zero, one, and multiple occurrences with bounded matching', () => {
    expect(countBrandOccurrences('Adult Dog Food 5 LB', 'Acme')).toBe(0);
    expect(countBrandOccurrences('Acme Adult Dog Food', 'Acme')).toBe(1);
    // The titleContainsBrand first-match trap: pre-existing duplication stays visible.
    expect(countBrandOccurrences('Acme Acme Bucket', 'Acme')).toBe(2);
    expect(countBrandOccurrences('Acme Bucket Acme', 'Acme')).toBe(2);
  });

  it('never matches substrings of larger words and tolerates separators', () => {
    expect(countBrandOccurrences('Acmes Best Food', 'Acme')).toBe(0);
    expect(countBrandOccurrences('Acme-Best Food', 'Acme')).toBe(1);
    expect(countBrandOccurrences('Fromm Family Foods', 'Fromm Family')).toBe(1);
    expect(countBrandOccurrences('', 'Acme')).toBe(0);
    expect(countBrandOccurrences('Acme Food', '')).toBe(0);
  });
});

describe('isProductCapacity', () => {
  it('accepts amount + recognized volume unit', () => {
    expect(isProductCapacity('5 gal')).toBe(true);
    expect(isProductCapacity('16 fl oz')).toBe(true);
    expect(isProductCapacity('500 ml')).toBe(true);
    expect(isProductCapacity('2.5 L')).toBe(true);
    expect(isProductCapacity('1 QT')).toBe(true);
  });

  it('rejects bare numbers, shipping weight, dimensions, and UOM-alone', () => {
    expect(isProductCapacity('5')).toBe(false);
    expect(isProductCapacity('gal')).toBe(false);
    expect(isProductCapacity('5 LB')).toBe(false);
    expect(isProductCapacity('10 x 12 x 8')).toBe(false);
    expect(isProductCapacity('5 CT')).toBe(false);
    expect(isProductCapacity('')).toBe(false);
  });
});

describe('assessNamingInvariants brand', () => {
  it('passes exactly-once containment', () => {
    expect(assessNamingInvariants(base()).ok).toBe(true);
  });

  it('distinguishes evidence_absent from title_absent', () => {
    const absent = assessNamingInvariants(base({ brand: null, brandEvidence: 'absent' }));
    expect(absent.ok).toBe(false);
    expect(absent.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_brand', detail: expect.stringContaining('evidence_absent') }),
    );
    const dropped = assessNamingInvariants(base({ title: 'Adult Dog Food 5 LB' }));
    expect(dropped.ok).toBe(false);
    expect(dropped.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_brand', detail: expect.stringContaining('title_absent') }),
    );
  });

  it('flags duplicate_brand for multiples', () => {
    const dup = assessNamingInvariants(base({ title: 'Acme Acme Bucket 5 LB' }));
    expect(dup.ok).toBe(false);
    expect(dup.findings).toContainEqual(expect.objectContaining({ code: 'duplicate_brand' }));
  });
});

describe('assessNamingInvariants measurement', () => {
  it('accepts capacity-only evidence', () => {
    expect(
      assessNamingInvariants(base({
        title: 'Acme Pond Clarifier 5 gal',
        measurementTokens: [{ axis: 'capacity', value: '5 gal' }],
      })).ok,
    ).toBe(true);
  });

  it('pack count cannot excuse a dropped capacity token', () => {
    const r = assessNamingInvariants(base({
      title: 'Acme Pond Clarifier 2 Pack',
      measurementTokens: [
        { axis: 'capacity', value: '5 gal' },
        { axis: 'count', value: '2 Pack' },
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_size', axis: 'capacity', value: '5 gal' }),
    );
  });

  it('same number with the wrong unit does not satisfy', () => {
    const r = assessNamingInvariants(base({
      title: 'Acme Food 5 CT',
      measurementTokens: [{ axis: 'weight', value: '5 LB' }],
    }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_size', axis: 'weight' }),
    );
  });

  it('absent measurement evidence holds with a coded reason', () => {
    const r = assessNamingInvariants(base({ measurementTokens: [] }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ code: 'missing_size' }));
  });

  it('measurement not applicable skips the check', () => {
    expect(
      assessNamingInvariants(base({ measurementTokens: [], measurementApplicable: false })).ok,
    ).toBe(true);
  });

  it('conflicted evidence holds instead of fabricating', () => {
    const r = assessNamingInvariants(base({
      title: 'Acme Food',
      measurementTokens: [{ axis: 'weight', value: '5 LB', conflicted: true }],
    }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(
      expect.objectContaining({ code: 'missing_size', conflict: true }),
    );
  });
});

describe('assessNamingInvariants color', () => {
  it('known multicolor family requires the known own color', () => {
    const r = assessNamingInvariants(base({
      title: 'Acme Collar Red',
      measurementTokens: [],
      measurementApplicable: false,
      ownColor: 'Red',
      familyColors: ['Red', 'Blue'],
    }));
    expect(r.ok).toBe(true);
    const missing = assessNamingInvariants(base({
      title: 'Acme Collar',
      measurementTokens: [],
      measurementApplicable: false,
      ownColor: 'Red',
      familyColors: ['Red', 'Blue'],
    }));
    expect(missing.ok).toBe(false);
    expect(missing.findings).toContainEqual(expect.objectContaining({ code: 'missing_color' }));
  });

  it('multicolor family with unknown own color holds', () => {
    const r = assessNamingInvariants(base({
      title: 'Acme Collar',
      measurementTokens: [],
      measurementApplicable: false,
      ownColor: null,
      familyColors: ['Red', 'Blue'],
    }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ code: 'missing_color' }));
  });

  it('single-color or no color evidence is never a blocker', () => {
    expect(
      assessNamingInvariants(base({
        title: 'Acme Collar', measurementTokens: [], measurementApplicable: false,
        ownColor: 'Red', familyColors: ['Red'],
      })).ok,
    ).toBe(true);
    expect(base() && assessNamingInvariants(base()).ok).toBe(true);
  });
});

describe('assessNamingInvariants siblings', () => {
  it('rejects titles duplicating a frozen sibling instead of regrouping', () => {
    const r = assessNamingInvariants(base({
      siblingTitles: ['Acme Adult Dog Food 5 LB', 'Acme Puppy Food 5 LB'],
    }));
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.objectContaining({ code: 'duplicate_sibling' }));
  });

  it('distinct sibling titles pass', () => {
    expect(
      assessNamingInvariants(base({ siblingTitles: ['Acme Puppy Food 5 LB'] })).ok,
    ).toBe(true);
  });
});
