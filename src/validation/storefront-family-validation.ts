import { createHash } from 'node:crypto';
import { hashCanonicalJson } from '../shared/stable-id';
import { z } from 'zod';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import { extractSubproductSkus, extractSubproductSkuOccurrences, hashNativeReferences } from '../shopsite/product-codec';
import { isManagedFamilyProduct, readManagedMembership } from '../shopsite/storefront-subproducts';
import {
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_FAMILY_LABEL_ORDER,
  NON_FOOD_FAMILY_PERMITTED_AXES,
  type FamilyVariantFactors,
  type FamilyVariantRuleVersion,
  type NonFoodFamilyVariantFactors,
} from '../classification/family-variant-rule';
import { FamilyMemberOriginSchema } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';

/**
 * Storefront-family validation (issue #368).
 *
 * Whole-group family blockers for change sets that carry an adopted family:
 * member completeness/consistency, rule acceptance, managed-Subproducts
 * single-block emission, PF7 uniqueness, independence of price/stock/images/
 * facts/enablement, and base/drift freshness. Pure over parsed drafts plus
 * read-only derived state; the change-set validator calls in and records
 * returned issues as blockers. Never throws for unresolvable members —
 * that is itself a blocker.
 */

export interface StorefrontFamilyIssue {
  severity: 'blocker' | 'warning';
  code: string;
  message: string;
  fieldPath: string | null;
  sku: string | null;
}

export interface StorefrontFamilyMemberEvidence {
  sku: string;
  base: Product | null;
  draft: Product | null;
  reviewedTypeHash: string | null;
  evidenceHash: string | null;
  comparableOunces: number | null;
  sizeRaw: string | null;
}

export const NonFoodFamilyStagingMemberSchema = z.object({
  sku: z.string().min(1),
  origin: FamilyMemberOriginSchema,
  purchasable: z.boolean(),
  /** Verified ounce-equivalent for sizeRaw (same parse path as food); null when unverified/incomparable. */
  ounces: z.number().positive().nullable().default(null),
  brand: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  material: z.string().nullable().default(null),
  function: z.string().nullable().default(null),
  safetyDose: z.string().nullable().default(null),
  strength: z.string().nullable().default(null),
  fit: z.string().nullable().default(null),
  sizeRaw: z.string().nullable().default(null),
  colorRaw: z.string().nullable().default(null),
  countRaw: z.string().nullable().default(null),
  countQuantity: z.number().int().positive().nullable().default(null),
  retailUnit: z.string().nullable().default(null),
  packCountDeclared: z.boolean().default(false),
  packCount: z.number().int().positive().nullable().default(null),
  reviewedTypeHash: z.string().min(1),
  reviewedProductTypeId: z.string().min(1),
  evidenceHash: z.string().min(1),
});
export type NonFoodFamilyStagingMember = z.infer<typeof NonFoodFamilyStagingMemberSchema>;

export const StorefrontFamilyStagingInputSchema = z.object({
  members: z.array(z.object({
    sku: z.string().min(1),
    origin: FamilyMemberOriginSchema,
    purchasable: z.boolean(),
    brand: z.string().nullable().default(null),
    recipe: z.string().nullable().default(null),
    flavor: z.string().nullable().default(null),
    species: z.string().nullable().default(null),
    lifeStage: z.string().nullable().default(null),
    form: z.string().nullable().default(null),
    sizeRaw: z.string().min(1),
    ounces: z.number().positive().nullable().default(null),
    retailUnit: z.string().nullable().default(null),
    packCountDeclared: z.boolean().default(false),
    packCount: z.number().int().positive().nullable().default(null),
    reviewedTypeHash: z.string().min(1),
    evidenceHash: z.string().min(1),
  })).min(2),
  mainSku: z.string().min(1).optional(),
});
export type StorefrontFamilyStagingInput = z.infer<typeof StorefrontFamilyStagingInputSchema>;

