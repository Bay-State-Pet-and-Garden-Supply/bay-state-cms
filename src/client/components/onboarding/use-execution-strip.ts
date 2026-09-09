/**
 * Slice 4-UI — ephemeral execution strip lifecycle hook (council plan §4.3).
 *
 * Owns the strip's two independent halves:
 * 1. Server-derived status — `executionState` plus the v2 server count
 *    matrix, fetched on a generation-guarded, overlap-free schedule.
 *    Running/paused is execution permission ONLY, never worker health.
 * 2. Ephemeral live activity — display-only SSE summaries received while
 *    this view is open. NEVER a source for status, counts, approval, or
 *    export eligibility.
 *
 * Lifecycle (budgets from `ExecutionStripBudgets`):
 * - initial refresh; refresh on every connection `open` (incl. reconnect);
 * - 400ms coalesced debounce with a 2s max-wait (continuous events cannot
 *   starve the trailing refresh);
 * - 15s periodic re-sync while visible; immediate refresh on
 *   visibility/focus/online return;
 * - connection states (connecting/connected/reconnecting/closed) DISTINCT
 *   from projection freshness (not-loaded/fresh/stale/error, derived from
 *   elapsed CLIENT time);
 * - no fetch means "not loaded", never "0"; failures retain the last
 *   success with an error badge, never overwrite with zero;
 * - generation-guarded fetches, no overlap, full teardown on
 *   unmount/batch-switch; periodic refresh never touches review state
 *   (this hook imports no review modules and issues no review requests).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_EXECUTION_STRIP_BUDGETS,
  appendTimelineItem,
  classifyStripFrame,
  computeProjectionFreshness,
  STRIP_ACTIVITY_EVENT_TYPES,
  type ExecutionStripBudgets,
  type ProjectionFreshness,
  type StripConnectionState,
  type StripTimelineItem,
} from './execution-strip-logic';
import {
  getExecutionStripSnapshot,
  type ExecutionStripSnapshot,
} from '../../onboarding-stage-api';

export type { ExecutionStripSnapshot };

export type FetchStripSnapshot = (batchId: string) => Promise<ExecutionStripSnapshot>;

/** Minimal EventSource surface the hook drives (injectable for tests). */
export interface StripEventSource {
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  /** Explicit server/transport close (distinct from transient errors). */
  onclose: ((ev: unknown) => void) | null;
}

export type StripEventSourceFactory = (url: string) => StripEventSource | null;

function defaultEventSourceFactory(url: string): StripEventSource | null {
  // No EventSource in this runtime (jsdom/SSR/tests): live activity is
  // unavailable, server polling still drives status/counts. Never throw here.
  if (typeof EventSource === 'undefined') return null;
  return new EventSource(url) as unknown as StripEventSource;
}

/** SSE representation selection lives in the URL (EventSource has no headers). */
export function executionStripEventsUrl(batchId: string): string {
  return `/api/onboarding/batches/${encodeURIComponent(batchId)}/events?stageVocabularyVersion=2`;
}

export interface UseExecutionStripOptions {
  batchId: string;
  budgets?: ExecutionStripBudgets;
  fetchSnapshot?: FetchStripSnapshot;
  createEventSource?: StripEventSourceFactory;
}

export interface UseExecutionStripResult {
  connection: StripConnectionState;
  freshness: ProjectionFreshness;
  snapshot: ExecutionStripSnapshot | null;
  /** Client receipt time of the last successful fetch (null = not loaded). */
  lastSuccessAtMs: number | null;
  /** Human-safe fetch failure reason (null when the last epoch succeeded). */
  fetchError: string | null;
  /** Display timeline: activity summaries + reconnect gap markers (capped). */
  timeline: StripTimelineItem[];
  budgets: ExecutionStripBudgets;
  /** Manual refresh (operator control + test seam). */
  refreshNow: () => void;
  /** Client clock tick — re-renders freshness labels without fetching. */
  nowMs: number;
}

let timelineIdCounter = 0;

