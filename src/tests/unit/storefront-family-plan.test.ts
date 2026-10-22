import { describe, expect, it } from 'bun:test';
import {
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  nominateFamilyMain,
  nominateNonFoodFamilyMain,
  normalizeFamilyFactor,
  resolveFamilyVariantRule,
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION,
} from '../../classification/family-variant-rule';
import {
  derivePf7ShortNames,
  deriveNonFoodPf7ShortNames,
  validateStorefrontFamilyGroup,
  validateNonFoodFamilyGroup,
  classifyClassifierFamilyWrite,
  parseOunces,
} from '../../validation/storefront-family-validation';
import { buildManagedSubproductsXml, setManagedSubproducts, classifySubproductsSupport } from '../../shopsite/storefront-subproducts';
import type { Product } from '../../shared/types';
function factors(sku: string, overrides: Record<string, unknown> = {}) {
  const base = {
    sku,
    factors: {
      brand: 'Acme',
      recipe: 'Chicken Dinner',
      flavor: 'Chicken',
      species: 'Dog',
      lifeStage: 'Adult',
      form: 'Dry Kibble',
      packageSize: { raw: '5 lb', ounces: 80 },
      retailUnit: null,
      comparableOunces: 80,
      reviewedTypeHash: 'type-v1',
    },
  };
  return { sku: base.sku, factors: { ...base.factors, ...overrides } };
}

describe('food family variant rule (issue #368)', () => {
  it('accepts two distinct sizes under identical invariants', () => {
    const verdict = evaluateFamilyVariantRule([factors('A-5', { packageSize: { raw: '5 lb', ounces: 80 }, comparableOunces: 80 }), factors('A-15', { packageSize: { raw: '15 lb', ounces: 240 }, comparableOunces: 240 })]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.ruleVersion).toBe(FOOD_FAMILY_VARIANT_RULE_VERSION);
  });

  it('refuses flavor conflicts, duplicate sizes, unknown invariants, undeclared packs, and type drift', () => {
    const conflict = evaluateFamilyVariantRule([factors('A'), factors('B', { flavor: 'Beef' })]);
    expect(conflict.ok).toBe(false);
    const dupe = evaluateFamilyVariantRule([factors('A'), factors('B')]);
    expect(dupe.ok).toBe(false);
    const unknown = evaluateFamilyVariantRule([factors('A', { flavor: null }), factors('B')]);
    expect(unknown.ok).toBe(false);
    const typeDrift = evaluateFamilyVariantRule([factors('A'), factors('B', { reviewedTypeHash: 'type-v2' })]);
    expect(typeDrift.ok).toBe(false);
    expect(typeDrift.ok === false && typeDrift.code).toBe('family_rule_type_authority_mismatch');
    // N1: pack rule binds only through the explicit pack input — an
    // undeclared pack count refuses, a declared one passes.
    const undeclared = evaluateFamilyVariantRule([
      { ...factors('A'), pack: { packCountDeclared: false, packCount: 2 } },
      { ...factors('B', { packageSize: { raw: '15 lb', ounces: 240 }, comparableOunces: 240 }), pack: { packCountDeclared: false, packCount: null } },
    ]);
    expect(undeclared.ok).toBe(false);
    expect(undeclared.ok === false && undeclared.code).toBe('family_rule_undeclared_pack');
    const declared = evaluateFamilyVariantRule([
      { ...factors('A'), pack: { packCountDeclared: true, packCount: 2 } },
      { ...factors('B', { packageSize: { raw: '15 lb', ounces: 240 }, comparableOunces: 240 }), pack: { packCountDeclared: false, packCount: null } },
    ]);
    expect(declared.ok).toBe(true);
  });

  it('nominates the smallest verified size and requires selection when incomparable', () => {
    expect(nominateFamilyMain([{ sku: 'A', comparableOunces: 240 }, { sku: 'B', comparableOunces: 80 }])).toEqual({
      kind: 'nominated', sku: 'B', ounces: 80,
    });
    expect(nominateFamilyMain([{ sku: 'A', comparableOunces: null }]).kind).toBe('selection_required');
    expect(normalizeFamilyFactor('  Chicken  ')).toBe('chicken');
  });

  it('derives nonempty unique PF7 names deterministically', () => {
    const names = derivePf7ShortNames([
      { sku: 'B', sizeRaw: '5 lb', ounces: 80 },
      { sku: 'A', sizeRaw: '5 lb', ounces: 80 },
    ]);
    expect(names.map((n) => n.shortName).every((s) => s.length > 0)).toBe(true);
    expect(new Set(names.map((n) => n.shortName)).size).toBe(2);
    expect(derivePf7ShortNames([{ sku: 'B', sizeRaw: '5 lb', ounces: 80 }, { sku: 'A', sizeRaw: '5 lb', ounces: 80 }])).toEqual(
      derivePf7ShortNames([{ sku: 'A', sizeRaw: '5 lb', ounces: 80 }, { sku: 'B', sizeRaw: '5 lb', ounces: 80 }]),
    );
  });

  it('parses ounces and refuses classifier PF7/native writes', () => {
    expect(parseOunces('5 lb')).toBe(80);
    expect(parseOunces('mystery')).toBeNull();
    expect(classifyClassifierFamilyWrite('ProductField7')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('Subproducts')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('ProductField27')).toBeNull();
  });

  it('treats comma-grouped gram quantities as thousands, not decimals', () => {
    const grouped = parseOunces('1,000 g');
    expect(grouped).toBe(parseOunces('1000 g'));
    expect(grouped).not.toBe(parseOunces('1 g'));
  });
});
function nonFoodFactors(sku: string, overrides: Record<string, unknown> = {}) {
  const base = {
    sku,
    factors: {
      brand: 'Acme',
      model: 'Trail Harness',
      material: 'Nylon',
      function: 'Walking',
      safetyDose: 'N/A',
      strength: 'Standard',
      fit: 'Adjustable',
      size: 'Small',
      color: 'Red',
      count: null,
      reviewedTypeHash: 'type-v1',
      reviewedProductTypeId: 'collars-leashes',
    },
  };
  return { sku: base.sku, factors: { ...base.factors, ...overrides } };
}

