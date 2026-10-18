import type { ClassificationProposal } from '../shared/types';

/** Return the reviewed correction when present, including an explicit null. */
export function getEffectiveProposalValue(proposal: ClassificationProposal): unknown {
  return proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
}

/** Return the reviewed target when present; otherwise retain the immutable target. */
export function getEffectiveProposalTargetId(proposal: ClassificationProposal): string | null {
  return proposal.hasRevisedTargetId ? proposal.revisedTargetId ?? null : proposal.targetId;
}
