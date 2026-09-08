import { describe, it, expect } from 'vitest';
import { enrichProductDetails } from '../../classification/detail-enrichment';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeOcr(overrides: Partial<PackagingOcrData> = {}): PackagingOcrData {
  return {
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
    ...overrides,
  };
}

// ─── Species ───────────────────────────────────────────────────────────────────

describe('enrichProductDetails - species', () => {
  it('extracts Dog from OCR species array', () => {
    const result = enrichProductDetails({
      evidenceText: 'premium pet food',
      packagingOcrData: makeOcr({ species: ['Dog'] }),
    });
    expect(result.filter(c => c.attributeId === 'species').length).toBe(1);
    expect(result.find(c => c.attributeId === 'species')!.value).toBe('Dog');
  });

  it('extracts Cat from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'This premium cat food is made with real chicken',
    });
    const species = result.filter(c => c.attributeId === 'species');
    expect(species.length).toBe(1);
    expect(species[0].value).toBe('Cat');
    expect(species[0].matchedBy).toBe('pattern');
  });

  it('extracts Puppy from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Formulated for growing puppies',
    });
    const species = result.filter(c => c.attributeId === 'species');
    expect(species.length).toBe(1);
    expect(species[0].value).toBe('Dog');
  });

  it('extracts Dog & Cat from multi-species text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Suitable for dog & cat households',
    });
    const species = result.filter(c => c.attributeId === 'species');
    expect(species.length).toBe(1);
    expect(species[0].value).toBe('Dog & Cat');
  });

  it('returns empty for unrelated text', () => {
    const result = enrichProductDetails({
      evidenceText: 'garden soil and fertilizer',
    });
    expect(result.filter(c => c.attributeId === 'species').length).toBe(0);
  });
});

// ─── Life Stage ────────────────────────────────────────────────────────────────

describe('enrichProductDetails - lifeStage', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some food',
      packagingOcrData: makeOcr({ lifeStage: 'Adult' }),
    });
    const ls = result.filter(c => c.attributeId === 'lifeStage');
    expect(ls.length).toBe(1);
    expect(ls[0].value).toBe('Adult');
    expect(ls[0].matchedBy).toBe('evidence');
  });

  it('extracts Senior from text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Specially formulated for senior dogs',
    });
    const ls = result.filter(c => c.attributeId === 'lifeStage');
    expect(ls.length).toBe(1);
    expect(ls[0].value).toBe('Senior');
  });

  it('returns empty for no match', () => {
    const result = enrichProductDetails({
      evidenceText: 'generic product description here',
    });
    expect(result.filter(c => c.attributeId === 'lifeStage').length).toBe(0);
  });
});

// ─── Flavor ────────────────────────────────────────────────────────────────────

describe('enrichProductDetails - flavor', () => {
  it('extracts from OCR flavorVariety', () => {
    const result = enrichProductDetails({
      evidenceText: 'some food',
      packagingOcrData: makeOcr({ flavorVariety: 'Chicken' }),
    });
    const flavor = result.filter(c => c.attributeId === 'flavor');
    expect(flavor.length).toBe(1);
    expect(flavor[0].value).toBe('Chicken');
  });

  it('extracts Beef from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Made with real beef for protein',
    });
    const flavor = result.filter(c => c.attributeId === 'flavor');
    expect(flavor.length).toBe(1);
    expect(flavor[0].value).toBe('Beef');
  });

  it('extracts Salmon from text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Wild caught salmon recipe',
    });
    const flavor = result.filter(c => c.attributeId === 'flavor');
    expect(flavor.length).toBe(1);
    expect(flavor[0].value).toBe('Salmon');
  });

  it('extracts from curatedTitle', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      curatedTitle: 'Turkey & Sweet Potato Dog Food',
    });
    const flavor = result.filter(c => c.attributeId === 'flavor');
    expect(flavor.length).toBe(1);
    expect(flavor[0].value).toBe('Turkey');
  });

  it('returns empty for no match', () => {
    const result = enrichProductDetails({
      evidenceText: 'a generic product',
    });
    expect(result.filter(c => c.attributeId === 'flavor').length).toBe(0);
  });
});

// ─── Color ─────────────────────────────────────────────────────────────────────

