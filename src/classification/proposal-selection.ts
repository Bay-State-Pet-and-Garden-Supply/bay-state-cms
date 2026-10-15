/**
 * Proposal selection helpers for the classification pipeline.
 *
 * Selection is split into two distinct contracts:
 *
 * 1. ACCEPTED selection (`selectAcceptedClassification`) — the reviewed
 *    canonical Category + Product Type pair (`product_classification` ONLY;
 *    ADR 0041). The legacy `primary_product_type` kind is HISTORY ONLY and
 *    never confers live authority — explicit restart or reclassification is
 *    required. Pending guesses never unlock decision-eligible proposals.
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
 * Select the reviewed (accepted) canonical pair proposal (ADR 0041): the
 * `product_classification` kind ONLY. Legacy `primary_product_type` rows
 * are history-only and never confer live reviewed authority.
 * Pending/deferred guesses are never accepted selections.
 */
function selectAcceptedPrimaryProductType(input: StageInput): ProposalSelection {
  const pair = input.acceptedProposals.find(
    p => p.proposalType === 'product_classification' && p.status === 'accepted',
  );
  if (pair) return { proposal: pair, source: 'accepted' };
  return { proposal: null, source: null };
}


/**
 * Select the reviewed (accepted) canonical pair proposal (ADR 0041):
 * `product_classification` ONLY; legacy `primary_product_type` is
 * history-only. Pending guesses are never accepted selections.
 */
export function selectAcceptedClassification(input: StageInput): ProposalSelection {
  return selectAcceptedPrimaryProductType(input);
}
/**
 * The provisional (pending, unreviewed) canonical pair from the SAME
 * pipeline pass (issue #352): the highest-confidence non-stale
 * pending/deferred `product_classification` in `allProposals` (ADR 0041:
 * legacy `primary_product_type` is history-only, never provisional
 * authority). Own-SKU pipeline output only — never a parent, sibling,
 * or execution conclusion. Returns null ids when no provisional pair
 * exists; callers withhold pair-gated proposals then (fail closed).
 */
export function selectProvisionalClassification(
  input: StageInput,
): { categoryId: string | null; productTypeId: string | null } {
  const provisional = input.allProposals
    .filter(
      p =>
        p.proposalType === 'product_classification' &&
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
 * #350): accepted pair, then highest-confidence non-stale pending/deferred
 * pair. Legacy `primary_product_type` rows may surface here as history-only
 * preview context but never authorize gating. An accepted legacy type alone
 * is NOT preview authority — it requires reclassification first.
 */
export function selectClassificationProposal(input: StageInput): ProposalSelection {
  const accepted = selectAcceptedClassification(input);
  if (accepted.proposal) return accepted;
  // Preview may surface the highest-confidence pending canonical pair OR a
  // history-only legacy row for display context — but an accepted legacy
  // type alone is never returned here (it requires reclassification).
  // Neither branch authorizes gating; callers must use the accepted or
  // provisional selectors for authority.
  const pendingPair = input.allProposals
    .filter(
      p =>
        p.proposalType === 'product_classification' &&
        !p.isStale &&
        (p.status === 'pending' || p.status === 'deferred'),
    )
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (pendingPair) return { proposal: pendingPair, source: 'provisional' };
  return { proposal: null, source: null };
}

/**
 * Resolve the one reviewed canonical pair for a run (issue #350, ADR 0041):
 * in-run accepted `product_classification` proposals first, then
 * provenance-compatible reviewed facts of the canonical kind. Legacy
 * `primary_product_type` rows/facts are history-only and never confer live
 * reviewed authority. Returns null ids when no reviewed pair exists —
 * pair-gated proposals must then be withheld (fail closed).
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
      if (fact.proposalType !== 'product_classification') continue;
      const typeId = getProductTypeIdFromValue(fact.value);
      const categoryId = getCategoryIdFromValue(fact.value);
      if ((typeId && typeId.length > 0) || (categoryId && categoryId.length > 0)) {
        return { categoryId: categoryId && categoryId.length > 0 ? categoryId : null, productTypeId: typeId && typeId.length > 0 ? typeId : null };
      }
    }
  }
  return { categoryId: null, productTypeId: null };
}
