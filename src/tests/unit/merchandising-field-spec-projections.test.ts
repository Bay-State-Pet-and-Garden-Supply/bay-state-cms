import { describe, it, expect } from 'vitest';
import { composeMerchandisingFieldSpecs } from '../../classification/merchandising-field-spec';
import {
  projectCurationFieldCandidates,
  projectCatalogFieldSummaries,
  inferValueMode,
} from '../../classification/merchandising-field-spec-projections';
import type { MerchandisingFieldSpecInput } from '../../shared/schemas/merchandising-field-spec';
import type { ClassificationConfig } from '../../shared/schemas/classification';

describe('MerchandisingFieldSpec projections (Ticket #128 / W1)', () => {
  const baseConfig: ClassificationConfig = {
    manifest: {
      schemaVersion: 1,
      compatibilityVersion: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      fileVersions: {},
    },
    productTypes: [],
    attributeProfiles: [],
    attributes: [
      {
        id: 'flavor',
        name: 'Flavor',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: ['Chicken', 'Beef'],
        valueAliases: [],
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
      {
        id: 'legacy_attr',
        name: 'Legacy Attr',
        description: null,
        valueMode: 'controlled',
        canonicalUnit: null,
        allowedValues: ['OldVal'],
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
      {
        id: 'map-stale',
        attributeId: 'legacy_attr',
        catalogField: 'ProductField26',
        serialization: { format: 'plain', separator: ', ', prefix: '', suffix: '' },
        isStale: true,
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
        mandatory: false,
        selectionMode: 'single',
        optionSource: 'configured',
        label: 'Disabled Notes Target',
        required: false,
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

  it('projects curation field candidates with numeric suffix sort, candidate value union, and target association', () => {
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
            sampleValuesJson: JSON.stringify(['Turkey', 'Duck|Goose']),
          },
          {
            xmlField: 'ProductField5',
            label: 'Weight',
            kind: 'custom',
            dataType: 'string',
            sampleValuesJson: JSON.stringify(['5 lb']),
          },
          {
            xmlField: 'ProductField10',
            label: 'Target Only',
            kind: 'custom',
            dataType: 'string',
            sampleValuesJson: null,
          },
        ],
      },
      discoveredCatalogFields: ['ProductField50'],
      observations: {
        ProductField24: {
          liveOptions: { status: 'available', data: ['Chicken', 'Salmon', 'Lamb'] },
        },
        ProductField5: {
          liveOptions: { status: 'available', data: ['10 lb'] },
        },
        ProductField50: {
          liveOptions: { status: 'available', data: ['DiscoveredVal'] },
        },
      },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const candidates = projectCurationFieldCandidates(model);

    // 1. Numeric suffix order: 5, 10, 24, 50
    expect(candidates.map(c => c.catalogField)).toEqual([
      'ProductField5',
      'ProductField10',
      'ProductField24',
      'ProductField50',
    ]);

    // 2. Controlled values union: configured (Chicken, Beef) + samples (Turkey, Duck, Goose) + live (Chicken, Salmon, Lamb)
    const pf24 = candidates.find(c => c.catalogField === 'ProductField24')!;
    expect(pf24.values).toEqual(['Beef', 'Chicken', 'Duck', 'Goose', 'Lamb', 'Salmon', 'Turkey']);
    expect(pf24.target?.id).toBe('tgt-flavor');
    expect(pf24.attributeId).toBe('flavor');

    // 3. Measured attribute: empty values
    const pf5 = candidates.find(c => c.catalogField === 'ProductField5')!;
    expect(pf5.values).toEqual([]);

    // 4. Target only: attributeId from target
    const pf10 = candidates.find(c => c.catalogField === 'ProductField10')!;
    expect(pf10.attributeId).toBe('notes');
    expect(pf10.target?.id).toBe('tgt-disabled');

    // 5. Discovered field
    const pf50 = candidates.find(c => c.catalogField === 'ProductField50')!;
    expect(pf50).toMatchObject({
      catalogField: 'ProductField50',
      label: 'ProductField50',
      dataType: 'string',
      values: ['DiscoveredVal'],
      target: null,
      attributeId: null,
    });
  });

  it('projects catalog field summaries matching catalog view specifications and warning precedence', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: {
        status: 'available',
        data: [
          { xmlField: 'name', label: 'name', kind: 'core', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'id', label: 'id', kind: 'system', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField25', label: 'ProductField25', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField26', label: 'ProductField26', kind: 'custom', dataType: 'string', sampleValuesJson: null },
        ],
      },
      observations: {
        ProductField24: {
          liveOptions: { status: 'available', data: [] },
          catalogStats: {
            status: 'available',
            data: {
              nonEmptyCount: 3,
              distinctCount: 2,
              sampleValues: ['Chicken', 'Beef'],
              topValues: [{ value: 'Chicken', frequency: 2 }],
            },
          },
        },
      },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const summaries = projectCatalogFieldSummaries(model, 'catalog');

    // 1. Strict registry order preserved
    expect(summaries.map(s => s.xmlField)).toEqual([
      'name',
      'id',
      'ProductField24',
      'ProductField25',
      'ProductField26',
    ]);

    // 2. Core & system fields do NOT get 'Unlabeled field' warning
    expect(summaries[0].warning).toBeNull();
    expect(summaries[1].warning).toBeNull();

    // 3. ProductField24: normal mapped field with stats
    const pf24 = summaries.find(s => s.xmlField === 'ProductField24')!;
    expect(pf24).toMatchObject({
      label: 'Flavor',
      nonEmptyCount: 3,
      distinctCount: 2,
      inferredValueMode: 'measured',
      mappedAttributeId: 'flavor',
      isCurationTarget: true,
      isStale: false,
      warning: null,
    });

    // 4. ProductField25: unlabeled custom field
    const pf25 = summaries.find(s => s.xmlField === 'ProductField25')!;
    expect(pf25.warning).toBe('Unlabeled field');

    // 5. ProductField26: unlabeled AND stale -> 'Unlabeled field' takes precedence
    const pf26 = summaries.find(s => s.xmlField === 'ProductField26')!;
    expect(pf26.isStale).toBe(true);
    expect(pf26.warning).toBe('Unlabeled field');
  });

  it('projects legacy-client-fallback summaries with false isStale, zero counts, and unlabeled warnings', () => {
    const input: MerchandisingFieldSpecInput = {
      configuration: {
        status: 'references_only',
        mappings: {
          status: 'available',
          data: [{ attributeId: 'legacy_attr', catalogField: 'ProductField26', isStale: true }],
        },
        targets: {
          status: 'available',
          data: [],
        },
      },
      registry: {
        status: 'available',
        data: [
          { xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField25', label: 'ProductField25', kind: 'custom', dataType: 'string', sampleValuesJson: null },
          { xmlField: 'ProductField26', label: 'Legacy Stale', kind: 'custom', dataType: 'string', sampleValuesJson: null },
        ],
      },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const summaries = projectCatalogFieldSummaries(model, 'legacy-client-fallback');

    expect(summaries).toHaveLength(3);

    // Fallback quirks:
    // ProductField24: nonEmptyCount = 0, distinctCount = 0, inferredValueMode = 'unknown', isStale = false, warning = null
    expect(summaries[0]).toMatchObject({
      xmlField: 'ProductField24',
      label: 'Flavor',
      nonEmptyCount: 0,
      distinctCount: 0,
      inferredValueMode: 'unknown',
      isStale: false,
      warning: null,
    });

    // ProductField25: unlabeled -> warning = 'Unlabeled field'
    expect(summaries[1]).toMatchObject({
      xmlField: 'ProductField25',
      warning: 'Unlabeled field',
    });

    // ProductField26: isStale in mapping is true, but fallback projects isStale: false and warning: null
    expect(summaries[2]).toMatchObject({
      xmlField: 'ProductField26',
      label: 'Legacy Stale',
      isStale: false,
      warning: null,
    });

    // If registry is unavailable, fallback projects empty array
    const unavailInput: MerchandisingFieldSpecInput = {
      ...input,
      registry: { status: 'unavailable', reason: 'source_failed' },
    };
    const unavailModel = composeMerchandisingFieldSpecs(unavailInput);
    expect(projectCatalogFieldSummaries(unavailModel, 'legacy-client-fallback')).toEqual([]);
  });

  it('verifies inferValueMode ratio thresholds', () => {
    expect(inferValueMode({ nonEmptyCount: 0, distinctCount: 0 })).toBe('unknown');
    expect(inferValueMode({ nonEmptyCount: 100, distinctCount: 10 })).toBe('controlled');
    expect(inferValueMode({ nonEmptyCount: 1000, distinctCount: 150 })).toBe('measured'); // ratio 0.15 but distinct > 100
    expect(inferValueMode({ nonEmptyCount: 100, distinctCount: 85 })).toBe('freeText'); // ratio > 0.8
    expect(inferValueMode({ nonEmptyCount: 100, distinctCount: 50 })).toBe('measured');
  });

  it('preserves pipe characters in configured allowed values while splitting observations', () => {
    const pipeConfig: ClassificationConfig = {
      ...baseConfig,
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled',
          canonicalUnit: null,
          allowedValues: ['Chicken|Delight', 'Beef'],
          valueAliases: [],
          visualEvidenceEligibility: 'eligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
        },
      ],
    };

    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: pipeConfig },
      registry: {
        status: 'available',
        data: [
          {
            xmlField: 'ProductField24',
            label: 'Flavor',
            kind: 'custom',
            dataType: 'string',
            sampleValuesJson: JSON.stringify(['Turkey|Duck']),
          },
        ],
      },
      observations: {
        ProductField24: {
          liveOptions: { status: 'available', data: ['Salmon|Trout'] },
        },
      },
    };

    const model = composeMerchandisingFieldSpecs(input);
    const candidates = projectCurationFieldCandidates(model);
    const pf24 = candidates.find(c => c.catalogField === 'ProductField24')!;

    // Configured 'Chicken|Delight' remains intact; observed 'Turkey|Duck' and 'Salmon|Trout' are split
    expect(pf24.values).toEqual([
      'Beef',
      'Chicken|Delight',
      'Duck',
      'Salmon',
      'Trout',
      'Turkey',
    ]);
  });

  it('suppresses raw allowedValues when configured identity is invalid', () => {
    const badConfig: ClassificationConfig = {
      ...baseConfig,
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled',
          canonicalUnit: null,
          allowedValues: ['Dog', 'dog'],
          valueAliases: [],
          visualEvidenceEligibility: 'eligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
        },
      ],
    };
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: badConfig },
      registry: {
        status: 'available',
        data: [{ xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null }],
      },
      observations: { ProductField24: { liveOptions: { status: 'available', data: ['Turkey'] } } },
    };
    const model = composeMerchandisingFieldSpecs(input);
    expect(model.fieldSpecs[0].bindings[0]?.configured?.status).toBe('invalid_identity');
    const candidates = projectCurationFieldCandidates(model);
    const pf24 = candidates.find(c => c.catalogField === 'ProductField24')!;
    expect(pf24.values).toEqual(['Turkey']);
    expect(pf24.values).not.toContain('Dog');
    expect(pf24.values).not.toContain('dog');
  });

  it('dedupes decomposed liveOptions against composed configured values and keeps case-distinct observations', () => {
    const nfcConfig: ClassificationConfig = {
      ...baseConfig,
      attributes: [
        {
          id: 'flavor',
          name: 'Flavor',
          description: null,
          valueMode: 'controlled',
          canonicalUnit: null,
          allowedValues: ['caf\u00e9'],
          valueAliases: [],
          visualEvidenceEligibility: 'eligible',
          isClaim: false,
          isCompositionAttribute: false,
          group: null,
        },
      ],
    };
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: nfcConfig },
      registry: {
        status: 'available',
        data: [{ xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null }],
      },
      observations: {
        ProductField24: { liveOptions: { status: 'available', data: ['cafe\u0301', 'Dog', 'dog'] } },
      },
    };
    const model = composeMerchandisingFieldSpecs(input);
    const candidates = projectCurationFieldCandidates(model);
    const pf24 = candidates.find(c => c.catalogField === 'ProductField24')!;
    // Decomposed cafe + U+0301 normalizes to composed café and dedupes; Dog vs dog stay distinct in display.
    expect(pf24.values).toEqual(['caf\u00e9', 'dog', 'Dog']);
  });

  it('preserves union limit placement with oversized, blank, and duplicated observations', () => {
    const live = ['Chicken', '', '  ', 'Beef', 'Beef', ...Array.from({ length: 260 }, (_, i) => `Opt${i}`)];
    const input: MerchandisingFieldSpecInput = {
      configuration: { status: 'complete', config: baseConfig },
      registry: {
        status: 'available',
        data: [{ xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null }],
      },
      observations: { ProductField24: { liveOptions: { status: 'available', data: live } } },
    };
    const model = composeMerchandisingFieldSpecs(input);
    const candidates = projectCurationFieldCandidates(model);
    const pf24 = candidates.find(c => c.catalogField === 'ProductField24')!;
    // No new cap in the projection: blanks removed, duplicates collapsed, everything else retained.
    expect(pf24.values).not.toContain('');
    expect(pf24.values.filter(v => v === 'Beef')).toHaveLength(1);
    expect(pf24.values).toContain('Chicken');
    expect(pf24.values).toContain('Opt259');
    expect(pf24.values.length).toBeGreaterThan(250);
  });

  it('keeps candidate display identical across configured and live_store option sources', () => {
    const withSource = (source: 'configured' | 'live_store'): ClassificationConfig => ({
      ...baseConfig,
      curationTargets: [
        {
          id: 'tgt-flavor',
          attributeId: 'flavor',
          catalogField: 'ProductField24',
          kind: 'product_field',
          enabled: true,
          mandatory: false,
          selectionMode: 'single',
          optionSource: source,
          label: 'Flavor Target',
          required: false,
          sortOrder: 1,
        },
      ],
    });
    const build = (config: ClassificationConfig) => {
      const input: MerchandisingFieldSpecInput = {
        configuration: { status: 'complete', config },
        registry: {
          status: 'available',
          data: [{ xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', sampleValuesJson: null }],
        },
        observations: { ProductField24: { liveOptions: { status: 'available', data: ['Turkey'] } } },
      };
      return projectCurationFieldCandidates(composeMerchandisingFieldSpecs(input))[0].values;
    };
    expect(build(withSource('live_store'))).toEqual(build(withSource('configured')));
  });
});
