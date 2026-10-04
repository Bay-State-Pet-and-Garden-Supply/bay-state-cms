import type { ClassificationProposal, ClassificationProposalDecision } from '../shared/types';
import type { ProposalReviewInput } from '../classification/proposal-review-service';
import type { RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';

export type CanaryReviewAction = 'accept' | 'reject' | 'correct' | 'defer';

export function parseCanaryCorrection(proposal: ClassificationProposal, text: string, snapshot: RuntimeClassificationSnapshot | null): {
  revisedValue: unknown; revisedTargetId?: string;
} {
  if (!snapshot) throw new Error('A frozen taxonomy/catalog is required to validate a correction.');
  if (proposal.proposalType === 'primary_product_type') {
    if (!snapshot.productTypes.some(type => type.id === text)) throw new Error('Select an existing frozen Product Type ID.');
    return { revisedValue: { productTypeId: text }, revisedTargetId: text };
  }
  if (proposal.proposalType === 'category_page') {
    const pages = snapshot.pages.state === 'verified' ? snapshot.pages.records : [];
    const matches = pages.filter(page => page.pageId === text || page.pageName === text);
    if (matches.length !== 1) throw new Error('Select one verified Page ID or an unambiguous exact page name.');
    return { revisedValue: { pageId: matches[0].pageId, pageName: matches[0].pageName, identityVerified: true }, revisedTargetId: matches[0].pageId };
  }
  if (proposal.proposalType !== 'field_assignment') throw new Error('Review an abstention as accepted, rejected or deferred; it is not an assignable field.');
  let revisedValue: unknown = text;
  if (Array.isArray(proposal.proposedValue)) {
    try { revisedValue = JSON.parse(text); } catch { throw new Error('Use a JSON array for this multi-value field.'); }
  }
  const attribute = snapshot.attributes.find(attribute => attribute.id === proposal.targetId);
  if (!attribute) throw new Error('The field is not configured in this run’s frozen taxonomy.');
  if (attribute.valueMode === 'controlled') {
    const target = snapshot.curationTargets.find(target => target.attributeId === attribute.id);
    const allowed = target ? snapshot.fieldOptions[target.id]?.map(option => option.label) ?? attribute.allowedValues : attribute.allowedValues;
    const values = Array.isArray(revisedValue) ? revisedValue : [revisedValue];
    if (!values.length || values.some(value => typeof value !== 'string' || !allowed.includes(value))) throw new Error('Use only the field’s configured controlled values.');
    if (Array.isArray(proposal.proposedValue) !== Array.isArray(revisedValue)) throw new Error('Keep the frozen field cardinality (JSON array for a multi-value field).');
  }
  return { revisedValue };
}

/** Corrections accept the corrected value; field corrections never clear their target. */
export function makeCanaryDecision(input: {
  proposal: ClassificationProposal; action: CanaryReviewAction; reviewer: string;
  note?: string; revisedValue?: unknown; revisedTargetId?: string | null;
}): ProposalReviewInput['decisions'][number] {
  if (!input.reviewer.trim()) throw new Error('A reviewer identity is required.');
  if (input.action === 'correct' && input.revisedValue === undefined) throw new Error('A correction requires a revised value.');
  return {
    proposalId: input.proposal.id,
    decision: input.action === 'reject' ? 'rejected' : input.action === 'defer' ? 'deferred' : 'accepted',
    reviewerId: input.reviewer.trim(),
    reviewerNote: input.note?.trim() || null,
    expectedRevisionId: input.proposal.currentDecisionId ?? null,
    actionToken: crypto.randomUUID(),
    ...(input.action === 'correct' || (input.action === 'accept' && input.proposal.hasRevisedValue) ? {
      revisedValue: input.action === 'correct' ? input.revisedValue : input.proposal.revisedValue,
      ...(input.revisedTargetId !== undefined ? { revisedTargetId: input.revisedTargetId } : {}),
    } : {}),
    ...(input.action === 'accept' && input.proposal.hasRevisedTargetId ? { revisedTargetId: input.proposal.revisedTargetId } : {}),
  };
}

export interface CanaryReviewItem {
  itemId: string;
  runId: string | null;
  cohortRunId: string | null;
  snapshotHash: string | null;
  proposals: ClassificationProposal[];
  decisions: ClassificationProposalDecision[];
}

const stages = {
  productType: { proposal: 'primary_product_type', abstention: 'primary_product_type_proposal' },
  attributes: { proposal: 'field_assignment', abstention: 'product_attribute_proposals' },
  pages: { proposal: 'category_page', abstention: 'category_page_proposals' },
} as const;

export function hasUnconfirmedAgentDecisions(proposals: ClassificationProposal[], decisions: ClassificationProposalDecision[]): boolean {
  const agentIds = new Set(decisions.filter(decision => decision.decisionOrigin === 'agent_review' && decision.supersededAt == null).map(decision => decision.id));
  return proposals.some(proposal => proposal.currentDecisionId && agentIds.has(proposal.currentDecisionId));
}

/** Absence, stale proposals, agent decisions and deferred abstentions cannot certify human review. */
export function summarizeCanaryReview(items: CanaryReviewItem[]) {
  const stageReviewed = (stage: keyof typeof stages): boolean => {
    if (items.length === 0) return false;
    return items.every(item => {
      if (!item.runId || !item.snapshotHash) return false;
      const relevant = item.proposals.filter(p => p.proposalType === stages[stage].proposal
        || (p.proposalType === 'reviewable_abstention' && (p.targetId === stages[stage].abstention
          || (stage === 'attributes' && typeof (p.proposedValue as { attributeId?: unknown } | null)?.attributeId === 'string'))));
      if (relevant.length === 0) return false;
      return relevant.every(proposal => {
        if (proposal.isStale || !['accepted', 'rejected'].includes(proposal.status)) return false;
        return item.decisions.some(decision => decision.proposalId === proposal.id
          && decision.id === proposal.currentDecisionId
          && decision.supersededAt == null
          && decision.decisionOrigin === 'human_review'
          && Boolean(decision.reviewerId?.trim())
          && ['accepted', 'rejected'].includes(decision.decision));
      });
    });
  };
  const pagesReviewed = stageReviewed('pages');
  const hasReviewedCohort = items.some(item => Boolean(item.cohortRunId)
    && item.proposals.some(p => p.proposalType === 'category_page'));
  return {
    productTypeReviewed: stageReviewed('productType'),
    attributesReviewed: stageReviewed('attributes'),
    pagesReviewed,
    cohortPagesReviewed: pagesReviewed && hasReviewedCohort,
    runs: items.map(({ itemId, runId, cohortRunId, snapshotHash, decisions }) => ({
      itemId, runId, cohortRunId, snapshotHash,
      decisions: decisions.map(d => ({ id: d.id, proposalId: d.proposalId, reviewerId: d.reviewerId, origin: d.decisionOrigin })),
    })),
  };
}
