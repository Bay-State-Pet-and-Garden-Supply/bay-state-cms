// fallow-ignore-file unused-export

/**
 * Epic #46 — Operator work-state projection (Phases 1/7/8).
 *
 * The server owns ALL operator-facing read-model derivation. The client never
 * reverse-engineers `stage` / `stage_status` / error strings / cohort state /
 * feature flags into human meaning — it consumes the projected work state
 * below.
 *
 * This schema is the shared contract between the projection service
 * (`src/onboarding/onboarding-work-state.ts`), the batch/item APIs
 * (`src/server/routes/onboarding-routes.ts`, `onboarding-work-routes.ts`) and
 * the Batch Workspace UI.
 */
import { z } from 'zod';
import { sha256 } from '../hash';
import { PipelineStageEnum, LegacyPipelineStageEnum, StageStatusEnum, SourceTypeEnum } from './onboarding';

// ─── Categories ─────────────────────────────────────────────────────────────────

/**
 * The operator-facing bucket every onboarding item projects into. One clear
 * current work state per product.
 *
 * - processing: automation is handling the item (no human action).
 * - needs_attention: automation stopped and requires operator judgment.
 * - waiting_on_family: the item's own evidence is ready but its cohort cannot
 *   start Curation until siblings are ready/blocked (ADR 0013 barrier).
 * - ready_for_review: Curation output complete, awaiting final human review.
 * - approved: human bulk approval granted; export/release not yet performed.
 * - ready_to_export: approved AND export drafts were created (the actual
 *   ShopSite-draft side effect completed); export/release is pending.
 * - completed: the release/export operation succeeded and was verified.
 * - skipped: the item was deliberately skipped.
 */
export const WorkStateCategoryEnum = z.enum([
  'processing',
  'needs_attention',
  'waiting_on_family',
  'ready_for_review',
  'approved',
  'ready_to_export',
  'completed',
  'skipped',
]);

export type WorkStateCategory = z.infer<typeof WorkStateCategoryEnum>;

// ─── Activities ────────────────────────────────────────────────────────────────

/** The underlying automated/human activity a product is in or waiting on. */
export const WorkActivityEnum = z.enum([
  'distributor_lookup',
  'official_site_search',
  'official_url_verification',
  'extraction',
  'curation',
  // Granular curation sub-stages (Task 1): refinement of 'curation' for
  // pipeline observability. Backward-compatible — 'curation' remains the
  // fallback when no sub-stage can be determined.
  'packaging_ocr',
  'cohort_freezing',
  'title_coordination',
  'page_coordination',
  'attribute_curation',
  'semantic_validation',
  'review',
  'approval',
  'export',
]);

export type WorkActivity = z.infer<typeof WorkActivityEnum>;

// ─── Semantic finding observability (Task 1) ──────────────────────────────────

export const FindingCodeEnum = z.enum([
  'family_product_type',
  'family_brand',
  'coordinated_title',
  'coordinated_page',
  'coordinated_page_name_mismatch',
  'member_attribute_applicability',
  'member_cardinality',
]);

export type FindingCode = z.infer<typeof FindingCodeEnum>;

export const SuggestedActionEnum = z.enum([
  'accept_majority',
  'choose_canonical_brand',
  'split_cohort',
  're_run_curation',
]);

export type SuggestedAction = z.infer<typeof SuggestedActionEnum>;

export const FindingDetailSchema = z.object({
  code: FindingCodeEnum,
  memberSku: z.string(),
  message: z.string(),
  conflictingValues: z.array(z.string()).nullable().default(null),
  suggestedAction: SuggestedActionEnum.nullable().default(null),
});

export type FindingDetail = z.infer<typeof FindingDetailSchema>;

// ─── Attention reasons / actions ───────────────────────────────────────────────

/** Why automation stopped for a needs_attention item. */
export const AttentionReasonEnum = z.enum([
  'brand_not_provided',
  'verify_official_url',
  'no_official_url',
  'choose_official_url',
  'choose_variant',
  'extractor_profile_required',
  'extraction_profile_failed',
  'source_conflict',
  'processing_failed',
  'semantic_validation_blocked',
  /**
   * Parent #101 (manual-evidence route): a profile-blocked extraction
   * failure eligible for operator manual evidence (flag-gated). Additive:
   * existing consumers fall back to their unknown-reason handling.
   */
  'manual_evidence_available',
]);

export type AttentionReason = z.infer<typeof AttentionReasonEnum>;

