/**
 * Epic #46 — shared frontend client for the operator work-state API.
 *
 * The Batch Workspace (and its feature views: Needs Attention, Waiting on
 * Family, Review, Approved / Ready to Export) consume ONLY this module for
 * server-derived work-state data. The server owns all projection logic —
 * this module is a thin typed fetch layer over:
 *
 *   GET  /api/onboarding/batches/:id/work-state
 *   GET  /api/onboarding/items/:id/work-state
 *   POST /api/onboarding/batches/:id/approve
 *   POST /api/onboarding/domains/:domain/release
 *
 * plus an SSE subscription helper reusing the existing batch events stream.
 */
import type {
  BatchWorkState,
  OnboardingWorkState,
  WorkStateCategory,
  WorkStateFilters,
  WorkStateCountsResponse,
  WorkStateItemsResponse,
  WorkStateProjectionHealth,
  ApproveItemsResponse,
  DomainReleaseResponse,
  ExtractorProfileBlockersResponse,
  BrandDomainSetupResponse,
} from '../shared/schemas/onboarding-work-state';
import type {
  ReviewQueuePage,
  ReviewQueueRow,
  ReviewQueueCounts,
  ReviewGateStatus,
  ReviewFamilySummary,
  ProjectionHealth,
} from '../shared/schemas/onboarding-review-queue';
import type { ReviewQueueFilters } from './components/onboarding/review/review-logic';

const API_BASE = '/api/onboarding';

export { OnboardingApiError } from './onboarding-api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const errorObj = (data as { error?: unknown }).error;
    const errMsg =
      typeof errorObj === 'object' && errorObj !== null && 'message' in errorObj
        ? String((errorObj as { message: unknown }).message)
        : typeof errorObj === 'string'
          ? errorObj
          : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

// ─── Work-state projection ─────────────────────────────────────────────────────

/**
 * Batch-level operator projection: counts + paginated items.
 * Filters: category, q (upc/name/brand), domain, sourceType, cohortId,
 * reviewState, limit, offset. Invalid filter values fail closed server-side.
 * @deprecated — prefer getBatchWorkStateCounts / getBatchWorkStateItems (bounded, cursor-paginated)
 */
export async function getBatchWorkState(
  batchId: string,
  filters?: WorkStateFilters,
): Promise<BatchWorkState> {
  const params = new URLSearchParams();
  if (filters) {
    if (filters.category) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.domain) params.set('domain', filters.domain);
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    if (filters.cohortId) params.set('cohortId', filters.cohortId);
    if (filters.reviewState) params.set('reviewState', filters.reviewState);
    if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
    if (typeof filters.offset === 'number') params.set('offset', String(filters.offset));
    if (filters.cursor) params.set('cursor', filters.cursor);
  }
  const qs = params.toString();
  return request<BatchWorkState>(`/batches/${batchId}/work-state${qs ? `?${qs}` : ''}`);
}

/** Bounded work-state counts (Milestone 3 / P1-E). */
export async function getBatchWorkStateCounts(
  batchId: string,
  filters?: Omit<WorkStateFilters, 'cursor' | 'limit' | 'offset'>,
): Promise<WorkStateCountsResponse> {
  const params = new URLSearchParams();
  if (filters) {
    if (filters.category) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.domain) params.set('domain', filters.domain);
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    if (filters.cohortId) params.set('cohortId', filters.cohortId);
    if (filters.reviewState) params.set('reviewState', filters.reviewState);
  }
  const qs = params.toString();
  return request<WorkStateCountsResponse>(`/batches/${batchId}/work-state/counts${qs ? `?${qs}` : ''}`);
}

/** Cursor-paginated work-state items (Milestone 3 / P1-E). */
export async function getBatchWorkStateItems(
  batchId: string,
  filters?: WorkStateFilters,
): Promise<WorkStateItemsResponse> {
  const params = new URLSearchParams();
  if (filters) {
    if (filters.category) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.domain) params.set('domain', filters.domain);
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    if (filters.cohortId) params.set('cohortId', filters.cohortId);
    if (filters.reviewState) params.set('reviewState', filters.reviewState);
    if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
    if (filters.cursor) params.set('cursor', filters.cursor);
    // offset intentionally not sent — server uses cursor
  }
  const qs = params.toString();
  return request<WorkStateItemsResponse>(`/batches/${batchId}/work-state/items${qs ? `?${qs}` : ''}`);
}

