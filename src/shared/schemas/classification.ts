// fallow-ignore-file unused-export

import { z } from 'zod';
import { DEFAULT_LOCAL_VISION_MODEL } from '../vision-model-defaults';


// ─── Helper Schemas ────────────────────────────────────────────────────────────

/**
 * Stable human-readable slug used for classification configuration IDs.
 * Must start with a lowercase letter and contain only lowercase letters,
 * numbers, hyphens, and underscores.
 */
export const ClassificationSlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Slug must start with a letter and contain only a-z, 0-9, hyphens, and underscores');

export type ClassificationSlug = z.infer<typeof ClassificationSlugSchema>;

/**
 * ISO 8601 datetime string.  Stored as TEXT in SQLite.
 */
export const IsoDateTimeStringSchema = z.string();

export type IsoDateTimeString = z.infer<typeof IsoDateTimeStringSchema>;

// ─── Configuration Payload Schemas ─────────────────────────────────────────────

/**
 * Schema for manifest.json in store/classification/.
 */
export const ClassificationManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  compatibilityVersion: z.number().int().positive(),
  createdAt: IsoDateTimeStringSchema,
  updatedAt: IsoDateTimeStringSchema,
  fileVersions: z.record(z.string(), z.string()).optional().default({}),
});

export type ClassificationManifest = z.infer<typeof ClassificationManifestSchema>;

/**
 * One product-type entry in product-types.json.
 */
export const ProductTypeConfigSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  attributeProfileId: ClassificationSlugSchema.nullable().default(null),
  oldIdAliases: z.array(z.string()).default(() => []),
  invariantAttributes: z
    .record(ClassificationSlugSchema, z.union([z.string(), z.array(z.string()).nonempty()]))
    .optional(),
});

export type ProductTypeConfig = z.infer<typeof ProductTypeConfigSchema>;

// ─── Attribute value mode ───────────────────────────────────────────────────────

export const ValueModeEnum = z.enum(['controlled', 'freeText', 'measured']);
export type ValueMode = z.infer<typeof ValueModeEnum>;

export const VisualEvidenceEligibilityEnum = z.enum(['eligible', 'ineligible']);
export type VisualEvidenceEligibility = z.infer<typeof VisualEvidenceEligibilityEnum>;

/**
 * One attribute entry in attributes.json.
 */
export const ProductAttributeConfigSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  valueMode: ValueModeEnum,
  canonicalUnit: z.string().nullable().default(null),
  // Controlled-value identity (issue #17 G): each string must be the stored
  // canonical form (NFC-normalized + trimmed). Labels equal IDs by v2 policy;
  // config validation rejects empty/control-char/non-NFC/non-trimmed values
  // and normalized/case-fold collision pairs. See
  // `src/classification/controlled-value-identity.ts`.
  allowedValues: z.array(z.string()).default(() => []),
  valueAliases: z
    .array(
      z.object({
        alias: z.string(),
        mapsTo: z.string(),
      }),
    )
    .default(() => []),
  visualEvidenceEligibility: VisualEvidenceEligibilityEnum.default('eligible'),
  isClaim: z.boolean().default(false),
  isCompositionAttribute: z.boolean().default(false),
  group: z.string().nullable().default(null),
});

export type ProductAttributeConfig = z.infer<typeof ProductAttributeConfigSchema>;

// ─── Attribute cardinality ─────────────────────────────────────────────────────

export const CardinalityEnum = z.enum(['single', 'multiple']);
export type Cardinality = z.infer<typeof CardinalityEnum>;

// ─── Configurable curation targets ─────────────────────────────────────────────

export const CurationTargetKindEnum = z.enum(['product_type', 'product_field', 'page']);
export type CurationTargetKind = z.infer<typeof CurationTargetKindEnum>;

export const CurationTargetOptionSourceEnum = z.enum(['configured', 'live_store']);
export type CurationTargetOptionSource = z.infer<typeof CurationTargetOptionSourceEnum>;

/**
 * Manager-selected classification target for the curation stage.
 *
 * Examples:
 * - kind=product_field, catalogField=ProductField24, selectionMode=single
 * - kind=page, selectionMode=multiple
 * - kind=product_type for the optional internal Primary Product Type gate
 */
