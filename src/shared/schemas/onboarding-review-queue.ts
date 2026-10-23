// fallow-ignore-file unused-export
import { z } from 'zod';
import { sha256 } from '../hash';
import { SourceTypeEnum, StageStatusEnum } from './onboarding';
import { StageV2Enum } from '../onboarding-stage-vocabulary';
import { ReviewStateEnum } from './onboarding-work-state';

// ── ReviewGateStatusEnum ────────────────────────────────────────────────────────
export const ReviewGateStatusEnum = z.enum(['ready', 'blocked', 'unknown']);
export type ReviewGateStatus = z.infer<typeof ReviewGateStatusEnum>;

// ── Bounded Family Summary ──────────────────────────────────────────────────────
export const ReviewFamilySummarySchema = z
  .object({
    cohortId: z.string(),
    label: z.string().nullable().default(null),
    memberCount: z.number().int().nonnegative(),
    readyCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ReviewFamilySummary = z.infer<typeof ReviewFamilySummarySchema>;

// ── ReviewQueueRowSchema (Strictly bounded, no detail blobs) ───────────────────
export const ReviewQueueRowSchema = z
  .object({
    itemId: z.string(),
    upc: z.string(),
    displayTitle: z.string(),
    brand: z.string().nullable().default(null),
    sourceType: SourceTypeEnum.nullable().default(null),
    imageUrl: z.string().nullable().default(null),
    family: ReviewFamilySummarySchema.nullable().default(null),
    reviewState: ReviewStateEnum.nullable().default(null),
    sortKey: z.string(),
    updatedAt: z.string(),
    warningCodes: z.array(z.string()).default([]),
    hasWarnings: z.boolean().default(false),
    reviewGateStatus: ReviewGateStatusEnum,
    /** Current command context; absent on older responses means unavailable. */
    stage: StageV2Enum.optional(),
    stageStatus: StageStatusEnum.optional(),
    actions: z.object({
      canCompleteReview: z.boolean(),
      canApprove: z.boolean(),
      canEdit: z.boolean(),
    }).strict().optional(),
  })
  .strict();
export type ReviewQueueRow = z.infer<typeof ReviewQueueRowSchema>;

// ── ProjectionHealthSchema ──────────────────────────────────────────────────────
export const ProjectionHealthIssueSchema = z
  .object({
    source: z.string(),
    code: z.string(),
    affectedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectionHealthIssue = z.infer<typeof ProjectionHealthIssueSchema>;

export const ProjectionHealthSchema = z
  .object({
    status: z.enum(['healthy', 'degraded']),
    version: z.string(),
    computedAt: z.string(),
    issues: z.array(ProjectionHealthIssueSchema).default([]),
  })
  .strict();
export type ProjectionHealth = z.infer<typeof ProjectionHealthSchema>;

// ── ReviewQueueCountsSchema ─────────────────────────────────────────────────────
export const ReviewQueueCountsSchema = z
  .object({
    total: z.number().int().nonnegative().default(0),
    reviewedTotal: z.number().int().nonnegative().default(0),
    unreviewedTotal: z.number().int().nonnegative().default(0),
    readyCount: z.number().int().nonnegative().default(0),
    blockedCount: z.number().int().nonnegative().default(0),
    unknownCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ReviewQueueCounts = z.infer<typeof ReviewQueueCountsSchema>;

/** Active queue totals respecting non-status filters, before pagination. */
export const ReviewQueueStatusTotalsSchema = z.object({
  unreviewed: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
}).strict();
export type ReviewQueueStatusTotals = z.infer<typeof ReviewQueueStatusTotalsSchema>;

/** Batch-wide active review scope, independent of all filters and pagination. */
export const ReviewQueueProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.reviewed + value.remaining !== value.total) {
    ctx.addIssue({ code: 'custom', message: 'Review progress must reconcile with total' });
  }
});
export type ReviewQueueProgress = z.infer<typeof ReviewQueueProgressSchema>;

// ── ReviewQueueFiltersSchema ────────────────────────────────────────────────────
export const ReviewQueueFiltersSchema = z
  .object({
    reviewStates: z.array(ReviewStateEnum).optional(),
    warningsOnly: z.boolean().optional(),
    gateStatus: ReviewGateStatusEnum.optional(),
    familyCohortId: z.string().optional(),
    brand: z.string().optional(),
    sourceType: z.enum(['official_page', 'distributor_record', 'all']).optional(),
    q: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50).optional(),
    cursor: z.string().optional(),
    /** Bounded inspector context, not a predicate or part of cursor identity. */
    selectedItemId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ReviewQueueFilters = z.infer<typeof ReviewQueueFiltersSchema>;

// ── ReviewQueuePageSchema ───────────────────────────────────────────────────────
export const ReviewQueuePageSchema = z
  .object({
    batchId: z.string(),
    rows: z.array(ReviewQueueRowSchema),
    /** Null proves the requested selection left this scope; absent is legacy coverage. */
    selectedRow: ReviewQueueRowSchema.nullable().optional(),
    nextCursor: z.string().nullable(),
    counts: ReviewQueueCountsSchema,
    statusTotals: ReviewQueueStatusTotalsSchema.optional(),
    progress: ReviewQueueProgressSchema.optional(),
    projectionHealth: ProjectionHealthSchema,
  })
  .strict();
export type ReviewQueuePage = z.infer<typeof ReviewQueuePageSchema>;

// ── Cursor Encoding / Decoding & Filter Hash ────────────────────────────────────
export interface ReviewQueueCursorPayload {
  v: 1;
  sortKey: string;
  itemId: string;
  filterHash: string;
}

export const ReviewQueueCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    sortKey: z.string(),
    itemId: z.string(),
    filterHash: z.string().regex(/^[a-f0-9]{16,64}$/),
  })
  .strict();

export class ReviewQueueCursorError extends Error {
  constructor(
    message: string,
    public readonly code: 'malformed_cursor' | 'filter_mismatch' | 'invalid_version',
  ) {
    super(message);
    this.name = 'ReviewQueueCursorError';
  }
}

/** Compute deterministic SHA-256 hash of canonicalized query filters. */
export function computeReviewQueueFilterHash(filters: ReviewQueueFilters): string {
  const canonical: Record<string, unknown> = {};
  if (filters.reviewStates && filters.reviewStates.length > 0) {
    canonical.reviewStates = [...filters.reviewStates].sort();
  }
  if (typeof filters.warningsOnly === 'boolean') {
    canonical.warningsOnly = filters.warningsOnly;
  }
  if (filters.gateStatus) {
    canonical.gateStatus = filters.gateStatus;
  }
  if (filters.familyCohortId && filters.familyCohortId.trim()) {
    canonical.familyCohortId = filters.familyCohortId.trim();
  }
  if (filters.brand && filters.brand.trim()) {
    canonical.brand = filters.brand.trim().toLowerCase();
  }
  if (filters.sourceType && filters.sourceType !== 'all') {
    canonical.sourceType = filters.sourceType;
  }
  if (filters.q && filters.q.trim()) {
    canonical.q = filters.q.trim().toLowerCase();
  }
  const serialized = JSON.stringify(canonical, Object.keys(canonical).sort());
  return sha256(serialized).slice(0, 16);
}

/** Encode cursor payload to base64url string. */
export function encodeReviewQueueCursor(payload: ReviewQueueCursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Decode base64url string into validated cursor payload. */
export function decodeReviewQueueCursor(cursor: string): ReviewQueueCursorPayload {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    const result = ReviewQueueCursorPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new ReviewQueueCursorError('Invalid cursor schema', 'malformed_cursor');
    }
    return result.data;
  } catch (err) {
    if (err instanceof ReviewQueueCursorError) throw err;
    throw new ReviewQueueCursorError(
      `Malformed review queue cursor: ${err instanceof Error ? err.message : String(err)}`,
      'malformed_cursor',
    );
  }
}

/** Validate cursor against active filters; throws HTTP-400 error on mismatch. */
export function validateReviewQueueCursor(
  cursor: string,
  currentFilters: ReviewQueueFilters,
): ReviewQueueCursorPayload {
  const payload = decodeReviewQueueCursor(cursor);
  const expectedHash = computeReviewQueueFilterHash(currentFilters);
  if (payload.filterHash !== expectedHash) {
    throw new ReviewQueueCursorError(
      'Cursor filter hash does not match current query filters',
      'filter_mismatch',
    );
  }
  return payload;
}

const REVIEW_STATE_ORDER: Record<string, number> = {
  unreviewed: 0,
  reviewed: 1,
  approved: 2,
  not_ready: 3,
};

/** Compute stable sortKey for ReviewQueueRow */
export function buildReviewQueueSortKey(
  reviewState: string | null,
  displayTitle: string,
  itemId: string,
): string {
  const stateOrder = REVIEW_STATE_ORDER[reviewState ?? 'unreviewed'] ?? 3;
  const titlePart = displayTitle.toLowerCase().slice(0, 64).padEnd(64, ' ');
  return `${stateOrder}:${titlePart}:${itemId}`;
}

/**
 * Derive review gate status and warning codes for a single item.
 * Evaluates mandatory promotion fields: name, price, brand, primary image, verified category pages.
 */
export function deriveReviewGateStatus(
  item: { name: string; price?: string | null; brand?: string | null; brandHint?: string | null; sourceType?: string | null },
  curationData: Record<string, unknown> | null,
  extractionData: Record<string, unknown> | null,
): { status: ReviewGateStatus; warningCodes: string[] } {
  const warningCodes: string[] = [];
  let isBlocked = false;
  const isUnknown = false;

  // 1. Semantic Validation Check
  if (curationData?.semanticValidation && typeof curationData.semanticValidation === 'object') {
    const sv = curationData.semanticValidation as { status?: string; findings?: Array<{ message?: string }> };
    if (sv.status === 'blocked') {
      isBlocked = true;
      warningCodes.push('semantic_validation_blocked');
    }
  }

  // 2. Name resolution
  const curatedTitle = typeof curationData?.curatedTitle === 'string' ? curationData.curatedTitle.trim() : null;
  const extractedTitle = typeof extractionData?.title === 'string' ? extractionData.title.trim() : null;
  const effectiveName = curatedTitle || extractedTitle || (item.name ? item.name.trim() : '');
  if (!effectiveName) {
    isBlocked = true;
    warningCodes.push('missing_name');
  } else if (!curatedTitle) {
    warningCodes.push('name_from_fallback_source');
  }

  // 3. Price resolution — Input Price Authority (ADR 0043): item.price ONLY,
  // never a page-extracted fallback for any source type.
  const rawPrice = item.price || null;
  const price = typeof rawPrice === 'string' ? rawPrice.replace(/[$\s,]/g, '').trim() : null;
  if (!price) {
    isBlocked = true;
    warningCodes.push('missing_price');
  }

  // 4. Brand resolution
  const brand = (item.brand || (curationData?.brandHint as string) || item.brandHint || '').trim();
  if (!brand) {
    isBlocked = true;
    warningCodes.push('missing_brand');
  }

  // 5. Primary image resolution
  const reviewedMedia = curationData?.reviewedMedia as { primaryImage?: string | null; suppressed?: string[] } | undefined;
  const suppressed = new Set(reviewedMedia?.suppressed ?? []);
  const designatedPrimary = reviewedMedia?.primaryImage?.trim();
  let primaryImage: string | null = null;
  if (designatedPrimary && !suppressed.has(designatedPrimary)) {
    primaryImage = designatedPrimary;
  } else if (item.sourceType === 'distributor_record') {
    const approvals = Array.isArray(extractionData?.distributorImageApprovals)
      ? (extractionData!.distributorImageApprovals as Array<{ imageUrl?: string }>)
      : [];
    const approvedUrls = approvals
      .map(a => a.imageUrl)
      .filter((u): u is string => typeof u === 'string' && u.length > 0 && !suppressed.has(u));
    primaryImage = approvedUrls[0] ?? null;
  } else {
    const extImg = typeof extractionData?.primaryImage === 'string' ? extractionData.primaryImage.trim() : null;
    if (extImg && !suppressed.has(extImg)) {
      primaryImage = extImg;
    }
  }
  if (!primaryImage) {
    isBlocked = true;
    warningCodes.push('missing_primary_image');
  }

  // 6. Category Page resolution
  const suggestedPages = Array.isArray(curationData?.suggestedPages) ? curationData!.suggestedPages : [];
  const proposals = Array.isArray(curationData?.classificationProposals) ? curationData!.classificationProposals : [];
  const acceptedPageProposals = proposals.filter((p: any) => p.proposalType === 'category_page' && p.status === 'accepted').length;
  if (suggestedPages.length === 0 && acceptedPageProposals === 0) {
    isBlocked = true;
    warningCodes.push('missing_pages');
  }

  // 7. Undecided proposals
  if (proposals.some((p: any) => p.status === 'pending')) {
    warningCodes.push('pending_proposals');
  }

  const finalStatus: ReviewGateStatus = isUnknown ? 'unknown' : isBlocked ? 'blocked' : 'ready';
  return { status: finalStatus, warningCodes };
}
