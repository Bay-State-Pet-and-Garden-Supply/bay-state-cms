/**
 * Epic #46 Phase 7/8 UI — approved-logic unit tests.
 * Selection state, outcome aggregation, export-status derivation, confirm gate.
 */
import { describe, expect, it } from 'vitest';
import {
  clearSelection,
  pruneSelection,
  selectAll,
  summarizeOutcomes,
  shouldConfirmApproveAll,
  toggleSelection,
  exportStatusPresentation,
  exportActionLabel,
} from '../../client/components/onboarding/approved/approved-logic.ts';
import type { ApprovalItemOutcome } from '../../shared/schemas/onboarding-work-state';

describe('selection state', () => {
  it('toggles ids in and out of the selection', () => {
    const s0 = { selectedIds: [], allEligibleIds: ['a', 'b', 'c'] };
    const s1 = toggleSelection(s0, 'a');
    expect(s1.selectedIds).toEqual(['a']);
    const s2 = toggleSelection(s1, 'a');
    expect(s2.selectedIds).toEqual([]);
    const s3 = toggleSelection(s2, 'b');
    expect(s3.selectedIds).toEqual(['b']);
  });

  it('selectAll selects only eligible ids', () => {
    const s = selectAll({ selectedIds: [], allEligibleIds: ['a', 'b'] });
    expect(s.selectedIds).toEqual(['a', 'b']);
  });

  it('clearSelection empties the selection', () => {
    const s = clearSelection({ selectedIds: ['a', 'b'], allEligibleIds: ['a', 'b'] });
    expect(s.selectedIds).toEqual([]);
  });

  it('pruneSelection drops ids that left the eligible set', () => {
    const s = pruneSelection(
      { selectedIds: ['a', 'b'], allEligibleIds: ['a', 'b', 'c'] },
      ['a', 'c'],
    );
    expect(s.selectedIds).toEqual(['a']);
    expect(s.allEligibleIds).toEqual(['a', 'c']);
  });
});

describe('outcome aggregation', () => {
  const outcomes: ApprovalItemOutcome[] = [
    { itemId: 'a', status: 'approved', reason: null },
    { itemId: 'b', status: 'approved', reason: null },
    { itemId: 'c', status: 'rejected', reason: 'semantic_validation_blocked: blocked' },
  ];

  it('counts approved/rejected and builds the retry set', () => {
    const summary = summarizeOutcomes(outcomes);
    expect(summary.approvedCount).toBe(2);
    expect(summary.rejectedCount).toBe(1);
    expect(summary.approvedIds).toEqual(['a', 'b']);
    expect(summary.retryIds).toEqual(['c']);
    expect(summary.rejected[0].reason).toContain('semantic_validation_blocked');
  });

  it('handles empty outcomes', () => {
    const summary = summarizeOutcomes([]);
    expect(summary.approvedCount).toBe(0);
    expect(summary.rejectedCount).toBe(0);
    expect(summary.retryIds).toEqual([]);
  });
});

describe('export-status derivation', () => {
  it('labels approved as draft-creation stage', () => {
    const pres = exportStatusPresentation('approved');
    expect(pres.canCreateDrafts).toBe(true);
    expect(pres.canOpenChangeSet).toBe(false);
    expect(pres.heading).toContain('awaiting CMS drafts');
  });

  it('labels ready_to_export as change-set review stage', () => {
    const pres = exportStatusPresentation('ready_to_export');
    expect(pres.canCreateDrafts).toBe(false);
    expect(pres.canOpenChangeSet).toBe(true);
    expect(pres.heading).toBe('CMS drafts created');
  });

  it('labels completed with verified language only', () => {
    const pres = exportStatusPresentation('completed');
    expect(pres.description).toContain('verified');
    expect(pres.description.toLowerCase()).not.toContain('published');
  });

  it('maps honest action labels', () => {
    expect(exportActionLabel('approved')).toBe('Create CMS drafts');
    expect(exportActionLabel('ready_to_export')).toBe('Open Change Set Review');
  });
});

describe('approve-all confirm gate', () => {
  it('requires confirmation for non-empty approve-all', () => {
    expect(shouldConfirmApproveAll(42, true)).toBe(true);
    expect(shouldConfirmApproveAll(0, true)).toBe(false);
    expect(shouldConfirmApproveAll(3, false)).toBe(false);
  });
});
