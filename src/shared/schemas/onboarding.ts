// fallow-ignore-file unused-export

import { z } from 'zod';
import { convertToLbs } from '../weight-converter';
import {
  ClassificationConfigSnapshotRefSchema,
  ClassificationEvidenceSchema,
  ClassificationProposalSchema,
  ClassificationProposalDecisionSchema,
  ClassificationHistoryEventSchema,
} from './classification';
import { VariantSelectionReceiptSchema } from './variant-resolution';

// ─── Column Mapping ────────────────────────────────────────────────────────────

export const ColumnMappingSchema = z.object({
  upc: z.string().min(1, 'UPC column is required'),
  name: z.string().min(1, 'Name column is required'),
  /** Secondary column to concatenate with `name` (e.g. DESCRIPTION2 when name is DESCRIPTION1). */
  nameMergeWith: z.string().nullable().default(null),
  price: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  department: z.string().nullable().default(null),
  sourceUrl: z.string().nullable().default(null),
});

export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

// ─── Spreadsheet Row (post-mapping, pre-insert) ────────────────────────────────

export const SpreadsheetRowSchema = z.object({
  upc: z.string().min(1, 'UPC is required'),
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  quantity: z.number().int().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  departmentHint: z.string().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  rowNumber: z.number().int(),
  // Milestone 5 — lossless imported identity (bounded, fail-closed, cross-field)
  rawIdentityJson: z.string().max(10000).nullable().optional(),
  normalizedIdentityJson: z.string().max(10000).nullable().optional(),
  identityNormalizerVersion: z.number().int().min(0).max(10).nullable().optional(),
  identityProvenanceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  identityLossy: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Shared tuple validator (M5 round 3) — fail-closed via dynamic require to avoid cycle
  const { validateIdentityTuple } = require('../../onboarding/imported-identity');
  const res = validateIdentityTuple({
    rawJson: (data as any).rawIdentityJson ?? null,
    normalizedJson: (data as any).normalizedIdentityJson ?? null,
    version: (data as any).identityNormalizerVersion ?? null,
    provenanceHash: (data as any).identityProvenanceHash ?? null,
    lossy: (data as any).identityLossy,
  });
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.reason || 'identity tuple invalid', path: ['identityNormalizerVersion'] });
  }
  // Also enforce individual envelope canonical + schema validation when present
  const checkCanonical = (json: string | null, path: string, isRaw: boolean) => {
    if (json === null) return;
    try {
      const parsed = JSON.parse(json);
      const { canonicalJsonStringify } = require('../stable-id');
      if (canonicalJsonStringify(parsed) !== json) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not canonical JSON', path: [path] });
        return;
      }
      const { RawIdentityEnvelopeV1Schema, NormalizedIdentityEnvelopeV1Schema } = require('../../onboarding/imported-identity');
      const schema = isRaw ? RawIdentityEnvelopeV1Schema : NormalizedIdentityEnvelopeV1Schema;
      const r = schema.safeParse(parsed);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'envelope schema invalid', path: [path] });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid JSON', path: [path] });
    }
  };
  checkCanonical((data as any).rawIdentityJson ?? null, 'rawIdentityJson', true);
  checkCanonical((data as any).normalizedIdentityJson ?? null, 'normalizedIdentityJson', false);
});

export type SpreadsheetRow = z.infer<typeof SpreadsheetRowSchema>;

// ─── Packaging OCR Data (VLM-sourced) ───────────────────────────────────────────

/**
 * Structured attributes extracted from the product's primary packaging image
 * via local VLM OCR. Populated once before classification, then consumed by
 * both the curator (title synthesis) and the classification pipeline (evidence).
 */
export const PackagingOcrDataSchema = z.object({
  // Core identity
  productName: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  species: z.array(z.string()).default(() => []),
  /** Round-5: UPC/GTIN barcode digits printed on the package (8-14 digits).
   *  Optional — null when no barcode is visible/legible. */
  upc: z.string().nullable().default(null),

  // Physical / sensory attributes
  flavorVariety: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  material: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  count: z.string().nullable().default(null),

  // Pet-specific classification targets
  lifeStage: z.string().nullable().default(null),
  breedSize: z.string().nullable().default(null),
  productForm: z.string().nullable().default(null),
  healthConcernFunction: z.array(z.string()).default(() => []),

  // Label / dietary / ingredient data
  dietaryLabels: z.array(z.string()).default(() => []),
  ingredients: z.array(z.string()).default(() => []),
  ingredientKeywords: z.array(z.string()).default(() => []),
  claims: z.array(z.string()).default(() => []),

  // Raw visible text from the package (for search / fallback)
  visibleTextLines: z.array(z.string()).default(() => []),

  // Per-field confidence (0-1)
  confidenceByField: z.record(z.string(), z.number().min(0).max(1)).default(() => ({})),

  // Processing metadata
  metadata: z.object({
    imageSourceUrl: z.string().nullable().default(null),
    imageLocalPath: z.string().nullable().default(null),
    model: z.string().nullable().default(null),
    extractedAt: z.string().nullable().default(null),
    parser: z.string().nullable().default(null),
    rawResponseExcerpt: z.string().nullable().default(null),
    /** Durable model-call IDs that produced this OCR (issue #17 E). */
    modelCallIds: z.array(z.string()).optional(),
    /** P2 redaction pass: SHA-256 of the raw image source reference. The raw
     *  ref itself is never persisted — `imageSourceUrl` keeps only a bounded,
     *  credential/query-stripped form for debugging. Optional so hand-built
     *  fixtures without it stay assignable. */
    imageSourceDigest: z.string().nullable().optional(),
  }).nullable().default(null),
});

export type PackagingOcrData = z.infer<typeof PackagingOcrDataSchema>;

// ─── Pipeline Stages ────────────────────────────────────────────────────────────

export const SourceTypeEnum = z.enum(['official_page', 'distributor_record']);
export type SourceType = z.infer<typeof SourceTypeEnum>;

// ─── Manual-evidence extraction route (parent #101, ticket #102 foundation) ───
// Additive only. SourceTypeEnum stays two-valued: manual rows are
// official-brand provenance claimed by the operator (source_type =
// 'official_page') discriminated by extraction_method + attestation join.
// No new SourceTypeEnum value (see plan §2; audit in
// src/tests/unit/manual-evidence-foundation.test.ts).

/** Extraction method literal for operator-transcribed manual evidence rows. */
export const ManualEvidenceExtractionMethodEnum = z.literal('manual_evidence_v1');
export type ManualEvidenceExtractionMethod = z.infer<typeof ManualEvidenceExtractionMethodEnum>;

/** Per-field source kind recorded in the manual-evidence attestation checklist. */
export const ManualEvidenceSourceKindEnum = z.enum([
  'operator_transcription',
  'packaging_photo',
  'distributor_sheet',
  'brand_family_reference',
]);
export type ManualEvidenceSourceKind = z.infer<typeof ManualEvidenceSourceKindEnum>;

/** Bounded ISO timestamp string for attestation records. */
const ManualEvidenceIsoString = z.string().min(1).max(64);

/** One field entry in the manual-evidence attestation checklist. */
export const ManualEvidenceFieldChecklistEntrySchema = z.object({
  valueHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceKind: ManualEvidenceSourceKindEnum,
  referenceUrl: z.string().url().max(2000).nullable().default(null),
});
export type ManualEvidenceFieldChecklistEntry = z.infer<typeof ManualEvidenceFieldChecklistEntrySchema>;

/**
 * Operator attestation for one manual-evidence submission. All strings
 * bounded; the three boolean attestations must all be true (fail-closed).
 */
export const ManualEvidenceAttestationSchema = z.object({
  attestationId: z.string().min(1).max(128),
  itemId: z.string().min(1).max(128),
  batchId: z.string().max(128).nullable().default(null),
  operatorId: z.string().min(1).max(256),
  attestedAt: ManualEvidenceIsoString,
  familyReferenceUrl: z.string().url().max(2000).nullable().default(null),
  fieldChecklist: z.record(z.string().max(128), ManualEvidenceFieldChecklistEntrySchema),
  noFamilyInheritanceAttested: z.literal(true),
  perSkuVerificationAttested: z.literal(true),
  rightsAttestedForImages: z.literal(true),
  notes: z.string().max(2000).nullable().default(null),
  supersededAt: z.string().max(64).nullable().default(null),
});
export type ManualEvidenceAttestation = z.infer<typeof ManualEvidenceAttestationSchema>;

export const PipelineStageEnum = z.enum([
  'sourcing',
  'discovery',
  'extraction',
  'curation',
  'review',
  'promotion',
]);

export type PipelineStage = z.infer<typeof PipelineStageEnum>;

// ─── Extraction Data (structured product output) ────────────────────────────────

/**
 * A distributor-sourced image candidate with provenance tracking.
 */
export const DistributorImageCandidateSchema = z.object({
  url: z.string().url(),
  sourceAttemptIds: z.array(z.string()),
  sourceProviderIds: z.array(z.string()),
});
export type DistributorImageCandidate = z.infer<typeof DistributorImageCandidateSchema>;

/**
 * An approved distributor image with rights attestation.
 */
export const DistributorImageApprovalSchema = z.object({
  imageUrl: z.string().url(),
  sourceAttemptIds: z.array(z.string()),
  approvedAt: z.string(),
  rightsAttested: z.literal(true),
  approvalOrigin: z.enum(['operator_review', 'legacy_explicit_opt_in', 'distributor_channel_opt_in']).default('operator_review'),
});
export type DistributorImageApproval = z.infer<typeof DistributorImageApprovalSchema>;

/**
 * Stable OCR failure-reason taxonomy (packaging-OCR overhaul P1-T1).
 *
 * Defined in the SHARED layer because it is persisted inside
 * OcrAttemptOutcomeSchema and consumed by src/onboarding OCR modules;
 * src/shared must never import from src/onboarding, so the enum values live
 * here and src/onboarding/ocr-failure-reasons.ts derives its message map and
 * helpers from this schema.
 */
export const OcrFailureReasonEnum = z.enum([
  'not_configured',
  'policy_denied',
  'plan_incompatible',
  'no_image',
  'image_fetch_failed',
  'image_http_error',
  'image_too_small',
  'image_svg_unsupported',
  'timeout',
  'http_error',
  'transport_error',
  'empty_response',
  'unparseable_json',
  'schema_coercion_failed',
  'circuit_open',
  'audit_terminal_write_failed',
]);
export type OcrFailureReason = z.infer<typeof OcrFailureReasonEnum>;

export const OcrAttemptOutcomeStatusEnum = z.enum(['succeeded', 'failed', 'skipped', 'no_image', 'disabled']);
export type OcrAttemptOutcomeStatus = z.infer<typeof OcrAttemptOutcomeStatusEnum>;

