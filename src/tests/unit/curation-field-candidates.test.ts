import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listCurationTargetCandidates,
  listCatalogFieldOptions,
  getExplicitCurationTargets,
  resolveAttributeAllowedValues,
} from '../../classification/curation-targets';
import { getDb } from '../../db/connection';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { listVerifiedPageOptions } from '../../db/repositories/page-repo';
import type { ClassificationConfig } from '../../shared/schemas/classification';

vi.mock('../../db/connection', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../db/repositories/field-registry-repo', () => ({
  listRegistry: vi.fn(),
}));

vi.mock('../../db/repositories/page-repo', () => ({
  listVerifiedPageOptions: vi.fn(),
}));

describe('curation-field-candidates characterization (Ticket #127 / W0)', () => {
  const workspaceId = 'ws-test';

  let mockDbQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery = vi.fn();
    (getDb as any).mockReturnValue({
      query: mockDbQuery,
    });
  });

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
            constraints: {},
            confidenceThresholds: {},
            valueAliases: [],
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
            cardinality: 'single',
            applicabilityConditions: [],
            constraints: {},
            confidenceThresholds: {},
            valueAliases: [],
          },
        ],
      },
    ],
    attributes: [
      {
        id: 'flavor',
        name: 'Flavor',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: ['Chicken', 'Beef'],
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
        id: 'description_notes',
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
        label: 'Target Flavor',
        required: false,
        sortOrder: 1,
      },
      {
        id: 'tgt-disabled',
        attributeId: 'notes',
        catalogField: 'ProductField10',
        kind: 'product_field',
        enabled: false,
        mandatory: false,
        selectionMode: 'single',
        optionSource: 'configured',
        label: 'Disabled Target',
        required: false,
        sortOrder: 2,
      },
    ],
    brands: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: 'qwen2.5vl:latest', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };

  it('pins numeric suffix ordering of product fields over registry order', () => {
    (listRegistry as any).mockReturnValue([
      { xmlField: 'ProductField24', label: 'Flavor Field', kind: 'custom', dataType: 'string', sampleValuesJson: null },
      { xmlField: 'ProductField5', label: 'Weight Field', kind: 'custom', dataType: 'string', sampleValuesJson: null },
      { xmlField: 'ProductField10', label: 'Notes Field', kind: 'custom', dataType: 'string', sampleValuesJson: null },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);
    mockDbQuery.mockReturnValue({ all: () => [] });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);

    expect(result.productFields.map(f => f.catalogField)).toEqual([
      'ProductField5',
      'ProductField10',
      'ProductField24',
    ]);
  });

  it('pins candidate value union for controlled attributes: live options + samples + configured', () => {
    (listRegistry as any).mockReturnValue([
      {
        xmlField: 'ProductField24',
        label: 'Flavor',
        kind: 'custom',
        dataType: 'string',
        sampleValuesJson: JSON.stringify(['Turkey', 'Duck|Goose']),
      },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);

    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != ?')) {
        return {
          all: () => [
            { custom_fields: JSON.stringify({ ProductField24: 'Chicken|Salmon' }) },
            { custom_fields: JSON.stringify({ ProductField24: ['Salmon', 'Lamb'] }) },
          ],
        };
      }
      return { all: () => [] };
    });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);
    const flavor = result.productFields.find(f => f.catalogField === 'ProductField24')!;

    expect(flavor).toBeDefined();
    expect(flavor.values).toEqual(['Beef', 'Chicken', 'Duck', 'Goose', 'Lamb', 'Salmon', 'Turkey']);
  });

  it('pins that freeText and measured attributes yield empty candidate values regardless of DB/samples', () => {
    (listRegistry as any).mockReturnValue([
      {
        xmlField: 'ProductField5',
        label: 'Weight',
        kind: 'custom',
        dataType: 'string',
        sampleValuesJson: JSON.stringify(['5 lb', '10 lb']),
      },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);

    mockDbQuery.mockReturnValue({
      all: () => [
        { custom_fields: JSON.stringify({ ProductField5: '25 lb' }) },
      ],
    });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);
    const weight = result.productFields.find(f => f.catalogField === 'ProductField5')!;

    expect(weight).toBeDefined();
    expect(weight.values).toEqual([]);
  });

  it('pins target association: direct catalog field, mapped attribute, and target-only attribute fallback', () => {
    (listRegistry as any).mockReturnValue([
      { xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null },
      { xmlField: 'ProductField10', label: 'Target Only', kind: 'custom', dataType: 'string', sampleValuesJson: null },
      { xmlField: 'ProductField99', label: 'Unmapped', kind: 'custom', dataType: 'string', sampleValuesJson: null },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);
    mockDbQuery.mockReturnValue({ all: () => [] });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);

    const pf24 = result.productFields.find(f => f.catalogField === 'ProductField24')!;
    expect(pf24.target?.id).toBe('tgt-flavor');
    expect(pf24.attributeId).toBe('flavor');

    const pf10 = result.productFields.find(f => f.catalogField === 'ProductField10')!;
    expect(pf10.target?.id).toBe('tgt-disabled');
    expect(pf10.attributeId).toBe('notes');

    const pf99 = result.productFields.find(f => f.catalogField === 'ProductField99')!;
    expect(pf99.target).toBeNull();
    expect(pf99.attributeId).toBeNull();
  });

  it('pins discovered ProductField candidates from product_index not present in registry', () => {
    (listRegistry as any).mockReturnValue([
      { xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);

    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("WHERE custom_fields IS NOT NULL AND custom_fields != '' AND custom_fields != '{}'")) {
        return {
          all: () => [
            { custom_fields: JSON.stringify({ ProductField24: 'val1', ProductField50: 'DiscoveredVal' }) },
          ],
        };
      }
      if (sql.includes('SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != ?')) {
        return {
          all: () => [
            { custom_fields: JSON.stringify({ ProductField50: 'DiscoveredVal' }) },
          ],
        };
      }
      return { all: () => [] };
    });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);

    const discovered = result.productFields.find(f => f.catalogField === 'ProductField50');
    expect(discovered).toBeDefined();
    expect(discovered).toMatchObject({
      catalogField: 'ProductField50',
      label: 'ProductField50',
      dataType: 'string',
      values: ['DiscoveredVal'],
      target: null,
      attributeId: null,
    });
  });

  it('pins page candidates: only verified pages, collapsing duplicate names', () => {
    (listRegistry as any).mockReturnValue([]);
    (listVerifiedPageOptions as any).mockReturnValue([
      { id: 'page-1', name: 'Dog Food', fileName: 'dog.html' },
      { id: 'page-2', name: 'Dog Food', fileName: 'dog-dup.html' },
      { id: 'page-3', name: 'Cat Food', fileName: 'cat.html' },
    ]);
    mockDbQuery.mockReturnValue({ all: () => [] });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);

    expect(result.pages).toEqual([
      { value: 'Dog Food', label: 'Dog Food' },
      { value: 'Cat Food', label: 'Cat Food' },
    ]);
  });

  it('pins product types projection: value = id, label = name', () => {
    (listRegistry as any).mockReturnValue([]);
    (listVerifiedPageOptions as any).mockReturnValue([]);
    mockDbQuery.mockReturnValue({ all: () => [] });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);

    expect(result.productTypes).toEqual([
      { value: 'pt-dog', label: 'Dog Food' },
      { value: 'pt-cat', label: 'Cat Food' },
    ]);
  });

  it('pins graceful handling of malformed sampleValuesJson and malformed custom_fields', () => {
    (listRegistry as any).mockReturnValue([
      { xmlField: 'ProductField1', label: 'Field 1', kind: 'custom', dataType: 'string', sampleValuesJson: '{not-an-array}' },
      { xmlField: 'ProductField2', label: 'Field 2', kind: 'custom', dataType: 'string', sampleValuesJson: 'invalid-json' },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);
    mockDbQuery.mockReturnValue({
      all: () => [
        { custom_fields: 'not-valid-json' },
      ],
    });

    const result = listCurationTargetCandidates(workspaceId, baseConfig);
    expect(result.productFields).toHaveLength(2);
    expect(result.productFields[0].values).toEqual([]);
    expect(result.productFields[1].values).toEqual([]);
  });

  it('pins listCatalogFieldOptions regex validation and 250 limit', () => {
    expect(listCatalogFieldOptions('Invalid Field!')).toEqual([]);

    mockDbQuery.mockReturnValue({
      all: () => [
        {
          custom_fields: JSON.stringify({
            ProductField1: Array.from({ length: 300 }, (_, i) => `Opt-${String(i).padStart(3, '0')}`),
          }),
        },
      ],
    });

    const options = listCatalogFieldOptions('ProductField1');
    expect(options).toHaveLength(250);
    expect(options[0]).toBe('Opt-000');
    expect(options[249]).toBe('Opt-249');
  });

  it('pins runtime helper stability: getExplicitCurationTargets and resolveAttributeAllowedValues', () => {
    const explicit = getExplicitCurationTargets(baseConfig);
    expect(explicit).toHaveLength(1);
    expect(explicit[0].id).toBe('tgt-flavor');

    const attr = baseConfig.attributes.find(a => a.id === 'flavor')!;
    const target = baseConfig.curationTargets.find(t => t.id === 'tgt-flavor')!;
    const allowed = resolveAttributeAllowedValues(baseConfig, attr, target);
    expect(allowed).toEqual(['Beef', 'Chicken']);
  });

  it('skips live option reads for measured and freeText attributes (Ticket #129 / W2)', () => {
    (listRegistry as any).mockReturnValue([
      { xmlField: 'ProductField5', label: 'Weight', kind: 'custom', dataType: 'string', sampleValuesJson: null },
    ]);
    (listVerifiedPageOptions as any).mockReturnValue([]);
    mockDbQuery.mockReturnValue({ all: () => [] });

    listCurationTargetCandidates(workspaceId, baseConfig);

    // mockDbQuery was called for listDistinctCustomFieldKeys, but never for listCatalogFieldOptions
    const sqlCalls = mockDbQuery.mock.calls.map((c: any[]) => c[0]);
    const optionQueries = sqlCalls.filter(sql => typeof sql === 'string' && sql.includes('WHERE custom_fields IS NOT NULL AND custom_fields != ?'));
    expect(optionQueries).toHaveLength(0);
  });
});
