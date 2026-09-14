import { z } from 'zod';

export const ReplayConfigurationSchema = z.enum([
  'current_extraction',
  'current_strict_images',
  'structured_only',
  'hybrid_identity_first',
]);
export type ReplayConfiguration = z.infer<typeof ReplayConfigurationSchema>;

export const IdentityVerdictSchema = z.enum([
  'correct_match',
  'wrong_product',
  'wrong_variant',
  'ambiguous',
  'unidentified',
]);
export type IdentityVerdict = z.infer<typeof IdentityVerdictSchema>;

export const AuditFailureCodeSchema = z.enum([
  'NONE',
  'IDENTITY_MISMATCH',
  'WRONG_PRODUCT',
  'WRONG_VARIANT',
  'PARENT_PAGE_VARIANT_CONFUSION',
  'MISSING_AVAILABLE_FIELD',
  'FIELD_CONFLICT',
  'LOW_IMAGE_PRECISION',
  'PRIMARY_IMAGE_MISMATCH',
  'EVIDENCE_GAP_MISSING_ARTIFACT',
  'EVIDENCE_GAP_MISSING_SUPPLEMENTAL',
]);
export type AuditFailureCode = z.infer<typeof AuditFailureCodeSchema>;

export const HybridConflictSchema = z.object({
  field: z.string(),
  selectorValue: z.string().nullable(),
  structuredValue: z.string().nullable(),
  structuredSource: z.string().default('structured'),
  selectorSource: z.string().default('custom-selector'),
  resolution: z.string(),
  severity: z.enum(['critical', 'warning']).optional(),
  disagreementReason: z.string().optional(),
});
export type HybridConflict = z.infer<typeof HybridConflictSchema>;

export const HybridIdentityResolutionSchema = z.object({
  status: z.enum([
    'resolved_variant',
    'single_variant',
    'parent_page',
    'ambiguous_variant',
    'no_variant_match',
    'no_matrix',
  ]),
  parentPageUrl: z.string(),
  totalCandidates: z.number(),
  selectedVariantKey: z.string().nullable(),
  selectedCandidateTitle: z.string().nullable().optional(),
  parentTitle: z.string().nullable().optional(),
  matchedBy: z.string().nullable().optional(),
  confusionDetected: z.boolean(),
  confusionType: z.enum([
    'parent_vs_variant',
    'ambiguous_variant',
    'wrong_variant_selected',
    'unresolved_parent',
  ]).nullable().optional(),
  confusionDetails: z.string().nullable().optional(),
});
export type HybridIdentityResolution = z.infer<typeof HybridIdentityResolutionSchema>;

export const AuditGroundTruthSchema = z.object({
  identity: z.object({
    brand: z.string(),
    productName: z.string(),
    gtin: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    variantName: z.string().nullable().optional(),
  }),
  fields: z.record(
    z.string(),
    z.object({
      available: z.boolean(),
      inapplicable: z.boolean().optional(),
      expectedValue: z.string().nullable().optional(),
      notes: z.string().optional(),
    }),
  ),
  images: z.object({
    primaryImage: z.string().nullable(),
    admissibleImages: z.array(z.string()),
    inadmissibleImages: z.array(z.string()).optional(),
  }),
});
export type AuditGroundTruth = z.infer<typeof AuditGroundTruthSchema>;

export const AuditManifestSampleSchema = z.object({
  sampleId: z.string(),
  url: z.string(),
  domain: z.string(),
  stratum: z.string(),
  inventoryStatus: z.enum(['confirmed', 'candidate']),
  artifactRef: z.string().nullable(),
  supplementalArtifactRefs: z.array(z.string()).default([]),
  hasSupplementalArtifact: z.boolean().default(false),
  captureFreshness: z.string().nullable(),
  groundTruth: AuditGroundTruthSchema,
  // Additive stratification fields (Issue #175)
  pageStructureScope: z.string().optional(),
  platform: z.string().optional(),
  productFamily: z.string().optional(),
  variantShape: z.string().optional(),
  isHoldout: z.boolean().optional(),
  holdoutFamilyName: z.string().nullable().optional(),
  isProfileBlocked: z.boolean().optional(),
  isFailureSample: z.boolean().optional(),
  sampleType: z.enum(['confirmed_profile_sample', 'unreviewed_candidate', 'profile_blocked', 'failure_sample']).optional(),
});
export type AuditManifestSample = z.infer<typeof AuditManifestSampleSchema>;

export const StratumSummarySchema = z.object({
  stratum: z.string(),
  domain: z.string(),
  platform: z.string(),
  pageStructureScope: z.string(),
  variantShape: z.string(),
  sampleCount: z.number(),
  freshnessRange: z.object({
    min: z.string(),
    max: z.string(),
  }),
});
export type StratumSummary = z.infer<typeof StratumSummarySchema>;

