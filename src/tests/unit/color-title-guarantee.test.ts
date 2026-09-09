import { describe, it, expect } from 'vitest';
import {
  extractColorWords,
  knownColorsAcross,
  colorTokenPresentInTitle,
  ensureColorInTitle,
  resolveOwnColor,
  extractLabeledColors,
  buildPerItemPrompt,
} from '../../onboarding/title-prompt-template';

describe('extractColorWords (issue #112)', () => {
  it('finds vocabulary colors case-insensitively', () => {
    expect(extractColorWords('RED Widget')).toEqual(['Red']);
    expect(extractColorWords('navy Widget')).toEqual(['Navy']);
  });

  it('never matches substrings of larger words', () => {
    expect(extractColorWords('Blackberry Treats')).toEqual([]);
    expect(extractColorWords('Sandals for Dogs')).toEqual([]);
  });

  it('canonicalizes aliases and dedupes preserving order', () => {
    expect(extractColorWords('grey Widget GREY red')).toEqual(['Gray', 'Red']);
  });

  it('ignores flavor and food words outside the vocabulary', () => {
    expect(extractColorWords('Chicken Salmon Treats')).toEqual([]);
    expect(extractColorWords('Chocolate Mint Chews')).toEqual([]);
  });

  it('returns empty for blank input', () => {
    expect(extractColorWords('')).toEqual([]);
    expect(extractColorWords('   ')).toEqual([]);
  });
});

describe('knownColorsAcross (issue #112)', () => {
  it('unions colors across strings, deduped', () => {
    expect(knownColorsAcross(['Red Widget', null, 'Blue Widget', 'red leash'])).toEqual(['Red', 'Blue']);
  });

  it('returns empty when nothing is evidenced', () => {
    expect(knownColorsAcross([null, undefined, 'Plain Widget'])).toEqual([]);
  });
});

describe('colorTokenPresentInTitle (issue #112)', () => {
  it('matches case-insensitively with flexible separators', () => {
    expect(colorTokenPresentInTitle('Acme RED Widget', 'Red')).toBe(true);
    expect(colorTokenPresentInTitle('Acme Navy-Blue Widget', 'Navy Blue')).toBe(true);
  });

  it('does not match substrings', () => {
    expect(colorTokenPresentInTitle('Acme Blackberry Treats', 'Black')).toBe(false);
  });
});

describe('ensureColorInTitle (issue #112)', () => {
  it('leaves single-color items untouched even when the color is missing (AC2)', () => {
    expect(ensureColorInTitle('Acme Widget', 'Red', ['Red'])).toBe('Acme Widget');
  });

  it('leaves titles untouched when no color is known (absence is not a hold)', () => {
    expect(ensureColorInTitle('Acme Widget', null, [])).toBe('Acme Widget');
    expect(ensureColorInTitle('Acme Widget', null, ['Red'])).toBe('Acme Widget');
  });

  it('appends the own color when multi-color and missing (AC1)', () => {
    expect(ensureColorInTitle('Acme Widget', 'Red', ['Red', 'Blue'])).toBe('Acme Widget Red');
  });

  it('never doubles a present color, normalizing casing in place', () => {
    expect(ensureColorInTitle('Acme RED Widget', 'Red', ['Red', 'Blue'])).toBe('Acme Red Widget');
  });

  it('never invents: unknown own color leaves a multi-color title unchanged', () => {
    expect(ensureColorInTitle('Acme Widget', null, ['Red', 'Blue'])).toBe('Acme Widget');
  });
});

describe('resolveOwnColor (issue #112)', () => {
  it('prefers structured colors over name words', () => {
    expect(resolveOwnColor(['Red'], ['Blue Widget'])).toBe('Red');
  });

  it('falls back to name words when unstructured', () => {
    expect(resolveOwnColor([], ['Blue Widget'])).toBe('Blue');
  });

  it('returns null when nothing is evidenced', () => {
    expect(resolveOwnColor([], ['Plain Widget'])).toBeNull();
    expect(resolveOwnColor([], [])).toBeNull();
  });
});

describe('extractLabeledColors (issue #112)', () => {
  it('parses labeled Color lines', () => {
    expect(extractLabeledColors(['Color: Red'])).toEqual(['Red']);
    expect(extractLabeledColors(['Colour: blue'])).toEqual(['Blue']);
  });

  it('splits multi-value lines on separators', () => {
    expect(extractLabeledColors(['Colors: Red/Blue'])).toEqual(['Red', 'Blue']);
    expect(extractLabeledColors(['Color: Red, Blue'])).toEqual(['Red', 'Blue']);
    expect(extractLabeledColors(['Color: Red and Blue'])).toEqual(['Red', 'Blue']);
  });

  it('drops non-vocabulary values (conservative options parsing)', () => {
    expect(extractLabeledColors(['Color: Midnight Blue'])).toEqual([]);
    expect(extractLabeledColors(['Color: Assorted'])).toEqual([]);
  });

  it('ignores non-labeled text', () => {
    expect(extractLabeledColors(['This widget is red and roomy'])).toEqual([]);
  });
});

describe('buildPerItemPrompt color lines (issue #112)', () => {
  it('renders OCR color and distributor color as first-class lines', () => {
    const prompt = buildPerItemPrompt({
      name: 'WIDGET',
      brandHint: 'Acme',
      ocrColor: 'Red',
      distributorVariants: [{ field: 'color', value: 'Red', providerId: 'bradley' }],
    });
    expect(prompt).toContain('Packaging OCR Color: "Red"');
    expect(prompt).toContain('Distributor (bradley) Color: "Red"');
  });

  it('omits color lines when no color is evidenced', () => {
    const prompt = buildPerItemPrompt({ name: 'WIDGET', brandHint: 'Acme' });
    expect(prompt).not.toContain('Packaging OCR Color');
    expect(prompt).not.toContain('Distributor (bradley) Color');
  });
});
