/**
 * v2 stage read contracts (Slice 1, council plan §4.1).
 *
 * Dedicated, versioned read model for the linear six-stage navigation. The
 * frozen v1 work-state contracts in `onboarding-work-state.ts` are untouched:
 * v1 keeps limit 1–500/default 100 and its cursor hash/cursor versions.
 *
 * INTENTIONAL VERSION DIVERGENCE: v2 accepts integer limits 1–100, default
 * 50. The v2 client sends 50 explicitly and follows cursors; a request for
 * 100 is a maximum, never a promise to fill it from a single bounded chunk.
 */
import { z } from 'zod';
import { sha256 } from '../hash';
import { StageStatusEnum, SourceTypeEnum } from './onboarding';
import { StageV2Enum } from '../onboarding-stage-vocabulary';
import {
  WorkStateCategoryEnum,
  ReviewStateEnum,
  WorkStateCountsSchema,
  WorkStateProjectionHealthSchema,
  OnboardingWorkStateSchema,
  type WorkStateCounts,
  type WorkStateProjectionHealth,
} from './onboarding-work-state';
import { PreparationSummarySchema } from './onboarding-preparation';

export const STAGE_READ_SCHEMA_VERSION = 2 as const;
export const STAGE_READ_VOCABULARY_VERSION = 2 as const;
/** v2 cursor envelope version. Deliberately 3: v1 API cursors are v:1 (sortKey)
 * and v:2 (row_number/id); v2 stage cursors must never collide with either. */
export const STAGE_READ_CURSOR_VERSION = 3 as const;
export const STAGE_READ_ENDPOINT = 'stage-work-state' as const;
export const STAGE_READ_LIMIT_DEFAULT = 50 as const;
export const STAGE_READ_LIMIT_MAX = 100 as const;
export const STAGE_READ_CHUNK_SIZE = 50 as const;

export const StageReadFiltersSchema = z
  .object({
    stage: StageV2Enum.optional(),
    stageStatus: StageStatusEnum.optional(),
    category: WorkStateCategoryEnum.optional(),
    reviewState: ReviewStateEnum.optional(),
    sourceType: SourceTypeEnum.optional(),
    domain: z.string().optional(),
    cohortId: z.string().optional(),
    q: z.string().optional(),
    /**
     * Ticket #125: server-owned collection-readiness filter. Optional and
     * additive: absent by default, so existing readers keep byte-identical
     * behavior. Applies to route_sources rows with a server-derived
     * collection decision; rows without one never match a present filter
     * (fail closed, never an invented state).
     */
    collectionReadiness: z
      .enum(['ready', 'ready_partial', 'awaiting_approval', 'setup_attention', 'underway', 'unknown', 'unavailable'])
      .optional(),
    collectionPath: z.enum(['approved_strategy', 'compatibility', 'blocked']).optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(STAGE_READ_LIMIT_MAX).optional(),
  })
  .strict();

export type StageReadFilters = z.infer<typeof StageReadFiltersSchema>;

/** Canonical v2 filter fingerprint envelope. Extends the v1 facet set with
 * stage/status plus explicit scope/version fields. This is NOT the v1
 * `computeWorkStateFilterHash` (which hashes category/q/domain/sourceType/
 * cohortId/reviewState only); v1 hashes and cursors are never reused here. */
export interface StageReadScope {
  workspaceId: string;
  batchId: string;
}

export function computeStageReadFilterHashV2(
  filters: Omit<StageReadFilters, 'cursor' | 'limit'>,
  scope: StageReadScope,
): string {
  const canonical: Record<string, unknown> = {
    workspaceId: scope.workspaceId,
    batchId: scope.batchId,
    endpoint: STAGE_READ_ENDPOINT,
    cursorVersion: STAGE_READ_CURSOR_VERSION,
    stageVocabularyVersion: STAGE_READ_VOCABULARY_VERSION,
    stage: filters.stage ?? null,
    stageStatus: filters.stageStatus ?? null,
    category: filters.category ?? null,
    reviewState: filters.reviewState ?? null,
    sourceType: filters.sourceType ?? null,
    domain: filters.domain && filters.domain.trim() ? filters.domain.trim().toLowerCase() : null,
    cohortId: filters.cohortId && filters.cohortId.trim() ? filters.cohortId.trim() : null,
    q: filters.q && filters.q.trim() ? filters.q.trim().toLowerCase() : null,
    collectionReadiness: filters.collectionReadiness ?? null,
    collectionPath: filters.collectionPath ?? null,
  };
  const serialized = JSON.stringify(canonical, Object.keys(canonical).sort());
  return sha256(serialized).slice(0, 32);
}