export const StratifiedManifestMetadataSchema = z.object({
  claimedStrata: z.array(z.string()).default([]),
  strataSummary: z.record(z.string(), StratumSummarySchema).default({}),
  holdoutFamilies: z.array(z.string()).default([]),
  tuningFamilies: z.array(z.string()).default([]),
  holdoutUntouched: z.boolean().default(true),
  totalConfirmed: z.number().default(0),
  totalCandidates: z.number().default(0),
  totalBlocked: z.number().default(0),
  totalExcludedDistributorRecords: z.number().default(0),
  totalSnapshotsDiscovered: z.number().default(0),
});
export type StratifiedManifestMetadata = z.infer<typeof StratifiedManifestMetadataSchema>;

export const AuditManifestSchema = z.object({
  domain: z.string(),
  generatedAt: z.string(),
  samples: z.array(AuditManifestSampleSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AuditManifest = z.infer<typeof AuditManifestSchema>;

export const MissingFieldReasonSchema = z.enum([
  'absent',
  'inapplicable',
  'conflicted',
  'failed',
]);
export type MissingFieldReason = z.infer<typeof MissingFieldReasonSchema>;

export const MissingFieldExplanationSchema = z.object({
  field: z.string(),
  reason: MissingFieldReasonSchema,
  explanation: z.string(),
  available: z.boolean(),
  inapplicable: z.boolean().optional(),
  notes: z.string().optional(),
  conflictDetails: z.string().nullable().optional(),
});
export type MissingFieldExplanation = z.infer<typeof MissingFieldExplanationSchema>;

export const FieldScoreDetailSchema = z.object({
  field: z.string(),
  available: z.boolean(),
  inapplicable: z.boolean().optional(),
  extractedValue: z.string().nullable(),
  expectedValue: z.string().nullable().optional(),
  provenance: z.string(),
  status: z.enum(['correct', 'incorrect', 'missing', 'unavailable', 'conflict', 'inapplicable']),
  correct: z.boolean(),
  conflictDetails: z.string().nullable().optional(),
  missingReason: MissingFieldReasonSchema.nullable().optional(),
  missingExplanation: z.string().nullable().optional(),
});
export type FieldScoreDetail = z.infer<typeof FieldScoreDetailSchema>;

export const ImageScoreDetailSchema = z.object({
  extractedImages: z.array(z.string()),
  admittedImages: z.array(z.string()),
  rejectedImages: z.array(z.string()),
  primaryImage: z.string().nullable(),
  primaryAccuracy: z.number(), // 1, 0
  precision: z.number(), // 0.0 - 1.0
  recall: z.number(), // 0.0 - 1.0
  rejectionReasons: z.record(z.string(), z.string()).optional(),
});
export type ImageScoreDetail = z.infer<typeof ImageScoreDetailSchema>;

export const AuditScoredRowSchema = z.object({
  sampleId: z.string(),
  url: z.string(),
  domain: z.string(),
  configuration: ReplayConfigurationSchema,
  identityVerdict: IdentityVerdictSchema,
  fieldScores: z.record(z.string(), FieldScoreDetailSchema),
  fieldCorrectnessScore: z.number(),
  imageScores: ImageScoreDetailSchema,
  failureCodes: z.array(AuditFailureCodeSchema),
  isEvidenceGap: z.boolean(),
  evidenceGapReason: z.string().nullable().optional(),
  identityResolution: HybridIdentityResolutionSchema.optional(),
  conflicts: z.array(HybridConflictSchema).optional(),
  imageRejectionReasons: z.record(z.string(), z.string()).optional(),
  extractedProductPreview: z.object({
    title: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    price: z.string().nullable().optional(),
    primaryImage: z.string().nullable().optional(),
    additionalImages: z.array(z.string()).optional(),
    sku: z.string().nullable().optional(),
    gtin: z.string().nullable().optional(),
  }),
});
export type AuditScoredRow = z.infer<typeof AuditScoredRowSchema>;

export const ConfigurationSummarySchema = z.object({
  configuration: ReplayConfigurationSchema,
  totalSamples: z.number(),
  correctIdentityRate: z.number(),
  meanFieldCorrectness: z.number(),
  meanImagePrecision: z.number(),
  meanImageRecall: z.number(),
  primaryImageAccuracy: z.number(),
  evidenceGapCount: z.number(),
  failureCodeCounts: z.record(z.string(), z.number()),
});
export type ConfigurationSummary = z.infer<typeof ConfigurationSummarySchema>;

export const ScopeServedRateSummarySchema = z.object({
  scope: z.string(),
  domain: z.string().optional(),
  platform: z.string().optional(),
  sampleCount: z.number(),
  servedRate: z.number(),
  baselineServedRate: z.number(),
  servedRateDelta: z.number(),
  uncertainty: z.number(),
  confidenceInterval: z.object({
    lower: z.number(),
    upper: z.number(),
  }),
  identityAccuracy: z.number(),
  acceptedIdentityErrors: z.number(),
  meanFieldCorrectness: z.number(),
  baselineMeanFieldCorrectness: z.number(),
  criticalFieldRegressionCount: z.number(),
  meanImagePrecision: z.number(),
  baselineMeanImagePrecision: z.number(),
  meanImageRecall: z.number(),
  primaryImageAccuracy: z.number(),
  evidenceGapCount: z.number(),
  isPromotable: z.boolean(),
  promotabilityVerdict: z.enum(['PROMOTABLE', 'BLOCKED', 'NEEDS_REVIEW']),
  promotabilityReasons: z.array(z.string()),
});
export type ScopeServedRateSummary = z.infer<typeof ScopeServedRateSummarySchema>;

export const ImageContactSheetItemSchema = z.object({
  url: z.string(),
  isPrimary: z.boolean(),
  status: z.enum(['accepted', 'rejected']),
  rejectionReason: z.string().nullable().optional(),
  role: z.string().optional(),
  isExpectedAdmissible: z.boolean().optional(),
  isExpectedPrimary: z.boolean().optional(),
});
export type ImageContactSheetItem = z.infer<typeof ImageContactSheetItemSchema>;

export const ImageContactSheetSchema = z.object({
  sampleId: z.string(),
  url: z.string(),
  domain: z.string(),
  totalDiscovered: z.number(),
  admittedCount: z.number(),
  rejectedCount: z.number(),
  primaryImage: z.string().nullable(),
  primaryAccuracy: z.number(),
  acceptedImages: z.array(ImageContactSheetItemSchema),
  rejectedImages: z.array(ImageContactSheetItemSchema),
});
export type ImageContactSheet = z.infer<typeof ImageContactSheetSchema>;

export const FieldEvidenceCellSchema = z.object({
  configuration: ReplayConfigurationSchema,
  value: z.string().nullable(),
  provenance: z.string(),
  status: z.enum(['correct', 'incorrect', 'missing', 'unavailable', 'conflict', 'inapplicable']),
  isCorrect: z.boolean(),
  missingReason: MissingFieldReasonSchema.nullable().optional(),
  missingExplanation: z.string().nullable().optional(),
  conflictDetails: z.string().nullable().optional(),
});
export type FieldEvidenceCell = z.infer<typeof FieldEvidenceCellSchema>;

export const FieldEvidenceRowSchema = z.object({
  field: z.string(),
  expectedValue: z.string().nullable().optional(),
  available: z.boolean(),
  inapplicable: z.boolean().optional(),
  cells: z.record(ReplayConfigurationSchema, FieldEvidenceCellSchema),
  disagreementDetected: z.boolean(),
  winnerConfiguration: ReplayConfigurationSchema.optional(),
});
export type FieldEvidenceRow = z.infer<typeof FieldEvidenceRowSchema>;

export const SampleFieldEvidenceSchema = z.object({
  sampleId: z.string(),
  url: z.string(),
  domain: z.string(),
  scope: z.string(),
  identityVerdicts: z.record(ReplayConfigurationSchema, IdentityVerdictSchema),
  fields: z.array(FieldEvidenceRowSchema),
  missingFieldExplanations: z.array(z.object({
    configuration: ReplayConfigurationSchema,
    field: z.string(),
    reason: MissingFieldReasonSchema,
    explanation: z.string(),
  })),
});
export type SampleFieldEvidence = z.infer<typeof SampleFieldEvidenceSchema>;

export const OperatorReviewSurfaceReportSchema = z.object({
  domain: z.string(),
  generatedAt: z.string(),
  totalSamples: z.number(),
  totalScopes: z.number(),
  scopeSummaries: z.record(z.string(), ScopeServedRateSummarySchema),
  fieldEvidences: z.array(SampleFieldEvidenceSchema),
  contactSheets: z.array(ImageContactSheetSchema),
  markdown: z.string(),
  html: z.string().optional(),
});
export type OperatorReviewSurfaceReport = z.infer<typeof OperatorReviewSurfaceReportSchema>;

export const PilotAuditResultSchema = z.object({
  domain: z.string(),
  executedAt: z.string(),
  manifest: AuditManifestSchema,
  rows: z.array(AuditScoredRowSchema),
  summaryByConfiguration: z.record(ReplayConfigurationSchema, ConfigurationSummarySchema),
  reviewableTable: z.string(),
  scopeSummaries: z.record(z.string(), ScopeServedRateSummarySchema).optional(),
  operatorReviewReport: z.string().optional(),
  fieldEvidences: z.array(SampleFieldEvidenceSchema).optional(),
  contactSheets: z.array(ImageContactSheetSchema).optional(),
});
export type PilotAuditResult = z.infer<typeof PilotAuditResultSchema>;
