// @vitest-environment node
/**
 * Epic #46 Phase 6 — Review workspace pure-logic unit tests.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  applyQueueFilters,
  countReviewableSelection,
  distinctBrands,
  distinctFamilies,
  findNextQueuedItem,
  findNextReviewTarget,
  findPreviousReviewTarget,
  formatReviewProgress,
  hasActiveQueueFilters,
  isReviewed,
  itemDisplayName,
  pruneQueueSelection,
  reviewProgress,
  reviewableSelectionIds,
  selectAllVisible,
  sortForReview,
  toggleGroupSelection,
  toggleQueueSelection,
  warningInfoFromDetail,
  countGateBlockedItems,
  buildLegacyListingUpdatePayload,
  distributorApprovedImages,
  groupQueueItems,
  type ReviewQueueFilters,
} from '../../client/components/onboarding/review/review-logic';
import type { OnboardingWorkState, ReviewState } from '../../shared/schemas/onboarding-work-state';
import type { SourceType } from '../../shared/schemas/onboarding';

function makeItem(
  overrides: Partial<OnboardingWorkState> & { itemId: string; name: string },
): OnboardingWorkState {
  return {
    category: 'ready_for_review',
    label: 'Ready for review',
    activity: 'review',
    stage: 'review',
    stageStatus: 'pending',
    upc: '1000000000000',
    brand: null,
    sourceType: 'distributor_record',
    domain: null,
    reviewState: 'unreviewed',
    family: null,
    attentionReason: null,
    attentionAction: null,
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    detail: null,
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
    variantResolution: null,
    variantDisposition: null,
    ...overrides,
  };
}

const a = makeItem({ itemId: 'a', name: 'Alpha', reviewState: 'unreviewed' });
const b = makeItem({ itemId: 'b', name: 'Beta', reviewState: 'reviewed' });
const c = makeItem({ itemId: 'c', name: 'Charlie', reviewState: 'unreviewed' });
const d = makeItem({ itemId: 'd', name: 'Delta', reviewState: 'approved' });
const items = [a, b, c, d];

describe('sortForReview', () => {
  it('puts unreviewed first, then reviewed, then approved/rest', () => {
    const sorted = sortForReview(items);
    expect(sorted.map(i => i.itemId)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('breaks ties deterministically by name', () => {
    const x = makeItem({ itemId: 'x', name: 'Zulu' });
    const y = makeItem({ itemId: 'y', name: 'Alpha' });
    expect(sortForReview([x, y]).map(i => i.itemId)).toEqual(['y', 'x']);
  });

  it('handles null reviewState as unreviewed', () => {
    const z = makeItem({ itemId: 'z', name: 'Zed', reviewState: null });
    expect(sortForReview([b, z]).map(i => i.itemId)).toEqual(['z', 'b']);
  });
});

describe('reviewProgress', () => {
  it('computes counts from the loaded set', () => {
    const p = reviewProgress([a, b, c]);
    expect(p.total).toBe(3);
    expect(p.reviewedCount).toBe(1);
    expect(p.unreviewedCount).toBe(2);
    expect(p.remaining).toBe(2);
  });

  it('prefers server totals when provided and clamps', () => {
    const p = reviewProgress([a, b], { total: 212, reviewedTotal: 184 });
    expect(p.total).toBe(212);
    expect(p.reviewedCount).toBe(184);
    expect(p.unreviewedCount).toBe(28);
    expect(p.remaining).toBe(28);
  });

  it('clamps reviewed count to total', () => {
    const p = reviewProgress([a], { total: 5, reviewedTotal: 8 });
    expect(p.reviewedCount).toBe(5);
    expect(p.remaining).toBe(0);
  });

  it('counts approved as reviewed', () => {
    expect(reviewProgress([d]).reviewedCount).toBe(1);
  });
});

describe('formatReviewProgress', () => {
  it('formats the progress line', () => {
    expect(formatReviewProgress({ total: 212, reviewedCount: 184, unreviewedCount: 28, remaining: 28 })).toBe(
      'Reviewed 184 / 212',
    );
  });
});

describe('applyQueueFilters', () => {
  const warnedIds = new Set(['b']);
  const editedIds = new Set(['c']);

  it('filters by review state', () => {
    const f: ReviewQueueFilters = { reviewStates: ['reviewed'] };
    expect(applyQueueFilters(items, f).map(i => i.itemId)).toEqual(['b']);
  });

  it('filters by warnings only', () => {
    const f: ReviewQueueFilters = { warningsOnly: true };
    expect(applyQueueFilters(items, f, { warnedIds }).map(i => i.itemId)).toEqual(['b']);
  });

  it('filters by edited during review', () => {
    const f: ReviewQueueFilters = { editedOnly: true };
    expect(applyQueueFilters(items, f, { editedIds }).map(i => i.itemId)).toEqual(['c']);
  });

  it('filters by family cohort id', () => {
    const withFamily = makeItem({
      itemId: 'f1',
      name: 'Family one',
      family: { cohortId: 'coh-1', label: 'Family One', memberCount: 3, readyCount: 2, blockedCount: 0, waitingOnItemIds: [] },
    });
    const other = makeItem({ itemId: 'f2', name: 'Family two' });
    const f: ReviewQueueFilters = { familyCohortId: 'coh-1' };
    expect(applyQueueFilters([withFamily, other], f).map(i => i.itemId)).toEqual(['f1']);
  });

  it('filters by brand case-insensitively', () => {
    const blue = makeItem({ itemId: 'bl', name: 'Blue Buffalo', brand: 'Blue Buffalo' });
    const other = makeItem({ itemId: 'ot', name: 'Other', brand: 'Purina' });
    const f: ReviewQueueFilters = { brand: 'blue buffalo' };
    expect(applyQueueFilters([blue, other], f).map(i => i.itemId)).toEqual(['bl']);
  });

  it('filters by source type', () => {
    const official: SourceType = 'official_page';
    const withOfficial = makeItem({ itemId: 'o1', name: 'Official', sourceType: official });
    const dist = makeItem({ itemId: 'd1', name: 'Dist', sourceType: 'distributor_record' });
    const f: ReviewQueueFilters = { sourceType: 'official_page' };
    expect(applyQueueFilters([withOfficial, dist], f).map(i => i.itemId)).toEqual(['o1']);
    expect(applyQueueFilters([withOfficial, dist], { sourceType: 'all' }).length).toBe(2);
  });

  it('combined filters compose', () => {
    const warnedReviewed = makeItem({ itemId: 'wr', name: 'Warned Reviewed', reviewState: 'reviewed' });
    const warnedUnreviewed = makeItem({ itemId: 'wu', name: 'Warned Unreviewed', reviewState: 'unreviewed' });
    const f: ReviewQueueFilters = { warningsOnly: true, reviewStates: ['reviewed'] };
    expect(applyQueueFilters([warnedReviewed, warnedUnreviewed], f, { warnedIds: new Set(['wr', 'wu']) }).map(i => i.itemId)).toEqual(['wr']);
  });

  it('hasActiveQueueFilters detects any non-default filter', () => {
    expect(hasActiveQueueFilters({})).toBe(false);
    expect(hasActiveQueueFilters({ sourceType: 'all' })).toBe(false);
    expect(hasActiveQueueFilters({ brand: 'X' })).toBe(true);
    expect(hasActiveQueueFilters({ warningsOnly: true })).toBe(true);
  });
});

describe('findNextReviewTarget', () => {
  it('finds the next unreviewed item after the current', () => {
    const target = findNextReviewTarget(sortForReview(items), 'a');
    expect(target?.itemId).toBe('c');
  });

  it('wraps to the first unreviewed when none remains after the current', () => {
    const target = findNextReviewTarget(sortForReview(items), 'c');
    expect(target?.itemId).toBe('a');
  });

  it('skips ids marked done this session (optimistic review)', () => {
    const done = new Set(['c']);
    const target = findNextReviewTarget(sortForReview(items), 'a', done);
    expect(target?.itemId).toBe('a');
  });

  it('returns null when every item is reviewed/approved', () => {
    const allReviewed = sortForReview([a, c]).map(i => ({ ...i, reviewState: 'reviewed' as ReviewState }));
    expect(findNextReviewTarget(allReviewed, 'a')).toBeNull();
  });

  it('returns null for an empty queue', () => {
    expect(findNextReviewTarget([], null)).toBeNull();
  });

  it('starts from the first unreviewed when no current id', () => {
    expect(findNextReviewTarget(sortForReview(items), null)?.itemId).toBe('a');
  });
});

describe('findPreviousReviewTarget', () => {
  it('returns the previous in sorted order wrapping to the end', () => {
    const sorted = sortForReview(items);
    expect(findPreviousReviewTarget(sorted, 'a')?.itemId).toBe('d');
    expect(findPreviousReviewTarget(sorted, 'b')?.itemId).toBe('c');
  });

  it('returns null for an empty queue', () => {
    expect(findPreviousReviewTarget([], null)).toBeNull();
  });
});

describe('findNextQueuedItem', () => {
  it('returns the next item in sorted order (any state), wrapping to the start', () => {
    const sorted = sortForReview(items);
    expect(sorted.map(i => i.itemId)).toEqual(['a', 'c', 'b', 'd']);
    expect(findNextQueuedItem(sorted, 'a')?.itemId).toBe('c');
    expect(findNextQueuedItem(sorted, 'd')?.itemId).toBe('a');
  });

  it('starts from the first item when no current id', () => {
    expect(findNextQueuedItem(sortForReview(items), null)?.itemId).toBe('a');
  });

  it('returns null for an empty queue', () => {
    expect(findNextQueuedItem([], null)).toBeNull();
  });
});

describe('distinctBrands / distinctFamilies', () => {
  it('returns sorted unique brands ignoring blanks', () => {
    const f1 = makeItem({ itemId: 'x', name: 'X', brand: 'Purina' });
    const f2 = makeItem({ itemId: 'y', name: 'Y', brand: 'Blue Buffalo' });
    const f3 = makeItem({ itemId: 'z', name: 'Z', brand: 'Purina' });
    expect(distinctBrands([f1, f2, f3])).toEqual(['Blue Buffalo', 'Purina']);
  });

  it('dedupes families by cohort id and takes max member count', () => {
    const m1 = makeItem({
      itemId: 'm1',
      name: 'M1',
      family: { cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 3, readyCount: 1, blockedCount: 0, waitingOnItemIds: [] },
    });
    const m2 = makeItem({
      itemId: 'm2',
      name: 'M2',
      family: { cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 4, readyCount: 2, blockedCount: 0, waitingOnItemIds: [] },
    });
    const families = distinctFamilies([m1, m2]);
    expect(families).toEqual([{ cohortId: 'coh-9', label: 'Chicken Recipe', memberCount: 4 }]);
  });
});

describe('warningInfoFromDetail', () => {
  it('flags blocked semantic validation and collects messages', () => {
    const info = warningInfoFromDetail({
      semanticValidation: {
        status: 'blocked',
        findings: [{ message: 'Brand conflict within family' }],
      },
    });
    expect(info.blocked).toBe(true);
    expect(info.messages).toEqual(['Brand conflict within family']);
  });

  it('also reads curationData.semanticValidation and consistencyWarnings', () => {
    const info = warningInfoFromDetail({
      item: { curationData: { semanticValidation: { status: 'blocked', findings: [{ message: 'Type mismatch' }] } } },
      consistencyWarnings: [{ message: 'Varied curated titles in family' }],
    });
    expect(info.blocked).toBe(true);
    expect(info.messages).toEqual(['Type mismatch', 'Varied curated titles in family']);
  });

  it('passed validation is not blocked', () => {
    const info = warningInfoFromDetail({ item: { curationData: { semanticValidation: { status: 'passed', findings: [] } } } });
    expect(info.blocked).toBe(false);
    expect(info.messages).toEqual([]);
  });
});

describe('display helpers', () => {
  it('itemDisplayName prefers curated title', () => {
    expect(itemDisplayName(a, 'Curated Alpha')).toBe('Curated Alpha');
    expect(itemDisplayName(a, '  ')).toBe('Alpha');
    expect(itemDisplayName(a, null)).toBe('Alpha');
  });

  it('isReviewed covers reviewed and approved', () => {
    expect(isReviewed(a)).toBe(false);
    expect(isReviewed(b)).toBe(true);
    expect(isReviewed(d)).toBe(true);
  });
});
describe('bulk review selection (epic #46 follow-up, phase 4)', () => {
  it('toggleQueueSelection adds and removes order-stably', () => {
    expect(toggleQueueSelection([], 'x')).toEqual(['x']);
    expect(toggleQueueSelection(['x', 'y'], 'z')).toEqual(['x', 'y', 'z']);
    expect(toggleQueueSelection(['x', 'y'], 'x')).toEqual(['y']);
  });

  it('selectAllVisible dedupes and prunes to the visible set', () => {
    expect(selectAllVisible(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('toggleGroupSelection adds missing family members and removes when fully selected', () => {
    // Empty selection → whole family added.
    expect(toggleGroupSelection([], ['a', 'b'])).toEqual(['a', 'b']);
    // Partially selected → only the missing members are added (order-stable).
    expect(toggleGroupSelection(['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(toggleGroupSelection(['z', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['z', 'a', 'c', 'b']);
    // Fully selected → the whole family is removed, other selections kept.
    expect(toggleGroupSelection(['z', 'a', 'b'], ['a', 'b'])).toEqual(['z']);
    expect(toggleGroupSelection(['a', 'b'], ['a', 'b'])).toEqual([]);
    // Empty group is a no-op; duplicate group ids do not double-add.
    expect(toggleGroupSelection(['a'], [])).toEqual(['a']);
    expect(toggleGroupSelection([], ['a', 'a'])).toEqual(['a']);
  });

  it('pruneQueueSelection drops ids that left the queue', () => {
    expect(pruneQueueSelection(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(pruneQueueSelection([], ['a'])).toEqual([]);
  });

  it('countReviewableSelection counts only unreviewed selected items', () => {
    // a = unreviewed, b = reviewed, d = approved (from the shared fixtures)
    expect(countReviewableSelection(['a', 'b', 'd'], [a, b, d])).toBe(1);
    expect(countReviewableSelection(['b'], [a, b, d])).toBe(0);
    expect(countReviewableSelection(['a', 'missing'], [a, b, d])).toBe(1);
  });

  it('reviewableSelectionIds returns EXACTLY the ids the modal count shows (GPT review, MEDIUM)', () => {
    // Hidden/filtered selections are excluded: 'a' is visible+unreviewed,
    // 'b' is visible but reviewed, 'c' is selected but NOT in the visible
    // (filtered) set, 'd' is approved.
    expect(reviewableSelectionIds(['a', 'b', 'c', 'd'], [a, b, d])).toEqual(['a']);
    expect(reviewableSelectionIds(['c'], [a, b, d])).toEqual([]);
    expect(reviewableSelectionIds([], [a, b, d])).toEqual([]);
  });
});

describe('distributorApprovedImages (epic #46 follow-up)', () => {
  it('derives primary + additional from rights-attested approvals', () => {
    const images = distributorApprovedImages({
      distributorImageApprovals: [
        { imageUrl: 'https://cdn.example.com/a.jpg' },
        { imageUrl: 'https://cdn.example.com/b.jpg' },
        { imageUrl: '' },
      ],
    });
    expect(images).toEqual({ primary: 'https://cdn.example.com/a.jpg', additional: ['https://cdn.example.com/b.jpg'] });
  });

  it('returns null when there are no approvals or no extraction', () => {
    expect(distributorApprovedImages(null)).toBeNull();
    expect(distributorApprovedImages(undefined)).toBeNull();
    expect(distributorApprovedImages({})).toBeNull();
    expect(distributorApprovedImages({ distributorImageApprovals: [] })).toBeNull();
  });
});

describe('groupQueueItems (epic #46 follow-up)', () => {
  it('groups items by family cohort with family headers', () => {
    const fam1 = {
      cohortId: 'fam-1',
      label: 'Fromm Gold Dog Food',
      memberCount: 2,
      readyCount: 1,
      blockedCount: 0,
      waitingOnItemIds: [],
    };
    const famItem1 = makeItem({ itemId: 'f1', name: 'Fromm Gold 5lb', family: fam1 });
    const famItem2 = makeItem({ itemId: 'f2', name: 'Fromm Gold 15lb', family: fam1 });
    const standalone = makeItem({ itemId: 's1', name: 'Rawz Cat Food', family: null });

    const groups = groupQueueItems([famItem1, standalone, famItem2]);
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('family');
    expect(groups[0].title).toBe('Fromm Gold Dog Food');
    expect(groups[0].items.map(i => i.itemId)).toEqual(['f1', 'f2']);
    expect(groups[1].type).toBe('individual');
    expect(groups[1].title).toBe('Individual Products');
    expect(groups[1].items.map(i => i.itemId)).toEqual(['s1']);
  });

  it('renders a single group with no header title when all items are individual products', () => {
    const s1 = makeItem({ itemId: 's1', name: 'Product 1', family: null });
    const s2 = makeItem({ itemId: 's2', name: 'Product 2', family: null });

    const groups = groupQueueItems([s1, s2]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('individual');
    expect(groups[0].title).toBeNull();
    expect(groups[0].items.map(i => i.itemId)).toEqual(['s1', 's2']);
  });
});


// ─── e10s03: review readiness derivation (advisory + authoritative) ───────────

import {
  applyServerBlockers,
  deriveReadiness,
  diffEffectiveValues,
  effectiveGateValues,
  gateText,
  isDraftDirty,
  jumpTargetFor,
  parseBlockersFromRejection,
} from '../../client/components/onboarding/review/review-readiness';
import type { ItemDetailResponse } from '../../client/onboarding-api';
import { completeReviewStage } from '../../client/onboarding-api';

function makeDetail(overrides: Partial<Record<string, unknown>> = {}): ItemDetailResponse {
  return {
    item: {
      name: 'Imported Name',
      price: null,
      quantity: null,
      brandHint: null,
      sourceType: 'official_page',
      curationData: {},
      extractionData: null,
    },
    sources: [],
    extraction: null,
    consistencyWarnings: [],
    ...overrides,
  } as unknown as ItemDetailResponse;
}

describe('deriveReadiness // e10s03', () => {
  it('prefers the authoritative server completeness snapshot when present', () => {
    const detail = makeDetail({
      completeness: {
        ready: false,
        blockers: ['missing_price'],
        warnings: ['weight_missing'],
        notes: ['note'],
      },
    }) as any;
    const readiness = deriveReadiness(detail);
    expect(readiness.authoritative).toBe(true);
    expect(readiness.blockers).toEqual(['missing_price']);
    expect(readiness.warnings).toEqual(['weight_missing']);
  });

  it('advisory fallback: empty curated title with extraction title warns, does not block', () => {
    const detail = makeDetail();
    (detail.item as any).curationData = { curatedTitle: null };
    detail.extraction = { title: 'Extraction Title' } as any;
    const readiness = deriveReadiness(detail);
    expect(readiness.blockers).not.toContain('missing_name');
    expect(readiness.warnings).toContain('name_from_fallback_source');
  });

  it('advisory fallback: no name anywhere is a blocker', () => {
    const detail = makeDetail();
    (detail as any).item.name = null;
    const readiness = deriveReadiness(detail);
    expect(readiness.blockers).toContain('missing_name');
    expect(readiness.ready).toBe(false);
  });

  it('advisory fallback: missing price blocks for BOTH source types (promoter parity adjudication)', () => {
    const official = makeDetail();
    expect(deriveReadiness(official).blockers).toContain('missing_price');

    // item.price is the promoter's ONLY distributor price authority — an
    // empty one blocks the advisory view exactly like the server gate.
    const distributor = makeDetail({ item: { ...(official.item as any), sourceType: 'distributor_record' } });
    const readiness = deriveReadiness(distributor);
    expect(readiness.blockers).toContain('missing_price');
    expect(readiness.ready).toBe(false);
  });

  it('advisory fallback: brand hint and primary image gates fire', () => {
    const noBrand = makeDetail({ item: { name: 'X', price: '5', brandHint: null, curationData: { suggestedPages: ['p1'] }, sourceType: 'official_page', extractionData: { primaryImage: 'https://x/i.jpg' } } });
    expect(deriveReadiness(noBrand).blockers).toContain('missing_brand');

    const noImage = makeDetail({ item: { name: 'X', price: '5', brandHint: 'Acme', curationData: { suggestedPages: ['p1'] }, sourceType: 'official_page' } });
    const readiness = deriveReadiness(noImage);
    expect(readiness.blockers).toContain('missing_primary_image');
    expect(readiness.blockers).not.toContain('missing_brand');
    expect(readiness.blockers).not.toContain('missing_pages');
  });

  it('advisory fallback: no pages assignment blocks with missing_pages', () => {
    const readiness = deriveReadiness(makeDetail());
    expect(readiness.blockers).toContain('missing_pages');
  });

  it('advisory fallback: curated-quality warnings fire independently of blockers', () => {
    const readiness = deriveReadiness(makeDetail());
    for (const code of ['description_empty', 'keywords_empty', 'weight_missing']) {
      expect(readiness.warnings).toContain(code);
    }
  });

  it('advisory fallback: pending proposals warn when undecided decisions exist', () => {
    const detail = makeDetail();
    (detail.item as any).curationData = {
      classificationProposals: [{ id: 'p1', proposalType: 'primary_product_type', status: 'pending' }],
      classificationDecisions: [],
    };
    expect(deriveReadiness(detail).warnings).toContain('pending_proposals');

    (detail.item as any).curationData.classificationDecisions = [{ proposalId: 'p1', decision: 'accepted' }];
    expect(deriveReadiness(detail).warnings).not.toContain('pending_proposals');
  });
});

describe('stale-snapshot handling // e10s03', () => {
  it('applyServerBlockers merges codes, marks authoritative, and clears ready', () => {
    const readiness = deriveReadiness(makeDetail({ completeness: { ready: true, blockers: [], warnings: [], notes: [] } }));
    expect(readiness.ready).toBe(true);
    const merged = applyServerBlockers(readiness, ['missing_brand']);
    expect(merged.authoritative).toBe(true);
    expect(merged.ready).toBe(false);
    expect(merged.blockers).toContain('missing_brand');
  });

  it('parseBlockersFromRejection reads structured failures payload per item', () => {
    const err = Object.assign(new Error('Some items failed'), {
      payload: { failures: [{ itemId: 'a', blockers: ['missing_price'] }, { itemId: 'b', blockers: ['missing_name'] }] },
    });
    expect(parseBlockersFromRejection(err, 'a')).toEqual(['missing_price']);
    expect(parseBlockersFromRejection(err).sort()).toEqual(['missing_name', 'missing_price']);
  });

  it('parseBlockersFromRejection falls back to message parsing', () => {
    expect(parseBlockersFromRejection(new Error('x — Missing mandatory fields: missing_price, missing_brand')))
      .toEqual(['missing_price', 'missing_brand']);
    expect(parseBlockersFromRejection(new Error('unrelated'))).toEqual([]);
  });
});

describe('gate text + jump targets // e10s03', () => {
  it('every blocker and warning code has human field-naming text', () => {
    for (const code of ['missing_name', 'missing_price', 'missing_brand', 'missing_primary_image', 'missing_pages']) {
      expect(gateText(code)).toMatch(/Name|Price|Brand|image|Catalog Page/);
    }
    for (const code of ['name_from_fallback_source', 'description_empty', 'keywords_empty', 'weight_missing', 'pending_proposals', 'unverified_accepted_pages']) {
      expect(gateText(code)).not.toBe(code);
    }
  });

  it('jump targets map to field anchors or region anchors', () => {
    expect(jumpTargetFor('missing_name')).toBe('rv-edit-title');
    expect(jumpTargetFor('missing_price')).toBe('rv-edit-price');
    expect(jumpTargetFor('missing_brand')).toBe('rv-edit-brand');
    expect(jumpTargetFor('missing_primary_image')).toBe('rv-listing-media');
    expect(jumpTargetFor('missing_pages')).toBe('rv-pages-panel');
    expect(jumpTargetFor('unknown_code')).toBeNull();
  });
});

describe('dirty-state + confirm diff derivations // e10s02/s03', () => {
  const seed = { curatedTitle: 'A', brandHint: '', curatedWeight: '', curatedDescription: '', searchKeywords: '' };

  it('isDraftDirty: any keystroke counts; identical drafts are clean; nulls are clean', () => {
    expect(isDraftDirty(seed, seed)).toBe(false);
    expect(isDraftDirty(seed, { ...seed, curatedTitle: 'A ' })).toBe(true);
    expect(isDraftDirty(null, seed)).toBe(false);
    expect(isDraftDirty(seed, null)).toBe(false);
  });

  it('effectiveGateValues resolves the five mandatory-check values', () => {
    const detail = makeDetail();
    (detail.item as any).price = '12.50';
    (detail.item as any).brandHint = 'Acme';
    (detail.item as any).curationData = { suggestedPages: ['p1'], curatedTitle: 'T' };
    detail.extraction = { title: null, primaryImage: 'https://x/i.jpg' } as any;
    const values = effectiveGateValues(detail);
    expect(values).toEqual({ name: 'T', price: '12.50', brand: 'Acme', primaryImage: 'https://x/i.jpg', pages: 1 });
  });

  it('diffEffectiveValues returns changed rows only; empty diff means clean pass', () => {
    const before = { name: 'Old', price: null, brand: 'B', primaryImage: 'img', pages: 0 };
    expect(diffEffectiveValues(before, { ...before })).toEqual([]);

    const rows = diffEffectiveValues(before, { ...before, name: 'New', price: '9.99' });
    expect(rows.map(r => r.field)).toEqual(['Name', 'Price']);
    expect(rows[0]).toEqual({ field: 'Name', previous: 'Old', current: 'New' });
    expect(rows[1].previous).toBe('(empty)');
  });

describe('effectiveGateValues price parity // e10s03 review fix', () => {
  it('falls back to extraction price for official items when item.price is empty (promoter chain)', () => {
    const detail = makeDetail();
    (detail.item as any).price = null;
    detail.extraction = { title: null, primaryImage: 'https://x/i.jpg', price: '$8.25' } as any;
    const values = effectiveGateValues(detail);
    expect(values.price).toBe('$8.25');
  });

  it('never falls back to extraction price for distributor rows', () => {
    const detail = makeDetail();
    (detail.item as any).sourceType = 'distributor_record';
    (detail.item as any).price = null;
    detail.extraction = { title: null, primaryImage: null, price: '19.99' } as any;
    expect(effectiveGateValues(detail).price).toBeNull();
  });
});

describe('countGateBlockedItems // e10s03 bulk gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts gate-blocked and blocking-warning items; skips unloaded views', () => {
    const blockedWs = makeItem({ itemId: 'b1', name: 'B1' });
    delete (blockedWs as Record<string, unknown>).brandHint; // advisory missing_brand blocker
    const warnDetail = makeDetail();
    (warnDetail as any).semanticValidation = {
      status: 'blocked',
      findings: [{ message: 'species conflict' }],
    };
    const okWs: OnboardingWorkState = makeItem({ itemId: 'ok1', name: 'OK' });
    (okWs as Record<string, unknown>).brandHint = 'Acme';
    const okDetail = makeDetail({ completeness: { ready: true, blockers: [], warnings: [], notes: [] } });

    const count = countGateBlockedItems(['b1', 'w1', 'ok1', 'missing'], (id) => {
      if (id === 'b1') return { detail: null, workState: blockedWs };
      if (id === 'w1') return { detail: warnDetail, workState: (() => { const ws = makeItem({ itemId: 'w1', name: 'W1' }); (ws as Record<string, unknown>).brandHint = 'Acme'; return ws; })() };
      if (id === 'ok1') return { detail: okDetail, workState: okWs };
      return null;
    });
    expect(count).toBe(2);
  });
});

describe('completeReviewStage rejection payload // e10s03 seam', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches the response body as payload so structured failures[].blockers is readable', async () => {
    const body = {
      error: 'Review completion failed mandatory-field validation',
      code: 'review_incomplete',
      failures: [{ itemId: 'a1', blockers: ['missing_price', 'missing_pages'] }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const err: any = await completeReviewStage(['a1']).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeTruthy();
    expect(err.payload?.failures?.[0]?.blockers).toEqual(['missing_price', 'missing_pages']);
    // End-to-end: the real thrown error feeds the stale-snapshot corrector.
    expect(parseBlockersFromRejection(err, 'a1')).toEqual(['missing_price', 'missing_pages']);
  });
});
});

describe('buildLegacyListingUpdatePayload // blind review F3 flag-off payload pin', () => {
  it('pins the exact V1 save shape: legacy keys PLUS curatedWeight write-back', () => {
    const payload = buildLegacyListingUpdatePayload({
      curatedTitle: '  Reviewed Title  ',
      brandHint: ' Acme ',
      curatedWeight: '2 lb',
      curatedDescription: ' Desc ',
      searchKeywords: ' kw ',
    });
    // Exact key set — no price/quantity/sourceType leakage into the V1 path.
    expect(Object.keys(payload).sort()).toEqual(['brandHint', 'curation_data']);
    expect(payload).toEqual({
      curation_data: {
        curatedTitle: 'Reviewed Title',
        curatedWeight: '2 lb', // documented deviation: V1 Weight editor persists
        curatedDescription: 'Desc',
        searchKeywords: 'kw',
      },
      brandHint: 'Acme',
    });
  });

  it('trims to null for whitespace-only values (pre-epic nulling semantics)', () => {
    const payload = buildLegacyListingUpdatePayload({
      curatedTitle: '   ', brandHint: '', curatedWeight: '',
      curatedDescription: '', searchKeywords: '',
    });
    expect(payload.curation_data).toEqual({
      curatedTitle: null, curatedWeight: null, curatedDescription: null, searchKeywords: null,
    });
    expect(payload.brandHint).toBeNull();
  });
});
