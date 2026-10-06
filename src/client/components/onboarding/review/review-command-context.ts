import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';
import { toCanonicalStage } from '../../../../shared/onboarding-stage-vocabulary';

/** Queue authority, further restricted by newer selected-product facts. */
export function reviewCommands(row: ReviewQueueRow | null, detail?: ItemDetailResponse | null) {
  const unavailable = { canEdit: false, canCompleteReview: false, canApprove: false };
  if (!row?.actions || row.stage !== 'review_listings' || row.stageStatus === 'skipped' || row.reviewState === 'approved') return unavailable;
  if (detail?.item) {
    const item = detail.item;
    try {
      if (toCanonicalStage(item.stage) !== 'review_listings' || item.stageStatus === 'skipped' || item.isHeld) return unavailable;
    } catch {
      return unavailable;
    }
    if (row.reviewState === 'reviewed' && item.stageStatus !== 'completed') return unavailable;
  }
  return {
    canEdit: row.actions.canEdit,
    canCompleteReview: row.actions.canCompleteReview && row.reviewState === 'unreviewed',
    canApprove: row.actions.canApprove && row.reviewState === 'reviewed' && row.stageStatus === 'completed',
  };
}