describe('enrichProductDetails - color', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ color: 'Blue' }),
    });
    const color = result.filter(c => c.attributeId === 'color');
    expect(color.length).toBe(1);
    expect(color[0].value).toBe('Blue');
  });

  it('extracts Brown from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Available in brown and tan',
    });
    const colors = result.filter(c => c.attributeId === 'color');
    expect(colors.length).toBeGreaterThanOrEqual(1);
    expect(colors.some(c => c.value === 'Brown')).toBe(true);
  });
});

// ─── Size ──────────────────────────────────────────────────────────────────────

describe('enrichProductDetails - size', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ size: 'Large' }),
    });
    const size = result.filter(c => c.attributeId === 'size');
    expect(size.length).toBe(1);
    expect(size[0].value).toBe('Large');
  });

  it('extracts Small from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Perfect for small breed dogs',
    });
    const size = result.filter(c => c.attributeId === 'size');
    expect(size.some(c => c.value === 'Small')).toBe(true);
  });
});

// ─── Material ──────────────────────────────────────────────────────────────────

describe('enrichProductDetails - material', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ material: 'Nylon' }),
    });
    const mat = result.filter(c => c.attributeId === 'material');
    expect(mat.length).toBe(1);
    expect(mat[0].value).toBe('Nylon');
  });

  it('extracts Leather from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Genuine leather collar with brass hardware',
    });
    const mat = result.filter(c => c.attributeId === 'material');
    expect(mat.some(c => c.value === 'Leather')).toBe(true);
  });
});

// ─── Weight ────────────────────────────────────────────────────────────────────

describe('enrichProductDetails - weight', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ weight: '5 lb' }),
    });
    const w = result.filter(c => c.attributeId === 'weight');
    expect(w.length).toBe(1);
    expect(w[0].value).toBe('5 lb');
  });

  it('extracts weight pattern from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'This 24 oz bag of dog food',
    });
    const w = result.filter(c => c.attributeId === 'weight');
    expect(w.length).toBe(1);
    expect(w[0].value).toBe('24 oz');
  });

  it('extracts kg pattern', () => {
    const result = enrichProductDetails({
      evidenceText: 'Available in 2.5kg size',
    });
    const w = result.filter(c => c.attributeId === 'weight');
    expect(w.length).toBe(1);
    expect(w[0].value).toBe('2.5 kg');
  });

  it('extracts lbs pattern', () => {
    const result = enrichProductDetails({
      evidenceText: '30 lb bag of dog food',
    });
    const w = result.filter(c => c.attributeId === 'weight');
    expect(w.length).toBe(1);
    expect(w[0].value).toBe('30 lb');
  });
});

// ─── Count ─────────────────────────────────────────────────────────────────────

describe('enrichProductDetails - count', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ count: '24 count' }),
    });
    const c = result.filter(c => c.attributeId === 'count');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe('24 count');
  });

  it('extracts count pattern from text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Pack of 12 count treats',
    });
    const c = result.filter(c => c.attributeId === 'count');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe('12 count');
  });

  it('extracts pack pattern', () => {
    const result = enrichProductDetails({
      evidenceText: '8 pack of dental chews',
    });
    const c = result.filter(c => c.attributeId === 'count');
    expect(c.length).toBe(1);
    expect(c[0].value).toBe('8 pack');
  });
});

// ─── Breed Size ────────────────────────────────────────────────────────────────

describe('enrichProductDetails - breedSize', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ breedSize: 'Large Breed' }),
    });
    const bs = result.filter(c => c.attributeId === 'breedSize');
    expect(bs.length).toBe(1);
    expect(bs[0].value).toBe('Large Breed');
  });

  it('extracts from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Formulated for large breed puppies',
    });
    const bs = result.filter(c => c.attributeId === 'breedSize');
    expect(bs.some(c => c.value === 'Large Breed')).toBe(true);
  });
});

// ─── Product Form ──────────────────────────────────────────────────────────────

