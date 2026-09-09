/**
 * Slice 1 — typed fetch client for the dedicated v2 stage reads.
 *
 * Thin layer over:
 *   GET /api/onboarding/v2/batches/:id/stage-work-state/counts
 *   GET /api/onboarding/v2/batches/:id/stage-work-state/items
 *
 * Server-authoritative: no client full-batch scan, no client-side stage
 * inference. The client sends limit 50 explicitly and follows cursors.
 */
import type {
  StageReadCountsResponse,
  StageReadItemsResponse,
  StageReadFilters,
} from '../shared/schemas/onboarding-stage-read';
import { STAGE_READ_LIMIT_DEFAULT } from '../shared/schemas/onboarding-stage-read';

const API_BASE = '/api/onboarding/v2';

export interface StageReadQuery extends Omit<StageReadFilters, 'cursor' | 'limit'> {
  cursor?: string;
  limit?: number;
}

export class StageReadApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'StageReadApiError';
  }
}

async function request<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}${query ? `?${query}` : ''}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { error?: unknown; code?: unknown };
    const errMsg = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const code = typeof body.code === 'string' ? body.code : undefined;
    throw new StageReadApiError(errMsg, res.status, code);
  }
  return data as T;
}

function toParams(query: StageReadQuery, limit: number): Record<string, string> {
  const params: Record<string, string> = { limit: String(limit) };
  if (query.stage) params['stage'] = query.stage;
  if (query.stageStatus) params['stageStatus'] = query.stageStatus;
  if (query.category) params['category'] = query.category;
  if (query.reviewState) params['reviewState'] = query.reviewState;
  if (query.sourceType) params['sourceType'] = query.sourceType;
  if (query.domain) params['domain'] = query.domain;
  if (query.cohortId) params['cohortId'] = query.cohortId;
  if (query.q) params['q'] = query.q;
  if (query.cursor) params['cursor'] = query.cursor;
  return params;
}

/** Server-filtered 6×6 counts + category totals for the current filter set. */
export async function getStageReadCounts(
  batchId: string,
  query: StageReadQuery = {},
): Promise<StageReadCountsResponse> {
  return request<StageReadCountsResponse>(
    `/batches/${encodeURIComponent(batchId)}/stage-work-state/counts`,
    toParams(query, query.limit ?? STAGE_READ_LIMIT_DEFAULT),
  );
}

/** One bounded page of server-projected stage rows. Follow nextCursor. */
export async function getStageReadItems(
  batchId: string,
  query: StageReadQuery = {},
): Promise<StageReadItemsResponse> {
  return request<StageReadItemsResponse>(
    `/batches/${encodeURIComponent(batchId)}/stage-work-state/items`,
    toParams(query, query.limit ?? STAGE_READ_LIMIT_DEFAULT),
  );
}

// Brand setup composition reads (Step 0 retired #115: brand fixes live in
// Stage 1 "Identify & Route Sources"; the attention queue keeps grouped
// missing-brand fixes). Mutations stay on the existing clients
// (`assignBrandGroup`, per-item assign-brand/domain in `onboarding-api.ts`,
// `assignBatchBrandDomain` in `onboarding-work-api.ts`). Settings remains
// the brand→domain mapping authority.
import type { BrandDomainSetupResponse } from '../shared/schemas/onboarding-work-state';
import { getBatch } from './onboarding-api';
import { getBrandDomainBlockers } from './onboarding-work-api';

export interface SettledBrandRead<T> {
  ok: boolean;
  value: T | null;
  /** Human-safe failure reason when `ok` is false (never raw payload). */
  error: string | null;
}

export interface BrandGateProjections {
  blockers: SettledBrandRead<BrandDomainSetupResponse>;
}

function toSettled<T>(result: PromiseSettledResult<T>): SettledBrandRead<T> {
  if (result.status === 'fulfilled') return { ok: true, value: result.value, error: null };
  const reason = result.reason;
  const error = reason instanceof Error ? reason.message : String(reason);
  return { ok: false, value: null, error };
}

/**
 * Slice 4-UI — ephemeral execution strip snapshot (council plan §4.3).
 *
 * One refresh epoch for the strip's server-derived half: the batch
 * `executionState` from the batch read plus the v2 server
 * count matrix. The execution state is permission to run, never worker
 * health; counts come from the server matrix, never from SSE events. The
 * hook retains the last success on failure, so this fetcher rejects on
 * error and never resolves a zeroed placeholder.
 */
export interface ExecutionStripSnapshot {
  executionState: string;
  matchingTotal: number;
  stageTotals: Record<string, number>;
  /** Server `projectionHealth.computedAt` (display only, never trusted for staleness). */
  projectionComputedAt: string | null;
  /** True when the server projection reported degraded health. */
  projectionDegraded: boolean;
}

export async function getExecutionStripSnapshot(batchId: string): Promise<ExecutionStripSnapshot> {
  const [batchRes, counts] = await Promise.all([
    getBatch(batchId),
    getStageReadCounts(batchId, {}),
  ]);
  const stageTotals: Record<string, number> = {};
  for (const [stage, column] of Object.entries(counts.stageStatusMatrix)) {
    stageTotals[stage] =
      column.pending +
      column.in_progress +
      column.completed +
      column.failed +
      column.needs_input +
      column.skipped;
  }
  return {
    executionState: batchRes.batch.executionState,
    matchingTotal: counts.matchingTotal,
    stageTotals,
    projectionComputedAt: counts.projectionHealth?.computedAt ?? null,
    projectionDegraded: (counts.projectionHealth?.status ?? 'healthy') !== 'healthy',
  };
}

/**
 * One refresh epoch for the attention queue: the brand-domain blocker read.
 * Per-item rows come from one bounded `getStageReadItems` page, never
 * N detail fetches.
 */
export async function getBrandGateProjections(batchId: string): Promise<BrandGateProjections> {
  const [blockersSettled] = await Promise.allSettled([
    getBrandDomainBlockers(batchId),
  ]);
  return {
    blockers: toSettled(blockersSettled),
  };
}
