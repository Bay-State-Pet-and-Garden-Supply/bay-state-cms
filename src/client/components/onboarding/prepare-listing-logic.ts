/**
 * Slice 2 — Prepare-listing presentation logic (pure, DOM-free).
 *
 * Presents EXPLICIT server states, never a second classifier: sections are
 * display groupings over the same stage list. Until the server ships
 * per-section facts, every section reports `unavailable` with an honest
 * reason — no `5/5 done` invention, no percentage treating skipped/abstained
 * as success, no inference from a single activity or missing output.
 */
import {
  PREPARATION_SECTION_TITLES,
  type PreparationSectionKey,
  type PreparationSummary,
} from '../../../shared/schemas/onboarding-preparation';

export interface SectionScopeNote {
  key: PreparationSectionKey;
  title: string;
  /** Where the full-batch operation for this concern lives (explicit destination). */
  operationLink: string;
  scopeNote: string;
}

export const PREPARE_LISTING_SECTIONS: readonly SectionScopeNote[] = [
  {
    key: 'ocr_evidence',
    title: PREPARATION_SECTION_TITLES.ocr_evidence,
    operationLink: 'attention',
    scopeNote:
      'Evidence for the selected stage item. “No image” / disabled / abstained is not an OCR success. Resolution stays in the existing attention inspector.',
  },
  {
    key: 'family_cohort',
    title: PREPARATION_SECTION_TITLES.family_cohort,
    operationLink: 'family',
    scopeNote:
      'Stage-scoped rows; the selected item’s complete actual family may include siblings in other stages (“family context across stages”). Full-batch family view stays unchanged.',
  },
  {
    key: 'names',
    title: PREPARATION_SECTION_TITLES.names,
    operationLink: 'review',
    scopeNote:
      'The item’s canonical output with the original name kept separate. An available name is not human-reviewed or approved.',
  },
  {
    key: 'product_type',
    title: PREPARATION_SECTION_TITLES.product_type,
    operationLink: 'review',
    scopeNote:
      'Pending/proposed vs accepted/revised/rejected. A frozen execution type is not a reviewed assignment.',
  },
  {
    key: 'field_classification',
    title: PREPARATION_SECTION_TITLES.field_classification,
    operationLink: 'review',
    scopeNote:
      'Includes the distinct Page placement / draft-readiness sub-row when canonical facts exist. Never label the section approved because stage_status is completed.',
  },
];

/**
 * Build the honest placeholder summary: every section `unavailable` until
 * the server reports validated facts. Bounded reason, no fabrication.
 */
export function buildUnavailablePreparationSummary(): PreparationSummary {
  const reason = 'Server section facts not yet reported for this item. No completion is inferred.';
  return {
    schemaVersion: 1,
    sections: [
      { key: 'ocr_evidence', title: PREPARATION_SECTION_TITLES.ocr_evidence, state: 'unavailable', reason },
      { key: 'family_cohort', title: PREPARATION_SECTION_TITLES.family_cohort, state: 'unavailable', reason, crossStageContext: false },
      { key: 'names', title: PREPARATION_SECTION_TITLES.names, state: 'unavailable', reason },
      { key: 'product_type', title: PREPARATION_SECTION_TITLES.product_type, state: 'unavailable', reason },
      { key: 'field_classification', title: PREPARATION_SECTION_TITLES.field_classification, state: 'unavailable', reason },
    ],
  };
}

/** True when no section claims completion — the honest Slice 2 invariant. */
export function isPreparationSummaryEmpty(summary: PreparationSummary): boolean {
  return summary.sections.every((s) => s.state === 'unavailable' || s.state === 'not_recorded' || s.state === 'not_started_or_unknown');
}
