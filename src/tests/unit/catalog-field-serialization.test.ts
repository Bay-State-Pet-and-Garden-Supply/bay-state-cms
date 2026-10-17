/**
 * Serialization at the shared projection/serializer interfaces. Approved
 * fixtures carry captured attributes and mappings; workflow tests own proof
 * of review, pending exclusion, and actual catalog/onboarding local drafts.
 */
import { describe, expect, it } from 'vitest';
import { serializeAttributeValue, buildAssignmentProjection } from '../../classification/assignment-projection';
import type { AttributeMappingConfig, ClassificationProposal, ProductAttributeConfig } from '../../shared/types';

function makeProposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'prop-1', runId: 'run-1', productSku: 'SKU-1', proposalType: 'field_assignment',
    targetId: 'flavor', proposedValue: ['Chicken', 'Beef'], confidence: 0.9,
    evidenceIds: [], status: 'accepted', isBulkAcceptable: false, isStale: false,
    stalenessReason: null, createdAt: '2026-08-01T00:00:00.000Z', ...overrides,
  };
}

const flavor: ProductAttributeConfig = {
  id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null,
  allowedValues: ['Chicken', 'Beef'], valueAliases: [{ alias: 'bird', mapsTo: 'Chicken' }],
  visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null,
};
const flavorMapping: AttributeMappingConfig = {
  id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23',
  serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false,
};
const captured = { attributes: [flavor], frozenMappings: [flavorMapping] };