export const NonFoodFamilyStagingInputSchema = z.object({
  ruleVersion: z.union([
    z.literal('non-food-size-family-variant-rule-v1'),
    z.literal('non-food-color-family-variant-rule-v1'),
    z.literal('non-food-count-family-variant-rule-v1'),
    z.literal('non-food-size-color-family-variant-rule-v1'),
    z.literal('non-food-size-count-family-variant-rule-v1'),
    z.literal('non-food-color-count-family-variant-rule-v1'),
    z.literal('non-food-size-color-count-family-variant-rule-v1'),
  ]),
  members: z.array(NonFoodFamilyStagingMemberSchema).min(2),
  mainSku: z.string().min(1).optional(),
});
export type NonFoodFamilyStagingInput = z.infer<typeof NonFoodFamilyStagingInputSchema>;

function shaHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shortNameFor(sizeRaw: string, ounces: number | null): string {
  const size = sizeRaw.trim().replace(/\s+/g, ' ');
  return ounces != null ? `${size} (${ounces} oz)` : size;
}

/**
 * Derive deterministic unique PF7 Child-Short-Names from verified
 * quantities across the whole family (main included). Suffixes disambiguate
 * deterministically (`"5 lb"`, `"5 lb · 2"`) — never empty, never duplicated.
 */
export function derivePf7ShortNames(
  members: ReadonlyArray<{ sku: string; sizeRaw: string; ounces: number | null }>,
): Array<{ sku: string; shortName: string }> {
  const sorted = [...members].sort((a, b) => (a.sku < b.sku ? -1 : 1));
  // Case-insensitive dedupe parity with the group validator (which compares
  // PF7 lowercased): "5 lb" vs "5 LB" collide here, never slip through.
  const used: Record<string, true> = {};
  const out: Array<{ sku: string; shortName: string }> = [];
  for (const m of sorted) {
    const base = shortNameFor(m.sizeRaw, m.ounces);
    let candidate = base;
    let n = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = `${base} · ${n}`;
      n += 1;
    }
    used[candidate.toLowerCase()] = true;
    out.push({ sku: m.sku, shortName: candidate });
  }
  return out.sort((a, b) => (a.sku < b.sku ? -1 : 1));
}

function permittedAxisComponent(axis: 'size' | 'color' | 'count', member: { sizeRaw?: string | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null }): string | null {
  if (axis === 'size') {
    const v = (member.sizeRaw ?? '').trim().replace(/\s+/g, ' ');
    return v.length > 0 ? v : null;
  }
  if (axis === 'color') {
    const raw = (member.colorRaw ?? '').trim().replace(/\s+/g, ' ');
    return raw.length > 0 ? raw : null;
  }
  const raw = (member.countRaw ?? '').trim().replace(/\s+/g, ' ');
  return raw.length === 0 ? null : raw;
}

/**
 * Derive deterministic unique PF7 Child-Short-Names for a non-food family
 * from the verified permitted axes in the rule's label order (#372:
 * size/color combos render as `Small / Red`). Suffixes disambiguate
 * deterministically — never empty, never duplicated across the family.
 */
export function deriveNonFoodPf7ShortNames(
  ruleVersion: Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
  members: ReadonlyArray<{ sku: string; sizeRaw?: string | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null }>,
): Array<{ sku: string; shortName: string }> {
  const order = NON_FOOD_FAMILY_LABEL_ORDER[ruleVersion] ?? NON_FOOD_FAMILY_PERMITTED_AXES[ruleVersion] ?? [];
  const sorted = [...members].sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const used: Record<string, true> = {};
  const out: Array<{ sku: string; shortName: string }> = [];
  for (const m of sorted) {
    const parts: string[] = [];
    for (const axis of order) {
      const component = permittedAxisComponent(axis, m);
      if (component !== null) parts.push(component);
    }
    const base = parts.length > 0 ? parts.join(' / ') : m.sku;
    let candidate = base;
    let n = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = `${base} · ${n}`;
      n += 1;
    }
    used[candidate.toLowerCase()] = true;
    out.push({ sku: m.sku, shortName: candidate });
  }
  return out.sort((a, b) => (a.sku < b.sku ? -1 : 1));
}