describe('non-food family variant rules (issue #372)', () => {
  it('resolves configured canonical Product Type identities, refuses unknown types', () => {
    expect(resolveFamilyVariantRule('collars-leashes')?.version).toBe(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION);
    // Most-specific default: dog-waste-bags declares count through the triple, so the default is the triple; staged narrower rules still win via preferredVersion.
    expect(resolveFamilyVariantRule('dog-waste-bags')?.version).toBe(NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION);
    expect(resolveFamilyVariantRule('mystery-type')).toBeNull();
    expect(resolveFamilyVariantRule(null)).toBeNull();
  });

  it('accepts allowed size/color/count combos with unique labels in rule order', () => {
    const sizeOk = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: 'Small' }),
      nonFoodFactors('B', { size: 'Large' }),
    ]);
    expect(sizeOk.ok).toBe(true);
    const colorOk = evaluateNonFoodFamilyVariantRule(NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { reviewedProductTypeId: 'dog-toys' }),
      nonFoodFactors('B', { color: 'Blue', reviewedProductTypeId: 'dog-toys' }),
    ]);
    expect(colorOk.ok).toBe(true);
    const comboOk = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A'),
      nonFoodFactors('B', { size: 'Large', color: 'Blue' }),
    ]);
    expect(comboOk.ok).toBe(true);
    if (comboOk.ok) expect(comboOk.ruleVersion).toBe(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION);
    const names = deriveNonFoodPf7ShortNames(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'B', sizeRaw: 'Large', colorRaw: 'Blue' },
      { sku: 'A', sizeRaw: 'Small', colorRaw: 'Red' },
    ]);
    expect(names.map((n) => n.shortName)).toEqual(['Small / Red', 'Large / Blue']);
    expect(new Set(names.map((n) => n.shortName)).size).toBe(2);
    const countOk = evaluateNonFoodFamilyVariantRule(NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Trail Harness', material: 'Nylon', function: 'Walking',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Adjustable',
          size: 'Small', color: 'Red',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Trail Harness', material: 'Nylon', function: 'Walking',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Adjustable',
          size: 'Small', color: 'Red',
          count: { raw: '120 ct', quantity: 120 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 120 },
      },
    ]);
    expect(countOk.ok).toBe(true);
  });

  it('accepts size-absent members when the rule needs no size, keeps size required where needed', () => {
    const colorNoSize = evaluateNonFoodFamilyVariantRule(NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: null, reviewedProductTypeId: 'dog-toys' }),
      nonFoodFactors('B', { size: null, color: 'Blue', reviewedProductTypeId: 'dog-toys' }),
    ]);
    expect(colorNoSize.ok).toBe(true);
    const sizeNeedsSize = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: null }),
      nonFoodFactors('B', { size: 'Large' }),
    ]);
    expect(sizeNeedsSize.ok).toBe(false);
    expect(sizeNeedsSize.ok === false && sizeNeedsSize.code).toBe('family_rule_missing_variant');
    const names = deriveNonFoodPf7ShortNames(NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'B', sizeRaw: null, colorRaw: 'Blue' },
      { sku: 'A', sizeRaw: null, colorRaw: 'Red' },
    ]);
    expect(names.map((n) => n.shortName)).toEqual(['Red', 'Blue']);
  });

  it('accepts size/count, color/count, and triple combos with combo-rule preference', () => {
    const sizeCount = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Small', color: 'Blue',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Large', color: 'Blue',
          count: { raw: '120 ct', quantity: 120 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 120 },
      },
    ]);
    expect(sizeCount.ok).toBe(true);
    const colorCount = evaluateNonFoodFamilyVariantRule(NON_FOOD_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Small', color: 'Red',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Small', color: 'Blue',
          count: { raw: '120 ct', quantity: 120 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 120 },
      },
    ]);
    expect(colorCount.ok).toBe(true);
    const triple = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Small', color: 'Red',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: 'Large', color: 'Blue',
          count: { raw: '120 ct', quantity: 120 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: true, packCount: 120 },
      },
    ]);
    expect(triple.ok).toBe(true);
    // Combo-rule preference: a type declaring both size and size/color
    // resolves the most specific combination rule.
    expect(resolveFamilyVariantRule('collars-leashes')?.version).toBe(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION);
    const names = deriveNonFoodPf7ShortNames(NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'B', sizeRaw: 'Large', colorRaw: 'Blue', countRaw: '120 ct', countQuantity: 120 },
      { sku: 'A', sizeRaw: 'Small', colorRaw: 'Red', countRaw: '60 ct', countQuantity: 60 },
    ]);
    expect(names.map((n) => n.shortName)).toEqual(['Small / Red / 60 ct', 'Large / Blue / 120 ct']);
  });

  it('refuses inferred packs and undeclared retail units while declared packs pass', () => {
    const inferredPack = evaluateNonFoodFamilyVariantRule(NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: null, color: null,
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        // Inferred (declared false) with a quantity present — refuses.
        pack: { packCountDeclared: false, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Waste Bags', material: 'Plastic', function: 'Cleanup',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Tie',
          size: null, color: null,
          count: { raw: '120 ct', quantity: 120 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: false, packCount: 120 },
      },
    ]);
    expect(inferredPack.ok).toBe(false);
    expect(inferredPack.ok === false && inferredPack.code).toBe('family_rule_undeclared_pack');
  });

  it('refuses known-vs-unknown retail units and unit-converted duplicate tuples', () => {
    const mixedUnit = evaluateFamilyVariantRule([
      factors('A', { retailUnit: 'each' }),
      factors('B', { retailUnit: null }),
    ]);
    expect(mixedUnit.ok).toBe(false);
    expect(mixedUnit.ok === false && mixedUnit.code).toBe('family_rule_ambiguous_unit');
    // "80 oz" and "5 lb" are the same converted tuple — duplicates refuse.
    const converted = evaluateFamilyVariantRule([
      factors('A', { packageSize: { raw: '80 oz', ounces: 80 }, comparableOunces: 80 }),
      factors('B', { packageSize: { raw: '5 lb', ounces: 80 }, comparableOunces: 80 }),
    ]);
    expect(converted.ok).toBe(false);
    expect(converted.ok === false && converted.code).toBe('family_rule_duplicate_size');
  });

  it('refuses classifier family writes through variant IDs, case, and bindings', () => {
    expect(classifyClassifierFamilyWrite('PF7')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('productfield7')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('Child - Short Names')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('CHILD_SHORT_NAME')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('SUBPRODUCTS')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('sub-product')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('ProductField27')).toBeNull();
    expect(classifyClassifierFamilyWrite(null)).toBeNull();
  });

  it('refuses material/function/dose or undeclared-axis merges, duplicates, and unknown invariants', () => {
    const material = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: 'Small' }),
      nonFoodFactors('B', { size: 'Large', material: 'Leather' }),
    ]);
    expect(material.ok).toBe(false);
    expect(material.ok === false && material.code).toBe('family_rule_invariant_conflict');
    const undeclaredSize = evaluateNonFoodFamilyVariantRule(NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { reviewedProductTypeId: 'dog-toys' }),
      nonFoodFactors('B', { size: 'Large', color: 'Blue', reviewedProductTypeId: 'dog-toys' }),
    ]);
    expect(undeclaredSize.ok).toBe(false);
    expect(undeclaredSize.ok === false && undeclaredSize.code).toBe('family_rule_unsupported_axis');
    const unknownInvariant = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: 'Small', material: null }),
      nonFoodFactors('B', { size: 'Large' }),
    ]);
    expect(unknownInvariant.ok).toBe(false);
    expect(unknownInvariant.ok === false && unknownInvariant.code).toBe('family_rule_missing_invariant');
    const dupe = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: 'Small' }),
      nonFoodFactors('B', { size: 'Small' }),
    ]);
    expect(dupe.ok).toBe(false);
    expect(dupe.ok === false && dupe.code).toBe('family_rule_duplicate_variant');
    const wrongType = evaluateNonFoodFamilyVariantRule(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      nonFoodFactors('A', { size: 'Small' }),
      nonFoodFactors('B', { size: 'Large', reviewedProductTypeId: 'dog-toys' }),
    ]);
    expect(wrongType.ok).toBe(false);
    expect(wrongType.ok === false && wrongType.code).toBe('family_rule_type_not_applicable');
    const undeclaredPack = evaluateNonFoodFamilyVariantRule(NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION, [
      {
        sku: 'A',
        factors: {
          brand: 'Acme', model: 'Trail Harness', material: 'Nylon', function: 'Walking',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Adjustable',
          size: 'Small', color: 'Red',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: false, packCount: 60 },
      },
      {
        sku: 'B',
        factors: {
          brand: 'Acme', model: 'Trail Harness', material: 'Nylon', function: 'Walking',
          safetyDose: 'N/A', strength: 'Standard', fit: 'Adjustable',
          size: 'Small', color: 'Red',
          count: { raw: '60 ct', quantity: 60 },
          reviewedTypeHash: 'type-v1', reviewedProductTypeId: 'dog-waste-bags',
        },
        pack: { packCountDeclared: false, packCount: 60 },
      },
    ]);
    expect(undeclaredPack.ok).toBe(false);
    expect(undeclaredPack.ok === false && undeclaredPack.code).toBe('family_rule_undeclared_pack');
  });

  it('nominates comparable non-food mains and requires selection for color-only or incomparable', () => {
    expect(nominateNonFoodFamilyMain(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'A', comparableQuantity: 2 },
      { sku: 'B', comparableQuantity: 1 },
    ])).toEqual({ kind: 'nominated', sku: 'B', ounces: 1 });
    expect(nominateNonFoodFamilyMain(NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'A', comparableQuantity: null },
      { sku: 'B', comparableQuantity: null },
    ]).kind).toBe('selection_required');
    expect(nominateNonFoodFamilyMain(NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, [
      { sku: 'A', comparableQuantity: 2 },
      { sku: 'B', comparableQuantity: null },
    ]).kind).toBe('selection_required');
    expect(evaluateFamilyVariantRule([]).ok).toBe(false);
  });

  it('validates non-food groups through the shared mesh/PF7 contract', () => {
    // Block-on-main-only (#368 criterion 4): NF-A carries the single managed
    // block (full set, self-included exactly once); NF-B carries the
    // managed-main marker but no block of its own.
    const MAIN = 'NF-A';
    const product = (sku: string, pf7: string, size: string, color: string): Product => {
      const base = blankProduct(sku);
      const staged: Product = {
        ...base,
        customFields: { ...base.customFields, ProductField7: pf7 },
        shopsite: {
          ...base.shopsite,
          preserved: {
            ...base.shopsite.preserved,
            rawAttributes: {
              ...base.shopsite.preserved.rawAttributes,
              managedFamilyMain: MAIN,
              stagedFamilyRuleVersion: NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION,
              nonFoodProductTypeId: 'collars-leashes',
              nonFoodModel: 'Trail Harness',
              nonFoodMaterial: 'Nylon',
              nonFoodFunction: 'Walking',
              nonFoodSafetyDose: 'N/A',
              nonFoodStrength: 'Standard',
              nonFoodFit: 'Adjustable',
              nonFoodSizeRaw: size,
              nonFoodColorRaw: color,
            },
          },
        },
      };
      return sku === MAIN
        ? setManagedSubproducts(staged, 'plan-nf', [
          { sku: 'NF-A', name: 'NF-A' },
          { sku: 'NF-B', name: 'NF-B' },
        ])
        : staged;
    };
    const group = [product('NF-A', 'Small / Red', 'Small', 'Red'), product('NF-B', 'Large / Blue', 'Large', 'Blue')];
    expect(validateNonFoodFamilyGroup(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION, 'plan-nf', group, new Map()).filter((i) => i.severity === 'blocker')).toEqual([]);
    const conflictBase = product('NF-B', 'Large / Red', 'Large', 'Red');
    const conflicted: Product = {
      ...conflictBase,
      shopsite: {
        ...conflictBase.shopsite,
        preserved: {
          ...conflictBase.shopsite.preserved,
          rawAttributes: { ...conflictBase.shopsite.preserved.rawAttributes, nonFoodMaterial: 'Leather' },
        },
      },
    };
    expect(validateNonFoodFamilyGroup(NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION, 'plan-nf', [group[0]!, conflicted], new Map()).some((i) => i.code === 'FAMILY_INVARIANT_CONFLICT')).toBe(true);
    expect(validateNonFoodFamilyGroup('bogus-rule', 'plan-nf', group, new Map()).some((i) => i.code === 'FAMILY_RULE_UNKNOWN')).toBe(true);
  });
});