export const OcrAttemptOutcomeSchema = z.object({
  status: OcrAttemptOutcomeStatusEnum,
  localStatus: OcrAttemptOutcomeStatusEnum.optional(),
  cloudStatus: OcrAttemptOutcomeStatusEnum.optional(),
  llmStatus: z.enum(['succeeded', 'failed', 'skipped', 'no_text', 'disabled']).optional(),
  model: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  imageCount: z.number().optional(),
  error: z.string().nullable().optional(),
  /** P1-T1: structured failure reason for the LOCAL VLM leg (null when succeeded/skipped). */
  localFailureReason: OcrFailureReasonEnum.nullish(),
  /** P1-T1: structured failure reason for the CLOUD VLM leg (null when succeeded/skipped). */
  cloudFailureReason: OcrFailureReasonEnum.nullish(),
  /** P1-T1: number of transport attempts made (>= 1 when an attempt ran). */
  attempts: z.number().int().positive().optional(),
  /** P1-T3 (reserved): stored OCR data predates the current frozen plan digest. */
  stale: z.boolean().optional(),
});
export type OcrAttemptOutcome = z.infer<typeof OcrAttemptOutcomeSchema>;

/**
 * The PI evidence payload attached to an onboarding item's extraction data
 * when a reviewed Agent Lab result is imported (PI-8). Distinct provenance
 * type so classification can consume it without conflating it with
 * spreadsheet or page evidence.
 */
export const ProductIntelligenceImportEvidenceSchema = z.object({
  runId: z.string().min(1),
  resultHash: z.string().min(1),
  importRecordId: z.string().min(1),
  importedAt: z.string(),
  evidence: z.array(
    z.object({
      field: z.string().min(1),
      value: z.string().max(2048),
      sourceId: z.string().min(1),
      evidenceId: z.string().min(1),
      extractionMethod: z.string().max(128).nullish(),
      snippet: z.string().max(2048).nullish(),
    }),
  ).default(() => []),
  sources: z.array(
    z.object({
      sourceId: z.string().min(1),
      url: z.string().url(),
      domain: z.string().max(256).nullish(),
      sourceType: z.string().max(128).nullish(),
    }),
  ).default(() => []),
  approvedImageIds: z.array(z.string()).default(() => []),
  /** Round-6: role-preserving image selection from the final reviewed bundle. */
  images: z.array(
    z.object({
      assetId: z.string().min(1),
      role: z.enum(['primary', 'alternate', 'nutrition', 'ingredients', 'comparison']),
    }),
  ).default(() => []),
});

export type ProductIntelligenceImportEvidence = z.infer<typeof ProductIntelligenceImportEvidenceSchema>;

export const ExtractionDataSchema = z.object({
  title: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  bulletPoints: z.array(z.string()).default(() => []),
  primaryImage: z.string().nullable().default(null),
  additionalImages: z.array(z.string()).default(() => []),
  price: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  dimensions: z.string().nullable().default(null),
  seoFileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  sourceType: SourceTypeEnum.optional().default('official_page'),
  /** The distributor provider ID when this extraction came from a distributor record. */
  distributorProviderId: z.string().nullable().optional().default(null),
  /** All distributor evidence attempt IDs that contributed to this extraction (plural). */
  distributorEvidenceAttemptIds: z.array(z.string()).optional().default(() => []),
  /** All distributor provider IDs that contributed to this extraction (plural). */
  distributorProviderIds: z.array(z.string()).optional().default(() => []),
  /** Image candidates from distributor evidence (not approved unless listed in distributorImageApprovals). */
  distributorImageCandidates: z.array(DistributorImageCandidateSchema).optional().default(() => []),
  /** Approved distributor images with rights attestation. */
  distributorImageApprovals: z.array(DistributorImageApprovalSchema).optional().default(() => []),
  /** Distributor SKU from the qualified distributor record (distributor_record sources only). */
  distributorSku: z.string().nullable().default(null),
  /**
   * All accepted evidence attempts' values for per-distributor reference
   * fields (distributorSku, distributorUpc, name). The consolidated single
   * pick stays in `distributorSku`; this map preserves every value so
   * Curation/display never lose distributor data. Sorted-unique arrays.
   */
  distributorReferenceValues: z.record(z.string(), z.array(z.string())).optional().default(() => ({})),
  /** Manufacturer part number from the qualified distributor record (distributor_record sources only). */
  manufacturerPartNumber: z.string().nullable().default(null),
  /**
   * Amendment B (M5): explicit merchandising-depth fields from qualified
   * distributor records. Noncanonical distributor category text — never a
   * Category Page ID. Price/inventory stay absent by contract.
   */
  distributorCategory: z.string().nullable().optional().default(null),
  casePack: z.string().nullable().optional().default(null),
  unitOfMeasure: z.string().nullable().optional().default(null),
  ingredients: z.string().nullable().optional().default(null),
  /** Whitelisted variant attributes from the qualified record: normalized axis → value. */
  variantAttributes: z.record(z.string(), z.string()).default(() => ({})),
  /**
   * Dedicated distributor-record provenance (Amendment A + Amendment B): the
   * sourcing generation, canonical evidence hash, sorted accepted attempt
   * ids, sorted provider ids, and observed catalog versions that produced
   * this materialization. v2 (Amendment B) adds projectionVersion,
   * extractionMethod, observation/connection identity, and full per-field +
   * merchandising provenance. Non-null exactly for `distributor_record`
   * sources.
   */
  distributorRecordProvenance: z
    .object({
      sourcingGenerationId: z.string(),
      evidenceHash: z.string(),
      acceptedEvidenceAttemptIds: z.array(z.string()),
      providerIds: z.array(z.string()),
      catalogVersions: z.array(z.string()),
      projectionVersion: z.string().optional(),
      extractionMethod: z.string().optional(),
      observedAt: z.array(z.string()).optional(),
      connectionIds: z.array(z.string()).optional(),
      fieldProvenance: z
        .record(
          z.string(),
          z.array(
            z.object({
              attemptId: z.string(),
              providerId: z.string(),
              catalogVersion: z.string(),
              connectionId: z.string(),
            }),
          ),
        )
        .optional(),
      merchandisingProvenance: z
        .record(
          z.string(),
          z.array(
            z.object({
              attemptId: z.string(),
              providerId: z.string(),
              catalogVersion: z.string(),
              connectionId: z.string(),
              values: z.array(z.string()),
            }),
          ),
        )
        .optional(),
    })
    .nullable()
    .default(null),
  sourceUrl: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0),
  fieldProvenance: z.record(z.string(), z.string()).default(() => ({})),
  // Tracks where each field came from: 'json-ld', 'meta', 'html', 'ai', 'user'
  // Manual-evidence invariant (parent #101, enforced by repo + review gates in
  // later tickets, never by this schema alone): rows with
  // extractionMethod 'manual_evidence_v1' must carry sourceType
  // 'official_page', sourceUrl null (the family page lives only in
  // manualReferenceUrl, reference-only), every populated field mapped to
  // 'user' in fieldProvenance, and identityStatus limited to
  // 'parent_product_only' | 'insufficient_evidence' (never exact/probable).
  /** Attestation id for manual-evidence rows; null for automated rows. */
  manualEvidenceAttestationId: z.string().max(128).nullable().default(null),
  /** Family page URL, reference-only attachment; never read as sourceUrl. */
  manualReferenceUrl: z.string().url().max(2000).nullable().default(null),
  /**
   * ADR-0031 (extraction-ladder wiring): deterministic identity classification
   * of the extracted page against the requested product. Values match the
   * PAGE_IDENTITY_STATUSES union in src/onboarding/extraction-ladder/result-shape.ts.
   * Diagnostics only — never gates extraction success or promotion.
   */
  identityStatus: z.enum([
    'exact_match',
    'probable_match',
    'parent_product_only',
    'wrong_variant',
    'conflicting_identity',
    'insufficient_evidence',
  ]).nullable().optional().default(null),
  /** Human-readable reasons supporting identityStatus. */
  identityReasons: z.array(z.string()).optional().default(() => []),
  packagingTitle: z.string().nullable().default(null),
  /** Structured OCR output from the primary product image. Populated once before classification. */
  packagingOcrData: PackagingOcrDataSchema.nullable().default(null),
  /** Detailed outcome status and provenance of the OCR extraction attempt */
  ocrOutcome: OcrAttemptOutcomeSchema.nullable().optional().default(null),
  /** Variant selection receipt when extraction required variant resolution (Issue #90 M4, optional, backward-compatible). */
  selectedVariant: VariantSelectionReceiptSchema.nullable().optional(),
  /** Typed variant identifiers/attributes provenance when variant-selected materialization applied. */
  variantProvenance: z.record(z.string(), z.string()).optional(),
  customFields: z.record(z.string(), z.string()).default(() => ({})),
  /**
   * Evidence imported from Product Intelligence Agent Lab runs (PI-8). An
   * ARRAY with one entry per imported run — a newer reviewed run augments
   * without silently replacing an earlier import, and promotion re-verifies
   * every entry's originating run + result hash.
   */
  productIntelligenceEvidence: z.array(ProductIntelligenceImportEvidenceSchema).default(() => []),
}).passthrough();



export type ExtractionData = z.infer<typeof ExtractionDataSchema>;

// ─── Sourcing Routing Contracts ─────────────────────────────────────────────────

/**
 * The automatic routing decision after Sourcing evaluates all provider results.
 *
 * Amendment A adds `distributor_record_to_extraction`: the ONLY automatic
 * Discovery-skipping route (qualified distributor record → extraction).
 * `bundle_to_curation` remains parse-only for historical audit rows — no
 * schema, request, repository transition, worker, route, or UI may create or
 * act on it.
 */
export const SourcingRouteEnum = z.enum([
  'bundle_to_curation',
  'evidence_to_discovery',
  'fallback_to_discovery',
  'needs_input_conflict',
  'retry_provider_errors',
  'degraded_fallback_to_discovery',
  'distributor_record_to_extraction',
]);
export type SourcingRoute = z.infer<typeof SourcingRouteEnum>;

/**
 * Route/target matrix (ADR 0014): Sourcing advances ONLY to adjacent
 * Discovery. `evidence_to_discovery` is the new coherent-evidence route
 * (accepted current-generation evidence, guarded move to discovery/pending);
 * `bundle_to_curation` survives only as a legacy persisted-audit value for
 * historical rows — no schema, request, repository transition, worker,
 * route, or UI may create or act on it.
 */

/**
 * How the Sourcing decision was made.
 */
export const SourcingRoutingOriginEnum = z.enum(['automatic_policy', 'operator_override']);
export type SourcingRoutingOrigin = z.infer<typeof SourcingRoutingOriginEnum>;

/**
 * A detected conflict between distributor providers for a specific field.
 */
export const SourcingConflictSchema = z.object({
  field: z.string(),
  providerValues: z.record(z.string(), z.string()),
  severity: z.enum(['hard', 'soft']),
});
export type SourcingConflict = z.infer<typeof SourcingConflictSchema>;

/**
 * The full Sourcing routing decision, persisted on the item.
 *
 * This is the LEGACY writer shape (pre-Amendment-A, no `schemaVersion`),
 * kept intact for byte-compatible hydration of existing rows. It is
 * PARSE-ONLY for `bundle_to_curation` and no longer the creatable authority:
 * repositories, services, routes, and workers must write through
 * `CreatableSourcingDecisionSchema` (V2) once migrated (Milestones B/C).
 */
