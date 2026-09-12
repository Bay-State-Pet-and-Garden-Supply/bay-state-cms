/**
 * Slice 4-SERVER — v2-only preparation-section server derivation
 * (reviewer-assigned P1; council plan Slice 4).
 *
 * Derives the five fixed Prepare-listing sections from ALREADY-LOADED chunk
 * facts (bulk classification stage rows, cohort context, item curation /
 * extraction payloads). Pure: zero new SQL statements — the caller reuses
 * the v2 stage-read chunk context and only maps matched items.
 *
 * Display groupings, never stages/queues/gates. Every state is an explicit
 * server fact; `unavailable`/`not_started_or_unknown` is reported instead of
 * inferring completion. Reasons use fixed templates (bounded 160 chars) —
 * never raw errors, evidence, URLs, or model text.
 */
import {
  PREPARATION_SECTION_TITLES,
  type PreparationSectionKey,
  type PreparationSummary,
} from '../shared/schemas/onboarding-preparation';
import type { BulkStageRow } from '../db/repositories/onboarding-work-state-repo';
import type { FamilyCohortState } from './onboarding-work-state';

/** Minimal per-item facts — all sourced from the already-loaded chunk. */
export interface PreparationItemFacts {
  itemId: string;
  /** Bulk-loaded classification stage rows for the item's effective run (null = no run). */
  stageRows: BulkStageRow[] | null;
  /** Chunk cohort membership (null = no family). */
  cohort: FamilyCohortState | null;
  /** Bulk cohort run status for the item (freezing/running/…/null). */
  cohortRunStatus: string | null;
  /** Canonical output facts from the already-projected work state. */
  curatedTitle: string | null;
  imageUrl: string | null;
  /** True when curation data records a blocking semantic validation. */
  semanticBlocked: boolean;
  /**
   * Ticket #124: open gap fact for the sidecar (null = confirmed no open
   * gap; undefined = gap state not loaded — rendered as unknown, never
   * as clear). Presentation never invents gap state.
   */
  gap?: {
    missingFields: string[];
    reason: string;
    evidenceHash: string | null;
    updatedAt: string;
    correctionRevision: number;
    correctionStatus: 'none' | 'recorded' | 'preparing' | 'failed' | 'applied' | 'superseded';
  } | null;
}

function reason(value: string): string {
  // All reasons are fixed templates well under 160 chars; slice defensively.
  return value.length <= 160 ? value : value.slice(0, 160);
}

function rowFor(stageRows: BulkStageRow[] | null, stageName: string): BulkStageRow | null {
  if (!stageRows) return null;
  return stageRows.find(r => r.stage_name === stageName) ?? null;
}

function stateForStageRow(row: BulkStageRow | null): 'running' | 'failed' | 'abstained' | 'succeeded' | null {
  if (!row) return null;
  switch (row.status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'abstained':
      return 'abstained';
    case 'succeeded':
      return 'succeeded';
    default:
      return null;
  }
}

function deriveOcrSection(facts: PreparationItemFacts): PreparationSummary['sections'][number] {
  const key: PreparationSectionKey = 'ocr_evidence';
  const title = PREPARATION_SECTION_TITLES[key];
  const rowState = stateForStageRow(rowFor(facts.stageRows, 'packaging_ocr'));
  if (rowState === 'running') {
    return { key, title, state: 'running', reason: reason('Packaging OCR is running on the product image.') };
  }
  if (rowState === 'failed') {
    return { key, title, state: 'failed', reason: reason('Packaging OCR did not complete. It can be retried.') };
  }
  if (rowState === 'abstained') {
    return { key, title, state: 'unavailable', reason: reason('Packaging OCR abstained. Abstention is not OCR evidence.') };
  }
  if (rowState === 'succeeded') {
    return { key, title, state: 'available', reason: reason('Packaging OCR evidence was recorded from the product image.') };
  }
  // No OCR stage fact: image presence decides no_image vs not started.
  if (!facts.imageUrl) {
    return { key, title, state: 'no_image', reason: reason('No product image is available for packaging OCR.') };
  }
  return { key, title, state: 'not_started_or_unknown', reason: reason('Packaging OCR has not run for this item.') };
}