/** The operator decision/action that resolves the blocker. */
export const AttentionActionEnum = z.enum([
  'assign_brand',
  'verify_official_url',
  'choose_official_url',
  'choose_variant',
  'setup_extractor_profile',
  'retry_extraction',
  'resolve_source_conflict',
  'retry_processing',
  'resolve_semantic_conflict',
  /**
   * Parent #101 (manual-evidence route): open the manual-evidence form for
   * a profile-blocked item. Additive: existing consumers fall back to
   * their unknown-action handling.
   */
  'enter_manual_evidence',
]);

export type AttentionAction = z.infer<typeof AttentionActionEnum>;

// ─── Durable review state ──────────────────────────────────────────────────────

/**
 * Durable human-review state, independent of the pipeline stage:
 * - not_ready: Curation output does not exist yet — nothing to review.
 * - unreviewed: Curation complete, human review not yet performed (or a
 *   prior review was invalidated by a consequential edit).
 * - reviewed: human inspection recorded (durable `onboarding_review_state`).
 * - approved: bulk approval release decision recorded.
 */
export const ReviewStateEnum = z.enum(['not_ready', 'unreviewed', 'reviewed', 'approved']);

export type ReviewState = z.infer<typeof ReviewStateEnum>;

// ─── Family context ────────────────────────────────────────────────────────────

/** Canonical cohort readiness surfaced to the operator (ADR 0013 barrier). */
export const OnboardingFamilyStateSchema = z.object({
  cohortId: z.string(),
  /** Cohort label, e.g. "Blue Buffalo Life Protection Chicken". */
  label: z.string().nullable(),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
  /** Members blocked in a pre-Curation barrier stage (sourcing|discovery|extraction). */
  blockedCount: z.number().int(),
  /** Sibling item ids this product is waiting on (excludes self; never the blocked members). */
  waitingOnItemIds: z.array(z.string()),
});

export type OnboardingFamilyState = z.infer<typeof OnboardingFamilyStateSchema>;

// ─── Per-item work state ───────────────────────────────────────────────────────

export const OnboardingWorkStateSchema = z.object({
  itemId: z.string(),
  category: WorkStateCategoryEnum,
  /** The automated/human activity, when meaningful. */
  activity: WorkActivityEnum.nullable().default(null),
  /** Human-facing short label, e.g. "Verify official product page". */
  label: z.string(),
  /** Optional human-facing detail (deterministic, non-secret). */
  detail: z.string().nullable().default(null),
  /** Present ONLY for needs_attention items: why automation stopped. */
  attentionReason: AttentionReasonEnum.nullable().default(null),
  /** Present ONLY for needs_attention items: the operator action that resolves it. */
  attentionAction: AttentionActionEnum.nullable().default(null),
  /** Optional client-safe variant resolution summary for choose_variant */
  variantResolution: z
    .object({
      id: z.string(),
      status: z.string(),
      candidates: z.array(z.any()),
      identityMatrixHash: z.string(),
      platform: z.string(),
    })
    .nullable()
    .optional()
    .default(null),
  /** Structured semantic finding (populated when attentionReason is semantic_validation_blocked). */
  findingCode: FindingCodeEnum.nullable().default(null),
  findingSummary: z.string().nullable().default(null),
  conflictingValues: z.array(z.string()).nullable().default(null),
  suggestedAction: SuggestedActionEnum.nullable().default(null),
  findingDetails: z.array(FindingDetailSchema).nullable().default(null),
  /** Canonical cohort readiness when the item belongs to a candidate family. */
  family: OnboardingFamilyStateSchema.nullable().default(null),
  /** Durable review/approval state. */
  reviewState: ReviewStateEnum.nullable().default(null),
  /**
   * Raw pipeline stage — secondary diagnostics, never the primary UI.
   * Slice 5b native: preserves the STORED spelling (either vocabulary);
   * compare through the canonical vocabulary helpers.
   */
  stage: z.union([PipelineStageEnum, LegacyPipelineStageEnum]),
  /** Raw pipeline stage status — secondary diagnostics. */
  stageStatus: StageStatusEnum,
  // ── Lightweight identity for filters/search/rendering (additive) ──
  upc: z.string(),
  name: z.string(),
  brand: z.string().nullable().default(null),
  sourceType: SourceTypeEnum.nullable().default(null),
  /** Normalized source host (official page only; null for distributor records). */
  domain: z.string().nullable().default(null),
  /** Curated title for immediate zero-latency review rendering. */
  curatedTitle: z.string().nullish().default(null),
  /** Primary image URL for immediate zero-latency review rendering. */
  imageUrl: z.string().nullish().default(null),
  /** Curated or extracted description for immediate zero-latency review rendering. */
  description: z.string().nullish().default(null),
  /** Weight in lbs / size for immediate zero-latency review rendering. */
  weight: z.string().nullish().default(null),
});

