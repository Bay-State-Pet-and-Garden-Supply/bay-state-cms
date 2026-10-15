import { z } from 'zod';
import {
  AttributeMappingsFileV2Schema,
  AttributeProfilesFileV2Schema,
  ApplicabilityConditionSchema,
  AttributesFileV2Schema,
  BrandsFileV2Schema,
  CardinalityEnum,
  ClassificationConfigBundleV2Schema,
  ClassificationManifestV2Schema,
  ClassificationSlugSchema,
  CurationTargetKindEnum,
  CurationTargetOptionSourceEnum,
  CurationTargetsFileV2Schema,
  CategoriesFileV2Schema,
  DataSharingFileV2Schema,
  GuidanceFileV2Schema,
  GuidanceScopeEnum,
  ModelPolicyFileV2Schema,
  ProductTypesFileV2Schema,
  ValueModeEnum,
  VisualEvidenceEligibilityEnum,
  type ClassificationConfigBundleV2,
  type ClassificationFocusedFileName,
  type ClassificationManifestV2,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, hashCanonicalJson, sha256Hex } from '../shared/stable-id';
import {
  computeClassificationBundleHash,
  computeMigrationFindingsDigest,
  validateClassificationConfigBundle,
} from './config-validation';

export type ConfigMigrationFindingSeverity = 'info' | 'warning' | 'error';

export interface ConfigMigrationFinding {
  severity: ConfigMigrationFindingSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ConfigMigrationV1Result {
  bundle: ClassificationConfigBundleV2;
  focusedFiles: Record<ClassificationFocusedFileName, string>;
  findings: ConfigMigrationFinding[];
  lossy: boolean;
}

const LegacyAliasSchema = z.object({ alias: z.string(), mapsTo: z.string() }).strict();
const LegacyProductTypeSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  attributeProfileId: ClassificationSlugSchema.nullable(),
  oldIdAliases: z.array(ClassificationSlugSchema),
  /** Approved canonical Category (issue #350). Absent on legacy configs — migration reports the gap. */
  categoryId: ClassificationSlugSchema.nullable().optional(),
}).strict();
const LegacyAttributeSchema = z.object({
  id: ClassificationSlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  valueMode: ValueModeEnum,
  canonicalUnit: z.string().nullable(),
  allowedValues: z.array(z.string()),
  valueAliases: z.array(LegacyAliasSchema),
  visualEvidenceEligibility: VisualEvidenceEligibilityEnum,
  isClaim: z.boolean(),
  isCompositionAttribute: z.boolean(),
  group: z.string().nullable(),
}).strict();
const LegacyProfileAttributeSchema = z.object({
  attributeId: ClassificationSlugSchema,
  required: z.boolean(),
  cardinality: CardinalityEnum,
  applicabilityConditions: z.array(z.unknown()),
  constraints: z.record(z.string(), z.unknown()),
  confidenceThresholds: z.record(z.string(), z.number().min(0).max(1)),
  valueAliases: z.array(LegacyAliasSchema),
}).strict();
const LegacyProfileSchema = z.object({
  id: ClassificationSlugSchema,
  productTypeId: ClassificationSlugSchema,
  name: z.string().min(1),
  attributes: z.array(LegacyProfileAttributeSchema),
}).strict();
const LegacyMappingSchema = z.object({
  id: ClassificationSlugSchema,
  attributeId: ClassificationSlugSchema,
  catalogField: z.string().min(1),
  serialization: z.object({
    format: z.string(),
    separator: z.string(),
    prefix: z.string(),
    suffix: z.string(),
  }).strict(),
  isStale: z.boolean(),
}).strict();
const LegacyCurationTargetSchema = z.object({
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
const LegacyBrandSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
  oldIdAliases: z.array(z.string()),
}).strict();
const LegacyGuidanceSchema = z.object({
  id: ClassificationSlugSchema,
  scope: GuidanceScopeEnum,
  scopeId: z.string().nullable(),
  structured: z.record(z.string(), z.unknown()),
  freeForm: z.string().nullable(),
  manualReviewRequirement: z.boolean(),
}).strict();
const LegacyModelPolicySchema = z.object({
  defaultProvider: z.string(),
  defaultModel: z.string(),
  stageOverrides: z.record(z.string(), z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    fallbackProvider: z.string().nullable(),
    fallbackModel: z.string().nullable(),
  }).strict()),
  imageDataSharing: z.enum(['local_only', 'cloud_allowed']),
  textDataSharing: z.enum(['local_only', 'cloud_allowed']),
}).strict();
const LegacyDataSharingSchema = z.object({
  imagePolicy: z.enum(['local_only', 'cloud_allowed']),
  textPolicy: z.enum(['local_only', 'cloud_allowed']),
  sensitiveDataFiltering: z.literal(true),
  retentionDays: z.number().int().positive(),
}).strict();