export const CurationTargetConfigSchema = z.object({
  id: ClassificationSlugSchema,
  kind: CurationTargetKindEnum,
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  /** When true, this target is always included regardless of the enabled flag */
  mandatory: z.boolean().default(false),
  selectionMode: CardinalityEnum.default('single'),
  attributeId: ClassificationSlugSchema.nullable().default(null),
  catalogField: z.string().nullable().default(null),
  optionSource: CurationTargetOptionSourceEnum.default('configured'),
  required: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

export type CurationTargetConfig = z.infer<typeof CurationTargetConfigSchema>;

/**
 * One attribute entry within an attribute profile.
 */
export const AttributeProfileAttributeSchema = z.object({
  attributeId: ClassificationSlugSchema,
  required: z.boolean().default(false),
  cardinality: CardinalityEnum.default('single'),
  applicabilityConditions: z.array(z.unknown()).default(() => []),
  constraints: z.record(z.string(), z.unknown()).default(() => ({})),
  confidenceThresholds: z.record(z.string(), z.number().min(0).max(1)).default(() => ({})),
  valueAliases: z
    .array(
      z.object({
        alias: z.string(),
        mapsTo: z.string(),
      }),
    )
    .default(() => []),
});

export type AttributeProfileAttribute = z.infer<typeof AttributeProfileAttributeSchema>;

/**
 * One profile entry in attribute-profiles.json.
 */
export const AttributeProfileConfigSchema = z.object({
  id: ClassificationSlugSchema,
  productTypeId: ClassificationSlugSchema,
  name: z.string().min(1),
  attributes: z.array(AttributeProfileAttributeSchema).default(() => []),
});

export type AttributeProfileConfig = z.infer<typeof AttributeProfileConfigSchema>;

/**
 * Serialization configuration for how attribute values are formatted
 * into a catalog field string.
 */
export const SerializationConfigSchema = z.object({
  format: z.string(),
  separator: z.string().optional().default(', '),
  prefix: z.string().optional().default(''),
  suffix: z.string().optional().default(''),
});

export type SerializationConfig = z.infer<typeof SerializationConfigSchema>;

/**
 * One mapping entry in mappings.json.
 */
export const AttributeMappingConfigSchema = z.object({
  id: ClassificationSlugSchema,
  attributeId: ClassificationSlugSchema,
  catalogField: z.string().min(1),
  serialization: SerializationConfigSchema.default(() => ({ format: 'direct', separator: ', ', prefix: '', suffix: '' })),
  isStale: z.boolean().default(false),
});

export type AttributeMappingConfig = z.infer<typeof AttributeMappingConfigSchema>;

// ─── Guidance scope ────────────────────────────────────────────────────────────

export const GuidanceScopeEnum = z.enum([
  'workspace',
  'productType',
  'attribute',
  'categoryPage',
  'attributeMapping',
]);

export type GuidanceScope = z.infer<typeof GuidanceScopeEnum>;

/**
 * One guidance entry in guidance.json.
 */
export const GuidanceConfigSchema = z.object({
  id: ClassificationSlugSchema,
  scope: GuidanceScopeEnum,
  scopeId: z.string().nullable().default(null),
  structured: z.record(z.string(), z.unknown()).default(() => ({})),
  freeForm: z.string().nullable().default(null),
  manualReviewRequirement: z.boolean().default(false),
});

export type GuidanceConfig = z.infer<typeof GuidanceConfigSchema>;

/**
 * Model policy configuration for model-policies.json.
 * Defines default provider/model and stage-specific overrides.
 * Image data sharing defaults to local-only.
 */
export const ModelPolicyConfigSchema = z.object({
  defaultProvider: z.string().default('ollama'),
  defaultModel: z.string().default(DEFAULT_LOCAL_VISION_MODEL),
  stageOverrides: z
    .record(
      z.string(),
      z.object({
        provider: z.string().optional(),
        model: z.string().optional(),
        fallbackProvider: z.string().nullable().default(null),
        fallbackModel: z.string().nullable().default(null),
      }),
    )
    .default(() => ({})),
  imageDataSharing: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']).default('local_only'),
  textDataSharing: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']).default('local_only'),
});

export type ModelPolicyConfig = z.infer<typeof ModelPolicyConfigSchema>;

/**
 * Data-sharing policy configuration for data-sharing.json.
 * Image policy defaults to local-only for privacy.
 */
export const DataSharingConfigSchema = z.object({
  imagePolicy: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']).default('local_only'),
  textPolicy: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']).default('local_only'),
  sensitiveDataFiltering: z.literal(true).default(true),
  retentionDays: z.number().int().positive().default(90),
});

export type DataSharingConfig = z.infer<typeof DataSharingConfigSchema>;

// ─── Brand configuration ────────────────────────────────────────────────────────

/**
 * A configured canonical brand with aliases for deterministic resolution.
 * Brands are stored in store/classification/brands.json.
 */
export const BrandConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default(() => []),
  oldIdAliases: z.array(z.string()).default(() => []),
});

export type BrandConfig = z.infer<typeof BrandConfigSchema>;

/**
 * Canonical evidence value shape for `resolved_brand` evidence entries.
 */
export const CanonicalBrandEvidenceValueSchema = z.object({
  brandId: z.string(),
  brandName: z.string(),
  confidence: z.number().min(0).max(1).default(1),
  matchedBy: z.string().optional(),
});
export type CanonicalBrandEvidenceValue = z.infer<typeof CanonicalBrandEvidenceValueSchema>;

/**
 * Aggregate classification configuration for snapshot validation.
 */
export const ClassificationConfigSchema = z.object({
  manifest: ClassificationManifestSchema,
  productTypes: z.array(ProductTypeConfigSchema).default(() => []),
  attributes: z.array(ProductAttributeConfigSchema).default(() => []),
  attributeProfiles: z.array(AttributeProfileConfigSchema).default(() => []),
  attributeMappings: z.array(AttributeMappingConfigSchema).default(() => []),
  curationTargets: z.array(CurationTargetConfigSchema).default(() => []),
  brands: z.array(BrandConfigSchema).default(() => []),
  guidance: z.array(GuidanceConfigSchema).default(() => []),
  modelPolicy: ModelPolicyConfigSchema.default(() => ({
    defaultProvider: 'ollama' as const,
    defaultModel: DEFAULT_LOCAL_VISION_MODEL,
    stageOverrides: {} as Record<string, { fallbackProvider: string | null; fallbackModel: string | null; provider?: string; model?: string }>,
    imageDataSharing: 'local_only' as const,
    textDataSharing: 'local_only' as const,
  })),
  dataSharing: DataSharingConfigSchema.default(() => ({
    imagePolicy: 'local_only' as const,
    textPolicy: 'local_only' as const,
    sensitiveDataFiltering: true as const,
    retentionDays: 90 as const,
  })),
});

export type ClassificationConfig = z.infer<typeof ClassificationConfigSchema>;

// ─── Strict version-2 configuration files ─────────────────────────────────────

export const ClassificationConfigV2SchemaVersion = 2 as const;

export const ClassificationFocusedFileNames = [
  'product-types.json',
  'attributes.json',
  'attribute-profiles.json',
  'mappings.json',
  'curation-targets.json',
  'brands.json',
  'guidance.json',
  'model-policies.json',
  'data-sharing.json',
] as const;

export const ClassificationFocusedFileNameSchema = z.enum(ClassificationFocusedFileNames);
export type ClassificationFocusedFileName = z.infer<typeof ClassificationFocusedFileNameSchema>;

export const ProviderLocalityEnum = z.enum(['local', 'trusted_lan', 'cloud', 'hybrid']);
export type ProviderLocality = z.infer<typeof ProviderLocalityEnum>;

export const ClassificationStageNameValues = [
  'evidence_extraction',
  'name_consolidation',
  'primary_product_type_proposal',
  'attribute_applicability',
  'product_attribute_proposals',
  // P3 (value-production ladder): flag-gated residual-gap resolution stage.
  // Additive only — previously valid configs remain valid; the new value is
  // accepted solely so modelPolicy.stageOverrides can target the stage.
  'value_gap_abstain',
  'category_page_proposals',
  'product_draft_projection',
] as const;

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 hex digest');
export const StrictIsoDateTimeStringSchema = z.string().datetime({ offset: true });

export const ApplicabilityConditionSchema = z.discriminatedUnion('operator', [
  z.object({
    operator: z.literal('equals'),
    attributeId: ClassificationSlugSchema,
    value: z.string(),
    factSource: z.literal('accepted_reviewed'),
  }).strict(),
  z.object({
    operator: z.literal('in'),
    attributeId: ClassificationSlugSchema,
    values: z.array(z.string()).min(1),
    factSource: z.literal('accepted_reviewed'),
  }).strict(),
  z.object({
    operator: z.literal('containsAny'),
    attributeId: ClassificationSlugSchema,
    values: z.array(z.string()).min(1),
    factSource: z.literal('accepted_reviewed'),
  }).strict(),
]);
export type ApplicabilityCondition = z.infer<typeof ApplicabilityConditionSchema>;