export type OnboardingWorkState = z.infer<typeof OnboardingWorkStateSchema>;

// ─── Batch-level projection ────────────────────────────────────────────────────

export const WorkStateCountsSchema = z.object({
  processing: z.number().int().default(0),
  needs_attention: z.number().int().default(0),
  waiting_on_family: z.number().int().default(0),
  ready_for_review: z.number().int().default(0),
  approved: z.number().int().default(0),
  ready_to_export: z.number().int().default(0),
  completed: z.number().int().default(0),
  skipped: z.number().int().default(0),
});

export type WorkStateCounts = z.infer<typeof WorkStateCountsSchema>;

export const WORK_STATE_PROJECTION_VERSION = '1.0.0';

export const WorkStateProjectionHealthIssueSchema = z
  .object({
    source: z.string(),
    code: z.string(),
    affectedCount: z.number().int().nonnegative(),
  })
  .strict();

export type WorkStateProjectionHealthIssue = z.infer<typeof WorkStateProjectionHealthIssueSchema>;

export const WorkStateProjectionHealthSchema = z
  .object({
    status: z.enum(['healthy', 'degraded']),
    version: z.string(),
    computedAt: z.string(),
    issues: z.array(WorkStateProjectionHealthIssueSchema).default([]),
  })
  .strict();

export type WorkStateProjectionHealth = z.infer<typeof WorkStateProjectionHealthSchema>;

export const BatchWorkStateSchema = z.object({
  batchId: z.string(),
  counts: WorkStateCountsSchema,
  items: z.array(OnboardingWorkStateSchema),
  /** Total items matching the applied filters (before cursor/limit). */
  total: z.number().int(),
  projectionHealth: WorkStateProjectionHealthSchema.optional(),
});

export type BatchWorkState = z.infer<typeof BatchWorkStateSchema>;

// ─── Bounded counts/items responses (Milestone 3 / P1-E) ──────────────────────

export const WorkStateCountsResponseSchema = z
  .object({
    batchId: z.string(),
    counts: WorkStateCountsSchema,
    total: z.number().int().nonnegative(),
    projectionHealth: WorkStateProjectionHealthSchema,
  })
  .strict();

export type WorkStateCountsResponse = z.infer<typeof WorkStateCountsResponseSchema>;

export const WorkStateItemsResponseSchema = z
  .object({
    batchId: z.string(),
    items: z.array(OnboardingWorkStateSchema),
    nextCursor: z.string().nullable(),
    projectionHealth: WorkStateProjectionHealthSchema,
    scannedRows: z.number().int().nonnegative().optional(),
    queryCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type WorkStateItemsResponse = z.infer<typeof WorkStateItemsResponseSchema>;

/**
 * Client-safe filter shape (mirrors the projection service's WorkStateFilters;
 * invalid enum values fail closed server-side, never 500).
 */
export interface WorkStateFilters {
  category?: WorkStateCategory;
  /** Free-text search across UPC / name / brand. */
  q?: string;
  /** Normalized source host (official page items only). */
  domain?: string;
  sourceType?: 'official_page' | 'distributor_record';
  cohortId?: string;
  reviewState?: ReviewState;
  limit?: number;
  /** @deprecated — use cursor pagination */
  offset?: number;
  cursor?: string;
}

export type OnboardingWorkStateFilters = WorkStateFilters;

export const WorkStateFiltersSchema = z
  .object({
    category: WorkStateCategoryEnum.optional(),
    q: z.string().optional(),
    domain: z.string().optional(),
    sourceType: SourceTypeEnum.optional(),
    cohortId: z.string().optional(),
    reviewState: ReviewStateEnum.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    cursor: z.string().optional(),
  })
  .strict();

// ─── Work-state cursor (cursor-based pagination, Milestone 3) ─────────────────

export interface WorkStateCursorPayload {
  v: 1;
  sortKey: string;
  itemId: string;
  filterHash: string;
}

export const WorkStateCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    sortKey: z.string(),
    itemId: z.string(),
    filterHash: z.string().regex(/^[a-f0-9]{16,64}$/),
  })
  .strict();

export interface WorkStateDbCursorPayload {
  v: 2;
  rowNumber: number;
  id: string;
  filterHash: string;
}

