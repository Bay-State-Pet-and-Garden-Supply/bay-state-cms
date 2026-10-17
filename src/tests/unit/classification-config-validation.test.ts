import { describe, expect, it } from 'vitest';
import type { ClassificationConfig } from '../../shared/schemas/classification';
import {
  ClassificationConfigBundleV2Schema,
  EvidencePolicySourceSchema,
  ProductAttributeConfigV2Schema,
} from '../../shared/schemas/classification';
import {
  computeClassificationBundleHash,
  evaluateClassificationReadiness,
  validateClassificationConfigBundle,
} from '../../classification/config-validation';
import { migrateClassificationConfigV1 } from '../../classification/config-migrate-v1';

function legacyConfig(overrides: Partial<ClassificationConfig> = {}): ClassificationConfig {
  const now = '2026-08-01T12:00:00.000Z';
  return {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
    productTypes: [],
    attributes: [{
      id: 'flavor',
      name: 'Flavor',
      description: null,
      valueMode: 'controlled',
      canonicalUnit: null,
      allowedValues: ['Chicken', 'Beef'],
      valueAliases: [{ alias: 'chicken flavor', mapsTo: 'Chicken' }],
      visualEvidenceEligibility: 'eligible',
      isClaim: false,
      isCompositionAttribute: false,
      group: 'Food',
    }],
    attributeProfiles: [],
    attributeMappings: [{
      id: 'flavor-mapping',
      attributeId: 'flavor',
      catalogField: 'ProductField23',
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    }],
    curationTargets: [{
      id: 'primary-product-type',
      kind: 'product_type',
      label: 'Primary Product Type',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: null,
      catalogField: null,
      optionSource: 'configured',
      required: true,
      sortOrder: 0,
    }],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'test',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
    ...overrides,
  };
}

function migrated(overrides: Partial<ClassificationConfig> = {}) {
  return migrateClassificationConfigV1(legacyConfig(overrides));
}

function activeBundle(source: ReturnType<typeof migrated>['bundle']): ReturnType<typeof migrated>['bundle'] {
  const active = structuredClone(source);
  active.manifest.activeRevision = 'bay-state-v2';
  active.manifest.lifecycle = 'active';
  active.manifest.hasUnresolvedSafetyFindings = false;
  // A reviewed generator must regenerate both manifest and focused payload
  // origins; manifest-only edits cannot remove the migrated origin binding.
  active.manifest.migrationProvenance = { kind: 'reviewed_generation' };
  active.bundleOrigin = { kind: 'reviewed_generation' };
  active.manifest.sourceCatalogCommit = 'a'.repeat(40);
  active.manifest.catalogEvidenceHash = 'b'.repeat(64);
  active.manifest.bundleHash = computeClassificationBundleHash(active.manifest);
  return active;
}

const verifiedVerifier = () => ({ verified: true as const });

function findingCodes(input: unknown): string[] {
  return validateClassificationConfigBundle(input).findings.map(finding => finding.code);
}

describe('classification v1 to v2 migration preview', () => {
  it('is deterministic, side-effect free, safety-defaulted, and content addressed', () => {
    const first = migrated();
    const second = migrated();
    expect(first).toEqual(second);
    expect(first.bundle.manifest.fileVersions).toEqual(second.bundle.manifest.fileVersions);
    expect(first.bundle.manifest.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bundle.manifest.bundleHash).toBe(computeClassificationBundleHash(first.bundle.manifest));
    expect(first.bundle.modelPolicy.mlFeatures).toEqual({
      productionRetrieval: expect.objectContaining({ state: 'disabled' }),
      pageReranking: expect.objectContaining({ state: 'disabled' }),
      confidenceCalibration: expect.objectContaining({ state: 'disabled' }),
      productionEmbeddings: expect.objectContaining({ state: 'disabled' }),
    });
    expect(first.bundle.attributes[0]).toMatchObject({ isUniversal: false });
    expect(Object.values(first.focusedFiles).every(content => content.endsWith('\n'))).toBe(true);
    expect(validateClassificationConfigBundle(first.bundle, { focusedFileContents: first.focusedFiles }).valid).toBe(true);
  });

  it('carries semantic validation errors into activation-blocking migration findings', () => {
    const result = migrated({
      productTypes: [{
        id: 'dog-food', name: 'Dog Food', description: null,
        attributeProfileId: 'missing-profile', oldIdAliases: [],
      }],
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_dangling_profile', severity: 'error' }),
    ]));
    // The two-pass rebind must not duplicate semantic findings or desync the digest.
    const semanticCodes = result.findings.filter(finding => finding.code.startsWith('semantic_')).map(finding => finding.code);
    expect(new Set(semanticCodes).size).toBe(semanticCodes.length);
    const bound = validateClassificationConfigBundle(result.bundle, {
      mode: 'preview',
      focusedFileContents: result.focusedFiles,
      unresolvedMigrationFindings: result.findings,
    });
    expect(bound.findings.map(finding => finding.code))
      .not.toEqual(expect.arrayContaining(['migration_findings_digest_mismatch', 'migration_finding_count_mismatch']));
    expect(result.bundle.manifest.lifecycle).toBe('preview');
    expect(result.bundle.manifest.hasUnresolvedSafetyFindings).toBe(true);
  });

  it('is invariant to stage override object insertion order', () => {
    const alpha = {
      provider: 'provider-alpha', model: 'model-alpha', fallbackProvider: null, fallbackModel: null,
    };
    const beta = {
      provider: 'provider-beta', model: 'model-beta', fallbackProvider: null, fallbackModel: null,
    };
    const first = migrated({
      modelPolicy: {
        defaultProvider: 'ollama', defaultModel: 'test',
        stageOverrides: { evidence_extraction: alpha, name_consolidation: beta },
        imageDataSharing: 'local_only', textDataSharing: 'local_only',
      },
    });
    const second = migrated({
      modelPolicy: {
        defaultProvider: 'ollama', defaultModel: 'test',
        stageOverrides: { name_consolidation: beta, evidence_extraction: alpha },
        imageDataSharing: 'local_only', textDataSharing: 'local_only',
      },
    });
    expect(first.bundle.manifest.fileVersions).toEqual(second.bundle.manifest.fileVersions);
    expect(first.bundle.manifest.bundleHash).toBe(second.bundle.manifest.bundleHash);
    expect(first.findings).toEqual(second.findings);
  });

  it('reports and drops unsupported untyped applicability conditions rather than silently accepting them', () => {
    const result = migrated({
      productTypes: [{ id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-food-profile', oldIdAliases: [] }],
      attributeProfiles: [{
        id: 'dog-food-profile',
        productTypeId: 'dog-food',
        name: 'Dog Food',
        attributes: [{
          attributeId: 'flavor',
          required: true,
          cardinality: 'single',
          applicabilityConditions: [{ arbitrary: 'legacy-shape' }],
          constraints: {},
          confidenceThresholds: {},
          valueAliases: [],
        }],
      }],
    });
    expect(result.lossy).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported_applicability_condition', severity: 'error' }),
    ]));
    expect(result.bundle.attributeProfiles[0].attributes[0].applicabilityConditions).toEqual([]);
  });
});