/**
 * Validate staged drafts for one adopted family as a whole group. `bases`
 * are the live approved catalog products (null for genuinely new SKUs).
 * Routes by stamped rule: food plans evaluate the food rule; non-food
 * plans evaluate their approved non-food rule against SKU-local identity
 * factors threaded from the managed drafts (staged declarations) with
 * approved-base fallback. Curation Cohorts and native accessory groups are
 * never consulted — no migration, no reinterpretation.
 */
export function validateStorefrontFamilyGroup(input: {
  familyId: string;
  members: Product[];
  bases: Map<string, Product | null>;
}): StorefrontFamilyIssue[] {
  const ruleVersion = readStagedRuleVersion(input.members[0] ?? null);
  if (ruleVersion !== FOOD_FAMILY_VARIANT_RULE_VERSION) {
    return validateNonFoodFamilyGroup(ruleVersion, input.familyId, input.members, input.bases);
  }
  const issues: StorefrontFamilyIssue[] = [];
  const block = (code: string, message: string, sku: string | null = null, fieldPath: string | null = null): void => {
    issues.push({ severity: 'blocker', code, message, fieldPath, sku });
  };
  if (input.members.length < 2) {
    block('FAMILY_TOO_FEW_MEMBERS', `Family ${input.familyId} needs at least 2 distinct real size SKUs.`);
    return issues;
  }
  const skus = input.members.map((m) => m.sku);
  const skuSet = new Set(skus);
  if (skuSet.size !== skus.length) {
    block('FAMILY_DUPLICATE_SKU', `Family ${input.familyId} carries duplicate SKUs; each size SKU appears exactly once.`);
  }
  const factors: Array<{ sku: string; factors: FamilyVariantFactors; pack: { packCountDeclared: boolean; packCount: number | null } }> = input.members.map((m) => {
    // N5: thread the live approved base per member. The draft carries the
    // proposed retail unit; the base carries the approved truth — retail-unit
    // drift (base moved under the staged draft) is a rule input, not
    // invisible. N1: pack evidence threads the same way — the managed draft
    // stamps the staged declaration (raw attributes), falling back to the
    // base; absent on both means no pack evidence (never inferred).
    const base = input.bases.get(m.sku) ?? null;
    const retailUnit = readRetailUnit(m) ?? readRetailUnit(base);
    const pack = readPackEvidence(m) ?? readPackEvidence(base) ?? { packCountDeclared: false, packCount: null };
    return {
      sku: m.sku,
      factors: {
        brand: m.customFields['ProductField16'] ?? null,
        recipe: m.customFields['ProductField24'] ?? null,
        flavor: m.customFields['ProductField23'] ?? null,
        species: m.customFields['ProductField17'] ?? null,
        lifeStage: m.customFields['ProductField18'] ?? null,
        form: m.customFields['ProductField22'] ?? null,
        packageSize: m.core.weight ? { raw: m.core.weight, ounces: parseOunces(m.core.weight) } : null,
        retailUnit,
        comparableOunces: m.core.weight ? parseOunces(m.core.weight) : null,
        reviewedTypeHash: readReviewedTypeHash(m),
      },
      pack,
    };
  });
  const verdict = evaluateFamilyVariantRule(factors);

  if (!verdict.ok) {
    block(
      verdict.code === 'family_rule_invariant_conflict' ? 'FAMILY_INVARIANT_CONFLICT'
        : verdict.code === 'family_rule_duplicate_size' ? 'FAMILY_DUPLICATE_SIZE'
          : verdict.code === 'family_rule_type_authority_mismatch' || verdict.code === 'family_rule_type_authority_missing'
            ? 'FAMILY_TYPE_AUTHORITY_MISMATCH'
            : verdict.code === 'family_rule_undeclared_pack' ? 'FAMILY_UNDECLARED_PACK'
              : 'FAMILY_RULE_REFUSED',
      `Family ${input.familyId} refused by ${FOOD_FAMILY_VARIANT_RULE_VERSION}: ${verdict.reason}`,
      'sku' in verdict && verdict.sku ? verdict.sku : null,
    );
  }
  checkManagedMesh(input.familyId, input.members, issues);
  // Cycle hygiene beyond self-membership: any non-self cycle through family
  // members other than the uniform full-mesh is caught by the membership
  // check above, but a strict 2-cycle A↔B in a 2-member family would pass
  // the mesh check — and it IS the mesh. Only flag asymmetric references.
  return issues;
}

