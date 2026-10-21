/**
 * Epic #46 Phase 5 — family-logic unit tests (pure derivation).
 */
import { describe, it, expect } from 'vitest';
import type { OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';
import type { CurationCohortView, CohortMemberReadiness } from '../../shared/schemas/cohorts';
import { buildFamilyCards, readinessText } from '../../client/components/onboarding/families/family-logic';

function waitingItem(partial: Partial<OnboardingWorkState>): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'processing',
    activity: 'curation',
    label: 'Curating product',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    family: null,
    reviewState: null,
    stage: 'curation',
    stageStatus: 'pending',
    upc: '012345678905',
    name: 'Test Product',
    brand: null,
    sourceType: 'official_page',
    domain: 'example.com',
    ...partial,
  } as OnboardingWorkState;
}

function member(partial: Partial<CohortMemberReadiness> & { itemId: string; upc?: string; name?: string }): CohortMemberReadiness {
  return {
    onboardingItemId: partial.itemId,
    productSku: partial.upc ?? null,
    normalizedBrand: 'Brand',
    normalizedNameStem: 'Stem',
    extractionHash: partial.ready ? 'hash' : null,
    ordinal: partial.ordinal ?? 0,
    item: {
      id: partial.itemId,
      upc: partial.upc ?? '000000000000',
      name: partial.name ?? `Product ${partial.itemId}`,
    },
    ready: partial.state === 'ready',
    state: partial.state ?? 'waiting',
    blockedReason: partial.blockedReason ?? null,
    waitingOn: partial.waitingOn ?? [],
  };
}

function cohortView(partial: Partial<CurationCohortView>): CurationCohortView {
  return {
    cohort: {
      id: 'cohort-1',
      workspaceId: 'ws',
      batchId: 'batch-1',
      groupKey: 'brand|stem',
      groupLabel: 'Blue Buffalo Life Protection Chicken',
      groupingVersion: 'product-family-v1',
      membershipHash: 'hash',
      status: 'forming',
      blockedReason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      supersededAt: null,
    },
    members: [],
    status: 'forming',
    state: 'waiting',
    blockedReason: null,
    memberCount: 0,
    readyCount: 0,
    waitingOn: [],
    ...partial,
  };
}

describe('readinessText', () => {
  it('formats the readiness fraction with correct pluralization', () => {
    expect(readinessText(4, 3)).toBe('3 / 4 products ready');
    expect(readinessText(1, 0)).toBe('0 / 1 product ready');
  });
});

