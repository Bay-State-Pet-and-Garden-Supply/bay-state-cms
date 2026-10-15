import type { ClassificationProposal } from '../shared/schemas/classification';
import type { CurationData } from '../shared/schemas/onboarding';

export type ReviewDecision = 'accepted' | 'rejected' | 'deferred';

export interface ProposalDecisionSnapshot {
  decision: ClassificationProposal['status'];
  hasRevisedValue: boolean;
  revisedValue?: unknown;
  hasRevisedTargetId: boolean;
  revisedTargetId?: string | null;
  /**
   * Selected evidence citations for this correction (issue #17 I). Optional;
   * part of the queued action snapshot and exact retry equality.
   */
  evidenceIds?: string[];
}

export interface PreparedDecisionInput {
  id: string;
  proposalId: string;
  decision: ReviewDecision;
  actionToken: string;
  expectedRevisionId: string | null;
  revisedValue?: unknown;
  revisedTargetId?: string | null;
  /** Evidence citations for this correction (issue #17 I). */
  evidenceIds?: string[];
}

export interface PreparedDecisionAction {
  input: PreparedDecisionInput;
  snapshot: ProposalDecisionSnapshot;
  semanticKey: string;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(child => cloneAndFreeze(child))) as T;
  }
  if (value && typeof value === 'object') {
    const clone = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, cloneAndFreeze(child)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined) return { __pipelineUndefined: true };
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { __pipelineNumber: String(value) };
  }
  return value;
}

/** JSON-semantic equality for proposal values, independent of object key order. */
function proposalValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
}

// Issue #354: the legacy type-only client mirrors
// (`getEffectiveProposalValue/TargetId`, `getEffectiveProductTypeId`,
// `withReviewedProductTypeId`) lived here with zero consumers — the server
// owns effective-value resolution and the canonical pair. Removed; the
// generic correction builders below stay.

/**
 * Return a proposal draft with a reviewer value correction. Selecting the
 * immutable prediction again removes the correction rather than rewriting the
 * prediction field.
 */
export function withReviewedProposalValue(
  proposal: ClassificationProposal,
  reviewedValue: unknown,
): ClassificationProposal {
  if (proposalValuesEqual(reviewedValue, proposal.proposedValue)) {
    const withoutRevision = { ...proposal };
    delete withoutRevision.revisedValue;
    return { ...withoutRevision, hasRevisedValue: false };
  }
  return { ...proposal, revisedValue: reviewedValue, hasRevisedValue: true };
}

/** Explicit null is a valid target correction and is retained by the presence flag. */
export function withReviewedProposalTarget(
  proposal: ClassificationProposal,
  reviewedTargetId: string | null,
): ClassificationProposal {
  if ((proposal.targetId ?? null) === reviewedTargetId) {
    const withoutRevision = { ...proposal };
    delete withoutRevision.revisedTargetId;
    return { ...withoutRevision, hasRevisedTargetId: false };
  }
  return { ...proposal, revisedTargetId: reviewedTargetId, hasRevisedTargetId: true };
}

export function proposalDecisionSnapshot(
  proposal: ClassificationProposal,
  evidenceIds?: string[],
): ProposalDecisionSnapshot {
  const hasRevisedValue = proposal.hasRevisedValue === true;
  const hasRevisedTargetId = proposal.hasRevisedTargetId === true;
  return {
    decision: proposal.status,
    hasRevisedValue,
    ...(hasRevisedValue ? { revisedValue: proposal.revisedValue } : {}),
    hasRevisedTargetId,
    ...(hasRevisedTargetId ? { revisedTargetId: proposal.revisedTargetId ?? null } : {}),
    // Stored citations from the hydrated live decision become part of the
    // canonical prior snapshot, so removing the SOLE stored citation produces
    // a different snapshot and a real revision action (issue #17 pass 5c).
    ...(evidenceIds && evidenceIds.length > 0 ? { evidenceIds: [...new Set(evidenceIds)].sort() } : {}),
  };
}

function proposalDecisionSnapshotsEqual(
  left: ProposalDecisionSnapshot,
  right: ProposalDecisionSnapshot,
): boolean {
  const sameCitations = sameStringSet(left.evidenceIds ?? [], right.evidenceIds ?? []);
  return left.decision === right.decision
    && left.hasRevisedValue === right.hasRevisedValue
    && (!left.hasRevisedValue || proposalValuesEqual(left.revisedValue, right.revisedValue))
    && left.hasRevisedTargetId === right.hasRevisedTargetId
    && (!left.hasRevisedTargetId || (left.revisedTargetId ?? null) === (right.revisedTargetId ?? null))
    && sameCitations;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const l = [...new Set(left)].sort().join('\u0000');
  const r = [...new Set(right)].sort().join('\u0000');
  return l === r;
}

export function isReviewDecision(status: ClassificationProposal['status']): status is ReviewDecision {
  return status === 'accepted' || status === 'rejected' || status === 'deferred';
}

function decisionSemanticKey(input: Omit<PreparedDecisionInput, 'id' | 'actionToken'>): string {
  return JSON.stringify(normalizeJson(input));
}

/**
 * Build one immutable decision action. The prior snapshot is the latest
 * canonical or optimistically queued state for this proposal, so no-op clicks
 * do not create revisions. An exact retry returns the prior action verbatim.
 */