export const EvidencePolicySourceSchema = z.enum([
  'spreadsheet',
  'official_product_page',
  'third_party_page',
  'visual_product_evidence',
  'page_context',
  'approved_product_example',
  'catalog_product',
]);

export const ThirdPartyEvidenceApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvedAt: StrictIsoDateTimeStringSchema,
  provenanceRequirement: z.literal('direct_product_statement'),
}).strict();

export const AttributeEvidencePolicySchema = z.object({
  directEvidenceRequired: z.boolean(),
  forbidAbsenceInference: z.boolean(),
  allowedSources: z.array(EvidencePolicySourceSchema).min(1),
  allowVisualEvidence: z.boolean(),
  allowThirdPartyEvidence: z.boolean(),
  thirdPartyEvidenceApproval: ThirdPartyEvidenceApprovalSchema.nullable(),
  manualReviewRequired: z.boolean(),
}).strict();
export type AttributeEvidencePolicy = z.infer<typeof AttributeEvidencePolicySchema>;

export const ScalarSerializationV2Schema = z.object({
  kind: z.literal('scalar'),
  prefix: z.string(),
  suffix: z.string(),
}).strict();

export const DelimitedSerializationV2Schema = z.object({
  kind: z.literal('delimited'),
  delimiter: z.string().min(1),
  escapePolicy: z.enum(['reject', 'backslash']),
  prefix: z.string(),
  suffix: z.string(),
}).strict();

export const MeasuredSerializationV2Schema = z.object({
  kind: z.literal('measured'),
  unit: z.string().min(1),
  valueUnitSeparator: z.string(),
  prefix: z.string(),
  suffix: z.string(),
}).strict();

export const SerializationConfigV2Schema = z.discriminatedUnion('kind', [
  ScalarSerializationV2Schema,
  DelimitedSerializationV2Schema,
  MeasuredSerializationV2Schema,
]);
export type SerializationConfigV2 = z.infer<typeof SerializationConfigV2Schema>;

export const ProductTypeConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  attributeProfileId: ClassificationSlugSchema.nullable(),
  oldIdAliases: z.array(ClassificationSlugSchema),
  /** Department grouping (bay-state-v3 release). Optional for v2 workspace bundles. */
  departmentId: ClassificationSlugSchema.optional(),
  /** Invariant attribute values deterministically implied by this Product Type. */
  invariantAttributes: z
    .record(ClassificationSlugSchema, z.union([z.string(), z.array(z.string()).nonempty()]))
    .optional(),
}).strict();
export type ProductTypeConfigV2 = z.infer<typeof ProductTypeConfigV2Schema>;

/**
 * Export disposition for a taxonomy attribute (bay-state-v3 release).
 * `shopsite` attributes persist to a ShopSite catalog field; `not_exported`
 * attributes are canonical classification data with no ShopSite destination.
 * Optional in the schema so v2 workspace bundles still parse; the release
 * validator requires it on every attribute.
 */
export const ExportDispositionV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shopsite'),
    catalogField: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('not_exported'),
  }).strict(),
]);
export type ExportDispositionV2 = z.infer<typeof ExportDispositionV2Schema>;

export const ProductAttributeConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  valueMode: ValueModeEnum,
  canonicalUnit: z.string().nullable(),
  // Controlled-value identity (issue #17 G): strings are exact canonical IDs
  // (NFC + trimmed); labels equal IDs by v2 policy. The shape is unchanged for
  // schema-v2 string compatibility — canonicality is enforced by config
  // validation (`controlled-value-identity.ts`), not the schema.
  allowedValues: z.array(z.string()),
  valueAliases: z.array(z.object({ alias: z.string(), mapsTo: z.string() }).strict()),
  visualEvidenceEligibility: VisualEvidenceEligibilityEnum,
  isClaim: z.boolean(),
  isCompositionAttribute: z.boolean(),
  group: z.string().nullable(),
  isUniversal: z.boolean(),
  evidencePolicy: AttributeEvidencePolicySchema,
  oldIdAliases: z.array(ClassificationSlugSchema),
  /** Export disposition (bay-state-v3 release). Optional for v2 workspace bundles. */
  exportDisposition: ExportDispositionV2Schema.optional(),
}).strict();
export type ProductAttributeConfigV2 = z.infer<typeof ProductAttributeConfigV2Schema>;

/**
 * Canonical controlled-value option: `value` and `label` are the SAME exact
 * canonical ID by the documented v2 policy (issue #17 G). Builders must use
 * `controlled-value-identity.canonicalOption()` rather than inventing a
 * display label distinct from the identity.
 */
export interface CanonicalControlledValueOptionV2 {
  value: string;
  label: string;
}

export const AttributeProfileAttributeV2Schema = z.object({
  attributeId: ClassificationSlugSchema,
  required: z.boolean(),
  cardinality: CardinalityEnum,
  applicabilityConditions: z.array(ApplicabilityConditionSchema),
  constraints: z.record(z.string(), z.unknown()),
  confidenceThresholds: z.record(z.string(), z.number().min(0).max(1)),
  valueAliases: z.array(z.object({ alias: z.string(), mapsTo: z.string() }).strict()),
}).strict();

export const AttributeProfileConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  productTypeId: ClassificationSlugSchema,
  name: z.string().min(1),
  attributes: z.array(AttributeProfileAttributeV2Schema),
  oldIdAliases: z.array(ClassificationSlugSchema),
}).strict();
export type AttributeProfileConfigV2 = z.infer<typeof AttributeProfileConfigV2Schema>;

export const AttributeMappingConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  attributeId: ClassificationSlugSchema,
  catalogField: z.string().min(1),
  serialization: SerializationConfigV2Schema,
  isStale: z.boolean(),
}).strict();
export type AttributeMappingConfigV2 = z.infer<typeof AttributeMappingConfigV2Schema>;

export const CurationTargetConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  kind: CurationTargetKindEnum,
  label: z.string().min(1),
  enabled: z.boolean(),
  mandatory: z.boolean(),
  selectionMode: CardinalityEnum,
  attributeId: ClassificationSlugSchema.nullable(),
  catalogField: z.string().nullable(),
  optionSource: CurationTargetOptionSourceEnum,
  required: z.boolean(),
  sortOrder: z.number().int(),
}).strict();
export type CurationTargetConfigV2 = z.infer<typeof CurationTargetConfigV2Schema>;

