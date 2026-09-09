import { describe, it, expect } from 'bun:test';
import {
  evaluateProductTypeCurrentness,
  computeReviewedTypeAuthorityHash,
  type ProductTypeCurrentnessInput,
} from '../../classification/classification-currentness';
import type { ClassificationProposal } from '../../shared/types';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';

describe('classification-currentness (P0.2)', () => {
  const baseRun = {
    id: 'run-1',
    workspaceId: 'ws-1',
    onboardingItemId: 'item-1',
    productSku: '012345678901',
    status: 'completed',
    configSnapshotHash: 'snap-hash-1',
    cohortRunId: null,
  };

  const baseSnapshot = {
    snapshotHash: 'snap-hash-1',
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    productTypes: [
      { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
      { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [
      {
        id: 'brand',
        name: 'Brand',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: [],
        valueAliases: [],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: null,
        isUniversal: true,
      },
      {
        id: 'kibble_size',
        name: 'Kibble Size',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: [],
        valueAliases: [],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: null,
        isUniversal: false,
      },
    ],
    curationTargets: [
      {
        id: 'target-pt',
        kind: 'product_type',
        label: 'Product Type',
        enabled: true,
        mandatory: true,
        selectionMode: 'single',
        attributeId: null,
        catalogField: null,
        optionSource: 'configured',
        required: true,
        sortOrder: 1,
      },
    ],
  } as unknown as RuntimeClassificationSnapshot;

  const baseTypeProposal: ClassificationProposal = {
    id: 'prop-pt-1',
    runId: 'run-1',
    productSku: '012345678901',
    proposalType: 'primary_product_type',
    targetId: 'dog_food',
    proposedValue: { productTypeId: 'dog_food' },
    confidence: 0.95,
    status: 'accepted',
    isBulkAcceptable: true,
    isStale: false,
    stalenessReason: null,
    evidenceIds: [],
    hasRevisedValue: false,
    hasRevisedTargetId: false,
    createdAt: new Date().toISOString(),
  };

  const baseTypeDecision = {
    id: 'dec-pt-1',
    decision: 'accepted',
    decisionOrigin: 'human_review',
    reviewerId: 'operator-1',
    revisedFromId: null,
    revisedValue: undefined,
    hasRevisedValue: false,
    revisedTargetId: undefined,
    hasRevisedTargetId: false,
    supersededAt: null,
  };

  it('passes when valid human-reviewed Primary Product Type is active and terminal', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.effectiveTypeId).toBe('dog_food');
      expect(result.decisionOrigin).toBe('human_review');
      expect(result.canonicalValueHash).toBe(computeReviewedTypeAuthorityHash('dog_food')!);
    }
  });

  it('rejects system_auto_accept origin as non_human_product_type_decision', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: {
        ...baseTypeDecision,
        decisionOrigin: 'system_auto_accept',
        reviewerId: 'system_auto_accept',
      },
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('non_human_product_type_decision');
    }
  });

  it('rejects legacy system_auto_accept reviewer even when decisionOrigin is null', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: {
        ...baseTypeDecision,
        decisionOrigin: null,
        reviewerId: 'system_auto_accept',
      },
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('non_human_product_type_decision');
    }
  });

  it('rejects explicit clear with reviewed_product_type_cleared', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: {
        ...baseTypeProposal,
        hasRevisedTargetId: true,
        revisedTargetId: null,
        hasRevisedValue: true,
        revisedValue: null,
      },
      primaryTypeDecision: {
        ...baseTypeDecision,
        hasRevisedTargetId: true,
        revisedTargetId: null,
        hasRevisedValue: true,
        revisedValue: null,
      },
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('reviewed_product_type_cleared');
    }
  });

  it('rejects mismatched revised target and value with revised_product_type_mismatch', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: {
        ...baseTypeProposal,
        hasRevisedTargetId: true,
        revisedTargetId: 'dog_food',
        hasRevisedValue: true,
        revisedValue: { productTypeId: 'cat_food' },
      },
      primaryTypeDecision: {
        ...baseTypeDecision,
        hasRevisedTargetId: true,
        revisedTargetId: 'dog_food',
        hasRevisedValue: true,
        revisedValue: { productTypeId: 'cat_food' },
      },
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('revised_product_type_mismatch');
    }
  });

  it('rejects unconfigured Product Type with unconfigured_product_type', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: {
        ...baseTypeProposal,
        hasRevisedTargetId: true,
        revisedTargetId: 'iguana_food',
      },
      primaryTypeDecision: {
        ...baseTypeDecision,
        hasRevisedTargetId: true,
        revisedTargetId: 'iguana_food',
      },
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unconfigured_product_type');
    }
  });

  it('rejects non-terminal active run with run_not_completed', () => {
    const input: ProductTypeCurrentnessInput = {
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: { ...baseRun, status: 'running' },
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
      typeDependentProposals: [],
    };

    const result = evaluateProductTypeCurrentness(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('run_not_completed');
    }
  });

  it('rejects cohort child when parent is superseded or non-terminal', () => {
    const cohortChildRun = { ...baseRun, cohortRunId: 'cohort-parent-1' };

    // Missing parent
    const resMissing = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: cohortChildRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
    });
    expect(resMissing.ok).toBe(false);
    if (!resMissing.ok) expect(resMissing.code).toBe('parent_not_found');

    // Superseded parent
    const resSuperseded = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: cohortChildRun,
      parentRun: { id: 'cohort-parent-1', workspaceId: 'ws-1', status: 'superseded' },
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
    });
    expect(resSuperseded.ok).toBe(false);
    if (!resSuperseded.ok) expect(resSuperseded.code).toBe('parent_superseded');

    // Running parent
    const resRunning = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: cohortChildRun,
      parentRun: { id: 'cohort-parent-1', workspaceId: 'ws-1', status: 'running' },
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
    });
    expect(resRunning.ok).toBe(false);
    if (!resRunning.ok) expect(resRunning.code).toBe('parent_not_completed');
  });

  it('rejects type-dependent proposal when dependency is missing or points to wrong type', () => {
    const typeDependentProposal: ClassificationProposal = {
      id: 'prop-kibble-1',
      runId: 'run-1',
      productSku: '012345678901',
      proposalType: 'field_assignment',
      targetId: 'kibble_size',
      proposedValue: 'small',
      confidence: 0.9,
      status: 'accepted',
      isBulkAcceptable: true,
      isStale: false,
      stalenessReason: null,
      evidenceIds: [],
      hasRevisedValue: false,
      hasRevisedTargetId: false,
      createdAt: new Date().toISOString(),
    };

    // Missing dependency
    const missingDepResult = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
      typeDependentProposals: [
        {
          proposal: typeDependentProposal,
          dependencies: [],
          isUniversal: false,
        },
      ],
    });
    expect(missingDepResult.ok).toBe(false);
    if (!missingDepResult.ok) {
      expect(missingDepResult.code).toBe('missing_type_dependency');
    }

    // Target mismatch
    const targetMismatchResult = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
      typeDependentProposals: [
        {
          proposal: typeDependentProposal,
          dependencies: [
            {
              dependencyKind: 'reviewed_product_type',
              dependencyTargetId: 'cat_food',
              dependencyValueHash: computeReviewedTypeAuthorityHash('cat_food'),
            },
          ],
          isUniversal: false,
        },
      ],
    });
    expect(targetMismatchResult.ok).toBe(false);
    if (!targetMismatchResult.ok) {
      expect(targetMismatchResult.code).toBe('stale_proposal');
    }
  });

  it('rejects universal proposal that carries unexpected product type dependency', () => {
    const universalProposal: ClassificationProposal = {
      id: 'prop-brand-1',
      runId: 'run-1',
      productSku: '012345678901',
      proposalType: 'field_assignment',
      targetId: 'brand',
      proposedValue: 'Purina',
      confidence: 0.99,
      status: 'accepted',
      isBulkAcceptable: true,
      isStale: false,
      stalenessReason: null,
      evidenceIds: [],
      hasRevisedValue: false,
      hasRevisedTargetId: false,
      createdAt: new Date().toISOString(),
    };

    const result = evaluateProductTypeCurrentness({
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: '012345678901',
      activeRun: baseRun,
      parentRun: null,
      snapshot: baseSnapshot,
      primaryTypeProposal: baseTypeProposal,
      primaryTypeDecision: baseTypeDecision,
      typeDependentProposals: [
        {
          proposal: universalProposal,
          dependencies: [
            {
              dependencyKind: 'reviewed_product_type',
              dependencyTargetId: 'dog_food',
              dependencyValueHash: computeReviewedTypeAuthorityHash('dog_food'),
            },
          ],
          isUniversal: true,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('universal_proposal_has_type_dependency');
    }
  });
});