export const WorkStateDbCursorPayloadSchema = z
  .object({
    v: z.literal(2),
    rowNumber: z.number().int().nonnegative(),
    id: z.string(),
    filterHash: z.string().regex(/^[a-f0-9]{16,64}$/),
  })
  .strict();

export class WorkStateCursorError extends Error {
  constructor(
    message: string,
    public readonly code: 'malformed_cursor' | 'filter_mismatch' | 'invalid_version',
  ) {
    super(message);
    this.name = 'WorkStateCursorError';
  }
}

/** Deterministic hash of work-state filters for cursor binding. */
export function computeWorkStateFilterHash(filters: WorkStateFilters): string {
  const canonical: Record<string, unknown> = {};
  if (filters.category) canonical.category = filters.category;
  if (filters.q && filters.q.trim()) canonical.q = filters.q.trim().toLowerCase();
  if (filters.domain && filters.domain.trim()) canonical.domain = filters.domain.trim().toLowerCase();
  if (filters.sourceType) canonical.sourceType = filters.sourceType;
  if (filters.cohortId && filters.cohortId.trim()) canonical.cohortId = filters.cohortId.trim();
  if (filters.reviewState) canonical.reviewState = filters.reviewState;
  const serialized = JSON.stringify(canonical, Object.keys(canonical).sort());
  return sha256(serialized).slice(0, 16);
}

export function encodeWorkStateCursor(payload: WorkStateCursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeWorkStateCursor(cursor: string): WorkStateCursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    const result = WorkStateCursorPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new WorkStateCursorError('Invalid cursor schema', 'malformed_cursor');
    }
    return result.data;
  } catch (err) {
    if (err instanceof WorkStateCursorError) throw err;
    throw new WorkStateCursorError(
      `Malformed work-state cursor: ${err instanceof Error ? err.message : String(err)}`,
      'malformed_cursor',
    );
  }
}

export function validateWorkStateCursor(
  cursor: string,
  currentFilters: WorkStateFilters,
): WorkStateCursorPayload {
  const payload = decodeWorkStateCursor(cursor);
  const expectedHash = computeWorkStateFilterHash(currentFilters);
  if (payload.filterHash !== expectedHash) {
    throw new WorkStateCursorError(
      'Cursor filter hash does not match current query filters',
      'filter_mismatch',
    );
  }
  return payload;
}

export function encodeWorkStateDbCursor(payload: WorkStateDbCursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeWorkStateDbCursor(cursor: string): WorkStateDbCursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    const result = WorkStateDbCursorPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new WorkStateCursorError('Invalid cursor schema', 'malformed_cursor');
    }
    return result.data;
  } catch (err) {
    if (err instanceof WorkStateCursorError) throw err;
    throw new WorkStateCursorError(
      `Malformed work-state cursor: ${err instanceof Error ? err.message : String(err)}`,
      'malformed_cursor',
    );
  }
}

export function validateWorkStateDbCursor(
  cursor: string,
  currentFilters: WorkStateFilters,
): WorkStateDbCursorPayload {
  const payload = decodeWorkStateDbCursor(cursor);
  const expectedHash = computeWorkStateFilterHash(currentFilters);
  if (payload.filterHash !== expectedHash) {
    throw new WorkStateCursorError(
      'Cursor filter hash does not match current query filters',
      'filter_mismatch',
    );
  }
  return payload;
}

/** Try DB cursor first, then legacy sortKey cursor; throws WorkStateCursorError on failure. */
export function decodeAnyWorkStateCursor(cursor: string): WorkStateCursorPayload | WorkStateDbCursorPayload {
  try {
    return decodeWorkStateDbCursor(cursor);
  } catch {
    return decodeWorkStateCursor(cursor);
  }
}

export function validateAnyWorkStateCursor(
  cursor: string,
  currentFilters: WorkStateFilters,
): WorkStateCursorPayload | WorkStateDbCursorPayload {
  try {
    return validateWorkStateDbCursor(cursor, currentFilters);
  } catch (e) {
    if (e instanceof WorkStateCursorError && e.code === 'filter_mismatch') throw e;
    return validateWorkStateCursor(cursor, currentFilters);
  }
}

const WORK_STATE_CATEGORY_ORDER: Record<string, number> = {
  needs_attention: 0,
  processing: 1,
  waiting_on_family: 2,
  ready_for_review: 3,
  approved: 4,
  ready_to_export: 5,
  completed: 6,
  skipped: 7,
};

export function buildWorkStateSortKey(
  category: string | null,
  displayName: string,
  itemId: string,
): string {
  const catOrder = WORK_STATE_CATEGORY_ORDER[category ?? 'processing'] ?? 8;
  const titlePart = displayName.toLowerCase().slice(0, 64).padEnd(64, ' ');
  return `${catOrder}:${titlePart}:${itemId}`;
}