export const BrandConfigV2Schema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  oldIdAliases: z.array(z.string()),
}).strict();
export type BrandConfigV2 = z.infer<typeof BrandConfigV2Schema>;

export const GuidanceConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  scope: GuidanceScopeEnum,
  scopeId: z.string().nullable(),
  structured: z.record(z.string(), z.unknown()),
  freeForm: z.string().nullable(),
  manualReviewRequirement: z.boolean(),
}).strict();
export type GuidanceConfigV2 = z.infer<typeof GuidanceConfigV2Schema>;

export const DataSharingConfigV2Schema = z.object({
  imagePolicy: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']),
  textPolicy: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']),
  sensitiveDataFiltering: z.literal(true),
  retentionDays: z.number().int().positive(),
}).strict();
export type DataSharingConfigV2 = z.infer<typeof DataSharingConfigV2Schema>;

export const MlFeatureIdSchema = z.enum([
  'productionRetrieval',
  'pageReranking',
  'confidenceCalibration',
  'productionEmbeddings',
]);
export type MlFeatureId = z.infer<typeof MlFeatureIdSchema>;

export const MlFeaturePolicySchema = z.object({
  state: z.enum(['disabled', 'evaluation_only', 'qualified', 'enabled']),
  qualificationReceiptDigest: Sha256HexSchema.nullable(),
  activatedBy: z.string().nullable(),
  activatedAt: StrictIsoDateTimeStringSchema.nullable(),
}).strict();
export type MlFeaturePolicy = z.infer<typeof MlFeaturePolicySchema>;

export const MlFeaturesPolicySchema = z.object({
  productionRetrieval: MlFeaturePolicySchema,
  pageReranking: MlFeaturePolicySchema,
  confidenceCalibration: MlFeaturePolicySchema,
  productionEmbeddings: MlFeaturePolicySchema,
}).strict();

export const ModelPolicyConfigV2Schema = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  /** Explicit provider locality registry; every referenced provider must be declared before active validation. */
  providerLocalities: z.record(z.string(), ProviderLocalityEnum),
  stageOverrides: z.record(z.string(), z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    fallbackProvider: z.string().nullable(),
    fallbackModel: z.string().nullable(),
  }).strict()),
  imageDataSharing: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']),
  textDataSharing: z.enum(['local_only', 'this_device_only', 'trusted_lan_allowed', 'cloud_allowed']),
  mlFeatures: MlFeaturesPolicySchema,
}).strict();
export type ModelPolicyConfigV2 = z.infer<typeof ModelPolicyConfigV2Schema>;

export const ClassificationBundleOriginV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reviewed_generation'),
  }).strict(),
  z.object({
    kind: z.literal('migrated_v1'),
    sourceConfigHash: Sha256HexSchema,
  }).strict(),
  z.object({
    kind: z.literal('release'),
    releaseId: ClassificationSlugSchema,
    createdAt: StrictIsoDateTimeStringSchema,
  }).strict(),
]);
export type ClassificationBundleOriginV2 = z.infer<typeof ClassificationBundleOriginV2Schema>;

export const ClassificationMigrationProvenanceV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reviewed_generation'),
  }).strict(),
  z.object({
    kind: z.literal('release'),
    releaseId: ClassificationSlugSchema,
    createdAt: StrictIsoDateTimeStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('migrated_v1'),
    sourceSchemaVersion: z.literal(1),
    sourceConfigHash: Sha256HexSchema,
    migratedAt: StrictIsoDateTimeStringSchema,
    findingCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    findingsDigest: Sha256HexSchema,
  }).strict(),
]);
export type ClassificationMigrationProvenanceV2 = z.infer<typeof ClassificationMigrationProvenanceV2Schema>;

export const ClassificationManifestV2Schema = z.object({
  schemaVersion: z.literal(ClassificationConfigV2SchemaVersion),
  compatibilityVersion: z.literal(ClassificationConfigV2SchemaVersion),
  createdAt: StrictIsoDateTimeStringSchema,
  updatedAt: StrictIsoDateTimeStringSchema,
  activeRevision: z.string().min(1),
  lifecycle: z.enum(['preview', 'active']),
  hasUnresolvedSafetyFindings: z.boolean(),
  /** Required discriminated origin. Migrated candidates cannot become clean through manifest-only edits. */
  migrationProvenance: ClassificationMigrationProvenanceV2Schema,
  sourceCatalogCommit: z.string().nullable(),
  catalogEvidenceHash: Sha256HexSchema.nullable(),
  fileVersions: z.record(z.string(), Sha256HexSchema),
  bundleHash: Sha256HexSchema,
}).strict();
export type ClassificationManifestV2 = z.infer<typeof ClassificationManifestV2Schema>;

function entriesEnvelopeV2<T extends z.ZodType>(entry: T) {
  return z.object({
    schemaVersion: z.literal(ClassificationConfigV2SchemaVersion),
    bundleOrigin: ClassificationBundleOriginV2Schema,
    entries: z.array(entry),
  }).strict();
}

function policyEnvelopeV2<T extends z.ZodType>(policy: T) {
  return z.object({
    schemaVersion: z.literal(ClassificationConfigV2SchemaVersion),
    bundleOrigin: ClassificationBundleOriginV2Schema,
    policy,
  }).strict();
}

export const ProductTypesFileV2Schema = entriesEnvelopeV2(ProductTypeConfigV2Schema);
export const AttributesFileV2Schema = entriesEnvelopeV2(ProductAttributeConfigV2Schema);
export const AttributeProfilesFileV2Schema = entriesEnvelopeV2(AttributeProfileConfigV2Schema);
export const AttributeMappingsFileV2Schema = entriesEnvelopeV2(AttributeMappingConfigV2Schema);
export const CurationTargetsFileV2Schema = entriesEnvelopeV2(CurationTargetConfigV2Schema);
export const BrandsFileV2Schema = entriesEnvelopeV2(BrandConfigV2Schema);
export const GuidanceFileV2Schema = entriesEnvelopeV2(GuidanceConfigV2Schema);
export const ModelPolicyFileV2Schema = policyEnvelopeV2(ModelPolicyConfigV2Schema);
export const DataSharingFileV2Schema = policyEnvelopeV2(DataSharingConfigV2Schema);

/**
 * Department grouping for a taxonomy release (bay-state-v3). Departments are
 * canonical browse/reporting groups; a product type's department membership
 * never renames the type id.
 */
