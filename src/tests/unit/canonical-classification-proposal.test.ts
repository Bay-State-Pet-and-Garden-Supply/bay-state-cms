/**
 * Issue #350 slice 2 — canonical pair proposal seam (TDD).
 *
 * The shared composition produces ONE canonical pair proposal per run:
 * `product_classification` carrying {categoryId, productTypeId} with an
 * explicit supported/unresolved outcome per component. Only approved
 * configured combinations are proposed — no taxonomy label or combination
 * is invented. Brand scope respected: the pair never carries Brand.
 */
import { describe, it, expect } from 'bun:test';
import { buildClassificationProposal } from '../../classification/curation-target-proposal';
import {
  isApprovedClassificationPair,
  resolveClassificationResult,
} from '../../classification/product-classification';

const BUNDLE: any = {
  productTypes: [
    { id: 'dog-food-dry', name: 'Dry Dog Food', categoryId: 'dog-food' },
    { id: 'cat-food-wet', name: 'Wet Cat Food', categoryId: 'cat-food' },
  ],
  categories: [
    { id: 'dog-food', name: 'Dog Food' },
    { id: 'cat-food', name: 'Cat Food' },
  ],
};

describe('canonical pair proposal (issue #350)', () => {
  it('builds a pair proposal for an approved combination', () => {
    const proposal = buildClassificationProposal({
      runId: 'run-1', sku: 'SKU-1',
      categoryId: 'dog-food', productTypeId: 'dog-food-dry',
      confidence: 0.9, evidenceIds: ['ev-1'],
    });
    expect(proposal.proposalType).toBe('product_classification');
    expect(proposal.targetId).toBe('dog-food-dry');
    expect(proposal.proposedValue).toEqual({ categoryId: 'dog-food', productTypeId: 'dog-food-dry', matchedWords: [] });
    expect(isApprovedClassificationPair({ categoryId: 'dog-food', productTypeId: 'dog-food-dry' }, BUNDLE)).toBe(true);
    expect(JSON.stringify(proposal.proposedValue)).not.toContain('brand');
  });

  it('an unresolved component yields an explicit unresolved outcome, never a forced label', () => {
    const result = resolveClassificationResult({ categoryId: null, productTypeId: 'dog-food-dry' }, BUNDLE);
    expect(result.category.status).toBe('unresolved');
    expect(result.productType.status).toBe('supported');
  });

  it('a mismatched pair is unresolved on the inconsistent component', () => {
    const result = resolveClassificationResult({ categoryId: 'cat-food', productTypeId: 'dog-food-dry' }, BUNDLE);
    expect(result.productType.status).toBe('unresolved');
    if (result.productType.status === 'unresolved') {
      expect(result.productType.reason).toContain('dog-food');
    }
  });

});
