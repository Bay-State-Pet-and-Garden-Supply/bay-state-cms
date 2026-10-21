// fallow-ignore-file unused-export

/**
 * Epic #46 — onboarding observability schema.
 *
 * Every metric is DERIVED from existing durable state at query time. Each
 * metric carries an honesty marker so consumers can tell exact derivations
 * from documented approximations and from genuinely unavailable values.
 */
import { z } from 'zod';

/** How trustworthy a metric value is. */
export const MetricDerivationEnum = z.enum(['exact', 'approximation', 'not_available']);

export type MetricDerivation = z.infer<typeof MetricDerivationEnum>;

/** P1-A discovery proof classes. */
export const DiscoveryProofClassEnum = z.enum([
  'exact_structured_gtin',
  'exact_variant_gtin',
  'none',
]);
export type DiscoveryProofClass = z.infer<typeof DiscoveryProofClassEnum>;

/** P1-A discovery outcome and rejection reasons (bounded set). */
export const DiscoveryOutcomeReasonEnum = z.enum([
  'auto_selected_structured_gtin',
  'auto_selected_variant_gtin',
  'denied_authority_gate',
  'denied_invalid_checksum',
  'denied_contradictory_gtins',
  'denied_no_structured_gtin',
  'denied_gtin_mismatch',
  'denied_ambiguous_variant',
  'denied_listing_or_blog_page',
  'denied_kill_switch',
]);
export type DiscoveryOutcomeReason = z.infer<typeof DiscoveryOutcomeReasonEnum>;

export const MetricBreakdownEntrySchema = z.object({
  key: z.string(),
  value: z.number(),
  /** Share of the parent population (0..1); null when not meaningful. */
  share: z.number().nullable().default(null),
});

export type MetricBreakdownEntry = z.infer<typeof MetricBreakdownEntrySchema>;

export const TelemetryMetricSchema = z.object({
  value: z.number().nullable(),
  unit: z.string().nullable().default(null),
  derivation: MetricDerivationEnum,
  note: z.string().nullable().default(null),
  /** Optional breakdown (e.g. attention volume by reason). */
  breakdown: z.array(MetricBreakdownEntrySchema).default(() => []),
});

export type TelemetryMetric = z.infer<typeof TelemetryMetricSchema>;

export const METRIC_KEYS = [
  // Epic #46 batch-analysis follow-up (GPT review): renamed to say what they
  // actually measure — "automationCompletionRate" implied approved/exported
  // products; it is the automation-to-review delivery rate.
  'automationToReviewRate',
  'attentionVolume',
  'attentionRateByReason',
  'attentionResolutionTime',
  'distributorRecordShareOfReviewReady',
  'productsRequiringOfficialSite',
  'extractorProfileBlockRate',
  'extractorProfileDomainUnblockCount',
  'cohortCurationSuccessRate',
  'productsReadyForReview',
  'reviewThroughputProductsPerMinute',
  'reviewEditRate',
  'approvalRate',
  'exportSuccessRate',
  // M6 (P2) — strict proof-class / needs-input delta, queue/detail, work-state health, receipts, import provenance
  'strictProofClassSelectionRate',
  'needsInputDelta',
  'reviewQueueRowRequests',
  'reviewDetailRequests',
  'reviewQueuePayloadSize',
  'reviewQueueLoadLatencyMs',
  'workStateP95Ms',
  'workStateP99Ms',
  'workStateStatements',
  'workStateScannedRows',
  'projectionDegradationCount',
  'approvalAttempts',
  'approvalSuccessCount',
  'approvalRejectCount',
  'approvalReplays',
  'approvalConflicts',
  'approvalInterruptedReceipts',
  'exportDraftAttempts',
  'exportSuccessCount',
  'exportRejectCount',
  'exportConflictCount',
  'exportInterruptedCount',
  'exportDraftReplays',
  'exportInterruptedReceipts',
  'importNormalizationCounts',
  'lossyLegacyRows',
] as const;

export type OnboardingMetricKey = (typeof METRIC_KEYS)[number];

export const OnboardingTelemetrySchema = z.object({
  scope: z.enum(['batch', 'global']),
  batchId: z.string().nullable().default(null),
  generatedAt: z.string(),
  metrics: z.object({
    automationToReviewRate: TelemetryMetricSchema,
    attentionVolume: TelemetryMetricSchema,
    attentionRateByReason: TelemetryMetricSchema,
    attentionResolutionTime: TelemetryMetricSchema,
    distributorRecordShareOfReviewReady: TelemetryMetricSchema,
    productsRequiringOfficialSite: TelemetryMetricSchema,
    extractorProfileBlockRate: TelemetryMetricSchema,
    extractorProfileDomainUnblockCount: TelemetryMetricSchema,
    cohortCurationSuccessRate: TelemetryMetricSchema,
    productsReadyForReview: TelemetryMetricSchema,
    reviewThroughputProductsPerMinute: TelemetryMetricSchema,
    reviewEditRate: TelemetryMetricSchema,
    approvalRate: TelemetryMetricSchema,
    exportSuccessRate: TelemetryMetricSchema,
    strictProofClassSelectionRate: TelemetryMetricSchema,
    needsInputDelta: TelemetryMetricSchema,
    reviewQueueRowRequests: TelemetryMetricSchema,
    reviewDetailRequests: TelemetryMetricSchema,
    reviewQueuePayloadSize: TelemetryMetricSchema,
    reviewQueueLoadLatencyMs: TelemetryMetricSchema,
    workStateP95Ms: TelemetryMetricSchema,
    workStateP99Ms: TelemetryMetricSchema,
    workStateStatements: TelemetryMetricSchema,
    workStateScannedRows: TelemetryMetricSchema,
    projectionDegradationCount: TelemetryMetricSchema,
    approvalAttempts: TelemetryMetricSchema,
    approvalSuccessCount: TelemetryMetricSchema,
    approvalRejectCount: TelemetryMetricSchema,
    approvalReplays: TelemetryMetricSchema,
    approvalConflicts: TelemetryMetricSchema,
    approvalInterruptedReceipts: TelemetryMetricSchema,
    exportDraftAttempts: TelemetryMetricSchema,
    exportSuccessCount: TelemetryMetricSchema,
    exportRejectCount: TelemetryMetricSchema,
    exportConflictCount: TelemetryMetricSchema,
    exportInterruptedCount: TelemetryMetricSchema,
    exportDraftReplays: TelemetryMetricSchema,
    exportInterruptedReceipts: TelemetryMetricSchema,
    importNormalizationCounts: TelemetryMetricSchema,
    lossyLegacyRows: TelemetryMetricSchema,
  }),
});

export type OnboardingTelemetry = z.infer<typeof OnboardingTelemetrySchema>;