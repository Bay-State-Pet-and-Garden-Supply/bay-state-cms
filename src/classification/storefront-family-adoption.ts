import { randomUUID } from 'node:crypto';
import { GitClient } from '../git/git-client';
import { getDb } from '../db/connection';
import {
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  familyRuleConfigHashFor,
  type FamilyVariantRuleVersion,
} from './family-variant-rule';
import type { FamilyVariantFactors, NonFoodFamilyVariantFactors } from './family-variant-rule';
import {
  familyRuleHashFor,
  nonFoodFamilyRuleHashFor,
  familyEvidenceHashFor,
  familyBaseHashFor,
  familyReadWriteHashFor,
  derivePf7ShortNames,
  deriveNonFoodPf7ShortNames,
  validateStorefrontFamilyGroup,
  validateNonFoodFamilyGroup,
} from '../validation/storefront-family-validation';
import {
  createStorefrontFamilyPlan,
  findStorefrontFamilyPlanById,
  parseStorefrontFamilyPlan,
  updateStorefrontFamilyPlan,
  type StorefrontFamilyPlanRow,
} from '../db/repositories/storefront-family-plan-repo';
import {
  setManagedSubproducts,
  clearSubproductsBlock,
  classifySubproductsSupport,
  classifyNativeAdoption,
  nativeSkusInDocumentOrder,
  nativeStanzaMetadata,
  type NativeAdoptionSupport,
} from '../shopsite/storefront-subproducts';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import { createChangeSet, upsertChangeSetItem, listConflictingDraftChangeSets } from '../db/repositories/change-set-repo';
import { listOutstandingDriftForSku } from '../db/repositories/drift-repo';
import { readProductFile } from '../git/workspace-files';
import { hashJson, deterministicStringify } from '../git/deterministic-json';
import type { StorefrontFamilyPlan } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';

/**
 * Native adoption previews and membership revisions (issue #369).
 *
 * This module never edits the #368 new-family flow: staging, decisions,
 * freshness, and apply for new families stay untouched. Adoption reads the
 * live approved catalog's existing native relationship (main + members +
 * raw block), validates the group under the current approved Family Variant
 * Rule, and stages an adopted plan whose materialized drafts preserve the
 * existing main/IDs/URL/labels/order — every proposed replacement surfaces
 * as an explicit reviewed diff. Unsupported/ambiguous natives refuse with a
 * preservation reason instead of dropping data.
 *
 * Removal/dissolution is a second reviewed revision on the SAME plan id:
 * the plan's member list shrinks (or empties) while PF7 and unrelated
 * native children/accessories are preserved on every touched draft, and the
 * ShopSite clear emits an explicit empty `<Subproducts></Subproducts>`
 * block (verified wire semantics — omission never clears).
 */

export type NativeAdoptionKind =
  | 'adopt_family'
  | 'remove_members'
  | 'dissolve_family';

export interface NativeRelationshipPreview {
  mainSku: string;
  memberSkus: string[];
  /** Native document order of the member list (verbatim from the raw block). */
  order: string[];
  existingLabels: Array<{ sku: string; pf7: string }>;
  supportedMetadata: Array<{ sku: string; price: string | null; childName: string | null }>;
  invariantEvidence: Array<{ axis: string; value: string | null; agreed: boolean }>;
  rawBlock: string;
  readHash: string;
  baseHash: string;
}

export interface AdoptionPreview {
  relationship: NativeRelationshipPreview;
  support: NativeAdoptionSupport;
  pf7Disposition: Array<{ sku: string; existing: string; proposed: string; replaced: boolean }>;
  blockers: string[];
  ruleHash: string;
  evidenceHash: string;
  baseHash: string;
  readHash: string;
  writeHash: string;
}

function nowIso(): string {
  return new Date().toISOString();
}
/** Mirror validateStorefrontFamilyGroup's food code mapping so stage refuses with the validator's codes. */
function foodSubsetRefusalCode(code: string): string {
  if (code === 'family_rule_invariant_conflict') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_duplicate_size') return 'FAMILY_DUPLICATE_SIZE';
  if (code === 'family_rule_type_authority_mismatch' || code === 'family_rule_type_authority_missing') return 'FAMILY_TYPE_AUTHORITY_MISMATCH';
  if (code === 'family_rule_missing_invariant') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_ambiguous_unit') return 'FAMILY_RULE_REFUSED';
  if (code === 'family_rule_undeclared_pack') return 'FAMILY_UNDECLARED_PACK';
  if (code === 'family_rule_too_few_members') return 'FAMILY_TOO_FEW_MEMBERS';
  return 'FAMILY_RULE_REFUSED';
}

/** Mirror validateNonFoodFamilyGroup's code mapping so stage refuses with the validator's codes. */
function nonFoodSubsetRefusalCode(code: string): string {
  if (code === 'family_rule_invariant_conflict' || code === 'family_rule_missing_invariant') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_duplicate_variant') return 'FAMILY_DUPLICATE_VARIANT';
  if (code === 'family_rule_missing_variant') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_ambiguous_unit') return 'FAMILY_RULE_REFUSED';
  if (code === 'family_rule_unsupported_axis') return 'FAMILY_UNDECLARED_AXIS';
  if (code === 'family_rule_type_not_applicable') return 'FAMILY_RULE_NOT_APPLICABLE';
  if (code === 'family_rule_type_authority_mismatch' || code === 'family_rule_type_authority_missing') return 'FAMILY_TYPE_AUTHORITY_MISMATCH';
  if (code === 'family_rule_undeclared_pack') return 'FAMILY_UNDECLARED_PACK';
  if (code === 'family_rule_too_few_members') return 'FAMILY_TOO_FEW_MEMBERS';
  return 'FAMILY_RULE_REFUSED';
}


/**
 * Preview an existing native relationship without mutating anything.
 * Refuses with blockers (no plan staged) when the native posture is not
 * an adoptable family: accessories, cohorts, incomplete/ambiguous blocks,
 * or unsupported structures.
 */