export function prepareDecisionAction(args: {
  proposal: ClassificationProposal;
  priorSnapshot: ProposalDecisionSnapshot;
  expectedRevisionId: string | null;
  existingAction?: PreparedDecisionAction;
  /** Evidence citations selected for this correction (issue #17 I). */
  evidenceIds?: string[];
  createId: () => string;
  createActionToken: () => string;
}): PreparedDecisionAction | null {
  const baseSnapshot = proposalDecisionSnapshot(args.proposal);
  const snapshot = cloneAndFreeze<ProposalDecisionSnapshot>(
    args.evidenceIds && args.evidenceIds.length > 0
      ? { ...baseSnapshot, evidenceIds: [...new Set(args.evidenceIds)].sort() }
      : baseSnapshot,
  );
  if (!isReviewDecision(snapshot.decision)) return null;
  if (proposalDecisionSnapshotsEqual(snapshot, args.priorSnapshot)) return null;

  const semanticInput: Omit<PreparedDecisionInput, 'id' | 'actionToken'> = {
    proposalId: args.proposal.id,
    decision: snapshot.decision,
    expectedRevisionId: args.expectedRevisionId,
    ...(snapshot.hasRevisedValue ? { revisedValue: snapshot.revisedValue } : {}),
    ...(snapshot.hasRevisedTargetId ? { revisedTargetId: snapshot.revisedTargetId ?? null } : {}),
    ...(snapshot.evidenceIds?.length ? { evidenceIds: snapshot.evidenceIds } : {}),
  };
  const semanticKey = decisionSemanticKey(semanticInput);

  if (args.existingAction?.semanticKey === semanticKey) {
    return args.existingAction;
  }

  return cloneAndFreeze({
    input: {
      id: args.createId(),
      ...semanticInput,
      actionToken: args.createActionToken(),
    },
    snapshot,
    semanticKey,
  });
}

/** Remove canonical run-owned arrays from a generic item autosave payload. */
export function editableCurationData(current: Partial<CurationData>): Partial<CurationData> {
  const editable = { ...current };
  delete editable.classificationRunId;
  delete editable.classificationConfigSnapshot;
  delete editable.classificationEvidence;
  delete editable.classificationProposals;
  delete editable.classificationDecisions;
  delete editable.classificationHistory;
  return editable;
}

export class ActionQueueResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionQueueResetError';
  }
}

interface QueueEntry<Action, Result> {
  action: Action;
  run: (action: Action) => Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: unknown) => void;
}

interface QueueFailure<Action, Result> {
  entry: Pick<QueueEntry<Action, Result>, 'action' | 'run'>;
  error: unknown;
}

/**
 * A small fail-stop sequential queue. A failed action prevents later actions
 * and drain() rejects. retryFailed() executes the exact captured action again;
 * resetAfterCanonicalRefresh() discards queued local actions after a conflict.
 */
export class SequentialActionQueue<Action, Result> {
  private entries: Array<QueueEntry<Action, Result>> = [];
  private running: QueueEntry<Action, Result> | null = null;
  private failure: QueueFailure<Action, Result> | null = null;
  private drainWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  enqueue(action: Action, run: (action: Action) => Promise<Result>): Promise<Result> {
    const result = new Promise<Result>((resolve, reject) => {
      this.entries.push({ action, run, resolve, reject });
    });
    this.pump();
    return result;
  }

  hasPending(): boolean {
    return this.running !== null || this.entries.length > 0;
  }

  hasFailure(): boolean {
    return this.failure !== null;
  }

  getFailedAction(): Action | null {
    return this.failure?.entry.action ?? null;
  }

  drain(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure.error);
    if (!this.hasPending()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.drainWaiters.push({ resolve, reject });
    });
  }

  retryFailed(): Promise<Result> {
    if (!this.failure) {
      return Promise.reject(new Error('There is no failed action to retry.'));
    }
    const failed = this.failure.entry;
    this.failure = null;
    const retry = new Promise<Result>((resolve, reject) => {
      this.entries.unshift({ ...failed, resolve, reject });
    });
    this.pump();
    return retry;
  }

  resetAfterCanonicalRefresh(reason = 'Local actions were discarded after canonical refresh.'): void {
    if (this.running) {
      throw new Error('Cannot reset an action queue while an action is running.');
    }
    const error = new ActionQueueResetError(reason);
    for (const entry of this.entries.splice(0)) entry.reject(error);
    this.failure = null;
    for (const waiter of this.drainWaiters.splice(0)) waiter.resolve();
  }

  private pump(): void {
    if (this.running || this.failure) return;
    const entry = this.entries.shift();
    if (!entry) {
      for (const waiter of this.drainWaiters.splice(0)) waiter.resolve();
      return;
    }

    this.running = entry;
    void Promise.resolve()
      .then(() => entry.run(entry.action))
      .then(result => {
        this.running = null;
        entry.resolve(result);
        this.pump();
      })
      .catch(error => {
        this.running = null;
        this.failure = { entry: { action: entry.action, run: entry.run }, error };
        entry.reject(error);
        for (const waiter of this.drainWaiters.splice(0)) waiter.reject(error);
      });
  }
}

export function isCurrentReviewGeneration(
  currentItemId: string | null,
  currentGeneration: number,
  expectedItemId: string,
  expectedGeneration: number,
): boolean {
  return currentItemId === expectedItemId && currentGeneration === expectedGeneration;
}

/** A canonical response is stale if any local write began while it was pending. */
export function isCurrentReviewVersion(
  currentItemId: string | null,
  currentGeneration: number,
  currentMutationVersion: number,
  expectedItemId: string,
  expectedGeneration: number,
  expectedMutationVersion: number,
): boolean {
  return isCurrentReviewGeneration(
    currentItemId,
    currentGeneration,
    expectedItemId,
    expectedGeneration,
  ) && currentMutationVersion === expectedMutationVersion;
}

export function canApplyProposalEdit(queueFailed: boolean, reviewTransitioning: boolean): boolean {
  return !queueFailed && !reviewTransitioning;
}
