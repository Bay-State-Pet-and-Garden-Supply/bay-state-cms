/**
 * Slice 4-UI — ephemeral execution strip pure logic (council plan §4.3).
 *
 * DOM-free derivations for `ExecutionStrip` / `use-execution-strip`. This
 * module owns the owner-approved timing/buffer budgets (single injectable
 * `ExecutionStripBudgets` value), frame classification, buffer caps,
 * freshness derivation, and honest labels. It never touches the network,
 * the DOM, timers, or review/approval/export state.
 *
 * Two independent halves (never mixed):
 * 1. Server-derived status — batch `executionState` plus the v2 server
 *    count matrix. Running/paused is execution PERMISSION only, never
 *    worker health. No alive badge, concurrency, last-poll, or oldest-claim
 *    claim exists anywhere in this module.
 * 2. Ephemeral live activity — display-only summaries received while the
 *    view is open. Never a source for status, counts, approval, or export.
 */

export interface ExecutionStripBudgets {
  /** Periodic server re-sync while visible. */
  refreshIntervalMs: number;
  /** Elapsed client time after the last success before counts read stale. */
  staleAfterMs: number;
  /** Coalesced refresh after live-activity frames. */
  debounceMs: number;
  /** Upper bound so continuous events cannot starve the trailing refresh. */
  maxDebounceWaitMs: number;
  /** Maximum retained timeline items (activity + gap markers). */
  maxEntries: number;
  /** Maximum display characters per activity summary. */
  maxSummaryChars: number;
  /** Maximum accepted SSE wire frame, UTF-8 bytes. */
  maxFrameBytes: number;
}

/** Owner-proposed defaults (council plan §4.3 + §10 checklist). */
export const DEFAULT_EXECUTION_STRIP_BUDGETS: ExecutionStripBudgets = {
  refreshIntervalMs: 15_000,
  staleAfterMs: 45_000,
  debounceMs: 400,
  maxDebounceWaitMs: 2_000,
  maxEntries: 100,
  maxSummaryChars: 160,
  maxFrameBytes: 16 * 1024,
};

/** Visible disclosure (exact copy, council plan §4.3). */
export const LIVE_ACTIVITY_DISCLOSURE =
  'Live activity only. Activity during disconnection or before this view opened is unavailable; counts are refreshed from the server.';

/** Gap marker copy shown after a reconnect. */
export const RECONNECT_GAP_LABEL =
  'Updates may be missing here — the stream reconnected and counts were refreshed from the server.';

// ─── Server-derived status (half 1) ──────────────────────────────────────────

/**
 * Batch execution permission spellings (server `executionState`). Displayed
 * as permission to run — NEVER as worker health.
 */
export const EXECUTION_PERMISSION_STATES = ['draft', 'ready', 'running', 'paused', 'completed'] as const;

export type ExecutionPermission = (typeof EXECUTION_PERMISSION_STATES)[number];

export const EXECUTION_PERMISSION_LABELS: Readonly<Record<ExecutionPermission, string>> = {
  draft: 'Draft',
  ready: 'Ready',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
};

/** Honest qualifier rendered alongside the permission pill. */
export const EXECUTION_PERMISSION_NOTE = 'Execution permission only — not worker health.';

export function labelExecutionPermission(state: string | null | undefined): string {
  if (state && (EXECUTION_PERMISSION_STATES as readonly string[]).includes(state)) {
    return EXECUTION_PERMISSION_LABELS[state as ExecutionPermission];
  }
  return 'Unknown';
}

/** Structural (schema-free) view of the v2 6×6 count matrix. */
export interface StageStatusMatrixLike {
  [stage: string]: { [status: string]: number };
}

