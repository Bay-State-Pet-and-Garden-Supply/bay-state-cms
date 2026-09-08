// @vitest-environment jsdom
/**
 * Slice 4-UI — execution strip lifecycle tests (Vitest/jsdom, deterministic).
 *
 * Mock EventSource injection order + `vi.useFakeTimers` advancement steps —
 * no production networking, no implicit reconnects, no wall-clock waits.
 * Covers: initial/open/reconnect/periodic/focus refresh, debounce +
 * anti-starvation, stream-error-with-fresh-counts, connected-with-stale
 * counts, failed-fetch-keeps-last, batch-switch no-leak/old-generation
 * discard, teardown, 100/160/16KiB caps, escaping, malformed frames,
 * receipt-time labels, welcome/ping exclusion, gap marker + disclosure.
 * A manual walkthrough supplements with a checklist only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The hook's default snapshot fetcher rides the v2 stage-read schema chain,
// which vite-node cannot collect (pre-existing named-zod toolchain
// breakage, same as the frozen review chain). Every test below injects
// `fetchSnapshot`, so the mock is never called — it only keeps collection
// green. Production wiring is unchanged.
vi.mock('../../client/onboarding-stage-api', () => ({
  getExecutionStripSnapshot: () => {
    throw new Error('test must inject fetchSnapshot');
  },
}));

import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ExecutionStrip } from '../../client/components/onboarding/ExecutionStrip';
import {
  DEFAULT_EXECUTION_STRIP_BUDGETS,
  LIVE_ACTIVITY_DISCLOSURE,
  type ExecutionStripBudgets,
} from '../../client/components/onboarding/execution-strip-logic';
import type { ExecutionStripSnapshot } from '../../client/components/onboarding/use-execution-strip';
import {
  createStripHarness,
  type StripHarness,
} from '../helpers/onboarding-event-source-harness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = new Date('2026-03-01T12:00:00.000Z').getTime();

function snap(overrides: Partial<ExecutionStripSnapshot> = {}): ExecutionStripSnapshot {
  return {
    executionState: 'running',
    matchingTotal: 10,
    stageTotals: {
      route_sources: 7,
      find_product_page: 0,
      collect_details: 0,
      prepare_listing: 0,
      review_listings: 3,
      create_drafts: 0,
    },
    projectionComputedAt: '2026-03-01T12:00:00.000Z',
    projectionDegraded: false,
    ...overrides,
  };
}

function frame(summary: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ event: 'item:status', batchId: 'b1', summary, ...overrides });
}

const VALID_FRAME = () =>
  frame('An item moved to its next stage.', {
    itemId: 'item-1',
    stage: 'prepare_listing',
    stageStatus: 'in_progress',
    reasonCode: 'advanced',
  });

describe('execution strip lifecycle (deterministic harness)', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function text(testId: string): string {
    return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /**
   * Drive one synchronous stimulus (EventSource delivery, fetch
   * resolve/reject, DOM event, control click) with all resulting React
   * updates — sync and microtask — flushed inside `act`.
   */
  async function drive(fn: () => void): Promise<void> {
    await act(async () => {
      fn();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    await settle();
  }

  async function mountStrip(opts?: {
    batchId?: string;
    budgets?: ExecutionStripBudgets;
    harness?: StripHarness;
  }): Promise<StripHarness> {
    const harness = opts?.harness ?? createStripHarness();
    await act(async () => {
      root.render(
        <ExecutionStrip
          batchId={opts?.batchId ?? 'b1'}
          budgets={opts?.budgets}
          fetchSnapshot={harness.fetchSnapshot}
          createEventSource={harness.factory}
          defaultExpanded
        />,
      );
    });
    await settle();
    return harness;
  }

  /** Mount, then drive the strip to idle-fresh (initial + open resolved). */
  async function mountFresh(total = 10): Promise<StripHarness> {
    const harness = await mountStrip();
    expect(harness.fetchCalls).toEqual(['b1']);
    await drive(() => { harness.instances[0].deliverOpen(); });
    // Open raced the initial fetch: coalesced while in flight, no second
    // fetch yet — exactly one trailing refresh follows the initial epoch.
    expect(harness.fetchCalls).toEqual(['b1']);
    expect(text('strip-connection')).toBe('Live');
    await drive(() => { harness.fetches[0].resolve(snap({ matchingTotal: total })); });
    expect(harness.fetchCalls).toEqual(['b1', 'b1']);
    await drive(() => { harness.fetches[1].resolve(snap({ matchingTotal: total })); });
    expect(text('strip-counts')).toContain(`${total} products`);
    return harness;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    fetchSpy = vi.spyOn(globalThis as any, 'fetch').mockRejectedValue(new Error('no production networking'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initial refresh: one fetch, not-loaded counts, connecting stream', async () => {
    const harness = await mountStrip();
    expect(harness.fetchCalls).toEqual(['b1']);
    expect(text('strip-counts')).toBe('Counts not loaded');
    expect(text('strip-freshness')).toBe('Not loaded');
    expect(text('strip-connection')).toBe('Connecting…');
    expect(harness.instances).toHaveLength(1);
    expect(harness.instances[0].url).toContain('/api/onboarding/batches/b1/events');
    expect(harness.instances[0].url).toContain('stageVocabularyVersion=2');
  });

  it('first open refreshes (coalesced while the initial fetch is pending, one trailing run guaranteed)', async () => {
    const harness = await mountStrip();
    await drive(() => { harness.instances[0].deliverOpen(); });
    // Initial fetch still in flight: no second fetch yet, trailing pending.
    expect(harness.fetchCalls).toEqual(['b1']);
    expect(text('strip-connection')).toBe('Live');
    await drive(() => { harness.fetches[0].resolve(snap()); });
    expect(harness.fetchCalls).toEqual(['b1', 'b1']);
    await drive(() => { harness.fetches[1].resolve(snap()); });
    expect(text('strip-freshness')).toContain('Updated');
  });

  it('open while idle refreshes immediately', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { harness.instances[0].deliverOpen(); });
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('valid named activity appears with a Received-at receipt label', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    const items = container.querySelectorAll('[data-testid="strip-activity-item"]');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Received at ');
    expect(items[0].textContent).toContain('An item moved to its next stage.');
    expect(text('strip-activity-toggle')).toBe('Hide live activity');
  });

  it('welcome/ping are excluded from activity and schedule no refresh', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => {
      harness.instances[0].deliverNamed('welcome', '{"frame":"welcome","batchId":"b1"}');
      harness.instances[0].deliverNamed('ping', '{"frame":"ping","batchId":"b1"}');
    });
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs + 100);
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(0);
    expect(text('strip-activity-empty')).toContain('No live activity received yet');
    expect(harness.fetchCalls.length).toBe(marked);
  });

  it('debounce: no refresh at debounce−1, exactly one at debounce', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs - 1);
    expect(harness.fetchCalls.length).toBe(marked);
    await advance(1);
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('anti-starvation: continuous events cannot push the refresh past max-wait', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    // Events every 300ms forever would defer a pure trailing debounce
    // indefinitely; the 2s max-wait must fire mid-stream.
    for (let i = 0; i < 6; i += 1) {
      await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
      await advance(300);
    }
    // t=1800: seventh event lands; the 400ms debounce could not fire yet.
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    await advance(100); // t=1900 — quiet for only 100ms, no refresh yet.
    expect(harness.fetchCalls.length).toBe(marked);
    await advance(100); // t=2000 — max-wait fires 200ms after the last event.
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
    // The slate is clean after the max-wait fire: no duplicate trailing run.
    await advance(1_000);
    expect(harness.fetchCalls.length).toBe(marked + 1);
  });

  it('periodic re-sync at the interval boundary (interval−1 silent, interval fires)', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.refreshIntervalMs - 1);
    expect(harness.fetchCalls.length).toBe(marked);
    await advance(1);
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('visibility, focus, and online each trigger one coalesced refresh', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { window.dispatchEvent(new Event('focus')); });
    expect(harness.fetchCalls.length).toBe(marked + 1);
    // An online return while that fetch is in flight coalesces into one
    // trailing run instead of a second overlapping fetch.
    await drive(() => { window.dispatchEvent(new Event('online')); });
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[marked].resolve(snap()); });
    expect(harness.fetchCalls.length).toBe(marked + 2);
    await drive(() => {
      for (const pending of harness.fetches.slice(marked + 1)) pending.resolve(snap());
    });
    await settle();
    expect(harness.fetchCalls.length).toBe(marked + 2);
  });

  it('stream error with fresh counts: reconnecting stream, freshness untouched', async () => {
    const harness = await mountFresh();
    await advance(5_000);
    await drive(() => { harness.instances[0].deliverError(); });
    expect(text('strip-connection')).toBe('Reconnecting…');
    // Independent axes: the stream is down but the projection is still fresh.
    expect(text('strip-freshness')).toContain('Updated');
    expect(text('strip-freshness')).not.toContain('Stale');
    expect(text('strip-counts')).toContain('10 products');
  });

  it('connected stream with stale counts: staleness is elapsed client time', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverOpen(); });
    await drive(() => {
      for (const pending of harness.fetches) {
        if (!pending.settled()) pending.resolve(snap());
      }
    });
    await settle();
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.staleAfterMs);
    expect(text('strip-connection')).toBe('Live');
    expect(text('strip-freshness')).toContain('Stale');
    // Last success retained — never overwritten with zero.
    expect(text('strip-counts')).toContain('10 products');
  });

  it('failed fetch keeps the last success with an error badge (never zeroed)', async () => {
    const harness = await mountFresh(10);
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs);
    const pending = harness.fetches[harness.fetches.length - 1];
    await drive(() => { pending.reject(new Error('boom')); });
    expect(text('strip-freshness')).toBe('Error — showing last successful counts');
    expect(text('strip-error')).toContain('Could not refresh counts: boom');
    expect(text('strip-counts')).toContain('10 products');
    expect(text('strip-counts')).not.toBe('Counts not loaded');
    expect(container.querySelector('[data-testid="strip-stage-totals"]')?.textContent).toContain('Check source options:');
  });

  it('error then open: gap marker, exact disclosure, and refetch', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { harness.instances[0].deliverError(); });
    await drive(() => { harness.instances[0].deliverOpen(); });
    expect(harness.fetchCalls.length).toBe(marked + 1);
    const gaps = container.querySelectorAll('[data-testid="strip-gap-marker"]');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].textContent).toContain('Updates may be missing here');
    expect(text('strip-disclosure')).toBe(LIVE_ACTIVITY_DISCLOSURE);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('explicit close reads Closed (distinct from freshness)', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverClose(); });
    expect(text('strip-connection')).toBe('Closed');
    expect(text('strip-freshness')).toContain('Updated');
  });

  it('execution permission renders running/paused (permission only, never worker health)', async () => {
    const harness = await mountStrip();
    await drive(() => { harness.instances[0].deliverOpen(); });
    await drive(() => { harness.fetches[0].resolve(snap({ executionState: 'paused' })); });
    await drive(() => { harness.fetches[1].resolve(snap({ executionState: 'paused' })); });
    expect(text('strip-execution-state')).toContain('Execution: Paused');
    expect(
      container.querySelector('[data-testid="strip-execution-state"]')?.getAttribute('title'),
    ).toContain('not worker health');
  });

  it('counts follow the server snapshot — events never set status or totals', async () => {
    const harness = await mountFresh(10);
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap({ matchingTotal: 25 })); });
    expect(text('strip-counts')).toContain('25 products');
  });

  it('batch switch: no leak, old generation discarded, old stream closed once', async () => {
    const harness = await mountFresh(10);
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(1);
    // A refresh is in flight for b1 when the batch switches.
    await drive(() => { (container.querySelector('[data-testid="strip-refresh"]') as HTMLButtonElement).click(); });
    const b1PendingIndex = harness.fetches.length - 1;
    await act(async () => {
      root.render(
        <ExecutionStrip
          batchId="b2"
          fetchSnapshot={harness.fetchSnapshot}
          createEventSource={harness.factory}
          defaultExpanded
        />,
      );
    });
    await settle();
    expect(harness.instances).toHaveLength(2);
    expect(harness.instances[0].closeCalls).toBe(1);
    // New batch starts unloaded; the old batch's activity never leaks.
    expect(text('strip-counts')).toBe('Counts not loaded');
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(0);
    expect(harness.fetchCalls[harness.fetchCalls.length - 1]).toBe('b2');
    // The stale b1 epoch resolves late with a foreign total: discarded.
    await drive(() => { harness.fetches[b1PendingIndex].resolve(snap({ matchingTotal: 999 })); });
    expect(text('strip-counts')).toBe('Counts not loaded');
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap({ matchingTotal: 5 })); });
    expect(text('strip-counts')).toContain('5 products');
  });

  it('teardown: exactly one close, no timers, no fetches, no state writes', async () => {
    const harness = await mountFresh();
    await drive(() => { (container.querySelector('[data-testid="strip-refresh"]') as HTMLButtonElement).click(); });
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    const marked = harness.fetchCalls.length;
    const instance = harness.instances[0];
    await act(async () => {
      root.unmount();
    });
    // Advance through every budget with a pending fetch outstanding.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await drive(() => {
      for (const pending of harness.fetches) {
        if (!pending.settled()) pending.resolve(snap());
      }
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(instance.closeCalls).toBe(1);
    expect(instance.totalListenerCount()).toBe(0);
    expect(instance.onopen).toBeNull();
    expect(instance.onerror).toBeNull();
    expect(instance.onmessage).toBeNull();
    expect(instance.onclose).toBeNull();
    expect(harness.fetchCalls.length).toBe(marked);
  });

  it('buffer cap: oldest summaries evicted past maxEntries (small budgets)', async () => {
    const small: ExecutionStripBudgets = { ...DEFAULT_EXECUTION_STRIP_BUDGETS, maxEntries: 3 };
    const harness = await mountStrip({ budgets: small });
    await drive(() => { harness.instances[0].deliverOpen(); });
    await drive(() => { for (const pending of harness.fetches) pending.resolve(snap()); });
    for (let i = 0; i < 4; i += 1) {
      await drive(() => { harness.instances[0].deliverNamed('item:status', frame(`event number ${i}`)); });
    }
    const items = Array.from(container.querySelectorAll('[data-testid="strip-activity-item"]'));
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('event number 1');
    expect(items[2].textContent).toContain('event number 3');
  });

  it('summary cap: 200-char summaries render truncated to 160 display characters', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverNamed('item:status', frame(`s${'x'.repeat(199)}`)); });
    const item = container.querySelector('[data-testid="strip-activity-item"]');
    const summary = (item?.textContent ?? '').split('— ')[1] ?? '';
    expect(Array.from(summary).length).toBe(160);
  });

  it('frame cap: 17KiB frames are dropped with a refetch, never rendered', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { harness.instances[0].deliverNamed('item:status', `{"summary":"${'y'.repeat(17 * 1024)}"}`); });
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(0);
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs);
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('escaping: HTML/token payloads render as inert text, never elements', async () => {
    const harness = await mountFresh();
    const poison = '<img src=x onerror=alert(1)> hunter2 https://admin:s3cret@example.com/x';
    await drive(() => { harness.instances[0].deliverNamed('item:status', frame(poison)); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    const item = container.querySelector('[data-testid="strip-activity-item"]');
    expect(item?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('malformed frames are dropped silently; unknown events drop but refetch', async () => {
    const harness = await mountFresh();
    const marked = harness.fetchCalls.length;
    await drive(() => { harness.instances[0].deliverNamed('item:status', 'not-json{{{'); });
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(0);
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs);
    expect(harness.fetchCalls.length).toBe(marked);
    // Unregistered event names never reach a named listener; the same
    // unknown payload on the unnamed fallback drops but schedules a
    // safe refetch (the projection may have moved without us).
    await drive(() => { harness.instances[0].deliverMessage(frame('beamed up')); });
    expect(container.querySelectorAll('[data-testid="strip-activity-item"]')).toHaveLength(0);
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.debounceMs);
    expect(harness.fetchCalls.length).toBe(marked + 1);
    await drive(() => { harness.fetches[harness.fetches.length - 1].resolve(snap()); });
  });

  it('receipt-time labels use the client receipt clock for each event', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverNamed('item:status', frame('first event')); });
    vi.setSystemTime(T0 + 5_000);
    await drive(() => { harness.instances[0].deliverNamed('item:status', frame('second event')); });
    const items = Array.from(container.querySelectorAll('[data-testid="strip-activity-item"]'));
    expect(items).toHaveLength(2);
    const labels = items.map((item) => item.textContent ?? '');
    for (const label of labels) expect(label).toContain('Received at ');
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('claims no worker-health signal anywhere in the rendered strip', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    const copy = container.textContent ?? '';
    expect(copy).not.toMatch(/alive|concurren|last-?poll|oldest.?claim/i);
  });

  it('issues no production requests: periodic refresh never touches review or other APIs', async () => {
    const harness = await mountFresh();
    await drive(() => { harness.instances[0].deliverNamed('item:status', VALID_FRAME()); });
    await advance(DEFAULT_EXECUTION_STRIP_BUDGETS.refreshIntervalMs * 2);
    await drive(() => {
      for (const pending of harness.fetches) {
        if (!pending.settled()) pending.resolve(snap());
      }
    });
    await settle();
    // Every byte of data arrived through the injected seams.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
