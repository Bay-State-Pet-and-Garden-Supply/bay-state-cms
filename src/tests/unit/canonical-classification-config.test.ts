/**
 * Issue #350 slice 1 — canonical classification config seam (TDD).
 *
 * Category + Product Type live in shared validation schemas and the
 * governed preview/validation path: every product type carries an approved
 * `categoryId`, a complete pair is valid iff the mapping matches, and
 * ambiguous (unmapped/unknown-category) types fail preview with an explicit
 * code requiring an owner decision — never silent invention.
 */
import { describe, it, expect } from 'bun:test';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { validateClassificationConfigBundle } from '../../classification/config-validation';
import { previewCandidate } from '../../classification/config-store';
import {
  resolveTypeCategory,
  isApprovedClassificationPair,
  resolveWebsiteClassification,
} from '../../classification/product-classification';
import type { BayStateSeed } from '../../classification/config-generator';

const EVIDENCE: any = { fields: [], pages: [], generatedAt: '2026-08-01T12:00:00.000Z' };

describe('canonical classification config (issue #350)', () => {
  it('every seed product type maps to an existing approved category', () => {
    const seed: BayStateSeed = BayStatePetGardenSeed;
    const categories = new Set(seed.categories.map(c => c.id));
    expect(categories.size).toBeGreaterThan(0);
    for (const type of seed.productTypes) {
      if (type.categoryId === undefined) throw new Error(`type ${type.id} has no approved category`);
      expect(categories.has(type.categoryId), `type ${type.id} maps to unknown category ${type.categoryId}`).toBe(true);
    }
  });

  it('generated bundle carries categories and the pair resolves through the mapping', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    expect(candidate.bundle.categories.length).toBeGreaterThan(0);
    const bundle = candidate.bundle;
    const pair = { categoryId: 'dog-food', productTypeId: 'dog-food-dry' };
    expect(isApprovedClassificationPair(pair, bundle)).toBe(true);
    expect(resolveTypeCategory('dog-food-dry', bundle)).toBe('dog-food');
  });

  it('an invented combination is not approved', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    expect(isApprovedClassificationPair(
      { categoryId: 'cat-food', productTypeId: 'dog-food-dry' },
      candidate.bundle,
    )).toBe(false);
  });

  it('preview rejects a bundle with an unmapped type using an explicit code', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const bundle = {
      ...candidate.bundle,
      productTypes: [...candidate.bundle.productTypes, { id: 'mystery-type', name: 'Mystery', description: null, attributeProfileId: null, oldIdAliases: [] as string[], categoryId: null }],
    };
    const dir = `/tmp/canonical-config-${Date.now()}`;
    const result = previewCandidate(bundle, dir);
    expect(result.hash).toBeNull();
    // A type with no approved Category mapping cannot preview: either the
    // schema rejects the missing mapping or validation reports the explicit
    // configuration-gap code. Both refuse — never silent invention.
    const codes = result.report.findings.map(f => f.code);
    expect(codes.some(code => code === 'unmapped_product_type_category' || code === 'schema_invalid')).toBe(true);
  });
  it('keeps missing website values as an explicit gap without inventing a mapping', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const report = validateClassificationConfigBundle(candidate.bundle, {
      mode: 'preview',
      focusedFileContents: candidate.focusedFiles,
    });
    const gap = report.findings.find(finding => finding.code === 'missing_website_classification_mapping');
    expect(report.valid).toBe(true);
    expect(gap?.severity).toBe('warning');
    expect(resolveWebsiteClassification(
      { categoryId: 'dog-food', productTypeId: 'dog-food-dry' },
      candidate.bundle,
    ).status).toBe('unresolved');
  });
  it('resolves only the exact approved website values for a canonical pair', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const bundle = {
      ...candidate.bundle,
      productTypes: candidate.bundle.productTypes.map(type => type.id === 'dog-food-dry'
        ? { ...type, websiteValues: { category: 'QA Category: dog-food', productType: 'QA Product Type: dog-food-dry' } }
        : type),
    };
    const pair = { categoryId: 'dog-food', productTypeId: 'dog-food-dry' };
    const resolved = resolveWebsiteClassification(pair, bundle);
    expect(resolved).toEqual({
      status: 'resolved',
      values: { category: 'QA Category: dog-food', productType: 'QA Product Type: dog-food-dry' },
    });
    if (resolved.status === 'resolved') {
      expect(Object.values(resolved.values)).not.toContain(pair.categoryId);
      expect(Object.values(resolved.values)).not.toContain(pair.productTypeId);
    }

    const missingMapping = {
      ...bundle,
      productTypes: bundle.productTypes.map(type => type.id === 'dog-food-dry'
        ? { ...type, websiteValues: undefined }
        : type),
    };
    expect(resolveWebsiteClassification(pair, missingMapping).status).toBe('unresolved');
    expect(resolveWebsiteClassification(
      { categoryId: 'unknown-category', productTypeId: 'dog-food-dry' },
      bundle,
    ).status).toBe('unresolved');
    expect(resolveWebsiteClassification(
      { categoryId: 'cat-food', productTypeId: 'dog-food-dry' },
      bundle,
    ).status).toBe('unresolved');
    const duplicateMapping = {
      ...bundle,
      productTypes: [...bundle.productTypes, {
        ...bundle.productTypes.find(type => type.id === 'dog-food-dry')!,
        id: 'other-dry-food',
      }],
    };
    expect(resolveWebsiteClassification(pair, duplicateMapping).status).toBe('unresolved');
  });
  it('rejects Category and Product Type attribute questions and invariants during preview', () => {
    const candidate = generateCandidate(BayStatePetGardenSeed, EVIDENCE);
    const bundle = structuredClone(candidate.bundle);
    const type = bundle.productTypes.find(productType => productType.id === 'dog-food-dry');
    const profile = bundle.attributeProfiles.find(attributeProfile => attributeProfile.productTypeId === 'dog-food-dry');
    const baseAttribute = bundle.attributes.find(attribute => attribute.id === 'flavor');
    const baseProfileAttribute = profile?.attributes.find(attribute => attribute.attributeId === 'flavor');
    const baseMapping = bundle.attributeMappings.find(mapping => mapping.attributeId === 'flavor');
    const baseTarget = bundle.curationTargets.find(target => target.kind === 'product_field' && target.attributeId === 'flavor');
    if (!type || !profile || !baseAttribute || !baseProfileAttribute || !baseMapping || !baseTarget) {
      throw new Error('Canonical pair fixture is incomplete');
    }

    const retiredFields = [
      { id: 'category', name: 'Category', catalogField: 'ProductField24', value: 'Dog Food' },
      { id: 'product-type', name: 'Product Type', catalogField: 'ProductField25', value: 'Dry Dog Food' },
    ];
    for (const [index, field] of retiredFields.entries()) {
      bundle.attributes.push({ ...baseAttribute, id: field.id, name: field.name, allowedValues: [field.value] });
      profile.attributes.push({ ...baseProfileAttribute, attributeId: field.id, required: false });
      bundle.attributeMappings.push({ ...baseMapping, id: `${field.id}-mapping`, attributeId: field.id, catalogField: field.catalogField });
      bundle.curationTargets.push({
        ...baseTarget, id: `${field.id}-target`, label: field.name, attributeId: field.id,
        catalogField: field.catalogField, sortOrder: 100 + index,
      });
      type.invariantAttributes = { ...type.invariantAttributes, [field.id]: field.value };
    }

    const result = previewCandidate(bundle, `/tmp/canonical-config-${Date.now()}`);
    expect(result.hash).toBeNull();
    const findings = result.report.findings.filter(finding => finding.code === 'canonical_pair_attribute_retired');
    expect(findings.some(finding => finding.path.startsWith('$.attributes['))).toBe(true);
    expect(findings.some(finding => finding.path.startsWith('$.attributeProfiles['))).toBe(true);
    expect(findings.some(finding => finding.path.startsWith('$.attributeMappings['))).toBe(true);
    expect(findings.some(finding => finding.path.startsWith('$.curationTargets['))).toBe(true);
    expect(findings.some(finding => finding.path.includes('.invariantAttributes.'))).toBe(true);
  });
});