export const LegacyClassificationConfigV1Schema = z.object({
  manifest: z.object({
    schemaVersion: z.literal(1),
    compatibilityVersion: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    fileVersions: z.record(z.string(), z.string()),
  }).strict(),
  productTypes: z.array(LegacyProductTypeSchema),
  attributes: z.array(LegacyAttributeSchema),
  attributeProfiles: z.array(LegacyProfileSchema),
  attributeMappings: z.array(LegacyMappingSchema),
  curationTargets: z.array(LegacyCurationTargetSchema),
  brands: z.array(LegacyBrandSchema),
  guidance: z.array(LegacyGuidanceSchema),
  modelPolicy: LegacyModelPolicySchema,
  dataSharing: LegacyDataSharingSchema,
}).strict();

export type LegacyClassificationConfigV1 = z.infer<typeof LegacyClassificationConfigV1Schema>;

const disabledFeature = () => ({
  state: 'disabled' as const,
  qualificationReceiptDigest: null,
  activatedBy: null,
  activatedAt: null,
});

/**
 * Only providers whose locality is safely known to the migration are attested.
 * Anything else becomes an activation-blocking finding; locality is never
 * guessed from provider names.
 */
const KNOWN_LEGACY_PROVIDER_LOCALITIES: Readonly<Record<string, 'local'>> = {
  ollama: 'local',
};

function sortMigrationFindings(findings: ConfigMigrationFinding[]): void {
  findings.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || left.severity.localeCompare(right.severity)
    || left.message.localeCompare(right.message)
  ));
}

function migrationEvidencePolicy(attribute: LegacyClassificationConfigV1['attributes'][number]) {
  const safetyCritical = attribute.isClaim || attribute.isCompositionAttribute;
  const allowVisualEvidence = attribute.visualEvidenceEligibility === 'eligible';
  return {
    directEvidenceRequired: safetyCritical,
    forbidAbsenceInference: safetyCritical,
    // V1 did not attest third-party/example/guidance/catalog provenance. Keep
    // the preview conservative; a manager may expand it only in a reviewed v2
    // candidate. Guidance is instruction and is never direct product evidence.
    allowedSources: [
      'official_product_page' as const,
      ...(allowVisualEvidence ? ['visual_product_evidence' as const] : []),
    ],
    allowVisualEvidence,
    allowThirdPartyEvidence: false,
    thirdPartyEvidenceApproval: null,
    manualReviewRequired: safetyCritical,
  };
}

function focusedFileContents(
  bundle: Omit<ClassificationConfigBundleV2, 'manifest'>,
): Record<ClassificationFocusedFileName, string> {
  return {
    'product-types.json': canonicalJsonFileString(ProductTypesFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.productTypes })),
    'categories.json': canonicalJsonFileString(CategoriesFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.categories })),
    'attributes.json': canonicalJsonFileString(AttributesFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.attributes })),
    'attribute-profiles.json': canonicalJsonFileString(AttributeProfilesFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.attributeProfiles })),
    'mappings.json': canonicalJsonFileString(AttributeMappingsFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.attributeMappings })),
    'curation-targets.json': canonicalJsonFileString(CurationTargetsFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.curationTargets })),
    'brands.json': canonicalJsonFileString(BrandsFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.brands })),
    'guidance.json': canonicalJsonFileString(GuidanceFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, entries: bundle.guidance })),
    'model-policies.json': canonicalJsonFileString(ModelPolicyFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, policy: bundle.modelPolicy })),
    'data-sharing.json': canonicalJsonFileString(DataSharingFileV2Schema.parse({ schemaVersion: 2, bundleOrigin: bundle.bundleOrigin, policy: bundle.dataSharing })),
  };
}

/**
 * Convert a complete, validated legacy v1 configuration into a deterministic
 * v2 preview. The function has no filesystem or database side effects.
 * Potentially lossy/defaulted choices are returned as path-addressed findings.
 */
