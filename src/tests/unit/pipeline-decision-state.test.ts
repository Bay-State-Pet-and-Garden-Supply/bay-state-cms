import { describe, expect, it } from 'vitest';
import type { ClassificationProposal } from '../../shared/schemas/classification';
import { getEffectivePrimaryProductTypeId } from '../../classification/assignment-projection';
import {
  SequentialActionQueue,
  canApplyProposalEdit,
  editableCurationData,
  isCurrentReviewGeneration,
  isCurrentReviewVersion,
  prepareDecisionAction,
  proposalDecisionSnapshot,
  withReviewedProposalTarget,
  withReviewedProposalValue,
} from '../../client/pipeline-decision-state';
import {
  getEffectiveProposalTargetId,
  getEffectiveProposalValue,
} from '../../classification/assignment-projection';

function proposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'proposal-1',
    runId: 'run-1',
    productSku: 'sku-1',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: 'Chicken',
    confidence: 0.9,
    evidenceIds: [],
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function idFactory(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}

describe('pipeline decision effective state', () => {
  it('hydrates revised values and explicit-null targets without mutating predictions', () => {
    const hydrated = proposal({
      targetId: 'page-original',
      proposedValue: 'Original',
      revisedValue: 'Reviewed',
      hasRevisedValue: true,
      revisedTargetId: null,
      hasRevisedTargetId: true,
      status: 'accepted',
    });

    expect(getEffectiveProposalValue(hydrated)).toBe('Reviewed');
    expect(getEffectiveProposalTargetId(hydrated)).toBeNull();
    expect(hydrated.proposedValue).toBe('Original');
    expect(hydrated.targetId).toBe('page-original');
  });

  // Issue #354: the client type-only mirrors are removed — the server owns
  // the canonical pair. Pair corrections move through the validated review
  // model (review-correction), not client mirrors.

  it('uses one Product Type precedence rule for historical one-sided and conflicting corrections', () => {
    const original = proposal({
      proposalType: 'primary_product_type',
      targetId: 'dog-food-dry',
      proposedValue: { productTypeId: 'dog-food-dry', matchedWords: ['dog', 'kibble'] },
    });
    const scenarios: Array<{
      proposal: ClassificationProposal;
      expected: string | null;
    }> = [
      {
        proposal: { ...original, revisedValue: { productTypeId: 'cat-food-wet' }, hasRevisedValue: true },
        expected: 'cat-food-wet',
      },
      {
        proposal: { ...original, revisedTargetId: 'bird-food', hasRevisedTargetId: true },
        expected: 'bird-food',
      },
      {
        proposal: { ...original, revisedTargetId: null, hasRevisedTargetId: true },
        expected: null,
      },
      {
        proposal: {
          ...original,
          revisedValue: { productTypeId: 'cat-food-wet' },
          hasRevisedValue: true,
          revisedTargetId: 'cat-food-wet',
          hasRevisedTargetId: true,
        },
        expected: 'cat-food-wet',
      },
      {
        proposal: {
          ...original,
          revisedValue: { productTypeId: 'cat-food-wet' },
          hasRevisedValue: true,
          revisedTargetId: 'bird-food',
          hasRevisedTargetId: true,
        },
        expected: 'bird-food',
      },
      {
        proposal: { ...original, targetId: null },
        expected: 'dog-food-dry',
      },
    ];

    for (const scenario of scenarios) {
      expect(getEffectivePrimaryProductTypeId(scenario.proposal)).toBe(scenario.expected);
    }
  });

  it('stores reviewer corrections separately and removes them when prediction is reselected', () => {
    const original = proposal();
    const reviewed = withReviewedProposalValue(original, 'Beef');
    expect(reviewed).toMatchObject({ proposedValue: 'Chicken', revisedValue: 'Beef', hasRevisedValue: true });
    expect(original).not.toHaveProperty('revisedValue');

    const restored = withReviewedProposalValue(reviewed, 'Chicken');
    expect(restored.proposedValue).toBe('Chicken');
    expect(restored.hasRevisedValue).toBe(false);
    expect(restored).not.toHaveProperty('revisedValue');

    const clearedTarget = withReviewedProposalTarget(original, null);
    expect(clearedTarget.targetId).toBe('flavor');
    expect(clearedTarget.hasRevisedTargetId).toBe(true);
    expect(clearedTarget.revisedTargetId).toBeNull();
  });

  it('builds one correction-free action for an accept and returns null for a semantic no-op', () => {
    const initial = proposal();
    const accepted = { ...initial, status: 'accepted' as const };
    const action = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(initial),
      expectedRevisionId: null,
      createId: () => 'decision-1',
      createActionToken: () => 'token-1',
    });

    expect(action?.input).toEqual({
      id: 'decision-1',
      proposalId: 'proposal-1',
      decision: 'accepted',
      expectedRevisionId: null,
      actionToken: 'token-1',
    });
    expect(action?.input).not.toHaveProperty('revisedValue');
    expect(action?.input).not.toHaveProperty('revisedTargetId');
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action?.input)).toBe(true);

    expect(prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: action!.snapshot,
      expectedRevisionId: 'decision-1',
      createId: () => 'decision-unused',
      createActionToken: () => 'token-unused',
    })).toBeNull();
  });

  it('retains an existing correction when only decision status changes', () => {
    const correctedPending = proposal({
      revisedValue: ['Chicken', 'Turkey'],
      hasRevisedValue: true,
    });
    const accepted = { ...correctedPending, status: 'accepted' as const };
    const action = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(correctedPending),
      expectedRevisionId: null,
      createId: () => 'decision-1',
      createActionToken: () => 'token-1',
    });

    expect(action?.input.revisedValue).toEqual(['Chicken', 'Turkey']);
    expect(action?.input).not.toHaveProperty('revisedTargetId');
  });

  it('captures an immutable rapid-edit predecessor chain and reuses an exact action', () => {
    const initial = proposal();
    const ids = idFactory('decision-1', 'token-1', 'decision-2', 'token-2');
    const accepted = { ...initial, status: 'accepted' as const };
    const first = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(initial),
      expectedRevisionId: null,
      createId: ids,
      createActionToken: ids,
    })!;
    const corrected = withReviewedProposalValue(accepted, 'Beef');
    const second = prepareDecisionAction({
      proposal: corrected,
      priorSnapshot: first.snapshot,
      expectedRevisionId: first.input.id,
      createId: ids,
      createActionToken: ids,
    })!;

    expect(first.input).toMatchObject({ id: 'decision-1', actionToken: 'token-1', expectedRevisionId: null });
    expect(second.input).toMatchObject({ id: 'decision-2', actionToken: 'token-2', expectedRevisionId: 'decision-1', revisedValue: 'Beef' });

    const exactRetry = prepareDecisionAction({
      proposal: corrected,
      priorSnapshot: first.snapshot,
      expectedRevisionId: first.input.id,
      existingAction: second,
      createId: () => 'different-id',
      createActionToken: () => 'different-token',
    });
    expect(exactRetry).toBe(second);
  });

  it('includes evidence citations in the action snapshot and exact retry equality', () => {
    const initial = proposal();
    const ids = idFactory('decision-c1', 'token-c1', 'decision-c2', 'token-c2');
    const accepted = { ...initial, status: 'accepted' as const };
    const first = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(initial),
      expectedRevisionId: null,
      evidenceIds: ['e2', 'e1', 'e2'],
      createId: ids,
      createActionToken: ids,
    })!;
    expect(first.input.evidenceIds).toEqual(['e1', 'e2']);
    expect(first.snapshot.evidenceIds).toEqual(['e1', 'e2']);

    // Same citations + same semantic state → exact retry returns the same action.
    const retry = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(initial),
      expectedRevisionId: null,
      evidenceIds: ['e2', 'e1'],
      existingAction: first,
      createId: () => 'different',
      createActionToken: () => 'different',
    });
    expect(retry).toBe(first);

    // Different citations → a different semantic action (never reuses the token action).
    const changed = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: proposalDecisionSnapshot(initial),
      expectedRevisionId: null,
      evidenceIds: ['e3'],
      createId: ids,
      createActionToken: ids,
    })!;
    expect(changed.input.evidenceIds).toEqual(['e3']);
    expect(changed.semanticKey).not.toBe(first.semanticKey);
  });

  it('treats identical citations as a no-op relative to the prior snapshot', () => {
    const accepted = { ...proposal(), status: 'accepted' as const };
    const prior = { ...proposalDecisionSnapshot(accepted), evidenceIds: ['e1'] };
    const action = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: prior,
      expectedRevisionId: null,
      evidenceIds: ['e1'],
      createId: () => 'x',
      createActionToken: () => 'y',
    });
    expect(action).toBeNull();
  });

  it('removing the SOLE stored citation produces a revision action with empty evidenceIds', () => {
    // Canonical install now seeds the prior snapshot with the hydrated decision
    // citations (issue #17 pass 5c). Unchecking the only stored citation must
    // therefore produce a DIFFERENT snapshot and a real revision action with
    // no evidenceIds — not a null no-op.
    const accepted = { ...proposal(), status: 'accepted' as const };
    const prior = { ...proposalDecisionSnapshot(accepted), evidenceIds: ['e1'] };
    const action = prepareDecisionAction({
      proposal: accepted,
      priorSnapshot: prior,
      expectedRevisionId: null,
      evidenceIds: [],
      createId: () => 'x',
      createActionToken: () => 'y',
    });
    expect(action).not.toBeNull();
    expect(action!.input.evidenceIds).toBeUndefined();
    expect(action!.snapshot.evidenceIds).toBeUndefined();
    expect(action!.semanticKey).not.toContain('e1');
  });

  it('proposalDecisionSnapshot carries stored citations for the canonical prior', () => {
    const accepted = { ...proposal(), status: 'accepted' as const };
    const snapshot = proposalDecisionSnapshot(accepted, ['e2', 'e1', 'e2']);
    expect(snapshot.evidenceIds).toEqual(['e1', 'e2']);
    // Without citations no evidenceIds key is emitted.
    expect(proposalDecisionSnapshot(accepted).evidenceIds).toBeUndefined();
  });

  it('strips run-owned classification arrays from ordinary item autosaves', () => {
    const editable = editableCurationData({
      curatedTitle: 'Reviewed title',
      classificationRunId: 'run-1',
      classificationProposals: [proposal()],
      classificationEvidence: [],
      classificationDecisions: [],
      classificationHistory: [],
    });

    expect(editable.curatedTitle).toBe('Reviewed title');
    expect(editable).not.toHaveProperty('classificationRunId');
    expect(editable).not.toHaveProperty('classificationProposals');
    expect(editable).not.toHaveProperty('classificationEvidence');
    expect(editable).not.toHaveProperty('classificationDecisions');
  });
});

