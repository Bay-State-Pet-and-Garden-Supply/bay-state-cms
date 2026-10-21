import { describe, expect, it } from 'bun:test';
import type { AcceptedItemEvidence, ListingCompletenessException, ListingCompletenessStandard } from '../../shared/schemas/item-evidence';
import { evaluateItemChecklist } from '../../classification/item-checklist';
import { evaluateListingCompletenessGate } from '../../classification/listing-evidence-gate';
import { hashAcceptedEvidenceBundle } from '../../classification/listing-evidence';
const hash = 'a'.repeat(64);
const evidence: AcceptedItemEvidence = {
  recordVersion: 1, id: 'snapshot-1', workspaceId: 'workspace-1', batchId: 'batch-1', itemId: 'item-1', sku: '000111',
  revision: 1, inputHash: hash, sourceStateHash: hash, authorityHash: hash, registerName: 'Sample', importedPrice: null,
  observations: [{
    id: 'observation-1', sourceRole: 'manufacturer_official', collectedVia: 'static_extraction', authorityId: 'brand-site',
    authorityHash: hash, sourceUrl: 'https://example.com/item', finalUrl: 'https://example.com/item', connectorRecordId: null,
    generationId: null, observedAt: '2026-01-01T00:00:00Z', expiresAt: null, contentType: 'text/plain', content: 'Sample details',
    artifactHash: hash, complete: true, identity: { itemId: 'item-1', sku: '000111', inputHash: hash, outcome: 'confirmed',
      proofType: 'gtin', proofHash: hash, variantKey: null, attestationId: null, reasons: [] }, modelCallIds: [],
  }],
  facts: [{ id: 'fact-1', field: 'care', value: 'Hand wash', unit: null, observationId: 'observation-1',
    reference: { kind: 'text_span', start: 0, end: 6 }, rawValue: 'Hand wash', normalization: 'verbatim', valueHash: hash, rights: null }],
  submittedFactReferences: [], findings: [], evidenceHash: hash, rulesVersion: '1', producingRunId: null, acceptedAt: '2026-01-01T00:00:00Z',
};

function standard(requirements: ListingCompletenessStandard['requirements']): ListingCompletenessStandard {
  return { recordVersion: 1, id: 'standard-1', revision: 1, categoryId: 'home', productTypeId: 'cloth', requirements,
    standardHash: hash, approvedBy: 'approver', approvedAt: '2026-01-01T00:00:00Z' };
}
function input(standardValue: ListingCompletenessStandard | null, exceptions: ListingCompletenessException[] = [], listing: Record<string, unknown> = {}) {
  return { workspaceId: 'workspace-1', itemId: 'item-1', sku: '000111', classification: { categoryId: 'home', productTypeId: 'cloth' },
    listing, evidence, standard: standardValue, exceptions, inputHash: hash, listingHash: hash, classificationHash: hash };
}
function requirement(overrides: Partial<ListingCompletenessStandard['requirements'][number]> = {}) {
  return { id: 'care', field: 'care', label: 'Care instructions', kind: 'field' as const, required: true, exceptionEligible: true,
    allowedSourceRoles: ['manufacturer_official' as const], applicableWhen: null, ...overrides };
}
function omission(decision: 'approved' | 'revoked', revision: number, overrides: Partial<ListingCompletenessException> = {}): ListingCompletenessException {
  return { id: `receipt-${revision}`, receiptId: `receipt-${revision}`, revision, workspaceId: 'workspace-1', itemId: 'item-1', sku: '000111',
    requirementId: 'care', standardId: 'standard-1', standardHash: hash, classificationHash: hash, inputHash: hash, dependencyHash: hash,
    decision, reason: 'Not supplied', actor: 'approver', decidedAt: '2026-01-01T00:00:00Z', actionToken: `action-${revision}`, ...overrides };
}