function deriveFamilySection(facts: PreparationItemFacts): PreparationSummary['sections'][number] {
  const key: PreparationSectionKey = 'family_cohort';
  const title = PREPARATION_SECTION_TITLES[key];
  const cohort = facts.cohort;
  if (!cohort) {
    return { key, title, state: 'not_started_or_unknown', reason: reason('This item is not in a family group.'), crossStageContext: false };
  }
  // Bounded + length-capped: waiting IDs are server-generated, but the schema
  // guarantees max(128) regardless of upstream content.
  const waitingOn = facts.cohort
    ? [...new Set(facts.cohort.waitingOnItemIds)]
        .map(id => (typeof id === 'string' ? id.slice(0, 128) : ''))
        .filter(id => id.length > 0)
        .slice(0, 25)
    : [];
  const base = {
    key,
    title,
    count: cohort.memberCount,
    ...(waitingOn.length > 0 ? { relatedIds: waitingOn, crossStageContext: true as const } : { crossStageContext: false as const }),
  };
  const runStatus = (facts.cohortRunStatus ?? '').toLowerCase();
  if (runStatus === 'freezing' || runStatus === 'running') {
    return { ...base, state: 'freezing_or_running', reason: reason('The family group is being prepared for execution.') };
  }
  if (cohort.cohortStatus === 'superseded' || runStatus === 'superseded' || runStatus === 'cancelled') {
    return { ...base, state: 'superseded_or_unknown', reason: reason('The family run was superseded. Current state is unknown.') };
  }
  if (cohort.cohortState === 'blocked') {
    // blockedReason may interpolate operator-supplied product names: never
    // rendered. The count is server-computed and safe.
    const n = Math.max(1, cohort.blockedCount);
    return {
      ...base,
      state: 'blocked',
      reason: reason(`Family group is blocked by ${n} member${n === 1 ? '' : 's'}. Details live in the family view.`),
    };
  }
  if (cohort.cohortState === 'waiting') {
    return { ...base, state: 'forming_or_waiting', reason: reason('The family group is forming or waiting on members.') };
  }
  return { ...base, state: 'ready', reason: reason('The family group is ready.') };
}

function deriveNamesSection(facts: PreparationItemFacts): PreparationSummary['sections'][number] {
  const key: PreparationSectionKey = 'names';
  const title = PREPARATION_SECTION_TITLES[key];
  if (facts.semanticBlocked) {
    return { key, title, state: 'conflicted', reason: reason('Name curation is blocked by a validation finding.') };
  }
  const rowState = stateForStageRow(rowFor(facts.stageRows, 'name_consolidation'));
  if (rowState === 'running') {
    return { key, title, state: 'running', reason: reason('Name curation is running.') };
  }
  if (rowState === 'failed') {
    return { key, title, state: 'failed', reason: reason('Name curation did not complete. It can be retried.') };
  }
  if (rowState === 'abstained') {
    return { key, title, state: 'abstained', reason: reason('Name curation abstained. No name was proposed.') };
  }
  if (rowState === 'succeeded' && facts.curatedTitle && facts.curatedTitle.trim().length > 0) {
    return { key, title, state: 'proposed', reason: reason('A curated name was proposed. It is not reviewed or approved.') };
  }
  if (rowState === 'succeeded') {
    return { key, title, state: 'not_started_or_unknown', reason: reason('Name curation finished without a recorded name.') };
  }
  if (facts.curatedTitle && facts.curatedTitle.trim().length > 0) {
    return { key, title, state: 'proposed', reason: reason('A curated name was proposed. It is not reviewed or approved.') };
  }
  return { key, title, state: 'not_started_or_unknown', reason: reason('Name curation has not started for this item.') };
}