export const DepartmentConfigV2Schema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  sortOrder: z.number().int().nonnegative(),
  /** Product type ids that belong to this department. */
  typeIds: z.array(ClassificationSlugSchema),
}).strict();
export type DepartmentConfigV2 = z.infer<typeof DepartmentConfigV2Schema>;

export const DepartmentsFileV2Schema = entriesEnvelopeV2(DepartmentConfigV2Schema);

export const ClassificationConfigBundleV2Schema = z.object({
  manifest: ClassificationManifestV2Schema,
  /** Origin decoded from and required in every focused file envelope. */
  bundleOrigin: ClassificationBundleOriginV2Schema,
  productTypes: z.array(ProductTypeConfigV2Schema),
  attributes: z.array(ProductAttributeConfigV2Schema),
  attributeProfiles: z.array(AttributeProfileConfigV2Schema),
  attributeMappings: z.array(AttributeMappingConfigV2Schema),
  curationTargets: z.array(CurationTargetConfigV2Schema),
  brands: z.array(BrandConfigV2Schema),
  guidance: z.array(GuidanceConfigV2Schema),
  modelPolicy: ModelPolicyConfigV2Schema,
  dataSharing: DataSharingConfigV2Schema,
  taxonomyRevision: z.unknown().optional(),
  pageAssignmentPolicyAdvisory: z.unknown().optional(),
}).strict();
export type ClassificationConfigBundleV2 = z.infer<typeof ClassificationConfigBundleV2Schema>;

// ─── Runtime / Review Enums ────────────────────────────────────────────────────

export const ClassificationStageNameEnum = z.enum(ClassificationStageNameValues);

export type ClassificationStageName = z.infer<typeof ClassificationStageNameEnum>;

export const ClassificationRunStatusEnum = z.enum([
  'queued',
  'running',
  'completed',
  'completed_with_abstentions',
  'failed',
  'cancelled',
]);

export type ClassificationRunStatus = z.infer<typeof ClassificationRunStatusEnum>;

export const ClassificationStageStatusEnum = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'abstained',
]);

export type ClassificationStageStatus = z.infer<typeof ClassificationStageStatusEnum>;

export const EvidenceSourceEnum = z.enum([
  'spreadsheet',
  'official_product_page',
  'third_party_page',
  'visual_product_evidence',
  'page_context',
  'approved_product_example',
  'catalog_manager_guidance',
  'catalog_product',
  /**
   * Amendment A (default-on): evidence materialized from a qualified
   * distributor record (source_type 'distributor_record'). Third-party
   * classification source label ONLY — it is never claim/composition
   * authority, never labeled `official_product_page`, and never grants
   * commerce rights. PI-6 remains the sole path for distributor images.
   */
  'distributor_record',
  /**
   * Parent #101 (manual-evidence route): operator-transcribed facts for a
   * profile-blocked item (extraction_method 'manual_evidence_v1').
   * Operator provenance ONLY — it is never labeled `official_product_page`,
   * always low reliability (requires Review), and carries the attestation id
   * in metadata. Additive: existing consumers ignore the new member.
   */
  'operator_manual',
]);

export type EvidenceSource = z.infer<typeof EvidenceSourceEnum>;

export const EvidenceReliabilityEnum = z.enum([
  'high',
  'medium',
  'low',
  'conflicting',
  'unknown',
]);

export type EvidenceReliability = z.infer<typeof EvidenceReliabilityEnum>;

export const ProposalTypeEnum = z.enum([
  'primary_product_type',
  'category_page',
  'field_assignment',
  'configuration_gap',
  'reviewable_abstention',
]);

export type ProposalType = z.infer<typeof ProposalTypeEnum>;

export const ProposalStatusEnum = z.enum(['pending', 'accepted', 'rejected', 'deferred', 'stale']);
export type ProposalStatus = z.infer<typeof ProposalStatusEnum>;

export const DecisionEnum = z.enum(['accepted', 'rejected', 'deferred']);
export type Decision = z.infer<typeof DecisionEnum>;

// ─── Runtime / Review Schemas ──────────────────────────────────────────────────

/**
 * Reference to a classification config snapshot.
 */
export const ClassificationConfigSnapshotRefSchema = z.object({
  id: z.string(),
  hash: z.string(),
  sourceCommit: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationConfigSnapshotRef = z.infer<typeof ClassificationConfigSnapshotRefSchema>;

/**
 * A piece of classification evidence: a product fact supporting a proposal.
 */
export const ClassificationEvidenceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stageName: ClassificationStageNameEnum,
  productSku: z.string().min(1),
  attributeId: z.string().nullable().default(null),
  source: EvidenceSourceEnum,
  reliability: EvidenceReliabilityEnum,
  sourceUrl: z.string().nullable().default(null),
  sourceField: z.string().nullable().default(null),
  snippet: z.string().nullable().default(null),
  value: z.unknown().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
  capturedAt: IsoDateTimeStringSchema,
});

export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>;

/**
 * First-class provenance explaining how a proposal was derived.
 */
export const ProposalDerivationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('product_type_invariant'),
    productTypeId: ClassificationSlugSchema,
    productTypeSource: z.enum(['reviewed', 'execution', 'none']),
  }).strict(),
  z.object({
    kind: z.literal('evidence_match'),
  }).strict(),
  z.object({
    kind: z.literal('deterministic_enrichment'),
  }).strict(),
  z.object({
    kind: z.literal('llm'),
  }).strict(),
]);
export type ProposalDerivation = z.infer<typeof ProposalDerivationSchema>;

/**
 * A reviewable suggestion produced by a classification run.
 */
