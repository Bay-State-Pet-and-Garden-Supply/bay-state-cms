/**
 * Bounded LRU Detail Cache (max 5 items) with Active + Adjacent Prefetching.
 *
 * Invariants:
 * 1. Immediate fetch for selected item.
 * 2. Adjacent prefetch ONLY for next and previous queued items (max 3 items in flight).
 * 3. Never loads details for all items in the queue.
 * 4. Stale request abortion (AbortController) on selection/batch change.
 * 5. Generation-guarded state updates.
 * 6. LRU cache size strictly capped at 5.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getItemDetail, type ItemDetailResponse } from '../../../onboarding-api';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import { findNextQueuedItem, findPreviousReviewTarget } from './review-logic';

export interface UseReviewDetailCacheOptions {
  batchId: string;
  selectedItemId: string | null;
  visibleRows: ReviewQueueRow[];
  maxCacheSize?: number; // default 5
}

export interface UseReviewDetailCacheResult {
  details: Map<string, ItemDetailResponse>;
  detailErrors: Map<string, string>;
  isDetailLoading: (itemId: string) => boolean;
  invalidateItem: (itemId: string) => void;
  updateCachedDetail: (
    itemId: string,
    updater: (prev: ItemDetailResponse) => ItemDetailResponse,
  ) => void;
  clearCache: () => void;
}

const DEFAULT_MAX_CACHE_SIZE = 5;

export function useReviewDetailCache({
  batchId,
  selectedItemId,
  visibleRows,
  maxCacheSize = DEFAULT_MAX_CACHE_SIZE,
}: UseReviewDetailCacheOptions): UseReviewDetailCacheResult {
  const [details, setDetails] = useState<Map<string, ItemDetailResponse>>(() => new Map());
  const [detailErrors, setDetailErrors] = useState<Map<string, string>>(() => new Map());
  const [inflightIds, setInflightIds] = useState<Set<string>>(() => new Set());

  // LRU ordering: least recently used at index 0, most recently used at the end
  const lruOrderRef = useRef<string[]>([]);
  // In-flight abort controllers
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Cache generation for batch invalidation
  const generationRef = useRef(0);

  // Clear cache on batchId change
  useEffect(() => {
    generationRef.current++;
    abortControllersRef.current.forEach(ctrl => ctrl.abort());
    abortControllersRef.current.clear();
    lruOrderRef.current = [];
    setDetails(new Map());
    setDetailErrors(new Map());
    setInflightIds(new Set());
  }, [batchId]);

  const touchLru = useCallback((itemId: string) => {
    lruOrderRef.current = lruOrderRef.current.filter(id => id !== itemId);
    lruOrderRef.current.push(itemId);
  }, []);

  const evictIfOverCapacity = useCallback(
    (protectedItemId: string | null) => {
      setDetails(prev => {
        if (lruOrderRef.current.length <= maxCacheSize) return prev;
        const next = new Map(prev);
        while (lruOrderRef.current.length > maxCacheSize) {
          // Find the oldest item that is not the active/protected item
          const evictCandidateIdx = lruOrderRef.current.findIndex(id => id !== protectedItemId);
          if (evictCandidateIdx === -1) break;
          const [evictedId] = lruOrderRef.current.splice(evictCandidateIdx, 1);
          next.delete(evictedId);
        }
        return next;
      });
    },
    [maxCacheSize],
  );

  const fetchDetail = useCallback(
    async (itemId: string, currentGen: number) => {
      if (details.has(itemId) || abortControllersRef.current.has(itemId)) {
        if (details.has(itemId)) touchLru(itemId);
        return;
      }

      const controller = new AbortController();
      abortControllersRef.current.set(itemId, controller);
      setInflightIds(prev => new Set(prev).add(itemId));

      try {
        const detail = await getItemDetail(itemId, { signal: controller.signal });
        if (controller.signal.aborted || generationRef.current !== currentGen) return;

        abortControllersRef.current.delete(itemId);
        setInflightIds(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });

        touchLru(itemId);
        setDetails(prev => new Map(prev).set(itemId, detail));
        setDetailErrors(prev => {
          if (!prev.has(itemId)) return prev;
          const next = new Map(prev);
          next.delete(itemId);
          return next;
        });
        evictIfOverCapacity(selectedItemId);
      } catch (err: unknown) {
        if (controller.signal.aborted || generationRef.current !== currentGen) return;
        abortControllersRef.current.delete(itemId);
        setInflightIds(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
        const msg = err instanceof Error ? err.message : String(err);
        setDetailErrors(prev => new Map(prev).set(itemId, msg));
      }
    },
    [details, selectedItemId, touchLru, evictIfOverCapacity],
  );

  // Active + Adjacent Prefetch Orchestration
  useEffect(() => {
    if (!selectedItemId) return;
    const currentGen = generationRef.current;

    // 1. Determine target IDs: active + next + previous
    const nextItem = findNextQueuedItem(visibleRows, selectedItemId);
    const prevItem = findPreviousReviewTarget(visibleRows, selectedItemId);

    const targetIds = [
      selectedItemId,
      nextItem?.itemId,
      prevItem?.itemId,
    ].filter((id): id is string => Boolean(id));

    const targetSet = new Set(targetIds);

    // 2. Abort non-target in-flight requests
    abortControllersRef.current.forEach((controller, itemId) => {
      if (!targetSet.has(itemId)) {
        controller.abort();
        abortControllersRef.current.delete(itemId);
        setInflightIds(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
    });

    // 3. Trigger active fetch first, then adjacent prefetches
    void fetchDetail(selectedItemId, currentGen);
    for (const targetId of targetIds) {
      if (targetId !== selectedItemId) {
        void fetchDetail(targetId, currentGen);
      }
    }
  }, [selectedItemId, visibleRows, fetchDetail]);

  const invalidateItem = useCallback(
    (itemId: string) => {
      lruOrderRef.current = lruOrderRef.current.filter(id => id !== itemId);
      setDetails(prev => {
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      setDetailErrors(prev => {
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
      const ctrl = abortControllersRef.current.get(itemId);
      if (ctrl) {
        ctrl.abort();
        abortControllersRef.current.delete(itemId);
        setInflightIds(prev => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
      // The orchestration effect fetches from the new cache state. Calling
      // fetchDetail here would see the old closed-over entry and skip refresh.
    },
    [],
  );

  const updateCachedDetail = useCallback(
    (itemId: string, updater: (prev: ItemDetailResponse) => ItemDetailResponse) => {
      setDetails(prev => {
        const existing = prev.get(itemId);
        if (!existing) return prev;
        return new Map(prev).set(itemId, updater(existing));
      });
    },
    [],
  );

  const clearCache = useCallback(() => {
    generationRef.current++;
    abortControllersRef.current.forEach(ctrl => ctrl.abort());
    abortControllersRef.current.clear();
    lruOrderRef.current = [];
    setDetails(new Map());
    setDetailErrors(new Map());
    setInflightIds(new Set());
  }, []);

  const isDetailLoading = useCallback(
    (itemId: string) => inflightIds.has(itemId),
    [inflightIds],
  );

  return {
    details,
    detailErrors,
    isDetailLoading,
    invalidateItem,
    updateCachedDetail,
    clearCache,
  };
}
