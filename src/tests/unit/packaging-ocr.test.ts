import { describe, it, expect } from 'vitest';
import { parseJsonFromVlmResponse, coercePackagingOcrData, mergeOcrResults } from '../../onboarding/packaging-ocr';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

// ─── parseJsonFromVlmResponse ──────────────────────────────────────────────────

describe('parseJsonFromVlmResponse', () => {
  it('parses valid JSON directly', () => {
    const result = parseJsonFromVlmResponse('{"productName": "Chicken Treats", "brand": "Woof"}');
    expect(result).toEqual({ productName: 'Chicken Treats', brand: 'Woof' });
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const input = '```json\n{"productName": "Beef Chews", "count": "12"}\n```';
    const result = parseJsonFromVlmResponse(input);
    expect(result).toEqual({ productName: 'Beef Chews', count: '12' });
  });

  it('recovers JSON from prose before/after the object', () => {
    const input = 'Here is the info: {"productName": "Dental Sticks", "size": "Large"} Based on my analysis.';
    const result = parseJsonFromVlmResponse(input);
    expect(result).toEqual({ productName: 'Dental Sticks', size: 'Large' });
  });

  it('recovers JSON from fenced block surrounded by extra text', () => {
    const input = 'I see a package.\n```\n{"productName": "Puppy Food", "weight": "5lb"}\n```\nThat is all.';
    const result = parseJsonFromVlmResponse(input);
    expect(result).toEqual({ productName: 'Puppy Food', weight: '5lb' });
  });

  it('returns null for empty input', () => {
    expect(parseJsonFromVlmResponse('')).toBeNull();
    expect(parseJsonFromVlmResponse('   ')).toBeNull();
  });

  it('returns null for non-JSON without recoverable object', () => {
    expect(parseJsonFromVlmResponse('Just some random text without any JSON')).toBeNull();
  });

  it('returns null for array-only JSON (not an object)', () => {
    const result = parseJsonFromVlmResponse('["item1", "item2"]');
    expect(result).toBeNull();
  });

  it('returns null for primitive-only JSON', () => {
    expect(parseJsonFromVlmResponse('"just a string"')).toBeNull();
    expect(parseJsonFromVlmResponse('42')).toBeNull();
  });

  it('handles nested JSON objects', () => {
    const input = '{"productName": "Cat Food", "metadata": {"shelf": "Aisle 3"}}';
    const result = parseJsonFromVlmResponse(input);
    expect(result).toEqual({ productName: 'Cat Food', metadata: { shelf: 'Aisle 3' } });
  });
});

// ─── coercePackagingOcrData ────────────────────────────────────────────────────