export function sumStageMatrixColumnTotal(matrix: StageStatusMatrixLike, stage: string): number {
  const column = matrix[stage];
  if (!column) return 0;
  let total = 0;
  for (const status of Object.keys(column)) {
    const value = column[status];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

export function sumStageMatrixTotal(matrix: StageStatusMatrixLike): number {
  let total = 0;
  for (const stage of Object.keys(matrix)) total += sumStageMatrixColumnTotal(matrix, stage);
  return total;
}

// ─── Connection vs freshness (distinct axes) ─────────────────────────────────

export type StripConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export const STRIP_CONNECTION_LABELS: Readonly<Record<StripConnectionState, string>> = {
  connecting: 'Connecting…',
  connected: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Closed',
};

export type ProjectionFreshness = 'not-loaded' | 'fresh' | 'stale' | 'error';

export interface FreshnessInputs {
  /** Client receipt time of the last successful fetch, or null when never. */
  lastSuccessAtMs: number | null;
  /** Client clock now (elapsed time — never the server clock). */
  nowMs: number;
  staleAfterMs: number;
  /** A fetch failed and no newer success replaced it. */
  fetchFailed: boolean;
  /** Server projection reported degraded health. */
  projectionDegraded: boolean;
}

/**
 * Derive projection freshness from ELAPSED CLIENT TIME. No successful fetch
 * means "not loaded", never "0". Any fetch error degrades immediately, as
 * does a degraded server projection — a connected stream never implies
 * current counts.
 */
export function computeProjectionFreshness(inputs: FreshnessInputs): ProjectionFreshness {
  const { lastSuccessAtMs, nowMs, staleAfterMs, fetchFailed, projectionDegraded } = inputs;
  if (lastSuccessAtMs === null) return 'not-loaded';
  if (fetchFailed) return 'error';
  if (projectionDegraded) return 'stale';
  if (nowMs - lastSuccessAtMs >= staleAfterMs) return 'stale';
  return 'fresh';
}

// ─── Ephemeral live activity (half 2) ────────────────────────────────────────

/** Named live event types. `welcome`/`ping` are connection frames, never activity. */
export const STRIP_ACTIVITY_EVENT_TYPES = [
  'item:status',
  'batch:progress',
  'batch:complete',
  'batch:error',
] as const;

export const STRIP_CONNECTION_FRAME_TYPES = ['welcome', 'ping'] as const;

/** Canonical v2 stage spellings (allowlist — never invented). */
export const STRIP_STAGE_ALLOWLIST = [
  'route_sources',
  'find_product_page',
  'collect_details',
  'prepare_listing',
  'review_listings',
  'create_drafts',
] as const;

/** Unchanged stage-status spellings (allowlist — never renamed). */
export const STRIP_STATUS_ALLOWLIST = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'needs_input',
  'skipped',
] as const;

/** Vetted reason codes (allowlist — the only machine-readable causes kept). */
export const STRIP_REASON_ALLOWLIST = [
  'advanced',
  'claimed',
  'retry_queued',
  'failed',
  'conflict_found',
  'profile_blocked',
  'family_barrier',
  'domain_released',
  'reviewed',
  'approval_recorded',
  'export_drafts_created',
  'batch_completed',
  'other',
] as const;

export interface StripActivityFacts {
  summary: string;
  stage?: string;
  stageStatus?: string;
  itemId?: string;
  reasonCode?: string;
}

export type StripFrameVerdict =
  | { outcome: 'connection' }
  | { outcome: 'activity'; facts: StripActivityFacts; refetchSuggested: boolean }
  | { outcome: 'dropped'; refetchSuggested: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allowlisted(value: unknown, allowlist: readonly string[]): string | undefined {
  return typeof value === 'string' && (allowlist as readonly string[]).includes(value) ? value : undefined;
}

/** UTF-8 byte length (multi-byte aware — never String.length for budgets). */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Truncate to display characters (code-point aware, never splits surrogate pairs). */
export function truncateSummary(value: string, maxChars: number): string {
  const points = Array.from(value);
  if (points.length <= maxChars) return value;
  return points.slice(0, maxChars).join('');
}

/**
 * Classify one raw SSE frame for display using the injected budgets. Pure:
 * no clock, no retention. Returns allowlisted facts only — raw error
 * strings, URLs, tokens, HTML, and evidence are never forwarded (the server
 * already sends fixed templates; anything off-allowlist is dropped).
 */
export function classifyStripFrame(
  rawEvent: string,
  rawData: string,
  budgets: ExecutionStripBudgets,
): StripFrameVerdict {
  if (typeof rawEvent !== 'string' || typeof rawData !== 'string') {
    return { outcome: 'dropped', refetchSuggested: false };
  }
  if ((STRIP_CONNECTION_FRAME_TYPES as readonly string[]).includes(rawEvent)) {
    return { outcome: 'connection' };
  }
  if (!(STRIP_ACTIVITY_EVENT_TYPES as readonly string[]).includes(rawEvent)) {
    // Unknown event types are dropped but trigger a safe refetch — the
    // projection may have moved without us.
    return { outcome: 'dropped', refetchSuggested: true };
  }
  if (utf8ByteLength(rawData) > budgets.maxFrameBytes) {
    return { outcome: 'dropped', refetchSuggested: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return { outcome: 'dropped', refetchSuggested: false };
  }
  if (!isRecord(parsed)) return { outcome: 'dropped', refetchSuggested: true };
  const summary = parsed['summary'];
  if (typeof summary !== 'string' || summary.length === 0) {
    return { outcome: 'dropped', refetchSuggested: true };
  }
  const facts: StripActivityFacts = {
    summary: truncateSummary(summary, budgets.maxSummaryChars),
  };
  const stage = allowlisted(parsed['stage'], STRIP_STAGE_ALLOWLIST);
  if (stage) facts.stage = stage;
  const stageStatus = allowlisted(parsed['stageStatus'], STRIP_STATUS_ALLOWLIST);
  if (stageStatus) facts.stageStatus = stageStatus;
  const itemId = parsed['itemId'];
  if (typeof itemId === 'string' && itemId.length > 0 && itemId.length <= 128) facts.itemId = itemId;
  const reasonCode = allowlisted(parsed['reasonCode'], STRIP_REASON_ALLOWLIST);
  if (reasonCode) facts.reasonCode = reasonCode;
  const refetchSuggested = parsed['refetchSuggested'] === true;
  return { outcome: 'activity', facts, refetchSuggested };
}

// ─── Timeline buffer ─────────────────────────────────────────────────────────

export interface StripActivityItem {
  kind: 'activity';
  id: string;
  summary: string;
  /** Client receipt time (ms since epoch) — labeled "Received at …". */
  receivedAtMs: number;
}

export interface StripGapItem {
  kind: 'gap';
  id: string;
  /** Client receipt time of the reconnect. */
  receivedAtMs: number;
}

export type StripTimelineItem = StripActivityItem | StripGapItem;

/**
 * Append one timeline item, evicting the oldest entries past the cap.
 * Returns a new array; the input is never mutated.
 */
export function appendTimelineItem(
  timeline: readonly StripTimelineItem[],
  item: StripTimelineItem,
  maxEntries: number,
): StripTimelineItem[] {
  const next = [...timeline, item];
  if (next.length <= maxEntries) return next;
  return next.slice(next.length - maxEntries);
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/** "Received at …" receipt-time label (NOT execution time). */
export function formatReceivedAt(receivedAtMs: number): string {
  const time = new Date(receivedAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `Received at ${time}`;
}

/** Compact elapsed age for freshness badges ("12s", "3m", "2h"). */
export function formatElapsedAge(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
