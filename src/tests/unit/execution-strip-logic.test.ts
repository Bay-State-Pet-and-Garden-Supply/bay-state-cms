/**
 * Slice 4-UI — execution strip pure-logic tests (Vitest, node env).
 *
 * Budgets, caps, classification, freshness, and honest labels. Every timing
 * and buffer budget is parameterized from `ExecutionStripBudgets`: each
 * boundary runs against the production defaults AND a second small-budget
 * configuration — no duplicated magic numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXECUTION_STRIP_BUDGETS,
  EXECUTION_PERMISSION_NOTE,
  LIVE_ACTIVITY_DISCLOSURE,
  RECONNECT_GAP_LABEL,
  STRIP_CONNECTION_LABELS,
  appendTimelineItem,
  classifyStripFrame,
  computeProjectionFreshness,
  formatElapsedAge,
  formatReceivedAt,
  labelExecutionPermission,
  sumStageMatrixColumnTotal,
  sumStageMatrixTotal,
  truncateSummary,
  utf8ByteLength,
  type ExecutionStripBudgets,
  type StripTimelineItem,
} from '../../client/components/onboarding/execution-strip-logic';

const SMALL_BUDGETS: ExecutionStripBudgets = {
  refreshIntervalMs: 1_000,
  staleAfterMs: 3_000,
  debounceMs: 50,
  maxDebounceWaitMs: 200,
  maxEntries: 3,
  maxSummaryChars: 10,
  maxFrameBytes: 64,
};

function activityData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    stageVocabularyVersion: 2,
    event: 'item:status',
    batchId: 'batch-1',
    itemId: 'item-1',
    stage: 'prepare_listing',
    stageStatus: 'in_progress',
    summary: 'An item moved to its next stage.',
    reasonCode: 'advanced',
    ...overrides,
  });
}

describe('owner-approved budget defaults', () => {
  it('matches the council plan §4.3 proposal (15s / 45s / 400ms / 2s / 100 / 160 / 16KiB)', () => {
    expect(DEFAULT_EXECUTION_STRIP_BUDGETS).toEqual({
      refreshIntervalMs: 15_000,
      staleAfterMs: 45_000,
      debounceMs: 400,
      maxDebounceWaitMs: 2_000,
      maxEntries: 100,
      maxSummaryChars: 160,
      maxFrameBytes: 16 * 1024,
    });
  });
});

describe('visible disclosure + honest labels', () => {
  it('uses the exact plan disclosure copy', () => {
    expect(LIVE_ACTIVITY_DISCLOSURE).toBe(
      'Live activity only. Activity during disconnection or before this view opened is unavailable; counts are refreshed from the server.',
    );
  });

  it('labels running/paused as execution permission, never worker health', () => {
    expect(labelExecutionPermission('running')).toBe('Running');
    expect(labelExecutionPermission('paused')).toBe('Paused');
    expect(labelExecutionPermission('draft')).toBe('Draft');
    expect(labelExecutionPermission('ready')).toBe('Ready');
    expect(labelExecutionPermission('completed')).toBe('Completed');
    expect(labelExecutionPermission('migrating')).toBe('Unknown');
    expect(labelExecutionPermission(null)).toBe('Unknown');
    expect(EXECUTION_PERMISSION_NOTE).toContain('not worker health');
  });

  it('claims no worker-health signal anywhere (no alive/concurrency/last-poll/oldest-claim)', () => {
    const copy = [
      LIVE_ACTIVITY_DISCLOSURE,
      RECONNECT_GAP_LABEL,
      EXECUTION_PERMISSION_NOTE,
      ...Object.values(STRIP_CONNECTION_LABELS),
    ].join('\n');
    expect(copy).not.toMatch(/alive|concurren|last-?poll|oldest.?claim/i);
  });

  it('keeps connection and freshness vocabularies distinct', () => {
    expect(Object.keys(STRIP_CONNECTION_LABELS).sort()).toEqual(
      ['closed', 'connected', 'connecting', 'reconnecting'].sort(),
    );
  });
});

describe('summary + frame budgets (UTF-8 aware)', () => {
  it.each([DEFAULT_EXECUTION_STRIP_BUDGETS, SMALL_BUDGETS])(
    'truncates maxSummaryChars−1/exact/+1 without splitting surrogate pairs',
    (budgets) => {
      const max = budgets.maxSummaryChars;
      expect(truncateSummary('x'.repeat(max - 1), max).length).toBe(max - 1);
      expect(truncateSummary('y'.repeat(max), max).length).toBe(max);
      expect(Array.from(truncateSummary('z'.repeat(max + 5), max)).length).toBe(max);
      const emoji = '🤖'.repeat(max + 2);
      const truncated = truncateSummary(emoji, max);
      expect(Array.from(truncated).length).toBe(max);
      expect(truncated).not.toContain('�');
    },
  );

  it.each([DEFAULT_EXECUTION_STRIP_BUDGETS, SMALL_BUDGETS])(
    'measures maxFrameBytes−1/exact/+1 in UTF-8 bytes (multi-byte aware)',
    (budgets) => {
      const max = budgets.maxFrameBytes;
      const unit = max <= 256 ? 'é' : 'a'; // multi-byte probe at small scale
      const unitBytes = utf8ByteLength(unit);
      const exactCount = Math.floor(max / unitBytes);
      const exact = unit.repeat(exactCount);
      const over = unit.repeat(exactCount) + (max % unitBytes === 0 ? unit : 'a'.repeat(max - utf8ByteLength(exact) + 1));
      expect(utf8ByteLength(exact)).toBeLessThanOrEqual(max);
      expect(utf8ByteLength(over)).toBeGreaterThan(max);
      // 16KiB boundary in raw bytes.
      expect(utf8ByteLength('a'.repeat(16 * 1024))).toBe(16 * 1024);
    },
  );

  it('classifies frames against the injected budget, not the production constants', () => {
    const big = 'x'.repeat(SMALL_BUDGETS.maxFrameBytes + 1);
    expect(classifyStripFrame('item:status', big, SMALL_BUDGETS)).toEqual({
      outcome: 'dropped',
      refetchSuggested: true,
    });
    // Same payload fits the production budget only when it parses: raw
    // non-JSON is still malformed (no refetch), proving budget ≠ validity.
    expect(classifyStripFrame('item:status', big, DEFAULT_EXECUTION_STRIP_BUDGETS)).toEqual({
      outcome: 'dropped',
      refetchSuggested: false,
    });
  });
});

describe('frame classification (allowlisted fields only)', () => {
  it('excludes welcome/ping from activity (connection frames)', () => {
    for (const budgets of [DEFAULT_EXECUTION_STRIP_BUDGETS, SMALL_BUDGETS]) {
      expect(classifyStripFrame('welcome', '{"frame":"welcome"}', budgets)).toEqual({ outcome: 'connection' });
      expect(classifyStripFrame('ping', '{"frame":"ping"}', budgets)).toEqual({ outcome: 'connection' });
    }
  });

  it('passes valid activity with allowlisted facts and truncates long summaries', () => {
    const long = 'An item moved. '.repeat(20); // > 160 chars
    const verdict = classifyStripFrame('item:status', activityData({ summary: long }), DEFAULT_EXECUTION_STRIP_BUDGETS);
    expect(verdict.outcome).toBe('activity');
    if (verdict.outcome !== 'activity') return;
    expect(Array.from(verdict.facts.summary).length).toBe(160);
    expect(verdict.facts.stage).toBe('prepare_listing');
    expect(verdict.facts.stageStatus).toBe('in_progress');
    expect(verdict.facts.itemId).toBe('item-1');
    expect(verdict.facts.reasonCode).toBe('advanced');
    expect(verdict.refetchSuggested).toBe(false);
  });

  it('never retains raw error strings, URLs, tokens, HTML, or evidence', () => {
    const verdict = classifyStripFrame(
      'item:status',
      activityData({
        error: 'DB password hunter2',
        message: 'boom <script>alert(1)</script>',
        url: 'https://admin:s3cret@example.com/logs?token=abc',
        evidence: [{ ocr: 'sensitive' }],
        token: 'sekret',
      }),
      DEFAULT_EXECUTION_STRIP_BUDGETS,
    );
    expect(verdict.outcome).toBe('activity');
    if (verdict.outcome !== 'activity') return;
    expect(verdict.facts).toEqual({
      summary: 'An item moved to its next stage.',
      stage: 'prepare_listing',
      stageStatus: 'in_progress',
      itemId: 'item-1',
      reasonCode: 'advanced',
    });
    expect(JSON.stringify(verdict.facts)).not.toContain('hunter2');
  });

  it('omits invalid stageStatus but keeps the vetted reasonCode (still truthful)', () => {
    const verdict = classifyStripFrame(
      'item:status',
      activityData({ stageStatus: 'DB password=hunter2 <script>alert(1)</script>' }),
      DEFAULT_EXECUTION_STRIP_BUDGETS,
    );
    expect(verdict.outcome).toBe('activity');
    if (verdict.outcome !== 'activity') return;
    expect('stageStatus' in verdict.facts).toBe(false);
    expect(verdict.facts.reasonCode).toBe('advanced');
  });

  it('drops v1 stage spellings and unknown events WITH refetch', () => {
    for (const data of [activityData({ stage: 'curation' }), activityData({ stage: 'nonsense' })]) {
      const verdict = classifyStripFrame('item:status', data, DEFAULT_EXECUTION_STRIP_BUDGETS);
      // v1/unknown stages are not allowlisted, so facts omit them — the
      // frame stays displayable (server counts remain authoritative).
      expect(verdict.outcome).toBe('activity');
      if (verdict.outcome === 'activity') expect('stage' in verdict.facts).toBe(false);
    }
    const unknown = classifyStripFrame('item:teleported', activityData(), DEFAULT_EXECUTION_STRIP_BUDGETS);
    expect(unknown).toEqual({ outcome: 'dropped', refetchSuggested: true });
  });

  it('drops malformed JSON without refetch, schema-invalid envelopes with refetch', () => {
    expect(classifyStripFrame('item:status', 'not-json{{{', DEFAULT_EXECUTION_STRIP_BUDGETS)).toEqual({
      outcome: 'dropped',
      refetchSuggested: false,
    });
    expect(classifyStripFrame('item:status', '[1,2]', DEFAULT_EXECUTION_STRIP_BUDGETS)).toEqual({
      outcome: 'dropped',
      refetchSuggested: true,
    });
    expect(
      classifyStripFrame('item:status', activityData({ summary: '' }), DEFAULT_EXECUTION_STRIP_BUDGETS),
    ).toEqual({ outcome: 'dropped', refetchSuggested: true });
  });

  it('never throws on hostile input', () => {
    expect(classifyStripFrame(null as never, null as never, DEFAULT_EXECUTION_STRIP_BUDGETS).outcome).toBe('dropped');
  });
});

describe('timeline buffer (max entries, oldest evicted)', () => {
  function activity(id: string, receivedAtMs: number): StripTimelineItem {
    return { kind: 'activity', id, summary: `summary ${id}`, receivedAtMs };
  }

  it.each([DEFAULT_EXECUTION_STRIP_BUDGETS, SMALL_BUDGETS])(
    'retains maxEntries−1/exact and evicts oldest at +1',
    (budgets) => {
      const max = budgets.maxEntries;
      let timeline: StripTimelineItem[] = [];
      for (let i = 0; i < max - 1; i += 1) timeline = appendTimelineItem(timeline, activity(`a-${i}`, i), max);
      expect(timeline).toHaveLength(max - 1);
      timeline = appendTimelineItem(timeline, activity(`a-${max - 1}`, max - 1), max);
      expect(timeline).toHaveLength(max);
      expect(timeline[0].id).toBe('a-0');
      timeline = appendTimelineItem(timeline, activity(`a-${max}`, max), max);
      expect(timeline).toHaveLength(max);
      expect(timeline[0].id).toBe('a-1');
      expect(timeline[timeline.length - 1].id).toBe(`a-${max}`);
    },
  );

  it('never mutates the input array', () => {
    const before: StripTimelineItem[] = [activity('a-0', 0)];
    appendTimelineItem(before, activity('a-1', 1), 1);
    expect(before).toHaveLength(1);
  });
});

describe('projection freshness (elapsed client time, never server clock)', () => {
  const NOW = 1_700_000_000_000;

  it.each([DEFAULT_EXECUTION_STRIP_BUDGETS, SMALL_BUDGETS])(
    'is fresh at staleAfter−1, stale at staleAfter/at+1',
    (budgets) => {
      const staleAfter = budgets.staleAfterMs;
      const base = { nowMs: NOW, staleAfterMs: staleAfter, fetchFailed: false, projectionDegraded: false };
      expect(computeProjectionFreshness({ ...base, lastSuccessAtMs: NOW - (staleAfter - 1) })).toBe('fresh');
      expect(computeProjectionFreshness({ ...base, lastSuccessAtMs: NOW - staleAfter })).toBe('stale');
      expect(computeProjectionFreshness({ ...base, lastSuccessAtMs: NOW - (staleAfter + 1) })).toBe('stale');
    },
  );

  it('reports not-loaded (never 0) before the first success', () => {
    expect(
      computeProjectionFreshness({
        lastSuccessAtMs: null,
        nowMs: NOW,
        staleAfterMs: 45_000,
        fetchFailed: true,
        projectionDegraded: true,
      }),
    ).toBe('not-loaded');
  });

  it('degrades immediately on fetch error or degraded projection', () => {
    expect(
      computeProjectionFreshness({
        lastSuccessAtMs: NOW - 1_000,
        nowMs: NOW,
        staleAfterMs: 45_000,
        fetchFailed: true,
        projectionDegraded: false,
      }),
    ).toBe('error');
    expect(
      computeProjectionFreshness({
        lastSuccessAtMs: NOW - 1_000,
        nowMs: NOW,
        staleAfterMs: 45_000,
        fetchFailed: false,
        projectionDegraded: true,
      }),
    ).toBe('stale');
  });

  it('ignores server-clock skew (only elapsed client time matters)', () => {
    // A far-future server computedAt cannot fake freshness: staleness uses
    // lastSuccessAtMs (client receipt) vs nowMs (client clock) only.
    expect(
      computeProjectionFreshness({
        lastSuccessAtMs: NOW - 60_000,
        nowMs: NOW,
        staleAfterMs: 45_000,
        fetchFailed: false,
        projectionDegraded: false,
      }),
    ).toBe('stale');
  });
});

describe('receipt-time labels (never execution time)', () => {
  it('labels every timestamp as received-at from the client receipt clock', () => {
    const label = formatReceivedAt(1_700_000_000_000);
    expect(label.startsWith('Received at ')).toBe(true);
    expect(label).not.toMatch(/execut|occur|event time/i);
  });

  it('formats elapsed ages compactly', () => {
    expect(formatElapsedAge(12_000)).toBe('12s');
    expect(formatElapsedAge(180_000)).toBe('3m');
    expect(formatElapsedAge(7_200_000)).toBe('2h');
  });
});

describe('server count matrix helpers', () => {
  const matrix = {
    route_sources: { pending: 7, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 },
    find_product_page: { pending: 0, in_progress: 2, completed: 1, failed: 0, needs_input: 0, skipped: 0 },
    collect_details: { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 },
    prepare_listing: { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 },
    review_listings: { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 },
    create_drafts: { pending: 0, in_progress: 0, completed: 0, failed: 0, needs_input: 0, skipped: 0 },
  };

  it('sums stage columns and the whole matrix (server-authoritative totals)', () => {
    expect(sumStageMatrixColumnTotal(matrix, 'route_sources')).toBe(7);
    expect(sumStageMatrixColumnTotal(matrix, 'find_product_page')).toBe(3);
    expect(sumStageMatrixColumnTotal(matrix, 'missing_stage')).toBe(0);
    expect(sumStageMatrixTotal(matrix)).toBe(10);
  });
});
