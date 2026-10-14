import type { ClassificationProposal } from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getCategoryIdFromValue, getProductTypeIdFromValue } from './assignment-projection';
import { isProtectedTargetId, protectedTargetRefusal } from './classification-ownership';
import { INVALID_CLASSIFICATION_PAIR_CODE, isApprovedClassificationPair } from './product-classification';
export interface ReviewCorrection {
  hasRevisedValue: boolean;
  revisedValue?: unknown;
  hasRevisedTargetId: boolean;
  revisedTargetId?: string | null;
}

/** Shared HTTP/CLI frozen-membership guard. Historical rows remain readable, not correctable without their authority. */
export function validateFrozenReviewCorrection(proposal: ClassificationProposal, correction: ReviewCorrection, snapshot: RuntimeClassificationSnapshot | null): ReviewCorrection {
  // ADR 0041 / issue #349: a revised target or historical Brand proposal can
  // never authorize a protected write. Accepted (or corrected) decisions on
  // protected targets refuse attributably instead of applying or silently
  // rerouting. Rejections/deferrals carry no write authority and pass.
  if (proposal.proposalType === 'field_assignment' && (correction.hasRevisedValue || correction.hasRevisedTargetId)) {
    const effectiveTarget = correction.hasRevisedTargetId ? correction.revisedTargetId : proposal.targetId;
    const originalProtected = isProtectedTargetId(proposal.targetId);
    if (originalProtected || isProtectedTargetId(effectiveTarget)) {
      throw new Error(protectedTargetRefusal(effectiveTarget ?? proposal.targetId).reason);
    }
  }
  if (!correction.hasRevisedValue && !correction.hasRevisedTargetId) return correction;
  if (!snapshot) throw new Error('Frozen runtime snapshot is required to validate a correction.');
  if (proposal.proposalType === 'field_assignment' && correction.hasRevisedTargetId && correction.revisedTargetId === null) {
    if (correction.hasRevisedValue && correction.revisedValue !== null) throw new Error('A cleared field target cannot assign a value.');
    return correction;
  }
  // Explicit removal is supported. It assigns no new controlled value/page;
  // mandatory-field and promotion gates still reject an incomplete listing.
  if (correction.hasRevisedValue && correction.revisedValue === null) {
    if (proposal.proposalType === 'category_page') return { hasRevisedValue: true, revisedValue: null, hasRevisedTargetId: true, revisedTargetId: null };
    if (proposal.proposalType === 'field_assignment' && !snapshot.attributes.some(attribute => attribute.id === (correction.hasRevisedTargetId ? correction.revisedTargetId : proposal.targetId))) throw new Error('Cleared field is not configured in the frozen taxonomy.');
    return correction;
  }
  if (proposal.proposalType === 'primary_product_type') {
    const id = correction.hasRevisedTargetId ? correction.revisedTargetId : getProductTypeIdFromValue(correction.revisedValue);
    if (id != null && !snapshot.productTypes.some(type => type.id === id)) throw new Error('Corrected Product Type is not in the run’s frozen configured options.');
    return correction;
  }
  if (proposal.proposalType === 'product_classification') {
    return validateClassificationCorrection(proposal, correction, snapshot);
  }
  if (proposal.proposalType === 'category_page') {
    const value = correction.hasRevisedValue ? correction.revisedValue : null;
    const record = typeof value === 'object' && value !== null ? value as { pageId?: string; pageName?: string } : null;
    const id = correction.hasRevisedTargetId ? correction.revisedTargetId : record?.pageId;
    if (correction.hasRevisedTargetId && record?.pageId && id !== record.pageId) throw new Error('Corrected Page target and value have different IDs.');
    const name = typeof value === 'string' ? value : record?.pageName;
    const pages = snapshot.pages.state === 'verified' ? snapshot.pages.records : [];
    const matches = pages.filter(page => id ? page.pageId === id && (!name || page.pageName === name) : page.pageName === name);
    if (matches.length !== 1) throw new Error('Corrected Category Page is not a unique verified identity in the run’s frozen page catalog.');
    return { hasRevisedValue: true, hasRevisedTargetId: true,
      revisedValue: { ...(record ?? {}), pageId: matches[0].pageId, pageName: matches[0].pageName, identityVerified: true }, revisedTargetId: matches[0].pageId };
  }
  if (proposal.proposalType !== 'field_assignment') return correction;
  const id = correction.hasRevisedTargetId ? correction.revisedTargetId : proposal.targetId;
  const attribute = snapshot.attributes.find(attribute => attribute.id === id);
  if (!attribute) throw new Error('Corrected field is not configured in the run’s frozen taxonomy.');
  const value = correction.hasRevisedValue ? correction.revisedValue
    : proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const values = Array.isArray(value) ? value : [value];
  if (Array.isArray(proposal.proposedValue) !== Array.isArray(value)) throw new Error('Correction changes the frozen proposal’s field cardinality.');
  if (attribute.valueMode === 'controlled') {
    const target = snapshot.curationTargets.find(target => target.attributeId === attribute.id);
    const allowed = target ? snapshot.fieldOptions[target.id]?.map(option => option.label) ?? attribute.allowedValues : attribute.allowedValues;
    if (!values.length || values.some(value => typeof value !== 'string' || !allowed.includes(value))) throw new Error('Corrected value is not a configured controlled option.');
  }
  return correction;
}