export const SourcingDecisionSchema = z.object({
  route: SourcingRouteEnum,
  origin: SourcingRoutingOriginEnum,
  acceptedEvidenceAttemptIds: z.array(z.string()),
  providerIds: z.array(z.string()),
  conflicts: z.array(SourcingConflictSchema).default(() => []),
  warnings: z.array(z.string()).default(() => []),
  decidedAt: z.string(),
});
export type SourcingDecision = z.infer<typeof SourcingDecisionSchema>;

/**
 * Read-only compatibility parser for historical decisions (pre-versioning
 * rows and legacy audit `bundle_to_curation` values). Never accepted by a
 * mutation helper.
 */
/**
 * Legacy read-only parser for pre-Amendment-A decisions.
 *
 * MUST NOT downgrade malformed V2 payloads: any object carrying a
 * `schemaVersion` key belongs to the V2 read path (and must fail there),
 * never the legacy parser. The legacy WRITER (`SourcingDecisionSchema`)
 * is intentionally unchanged; only the read-facing alias gains the guard.
 */
export const LegacySourcingDecisionSchema = SourcingDecisionSchema.extend({
  // `schemaVersion` is a KNOWN key whose presence always fails (z.never), so
  // malformed V2 payloads can never downgrade to legacy. Unknown keys are
  // still stripped as before, keeping historical rows readable. NB: a plain
  // `.refine` would be useless here — object schemas strip unknown keys
  // BEFORE refinement, so the parsed value would never contain schemaVersion.
  schemaVersion: z.never().optional(),
});
export type LegacySourcingDecision = z.infer<typeof LegacySourcingDecisionSchema>;

const UNIQUE_STRINGS = (values: string[]) => new Set(values).size === values.length;
const UNIQUE_STRINGS_MSG = 'values must be unique';

/**
 * Strict route-specific decision schema (Amendment A, schema version 2).
 * Each route variant enforces its own accepted-attempt / provider /
 * generation / hash / source-type / target invariants (see the plan's
 * route-specific decision contract). The route/target matrix is enforced
 * at the schema level: a caller-provided target that disagrees with the
 * route is rejected. `bundle_to_curation` has NO variant — it is not
 * creatable.
 */
export const SourcingDecisionV2Schema = z.discriminatedUnion('route', [
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('distributor_record_to_extraction'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z
      .array(z.string().min(1))
      .min(1)
      .max(64)
      .refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    providerIds: z.array(z.string().min(1)).min(1).max(64).refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    sourcingGenerationId: z.string().min(1),
    /** Canonical SHA-256 hex of the deterministic distributor-record projection. */
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/, 'evidenceHash must be a canonical SHA-256 hex digest'),
    sourceType: z.literal('distributor_record'),
    target: z.literal('extraction'),
    conflicts: z.array(SourcingConflictSchema).max(128).default(() => []),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('evidence_to_discovery'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z
      .array(z.string().min(1))
      .min(1)
      .max(64)
      .refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    providerIds: z.array(z.string().min(1)).min(1).max(64).refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    sourcingGenerationId: z.string().min(1),
    sourceType: z.literal('official_page'),
    target: z.literal('discovery'),
    conflicts: z.array(SourcingConflictSchema).max(128).default(() => []),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('fallback_to_discovery'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z.array(z.string()).max(0),
    providerIds: z.array(z.string().min(1).max(64)).max(64).default(() => []),
    sourcingGenerationId: z.string().min(1).optional(),
    sourceType: z.literal('official_page'),
    target: z.literal('discovery'),
    conflicts: z.array(SourcingConflictSchema).max(128).default(() => []),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('degraded_fallback_to_discovery'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z.array(z.string()).max(0),
    providerIds: z.array(z.string().min(1)).min(1).max(64).refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    sourcingGenerationId: z.string().min(1),
    sourceType: z.literal('official_page'),
    target: z.literal('discovery'),
    conflicts: z.array(SourcingConflictSchema).max(128).default(() => []),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('needs_input_conflict'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z.array(z.string()).max(0),
    providerIds: z.array(z.string().min(1)).min(1).max(64).refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    sourcingGenerationId: z.string().min(1),
    sourceType: z.literal('official_page').optional(),
    target: z.literal('sourcing'),
    // A needs_input_conflict decision MUST carry at least one hard conflict.
    conflicts: z
      .array(SourcingConflictSchema)
      .min(1)
      .max(128)
      .refine(
        (cs) => cs.some((c) => c.severity === 'hard'),
        'needs_input_conflict requires at least one hard conflict',
      ),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    route: z.literal('retry_provider_errors'),
    origin: SourcingRoutingOriginEnum,
    acceptedEvidenceAttemptIds: z.array(z.string()).max(0),
    providerIds: z.array(z.string().min(1)).min(1).max(64).refine(UNIQUE_STRINGS, UNIQUE_STRINGS_MSG),
    sourcingGenerationId: z.string().min(1),
    sourceType: z.literal('official_page').optional(),
    target: z.literal('sourcing'),
    conflicts: z.array(SourcingConflictSchema).max(128).default(() => []),
    warnings: z.array(z.string().max(500)).max(128).default(() => []),
    decidedAt: z.string().datetime({ offset: true }),
  }).strict(),
]);
export type SourcingDecisionV2 = z.infer<typeof SourcingDecisionV2Schema>;

/**
 * Read union used for hydration: strict V2 decisions plus legacy rows.
 */
export const SourcingDecisionReadSchema = z.union([SourcingDecisionV2Schema, LegacySourcingDecisionSchema]);
export type SourcingDecisionRead = z.infer<typeof SourcingDecisionReadSchema>;

/**
 * The ONLY creatable decision input (Amendment A): strict V2, route-specific.
 * Repositories, services, routes, and workers validate through this schema
 * once migrated; legacy-shaped decisions are rejected (no schemaVersion).
 */
export const CreatableSourcingDecisionSchema = SourcingDecisionV2Schema;
export type CreatableSourcingDecision = SourcingDecisionV2;

// ─── Request Schemas for Sourcing Resolution ───────────────────────────────────

/**
 * Resolve a Sourcing item by falling back to Discovery.
 *
 * `bundle_to_curation` survives in `SourcingRouteEnum` only as a legacy
 * persisted-audit value for historical rows; no request schema, repository
 * transition, route, or UI may create or act on it.
 */
export const ResolveSourcingFallbackToDiscoverySchema = z.object({
  action: z.literal('fallback_to_discovery'),
});

/**
 * Strict manual routing action (Amendment A, MC item 7): use the qualified
 * distributor record and skip Discovery. The server recomputes qualification
 * and IGNORES any client-supplied ids/hash/providers — this schema is closed
 * so an attempt to smuggle provenance fails validation.
 */
export const ResolveSourcingUseDistributorRecordSchema = z
  .object({
    action: z.literal('use_distributor_record'),
  })
  .strict();

export const ResolveSourcingRequestSchema = z.discriminatedUnion('action', [
  ResolveSourcingFallbackToDiscoverySchema,
  ResolveSourcingUseDistributorRecordSchema,
]);
export type ResolveSourcingRequest = z.infer<typeof ResolveSourcingRequestSchema>;

/**
 * Bulk repair request: move stranded `sourcing/pending` items to Discovery
 * with an audited `fallback_to_discovery` operator-override decision.
 */
export const FallbackSourcingItemsRequestSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1),
});
export type FallbackSourcingItemsRequest = z.infer<typeof FallbackSourcingItemsRequestSchema>;

/**
 * Bulk repair response: deterministic counts plus per-item skip reasons so a
 * partial result is visible instead of silently reported as full success.
 */
export const FallbackSourcingItemsResponseSchema = z.object({
  moved: z.array(z.string()),
  skipped: z.array(z.object({
    id: z.string(),
    reason: z.string(),
  })),
});
export type FallbackSourcingItemsResponse = z.infer<typeof FallbackSourcingItemsResponseSchema>;

/**
 * Approve a distributor image for use in a product draft.
 */
export const ApproveDistributorImageRequestSchema = z.object({
  imageUrl: z.string().url(),
  rightsAttested: z.literal(true),
  sourceAttemptIds: z.array(z.string()).min(1),
});
export type ApproveDistributorImageRequest = z.infer<typeof ApproveDistributorImageRequestSchema>;

// ─── Manual-evidence extraction route (parent #101, ticket #103 thin slice) ───
// Strict request shapes: the server derives ALL provenance (sourceType,
// identityStatus, confidence, fieldProvenance, hashes, attestation link) and
// rejects any client-supplied provenance — this schema is closed so an
// attempt to smuggle provenance fails validation. Thin-slice field set:
// title (required) + brand (optional); later tickets extend the fields.
/** Three-part operator attestation for one manual-evidence submission. */
export const ManualEvidenceAttestationInputSchema = z
  .object({
    noFamilyInheritance: z.literal(true),
    perSkuVerified: z.literal(true),
    rightsAttested: z.literal(true),
    notes: z.string().max(2000).nullable().default(null),
  })
  .strict();
export type ManualEvidenceAttestationInput = z.infer<typeof ManualEvidenceAttestationInputSchema>;

/** Operator submission of manual evidence for one profile-blocked item. */
export const SubmitManualEvidenceRequestSchema = z
  .object({
    itemId: z.string().min(1).max(128),
    title: z.string().min(1).max(500),
    brand: z.string().max(256).nullable().default(null),
    familyReferenceUrl: z.string().url().max(2000).nullable().default(null),
    familyPageOnlyConfirmed: z.boolean().default(false),
    overrideDistributorReason: z.string().max(500).nullable().default(null),
    attestation: ManualEvidenceAttestationInputSchema,
  })
  .strict();
export type SubmitManualEvidenceRequest = z.infer<typeof SubmitManualEvidenceRequestSchema>;

/** Operator withdrawal of manual evidence for one item. */
export const WithdrawManualEvidenceRequestSchema = z
  .object({
    itemId: z.string().min(1).max(128),
  })
  .strict();
export type WithdrawManualEvidenceRequest = z.infer<typeof WithdrawManualEvidenceRequestSchema>;

// ─── Curation Data (Refined taxonomy and packaging mapping) ─────────────────────

/**
 * PR9 (issue #30, DECISION-A): the member's cohort semantic validation
 * payload shape — `{status, findings}` where a 'blocked' status means the
 * member is NOT review-ready (`semantic_validation_blocked` gate) while the
 * curationData + proposals stay intact (blocked-not-destroyed).
 *
 * Exported so the review completion gate (R2-A) parses the committed payload
 * against the EXACT same schema the curator writes — missing or malformed
 * semantic data fails closed (never review-ready).
 *
 * PR9 review R2 (B): `coordinated_page_name_mismatch` is an ADVISORY-only
 * finding code — the BLOCKING page correspondence is the stable Page ID
 * set-match (`coordinated_page`); a pageName mismatch for a matched id is a
 * diagnostic (stale/renamed store page), never a review blocker.
 */
