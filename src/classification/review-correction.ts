import type { ClassificationProposal } from '../shared/types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import { getProductTypeIdFromValue } from './assignment-projection';

export interface ReviewCorrection {
  hasRevisedValue: boolean;
  revisedValue?: unknown;
  hasRevisedTargetId: boolean;
  revisedTargetId?: string | null;
}

/** Shared HTTP/CLI frozen-membership guard. Historical rows remain readable, not correctable without their authority. */
export function validateFrozenReviewCorrection(proposal: ClassificationProposal, correction: ReviewCorrection, snapshot: RuntimeClassificationSnapshot | null): ReviewCorrection {
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
