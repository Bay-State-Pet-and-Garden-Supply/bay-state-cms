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
  'MISSING_AVAILABLE_FIELD',
  'FIELD_CONFLICT',
  'LOW_IMAGE_PRECISION',
  'PRIMARY_IMAGE_MISMATCH',
  'EVIDENCE_GAP_MISSING_ARTIFACT',
  'EVIDENCE_GAP_MISSING_SUPPLEMENTAL',
]);
export type AuditFailureCode = z.infer<typeof AuditFailureCodeSchema>;

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

export const FieldScoreDetailSchema = z.object({
  field: z.string(),
  available: z.boolean(),
  extractedValue: z.string().nullable(),
  expectedValue: z.string().nullable().optional(),
  provenance: z.string(),
  status: z.enum(['correct', 'incorrect', 'missing', 'unavailable', 'conflict']),
  correct: z.boolean(),
  conflictDetails: z.string().nullable().optional(),
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

export const PilotAuditResultSchema = z.object({
  domain: z.string(),
  executedAt: z.string(),
  manifest: AuditManifestSchema,
  rows: z.array(AuditScoredRowSchema),
  summaryByConfiguration: z.record(ReplayConfigurationSchema, ConfigurationSummarySchema),
  reviewableTable: z.string(),
});
export type PilotAuditResult = z.infer<typeof PilotAuditResultSchema>;