export const CohortSemanticValidationSchema = z.object({
  status: z.enum(['passed', 'blocked']),
  findings: z.array(z.object({
    code: z.enum([
      'family_product_type',
      'family_brand',
      'coordinated_title',
      'coordinated_page',
      'coordinated_page_name_mismatch',
      'member_attribute_applicability',
      'member_cardinality',
    ]),
    memberSku: z.string(),
    message: z.string(),
    conflictingValues: z.array(z.string()).nullable().optional().default(null),
    suggestedAction: z.enum(['accept_majority', 'choose_canonical_brand', 'split_cohort', 're_run_curation']).nullable().optional().default(null),
  })),
});

export type CohortSemanticValidation = z.infer<typeof CohortSemanticValidationSchema>;

/**
 * e09 B3 (T9): persisted family-title-consistency proof, captured at the
 * member-projection commit from the DURABLE coordinated title output. The
 * cohort name coordinator already enforced all-or-nothing validation (T7)
 * BEFORE commit — a committed `llm_cohort`/`cohort_fallback` title passed
 * `validateFamilyTitleSet`, so only the passing status is representable.
 * Additive key: absent in legacy/non-cohort runs (byte-identical). Consumed
 * fail-closed by the review completion gate for cohort-coordinated titles
 * (adjudication #8: new revisions only — completed cohorts are never
 * backfilled).
 */
export const FamilyTitleValidationRecordSchema = z.object({
  version: z.string(),
  // 'blocked' is representable for a family whose coordinated set failed
  // validation and was committed as a blocked outcome; the review completion
  // gate refuses such records with `title_validation_blocked` (T9). The
  // current producer only commits 'passed' — the wider enum keeps the record
  // contract total without changing producer behavior.
  status: z.enum(['passed', 'blocked']),
  source: z.enum(['llm_cohort', 'cohort_fallback']),
});

export type FamilyTitleValidationRecord = z.infer<typeof FamilyTitleValidationRecordSchema>;

/**
 * e09 B3 (P10): persisted durable Category Page decision status for the
 * member, captured at the member-projection commit from the DURABLE
 * coordinated page output — never recomputed from live rows. Additive key:
 * absent in legacy runs (byte-identical). The review completion gate enforces
 * it for runs whose frozen snapshot enables the category_page target;
 * `abstained` blocks review unless a reviewer correction resolves to a
 * current verified Page ID (adjudication #6/#10).
 */
export const PageDecisionStatusRecordSchema = z.object({
  status: z.enum(['assigned', 'abstained', 'absent']),
  reason: z.string().nullable().optional(),
});

export type PageDecisionStatusRecord = z.infer<typeof PageDecisionStatusRecordSchema>;

/**
 * e09 round-3 FIX 1 (adjudication #10): reviewer manual-selection correction
 * for an ABSTAINED durable Category Page decision. Written by the Review UI
 * when the reviewer picks a page from the VERIFIED options list — a stable
 * verified Page ID plus the active page-import hash captured at correction
 * time. Additive optional key: absent in legacy/non-corrected runs
 * (byte-identical). Consumed fail-closed by the review completion gate: the
 * recorded Page ID must resolve into the CURRENT verified import AND the
 * recorded hash must equal the ACTIVE page-import source hash at gate time
 * (a stale hash or unverified ID → `page_decision_stale` refusal; a malformed
 * record never satisfies the abstention).
 */
export const CorrectedCategoryPageRecordSchema = z.object({
  /** Stable verified Page ID selected by the reviewer (never a display name). */
  pageId: z.string().min(1),
  /** Active page-import source hash captured when the correction was made. */
  activePageImportHash: z.string().min(1),
  /** ISO timestamp of the correction. */
  correctedAt: z.string().min(1),
});

export type CorrectedCategoryPageRecord = z.infer<typeof CorrectedCategoryPageRecordSchema>;

/**
 * e10s04 — reviewer media selection persisted at review time
 * (`curation_data.reviewedMedia`). Written ONLY by the dedicated
 * `PUT /api/onboarding/items/:id/media` route after candidate-set union
 * validation; never by generic curation_data edits. Additive optional key:
 * absent until a reviewer saves a selection (legacy rows byte-identical).
 *
 * OVERWRITE semantics (supervisor decision 2026-08-23): suppression removes
 * images from consideration without preserving a separate audit copy of the
 * original extraction proposal set; repeated saves validate against the
 * UNION of extraction candidates and previously persisted entries.
 */
export const ReviewedMediaSchema = z.object({
  /** Reviewer-designated primary image; null ⇒ promoter falls back to its current chain. */
  primaryImage: z.string().min(1).nullable().default(null),
  /** Explicit ordering for additional images; empty ⇒ extraction order unchanged. */
  orderedAdditional: z.array(z.string().min(1)).default(() => []),
  /** URLs removed from consideration (never promoted, still validated as candidates). */
  suppressed: z.array(z.string().min(1)).default(() => []),
});

export type ReviewedMedia = z.infer<typeof ReviewedMediaSchema>;

/** Request body for PUT /api/onboarding/items/:id/media (e10s04). */
export const MediaSelectionRequestSchema = z.object({
  primaryImage: z.string().min(1).nullable(),
  orderedAdditional: z.array(z.string().min(1)),
  suppressed: z.array(z.string().min(1)),
});

export type MediaSelectionRequest = z.infer<typeof MediaSelectionRequestSchema>;

