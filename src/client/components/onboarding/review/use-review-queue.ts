/**
 * Hook for managing the cursor-paginated Review Queue.
 * Consumes GET /api/onboarding/batches/:id/review-queue.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBatchReviewQueue } from '../../../onboarding-work-api';
import type {
  ReviewQueuePage,
  ReviewQueueRow,
  ReviewQueueCounts,
  ProjectionHealth,
  ReviewQueueStatusTotals,
  ReviewQueueProgress,
} from '../../../../shared/schemas/onboarding-review-queue';
import type { ReviewQueueFilters } from './review-logic';

export interface UseReviewQueueOptions {
  batchId: string;
  filters?: ReviewQueueFilters;
  pageSize?: number;
  selectedItemId?: string | null;
}

export interface UseReviewQueueResult {
  rows: ReviewQueueRow[];
  selectedRow?: ReviewQueueRow | null;
  selectedContextId?: string | null;
  counts: ReviewQueueCounts | null;
  statusTotals: ReviewQueueStatusTotals | null;
  progress: ReviewQueueProgress | null;
  projectionHealth: ProjectionHealth;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  refreshing?: boolean;
  error: string | null;
  loadQueue: (opts?: { silent?: boolean }) => Promise<void>;
  loadMore: () => Promise<void>;
  optimisticUpdateRow: (itemId: string, updates: Partial<ReviewQueueRow>) => void;
  optimisticRemoveRow: (itemId: string) => void;
}

const DEFAULT_PAGE_SIZE = 50;

const DEFAULT_PROJECTION_HEALTH: ProjectionHealth = {
  status: 'healthy',
  version: '1.0.0',
  computedAt: new Date().toISOString(),
  issues: [],
};

export function useReviewQueue({
  batchId,
  filters,
  pageSize = DEFAULT_PAGE_SIZE,
  selectedItemId = null,
}: UseReviewQueueOptions): UseReviewQueueResult {
  const [rows, setRows] = useState<ReviewQueueRow[]>([]);
  const [selectedRow, setSelectedRow] = useState<ReviewQueueRow | null | undefined>();
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
  const [counts, setCounts] = useState<ReviewQueueCounts | null>(null);
  const [statusTotals, setStatusTotals] = useState<ReviewQueueStatusTotals | null>(null);
  const [progress, setProgress] = useState<ReviewQueueProgress | null>(null);
  const [projectionHealth, setProjectionHealth] = useState<ProjectionHealth>(DEFAULT_PROJECTION_HEALTH);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestVersionRef = useRef(0);
  const paginationRequestRef = useRef<object | null>(null);
  const queueRequestInFlight = useRef(false);
  const selectedItemRef = useRef(selectedItemId);
  selectedItemRef.current = selectedItemId;

  const loadQueue = useCallback(
    async (opts?: { silent?: boolean }) => {
      const version = ++requestVersionRef.current;
      const contextId = selectedItemRef.current;
      queueRequestInFlight.current = true;
      setRefreshing(true);
      // The new queue request owns cancellation of any obsolete cursor read.
      paginationRequestRef.current = null;
      setLoadingMore(false);
      if (!opts?.silent) {
        setLoading(true);
        setRows([]);
        setSelectedRow(undefined);
        setSelectedContextId(null);
        setCounts(null);
        setStatusTotals(null);
        setProgress(null);
        setNextCursor(null);
      }
      // Keep a prior failure visible (and commands disabled) until a fresh
      // response succeeds, including background retries driven by SSE.
      try {
        const page: ReviewQueuePage = await getBatchReviewQueue(batchId, {
          ...filters,
          limit: pageSize,
          ...(contextId ? { selectedItemId: contextId } : {}),
        });
        if (version !== requestVersionRef.current) return;
        setRows(page.rows);
        setSelectedRow(page.selectedRow);
        setSelectedContextId(contextId);
        setCounts(page.counts);
        setStatusTotals(page.statusTotals ?? null);
        setProgress(page.progress ?? null);
        setProjectionHealth(page.projectionHealth);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (version !== requestVersionRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load review queue');
      } finally {
        if (version === requestVersionRef.current) {
          queueRequestInFlight.current = false;
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [batchId, filters, pageSize],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || paginationRequestRef.current || queueRequestInFlight.current) return;
    const version = requestVersionRef.current;
    const contextId = selectedItemRef.current;
    const owner = {};
    paginationRequestRef.current = owner;
    setLoadingMore(true);
    try {
      const page = await getBatchReviewQueue(batchId, {
        ...filters,
        cursor: nextCursor,
        limit: pageSize,
        ...(contextId ? { selectedItemId: contextId } : {}),
      });
      if (version !== requestVersionRef.current) return;
      setRows(prev => {
        const seen = new Set(prev.map(row => row.itemId));
        return [...prev, ...page.rows.filter(row => !seen.has(row.itemId))];
      });
      setNextCursor(page.nextCursor);
      if (selectedItemRef.current === contextId) {
        setSelectedRow(page.selectedRow);
        setSelectedContextId(contextId);
      }
      setCounts(page.counts);
      setStatusTotals(page.statusTotals ?? null);
      setProgress(page.progress ?? null);
      setProjectionHealth(page.projectionHealth);
    } catch (err) {
      if (version === requestVersionRef.current) setError(err instanceof Error ? err.message : 'Could not load more products');
    } finally {
      if (paginationRequestRef.current === owner) {
        paginationRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [batchId, filters, nextCursor, pageSize]);

  const optimisticUpdateRow = useCallback(
    (itemId: string, updates: Partial<ReviewQueueRow>) => {
      setRows(prev => prev.map(r => (r.itemId === itemId ? { ...r, ...updates } : r)));
    },
    [],
  );

  const optimisticRemoveRow = useCallback((itemId: string) => {
    setRows(prev => prev.filter(r => r.itemId !== itemId));
  }, []);

  useEffect(() => {
    setLoadingMore(false);
    void loadQueue();
    return () => { requestVersionRef.current++; paginationRequestRef.current = null; };
  }, [loadQueue]);

  return {
    rows,
    selectedRow,
    selectedContextId,
    counts,
    statusTotals,
    progress,
    projectionHealth,
    nextCursor,
    hasMore: Boolean(nextCursor),
    loading,
    loadingMore,
    refreshing,
    error,
    loadQueue,
    loadMore,
    optimisticUpdateRow,
    optimisticRemoveRow,
  };
}