export const ClassificationProposalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  productSku: z.string().min(1),
  proposalType: ProposalTypeEnum,
  targetId: z.string().nullable().default(null),
  proposedValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).default(() => []),
  /**
   * Target-specific evidence roles (issue #17 work item H). `supporting` and
   * `contradicting` are authoritative subsets of `evidenceIds`; the join table
   * (classification_proposal_evidence.relation) is authoritative at rest.
   * Unresolved contradictions force individual review (never bulk-acceptable)
   * and are never silently resolved by source order or confidence.
   */
  supportingEvidenceIds: z.array(z.string()).optional(),
  contradictingEvidenceIds: z.array(z.string()).optional(),
  /** First-class proposal derivation provenance (e.g. type invariant vs evidence match vs LLM). */
  derivation: ProposalDerivationSchema.optional(),
  status: ProposalStatusEnum.default('pending'),
  isBulkAcceptable: z.boolean().default(false),
  isStale: z.boolean().default(false),
  stalenessReason: z.string().nullable().default(null),
  /** Effective reviewer-corrected value from the latest live decision (immutable original stays in proposedValue). */
  revisedValue: z.unknown().optional(),
  /** Distinguishes an explicit null correction from no corrected value. */
  hasRevisedValue: z.boolean().optional(),
  /** Effective reviewer-corrected target from the latest live decision (immutable original stays in targetId). */
  revisedTargetId: z.string().nullable().optional(),
  hasRevisedTargetId: z.boolean().optional(),
  /** Canonical live decision used as the optimistic predecessor for the next edit. */
  currentDecisionId: z.string().nullable().optional(),
  /**
   * Immutable runtime snapshot hash the proposal was built under. Stages stamp
   * it so the pipeline can fail closed on cross-snapshot proposal smuggling.
   */
  snapshotHash: z.string().nullable().optional(),
  /**
   * Durable model-call IDs (classification_model_calls) that produced this
   * proposal. The pipeline verifies every ID belongs to the same run/snapshot
   * before persistence (issue #17 work item E).
   */
  modelCallIds: z.array(z.string()).optional(),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationProposal = z.infer<typeof ClassificationProposalSchema>;

/**
 * A reviewer's decision on a classification proposal.
 * Decisions are append-only: corrected values live here (revisedValue /
 * revisedTargetId), never on the proposal prediction. Revisions chain through
 * revisedFromId and supersede the previous live decision (supersededAt).
 */
export const ClassificationProposalDecisionSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  decision: DecisionEnum,
  revisedFromId: z.string().nullable().default(null),
  reviewerId: z.string().nullable().default(null),
  reviewerNote: z.string().nullable().default(null),
  /**
   * Evidence citations for this reviewer correction (issue #17 work item I).
   * Optional: corrections remain valid without citations, but the UI and
   * telemetry must explicitly show "no citation supplied". Every cited id must
   * belong to the same run/SKU and be linked to the proposal in one of H's
   * relations; arbitrary/invented citations are rejected before any row is
   * written. Citations are part of exact retry/idempotency equality.
   */
  evidenceIds: z.array(z.string()).max(50).optional(),
  revisedValue: z.unknown().optional(),
  hasRevisedValue: z.boolean().optional(),
  revisedTargetId: z.string().nullable().optional(),
  hasRevisedTargetId: z.boolean().optional(),
  /** Explicit client action token used for retry-safe idempotency. */
  actionToken: z.string().nullable().optional(),
  /** @deprecated database/backward-compatible alias for actionToken. */
  decisionKey: z.string().nullable().default(null),
  supersededAt: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationProposalDecision = z.infer<typeof ClassificationProposalDecisionSchema>;

/**
 * An audit/history event for a classification run.
 */
export const ClassificationHistoryEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  proposalId: z.string().nullable().default(null),
  decisionId: z.string().nullable().default(null),
  eventType: z.string(),
  eventJson: z.record(z.string(), z.unknown()).default(() => ({})),
  createdAt: IsoDateTimeStringSchema,
});

export type ClassificationHistoryEvent = z.infer<typeof ClassificationHistoryEventSchema>;

// ─── Catalog Product Classification ─────────────────────────────────────────────

/**
 * Discriminates classification runs by their data source.
 * - onboarding: Run was triggered from an onboarding pipeline item.
 * - catalog_product: Run was triggered from an existing catalog product.
 */
export const ClassificationRunSourceKindEnum = z.enum(['onboarding', 'catalog_product']);
export type ClassificationRunSourceKind = z.infer<typeof ClassificationRunSourceKindEnum>;

// ─── Catalog Product Classification API Schemas ─────────────────────────────────

/**
 * Request body to start a classification run for an existing catalog product.
 */
export const StartCatalogClassificationRunRequestSchema = z.object({
  sku: z.string().min(1),
});

export type StartCatalogClassificationRunRequest = z.infer<typeof StartCatalogClassificationRunRequestSchema>;

/**
 * Request body to submit proposal decisions for a catalog classification run.
 */
export const ProposalDecisionInputSchema = z.object({
  id: z.string().min(1).optional(),
  proposalId: z.string().min(1),
  decision: DecisionEnum,
  reviewerId: z.string().nullable().optional(),
  reviewerNote: z.string().nullable().optional(),
  revisedValue: z.unknown().optional(),
  revisedTargetId: z.string().nullable().optional(),
  /**
   * Evidence citations for this correction (issue #17 work item I). Optional
   * and bounded; each id must belong to the same run/SKU and be linked to the
   * proposal in one of the evidence relations. Citations are part of exact
   * retry/idempotency equality.
   */
  evidenceIds: z.array(z.string()).max(50).optional(),
  actionToken: z.string().min(1).max(200).optional(),
  expectedRevisionId: z.string().nullable().optional(),
  /** @deprecated Transitional aliases accepted while older clients drain. */
  revisedFromId: z.string().nullable().optional(),
  proposedValue: z.unknown().optional(),
  targetId: z.string().nullable().optional(),
}).superRefine((decision, context) => {
  const aliasPairs = [
    ['expectedRevisionId', 'revisedFromId'],
    ['revisedValue', 'proposedValue'],
    ['revisedTargetId', 'targetId'],
  ] as const;
  for (const [canonical, legacy] of aliasPairs) {
    if (Object.prototype.hasOwnProperty.call(decision, canonical)
      && Object.prototype.hasOwnProperty.call(decision, legacy)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [legacy],
        message: `Cannot include deprecated ${legacy} with ${canonical}.`,
      });
    }
  }
});

export type ProposalDecisionInput = z.infer<typeof ProposalDecisionInputSchema>;

export const SubmitProposalDecisionsRequestSchema = z.object({
  decisions: z.array(ProposalDecisionInputSchema).min(1),
  bulk: z.boolean().optional(),
});

export type SubmitProposalDecisionsRequest = z.infer<typeof SubmitProposalDecisionsRequestSchema>;

export const SubmitCatalogDecisionsRequestSchema = SubmitProposalDecisionsRequestSchema;

export type SubmitCatalogDecisionsRequest = z.infer<typeof SubmitCatalogDecisionsRequestSchema>;

/**
 * Request body to apply accepted classification proposals as a change-set draft.
 */
export const ApplyCatalogClassificationRequestSchema = z.object({
  runId: z.string().min(1),
});

export type ApplyCatalogClassificationRequest = z.infer<typeof ApplyCatalogClassificationRequestSchema>;

/**
 * Enriched run detail returned by GET /api/products/:sku/classification.
 */
