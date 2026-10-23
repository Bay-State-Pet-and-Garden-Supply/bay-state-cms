import { z } from 'zod';

export const EvidenceHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z.string().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });
const PublicReferenceUrlSchema = z.string().url().max(4000).refine((value) => {
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
}, 'Evidence references must be credential-free HTTP(S) URLs');

export const ItemEvidenceSourceRoleSchema = z.enum([
  'manufacturer_official',
  'distributor_record',
  'retailer_corroboration',
  'operator_attested',
]);
export type ItemEvidenceSourceRole = z.infer<typeof ItemEvidenceSourceRoleSchema>;

export const ItemEvidenceCollectionMethodSchema = z.enum([
  'structured', 'static_extraction', 'rendered_browser', 'manual', 'ocr',
]);
export type ItemEvidenceCollectionMethod = z.infer<typeof ItemEvidenceCollectionMethodSchema>;

export const ItemEvidenceIdentitySchema = z.object({
  itemId: IdSchema,
  sku: z.string().min(1).max(128),
  inputHash: EvidenceHashSchema,
  outcome: z.enum(['confirmed', 'needs_operator', 'conflict']),
  proofType: z.enum(['gtin', 'name_variant', 'operator_attestation']),
  proofHash: EvidenceHashSchema,
  variantKey: z.string().min(1).max(500).nullable(),
  attestationId: IdSchema.nullable(),
  reasons: z.array(z.string().min(1).max(500)).max(32),
}).strict();
export type ItemEvidenceIdentity = z.infer<typeof ItemEvidenceIdentitySchema>;

export const ItemEvidenceObservationSchema = z.object({
  id: IdSchema,
  sourceRole: ItemEvidenceSourceRoleSchema,
  collectedVia: ItemEvidenceCollectionMethodSchema,
  authorityId: IdSchema,
  authorityHash: EvidenceHashSchema,
  sourceUrl: PublicReferenceUrlSchema.nullable(),
  finalUrl: PublicReferenceUrlSchema.nullable(),
  connectorRecordId: z.string().min(1).max(500).nullable(),
  generationId: IdSchema.nullable(),
  observedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  contentType: z.enum(['text/plain', 'application/json']),
  content: z.string().min(1).max(262144),
  artifactHash: EvidenceHashSchema,
  complete: z.literal(true),
  identity: ItemEvidenceIdentitySchema,
  modelCallIds: z.array(IdSchema).max(32),
}).strict();
export type ItemEvidenceObservation = z.infer<typeof ItemEvidenceObservationSchema>;

export const ItemEvidenceReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text_span'),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }).strict().refine((span) => span.end > span.start, 'Evidence span must be nonempty'),
  z.object({ kind: z.literal('json_pointer'), pointer: z.string().max(2000) }).strict(),
]);

export const ItemEvidenceRightsSchema = z.object({
  assetUrl: PublicReferenceUrlSchema,
  approvalId: IdSchema,
  authorityHash: EvidenceHashSchema,
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
}).strict();
export type ItemEvidenceRights = z.infer<typeof ItemEvidenceRightsSchema>;

export const AcceptedItemFactSchema = z.object({
  id: IdSchema,
  field: z.string().min(1).max(128),
  value: z.string().min(1).max(32768),
  unit: z.string().min(1).max(64).nullable(),
  observationId: IdSchema,
  reference: ItemEvidenceReferenceSchema,
  rawValue: z.string().min(1).max(32768),
  normalization: z.enum(['verbatim', 'whitespace', 'quantity']),
  valueHash: EvidenceHashSchema,
  rights: ItemEvidenceRightsSchema.nullable(),
}).strict();
export type AcceptedItemFact = z.infer<typeof AcceptedItemFactSchema>;

export const ItemEvidenceFindingSchema = z.object({
  field: z.string().min(1).max(128).nullable(),
  observationId: IdSchema.nullable(),
  code: z.string().min(1).max(100),
  reason: z.string().min(1).max(1000),
}).strict();
export type ItemEvidenceFinding = z.infer<typeof ItemEvidenceFindingSchema>;

export const AcceptedItemEvidenceSchema = z.object({
  recordVersion: z.literal(1),
  id: IdSchema,
  workspaceId: IdSchema,
  batchId: IdSchema,
  itemId: IdSchema,
  sku: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  inputHash: EvidenceHashSchema,
  sourceStateHash: EvidenceHashSchema,
  authorityHash: EvidenceHashSchema,
  registerName: z.string().max(2000),
  importedPrice: z.string().max(128).nullable(),
  observations: z.array(ItemEvidenceObservationSchema).max(64),
  facts: z.array(AcceptedItemFactSchema).max(512),
  submittedFactReferences: z.array(z.object({
    observationId: IdSchema,
    field: z.string().min(1).max(128),
    reference: ItemEvidenceReferenceSchema,
    rightsApprovalId: IdSchema.nullable(),
  }).strict()).max(512),
  findings: z.array(ItemEvidenceFindingSchema).max(512),
  evidenceHash: EvidenceHashSchema,
  rulesVersion: z.string().min(1).max(128),
  producingRunId: IdSchema.nullable(),
  acceptedAt: TimestampSchema,
}).strict();
export type AcceptedItemEvidence = z.infer<typeof AcceptedItemEvidenceSchema>;