describe('item listing completeness evaluation', () => {
  it('fails closed when the matching approved classification standard is missing', () => {
    expect(evaluateItemChecklist(input(null)).status).toBe('unavailable');
    expect(evaluateItemChecklist(input(null)).requirements).toEqual([]);
    expect(evaluateListingCompletenessGate(evaluateItemChecklist(input(null)))).toMatchObject({ ok: false, code: 'listing_completeness_unavailable' });
  });
  it('emits hard acquisition guidance without treating evidence absence as release readiness', () => {
    const policy = standard([requirement({ id: 'safety', field: 'safety', kind: 'safety', required: false, exceptionEligible: true })]);
    const result = evaluateItemChecklist({ ...input(policy), evidence: null, allowMissingEvidence: true });
    expect(result).toMatchObject({
      status: 'needs_attention', evidenceHash: null,
      requirements: [{ required: true, exceptionEligible: false, state: 'missing' }],
    });
  });

  it('binds the claim bundle to the exact accepted snapshot hash', () => {
    expect(hashAcceptedEvidenceBundle('a'.repeat(64), [])).not.toBe(hashAcceptedEvidenceBundle('b'.repeat(64), []));
  });


  it('does not let a policy/client flag waive classification-required catalog fields', () => {
    const policy = standard([requirement({ field: 'required_catalog_field' })]);
    const protectedFields = ['required_catalog_field'];
    const base = evaluateItemChecklist({ ...input(policy), nonWaivableFields: protectedFields });
    const result = evaluateItemChecklist({ ...input(policy, [omission('approved', 1, { dependencyHash: base.requirements[0]!.dependencyHash! })]),
      nonWaivableFields: protectedFields });
    expect(result.requirements[0]).toMatchObject({ required: true, exceptionEligible: false, state: 'missing' });
  });

  it('does not allow policy conditions to make required safety inapplicable', () => {
    const conditionFact = { id: 'fact-condition', field: 'availability', value: 'not-applicable', unit: null, observationId: 'observation-1',
      reference: { kind: 'text_span' as const, start: 0, end: 6 }, rawValue: 'not-applicable', normalization: 'verbatim' as const, valueHash: hash, rights: null };
    const policy = standard([requirement({ id: 'safety', field: 'safety', required: false, exceptionEligible: true,
      applicableWhen: { attributeId: 'availability', values: ['applicable'] } })]);
    const result = evaluateItemChecklist({ ...input(policy, [], { safety: 'safe' }), evidence: { ...evidence, facts: [...evidence.facts, conditionFact] } });
    expect(result.requirements[0]).toMatchObject({ required: true, exceptionEligible: false, state: 'missing' });
  });

  it('does not let an older approval survive a later revocation', () => {
    const result = evaluateItemChecklist(input(standard([requirement()]), [omission('approved', 1), omission('revoked', 2)]));
    expect(result.requirements[0]?.state).toBe('missing');
  });

  it('keeps an omission valid across unrelated cosmetic edits', () => {
    const policy = standard([requirement({ label: 'Care guide' })]);
    const base = evaluateItemChecklist(input(policy, [], { care: 'Not provided' }));
    const approval = omission('approved', 1, { dependencyHash: base.requirements[0]!.dependencyHash! });
    const result = evaluateItemChecklist(input(policy, [approval], { care: 'Not provided', unrelated: 'changed' }));
    expect(result.requirements[0]).toMatchObject({ state: 'excepted', exceptionId: approval.id });
  });

  it('requires server-resolved rights for every exact local draft media path and binds its source provenance', () => {
    const policy = standard([requirement({ id: 'media-rights', field: 'image_rights', kind: 'image_rights', exceptionEligible: false })]);
    const listing = { image_rights: ['assets/approved.jpg'] };
    const unresolved = evaluateItemChecklist({ ...input(policy, [], listing), assetRightsBindings: [] });
    const resolved = evaluateItemChecklist({
      ...input(policy, [], listing),
      assetRightsBindings: [{ localPath: 'assets/approved.jpg', sourceUrl: 'https://example.com/approved.jpg', assetId: 'asset-1',
        factId: 'rights-fact-1', approvalId: 'rights-approval-1', rightsAuthorityHash: hash }],
    });
    const changedSource = evaluateItemChecklist({
      ...input(policy, [], listing),
      assetRightsBindings: [{ localPath: 'assets/approved.jpg', sourceUrl: 'https://example.com/other.jpg', assetId: 'asset-1',
        factId: 'rights-fact-1', approvalId: 'rights-approval-1', rightsAuthorityHash: hash }],
    });
    expect(unresolved.requirements[0]).toMatchObject({ state: 'missing', exceptionEligible: false });
    expect(resolved.requirements[0]?.state).toBe('satisfied');
    expect(changedSource.requirements[0]?.dependencyHash).not.toBe(resolved.requirements[0]?.dependencyHash);
  });
});
