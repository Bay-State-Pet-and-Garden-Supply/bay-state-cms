import { describe, expect, it } from 'vitest';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { generateCandidate } from '../../classification/config-generator';
import { validateClassificationConfigBundle } from '../../classification/config-validation';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

const REVIEWED_FIELDS = [
  'ProductField16', 'ProductField17', 'ProductField18', 'ProductField19',
  'ProductField20', 'ProductField21', 'ProductField22', 'ProductField23',
  'ProductField24', 'ProductField25', 'ProductField26', 'ProductField27',
  'ProductField28', 'ProductField29', 'ProductField30', 'ProductField32',
  'ProductField4', 'ProductField8',
];

function evidenceWithFields(fields: string[]): CatalogEvidence {
  return {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: fields.length, xmlFields: [...fields].sort() },
    fields: [...fields].sort().map(xmlField => ({
      xmlField,
      recordCount: 1,
      nonEmptyCount: 1,
      distinctValueCount: 1,
      distinctValueHash: '0'.repeat(64),
      delimiterEvidence: [],
    })),
    pages: [],
  };
}

describe('classification config generator', () => {
  it('produces a preview-valid complete v2 bundle from the approved Bay State seed', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const report = validateClassificationConfigBundle(candidate.bundle, {
      mode: 'preview',
      focusedFileContents: candidate.focusedFiles,
    });

    expect(report.valid).toBe(true);
    expect(report.findings.filter(finding => finding.severity === 'error')).toEqual([]);
    expect(candidate.bundle.manifest.schemaVersion).toBe(2);
    expect(candidate.bundle.manifest.lifecycle).toBe('preview');
    expect(candidate.bundle.manifest.migrationProvenance).toEqual({ kind: 'reviewed_generation' });
    expect(candidate.bundle.manifest.bundleHash).toMatch(/^[a-f0-9]{64}$/);

    // Complete focused-file set with manifest-bound hashes.
    expect(Object.keys(candidate.focusedFiles).sort()).toEqual([
      'attribute-profiles.json', 'attributes.json', 'brands.json',
      'categories.json', 'curation-targets.json', 'data-sharing.json',
      'guidance.json', 'mappings.json', 'model-policies.json',
      'product-types.json',
    ]);
  });

  it('is deterministic across repeated generation', () => {
    const first = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const second = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    expect(second.bundle.manifest.bundleHash).toBe(first.bundle.manifest.bundleHash);
    expect(second.focusedFiles).toEqual(first.focusedFiles);
  });

  it('creates conservative profiles: no pet attributes in garden, no store fields in pet food', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const profiles = candidate.bundle.attributeProfiles;

    const gardenTypes = new Set([
      'lawn-fertilizer', 'grass-seed', 'weed-control',
      'insect-control', 'potting-soil', 'hand-tools',
    ]);
    const gardenProfileIds = profiles
      .filter(profile => gardenTypes.has(profile.productTypeId))
      .map(profile => profile.id);

    expect(gardenProfileIds).toHaveLength(6);
    for (const profile of profiles) {
      const attributeIds = new Set(profile.attributes.map(entry => entry.attributeId));
      if (gardenTypes.has(profile.productTypeId)) {
        // Garden profiles never carry pet attributes (species, life stage, food form, etc.).
        expect([...attributeIds].some(id => ['species', 'life-stage', 'breed-size', 'food-form', 'flavor', 'dietary-features', 'health-benefits'].includes(id))).toBe(false);
      } else if (['dog-food-dry', 'cat-food-wet', 'bird-food', 'supplements'].includes(profile.productTypeId)) {
        // Pet-food profiles carry pet-food fields but never store department/category.
        expect(attributeIds.has('department')).toBe(false);
        expect(attributeIds.has('category')).toBe(false);
      }
    }
    // Every product type references exactly its own profile.
    for (const type of candidate.bundle.productTypes) {
      const profile = profiles.find(entry => entry.id === type.attributeProfileId);
      if (profile) expect(profile.productTypeId).toBe(type.id);
    }
  });

  it('preserves the reviewed ShopSite field mappings (verified Extra Fields config)', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const mappingByAttribute = new Map(
      candidate.bundle.attributeMappings.map(mapping => [mapping.attributeId, mapping.catalogField]),
    );
    expect(mappingByAttribute.get('brand')).toBe('ProductField16');
    expect(mappingByAttribute.get('species')).toBe('ProductField17');
    expect(mappingByAttribute.get('life-stage')).toBe('ProductField18');
    expect(mappingByAttribute.get('breed-size')).toBe('ProductField19');
    expect(mappingByAttribute.get('dietary-features')).toBe('ProductField20');
    expect(mappingByAttribute.get('health-benefits')).toBe('ProductField21');
    expect(mappingByAttribute.get('food-form')).toBe('ProductField22');
    expect(mappingByAttribute.get('flavor')).toBe('ProductField23');
    expect(mappingByAttribute.get('category')).toBe('ProductField24');
    expect(mappingByAttribute.get('product-type')).toBe('ProductField25');
    expect(mappingByAttribute.get('product-feature')).toBe('ProductField26');
    expect(mappingByAttribute.get('size')).toBe('ProductField27');
    expect(mappingByAttribute.get('material')).toBe('ProductField28');
    expect(mappingByAttribute.get('color')).toBe('ProductField29');
    expect(mappingByAttribute.get('packaging-type')).toBe('ProductField30');
    expect(mappingByAttribute.get('product-cross-sell')).toBe('ProductField32');
    expect(mappingByAttribute.get('nutrition')).toBe('ProductField8');
    // Reserved: ProductField31 (Product Category) is intentionally unmapped
    // pending owner verification — it carries live category values (2026-10-13 census).
    expect(mappingByAttribute.has('department')).toBe(false);
    expect(candidate.bundle.attributeMappings.some(mapping => mapping.catalogField === 'ProductField31')).toBe(false);

    // Product Type is mapped through the product-type attribute (the Facet -
    // Product Type field), while the primary-product-type target stays
    // attribute/catalog-field free (single-cardinality configured gate).
    const productTypeTarget = candidate.bundle.curationTargets.find(target => target.kind === 'product_type')!;
    expect(productTypeTarget).toBeDefined();
    expect(productTypeTarget.catalogField).toBeNull();
    expect(productTypeTarget.attributeId).toBeNull();
    const productTypeIds = new Set(candidate.bundle.productTypes.map(type => type.id));
    expect(candidate.bundle.attributeMappings.some(mapping => productTypeIds.has(mapping.attributeId))).toBe(false);
  });

  it('keeps exactly one enabled Product Type target, enables the verified Page target, and leaves claims/composition inactive', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    const effective = candidate.bundle.curationTargets.filter(target => target.enabled || target.mandatory);

    const typeTargets = effective.filter(target => target.kind === 'product_type');
    expect(typeTargets).toHaveLength(1);
    expect(typeTargets[0].selectionMode).toBe('single');
    expect(typeTargets[0].optionSource).toBe('configured');

    const pageTarget = candidate.bundle.curationTargets.find(target => target.kind === 'page')!;
    expect(pageTarget.enabled).toBe(true);
    expect(pageTarget.mandatory).toBe(false);
    expect(pageTarget.required).toBe(false);
    expect(pageTarget.selectionMode).toBe('multiple');
    expect(pageTarget.optionSource).toBe('live_store');

    // Claim/composition attributes exist but no target is enabled for them.
    const claimAttributes = new Set(
      candidate.bundle.attributes
        .filter(attribute => attribute.isClaim || attribute.isCompositionAttribute)
        .map(attribute => attribute.id),
    );
    expect(claimAttributes.size).toBeGreaterThan(0);
    const enabledTargetAttributes = new Set(
      effective
        .filter(target => target.kind === 'product_field' && target.attributeId)
        .map(target => target.attributeId as string),
    );
    for (const claimId of claimAttributes) {
      expect(enabledTargetAttributes.has(claimId)).toBe(false);
    }
  });

  it('disables every ML production feature and attests local-only provider locality', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(REVIEWED_FIELDS));
    for (const policy of Object.values(candidate.bundle.modelPolicy.mlFeatures)) {
      expect(policy.state).toBe('disabled');
      expect(policy.qualificationReceiptDigest).toBeNull();
    }
    expect(candidate.bundle.modelPolicy.defaultProvider).toBe('ollama');
    expect(candidate.bundle.modelPolicy.defaultModel).toBe('qwen2.5vl:latest');
    expect(candidate.bundle.modelPolicy.providerLocalities).toEqual({ ollama: 'local' });
    expect(candidate.bundle.modelPolicy.imageDataSharing).toBe('local_only');
    expect(candidate.bundle.modelPolicy.textDataSharing).toBe('local_only');
    expect(candidate.bundle.dataSharing.imagePolicy).toBe('local_only');
    expect(candidate.bundle.dataSharing.textPolicy).toBe('local_only');
    expect(candidate.bundle.dataSharing.sensitiveDataFiltering).toBe(true);
  });

  it('throws rather than producing a semantically invalid candidate', () => {
    const brokenSeed = {
      ...BayStatePetGardenSeed,
      curationTargets: BayStatePetGardenSeed.curationTargets.filter(target => target.kind !== 'product_type'),
    };
    expect(() => generateCandidate(brokenSeed, evidenceWithFields(REVIEWED_FIELDS))).toThrow(/product_type_target_required/);
  });

  it('flags mappings whose Catalog Field is absent from the evidence scan', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, evidenceWithFields(['ProductField16']));
    const finding = candidate.findings.find(finding => finding.code === 'mapping_field_not_in_evidence');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
  });
});