export const ItemExecutionCurrentnessSchema = z.object({
  recordVersion: z.literal(1),
  inputRevision: EvidenceHashSchema,
  evidenceId: IdSchema,
  evidenceRevision: z.number().int().positive(),
  evidenceHash: EvidenceHashSchema,
  inputHash: EvidenceHashSchema,
  sourceStateHash: EvidenceHashSchema,
  authorityHash: EvidenceHashSchema,
  configSnapshotId: IdSchema.nullable(),
  configSnapshotHash: EvidenceHashSchema,
  runtimeSnapshotId: IdSchema.nullable(),
  runtimeSnapshotHash: EvidenceHashSchema,
  policyDigest: EvidenceHashSchema,
  classificationRunId: IdSchema,
  classificationOutputHash: EvidenceHashSchema,
  runCurrentnessHash: EvidenceHashSchema,
}).strict();
export type ItemExecutionCurrentness = z.infer<typeof ItemExecutionCurrentnessSchema>;

export const GroundedCopyProvenanceSchema = z.object({
  status: z.enum(['prepared', 'blocked']),
  evidenceId: IdSchema,
  evidenceRevision: z.number().int().positive(),
  evidenceHash: EvidenceHashSchema,
  currentnessHash: EvidenceHashSchema,
  descriptionHash: EvidenceHashSchema,
  factIds: z.array(IdSchema).min(1).max(512),
  callIds: z.array(IdSchema).max(64),
  producer: z.object({
    operation: z.literal('distributor_copy_consolidation'),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(200),
    policyDigest: EvidenceHashSchema,
    promptVersion: z.string().min(1).max(200),
    rulesVersion: z.string().min(1).max(200),
  }).strict(),
}).strict();
export type GroundedCopyProvenance = z.infer<typeof GroundedCopyProvenanceSchema>;

export const ListingRequirementSchema = z.object({
  id: IdSchema,
  field: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  kind: z.enum(['field', 'identity', 'image_rights', 'safety', 'classification']),
  required: z.boolean(),
  exceptionEligible: z.boolean(),
  allowedSourceRoles: z.array(ItemEvidenceSourceRoleSchema).min(1).max(4),
  applicableWhen: z.object({
    attributeId: IdSchema,
    values: z.array(z.string().min(1).max(500)).min(1).max(128),
  }).strict().nullable(),
}).strict();
export type ListingRequirement = z.infer<typeof ListingRequirementSchema>;

export const ListingCompletenessStandardSchema = z.object({
  recordVersion: z.literal(1),
  id: IdSchema,
  revision: z.number().int().positive(),
  categoryId: IdSchema,
  productTypeId: IdSchema,
  requirements: z.array(ListingRequirementSchema).min(1).max(64),
  standardHash: EvidenceHashSchema,
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
}).strict();
export type ListingCompletenessStandard = z.infer<typeof ListingCompletenessStandardSchema>;

export const ListingCompletenessExceptionSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  itemId: IdSchema,
  sku: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  requirementId: IdSchema,
  standardId: IdSchema,
  standardHash: EvidenceHashSchema,
  classificationHash: EvidenceHashSchema,
  inputHash: EvidenceHashSchema,
  dependencyHash: EvidenceHashSchema,
  decision: z.enum(['approved', 'revoked']),
  reason: z.string().trim().min(1).max(2000),
  actor: IdSchema,
  decidedAt: TimestampSchema,
  actionToken: z.string().min(1).max(200),
  receiptId: IdSchema,
}).strict();
export type ListingCompletenessException = z.infer<typeof ListingCompletenessExceptionSchema>;

export const ItemChecklistRequirementStateSchema = z.enum([
  'satisfied', 'missing', 'not_applicable', 'excepted', 'conflicted', 'unavailable', 'stale',
]);
export type ItemChecklistRequirementState = z.infer<typeof ItemChecklistRequirementStateSchema>;

export const ItemChecklistEvaluationSchema = z.object({
  status: z.enum(['ready', 'needs_attention', 'unavailable', 'stale']),
  inputHash: EvidenceHashSchema.nullable(),
  evidenceHash: EvidenceHashSchema.nullable(),
  standardHash: EvidenceHashSchema.nullable(),
  classificationHash: EvidenceHashSchema.nullable(),
  listingHash: EvidenceHashSchema.nullable(),
  requirements: z.array(z.object({
    requirementId: IdSchema,
    field: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    required: z.boolean(),
    exceptionEligible: z.boolean(),
    state: ItemChecklistRequirementStateSchema,
    factIds: z.array(IdSchema).max(512),
    dependencyHash: EvidenceHashSchema.nullable(),
    exceptionId: IdSchema.nullable(),
    reason: z.string().max(1000).nullable(),
  }).strict()).max(64),
  reasons: z.array(z.string().min(1).max(1000)).max(128),
}).strict();
export type ItemChecklistEvaluation = z.infer<typeof ItemChecklistEvaluationSchema>;