describe('enrichProductDetails - productForm', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ productForm: 'Dry' }),
    });
    const pf = result.filter(c => c.attributeId === 'productForm');
    expect(pf.length).toBe(1);
    expect(pf[0].value).toBe('Dry');
  });

  it('extracts Wet from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Grain free wet cat food',
    });
    const pf = result.filter(c => c.attributeId === 'productForm');
    expect(pf.some(c => c.value === 'Wet')).toBe(true);
  });

  it('extracts Treats from evidence', () => {
    const result = enrichProductDetails({
      evidenceText: 'Soft chewy dog treats',
    });
    const pf = result.filter(c => c.attributeId === 'productForm');
    expect(pf.some(c => c.value === 'Treats')).toBe(true);
  });
});

// ─── Dietary Labels (safety-gated) ─────────────────────────────────────────────

describe('enrichProductDetails - dietaryLabel (safety-gated)', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ dietaryLabels: ['Grain-Free'] }),
    });
    const dl = result.filter(c => c.attributeId === 'dietaryLabel');
    expect(dl.length).toBe(1);
    expect(dl[0].value).toBe('Grain-Free');
    expect(dl[0].matchedBy).toBe('evidence');
  });

  it('extracts from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'This grain-free recipe is also gluten-free',
    });
    const dl = result.filter(c => c.attributeId === 'dietaryLabel');
    expect(dl.length).toBeGreaterThanOrEqual(1);
    expect(dl.some(c => c.value === 'Grain-Free')).toBe(true);
  });

  it('does NOT infer dietary labels from absence', () => {
    const result = enrichProductDetails({
      evidenceText: 'A generic product with no dietary claims',
    });
    expect(result.filter(c => c.attributeId === 'dietaryLabel').length).toBe(0);
  });
});

// ─── Health Concerns (safety-gated) ────────────────────────────────────────────

describe('enrichProductDetails - healthConcern (safety-gated)', () => {
  it('extracts from OCR', () => {
    const result = enrichProductDetails({
      evidenceText: 'some text',
      packagingOcrData: makeOcr({ healthConcernFunction: ['Digestive Health'] }),
    });
    const hc = result.filter(c => c.attributeId === 'healthConcern');
    expect(hc.length).toBe(1);
    expect(hc[0].value).toBe('Digestive Health');
  });

  it('extracts from evidence text', () => {
    const result = enrichProductDetails({
      evidenceText: 'With added glucosamine for joint health',
    });
    const hc = result.filter(c => c.attributeId === 'healthConcern');
    expect(hc.some(c => c.value === 'Joint Health')).toBe(true);
  });

  it('does NOT infer health concerns from absence', () => {
    const result = enrichProductDetails({
      evidenceText: 'A generic product with no health claims',
    });
    expect(result.filter(c => c.attributeId === 'healthConcern').length).toBe(0);
  });
});

// ─── allowedValues Filtering ───────────────────────────────────────────────────

describe('enrichProductDetails - allowedValues filtering', () => {
  it('filters species to allowed values', () => {
    const result = enrichProductDetails({
      evidenceText: 'Premium dog and cat food',
      allowedValues: ['Cat'],
    });
    const species = result.filter(c => c.attributeId === 'species');
    expect(species.length).toBe(1);
    expect(species[0].value).toBe('Cat');
  });

  it('filters flavor to allowed values', () => {
    const result = enrichProductDetails({
      evidenceText: 'Chicken and Salmon recipe',
      allowedValues: ['Salmon'],
    });
    const flavor = result.filter(c => c.attributeId === 'flavor');
    expect(flavor.length).toBe(1);
    expect(flavor[0].value).toBe('Salmon');
  });

  it('resolves OCR values to the exact canonical allowed ID (issue #17 G)', () => {
    const result = enrichProductDetails({
      evidenceText: 'premium dog food',
      packagingOcrData: {
        species: 'dog',
        flavorVariety: 'chicken',
      } as any,
      allowedValues: ['Dog', 'Chicken'],
    });
    const species = result.find(c => c.attributeId === 'species');
    expect(species).toBeDefined();
    expect(species!.value).toBe('Dog'); // canonical ID, never the raw OCR string
    const flavor = result.find(c => c.attributeId === 'flavor');
    expect(flavor).toBeDefined();
    expect(flavor!.value).toBe('Chicken');
  });

  it('drops OCR values that are not in the allowed set (near-match fails closed)', () => {
    const result = enrichProductDetails({
      evidenceText: 'premium food',
      packagingOcrData: { species: 'canine' } as any,
      allowedValues: ['Dog'],
    });
    expect(result.filter(c => c.attributeId === 'species').length).toBe(0);
  });

  it('keeps an alias target that is not in the allowed set from serializing (fail closed)', () => {
    const result = enrichProductDetails({
      evidenceText: 'handmade ceramic dog bowl',
      aliases: [{ alias: 'ceramic', mapsTo: 'Ceramic' }],
      allowedValues: ['Clay'],
    });
    expect(result.filter(c => c.attributeId === 'material').length).toBe(0);
  });
});