describe('captured value authority at the reviewed projection interface', () => {
  it('serializes multiple canonical values into the certified Flavor field', () => {
    const result = buildAssignmentProjection([makeProposal()], {}, [], [flavorMapping], undefined, captured);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: null, proposedValue: 'Chicken, Beef', isOverwrite: false, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('canonicalizes a configured alias before serializing the field', () => {
    const result = buildAssignmentProjection([
      makeProposal({ proposedValue: ['bird', 'Beef'] }),
    ], {}, [], [flavorMapping], undefined, captured);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: null, proposedValue: 'Chicken, Beef', isOverwrite: false, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it.each([
    { proposedValue: 'Salmon' },
    { proposedValue: 'CHICKEN' },
    { proposedValue: ['Chicken', 'Salmon'] },
  ])('refuses noncanonical controlled values: $proposedValue', ({ proposedValue }) => {
    const result = buildAssignmentProjection([
      makeProposal({ proposedValue }),
    ], {}, [], [flavorMapping], undefined, captured);
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('refuses an alias whose destination is not an allowed canonical value', () => {
    const invalidAlias = { ...flavor, valueAliases: [{ alias: 'bird', mapsTo: 'Turkey' }] };
    const result = buildAssignmentProjection([
      makeProposal({ proposedValue: 'bird' }),
    ], {}, [], [flavorMapping], undefined, { ...captured, attributes: [invalidAlias] });
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('refuses nonempty controlled values when the captured allowed set is empty', () => {
    const result = buildAssignmentProjection([makeProposal()], {}, [], [flavorMapping], undefined, {
      ...captured, attributes: [{ ...flavor, allowedValues: [] }],
    });
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('refuses a target absent from captured attributes despite a valid current mapping', () => {
    const result = buildAssignmentProjection([makeProposal()], {}, [], [flavorMapping], undefined, {
      ...captured, attributes: [],
    });
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('clears a controlled field without leaving configured prefix/suffix text behind', () => {
    const mapping = { ...flavorMapping, serialization: { ...flavorMapping.serialization, prefix: 'Flavor: ', suffix: ' recipe' } };
    const result = buildAssignmentProjection([
      makeProposal({ revisedValue: null, hasRevisedValue: true }),
    ], { ProductField23: 'Flavor: Chicken recipe' }, [], [mapping], undefined, { attributes: [flavor], frozenMappings: [mapping] });
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: 'Flavor: Chicken recipe', proposedValue: '', isOverwrite: true, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('does not reinterpret a missing value as an explicit reviewed clear', () => {
    const result = buildAssignmentProjection([
      makeProposal({ revisedValue: undefined, hasRevisedValue: true }),
    ], { ProductField23: 'Chicken' }, [], [flavorMapping], undefined, captured);
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('keeps targetless assignments visible without blocking interpretation of valid fields', () => {
    const result = buildAssignmentProjection([
      makeProposal(), makeProposal({ id: 'no-target', targetId: null }),
    ], {}, [], [flavorMapping], undefined, captured);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField23', currentValue: null, proposedValue: 'Chicken, Beef', isOverwrite: false, isNoOp: false },
    ]);
    // A mutation owner must refuse this projection atomically because of the
    // refusal; a valid partial interpretation is not permission to save it.
    expect(result.skipped.map(skip => ({ proposalId: skip.proposalId, targetId: skip.targetId }))).toEqual([
      { proposalId: 'no-target', targetId: null },
    ]);
  });
});

describe('measured captured attributes', () => {
  const size: ProductAttributeConfig = { ...flavor, id: 'size', name: 'Size', valueMode: 'measured', canonicalUnit: 'lb', allowedValues: [], valueAliases: [] };
  const mapping: AttributeMappingConfig = {
    id: 'size-map', attributeId: 'size', catalogField: 'ProductField27',
    serialization: { format: 'direct', separator: ', ', prefix: '', suffix: ' lb' }, isStale: false,
  };
  const authority = { attributes: [size], frozenMappings: [mapping] };

  it('projects a finite measured value with its configured unit', () => {
    const result = buildAssignmentProjection([
      makeProposal({ targetId: 'size', proposedValue: 15 }),
    ], {}, [], [mapping], undefined, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField27', currentValue: null, proposedValue: '15 lb', isOverwrite: false, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity, 'heavy'])('refuses a non-finite measured value: %s', proposedValue => {
    const result = buildAssignmentProjection([
      makeProposal({ targetId: 'size', proposedValue }),
    ], {}, [], [mapping], undefined, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it.each(['15 kg', '15 lbs', '12lb?'])('refuses a measured string whose unit does not match the captured unit: %s', proposedValue => {
    const result = buildAssignmentProjection([
      makeProposal({ targetId: 'size', proposedValue }),
    ], {}, [], [mapping], undefined, authority);
    expect(result.fields).toEqual([]);
    expect(result.skipped.map(skip => skip.proposalId)).toEqual(['prop-1']);
  });

  it('allows an explicit reviewed measured clear without a dangling unit', () => {
    const result = buildAssignmentProjection([
      makeProposal({ targetId: 'size', proposedValue: 15, revisedValue: null, hasRevisedValue: true }),
    ], { ProductField27: '15 lb' }, [], [mapping], undefined, authority);
    expect(result.fields).toEqual([
      { catalogField: 'ProductField27', currentValue: '15 lb', proposedValue: '', isOverwrite: true, isNoOp: false },
    ]);
    expect(result.skipped).toEqual([]);
  });
});

describe('field-specific serializer formats', () => {
  it('serializes a scalar with configured affixes', () => {
    expect(serializeAttributeValue('Chicken', { kind: 'scalar', prefix: '[', suffix: ']' })).toBe('[Chicken]');
  });

  it('joins multi-values with the configured delimiter', () => {
    expect(serializeAttributeValue(['Chicken', 'Beef'], {
      kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '',
    })).toBe('Chicken|Beef');
  });

  it('rejects embedded delimiters instead of silently corrupting membership', () => {
    expect(() => serializeAttributeValue(['Chicken|Rice', 'Beef'], {
      kind: 'delimited', delimiter: '|', escapePolicy: 'reject', prefix: '', suffix: '',
    })).toThrow();
  });

  it('escapes embedded delimiters under the configured backslash policy', () => {
    expect(serializeAttributeValue(['Chicken|Rice', 'Beef'], {
      kind: 'delimited', delimiter: '|', escapePolicy: 'backslash', prefix: '', suffix: '',
    })).toBe('Chicken\\|Rice|Beef');
  });

  it('serializes finite quantities with measured units and affixes', () => {
    expect(serializeAttributeValue(15, {
      kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '[', suffix: ']',
    })).toBe('[15 lb]');
  });

  it.each([NaN, Infinity, -Infinity, 'heavy'])('rejects a non-finite measured quantity: %s', value => {
    expect(() => serializeAttributeValue(value, {
      kind: 'measured', unit: 'lb', valueUnitSeparator: ' ', prefix: '', suffix: '',
    })).toThrow();
  });

  it('bypasses affixes for explicit serializer clears', () => {
    expect(serializeAttributeValue(null, { format: 'direct', separator: ', ', prefix: 'Size: ', suffix: ' lb' })).toBe('');
    expect(serializeAttributeValue(undefined, { kind: 'scalar', prefix: 'Size: ', suffix: ' lb' })).toBe('');
  });
});
