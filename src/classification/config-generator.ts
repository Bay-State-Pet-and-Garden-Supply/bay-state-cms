// fallow-ignore-file unused-export

/**
 * Reviewed v2 candidate generation.
 *
 * The generator turns a reviewed Bay State seed plus a deterministic catalog
 * evidence artifact into a complete, preview-valid ClassificationConfigBundleV2
 * (all nine focused files + manifest). It never writes to the filesystem, never
 * activates anything, and never infers field semantics from value frequency.
 * The caller must pass the candidate through `config-store` to stage it.
 */

import type {
  ApplicabilityCondition,
  AttributeEvidencePolicy,
  AttributeProfileConfigV2,
  AttributeMappingConfigV2,
  BrandConfigV2,
  Cardinality,
  ClassificationConfigBundleV2,
  ClassificationFocusedFileName,
  ClassificationManifestV2,
  CurationTargetConfigV2,
  DataSharingConfigV2,
  GuidanceConfigV2,
  ModelPolicyConfigV2,
  ProductAttributeConfigV2,
  ProductTypeConfigV2,
  SerializationConfigV2,
  VisualEvidenceEligibility,
  ValueMode,
} from '../shared/schemas/classification';
import {
  AttributesFileV2Schema,
  AttributeMappingsFileV2Schema,
  AttributeProfilesFileV2Schema,
  BrandsFileV2Schema,
  ClassificationConfigBundleV2Schema,
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  CurationTargetsFileV2Schema,
  CategoriesFileV2Schema,
  DataSharingFileV2Schema,
  GuidanceFileV2Schema,
  ModelPolicyFileV2Schema,
  ProductTypesFileV2Schema,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, sha256Hex } from '../shared/stable-id';
import {
  canonicalForm,
  findCanonicalCollisions,
  validateCanonicalValue,
} from './controlled-value-identity';
import {
  computeClassificationBundleHash,
  validateClassificationConfigBundle,
  type ClassificationConfigFinding,
} from './config-validation';
import type { CatalogEvidence } from './catalog-evidence';

// ─── Seed shapes ───────────────────────────────────────────────────────────────

export interface BayStateSeedAttribute {
  id: string;
  name: string;
  description: string | null;
  valueMode: ValueMode;
  canonicalUnit: string | null;
  allowedValues: string[];
  valueAliases: Array<{ alias: string; mapsTo: string }>;
  visualEvidenceEligibility: VisualEvidenceEligibility;
  isClaim: boolean;
  isCompositionAttribute: boolean;
  group: string | null;
  isUniversal: boolean;
  /** When omitted, a conservative official/visual policy is generated. */
  evidencePolicy?: AttributeEvidencePolicy | null;
  oldIdAliases?: string[];
}

export interface BayStateSeedProfileAttribute {
  attributeId: string;
  required?: boolean;
  cardinality?: Cardinality;
  applicabilityConditions?: ApplicabilityCondition[];
  constraints?: Record<string, unknown>;
  confidenceThresholds?: Record<string, number>;
  valueAliases?: Array<{ alias: string; mapsTo: string }>;
}

export interface BayStateSeedProfileTemplate {
  id: string;
  name: string;
  productTypeIds: string[];
  attributes: BayStateSeedProfileAttribute[];
}

export interface BayStateSeedMapping {
  id: string;
  attributeId: string;
  catalogField: string;
  serialization: SerializationConfigV2;
  isStale?: boolean;
}

export interface BayStateSeed {
  name: string;
  /** Non-preview revision identifier recorded in the manifest. */
  revision: string;
  /** Fixed ISO-8601 offset datetime; drives deterministic candidate identity. */
  createdAt: string;
  productTypes: Array<{
    id: string;
    name: string;
    description: string | null;
    /** Approved canonical Category for this type (issue #350). */
    categoryId?: string;
    websiteValues?: ProductTypeConfigV2['websiteValues'];
    invariantAttributes?: ProductTypeConfigV2['invariantAttributes'];
    oldIdAliases?: string[];
  }>;
  /** Approved canonical Categories (issue #350). */
  categories: Array<{ id: string; name: string; description: string | null; oldIdAliases?: string[] }>;
  attributes: BayStateSeedAttribute[];
  profileTemplates: BayStateSeedProfileTemplate[];
  mappings: BayStateSeedMapping[];
  curationTargets: CurationTargetConfigV2[];
  brands: BrandConfigV2[];
  guidance: GuidanceConfigV2[];
  modelPolicy: ModelPolicyConfigV2;
  dataSharing: DataSharingConfigV2;
}

export interface ClassificationCandidateV2 {
  bundle: ClassificationConfigBundleV2;
  focusedFiles: Record<ClassificationFocusedFileName, string>;
  /** Generator-level notes (e.g. mappings whose Catalog Field is absent from the scanned evidence). */
  findings: ClassificationConfigFinding[];
}

// ─── Conservative evidence-policy defaults ─────────────────────────────────────

