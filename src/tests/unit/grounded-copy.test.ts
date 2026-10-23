import { describe, expect, it } from 'bun:test';
import { buildNameCandidatesFromAcceptedEvidence } from '../../classification/name-candidates';
import type { AcceptedItemEvidence } from '../../shared/schemas/item-evidence';
import { isSameAcceptedEvidenceSnapshot, validateGroundedCopyResponse } from '../../onboarding/grounded-copy';

describe('grounded copy preparation boundaries', () => {
  const knownFacts = new Set(['fact-not-suitable', 'fact-model']);

  it('refuses fabricated or stale fact references rather than treating citations as proof', () => {
    const result = validateGroundedCopyResponse(JSON.stringify({
      description: 'Suitable for puppies and kittens with a premium natural formula.',
      factIds: ['fact-not-suitable', 'fact-from-sibling'],
    }), knownFacts);
    expect(result).toBeNull();
  });

  it('requires returned fact references and strict structured output', () => {
    expect(validateGroundedCopyResponse(JSON.stringify({
      description: 'Model XR-4 is not suitable for puppies.',
      factIds: [],
    }), knownFacts)).toBeNull();
    expect(validateGroundedCopyResponse('Model XR-4 is not suitable for puppies.', knownFacts)).toBeNull();
  });

  it('preserves source-supported qualifiers and model facts without rewriting them', () => {
    const description = 'Model XR-4 is not suitable for puppies.';
    expect(validateGroundedCopyResponse(JSON.stringify({
      description,
      factIds: ['fact-model', 'fact-not-suitable'],
    }), knownFacts)).toEqual({ description, factIds: ['fact-model', 'fact-not-suitable'] });
  });

  it('rejects an accepted snapshot after revision, input, authority, or evidence changes', () => {
    const accepted = {
      workspaceId: 'workspace', itemId: 'item', id: 'snapshot', revision: 3,
      evidenceHash: 'e'.repeat(64), inputHash: 'i'.repeat(64),
      sourceStateHash: 's'.repeat(64), authorityHash: 'a'.repeat(64),
    } as AcceptedItemEvidence;
    expect(isSameAcceptedEvidenceSnapshot(accepted, accepted)).toBe(true);
    expect(isSameAcceptedEvidenceSnapshot(accepted, { ...accepted, revision: 4 })).toBe(false);
    expect(isSameAcceptedEvidenceSnapshot(accepted, { ...accepted, inputHash: 'n'.repeat(64) })).toBe(false);
    expect(isSameAcceptedEvidenceSnapshot(accepted, { ...accepted, authorityHash: 'b'.repeat(64) })).toBe(false);
    expect(isSameAcceptedEvidenceSnapshot(accepted, null)).toBe(false);
  });
  it('builds names from current item facts without stale variant borrowing, retaining negation and model identity', () => {
    const evidence = {
      workspaceId: 'workspace',
      batchId: 'batch',
      itemId: 'item',
      sku: 'sku',
      revision: 2,
      inputHash: 'i'.repeat(64),
      sourceStateHash: 's'.repeat(64),
      authorityHash: 'a'.repeat(64),
      id: 'snapshot',
      registerName: 'Acme Pet Feeder Model XR-4',
      facts: [
        { id: 'brand', field: 'brand', value: 'Acme', rawValue: 'Acme', observationId: 'current' },
        { id: 'title', field: 'name', value: 'Acme Pet Feeder Model XR-4 not suitable for kittens', rawValue: 'Acme Pet Feeder Model XR-4 not suitable for kittens', observationId: 'current' },
        { id: 'stale-size', field: 'size', value: '15 lb', rawValue: '15 lb', observationId: 'stale' },
      ],
      observations: [
        { id: 'current', sourceRole: 'manufacturer_official', identity: { itemId: 'item', sku: 'sku', inputHash: 'i'.repeat(64), outcome: 'confirmed' } },
        { id: 'stale', sourceRole: 'manufacturer_official', identity: { itemId: 'item', sku: 'sku', inputHash: 'x'.repeat(64), outcome: 'confirmed' } },
      ],
    } as unknown as AcceptedItemEvidence;
    const result = buildNameCandidatesFromAcceptedEvidence(evidence);
    expect(result.kind).toBe('candidates');
    if (result.kind !== 'candidates') throw new Error('Expected accepted item name candidates');
    expect(result.candidates.some((candidate) => candidate.title.includes('XR-4') && candidate.title.includes('not suitable for kittens'))).toBe(true);
    expect(result.candidates.every((candidate) => !candidate.title.includes('15 lb'))).toBe(true);
  });
  it('treats accepted flavor fields as attributes, not standalone product identity', () => {
    const evidence = {
      workspaceId: 'workspace',
      batchId: 'batch',
      itemId: 'item',
      sku: 'sku',
      revision: 2,
      inputHash: 'i'.repeat(64),
      sourceStateHash: 's'.repeat(64),
      authorityHash: 'a'.repeat(64),
      id: 'snapshot',
      registerName: 'Acme',
      facts: [
        { id: 'brand', field: 'brand', value: 'Acme', rawValue: 'Acme', observationId: 'current' },
        { id: 'flavor', field: 'flavor', value: 'Chicken', rawValue: 'Chicken', observationId: 'current' },
        { id: 'size', field: 'size', value: '12 oz', rawValue: '12 oz', observationId: 'current' },
      ],
      observations: [
        { id: 'current', sourceRole: 'manufacturer_official', identity: { itemId: 'item', sku: 'sku', inputHash: 'i'.repeat(64), outcome: 'confirmed' } },
      ],
    } as unknown as AcceptedItemEvidence;
    expect(buildNameCandidatesFromAcceptedEvidence(evidence).kind).toBe('missing');
  });
  it('projects applicable species, pack-count role, and strength from accepted fact fields', () => {
    const evidence = {
      workspaceId: 'workspace',
      batchId: 'batch',
      itemId: 'item',
      sku: 'sku',
      revision: 1,
      inputHash: 'i'.repeat(64),
      sourceStateHash: 's'.repeat(64),
      authorityHash: 'a'.repeat(64),
      id: 'snapshot',
      registerName: 'Acme Supplement',
      facts: [
        { id: 'brand', field: 'brand', value: 'Acme', rawValue: 'Acme', observationId: 'current' },
        { id: 'species-dog', field: 'species', value: 'dog', rawValue: 'dog', observationId: 'current' },
        { id: 'species-cat', field: 'species', value: 'cat', rawValue: 'cat', observationId: 'current' },
        { id: 'pack-count', field: 'packCount', value: '6', rawValue: '6', observationId: 'current' },
        { id: 'strength', field: 'strength', value: '500 mg', rawValue: '500 mg', observationId: 'current' },
      ],
      observations: [
        { id: 'current', sourceRole: 'manufacturer_official', identity: { itemId: 'item', sku: 'sku', inputHash: 'i'.repeat(64), outcome: 'confirmed' } },
      ],
    } as unknown as AcceptedItemEvidence;
    const result = buildNameCandidatesFromAcceptedEvidence(evidence);
    expect(result.kind).toBe('candidates');
    if (result.kind !== 'candidates') throw new Error('Expected accepted item name candidates');
    expect(result.candidates.every((candidate) =>
      candidate.title.toLowerCase().includes('dog')
      && candidate.title.toLowerCase().includes('cat')
      && candidate.title.includes('6 pack')
      && candidate.title.includes('500 mg')
      && candidate.evidenceIds.includes('pack-count')
      && candidate.evidenceIds.includes('strength'),
    )).toBe(true);
  });
});
