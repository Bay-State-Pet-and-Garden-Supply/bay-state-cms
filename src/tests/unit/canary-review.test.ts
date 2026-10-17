import { describe, expect, it } from 'vitest';
import { hasUnconfirmedAgentDecisions, makeCanaryDecision, parseCanaryCorrection, summarizeCanaryReview, type CanaryReviewItem } from '../../onboarding/canary-review';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { validateFrozenReviewCorrection } from '../../classification/review-correction';
import type { ClassificationProposal, ClassificationProposalDecision } from '../../shared/types';

function reviewedItem(): CanaryReviewItem {
  const proposals = ['product_classification', 'field_assignment', 'category_page'].map((proposalType, i) => ({
    id: `p${i}`, runId: 'run', productSku: 'SKU', proposalType, targetId: 'target',
    proposedValue: 'value', confidence: 0.9, evidenceIds: [], status: 'accepted',
    isBulkAcceptable: false, isStale: false, stalenessReason: null,
    currentDecisionId: `d${i}`, createdAt: '2026-10-02T00:00:00.000Z',
  } as ClassificationProposal));
  return {
    itemId: 'item', runId: 'run', cohortRunId: 'cohort', snapshotHash: 'hash', proposals,
    decisions: proposals.map((p, i) => ({
      id: `d${i}`, proposalId: p.id, decision: 'accepted', reviewerId: 'nick',
      decisionOrigin: 'human_review', supersededAt: null,
    } as ClassificationProposalDecision)),
  };
}

describe('canary review authority', () => {
  it('accepts a corrected attribute without clearing its target and binds the predecessor', () => {
    const proposal = reviewedItem().proposals[1];
    const decision = makeCanaryDecision({ proposal, action: 'correct', reviewer: 'nick', revisedValue: ['Chicken', 'Beef'] });
    expect(decision.decision).toBe('accepted');
    expect(decision.revisedValue).toEqual(['Chicken', 'Beef']);
    expect(decision).not.toHaveProperty('revisedTargetId');
    expect(decision.expectedRevisionId).toBe('d1');
  });

  it('cannot certify an empty queue or an item without a validated run', () => {
    expect(summarizeCanaryReview([]).productTypeReviewed).toBe(false);
    expect(summarizeCanaryReview([{ ...reviewedItem(), runId: null }]).attributesReviewed).toBe(false);
    expect(summarizeCanaryReview([{ ...reviewedItem(), proposals: [] }]).cohortPagesReviewed).toBe(false);
  });

  it('requires attributed live human decisions, including explicit abstention review', () => {
    const item = reviewedItem();
    expect(summarizeCanaryReview([item]).cohortPagesReviewed).toBe(true);
    item.decisions[1].decisionOrigin = 'agent_review';
    expect(summarizeCanaryReview([item]).attributesReviewed).toBe(false);
    item.decisions[0].reviewerId = null;
    expect(summarizeCanaryReview([item]).productTypeReviewed).toBe(false);
    item.proposals[2] = { ...item.proposals[2], proposalType: 'reviewable_abstention', targetId: 'category_page_proposals', status: 'pending' };
    expect(summarizeCanaryReview([item]).pagesReviewed).toBe(false);
  });

  it('does not label individually reviewed singleton pages as a cohort canary', () => {
    const item = { ...reviewedItem(), cohortRunId: null };
    expect(summarizeCanaryReview([item]).pagesReviewed).toBe(true);
    expect(summarizeCanaryReview([item]).cohortPagesReviewed).toBe(false);
  });

  it('requires human confirmation of agent decisions before final item review', () => {
    const item = reviewedItem();
    expect(hasUnconfirmedAgentDecisions(item.proposals, item.decisions)).toBe(false);
    item.decisions[1].decisionOrigin = 'agent_review';
    expect(hasUnconfirmedAgentDecisions(item.proposals, item.decisions)).toBe(true);
    item.decisions[1].supersededAt = '2026-10-02T01:00:00.000Z';
    expect(hasUnconfirmedAgentDecisions(item.proposals, item.decisions)).toBe(false);
  });

  it('corrects a page by its frozen identity and rejects ambiguous or invented names', () => {
    const page = reviewedItem().proposals[2];
    const snapshot = { pages: { state: 'verified', records: [{ pageId: 'dog-dry', pageName: 'Dog Food Dry' }] } } as RuntimeClassificationSnapshot;
    expect(parseCanaryCorrection(page, 'Dog Food Dry', snapshot)).toEqual({ revisedValue: { pageId: 'dog-dry', pageName: 'Dog Food Dry', identityVerified: true }, revisedTargetId: 'dog-dry' });
    expect(() => parseCanaryCorrection(page, 'Invented Page', snapshot)).toThrow('verified Page');
    expect(() => parseCanaryCorrection(page, 'Dog Food Dry', null)).toThrow('frozen taxonomy');
  });

  it('guards the HTTP correction boundary with the same verified page and controlled-value membership', () => {
    const snapshot = { pages: { state: 'verified', records: [{ pageId: 'dog-dry', pageName: 'Dog Food Dry' }] },
      attributes: [{ id: 'flavor', valueMode: 'controlled', allowedValues: ['Chicken'] }], curationTargets: [], fieldOptions: {} } as unknown as RuntimeClassificationSnapshot;
    const correction = { hasRevisedValue: true, revisedValue: { pageId: 'invented', pageName: 'Invented Page' }, hasRevisedTargetId: false };
    expect(() => validateFrozenReviewCorrection(reviewedItem().proposals[2], correction, snapshot)).toThrow('verified identity');
    expect(() => validateFrozenReviewCorrection({ ...reviewedItem().proposals[1], targetId: 'flavor' },
      { ...correction, revisedValue: 'Unconfigured' }, snapshot)).toThrow('configured controlled');
    expect(validateFrozenReviewCorrection(reviewedItem().proposals[2], { ...correction, revisedValue: 'Dog Food Dry' }, snapshot).revisedTargetId).toBe('dog-dry');
  });

  it('validates both the field identity and carried value when only its target changes', () => {
    const snapshot = { attributes: [{ id: 'flavor', valueMode: 'controlled', allowedValues: ['Chicken'] }],
      curationTargets: [], fieldOptions: {} } as unknown as RuntimeClassificationSnapshot;
    const proposal = { ...reviewedItem().proposals[1], targetId: 'flavor', proposedValue: 'Chicken' };
    const correction = { hasRevisedValue: false, hasRevisedTargetId: true, revisedTargetId: 'unconfigured' };
    expect(() => validateFrozenReviewCorrection({ ...proposal, targetId: 'brand' },
      { ...correction, revisedTargetId: 'flavor' }, snapshot)).toThrow(/protected target/);
    expect(() => validateFrozenReviewCorrection(proposal, correction, snapshot)).toThrow(/protected target/);
    expect(validateFrozenReviewCorrection(proposal, { ...correction, revisedTargetId: 'flavor' }, snapshot).revisedTargetId).toBe('flavor');
    expect(() => validateFrozenReviewCorrection({ ...proposal, proposedValue: 'Acme' },
      { ...correction, revisedTargetId: 'flavor' }, snapshot)).toThrow('configured controlled');
    expect(validateFrozenReviewCorrection(proposal, { ...correction, revisedTargetId: null }, snapshot).revisedTargetId).toBeNull();
  });
});
