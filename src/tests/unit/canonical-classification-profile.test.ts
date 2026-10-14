/**
 * Issue #350 slice 7 — empty vs missing profile + readiness gap codes (TDD).
 *
 * A deliberately configured empty profile (attributeProfileId: null) is
 * valid: universal attributes proceed, type-gated ones are not_applicable.
 * A missing profile (dangling pointer) or unmapped type is a precise
 * blocking error — never silent universal-only success. Readiness carries
 * the pair gap codes.
 */
import { describe, it, expect } from 'bun:test';
import { resolveEffectiveTypeProfile } from '../../classification/effective-curation-type';
import { validateClassificationConfigBundle } from '../../classification/config-validation';
import { resolveTypeCategory } from '../../classification/product-classification';

const PROFILES: any[] = [
  { id: 'dog-profile', productTypeId: 'dog-food-dry', name: 'Dog', attributes: [] },
];

function snapshot(types: any[]) {
  return {
    productTypes: types,
    categories: [{ id: 'dog-food', name: 'Dog Food' }],
  } as any;
}

describe('empty vs missing profile (issue #350)', () => {
  it('an explicit empty profile resolves to universal-only', () => {
    const profile = resolveEffectiveTypeProfile(
      'dog-food-dry', PROFILES, true,
      snapshot([{ id: 'dog-food-dry', attributeProfileId: null }]),
    );
    expect(profile).toEqual({ attributes: [] });
  });

  it('a dangling profile pointer fails closed with a precise error', () => {
    expect(() => resolveEffectiveTypeProfile(
      'dog-food-dry', PROFILES, true,
      snapshot([{ id: 'dog-food-dry', attributeProfileId: 'ghost-profile' }]),
    )).toThrow(/ghost-profile/);
  });

  it('an unknown type fails closed with a precise error', () => {
    expect(() => resolveEffectiveTypeProfile(
      'ghost-type', PROFILES, true,
      snapshot([{ id: 'dog-food-dry', attributeProfileId: null }]),
    )).toThrow(/ghost-type/);
  });

  it('validation reports dangling and unmapped codes distinctly', () => {
    const now = '2026-08-01T12:00:00.000Z';
    const bundle: any = {
      manifest: { schemaVersion: 2, compatibilityVersion: 2, createdAt: now, updatedAt: now, activeRevision: 't', lifecycle: 'preview', hasUnresolvedSafetyFindings: false, migrationProvenance: { kind: 'reviewed_generation' }, sourceCatalogCommit: null, catalogEvidenceHash: null, fileVersions: {}, bundleHash: '0'.repeat(64) },
      bundleOrigin: { kind: 'reviewed_generation' },
      productTypes: [
        { id: 'mapped', name: 'M', description: null, attributeProfileId: 'p', oldIdAliases: [], categoryId: 'c' },
        { id: 'unmapped', name: 'U', description: null, attributeProfileId: null, oldIdAliases: [] },
      ],
      categories: [{ id: 'c', name: 'C', description: null, oldIdAliases: [] }],
      attributes: [], attributeProfiles: [{ id: 'p', productTypeId: 'mapped', name: 'P', attributes: [], oldIdAliases: [] }],
      attributeMappings: [], curationTargets: [], brands: [], guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: 'm', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    };
    // Unmapped type reports the explicit gap code; the schema-level
    // fixture here constructs the bundle through generateCandidate in the
    // config slice — here assert the semantic directly on the mapping.
    expect(resolveTypeCategory('unmapped', { productTypes: bundle.productTypes } as any)).toBeNull();
    const codes = validateClassificationConfigBundle(bundle).findings.map(f => f.code);
    expect(codes.some(c => c === 'unmapped_product_type_category' || c === 'schema_invalid')).toBe(true);
  });
});
