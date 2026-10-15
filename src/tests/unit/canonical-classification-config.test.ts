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
import { previewCandidate } from '../../classification/config-store';
import {
  resolveTypeCategory,
  isApprovedClassificationPair,
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
});