/**
 * Validate one adopted non-food family as a whole group (#372) under its
 * approved rule version. Unknown rule versions, undeclared types, and
 * undeclared-axis differences refuse closed; Curation Cohorts and native
 * accessory groups are never consulted.
 */
export function validateNonFoodFamilyGroup(
  ruleVersion: FamilyVariantRuleVersion | string | null,
  familyId: string,
  members: Product[],
  bases: Map<string, Product | null>,
): StorefrontFamilyIssue[] {
  const issues: StorefrontFamilyIssue[] = [];
  const block = (code: string, message: string, sku: string | null = null, fieldPath: string | null = null): void => {
    issues.push({ severity: 'blocker', code, message, fieldPath, sku });
  };
  if (members.length < 2) {
    block('FAMILY_TOO_FEW_MEMBERS', `Family ${familyId} needs at least 2 distinct real member SKUs.`);
    return issues;
  }
  const skus = members.map((m) => m.sku);
  const skuSet = new Set(skus);
  if (skuSet.size !== skus.length) {
    block('FAMILY_DUPLICATE_SKU', `Family ${familyId} carries duplicate SKUs; each member SKU appears exactly once.`);
  }
  if (ruleVersion === null || !(ruleVersion in NON_FOOD_FAMILY_PERMITTED_AXES)) {
    block(
      'FAMILY_RULE_UNKNOWN',
      `Family ${familyId} carries no approved non-food Family Variant Rule ("${String(ruleVersion)}"); undeclared rules never form families.`,
    );
    return issues;
  }
  const version = ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>;
  const factors: Array<{ sku: string; factors: NonFoodFamilyVariantFactors; pack: { packCountDeclared: boolean; packCount: number | null } }> = members.map((m) => {
    const base = bases.get(m.sku) ?? null;
    const staged = readNonFoodStaging(m) ?? readNonFoodStaging(base);
    const pack = readPackEvidence(m) ?? readPackEvidence(base) ?? { packCountDeclared: false, packCount: null };
    // Retail-unit evidence threads draft-first, base as fallback (#372):
    // undeclared differences refuse closed in the evaluator, never pass
    // silently as unknown-equal.
    const retailUnit = readRetailUnit(m) ?? readRetailUnit(base);
    return {
      sku: m.sku,
      factors: {
        brand: readBrand(m) ?? readBrand(base),
        model: staged?.model ?? null,
        material: staged?.material ?? null,
        function: staged?.function ?? null,
        safetyDose: staged?.safetyDose ?? null,
        strength: staged?.strength ?? null,
        fit: staged?.fit ?? null,
        size: staged?.sizeRaw ?? null,
        color: staged?.colorRaw ?? null,
        count: staged?.countRaw != null ? { raw: staged.countRaw, quantity: staged.countQuantity ?? null } : null,
        retailUnit,
        reviewedTypeHash: readReviewedTypeHash(m),
        reviewedProductTypeId: staged?.productTypeId ?? null,
      },
      pack,
    };
  });
  const verdict = evaluateNonFoodFamilyVariantRule(version, factors);
  if (!verdict.ok) {
    block(
      verdict.code === 'family_rule_invariant_conflict' || verdict.code === 'family_rule_missing_invariant' ? 'FAMILY_INVARIANT_CONFLICT'
        : verdict.code === 'family_rule_duplicate_variant' ? 'FAMILY_DUPLICATE_VARIANT'
          : verdict.code === 'family_rule_unsupported_axis' ? 'FAMILY_UNDECLARED_AXIS'
            : verdict.code === 'family_rule_type_not_applicable' ? 'FAMILY_RULE_NOT_APPLICABLE'
              : verdict.code === 'family_rule_type_authority_mismatch' || verdict.code === 'family_rule_type_authority_missing'
                ? 'FAMILY_TYPE_AUTHORITY_MISMATCH'
                : verdict.code === 'family_rule_undeclared_pack' ? 'FAMILY_UNDECLARED_PACK'
                  : 'FAMILY_RULE_REFUSED',
      `Family ${familyId} refused by ${version}: ${verdict.reason}`,
      'sku' in verdict && verdict.sku ? verdict.sku : null,
    );
  }
  checkManagedMesh(familyId, members, issues);
  return issues;
}

