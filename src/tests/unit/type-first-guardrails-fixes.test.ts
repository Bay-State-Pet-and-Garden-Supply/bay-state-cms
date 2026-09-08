import { describe, it, expect } from 'bun:test';
import { evaluateProductTypeCurrentness, resolveDecisionOrigin } from '../../classification/classification-currentness';
import { analyzeProductTypeImpact } from '../../classification/type-change-impact';

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    onboardingItemId: 'item-1',
    productSku: 'SKU-1',
    activeRun: {
      id: 'run-1',
      workspaceId: 'ws-1',
      onboardingItemId: 'item-1',
      productSku: 'SKU-1',
      status: 'completed',
      configSnapshotHash: 'snap-1',
      cohortRunId: null,
    },
    parentRun: null,
    snapshot: { productTypes: [{ id: 'dog_food' }, { id: 'cat_food' }] } as never,
    primaryTypeProposal: {
      id: 'p-type',
      proposalType: 'primary_product_type',
      targetId: 'dog_food',
    } as never,
    primaryTypeDecision: {
      id: 'd-1',
      decision: 'accepted',
      decisionOrigin: 'human_review',
      supersededAt: null,
    } as never,
    typeDependentProposals: [],
    ...overrides,
  } as Parameters<typeof evaluateProductTypeCurrentness>[0];
}

describe('type-first guardrail fixes (review follow-up)', () => {
  it('unknown/missing origin blocks as non-human', () => {
    expect(resolveDecisionOrigin({})).toBe('unknown');
    const res = evaluateProductTypeCurrentness(baseInput({
      primaryTypeDecision: { id: 'd-1', decision: 'accepted', supersededAt: null },
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('non_human_product_type_decision');
  });

  it('missing snapshot blocks fail-closed', () => {
    const res = evaluateProductTypeCurrentness(baseInput({ snapshot: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('snapshot_unavailable');
  });

  it('missing dependency hash blocks', () => {
    const res = evaluateProductTypeCurrentness(baseInput({
      typeDependentProposals: [{
        proposal: { id: 'p-attr', proposalType: 'field_assignment', targetId: 'color' } as never,
        dependencies: [{ dependencyKind: 'reviewed_product_type', dependencyTargetId: 'dog_food', dependencyValueHash: null }],
        isUniversal: false,
      }],
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('stale_proposal');
  });

  it('conflicting null-target vs valued-value blocks', () => {
    const res = evaluateProductTypeCurrentness(baseInput({
      primaryTypeProposal: {
        id: 'p-type',
        proposalType: 'primary_product_type',
        targetId: 'dog_food',
        hasRevisedTargetId: true,
        revisedTargetId: null,
        hasRevisedValue: true,
        revisedValue: { productTypeId: 'cat_food' },
      } as never,
      primaryTypeDecision: { id: 'd-1', decision: 'accepted', decisionOrigin: 'human_review', supersededAt: null } as never,
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('revised_product_type_mismatch');
  });

  it('unchanged impact never preserves stale rows', () => {
    const primary = { id: 'p-type', proposalType: 'primary_product_type', targetId: 'dog_food' } as never;
    const staleDep = { id: 'p-stale', proposalType: 'field_assignment', targetId: 'color', status: 'stale', isStale: true } as never;
    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: 'dog_food',
      activeProposals: [primary, staleDep],
      dependencies: [],
      snapshot: { attributes: [] } as never,
    });
    expect(analysis.isUnchanged).toBe(true);
    expect(analysis.preservedProposals.find(p => p.proposalId === 'p-stale')).toBeUndefined();
    expect(analysis.universalProposalsPreserved.find(p => p.proposalId === 'p-stale')).toBeUndefined();
  });

  it('execution alignment requires exact hash (no falsy bypass)', () => {
    const primary = { id: 'p-type', proposalType: 'primary_product_type', targetId: 'dog_food' } as never;
    const dep = { id: 'p-attr', proposalType: 'field_assignment', targetId: 'color' } as never;
    const analysis = analyzeProductTypeImpact({
      runId: 'run-1',
      candidateProductTypeId: 'cat_food',
      activeProposals: [primary, dep],
      dependencies: [{ proposalId: 'p-attr', dependencyKind: 'reviewed_product_type', dependencyTargetId: 'cat_food', dependencyValueHash: null }],
      snapshot: { attributes: [] } as never,
      executionProductTypeId: 'cat_food',
      executionAuthorityHash: 'hash-cat',
    });
    expect(analysis.dependentProposalsToInvalidate.find(p => p.proposalId === 'p-attr')).toBeDefined();
    expect(analysis.preservedProposals.find(p => p.proposalId === 'p-attr')).toBeUndefined();
  });
});
