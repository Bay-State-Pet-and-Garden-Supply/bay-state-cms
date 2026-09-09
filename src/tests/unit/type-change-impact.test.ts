import { describe, it, expect } from 'bun:test';
import { analyzeProductTypeImpact } from '../../classification/type-change-impact';
import type { ClassificationProposal } from '../../shared/types';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';

describe('type-change-impact (P1.1)', () => {
  const baseSnapshot = {
    attributes: [
      { id: 'brand', isUniversal: true },
      { id: 'flavor', isUniversal: false },
    ],
  } as unknown as RuntimeClassificationSnapshot;

  const primaryTypeProp: ClassificationProposal = {
    id: 'prop-pt',
    runId: 'run-1',
    productSku: '012345678901',
    proposalType: 'primary_product_type',
    targetId: 'dog_food',
    proposedValue: { productTypeId: 'dog_food' },
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

  const universalProp: ClassificationProposal = {
    id: 'prop-brand',
    runId: 'run-1',
    productSku: '012345678901',
    proposalType: 'field_assignment',
    targetId: 'brand',
    proposedValue: 'Purina',
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

  const dependentFieldProp: ClassificationProposal = {
    id: 'prop-flavor',
    runId: 'run-1',
    productSku: '012345678901',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: 'Chicken',
    confidence: 0.8,
    status: 'accepted',
    isBulkAcceptable: true,
    isStale: false,
    stalenessReason: null,
    evidenceIds: [],
    hasRevisedValue: false,
    hasRevisedTargetId: false,
    createdAt: new Date().toISOString(),
  };

  const categoryPageProp: ClassificationProposal = {
    id: 'prop-page',
    runId: 'run-1',
    productSku: '012345678901',
    proposalType: 'category_page',
    targetId: 'page-dog',
    proposedValue: { pageId: 'page-dog' },
    confidence: 0.85,
    status: 'accepted',
    isBulkAcceptable: true,
    isStale: false,
    stalenessReason: null,
    evidenceIds: [],
    hasRevisedValue: false,
    hasRevisedTargetId: false,
    createdAt: new Date().toISOString(),
  };

  const dependencies = [
    {
      proposalId: 'prop-flavor',
      dependencyKind: 'reviewed_product_type',
      dependencyTargetId: 'dog_food',
      dependencyValueHash: 'hash-dog',
    },
    {
      proposalId: 'prop-page',
      dependencyKind: 'reviewed_product_type',
      dependencyTargetId: 'dog_food',
      dependencyValueHash: 'hash-dog',
    },
  ];

  it('preserves all proposals when candidate matches current type (unchanged)', () => {
    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: 'dog_food',
      activeProposals: [primaryTypeProp, universalProp, dependentFieldProp, categoryPageProp],
      dependencies,
      snapshot: baseSnapshot,
    });

    expect(analysis.isUnchanged).toBe(true);
    expect(analysis.dependentProposalsToInvalidate.length).toBe(0);
    expect(analysis.universalProposalsPreserved.length).toBe(1);
    expect(analysis.universalProposalsPreserved[0].targetId).toBe('brand');
    expect(analysis.preservedProposals.length).toBe(2);
  });

  it('invalidates dependent proposals and preserves universals on type change A -> B', () => {
    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: 'cat_food',
      activeProposals: [primaryTypeProp, universalProp, dependentFieldProp, categoryPageProp],
      dependencies,
      snapshot: baseSnapshot,
    });

    expect(analysis.isUnchanged).toBe(false);
    expect(analysis.isClear).toBe(false);
    expect(analysis.universalProposalsPreserved.length).toBe(1);
    expect(analysis.universalProposalsPreserved[0].targetId).toBe('brand');
    expect(analysis.dependentProposalsToInvalidate.length).toBe(2);
    expect(analysis.dependentProposalsToInvalidate.map(p => p.proposalId)).toContain('prop-flavor');
    expect(analysis.dependentProposalsToInvalidate.map(p => p.proposalId)).toContain('prop-page');
    expect(analysis.proposalsToRecompute.length).toBe(2);
  });

  it('invalidates all dependents with product_type_cleared on explicit clear', () => {
    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: null,
      activeProposals: [primaryTypeProp, universalProp, dependentFieldProp, categoryPageProp],
      dependencies,
      snapshot: baseSnapshot,
    });

    expect(analysis.isClear).toBe(true);
    expect(analysis.universalProposalsPreserved.length).toBe(1);
    expect(analysis.dependentProposalsToInvalidate.length).toBe(2);
    expect(analysis.dependentProposalsToInvalidate[0].reason).toBe('product_type_cleared');
    expect(analysis.proposalsToRecompute.length).toBe(0);
  });

  it('preserves matching execution proposals when candidate aligns with execution type', () => {
    const execDependencies = [
      {
        proposalId: 'prop-flavor',
        dependencyKind: 'execution_product_type',
        dependencyTargetId: 'dry_dog_food',
        dependencyValueHash: 'exec-hash-1',
      },
    ];

    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: 'dry_dog_food',
      activeProposals: [primaryTypeProp, universalProp, dependentFieldProp],
      dependencies: execDependencies,
      snapshot: baseSnapshot,
      executionProductTypeId: 'dry_dog_food',
      executionAuthorityHash: 'exec-hash-1',
    });

    expect(analysis.hasExecutionTypeAlignment).toBe(true);
    expect(analysis.preservedProposals.length).toBe(1);
    expect(analysis.preservedProposals[0].proposalId).toBe('prop-flavor');
    expect(analysis.preservedProposals[0].matchedKind).toBe('execution_alignment');
    expect(analysis.dependentProposalsToInvalidate.length).toBe(0);
  });
});
