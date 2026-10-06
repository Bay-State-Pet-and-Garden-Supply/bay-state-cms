/**
 * Preparation display helpers. States come from the server projection;
 * these five groups never classify products or authorize progression.
 */
import {
  PREPARATION_SECTION_TITLES,
  PreparationSummarySchema,
  type PreparationSectionKey,
  type PreparationSummary,
} from '../../../shared/schemas/onboarding-preparation';
import type { WorkStateCategory } from '../../../shared/schemas/onboarding-work-state';
import type { CurationData } from '../../../shared/schemas/onboarding';

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
 * Missing/invalid per-product projection: each section is unavailable.
 * Bounded reason; missing gap data remains unknown.
 */
export function buildUnavailablePreparationSummary(): PreparationSummary {
  const reason = 'Preparation facts are unavailable for this product. No completion is inferred.';
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

export const PREPARATION_FILTERS = [
  { category: '', label: 'All products' },
  { category: 'processing', label: 'Preparing' },
  { category: 'waiting_on_family', label: 'Waiting on family' },
  { category: 'needs_attention', label: 'Needs attention' },
] as const;

export type PreparationCategoryFilter = (typeof PREPARATION_FILTERS)[number]['category'];

export function preparationCategoryFilter(value: unknown): PreparationCategoryFilter {
  return PREPARATION_FILTERS.find(filter => filter.category === value)?.category ?? '';
}

export function preparationStatusLabel(category: WorkStateCategory): string {
  const labels: Record<WorkStateCategory, string> = {
    processing: 'Preparing', waiting_on_family: 'Waiting on family', needs_attention: 'Needs attention',
    ready_for_review: 'Ready for review', approved: 'Approved', ready_to_export: 'CMS draft created',
    completed: 'Completed', skipped: 'Skipped',
  };
  return labels[category] ?? 'Status unavailable';
}

/** Missing/corrupt projections must not turn a missing gap into a clear gap. */
export function preparationSummary(value: unknown): PreparationSummary {
  const parsed = PreparationSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : buildUnavailablePreparationSummary();
}

/** The item detail endpoint hydrates its validated effective run, not JSON history. */
export function effectivePreparationFacts(curation: CurationData | null | undefined, sku: string) {
  const runId = curation?.classificationRunId ?? null;
  const proposals = (curation?.classificationProposals ?? [])
    .filter(p => runId !== null && p.runId === runId && p.productSku === sku);
  const evidence = (curation?.classificationEvidence ?? [])
    .filter(e => runId !== null && e.runId === runId && e.productSku === sku);
  const proposalIds = new Set(proposals.map(p => p.id));
  const decisions = (curation?.classificationDecisions ?? [])
    .filter(d => proposalIds.has(d.proposalId) && !d.supersededAt);
  return { runId, proposals, evidence, decisions };
}

export function preparationValue(value: unknown): string {
  if (value === null) return 'Cleared';
  if (value === undefined || value === '') return 'Unavailable';
  if (typeof value === 'string') return value.slice(0, 800);
  try {
    return (JSON.stringify(value) ?? 'Unavailable').slice(0, 800);
  } catch {
    return 'Unavailable';
  }
}