export const StageReadDbCursorPayloadSchema = z
  .object({
    v: z.literal(STAGE_READ_CURSOR_VERSION),
    rowNumber: z.number().int().nonnegative(),
    id: z.string().min(1),
    filterHash: z.string().regex(/^[a-f0-9]{16,64}$/),
    workspaceId: z.string().min(1),
    batchId: z.string().min(1),
    endpoint: z.literal(STAGE_READ_ENDPOINT),
    stageVocabularyVersion: z.literal(STAGE_READ_VOCABULARY_VERSION),
  })
  .strict();

export type StageReadDbCursorPayload = z.infer<typeof StageReadDbCursorPayloadSchema>;

export class StageReadCursorError extends Error {
  constructor(
    message: string,
    public readonly code: 'malformed_cursor' | 'filter_mismatch' | 'invalid_version',
  ) {
    super(message);
    this.name = 'StageReadCursorError';
  }
}

export function encodeStageReadCursor(payload: StageReadDbCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeStageReadCursor(cursor: string): StageReadDbCursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new StageReadCursorError('Malformed stage-read cursor', 'malformed_cursor');
  }
  // Legacy/foreign cursor versions are a version error, never silently accepted.
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'v' in parsed &&
    (parsed as { v: unknown }).v !== STAGE_READ_CURSOR_VERSION
  ) {
    throw new StageReadCursorError(
      `Unsupported stage-read cursor version: ${String((parsed as { v: unknown }).v)}`,
      'invalid_version',
    );
  }
  const result = StageReadDbCursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    // A structurally valid v3 envelope with wrong scope/version fields is a
    // version/scope error only when the fields parse but mismatch at validate
    // time; unparseable structure is malformed.
    throw new StageReadCursorError('Malformed stage-read cursor', 'malformed_cursor');
  }
  return result.data;
}

/** Bind a v3 cursor to the current request scope + filter fingerprint. */
export function validateStageReadCursor(
  cursor: string,
  filters: Omit<StageReadFilters, 'cursor' | 'limit'>,
  scope: StageReadScope,
): StageReadDbCursorPayload {
  const payload = decodeStageReadCursor(cursor);
  if (
    payload.workspaceId !== scope.workspaceId ||
    payload.batchId !== scope.batchId ||
    payload.endpoint !== STAGE_READ_ENDPOINT ||
    payload.stageVocabularyVersion !== STAGE_READ_VOCABULARY_VERSION
  ) {
    throw new StageReadCursorError('Stage-read cursor does not belong to this batch/workspace/endpoint version', 'invalid_version');
  }
  const expectedHash = computeStageReadFilterHashV2(filters, scope);
  if (payload.filterHash !== expectedHash) {
    throw new StageReadCursorError('Stage-read cursor filter fingerprint does not match current filters', 'filter_mismatch');
  }
  return payload;
}

// ─── 36-cell stage×status matrix (canonical v2 stage keys) ────────────────────