type MutableIssue = StorefrontFamilyIssue;

function checkManagedMesh(familyId: string, members: Product[], issues: MutableIssue[]): void {
  const skuSet = new Set(members.map((m) => m.sku));
  const block = (code: string, message: string, sku: string | null = null, fieldPath: string | null = null): void => {
    issues.push({ severity: 'blocker', code, message, fieldPath, sku });
  };
  // Main self-membership (#368 criterion 4): the main carries the single
  // managed block listing exactly the family member set (main self-included
  // exactly once); every other member carries NO managed Subproducts block
  // of its own (block-on-main-only emission). Any cycle beyond the main's
  // single block — a non-main member hosting member refs — refuses as a
  // conflicting cycle.
  const mainSku = readManagedMain(members[0]!);
  if (mainSku === null) {
    // No managed main stamped on the group: no member opted into the managed
    // relationship — the family has no emitted block at all. Fail closed
    // (a managed family without a main block is incomplete, never approved).
    block('FAMILY_MAIN_NOT_MEMBER', `Family "${familyId}" has no managed main; the main carries the single managed block self-included exactly once.`, null);
  } else if (!skuSet.has(mainSku)) {
    // Foreign main is reported below; skip per-member mesh checks so the
    // missing-main blocker stays singular.
  } else {
    const mainDraft = members.find((m) => m.sku === mainSku)!;
    // Multiplicity BEFORE dedupe: a double-listed SKU must refuse as a
    // duplicate — the deduped reader would otherwise hide it.
    const mainOccurrences = extractSubproductSkuOccurrences(mainDraft);
    if (new Set(mainOccurrences).size !== mainOccurrences.length) {
      block('FAMILY_MAIN_DUPLICATED', `Main "${mainSku}" lists a Subproduct SKU more than once; the main appears exactly once.`, mainSku, 'shopsite.preserved.advancedBlocks');
    }
    const mainRefs = extractSubproductSkus(mainDraft);
    const mainRefSet = new Set(mainRefs);
    if (mainRefSet.size !== skuSet.size || ![...skuSet].every((sv) => mainRefSet.has(sv))) {
      block(
        'FAMILY_MAIN_SELF_MEMBERSHIP',
        `Main "${mainSku}" managed Subproducts must reference exactly the family member set (${[...skuSet].sort().join(', ')}); got (${mainRefs.join(', ') || 'none'}).`,
        mainSku,
        'shopsite.preserved.advancedBlocks',
      );
    }
    if (!mainRefSet.has(mainSku)) {
      block('FAMILY_SELF_REFERENCE_MISSING', `Main "${mainSku}" must list itself as its own Subproduct so its size stays purchasable.`, mainSku, 'shopsite.preserved.advancedBlocks');
    }
    for (const m of members) {
      if (m.sku === mainSku) continue;
      const refs = extractSubproductSkus(m).filter((r) => skuSet.has(r));
      if (refs.length > 0) {
        block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${m.sku}" hosts family member refs (${refs.join(', ')}); only the main "${mainSku}" emits the managed block — other cycles refuse.`, m.sku, 'shopsite.preserved.advancedBlocks');
      }
    }
  }
  for (const m of members) {
    const refs = extractSubproductSkus(m);
    const otherFamilyRefs = refs.filter((r) => !skuSet.has(r));
    if (otherFamilyRefs.length > 0) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${m.sku}" references conflicting managed membership (${otherFamilyRefs.join(', ')}); one family per product.`, m.sku, 'shopsite.preserved.advancedBlocks');
    }
  }
  if (mainSku !== null && !skuSet.has(mainSku)) {
    block('FAMILY_MAIN_NOT_MEMBER', `Family main "${mainSku}" is not a real member SKU; the main is always a real member.`, mainSku);
  }
  // Emitted-membership consistency (#368): the encoder builds the exported
  // block from the managed markers, so the markers must name exactly the
  // accepted set (multiplicity-preserving — marker duplicates refuse here,
  // before the builder throws at export). One family per product: a marker
  // naming a foreign family id refuses as a conflicting membership.
  for (const m of members) {
    const managed = readManagedMembership(m);
    if (!managed) continue;
    if (managed.familyId !== familyId) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${m.sku}" already belongs to managed family "${managed.familyId}"; transitive merges are refused.`, m.sku);
      continue;
    }
    if (m.sku === mainSku) {
      if (new Set(managed.memberSkus).size !== managed.memberSkus.length) {
        const dupes = [...new Set(managed.memberSkus.filter((sku, i) => managed.memberSkus.indexOf(sku) !== i))].sort();
        block('FAMILY_MAIN_DUPLICATED', `Main "${m.sku}" managed markers list ${dupes.map((d) => `"${d}"`).join(', ')} more than once; each member appears exactly once.`, m.sku, 'shopsite.preserved.rawAttributes');
      }
      const markerSet = new Set(managed.memberSkus);
      if (markerSet.size !== skuSet.size || ![...skuSet].every((sv) => markerSet.has(sv))) {
        block(
          'FAMILY_MAIN_SELF_MEMBERSHIP',
          `Main "${m.sku}" managed markers must name exactly the family member set (${[...skuSet].sort().join(', ')}); got (${managed.memberSkus.join(', ') || 'none'}).`,
          m.sku,
          'shopsite.preserved.rawAttributes',
        );
      }
    } else if (managed.memberSkus.length > 0) {
      block('FAMILY_CONFLICTING_MEMBERSHIP', `SKU "${m.sku}" carries managed-family markers; only the main "${mainSku}" emits the managed block — other cycles refuse.`, m.sku, 'shopsite.preserved.rawAttributes');
    }
  }
  // No transitive merges: a member with its own managed markers for a
  // DIFFERENT family refuses in the emitted-membership loop above (foreign
  // id reported with the id); no second loop here, keeping the blocker
  // singular.
  // PF7: nonempty + unique across the whole family (main included).
  const pf7Seen: Record<string, string> = {};
  for (const m of members) {
    const pf7 = (m.customFields['ProductField7'] ?? '').trim();
    if (pf7.length === 0) {
      block('FAMILY_PF7_MISSING', `SKU "${m.sku}" needs a nonempty PF7 Child - Short Name.`, m.sku, 'customFields.ProductField7');
      continue;
    }
    const prior = pf7Seen[pf7.toLowerCase()];
    if (prior) {
      block('FAMILY_PF7_DUPLICATE', `PF7 Child - Short Name "${pf7}" is shared by "${prior}" and "${m.sku}"; names must be unique across the family.`, m.sku, 'customFields.ProductField7');
      continue;
    }
    pf7Seen[pf7.toLowerCase()] = m.sku;
  }
  // Cross-workspace / invalid references: every managed SKU ref must be a
  // same-workspace member of THIS group (the linked approval scope).
  for (const m of members) {
    for (const ref of extractSubproductSkus(m)) {
      if (!skuSet.has(ref)) {
        block('FAMILY_INVALID_REFERENCE', `SKU "${m.sku}" references "${ref}" outside the family group; invalid/cross-workspace references refuse adoption.`, m.sku, 'shopsite.preserved.advancedBlocks');
      }
    }
  }
}

