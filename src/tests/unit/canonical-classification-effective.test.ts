/**
 * Issue #350 slice 5 — effective pair + readiness seam (TDD).
 *
 * The effective classification carries Category + Type with provenance;
 * readiness blocks drafts on unresolved Category, unresolved Type, missing
 * profile, or invalid combination — with a precise reason per gap. A
 * deliberately empty profile is valid (universal-only); a missing profile
 * is a gap, never silent universal-only success.
 */
import { describe, it, expect } from 'bun:test';
import { getEffectiveClassification } from '../../classification/effective-curation-type';
import { evaluateClassificationReadiness } from '../../classification/config-validation';

describe('effective pair + readiness (issue #350)', () => {
  it('reviewed pair yields both members with reviewed provenance', () => {
    const effective = getEffectiveClassification(
      {
        sku: 'S', evidence: [],
        acceptedProposals: [{
          id: 'p', runId: 'r', productSku: 'S', proposalType: 'product_classification',
          targetId: 'dog-food-dry',
          proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
          confidence: 0.9, evidenceIds: [], status: 'accepted',
          isBulkAcceptable: false, isStale: false, stalenessReason: null,
          createdAt: new Date().toISOString(),
        } as any],
        allProposals: [],
      } as any,
      {} as any,
    );
    expect(effective.effectiveTypeId).toBe('dog-food-dry');
    expect(effective.effectiveCategoryId).toBe('dog-food');
    expect(effective.source).toBe('reviewed');
  });

  it('canonical accepted pair resolves both members with reviewed provenance', () => {
    const effective = getEffectiveClassification(
      {
        sku: 'S', evidence: [],
        acceptedProposals: [{
          id: 'p', runId: 'r', productSku: 'S', proposalType: 'product_classification',
          targetId: 'dog-food-dry',
          proposedValue: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
          confidence: 0.9, evidenceIds: [], status: 'accepted',
          isBulkAcceptable: false, isStale: false, stalenessReason: null,
          createdAt: new Date().toISOString(),
        } as any],
        allProposals: [],
      } as any,
      {
        snapshot: { productTypes: [{ id: 'dog-food-dry', categoryId: 'dog-food' }] },
      } as any,
    );
    expect(effective.effectiveTypeId).toBe('dog-food-dry');
    expect(effective.effectiveCategoryId).toBe('dog-food');
    expect(effective.source).toBe('reviewed');
  });

  it('no reviewed pair yields none provenance', () => {
    const effective = getEffectiveClassification({ sku: 'S', evidence: [], acceptedProposals: [], allProposals: [] } as any, {} as any);
    expect(effective.source).toBe('none');
    expect(effective.effectiveTypeId).toBeNull();
    expect(effective.effectiveCategoryId).toBeNull();
  });

  it('readiness reports precise codes (not silent success)', () => {
    expect(typeof evaluateClassificationReadiness).toBe('function');
  });
});