const StageStatusCellMapSchema = z.object({
  pending: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  needs_input: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const StageStatusMatrixSchema = z.object({
  route_sources: StageStatusCellMapSchema,
  find_product_page: StageStatusCellMapSchema,
  collect_details: StageStatusCellMapSchema,
  prepare_listing: StageStatusCellMapSchema,
  review_listings: StageStatusCellMapSchema,
  create_drafts: StageStatusCellMapSchema,
});

export type StageStatusMatrix = z.infer<typeof StageStatusMatrixSchema>;

export function emptyStageStatusMatrix(): StageStatusMatrix {
  const zero = () => ({
    pending: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
    needs_input: 0,
    skipped: 0,
  });
  return {
    route_sources: zero(),
    find_product_page: zero(),
    collect_details: zero(),
    prepare_listing: zero(),
    review_listings: zero(),
    create_drafts: zero(),
  };
}

/** Non-matrix view of the 36 cells. Sums to matchingTotal. */
export function sumStageStatusMatrix(matrix: StageStatusMatrix): number {
  let total = 0;
  for (const stage of Object.keys(matrix) as Array<keyof StageStatusMatrix>) {
    for (const status of Object.keys(matrix[stage]) as Array<keyof StageStatusMatrix[keyof StageStatusMatrix]>) {
      total += matrix[stage][status];
    }
  }
  return total;
}

export function emptyWorkStateCounts(): WorkStateCounts {
  return {
    processing: 0,
    needs_attention: 0,
    waiting_on_family: 0,
    ready_for_review: 0,
    approved: 0,
    ready_to_export: 0,
    completed: 0,
    skipped: 0,
  };
}

// ─── Response envelopes ───────────────────────────────────────────────────────

const StageReadEnvelopeBase = {
  schemaVersion: z.literal(STAGE_READ_SCHEMA_VERSION),
  stageVocabularyVersion: z.literal(STAGE_READ_VOCABULARY_VERSION),
  batchId: z.string(),
  filterFingerprint: z.string().regex(/^[a-f0-9]{16,64}$/),
  projectionHealth: WorkStateProjectionHealthSchema,
};

export const StageReadCountsResponseSchema = z
  .object({
    ...StageReadEnvelopeBase,
    matchingTotal: z.number().int().nonnegative(),
    counts: WorkStateCountsSchema,
    stageStatusMatrix: StageStatusMatrixSchema,
  })
  .strict();

export type StageReadCountsResponse = z.infer<typeof StageReadCountsResponseSchema>;

export const CollectionSourceAvailabilitySchema = z.object({
  kind: z.enum(['official_page', 'distributor_record']),
  ref: z.string().min(1),
  domain: z.string().optional(),
  distributorId: z.string().optional(),
  usable: z.boolean(),
  reason: z.string().max(160),
});

export type CollectionSourceAvailability = z.infer<typeof CollectionSourceAvailabilitySchema>;

/**
 * Ticket #125: serialized server-owned collection decision per item.
 * The client formats this decision; it never recomputes authority.
 */
export const CollectionReadinessSchema = z.object({
  itemId: z.string().min(1),
  path: z.enum(['approved_strategy', 'compatibility', 'blocked']),
  readiness: z.enum(['ready', 'ready_partial', 'awaiting_approval', 'setup_attention', 'underway', 'unknown', 'unavailable']),
  canCollect: z.boolean(),
  canExecuteNow: z.boolean(),
  effectiveRevision: z.number().int().nonnegative().nullable(),
  reasons: z.array(z.string().max(160)),
  requires: z.enum(['none', 'fresh_capture', 'pinned_resume', 'explicit_retry']),
  effectiveSources: z.array(z.object({ kind: z.enum(['official_page', 'distributor_record']), ref: z.string().min(1) })),
  sourceAvailability: z.array(CollectionSourceAvailabilitySchema),
  /** Exact copy-ladder label (textual, never color-only). */
  label: z.string().min(1),
  /** Persistent Ready explanation (null unless ready/ready_partial). */
  explanation: z.string().nullable(),
  strategyLabel: z.string().min(1),
});

export type CollectionReadiness = z.infer<typeof CollectionReadinessSchema>;

export const StageReadItemsResponseSchema = z
  .object({
    ...StageReadEnvelopeBase,
    items: z.array(OnboardingWorkStateSchema),
    /**
     * Slice 4-SERVER: v2-only preparation sections keyed by item id, covering
     * exactly the matched items. Optional so older v2 readers keep parsing.
     * Bounded: ≤limit entries, five fixed sections each (see
     * PreparationSummarySchema).
     */
    preparationByItem: z.record(z.string(), PreparationSummarySchema).optional(),
    /**
     * Ticket #125: server-owned collection decisions keyed by item id,
     * covering exactly the matched route_sources items. Optional so older
     * v2 readers keep parsing. Bounded: ≤limit entries.
     */
    collectionByItem: z.record(z.string(), CollectionReadinessSchema).optional(),
    nextCursor: z.string().nullable(),
    scannedRows: z.number().int().nonnegative(),
    queryCount: z.number().int().nonnegative(),
  })
  .strict();

export type StageReadItemsResponse = z.infer<typeof StageReadItemsResponseSchema>;

export type { WorkStateProjectionHealth };