describe('buildFamilyCards', () => {
  it('groups waiting items by cohort and builds one card per family', () => {
    const waiting = [
      waitingItem({ itemId: 'w1', family: { cohortId: 'c1', label: 'Family A', memberCount: 3, readyCount: 2, blockedCount: 0, waitingOnItemIds: ['w2'] } }),
      waitingItem({ itemId: 'w2', family: { cohortId: 'c1', label: 'Family A', memberCount: 3, readyCount: 2, blockedCount: 0, waitingOnItemIds: ['w1'] } }),
      waitingItem({ itemId: 'w3', family: { cohortId: 'c2', label: 'Family B', memberCount: 2, readyCount: 1, blockedCount: 0, waitingOnItemIds: ['w4'] } }),
    ];
    const cards = buildFamilyCards(waiting, []);
    expect(cards).toHaveLength(2);
    expect(cards[0].cohortId).toBe('c1');
    expect(cards[0].label).toBe('Family A');
    expect(cards[1].cohortId).toBe('c2');
  });

  it('prefers the cohort view roster over the waiting members', () => {
    const view = cohortView({
      members: [
        member({ itemId: 'r1', state: 'ready', upc: '111', name: 'Ready Member' }),
        member({ itemId: 'w1', state: 'waiting', upc: '222', name: 'Waiting Member' }),
      ],
      memberCount: 2,
      readyCount: 1,
      state: 'waiting',
    });
    const cards = buildFamilyCards(
      [waitingItem({ itemId: 'w1', family: { cohortId: 'cohort-1', label: 'F', memberCount: 2, readyCount: 1, blockedCount: 0, waitingOnItemIds: ['r1'] } })],
      [view],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].members.map((m) => m.state).sort()).toEqual(['ready', 'waiting']);
    expect(cards[0].readyCount).toBe(1);
    expect(cards[0].memberCount).toBe(2);
    expect(cards[0].waitingCount).toBe(1);
    expect(cards[0].blocked).toBe(false);
  });

  it('derives blocked state from blocked members and surfaces their reason', () => {
    const view = cohortView({
      members: [
        member({ itemId: 'r1', state: 'ready', upc: '111' }),
        member({ itemId: 'b1', state: 'blocked', upc: '333', name: 'Blocked Member', blockedReason: 'Member failed in Discovery (SKU: 333)' }),
        member({ itemId: 'w1', state: 'waiting', upc: '222' }),
      ],
      memberCount: 3,
      readyCount: 1,
      state: 'blocked',
      blockedReason: 'Member failed in Discovery (SKU: 333)',
    });
    const cards = buildFamilyCards(
      [waitingItem({ itemId: 'w1', family: { cohortId: 'cohort-1', label: 'F', memberCount: 3, readyCount: 1, blockedCount: 1, waitingOnItemIds: ['r1'] } })],
      [view],
    );
    expect(cards[0].blocked).toBe(true);
    expect(cards[0].blockedCount).toBe(1);
    expect(cards[0].blockedReason).toContain('SKU: 333');
    // Blocked members are deep-link action items with kind 'blocked'.
    expect(cards[0].actionItems.some((a) => a.kind === 'blocked' && a.itemId === 'b1')).toBe(true);
    expect(cards[0].actionItems.some((a) => a.kind === 'blocked' && a.reason)).toBe(true);
  });

  it('assembles waiting-on deep links from cohort waitingOn and dedupes', () => {
    const view = cohortView({
      members: [
        member({ itemId: 'w1', state: 'waiting', upc: '222', waitingOn: [{ itemId: 'r1', upc: '111', name: 'Ready Member' }] }),
      ],
      waitingOn: [{ itemId: 'r1', upc: '111', name: 'Ready Member' }],
      memberCount: 2,
      readyCount: 1,
    });
    const cards = buildFamilyCards(
      [waitingItem({ itemId: 'w1', family: { cohortId: 'cohort-1', label: 'F', memberCount: 2, readyCount: 1, blockedCount: 0, waitingOnItemIds: ['r1'] } })],
      [view],
    );
    const waitingActions = cards[0].actionItems.filter((a) => a.kind === 'waiting');
    expect(waitingActions).toHaveLength(1);
    expect(waitingActions[0]).toMatchObject({ itemId: 'r1', upc: '111', name: 'Ready Member' });
  });

  it('degrades gracefully when a cohort view is missing (superseded between fetches)', () => {
    const cards = buildFamilyCards(
      [waitingItem({ itemId: 'w1', family: { cohortId: 'gone', label: 'Legacy Family', memberCount: 2, readyCount: 1, blockedCount: 0, waitingOnItemIds: ['w2'] } })],
      [],
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].label).toBe('Legacy Family');
    expect(cards[0].memberCount).toBe(2);
    expect(cards[0].readyCount).toBe(1);
    expect(cards[0].members[0].state).toBe('waiting');
    expect(cards[0].actionItems[0].itemId).toBe('w2');
  });

  it('ignores items without family context and sorts blocked families first', () => {
    const cards = buildFamilyCards(
      [
        waitingItem({ itemId: 'plain', family: null }),
        waitingItem({ itemId: 'wB', family: { cohortId: 'b', label: 'B Family', memberCount: 2, readyCount: 1, blockedCount: 1, waitingOnItemIds: [] } }),
        waitingItem({ itemId: 'wA', family: { cohortId: 'a', label: 'A Family', memberCount: 2, readyCount: 1, blockedCount: 0, waitingOnItemIds: [] } }),
      ],
      [],
    );
    expect(cards).toHaveLength(2);
    // A Family has no blocked members but arrives before B Family alphabetically;
    // blocked-first ordering still wins for B Family? B has blockedCount 1 → blocked.
    // buildFamilyCards derives blocked from family.blockedCount on the degraded path.
    expect(cards[0].cohortId).toBe('b');
    expect(cards[1].cohortId).toBe('a');
  });
});
