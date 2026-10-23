/**
 * Issue #351 — SKU-local evidence (TDD red test).
 *
 * A member with NO reviewed pair must resolve to `none`/unresolved through
 * the public seam, even when a cohort execution type is present. No parent
 * or sibling conclusion may fill an unsupported SKU result.
 */
import { describe, it, expect } from 'bun:test';
import {
  getEffectiveCurationProductType,
  getEffectiveClassification,
  getEffectiveCurationTypeForSnapshot,
} from '../../classification/effective-curation-type';
import type { StageContext, StageInput } from '../../classification/types';

const EMPTY_INPUT = {
  sku: 'SKU-1',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
} satisfies StageInput;

function contextWithExecutionType(): StageContext {
  // Issue #351: `cohortExecutionType` no longer exists on StageContext — a
  // stale execution conclusion cannot even be threaded, let alone fill a
  // result. The context below carries no reviewed pair and no execution key.
  return {
    workspacePath: '/tmp/ws',
    workspaceId: 'ws',
    configSnapshotRef: { id: 's', hash: 'h', sourceCommit: null, createdAt: '2026-08-01T00:00:00.000Z' },
    runId: 'run-1',
  };
}

describe('SKU-local evidence (issue #351)', () => {
  it('member with no reviewed pair resolves to none, not execution-filled', () => {
    const resolved = getEffectiveCurationProductType(EMPTY_INPUT, contextWithExecutionType());
    expect(resolved.source).toBe('none');
    expect(resolved.effectiveTypeId).toBeNull();
  });

  it('canonical classification with no reviewed pair is unresolved, not execution-filled', () => {
    const effective = getEffectiveClassification(EMPTY_INPUT, contextWithExecutionType());
    expect(effective.source).toBe('none');
    expect(effective.effectiveTypeId).toBeNull();
    expect(effective.effectiveCategoryId).toBeNull();
  });

  it('snapshot variant with no reviewed facts is unresolved, not execution-filled', () => {
    const resolved = getEffectiveCurationTypeForSnapshot(undefined);
    expect(resolved.source).toBe('none');
    expect(resolved.effectiveTypeId).toBeNull();
  });
});
