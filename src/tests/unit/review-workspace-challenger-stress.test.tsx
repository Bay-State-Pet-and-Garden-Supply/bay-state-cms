// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ReviewWorkspace } from '../../client/components/onboarding/review/ReviewWorkspace';
import { useReviewDetailCache } from '../../client/components/onboarding/review/use-review-detail-cache';
import { isGateBlocked, countGateBlockedItems } from '../../client/components/onboarding/review/review-logic';
import * as workApi from '../../client/onboarding-work-api';
import * as api from '../../client/onboarding-api';
import type { ReviewQueuePage, ReviewQueueRow } from '../../shared/schemas/onboarding-review-queue';

function makeQueueRow(i: number, overrides: Partial<ReviewQueueRow> = {}): ReviewQueueRow {
  return {
    itemId: `item_${i}`,
    upc: `10000000000${i.toString().padStart(3, '0')}`,
    displayTitle: `Product ${i}`,
    brand: 'Acme Brand',
    sourceType: 'official_page',
    imageUrl: `https://img.example/${i}.jpg`,
    family: null,
    reviewState: 'unreviewed',
    sortKey: `00_item_${i.toString().padStart(4, '0')}`,
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
      price: '29.99',
      quantity: 10,
      brandHint: 'Acme Brand',
      sourceType: 'official_page',
      curationData: {
        curatedTitle: `Curated Title ${itemId}`,
        curatedDescription: `Description for ${itemId}`,
        curatedWeight: '1.5 lbs',
        suggestedPages: ['p1'],
      },
      extractionData: { primaryImage: `https://img.example/${itemId}.jpg` },
    },
    sources: [],
    extraction: { primaryImage: `https://img.example/${itemId}.jpg` },
    consistencyWarnings: [],
    completeness: { ready: true, blockers: [], warnings: [], notes: [] },
  } as any;
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Challenger 2 Empirical Stress Suite // Milestone 1 (P1-C)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation(() => () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('1. LRU Cache & Request Bounding Stress under Rapid Navigation', () => {
    it('rapidly navigates across 25 items in a 500-item queue and asserts cache size NEVER exceeds 5', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => makeQueueRow(i));
      const page: ReviewQueuePage = {
        batchId: 'batch_500',
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
      vi.spyOn(api, 'getItemDetail').mockImplementation(async id => makeDetail(id));

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const hookResult = useReviewDetailCache({
          batchId: 'batch_500',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = hookResult;
        return <div data-size={hookResult.details.size} />;
      }

      // Initial render with item_0
      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      expect(cacheHookOutput!.details.size).toBeLessThanOrEqual(5);

      // Rapidly step through 25 items
      for (let i = 1; i <= 25; i++) {
        await act(async () => {
          root.render(<TestHarness selectedId={`item_${i}`} />);
        });

        // Invariant: At every single step, details map size must be <= 5
        expect(cacheHookOutput!.details.size).toBeLessThanOrEqual(5);
      }

      // Assert that oldest items (item_0, item_1, item_2, etc.) were evicted from LRU cache
      expect(cacheHookOutput!.details.has('item_0')).toBe(false);
      expect(cacheHookOutput!.details.has('item_1')).toBe(false);
      expect(cacheHookOutput!.details.has('item_2')).toBe(false);
      expect(cacheHookOutput!.details.has('item_3')).toBe(false);

      // Most recent items should be present
      expect(cacheHookOutput!.details.has('item_25')).toBe(true);
      expect(cacheHookOutput!.details.size).toBe(5);
    });

    it('asserts that stale in-flight requests are properly aborted via AbortController on fast navigation', async () => {
      const rows = Array.from({ length: 100 }, (_, i) => makeQueueRow(i));

      interface RequestRecord {
        itemId: string;
        signal?: AbortSignal | null;
        aborted: boolean;
        resolve: (value: any) => void;
      }

      const activeRequests: RequestRecord[] = [];

      vi.spyOn(api, 'getItemDetail').mockImplementation((id: string, options?: RequestInit) => {
        return new Promise((resolve, reject) => {
          const rec: RequestRecord = {
            itemId: id,
            signal: options?.signal,
            aborted: Boolean(options?.signal?.aborted),
            resolve,
          };
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              rec.aborted = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
          activeRequests.push(rec);
        });
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const hookResult = useReviewDetailCache({
          batchId: 'batch_abort_test',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = hookResult;
        return <div data-count={activeRequests.length} />;
      }

      // 1. Select item_0 (triggers fetch for item_0, item_1, item_99)
      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      const initialRequests = [...activeRequests];
      expect(initialRequests.map(r => r.itemId)).toEqual(expect.arrayContaining(['item_0', 'item_1', 'item_99']));
      expect(initialRequests.every(r => !r.aborted)).toBe(true);

      // 2. Before item_0/1/99 resolve, rapidly jump to item_50
      await act(async () => {
        root.render(<TestHarness selectedId="item_50" />);
      });

      // Assert that previous in-flight requests for item_0, item_1, item_99 were ABORTED
      const staleItem0 = initialRequests.find(r => r.itemId === 'item_0');
      const staleItem1 = initialRequests.find(r => r.itemId === 'item_1');
      const staleItem99 = initialRequests.find(r => r.itemId === 'item_99');

      expect(staleItem0?.signal?.aborted).toBe(true);
      expect(staleItem1?.signal?.aborted).toBe(true);
      expect(staleItem99?.signal?.aborted).toBe(true);

      // New requests should be for item_50, item_51, item_49
      const newRequests = activeRequests.filter(r => ['item_50', 'item_51', 'item_49'].includes(r.itemId));
      expect(newRequests.length).toBeGreaterThanOrEqual(3);
      expect(newRequests.every(r => !r.aborted)).toBe(true);

      // 3. Resolve the item_50 request
      const item50Req = newRequests.find(r => r.itemId === 'item_50');
      await act(async () => {
        item50Req?.resolve(makeDetail('item_50'));
      });

      // Item 50 should now be in details map, but aborted stale items should NOT be
      expect(cacheHookOutput!.details.has('item_50')).toBe(true);
      expect(cacheHookOutput!.details.has('item_0')).toBe(false);
      expect(cacheHookOutput!.detailErrors.has('item_0')).toBe(false); // Abort error not treated as detailError
    });

    it('asserts that no requests are made for unselected non-adjacent items in a 500-item queue', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => makeQueueRow(i));
      const requestedIds = new Set<string>();

      vi.spyOn(api, 'getItemDetail').mockImplementation(async (id: string) => {
        requestedIds.add(id);
        return makeDetail(id);
      });

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        useReviewDetailCache({
          batchId: 'batch_bounding_test',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        return null;
      }

      // Initial selection at item_100
      await act(async () => {
        root.render(<TestHarness selectedId="item_100" />);
      });

      // Allowed requested items: active (item_100) + next (item_101) + prev (item_99)
      const allowed = new Set(['item_100', 'item_101', 'item_99']);
      expect(requestedIds.size).toBeLessThanOrEqual(3);
      for (const id of requestedIds) {
        expect(allowed.has(id)).toBe(true);
      }

      // Unselected items across the queue must NEVER have been requested
      expect(requestedIds.has('item_0')).toBe(false);
      expect(requestedIds.has('item_50')).toBe(false);
      expect(requestedIds.has('item_150')).toBe(false);
      expect(requestedIds.has('item_250')).toBe(false);
      expect(requestedIds.has('item_400')).toBe(false);
      expect(requestedIds.has('item_499')).toBe(false);

      // Jump to item_250
      await act(async () => {
        root.render(<TestHarness selectedId="item_250" />);
      });

      const allowedJump = new Set(['item_100', 'item_101', 'item_99', 'item_250', 'item_251', 'item_249']);
      for (const id of requestedIds) {
        expect(allowedJump.has(id)).toBe(true);
      }
      expect(requestedIds.size).toBeLessThanOrEqual(6);
    });

    it('handles rapid ping-pong navigation without cache corruption or redundant fetches', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => makeQueueRow(i));
      const fetchCounts = new Map<string, number>();

      vi.spyOn(api, 'getItemDetail').mockImplementation(async (id: string) => {
        fetchCounts.set(id, (fetchCounts.get(id) ?? 0) + 1);
        return makeDetail(id);
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId: 'batch_ping_pong',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      // Step 1: select item_0 (loads item_0, 1, 9)
      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      // Step 2: switch to item_1 (already in cache or prefetching)
      await act(async () => {
        root.render(<TestHarness selectedId="item_1" />);
      });

      // Step 3: switch back to item_0
      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      // Step 4: switch to item_1 again
      await act(async () => {
        root.render(<TestHarness selectedId="item_1" />);
      });

      // Assert item_0 and item_1 were NOT fetched multiple times unnecessarily
      expect(fetchCounts.get('item_0')).toBe(1);
      expect(fetchCounts.get('item_1')).toBe(1);
      expect(cacheHookOutput!.details.size).toBeLessThanOrEqual(5);
    });

    it('clears cache and aborts requests on batchId change', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => makeQueueRow(i));
      let abortCalled = false;

      vi.spyOn(api, 'getItemDetail').mockImplementation((id: string, options?: RequestInit) => {
        options?.signal?.addEventListener('abort', () => {
          abortCalled = true;
        });
        return new Promise(() => {}); // Never resolves
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ batchId, selectedId }: { batchId: string; selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId,
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      await act(async () => {
        root.render(<TestHarness batchId="batch_1" selectedId="item_0" />);
      });

      // Switch batchId
      await act(async () => {
        root.render(<TestHarness batchId="batch_2" selectedId="item_0" />);
      });

      expect(abortCalled).toBe(true);
      expect(cacheHookOutput!.details.size).toBe(0);
    });

    it('invalidateItem purges cache item and refetches if selected', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => makeQueueRow(i));
      let fetchCount = 0;

      vi.spyOn(api, 'getItemDetail').mockImplementation(async () => {
        fetchCount++;
        return makeDetail('item_0');
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId: 'batch_inv',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      expect(cacheHookOutput!.details.has('item_0')).toBe(true);
      const initialFetches = fetchCount;

      await act(async () => {
        cacheHookOutput!.invalidateItem('item_0');
      });

      expect(fetchCount).toBeGreaterThan(initialFetches);
    });
  });

  describe('2. Bulk Review Selection Gating (Fail-Closed Safety)', () => {
    it('isGateBlocked correctly identifies unknown and blocked statuses', () => {
      const readyRow = makeQueueRow(0, { reviewGateStatus: 'ready' });
      const blockedRow = makeQueueRow(1, { reviewGateStatus: 'blocked' });
      const unknownRow = makeQueueRow(2, { reviewGateStatus: 'unknown' });

      expect(isGateBlocked(readyRow)).toBe(false);
      expect(isGateBlocked(blockedRow)).toBe(true);
      expect(isGateBlocked(unknownRow)).toBe(true);
    });

    it('countGateBlockedItems counts all blocked and unknown items in selection', () => {
      const rows = [
        makeQueueRow(0, { reviewGateStatus: 'ready' }),
        makeQueueRow(1, { reviewGateStatus: 'ready' }),
        makeQueueRow(2, { reviewGateStatus: 'blocked' }),
        makeQueueRow(3, { reviewGateStatus: 'unknown' }),
        makeQueueRow(4, { reviewGateStatus: 'blocked' }),
      ];

      // Selecting all 5 items
      const selectedAll = ['item_0', 'item_1', 'item_2', 'item_3', 'item_4'];
      const blockedCount = countGateBlockedItems(selectedAll, rows);
      expect(blockedCount).toBe(3); // 2 blocked + 1 unknown

      // Selecting only ready items
      const selectedReady = ['item_0', 'item_1'];
      expect(countGateBlockedItems(selectedReady, rows)).toBe(0);

      // Selecting only blocked items
      const selectedBlocked = ['item_2', 'item_4'];
      expect(countGateBlockedItems(selectedBlocked, rows)).toBe(2);
    });

    it('ReviewWorkspace disables bulk review button when any selected item has reviewGateStatus="blocked" or "unknown"', async () => {
      const rows = [
        makeQueueRow(0, { reviewGateStatus: 'ready' }),
        makeQueueRow(1, { reviewGateStatus: 'blocked' }),
        makeQueueRow(2, { reviewGateStatus: 'unknown' }),
      ];

      const page: ReviewQueuePage = {
        batchId: 'b_gating',
        rows,
        nextCursor: null,
        counts: {
          total: 3,
          unreviewedTotal: 3,
          reviewedTotal: 0,
          readyCount: 1,
          blockedCount: 1,
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
        root.render(<ReviewWorkspace batchId="b_gating" />);
      });

      // Select item_0 (ready)
      const item0Checkbox = container.querySelector('#item_0 input[type="checkbox"]') as HTMLInputElement;
      expect(item0Checkbox).not.toBeNull();
      await act(async () => {
        item0Checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Find bulk review button
      let bulkBtn = Array.from(container.querySelectorAll('.rv-bulk-bar button')).find(b =>
        b.textContent?.includes('Mark reviewed'),
      ) as HTMLButtonElement;

      // With only item_0 selected (ready), bulk review button must be enabled
      expect(bulkBtn).toBeDefined();
      expect(bulkBtn.disabled).toBe(false);

      // Now also select item_1 (blocked)
      const item1Checkbox = container.querySelector('#item_1 input[type="checkbox"]') as HTMLInputElement;
      await act(async () => {
        item1Checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      bulkBtn = Array.from(container.querySelectorAll('.rv-bulk-bar button')).find(b =>
        b.textContent?.includes('Mark reviewed'),
      ) as HTMLButtonElement;

      // Must be disabled because 1 item is blocked
      expect(bulkBtn.disabled).toBe(true);
      expect(bulkBtn.textContent).toContain('1 blocked');

      // Now also select item_2 (unknown)
      const item2Checkbox = container.querySelector('#item_2 input[type="checkbox"]') as HTMLInputElement;
      await act(async () => {
        item2Checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      bulkBtn = Array.from(container.querySelectorAll('.rv-bulk-bar button')).find(b =>
        b.textContent?.includes('Mark reviewed'),
      ) as HTMLButtonElement;

      // Must be disabled with 2 blocked items
      expect(bulkBtn.disabled).toBe(true);
      expect(bulkBtn.textContent).toContain('2 blocked');
    });
  });

  describe('3. Dirty Inspector Draft Preservation during SSE Refresh', () => {
    it('preserves user input in inspector when multiple SSE refresh cycles fire in background', async () => {
      vi.useFakeTimers();

      const rows = [makeQueueRow(0), makeQueueRow(1)];
      const page: ReviewQueuePage = {
        batchId: 'b_sse_draft',
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

      let loadQueueCallCount = 0;
      vi.spyOn(workApi, 'getBatchReviewQueue').mockImplementation(async () => {
        loadQueueCallCount++;
        return { ...page, rows: page.rows.map(row => ({ ...row })),
          projectionHealth: { ...page.projectionHealth, computedAt: new Date().toISOString() } };
      });
      vi.spyOn(api, 'getItemDetail').mockImplementation(async id => makeDetail(id));

      let sseCallback: ((event: any) => void) | null = null;
      vi.spyOn(workApi, 'subscribeBatchEvents').mockImplementation((batchId, cb) => {
        sseCallback = cb;
        return () => {};
      });

      await act(async () => {
        root.render(<ReviewWorkspace batchId="b_sse_draft" />);
      });

      // Enter edit mode by clicking Edit button or modifying input
      const editBtn = Array.from(container.querySelectorAll('button')).find(
        b => b.textContent?.includes('Edit') || b.textContent?.includes('Save edits'),
      );
      if (editBtn && editBtn.textContent?.includes('Edit')) {
        await act(async () => {
          editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }

      // Modify the title input
      const titleInput = container.querySelector('#rv-edit-title') as HTMLInputElement;
      expect(titleInput).not.toBeNull();

      await act(async () => {
        // Bypass React's value tracker, as a real browser input event does.
        // A direct property assignment only changes the DOM, not the draft.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(titleInput, 'User Entered Critical Edit');
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(titleInput.value).toBe('User Entered Critical Edit');
      expect(container.querySelector('[data-onboarding-dirty="true"]')).not.toBeNull();

      // Fire multiple SSE events in rapid succession
      expect(sseCallback).not.toBeNull();
      await act(async () => {
        sseCallback!({ type: 'item:status', data: { itemId: 'item_1', status: 'ready' } });
        sseCallback!({ type: 'batch:progress', data: { reviewedTotal: 1 } });
      });

      // Advance debounce timer (900ms)
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      // Assert that loadQueue was triggered silently
      expect(loadQueueCallCount).toBeGreaterThanOrEqual(2);

      // Verify that user draft was NOT overwritten or wiped
      const titleAfterRefresh = container.querySelector('#rv-edit-title') as HTMLInputElement;
      expect(titleAfterRefresh).not.toBeNull();
      expect(titleAfterRefresh.value).toBe('User Entered Critical Edit');

      vi.useRealTimers();
    });
  });

  describe('4. Adversarial Concurrency, Navigation & Schema Invariants', () => {
    it('handles out-of-order / variable latency promise resolutions without exceeding maxCacheSize', async () => {
      const rows = Array.from({ length: 30 }, (_, i) => makeQueueRow(i));
      const resolvers = new Map<string, (val: any) => void>();

      vi.spyOn(api, 'getItemDetail').mockImplementation((id: string, options?: RequestInit) => {
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          resolvers.set(id, resolve);
        });
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId: 'batch_race_test',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      // Step 1: Render with item_0
      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      // Step 2: Jump through items 5, 10, 15, 20 without waiting
      for (const id of ['item_5', 'item_10', 'item_15', 'item_20']) {
        await act(async () => {
          root.render(<TestHarness selectedId={id} />);
        });
      }

      // Step 3: Resolve promises in reversed/chaotic order
      const idsToResolve = ['item_20', 'item_21', 'item_19', 'item_15', 'item_10', 'item_5', 'item_0'];
      for (const id of idsToResolve) {
        const resolve = resolvers.get(id);
        if (resolve) {
          await act(async () => {
            try {
              resolve(makeDetail(id));
            } catch {
              // Ignore abort rejections
            }
          });
        }
      }

      // Cache size must remain bounded <= 5
      expect(cacheHookOutput!.details.size).toBeLessThanOrEqual(5);
      // Active item (item_20) must be retained
      expect(cacheHookOutput!.details.has('item_20')).toBe(true);
    });

    it('records network failure in detailErrors without crashing adjacent or cached items', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => makeQueueRow(i));

      vi.spyOn(api, 'getItemDetail').mockImplementation(async (id: string) => {
        if (id === 'item_1') {
          throw new Error('Network error 500: Server unavailable');
        }
        return makeDetail(id);
      });

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId: 'batch_error_test',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      await act(async () => {
        root.render(<TestHarness selectedId="item_0" />);
      });

      // item_0 should succeed, item_1 (adjacent prefetch) should fail gracefully
      expect(cacheHookOutput!.details.has('item_0')).toBe(true);
      expect(cacheHookOutput!.detailErrors.has('item_1')).toBe(true);
      expect(cacheHookOutput!.detailErrors.get('item_1')).toContain('Network error 500');
    });

    it('prompts window.confirm when selecting another item while draft is dirty', async () => {
      const rows = [makeQueueRow(0), makeQueueRow(1)];
      const page: ReviewQueuePage = {
        batchId: 'b_confirm_guard',
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

      await act(async () => {
        root.render(<ReviewWorkspace batchId="b_confirm_guard" />);
      });

      // Start editing and make dirty
      const editBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Edit'));
      if (editBtn) {
        await act(async () => {
          editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }

      const titleInput = container.querySelector('#rv-edit-title') as HTMLInputElement;
      if (titleInput) {
        await act(async () => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
          )?.set;
          nativeInputValueSetter?.call(titleInput, 'Dirty Unsaved Change');
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }

      // User rejects discard dialog
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      // Try clicking item_1 in queue
      const item1Elem = container.querySelector('#item_1');
      if (item1Elem) {
        await act(async () => {
          item1Elem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
      }

      // Confirm dialog was indeed shown
      expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved listing changes and open another product?');

      // If user canceled, title should still remain 'Dirty Unsaved Change'
      const titleStillPresent = container.querySelector('#rv-edit-title') as HTMLInputElement;
      if (titleStillPresent) {
        expect(titleStillPresent.value).toBe('Dirty Unsaved Change');
      }

      confirmSpy.mockRestore();
    });

    it('survives rapid item navigation with bounded cache and correct active item', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => makeQueueRow(i));
      const page: ReviewQueuePage = {
        batchId: 'b_keyboard_stress',
        rows,
        nextCursor: null,
        counts: {
          total: 10,
          unreviewedTotal: 10,
          reviewedTotal: 0,
          readyCount: 10,
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

      await act(async () => {
        root.render(<ReviewWorkspace batchId="b_keyboard_stress" />);
      });

      // Rapidly click through items 1 to 5
      for (let k = 1; k <= 5; k++) {
        const rowElem = container.querySelector(`#item_${k}`);
        if (rowElem) {
          await act(async () => {
            rowElem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          });
        }
      }

      // Assert active item moved to item_5
      const activeRow = container.querySelector('.rv-row-active');
      expect(activeRow).not.toBeNull();
      expect(activeRow?.id).toBe('item_5');
    });

    it('500-item queue: executes 50 random jumps and confirms cache size never exceeds 5', async () => {
      const rows = Array.from({ length: 500 }, (_, i) => makeQueueRow(i));
      vi.spyOn(api, 'getItemDetail').mockImplementation(async id => makeDetail(id));

      let cacheHookOutput: ReturnType<typeof useReviewDetailCache> | null = null;

      function TestHarness({ selectedId }: { selectedId: string | null }) {
        const res = useReviewDetailCache({
          batchId: 'batch_500_random_jumps',
          selectedItemId: selectedId,
          visibleRows: rows,
          maxCacheSize: 5,
        });
        cacheHookOutput = res;
        return null;
      }

      // 50 random indices across the 500-item range
      const randomIndices = [
        12, 450, 89, 230, 4, 399, 100, 250, 499, 0, 77, 188, 305, 412, 55,
        144, 289, 360, 478, 23, 91, 166, 240, 311, 485, 10, 62, 134, 219,
        380, 490, 31, 79, 150, 275, 345, 420, 8, 99, 172, 260, 333, 444, 19,
        84, 160, 235, 390, 465, 50,
      ];

      for (const idx of randomIndices) {
        await act(async () => {
          root.render(<TestHarness selectedId={`item_${idx}`} />);
        });
        expect(cacheHookOutput!.details.size).toBeLessThanOrEqual(5);
      }

      expect(cacheHookOutput!.details.size).toBe(5);
      expect(cacheHookOutput!.details.has('item_50')).toBe(true);
    });
  });

  describe('5. Strict Schema Validation & Cursor Hash Tamper Safety', () => {
    it('ReviewQueueRowSchema strictly rejects forbidden detail blobs', async () => {
      const { ReviewQueueRowSchema } = await import('../../shared/schemas/onboarding-review-queue');

      const validRow = makeQueueRow(0);
      expect(() => ReviewQueueRowSchema.parse(validRow)).not.toThrow();

      // Prohibited heavy detail blobs
      const forbiddenBlobs = [
        { curatedDescription: 'Heavy description' },
        { description: 'Raw description' },
        { extraction: { title: 'Ext' } },
        { extractionData: { title: 'ExtData' } },
        { ocrData: { text: 'OCR' } },
        { packagingOcrData: { text: 'Packaging' } },
        { classificationProposals: [{ id: 'p1' }] },
        { proposalTrees: {} },
        { variantMatrix: {} },
        { sourceHtml: '<html></html>' },
        { rawItem: {} },
        { item: {} },
      ];

      for (const blob of forbiddenBlobs) {
        const contaminatedRow = { ...validRow, ...blob };
        expect(() => ReviewQueueRowSchema.parse(contaminatedRow)).toThrow();
      }
    });

    it('cursor validation detects filter hash mismatches and malformed cursors', async () => {
      const {
        encodeReviewQueueCursor,
        decodeReviewQueueCursor,
        validateReviewQueueCursor,
        computeReviewQueueFilterHash,
        ReviewQueueCursorError,
      } = await import('../../shared/schemas/onboarding-review-queue');

      const filtersA = { brand: 'Acme', sourceType: 'official_page' as const };
      const filtersB = { brand: 'Beta', sourceType: 'official_page' as const };

      const cursorForA = encodeReviewQueueCursor({
        v: 1,
        sortKey: '00_item_0010',
        itemId: 'item_10',
        filterHash: computeReviewQueueFilterHash(filtersA),
      });

      // Decoding valid cursor
      const decoded = decodeReviewQueueCursor(cursorForA);
      expect(decoded.sortKey).toBe('00_item_0010');
      expect(decoded.itemId).toBe('item_10');

      // Validating with matching filters succeeds
      expect(() => validateReviewQueueCursor(cursorForA, filtersA)).not.toThrow();

      // Validating with mismatched filters throws ReviewQueueCursorError (400)
      expect(() => validateReviewQueueCursor(cursorForA, filtersB)).toThrow(ReviewQueueCursorError);

      // Malformed cursor throws ReviewQueueCursorError
      expect(() => decodeReviewQueueCursor('not-a-valid-cursor')).toThrow(ReviewQueueCursorError);
      expect(() => decodeReviewQueueCursor('eyJzb21lIjoidmFsaWQuanNvbiJ9')).toThrow(ReviewQueueCursorError);
    });
  });
});