export const CatalogClassificationRunDetailSchema = z.object({
  run: z.object({
    id: z.string(),
    sourceKind: ClassificationRunSourceKindEnum,
    status: ClassificationRunStatusEnum,
    productSku: z.string(),
    configSnapshotHash: z.string().nullable(),
    sourceProductHash: z.string().nullable(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }),
  configDrift: z.boolean().default(false),
  sourceDrift: z.boolean().default(false),
  evidence: z.array(ClassificationEvidenceSchema),
  proposals: z.array(ClassificationProposalSchema),
  decisions: z.array(ClassificationProposalDecisionSchema),
  stageResults: z.array(z.object({
    stageName: ClassificationStageNameEnum,
    status: ClassificationStageStatusEnum,
    errorMessage: z.string().nullable(),
  })),
  projection: z.object({
    fields: z.array(z.object({
      catalogField: z.string(),
      currentValue: z.string().nullable(),
      proposedValue: z.string().nullable(),
      isOverwrite: z.boolean(),
      isNoOp: z.boolean(),
    })),
    pages: z.object({
      existing: z.array(z.string()),
      proposed: z.array(z.string()),
    }),
  }).optional(),
});

export type CatalogClassificationRunDetail = z.infer<typeof CatalogClassificationRunDetailSchema>;

// ─── Benchmark / Evaluation Schemas ────────────────────────────────────────────

export const BenchmarkGoldLabelsSchema = z.object({
  productType: z.string().nullable().default(null),
  pageAssignments: z.array(z.object({
    pageName: z.string(),
    pageId: z.string().nullable().default(null),
  })).default([]),
  fieldAssignments: z.array(z.object({
    targetId: z.string(),
    value: z.string().nullable(),
  })).default([]),
});
export type BenchmarkGoldLabels = z.infer<typeof BenchmarkGoldLabelsSchema>;

export const BenchmarkDatasetStatusEnum = z.enum(['draft', 'frozen', 'retired']);
export type BenchmarkDatasetStatus = z.infer<typeof BenchmarkDatasetStatusEnum>;

/**
 * Lifecycle-aware benchmark dataset. Draft datasets accept examples; frozen
 * datasets are immutable (content-addressed by datasetHash) and are the only
 * datasets eligible for prediction/evaluation; retired datasets are read-only
 * archives. Freeze requires a reviewed family grouping (familyReviewComplete).
 */
export const BenchmarkDatasetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string().min(1),
  holdoutStrategy: z.enum(['product_family', 'random']).default('product_family'),
  splitSeed: z.number().int(),
  totalExamples: z.number().int().default(0),
  status: BenchmarkDatasetStatusEnum.default('draft'),
  familyReviewComplete: z.boolean().default(false),
  familyReviewedBy: z.string().nullable().default(null),
  familyReviewedAt: z.string().nullable().default(null),
  datasetHash: z.string().nullable().default(null),
  frozenAt: z.string().nullable().default(null),
  frozenBy: z.string().nullable().default(null),
  retiredAt: z.string().nullable().default(null),
  /** Source config snapshot hash captured at export time (drift exclusion). */
  sourceConfigHash: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});
export type BenchmarkDataset = z.infer<typeof BenchmarkDatasetSchema>;

/**
 * Immutable benchmark example. The exampleHash content-addresses the gold
 * labels, input snapshot, and source provenance; frozen datasets refuse
 * inserts/updates so examples cannot be modified after freeze.
 */
export const BenchmarkExampleSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  productSku: z.string(),
  productFamilyId: z.string().nullable().default(null),
  splitGroup: z.enum(['train', 'test', 'holdout']),
  inputSnapshotJson: z.string(),
  goldLabelsJson: z.string(),
  /** Content hash of the example payload (labels + input + provenance). */
  exampleHash: z.string(),
  /** Reviewer/adjudication provenance for the exported gold labels. */
  reviewerId: z.string().nullable().default(null),
  adjudicatedBy: z.string().nullable().default(null),
  /** Exact reviewed run that produced the gold labels. */
  sourceRunId: z.string().nullable().default(null),
  sourceConfigHash: z.string().nullable().default(null),
  sourceProductHash: z.string().nullable().default(null),
  createdAt: IsoDateTimeStringSchema,
});
export type BenchmarkExample = z.infer<typeof BenchmarkExampleSchema>;

/**
 * One prediction for one gold example inside an immutable prediction bundle.
 */
export const BenchmarkPredictionEntrySchema = z.object({
  exampleId: z.string(),
  productSku: z.string(),
  productType: z.string().nullable(),
  pageAssignments: z.array(z.string()).default([]),
  fieldAssignments: z.array(z.object({
    targetId: z.string(),
    value: z.string().nullable(),
  })).default([]),
  abstained: z.boolean().default(false),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** Target IDs whose attributes are claim-sensitive in the active config. */
  claimTargets: z.array(z.string()).default([]),
});
export type BenchmarkPredictionEntry = z.infer<typeof BenchmarkPredictionEntrySchema>;

/**
 * Immutable prediction bundle. Persisted in full BEFORE evaluation; the
 * evaluator only reads the bundle plus frozen gold (never current runs or
 * decisions). bundleHash content-addresses the ordered predictions.
 */
export const BenchmarkPredictionBundleSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  workspaceId: z.string(),
  runLabel: z.string().min(1),
  splitGroup: z.enum(['test', 'holdout']),
  predictions: z.array(BenchmarkPredictionEntrySchema),
  bundleHash: Sha256HexSchema,
  createdAt: StrictIsoDateTimeStringSchema,
});
export type BenchmarkPredictionBundle = z.infer<typeof BenchmarkPredictionBundleSchema>;