function deriveProductTypeSection(facts: PreparationItemFacts): PreparationSummary['sections'][number] {
  const key: PreparationSectionKey = 'product_type';
  const title = PREPARATION_SECTION_TITLES[key];
  if (facts.semanticBlocked) {
    return { key, title, state: 'conflicted', reason: reason('Product type assignment is blocked by a validation finding.') };
  }
  const rowState = stateForStageRow(rowFor(facts.stageRows, 'primary_product_type_proposal'));
  if (rowState === 'running') {
    return { key, title, state: 'running', reason: reason('Product type assignment is running.') };
  }
  if (rowState === 'failed') {
    return { key, title, state: 'failed', reason: reason('Product type assignment did not complete. It can be retried.') };
  }
  if (rowState === 'abstained') {
    return { key, title, state: 'abstained', reason: reason('Product type assignment abstained. No type was proposed.') };
  }
  if (rowState === 'succeeded') {
    return { key, title, state: 'proposed', reason: reason('A product type was proposed. It is not a reviewed assignment.') };
  }
  return { key, title, state: 'not_started_or_unknown', reason: reason('Product type assignment has not started for this item.') };
}

const ATTRIBUTE_STAGE_NAMES = ['attribute_applicability', 'product_attribute_proposals', 'category_page_proposals'] as const;

function deriveFieldClassificationSection(facts: PreparationItemFacts): PreparationSummary['sections'][number] {
  const key: PreparationSectionKey = 'field_classification';
  const title = PREPARATION_SECTION_TITLES[key];
  if (facts.semanticBlocked) {
    return { key, title, state: 'conflicted', reason: reason('Field classification is blocked by a validation finding.') };
  }
  const states = ATTRIBUTE_STAGE_NAMES.map(name => stateForStageRow(rowFor(facts.stageRows, name)));
  const present = states.filter((s): s is NonNullable<typeof s> => s !== null);
  if (present.length === 0) {
    return { key, title, state: 'not_started_or_unknown', reason: reason('Field classification has not started for this item.') };
  }
  if (present.includes('running')) {
    return { key, title, state: 'running', reason: reason('Field classification is running.') };
  }
  if (present.includes('failed')) {
    return { key, title, state: 'failed', reason: reason('Field classification did not complete. It can be retried.') };
  }
  if (present.includes('abstained')) {
    return { key, title, state: 'abstained', reason: reason('Field classification abstained for at least one concern.') };
  }
  if (present.every(s => s === 'succeeded')) {
    return { key, title, state: 'pending_or_proposed', reason: reason('Field proposals exist and are pending review. None are approved.') };
  }
  return { key, title, state: 'pending_or_proposed', reason: reason('Field classification is partially recorded and pending review.') };
}

/** Derive the five-section summary from already-loaded chunk facts (pure, no I/O). */
export function derivePreparationSummary(facts: PreparationItemFacts): PreparationSummary {
  return {
    schemaVersion: 1,
    sections: [
      deriveOcrSection(facts),
      deriveFamilySection(facts),
      deriveNamesSection(facts),
      deriveProductTypeSection(facts),
      deriveFieldClassificationSection(facts),
    ],
    // Ticket #124 sidecar: project the persisted open gap (or confirmed
    // absence) without touching the five display sections.
    gap: facts.gap === undefined
      ? undefined
      : facts.gap === null
        ? null
        : {
          missingFields: facts.gap.missingFields.slice(0, 25),
          reason: facts.gap.reason.slice(0, 160),
          evidenceHash: facts.gap.evidenceHash,
          updatedAt: facts.gap.updatedAt,
          correctionRevision: facts.gap.correctionRevision,
          correctionStatus: facts.gap.correctionStatus,
        },
  };
}

export type PreparationFactsInput = Omit<PreparationItemFacts, 'itemId'>;

/**
 * Derive summaries for a batch of items sharing one loaded chunk context.
 * Pure mapping — the caller supplies facts from its existing projection.
 */
export function derivePreparationForItems(
  entries: Array<{ itemId: string; facts: PreparationFactsInput }>,
): Map<string, PreparationSummary> {
  const out = new Map<string, PreparationSummary>();
  for (const entry of entries) {
    out.set(entry.itemId, derivePreparationSummary({ itemId: entry.itemId, ...entry.facts }));
  }
  return out;
}
