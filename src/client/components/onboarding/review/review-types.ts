/**
 * Epic #46 — Review workspace shared types (Phase 6).
 */
import type { OnboardingWorkState } from '../../../../shared/schemas/onboarding-work-state';
import type { ReviewQueueRow } from '../../../../shared/schemas/onboarding-review-queue';
import type { ItemDetailResponse } from '../../../onboarding-api';

/** An inspector-loaded item: server projection + enriched detail. */
export interface ReviewInspectorItem {
  workState: ReviewQueueRow | OnboardingWorkState;
  /** Enriched detail from GET /onboarding/items/:id (null while loading). */
  detail: ItemDetailResponse | null;
  /** Detail load failure (never silently swallowed). */
  detailError: string | null;
}

/**
 * Editable listing fields surfaced for inline editing during review.
 *
 * e10s02: extended with price/quantity behind the V2 flag. The V1 call
 * sites construct the five original keys; V2 seeds and saves all seven.
 */
export interface ReviewDraft {
  curatedTitle: string;
  brandHint: string;
  curatedWeight: string;
  curatedDescription: string;
  searchKeywords: string;
  /** V2 only — official-page items; integer-as-string (distributor rows readonly). */
  quantity?: string;
}
