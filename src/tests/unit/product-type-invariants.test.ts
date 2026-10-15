import { describe, expect, it } from 'vitest';
import { resolveProductTypeInvariants } from '../../classification/product-type-invariants';
import type { ResolvedTarget } from '../../classification/curation-target-resolver';
import type { ProductTypeConfig, ProductAttributeConfig } from '../../shared/schemas/classification';
import type { ClassificationEvidence } from '../../shared/types';

describe('Product Type Invariants Resolver', () => {
  const speciesAttribute: ProductAttributeConfig = {
    id: 'species',
    name: 'Animal Species',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Dog', 'Cat', 'Horse', 'Poultry'],
    valueAliases: [
      { alias: 'canine', mapsTo: 'Dog' },
      { alias: 'dogs', mapsTo: 'Dog' },
      { alias: 'feline', mapsTo: 'Cat' },
      { alias: 'cats', mapsTo: 'Cat' },
    ],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Pet',
  };

  const foodFormAttribute: ProductAttributeConfig = {
    id: 'food-form',
    name: 'Food Form',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Dry Food', 'Wet Food', 'Treat'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Food',
  };

  const flavorAttribute: ProductAttributeConfig = {
    id: 'flavor',
    name: 'Flavor',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Chicken', 'Beef', 'Salmon'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Food',
  };

  const dogFoodType: ProductTypeConfig = {
    id: 'dog-food-dry',
    name: 'Dry Dog Food',
    description: null,
    attributeProfileId: 'dog-food-profile',
    oldIdAliases: [],
    invariantAttributes: {
      species: 'Dog',
      'food-form': 'Dry Food',
    },
  };

  const makeGatedTarget = (
    attribute: ProductAttributeConfig,
    cardinality: 'single' | 'multiple' = 'single',
  ): { target: ResolvedTarget; cardinality: 'single' | 'multiple' } => ({
    target: {
      config: {
        id: `${attribute.id}-target`,
        kind: 'product_field',
        label: attribute.name,
        enabled: true,
        mandatory: false,
        selectionMode: cardinality,
        attributeId: attribute.id,
        catalogField: `ProductField_${attribute.id}`,
        optionSource: 'configured',
        required: false,
        sortOrder: 1,
      },
      options: attribute.allowedValues.map(v => ({ value: v, label: v })),
      attribute,
    },
    cardinality,
  });

  it('generates deterministic invariant proposals with confidence 1.0, isBulkAcceptable false, and first-class provenance', () => {
    const gated = [
      makeGatedTarget(speciesAttribute),
      makeGatedTarget(foodFormAttribute),
      makeGatedTarget(flavorAttribute),
    ];

    const result = resolveProductTypeInvariants({
      effectiveTypeId: 'dog-food-dry',
      effectiveTypeSource: 'reviewed',
      gatedTargets: gated,
      productTypes: [dogFoodType],
      evidence: [],
      runId: 'run-1',
      sku: 'SKU-DOG-1',
      snapshotHash: 'snap-hash-123',
    });

    expect(result.invariantProposals).toHaveLength(2);

    const speciesProposal = result.invariantProposals.find(p => p.targetId === 'species');
    expect(speciesProposal).toBeDefined();
    expect(speciesProposal?.proposedValue).toBe('Dog');
    expect(speciesProposal?.confidence).toBe(1.0);
    expect(speciesProposal?.isBulkAcceptable).toBe(false);
    expect(speciesProposal?.derivation).toEqual({
      kind: 'product_type_invariant',
      productTypeId: 'dog-food-dry',
      productTypeSource: 'reviewed',
    });
    expect(speciesProposal?.snapshotHash).toBe('snap-hash-123');

    const foodFormProposal = result.invariantProposals.find(p => p.targetId === 'food-form');
    expect(foodFormProposal).toBeDefined();
    expect(foodFormProposal?.proposedValue).toBe('Dry Food');
    expect(foodFormProposal?.confidence).toBe(1.0);
    expect(foodFormProposal?.isBulkAcceptable).toBe(false);

    // Flavor is not an invariant, so it remains in remainingGatedTargets for variable processing
    expect(result.remainingGatedTargets).toHaveLength(1);
    expect(result.remainingGatedTargets[0].target.attribute?.id).toBe('flavor');
  });

  it('detects target-specific semantic contradictions using buildEvidenceTargetPacket', () => {
    const gated = [makeGatedTarget(speciesAttribute)];

    // Target-matching evidence that explicitly asserts Cat (contradiction)
    const conflictingEvidence: ClassificationEvidence = {
      id: 'ev-cat-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-1',
      attributeId: 'species',
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/cat-food',
      sourceField: 'species',
      snippet: 'Species: Cat',
      value: 'Cat',
      metadata: null,
      capturedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = resolveProductTypeInvariants({
      effectiveTypeId: 'dog-food-dry',
      effectiveTypeSource: 'reviewed',
      gatedTargets: gated,
      productTypes: [dogFoodType],
      evidence: [conflictingEvidence],
      runId: 'run-1',
      sku: 'SKU-DOG-1',
    });

    expect(result.invariantProposals).toHaveLength(1);
    const proposal = result.invariantProposals[0];
    expect(proposal.proposedValue).toBe('Dog');
    expect(proposal.contradictingEvidenceIds).toContain('ev-cat-1');
    expect(proposal.derivation).toEqual({
      kind: 'product_type_invariant',
      productTypeId: 'dog-food-dry',
      productTypeSource: 'reviewed',
    });
  });

  it('does NOT treat incidental token mentions in general copy as a contradiction', () => {
    const gated = [makeGatedTarget(speciesAttribute)];

    // General description evidence mentioning "cats" in a non-target assertion context
    const incidentalEvidence: ClassificationEvidence = {
      id: 'ev-desc-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-1',
      attributeId: null,
      source: 'official_product_page',
      reliability: 'medium',
      sourceUrl: 'https://example.com/dog-food',
      sourceField: 'description',
      snippet: 'Keep away from cats. Suitable for all canine breeds.',
      value: 'Keep away from cats. Suitable for all canine breeds.',
      metadata: null,
      capturedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = resolveProductTypeInvariants({
      effectiveTypeId: 'dog-food-dry',
      effectiveTypeSource: 'reviewed',
      gatedTargets: gated,
      productTypes: [dogFoodType],
      evidence: [incidentalEvidence],
      runId: 'run-1',
      sku: 'SKU-DOG-1',
    });

    expect(result.invariantProposals).toHaveLength(1);
    const proposal = result.invariantProposals[0];
    expect(proposal.proposedValue).toBe('Dog');
    // Non-target description is context only, not contradicting
    expect(proposal.contradictingEvidenceIds ?? []).toHaveLength(0);
  });

  it('reconciles known aliases (canine -> Dog) as supporting evidence', () => {
    const gated = [makeGatedTarget(speciesAttribute)];

    const aliasEvidence: ClassificationEvidence = {
      id: 'ev-alias-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-DOG-1',
      attributeId: 'species',
      source: 'official_product_page',
      reliability: 'high',
      sourceUrl: 'https://example.com/dog-food',
      sourceField: 'species',
      snippet: 'canine formula',
      value: 'canine',
      metadata: null,
      capturedAt: '2026-09-01T00:00:00.000Z',
    };

    const result = resolveProductTypeInvariants({
      effectiveTypeId: 'dog-food-dry',
      effectiveTypeSource: 'reviewed',
      gatedTargets: gated,
      productTypes: [dogFoodType],
      evidence: [aliasEvidence],
      runId: 'run-1',
      sku: 'SKU-DOG-1',
    });

    expect(result.invariantProposals).toHaveLength(1);
    const proposal = result.invariantProposals[0];
    expect(proposal.supportingEvidenceIds).toContain('ev-alias-1');
  });

  it('returns empty invariant proposals when Product Type has no invariants or no effective type exists', () => {
    const genericType: ProductTypeConfig = {
      id: 'generic-item',
      name: 'Generic Item',
      description: null,
      attributeProfileId: null,
      oldIdAliases: [],
    };

    const gated = [makeGatedTarget(speciesAttribute)];

    const resultWithoutType = resolveProductTypeInvariants({
      effectiveTypeId: null,
      effectiveTypeSource: 'none',
      gatedTargets: gated,
      productTypes: [genericType],
      evidence: [],
      runId: 'run-1',
      sku: 'SKU-GEN-1',
    });
    expect(resultWithoutType.invariantProposals).toHaveLength(0);
    expect(resultWithoutType.remainingGatedTargets).toHaveLength(1);

    const resultWithoutInvariants = resolveProductTypeInvariants({
      effectiveTypeId: 'generic-item',
      effectiveTypeSource: 'reviewed',
      gatedTargets: gated,
      productTypes: [genericType],
      evidence: [],
      runId: 'run-1',
      sku: 'SKU-GEN-1',
    });
    expect(resultWithoutInvariants.invariantProposals).toHaveLength(0);
    expect(resultWithoutInvariants.remainingGatedTargets).toHaveLength(1);
  });
});
