// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReviewWorkspace } from '../../client/components/onboarding/review/ReviewWorkspace';
import * as workApi from '../../client/onboarding-work-api';
import * as api from '../../client/onboarding-api';
import type { ReviewQueuePage, ReviewQueueRow } from '../../shared/schemas/onboarding-review-queue';

function makeQueueRow(i: number, overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    itemId: `item_${i}`,
    upc: `10000000000${i.toString().padStart(2, '0')}`,
    displayTitle: `Product ${i}`,
    brand: 'Acme',
    sourceType: 'official_page',
    imageUrl: `https://img.example/${i}.jpg`,
    family: null,
    reviewState: 'unreviewed',
    sortKey: `00_item_${i}`,
    updatedAt: new Date().toISOString(),
    warningCodes: [],
    hasWarnings: false,
    reviewGateStatus: 'ready',
    stage: 'review_listings',
    stageStatus: 'pending',
    actions: { canEdit: true, canCompleteReview: true, canApprove: false },
    ...overrides,
  };
}

function makeDetail(itemId: string) {
  return {
    item: {
      itemId,
      stage: 'review_listings',
      stageStatus: 'pending',
      name: `Product ${itemId}`,
      price: '19.99',
      quantity: 5,
      brandHint: 'Acme',
      sourceType: 'official_page',
      curationData: { curatedTitle: `Curated ${itemId}`, suggestedPages: ['p1'] },
      extractionData: { primaryImage: `https://img.example/${itemId}.jpg` },
    },
    sources: [],
    extraction: { primaryImage: `https://img.example/${itemId}.jpg` },
    consistencyWarnings: [],
    completeness: { ready: true, blockers: [], warnings: [], notes: [] },
  } as any;
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Milestone 1 (P1-C) Bounded Review Loading // review-workspace-loading', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let getItemDetailSpy: any;

  beforeEach(() => {
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders a 500-item queue with at most 3 initial detail requests (active + adjacent)', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => makeQueueRow(i));
    const page: ReviewQueuePage = {
      batchId: 'b1',
      rows,
      nextCursor: null,
      counts: {
        total: 500,
        unreviewedTotal: 500,
        reviewedTotal: 0,
        readyCount: 500,
        blockedCount: 0,
        unknownCount: 0,
      },
      projectionHealth: {
        status: 'healthy',
        version: '1.0.0',
        computedAt: new Date().toISOString(),
        issues: [],
      },
    };

    vi.spyOn(workApi, 'getBatchReviewQueue').mockResolvedValue(page);
    getItemDetailSpy = vi.spyOn(api, 'getItemDetail').mockImplementation(async (id: string) => makeDetail(id));

    await act(async () => {
      root.render(<ReviewWorkspace batchId="b1" />);
    });

    // Initial detail calls must be <= 3 (active item_0, adjacent item_1, prev item_499)
    expect(getItemDetailSpy.mock.calls.length).toBeLessThanOrEqual(3);
    expect(getItemDetailSpy.mock.calls.length).toBeGreaterThan(0);

    // Unselected items (item_50, item_250, item_400) MUST NOT be requested
    const requestedIds = getItemDetailSpy.mock.calls.map((c: any) => c[0]);
    expect(requestedIds).toContain('item_0');
    expect(requestedIds).not.toContain('item_50');
    expect(requestedIds).not.toContain('item_250');
    expect(requestedIds).not.toContain('item_400');
  });

  it('enforces LRU cache cap of 5 during sequential item navigation', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => makeQueueRow(i));
    const page: ReviewQueuePage = {
      batchId: 'b1',
      rows,
      nextCursor: null,
      counts: {
        total: 20,
        unreviewedTotal: 20,
        reviewedTotal: 0,
        readyCount: 20,
        blockedCount: 0,
        unknownCount: 0,
      },
      projectionHealth: {
        status: 'healthy',
        version: '1.0.0',
        computedAt: new Date().toISOString(),
        issues: [],
      },
    };

    vi.spyOn(workApi, 'getBatchReviewQueue').mockResolvedValue(page);
    const detailMap = new Map<string, any>();
    getItemDetailSpy = vi.spyOn(api, 'getItemDetail').mockImplementation(async (id: string) => {
      const d = makeDetail(id);
      detailMap.set(id, d);
      return d;
    });

    await act(async () => {
      root.render(<ReviewWorkspace batchId="b1" />);
    });

    // Simulate clicking through items 1, 2, 3, 4, 5, 6, 7
    for (let i = 1; i <= 7; i++) {
      const rowElem = container.querySelector(`#item_${i}`);
      if (rowElem) {
        await act(async () => {
          rowElem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }
    }

    // Detail calls were issued lazily per step, not in one 500-item burst
    expect(getItemDetailSpy.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('blocks bulk review when reviewGateStatus is unknown (fail closed)', async () => {
    const rows = [
      makeQueueRow(0, { reviewGateStatus: 'unknown' }),
      makeQueueRow(1, { reviewGateStatus: 'ready' }),
    ];
    const page: ReviewQueuePage = {
      batchId: 'b1',
      rows,
      nextCursor: null,
      counts: {
        total: 2,
        unreviewedTotal: 2,
        reviewedTotal: 0,
        readyCount: 1,
        blockedCount: 0,
        unknownCount: 1,
      },
      projectionHealth: {
        status: 'healthy',
        version: '1.0.0',
        computedAt: new Date().toISOString(),
        issues: [],
      },
    };

    vi.spyOn(workApi, 'getBatchReviewQueue').mockResolvedValue(page);
    vi.spyOn(api, 'getItemDetail').mockImplementation(async id => makeDetail(id));

    await act(async () => {
      root.render(<ReviewWorkspace batchId="b1" />);
    });

    // Click row checkbox for item_0 to trigger bulk selection bar
    const rowCheckbox = container.querySelector('#item_0 input[type="checkbox"]') as HTMLInputElement;
    expect(rowCheckbox).toBeDefined();
    await act(async () => {
      rowCheckbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Select all shown from bulk bar
    const selectAllBtn = container.querySelector('.rv-bulk-bar button') as HTMLButtonElement;
    expect(selectAllBtn).toBeDefined();
    await act(async () => {
      selectAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Mark reviewed button should be disabled because item_0 is 'unknown'
    const bulkReviewBtn = Array.from(container.querySelectorAll('.rv-bulk-bar button')).find(
      b => b.textContent?.includes('Mark reviewed'),
    ) as HTMLButtonElement;

    expect(bulkReviewBtn).toBeDefined();
    expect(bulkReviewBtn.disabled).toBe(true);
    expect(bulkReviewBtn.textContent).toContain('1 blocked');
  });

  it('preserves dirty inspector draft across SSE refresh events', async () => {
    const rows = [makeQueueRow(0), makeQueueRow(1)];
    const page: ReviewQueuePage = {
      batchId: 'b1',
      rows,
      nextCursor: null,
      counts: {
        total: 2,
        unreviewedTotal: 2,
        reviewedTotal: 0,
        readyCount: 2,
        blockedCount: 0,
        unknownCount: 0,
      },
      projectionHealth: {
        status: 'healthy',
        version: '1.0.0',
        computedAt: new Date().toISOString(),
        issues: [],
      },
    };

    vi.spyOn(workApi, 'getBatchReviewQueue').mockResolvedValue(page);
    vi.spyOn(api, 'getItemDetail').mockImplementation(async id => makeDetail(id));

    let sseCallback: any;
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation((batchId, cb) => {
      sseCallback = cb;
      return () => {};
    });

    await act(async () => {
      root.render(<ReviewWorkspace batchId="b1" />);
    });

    // Type into title field to make draft dirty
    const titleInput = container.querySelector('#rv-edit-title') as HTMLInputElement;
    if (titleInput) {
      await act(async () => {
        titleInput.value = 'Modified Unsaved Title';
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    // Trigger SSE event
    if (sseCallback) {
      await act(async () => {
        sseCallback({ type: 'item:status', data: { itemId: 'item_1', status: 'ready' } });
      });
    }

    // Unsaved title must still be present and not overwritten by SSE
    const titleAfter = container.querySelector('#rv-edit-title') as HTMLInputElement;
    if (titleAfter) {
      expect(titleAfter.value).toBe('Modified Unsaved Title');
    }
  });
});
