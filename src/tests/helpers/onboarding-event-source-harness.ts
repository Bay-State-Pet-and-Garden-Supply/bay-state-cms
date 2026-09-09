/**
 * Slice 4-UI — deterministic EventSource/fetch harness (Vitest/jsdom).
 *
 * No production networking, no implicit auto-reconnect, no implicit
 * emissions: tests drive every `open` / named `message` / unnamed fallback
 * / `error` / `close` delivery in explicit injection order, resolve deferred
 * fetches in a chosen order, and advance a fixed fake clock inside `act`.
 *
 * Import this module BEFORE mounting the hook/component under test and pass
 * its factory into `ExecutionStrip` (`createEventSource`) so no global
 * `EventSource` patching is needed. Call `vi.useFakeTimers()` in the test
 * itself (the harness never owns the clock); restore with
 * `harness.restore()` + `vi.useRealTimers()` after each case — a leaked
 * handler/timer is a test failure, not cleanup noise.
 */
import { vi } from 'vitest';
import type {
  StripEventSource,
  StripEventSourceFactory,
} from '../../client/components/onboarding/use-execution-strip';

export type FrameListener = (ev: { data?: unknown }) => void;

export class MockEventSource implements StripEventSource {
  readonly url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closeCalls = 0;
  closed = false;
  private named = new Map<string, Set<FrameListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: FrameListener): void {
    let set = this.named.get(type);
    if (!set) {
      set = new Set();
      this.named.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: FrameListener): void {
    this.named.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.named.get(type)?.size ?? 0;
  }

  totalListenerCount(): number {
    let total = 0;
    for (const set of this.named.values()) total += set.size;
    return total;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }

  /** Drive an `open` delivery (initial connect or reconnect). */
  deliverOpen(): void {
    this.onopen?.({});
  }

  /** Drive a NAMED event frame (`event: item:status` etc.). */
  deliverNamed(type: string, data: string): void {
    this.named.get(type)?.forEach((listener) => listener({ data }));
  }

  /** Drive an UNNAMED fallback message frame. */
  deliverMessage(data: string): void {
    this.onmessage?.({ data });
  }

  /** Drive an `error` delivery (transport failure; native stacks auto-retry). */
  deliverError(): void {
    this.onerror?.({});
  }

  /** Drive an explicit `close` delivery (stream closed, not retrying). */
  deliverClose(): void {
    this.onclose?.({});
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: () => boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T) => {
      done = true;
      res(value);
    };
    reject = (reason?: unknown) => {
      done = true;
      rej(reason);
    };
  });
  // Prevent unhandled-rejection noise for intentionally rejected epochs.
  promise.catch(() => {});
  return { promise, resolve, reject, settled: () => done };
}

export interface StripHarness {
  /** Injectable factory — pass as `createEventSource`. */
  factory: StripEventSourceFactory;
  /** Created instances in injection order. */
  instances: MockEventSource[];
  /** Deferred fetch queue — resolve/reject in any chosen order. */
  fetches: Array<Deferred<unknown>>;
  fetchSnapshot: (batchId: string) => Promise<any>;
  fetchCalls: string[];
  restore: () => void;
}

export function createStripHarness(): StripHarness {
  const harness: StripHarness = {
    factory: (url: string) => {
      const instance = new MockEventSource(url);
      harness.instances.push(instance);
      return instance;
    },
    instances: [],
    fetches: [],
    fetchCalls: [],
    fetchSnapshot: ((batchId: string) => {
      harness.fetchCalls.push(batchId);
      const deferred = createDeferred<unknown>();
      harness.fetches.push(deferred);
      return deferred.promise;
    }) as StripHarness['fetchSnapshot'],
    restore: () => {
      vi.restoreAllMocks();
    },
  };
  return harness;
}

/** Flush pending promise continuations (fetch settle → state update). */
export async function flushStripQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
