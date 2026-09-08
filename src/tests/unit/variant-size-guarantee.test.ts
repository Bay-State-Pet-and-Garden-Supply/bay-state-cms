import { describe, it, expect } from 'vitest';
import {
  extractProtectedTokens,
  normalizeProtectedToken,
  knownVariantTokens,
  variantTokenPresentInTitle,
  ensureVariantTokensInTitle,
} from '../../onboarding/title-prompt-template';

describe('extractProtectedTokens capacity axis (issue #111)', () => {
  it('extracts fluid ounces', () => {
    expect(extractProtectedTokens('CLEANER 16FLOZ')).toContain('16FLOZ');
    expect(extractProtectedTokens('CLEANER 16 FL OZ')).toContain('16 FL OZ');
  });

  it('extracts volume units', () => {
    expect(extractProtectedTokens('BUCKET 5 GAL')).toContain('5 GAL');
    expect(extractProtectedTokens('JUG 2.5 LTR')).toContain('2.5 LTR');
    expect(extractProtectedTokens('BOTTLE 500ML')).toContain('500ML');
  });

  it('keeps existing weight/count/abbreviation behavior', () => {
    expect(extractProtectedTokens('INSTINCT CAT PATE 2.64OZ')).toContain('2.64OZ');
    expect(extractProtectedTokens('WOOF PUPSICLE 3PK')).toContain('3PK');
    expect(extractProtectedTokens('WOOF PUPSICLE SM')).toContain('SM');
  });

  it('extracts hyphenated counts', () => {
    expect(extractProtectedTokens('WOOF PUPSICLE LAVENDER 20-PIECE VALUE PACK')).toContain('20-PIECE');
    expect(extractProtectedTokens('WIDGET 5-Count')).toContain('5-Count');
    expect(extractProtectedTokens('WIDGET 6-Pack')).toContain('6-Pack');
  });

  it('extracts lowercase size abbreviations from distributor-style sources', () => {
    expect(extractProtectedTokens('woof pupsicle sm')).toContain('sm');
    expect(extractProtectedTokens('widget lg')).toContain('lg');
  });
});

describe('normalizeProtectedToken capacity (issue #111)', () => {
  it('normalizes fluid ounces to fl oz', () => {
    expect(normalizeProtectedToken('16FLOZ')).toBe('16 fl oz');
    expect(normalizeProtectedToken('16 FL OZ')).toBe('16 fl oz');
  });

  it('keeps existing normalizations', () => {
    expect(normalizeProtectedToken('2.64OZ')).toBe('2.64 oz');
    expect(normalizeProtectedToken('3PK')).toBe('3-Pack');
    expect(normalizeProtectedToken('SM')).toBe('Small');
  });

  it('normalizes counts to N-Count per FORMAT_RULES', () => {
    expect(normalizeProtectedToken('5CT')).toBe('5-Count');
    expect(normalizeProtectedToken('5-Count')).toBe('5-Count');
    expect(normalizeProtectedToken('20-PIECE')).toBe('20-Piece');
  });
});

describe('knownVariantTokens merged set (issue #111)', () => {
  it('merges tokens from every origin, deduped and normalized', () => {
    expect(
      knownVariantTokens(['DOG FOOD 5LB', 'Premium Dog Food 5 lb', '5 lb', null, undefined, '  ']),
    ).toEqual(['5 lb']);
  });

  it('keeps capacity as its own axis alongside size', () => {
    expect(knownVariantTokens(['BUCKET 5 GAL', '16FLOZ'])).toEqual(['5 gal', '16 fl oz']);
  });

  it('returns empty when nothing is evidenced', () => {
    expect(knownVariantTokens(['Mystery Product', null, undefined])).toEqual([]);
  });
});

describe('variantTokenPresentInTitle (issue #111)', () => {
  it('matches numeric tokens loosely on the number', () => {
    expect(variantTokenPresentInTitle('Premium Dog Food 5 lb', '5 lb')).toBe(true);
    expect(variantTokenPresentInTitle('Premium Dog Food 5lb', '5 lb')).toBe(true);
  });

  it('matches non-numeric tokens case-insensitively', () => {
    expect(variantTokenPresentInTitle('Woof Pupsicle small', 'Small')).toBe(true);
    expect(variantTokenPresentInTitle('Woof Pupsicle Large', 'Small')).toBe(false);
  });
});

describe('variantTokenPresentInTitle strict units (issue #111 review)', () => {
  it('a bare number never satisfies a different axis', () => {
    expect(variantTokenPresentInTitle('Acme Bucket 5 lb', '5 gal')).toBe(false);
    expect(variantTokenPresentInTitle('Acme Bucket 16 oz', '16 fl oz')).toBe(false);
    expect(variantTokenPresentInTitle('Acme Widget 5 lb', '5-Count')).toBe(false);
  });

  it('matches the same axis across spacing/casing variants', () => {
    expect(variantTokenPresentInTitle('Premium Dog Food 5LB', '5 lb')).toBe(true);
    expect(variantTokenPresentInTitle('Acme Bucket 5-GAL', '5 gal')).toBe(true);
    expect(variantTokenPresentInTitle('Widget 5-Count', '5-Count')).toBe(true);
  });
});

describe('ensureVariantTokensInTitle (issue #111)', () => {
  it('keeps distinct axes: weight does not satisfy capacity or count', () => {
    expect(ensureVariantTokensInTitle('Acme Bucket 5 lb', ['5 GAL'])).toBe('Acme Bucket 5 lb 5 gal');
    expect(ensureVariantTokensInTitle('Acme Widget 5 lb', ['5-Count'])).toBe('Acme Widget 5 lb 5-Count');
  });
  it('appends a distributor size missing from a sizeless H1 as final tokens', () => {
    expect(ensureVariantTokensInTitle('Salter E-Z Hang Scale Silver', ['Up to 55 LB'])).toBe(
      'Salter E-Z Hang Scale Silver 55 lb',
    );
  });

  it('appends capacity as its own axis', () => {
    expect(ensureVariantTokensInTitle('Acme Bucket', ['5 GAL'])).toBe('Acme Bucket 5 gal');
  });

  it('leaves titles already carrying the token untouched', () => {
    expect(ensureVariantTokensInTitle('Acme Premium Dog Food 5 lb', ['DOG FOOD 5LB'])).toBe(
      'Acme Premium Dog Food 5 lb',
    );
  });

  it('never invents: unknown sizes leave the title unchanged', () => {
    expect(ensureVariantTokensInTitle('Mystery Product', ['Mystery Product', null])).toBe(
      'Mystery Product',
    );
  });

  it('dedupes the same token evidenced twice', () => {
    expect(ensureVariantTokensInTitle('Widget', ['6 OZ', '6OZ'])).toBe('Widget 6 oz');
  });
});