export const EMPTY_WORK_STATE_COUNTS: WorkStateCounts = {
  processing: 0,
  needs_attention: 0,
  waiting_on_family: 0,
  ready_for_review: 0,
  approved: 0,
  ready_to_export: 0,
  completed: 0,
  skipped: 0,
};

// ─── Operation receipt (Milestone 4 / P1-D) ─────────────────────────────────────

export const OperationReceiptSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  batchId: z.string(),
  operation: z.enum(['approve', 'export']),
  principal: z.string(),
  role: z.string(),
  createdAt: z.string(),
  idempotencyKey: z.string().nullable().default(null),
  detailsJson: z.string().nullable().default(null),
});

export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

// ─── Approval request/response ─────────────────────────────────────────────────

export const ApproveItemsRequestSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(1000).refine(
    ids => new Set(ids).size === ids.length,
    'itemIds must not contain duplicates',
  ),
  /** Optional operator identity for the audit trail. */
  reviewerId: z.string().max(200).optional(),
});

export type ApproveItemsRequest = z.infer<typeof ApproveItemsRequestSchema>;

export const ApprovalItemOutcomeSchema = z.object({
  itemId: z.string(),
  status: z.enum(['approved', 'rejected']),
  reason: z.string().nullable().default(null),
});

export type ApprovalItemOutcome = z.infer<typeof ApprovalItemOutcomeSchema>;

export const ApproveItemsResponseSchema = z.object({
  results: z.array(ApprovalItemOutcomeSchema),
  approvedCount: z.number().int(),
  rejectedCount: z.number().int(),
  rejected: z.array(ApprovalItemOutcomeSchema),
  audited: z.boolean(),
});

export type ApproveItemsResponse = z.infer<typeof ApproveItemsResponseSchema>;

// ─── Extractor-profile domain blockers (epic #46 follow-up, phase 5) ──────────

export const ExtractorProfileBlockerSampleSchema = z.object({
  itemId: z.string(),
  upc: z.string().optional(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string(),
});

export const ExtractorProfileDomainBlockerSchema = z.object({
  domain: z.string(),
  blockedItemCount: z.number().int(),
  batchId: z.string(),
  itemIds: z.array(z.string()),
  sampleItems: z.array(ExtractorProfileBlockerSampleSchema),
  profileExists: z.boolean(),
});

export const ExtractorProfileBlockersResponseSchema = z.object({
  blockers: z.array(ExtractorProfileDomainBlockerSchema),
});

export type ExtractorProfileDomainBlocker = z.infer<typeof ExtractorProfileDomainBlockerSchema>;
export type ExtractorProfileBlockersResponse = z.infer<typeof ExtractorProfileBlockersResponseSchema>;

// ─── Brand-domain setup blockers (ADR 0017 — batch-level Resolve Brand Domains) ─

/** One sample item behind a brand-domain blocker (up to 3 per blocker). */
export const BrandDomainSetupBlockerSampleSchema = z.object({
  itemId: z.string(),
  upc: z.string().optional(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
});

/**
 * Discovery items parked because their brand has no mapped official domain
 * (`needs_review: no domain mapped for brand "X" …`), grouped by brand.
 */
export const BrandDomainSetupBlockerSchema = z.object({
  brand: z.string(),
  blockedItemCount: z.number().int(),
  batchId: z.string(),
  itemIds: z.array(z.string()),
  sampleItems: z.array(BrandDomainSetupBlockerSampleSchema),
  /** Best-known brand→domain mapping from `brand_sites` (null when unmapped). */
  existingMapping: z.string().nullable(),
  /** When the group's earliest parked item was created (ISO timestamp). */
  createdAt: z.string(),
});

export const BrandDomainSetupResponseSchema = z.object({
  blockers: z.array(BrandDomainSetupBlockerSchema),
});

export type BrandDomainSetupBlocker = z.infer<typeof BrandDomainSetupBlockerSchema>;
export type BrandDomainSetupResponse = z.infer<typeof BrandDomainSetupResponseSchema>;

// ─── Domain release response ───────────────────────────────────────────────────

export const DomainReleaseResponseSchema = z.object({
  domain: z.string(),
  releasedItemIds: z.array(z.string()),
  count: z.number().int(),
  skippedCount: z.number().int(),
});

export type DomainReleaseResponse = z.infer<typeof DomainReleaseResponseSchema>;