export const CurationDataSchema = z.object({
  curatedTitle: z.string().nullable().default(null),
  /** Search keywords synthesized by the curator from curated title, brand, attributes, and page names. */
  searchKeywords: z.string().nullable().default(null),
  packagingOcrTitle: z.string().nullable().default(null),
  curatedWeight: z.preprocess(val => {
    if (typeof val === 'string') {
      return convertToLbs(val);
    }
    return val;
  }, z.string().nullable().default(null)),
  titleSource: z.enum(['web', 'ocr', 'llm', 'manual', 'llm_cohort', 'cohort_fallback']).default('web'),
  /** Factual consolidated copy from multi-provider distributor bundle. */
  curatedDescription: z.string().nullable().default(null),
  /** The evidence attempt IDs whose copy contributed to curatedDescription. */
  curatedDescriptionSourceAttemptIds: z.array(z.string()).default(() => []),
  suggestedPages: z.array(z.string()).default(() => []),
  /** e09 round-3 FIX 1: reviewer manual-selection correction record (see CorrectedCategoryPageRecordSchema). Additive, absent unless corrected. */
  correctedCategoryPage: CorrectedCategoryPageRecordSchema.nullable().optional(),
  /** e10s04: reviewer media selection (see ReviewedMediaSchema). Absent until first media save. */
  reviewedMedia: ReviewedMediaSchema.nullable().optional(),
  suggestedProductType: z.string().nullable().default(null),
  curatedAt: z.string().nullable().default(null),
  curationMethod: z.enum(['auto', 'manual']).default('auto'),

  // Phase 1 classification containers
  classificationRunId: z.string().nullable().default(null),
  classificationConfigSnapshot: ClassificationConfigSnapshotRefSchema.nullable().default(null),
  classificationEvidence: z.array(ClassificationEvidenceSchema).default(() => []),
  classificationProposals: z.array(ClassificationProposalSchema).default(() => []),
  classificationDecisions: z.array(ClassificationProposalDecisionSchema).default(() => []),
  classificationHistory: z.array(ClassificationHistoryEventSchema).default(() => []),
  /**
   * PR5 (issue #30, DECISION-J): the member's effective Curation Product Type
   * in prepared-cohort mode — the reviewed (accepted) Primary Product Type
   * first, the frozen cohort Execution Product Type as fallback, else none.
   * Read-only observability: the Review UI ignores unknown keys, Promotion
   * never consumes it (the Execution Type is never reviewed truth), and
   * legacy (non-cohort) runs never carry the key.
   */
  effectiveProductType: z.object({
    id: z.string().nullable(),
    source: z.enum(['reviewed', 'execution', 'none']),
  }).nullable().optional(),
  /**
   * PR9 (issue #30, DECISION-A): the member's cohort semantic validation
   * result — computed from FROZEN authority at the member-projection commit
   * (family_invariant Product Type/Brand, coordinated_variant title/page
   * correspondence to the parent durable outputs, member_local profile
   * applicability) and re-evaluated for mutual Brand coherence after the
   * member loop. Additive key: absent in legacy/shadow runs (byte-identical).
   * A 'blocked' status is NOT review-ready (the review completion gate
   * refuses it with code 'semantic_validation_blocked') while curationData
   * + proposals stay intact for the Review UX (blocked-not-destroyed).
   */
  semanticValidation: CohortSemanticValidationSchema.nullable().optional(),
  // e09 B3 (T9/P10): additive gate-status records — absent in legacy/shadow
  // runs (JSON.stringify drops undefined keys). See the record schemas above.
  familyTitleValidation: FamilyTitleValidationRecordSchema.nullable().optional(),
  pageDecisionStatus: PageDecisionStatusRecordSchema.nullable().optional(),
  // e05s01: review observability — additive, absent in legacy runs (byte-identical)
  attributeApplicability: z
    .array(
      z.object({
        attributeId: z.string(),
        state: z.enum(['applicable', 'not_applicable', 'unknown']),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  categoryPageGating: z
    .object({
      needsReviewedType: z.boolean(),
      needsVerifiedPages: z.boolean(),
      verifiedPageCount: z.number().int(),
      reason: z.string().nullable().optional(),
      // e05s02 provenance
      verifiedPageIdSet: z.array(z.string()).optional(),
      snapshotHash: z.string().nullable().optional(),
    })
    .optional(),
  speciesGuardDropped: z
    .array(
      z.object({
        pageName: z.string(),
        species: z.string(),
        reason: z.string(),
        matchedTerm: z.string().optional(),
      }),
    )
    .optional(),
  // story: e05s02 — taxonomy provenance per field (bundle/snapshot/verified identity), no invented IDs
  taxonomyProvenance: z
    .object({
      bundleHash: z.string().nullable().optional(),
      bundleVersion: z.string().nullable().optional(),
      snapshotHash: z.string().nullable().optional(),
      manifestFileVersions: z.record(z.string(), z.string()).optional(),
      verifiedPageCount: z.number().int().optional(),
      verifiedPageIdSet: z.array(z.string()).optional(),
      attributeProfileId: z.string().nullable().optional(),
      classificationRunId: z.string().nullable().optional(),
    })
    .optional(),
});

export type CurationData = z.infer<typeof CurationDataSchema>;

// ─── Review completeness (story e10s01) ─────────────────────────────────────
// Shared blocker/warning codes for the review-completeness gate so the
// server (authoritative) and client (advisory live status) can never
// diverge on vocabulary. Blocker codes mirror the promotion mandatory
// checklist in src/onboarding/draft-promoter.ts (~976–996) exactly.
export const REVIEW_COMPLETENESS_BLOCKER_CODES = [
  'missing_name',
  'missing_price',
  'missing_brand',
  'missing_primary_image',
  'missing_pages',
] as const;
export type ReviewCompletenessBlockerCode = (typeof REVIEW_COMPLETENESS_BLOCKER_CODES)[number];

export const REVIEW_COMPLETENESS_WARNING_CODES = [
  'name_from_fallback_source',
  'description_empty',
  'keywords_empty',
  'weight_missing',
  'pending_proposals',
  'unverified_accepted_pages',
] as const;
export type ReviewCompletenessWarningCode = (typeof REVIEW_COMPLETENESS_WARNING_CODES)[number];

export const ReviewCompletenessSchema = z.object({
  ready: z.boolean(),
  blockers: z.array(z.enum(REVIEW_COMPLETENESS_BLOCKER_CODES)),
  warnings: z.array(z.enum(REVIEW_COMPLETENESS_WARNING_CODES)),
  /** Non-coded human-readable notes (e.g. distributor price auto-satisfaction). */
  notes: z.array(z.string()).default([]),
});
export type ReviewCompleteness = z.infer<typeof ReviewCompletenessSchema>;

// ─── Batch Statuses ─────────────────────────────────────────────────────────────

// Batches no longer control the pipeline lifecycle. Status is minimal:
// - 'active': default, items are being processed
// - 'archived': batch is done / hidden from active view
export const BatchStatusEnum = z.enum(['active', 'archived']);

export type BatchStatus = z.infer<typeof BatchStatusEnum>;

/** Batch execution state controls worker claim eligibility. */
export const BatchExecutionStateEnum = z.enum(['draft', 'ready', 'running', 'paused', 'completed']);

export type BatchExecutionState = z.infer<typeof BatchExecutionStateEnum>;

// ─── Stage Statuses ─────────────────────────────────────────────────────────────

export const StageStatusEnum = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'needs_input',
  'skipped',
]);

/**
 * `needs_input` means processing is paused for an explicit operator action
 * (like selecting a source URL, resolving ambiguous candidates, or fixing
 * brand/domain setup). It is NOT a failure and NOT the Review stage.
 */
export type StageStatus = z.infer<typeof StageStatusEnum>;

// ─── Item Statuses (DEPRECATED — use stage + stageStatus) ───────────────────────

export const ItemStatusEnum = z.enum([
  'imported',
  'discovering',
  'source_found',
  'source_confirmed',
  'extracting',
  'extracted',
  'curating',
  'curated',
  'needs_review',
  'ready',
  'promoted',
  'failed',
  'skipped',
]);

export type ItemStatus = z.infer<typeof ItemStatusEnum>;

// ─── API Key ────────────────────────────────────────────────────────────────────

export const ApiKeyServiceEnum = z.enum([
  'openai',
  'deepseek',
  'ollama',
  'ollama_vlm',
  'firecrawl',
]);

export type ApiKeyService = z.infer<typeof ApiKeyServiceEnum>;

export const ApiKeyConfigSchema = z.object({
  service: ApiKeyServiceEnum,
  apiKey: z.string().min(1),
  baseUrl: z.string().url().nullable().default(null),
  model: z.string().nullable().default(null),
});

export type ApiKeyConfig = z.infer<typeof ApiKeyConfigSchema>;

export const VariantSelectionStrategySchema = z.object({
  containerSelector: z.string().nullable().default(null),
  optionType: z.enum(['dropdown', 'button_group', 'radio', 'unknown']).default('unknown'),
  detectedOptions: z.array(z.string()).default(() => []),
  optionFields: z.array(z.string()).default(() => []),
  optionSelector: z.string().nullable().default(null),
  optionTextAttribute: z.string().nullable().default(null),
}).nullable().default(null);

export type VariantSelectionStrategy = z.infer<typeof VariantSelectionStrategySchema>;

/**
 * Runtime representation of variant selection strategy (DB-serialized).
 * This matches VariantSelectionStrategySchema but allows loose JSON
 * for repo-level compatibility.
 */
export type VariantSelectionStrategyRecord = Record<string, unknown> | null;

export const StrictVariantSelectionStrategySchema = z.object({
  axes: z.array(z.object({
    axis: z.string().min(1).max(64),
    selector: z.string().min(1).max(500),
    optionType: z.enum(['dropdown', 'button_group', 'radio']),
    optionValueSelector: z.string().max(500).optional(),
    optionTextAttribute: z.string().max(64).optional(),
    settledSelector: z.string().max(500).optional(),
    settledAttribute: z.string().max(64).optional(),
    timeoutMs: z.number().int().min(100).max(10000).optional(),
  })).max(8),
  timeoutMs: z.number().int().min(100).max(10000).optional().default(3000),
});
export type StrictVariantSelectionStrategy = z.infer<typeof StrictVariantSelectionStrategySchema>;
// Legacy loose shape still accepted for reads (back-compat with existing profiles) — ExtractorProfile keeps loose record to avoid breaking existing validation

export const ExtractorProfileSchema = z.object({
  id: z.string(),
  domain: z.string(),
  titleSelector: z.string().nullable().default(null),
  titleOptionalSelectors: z.array(z.string()).default(() => []),
  priceSelector: z.string().nullable().default(null),
  descriptionSelector: z.string().nullable().default(null),
  brandSelector: z.string().nullable().default(null),
  imagesSelector: z.string().nullable().default(null),
  customSelectors: z.record(z.string(), z.string()).default(() => ({})),
  sitemapProductUrlPattern: z.string().nullable().default(null),
  shopifyJSONPath: z.boolean().default(false),
  variantSelectionStrategy: z.record(z.string(), z.unknown()).nullable().default(null),
  customSelectorMetadata: z.record(z.string(), z.unknown()).default(() => ({})),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
  profileType: z.enum(['brand', 'retailer']).optional().default('brand'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ExtractorProfile = z.infer<typeof ExtractorProfileSchema>;

// ─── Onboarding Batch ───────────────────────────────────────────────────────────

export const OnboardingBatchSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  fileName: z.string(),
  /** Minimal batch lifecycle: 'active' (default), 'archived' (hidden from board). */
  status: BatchStatusEnum,
  /** Execution state: controls worker claim eligibility. */
  executionState: BatchExecutionStateEnum.default('draft'),
  totalItems: z.number().int(),
  completedItems: z.number().int(),
  failedItems: z.number().int(),
  skippedItems: z.number().int().default(0),
  columnMapping: ColumnMappingSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OnboardingBatch = z.infer<typeof OnboardingBatchSchema>;

// ─── Onboarding Item ────────────────────────────────────────────────────────────

export const OnboardingItemSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  upc: z.string(),
  name: z.string(),
  price: z.string().nullable(),
  quantity: z.number().int().nullable(),
  brandHint: z.string().nullable(),
  departmentHint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  expectedName: z.string().nullable().optional(),
  /** Pre-computed coordinated title from cohort LLM call. */
  coordinatedTitle: z.string().nullable().optional(),
  /** Whether the source of truth is an official product page or a distributor record. */
  sourceType: SourceTypeEnum.optional().default('official_page'),
  /** When sourceType='distributor_record', the accepted evidence attempt IDs (plural). */
  acceptedEvidenceAttemptIds: z.array(z.string()).default(() => []),
  /** @deprecated Use acceptedEvidenceAttemptIds instead. Kept for backward compat. */
  acceptedEvidenceAttemptId: z.string().nullable().default(null),
  /** The auto-routing decision from Sourcing evaluation. Legacy writer shape, or the strict V2 shape (Amendment A) once written. */
  sourcingDecision: z.union([SourcingDecisionSchema, SourcingDecisionV2Schema]).nullable().default(null),
  /** Current pipeline stage for this item. */
  stage: PipelineStageEnum,
  /** Status within the current stage. */
  stageStatus: StageStatusEnum,
  /** Preflight / controlled release hold flag: 1 when held from worker processing. */
  isHeld: z.boolean().default(false),
  /** Reason why the item is held (e.g. missing_brand, ambiguous_brand, unrouted_brand). */
  heldReason: z.string().nullable().default(null),
  /** DEPRECATED: flat status, kept for backward compat. Use stage + stageStatus instead. */
  status: ItemStatusEnum,
  errorMessage: z.string().nullable(),
  retryCount: z.number().int(),
  isDuplicate: z.boolean(),
  existingSku: z.string().nullable(),
  extractionData: ExtractionDataSchema.nullable().default(null),
  curationData: CurationDataSchema.nullable().default(null),
  // Milestone 5 (P1-B) — lossless imported identity (bounded, fail-closed, lossy flag, cross-field)
  rawIdentityJson: z.string().max(10000).nullable().optional(),
  normalizedIdentityJson: z.string().max(10000).nullable().optional(),
  identityNormalizerVersion: z.number().int().min(0).max(10).nullable().optional(),
  identityProvenanceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  identityLossy: z.boolean().optional(),
  rowNumber: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine((data, ctx) => {
  // Shared tuple validator (M5 round 3) — fail-closed via dynamic require to avoid cycle
  const { validateIdentityTuple } = require('../../onboarding/imported-identity');
  const res = validateIdentityTuple({
    rawJson: (data as any).rawIdentityJson ?? null,
    normalizedJson: (data as any).normalizedIdentityJson ?? null,
    version: (data as any).identityNormalizerVersion ?? null,
    provenanceHash: (data as any).identityProvenanceHash ?? null,
    lossy: (data as any).identityLossy,
  });
  if (!res.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.reason || 'identity tuple invalid', path: ['identityNormalizerVersion'] });
  }
  // Also enforce individual envelope canonical + schema validation when present
  const checkCanonical = (json: string | null, path: string, isRaw: boolean) => {
    if (json === null) return;
    try {
      const parsed = JSON.parse(json);
      const { canonicalJsonStringify } = require('../stable-id');
      if (canonicalJsonStringify(parsed) !== json) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not canonical JSON', path: [path] });
        return;
      }
      const { RawIdentityEnvelopeV1Schema, NormalizedIdentityEnvelopeV1Schema } = require('../../onboarding/imported-identity');
      const schema = isRaw ? RawIdentityEnvelopeV1Schema : NormalizedIdentityEnvelopeV1Schema;
      const r = schema.safeParse(parsed);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'envelope schema invalid', path: [path] });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid JSON', path: [path] });
    }
  };
  checkCanonical((data as any).rawIdentityJson ?? null, 'rawIdentityJson', true);
  checkCanonical((data as any).normalizedIdentityJson ?? null, 'normalizedIdentityJson', false);
});

export type OnboardingItem = z.infer<typeof OnboardingItemSchema>;

// ─── Onboarding Source ──────────────────────────────────────────────────────────

export const OnboardingSourceSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  snippet: z.string().nullable(),
  domain: z.string().nullable(),
  confidence: z.number(),
  isSelected: z.boolean(),
  sourceMethod: z.string(),
  metadataJson: z.string().nullable().optional(),
  discoveryRunId: z.string().nullable().optional(),
  verificationJson: z.string().nullable().optional(),
  verificationScore: z.number().nullable().optional(),
  recommendation: z.string().nullable().optional(),
  reviewStatus: z.string().optional().default('pending'),
  decisionOrigin: z.string().nullable().optional(),
  decisionReason: z.string().nullable().optional(),
  reviewedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type OnboardingSource = z.infer<typeof OnboardingSourceSchema>;

// ─── Profile Governance (Phase 3) ───────────────────────────────────────────────

