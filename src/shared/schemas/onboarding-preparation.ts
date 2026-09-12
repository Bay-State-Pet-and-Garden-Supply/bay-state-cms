/**
 * Slice 2 — read-only five-section Prepare-listing summary (council plan
 * Slice 2 granularity table).
 *
 * Display contract ONLY, distinct from PipelineStage/StageStatus and from
 * WorkActivity. Five fixed section keys over the SAME stage list — sections
 * are display groupings, never stages, queues, or mutation gates. All states
 * are finite codes with bounded reason labels; unavailable/stale is explicit
 * and never fabricated from a single activity or missing output.
 */
import * as z from 'zod';

export const PREPARATION_SECTION_KEYS = [
  'ocr_evidence',
  'family_cohort',
  'names',
  'product_type',
  'field_classification',
] as const;

export type PreparationSectionKey = (typeof PREPARATION_SECTION_KEYS)[number];

export const PreparationSectionStateEnum = z.enum([
  'not_recorded',
  'queued_or_running',
  'available',
  'no_image',
  'disabled',
  'skipped',
  'failed',
  'stale',
  'forming_or_waiting',
  'blocked',
  'ready',
  'freezing_or_running',
  'superseded_or_unknown',
  'not_started_or_unknown',
  'running',
  'proposed',
  'abstained',
  'conflicted',
  'accepted_or_revised',
  'rejected',
  'pending_or_proposed',
  'partly_decided',
  'decided',
  'unavailable',
]);

export type PreparationSectionState = z.infer<typeof PreparationSectionStateEnum>;

export const PreparationSectionSchema = z
  .object({
    key: z.enum(PREPARATION_SECTION_KEYS),
    title: z.string().min(1).max(80),
    /** Finite canonical state. `unavailable` when the server has not reported facts. */
    state: PreparationSectionStateEnum,
    /** At most one bounded human-readable reason (display characters). */
    reason: z.string().max(160).optional(),
    /** Optional bounded counts/IDs for context (never raw evidence arrays). */
    count: z.number().int().nonnegative().optional(),
    relatedIds: z.array(z.string().max(128)).max(25).optional(),
    /** When true the context shown spans stages (family siblings elsewhere). */
    crossStageContext: z.boolean().optional(),
  })
  .strict();

export type PreparationSection = z.infer<typeof PreparationSectionSchema>;

export const PreparationSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    sections: z.tuple([
      PreparationSectionSchema,
      PreparationSectionSchema,
      PreparationSectionSchema,
      PreparationSectionSchema,
      PreparationSectionSchema,
    ]),
    /**
     * Ticket #124: durable Listing Evidence Gap sidecar. The five sections
     * stay exactly as specified (never a sixth section, never a second
     * gate) — gap facts ride alongside, projected from the same persisted
     * store the attention surface reads. Null = confirmed no open gap;
     * absent = gap state not loaded (unknown, never presented as clear).
     */
    gap: z.object({
      missingFields: z.array(z.string().min(1).max(64)).max(25),
      reason: z.string().min(1).max(160),
      evidenceHash: z.string().nullable(),
      updatedAt: z.string().min(1),
      correctionRevision: z.number().int().min(0),
      correctionStatus: z.enum(['none', 'recorded', 'preparing', 'failed', 'applied', 'superseded']),
    }).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => {
      const keys = v.sections.map((s) => s.key);
      return (
        keys.length === 5 &&
        keys[0] === 'ocr_evidence' &&
        keys[1] === 'family_cohort' &&
        keys[2] === 'names' &&
        keys[3] === 'product_type' &&
        keys[4] === 'field_classification'
      );
    },
    { message: 'preparation summary must contain exactly the five fixed sections in order' },
  );

export type PreparationSummary = z.infer<typeof PreparationSummarySchema>;

export const PREPARATION_SECTION_TITLES: Readonly<Record<PreparationSectionKey, string>> = {
  ocr_evidence: 'Packaging OCR evidence',
  family_cohort: 'Family/cohort grouping & readiness',
  names: 'Name curation',
  product_type: 'Product type assignment',
  field_classification: 'Field classification',
};