/**
 * Classify a classifier-owned write attempt against family data (issue #368
 * §7): the classifier NEVER writes PF7/native Subproducts. Returns the
 * refusal code when the target is protected, else null.
 *
 * Closed normalization: casefold + strip every non-alphanumeric so variant
 * casings/spellings (`productfield7`, `PF7`, `Child - Short Name`,
 * `child_short_name`, `SUBPRODUCTS`, `sub-product`) cannot bypass the
 * refusal. Callers must check BOTH the semantic target id AND the resolved
 * catalog field (a binding can otherwise launder a family slot behind an
 * innocent attribute id).
 */
export function classifyClassifierFamilyWrite(targetId: string | null | undefined): { code: string; reason: string } | null {
  if (!targetId) return null;
  const t = String(targetId).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (t === 'productfield7' || t === 'pf7' || t === 'childshortname' || t === 'childshortnames') {
    return { code: 'protected_target_refused', reason: 'Classification cannot assign PF7 Child - Short Name: listing-owned family data, never a classifier output.' };
  }
  if (t === 'subproducts' || t === 'subproduct' || t === 'subproductsblock' || t === 'subproductblock') {
    return { code: 'protected_target_refused', reason: 'Classification cannot assign native Subproducts: storefront-family links are listing-owned, never classifier outputs.' };
  }
  return null;
}

