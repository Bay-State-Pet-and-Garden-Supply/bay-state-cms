import { describe, it, expect } from 'vitest';
import { ensureBrandInTitle, titleContainsBrand } from '../../onboarding/title-prompt-template';

describe('titleContainsBrand (issue #108)', () => {
  it('matches case-insensitively with flexible separators', () => {
    expect(titleContainsBrand('ACME Premium Dog Food', 'Acme')).toBe(true);
    expect(titleContainsBrand('Blue Buffalo Dog Food', 'Blue Buffalo')).toBe(true);
    expect(titleContainsBrand('Blue-Buffalo Dog Food', 'Blue Buffalo')).toBe(true);
    expect(titleContainsBrand('Premium Dog Food', 'Acme')).toBe(false);
  });

  it('does not match substrings of larger words', () => {
    expect(titleContainsBrand('Acmes Dog Food', 'Acme')).toBe(false);
  });

  it('returns false for blank brand or title', () => {
    expect(titleContainsBrand('Some Title', '')).toBe(false);
    expect(titleContainsBrand('Some Title', '   ')).toBe(false);
    expect(titleContainsBrand('', 'Acme')).toBe(false);
  });
});

describe('ensureBrandInTitle (issue #108)', () => {
  it('prefixes the brand when absent (manufacturer-copy fixture)', () => {
    expect(ensureBrandInTitle('Premium Dog Food 5 lb', 'Acme')).toBe('Acme Premium Dog Food 5 lb');
  });

  it('prefixes the brand for Bradley-style brandless H1s', () => {
    expect(ensureBrandInTitle('E-Z Hang Scale Silver Up to 55 LB', 'Salter')).toBe(
      'Salter E-Z Hang Scale Silver Up to 55 LB',
    );
  });

  it('restores canonical casing when the brand is already the prefix', () => {
    expect(ensureBrandInTitle('ACME Premium Dog Food', 'Acme')).toBe('Acme Premium Dog Food');
  });

  it('never doubles the brand when it appears mid-title', () => {
    expect(ensureBrandInTitle('Premium Dog Food Acme 5 lb', 'Acme')).toBe('Premium Dog Food Acme 5 lb');
  });

  it('handles multiword brands without doubling', () => {
    expect(ensureBrandInTitle('Dog Food', 'Blue Buffalo')).toBe('Blue Buffalo Dog Food');
    expect(ensureBrandInTitle('BLUE BUFFALO Dog Food', 'Blue Buffalo')).toBe('Blue Buffalo Dog Food');
    expect(ensureBrandInTitle('Natural Dog Food Blue Buffalo', 'Blue Buffalo')).toBe(
      'Natural Dog Food Blue Buffalo',
    );
  });

  it('treats a brand-substring word as absent', () => {
    expect(ensureBrandInTitle('Acmes Dog Food', 'Acme')).toBe('Acme Acmes Dog Food');
  });

  it('leaves the title untouched for blank brands', () => {
    expect(ensureBrandInTitle('Premium Dog Food', '')).toBe('Premium Dog Food');
    expect(ensureBrandInTitle('Premium Dog Food', '   ')).toBe('Premium Dog Food');
  });
});