// ─── Alias Matching ────────────────────────────────────────────────────────────

describe('enrichProductDetails - alias matching', () => {
  it('matches via alias for non-keyword material', () => {
    // MATERIAL_KEYWORDS doesn't have 'Ceramic', so alias fires for it
    const result = enrichProductDetails({
      evidenceText: 'handmade ceramic dog bowl',
      aliases: [{ alias: 'ceramic', mapsTo: 'Ceramic' }],
    });
    const mat = result.filter(c => c.attributeId === 'material');
    expect(mat.length).toBe(1);
    expect(mat[0].value).toBe('Ceramic');
    expect(mat[0].matchedBy).toBe('alias');
  });

  it('keeps an alias whose TEXT differs from its TARGET when the target is allowed (reviewer regression: resolveAlias searched alias texts and silently dropped these)', () => {
    const result = enrichProductDetails({
      evidenceText: 'handmade chicken flavor bowl',
      aliases: [
        { alias: 'chicken flavor', mapsTo: 'Chicken' },
        { alias: 'dogs', mapsTo: 'Dog' },
      ],
      allowedValues: ['Chicken', 'Dog'],
    });
    const mat = result.filter(c => c.attributeId === 'material');
    expect(mat.length).toBe(1);
    expect(mat[0].value).toBe('Chicken');
    expect(mat[0].matchedBy).toBe('alias');
  });

  it('still fails closed when an alias target is outside the allowed set (target match, not alias-text match)', () => {
    const result = enrichProductDetails({
      evidenceText: 'handmade chicken flavor bowl',
      aliases: [{ alias: 'chicken flavor', mapsTo: 'Turkey' }],
      allowedValues: ['Chicken'],
    });
    expect(result.filter(c => c.attributeId === 'material').length).toBe(0);
  });
});

// ─── Empty / Edge Cases ────────────────────────────────────────────────────────

describe('enrichProductDetails - edge cases', () => {
  it('returns empty for empty input', () => {
    const result = enrichProductDetails({
      evidenceText: '',
    });
    expect(result.length).toBe(0);
  });

  it('returns empty for whitespace text', () => {
    const result = enrichProductDetails({
      evidenceText: '   ',
    });
    expect(result.length).toBe(0);
  });

  it('returns empty for non-matching text', () => {
    const result = enrichProductDetails({
      evidenceText: 'qwerty zxcvb 12345',
    });
    expect(result.length).toBe(0);
  });

  it('handles null OCR gracefully', () => {
    const result = enrichProductDetails({
      evidenceText: 'premium dog food',
      packagingOcrData: null,
    });
    expect(result.filter(c => c.attributeId === 'species').length).toBe(1);
    expect(result.find(c => c.attributeId === 'species')!.value).toBe('Dog');
  });

  it('handles undefined OCR gracefully', () => {
    const result = enrichProductDetails({
      evidenceText: 'premium cat food',
    });
    expect(result.filter(c => c.attributeId === 'species').length).toBe(1);
    expect(result.find(c => c.attributeId === 'species')!.value).toBe('Cat');
  });

  it('extracts multiple facets from same text', () => {
    const result = enrichProductDetails({
      evidenceText: 'Grain-free chicken recipe for adult small breed dogs',
    });
    const attributeIds = result.map(c => c.attributeId);
    expect(attributeIds).toContain('species');
    expect(attributeIds).toContain('lifeStage');
    expect(attributeIds).toContain('flavor');
    expect(attributeIds).toContain('size');
    expect(attributeIds).toContain('breedSize');
  });
});