/** LLM tasks that can be routed through `llm_task_configs`. */
export const LlmTaskEnum = z.enum([
  'product_name_consolidation',
  'discovery_candidate_selection',
  'profile_generation',
  'profile_revision',
  'product_curation',
  'category_classification',
  'classification_evidence_extraction',
  'product_type_classification',
  'category_page_assignment',
  'attribute_value_classification',
  'product_field_refactor',
  'store_manager_assistant',
]);
export type LlmTask = z.infer<typeof LlmTaskEnum>;

/** LLM providers accepted by `llm_task_configs`. */
export const LlmProviderEnum = z.enum(['deepseek', 'openai', 'ollama']);
export type LlmProvider = z.infer<typeof LlmProviderEnum>;

export const ReasoningEffortEnum = z.enum(['low', 'medium', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortEnum>;

export const LlmTaskConfigSchema = z.object({
  id: z.string(),
  task: LlmTaskEnum,
  provider: LlmProviderEnum,
  model: z.string().min(1),
  fallbackProvider: LlmProviderEnum.nullable().default(null),
  fallbackModel: z.string().nullable().default(null),
  baseUrlOverride: z.string().url().nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  reasoningEffort: ReasoningEffortEnum.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LlmTaskConfig = z.infer<typeof LlmTaskConfigSchema>;

export const LlmTaskConfigUpsertSchema = z.object({
  provider: LlmProviderEnum,
  model: z.string().min(1),
  fallbackProvider: LlmProviderEnum.nullable().optional(),
  fallbackModel: z.string().nullable().optional(),
  baseUrlOverride: z.string().url().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  reasoningEffort: ReasoningEffortEnum.nullable().optional(),
});


/**
 * The full set of standard selector fields.
 *
 * For runtime validation of arbitrary/custom field names, use
 * `SelectorFieldOrString` or `z.string()` directly.
 */
export const SelectorFieldEnum = z.enum([
  'titleSelector',
  'priceSelector',
  'descriptionSelector',
  'brandSelector',
  'imagesSelector',
]);
export type SelectorField = z.infer<typeof SelectorFieldEnum>;

/**
 * A selector field that is either a known standard field or an
 * arbitrary string (for custom/dynamic fields).
 */
export const SelectorFieldOrString = z.union([SelectorFieldEnum, z.string()]);
export type SelectorFieldOrString = z.infer<typeof SelectorFieldOrString>;

/**
 * Active selector fields managed in review and approval.
 *
 * This list is kept as the core subset for backward compatibility.
 * The canonical full list lives in `src/shared/profile-fields.ts`
 * as `PROMOTABLE_PROFILE_KEYS`.
 */
export const SELECTOR_FIELDS: readonly string[] = [
  'titleSelector',
  'descriptionSelector',
  'imagesSelector',
  'priceSelector',
  'brandSelector',
];

/** Profile generation audit status values. */
export const ProfileGenerationStatusEnum = z.enum([
  'proposed',
  'validated',
  'rejected',
  'promoted',
  'failed',
]);
export type ProfileGenerationStatus = z.infer<typeof ProfileGenerationStatusEnum>;

/** Profile generation revision status values. */
export const ProfileGenerationRevisionStatusEnum = z.enum([
  'draft',
  'validated',
  'rejected',
  'superseded',
]);
export type ProfileGenerationRevisionStatus = z.infer<typeof ProfileGenerationRevisionStatusEnum>;

/** Profile generation revision source values. */
export const ProfileGenerationRevisionSourceEnum = z.enum([
  'initial_generation',
  'manager_feedback',
  'manual_css',
  'system_validation',
]);
export type ProfileGenerationRevisionSource = z.infer<typeof ProfileGenerationRevisionSourceEnum>;

/** Per-field decision values. */
export const ProfileFieldDecisionTypeEnum = z.enum([
  'approved',
  'rejected',
  'rolled_back',
]);
export type ProfileFieldDecisionType = z.infer<typeof ProfileFieldDecisionTypeEnum>;

/** Per-field/per-sample validation result status. */
export const ProfileGenerationValidationStatusEnum = z.enum(['pass', 'warning', 'fail']);
export type ProfileGenerationValidationStatus = z.infer<typeof ProfileGenerationValidationStatusEnum>;

export const ProfileGenerationGenerationSchema = z.object({
  id: z.string(),
  domain: z.string(),
  sourceUrl: z.string(),
  expectedName: z.string().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  selectors: z.record(z.string(), z.unknown()).default(() => ({})),
  fieldSamples: z.record(z.string(), z.unknown()).nullable().default(null),
  validation: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ProfileGenerationStatusEnum,
  confidence: z.number(),
  llmProvider: z.string().nullable().default(null),
  llmModel: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  promotedAt: z.string().nullable().default(null),
});
export type ProfileGenerationGeneration = z.infer<typeof ProfileGenerationGenerationSchema>;

export const ProfileGenerationRevisionSchema = z.object({
  id: z.string(),
  generationId: z.string(),
  revisionNumber: z.number().int(),
  parentRevisionId: z.string().nullable().default(null),
  source: ProfileGenerationRevisionSourceEnum,
  feedback: z.record(z.string(), z.unknown()).nullable().default(null),
  selectors: z.record(z.string(), z.unknown()).default(() => ({})),
  fieldSamples: z.record(z.string(), z.unknown()).nullable().default(null),
  validationSummary: z.record(z.string(), z.unknown()).nullable().default(null),
  status: ProfileGenerationRevisionStatusEnum,
  confidence: z.number(),
  llmTask: z.string().nullable().default(null),
  llmProvider: z.string().nullable().default(null),
  llmModel: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProfileGenerationRevision = z.infer<typeof ProfileGenerationRevisionSchema>;

export const ProfileGenerationValidationResultSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  selectorField: SelectorFieldOrString,
  sampleUrl: z.string(),
  itemId: z.string().nullable().default(null),
  expectedName: z.string().nullable().default(null),
  brandHint: z.string().nullable().default(null),
  extractedValue: z.record(z.string(), z.unknown()).nullable().default(null),
  imagePreviews: z.array(z.string()).nullable().default(null),
  warnings: z.array(z.string()).nullable().default(null),
  status: ProfileGenerationValidationStatusEnum,
  createdAt: z.string(),
});
export type ProfileGenerationValidationResult = z.infer<typeof ProfileGenerationValidationResultSchema>;

export const ProfileGenerationFieldDecisionSchema = z.object({
  id: z.string(),
  generationId: z.string(),
  revisionId: z.string().nullable().default(null),
  domain: z.string(),
  selectorField: SelectorFieldOrString,
  decision: ProfileFieldDecisionTypeEnum,
  previousSelector: z.string().nullable().default(null),
  proposedSelector: z.string().nullable().default(null),
  approvedSelector: z.string().nullable().default(null),
  feedback: z.record(z.string(), z.unknown()).nullable().default(null),
  validationResultIds: z.array(z.string()).nullable().default(null),
  decidedAt: z.string(),
  decidedBy: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type ProfileGenerationFieldDecision = z.infer<typeof ProfileGenerationFieldDecisionSchema>;

/** Structured feedback supplied by the store manager when a revision
 *  is not correct. Designed to be UI-friendly: the operator should not
 *  have to write CSS. The AI revises the revision from this
 *  feedback. */
export const StructuredFeedbackTextSchema = z.object({
  kind: z.literal('text'),
  field: SelectorFieldOrString,
  /** Whether the operator thinks the currently-extracted value is correct. */
  currentValueCorrect: z.boolean().optional(),
  /** The expected/correct value, when not correct. */
  expectedValue: z.string().optional(),
  notes: z.string().optional(),
});

export const StructuredFeedbackImageSchema = z.object({
  kind: z.literal('images'),
  /** Per-URL verdict. URLs not in the map are ignored. */
  perImage: z.record(z.string(), z.enum(['correct', 'exclude', 'include'])).default(() => ({})),
  /** Hint that images look like recommendation/carousel content. */
  looksLikeRecommendations: z.boolean().optional(),
  /** Free-form note (advanced). */
  notes: z.string().optional(),
});

export const StructuredFeedbackPriceSchema = z.object({
  kind: z.literal('price'),
  /** Whether to ignore the price field for this domain. */
  ignoreForDomain: z.boolean().optional(),
  /** Expected price string. */
  expectedValue: z.string().optional(),
  notes: z.string().optional(),
});

export const StructuredFeedbackSchema = z.union([
  StructuredFeedbackTextSchema,
  StructuredFeedbackImageSchema,
  StructuredFeedbackPriceSchema,
]);
export type StructuredFeedback = z.infer<typeof StructuredFeedbackSchema>;

/** Per-field approval payload sent by the operator. Only `true`
 *  fields are written to `extractor_profiles`.
 *
 * Accepts both standard fields (SelectorFieldEnum) and arbitrary
 * custom field names (strings). At least one field must be `true`. */
export const ApprovedSelectorFieldsSchema = z
  .record(z.union([SelectorFieldEnum, z.string()]), z.boolean())
  .refine(
    (v) => Object.values(v).some((x) => x === true),
    { message: 'At least one selector field must be set to true' },
  );

/** Approval request body for a single revision. */
export const ApproveRevisionFieldsRequestSchema = z.object({
  approvedFields: ApprovedSelectorFieldsSchema,
  feedback: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
  /** Required when approving `imagesSelector` — operator must
   *  attest they reviewed the image previews. */
  imagePreviewsReviewed: z.boolean().optional(),
});

/** Rejection request body for a single revision. */
export const RejectRevisionFieldsRequestSchema = z.object({
  rejectedFields: z.array(z.union([SelectorFieldEnum, z.string()])).min(1),
  reason: z.string().nullable().optional(),
  feedback: z.record(z.string(), z.unknown()).nullable().optional(),
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});

/** Rollback request body. */
export const RollbackFieldRequestSchema = z.object({
  notes: z.string().nullable().optional(),
  decidedBy: z.string().nullable().optional(),
});

/** Request body for creating a new revision from structured feedback. */
export const ReviseFromFeedbackRequestSchema = z.object({
  parentRevisionId: z.string().nullable().optional(),
  feedback: StructuredFeedbackSchema,
  notes: z.string().nullable().optional(),
});

/** Request body for re-validating a revision across confirmed samples. */
export const ValidateRevisionRequestSchema = z.object({
  sampleLimit: z.number().int().min(1).max(50).optional(),
  notes: z.string().nullable().optional(),
});

/** Domain profile governance summary. */
export const ValidationSampleRefSchema = z.object({
  url: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  itemId: z.string(),
  confirmed: z.boolean(),
});
export type ValidationSampleRef = z.infer<typeof ValidationSampleRefSchema>;

export const DomainProfileGovernanceSchema = z.object({
  domain: z.string(),
  activeProfile: ExtractorProfileSchema.nullable().default(null),
  generations: z.array(ProfileGenerationGenerationSchema).default(() => []),
  revisions: z.array(ProfileGenerationRevisionSchema).default(() => []),
  fieldDecisions: z.array(ProfileGenerationFieldDecisionSchema).default(() => []),
  validationSampleCount: z.number().int().default(0),
  validationSamples: z.array(ValidationSampleRefSchema).default(() => []),
});
export type DomainProfileGovernance = z.infer<typeof DomainProfileGovernanceSchema>;

// ── Discovery Run Schemas ──────────────────────────────────────────

export const DiscoveryRunTriggerEnum = z.enum([
  'automatic',    // initial worker-triggered run
  'refinement',   // operator-supplied search terms
  'direct_url',   // operator-supplied URL to verify
]);
export type DiscoveryRunTrigger = z.infer<typeof DiscoveryRunTriggerEnum>;

export const DiscoveryRunStatusEnum = z.enum([
  'queued',       // waiting for worker claim
  'running',      // worker is executing steps
  'completed',    // finished with outcome
  'failed',       // unrecoverable error
]);
export type DiscoveryRunStatus = z.infer<typeof DiscoveryRunStatusEnum>;

export const DiscoveryRunStepEnum = z.enum([
  'preflight',              // validating brand/domain setup
  'sitemap_fetch',          // fetching/caching official sitemap
  'sitemap_match',          // matching sitemap URLs to product
  'variant_resolution',     // resolving Shopify/product variants
  'page_verification',      // fetching and verifying page content
  'ranking',                // ranking and assigning recommendation tiers
  'applying_outcome',       // persisting final outcome to item
]);
export type DiscoveryRunStep = z.infer<typeof DiscoveryRunStepEnum>;

export const DiscoveryOutcomeEnum = z.enum([
  'auto_selected',             // system auto-confirmed a source
  'needs_input_candidates',    // candidates available, operator must choose
  'needs_input_no_candidates', // no candidates found
  'needs_input_ambiguous',     // ambiguous variant/product family
  'needs_input_setup',         // brand/domain setup incomplete
  'failed',                    // unrecoverable error
]);
export type DiscoveryOutcome = z.infer<typeof DiscoveryOutcomeEnum>;

export const RecommendationTierEnum = z.enum([
  'verified_official',     // official domain + exact identifier match
  'likely_official',       // official domain + strong signals
  'third_party_evidence',  // non-official domain with identity evidence
  'not_product',           // page does not appear to be a product page
]);
export type RecommendationTier = z.infer<typeof RecommendationTierEnum>;

export const SourceReviewDecisionEnum = z.enum([
  'accepted',   // operator accepted this candidate as the source
  'rejected',   // operator rejected this candidate
  'pending',    // no decision yet
]);
export type SourceReviewDecision = z.infer<typeof SourceReviewDecisionEnum>;

/**
 * A single piece of page-verification evidence for a discovery candidate,
 * suitable for display in the discovery console UI.
 */
export const VerificationEvidenceSchema = z.object({
  signal: z.string(),
  present: z.boolean(),
  detail: z.string().nullable(),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

// ── Request/Response Schemas ───────────────────────────────────────

export const DiscoveryRunRequestSchema = z.object({
  trigger: DiscoveryRunTriggerEnum,
  query: z.string().optional(),
  url: z.string().optional(),
  options: z.object({
    skipSitemap: z.boolean().optional(),
    skipNameConsolidation: z.boolean().optional(),
    allowThirdParty: z.boolean().optional(),
  }).optional(),
});

export const DiscoveryRunSummarySchema = z.object({
  runId: z.string(),
  trigger: DiscoveryRunTriggerEnum,
  status: DiscoveryRunStatusEnum,
  currentStep: DiscoveryRunStepEnum.nullable(),
  outcome: DiscoveryOutcomeEnum.nullable(),
  candidateCount: z.number(),
  message: z.string().nullable(),
  topCandidate: z.object({
    url: z.string(),
    domain: z.string().nullable(),
    title: z.string().nullable(),
    recommendation: RecommendationTierEnum,
    confidence: z.number(),
  }).nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const DiscoveryCardSummarySchema = z.object({
  itemId: z.string(),
  hasSource: z.boolean(),
  sourceUrl: z.string().nullable(),
  sourceType: SourceTypeEnum.default('official_page'),
  stageStatus: StageStatusEnum,
  latestRun: DiscoveryRunSummarySchema.nullable(),
  actionableReason: z.string().nullable(),
  availableActions: z.array(z.enum([
    'accept_candidate', 'reject_candidate', 'review_all',
    'search_again', 'verify_url', 'assign_brand', 'assign_domain',
  ])),
  brandHint: z.string().nullable(),
  officialDomains: z.array(z.string()),                                                                                                 });

export const DistributorEvidenceAttemptViewSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  distributorConnectionId: z.string().nullable().optional(),
  catalogSnapshotId: z.string().nullable().optional(),
  lookupUpc: z.string(),
  outcome: z.enum(['found', 'not_stocked', 'source_error']),
  confidence: z.number().min(0).max(1),
  evidenceUrl: z.string().nullable(),
  productName: z.string().nullable(),
  brand: z.string().nullable(),
  description: z.string().nullable(),
  imageUrls: z.array(z.string()).default(() => []),
  warnings: z.array(z.string()).default(() => []),
  errorCode: z.string().nullable().optional(),
  errorMessage: z.string().nullable(),
  catalogVersion: z.string().nullable().optional(),
  observedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  /** Immutable sourcing generation this attempt belongs to (ADR 0014). */
  sourcingGenerationId: z.string().nullable().optional(),
  createdAt: z.string(),
  /** Whether this attempt is accepted in the item's current acceptedEvidenceAttemptIds. */
  isAccepted: z.boolean().default(false),
  /** Validated ProductIdentityEvidence parsed from identityJson. */
  identity: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DistributorEvidenceAttemptView = z.infer<typeof DistributorEvidenceAttemptViewSchema>;

export const AcceptEvidenceRequestSchema = z.object({
  evidenceAttemptId: z.string().min(1),
  includeImages: z.boolean().default(false),
});
export type AcceptEvidenceRequest = z.infer<typeof AcceptEvidenceRequestSchema>;

export const DiscoveryConsoleDetailSchema = z.object({
  itemId: z.string(),
  itemName: z.string(),
  itemUpc: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  officialDomains: z.array(z.string()),
  sourceUrl: z.string().nullable(),
  sourceType: SourceTypeEnum.default('official_page'),
  /** sourceConfirmed is true when acceptedEvidenceAttemptIds is non-empty or sourceUrl is set. */
  sourceConfirmed: z.boolean(),
  /** @deprecated Use acceptedEvidenceAttemptIds. */
  acceptedEvidenceAttemptId: z.string().nullable(),
  acceptedEvidenceAttemptIds: z.array(z.string()).default(() => []),
  evidenceAttempts: z.array(DistributorEvidenceAttemptViewSchema).default(() => []),
  latestRun: DiscoveryRunSummarySchema.nullable(),
  candidates: z.array(z.object({
    id: z.string(),
    url: z.string(),
    title: z.string().nullable(),
    snippet: z.string().nullable(),
    domain: z.string().nullable(),
    confidence: z.number(),
    recommendation: RecommendationTierEnum,
    sourceMethod: z.string(),
    verificationScore: z.number().nullable(),
    verificationEvidence: z.array(z.object({
      signal: z.string(), present: z.boolean(), detail: z.string().nullable(),
    })).nullable(),
    warnings: z.array(z.string()),
    reviewStatus: SourceReviewDecisionEnum,
    isSelected: z.boolean(),
    metadataJson: z.string().nullable(),
  })),
  runs: z.array(DiscoveryRunSummarySchema),
});

export const DiscoverySearchRequestSchema = z.object({
  query: z.string().min(1).max(200),
});

export const DiscoveryVerifyUrlRequestSchema = z.object({
  url: z.string().url(),
});

export const DiscoveryCandidateDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  allowThirdParty: z.boolean().optional().default(false),
});

export const SourceStrategyEnum = z.enum(['official_first', 'retailer_preferred', 'any_best_quality']);
export type SourceStrategy = z.infer<typeof SourceStrategyEnum>;

// ── Batch Setup Schemas ────────────────────────────────────────────

export const BatchBrandAssignmentSchema = z.object({
  itemId: z.string(),
  brandHint: z.string().min(1),
  brandDomain: z.string().min(1),
  sourceStrategy: SourceStrategyEnum.optional().default('official_first'),
});

export const BatchDiscoverySetupSchema = z.object({
  assignments: z.array(BatchBrandAssignmentSchema).min(1).max(1000),
});

// Type exports for Discovery schemas
export type DiscoveryRunRequest = z.infer<typeof DiscoveryRunRequestSchema>;
export type DiscoveryRunSummary = z.infer<typeof DiscoveryRunSummarySchema>;
export type DiscoveryCardSummary = z.infer<typeof DiscoveryCardSummarySchema>;
export type DiscoveryConsoleDetail = z.infer<typeof DiscoveryConsoleDetailSchema>;
export type DiscoverySearchRequest = z.infer<typeof DiscoverySearchRequestSchema>;
export type DiscoveryVerifyUrlRequest = z.infer<typeof DiscoveryVerifyUrlRequestSchema>;
export type DiscoveryCandidateDecision = z.infer<typeof DiscoveryCandidateDecisionSchema>;
export type BatchBrandAssignment = z.infer<typeof BatchBrandAssignmentSchema>;
export type BatchDiscoverySetup = z.infer<typeof BatchDiscoverySetupSchema>;

// ─── Brand Site ─────────────────────────────────────────────────────────────────

export const BrandSiteSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  domain: z.string(),
  urlPattern: z.string().nullable(),
  successCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  sourceStrategy: SourceStrategyEnum.optional().default('official_first'),
  createdAt: z.string(),
});

export type BrandSite = z.infer<typeof BrandSiteSchema>;

// ─── Domain Diagnostics ────────────────────────────────────────────────────────

/**
 * Health values stored in `domain_status`. The diagnostics surface also
 * uses an additional `'unknown'` literal for domains that have no row
 * at all (no health probe has ever been recorded for that domain).
 */
export const DomainHealthStatusEnum = z.enum([
  'ok',
  'blocked',
  'offline',
  'mismatch',
  'unknown',
]);
export type DomainHealthStatus = z.infer<typeof DomainHealthStatusEnum>;

export const DomainDiagnosticsBrandAssociationSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  successCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
});
export type DomainDiagnosticsBrandAssociation = z.infer<
  typeof DomainDiagnosticsBrandAssociationSchema
>;

export const DomainDiagnosticsEntrySchema = z.object({
  domain: z.string(),
  hasActiveProfile: z.boolean(),
  activeProfileId: z.string().nullable(),
  profileUpdatedAt: z.string().nullable(),
  sitemapUrlsCount: z.number().int(),
  sitemapFetchedAt: z.string().nullable(),
  sitemapExpiresAt: z.string().nullable(),
  sitemapSourceUrl: z.string().nullable(),
  sitemapStale: z.boolean(),
  healthStatus: DomainHealthStatusEnum,
  healthCheckedAt: z.string().nullable(),
  healthReason: z.string().nullable(),
  healthStale: z.boolean(),
  brandAssociations: z.array(DomainDiagnosticsBrandAssociationSchema),
  generationCount: z.number().int(),
  latestGenerationStatus: ProfileGenerationStatusEnum.nullable(),
  latestGenerationAt: z.string().nullable(),
});
export type DomainDiagnosticsEntry = z.infer<typeof DomainDiagnosticsEntrySchema>;

export const DomainDiagnosticsResponseSchema = z.object({
  entries: z.array(DomainDiagnosticsEntrySchema),
  generatedAt: z.string(),
});
export type DomainDiagnosticsResponse = z.infer<typeof DomainDiagnosticsResponseSchema>;

// ─── Sitemap Health & Brand URL Index Schemas (Epic #61) ──────────────────────

export const SitemapHealthStatusEnum = z.enum([
  'healthy',
  'stale',
  'missing',
  'error',
  'blocked',
  'unknown',
]);
export type SitemapHealthStatus = z.infer<typeof SitemapHealthStatusEnum>;

export const DomainSitemapSummarySchema = z.object({
  domain: z.string(),
  status: SitemapHealthStatusEnum,
  statusReason: z.string().nullable(),
  needsAttention: z.boolean(),
  attentionReasons: z.array(z.string()),
  totalUrlsCount: z.number().int(),
  productUrlsCount: z.number().int(),
  activeUrlsCount: z.number().int(),
  inactiveUrlsCount: z.number().int(),
  sitemapSourceUrl: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  lastRefreshDurationMs: z.number().nullable(),
  lastRefreshStatus: z.enum(['success', 'failed', 'blocked']).nullable(),
  lastRefreshAddedCount: z.number().int(),
  lastRefreshRemovedCount: z.number().int(),
  localHitRate: z.number(),
  totalLookups: z.number().int(),
  brandAssociations: z.array(DomainDiagnosticsBrandAssociationSchema).optional().default(() => []),
  productUrlPattern: z.string().nullable().optional(),
});
export type DomainSitemapSummary = z.infer<typeof DomainSitemapSummarySchema>;

export const SitemapsOverviewResponseSchema = z.object({
  domains: z.array(DomainSitemapSummarySchema),
  totals: z.object({
    totalDomains: z.number().int(),
    healthyCount: z.number().int(),
    staleCount: z.number().int(),
    errorCount: z.number().int(),
    missingCount: z.number().int(),
    needsAttentionCount: z.number().int(),
    totalIndexedUrls: z.number().int(),
    totalProductUrls: z.number().int(),
    overallLocalHitRate: z.number(),
  }),
  generatedAt: z.string(),
});
export type SitemapsOverviewResponse = z.infer<typeof SitemapsOverviewResponseSchema>;

export const SitemapRefreshHistoryItemSchema = z.object({
  id: z.string(),
  domain: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum(['success', 'failed', 'blocked']),
  sourceUrl: z.string().nullable(),
  totalUrlsObserved: z.number().int(),
  productUrlsEligible: z.number().int(),
  addedCount: z.number().int(),
  updatedCount: z.number().int(),
  inactivatedCount: z.number().int(),
  durationMs: z.number().int(),
  errorMessage: z.string().nullable(),
  httpStatus: z.number().nullable(),
});
export type SitemapRefreshHistoryItem = z.infer<typeof SitemapRefreshHistoryItemSchema>;

export const BrandUrlItemSchema = z.object({
  id: z.string(),
  domain: z.string(),
  url: z.string(),
  path: z.string(),
  slug: z.string().nullable(),
  pageType: z.enum(['product', 'category', 'article', 'other', 'unknown']),
  sitemapSourceUrl: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastSitemapRefreshAt: z.string(),
  active: z.number().int(),
  lastmod: z.string().nullable(),
  title: z.string().nullable(),
  h1: z.string().nullable(),
  upc: z.string().nullable(),
  sku: z.string().nullable(),
  mpn: z.string().nullable(),
  brand: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  extractionStatus: z.string().nullable(),
});
export type BrandUrlItem = z.infer<typeof BrandUrlItemSchema>;

export const BrandUrlsListResponseSchema = z.object({
  domain: z.string(),
  urls: z.array(BrandUrlItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type BrandUrlsListResponse = z.infer<typeof BrandUrlsListResponseSchema>;

export const SitemapDomainDetailResponseSchema = z.object({
  summary: DomainSitemapSummarySchema,
  history: z.array(SitemapRefreshHistoryItemSchema),
  productUrlPattern: z.string().nullable(),
});
export type SitemapDomainDetailResponse = z.infer<typeof SitemapDomainDetailResponseSchema>;

export const SitemapTestLookupRequestSchema = z.object({
  upc: z.string().optional(),
  name: z.string().optional(),
  sku: z.string().optional(),
  brandHint: z.string().optional(),
  price: z.number().optional(),
});
export type SitemapTestLookupRequest = z.infer<typeof SitemapTestLookupRequestSchema>;

export const SitemapTestLookupCandidateSchema = z.object({
  url: z.string(),
  confidence: z.number(),
  sourceMethod: z.string(),
  matchType: z.string(),
  title: z.string().nullable().optional(),
  upc: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  signals: z.object({
    upcMatched: z.boolean(),
    skuMatched: z.boolean(),
    tokenOverlapRatio: z.number(),
    patternMatched: z.boolean(),
    llmSelected: z.boolean(),
    enrichedMetadataPresent: z.boolean(),
  }),
});
export type SitemapTestLookupCandidate = z.infer<typeof SitemapTestLookupCandidateSchema>;

export const SitemapTestLookupResponseSchema = z.object({
  domain: z.string(),
  candidates: z.array(SitemapTestLookupCandidateSchema),
  testedAt: z.string(),
});
export type SitemapTestLookupResponse = z.infer<typeof SitemapTestLookupResponseSchema>;

// ─── Brand Hub (Refactor e35s10) ───────────────────────────────────────────────────
// Thin view-model hub that joins extractor profile + sitemap/brand-url signals
// domain-keyed, read-only, mirrors SitemapsOverview shape plus profile enrichment.
export const BrandHubProfileStatusEnum = z.enum(['missing', 'partial', 'complete']);
export type BrandHubProfileStatus = z.infer<typeof BrandHubProfileStatusEnum>;

export const BrandHubRowSchema = z.object({
  domain: z.string(),
  normalizedDomain: z.string(),
  profile: z.object({
    exists: z.boolean(),
    status: BrandHubProfileStatusEnum,
    sitemapProductUrlPattern: z.string().nullable(),
    runtime: z.enum(['static', 'rendered']).nullable(),
  }),
  sitemap: z
    .object({
      status: z.string(),
      needsAttention: z.boolean(),
      attentionReasons: z.array(z.string()),
      lastRefreshedAt: z.string().nullable(),
    })
    .nullable(),
  urlCounts: z.object({
    totalCount: z.number().int(),
    activeCount: z.number().int(),
    inactiveCount: z.number().int(),
    productCount: z.number().int(),
  }),
  brandAssociations: z.array(BrandSiteSchema),
});
export type BrandHubRow = z.infer<typeof BrandHubRowSchema>;

export const BrandHubOverviewResponseSchema = z.object({
  rows: z.array(BrandHubRowSchema),
  totals: z.object({
    totalDomains: z.number().int(),
    healthyCount: z.number().int(),
    needsAttentionCount: z.number().int(),
    totalProductUrls: z.number().int(),
  }),
  generatedAt: z.string(),
});
export type BrandHubOverviewResponse = z.infer<typeof BrandHubOverviewResponseSchema>;

export const ProfileBlockedItemSchema = z.object({
  itemId: z.string(),
  upc: z.string(),
  name: z.string(),
  expectedName: z.string().nullable(),
  brandHint: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  blockedAt: z.string(),
});
export type ProfileBlockedItem = z.infer<typeof ProfileBlockedItemSchema>;

// ─── Batch Preflight & Controlled Release ─────────────────────────────────────

export const PreflightSampleProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  upc: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
});
export type PreflightSampleProduct = z.infer<typeof PreflightSampleProductSchema>;

export const PreflightBrandGroupSchema = z.object({
  key: z.string(),
  suggestedBrand: z.string().nullable(),
  itemCount: z.number().int(),
  itemIds: z.array(z.string()),
  sampleProductNames: z.array(z.string()),
  sampleProducts: z.array(PreflightSampleProductSchema).optional(),
});
export type PreflightBrandGroup = z.infer<typeof PreflightBrandGroupSchema>;

export const PreflightDomainBlockerSchema = z.object({
  brand: z.string(),
  itemCount: z.number().int(),
  itemIds: z.array(z.string()),
  urlPattern: z.string().nullable().optional(),
  sampleProductNames: z.array(z.string()).optional(),
  sampleProducts: z.array(PreflightSampleProductSchema).optional(),
});
export type PreflightDomainBlocker = z.infer<typeof PreflightDomainBlockerSchema>;

export const PreflightRoutingBlockerSchema = z.object({
  brand: z.string(),
  itemCount: z.number().int(),
  itemIds: z.array(z.string()),
  preferredDistributorIds: z.array(z.string()).default(() => []),
  sourcingPolicy: z.enum(['advisory', 'preferred_then_fallback', 'preferred_only']).default('preferred_then_fallback'),
  sampleProductNames: z.array(z.string()).optional(),
  sampleProducts: z.array(PreflightSampleProductSchema).optional(),
});
export type PreflightRoutingBlocker = z.infer<typeof PreflightRoutingBlockerSchema>;

export const BatchPreflightMetricsSchema = z.object({
  brandResolvedCount: z.number().int(),
  brandResolvedPercent: z.number(),
  ambiguousBrandCount: z.number().int(),
  missingBrandCount: z.number().int(),
  domainMappedCount: z.number().int(),
  domainMappedPercent: z.number(),
  missingDomainBrandCount: z.number().int(),
  distributorRoutedCount: z.number().int(),
  distributorRoutedPercent: z.number(),
  unroutedBrandCount: z.number().int(),
});
export type BatchPreflightMetrics = z.infer<typeof BatchPreflightMetricsSchema>;

export const BatchPreflightBlockersSchema = z.object({
  needsBrandGroups: z.array(PreflightBrandGroupSchema),
  missingDomainBrands: z.array(PreflightDomainBlockerSchema),
  unroutedBrands: z.array(PreflightRoutingBlockerSchema),
});
export type BatchPreflightBlockers = z.infer<typeof BatchPreflightBlockersSchema>;

export const PreflightAvailableDistributorSchema = z.object({
  id: z.string(),
  distributorId: z.string(),
  connectorType: z.string(),
  enabled: z.boolean(),
});
export type PreflightAvailableDistributor = z.infer<typeof PreflightAvailableDistributorSchema>;

export const BatchPreflightResponseSchema = z.object({
  batchId: z.string(),
  batchName: z.string(),
  executionState: BatchExecutionStateEnum,
  totalItems: z.number().int(),
  readyCount: z.number().int(),
  heldCount: z.number().int(),
  readyItemIds: z.array(z.string()),
  heldItemIds: z.array(z.string()),
  metrics: BatchPreflightMetricsSchema,
  blockers: BatchPreflightBlockersSchema,
  availableDistributors: z.array(PreflightAvailableDistributorSchema),
  knownBrands: z.array(z.string()).optional(),
});
export type BatchPreflightResponse = z.infer<typeof BatchPreflightResponseSchema>;

export { SourcingPolicyEnum, type SourcingPolicy } from './distributor';
