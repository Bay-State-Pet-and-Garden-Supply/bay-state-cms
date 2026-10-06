import { describe, it, expect } from 'vitest';
import {
  buildEvidenceText,
  matchKeywordOptions,
  matchAttributeOptions,
  normalizeOption,
  tokenize,
} from '../../classification/curation-target-matcher';
import type { ClassificationEvidence, ProductAttributeConfig } from '../../shared/schemas/classification';

describe('Curation Target Matcher', () => {
  describe('buildEvidenceText', () => {
    it('joins evidence values into text and collects IDs', () => {
      const evidence: ClassificationEvidence[] = [
        { id: 'ev1', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: 'Dog Food', value: 'Dog Food', metadata: {}, capturedAt: '' },
        { id: 'ev2', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'official_product_page', reliability: 'medium', sourceUrl: null, sourceField: 'description', snippet: 'Tasty food', value: 'Tasty food for dogs', metadata: {}, capturedAt: '' },
      ];
      const result = buildEvidenceText(evidence);
      expect(result.text).toContain('Dog Food');
      expect(result.text).toContain('Tasty food for dogs');
      expect(result.evidenceIds).toEqual(['ev1', 'ev2']);
    });

    it('returns empty string and array for empty evidence', () => {
      const result = buildEvidenceText([]);
      expect(result.text).toBe('');
      expect(result.evidenceIds).toEqual([]);
    });

    it('filters by includeSources when provided', () => {
      const evidence: ClassificationEvidence[] = [
        { id: 'ev1', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: 'Dog Food', value: 'Dog Food', metadata: {}, capturedAt: '' },
        { id: 'ev2', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'visual_product_evidence', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: 'Chicken', value: 'Chicken', metadata: {}, capturedAt: '' },
      ];
      const result = buildEvidenceText(evidence, { includeSources: ['spreadsheet'] });
      expect(result.text).toContain('Dog Food');
      expect(result.text).not.toContain('Chicken');
    });

    it('excludes fields when excludeFields provided', () => {
      const evidence: ClassificationEvidence[] = [
        { id: 'ev1', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: 'Dog Food', value: 'Dog Food', metadata: {}, capturedAt: '' },
        { id: 'ev2', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'official_product_page', reliability: 'medium', sourceUrl: null, sourceField: 'description', snippet: 'Tasty', value: 'Tasty', metadata: {}, capturedAt: '' },
      ];
      const result = buildEvidenceText(evidence, { excludeFields: ['description'] });
      expect(result.text).toContain('Dog Food');
      expect(result.text).not.toContain('Tasty');
    });
  });

  describe('tokenize', () => {
    it('splits text into lowercase tokens', () => {
      const tokens = tokenize('Dry Dog Food Chicken Recipe');
      expect(tokens).toContain('dry');
      expect(tokens).toContain('dog');
      expect(tokens).toContain('food');
      expect(tokens).toContain('chicken');
      expect(tokens).toContain('recipe');
    });

    it('filters stop words', () => {
      const tokens = tokenize('the and for with dog food');
      expect(tokens).not.toContain('the');
      expect(tokens).not.toContain('and');
      expect(tokens).not.toContain('for');
      expect(tokens).not.toContain('with');
      expect(tokens).toContain('dog');
      expect(tokens).toContain('food');
    });

    it('filters short tokens (< 3 chars)', () => {
      const tokens = tokenize('a an the dog');
      expect(tokens).toEqual(['dog']);
    });

    it('returns empty array for empty text', () => {
      expect(tokenize('')).toEqual([]);
    });

    it('accepts custom stop words', () => {
      const tokens = tokenize('premium dog food', new Set(['premium']));
      expect(tokens).not.toContain('premium');
      expect(tokens).toContain('dog');
      expect(tokens).toContain('food');
    });
  });

  describe('normalizeOption', () => {
    it('finds exact case-insensitive match', () => {
      const result = normalizeOption('Chicken', ['Chicken', 'Beef', 'Salmon']);
      expect(result).toBe('Chicken');
    });

    it('finds case-insensitive match', () => {
      const result = normalizeOption('CHICKEN', ['Chicken', 'Beef', 'Salmon']);
      expect(result).toBe('Chicken');
    });

    it('returns null for no match', () => {
      const result = normalizeOption('Turkey', ['Chicken', 'Beef', 'Salmon']);
      expect(result).toBeNull();
    });

    it('returns null for empty input', () => {
      const result = normalizeOption('', ['Chicken']);
      expect(result).toBeNull();
    });

    it('returns null for null/undefined input', () => {
      const result = normalizeOption(null, ['Chicken']);
      expect(result).toBeNull();
    });
  });

  describe('matchKeywordOptions', () => {
    const options = [
      { value: 'dry-dog-food', label: 'Dry Dog Food' },
      { value: 'wet-dog-food', label: 'Wet Dog Food' },
      { value: 'dog-treats', label: 'Dog Treats' },
    ];

    it('ranks options by token overlap', () => {
      const result = matchKeywordOptions({
        options,
        text: 'Premium Dry Dog Food Chicken Recipe',
        selectionMode: 'single',
      });
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].value).toBe('dry-dog-food');
    });

    it('returns multiple results in multiple mode', () => {
      const result = matchKeywordOptions({
        options,
        text: 'Dog Food Premium Recipe',
        selectionMode: 'multiple',
        maxResults: 3,
      });
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for empty text', () => {
      const result = matchKeywordOptions({ options, text: '', selectionMode: 'single' });
      expect(result).toEqual([]);
    });

    it('returns empty array for no options', () => {
      const result = matchKeywordOptions({ options: [], text: 'Dog Food', selectionMode: 'single' });
      expect(result).toEqual([]);
    });

    it('returns empty array for short text (< 3 chars)', () => {
      const result = matchKeywordOptions({ options, text: 'ab', selectionMode: 'single' });
      expect(result).toEqual([]);
    });

    it('scores duplicate label tokens with full multiplicity on repeated calls (stable arrays engage the index)', () => {
      // Regression: the inverted index once dedup-counted postings, scoring
      // 'Chicken Chicken' 0.625 instead of the direct 0.8. Same array three
      // times: first call direct, later calls indexed — outputs must agree.
      const dupOptions = [
        { value: 'dup', label: 'Chicken Chicken' },
        { value: 'plain', label: 'Beef' },
      ];
      const text = 'made with real chicken and rice';
      const first = matchKeywordOptions({ options: dupOptions, text, selectionMode: 'single' });
      expect(first[0].confidence).toBeCloseTo(0.8, 10);
      expect(first[0].matchedTokens).toEqual(['chicken', 'chicken']);
      for (let i = 0; i < 3; i++) {
        expect(matchKeywordOptions({ options: dupOptions, text, selectionMode: 'single' })).toEqual(first);
        expect(matchKeywordOptions({ options: dupOptions, text, selectionMode: 'multiple', maxResults: 5 })).toEqual(
          matchKeywordOptions({ options: dupOptions.map(o => ({ ...o })), text, selectionMode: 'multiple', maxResults: 5 }),
        );
      }
    });

    it('breaks full ties in array order on repeated calls (duplicate labels)', () => {
      // Two identical labels tying at top: the direct stable sort keeps
      // array order; the index must not leak touch order through.
      const tieOptions = [
        { value: 'x1', label: 'Thank you!' },
        { value: 'x2', label: 'Thank you!' },
        { value: 'x3', label: 'Alpha' },
      ];
      const text = 'thank you for shopping alpha beta';
      const first = matchKeywordOptions({ options: tieOptions, text, selectionMode: 'single' });
      const multi = matchKeywordOptions({ options: tieOptions, text, selectionMode: 'multiple', maxResults: 3 });
      for (let i = 0; i < 3; i++) {
        expect(matchKeywordOptions({ options: tieOptions, text, selectionMode: 'single' })).toEqual(first);
        expect(matchKeywordOptions({ options: tieOptions, text, selectionMode: 'multiple', maxResults: 3 })).toEqual(multi);
      }
      // Three-way tie at 0.8: min label 'Alpha' wins, then the identical
      // pair in array order.
      expect(first[0].value).toBe('x3');
      expect(multi.map(m => m.value)).toEqual(['x3', 'x1', 'x2']);
    });
  });

  describe('matchAttributeOptions', () => {
    const attribute: ProductAttributeConfig = {
      id: 'flavor',
      name: 'Flavor',
      description: null,
      valueMode: 'controlled',
      canonicalUnit: null,
      allowedValues: ['Chicken', 'Beef', 'Salmon', 'Lamb'],
      valueAliases: [
        { alias: 'chicken', mapsTo: 'Chicken' },
        { alias: 'beef', mapsTo: 'Beef' },
        { alias: 'lamb', mapsTo: 'Lamb' },
      ],
      visualEvidenceEligibility: 'eligible',
      isClaim: false,
      isCompositionAttribute: false,
      group: 'Food',
    };

    it('finds direct matches via substring', () => {
      const result = matchAttributeOptions(attribute, 'made with real beef'.toLowerCase(), attribute.allowedValues, 'single');
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].value).toBe('Beef');
      expect(result[0].matchedBy).toBe('direct');
    });

    it('matches via aliases', () => {
      const result = matchAttributeOptions(attribute, 'contains chicken meal'.toLowerCase(), attribute.allowedValues, 'multiple');
      const values = result.map(r => r.value);
      expect(values).toContain('Chicken');
    });

    it('returns multiple matches in multiple mode', () => {
      const result = matchAttributeOptions(attribute, 'beef and lamb recipe with chicken'.toLowerCase(), attribute.allowedValues, 'multiple');
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('returns single match in single mode', () => {
      const result = matchAttributeOptions(attribute, 'beef and lamb recipe with chicken'.toLowerCase(), attribute.allowedValues, 'single');
      expect(result.length).toBe(1);
    });

    it('returns empty array for empty text', () => {
      const result = matchAttributeOptions(attribute, '', attribute.allowedValues, 'single');
      expect(result).toEqual([]);
    });

    it('returns empty array for no options', () => {
      const result = matchAttributeOptions(attribute, 'beef', [], 'single');
      expect(result).toEqual([]);
    });

    it('returns empty array when nothing matches', () => {
      const result = matchAttributeOptions(attribute, 'tuna fish', attribute.allowedValues, 'single');
      expect(result).toEqual([]);
    });

    it('fails closed when an alias mapsTo is not an exact allowed option (issue #17 G)', () => {
      const danglingAliasAttribute: ProductAttributeConfig = {
        ...attribute,
        valueAliases: [{ alias: 'bird', mapsTo: 'Turkey' }],
      };
      // 'Turkey' is not in the allowed options: the alias must never emit a
      // non-canonical guess.
      const result = matchAttributeOptions(danglingAliasAttribute, 'bird meat', attribute.allowedValues, 'multiple');
      expect(result.filter(r => r.matchedBy === 'alias')).toEqual([]);
    });
  });
});