/**
 * Conservative v2 evidence policy. Claims/composition always require direct
 * evidence, absence inference is forbidden, and manual review is mandatory.
 * Third-party evidence is never granted by default.
 */
function defaultEvidencePolicy(attribute: BayStateSeedAttribute): AttributeEvidencePolicy {
  const safetyCritical = attribute.isClaim || attribute.isCompositionAttribute;
  const allowVisualEvidence = attribute.visualEvidenceEligibility === 'eligible';
  return {
    directEvidenceRequired: safetyCritical,
    forbidAbsenceInference: safetyCritical,
    allowedSources: [
      'official_product_page',
      ...(allowVisualEvidence ? ['visual_product_evidence' as const] : []),
    ],
    allowVisualEvidence,
    allowThirdPartyEvidence: false,
    thirdPartyEvidenceApproval: null,
    manualReviewRequired: safetyCritical,
  };
}

// ─── Focused-file envelope construction ───────────────────────────────────────

/**
 * Serialize every focused file for a bundle as canonical JSON file bytes with
 * the required v2 envelope. config-store writes exactly these bytes so the
 * manifest file-versions always match what is on disk.
 */
export function buildFocusedFiles(bundle: Omit<ClassificationConfigBundleV2, 'manifest'>): Record<ClassificationFocusedFileName, string> {
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

// ─── Candidate generation ──────────────────────────────────────────────────────

function makeManifest(seed: BayStateSeed, fileVersions: Record<string, string>): ClassificationManifestV2 {
  const manifestWithoutHash = {
    schemaVersion: 2 as const,
    compatibilityVersion: 2 as const,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
    activeRevision: seed.revision,
    lifecycle: 'preview' as const,
    hasUnresolvedSafetyFindings: false,
    migrationProvenance: { kind: 'reviewed_generation' as const },
    sourceCatalogCommit: null,
    catalogEvidenceHash: null,
    fileVersions,
  };
  return ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
}

/**
 * Generate a deterministic preview-valid v2 candidate from the reviewed seed and
 * catalog evidence. Throws when the resulting bundle fails semantic preview
 * validation; the seed must be repaired before generation can succeed.
 */
export function generateCandidate(seed: BayStateSeed, evidence: CatalogEvidence): ClassificationCandidateV2 {
  const findings: ClassificationConfigFinding[] = [];

  // Attributes with conservative policies applied. Allowed values and value
  // aliases are canonicalized (NFC + trim) at generation time and checked for
  // canonical validity / collision pairs so the generated bundle never carries
  // a non-canonical or ambiguous controlled-value identity.
  const attributes: ProductAttributeConfigV2[] = seed.attributes.map(attribute => {
    const allowedValues = attribute.allowedValues.map(canonicalForm);
    const valueAliases = attribute.valueAliases.map(alias => ({
      alias: canonicalForm(alias.alias),
      mapsTo: canonicalForm(alias.mapsTo),
    }));
    for (const value of allowedValues) {
      const canonical = validateCanonicalValue(value);
      if (!canonical.ok) {
        throw new Error(
          `Attribute "${attribute.id}" has a non-canonical controlled value ${JSON.stringify(value)} (${canonical.reason}); repair the seed before generation.`,
        );
      }
    }
    const collisions = findCanonicalCollisions(allowedValues);
    if (collisions.length > 0) {
      throw new Error(
        `Attribute "${attribute.id}" has an ambiguous controlled-value set (${collisions.map(c => `${c.a}~${c.b}:${c.kind}`).join(', ')}); repair the seed before generation.`,
      );
    }
    const allowedSet = new Set(allowedValues);
    for (const alias of valueAliases) {
      if (!allowedSet.has(alias.mapsTo)) {
        throw new Error(
          `Attribute "${attribute.id}" has an alias target "${alias.mapsTo}" that is not an exact allowed value; repair the seed before generation.`,
        );
      }
    }
    return {
      ...attribute,
      allowedValues,
      valueAliases,
      oldIdAliases: attribute.oldIdAliases ?? [],
      evidencePolicy: attribute.evidencePolicy ?? defaultEvidencePolicy(attribute),
    };
  });

  const attributeIds = new Set(attributes.map(attribute => attribute.id));
  const productTypeIds = new Set(seed.productTypes.map(type => type.id));

  // Expand profile templates into one profile per referenced Product Type.
  const profiles: AttributeProfileConfigV2[] = [];
  const typeNameById = new Map(seed.productTypes.map(type => [type.id, type.name]));
  const seenTemplateProfileTypes = new Set<string>();
  for (const template of seed.profileTemplates) {
    for (const productTypeId of template.productTypeIds) {
      if (seenTemplateProfileTypes.has(productTypeId)) {
        throw new Error(`Profile template "${template.id}" and another template both reference Product Type "${productTypeId}".`);
      }
      seenTemplateProfileTypes.add(productTypeId);
      if (!productTypeIds.has(productTypeId)) {
        throw new Error(`Profile template "${template.id}" references unknown Product Type "${productTypeId}".`);
      }
      const profileId = `${productTypeId}-profile`;
      const profileAttributes = template.attributes.map(entry => {
        if (!attributeIds.has(entry.attributeId)) {
          throw new Error(`Profile "${template.id}" references unknown attribute "${entry.attributeId}".`);
        }
        return {
          attributeId: entry.attributeId,
          required: entry.required ?? false,
          cardinality: entry.cardinality ?? 'single',
          applicabilityConditions: entry.applicabilityConditions ?? [],
          constraints: entry.constraints ?? {},
          confidenceThresholds: entry.confidenceThresholds ?? {},
          valueAliases: (entry.valueAliases ?? []).map(alias => ({
            alias: canonicalForm(alias.alias),
            mapsTo: canonicalForm(alias.mapsTo),
          })),
        };
      });
      profiles.push({
        id: profileId,
        productTypeId,
        name: typeNameById.get(productTypeId) ?? template.name,
        attributes: profileAttributes,
        oldIdAliases: [],
      });
    }
  }

  const productTypes: ProductTypeConfigV2[] = seed.productTypes.map(type => {
    const hasProfile = profiles.some(profile => profile.productTypeId === type.id);
    return {
      id: type.id,
      name: type.name,
      description: type.description,
      categoryId: type.categoryId ?? null,
      attributeProfileId: hasProfile ? `${type.id}-profile` : null,
      oldIdAliases: type.oldIdAliases ?? [],
      // Website values are explicit owner authority, never inferred from ids.
      ...(type.websiteValues ? { websiteValues: type.websiteValues } : {}),
      invariantAttributes: type.invariantAttributes ?? {},
    };
  });

  // Categories: pass through verbatim (canonical identity, no inference).
  const categories = (seed.categories ?? []).map(category => ({
    id: category.id,
    name: category.name,
    description: category.description,
    oldIdAliases: category.oldIdAliases ?? [],
  }));

  // Mappings: verify attributes exist; serializer cardinality is validated
  // semantically on the complete bundle below.
  const mappings: AttributeMappingConfigV2[] = seed.mappings.map(mapping => {
    if (!attributeIds.has(mapping.attributeId)) {
      throw new Error(`Mapping "${mapping.id}" references unknown attribute "${mapping.attributeId}".`);
    }
    return {
      id: mapping.id,
      attributeId: mapping.attributeId,
      catalogField: mapping.catalogField,
      serialization: mapping.serialization,
      isStale: mapping.isStale ?? false,
    };
  });

  // Curation targets: verify references so the semantic validator reports no
  // dangling target/mapping mismatches.
  const mappingsByAttribute = new Map(mappings.map(mapping => [mapping.attributeId, mapping]));
  const curationTargets: CurationTargetConfigV2[] = seed.curationTargets.map(target => {
    if (target.kind === 'product_field') {
      if (target.attributeId && !attributeIds.has(target.attributeId)) {
        throw new Error(`Curation target "${target.id}" references unknown attribute "${target.attributeId}".`);
      }
      if (target.attributeId && target.catalogField) {
        const mapping = mappingsByAttribute.get(target.attributeId);
        if (mapping && mapping.catalogField !== target.catalogField) {
          throw new Error(`Curation target "${target.id}" Catalog Field does not match mapping "${mapping.id}".`);
        }
      }
    }
    return target;
  });

  const bundleOrigin = { kind: 'reviewed_generation' as const };
  const withoutManifest = {
    bundleOrigin,
    productTypes,
    categories,
    attributes,
    attributeProfiles: profiles,
    attributeMappings: mappings,
    curationTargets,
    brands: seed.brands,
    guidance: seed.guidance,
    modelPolicy: seed.modelPolicy,
    dataSharing: seed.dataSharing,
  };

  const focusedFiles = buildFocusedFiles(withoutManifest);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const manifest = makeManifest(seed, fileVersions);
  const bundle = ClassificationConfigBundleV2Schema.parse({ manifest, ...withoutManifest });

  const report = validateClassificationConfigBundle(bundle, {
    mode: 'preview',
    focusedFileContents: focusedFiles,
  });
  if (!report.valid || !report.config) {
    throw new Error(
      `generateCandidate produced a semantically invalid preview bundle:\n${
        report.findings.map(finding => `  - [${finding.severity}] ${finding.code} at ${finding.path}: ${finding.message}`).join('\n')
      }`,
    );
  }

  // Evidence cross-check: mappings to fields that the deterministic scan never
  // observed are surfaced as findings. The generator never infers semantics;
  // active validation (M7) additionally requires a committed evidence artifact.
  const evidencedFields = new Set(evidence.fields.map(field => field.xmlField));
  for (const mapping of mappings) {
    if (!evidencedFields.has(mapping.catalogField)) {
      findings.push({
        severity: 'warning',
        code: 'mapping_field_not_in_evidence',
        path: `$.attributeMappings.${mapping.id}.catalogField`,
        message: `Catalog Field "${mapping.catalogField}" was not observed by the catalog evidence scan; verify the mapping against a committed evidence artifact before activation.`,
      });
    }
  }

  return { bundle, focusedFiles, findings };
}
