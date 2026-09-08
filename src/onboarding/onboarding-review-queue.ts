import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { toCanonicalStage, type StageV2 } from '../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical equality for hydrated stages (dual read). */
function stageIs(rawStage: unknown, canonical: StageV2): boolean {
  try {
    return toCanonicalStage(rawStage) === canonical;
  } catch {
    return false;
  }
}
import { listReviewStates } from '../db/repositories/onboarding-review-repo';
import { buildCohortContext } from './onboarding-work-state';
import {
  type ReviewQueueRow,
  type ReviewQueuePage,
  type ReviewQueueFilters,
  type ProjectionHealth,
  type ProjectionHealthIssue,
  encodeReviewQueueCursor,
  validateReviewQueueCursor,
  computeReviewQueueFilterHash,
  deriveReviewGateStatus,
  buildReviewQueueSortKey,
} from '../shared/schemas/onboarding-review-queue';

export { deriveReviewGateStatus, buildReviewQueueSortKey };

export const REVIEW_QUEUE_PROJECTION_VERSION = '1.0.0';

/**
 * Project a batch into a bounded, cursor-paginated review queue.
 */
export function getBatchReviewQueue(
  batchId: string,
  filters: ReviewQueueFilters = {},
  _options?: { workspaceId?: string },
): ReviewQueuePage {
  const items = listItemsByBatch(batchId);
  const reviewStatesMap = listReviewStates(batchId);
  const cohortContext = buildCohortContext(batchId, items);

  const issues: ProjectionHealthIssue[] = [];

  // 1. Project compact rows
  const allRows: ReviewQueueRow[] = [];
  for (const item of items) {
    const curationData = item.curationData ? (item.curationData as Record<string, unknown>) : null;
    const extractionData = item.extractionData ? (item.extractionData as Record<string, unknown>) : null;

    const reviewRow = reviewStatesMap.get(item.id);
    // Derive review state
    let reviewState: 'unreviewed' | 'reviewed' | 'approved' | 'not_ready';
    if (reviewRow) {
      if (reviewRow.approvedAt && !reviewRow.reviewInvalidatedAt) reviewState = 'approved';
      else if (reviewRow.reviewInvalidatedAt) reviewState = 'unreviewed';
      else if (reviewRow.reviewedAt) reviewState = 'reviewed';
      else reviewState = 'unreviewed';
    } else {
      if (stageIs(item.stage, 'review_listings') && item.stageStatus === 'completed') reviewState = 'reviewed';
      else if (stageIs(item.stage, 'create_drafts') && item.stageStatus === 'completed') reviewState = 'reviewed';
      else if (stageIs(item.stage, 'prepare_listing') && item.stageStatus === 'completed') reviewState = 'unreviewed';
      else if (stageIs(item.stage, 'review_listings')) reviewState = 'unreviewed';
      else reviewState = 'not_ready';
    }

    const curatedTitle = typeof curationData?.curatedTitle === 'string' ? curationData.curatedTitle : null;
    const displayTitle = curatedTitle?.trim() || item.name;
    const brand = (curationData?.brandHint as string) || item.brandHint || null;
    const familyState = cohortContext.get(item.id);

    const familySummary = familyState
      ? {
          cohortId: familyState.cohortId,
          label: familyState.label,
          memberCount: familyState.memberCount,
          readyCount: familyState.readyCount,
          blockedCount: familyState.blockedCount,
        }
      : null;

    const { status: reviewGateStatus, warningCodes } = deriveReviewGateStatus(
      item,
      curationData,
      extractionData,
    );

    // Primary image thumbnail
    let imageUrl: string | null = null;
    if (curationData?.reviewedMedia && typeof curationData.reviewedMedia === 'object') {
      const rm = curationData.reviewedMedia as { primaryImage?: string };
      if (rm.primaryImage) imageUrl = rm.primaryImage;
    }
    if (!imageUrl && extractionData) {
      if (item.sourceType === 'distributor_record') {
        const approvals = Array.isArray(extractionData.distributorImageApprovals)
          ? (extractionData.distributorImageApprovals as Array<{ imageUrl?: string }>)
          : [];
        imageUrl = approvals[0]?.imageUrl ?? null;
      } else {
        imageUrl = (extractionData.primaryImage as string) ?? null;
      }
    }

    const sortKey = buildReviewQueueSortKey(reviewState, displayTitle, item.id);

    allRows.push({
      itemId: item.id,
      upc: item.upc,
      displayTitle,
      brand,
      sourceType: item.sourceType ?? null,
      imageUrl,
      family: familySummary,
      reviewState: reviewState as any,
      sortKey,
      updatedAt: item.updatedAt ?? item.createdAt,
      warningCodes,
      hasWarnings: warningCodes.length > 0,
      reviewGateStatus,
    });
  }

  // 2. Filter rows
  const filteredRows = allRows.filter(row => {
    if (filters.reviewStates && filters.reviewStates.length > 0) {
      const state = row.reviewState ?? 'unreviewed';
      if (!filters.reviewStates.includes(state as any)) return false;
    }
    if (filters.warningsOnly && !row.hasWarnings) return false;
    if (filters.gateStatus && row.reviewGateStatus !== filters.gateStatus) return false;
    if (filters.familyCohortId && row.family?.cohortId !== filters.familyCohortId) return false;
    if (filters.brand && (row.brand ?? '').toLowerCase() !== filters.brand.toLowerCase()) return false;
    if (filters.sourceType && filters.sourceType !== 'all') {
      if (row.sourceType !== filters.sourceType) return false;
    }
    if (filters.q && filters.q.trim()) {
      const query = filters.q.trim().toLowerCase();
      const haystack = [row.upc, row.displayTitle, row.brand ?? '', row.family?.label ?? ''].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // 3. Sort rows deterministically
  filteredRows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey);
    return a.itemId.localeCompare(b.itemId);
  });

  // 4. Cursor positioning & pagination
  let startIndex = 0;
  if (filters.cursor) {
    const cursorPayload = validateReviewQueueCursor(filters.cursor, filters);
    const cursorIndex = filteredRows.findIndex(
      r => r.sortKey > cursorPayload.sortKey || (r.sortKey === cursorPayload.sortKey && r.itemId > cursorPayload.itemId),
    );
    startIndex = cursorIndex === -1 ? filteredRows.length : cursorIndex;
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const pageRows = filteredRows.slice(startIndex, startIndex + limit);

  let nextCursor: string | null = null;
  if (startIndex + limit < filteredRows.length && pageRows.length > 0) {
    const lastRow = pageRows[pageRows.length - 1];
    nextCursor = encodeReviewQueueCursor({
      v: 1,
      sortKey: lastRow.sortKey,
      itemId: lastRow.itemId,
      filterHash: computeReviewQueueFilterHash(filters),
    });
  }

  // 5. Calculate counts
  const counts = {
    total: filteredRows.length,
    reviewedTotal: filteredRows.filter(r => r.reviewState === 'reviewed' || r.reviewState === 'approved').length,
    unreviewedTotal: filteredRows.filter(r => r.reviewState === 'unreviewed' || !r.reviewState).length,
    readyCount: filteredRows.filter(r => r.reviewGateStatus === 'ready').length,
    blockedCount: filteredRows.filter(r => r.reviewGateStatus === 'blocked').length,
    unknownCount: filteredRows.filter(r => r.reviewGateStatus === 'unknown').length,
  };

  const projectionHealth: ProjectionHealth = {
    status: issues.length > 0 ? 'degraded' : 'healthy',
    version: REVIEW_QUEUE_PROJECTION_VERSION,
    computedAt: new Date().toISOString(),
    issues,
  };

  return {
    batchId,
    rows: pageRows,
    nextCursor,
    counts,
    projectionHealth,
  };
}
