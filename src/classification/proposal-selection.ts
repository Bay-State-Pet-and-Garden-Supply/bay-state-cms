/**
 * Proposal selection helpers for the classification pipeline.
 *
 * Selection is split into two distinct contracts:
 *
 * 1. ACCEPTED selection (`selectAcceptedClassification`) — the reviewed
 *    canonical Category + Product Type pair (new `product_classification`
 *    kind first, then the legacy `primary_product_type` kind, which the
 *    historical-interpretation path reads as a pair via the frozen snapshot
 *    mapping). This is the ONLY authority that may unlock pair-gated
 *    attribute and Page proposals. Pending guesses never unlock
 *    decision-eligible proposals.
 * 2. PREVIEW selection (`selectClassificationProposal`) — the "best
 *    available" pair (accepted first, then highest-confidence pending)
 *    used ONLY for UI/draft preview. It never authorizes pair-gated
 *    proposals and never mutates proposal status.
 *
 * Reviewed facts carried from prior runs (via the immutable runtime snapshot)
 * are also a legitimate source for the accepted pair: a fact is accepted,
 * non-superseded, and provenance-compatible by construction of the snapshot.
 */
import type { StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { ClassificationProposal } from '../shared/schemas/classification';
import { getCategoryIdFromValue, getEffectivePrimaryProductTypeId, getProductTypeIdFromValue } from './assignment-projection';

export interface ProposalSelection {
  /** The selected proposal, or null if none available */
  proposal: ClassificationProposal | null;
  /** How the proposal was selected */
  source: 'accepted' | 'provisional' | null;
}

/**
 * Select the reviewed (accepted) canonical pair proposal: the new
 * `product_classification` kind first, then the legacy
 * `primary_product_type` kind, which the historical-interpretation path
 * reads as a pair through the frozen snapshot mapping.
 * Pending/deferred guesses are never accepted selections.
 */
function selectAcceptedPrimaryProductType(input: StageInput): ProposalSelection {
  const pair = input.acceptedProposals.find(
    p => p.proposalType === 'product_classification' && p.status === 'accepted',
  );
  if (pair) return { proposal: pair, source: 'accepted' };
  const legacy = input.acceptedProposals.find(
    p => p.proposalType === 'primary_product_type' && p.status === 'accepted',
  );
  if (legacy) return { proposal: legacy, source: 'accepted' };
  return { proposal: null, source: null };
}


/**
 * Select the reviewed (accepted) canonical pair proposal: the new
 * `product_classification` kind first, then the legacy
 * `primary_product_type` kind for historical in-flight runs. Pending guesses
 * are never accepted selections.
 */
export function selectAcceptedClassification(input: StageInput): ProposalSelection {
  return selectAcceptedPrimaryProductType(input);
}
/**
 * The provisional (pending, unreviewed) canonical pair from the SAME
 * pipeline pass (issue #352): the highest-confidence non-stale
 * pending/deferred `product_classification` (then legacy type) in
 * `allProposals`. Own-SKU pipeline output only — never a parent, sibling,
 * or execution conclusion. Returns null ids when no provisional pair
 * exists; callers withhold pair-gated proposals then (fail closed).
 */
export function selectProvisionalClassification(
  input: StageInput,
): { categoryId: string | null; productTypeId: string | null } {
  const provisional = input.allProposals
    .filter(
      p =>
        (p.proposalType === 'product_classification' || p.proposalType === 'primary_product_type') &&
        !p.isStale &&
        (p.status === 'pending' || p.status === 'deferred'),
    )
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (!provisional) return { categoryId: null, productTypeId: null };
  const proposal = provisional as { proposedValue?: unknown; revisedValue?: unknown; hasRevisedValue?: boolean; targetId?: string | null };
  const value = proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const typeId = getProductTypeIdFromValue(value) ?? (typeof proposal.targetId === 'string' ? proposal.targetId : null);
  const categoryId = getCategoryIdFromValue(value);
  return {
    categoryId: categoryId && categoryId.length > 0 ? categoryId : null,
    productTypeId: typeId && typeId.length > 0 ? typeId : null,
  };
}

/**
 * Best available canonical pair proposal for UI/draft preview only (issue
 * #350): accepted pair, then accepted legacy type, then highest-confidence
 * non-stale pending/deferred pair or legacy type. Never authorizes gating.
 */
export function selectClassificationProposal(input: StageInput): ProposalSelection {
  const accepted = selectAcceptedClassification(input);
  if (accepted.proposal) return accepted;
  const provisional = input.allProposals
    .filter(
      p =>
        (p.proposalType === 'product_classification' || p.proposalType === 'primary_product_type') &&
        !p.isStale &&
        (p.status === 'pending' || p.status === 'deferred'),
    )
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (provisional) return { proposal: provisional, source: 'provisional' };
  return { proposal: null, source: null };
}

/**
 * Resolve the one reviewed canonical pair for a run (issue #350): in-run
 * accepted pair proposals first (new kind, then legacy type kind), then
 * provenance-compatible reviewed facts. Returns null ids when no reviewed
 * pair exists — pair-gated proposals must then be withheld (fail closed).
 */
export function getReviewedClassification(
  input: StageInput,
  snapshot?: RuntimeClassificationSnapshot,
): { categoryId: string | null; productTypeId: string | null } {
  const accepted = selectAcceptedClassification(input);
  if (accepted.proposal) {
    const typeId = getEffectivePrimaryProductTypeId(accepted.proposal);
    const categoryId = getCategoryIdFromValue(
      accepted.proposal.hasRevisedValue ? accepted.proposal.revisedValue : accepted.proposal.proposedValue,
    );
    if ((typeId && typeId.length > 0) || (categoryId && categoryId.length > 0)) {
      return { categoryId: categoryId && categoryId.length > 0 ? categoryId : null, productTypeId: typeId && typeId.length > 0 ? typeId : null };
    }
  }
  if (snapshot?.reviewedFacts?.length) {
    for (const fact of snapshot.reviewedFacts) {
      if (fact.proposalType !== 'product_classification' && fact.proposalType !== 'primary_product_type') continue;
      const typeId = getProductTypeIdFromValue(fact.value);
      const categoryId = getCategoryIdFromValue(fact.value);
      if ((typeId && typeId.length > 0) || (categoryId && categoryId.length > 0)) {
        return { categoryId: categoryId && categoryId.length > 0 ? categoryId : null, productTypeId: typeId && typeId.length > 0 ? typeId : null };
      }
    }
  }
  return { categoryId: null, productTypeId: null };
}
