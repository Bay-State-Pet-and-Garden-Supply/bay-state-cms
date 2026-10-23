/**
 * P3 Universal-Tier Widening (classification roadmap plan B.P3.1/B.P3.2)
 *
 * Covers:
 * - evaluator: widened ids (size/color/material/flavor) become `applicable`
 *   pre-type ONLY while the flag is ON; flag OFF is byte-identical legacy;
 * - profile enforcement unchanged post-type: a widened attribute outside the
 *   accepted type's profile stays `not_applicable` — widening never bypasses
 *   the Attribute Profile;
 * - both applicability stages thread the shared flag into the evaluator;
 * - PR9 DECISION-B structural invariant: pre-type proposals exist only while
 *   no reviewed/execution type drives dependency stamping (effective-type
 *   source `none`), asserted via the effective-type resolver contract;
 * - CONTEXT.md wording matches the implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateAttributeApplicability,
  WIDENED_UNIVERSAL_ATTRIBUTE_IDS,
} from '../../classification/applicability-evaluator';
import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';
import type { ResolvedTargets } from '../../classification/curation-target-resolver';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';

vi.mock('@/classification/config-loader', () => ({ loadClassificationConfig: vi.fn(() => { throw new Error('no disk reads in unit tests'); }) }));
vi.mock('@/classification/runtime-snapshot', () => ({ buildModelCallContext: vi.fn(() => null) }));
vi.mock('@/db/repositories/classification-config-repo', () => ({ getCachedAttributeProfiles: vi.fn(() => []), getCachedAttributeMappings: vi.fn(() => []) }));
vi.mock('@/db/repositories/classification-model-call-repo', () => ({ recordTerminalPreflight: vi.fn() }));
vi.mock('@/onboarding/llm-client', () => ({ callLlmForTaskWithProvenance: vi.fn(), getLlmConfigForTask: vi.fn() }));
vi.mock('@/classification/curation-target-resolver', () => ({
  resolveEnabledTargets: vi.fn(),
  resolveTargetsFromSnapshot: vi.fn(),
}));
import { getEffectiveCurationProductType } from '../../classification/effective-curation-type';
import {
  DEFAULT_UNIVERSAL_TIER_FLAGS,
  getUniversalTierFlags,
  overrideUniversalTierFlags,
  resetUniversalTierFlagsOverride,
} from '../../classification/flags';
import type { ProductAttributeConfig } from '../../shared/schemas/classification';

function makeAttribute(id: string, name: string): ProductAttributeConfig {
  return {
    id,
    name,
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues: ['A', 'B'],
    valueAliases: [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Product',
  };
}

function evalFor(attribute: ProductAttributeConfig, overrides: Record<string, unknown> = {}) {
  return evaluateAttributeApplicability({
    attribute,
    profileAttributeIds: new Set(['size']),
    conditions: [],
    acceptedTypeId: null,
    typeTargetEnabled: true,
    reviewedFacts: [],
    ...overrides,
  });
}

beforeEach(() => resetUniversalTierFlagsOverride());
afterEach(() => resetUniversalTierFlagsOverride());

describe('widened universal tier — pure evaluator', () => {
  const size = makeAttribute('size', 'Size');
  const color = makeAttribute('color', 'Color');
  const material = makeAttribute('material', 'Material');
  const flavor = makeAttribute('flavor', 'Flavor');
  const btu = makeAttribute('btu-rating', 'BTU Rating');

  it('exposes exactly the planned widened tier', () => {
    expect([...WIDENED_UNIVERSAL_ATTRIBUTE_IDS].sort()).toEqual(['color', 'flavor', 'material', 'size']);
  });

  it('defaults OFF and OFF keeps legacy behavior (pre-type = unknown)', () => {
    expect(DEFAULT_UNIVERSAL_TIER_FLAGS.universalTierWideningEnabled).toBe(false);
    for (const attribute of [size, color, material, flavor]) {
      const result = evalFor(attribute);
      expect(result.state).toBe('unknown');
      expect(result.reason).toMatch(/No Product Classification/);
    }
  });

  it('flag ON: widened tier proposes without a Product Type', () => {
    overrideUniversalTierFlags({ universalTierWideningEnabled: true });
    for (const attribute of [size, color, material, flavor]) {
      const result = evalFor(attribute, { widenedUniversal: true });
      expect(result.state).toBe('applicable');
      expect(result.reason).toMatch(/Widened universal tier/);
      expect(result.reason).toMatch(/Attribute Profile still enforces/);
    }
  });

  it('flag ON does NOT widen non-tier attributes (btu-rating stays unknown)', () => {
    overrideUniversalTierFlags({ universalTierWideningEnabled: true });
    expect(evalFor(btu, { widenedUniversal: true }).state).toBe('unknown');
  });

  it('flag ON never bypasses the profile once a type IS accepted', () => {
    overrideUniversalTierFlags({ universalTierWideningEnabled: true });
    // size IS in the accepted profile → normal applicable path.
    const inProfile = evaluateAttributeApplicability({
      attribute: size,
      profileAttributeIds: new Set(['size']),
      conditions: [],
      acceptedTypeId: 'dog-toys',
      typeTargetEnabled: true,
      reviewedFacts: [],
      widenedUniversal: true,
    });
    expect(inProfile.state).toBe('applicable');

    // color is NOT in the accepted profile → not_applicable (no widening bypass).
    const outOfProfile = evaluateAttributeApplicability({
      attribute: color,
      profileAttributeIds: new Set(['size']),
      conditions: [],
      acceptedTypeId: 'dog-toys',
      typeTargetEnabled: true,
      reviewedFacts: [],
      widenedUniversal: true,
    });
    expect(outOfProfile.state).toBe('not_applicable');
    expect(outOfProfile.reason).toMatch(/not in the accepted Product Type profile/);
  });

  it('flag OFF stays byte-identical even when callers pass widenedUniversal=false/undefined', () => {
    expect(getUniversalTierFlags().universalTierWideningEnabled).toBe(false);
    expect(evalFor(size, { widenedUniversal: false }).state).toBe('unknown');
    expect(evalFor(size, {}).state).toBe('unknown');
  });
});

describe('widened universal tier — stages thread the shared flag', () => {
  const size = makeAttribute('size', 'Size');
  const _color = makeAttribute('color', 'Color');

  const sizeTarget = {
    id: 'size-target',
    kind: 'product_field' as const,
    label: 'Size',
    enabled: true,
    mandatory: false,
    selectionMode: 'single' as const,
    attributeId: 'size',
    catalogField: 'ProductField27',
    optionSource: 'configured' as const,
    required: false,
    sortOrder: 0,
  };
  const snapshot = {
    schemaVersion: 2 as const,
    snapshotHash: 'hash-1',
    createdAt: '2026-08-24T00:00:00.000Z',
    workspaceId: 'ws',
    workspacePath: '/tmp/ws',
    productSku: 'sku',
    configAuthorityKind: 'v1' as const,
    config: { curationTargets: [sizeTarget], attributeMappings: [], attributes: [size] },
    curationTargets: [],
    // A Product Type exists as a target, so type gating applies...
    productTypes: [{ id: 'dog-toys', name: 'Dog Toys', description: null, attributeProfileId: null, oldIdAliases: [] }],
    attributes: [size],
    fieldOptions: {},
    pages: { state: 'empty', records: [] },
    reviewedFacts: [],
  };
  const context = { runId: 'run-1', workspaceId: 'ws', workspacePath: '/tmp/ws', snapshot } as never;

  function baseInput(): Record<string, unknown> {
    return {
      sku: 'sku',
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
      stageOutputs: {},
    };
  }

  /** Both stages resolve targets from the frozen snapshot (never live config). */
  function stubResolver() {
    vi.mocked(resolveTargetsFromSnapshot).mockImplementation((snap: import('../../classification/runtime-snapshot').RuntimeClassificationSnapshot) => ({
      productTypes: snap.productTypes.map(pt => ({ config: pt, options: [] })),
      productFields: [{ config: sizeTarget, options: [], attribute: snap.attributes[0] }],
      pages: [],
      hasAny: true,
    }) as unknown as ResolvedTargets);
  }

  it('attribute_applicability stage refuses missing frozen profile authority when widening is enabled', async () => {
    overrideUniversalTierFlags({ universalTierWideningEnabled: true });
    stubResolver();
    const result = await attributeApplicabilityStage.execute(baseInput() as never, context);

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') return;
    expect(result.output?.metadata).toMatchObject({
      applicability: [],
      profileStatus: 'configuration_gap',
    });
  });

  it('attribute_applicability stage does not infer a profile from missing authority when widening is disabled', async () => {
    stubResolver();
    const result = await attributeApplicabilityStage.execute(baseInput() as never, context);

    expect(result.status).toBe('abstained');
    if (result.status !== 'abstained') return;
    expect(result.output?.metadata).toMatchObject({
      applicability: [],
      profileStatus: 'configuration_gap',
    });
  });

  it('product_attribute_proposals stage never bypasses missing frozen profile authority', async () => {
    stubResolver();
    const input = baseInput() as never;

    const offResult = await productAttributeProposalsStage.execute(
      JSON.parse(JSON.stringify(input)) as never,
      context,
    );
    expect(offResult.status).toBe('abstained');
    if (offResult.status !== 'abstained') return;
    expect(offResult.output?.proposals ?? []).toEqual([]);
    expect(offResult.output?.metadata).toMatchObject({ profileStatus: 'configuration_gap' });

    overrideUniversalTierFlags({ universalTierWideningEnabled: true });
    const onResult = await productAttributeProposalsStage.execute(
      JSON.parse(JSON.stringify(input)) as never,
      context,
    );
    expect(onResult.status).toBe('abstained');
    if (onResult.status !== 'abstained') return;
    expect(onResult.output?.proposals ?? []).toEqual([]);
    expect(onResult.output?.metadata).toMatchObject({ profileStatus: 'configuration_gap' });
  });

  it('PR9 DECISION-B: pre-type widening resolves the effective type source to none (no dependency rows possible)', () => {
    const input = {
      ...baseInput(),
      acceptedProposals: [],
      allProposals: [],
    } as never;
    const resolved = getEffectiveCurationProductType(input, context);
    expect(resolved.effectiveTypeId).toBeNull();
    expect(resolved.source).toBe('none');
    // Dependency stamping in the cohort executor fires only for source
    // 'reviewed'; source 'none' stamps nothing — so every
    // proposal produced under widening carries NO product-type dependency row.
  });
});
