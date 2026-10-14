/**
 * Effective Curation Product Type resolver — pure unit tests (issue #351 SKU-local evidence).
 *
 * Covers: reviewed own-SKU resolution, the `none` outcome when no reviewed
 * pair exists (no execution fallback — execution values are never factual
 * authority), the snapshot-only reviewed-type reader, and the stage-facing
 * helper against a synthetic StageContext.
 */
import { describe, expect, it } from 'bun:test';
import {
  resolveEffectiveCurationType,
  getReviewedTypeFromSnapshot,
  getEffectiveCurationProductType,
  getEffectiveCurationTypeForSnapshot,
} from '../../classification/effective-curation-type';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { StageContext, StageInput } from '../../classification/types';
import type { ReviewedFact } from '../../classification/reviewed-facts';

const REVIEWED_ID = 'dry-dog-food';

function makeTypeFact(value: unknown): ReviewedFact {
  return {
    proposalId: 'p1',
    decisionId: 'd1',
    runId: 'r1',
    workspaceId: 'ws',
    productSku: 'sku',
    proposalType: 'primary_product_type',
    targetId: REVIEWED_ID,
    value,
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeNonTypeFact(proposalType: string, targetId: string): ReviewedFact {
  return {
    proposalId: 'p2',
    decisionId: 'd2',
    runId: 'r1',
    workspaceId: 'ws',
    productSku: 'sku',
    proposalType,
    targetId,
    value: 'Dog',
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeSnapshot(facts: ReviewedFact[]): RuntimeClassificationSnapshot {
  return { reviewedFacts: facts } as unknown as RuntimeClassificationSnapshot;
}

function makeContext(): StageContext {
  return {
    workspacePath: '/tmp/ws',
    workspaceId: 'ws',
    configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: '2026-08-01T00:00:00.000Z' },
    runId: 'run',
  };
}

const EMPTY_INPUT: StageInput = {
  sku: 'sku',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
};

describe('resolveEffectiveCurationType', () => {
  it('resolves the reviewed own-SKU type', () => {
    expect(resolveEffectiveCurationType(REVIEWED_ID)).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('ignores any execution value — an execution id never fills the result', () => {
    expect(resolveEffectiveCurationType(null, 'dry-dog-food')).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });

  it('treats empty-string ids as absent', () => {
    expect(resolveEffectiveCurationType('')).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
    expect(resolveEffectiveCurationType(REVIEWED_ID, '')).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('returns none when both ids are absent', () => {
    expect(resolveEffectiveCurationType(null, null)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });
});

describe('getReviewedTypeFromSnapshot', () => {
  it('returns null for an empty reviewed-facts list', () => {
    expect(getReviewedTypeFromSnapshot(makeSnapshot([]))).toBeNull();
  });

  it('returns null when the snapshot is absent', () => {
    expect(getReviewedTypeFromSnapshot(undefined)).toBeNull();
  });

  it('extracts the id from a { productTypeId } value shape', () => {
    const snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('extracts the id from a plain string value shape', () => {
    const snapshot = makeSnapshot([makeTypeFact(REVIEWED_ID)]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('ignores non-type facts', () => {
    const snapshot = makeSnapshot([
      makeNonTypeFact('field_assignment', 'flavor'),
      makeTypeFact({ productTypeId: REVIEWED_ID }),
    ]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('returns the first type fact when several exist', () => {
    const snapshot = makeSnapshot([
      makeTypeFact({ productTypeId: 'dog-treats' }),
      makeTypeFact({ productTypeId: REVIEWED_ID }),
    ]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe('dog-treats');
  });
});

describe('getEffectiveCurationProductType', () => {
  it('resolves the reviewed fact from the snapshot', () => {
    const input = { ...EMPTY_INPUT };
    const context = makeContext();
    context.snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getEffectiveCurationProductType(input, context)).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('returns none when no reviewed facts exist (no execution fallback)', () => {
    const context = makeContext();
    context.snapshot = makeSnapshot([]);
    expect(getEffectiveCurationProductType(EMPTY_INPUT, context)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });

  it('returns none without a snapshot and without reviewed facts', () => {
    const context = makeContext();
    context.snapshot = makeSnapshot([]);
    expect(getEffectiveCurationProductType(EMPTY_INPUT, context)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });

  it('honors an in-run accepted proposal through the unchanged reviewed helper', () => {
    const context = makeContext();
    context.snapshot = makeSnapshot([]);
    const input = {
      ...EMPTY_INPUT,
      acceptedProposals: [
        {
          id: 'acc-1',
          runId: 'run',
          productSku: 'sku',
          proposalType: 'primary_product_type' as const,
          targetId: 'dog-treats',
          proposedValue: { productTypeId: 'dog-treats' },
          confidence: 1,
          evidenceIds: [],
          status: 'accepted' as const,
          isBulkAcceptable: false,
          isStale: false,
          stalenessReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    };
    expect(getEffectiveCurationProductType(input, context)).toEqual({
      effectiveTypeId: 'dog-treats',
      source: 'reviewed',
    });
  });
});

describe('getEffectiveCurationTypeForSnapshot', () => {
  it('resolves the reviewed type from snapshot facts, ignoring any execution id', () => {
    const snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getEffectiveCurationTypeForSnapshot(snapshot, 'dry-dog-food')).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('returns none when the snapshot has no reviewed type, even with an execution id', () => {
    expect(getEffectiveCurationTypeForSnapshot(makeSnapshot([]), 'dry-dog-food')).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });

  it('returns none when the snapshot is absent and no reviewed type exists', () => {
    expect(getEffectiveCurationTypeForSnapshot(undefined, null)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });
});