function blankProduct(sku: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `test-${sku}`,
    sku,
    status: 'draft',
    core: {
      name: `${sku} name`,
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: 3, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: '5 lb',
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {
      ProductField16: 'Acme',
      ProductField24: 'Chicken Dinner',
      ProductField23: 'Chicken',
      ProductField17: 'Dog',
      ProductField18: 'Adult',
      ProductField22: 'Dry Kibble',
    },
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: { reviewedTypeHash: 'reviewed-type-v1' } },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

describe('managed Subproducts emission (issue #368)', () => {
  it('emits one managed block with every member exactly once, main self-included', () => {
    const xml = buildManagedSubproductsXml([
      { sku: 'FAM-15', name: 'Fam 15' },
      { sku: 'FAM-5', name: 'Fam 5' },
    ]);
    expect(xml.match(/<Subproduct>/g)?.length).toBe(2);
    expect(xml.indexOf('FAM-15')).toBeGreaterThan(-1);
    const managed = setManagedSubproducts(blankProduct('FAM-5'), 'plan-1', [
      { sku: 'FAM-5', name: 'Fam 5' },
      { sku: 'FAM-15', name: 'Fam 15' },
    ]);
    const keys = Object.keys(managed.shopsite.preserved.advancedBlocks).filter((k) => k.toLowerCase() === 'subproducts');
    expect(keys).toEqual(['Subproducts']);
  });

  it('classifies unsupported nested blocks as refusal, absent as adoptable', () => {
    expect(classifySubproductsSupport(blankProduct('X')).code).toBe('supported_absent');
    const nested = blankProduct('Y');
    nested.shopsite.preserved.advancedBlocks['Subproducts'] = '<Subproducts><Subproducts><SKU>Z</SKU></Subproducts></Subproducts>';
    expect(classifySubproductsSupport(nested).code).toBe('unsupported_nested');
  });

  it('validates the whole managed group: membership, PF7, independence', () => {
    // Block-on-main-only (#368 criterion 4): the main (FAM-5) carries the
    // single managed block with the full member set self-included exactly
    // once; the non-main member carries the managed-main marker but no
    // block of its own — other cycles refuse.
    const stampMain = (p: import('../../shared/types').Product, main: string): import('../../shared/types').Product => ({
      ...p,
      shopsite: {
        ...p.shopsite,
        preserved: {
          ...p.shopsite.preserved,
          rawAttributes: { ...(p.shopsite.preserved.rawAttributes ?? {}), managedFamilyMain: main },
        },
      },
    });
    const a = stampMain(setManagedSubproducts(
      { ...blankProduct('FAM-5'), customFields: { ...blankProduct('FAM-5').customFields, ProductField7: 'Fam 5 lb' } },
      'plan-1',
      [{ sku: 'FAM-5', name: 'Fam 5' }, { sku: 'FAM-15', name: 'Fam 15' }],
    ), 'FAM-5');
    const b = stampMain(
      { ...blankProduct('FAM-15'), customFields: { ...blankProduct('FAM-15').customFields, ProductField7: 'Fam 15 lb' }, core: { ...blankProduct('FAM-15').core, weight: '15 lb' } },
      'FAM-5',
    );
    const ok = validateStorefrontFamilyGroup({ familyId: 'plan-1', members: [a, b], bases: new Map() });
    expect(ok.filter((i) => i.severity === 'blocker')).toEqual([]);
    const dupePf7 = validateStorefrontFamilyGroup({
      familyId: 'plan-1',
      members: [
        { ...b, customFields: { ...b.customFields, ProductField7: 'Fam 5 lb' } },
        a,
      ],
      bases: new Map(),
    });
    expect(dupePf7.some((i) => i.code === 'FAMILY_PF7_DUPLICATE')).toBe(true);
    const partial = validateStorefrontFamilyGroup({ familyId: 'plan-1', members: [a], bases: new Map() });
    expect(partial.some((i) => i.severity === 'blocker')).toBe(true);
    // N8: duplicate-SKU staging refuses at group validation (exact-set gate).
    const dupeSku = validateStorefrontFamilyGroup({ familyId: 'plan-1', members: [a, a], bases: new Map() });
    expect(dupeSku.some((i) => i.code === 'FAMILY_DUPLICATE_SKU')).toBe(true);
    // N5: bases thread through group validation — a base carrying staged
    // retail-unit evidence is read without throwing; the gate stays an array.
    const baseWithUnit = blankProduct('FAM-5');
    baseWithUnit.shopsite.preserved.rawAttributes = { ...baseWithUnit.shopsite.preserved.rawAttributes, retailUnit: 'case' };
    const withBases = validateStorefrontFamilyGroup({
      familyId: 'plan-1',
      members: [a, b],
      bases: new Map([['FAM-5', baseWithUnit], ['FAM-15', null]]),
    });
    expect(Array.isArray(withBases)).toBe(true);
  });
});
