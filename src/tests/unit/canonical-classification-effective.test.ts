/**
 * Issue #350 — own-SKU classification pair selection.
 *
 * Reviewed in-run decisions and compatible frozen facts precede provisional
 * output; missing execution identity is never borrowed.
 */
import { describe, it, expect } from 'bun:test';
import { getEffectiveClassification } from '../../classification/effective-curation-type';

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
      { runId: 'r', workspaceId: 'ws' } as any,
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
        runId: 'later-run',
        workspaceId: 'ws',
        snapshot: {
          productSku: 'S',
          workspaceId: 'ws',
          reviewedFacts: [{
            proposalType: 'product_classification',
            productSku: 'S',
            workspaceId: 'ws',
            value: { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
          }],
        },
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

});