export const EvalMetricsSchema = z.object({
  productType: z.object({
    top1Accuracy: z.number(),
    macroF1: z.number(),
    confusionPairs: z.array(z.tuple([z.string(), z.string(), z.number()])).default([]),
    /** Evaluated gold examples (non-abstained, labeled). */
    support: z.number().int().default(0),
    /** Fraction of eligible labeled examples that were evaluated (non-abstained). */
    coverage: z.number().default(0),
    perClassSupport: z.record(z.string(), z.number().int()).default({}),
  }),
  pages: z.object({
    precisionAtK: z.number(),
    recallAtK: z.number(),
    exactSetAccuracy: z.number(),
    /** True when Page gold exists but verified Page identity is unavailable. */
    blocked: z.boolean().default(false),
    blockedReason: z.string().nullable().default(null),
  }),
  fields: z.object({
    targetAccuracy: z.record(z.string(), z.number()).default({}),
    targetSupport: z.record(z.string(), z.number().int()).default({}),
  }).default({ targetAccuracy: {}, targetSupport: {} }),
  safety: z.object({
    crossSpeciesCount: z.number().int(),
    crossSpeciesExamples: z.array(z.string()).default([]),
    claimSafetyViolations: z.number().int().default(0),
    controlledValueViolations: z.number().int().default(0),
  }),
  abstention: z.object({
    abstainedPercent: z.number(),
    accuracyOfNonAbstained: z.number(),
  }),
  operations: z.object({
    correctionsPerHundred: z.number(),
  }),
  calibration: z.object({
    ece: z.number().default(0),
    bins: z.array(z.object({
      bin: z.number().int(),
      count: z.number().int(),
      accuracy: z.number(),
      avgConfidence: z.number(),
    })).default([]),
  }).default({ ece: 0, bins: [] }),
  /** Deterministic paired bootstrap interval over a predeclared primary metric. */
  pairedDelta: z.object({
    primaryMetric: z.string().default('productType.top1Accuracy'),
    deltaMean: z.number().default(0),
    deltaLower95: z.number().default(0),
    deltaUpper95: z.number().default(0),
    bootstrapRuns: z.number().int().default(0),
  }).default({
    primaryMetric: 'productType.top1Accuracy',
    deltaMean: 0,
    deltaLower95: 0,
    deltaUpper95: 0,
    bootstrapRuns: 0,
  }),
});
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

/**
 * Conservative qualification receipt. Qualification is NECESSARY but NOT
 * SUFFICIENT for feature activation: feature-policy still requires the receipt
 * digest plus an explicit activation audit before any production enablement.
 */
export const BenchmarkQualificationReceiptSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  datasetHash: z.string(),
  predictionBundleId: z.string(),
  bundleHash: z.string(),
  holdoutSize: z.number().int(),
  coverage: z.number(),
  minClassSupport: z.number().int(),
  violations: z.object({
    crossSpecies: z.number().int(),
    claimSafety: z.number().int(),
    controlledValue: z.number().int(),
  }),
  pairedDelta: z.object({
    primaryMetric: z.string(),
    deltaLower95: z.number(),
  }),
  nonRegressionFloorsMet: z.boolean(),
  qualified: z.boolean(),
  reasons: z.array(z.string()).default([]),
  /** sha256 of the canonical receipt payload. */
  digest: Sha256HexSchema,
  generatedAt: StrictIsoDateTimeStringSchema,
  generatedBy: z.string().nullable().default(null),
});
export type BenchmarkQualificationReceipt = z.infer<typeof BenchmarkQualificationReceiptSchema>;

export const BenchmarkEvalRunSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  runLabel: z.string().min(1),
  modelConfigJson: z.string().nullable().default(null),
  predictionBundleId: z.string().nullable().default(null),
  metricsJson: z.string(),
  createdAt: IsoDateTimeStringSchema,
});
export type BenchmarkEvalRun = z.infer<typeof BenchmarkEvalRunSchema>;

export const FeaturePolicyStateEnum = z.enum(['disabled', 'evaluation_only', 'enabled']);
export type FeaturePolicyState = z.infer<typeof FeaturePolicyStateEnum>;

/**
 * Fail-closed feature policy decision. `enabled` is only returned when the
 * config policy is qualified/enabled AND a verified qualification receipt
 * digest AND an activation audit are present. Nothing here ever auto-enables.
 */
export const FeaturePolicyDecisionSchema = z.object({
  feature: MlFeatureIdSchema,
  state: FeaturePolicyStateEnum,
  reason: z.string(),
  receiptDigest: z.string().nullable().default(null),
});
export type FeaturePolicyDecision = z.infer<typeof FeaturePolicyDecisionSchema>;

export const ExportBenchmarkRequestSchema = z.object({
  name: z.string().min(1),
  holdoutPercent: z.number().min(5).max(50).default(20),
  splitSeed: z.number().int().optional(),
  minDecisionsPerSku: z.number().int().min(1).default(1),
});
export type ExportBenchmarkRequest = z.infer<typeof ExportBenchmarkRequestSchema>;

export const RunEvalRequestSchema = z.object({
  splitGroup: z.enum(['test', 'holdout']).default('test'),
  runLabel: z.string().min(1),
  /** Optional explicit prediction bundle; defaults to the latest for the split. */
  predictionBundleId: z.string().optional(),
  /** Optional baseline bundle for the paired bootstrap delta. */
  baselineBundleId: z.string().optional(),
});
export type RunEvalRequest = z.infer<typeof RunEvalRequestSchema>;

export const FreezeDatasetRequestSchema = z.object({
  reviewerId: z.string().optional(),
});
export type FreezeDatasetRequest = z.infer<typeof FreezeDatasetRequestSchema>;

export const MarkFamilyReviewRequestSchema = z.object({
  reviewerId: z.string().min(1),
});
export type MarkFamilyReviewRequest = z.infer<typeof MarkFamilyReviewRequestSchema>;

export const BuildPredictionBundleRequestSchema = z.object({
  runLabel: z.string().min(1),
  splitGroup: z.enum(['test', 'holdout']).default('holdout'),
});
export type BuildPredictionBundleRequest = z.infer<typeof BuildPredictionBundleRequestSchema>;

// ─── Classification readiness (issue #17 work item L) ────────────────────────

export const ClassificationReadinessCapabilitySchema = z.object({
  kind: z.enum(['product_type', 'product_field', 'page']),
  enabled: z.boolean(),
  targetCount: z.number().int().nonnegative(),
  runnable: z.boolean(),
  reason: z.string().nullable(),
}).strict();
export type ClassificationReadinessCapability = z.infer<typeof ClassificationReadinessCapabilitySchema>;

export const ClassificationReadinessFindingSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  path: z.string(),
  message: z.string(),
}).strict();
export type ClassificationReadinessFinding = z.infer<typeof ClassificationReadinessFindingSchema>;

export const ClassificationReadinessReportSchema = z.object({
  isReady: z.boolean(),
  hasWarnings: z.boolean(),
  capabilities: z.object({
    productType: ClassificationReadinessCapabilitySchema,
    productFields: ClassificationReadinessCapabilitySchema,
    categoryPages: ClassificationReadinessCapabilitySchema,
  }),
  findings: z.array(ClassificationReadinessFindingSchema),
  summary: z.array(z.string()),
}).strict();
export type ClassificationReadinessReportDto = z.infer<typeof ClassificationReadinessReportSchema>;
