import { describe, expect, it } from 'vitest';
import { packagingOcrDataToEvidence } from '../../classification/ocr-evidence';
import type { PackagingOcrData } from '../../shared/schemas/onboarding';

function ocrDataWithLines(lines: string[]): PackagingOcrData {
  return {
    productName: null,
    brand: null,
    species: ['dog'],
    upc: null,
    flavorVariety: 'Chicken',
    color: null,
    material: null,
    size: null,
    weight: null,
    count: null,
    lifeStage: 'puppy',
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
    visibleTextLines: lines,
    confidenceByField: { flavorVariety: 0.95, lifeStage: 0.9 },
    metadata: null,
  };
}

describe('grounded OCR evidence (A3)', () => {
  it('keeps a fourth-line value-relevant quote citeable (first-4 window, A3)', () => {
    const evidence = packagingOcrDataToEvidence(
      ocrDataWithLines(['PREMIUM', 'NATURAL', 'GRAIN FREE', 'DOGS & PUPPIES', 'NET WT 5 LB']),
      { runId: 'run-a3', sku: 'A3-001', model: 'qwen2.5vl:latest' },
    );
    const quotes = evidence.filter(e => e.sourceField === 'visible_text').map(e => String(e.value));
    expect(quotes).toContain('DOGS & PUPPIES');
    expect(quotes).toHaveLength(4);
  });

  it('caps self-reported confidence at medium without corroboration', () => {
    const evidence = packagingOcrDataToEvidence(
      ocrDataWithLines(['CHICKEN RECIPE']),
      { runId: 'run-a3', sku: 'A3-001', model: 'qwen2.5vl:latest' },
    );
    const flavor = evidence.find(e => e.sourceField === 'flavor');
    expect(flavor).toBeDefined();
    // 0.95 self-confidence must not become high reliability on its own claim.
    expect(flavor!.reliability).not.toBe('high');
    expect(flavor!.reliability).toBe('medium');
  });

  it('scopes rows to the supplying image calls, not an unrelated union', () => {
    const data = ocrDataWithLines(['CHICKEN RECIPE']);
    (data as { metadata: unknown }).metadata = {
      modelCallIds: ['call-unrelated'],
      fieldProvenance: { flavorVariety: { imageIndex: 1, modelCallIds: ['call-image-1'] } },
    };
    const evidence = packagingOcrDataToEvidence(
      data,
      { runId: 'run-a3', sku: 'A3-001', model: 'qwen2.5vl:latest', modelCallIds: ['call-unrelated'] },
    );
    const flavor = evidence.find(e => e.sourceField === 'flavor');
    const callIds = (flavor!.metadata as { modelCallIds?: string[] }).modelCallIds;
    expect(callIds).toEqual(['call-image-1']);
  });
});