export function previewNativeAdoption(input: {
  workspaceId: string;
  workspacePath: string;
  skus: string[];
  liveBySku: Map<string, Product | null>;
  evidenceBySku: Map<string, { reviewedTypeHash: string; evidenceHash: string }>;
  axisOf: (p: Product) => {
    brand: string | null; recipe: string | null; flavor: string | null;
    species: string | null; lifeStage: string | null; form: string | null;
    sizeRaw: string; ounces: number | null; retailUnit: string | null;
    packCountDeclared: boolean; packCount: number | null; purchasable: boolean;
  };
  /** Non-food axis evidence by SKU (route threads staged raw attributes); absent = food path. */
  nonFoodAxisOf?: (p: Product) => {
    model: string | null; material: string | null; function: string | null;
    safetyDose: string | null; strength: string | null; fit: string | null;
    sizeRaw: string | null; colorRaw: string | null; countRaw: string | null;
    countQuantity: number | null; reviewedProductTypeId: string | null;
  } | null;
  /** Rule override: when the reviewed type resolves a non-food rule, preview validates under it. */
  ruleVersion?: string | null;
}): AdoptionPreview {
  const present = input.skus.map((sku) => ({ sku, live: input.liveBySku.get(sku) ?? null }));
  const missing = present.filter((p) => !p.live).map((p) => p.sku);
  if (missing.length > 0) {
    return emptyPreview(`family_member_missing_base: no approved catalog entry for (${missing.join(', ')}); stage them in the group first.`);
  }
  const lives = present.map((p) => p.live!);
  const hosts = lives.filter((p) => {
    const blocks = p.shopsite?.preserved?.advancedBlocks ?? {};
    return Object.keys(blocks).some((k) => k.toLowerCase() === 'subproducts');
  });
  if (hosts.length !== 1) {
    return emptyPreview(
      hosts.length === 0
        ? 'family_native_no_host: none of the supplied SKUs carries a native Subproducts block; nothing to adopt (leave unmanaged).'
        : 'family_native_ambiguous_host: more than one member carries a native Subproducts block; refusing to guess which owns the relationship.',
    );
  }
  const host = hosts[0]!;
  const rawBlock = (() => {
    const blocks = host.shopsite.preserved.advancedBlocks;
    for (const k of Object.keys(blocks)) if (k.toLowerCase() === 'subproducts') return blocks[k];
    return '';
  })();
  const documentOrder = nativeSkusInDocumentOrder(rawBlock);
  const supplied = new Set(input.skus);
  const refSet = new Set(documentOrder);
  const support = classifyNativeAdoption(host, input.skus);
  const order = documentOrder.length > 0 ? documentOrder : [...input.skus].sort();
  const relationship: NativeRelationshipPreview = {
    mainSku: host.sku,
    memberSkus: documentOrder.length > 0 ? [...documentOrder] : [...input.skus].sort(),
    order,
    existingLabels: lives.map((p) => ({ sku: p.sku, pf7: (p.customFields['ProductField7'] ?? '').trim() })),
    supportedMetadata: lives.map((p) => {
      const stanza = nativeStanzaMetadata(rawBlock, p.sku);
      return { sku: p.sku, price: stanza?.price ?? null, childName: stanza?.childName ?? null };
    }),
    invariantEvidence: invariantRows(lives, input.axisOf),
    rawBlock,
    readHash: hashJson(lives.map((p) => comparisonHashForProduct(p)).sort()),
    baseHash: hashJson(lives.map((p) => comparisonHashForProduct(p)).sort()),
  };
  const blockers: string[] = [];
  for (const live of lives) {
    const axCheck = input.axisOf(live);
    if (!axCheck.purchasable) {
      blockers.push(`family_not_purchasable: SKU "${live.sku}" is not a real purchasable member SKU.`);
    }
  }
  if (support.code !== 'adoptable_family') {
    blockers.push(`family_native_refused: ${support.code}: ${support.detail} The native relationship stays preserved and unmanaged.`);
  }
  if (refSet.size !== supplied.size || ![...supplied].every((s) => refSet.has(s))) {
    if (documentOrder.length > 0) {
      blockers.push(
        `family_native_incomplete: native block references (${documentOrder.join(', ') || 'none'}) but the supplied group is (${input.skus.join(', ')}); adopt the complete group or leave it unmanaged.`,
      );
    }
  }
  if (documentOrder.length > 0 && !refSet.has(host.sku)) {
    blockers.push(`family_native_main_absent: host "${host.sku}" does not list itself; adoption preserves it only when the native main lists itself (main stays purchasable).`);
  }
  // Rule validation under the current approved rule — same evaluator as new families.
  // Non-food adoption (#369 decide-route): when the route binds a non-food
  // ruleVersion + per-SKU non-food axes, validate under the approved
  // non-food rule; otherwise the food path runs untouched.
  let ruleHash = '';
  try {
    const ruleVersion = input.ruleVersion ?? FOOD_FAMILY_VARIANT_RULE_VERSION;
    if (ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION) {
      const staged = input.skus.map((sku) => {
        const ax = input.axisOf(input.liveBySku.get(sku)!);
        return {
          sku,
          factors: {
            brand: ax.brand, recipe: ax.recipe, flavor: ax.flavor, species: ax.species,
            lifeStage: ax.lifeStage, form: ax.form,
            packageSize: { raw: ax.sizeRaw, ounces: ax.ounces },
            retailUnit: ax.retailUnit, comparableOunces: ax.ounces,
            reviewedTypeHash: input.evidenceBySku.get(sku)?.reviewedTypeHash ?? null,
          } satisfies FamilyVariantFactors,
          pack: { packCountDeclared: ax.packCountDeclared, packCount: ax.packCount },
        };
      });
      ruleHash = familyRuleHashFor(staged);
      const verdict = evaluateFamilyVariantRule(staged);
      if (!verdict.ok) blockers.push(`${verdict.code}: ${verdict.reason}`);
    } else {
      const staged = input.skus.map((sku) => {
        const live = input.liveBySku.get(sku)!;
        const ax = input.axisOf(live);
        const nf = input.nonFoodAxisOf?.(live) ?? null;
        return {
          sku,
          factors: {
            brand: ax.brand,
            model: nf?.model ?? null, material: nf?.material ?? null,
            function: nf?.function ?? null, safetyDose: nf?.safetyDose ?? null,
            strength: nf?.strength ?? null, fit: nf?.fit ?? null,
            size: nf?.sizeRaw ?? null, color: nf?.colorRaw ?? null,
            count: nf?.countRaw != null ? { raw: nf.countRaw, quantity: nf.countQuantity ?? null } : null,
            reviewedTypeHash: input.evidenceBySku.get(sku)?.reviewedTypeHash ?? null,
            reviewedProductTypeId: nf?.reviewedProductTypeId ?? null,
          } satisfies NonFoodFamilyVariantFactors,
          pack: { packCountDeclared: ax.packCountDeclared, packCount: ax.packCount },
        };
      });
      ruleHash = nonFoodFamilyRuleHashFor(ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, staged);
      const verdict = evaluateNonFoodFamilyVariantRule(ruleVersion as FamilyVariantRuleVersion, staged);
      if (!verdict.ok) blockers.push(`${verdict.code}: ${verdict.reason}`);
    }
  } catch (err) {
    blockers.push(`family_rule_unresolvable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const dispositionRuleVersion = input.ruleVersion ?? FOOD_FAMILY_VARIANT_RULE_VERSION;
  const isFoodPreview = dispositionRuleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
  const derivedPreviewBySku = new Map(
    (isFoodPreview
      ? derivePf7ShortNames(
          lives.map((q) => ({ sku: q.sku, sizeRaw: input.axisOf(q).sizeRaw, ounces: input.axisOf(q).ounces })),
        )
      : deriveNonFoodPf7ShortNames(
          dispositionRuleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
          lives.map((q) => {
            const nf = input.nonFoodAxisOf?.(q) ?? null;
            return { sku: q.sku, sizeRaw: nf?.sizeRaw ?? null, colorRaw: nf?.colorRaw ?? null, countRaw: nf?.countRaw ?? null, countQuantity: nf?.countQuantity ?? null };
          }),
        )
    ).map((d) => [d.sku, d.shortName] as const),
  );
  const pf7Disposition = lives.map((p) => {
    const existing = (p.customFields['ProductField7'] ?? '').trim();
    const fallback = derivedPreviewBySku.get(p.sku) ?? '';
    const nonempty = existing.length > 0;
    return { sku: p.sku, existing, proposed: nonempty ? existing : fallback, replaced: false };
  });
  const bases = lives;
  return {
    relationship,
    support,
    pf7Disposition,
    blockers,
    ruleHash,
    evidenceHash: familyEvidenceHashFor(input.skus.map((s) => input.evidenceBySku.get(s)?.evidenceHash ?? '')),
    baseHash: familyBaseHashFor(bases),
    readHash: familyReadWriteHashFor(bases).slice(0, 32),
    writeHash: familyReadWriteHashFor(bases),
  };
}

function emptyPreview(reason: string): AdoptionPreview {
  return {
    relationship: {
      mainSku: '', memberSkus: [], order: [], existingLabels: [],
      supportedMetadata: [], invariantEvidence: [], rawBlock: '', readHash: '', baseHash: '',
    },
    support: { code: 'refused_not_family', detail: reason } satisfies NativeAdoptionSupport,
    pf7Disposition: [],
    blockers: [`family_native_refused: ${reason} The native relationship stays preserved and unmanaged.`],
    ruleHash: '', evidenceHash: '', baseHash: '', readHash: '', writeHash: '',
  };
}

function rawOf(product: Product): string {
  const blocks = product.shopsite?.preserved?.advancedBlocks ?? {};
  for (const k of Object.keys(blocks)) if (k.toLowerCase() === 'subproducts') return blocks[k];
  return '';
}

function invariantRows(
  lives: Product[],
  axisOf: (p: Product) => { brand: string | null; recipe: string | null; flavor: string | null; species: string | null; lifeStage: string | null; form: string | null; [k: string]: unknown },
): Array<{ axis: string; value: string | null; agreed: boolean }> {
  const axes = ['brand', 'recipe', 'flavor', 'species', 'lifeStage', 'form'] as const;
  return axes.map((axis) => {
    const values = lives.map((p) => {
      const v = axisOf(p)[axis];
      return typeof v === 'string' && v.trim().length > 0 ? v.trim().toLowerCase() : null;
    });
    const first = values[0] ?? null;
    const agreed = first !== null && values.every((v) => v === first);
    return { axis, value: first, agreed };
  });
}

/** Evidence bundle for adoption staging — resolved server-side, never trusted from the client body. */
export interface AdoptionEvidence {
  base: Product | null;
  draftBase: Product;
  reviewedTypeHash: string;
  evidenceHash: string;
  axis: {
    brand: string | null; recipe: string | null; flavor: string | null;
    species: string | null; lifeStage: string | null; form: string | null;
    sizeRaw: string; ounces: number | null; retailUnit: string | null;
    packCountDeclared: boolean; packCount: number | null; purchasable: boolean;
  };
  /** Non-food axis evidence (route threads staged raw attributes); absent = food path. */
  nonFoodAxis?: {
    model: string | null; material: string | null; function: string | null;
    safetyDose: string | null; strength: string | null; fit: string | null;
    sizeRaw: string | null; colorRaw: string | null; countRaw: string | null;
    countQuantity: number | null; reviewedProductTypeId: string | null;
  } | null;
}

/**
 * Stage an adopted plan from a complete previewed native relationship.
 * The native main is preserved verbatim as plan main — never re-nominated.
 * Existing nonempty PF7 labels are preserved verbatim; only empty PF7s
 * receive deterministic proposals, exposed as reviewed diffs.
 */
export function stageNativeAdoption(input: {
  workspaceId: string;
  workspacePath: string;
  memberSkus: string[];
  actor: string;
  evidenceBySku: Map<string, AdoptionEvidence>;
  /** Approved rule override: non-food adoptions validate under their approved rule. */
  ruleVersion?: string | null;
}): { row: StorefrontFamilyPlanRow; plan: StorefrontFamilyPlan; blockers: string[] } {
  const skus = [...input.memberSkus].sort();
  if (skus.length < 2) throw new Error('family_rule_too_few_members: adoption needs at least 2 distinct real size SKUs.');
  if (new Set(skus).size !== skus.length) throw new Error('family_rule_duplicate_size: duplicate member SKUs refuse adoption.');
  for (const sku of skus) {
    const ev = input.evidenceBySku.get(sku);
    if (!ev) throw new Error(`family_member_unresolved: SKU "${sku}" has no current eligible adoption evidence.`);
    if (!ev.axis.purchasable) throw new Error(`family_not_purchasable: SKU "${sku}" is not a real purchasable size SKU.`);
    // Generic posture per member: every staged draft must be structurally
    // safe to overwrite with the managed mesh (unsupported nesting/
    // unparseable blocks refuse on every member, host or not).
    const generic = classifySubproductsSupport(ev.draftBase);
    if (generic.code !== 'supported_absent' && generic.code !== 'supported_unmanaged_simple' && generic.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${sku}" keeps its unsafe native Subproducts structure preserved and unadopted (${generic.code}: ${generic.detail})`);
    }
  }
  // Main = the existing native host (sole Subproducts carrier), preserved verbatim.
  const hosts = skus.filter((sku) => {
    const blocks = input.evidenceBySku.get(sku)!.draftBase.shopsite?.preserved?.advancedBlocks ?? {};
    return Object.keys(blocks).some((k) => k.toLowerCase() === 'subproducts');
  });
  if (hosts.length !== 1) {
    throw new Error(
      hosts.length === 0
        ? 'family_native_no_host: none of the supplied SKUs carries a native Subproducts block; nothing to adopt (leave unmanaged).'
        : 'family_native_ambiguous_host: more than one member carries a native Subproducts block; refusing to guess which owns the relationship.',
    );
  }
  const mainSku = hosts[0]!;
  // Native classification runs ONCE against the host — non-host members
  // carry no block by construction (the host is sole), so per-member native
  // checks would always refuse non-hosts with refused_not_family. The
  // complete-group membership check still binds every member here.
  const support = classifyNativeAdoption(input.evidenceBySku.get(mainSku)!.draftBase, skus);
  if (support.code !== 'adoptable_family') {
    throw new Error(`family_native_refused: ${support.code}: ${support.detail} The native relationship stays preserved and unmanaged.`);
  }
  const ruleVersion = input.ruleVersion ?? FOOD_FAMILY_VARIANT_RULE_VERSION;
  const isFoodAdoption = ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
  const foodFactors = isFoodAdoption ? skus.map((sku) => {
    const ev = input.evidenceBySku.get(sku)!;
    return {
      sku,
      factors: {
        brand: ev.axis.brand, recipe: ev.axis.recipe, flavor: ev.axis.flavor,
        species: ev.axis.species, lifeStage: ev.axis.lifeStage, form: ev.axis.form,
        packageSize: { raw: ev.axis.sizeRaw, ounces: ev.axis.ounces },
        retailUnit: ev.axis.retailUnit, comparableOunces: ev.axis.ounces,
        reviewedTypeHash: ev.reviewedTypeHash,
      } satisfies FamilyVariantFactors,
      pack: { packCountDeclared: ev.axis.packCountDeclared, packCount: ev.axis.packCount },
    };
  }) : [];
  const nonFoodFactors = !isFoodAdoption ? skus.map((sku) => {
    const ev = input.evidenceBySku.get(sku)!;
    const nf = ev.nonFoodAxis ?? null;
    return {
      sku,
      factors: {
        brand: ev.axis.brand,
        model: nf?.model ?? null, material: nf?.material ?? null,
        function: nf?.function ?? null, safetyDose: nf?.safetyDose ?? null,
        strength: nf?.strength ?? null, fit: nf?.fit ?? null,
        size: nf?.sizeRaw ?? null, color: nf?.colorRaw ?? null,
        count: nf?.countRaw != null ? { raw: nf.countRaw, quantity: nf.countQuantity ?? null } : null,
        reviewedTypeHash: ev.reviewedTypeHash,
        reviewedProductTypeId: nf?.reviewedProductTypeId ?? null,
      } satisfies NonFoodFamilyVariantFactors,
      pack: { packCountDeclared: ev.axis.packCountDeclared, packCount: ev.axis.packCount },
    };
  }) : [];
  if (isFoodAdoption) {
    const verdict = evaluateFamilyVariantRule(foodFactors);
    if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`);
  } else {
    const verdict = evaluateNonFoodFamilyVariantRule(ruleVersion as FamilyVariantRuleVersion, nonFoodFactors);
    if (!verdict.ok) throw new Error(`${nonFoodSubsetRefusalCode(verdict.code)}: ${verdict.reason}`);
  }
  // PF7: preserve existing nonempty labels verbatim; derive only for empties.
  // Non-food empties derive under the stamped rule's label order — never the food deriver.
  const derived = isFoodAdoption
    ? derivePf7ShortNames(skus.map((sku) => {
        const ev = input.evidenceBySku.get(sku)!;
        return { sku, sizeRaw: ev.axis.sizeRaw, ounces: ev.axis.ounces };
      }))
    : deriveNonFoodPf7ShortNames(
        ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
        skus.map((sku) => {
          const nf = input.evidenceBySku.get(sku)!.nonFoodAxis ?? null;
          return { sku, sizeRaw: nf?.sizeRaw ?? null, colorRaw: nf?.colorRaw ?? null, countRaw: nf?.countRaw ?? null, countQuantity: nf?.countQuantity ?? null };
        }),
      );
  const pf7Proposals = skus.map((sku) => {
    const existing = (input.evidenceBySku.get(sku)!.draftBase.customFields['ProductField7'] ?? '').trim();
    if (existing.length > 0) return { sku, shortName: existing, replaced: false };
    return { sku, shortName: derived.find((d) => d.sku === sku)!.shortName, replaced: false };
  });
  const drafts = skus.map((s) => input.evidenceBySku.get(s)!.draftBase);
  const bases = skus.map((s) => input.evidenceBySku.get(s)!.base).filter((b): b is Product => b !== null);
  const evidenceHashes = skus.map((s) => input.evidenceBySku.get(s)!.evidenceHash);
  const at = nowIso();
  const plan: StorefrontFamilyPlan = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    ruleVersion: ruleVersion as FamilyVariantRuleVersion,
    planVersion: 'storefront-family-plan-v1',
    status: 'proposed',
    revision: 0,
    memberSkus: skus,
    members: skus.map((sku) => {
      const ev = input.evidenceBySku.get(sku)!;
      const nf = !isFoodAdoption ? ev.nonFoodAxis ?? null : null;
      return {
        sku,
        comparableOunces: ev.axis.ounces,
        sizeRaw: ev.axis.sizeRaw,
        retailUnit: ev.axis.retailUnit,
        packCountDeclared: ev.axis.packCountDeclared,
        packCount: ev.axis.packCount,
        reviewedTypeHash: ev.reviewedTypeHash,
        evidenceHash: ev.evidenceHash,
        baseHash: ev.base ? comparisonHashForProduct(ev.base) : null,
        productTypeId: nf?.reviewedProductTypeId ?? null,
        model: nf?.model ?? null,
        material: nf?.material ?? null,
        function: nf?.function ?? null,
        safetyDose: nf?.safetyDose ?? null,
        strength: nf?.strength ?? null,
        fit: nf?.fit ?? null,
        colorRaw: nf?.colorRaw ?? null,
        countRaw: nf?.countRaw ?? null,
        countQuantity: nf?.countQuantity ?? null,
      };
    }),
    mainSku,
    mainOverridden: false,
    pf7Proposals,
    ruleHash: isFoodAdoption ? familyRuleHashFor(foodFactors) : nonFoodFamilyRuleHashFor(ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, nonFoodFactors),
    ruleConfigHash: familyRuleConfigHashFor(ruleVersion as FamilyVariantRuleVersion),
    evidenceHash: familyEvidenceHashFor(evidenceHashes),
    baseHash: familyBaseHashFor(bases),
    readHash: familyReadWriteHashFor(drafts).slice(0, 32),
    writeHash: familyReadWriteHashFor(drafts),
    linkedChangeSetId: null,
    decisions: [],
    createdAt: at,
    updatedAt: at,
  };
  plan.adoptionOrigin = {
    kind: 'adopt_family',
    nativeMain: mainSku,
    nativeOrder: nativeSkusInDocumentOrder(rawOf(input.evidenceBySku.get(mainSku)!.draftBase)),
  };
  const row = createStorefrontFamilyPlan({ workspaceId: input.workspaceId, plan });
  return { row, plan, blockers: [] };
}

/**
 * Stage an explicit membership removal/dissolution as a new reviewed
 * revision on the SAME plan id. The removed members keep their files,
 * PF7 labels, and unrelated relationships untouched — only the managed
 * Subproducts references change on the remaining members (or, for full
 * dissolution, every member regains an explicit empty clear block).
 */
export function stageMembershipChange(input: {
  planId: string;
  actor: string;
  removeSkus: string[];
  dissolve: boolean;
  liveBySku: Map<string, Product | null>;
}): { row: StorefrontFamilyPlanRow; plan: StorefrontFamilyPlan } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  // Guard the member-change path to adoption-origin plans only: a #368/#372
  // new-family plan given a membership revision would store membershipChange
  // but route at apply to the new-family materializer, which knows nothing
  // about removals. Refuse closed — stage an adopted plan first.
  if (!plan.adoptionOrigin) {
    throw new Error('family_membership_change_not_adopted: member-change revisions apply only to adopted native families; this plan has no adoption origin.');
  }
  if (plan.status === 'applied') {
    throw new Error('family_plan_applied: an applied plan is immutable; stage a new plan to change the family.');
  }
  if (plan.status === 'stale') {
    throw new Error('family_plan_stale: re-stage the family against current evidence before deciding.');
  }
  // Clean subset refusal: every removed SKU must be a current member. A
  // bogus removal is refused here as not_member — never staged as a ghost
  // revision, and never deferred to a post-removal group check downstream.
  const memberSet = new Set(plan.memberSkus);
  for (const sku of input.removeSkus) {
    if (!memberSet.has(sku)) {
      throw new Error(`family_removal_not_member: cannot remove "${sku}" — not a member of this family (${[...plan.memberSkus].sort().join(', ')}).`);
    }
  }
  const remaining = input.dissolve ? [] : plan.memberSkus.filter((s) => !input.removeSkus.includes(s));
  if (!input.dissolve && remaining.length < 2) {
    throw new Error('family_removal_too_few: removing these members would leave fewer than 2; dissolve the family instead (explicit reviewed dissolution).');
  }
  for (const sku of input.dissolve ? plan.memberSkus : [...input.removeSkus, ...remaining]) {
    const live = input.liveBySku.get(sku) ?? null;
    if (!live) throw new Error(`family_member_missing_base: no approved catalog entry for "${sku}"; re-stage before revising membership.`);
  }
  if (!input.dissolve && remaining.includes(plan.mainSku) === false) {
    throw new Error(`family_removal_main: cannot remove the main "${plan.mainSku}" while keeping the family; dissolve instead or choose an explicit reviewed main change.`);
  }
  // Post-removal subset rule-conformance at stage: the remaining set must
  // still satisfy the plan's Family Variant Rule as a same-family subset.
  // A rule-violating remainder refuses here — never staged as a revised
  // revision only to be refused later at apply/gate.
  if (!input.dissolve) {
    if (plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION) {
      const staged = remaining.map((sku) => {
        const member = plan.members.find((m) => m.sku === sku);
        const live = input.liveBySku.get(sku)!;
        return {
          sku,
          factors: {
            brand: live.customFields['ProductField16'] ?? null,
            recipe: live.customFields['ProductField24'] ?? null,
            flavor: live.customFields['ProductField23'] ?? null,
            species: live.customFields['ProductField17'] ?? null,
            lifeStage: live.customFields['ProductField18'] ?? null,
            form: live.customFields['ProductField22'] ?? null,
            packageSize: member?.sizeRaw ? { raw: member.sizeRaw, ounces: member.comparableOunces } : null,
            retailUnit: member?.retailUnit ?? null,
            comparableOunces: member?.comparableOunces ?? null,
            reviewedTypeHash: member?.reviewedTypeHash ?? null,
          } satisfies FamilyVariantFactors,
          pack: { packCountDeclared: member?.packCountDeclared ?? false, packCount: member?.packCount ?? null },
        };
      });
      const verdict = evaluateFamilyVariantRule(staged);
      if (!verdict.ok) throw new Error(`${foodSubsetRefusalCode(verdict.code)}: ${verdict.reason}`);
    } else {
      const staged = remaining.map((sku) => {
        const member = plan.members.find((m) => m.sku === sku);
        const live = input.liveBySku.get(sku)!;
        return {
          sku,
          factors: {
            brand: live.customFields['ProductField16'] ?? null,
            model: member?.model ?? null,
            material: member?.material ?? null,
            function: member?.function ?? null,
            safetyDose: member?.safetyDose ?? null,
            strength: member?.strength ?? null,
            fit: member?.fit ?? null,
            size: member?.sizeRaw ?? null,
            color: member?.colorRaw ?? null,
            count: member?.countRaw != null ? { raw: member.countRaw, quantity: member.countQuantity ?? null } : null,
            reviewedTypeHash: member?.reviewedTypeHash ?? null,
            reviewedProductTypeId: member?.productTypeId ?? null,
          } satisfies NonFoodFamilyVariantFactors,
          pack: { packCountDeclared: member?.packCountDeclared ?? false, packCount: member?.packCount ?? null },
        };
      });
      const verdict = evaluateNonFoodFamilyVariantRule(plan.ruleVersion, staged);
      if (!verdict.ok) throw new Error(`${nonFoodSubsetRefusalCode(verdict.code)}: ${verdict.reason}`);
    }
  }
  // Removed-member snapshots are RETAINED on the plan (members +
  // pf7Proposals keep the complete touched set): decide/apply recheck every
  // touched SKU's freshness, and removed/dissolved members keep PF7
  // comparison authority (verbatim equality). Only memberSkus narrows to
  // the remaining family; the membershipChange marker names removed set.
  const at = nowIso();
  const next: StorefrontFamilyPlan = {
    ...plan,
    status: 'revised',
    revision: plan.revision + 1,
    memberSkus: remaining.length > 0 ? [...remaining].sort() : plan.memberSkus,
    members: plan.members,
    pf7Proposals: plan.pf7Proposals,
    updatedAt: at,
    decisions: [
      ...plan.decisions,
      {
        actor: input.actor,
        action: 'revise',
        at,
        note: input.dissolve
          ? `dissolve family: explicit reviewed dissolution of ${plan.memberSkus.length} members (PF7 preserved; managed blocks cleared explicitly)`
          : `remove members (${input.removeSkus.join(', ')}); remaining: ${remaining.join(', ')} (removed PF7 preserved; unrelated relationships untouched)`,
        mainOverrideSku: null,
      },
    ],
  };
  next.membershipChange = {
    kind: input.dissolve ? 'dissolve_family' : 'remove_members',
    removedSkus: input.dissolve ? [...plan.memberSkus].sort() : [...input.removeSkus].sort(),
    remainingSkus: [...remaining].sort(),
    at,
    actor: input.actor,
  };
  const updated = updateStorefrontFamilyPlan({ id: plan.id, plan: next, status: 'revised', revision: next.revision });
  return { row: updated, plan: next };
}

/**
 * Materialize an ACCEPTED adopted plan into managed native drafts.
 * Every member keeps full SKU-local independence: only Subproducts + PF7
 * change (PF7 existing-nonempty preserved verbatim); names/SKU/prices/
 * stock/images/facts/classifications/filenames/enablement come from the
 * staged draft bases untouched. Removed-member and dissolution revisions
 * flow through the same accepted-plan gate with explicit clear semantics.
 */
export function applyAdoptedFamilyPlan(input: {
  planId: string;
  workspaceId: string;
  workspacePath: string;
  draftsBySku: Map<string, Product>;
  actor: string;
  /** Purchasable re-check (#368). */
  purchasableBySku?: Map<string, boolean>;
}): { changeSetId: string; plan: StorefrontFamilyPlan } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  if (plan.status !== 'accepted') {
    throw new Error(`family_plan_not_accepted: plan is "${plan.status}"; accept (or re-accept after revise) before applying.`);
  }
  // Approved configuration gate (shared with #368/#372 new-family and #370
  // join applies): a plan staged under a superseded rule configuration
  // never materializes — re-stage onto the current configuration first.
  if ((plan.ruleConfigHash ?? '') !== familyRuleConfigHashFor(plan.ruleVersion)) {
    throw new Error(`family_apply_stale: approved rule configuration changed after staging (expected "${familyRuleConfigHashFor(plan.ruleVersion)}"); re-stage before applying.`);
  }
  const change = plan.membershipChange ?? undefined;
  const isRemoval = change?.kind === 'remove_members';
  const isDissolution = change?.kind === 'dissolve_family';
  const effectiveMembers = isDissolution ? plan.memberSkus : (isRemoval ? (change?.remainingSkus ?? plan.memberSkus) : plan.memberSkus);
  // Native document order from the adoption origin drives the managed
  // mesh: the managed block preserves the store's native ordering instead
  // of re-sorting to SKU order. Post-removal, the remaining members keep
  // their relative native order.
  const nativeOrder = plan.adoptionOrigin?.nativeOrder ?? [...effectiveMembers].sort();
  const orderedMembers = [...effectiveMembers].sort((a, b) => {
    const ai = nativeOrder.indexOf(a);
    const bi = nativeOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a < b ? -1 : a > b ? 1 : 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  for (const sku of isDissolution ? plan.memberSkus : effectiveMembers) {
    if (input.purchasableBySku?.get(sku) === false) {
      throw new Error(`family_not_purchasable: SKU "${sku}" is not a real purchasable size SKU at apply time.`);
    }
    if (input.purchasableBySku && !input.purchasableBySku.has(sku)) {
      throw new Error(`family_not_purchasable: SKU "${sku}" is not currently purchasable (or has no current purchasability authority); refusing apply.`);
    }
    if (!input.draftsBySku.has(sku)) {
      throw new Error(`family_member_missing_draft: SKU "${sku}" has no staged draft; accepting requires the complete validated set.`);
    }
    const support = classifySubproductsSupport(input.draftsBySku.get(sku)!);
    if (support.code !== 'supported_absent' && support.code !== 'supported_unmanaged_simple' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${sku}" keeps its unsafe native Subproducts structure preserved and unadopted (${support.code}: ${support.detail})`);
    }
  }
  // Resolve the host raw block (source of verbatim Price/Name stanzas) and
  // every member's real title from the staged drafts before materializing.
  const hostRaw = rawOf(input.draftsBySku.get(plan.adoptionOrigin?.nativeMain ?? plan.mainSku) ?? input.draftsBySku.get(plan.mainSku) ?? input.draftsBySku.get(effectiveMembers[0]!)!);
  const nameBySku = new Map<string, string>();
  for (const sku of effectiveMembers) {
    nameBySku.set(sku, input.draftsBySku.get(sku)?.core.name ?? sku);
  }
  // Freshness-gated apply (#370): stale bases, competing drafts, and open
  // drift refuse before any write. Removal revisions scope to the touched
  // set (remaining + removed — removed-member drift blocks too);
  // dissolution scopes to the full member list.
  {
    const gateSkus = isDissolution ? plan.memberSkus : [...new Set([...effectiveMembers, ...(change?.removedSkus ?? [])])];
    // Non-food adopted plans route validation by stamped rule below; the
    // freshness gate itself is rule-agnostic (bases/drafts/drift only).
    for (const sku of gateSkus) {
      // Removed-member snapshots are retained on the plan, so every
      // touched SKU has staged comparison authority — a removed member
      // that changed after staging invalidates acceptance the same way.
      const staged = plan.members.find((mm) => mm.sku === sku);
      if (staged === undefined) {
        throw new Error(`family_apply_stale: SKU "${sku}" has no staged snapshot; re-stage before applying.`);
      }
      let liveBaseHash: string | null;
      try {
        const live = readProductFile(input.workspacePath, sku);
        liveBaseHash = live ? comparisonHashForProduct(live) : null;
      } catch (err) {
        throw new Error(`family_apply_stale: base for SKU "${sku}" unreadable after staging (${err instanceof Error ? err.message : String(err)}); re-stage before applying.`, { cause: err });
      }
      if (liveBaseHash !== staged.baseHash) {
        throw new Error(`family_apply_stale: SKU "${sku}" base changed after staging; re-stage before applying.`);
      }
      let conflicts: Array<{ changeSetId: string; sku: string; status: string }>;
      try {
        conflicts = listConflictingDraftChangeSets(input.workspaceId, [sku], plan.linkedChangeSetId ?? '');
      } catch (err) {
        throw new Error(`family_apply_conflict_check_failed: conflicting-draft check for "${sku}" could not complete: ${err instanceof Error ? err.message : String(err)}.`, { cause: err });
      }
      if (conflicts.length > 0) {
        throw new Error(`family_apply_conflict: SKU "${sku}" is also staged in change set ${conflicts[0]!.changeSetId.slice(0, 8)} (status "${conflicts[0]!.status}"); resolve the competing draft before applying.`);
      }
      try {
        if (listOutstandingDriftForSku(input.workspaceId, sku).length > 0) {
          throw new Error(`family_apply_drift: SKU "${sku}" carries open/reconciling drift; resolve drift before applying.`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('family_apply_drift:')) throw err;
        throw new Error(`family_apply_drift_check_failed: drift check for "${sku}" could not complete: ${err instanceof Error ? err.message : String(err)}.`, { cause: err });
      }
    }
  }
  // PF7 verbatim equality at apply (#369): a touched draft must carry
  // either the accepted proposal (already-materialized shape — empty-PF7
  // adoptions stage a proposal the input draft never had) or its untouched
  // original label (live base PF7, pinned by the freshness gate above).
  // Any other value is an unreviewed rewrite and refuses. Removed members
  // preserve verbatim under the same rule.
  for (const sku of isDissolution ? plan.memberSkus : [...new Set([...effectiveMembers, ...(change?.removedSkus ?? [])])]) {
    const proposal = plan.pf7Proposals.find((pp) => pp.sku === sku)?.shortName ?? null;
    if (proposal === null) {
      throw new Error(`family_pf7_missing: no PF7 proposal for SKU "${sku}".`);
    }
    const draftPf7 = (input.draftsBySku.get(sku)?.customFields['ProductField7'] ?? '').trim();
    const originalPf7 = (readProductFile(input.workspacePath, sku)?.customFields['ProductField7'] ?? '').trim();
    if (draftPf7 !== proposal && draftPf7 !== originalPf7) {
      throw new Error(`family_apply_pf7_mismatch: SKU "${sku}" draft PF7 does not match the accepted proposal; unreviewed payload rewrites refuse apply.`);
    }
  }
  // Route by stamped rule (#369): non-food adopted plans validate under
  // their approved non-food rule; food plans use the food group check.
  const issues = isDissolution
    ? []
    : plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION
      ? validateStorefrontFamilyGroup({
          familyId: plan.id,
          members: orderedMembers.map((sku) => withAdoptedFamilyDraft(input.draftsBySku.get(sku)!, plan, orderedMembers, hostRaw, nameBySku)),
          bases: new Map(effectiveMembers.map((sku) => [sku, readProductFile(input.workspacePath, sku)])),
        })
      : validateNonFoodFamilyGroup(
          plan.ruleVersion,
          plan.id,
          orderedMembers.map((sku) => withAdoptedFamilyDraft(input.draftsBySku.get(sku)!, plan, orderedMembers, hostRaw, nameBySku)),
          new Map(effectiveMembers.map((sku) => [sku, readProductFile(input.workspacePath, sku)])),
        );
  const blockers = issues.filter((i) => i.severity === 'blocker');
  if (blockers.length > 0) {
    throw new Error(`family_group_blocked: ${blockers.map((b) => `[${b.code}] ${b.message}`).slice(0, 5).join('; ')}`);
  }
  const db = getDb();
  const staged = db.transaction(() => {
    const changeSet = createChangeSet({
      workspaceId: input.workspaceId,
      title: isDissolution
        ? `Dissolve storefront family ${plan.id.slice(0, 8)} (${plan.memberSkus.length} members)`
        : isRemoval
          ? `Storefront family ${plan.id.slice(0, 8)} membership removal (${effectiveMembers.length} remain)`
          : `Adopt storefront family ${plan.id.slice(0, 8)} (${effectiveMembers.length} sizes, main ${plan.mainSku})`,
      description: isDissolution
        ? `Explicit reviewed dissolution of adopted family under ${plan.ruleVersion}; PF7 preserved, managed blocks cleared explicitly.`
        : isRemoval
          ? `Explicit reviewed membership removal under ${plan.ruleVersion}; removed PF7 preserved, unrelated relationships untouched.`
          : `Adopted native family under ${plan.ruleVersion}; existing main ${plan.mainSku} preserved.`,
      baseCommit: readHeadCommit(input.workspacePath),
    });
    const touched = isDissolution ? plan.memberSkus : isRemoval ? [...orderedMembers, ...(change?.removedSkus ?? [])] : orderedMembers;
    for (const sku of touched) {
      const base = readProductFile(input.workspacePath, sku);
      const managed = isDissolution || (isRemoval && !(change?.remainingSkus ?? []).includes(sku))
        ? withDissolvedDraft(input.draftsBySku.get(sku)!)
        : withAdoptedFamilyDraft(input.draftsBySku.get(sku)!, plan, orderedMembers, hostRaw, nameBySku);
      upsertChangeSetItem({
        changeSetId: changeSet.id,
        sku,
        operation: base ? 'update' : 'create',
        draftJson: deterministicStringify(managed),
        baseJson: base ? deterministicStringify(base) : null,
        draftHash: hashJson(managed),
        classificationRunId: null,
      });
    }
    return changeSet;
  })();
  const next: StorefrontFamilyPlan = {
    ...plan,
    status: 'applied',
    linkedChangeSetId: staged.id,
    updatedAt: nowIso(),
  };
  updateStorefrontFamilyPlan({ id: plan.id, plan: next, status: 'applied', revision: plan.revision, linkedChangeSetId: staged.id });
  return { changeSetId: staged.id, plan: next };
}