describe('coercePackagingOcrData', () => {
  it('coerces valid data correctly', () => {
    const result = coercePackagingOcrData({
      productName: 'Chicken Flavored Chews',
      brand: 'BarkBits',
      species: ['dog'],
      flavorVariety: 'Chicken',
      color: 'Brown',
      material: 'Nylon',
      size: 'Large',
      weight: '8 oz',
      count: '12',
      lifeStage: 'Adult',
      breedSize: null,
      productForm: 'Chew Treat',
      healthConcernFunction: ['Dental', 'Fresh Breath'],
      dietaryLabels: ['Grain Free', 'No Artificial Flavors'],
      ingredients: ['Chicken', 'Sweet Potato', 'Pea Flour'],
      ingredientKeywords: ['high-protein', 'grain-free'],
      claims: ['Vet Recommended', 'Made in USA'],
      visibleTextLines: ['BarkBits Chicken Chews', 'Grain Free', '12 count'],
      confidenceByField: { productName: 0.95, species: 0.8, flavorVariety: 0.65 },
    });

    expect(result).not.toBeNull();
    expect(result!.productName).toBe('Chicken Flavored Chews');
    expect(result!.brand).toBe('BarkBits');
    expect(result!.species).toEqual(['dog']);
    expect(result!.flavorVariety).toBe('Chicken');
    expect(result!.color).toBe('Brown');
    expect(result!.material).toBe('Nylon');
    expect(result!.size).toBe('Large');
    expect(result!.weight).toBe('8 oz');
    expect(result!.count).toBe('12');
    expect(result!.lifeStage).toBe('Adult');
    expect(result!.breedSize).toBeNull();
    expect(result!.productForm).toBe('Chew Treat');
    expect(result!.healthConcernFunction).toEqual(['Dental', 'Fresh Breath']);
    expect(result!.dietaryLabels).toEqual(['Grain Free', 'No Artificial Flavors']);
    expect(result!.ingredients).toEqual(['Chicken', 'Sweet Potato', 'Pea Flour']);
    expect(result!.ingredientKeywords).toEqual(['high-protein', 'grain-free']);
    expect(result!.claims).toEqual(['Vet Recommended', 'Made in USA']);
    expect(result!.visibleTextLines).toEqual(['BarkBits Chicken Chews', 'Grain Free', '12 count']);
    expect(result!.confidenceByField).toEqual({ productName: 0.95, species: 0.8, flavorVariety: 0.65 });
  });

  it('normalizes a visible barcode into the upc field (round-5)', () => {
    const result = coercePackagingOcrData({
      productName: 'Wormeze Liquid',
      upc: '0 74580 11054 4',
      confidenceByField: { upc: 0.9 },
    });
    expect(result).not.toBeNull();
    expect(result!.upc).toBe('074580110544');
  });

  it('rejects a barcode that is not 8-14 digits (round-5)', () => {
    const result = coercePackagingOcrData({
      productName: 'Wormeze Liquid',
      upc: '12AB',
    });
    expect(result).not.toBeNull();
    expect(result!.upc).toBeNull();
  });

  it('keeps upc null when no barcode is visible', () => {
    const result = coercePackagingOcrData({
      productName: 'Wormeze Liquid',
      upc: null,
    });
    expect(result).not.toBeNull();
    expect(result!.upc).toBeNull();
  });

  it('clamps confidence values to 0-1 range', () => {
    const result = coercePackagingOcrData({
      productName: 'Test',
      confidenceByField: { a: 1.5, b: -0.5, c: 0.7, d: NaN },
    });
    expect(result).not.toBeNull();
    expect(result!.confidenceByField.a).toBe(1);
    expect(result!.confidenceByField.b).toBe(0);
    expect(result!.confidenceByField.c).toBe(0.7);
    expect(result!.confidenceByField.d).toBeUndefined(); // NaN filtered
  });

  it('converts string values that should be arrays', () => {
    const result = coercePackagingOcrData({
      productName: 'Test',
      species: 'dog', // single string instead of array
      dietaryLabels: 'Grain Free',
    });
    expect(result).not.toBeNull();
    expect(result!.species).toEqual(['dog']);
    expect(result!.dietaryLabels).toEqual(['Grain Free']);
  });

  it('filters empty strings from arrays', () => {
    const result = coercePackagingOcrData({
      productName: 'Test',
      species: ['dog', '', 'cat', '  '],
    });
    expect(result).not.toBeNull();
    expect(result!.species).toEqual(['dog', 'cat']);
  });

  it('defaults all missing fields to null or []', () => {
    const result = coercePackagingOcrData({ productName: 'Test' });
    expect(result).not.toBeNull();
    expect(result!.productName).toBe('Test');
    expect(result!.brand).toBeNull();
    expect(result!.species).toEqual([]);
    expect(result!.flavorVariety).toBeNull();
    expect(result!.color).toBeNull();
    expect(result!.material).toBeNull();
    expect(result!.size).toBeNull();
    expect(result!.weight).toBeNull();
    expect(result!.count).toBeNull();
    expect(result!.lifeStage).toBeNull();
    expect(result!.breedSize).toBeNull();
    expect(result!.productForm).toBeNull();
    expect(result!.healthConcernFunction).toEqual([]);
    expect(result!.dietaryLabels).toEqual([]);
    expect(result!.ingredients).toEqual([]);
    expect(result!.ingredientKeywords).toEqual([]);
    expect(result!.claims).toEqual([]);
    expect(result!.visibleTextLines).toEqual([]);
    expect(result!.confidenceByField).toEqual({});
    expect(result!.metadata).toBeNull();
    expect(result!.packagingType).toBeNull();
    expect(result!.npkRatio).toBeNull();
    expect(result!.guaranteedAnalysis).toEqual({});
  });

  it('coerces packagingType, npkRatio, and guaranteedAnalysis', () => {
    const result = coercePackagingOcrData({
      productName: 'Lawn Fertilizer 20-5-10',
      packagingType: 'Bag',
      npkRatio: '20-5-10',
      guaranteedAnalysis: { crudeProtein: '28%', crudeFat: '15%' },
    });
    expect(result).not.toBeNull();
    expect(result!.packagingType).toBe('Bag');
    expect(result!.npkRatio).toBe('20-5-10');
    expect(result!.guaranteedAnalysis).toEqual({ crudeProtein: '28%', crudeFat: '15%' });
  });

  it('converts numeric/boolean values to strings', () => {
    const result = coercePackagingOcrData({
      productName: 'Test',
      count: 12,
      weight: 5,
    });
    expect(result).not.toBeNull();
    expect(result!.count).toBe('12');
    expect(result!.weight).toBe('5');
  });

  it('accepts metadata if provided', () => {
    const metadata = {
      imageSourceUrl: 'https://example.com/img.jpg',
      imageLocalPath: null,
      model: 'qwen2.5vl:latest',
      extractedAt: '2026-07-04T00:00:00Z',
      parser: 'test',
      rawResponseExcerpt: '{"productName": "Test"}',
    };
    const result = coercePackagingOcrData({ productName: 'Test' }, metadata);
    expect(result).not.toBeNull();
    expect(result!.metadata?.imageSourceUrl).toBe('https://example.com/img.jpg');
    expect(result!.metadata?.model).toBe('qwen2.5vl:latest');
    expect(result!.metadata?.parser).toBe('test');
  });

  it('coerces placeholder strings ("null", "none", "N/A", "unknown") to null (FIX-8)', () => {
    const result = coercePackagingOcrData({
      productName: 'null',
      brand: ' NONE ',
      flavorVariety: 'n/a',
      color: 'NA',
      material: 'Unknown',
      size: 'N.A.',
      weight: 'Real Weight',
      count: 12,
    });
    expect(result).not.toBeNull();
    expect(result!.productName).toBeNull();
    expect(result!.brand).toBeNull();
    expect(result!.flavorVariety).toBeNull();
    expect(result!.color).toBeNull();
    expect(result!.material).toBeNull();
    expect(result!.size).toBeNull();
    // Real values (and non-string scalars) are untouched.
    expect(result!.weight).toBe('Real Weight');
    expect(result!.count).toBe('12');
  });

  it('drops placeholder entries from arrays too (FIX-D round 2)', () => {
    const result = coercePackagingOcrData({
      productName: 'Test',
      visibleTextLines: ['NA', 'REAL LINE'],
      claims: ['NULL', 'none', 'Unknown', 'REAL CLAIM'],
      ingredients: ['N/A', 'chicken'],
    });
    expect(result).not.toBeNull();
    // Placeholder entries are VLM non-answers — dropped like scalar
    // placeholders; a placeholder-only array normalizes to empty.
    expect(result!.visibleTextLines).toEqual(['REAL LINE']);
    expect(result!.claims).toEqual(['REAL CLAIM']);
    expect(result!.ingredients).toEqual(['chicken']);
  });

  it('returns null for invalid input that fails schema validation', () => {
    // productName is fine but confidenceByField must be an object of numbers
    const result = coercePackagingOcrData({
      productName: 'Test',
      confidenceByField: { a: 'not-a-number' },
    });
    // should still work since we normalize confidence values
    expect(result).not.toBeNull();
    expect(result!.confidenceByField).toEqual({}); // invalid values filtered out
  });
});