describe('SequentialActionQueue', () => {
  it('executes captured actions in order', async () => {
    const queue = new SequentialActionQueue<{ token: string }, string>();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = queue.enqueue(Object.freeze({ token: 'a' }), async action => {
      events.push(`start-${action.token}`);
      await firstGate;
      events.push(`end-${action.token}`);
      return action.token;
    });
    const second = queue.enqueue(Object.freeze({ token: 'b' }), async action => {
      events.push(`start-${action.token}`);
      events.push(`end-${action.token}`);
      return action.token;
    });

    await Promise.resolve();
    expect(events).toEqual(['start-a']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(events).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
  });

  it('preserves failure, rejects drain, and retries the exact captured action before later work', async () => {
    const queue = new SequentialActionQueue<{ token: string }, string>();
    const attempts: string[] = [];
    let fail = true;
    const action = Object.freeze({ token: 'same-token' });

    const first = queue.enqueue(action, async captured => {
      attempts.push(captured.token);
      if (fail) throw new Error('network lost');
      return captured.token;
    });
    const later = queue.enqueue(Object.freeze({ token: 'later-token' }), async captured => {
      attempts.push(captured.token);
      return captured.token;
    });

    await expect(first).rejects.toThrow('network lost');
    await expect(queue.drain()).rejects.toThrow('network lost');
    expect(queue.getFailedAction()).toBe(action);
    expect(attempts).toEqual(['same-token']);

    fail = false;
    await expect(queue.retryFailed()).resolves.toBe('same-token');
    await expect(later).resolves.toBe('later-token');
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(attempts).toEqual(['same-token', 'same-token', 'later-token']);
  });

  it('discards queued local edits after a canonical conflict refresh', async () => {
    const queue = new SequentialActionQueue<string, string>();
    const first = queue.enqueue('conflict', async () => { throw new Error('409 conflict'); });
    const queued = queue.enqueue('stale-follow-up', async action => action);

    await expect(first).rejects.toThrow('409 conflict');
    expect(queue.hasFailure()).toBe(true);
    queue.resetAfterCanonicalRefresh();
    await expect(queued).rejects.toThrow('discarded after canonical refresh');
    await expect(queue.drain()).resolves.toBeUndefined();
    expect(queue.hasFailure()).toBe(false);
    expect(queue.hasPending()).toBe(false);
  });
});

describe('review item generation guard', () => {
  it('rejects late responses for another item or generation', () => {
    expect(isCurrentReviewGeneration('item-a', 3, 'item-a', 3)).toBe(true);
    expect(isCurrentReviewGeneration('item-b', 3, 'item-a', 3)).toBe(false);
    expect(isCurrentReviewGeneration('item-a', 4, 'item-a', 3)).toBe(false);
  });

  it('rejects a same-generation response when a local write began in flight', () => {
    expect(isCurrentReviewVersion('item-a', 3, 7, 'item-a', 3, 7)).toBe(true);
    expect(isCurrentReviewVersion('item-a', 3, 8, 'item-a', 3, 7)).toBe(false);
  });

  it('blocks proposal edits while a failed action or approval transition exists', () => {
    expect(canApplyProposalEdit(false, false)).toBe(true);
    expect(canApplyProposalEdit(true, false)).toBe(false);
    expect(canApplyProposalEdit(false, true)).toBe(false);
  });
});