/** Single-item operator projection. */
export async function getItemWorkState(itemId: string): Promise<{ workState: OnboardingWorkState }> {
  return request<{ workState: OnboardingWorkState }>(`/items/${itemId}/work-state`);
}

// ─── Bulk approval ─────────────────────────────────────────────────────────────

function generateIdempotencyKey(): string {
  try {
    // Browser / Bun
    if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
      return (crypto as any).randomUUID();
    }
  } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Bulk approval of reviewed items. Per-item structured outcomes; approval
 * NEVER exports anything. Unreviewed items are rejected by the server.
 * Idempotency-Key header engages scoped receipt replay (DB receipt is authority).
 */
export async function approveItems(
  batchId: string,
  itemIds: string[],
  opts?: { idempotencyKey?: string; filenameDecisions?: Record<string, 'accept' | 'defer'> },
): Promise<ApproveItemsResponse & { receiptId?: string; principal?: string }> {
  const key = opts?.idempotencyKey ?? generateIdempotencyKey();
  return request<ApproveItemsResponse & { receiptId?: string; principal?: string }>(`/batches/${batchId}/approve`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify(
      opts?.filenameDecisions ? { itemIds, filenameDecisions: opts.filenameDecisions } : { itemIds },
    ),
  });
}

/**
 * Batch filename preview for the Review drawer (issue #109). Deterministic
 * for a fixed batch state — fetch once per batch review load and cache.
 */
export interface BatchFilenamePreviewItem {
  itemId: string;
  upc: string;
  title: string;
  fileName: string;
  baseFileName: string;
  acceptedFileName: string | null;
  warnings: Array<{
    code: string;
    message: string;
    fileName: string;
    conflictingUpcs: string[];
    conflictingTitles: string[];
    catalogSku?: string | null;
    catalogTitle?: string | null;
  }>;
}

export async function getBatchFilenamePreview(
  batchId: string,
): Promise<{ batchId: string; items: BatchFilenamePreviewItem[] }> {
  return request<{ batchId: string; items: BatchFilenamePreviewItem[] }>(`/batches/${batchId}/filename-preview`);
}

export interface CreateExportDraftsResponse {
  results: Array<{ itemId: string; status: string; reason: string | null }>;
  createdCount: number;
  rejectedCount: number;
  rejected: Array<{ itemId: string; reason: string }>;
  created: string[];
  changeSetId: string | null;
  audited: boolean;
  receiptId: string;
  principal: string;
}
/**
 * Create export drafts (change set) for approved items. Separate operation
 * from approval with its own idempotency lifecycle (catalog_exporter).
 * Header Idempotency-Key is required for receipt replay; generated per logical operation.
 */
export async function createExportDrafts(
  batchId: string,
  itemIds: string[],
  opts?: { idempotencyKey?: string },
): Promise<CreateExportDraftsResponse> {
  const key = opts?.idempotencyKey ?? generateIdempotencyKey();
  return request<CreateExportDraftsResponse>(`/batches/${batchId}/create-export-drafts`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ itemIds }),
  });
}

export function createIdempotencyKey(): string {
  return generateIdempotencyKey();
}

// ─── Domain-level release ──────────────────────────────────────────────────────

/**
 * Deterministic domain-level release: after an extractor profile becomes
 * usable, re-queue blocked extraction items on that domain.
 */
export async function releaseDomainItems(domain: string): Promise<DomainReleaseResponse> {
  return request<DomainReleaseResponse>(`/domains/${encodeURIComponent(domain)}/release`, {
    method: 'POST',
  });
}

/**
 * Domain-level extractor setup queue (epic #46 follow-up, phase 5):
 * missing-profile extraction failures grouped by domain, sorted by
 * blocked-product count.
 */
export async function getExtractorProfileBlockers(batchId: string): Promise<ExtractorProfileBlockersResponse> {
  return request<ExtractorProfileBlockersResponse>(`/batches/${batchId}/extractor-profile-blockers`);
}

// ─── Brand-domain setup queue (ADR 0017) ───────────────────────────────────────

/**
 * Batch-level brand→domain setup queue (ADR 0017): discovery items parked
 * because their brand has no mapped official domain, grouped by brand and
 * sorted by blocked-product count.
 */
export async function getBrandDomainBlockers(batchId: string): Promise<BrandDomainSetupResponse> {
  return request<BrandDomainSetupResponse>(`/batches/${batchId}/brand-domain-setup`);
}

/**
 * Assign an official brand domain for one of the batch's unmapped brands and
 * re-queue every blocked discovery item. Returns the refreshed blocker list
 * (the mapped brand's row disappears once its items leave the park state).
 */