// ─── mergeOcrResults (post-review fixup 3) ─────────────────────────────────────

describe('mergeOcrResults', () => {
  it('carries the primary image contentHash forward instead of dropping it', () => {
    const base = {
      productName: 'Primary Name',
      brand: null,
      species: [],
      upc: null,
      flavorVariety: null,
      color: null,
      material: null,
      size: null,
      weight: null,
      count: null,
      lifeStage: null,
      breedSize: null,
      productForm: null,
      packagingType: null,
      npkRatio: null,
      guaranteedAnalysis: {},
      healthConcernFunction: [],
      dietaryLabels: [],
      ingredients: [],
      ingredientKeywords: [],
      claims: [],
      visibleTextLines: [],
      confidenceByField: {},
      metadata: null,
    };
    const primary = { ...base, productName: 'Primary Name', contentHash: 'a'.repeat(64) } as PackagingOcrData & { contentHash: string | null };
    const secondary = { ...base, productName: 'Secondary Name', species: ['cat'], contentHash: 'b'.repeat(64) } as PackagingOcrData & { contentHash: string | null };

    const merged = mergeOcrResults([primary, secondary]);
    expect((merged as { contentHash?: string | null }).contentHash).toBe('a'.repeat(64));
    expect(merged.productName).toBe('Primary Name');
    expect(merged.species).toEqual(['cat']);
  });

  it('merges two UPC-only results without discarding the barcode (FIX-C round 2)', () => {
    const base = {
      productName: null,
      brand: null,
      species: [],
      upc: null,
      flavorVariety: null,
      color: null,
      material: null,
      size: null,
      weight: null,
      count: null,
      lifeStage: null,
      breedSize: null,
      productForm: null,
      packagingType: null,
      npkRatio: null,
      guaranteedAnalysis: {},
      healthConcernFunction: [],
      dietaryLabels: [],
      ingredients: [],
      ingredientKeywords: [],
      claims: [],
      visibleTextLines: [],
      confidenceByField: {},
      metadata: null,
      contentHash: null,
    };
    const first = { ...base, upc: '035585507101' } as PackagingOcrData & { contentHash: string | null };
    const second = { ...base, upc: null } as PackagingOcrData & { contentHash: string | null };

    const merged = mergeOcrResults([first, second]);
    // Before FIX-C `upc` was missing from the scalar merge list, so the merge
    // produced an all-null result and callers discarded the transcription.
    expect(merged.upc).toBe('035585507101');
    expect(merged.productName).toBeNull();
  });
});
