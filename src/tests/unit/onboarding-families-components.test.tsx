// @vitest-environment jsdom
/**
 * Epic #46 Phase 5 — Processing + Waiting on Family view smoke tests.
 *
 * Verifies the cross-agent contract exports render, handle loading/empty
 * states, and show no fake progression controls. API module is mocked.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { BatchWorkState, OnboardingWorkState } from '../../shared/schemas/onboarding-work-state';
import type { CohortListResponse } from '../../shared/schemas/cohorts';

vi.mock('@/client/onboarding-work-api', () => ({
  getBatchWorkState: vi.fn(),
  getBatchWorkStateCounts: vi.fn(),
  getBatchWorkStateItems: vi.fn(),
  subscribeBatchEvents: vi.fn(() => () => {}),
}));
vi.mock('@/client/onboarding-api', () => ({
  getBatchCohorts: vi.fn(),
}));

import { getBatchWorkState, subscribeBatchEvents, getBatchWorkStateCounts, getBatchWorkStateItems } from '../../client/onboarding-work-api';
import { getBatchCohorts } from '../../client/onboarding-api';
import { ProcessingView } from '../../client/components/onboarding/processing/ProcessingView';
import { FamilyWaitingView } from '../../client/components/onboarding/families/FamilyWaitingView';

function workItem(partial: Partial<OnboardingWorkState>): OnboardingWorkState {
  return {
    itemId: 'item-1',
    category: 'processing',
    activity: null,
    label: 'Processing',
    detail: null,
    attentionReason: null,
    attentionAction: null,
    family: null,
    reviewState: null,
    stage: 'extraction',
    stageStatus: 'in_progress',
    upc: '012345678905',
    name: 'Test Product',
    brand: null,
    sourceType: 'official_page',
    domain: 'example.com',
    ...partial,
  } as OnboardingWorkState;
}

async function renderAsync(component: React.ReactElement): Promise<{ container: HTMLElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('ProcessingView (contract export)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders processing rows grouped by activity with no progression controls', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 1, needs_attention: 0, waiting_on_family: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [
        workItem({ itemId: 'p1', activity: 'extraction', label: 'Extracting product data', name: 'Chicken Treats', upc: '100000000001', brand: 'Blue Buffalo', stage: 'extraction', stageStatus: 'in_progress' }),
      ],
      total: 1,
    };
    vi.mocked(getBatchWorkState).mockResolvedValue(payload);

    const { container, unmount } = await renderAsync(<ProcessingView batchId="batch-1" />);

    expect(container.textContent).toContain('Extracting Product Data');
    expect(container.textContent).toContain('Chicken Treats');
    expect(container.textContent).toContain('100000000001');
    expect(container.textContent).toContain('Extracting product data');
    // Diagnostics-only stage badge is subtle, but the primary activity header is there.
    expect(container.textContent).toContain('extraction / in_progress');
    // NO fake progression controls.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.every((b) => !/advance|reset|skip/i.test(b.textContent ?? ''))).toBe(true);
    expect(vi.mocked(subscribeBatchEvents)).toHaveBeenCalledWith('batch-1', expect.any(Function));
    unmount();
  });

  it('renders an honest empty state', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 0, needs_attention: 0, waiting_on_family: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [],
      total: 0,
    };
    vi.mocked(getBatchWorkState).mockResolvedValue(payload);
    const { container, unmount } = await renderAsync(<ProcessingView batchId="batch-1" />);
    expect(container.textContent).toContain('Nothing processing right now');
    unmount();
  });
});

describe('FamilyWaitingView (contract export)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders family cards with readiness fraction and deep-link actions', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 0, needs_attention: 0, waiting_on_family: 1, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [
        workItem({
          itemId: 'w1',
          category: 'waiting_on_family',
          label: 'Family not ready yet',
          name: 'Chicken 30 lb',
          upc: '100000000001',
          stage: 'curation',
          stageStatus: 'pending',
          family: { cohortId: 'c1', label: 'Blue Buffalo Life Protection Chicken', memberCount: 4, readyCount: 3, blockedCount: 0, waitingOnItemIds: ['s1'] },
        }),
      ],
      total: 1,
    };
    const cohorts: CohortListResponse = {
      shadowObservations: [],
      cohorts: [{
        cohort: {
          id: 'c1', workspaceId: 'ws', batchId: 'batch-1', groupKey: 'k', groupLabel: 'Blue Buffalo Life Protection Chicken',
          groupingVersion: 'product-family-v1', membershipHash: 'h', status: 'forming', blockedReason: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', supersededAt: null,
        },
        members: [
          { onboardingItemId: 'r1', productSku: '100000000002', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h1', ordinal: 0, item: { id: 'r1', upc: '100000000002', name: 'Chicken 14 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'r2', productSku: '100000000003', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h2', ordinal: 1, item: { id: 'r2', upc: '100000000003', name: 'Chicken 24 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'r3', productSku: '100000000004', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h3', ordinal: 2, item: { id: 'r3', upc: '100000000004', name: 'Chicken 5 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'w1', productSku: '100000000001', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: null, ordinal: 3, item: { id: 'w1', upc: '100000000001', name: 'Chicken 30 lb' }, ready: false, state: 'waiting', blockedReason: null, waitingOn: [{ itemId: 's1', upc: '100000000005', name: 'Chicken 40 lb' }] },
        ],
        status: 'forming',
        state: 'waiting',
        blockedReason: null,
        memberCount: 4,
        readyCount: 3,
        waitingOn: [{ itemId: 's1', upc: '100000000005', name: 'Chicken 40 lb' }],
      }],
    };
    vi.mocked(getBatchWorkState).mockImplementation((_batchId, filters) => {
      // The sibling s1 is itself a Needs Attention item — a genuine blocker —
      // so it must deep-link to its exception workflow (audit M8 positive path).
      if (filters?.category === 'needs_attention') {
        return Promise.resolve({
          batchId: 'batch-1',
          counts: { processing: 0, needs_attention: 1, waiting_on_family: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
          items: [
            workItem({
              itemId: 's1',
              category: 'needs_attention',
              label: 'Verify official product page',
              name: 'Chicken 40 lb',
              upc: '100000000005',
              stage: 'discovery',
              stageStatus: 'needs_input',
            }),
          ],
          total: 1,
        } as BatchWorkState);
      }
      return Promise.resolve(payload);
    });
    vi.mocked(getBatchCohorts).mockResolvedValue(cohorts);

    const onOpenItem = vi.fn();
    const { container, unmount } = await renderAsync(
      <FamilyWaitingView batchId="batch-1" onOpenItem={onOpenItem} />,
    );

    expect(container.textContent).toContain('Blue Buffalo Life Protection Chicken');
    expect(container.textContent).toContain('3 / 4 products ready');
    expect(container.textContent).toContain('Waiting on');
    // Deep-link button triggers onOpenItem with the sibling id.
    const viewBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('View item'));
    expect(viewBtn).toBeTruthy();
    await act(async () => {
      viewBtn!.click();
    });
    expect(onOpenItem).toHaveBeenCalledWith('s1');
    // No manual Curation start control.
    expect(Array.from(container.querySelectorAll('button')).some((b) => /curate/i.test(b.textContent ?? ''))).toBe(false);
    unmount();
  });

  it('keeps merely-processing siblings non-actionable (audit M8 negative path)', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 0, needs_attention: 0, waiting_on_family: 1, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [
        workItem({
          itemId: 'w1',
          category: 'waiting_on_family',
          label: 'Family not ready yet',
          name: 'Chicken 30 lb',
          upc: '100000000001',
          stage: 'curation',
          stageStatus: 'pending',
          family: { cohortId: 'c1', label: 'Blue Buffalo Life Protection Chicken', memberCount: 4, readyCount: 3, blockedCount: 0, waitingOnItemIds: ['s1'] },
        }),
      ],
      total: 1,
    };
    const cohorts: CohortListResponse = {
      shadowObservations: [],
      cohorts: [{
        cohort: {
          id: 'c1', workspaceId: 'ws', batchId: 'batch-1', groupKey: 'k', groupLabel: 'Blue Buffalo Life Protection Chicken',
          groupingVersion: 'product-family-v1', membershipHash: 'h', status: 'forming', blockedReason: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', supersededAt: null,
        },
        members: [
          { onboardingItemId: 'r1', productSku: '100000000002', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h1', ordinal: 0, item: { id: 'r1', upc: '100000000002', name: 'Chicken 14 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'r2', productSku: '100000000003', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h2', ordinal: 1, item: { id: 'r2', upc: '100000000003', name: 'Chicken 24 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'r3', productSku: '100000000004', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: 'h3', ordinal: 2, item: { id: 'r3', upc: '100000000004', name: 'Chicken 5 lb' }, ready: true, state: 'ready', blockedReason: null, waitingOn: [] },
          { onboardingItemId: 'w1', productSku: '100000000001', normalizedBrand: 'Blue Buffalo', normalizedNameStem: 'chicken', extractionHash: null, ordinal: 3, item: { id: 'w1', upc: '100000000001', name: 'Chicken 30 lb' }, ready: false, state: 'waiting', blockedReason: null, waitingOn: [{ itemId: 's1', upc: '100000000005', name: 'Chicken 40 lb' }] },
        ],
        status: 'forming',
        state: 'waiting',
        blockedReason: null,
        memberCount: 4,
        readyCount: 3,
        waitingOn: [{ itemId: 's1', upc: '100000000005', name: 'Chicken 40 lb' }],
      }],
    };
    // s1 is NOT surfaced in needs_attention (it is merely processing), so the
    // family renders it as a non-actionable note instead of a URL workflow.
    vi.mocked(getBatchWorkState).mockImplementation((_batchId, filters) =>
      filters?.category === 'needs_attention'
        ? Promise.resolve({ batchId: 'batch-1', counts: { processing: 0, needs_attention: 0, waiting_on_family: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 }, items: [], total: 0 })
        : Promise.resolve(payload),
    );
    vi.mocked(getBatchCohorts).mockResolvedValue(cohorts);

    const onOpenItem = vi.fn();
    const { container, unmount } = await renderAsync(
      <FamilyWaitingView batchId="batch-1" onOpenItem={onOpenItem} />,
    );

    expect(container.textContent).toContain('Blue Buffalo Life Protection Chicken');
    expect(container.textContent).toContain('3 / 4 products ready');
    // No actionable deep-link for the merely-processing sibling.
    const viewBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('View item'));
    expect(viewBtn).toBeUndefined();
    expect(onOpenItem).not.toHaveBeenCalled();
    unmount();
  });

  it('renders an honest empty state', async () => {
    const payload: BatchWorkState = {
      batchId: 'batch-1',
      counts: { processing: 0, needs_attention: 0, waiting_on_family: 0, ready_for_review: 0, approved: 0, ready_to_export: 0, completed: 0, skipped: 0 },
      items: [],
      total: 0,
    };
    vi.mocked(getBatchWorkState).mockResolvedValue(payload);
    vi.mocked(getBatchCohorts).mockResolvedValue({ cohorts: [], shadowObservations: [] });
    const { container, unmount } = await renderAsync(<FamilyWaitingView batchId="batch-1" />);
    expect(container.textContent).toContain('No families are waiting right now');
    unmount();
  });
});