describe('classification v2 structural and semantic validation', () => {
  it('rejects unknown keys and unsupported versions in strict v2 schemas', () => {
    const attribute = migrated().bundle.attributes[0];
    expect(ProductAttributeConfigV2Schema.safeParse({ ...attribute, surprise: true }).success).toBe(false);
    const missingRequired = { ...attribute } as any;
    delete missingRequired.description;
    expect(ProductAttributeConfigV2Schema.safeParse(missingRequired).success).toBe(false);

    const bundle = structuredClone(migrated().bundle) as any;
    bundle.manifest.schemaVersion = 3;
    expect(ClassificationConfigBundleV2Schema.safeParse(bundle).success).toBe(false);
    expect(findingCodes(bundle)).toContain('schema_invalid');
  });

  it('reports duplicate and dangling IDs with paths', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributes.push({ ...bundle.attributes[0] });
    bundle.attributeMappings[0].attributeId = 'missing-attribute';
    const report = validateClassificationConfigBundle(bundle);
    expect(report.valid).toBe(false);
    expect(report.config).toBeUndefined();
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_id', path: '$.attributes[1].id' }),
      expect.objectContaining({ code: 'dangling_attribute', path: '$.attributeMappings[0].attributeId' }),
    ]));
  });

  it('rejects controlled aliases to unknown values and missing measured units', () => {
    const controlled = structuredClone(migrated().bundle);
    controlled.attributes[0].valueAliases.push({ alias: 'turkey', mapsTo: 'Turkey' });
    expect(findingCodes(controlled)).toContain('alias_target_unknown');

    const measured = structuredClone(migrated().bundle);
    measured.attributes[0].valueMode = 'measured';
    measured.attributes[0].canonicalUnit = null;
    measured.attributeMappings[0].serialization = {
      kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '', suffix: '',
    };
    expect(findingCodes(measured)).toEqual(expect.arrayContaining(['measured_unit_required', 'measured_unit_mismatch']));
  });

  it('rejects non-canonical and ambiguous controlled values (issue #17 G)', () => {
    const nonCanonical = structuredClone(migrated().bundle);
    nonCanonical.attributes[0].allowedValues = [' Chicken', 'Beef'];
    expect(findingCodes(nonCanonical)).toContain('non_canonical_controlled_value');

    const controlChar = structuredClone(migrated().bundle);
    controlChar.attributes[0].allowedValues = ['Dog\u0007', 'Beef'];
    expect(findingCodes(controlChar)).toContain('non_canonical_controlled_value');

    const caseCollision = structuredClone(migrated().bundle);
    caseCollision.attributes[0].allowedValues = ['Dog', 'dog'];
    const caseCodes = findingCodes(caseCollision);
    expect(caseCodes).toContain('ambiguous_controlled_value');
    expect(caseCodes).not.toContain('non_canonical_controlled_value');
    expect(validateClassificationConfigBundle(caseCollision).valid).toBe(false);

    const whitespaceCollision = structuredClone(migrated().bundle);
    whitespaceCollision.attributes[0].allowedValues = ['Beef', 'Beef '];
    expect(findingCodes(whitespaceCollision)).toContain('ambiguous_controlled_value');

    // A clean distinct canonical set stays valid.
    const clean = structuredClone(migrated().bundle);
    clean.attributes[0].allowedValues = ['Chicken', 'Beef'];
    expect(validateClassificationConfigBundle(clean).valid).toBe(true);
  });

  it('rejects serialization/cardinality mismatches', () => {
    const result = migrated({
      productTypes: [{ id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-food-profile', oldIdAliases: [] }],
      attributeProfiles: [{
        id: 'dog-food-profile', productTypeId: 'dog-food', name: 'Dog Food',
        attributes: [{
          attributeId: 'flavor', required: true, cardinality: 'multiple', applicabilityConditions: [],
          constraints: {}, confidenceThresholds: {}, valueAliases: [],
        }],
      }],
    });
    const bundle = structuredClone(result.bundle);
    bundle.attributeMappings[0].serialization = { kind: 'scalar', prefix: '', suffix: '' };
    expect(findingCodes(bundle)).toContain('serialization_cardinality_mismatch');
  });

  it('rejects unsafe claim/composition evidence policies', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributes[0].isClaim = true;
    bundle.attributes[0].evidencePolicy = {
      directEvidenceRequired: false,
      forbidAbsenceInference: false,
      allowedSources: ['page_context', 'third_party_page', 'visual_product_evidence'],
      allowVisualEvidence: true,
      allowThirdPartyEvidence: true,
      thirdPartyEvidenceApproval: null,
      manualReviewRequired: false,
    };
    expect(findingCodes(bundle)).toEqual(expect.arrayContaining([
      'unsafe_direct_evidence_policy',
      'unsafe_evidence_source',
      'third_party_review_approval_required',
    ]));
  });

  it('keeps ML features fail-closed without qualification and activation audit', () => {
    const qualified = structuredClone(migrated().bundle);
    qualified.modelPolicy.mlFeatures.productionRetrieval.state = 'qualified';
    expect(findingCodes(qualified)).toContain('ml_qualification_receipt_required');

    const enabled = structuredClone(migrated().bundle);
    enabled.modelPolicy.mlFeatures.productionEmbeddings.state = 'enabled';
    enabled.modelPolicy.mlFeatures.productionEmbeddings.qualificationReceiptDigest = 'a'.repeat(64);
    expect(findingCodes(enabled)).toContain('ml_activation_audit_required');
  });

  it('enforces supplied catalog-field attestations', () => {
    const bundle = migrated().bundle;
    expect(validateClassificationConfigBundle(bundle, { catalogFields: ['ProductField23'] }).valid).toBe(true);
    const report = validateClassificationConfigBundle(bundle, { catalogFields: ['ProductField16'] });
    expect(report.valid).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'catalog_field_unattested', path: '$.attributeMappings[0].catalogField' }),
    ]));
  });

  it('requires every persisted v2 field explicitly', () => {
    const attribute = structuredClone(migrated().bundle.attributes[0]) as any;
    delete attribute.oldIdAliases;
    expect(ProductAttributeConfigV2Schema.safeParse(attribute).success).toBe(false);

    const mapping = structuredClone(migrated().bundle.attributeMappings[0]) as any;
    delete mapping.serialization.prefix;
    const bundle = structuredClone(migrated().bundle) as any;
    bundle.attributeMappings[0] = mapping;
    expect(ClassificationConfigBundleV2Schema.safeParse(bundle).success).toBe(false);

    const policy = structuredClone(migrated().bundle) as any;
    delete policy.modelPolicy.mlFeatures.productionRetrieval.state;
    expect(ClassificationConfigBundleV2Schema.safeParse(policy).success).toBe(false);
  });

  it('separates preview and active provenance/attestation validation', () => {
    const preview = migrated().bundle;
    expect(validateClassificationConfigBundle(preview, { mode: 'preview' }).valid).toBe(true);
    expect(findingCodes(preview)).not.toContain('active_catalog_commit_required');

    const unready = validateClassificationConfigBundle(preview, {
      mode: 'active',
      catalogFields: ['ProductField23'],
    });
    expect(unready.valid).toBe(false);
    expect(unready.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'active_lifecycle_required',
      'active_catalog_commit_required',
      'active_catalog_evidence_required',
      'preview_revision_not_active',
    ]));

    const active = activeBundle(preview);
    expect(validateClassificationConfigBundle(active).findings.map(finding => finding.code))
      .toContain('preview_lifecycle_required');
    expect(validateClassificationConfigBundle(active, { mode: 'preview' }).valid).toBe(false);
    expect(validateClassificationConfigBundle(active, {
      mode: 'active',
      catalogFields: ['ProductField23'],
      verifyCatalogEvidence: verifiedVerifier,
    }).valid).toBe(true);
    expect(validateClassificationConfigBundle(active, { mode: 'active' }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'catalog_attestation_required' })]));
    expect(validateClassificationConfigBundle(active, { mode: 'active', catalogFields: ['ProductField23'] }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'catalog_evidence_verifier_required' })]));
    expect(validateClassificationConfigBundle(active, {
      mode: 'active',
      catalogFields: ['ProductField23'],
      verifyCatalogEvidence: () => ({ verified: false, reason: 'committed evidence artifact mismatch' }),
    }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'catalog_evidence_unverified' })]));
  });

  it('enforces sensitive filtering and explicit reviewed third-party claim exceptions', () => {
    const unsafeSharing = structuredClone(migrated().bundle) as any;
    unsafeSharing.dataSharing.sensitiveDataFiltering = false;
    expect(findingCodes(unsafeSharing)).toContain('schema_invalid');
    expect(EvidencePolicySourceSchema.safeParse('catalog_manager_guidance').success).toBe(false);

    const reviewed = structuredClone(migrated().bundle);
    reviewed.attributes[0].isClaim = true;
    reviewed.attributes[0].evidencePolicy = {
      directEvidenceRequired: true,
      forbidAbsenceInference: true,
      allowedSources: ['official_product_page', 'third_party_page'],
      allowVisualEvidence: false,
      allowThirdPartyEvidence: true,
      thirdPartyEvidenceApproval: {
        approvedBy: 'catalog-manager',
        approvedAt: '2026-08-01T12:00:00.000Z',
        provenanceRequirement: 'direct_product_statement',
      },
      manualReviewRequired: true,
    };
    expect(validateClassificationConfigBundle(reviewed).valid).toBe(true);

    reviewed.attributes[0].evidencePolicy.thirdPartyEvidenceApproval = null;
    expect(findingCodes(reviewed)).toContain('third_party_review_approval_required');
  });

  it('rejects self-referential, cyclic, impossible, and operator-incompatible applicability', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributes.push({
      ...structuredClone(bundle.attributes[0]),
      id: 'species',
      name: 'Species',
      allowedValues: ['Dog', 'Cat'],
      valueAliases: [],
      oldIdAliases: [],
    });
    bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
    bundle.productTypes = [{
      id: 'dog-food', name: 'Dog Food', description: null,
      attributeProfileId: 'dog-food-profile', oldIdAliases: [], categoryId: 'food',
    }];
    bundle.attributeProfiles = [{
      id: 'dog-food-profile', productTypeId: 'dog-food', name: 'Dog Food', oldIdAliases: [],
      attributes: [
        {
          attributeId: 'flavor', required: false, cardinality: 'single', constraints: {}, confidenceThresholds: {},
          valueAliases: [{ alias: 'chicken flavor', mapsTo: 'Chicken' }],
          applicabilityConditions: [{ operator: 'equals', attributeId: 'flavor', value: 'Turkey', factSource: 'accepted_reviewed' }],
        },
        {
          attributeId: 'species', required: false, cardinality: 'multiple', constraints: {}, confidenceThresholds: {}, valueAliases: [],
          applicabilityConditions: [{ operator: 'equals', attributeId: 'flavor', value: 'Chicken', factSource: 'accepted_reviewed' }],
        },
      ],
    }];
    const codes = findingCodes(bundle);
    expect(codes).toEqual(expect.arrayContaining([
      'self_referential_applicability',
      'impossible_condition_value',
      'applicability_cycle',
      'duplicate_value_alias',
    ]));

    bundle.attributeProfiles[0].attributes[0].applicabilityConditions = [{
      operator: 'containsAny', attributeId: 'flavor', values: ['Chicken'], factSource: 'accepted_reviewed',
    }];
    expect(findingCodes(bundle)).toContain('condition_operator_cardinality_mismatch');
  });

  it('allows profile-scoped mixed cardinality when the shared serializer supports multiple use', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
    bundle.productTypes = [
      { id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'food' },
      { id: 'cat-food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [], categoryId: 'food' },
    ];
    bundle.attributeProfiles = [
      { id: 'dog-profile', productTypeId: 'dog-food', name: 'Dog Profile', oldIdAliases: [], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      { id: 'cat-profile', productTypeId: 'cat-food', name: 'Cat Profile', oldIdAliases: [], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'multiple', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
    ];
    bundle.attributeMappings[0].serialization = { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' };
    const report = validateClassificationConfigBundle(bundle);
    expect(report.findings.map(finding => finding.code)).not.toContain('mixed_attribute_cardinality');
    expect(report.valid).toBe(true);
  });

  it('enforces kind-specific targets and verified Page prerequisites', () => {
    const targetBundle = structuredClone(migrated().bundle);
    targetBundle.curationTargets = [{
      id: 'primary-type', kind: 'product_type', label: 'Type', enabled: true, mandatory: false,
      selectionMode: 'multiple', attributeId: null, catalogField: null,
      optionSource: 'live_store', required: false, sortOrder: 0,
    }];
    expect(findingCodes(targetBundle)).toContain('product_type_target_contract');

    const active = activeBundle(structuredClone(migrated().bundle));
    active.curationTargets = [{
      id: 'pages', kind: 'page', label: 'Pages', enabled: true, mandatory: false,
      selectionMode: 'multiple', attributeId: null, catalogField: null,
      optionSource: 'live_store', required: false, sortOrder: 0,
    }];
    expect(validateClassificationConfigBundle(active, { mode: 'active', catalogFields: ['ProductField23'], verifyCatalogEvidence: verifiedVerifier }).findings)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'verified_page_catalog_required' })]));
  });

  it('validates stage overrides, fallback pairs, sharing coherence, guidance refs, aliases, and labels', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.modelPolicy.stageOverrides.typo_stage = {
      fallbackProvider: 'ollama', fallbackModel: null,
    };
    bundle.modelPolicy.textDataSharing = 'cloud_allowed';
    bundle.guidance.push({
      id: 'missing-mapping-guidance', scope: 'attributeMapping', scopeId: 'missing',
      structured: {}, freeForm: null, manualReviewRequirement: true,
    });
    bundle.attributes.push({ ...structuredClone(bundle.attributes[0]), id: 'flavor-2', oldIdAliases: ['flavor'], name: 'Flavor' });
    const report = validateClassificationConfigBundle(bundle);
    expect(report.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'unknown_model_stage',
      'incomplete_model_fallback',
      'data_sharing_policy_conflict',
      'dangling_guidance_scope',
      'duplicate_old_id_alias',
      'duplicate_display_label',
    ]));
  });

  it('requires independently verified receipts before active ML enablement', () => {
    const bundle = activeBundle(structuredClone(migrated().bundle));
    const receipt = 'c'.repeat(64);
    bundle.modelPolicy.mlFeatures.productionRetrieval = {
      state: 'enabled', qualificationReceiptDigest: receipt,
      activatedBy: 'catalog-manager', activatedAt: '2026-08-01T12:00:00.000Z',
    };
    expect(validateClassificationConfigBundle(bundle, {
      mode: 'active', catalogFields: ['ProductField23'], verifyCatalogEvidence: verifiedVerifier,
    }).findings.map(finding => finding.code)).toContain('ml_verified_receipt_required');
    expect(validateClassificationConfigBundle(bundle, {
      mode: 'active', catalogFields: ['ProductField23'], verifyCatalogEvidence: verifiedVerifier,
      verifiedQualificationReceiptDigests: [receipt],
    }).valid).toBe(true);
  });

  it('detects focused-file and bundle hash mismatches without returning a partial config', () => {
    const result = migrated();
    const changedFiles = { ...result.focusedFiles, 'attributes.json': `${result.focusedFiles['attributes.json']} ` };
    const fileReport = validateClassificationConfigBundle(result.bundle, { focusedFileContents: changedFiles });
    expect(fileReport.valid).toBe(false);
    expect(fileReport.config).toBeUndefined();
    expect(fileReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'file_hash_mismatch', path: '$.manifest.fileVersions.attributes.json' }),
    ]));

    const bundle = structuredClone(result.bundle);
    bundle.manifest.bundleHash = '0'.repeat(64);
    expect(findingCodes(bundle)).toContain('bundle_hash_mismatch');
  });

  it('I4: rejects two attributes mapped to the same Catalog Field (duplicate_catalog_field_mapping)', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributes.push({
      ...structuredClone(bundle.attributes[0]),
      id: 'flavor-2',
      name: 'Flavor Two',
      valueAliases: [],
      oldIdAliases: [],
    });
    bundle.attributeMappings.push({
      ...structuredClone(bundle.attributeMappings[0]),
      id: 'flavor-2-mapping',
      attributeId: 'flavor-2',
      // Same catalogField as the flavor mapping → the field is claimed twice.
    });
    const codes = findingCodes(bundle);
    expect(codes).toContain('duplicate_catalog_field_mapping');
    expect(codes).not.toContain('duplicate_attribute_mapping');
  });

  it('governs Category and Product Type output bindings as an atomic pair separate from attributes', () => {
    const mappings = [
      { role: 'category' as const, catalogField: 'ProductField24', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
      { role: 'product-type' as const, catalogField: 'ProductField25', serialization: { kind: 'scalar' as const, prefix: '', suffix: '' }, isStale: false },
    ];

    const missingMate = structuredClone(migrated().bundle);
    missingMate.classificationOutputBindings = [mappings[0]];
    expect(findingCodes(missingMate)).toContain('canonical_output_binding_incomplete');

    const crossedRoles = structuredClone(migrated().bundle);
    crossedRoles.classificationOutputBindings = [
      { ...mappings[0], catalogField: 'ProductField25' },
      { ...mappings[1], catalogField: 'ProductField24' },
    ];
    expect(findingCodes(crossedRoles)).toContain('canonical_output_binding_unapproved');

    const approvedPair = structuredClone(migrated().bundle);
    approvedPair.classificationOutputBindings = mappings;
    expect(findingCodes(approvedPair)).not.toEqual(expect.arrayContaining([
      'canonical_output_binding_incomplete',
      'canonical_output_binding_unapproved',
      'duplicate_canonical_output_field',
    ]));
  });

  it('I5: rejects one attribute mapped to two Catalog Fields (duplicate_attribute_mapping)', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributeMappings.push({
      ...structuredClone(bundle.attributeMappings[0]),
      id: 'flavor-mapping-2',
      catalogField: 'ProductField24',
    });
    const codes = findingCodes(bundle);
    expect(codes).toContain('duplicate_attribute_mapping');
    expect(codes).not.toContain('duplicate_catalog_field_mapping');
  });

  it('I6: rejects an enabled product-field target whose catalogField mismatches its mapping', () => {
    const bundle = structuredClone(migrated().bundle);
    // flavor is mapped to ProductField23; the target names ProductField24.
    bundle.curationTargets.push({
      id: 'flavor-target',
      kind: 'product_field',
      label: 'Flavor',
      enabled: true,
      mandatory: false,
      selectionMode: 'single',
      attributeId: 'flavor',
      catalogField: 'ProductField24',
      optionSource: 'configured',
      required: false,
      sortOrder: 1,
    });
    const report = validateClassificationConfigBundle(bundle);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'target_mapping_mismatch', path: '$.curationTargets[1].catalogField' }),
    ]));
    expect(report.valid).toBe(false);

    // A matching target stays clean.
    const aligned = structuredClone(migrated().bundle);
    aligned.curationTargets.push({
      ...structuredClone(bundle.curationTargets[1]),
      catalogField: 'ProductField23',
    });
    expect(validateClassificationConfigBundle(aligned).valid).toBe(true);
  });

  it('D6: identical bundles differing only in updatedAt produce the same bundleHash', () => {
    const first = migrated();
    const second = structuredClone(first.bundle);
    second.manifest.updatedAt = '2026-12-01T12:00:00.000Z';
    // The semantic hash excludes updatedAt entirely.
    expect(computeClassificationBundleHash(second.manifest)).toBe(first.bundle.manifest.bundleHash);
    second.manifest.bundleHash = computeClassificationBundleHash(second.manifest);
    expect(second.manifest.bundleHash).toBe(first.bundle.manifest.bundleHash);
    // validateClassificationConfigBundle recomputes with the same rule, so a
    // bundle whose only difference is updatedAt never trips bundle_hash_mismatch.
    const codes = validateClassificationConfigBundle(second).findings.map(finding => finding.code);
    expect(codes).not.toContain('bundle_hash_mismatch');
    expect(codes).not.toContain('missing_file_hash');
  });

  it('binds migration findings into the manifest and rejects stripping or flag flips', () => {
    const result = migrated();
    expect(result.bundle.manifest.migrationProvenance).toEqual(expect.objectContaining({
      sourceSchemaVersion: 1,
      findingCount: result.findings.length,
      errorCount: result.findings.filter(finding => finding.severity === 'error').length,
    }));
    const complete = validateClassificationConfigBundle(result.bundle, {
      mode: 'preview',
      unresolvedMigrationFindings: result.findings,
    });
    expect(complete.findings.map(finding => finding.code))
      .not.toEqual(expect.arrayContaining(['migration_findings_digest_mismatch', 'migration_finding_count_mismatch']));
    const stripped = validateClassificationConfigBundle(result.bundle, {
      mode: 'preview',
      unresolvedMigrationFindings: result.findings.filter(finding => finding.severity !== 'error'),
    });
    expect(stripped.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'migration_findings_digest_mismatch',
      'migration_finding_count_mismatch',
      'migration_finding_error_count_mismatch',
    ]));

    const forgedCount = structuredClone(result.bundle);
    if (forgedCount.manifest.migrationProvenance.kind !== 'migrated_v1') {
      throw new Error('Expected migrated provenance.');
    }
    forgedCount.manifest.migrationProvenance.errorCount = 0;
    forgedCount.manifest.bundleHash = computeClassificationBundleHash(forgedCount.manifest);
    expect(validateClassificationConfigBundle(forgedCount, {
      mode: 'preview', unresolvedMigrationFindings: result.findings,
    }).findings.map(finding => finding.code)).toContain('migration_finding_error_count_mismatch');

    const manifestOnlyCleaned = structuredClone(result.bundle);
    manifestOnlyCleaned.manifest.activeRevision = 'bay-state-v2';
    manifestOnlyCleaned.manifest.lifecycle = 'active';
    manifestOnlyCleaned.manifest.hasUnresolvedSafetyFindings = false;
    manifestOnlyCleaned.manifest.migrationProvenance = { kind: 'reviewed_generation' };
    manifestOnlyCleaned.manifest.sourceCatalogCommit = 'a'.repeat(40);
    manifestOnlyCleaned.manifest.catalogEvidenceHash = 'b'.repeat(64);
    manifestOnlyCleaned.manifest.bundleHash = computeClassificationBundleHash(manifestOnlyCleaned.manifest);
    expect(validateClassificationConfigBundle(manifestOnlyCleaned, {
      mode: 'active', catalogFields: ['ProductField23'], verifyCatalogEvidence: verifiedVerifier,
    }).findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'bundle_origin_mismatch', 'unresolved_migration_provenance',
    ]));

    const falseInMemoryClaim = structuredClone(manifestOnlyCleaned);
    falseInMemoryClaim.bundleOrigin = { kind: 'reviewed_generation' };
    expect(validateClassificationConfigBundle(falseInMemoryClaim, {
      mode: 'active', catalogFields: ['ProductField23'], verifyCatalogEvidence: verifiedVerifier,
      focusedFileContents: result.focusedFiles,
    }).findings.map(finding => finding.code)).toContain('focused_file_origin_mismatch');

    const flipped = structuredClone(result.bundle);
    flipped.manifest.activeRevision = 'bay-state-v2';
    flipped.manifest.lifecycle = 'active';
    flipped.manifest.hasUnresolvedSafetyFindings = false;
    flipped.manifest.sourceCatalogCommit = 'a'.repeat(40);
    flipped.manifest.catalogEvidenceHash = 'b'.repeat(64);
    flipped.manifest.bundleHash = computeClassificationBundleHash(flipped.manifest);
    const report = validateClassificationConfigBundle(flipped, {
      mode: 'active',
      catalogFields: ['ProductField23'],
      verifyCatalogEvidence: verifiedVerifier,
    });
    expect(report.valid).toBe(false);
    expect(report.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'unresolved_migration_provenance',
      'migration_provenance_inconsistent',
    ]));
  });

  it('rejects applicability facts that are neither universal nor in the same profile', () => {
    const bundle = structuredClone(migrated().bundle);
    bundle.attributes.push({
      ...structuredClone(bundle.attributes[0]),
      id: 'species',
      name: 'Species',
      allowedValues: ['Dog', 'Cat'],
      valueAliases: [],
      oldIdAliases: [],
    });
    bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
    bundle.productTypes = [{
      id: 'dog-food', name: 'Dog Food', description: null,
      attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'food',
    }];
    bundle.attributeProfiles = [{
      id: 'dog-profile', productTypeId: 'dog-food', name: 'Dog', oldIdAliases: [],
      attributes: [{
        attributeId: 'flavor', required: true, cardinality: 'single', constraints: {}, confidenceThresholds: {},
        valueAliases: [],
        applicabilityConditions: [{
          operator: 'equals', attributeId: 'species', value: 'Dog', factSource: 'accepted_reviewed',
        }],
      }],
    }];
    expect(findingCodes(bundle)).toContain('condition_attribute_not_applicable');

    bundle.attributes[1].isUniversal = true;
    const report = validateClassificationConfigBundle(bundle);
    expect(report.valid).toBe(true);
    expect(report.findings.map(finding => finding.code)).not.toContain('condition_attribute_not_applicable');
  });

  it('requires exactly one Primary Product Type target and rejects mixed-cardinality global targets', () => {
    const withoutTarget = structuredClone(migrated().bundle);
    withoutTarget.curationTargets = [];
    expect(findingCodes(withoutTarget)).toContain('product_type_target_required');

    const duplicated = structuredClone(migrated().bundle);
    duplicated.curationTargets = [
      ...duplicated.curationTargets,
      { ...duplicated.curationTargets[0], id: 'primary-type-2', label: 'Second Type Target' },
    ];
    expect(findingCodes(duplicated)).toContain('duplicate_product_type_target');

    const mixed = structuredClone(migrated().bundle);
    mixed.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
    mixed.productTypes = [
      { id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'food' },
      { id: 'cat-food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [], categoryId: 'food' },
    ];
    mixed.attributeProfiles = [
      { id: 'dog-profile', productTypeId: 'dog-food', name: 'Dog', oldIdAliases: [], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      { id: 'cat-profile', productTypeId: 'cat-food', name: 'Cat', oldIdAliases: [], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'multiple', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
    ];
    mixed.attributeMappings[0].serialization = { kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '' };
    mixed.curationTargets = [
      ...mixed.curationTargets,
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 1 },
    ];
    expect(findingCodes(mixed)).toContain('target_cardinality_conflict');

    const single = structuredClone(migrated().bundle);
    single.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
    single.productTypes = [{ id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'food' }];
    single.attributeProfiles = [{ id: 'dog-profile', productTypeId: 'dog-food', name: 'Dog', oldIdAliases: [], attributes: [{ attributeId: 'flavor', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] }];
    single.curationTargets = [
      ...single.curationTargets,
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'multiple', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 1 },
    ];
    expect(findingCodes(single)).toContain('target_cardinality_mismatch');

    const mandatoryDisabled = structuredClone(single);
    const mandatoryTarget = mandatoryDisabled.curationTargets.find(target => target.kind === 'product_field');
    if (!mandatoryTarget) throw new Error('Expected Product Field target.');
    mandatoryTarget.enabled = false;
    mandatoryTarget.mandatory = true;
    mandatoryDisabled.attributeMappings[0].isStale = true;
    mandatoryDisabled.attributeMappings[0].serialization = { kind: 'scalar', prefix: '', suffix: '' };
    expect(findingCodes(mandatoryDisabled)).toEqual(expect.arrayContaining([
      'stale_mapping_enabled',
      'serialization_cardinality_mismatch',
      'target_cardinality_mismatch',
    ]));

    const duplicateFields = structuredClone(migrated().bundle);
    duplicateFields.curationTargets.push(
      { id: 'flavor-target-1', kind: 'product_field', label: 'Flavor 1', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 1 },
      { id: 'flavor-target-2', kind: 'product_field', label: 'Flavor 2', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, sortOrder: 2 },
    );
    expect(findingCodes(duplicateFields)).toEqual(expect.arrayContaining([
      'duplicate_product_field_target_attribute',
      'duplicate_product_field_target_catalog_field',
    ]));
  });

  it('enforces complete provider/model pairs and locality attestation', () => {
    const undeclared = structuredClone(migrated().bundle);
    undeclared.modelPolicy.defaultProvider = 'openai';
    expect(findingCodes(undeclared)).toContain('provider_locality_undeclared');

    const conflicting = structuredClone(undeclared);
    conflicting.modelPolicy.providerLocalities.openai = 'cloud';
    expect(findingCodes(conflicting)).toContain('provider_locality_conflict');

    const cloudApproved = structuredClone(conflicting);
    cloudApproved.modelPolicy.imageDataSharing = 'cloud_allowed';
    cloudApproved.modelPolicy.textDataSharing = 'cloud_allowed';
    cloudApproved.dataSharing.imagePolicy = 'cloud_allowed';
    cloudApproved.dataSharing.textPolicy = 'cloud_allowed';
    expect(validateClassificationConfigBundle(cloudApproved).valid).toBe(true);
    const textOnlyCloud = structuredClone(cloudApproved);
    textOnlyCloud.modelPolicy.imageDataSharing = 'local_only';
    textOnlyCloud.dataSharing.imagePolicy = 'local_only';
    expect(validateClassificationConfigBundle(textOnlyCloud).valid).toBe(true);

    const partialOverride = structuredClone(migrated().bundle);
    partialOverride.modelPolicy.stageOverrides.evidence_extraction = {
      provider: 'ollama', fallbackProvider: null, fallbackModel: null,
    };
    expect(findingCodes(partialOverride)).toContain('incomplete_model_override');

    const emptyDefault = structuredClone(migrated().bundle) as any;
    emptyDefault.modelPolicy.defaultProvider = '';
    expect(findingCodes(emptyDefault)).toContain('empty_model_default_pair');

    const inherited = structuredClone(migrated().bundle);
    inherited.modelPolicy.defaultProvider = 'toString';
    inherited.modelPolicy.providerLocalities = {};
    inherited.modelPolicy.imageDataSharing = 'cloud_allowed';
    inherited.modelPolicy.textDataSharing = 'cloud_allowed';
    inherited.dataSharing.imagePolicy = 'cloud_allowed';
    inherited.dataSharing.textPolicy = 'cloud_allowed';
    expect(findingCodes(inherited)).toContain('provider_locality_undeclared');
  });

  it('requires old-id aliases to be valid stable slugs distinct from their own id', () => {
    const selfAliased = structuredClone(migrated().bundle);
    selfAliased.attributes[0].oldIdAliases = ['flavor', 'flavor'];
    expect(findingCodes(selfAliased)).toEqual(expect.arrayContaining([
      'alias_equals_current_id',
      'duplicate_old_id_alias',
    ]));

    const nonSlug = structuredClone(migrated().bundle) as any;
    nonSlug.attributes[0].oldIdAliases = ['Flavor!'];
    expect(findingCodes(nonSlug)).toContain('schema_invalid');

    const emptyAlias = structuredClone(migrated().bundle) as any;
    emptyAlias.attributes[0].oldIdAliases = [''];
    expect(findingCodes(emptyAlias)).toContain('schema_invalid');

    const crossOwner = structuredClone(migrated().bundle);
    crossOwner.attributes.push({ ...structuredClone(crossOwner.attributes[0]), id: 'flavor-2', oldIdAliases: ['flavor'] });
    expect(findingCodes(crossOwner)).toContain('duplicate_old_id_alias');

    const forwardCollision = structuredClone(migrated().bundle);
    forwardCollision.attributes[0].oldIdAliases = ['future-flavor'];
    forwardCollision.attributes.push({
      ...structuredClone(forwardCollision.attributes[0]),
      id: 'future-flavor',
      name: 'Future Flavor',
      oldIdAliases: [],
    });
    expect(findingCodes(forwardCollision)).toContain('duplicate_old_id_alias');
  });

  describe('evaluateClassificationReadiness (Issue #4)', () => {
    it('flags page-only workspace with a warning that Product Type and Product Attribute outputs are disabled', () => {
      const pageOnlyBundle = structuredClone(migrated().bundle);
      pageOnlyBundle.curationTargets = [{
        id: 'store-pages',
        kind: 'page',
        label: 'Category Pages',
        enabled: true,
        mandatory: false,
        selectionMode: 'multiple',
        attributeId: null,
        catalogField: null,
        optionSource: 'live_store',
        required: false,
        sortOrder: 0,
      }];

      const report = evaluateClassificationReadiness(pageOnlyBundle);
      expect(report.hasWarnings).toBe(true);
      expect(report.findings.map(f => f.code)).toContain('page_only_workspace');
      expect(report.capabilities.productType.runnable).toBe(false);
      expect(report.capabilities.productFields.runnable).toBe(false);
      expect(report.capabilities.categoryPages.runnable).toBe(true);
    });

    it('blocks readiness when a mandatory target has no legal options', () => {
      const noTypesBundle = structuredClone(migrated().bundle);
      noTypesBundle.productTypes = [];
      noTypesBundle.curationTargets = [{
        id: 'primary-product-type',
        kind: 'product_type',
        label: 'Primary Product Type',
        enabled: true,
        mandatory: true,
        selectionMode: 'single',
        attributeId: null,
        catalogField: null,
        optionSource: 'configured',
        required: true,
        sortOrder: 0,
      }];

      const report = evaluateClassificationReadiness(noTypesBundle);
      expect(report.isReady).toBe(false);
      expect(report.findings.map(f => f.code)).toContain('target_no_legal_options');
      expect(report.capabilities.productType.runnable).toBe(false);
    });

    it('reports isReady: true for a fully configured workspace with legal options', () => {
      const fullBundle = structuredClone(migrated().bundle);
      fullBundle.categories = [{ id: 'dog-food', name: 'Dog Food', description: null, oldIdAliases: [] }];
      fullBundle.productTypes = [{
        id: 'dog_food_dry',
        name: 'Dry Dog Food',
        description: 'Kibble',
        attributeProfileId: null,
        oldIdAliases: [],
        categoryId: 'dog-food',
      }];
      fullBundle.curationTargets = [
        {
          id: 'primary-product-type',
          kind: 'product_type',
          label: 'Primary Product Type',
          enabled: true,
          mandatory: true,
          selectionMode: 'single',
          attributeId: null,
          catalogField: null,
          optionSource: 'configured',
          required: true,
          sortOrder: 0,
        },
        {
          id: 'flavor-target',
          kind: 'product_field',
          label: 'Flavor',
          enabled: true,
          mandatory: false,
          selectionMode: 'single',
          attributeId: 'flavor',
          catalogField: 'ProductField23',
          optionSource: 'live_store',
          required: false,
          sortOrder: 1,
        },
      ];

      const report = evaluateClassificationReadiness(fullBundle);
      expect(report.isReady).toBe(true);
      expect(report.capabilities.productType.runnable).toBe(true);
      expect(report.capabilities.productFields.runnable).toBe(true);
      expect(report.summary.length).toBe(3);
    });
  });

  describe('Product Type Invariant Attributes Validation', () => {
    const makeSpeciesAttrV2 = (bundle: any, isUniversal = true) => {
      const attr = structuredClone(bundle.attributes[0]);
      attr.id = 'species';
      attr.name = 'Species';
      attr.valueMode = 'controlled';
      attr.allowedValues = ['Dog', 'Cat'];
      attr.valueAliases = [];
      attr.isUniversal = isUniversal;
      return attr;
    };

    it('passes valid invariant attributes on product types', () => {
      const bundle = migrated().bundle;
      bundle.attributes = [makeSpeciesAttrV2(bundle, true)];
      bundle.attributeMappings[0].attributeId = 'species';
      bundle.curationTargets = [
        bundle.curationTargets.find(t => t.id === 'primary-product-type')!,
      ];
      bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
      bundle.productTypes = [{
        id: 'dog-food-dry',
        name: 'Dry Dog Food',
        description: null,
        attributeProfileId: null,
        oldIdAliases: [],
        categoryId: 'food',
        invariantAttributes: {
          species: 'Dog',
        },
      }];

      const findings = validateClassificationConfigBundle(bundle).findings;
      const errors = findings.filter(f => f.severity === 'error');
      expect(errors).toEqual([]);
    });

    it('rejects invariant for unknown attribute', () => {
      const bundle = migrated().bundle;
      bundle.attributes = [makeSpeciesAttrV2(bundle, true)];
      bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
      bundle.productTypes = [{
        id: 'dog-food-dry',
        name: 'Dry Dog Food',
        description: null,
        attributeProfileId: null,
        oldIdAliases: [],
        categoryId: 'food',
        invariantAttributes: {
          'non-existent-attr': 'Value',
        },
      }];

      const findings = validateClassificationConfigBundle(bundle).findings;
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'unknown_invariant_attribute',
          severity: 'error',
        }),
      );
    });

    it('rejects invariant attribute not in profile and not universal', () => {
      const bundle = migrated().bundle;
      bundle.attributes = [makeSpeciesAttrV2(bundle, false)];
      bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
      bundle.productTypes = [{
        id: 'dog-food-dry',
        name: 'Dry Dog Food',
        description: null,
        attributeProfileId: 'empty-profile',
        oldIdAliases: [],
        categoryId: 'food',
        invariantAttributes: {
          species: 'Dog',
        },
      }];
      bundle.attributeProfiles = [{
        id: 'empty-profile',
        productTypeId: 'dog-food-dry',
        name: 'Empty Profile',
        attributes: [],
        oldIdAliases: [],
      }];

      const findings = validateClassificationConfigBundle(bundle).findings;
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'invariant_attribute_not_applicable',
          severity: 'error',
        }),
      );
    });

    it('rejects invalid controlled value for invariant', () => {
      const bundle = migrated().bundle;
      bundle.attributes = [makeSpeciesAttrV2(bundle, true)];
      bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
      bundle.productTypes = [{
        id: 'dog-food-dry',
        name: 'Dry Dog Food',
        description: null,
        attributeProfileId: null,
        oldIdAliases: [],
        categoryId: 'food',
        invariantAttributes: {
          species: 'Dragon', // Invalid controlled value
        },
      }];

      const findings = validateClassificationConfigBundle(bundle).findings;
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'invalid_invariant_controlled_value',
          severity: 'error',
        }),
      );
    });

    it('rejects single-cardinality attribute with array invariant', () => {
      const bundle = migrated().bundle;
      bundle.attributes = [makeSpeciesAttrV2(bundle, true)];
      bundle.categories = [{ id: 'food', name: 'Food', description: null, oldIdAliases: [] }];
      bundle.productTypes = [{
        id: 'dog-food-dry',
        name: 'Dry Dog Food',
        description: null,
        attributeProfileId: null,
        oldIdAliases: [],
        categoryId: 'food',
        invariantAttributes: {
          species: ['Dog'] as any, // Array for single cardinality
        },
      }];

      const findings = validateClassificationConfigBundle(bundle).findings;
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: 'invariant_cardinality_mismatch',
          severity: 'error',
        }),
      );
    });
  });
});