export async function assignBatchBrandDomain(
  batchId: string,
  brand: string,
  domain: string,
): Promise<{ success: boolean; requeued: number; blockers: BrandDomainSetupResponse['blockers'] }> {
  return request(`/batches/${batchId}/brand-domain-setup/${encodeURIComponent(brand)}`, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}

// ─── Brand sourcing strategy approval (spec #120, ticket #121) ─────────────
// Explicit operator approval of a reusable per-brand collection plan.
// Viewing a proposal never writes; only this command persists approval.
export type { StrategySourceRef as StrategySourceInput } from '../shared/schemas/brand-strategy';
export { saveBrandStrategy } from './onboarding-api';

export async function approveBrandStrategy(input: {
  brand: string;
  sources: import('../shared/schemas/brand-strategy').StrategySourceRef[];
  expectedRevision: number;
}): Promise<{ strategy: unknown }> {
  const { saveBrandStrategy: save } = await import('./onboarding-api');
  return save(input);
}

// ─── Live events ───────────────────────────────────────────────────────────────

/**
 * Subscribe to batch SSE events (reuses the existing
 * `GET /api/onboarding/batches/:id/events` stream). Returns an unsubscribe
 * function. The stream is a firehose — consumers filter by event type.
 *
 * The server writes NAMED events (`event: item:status` etc.), so listeners
 * are attached per event name plus a fallback `message` handler for any
 * unnamed frames. Data payloads carry the full event object
 * `{ type, batchId, itemId?, data }`.
 *
 * Slice 4-UI: optional third `options` argument selects the SSE
 * representation (URL parameter only — EventSource cannot send headers).
 * Absent options preserves the exact legacy v1 subscription: same URL,
 * same named-event callbacks. Pass `{ vocabularyVersion: 2 }` for the
 * versioned sanitized envelope consumed by the execution strip.
 */
export function subscribeBatchEvents(
  batchId: string,
  onEvent: (event: { type: string; data: unknown }) => void,
  options?: { vocabularyVersion?: 1 | 2 },
): () => void {
  const versionSuffix = options?.vocabularyVersion === 2 ? '?stageVocabularyVersion=2' : '';
  const sse = new EventSource(`${API_BASE}/batches/${batchId}/events${versionSuffix}`);
  const handler = (ev: MessageEvent) => {
    try {
      const payload = JSON.parse(ev.data) as { type?: string; [k: string]: unknown };
      onEvent({ type: payload.type ?? ev.type ?? 'message', data: payload });
    } catch {
      onEvent({ type: ev.type ?? 'message', data: ev.data });
    }
  };
  sse.onmessage = handler;
  for (const eventName of ['item:status', 'batch:progress', 'batch:complete', 'batch:error']) {
    sse.addEventListener(eventName, handler);
  }
  sse.onerror = () => {
    // SSE reconnect is automatic; consumers refresh on demand.
  };
  return () => sse.close();
}

// ─── Review Queue Projection (Milestone 1 / P1-C) ──────────────────────────────

/**
 * Fetch a bounded, cursor-paginated review queue projection.
 */
export async function getBatchReviewQueue(
  batchId: string,
  filters?: ReviewQueueFilters & { cursor?: string; limit?: number },
): Promise<ReviewQueuePage> {
  const params = new URLSearchParams();
  if (filters) {
    if (filters.cursor) params.set('cursor', filters.cursor);
    if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
    if (filters.q) params.set('q', filters.q);
    if (filters.brand) params.set('brand', filters.brand);
    if (filters.familyCohortId) params.set('familyCohortId', filters.familyCohortId);
    if (filters.sourceType && filters.sourceType !== 'all') params.set('sourceType', filters.sourceType);
    if (filters.warningsOnly !== undefined) params.set('warningsOnly', String(filters.warningsOnly));
    if (filters.reviewStates && filters.reviewStates.length > 0) {
      params.set('reviewStates', filters.reviewStates.join(','));
    }
  }
  const qs = params.toString();
  return request<ReviewQueuePage>(`/batches/${batchId}/review-queue${qs ? `?${qs}` : ''}`);
}

export type {
  WorkStateCategory,
  WorkStateFilters,
  WorkStateCountsResponse,
  WorkStateItemsResponse,
  WorkStateProjectionHealth,
  ReviewQueuePage,
  ReviewQueueRow,
  ReviewQueueCounts,
  ReviewGateStatus,
  ReviewFamilySummary,
  ProjectionHealth,
};