export function useExecutionStrip(options: UseExecutionStripOptions): UseExecutionStripResult {
  const { batchId, fetchSnapshot, createEventSource } = options;
  const budgets = options.budgets ?? DEFAULT_EXECUTION_STRIP_BUDGETS;

  const [connection, setConnection] = useState<StripConnectionState>('connecting');
  const [snapshot, setSnapshot] = useState<ExecutionStripSnapshot | null>(null);
  const [lastSuccessAtMs, setLastSuccessAtMs] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<StripTimelineItem[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const budgetsRef = useRef(budgets);
  budgetsRef.current = budgets;
  const fetchRef = useRef<FetchStripSnapshot>(fetchSnapshot ?? getExecutionStripSnapshot);
  fetchRef.current = fetchSnapshot ?? getExecutionStripSnapshot;
  const factoryRef = useRef<StripEventSourceFactory>(createEventSource ?? defaultEventSourceFactory);
  factoryRef.current = createEventSource ?? defaultEventSourceFactory;

  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const esRef = useRef<StripEventSource | null>(null);
  const needsGapRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceActiveRef = useRef(false);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearDebounceTimers = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = null;
    }
    debounceActiveRef.current = false;
  }, []);

  const refresh = useCallback(
    (_reason: string) => {
      const generation = generationRef.current;
      if (!mountedRef.current || generationRef.current !== generation) return;
      // No overlap: a pending refresh runs once the in-flight epoch settles,
      // so an `open` racing the initial fetch still gets its trailing run.
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const run = fetchRef.current;
      run(batchId).then(
        (next) => {
          if (!mountedRef.current || generationRef.current !== generation) return;
          setSnapshot(next);
          setLastSuccessAtMs(Date.now());
          setFetchError(null);
        },
        (err: unknown) => {
          if (!mountedRef.current || generationRef.current !== generation) return;
          // Retain the last success with an error badge — never zero it.
          setFetchError(err instanceof Error ? err.message : String(err));
        },
      ).finally(() => {
        inFlightRef.current = false;
        if (!mountedRef.current || generationRef.current !== generation) {
          pendingRef.current = false;
          return;
        }
        if (pendingRef.current) {
          pendingRef.current = false;
          refresh('trailing');
        }
      });
    },
    [batchId],
  );

  const fireDebounced = useCallback(
    (generation: number) => {
      clearDebounceTimers();
      if (!mountedRef.current || generationRef.current !== generation) return;
      refresh('event');
    },
    [clearDebounceTimers, refresh],
  );

  const scheduleCoalesced = useCallback(
    (generation: number) => {
      const activeBudgets = budgetsRef.current;
      if (!debounceActiveRef.current) {
        debounceActiveRef.current = true;
        // Max-wait: continuous events cannot starve the trailing refresh.
        maxWaitTimerRef.current = setTimeout(
          () => fireDebounced(generation),
          activeBudgets.maxDebounceWaitMs,
        );
      }
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => fireDebounced(generation), activeBudgets.debounceMs);
    },
    [fireDebounced],
  );

  const pushTimeline = useCallback((item: StripTimelineItem) => {
    const activeBudgets = budgetsRef.current;
    setTimeline((prev) => appendTimelineItem(prev, item, activeBudgets.maxEntries));
  }, []);

  // ── Lifecycle: full teardown + re-init on batch switch; full teardown on unmount.
  useEffect(() => {
    mountedRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;

    // Reset per-batch state: no fetch means "not loaded", never "0"; the
    // previous batch's counts, errors, and ephemeral activity never leak.
    inFlightRef.current = false;
    pendingRef.current = false;
    needsGapRef.current = false;
    clearDebounceTimers();
    setConnection('connecting');
    setSnapshot(null);
    setLastSuccessAtMs(null);
    setFetchError(null);
    setTimeline([]);

    refresh('initial');

    // Display-only SSE while open. Named live events plus an unnamed
    // fallback; `welcome`/`ping` classify as connection frames and are
    // excluded from activity by `classifyStripFrame`.
    const source = factoryRef.current(executionStripEventsUrl(batchId));
    esRef.current = source;

    if (!source) {
      // No live stream in this runtime (see defaultEventSourceFactory).
      // Counts/freshness still refresh from the server; activity stays empty.
      setConnection('closed');
      needsGapRef.current = true;
    }

    const namedListeners: Array<{ type: string; listener: (ev: { data?: unknown }) => void }> = [];
    if (source) {
    source.onopen = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setConnection('connected');
      if (needsGapRef.current) {
        needsGapRef.current = false;
        timelineIdCounter += 1;
        pushTimeline({ kind: 'gap', id: `gap-${generation}-${timelineIdCounter}`, receivedAtMs: Date.now() });
      }
      refresh('open');
    };
    source.onerror = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      // Native EventSource reconnects on its own; the next `open` inserts
      // the gap marker and refetches. Freshness is untouched here — a
      // reconnecting stream with fresh counts still reads fresh.
      setConnection('reconnecting');
      needsGapRef.current = true;
    };
    source.onclose = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setConnection('closed');
      needsGapRef.current = true;
    };

    const handleFrame = (eventName: string, data: unknown) => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      const verdict = classifyStripFrame(eventName, String(data ?? ''), budgetsRef.current);
      if (verdict.outcome === 'connection') return;
      if (verdict.outcome === 'activity') {
        timelineIdCounter += 1;
        pushTimeline({
          kind: 'activity',
          id: `activity-${generation}-${timelineIdCounter}`,
          summary: verdict.facts.summary,
          receivedAtMs: Date.now(),
        });
      }
      if (verdict.outcome === 'activity' || verdict.refetchSuggested) {
        scheduleCoalesced(generation);
      }
    };

    for (const type of STRIP_ACTIVITY_EVENT_TYPES) {
      if (!source) break;
      const listener = (ev: { data?: unknown }) => handleFrame(type, ev.data);
      source.addEventListener(type, listener);
      namedListeners.push({ type, listener });
    }
    source.onmessage = (ev: { data: string }) => handleFrame('message', ev.data);
    } // end if (source) — no live stream without an EventSource-capable runtime

    const onVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!mountedRef.current || generationRef.current !== generation) return;
      refresh('visibility');
    };
    const onFocus = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      refresh('focus');
    };
    const onOnline = () => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      refresh('online');
    };

    const activeBudgets = budgetsRef.current;
    periodicTimerRef.current = setInterval(() => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      refresh('periodic');
    }, activeBudgets.refreshIntervalMs);
    // Client-clock tick re-renders freshness labels; it never fetches and
    // never resets review operations.
    tickTimerRef.current = setInterval(() => {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setNowMs(Date.now());
    }, 1000);

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
      window.addEventListener('online', onOnline);
    }

    return () => {
      generationRef.current += 1;
      mountedRef.current = false;
      clearDebounceTimers();
      if (periodicTimerRef.current) {
        clearInterval(periodicTimerRef.current);
        periodicTimerRef.current = null;
      }
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('online', onOnline);
      }
      for (const { type, listener } of namedListeners) {
        if (!source) break;
        try {
          source.removeEventListener(type, listener);
        } catch {
          // Best-effort teardown; close below is the guarantee.
        }
      }
      if (source) {
      source.onopen = null;
      source.onerror = null;
      source.onmessage = null;
      source.onclose = null;
      try {
        source.close();
      } catch {
        // Close is best-effort; timers/listeners above are already cleared.
      }
      }
      esRef.current = null;
    };
    // `refresh`/push/schedule fns are stable per batchId; budgets ride
    // `budgetsRef` so budget identity churn never resubscribes.
  }, [batchId, refresh]);

  // Remount the hook instance for a new mounted session (StrictMode-safe:
  // the effect teardown above already invalidates the old generation).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const freshness = useMemo<ProjectionFreshness>(
    () =>
      computeProjectionFreshness({
        lastSuccessAtMs,
        nowMs,
        staleAfterMs: budgets.staleAfterMs,
        fetchFailed: fetchError !== null,
        projectionDegraded: snapshot?.projectionDegraded ?? false,
      }),
    [lastSuccessAtMs, nowMs, budgets.staleAfterMs, fetchError, snapshot],
  );

  return {
    connection,
    freshness,
    snapshot,
    lastSuccessAtMs,
    fetchError,
    timeline,
    budgets,
    refreshNow: () => refresh('manual'),
    nowMs,
  };
}