/**
 * Validate a correction to the canonical pair through the same validated
 * model (issue #350). The corrected pair must be an approved configured
 * combination; corrections to either member invalidate dependents identically
 * (invalidation is owned by the review service reading the pair kind).
 * A legacy type-only correction resolves its category through the approved
 * mapping — an unmapped type is a configuration gap, never silent invention.
 */
export function validateClassificationCorrection(
  proposal: ClassificationProposal,
  correction: ReviewCorrection,
  snapshot: Pick<RuntimeClassificationSnapshot, 'productTypes' | 'categories'>,
): ReviewCorrection {
  if (proposal.proposalType === 'primary_product_type' && !correction.hasRevisedValue && correction.hasRevisedTargetId) {
    const typeId = correction.revisedTargetId;
    if (typeId) {
      const type = snapshot.productTypes.find(candidate => candidate.id === typeId);
      if (!type) throw new Error('Corrected Product Type is not in the run’s frozen configured options.');
      const categoryId = (type as { categoryId?: string | null }).categoryId ?? null;
      if (!categoryId) throw new Error(`Product Type "${typeId}" has no approved Category mapping (${INVALID_CLASSIFICATION_PAIR_CODE}:unmapped).`);
      return {
        hasRevisedValue: true,
        revisedValue: { categoryId, productTypeId: typeId },
        hasRevisedTargetId: true,
        revisedTargetId: typeId,
      };
    }
    return correction;
  }
  const value = correction.hasRevisedValue ? correction.revisedValue
    : proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const categoryId = getCategoryIdFromValue(value);
  const productTypeId = correction.hasRevisedTargetId && !correction.hasRevisedValue
    ? correction.revisedTargetId
    : getProductTypeIdFromValue(value);
  if (!categoryId || !productTypeId) {
    throw new Error(`${INVALID_CLASSIFICATION_PAIR_CODE}: corrected classification must address both Category and Product Type.`);
  }
  if (!isApprovedClassificationPair({ categoryId, productTypeId }, snapshot)) {
    throw new Error(`${INVALID_CLASSIFICATION_PAIR_CODE}: "${categoryId}" + "${productTypeId}" is not an approved configured combination.`);
  }
  return {
    hasRevisedValue: true,
    revisedValue: { categoryId, productTypeId },
    hasRevisedTargetId: true,
    revisedTargetId: productTypeId,
  };
}
