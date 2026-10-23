/**
 * Review editability matrix + save-payload builder (story e10s02, epic
 * #review-final-gate).
 *
 * Pure derivation implementing the plan §3 matrix: which curated fields a
 * reviewer may edit per source type, and exactly what the PUT payload may
 * carry. Distributor-record rows are constrained by server guards
 * (onboarding-routes PUT): extraction_data/source_url/quantity are rejected
 * 400 — so the client NEVER sends a quantity key for distributor items and
 * renders the field read-only with an explanatory note instead of offering
 * a dead input.
 *
 * Price is immutable onboarding input. Reviewers cannot edit it or send it
 * as part of a listing update. Quantity remains editable only for
 * official-page items.
 */
import type { SourceType } from '../../../../shared/schemas/onboarding';
import type { ReviewDraft } from './review-types';

/** Editability of one review form field for one source type. */
export type ReviewFieldEditability =
  /** Normal editable input. */
  | 'editable'
  /** Display-only (no editor rendered in edit mode). */
  | 'readonly'
  /** Rendered disabled WITH a visible explanatory note — never silently dead. */
  | 'locked-with-note';

export type ReviewEditableFieldKey =
  | 'curatedTitle'
  | 'brandHint'
  | 'curatedWeight'
  | 'curatedDescription'
  | 'searchKeywords'
  | 'quantity';

/**
 * Quantity is editable for official-page items and read-only when inventory
 * is managed by a distributor record.
 */
export function fieldEditability(
  sourceType: SourceType | null | undefined,
  field: ReviewEditableFieldKey,
): ReviewFieldEditability {
  const distributor = sourceType === 'distributor_record';
  if (field === 'quantity') return distributor ? 'readonly' : 'editable';
  return 'editable';
}

/** Visible note under a read-only distributor quantity display. */
export const QUANTITY_READONLY_NOTE = 'Distributor records manage inventory upstream.';

/** Read-only "Listing facts" group (plan §3 row 15), rendered collapsible. */
export interface ListingFactField {
  key: string;
  label: string;
}

export const LISTING_FACTS_FIELDS: ListingFactField[] = [
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'manufacturerPartNumber', label: 'MPN' },
  { key: 'casePack', label: 'Case pack' },
  { key: 'unitOfMeasure', label: 'Unit of measure' },
  { key: 'ingredients', label: 'Ingredients' },
  { key: 'distributorCategory', label: 'Distributor category' },
];

/**
 * Read-only "Listing facts" rendering iterates ONLY LISTING_FACTS_FIELDS
 * above, so unknown `.passthrough()` extraction keys are ignored entirely —
 * never auto-rendered, never invented into editors or misleading displays.
 */
export function listingFactValues(extraction: Record<string, unknown> | null | undefined): Array<{
  key: string;
  label: string;
  value: string;
}> {
  if (!extraction) return [];
  const rows: Array<{ key: string; label: string; value: string }> = [];
  for (const field of LISTING_FACTS_FIELDS) {
    const raw = extraction[field.key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      rows.push({ key: field.key, label: field.label, value: raw.trim() });
    }
  }
  return rows;
}

// ─── Save payload builder ─────────────────────────────────────────────────────────

export interface ReviewListingUpdatePayload {
  curation_data: Record<string, unknown>;
  brandHint: string | null;
  /** Present ONLY for official_page sources; integer or null. */
  quantity?: number | null;
}

const trimOrNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Build the PUT /items/:id body fragment for the review listing form.
 *
 * - The four curated keys are always sent (trimmed-or-null), matching the
 *   existing payload shape plus brandHint.
 * - Immutable price input is never included.
 * - `quantity` is included only when editable; distributor payloads omit it.
 */
export function buildListingUpdatePayload(
  draft: ReviewDraft,
  sourceType: SourceType | null | undefined,
): ReviewListingUpdatePayload {
  const payload: ReviewListingUpdatePayload = {
    curation_data: {
      curatedTitle: trimOrNull(draft.curatedTitle),
      curatedWeight: trimOrNull(draft.curatedWeight),
      curatedDescription: trimOrNull(draft.curatedDescription),
      searchKeywords: trimOrNull(draft.searchKeywords),
    },
    brandHint: trimOrNull(draft.brandHint),
  };

  if (fieldEditability(sourceType, 'quantity') === 'editable') {
    const parsed = parseInt((draft.quantity ?? '').trim(), 10);
    payload.quantity = Number.isNaN(parsed) ? null : parsed;
  }
  return payload;
}
