/**
 * Spec reconciliation finding 1 (RED): legacy `primary_product_type` kind
 * must be readable for HISTORY ONLY — never live reviewed, provisional, or
 * invalidation authority (ADR 0041: no parallel granular internal type; no
 * permanent old/new execution path).
 *
 * Legacy rows still exist in historical runs, but only the canonical
 * `product_classification` pair may drive reviewed facts, provisional
 * selection, or dependent invalidation. A legacy kind requires an explicit
 * restart or reclassification before it can confer authority again.
 */
import { describe, it, expect } from 'bun:test';
import { getReviewedClassification, selectProvisionalClassification } from '../../classification/proposal-selection';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import type { StageInput } from '../../classification/types';
import type { ReviewedFact } from '../../classification/reviewed-facts';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';

function legacyProposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'legacy-1', runId: 'r', productSku: 'S', proposalType: 'primary_product_type',
    targetId: 'dog-food-dry', proposedValue: { productTypeId: 'dog-food-dry' },
    confidence: 0.9, evidenceIds: [], status: 'accepted',
    isBulkAcceptable: false, isStale: false, stalenessReason: null,
    createdAt: new Date().toISOString(), ...overrides,
  } satisfies ClassificationProposal;
}

function stageInput(proposals: Partial<Pick<StageInput, 'acceptedProposals' | 'allProposals'>>): StageInput {
  return {
    sku: 'S', evidence: [],
    acceptedProposals: [], allProposals: [],
    ...proposals,
  } satisfies StageInput;
}

describe('legacy primary_product_type confers no live authority (spec finding 1)', () => {
  it('an accepted legacy proposal is not a reviewed classification', () => {
    const reviewed = getReviewedClassification(stageInput({ acceptedProposals: [legacyProposal()] }), undefined);
    expect(reviewed.productTypeId).toBeNull();
    expect(reviewed.categoryId).toBeNull();
  });

  it('a pending legacy proposal is not a provisional classification', () => {
    const provisional = selectProvisionalClassification(
      stageInput({ allProposals: [legacyProposal({ status: 'pending' })] }),
    );
    expect(provisional.productTypeId).toBeNull();
    expect(provisional.categoryId).toBeNull();
  });

  it('a legacy reviewed fact is not a reviewed classification', () => {
    const fact: ReviewedFact = {
      proposalId: 'p1', decisionId: 'd1', runId: 'r1', workspaceId: 'ws', productSku: 'S',
      proposalType: 'primary_product_type', targetId: 'dog-food-dry',
      value: { productTypeId: 'dog-food-dry' },
      configSnapshotHash: 'cfg', sourceHash: 'src', createdAt: '2026-08-01T00:00:00.000Z',
    };
    const snapshot = { reviewedFacts: [fact] } as RuntimeClassificationSnapshot;
    const reviewed = getReviewedClassification(stageInput({}), snapshot);
    expect(reviewed.productTypeId).toBeNull();
    expect(reviewed.categoryId).toBeNull();
  });
});
