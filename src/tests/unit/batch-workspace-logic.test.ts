// @vitest-environment node
/**
 * Epic #46 Phase 3 — Batch Workspace pure-logic unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_TABS,
  getWorkspaceTab,
  getTabCount,
  totalItemCount,
  attentionIsUrgent,
  formatCount,
  buildWorkStateFilters,
  hasActiveFilters,
  reviewStateLabel,
  sourceTypeLabel,
  workspaceTabForCategory,
  WORK_STATE_CATEGORY_LABELS,
  REVIEW_LIST_FACETS,
  DEFAULT_REVIEW_LIST_FACET,
  isAwaitingReviewFacet,
} from '../../client/components/onboarding/batch-workspace-logic';
import type { WorkStateCounts } from '../../shared/schemas/onboarding-work-state';

const ZERO_COUNTS: WorkStateCounts = {
  processing: 0,
  needs_attention: 0,
  waiting_on_family: 0,
  ready_for_review: 0,
  approved: 0,
  ready_to_export: 0,
  completed: 0,
  skipped: 0,
};

describe('WORKSPACE_TABS', () => {
  it('orders Needs Attention first, then Processing, Waiting on Family, Review, Approved, Ready to Export', () => {
    expect(WORKSPACE_TABS.map(t => t.id)).toEqual([
      'needs_attention',
      'processing',
      'waiting_on_family',
      'review',
      'approved',
      'ready_to_export',
    ]);
  });

  it('every tab id resolves through getWorkspaceTab', () => {
    for (const tab of WORKSPACE_TABS) {
      expect(getWorkspaceTab(tab.id)).toBe(tab);
    }
  });

  it('throws on an unknown tab id', () => {
    expect(() => getWorkspaceTab('bogus' as never)).toThrow(/unknown workspace tab/i);
  });

  it('counts approved tab badge from approved only (M4 split)', () => {
    const approvedTab = WORKSPACE_TABS.find(t => t.id === 'approved')!;
    const counts: WorkStateCounts = {
      ...ZERO_COUNTS,
      approved: 10,
      ready_to_export: 4,
      completed: 2,
    };
    expect(getTabCount(approvedTab, counts)).toBe(10);
  });

  it('counts ready_to_export tab badge from ready_to_export only (Slice 2: completed excluded)', () => {
    const readyTab = WORKSPACE_TABS.find(t => t.id === 'ready_to_export')!;
    const counts: WorkStateCounts = {
      ...ZERO_COUNTS,
      approved: 10,
      ready_to_export: 4,
      completed: 2,
    };
    // Completed is a distinct terminal outcome — never merged into Ready to Export.
    expect(getTabCount(readyTab, counts)).toBe(4);
  });

  it('counts review tab badge from ready_for_review only', () => {
    const reviewTab = WORKSPACE_TABS.find(t => t.id === 'review')!;
    const counts: WorkStateCounts = { ...ZERO_COUNTS, ready_for_review: 7 };
    expect(getTabCount(reviewTab, counts)).toBe(7);
  });
});

describe('counts / prominence', () => {
  it('sums all eight categories in totalItemCount', () => {
    const counts: WorkStateCounts = {
      processing: 100,
      needs_attention: 5,
      waiting_on_family: 4,
      ready_for_review: 20,
      approved: 3,
      ready_to_export: 2,
      completed: 1,
      skipped: 9,
    };
    expect(totalItemCount(counts)).toBe(144);
  });

  it('is urgent only when needs_attention > 0', () => {
    expect(attentionIsUrgent(ZERO_COUNTS)).toBe(false);
    expect(attentionIsUrgent({ ...ZERO_COUNTS, needs_attention: 1 })).toBe(true);
  });

  it('formats counts with thousands separators', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1234)).toBe('1,234');
  });
});

describe('buildWorkStateFilters', () => {
  it('trims and includes only non-empty values', () => {
    expect(buildWorkStateFilters({ q: '  blue buffalo  ' })).toEqual({ q: 'blue buffalo' });
    expect(buildWorkStateFilters({})).toEqual({});
    expect(buildWorkStateFilters({ q: '', reviewState: '', sourceType: '' })).toEqual({});
  });

  it('maps review state and source type', () => {
    expect(
      buildWorkStateFilters({ reviewState: 'reviewed', sourceType: 'distributor_record' }),
    ).toEqual({ reviewState: 'reviewed', sourceType: 'distributor_record' });
  });

  it('includes category when provided', () => {
    expect(buildWorkStateFilters({ category: 'needs_attention' })).toEqual({
      category: 'needs_attention',
    });
  });
});

describe('hasActiveFilters', () => {
  it('is false for empty filters and pure category filters', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ category: 'processing' })).toBe(false);
  });

  it('is true for q, reviewState, sourceType, domain, cohortId', () => {
    expect(hasActiveFilters({ q: 'abc' })).toBe(true);
    expect(hasActiveFilters({ reviewState: 'unreviewed' })).toBe(true);
    expect(hasActiveFilters({ sourceType: 'official_page' })).toBe(true);
    expect(hasActiveFilters({ domain: 'bluebuffalo.com' })).toBe(true);
    expect(hasActiveFilters({ cohortId: 'c1' })).toBe(true);
  });
});

describe('labels', () => {
  it('covers every work-state category with a human label', () => {
    expect(WORK_STATE_CATEGORY_LABELS.needs_attention).toBe('Needs Attention');
    expect(Object.keys(WORK_STATE_CATEGORY_LABELS)).toHaveLength(8);
  });

  it('maps review states to friendly labels', () => {
    expect(reviewStateLabel('reviewed')).toBe('Reviewed');
    expect(reviewStateLabel('approved')).toBe('Approved');
    expect(reviewStateLabel('not_ready')).toBe('Not ready');
    expect(reviewStateLabel('unreviewed')).toBe('Unreviewed');
  });

  it('labels source types without leaking internals', () => {
    expect(sourceTypeLabel('distributor_record')).toBe('Distributor record');
    expect(sourceTypeLabel('official_page')).toBe('Official page');
    expect(sourceTypeLabel(null)).toBe('—');
  });
});

describe('workspaceTabForCategory', () => {
  it('maps operation categories to their tab', () => {
    expect(workspaceTabForCategory('needs_attention')).toBe('needs_attention');
    expect(workspaceTabForCategory('processing')).toBe('processing');
    expect(workspaceTabForCategory('waiting_on_family')).toBe('waiting_on_family');
    expect(workspaceTabForCategory('ready_for_review')).toBe('review');
    expect(workspaceTabForCategory('approved')).toBe('approved');
    expect(workspaceTabForCategory('ready_to_export')).toBe('ready_to_export');
  });

  it('Slice 2: completed and skipped are outcomes with no operation tab (never Approved / Ready-to-Export)', () => {
    expect(workspaceTabForCategory('completed')).toBeNull();
    expect(workspaceTabForCategory('skipped')).toBeNull();
  });
});

describe('review-list facets (Slice 2: category/reviewState independence)', () => {
  it('defaults the Review-listings stage list to Unreviewed', () => {
    expect(DEFAULT_REVIEW_LIST_FACET).toBe('unreviewed');
    expect(REVIEW_LIST_FACETS).toEqual(['unreviewed', 'reviewed', 'not_ready']);
  });

  it('counts only Unreviewed as awaiting review (Reviewed/Not-ready separated)', () => {
    expect(isAwaitingReviewFacet('unreviewed')).toBe(true);
    expect(isAwaitingReviewFacet('reviewed')).toBe(false);
    expect(isAwaitingReviewFacet('not_ready')).toBe(false);
  });
});
