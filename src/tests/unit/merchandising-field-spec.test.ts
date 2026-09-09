import { describe, it, expect } from 'vitest';
import {
  composeMerchandisingFieldSpecs,
  getMerchandisingFieldSpec,
  listMerchandisingFieldSpecsForAttribute,
  getMerchandisingFieldProfileContext,
} from '../../classification/merchandising-field-spec';
import { resolveAlias } from '../../classification/controlled-value-identity';
import type {
  MerchandisingFieldSpecInput,
  RegistryMetadata,
} from '../../shared/schemas/merchandising-field-spec';
import type { ClassificationConfig, ClassificationConfigBundleV2 } from '../../shared/schemas/classification';

describe('MerchandisingFieldSpec pure composer (Ticket #128 / W1)', () => {
  const baseConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 1,
      compatibilityVersion: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      fileVersions: {},
    },
    productTypes: [
      { id: 'pt-dog', name: 'Dog Food', description: null, attributeProfileId: 'prof-dog', oldIdAliases: [] },
      { id: 'pt-cat', name: 'Cat Food', description: null, attributeProfileId: 'prof-cat', oldIdAliases: [] },
    ],
    attributeProfiles: [
      {
        id: 'prof-dog',
        productTypeId: 'pt-dog',
        name: 'Dog Profile',
        attributes: [
          {
            attributeId: 'flavor',
            required: true,
            cardinality: 'single',
            applicabilityConditions: [],
            constraints: { maxItems: 1 },
            confidenceThresholds: { overall: 0.8 },
            valueAliases: [{ alias: 'Canine-Fowl', mapsTo: 'Chicken' }],
          },
        ],
      },
      {
        id: 'prof-cat',
        productTypeId: 'pt-cat',
        name: 'Cat Profile',
        attributes: [
          {
            attributeId: 'flavor',
            required: false,
            cardinality: 'multiple',
            applicabilityConditions: [{ field: 'breed', op: 'eq', value: 'persian' }],
            constraints: {},
            confidenceThresholds: { overall: 0.7 },
            valueAliases: [{ alias: 'Feline-Bird', mapsTo: 'Chicken' }],
          },
        ],
      },
    ],
    attributes: [
      {
        id: 'flavor',
        name: 'Flavor',
        description: 'Product flavor',
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: ['Chicken', 'Beef', 'café'],
        valueAliases: [{ alias: 'Fowl', mapsTo: 'Chicken' }],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: null,
      },
      {
        id: 'weight',
        name: 'Weight',
        description: null,
        valueMode: 'measured',
        canonicalUnit: 'lb',
        allowedValues: [],
        valueAliases: [],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: null,
      },
      {
        id: 'notes',
        name: 'Notes',
        description: null,
        valueMode: 'freeText',
        canonicalUnit: null,
        allowedValues: [],
        valueAliases: [],
        visualEvidenceEligibility: 'eligible',
        isClaim: false,
        isCompositionAttribute: false,
        group: null,
      },
    ],
    attributeMappings: [
      {
        id: 'map-flavor',
        attributeId: 'flavor',
        catalogField: 'ProductField24',
        serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' },
        isStale: false,
      },
      {
        id: 'map-weight',
        attributeId: 'weight',
        catalogField: 'ProductField5',
        serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' },
        isStale: false,
      },
    ],
    curationTargets: [
      {
        id: 'tgt-flavor',
        attributeId: 'flavor',
        catalogField: 'ProductField24',
        kind: 'product_field',
        enabled: true,
        mandatory: false,
        selectionMode: 'single',
        optionSource: 'configured',
        label: 'Flavor Target',
        required: false,
        sortOrder: 1,
      },
      {
        id: 'tgt-disabled',
        attributeId: 'notes',
        catalogField: 'ProductField10',
        kind: 'product_field',
        enabled: false,
        mandatory: true,
        selectionMode: 'single',
        optionSource: 'configured',
        label: 'Disabled Notes Target',
        required: true,
        sortOrder: 2,
      },
    ],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'qwen2.5vl:latest',
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
  };

  const sampleRegistry: RegistryMetadata[] = [
    {
      xmlField: 'ProductField24',
      label: 'Flavor',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: JSON.stringify(['Turkey', 'Duck|Goose']),
    },
    {
      xmlField: 'ProductField5',
      label: 'Weight',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
    },
    {
      xmlField: 'name',
      label: 'Product Name',
      kind: 'core',
      dataType: 'string',
      editable: false,
      required: true,
      uiGroup: 'Core',
      sampleValuesJson: null,
    },
  ];

  it('composes normal mapped controlled field with three distinct value lanes and no mutation', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: { status: 'available', data: sampleRegistry },
      discoveredCatalogFields: ['ProductField50'],
      observations: {
        ProductField24: {
          liveOptions: { status: 'available', data: ['Salmon', 'Lamb'] },
          catalogStats: {
            status: 'available',
            data: {
              nonEmptyCount: 10,
              distinctCount: 3,
              sampleValues: ['Chicken', 'Salmon'],
              topValues: [{ value: 'Chicken', frequency: 7 }],
            },
          },
        },
      },
    };

    const model = composeMerchandisingFieldSpecs(input);

    expect(model.provenance.configurationKind).toBe('complete');
    expect(model.provenance.sourceAvailability.configuration).toBe('available');
    expect(model.provenance.sourceAvailability.registry).toBe('available');
    expect(model.provenance.sourceAvailability.observations).toBe('available');

    const spec24 = getMerchandisingFieldSpec(model, 'ProductField24');
    expect(spec24).not.toBeNull();
    expect(spec24!.catalogField).toBe('ProductField24');
    expect(spec24!.origins).toEqual(['registry', 'mapping', 'target']);
    expect(spec24!.display).toMatchObject({
      label: 'Flavor',
      isFallbackLabel: false,
      kind: 'custom',
      dataType: 'string',
      registryStatus: 'available',
    });

    // Bindings
    expect(spec24!.bindings).toHaveLength(1);
    const binding = spec24!.bindings[0];
    expect(binding.attributeId).toBe('flavor');
    expect(binding.isStale).toBe(false);
    expect(binding.serialization.status).toBe('available');
    expect(binding.configured).toMatchObject({
      attributeId: 'flavor',
      name: 'Flavor',
      valueMode: 'controlled',
      allowedValues: ['Chicken', 'Beef', 'café'],
      status: 'valid',
    });
    expect(binding.configured!.canonicalOptions).toEqual([
      { value: 'Chicken', label: 'Chicken' },
      { value: 'Beef', label: 'Beef' },
      { value: 'café', label: 'café' },
    ]);

    // Profile contexts
    expect(binding.profileContexts).toHaveLength(2);
    expect(binding.profileContexts[0]).toMatchObject({
      profileId: 'prof-dog',
      productTypeId: 'pt-dog',
      required: true,
      cardinality: 'single',
    });
    expect(binding.profileContexts[1]).toMatchObject({
      profileId: 'prof-cat',
      productTypeId: 'pt-cat',
      required: false,
      cardinality: 'multiple',
    });

    // Targets association
    expect(spec24!.targets).toHaveLength(1);
    expect(spec24!.targets[0].target.id).toBe('tgt-flavor');
    expect(spec24!.targets[0].associationReasons).toEqual(['direct_catalog_field', 'mapped_attribute']);

    // Observations (three value lanes stay distinct)
    expect(spec24!.observed.liveOptions).toEqual({ status: 'available', data: ['Salmon', 'Lamb'] });
    expect(spec24!.observed.parsedRegistrySamples).toEqual(['Turkey', 'Duck', 'Goose']);
    expect(spec24!.observed.inferredDisplayValueMode).toBe('measured');

    // Immutability check: model is frozen
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(spec24)).toBe(true);
    expect(Object.isFrozen(spec24!.bindings)).toBe(true);
    expect(() => {
      (spec24 as any).catalogField = 'Changed';
    }).toThrow();
  });

  it('supports global and profile-specific alias resolution via existing helpers', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: { status: 'available', data: sampleRegistry },
    };
    const model = composeMerchandisingFieldSpecs(input);
    const spec = getMerchandisingFieldSpec(model, 'ProductField24')!;
    const configured = spec.bindings[0].configured!;

    // Global alias
    const resolved = resolveAlias('Fowl', [...configured.valueAliases], [...configured.allowedValues]);
    expect(resolved).toBe('Chicken');

    // Profile-specific lookup
    const dogLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-dog',
    });
    expect(dogLookup.status).toBe('found');
    if (dogLookup.status === 'found') {
      expect(dogLookup.context.cardinality).toBe('single');
      const dogAlias = resolveAlias('Canine-Fowl', [...dogLookup.context.valueAliases], [...configured.allowedValues]);
      expect(dogAlias).toBe('Chicken');
    }

    const catLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-cat',
    });
    expect(catLookup.status).toBe('found');
    if (catLookup.status === 'found') {
      expect(catLookup.context.cardinality).toBe('multiple');
      const catAlias = resolveAlias('Feline-Bird', [...catLookup.context.valueAliases], [...configured.allowedValues]);
      expect(catAlias).toBe('Chicken');
    }

    // Missing profile
    const missingLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-nonexistent',
    });
    expect(missingLookup.status).toBe('profile_missing');
  });

  it('fails closed on invalid canonical identity and case-fold collisions in configured values', () => {
    const corruptConfig: ClassificationConfig = {
      ...baseConfig,
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled',
          canonicalUnit: null,
          // 'cafe\u0301' is decomposed (non-NFC), ' dog' is untrimmed, 'Dog'/'dog' is case-fold collision
          allowedValues: ['cafe\u0301', 'Dog', 'dog'],
          valueAliases: [],
          visualEvidenceEligibility: 'eligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
        },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: corruptConfig },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const spec = getMerchandisingFieldSpec(model, 'ProductField24')!;
    expect(spec.bindings[0].configured!.status).toBe('invalid_identity');
    expect(spec.bindings[0].configured!.canonicalOptions).toEqual([]);
    expect(model.diagnostics.some(d => d.code === 'invalid_configured_identity')).toBe(true);
  });

  it('handles unmapped attributes and target-only fields correctly', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: {
        status: 'available',
        data: [
          ...sampleRegistry,
          { xmlField: 'ProductField10', label: 'Notes Direct', kind: 'custom', dataType: 'string', sampleValuesJson: null },
        ],
      },
    };

    const model = composeMerchandisingFieldSpecs(input);

    // Attribute 'notes' is unmapped in baseConfig
    expect(model.unmappedAttributes.some(u => u.attributeId === 'notes')).toBe(true);
    expect(model.diagnostics.some(d => d.code === 'unmapped_attribute' && d.attributeId === 'notes')).toBe(true);

    // ProductField10 has a target referencing 'notes', but no mapping
    const spec10 = getMerchandisingFieldSpec(model, 'ProductField10')!;
    expect(spec10.bindings).toHaveLength(0);
    expect(spec10.targets).toHaveLength(1);
    expect(spec10.targets[0].target.id).toBe('tgt-disabled');
    expect(spec10.targets[0].associationReasons).toEqual(['direct_catalog_field']);

    // listMerchandisingFieldSpecsForAttribute matches targets as well
    const notesSpecs = listMerchandisingFieldSpecsForAttribute(model, 'notes');
    expect(notesSpecs.map(s => s.catalogField)).toContain('ProductField10');
  });

  it('handles ambiguous mappings and inconsistent target references with diagnostics', () => {
    const conflictingConfig: ClassificationConfig = {
      ...baseConfig,
      attributeMappings: [
        {
          id: 'map-1',
          attributeId: 'flavor',
          catalogField: 'ProductField24',
          serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' },
          isStale: false,
        },
        {
          id: 'map-2',
          attributeId: 'weight',
          catalogField: 'ProductField24',
          serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' },
          isStale: false,
        },
      ],
      curationTargets: [
        {
          id: 'tgt-inconsistent',
          attributeId: 'weight', // contradicts primary mapping to flavor
          catalogField: 'ProductField24',
          kind: 'product_field',
          enabled: true,
          mandatory: false,
          selectionMode: 'single',
          optionSource: 'configured',
          label: 'Inconsistent',
          required: false,
          sortOrder: 1,
        },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: conflictingConfig },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const spec = getMerchandisingFieldSpec(model, 'ProductField24')!;

    expect(spec.bindings).toHaveLength(2);
    expect(spec.diagnostics.some(d => d.code === 'ambiguous_mapping')).toBe(true);
    expect(spec.diagnostics.some(d => d.code === 'inconsistent_target_reference')).toBe(true);
  });

  it('handles missing registry rows and malformed registry sample JSON', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: {
        status: 'available',
        data: [
          {
            xmlField: 'ProductField24',
            label: 'Flavor',
            kind: 'custom',
            dataType: 'string',
            sampleValuesJson: '{not-json}',
          },
        ],
      },
      discoveredCatalogFields: ['ProductField88'],
    };

    const model = composeMerchandisingFieldSpecs(input);

    // ProductField5 is in config mappings but not in registry
    const spec5 = getMerchandisingFieldSpec(model, 'ProductField5')!;
    expect(spec5.display.registryStatus).toBe('missing');
    expect(spec5.display.label).toBe('ProductField5');
    expect(spec5.display.isFallbackLabel).toBe(true);
    expect(spec5.diagnostics.some(d => d.code === 'missing_registry_entry')).toBe(true);

    // Malformed sample values
    const spec24 = getMerchandisingFieldSpec(model, 'ProductField24')!;
    expect(spec24.observed.parsedRegistrySamples).toEqual([]);
    expect(spec24.diagnostics.some(d => d.code === 'malformed_sample_json')).toBe(true);

    // Discovered field
    const spec88 = getMerchandisingFieldSpec(model, 'ProductField88')!;
    expect(spec88.origins).toEqual(['discovered']);
    expect(spec88.display.registryStatus).toBe('missing');
  });

  it('supports references_only configuration input and partial failure slices', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: {
        status: 'references_only',
        mappings: {
          status: 'available',
          data: [{ attributeId: 'flavor', catalogField: 'ProductField24', isStale: true }],
        },
        targets: {
          status: 'available',
          data: [
            {
              id: 'tgt-ref',
              kind: 'product_field',
              catalogField: 'ProductField24',
              attributeId: 'flavor',
              enabled: true,
              mandatory: false,
              selectionMode: 'single',
              optionSource: 'configured',
              label: 'Ref Target',
              required: false,
              sortOrder: 1,
            },
          ],
        },
      },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model = composeMerchandisingFieldSpecs(input);
    expect(model.provenance.configurationKind).toBe('references_only');

    const spec24 = getMerchandisingFieldSpec(model, 'ProductField24')!;
    expect(spec24.bindings[0].isStale).toBe(true);
    expect(spec24.bindings[0].serialization.status).toBe('unknown');
    expect(spec24.bindings[0].configured).toBeNull();

    // Profile context lookup in references_only mode returns unavailable
    const lookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-dog',
    });
    expect(lookup.status).toBe('unavailable');
  });

  it('supports v2 configuration bundles without loss of v2 serialization or export disposition', () => {
    const v2Bundle = {
      manifest: {
        schemaVersion: 2,
        compatibilityVersion: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        activeRevision: 'rev-1',
        migrationProvenance: { kind: 'reviewed_generation' },
      },
      bundleOrigin: { kind: 'reviewed_generation' },
      productTypes: [
        { id: 'pt-dog', name: 'Dog Food', description: null, attributeProfileId: 'prof-dog', oldIdAliases: [] },
      ],
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled',
          canonicalUnit: null,
          allowedValues: ['Chicken'],
          valueAliases: [],
          visualEvidenceEligibility: 'eligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
          isUniversal: false,
          evidencePolicy: {
            directEvidenceRequired: false,
            forbidAbsenceInference: false,
            allowedSources: ['official_product_page'],
            allowVisualEvidence: true,
            allowThirdPartyEvidence: false,
            thirdPartyEvidenceApproval: null,
            manualReviewRequired: false,
          },
          oldIdAliases: [],
          exportDisposition: { kind: 'shopsite', catalogField: 'ProductField24' },
        },
        {
          id: 'internal_cost',
          name: 'Internal Cost',
          description: null,
          valueMode: 'measured',
          canonicalUnit: 'USD',
          allowedValues: [],
          valueAliases: [],
          visualEvidenceEligibility: 'ineligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
          isUniversal: false,
          evidencePolicy: {
            directEvidenceRequired: false,
            forbidAbsenceInference: false,
            allowedSources: ['official_product_page'],
            allowVisualEvidence: false,
            allowThirdPartyEvidence: false,
            thirdPartyEvidenceApproval: null,
            manualReviewRequired: false,
          },
          oldIdAliases: [],
          exportDisposition: { kind: 'not_exported' },
        },
      ],
      attributeProfiles: [
        {
          id: 'prof-dog',
          productTypeId: 'pt-dog',
          name: 'Dog Profile',
          attributes: [
            {
              attributeId: 'flavor',
              required: true,
              cardinality: 'single',
              applicabilityConditions: [],
              constraints: {},
              confidenceThresholds: {},
              valueAliases: [],
            },
          ],
          oldIdAliases: [],
        },
      ],
      attributeMappings: [
        {
          id: 'map-v2',
          attributeId: 'flavor',
          catalogField: 'ProductField24',
          serialization: { kind: 'scalar', prefix: '', suffix: '' },
          isStale: false,
        },
      ],
      curationTargets: [
        {
          id: 'tgt-v2',
          kind: 'product_field',
          label: 'Target V2',
          enabled: true,
          mandatory: false,
          selectionMode: 'single',
          attributeId: 'flavor',
          catalogField: 'ProductField24',
          optionSource: 'configured',
          required: false,
          sortOrder: 1,
        },
      ],
      brands: [],
      guidance: [],
      modelPolicy: {
        defaultProvider: 'ollama',
        defaultModel: 'qwen2.5vl:latest',
        providerLocalities: { ollama: 'local' },
        stageOverrides: {},
        imageDataSharing: 'local_only',
        textDataSharing: 'local_only',
        mlFeatures: {
          productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
          productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        },
      },
      dataSharing: {
        imagePolicy: 'local_only',
        textPolicy: 'local_only',
        sensitiveDataFiltering: true,
        retentionDays: 90,
      },
    } as unknown as ClassificationConfigBundleV2;

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: v2Bundle },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const spec24 = getMerchandisingFieldSpec(model, 'ProductField24')!;
    expect(spec24.bindings[0].serialization).toEqual({
      status: 'available',
      value: { kind: 'scalar', prefix: '', suffix: '' },
    });
    expect(spec24.bindings[0].configured!.exportDisposition).toEqual({
      kind: 'shopsite',
      catalogField: 'ProductField24',
    });

    // internal_cost is intentionally not exported in v2
    const unmappedCost = model.unmappedAttributes.find(u => u.attributeId === 'internal_cost');
    expect(unmappedCost).toBeDefined();
    expect(unmappedCost!.reason).toBe('intentionally_not_exported');
  });

  it('demonstrates purity: identical inputs produce deeply equal output; no external dependencies', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model1 = composeMerchandisingFieldSpecs(input);
    const model2 = composeMerchandisingFieldSpecs(input);

    expect(model1).toEqual(model2);
  });

  it('does not freeze or mutate caller-owned configuration objects', () => {
    const mutableAlias = { alias: 'Pooch-Fowl', mapsTo: 'Chicken' };
    const mutableCondition = { field: 'species', op: 'eq', value: 'canine' };
    const mutableExport = { kind: 'shopsite' as const, catalogField: 'ProductField24' };
    const mutableSerialization = { format: 'plain' as const, separator: ', ', prefix: '', suffix: '' };

    const mutableConfig: ClassificationConfig = {
      ...baseConfig,
      attributes: [
        {
          ...baseConfig.attributes[0],
          valueAliases: [mutableAlias],
          exportDisposition: mutableExport,
        } as any,
      ],
      attributeMappings: [
        {
          ...baseConfig.attributeMappings[0],
          serialization: mutableSerialization,
        },
      ],
      attributeProfiles: [
        {
          ...baseConfig.attributeProfiles[0],
          attributes: [
            {
              ...baseConfig.attributeProfiles[0].attributes[0],
              applicabilityConditions: [mutableCondition],
            },
          ],
        },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: mutableConfig },
      registry: { status: 'available', data: sampleRegistry },
    };

    const model = composeMerchandisingFieldSpecs(input);
    expect(Object.isFrozen(model)).toBe(true);

    // Caller's objects must NOT be frozen
    expect(Object.isFrozen(mutableConfig)).toBe(false);
    expect(Object.isFrozen(mutableAlias)).toBe(false);
    expect(Object.isFrozen(mutableCondition)).toBe(false);
    expect(Object.isFrozen(mutableExport)).toBe(false);
    expect(Object.isFrozen(mutableSerialization)).toBe(false);

    // Caller can still mutate their own objects without error
    mutableSerialization.prefix = 'test-prefix';
    expect(mutableSerialization.prefix).toBe('test-prefix');
  });

  it('correctly reports mappingStatus as none, unique, ambiguous, and unavailable', () => {
    const multiMapConfig: ClassificationConfig = {
      ...baseConfig,
      attributeMappings: [
        { id: 'm1', attributeId: 'flavor', catalogField: 'ProductField24', serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'm2', attributeId: 'weight', catalogField: 'ProductField24', serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'm3', attributeId: 'weight', catalogField: 'ProductField5', serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: multiMapConfig },
      registry: {
        status: 'available',
        data: [
          { xmlField: 'ProductField24', label: 'Ambiguous', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField5', label: 'Unique', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField99', label: 'None', kind: 'custom', dataType: 'string', sampleValuesJson: null },
        ],
      },
    };

    const model = composeMerchandisingFieldSpecs(input);
    expect(getMerchandisingFieldSpec(model, 'ProductField24')!.mappingStatus).toBe('ambiguous');
    expect(getMerchandisingFieldSpec(model, 'ProductField5')!.mappingStatus).toBe('unique');
    expect(getMerchandisingFieldSpec(model, 'ProductField99')!.mappingStatus).toBe('none');

    // In unavailable configuration mode:
    const unavailModel = composeMerchandisingFieldSpecs({
      configuration: { status: 'unavailable', reason: 'source_failed' },
      registry: { status: 'available', data: sampleRegistry },
    });
    expect(getMerchandisingFieldSpec(unavailModel, 'ProductField24')!.mappingStatus).toBe('unavailable');
  });

  it('correctly handles profile context lookup for multi-mapped attributes and unmapped attributes', () => {
    // Config where 'flavor' is mapped to two catalog fields, and 'notes' is in prof-dog but has no mapping
    const extendedConfig: ClassificationConfig = {
      ...baseConfig,
      attributeMappings: [
        { id: 'm1', attributeId: 'flavor', catalogField: 'ProductField24', serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'm2', attributeId: 'flavor', catalogField: 'ProductField25', serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      attributeProfiles: [
        {
          id: 'prof-dog',
          productTypeId: 'pt-dog',
          name: 'Dog Profile',
          attributes: [
            {
              attributeId: 'flavor',
              required: true,
              cardinality: 'single',
              applicabilityConditions: [],
              constraints: {},
              confidenceThresholds: {},
              valueAliases: [],
            },
            {
              attributeId: 'notes',
              required: false,
              cardinality: 'multiple',
              applicabilityConditions: [],
              constraints: {},
              confidenceThresholds: {},
              valueAliases: [],
            },
          ],
        },
        {
          id: 'prof-empty',
          productTypeId: 'pt-cat',
          name: 'Empty Profile',
          attributes: [],
        },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: extendedConfig },
      registry: {
        status: 'available',
        data: [
          { xmlField: 'ProductField24', label: 'Flavor 1', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField25', label: 'Flavor 2', kind: 'custom', dataType: 'string', sampleValuesJson: null },
        ],
      },
    };

    const model = composeMerchandisingFieldSpecs(input);

    // 1. Attribute mapped to multiple fields returns 'found' (not 'ambiguous')
    const flavorLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-dog',
    });
    expect(flavorLookup.status).toBe('found');
    if (flavorLookup.status === 'found') {
      expect(flavorLookup.context.profileId).toBe('prof-dog');
      expect(flavorLookup.context.required).toBe(true);
    }

    // 2. Unmapped attribute 'notes' belongs to prof-dog: returns 'found'
    const notesLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'notes',
      profileId: 'prof-dog',
    });
    expect(notesLookup.status).toBe('found');
    if (notesLookup.status === 'found') {
      expect(notesLookup.context.profileId).toBe('prof-dog');
      expect(notesLookup.context.cardinality).toBe('multiple');
    }

    // 3. Profile that exists but does not contain the attribute returns 'not_in_profile'
    const emptyProfileLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-empty',
    });
    expect(emptyProfileLookup.status).toBe('not_in_profile');

    // 4. Non-existent profile returns 'profile_missing'
    const missingProfileLookup = getMerchandisingFieldProfileContext(model, {
      attributeId: 'flavor',
      profileId: 'prof-does-not-exist',
    });
    expect(missingProfileLookup.status).toBe('profile_missing');
  });
});