/** Parse a weight string to ounces; null when unverified/incomparable. */
export function parseOunces(weight: string | null | undefined): number | null {
  if (weight == null) return null;
  const m = String(weight).trim().match(/^([\d.,]+)\s*(oz|ounces?|lb|lbs|pounds?|g|grams?|kg|kilograms?)\.?$/i);
  if (!m) return null;
  const value = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith('oz') || unit.startsWith('ounce')) return value;
  if (unit.startsWith('lb') || unit.startsWith('pound')) return value * 16;
  if (unit === 'g' || unit.startsWith('gram')) return value / 28.349523125;
  if (unit === 'kg' || unit.startsWith('kilo')) return (value * 1000) / 28.349523125;
  return null;
}

function readReviewedTypeHash(product: Product): string | null {
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const v = attrs['reviewedTypeHash'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Consistent Brand authority (#372): the live approved PF16 is the
 * authority the group validates (application checks it). Blank means
 * unknown (null) — never coerced to an empty invariant.
 */
function readBrand(product: Product | null): string | null {
  if (!product) return null;
  const raw = product.customFields['ProductField16'] ?? null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRetailUnit(product: Product | null): string | null {
  if (!product) return null;
  // Retail unit is a qualifying axis: read the preserved raw attribute when
  // present, else scan custom fields for an explicit retail-unit value
  // ("each"/"case"/"pack"-style). Absent means unknown (null) — never
  // inferred. (No dedicated PF slot is certified for retail unit, so the
  // raw attribute stamped by staging evidence is authoritative.)
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const raw = attrs['retailUnit'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  for (const value of Object.values(product.customFields)) {
    const v = value.trim().toLowerCase();
    if (v === 'each' || v === 'case' || v === 'pack') return value.trim();
  }
  return null;
}

function readPackEvidence(product: Product | null): { packCountDeclared: boolean; packCount: number | null } | null {
  if (!product) return null;
  // N1: pack evidence lives in the stamped raw attributes (see the plan
  // service writer). Absent on the product means no evidence — return null
  // so the caller falls back to the base, then to undeclared-absent.
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const hasDeclared = 'packCountDeclared' in attrs || 'packCount' in attrs;
  if (!hasDeclared) return null;
  const declaredRaw = attrs['packCountDeclared'];
  const declared = declaredRaw === 'true';
  const countRaw = attrs['packCount'];
  const count = typeof countRaw === 'number' && Number.isInteger(countRaw) && countRaw > 0
    ? countRaw
    : typeof countRaw === 'string' && /^\d+$/.test(countRaw.trim()) && Number(countRaw.trim()) > 0
      ? Number(countRaw.trim())
      : null;
  return { packCountDeclared: declared, packCount: count };
}

function readManagedMain(product: Product): string | null {

  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const v = attrs['managedFamilyMain'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
interface NonFoodStagingEvidence {
  productTypeId: string | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  sizeRaw: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
}

function textAttr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNonFoodStaging(product: Product | null): NonFoodStagingEvidence | null {
  if (!product) return null;
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const hasMarker = 'nonFoodModel' in attrs || 'nonFoodMaterial' in attrs || 'nonFoodProductTypeId' in attrs;
  if (!hasMarker) return null;
  const countRawAttr = attrs['nonFoodCountRaw'];
  const countQuantityAttr = attrs['nonFoodCountQuantity'];
  const countQuantity = typeof countQuantityAttr === 'number' && Number.isInteger(countQuantityAttr) && countQuantityAttr > 0
    ? countQuantityAttr
    : typeof countQuantityAttr === 'string' && /^\d+$/.test(countQuantityAttr.trim()) && Number(countQuantityAttr.trim()) > 0
      ? Number(countQuantityAttr.trim())
      : null;
  return {
    productTypeId: textAttr(attrs['nonFoodProductTypeId']),
    model: textAttr(attrs['nonFoodModel']),
    material: textAttr(attrs['nonFoodMaterial']),
    function: textAttr(attrs['nonFoodFunction']),
    safetyDose: textAttr(attrs['nonFoodSafetyDose']),
    strength: textAttr(attrs['nonFoodStrength']),
    fit: textAttr(attrs['nonFoodFit']),
    sizeRaw: textAttr(attrs['nonFoodSizeRaw']),
    colorRaw: textAttr(attrs['nonFoodColorRaw']),
    countRaw: typeof countRawAttr === 'string' ? textAttr(countRawAttr) : null,
    countQuantity,
  };
}

function readStagedRuleVersion(product: Product | null): FamilyVariantRuleVersion {
  if (!product) return FOOD_FAMILY_VARIANT_RULE_VERSION;
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const raw = attrs['stagedFamilyRuleVersion'];
  if (raw === 'non-food-size-family-variant-rule-v1'
    || raw === 'non-food-color-family-variant-rule-v1'
    || raw === 'non-food-count-family-variant-rule-v1'
    || raw === 'non-food-size-color-family-variant-rule-v1'
    || raw === 'non-food-size-count-family-variant-rule-v1'
    || raw === 'non-food-color-count-family-variant-rule-v1'
    || raw === 'non-food-size-color-count-family-variant-rule-v1') {
    return raw as FamilyVariantRuleVersion;
  }
  return FOOD_FAMILY_VARIANT_RULE_VERSION;
}

export function familyRuleHashFor(
  members: ReadonlyArray<{ sku: string; factors: FamilyVariantFactors; pack?: { packCountDeclared: boolean; packCount: number | null } }>,
  ruleVersion: FamilyVariantRuleVersion = FOOD_FAMILY_VARIANT_RULE_VERSION,
): string {
  return shaHex(JSON.stringify({ rule: ruleVersion, members }));
}

export function nonFoodFamilyRuleHashFor(
  ruleVersion: Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
  members: ReadonlyArray<{ sku: string; factors: NonFoodFamilyVariantFactors; pack?: { packCountDeclared: boolean; packCount: number | null } }>,
): string {
  return shaHex(JSON.stringify({ rule: ruleVersion, members }));
}

export function familyEvidenceHashFor(hashes: readonly string[]): string {
  return shaHex(JSON.stringify({ evidence: [...hashes].sort() }));
}

export function familyBaseHashFor(products: readonly Product[]): string {
  return shaHex(JSON.stringify(products.map((p) => comparisonHashForProduct(p)).sort()));
}

export function familyReadWriteHashFor(products: readonly Product[]): string {
  return hashCanonicalJson({
    members: [...products]
      .sort((a, b) => a.sku.localeCompare(b.sku))
      .map((product) => ({
        sku: product.sku,
        snapshot: product,
        nativeReferenceHash: hashNativeReferences(product),
      })),
  });
}
export { isManagedFamilyProduct };
export { readManagedMain };
