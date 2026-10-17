/**
 * Issue #350 slice 3 — canonical pair review seam (TDD).
 *
 * Corrections target the canonical pair through the same validated model:
 * a corrected pair must be an approved configured combination, and
 * correcting either member invalidates affected dependents. Review of a
 * historical type-only proposal stays readable but cannot gain canonical
 * authority without reclassification.
 */
import { describe, it, expect } from 'bun:test';
import { validateClassificationCorrection } from '../../classification/review-correction';
import type { ClassificationProposal } from '../../shared/schemas/classification';

const BUNDLE: any = {
  productTypes: [
    { id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' },
    { id: 'cat-food-wet', name: 'Wet Cat Food', categoryId: 'cat-food' },
  ],
  categories: [{ id: 'dog-food', name: 'Dog Food' }, { id: 'cat-food', name: 'Cat Food' }],
};

function pairProposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'p-pair', runId: 'run-1', productSku: 'SKU-1',
    proposalType: 'product_classification', targetId: 'dog-food-dry',
    proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
    confidence: 0.9, evidenceIds: [], status: 'pending',
    isBulkAcceptable: false, isStale: false, stalenessReason: null,
    createdAt: new Date().toISOString(), ...overrides,
  } as ClassificationProposal;
}

describe('canonical pair correction (issue #350)', () => {
  it('accepts a corrected approved pair', () => {
    const result = validateClassificationCorrection(
      pairProposal(),
      { hasRevisedValue: true, revisedValue: { categoryId: 'cat-food', productTypeId: 'cat-food-wet' }, hasRevisedTargetId: false },
      BUNDLE,
    );
    expect(result.hasRevisedValue).toBe(true);
  });

  it('refuses an invented combination with an attributable code', () => {
    expect(() => validateClassificationCorrection(
      pairProposal(),
      { hasRevisedValue: true, revisedValue: { categoryId: 'cat-food', productTypeId: 'dog-food-dry' }, hasRevisedTargetId: false },
      BUNDLE,
    )).toThrow(/invalid_classification_pair/);
  });

  it('refuses a correction to an unconfigured category', () => {
    expect(() => validateClassificationCorrection(
      pairProposal(),
      { hasRevisedValue: true, revisedValue: { categoryId: 'nope', productTypeId: 'dog-food-dry' }, hasRevisedTargetId: false },
      BUNDLE,
    )).toThrow(/invalid_classification_pair/);
  });

  it('keeps legacy type-only proposals history-only and refuses corrections', () => {
    const legacy = pairProposal({ proposalType: 'primary_product_type', targetId: 'dog-food-dry', proposedValue: { productTypeId: 'dog-food-dry' } });
    expect(() => validateClassificationCorrection(
      legacy,
      { hasRevisedValue: false, hasRevisedTargetId: true, revisedTargetId: 'cat-food-wet' },
      BUNDLE,
    )).toThrow(/canonical Product Classification proposal/);
  });
});