function withAdoptedFamilyDraft(
  draft: Product,
  plan: StorefrontFamilyPlan,
  memberSkus: string[],
  hostRaw = '',
  nameBySku: Map<string, string> | null = null,
): Product {
  const pf7 = plan.pf7Proposals.find((p) => p.sku === draft.sku)?.shortName;
  if (!pf7) throw new Error(`family_pf7_missing: no PF7 proposal for SKU "${draft.sku}".`);
  const staged = plan.members.find((m) => m.sku === draft.sku);
  const retailUnit = readStagingRetailUnit(draft) ?? staged?.retailUnit ?? null;
  const withPf7: Product = {
    ...draft,
    customFields: { ...draft.customFields, ProductField7: pf7 },
    shopsite: {
      ...draft.shopsite,
      preserved: {
        ...draft.shopsite.preserved,
        rawAttributes: {
          ...(draft.shopsite.preserved.rawAttributes ?? {}),
          reviewedTypeHash: staged?.reviewedTypeHash ?? '',
          managedFamilyMain: plan.mainSku,
          stagedFamilyRuleVersion: plan.ruleVersion,
          ...(retailUnit ? { retailUnit } : {}),
          ...(staged?.packCountDeclared ? { packCountDeclared: 'true' } : {}),
          ...(staged?.packCount != null ? { packCount: String(staged.packCount) } : {}),
          ...(staged?.productTypeId ? { nonFoodProductTypeId: staged.productTypeId } : {}),
          ...(staged?.model ? { nonFoodModel: staged.model } : {}),
          ...(staged?.material ? { nonFoodMaterial: staged.material } : {}),
          ...(staged?.function ? { nonFoodFunction: staged.function } : {}),
          ...(staged?.safetyDose ? { nonFoodSafetyDose: staged.safetyDose } : {}),
          ...(staged?.strength ? { nonFoodStrength: staged.strength } : {}),
          ...(staged?.fit ? { nonFoodFit: staged.fit } : {}),
          ...(staged?.sizeRaw ? { nonFoodSizeRaw: staged.sizeRaw } : {}),
          ...(staged?.colorRaw ? { nonFoodColorRaw: staged.colorRaw } : {}),
          ...(staged?.countRaw ? { nonFoodCountRaw: staged.countRaw } : {}),
          ...(staged?.countQuantity != null ? { nonFoodCountQuantity: String(staged.countQuantity) } : {}),
        },
      },
    },
  };
  // Supported child metadata verbatim: each member's native stanza (Price +
  // child Name) rides the managed block in native document order. Members
  // keep their own real titles; the classifier refuses any stanza child
  // outside this contract at stage, so nothing here can silently drop.
  // Block-on-main-only emission: only the main emits the managed block;
  // non-main members keep their SKU-local native posture (no mesh, no
  // other cycles).
  if (draft.sku !== plan.mainSku) return withPf7;
  const memberNames = memberSkus.map((sku) => {
    const stanza = hostRaw ? nativeStanzaMetadata(hostRaw, sku) : null;
    return {
      sku,
      name: nameBySku?.get(sku) ?? (sku === draft.sku ? draft.core.name : sku),
      price: stanza?.price ?? null,
      childName: stanza?.childName ?? null,
    };
  });
  return setManagedSubproducts(withPf7, plan.id, memberNames);
}

function withDissolvedDraft(draft: Product): Product {
  return clearSubproductsBlock(draft);
}

function readStagingRetailUnit(draft: Product): string | null {
  const attrs = draft.shopsite.preserved.rawAttributes ?? {};
  const raw = attrs['retailUnit'];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  for (const value of Object.values(draft.customFields)) {
    const v = value.trim().toLowerCase();
    if (v === 'each' || v === 'case' || v === 'pack') return value.trim();
  }
  return null;
}

function readHeadCommit(workspacePath: string): string {
  try {
    const git = new GitClient(workspacePath);
    return git.getHeadHash() || 'family-plan';
  } catch {
    return 'family-plan';
  }
}

export type { StorefrontFamilyPlan };
