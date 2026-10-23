/**
 * Own-SKU canonical classification selection (ADR 0041, issues #351/#359).
 * Reviewed in-run decisions precede compatible frozen reviewed facts, which
 * precede the provisional pair produced in this pass. Selection never fills a
 * missing Category from a Type, nor borrows execution or sibling authority.
 * Pair/configuration validity belongs to attribute-profile-plan.
 */
import type { StageContext, StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getEffectiveClassificationPair, getCategoryIdFromValue, getProductTypeIdFromValue } from './assignment-projection';
import { selectClassificationProposal } from './proposal-selection';
import type { ClassificationProposal } from '../shared/types';
import { findRejectedProductClassificationProposal } from './reviewed-facts';

export type EffectiveTypeSource = 'reviewed' | 'provisional' | 'none';

export interface EffectiveCurationType {
  effectiveTypeId: string | null;
  source: EffectiveTypeSource;
}

export interface EffectiveClassification extends EffectiveCurationType {
  effectiveCategoryId: string | null;
}

function pairFromValue(value: unknown): { categoryId: string | null; productTypeId: string | null } {
  return {
    categoryId: getCategoryIdFromValue(value) || null,
    productTypeId: getProductTypeIdFromValue(value) || null,
  };
}

/** Frozen facts have already passed source/config provenance compatibility. */
export function getReviewedClassificationPair(
  snapshot: RuntimeClassificationSnapshot | undefined,
  currentRunProposals: readonly ClassificationProposal[] = [],
): { categoryId: string | null; productTypeId: string | null } {
  if (snapshot && findRejectedProductClassificationProposal(currentRunProposals, snapshot.productSku)) {
    return { categoryId: null, productTypeId: null };
  }
  const fact = snapshot?.reviewedFacts.find(candidate =>
    candidate.proposalType === 'product_classification'
    && candidate.productSku === snapshot.productSku
    && candidate.workspaceId === snapshot.workspaceId,
  );
  return pairFromValue(fact?.value);
}

export function getReviewedTypeFromSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
): string | null {
  return getReviewedClassificationPair(snapshot).productTypeId;
}

export function resolveEffectiveCurationType(reviewedTypeId: string | null): EffectiveCurationType {
  return reviewedTypeId
    ? { effectiveTypeId: reviewedTypeId, source: 'reviewed' }
    : { effectiveTypeId: null, source: 'none' };
}

export function getEffectiveCurationTypeForSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
): EffectiveCurationType {
  return resolveEffectiveCurationType(getReviewedTypeFromSnapshot(snapshot));
}

/** A reviewed unresolved/cleared pair cannot fall through to a pending guess. */
export function getEffectiveClassification(
  input: StageInput,
  context: StageContext,
): EffectiveClassification {
  const accepted = input.acceptedProposals.find(proposal =>
    proposal.proposalType === 'product_classification'
    && proposal.productSku === input.sku
    && proposal.runId === context.runId
    && proposal.status === 'accepted'
    && !proposal.isStale,
  );
  if (accepted) {
    const pair = getEffectiveClassificationPair(accepted);
    return { effectiveTypeId: pair.productTypeId, effectiveCategoryId: pair.categoryId, source: 'reviewed' };
  }
  const snapshot = context.snapshot;
  const currentRunProposals = input.allProposals.filter(proposal =>
    proposal.productSku === input.sku && proposal.runId === context.runId,
  );
  const hasRejectedPair = findRejectedProductClassificationProposal(currentRunProposals, input.sku) !== null;
  if (snapshot?.productSku === input.sku && snapshot.workspaceId === context.workspaceId && !hasRejectedPair) {
    const hasReviewedPair = snapshot.reviewedFacts.some(fact =>
      fact.proposalType === 'product_classification'
      && fact.productSku === input.sku
      && fact.workspaceId === context.workspaceId,
    );
    if (hasReviewedPair) {
      const pair = getReviewedClassificationPair(snapshot, currentRunProposals);
      return { effectiveTypeId: pair.productTypeId, effectiveCategoryId: pair.categoryId, source: 'reviewed' };
    }
  }
  const provisional = selectClassificationProposal({
    ...input,
    acceptedProposals: [],
    allProposals: currentRunProposals,
  }).proposal;
  if (provisional) {
    const pair = getEffectiveClassificationPair(provisional);
    return { effectiveTypeId: pair.productTypeId, effectiveCategoryId: pair.categoryId, source: 'provisional' };
  }
  return { effectiveTypeId: null, effectiveCategoryId: null, source: 'none' };
}

export function getEffectiveCurationProductType(
  input: StageInput,
  context: StageContext,
): EffectiveCurationType {
  const { effectiveTypeId, source } = getEffectiveClassification(input, context);
  return { effectiveTypeId, source };
}
