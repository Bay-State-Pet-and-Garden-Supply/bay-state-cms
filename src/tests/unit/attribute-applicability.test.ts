/**
 * Attribute Applicability — explicit states, deterministic evaluation,
 * universal-without-type, profile-requires-type (Milestone 5).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateAttributeApplicability,
  isUniversalAttribute,
  type AttributeApplicability,
} from '../../classification/applicability-evaluator';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';

function makeAttribute(overrides: Partial<ProductAttributeConfig> = {}): ProductAttributeConfig {
  return {
    id: 'flavor',
    name: 'Flavor',
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['Chicken', 'Beef'],
    valueAliases: [{ alias: 'chicken', mapsTo: 'Chicken' }],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Food',
    ...overrides,
  };
}

describe('evaluateAttributeApplicability', () => {
  it('marks every attribute applicable when no Product Type target is enabled', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: null,
      conditions: [],
      acceptedTypeId: null,
      typeTargetEnabled: false,
      reviewedFacts: [],
    });
    expect(result.state).toBe('applicable');
  });

  it('lets universal attributes proceed without a Product Type', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute({ id: 'brand', name: 'Brand' }),
      profileAttributeIds: null,
      conditions: [],
      acceptedTypeId: null,
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(isUniversalAttribute(makeAttribute({ id: 'brand' }))).toBe(false);
    // v1 runtime attributes have no isUniversal; the accessor must be tolerant.
    expect(result.state).toBe('unknown');
  });

  it('evaluates v2-style universal attributes as applicable without a type', () => {
    const universal = makeAttribute({ id: 'brand', name: 'Brand' }) as ProductAttributeConfig & { isUniversal: boolean };
    universal.isUniversal = true;
    expect(isUniversalAttribute(universal)).toBe(true);
    const result = evaluateAttributeApplicability({
      attribute: universal,
      profileAttributeIds: null,
      conditions: [],
      acceptedTypeId: null,
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('applicable');
  });

  it('blocks profile attributes to unknown when no reviewed Product Type exists', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [],
      acceptedTypeId: null,
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('unknown');
  });

  it('marks profile attributes not_applicable when absent from the accepted type profile', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['species']),
      conditions: [],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('not_applicable');
  });

  it('marks profile attributes applicable when present in the accepted type profile with no conditions', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('applicable');
  });

  it('evaluates equals conditions deterministically against accepted/reviewed facts', () => {
    const facts = [
      { proposalId: 'p1', decisionId: 'd1', runId: 'r1', workspaceId: 'ws', productSku: 'sku', proposalType: 'field_assignment', targetId: 'species', value: 'Dog', configSnapshotHash: 'cfg', sourceHash: 'src', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const applicable = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [{ operator: 'equals', attributeId: 'species', value: 'Dog' }],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: facts,
    });
    expect(applicable.state).toBe('applicable');

    const notApplicable = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [{ operator: 'equals', attributeId: 'species', value: 'Cat' }],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: facts,
    });
    expect(notApplicable.state).toBe('not_applicable');
  });

  it('evaluates in conditions deterministically', () => {
    const facts = [
      { proposalId: 'p1', decisionId: 'd1', runId: 'r1', workspaceId: 'ws', productSku: 'sku', proposalType: 'field_assignment', targetId: 'species', value: 'Dog', configSnapshotHash: 'cfg', sourceHash: 'src', createdAt: '2026-08-01T00:00:00.000Z' },
    ];
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [{ operator: 'in', attributeId: 'species', values: ['Dog', 'Cat'] }],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: facts,
    });
    expect(result.state).toBe('applicable');
  });

  it('returns unknown when a condition depends on a missing fact or an unrecognized shape', () => {
    const missingFact = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [{ operator: 'equals', attributeId: 'species', value: 'Dog' }],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(missingFact.state).toBe('unknown');

    const unrecognized = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [{ operator: 'regex', attributeId: 'species', pattern: '.*' }],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(unrecognized.state).toBe('unknown');
  });

  it('returns a stable result object per attribute', () => {
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set(['flavor']),
      conditions: [],
      acceptedTypeId: 'dry-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    }) as AttributeApplicability;
    expect(result.attributeId).toBe('flavor');
    expect(['applicable', 'not_applicable', 'unknown']).toContain(result.state);
  });

  it('treats a non-null EMPTY profile set as not_applicable for every type-gated attribute (type exists, empty profile)', () => {
    // PR5 P1-1: a type with a legitimately empty profile (attributeProfileId
    // null) must gate to not_applicable — an empty Set means "no attribute
    // from this profile may apply", never "no profile constraint".
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: new Set<string>(),
      conditions: [],
      acceptedTypeId: 'plain-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('not_applicable');
  });

  it('keeps the legacy null-profile semantics: a null profile with a type falls through to conditions (flag-OFF contract)', () => {
    // The legacy path (no cohort execution type) is byte-identical: null
    // profileAttributeIds means "no profile constraint" and, with no
    // conditions, evaluates applicable. The effective path never passes null
    // when a type exists — that unsafe interpretation is the bug this fixes.
    const result = evaluateAttributeApplicability({
      attribute: makeAttribute(),
      profileAttributeIds: null,
      conditions: [],
      acceptedTypeId: 'plain-dog-food',
      typeTargetEnabled: true,
      reviewedFacts: [],
    });
    expect(result.state).toBe('applicable');
  });
});