export function migrateClassificationConfigV1(input: unknown): ConfigMigrationV1Result {
  const legacy = LegacyClassificationConfigV1Schema.parse(input);
  const sourceConfigHash = hashCanonicalJson(legacy);
  const findings: ConfigMigrationFinding[] = [];

  const attributes = legacy.attributes.map((attribute, index) => {
    findings.push({
      severity: 'error',
      code: 'defaulted_universal_scope',
      path: `$.attributes[${index}].isUniversal`,
      message: 'V1 did not record universal scope. The preview uses false but requires explicit review before activation.',
    });
    findings.push({
      severity: 'error',
      code: 'evidence_policy_added',
      path: `$.attributes[${index}].evidencePolicy`,
      message: attribute.isClaim || attribute.isCompositionAttribute
        ? 'Added a conservative direct-evidence policy; manager review is required before activation.'
        : 'V1 had no source policy. The preview allows only official/eligible visual evidence and requires explicit review before activation.',
    });
    return {
      ...attribute,
      isUniversal: false,
      evidencePolicy: migrationEvidencePolicy(attribute),
      oldIdAliases: [],
    };
  });

  const attributeById = new Map(attributes.map(attribute => [attribute.id, attribute]));
  const cardinalities = new Map<string, Set<'single' | 'multiple'>>();
  legacy.attributeProfiles.forEach(profile => {
    profile.attributes.forEach(attribute => {
      const uses = cardinalities.get(attribute.attributeId) ?? new Set<'single' | 'multiple'>();
      uses.add(attribute.cardinality);
      cardinalities.set(attribute.attributeId, uses);
    });
  });
  legacy.curationTargets.forEach(target => {
    if (target.kind === 'product_field' && target.attributeId && (target.enabled || target.mandatory)) {
      const uses = cardinalities.get(target.attributeId) ?? new Set<'single' | 'multiple'>();
      uses.add(target.selectionMode);
      cardinalities.set(target.attributeId, uses);
    }
  });

  const attributeProfiles = legacy.attributeProfiles.map((profile, profileIndex) => ({
    ...profile,
    oldIdAliases: [],
    attributes: profile.attributes.map((profileAttribute, attributeIndex) => {
      const applicabilityConditions = profileAttribute.applicabilityConditions.flatMap((condition, conditionIndex) => {
        const parsed = ApplicabilityConditionSchema.safeParse(condition);
        if (parsed.success) return [parsed.data];
        findings.push({
          severity: 'error',
          code: 'unsupported_applicability_condition',
          path: `$.attributeProfiles[${profileIndex}].attributes[${attributeIndex}].applicabilityConditions[${conditionIndex}]`,
          message: 'V1 applicability semantics cannot be activated as-is. The preview omits this condition only for inspection; a reviewed accepted/reviewed-fact condition is required before activation.',
        });
        return [];
      });
      return {
        ...profileAttribute,
        applicabilityConditions,
      };
    }),
  }));

  const attributeMappings = legacy.attributeMappings.map((mapping, index) => {
    findings.push({
      severity: 'info',
      code: 'serialization_schema_migrated',
      path: `$.attributeMappings[${index}].serialization`,
      message: 'Converted the free-form v1 serialization object to an explicit v2 serialization variant.',
    });
    const attribute = attributeById.get(mapping.attributeId);
    const uses = cardinalities.get(mapping.attributeId);
    const prefix = mapping.serialization.prefix ?? '';
    const suffix = mapping.serialization.suffix ?? '';
    if (mapping.serialization.format !== 'direct'
      && mapping.serialization.format !== 'scalar'
      && mapping.serialization.format !== 'delimited'
      && mapping.serialization.format !== 'measured') {
      findings.push({
        severity: 'error',
        code: 'unsupported_serialization_format',
        path: `$.attributeMappings[${index}].serialization.format`,
        message: `Unsupported v1 serialization format "${mapping.serialization.format}".`,
      });
    }

    if (attribute?.valueMode === 'measured') {
      if (!attribute.canonicalUnit) {
        findings.push({
          severity: 'error',
          code: 'missing_measured_unit',
          path: `$.attributes.${attribute.id}.canonicalUnit`,
          message: 'Measured serialization cannot be migrated without a canonical unit.',
        });
      }
      return {
        ...mapping,
        serialization: {
          kind: 'measured' as const,
          unit: attribute.canonicalUnit ?? '__missing_unit__',
          valueUnitSeparator: mapping.serialization.separator ?? ' ',
          prefix,
          suffix,
        },
      };
    }

    if (uses?.has('multiple') || mapping.serialization.format === 'delimited') {
      if (uses?.has('single')) {
        findings.push({
          severity: 'warning',
          code: 'mixed_cardinality',
          path: `$.attributeMappings[${index}].serialization`,
          message: 'The attribute is both single and multiple cardinality; migrated as delimited and requires review.',
        });
      }
      return {
        ...mapping,
        serialization: {
          kind: 'delimited' as const,
          delimiter: mapping.serialization.separator ?? ', ',
          escapePolicy: 'reject' as const,
          prefix,
          suffix,
        },
      };
    }

    if ((mapping.serialization.separator ?? ', ') !== ', ') {
      findings.push({
        severity: 'info',
        code: 'unused_scalar_separator',
        path: `$.attributeMappings[${index}].serialization.separator`,
        message: 'The legacy separator was ignored for a scalar mapping.',
      });
    }
    return {
      ...mapping,
      serialization: { kind: 'scalar' as const, prefix, suffix },
    };
  });

  const referencedProviders = new Set<string>();
  if (legacy.modelPolicy.defaultProvider) referencedProviders.add(legacy.modelPolicy.defaultProvider);
  if (!legacy.modelPolicy.defaultProvider || !legacy.modelPolicy.defaultModel) {
    findings.push({
      severity: 'error',
      code: 'empty_legacy_default_model_pair',
      path: '$.modelPolicy',
      message: 'V1 must declare a nonempty default provider/model pair; the v2 policy requires completeness before activation.',
    });
  }
  for (const [stageName, override] of Object.entries(legacy.modelPolicy.stageOverrides)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (override.provider !== undefined && !override.provider) {
      findings.push({
        severity: 'error',
        code: 'empty_legacy_override_provider',
        path: `$.modelPolicy.stageOverrides.${stageName}.provider`,
        message: 'Stage override provider must be nonempty when present.',
      });
    }
    if (override.model !== undefined && !override.model) {
      findings.push({
        severity: 'error',
        code: 'empty_legacy_override_model',
        path: `$.modelPolicy.stageOverrides.${stageName}.model`,
        message: 'Stage override model must be nonempty when present.',
      });
    }
    if (override.provider) referencedProviders.add(override.provider);
    if (override.fallbackProvider) referencedProviders.add(override.fallbackProvider);
  }
  const providerLocalities: Record<string, 'local'> = {};
  for (const provider of [...referencedProviders].sort()) {
    const locality = KNOWN_LEGACY_PROVIDER_LOCALITIES[provider];
    if (locality) {
      providerLocalities[provider] = locality;
    } else {
      findings.push({
        severity: 'error',
        code: 'unrecognized_legacy_provider_locality',
        path: `$.modelPolicy.providerLocalities.${provider}`,
        message: `V1 did not attest locality for provider "${provider}". The preview omits it; an explicit locality declaration is required in a reviewed v2 candidate before activation.`,
      });
    }
  }
  if (Object.keys(providerLocalities).length > 0) {
    findings.push({
      severity: 'info',
      code: 'provider_localities_attested',
      path: '$.modelPolicy.providerLocalities',
      message: `Attested local-only locality for legacy providers: ${Object.keys(providerLocalities).sort().join(', ')}.`,
    });
  }
  const modelPolicy = {
    ...legacy.modelPolicy,
    providerLocalities,
    mlFeatures: {
      productionRetrieval: disabledFeature(),
      pageReranking: disabledFeature(),
      confidenceCalibration: disabledFeature(),
      productionEmbeddings: disabledFeature(),
    },
  };
  findings.push({
    severity: 'info',
    code: 'ml_features_disabled',
    path: '$.modelPolicy.mlFeatures',
    message: 'All ML features defaulted to disabled; qualification and explicit activation are required.',
  });

  // Issue #350: carry approved Category mappings; legacy types without one
  // get an explicit blocking gap finding each — ambiguous old semantics
  // require an explicit owner decision, never silent invention.
  const productTypes = legacy.productTypes.map((type, index) => {
    if (!type.categoryId) {
      findings.push({
        severity: 'error',
        code: 'unmapped_product_type_category',
        path: `$.productTypes[${index}].categoryId`,
        message: `Product Type "${type.id}" has no approved Category mapping; assign its canonical Category explicitly before activation.`,
      });
    }
    return { ...type, categoryId: type.categoryId ?? null };
  });

  const withoutManifest: Omit<ClassificationConfigBundleV2, 'manifest'> = {
    bundleOrigin: { kind: 'migrated_v1', sourceConfigHash },
    productTypes,
    categories: [],
    attributes,
    attributeProfiles,
    attributeMappings,
    curationTargets: legacy.curationTargets,
    brands: legacy.brands,
    guidance: legacy.guidance,
    modelPolicy,
    dataSharing: legacy.dataSharing,
  };
  const focusedFiles = focusedFileContents(withoutManifest);
  const fileVersions = Object.fromEntries(
    Object.entries(focusedFiles).map(([fileName, content]) => [fileName, sha256Hex(content)]),
  );
  findings.push({
    severity: 'info',
    code: 'file_versions_replaced',
    path: '$.manifest.fileVersions',
    message: 'Replaced legacy timestamp/version strings with SHA-256 hashes of canonical focused-file bytes.',
  });
  findings.push({
    severity: 'warning',
    code: 'activation_provenance_unavailable',
    path: '$.manifest',
    message: 'v1 did not attest catalog commit or evidence hash; both remain null and require activation review.',
  });
  findings.push({
    severity: 'info',
    code: 'migration_findings_digest_bound',
    path: '$.manifest.migrationProvenance',
    message: 'Migration safety findings are content-addressed into the preview manifest; stripping or editing them invalidates the candidate.',
  });

  const buildManifest = (): ClassificationManifestV2 => {
    sortMigrationFindings(findings);
    const manifestWithoutHash = {
      schemaVersion: 2 as const,
      compatibilityVersion: 2 as const,
      createdAt: legacy.manifest.createdAt,
      updatedAt: legacy.manifest.updatedAt,
      activeRevision: 'migrated-v1-preview',
      lifecycle: 'preview' as const,
      hasUnresolvedSafetyFindings: true,
      migrationProvenance: {
        kind: 'migrated_v1' as const,
        sourceSchemaVersion: 1 as const,
        sourceConfigHash,
        migratedAt: legacy.manifest.updatedAt,
        findingCount: findings.length,
        errorCount: findings.filter(finding => finding.severity === 'error').length,
        findingsDigest: computeMigrationFindingsDigest(findings),
      },
      sourceCatalogCommit: null,
      catalogEvidenceHash: null,
      fileVersions,
    };
    return ClassificationManifestV2Schema.parse({
      ...manifestWithoutHash,
      bundleHash: computeClassificationBundleHash(manifestWithoutHash),
    });
  };

  // First pass binds the digest over migration findings; if semantic
  // validation appends errors, a second pass rebinds the final finding list.
  let manifest = buildManifest();
  let bundle = ClassificationConfigBundleV2Schema.parse({ manifest, ...withoutManifest });
  let semanticReport = validateClassificationConfigBundle(bundle, {
    mode: 'preview',
    focusedFileContents: focusedFiles,
    unresolvedMigrationFindings: findings,
  });
  let appended = 0;
  for (const finding of semanticReport.findings) {
    if (finding.severity === 'error') {
      findings.push({
        severity: 'error',
        code: `semantic_${finding.code}`,
        path: finding.path,
        message: finding.message,
      });
      appended += 1;
    }
  }
  if (appended > 0) {
    manifest = buildManifest();
    bundle = ClassificationConfigBundleV2Schema.parse({ manifest, ...withoutManifest });
    semanticReport = validateClassificationConfigBundle(bundle, {
      mode: 'preview',
      focusedFileContents: focusedFiles,
      unresolvedMigrationFindings: findings,
    });
    const pass1ErrorCodes = new Set(
      findings
        .filter(finding => finding.severity === 'error')
        .map(finding => finding.code.replace(/^semantic_/, '')),
    );
    for (const finding of semanticReport.findings) {
      if (finding.severity === 'error' && !pass1ErrorCodes.has(finding.code)) {
        throw new Error(`Migration semantic validation was unstable across passes: ${finding.code} at ${finding.path}.`);
      }
    }
  }
  sortMigrationFindings(findings);
  return {
    bundle,
    focusedFiles,
    findings,
    lossy: findings.some(finding => finding.severity === 'warning' || finding.severity === 'error'),
  };
}
