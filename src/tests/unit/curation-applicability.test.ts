import { describe, test, expect } from 'vitest';
import { deriveCurationApplicability } from '../../classification/curation-applicability';
import type { ClassificationConfig } from '../../shared/schemas/classification';

describe('curation-applicability', () => {
  const baseConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 2,
      compatibilityVersion: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      fileVersions: {},
    },
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
      { id: 'wet-dog-food', name: 'Wet Dog Food', description: null, attributeProfileId: 'wet-dog-food-profile', oldIdAliases: [] },
      { id: 'garden-hose', name: 'Garden Hose', description: null, attributeProfileId: 'garden-hose-profile', oldIdAliases: [] },
      { id: 'unprofiled-type', name: 'Unprofiled Type', description: null, attributeProfileId: null, oldIdAliases: [] },
    ],
    attributes: [
      { id: 'ingredients', name: 'Ingredients', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: true, group: null },
      { id: 'material', name: 'Material', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Rubber', 'Vinyl'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
      { id: 'brand', name: 'Brand', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null, isUniversal: true } as any,
      { id: 'unused-attr', name: 'Unused Attr', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
    ],
    attributeProfiles: [
      {
        id: 'dry-dog-food-profile',
        productTypeId: 'dry-dog-food',
        name: 'Dry Dog Food Profile',
        attributes: [
          { attributeId: 'ingredients', required: true, cardinality: 'multiple', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        ],
      },
      {
        id: 'wet-dog-food-profile',
        productTypeId: 'wet-dog-food',
        name: 'Wet Dog Food Profile',
        attributes: [
          { attributeId: 'ingredients', required: false, cardinality: 'multiple', applicabilityConditions: [{ operator: 'equals', attributeId: 'brand', value: 'Acme' }], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        ],
      },
      {
        id: 'garden-hose-profile',
        productTypeId: 'garden-hose',
        name: 'Garden Hose Profile',
        attributes: [
          { attributeId: 'material', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
        ],
      },
    ],
    attributeMappings: [
      { id: 'm-24', attributeId: 'ingredients', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'm-7', attributeId: 'material', catalogField: 'ProductField7', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'm-12', attributeId: 'brand', catalogField: 'ProductField12', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      { id: 'm-30', attributeId: 'unused-attr', catalogField: 'ProductField30', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    ],
    curationTargets: [
      { id: 'target-24', kind: 'product_field', label: 'Ingredients', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'ingredients', catalogField: 'ProductField24', optionSource: 'live_store', required: false, sortOrder: 0 },
      { id: 'target-7', kind: 'product_field', label: 'Material', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'material', catalogField: 'ProductField7', optionSource: 'live_store', required: false, sortOrder: 1 },
      { id: 'target-12', kind: 'product_field', label: 'Brand', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'brand', catalogField: 'ProductField12', optionSource: 'live_store', required: false, sortOrder: 2 },
      { id: 'target-30', kind: 'product_field', label: 'Unused Field', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'unused-attr', catalogField: 'ProductField30', optionSource: 'live_store', required: false, sortOrder: 3 },
      { id: 'target-99', kind: 'product_field', label: 'Unmapped Field', enabled: true, mandatory: false, selectionMode: 'single', attributeId: null, catalogField: 'ProductField99', optionSource: 'live_store', required: false, sortOrder: 4 },
    ],
    brands: [],
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: 'llama3',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 30,
    },
  };

  test('derives profiled scope for Ingredients and Material correctly', () => {
    const { applicability } = deriveCurationApplicability(baseConfig);

    const ingredients = applicability.find(a => a.catalogField === 'ProductField24');
    expect(ingredients).toBeDefined();
    expect(ingredients?.scope).toBe('profiled');
    expect(ingredients?.productTypes).toHaveLength(2);
    expect(ingredients?.productTypes.map(pt => pt.productTypeId)).toEqual(['dry-dog-food', 'wet-dog-food']);

    const dryDog = ingredients?.productTypes.find(pt => pt.productTypeId === 'dry-dog-food');
    expect(dryDog?.required).toBe(true);
    expect(dryDog?.cardinality).toBe('multiple');
    expect(dryDog?.conditional).toBe(false);

    const wetDog = ingredients?.productTypes.find(pt => pt.productTypeId === 'wet-dog-food');
    expect(wetDog?.required).toBe(false);
    expect(wetDog?.conditional).toBe(true);

    const material = applicability.find(a => a.catalogField === 'ProductField7');
    expect(material).toBeDefined();
    expect(material?.scope).toBe('profiled');
    expect(material?.productTypes).toHaveLength(1);
    expect(material?.productTypes[0].productTypeId).toBe('garden-hose');
  });

  test('derives universal scope for universal attributes', () => {
    const { applicability } = deriveCurationApplicability(baseConfig);

    const brand = applicability.find(a => a.catalogField === 'ProductField12');
    expect(brand).toBeDefined();
    expect(brand?.scope).toBe('universal');
    expect(brand?.productTypes).toHaveLength(0);
  });

  test('derives unused scope and finding for target enabled but in 0 profiles', () => {
    const { applicability, findings } = deriveCurationApplicability(baseConfig);

    const unused = applicability.find(a => a.catalogField === 'ProductField30');
    expect(unused).toBeDefined();
    expect(unused?.scope).toBe('unused');
    expect(unused?.productTypes).toHaveLength(0);

    const unusedFinding = findings.find(f => f.code === 'target_unused_by_profiles');
    expect(unusedFinding).toBeDefined();
    expect(unusedFinding?.details?.catalogField).toBe('ProductField30');
  });

  test('derives unmapped scope for unmapped fields', () => {
    const { applicability } = deriveCurationApplicability(baseConfig);

    const unmapped = applicability.find(a => a.catalogField === 'ProductField99');
    expect(unmapped).toBeDefined();
    expect(unmapped?.scope).toBe('unmapped');
    expect(unmapped?.productTypes).toHaveLength(0);
  });

  test('surfaces product_type_profile_missing finding when declared profile is absent', () => {
    const configWithMissingProfile: ClassificationConfig = {
      ...baseConfig,
      productTypes: [
        ...baseConfig.productTypes,
        { id: 'broken-type', name: 'Broken Type', description: null, attributeProfileId: 'non-existent-profile', oldIdAliases: [] },
      ],
    };

    const { findings } = deriveCurationApplicability(configWithMissingProfile);
    const missingFinding = findings.find(f => f.code === 'product_type_profile_missing');
    expect(missingFinding).toBeDefined();
    expect(missingFinding?.details?.productTypeId).toBe('broken-type');
  });

  test('does not emit health findings when a curation target is disabled', () => {
    const configWithDisabledTarget: ClassificationConfig = {
      ...baseConfig,
      curationTargets: baseConfig.curationTargets.map(t =>
        t.catalogField === 'ProductField7' ? { ...t, enabled: false } : t,
      ),
    };

    const { findings } = deriveCurationApplicability(configWithDisabledTarget);
    expect(findings.filter(f => (f.details as any)?.catalogField === 'ProductField7')).toHaveLength(0);
  });
});
