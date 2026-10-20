import { randomUUID } from 'node:crypto';
import { GitClient } from '../git/git-client';
import { getDb } from '../db/connection';
import {
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  nominateFamilyMain,
  nominateNonFoodFamilyMain,
  familyRuleConfigHashFor,
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_FAMILY_RULE_PRODUCT_TYPES,
  type FamilyVariantFactors,
  type FamilyVariantRuleVersion,
  type NonFoodFamilyVariantFactors,
} from './family-variant-rule';
import {
  familyRuleHashFor,
  nonFoodFamilyRuleHashFor,
  familyEvidenceHashFor,
  familyBaseHashFor,
  familyReadWriteHashFor,
  derivePf7ShortNames,
  deriveNonFoodPf7ShortNames,
  validateStorefrontFamilyGroup,
  type StorefrontFamilyStagingInput,
  type NonFoodFamilyStagingInput,
} from '../validation/storefront-family-validation';
import {
  createStorefrontFamilyPlan,
  findStorefrontFamilyPlanById,
  parseStorefrontFamilyPlan,
  updateStorefrontFamilyPlan,
  type StorefrontFamilyPlanRow,
} from '../db/repositories/storefront-family-plan-repo';
import { setManagedSubproducts, classifySubproductsSupport, extractSubproductSkus, readManagedMembership } from '../shopsite/storefront-subproducts';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import {
  createChangeSet,
  upsertChangeSetItem,
  listConflictingDraftChangeSets,
} from '../db/repositories/change-set-repo';
import { listOutstandingDriftForSku } from '../db/repositories/drift-repo';
import { readProductFile } from '../git/workspace-files';
import { hashJson } from '../git/deterministic-json';
import { deterministicStringify } from '../git/deterministic-json';
import type { StorefrontFamilyPlan } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';

/**
 * Storefront-family plan service (issues #368 food, #372 non-food).
 *
 * New-family flow: stage from ≥2 real purchasable SKUs under an explicit
 * versioned Family Variant Rule (food sizes via the food rule; non-food
 * size/color/count via the approved rule for the member's configured
 * canonical Product Type) → nominate smallest verified comparable member
 * as main (pre-acceptance override to another real member allowed;
 * incomparable/color-only families require explicit selection) →
 * deterministic unique PF7 proposals from the rule's permitted axes →
 * persist versioned plan with rule/evidence/base/read-write hashes →
 * review accept/revise/reject/defer → accepted plans materialize managed
 * native drafts through shared change sets → approval/export reuses the
 * #363 consistency group + #366 listing gate. No Curation Cohort migration,
 * no native accessory reinterpretation, no parallel publisher.
 *
 * SKU-local independence: staging never copies name/price/stock/images/
 * facts/classification/filenames across members; existing catalog data and
 * the existing main are preserved; new products stay disabled
 * (`status: 'draft'`).
 */

export interface StageFamilyInput {
  workspaceId: string;
  workspacePath: string;
  input: StorefrontFamilyStagingInput;
  actor: string;
  curationBySku: Map<string, { base: Product | null; draftBase: Product }>;
}

export interface StageNonFoodFamilyInput {
  workspaceId: string;
  workspacePath: string;
  input: NonFoodFamilyStagingInput;
  actor: string;
  curationBySku: Map<string, { base: Product | null; draftBase: Product }>;
}

export interface FamilyPlanView {
  row: StorefrontFamilyPlanRow;
  plan: StorefrontFamilyPlan;
  blockers: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function planHashParts(
  members: Array<{ sku: string; factors: FamilyVariantFactors; pack: { packCountDeclared: boolean; packCount: number | null } }>,
  evidenceHashes: string[],
  bases: Product[],
  drafts: Product[],
): { ruleHash: string; evidenceHash: string; baseHash: string; readHash: string; writeHash: string } {
  return {
    ruleHash: familyRuleHashFor(members),
    evidenceHash: familyEvidenceHashFor(evidenceHashes),
    baseHash: familyBaseHashFor(bases),
    readHash: familyReadWriteHashFor(drafts).slice(0, 32),
    writeHash: familyReadWriteHashFor(drafts),
  };
}

/**
 * Stage a NEW family plan from eligible SKU-local evidence. Refuses closed
 * on every rule violation; never creates display-only products, synthetic
 * UPCs, or replacement identities.
 */
export function stageStorefrontFamilyPlan(args: StageFamilyInput): FamilyPlanView {
  const parsed = args.input;
  if (parsed.members.length < 2) {
    throw new Error('family_rule_too_few_members: a new family needs at least 2 distinct real size SKUs.');
  }
  const skuSet = new Set(parsed.members.map((m) => m.sku));
  if (skuSet.size !== parsed.members.length) {
    throw new Error('family_rule_duplicate_size: duplicate member SKUs refuse staging.');
  }
  for (const m of parsed.members) {
    if (!m.purchasable) {
      throw new Error(`family_not_purchasable: SKU "${m.sku}" is not a real purchasable size SKU.`);
    }
    const curation = args.curationBySku.get(m.sku);
    if (!curation) {
      throw new Error(`family_member_unresolved: SKU "${m.sku}" has no current eligible SKU-local evidence.`);
    }
    // B2: refuse unsupported native structures closed at stage time, per
    // member, before anything is authored. setManagedSubproducts would
    // otherwise drop the existing raw block, so the check must run on the
    // pre-mutation draft base — never on an already-managed draft.
    // Accessory-host refusal (#372): supported_unmanaged_simple still
    // carries a native accessory block (the host lists other SKUs without
    // self-listing). When that member becomes the main, setManagedSubproducts
    // would replace its accessory relationships and discard native
    // references/metadata. Refuse closed — stage explicit native adoption
    // first (or exclude the host), never silently convert accessories.
    const support = classifySubproductsSupport(curation.draftBase);
    if (support.code !== 'supported_absent' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${m.sku}" keeps its existing native Subproducts structure preserved and unadopted (${support.code}: ${support.detail}); stage explicit native adoption first or exclude the member.`);
    }
  }
  const factors: Array<{ sku: string; factors: FamilyVariantFactors; pack: { packCountDeclared: boolean; packCount: number | null } }> = parsed.members.map((m) => ({
    sku: m.sku,
    factors: {
      brand: m.brand,
      recipe: m.recipe,
      flavor: m.flavor,
      species: m.species,
      lifeStage: m.lifeStage,
      form: m.form,
      packageSize: { raw: m.sizeRaw, ounces: m.ounces },
      retailUnit: m.retailUnit,
      comparableOunces: m.ounces,
      reviewedTypeHash: m.reviewedTypeHash,
    } satisfies FamilyVariantFactors,
    pack: { packCountDeclared: m.packCountDeclared, packCount: m.packCount },
  }));
  const verdict = evaluateFamilyVariantRule(factors);
  if (!verdict.ok) {
    throw new Error(`${verdict.code}: ${verdict.reason}`);
  }
  let mainSku: string;
  let mainOverridden = false;
  if (parsed.mainSku) {
    if (!skuSet.has(parsed.mainSku)) {
      throw new Error(`family_main_not_member: override "${parsed.mainSku}" is not a real member SKU.`);
    }
    mainSku = parsed.mainSku;
    const auto = nominateFamilyMain(parsed.members.map((m) => ({ sku: m.sku, comparableOunces: m.ounces })));
    mainOverridden = auto.kind === 'nominated' ? auto.sku !== parsed.mainSku : true;
  } else {
    const nomination = nominateFamilyMain(parsed.members.map((m) => ({ sku: m.sku, comparableOunces: m.ounces })));
    if (nomination.kind === 'selection_required') {
      throw new Error(`family_main_selection_required: ${nomination.reason}`);
    }
    mainSku = nomination.sku;
  }
  // Preserve existing nonempty PF7 labels by default (consistent with #372
  // non-food staging): seed from the live base label when present; only
  // members without a label receive generated values.
  const liveLabelBySku = new Map<string, string>();
  for (const m of parsed.members) {
    const live = args.curationBySku.get(m.sku)?.base ?? null;
    const livePf7 = (live?.customFields['ProductField7'] ?? '').trim();
    if (livePf7.length > 0) liveLabelBySku.set(m.sku, livePf7);
  }
  const generated = derivePf7ShortNames(parsed.members.map((m) => ({ sku: m.sku, sizeRaw: m.sizeRaw, ounces: m.ounces })));
  const pf7 = adjustProposalsForPreservedLabels(generated, liveLabelBySku);
  const drafts = parsed.members.map((m) => args.curationBySku.get(m.sku)!.draftBase);
  const bases = parsed.members.map((m) => args.curationBySku.get(m.sku)!.base).filter((b): b is Product => b !== null);
  const hashes = planHashParts(factors, parsed.members.map((m) => m.evidenceHash), bases, drafts);
  const at = nowIso();
  const plan: StorefrontFamilyPlan = {
    id: randomUUID(),
    workspaceId: args.workspaceId,
    ruleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION,
    planVersion: 'storefront-family-plan-v1',
    status: 'proposed',
    revision: 0,
    memberSkus: [...skuSet].sort(),
    members: parsed.members.map((m) => ({
      sku: m.sku,
      comparableOunces: m.ounces,
      sizeRaw: m.sizeRaw,
      retailUnit: m.retailUnit,
      packCountDeclared: m.packCountDeclared,
      packCount: m.packCount,
      reviewedTypeHash: m.reviewedTypeHash,
      evidenceHash: m.evidenceHash,
      baseHash: args.curationBySku.get(m.sku)!.base ? comparisonHashForProduct(args.curationBySku.get(m.sku)!.base!) : null,
      stagedLabel: liveLabelBySku.get(m.sku) ?? null,
      productTypeId: null,
      model: null,
      material: null,
      function: null,
      safetyDose: null,
      strength: null,
      fit: null,
      colorRaw: null,
      countRaw: null,
      countQuantity: null,
    })),
    mainSku,
    mainOverridden,
    pf7Proposals: pf7,
    ruleHash: hashes.ruleHash,
    ruleConfigHash: familyRuleConfigHashFor(FOOD_FAMILY_VARIANT_RULE_VERSION),
    evidenceHash: hashes.evidenceHash,
    baseHash: hashes.baseHash,
    readHash: hashes.readHash,
    writeHash: hashes.writeHash,
    linkedChangeSetId: null,
    decisions: [],
    createdAt: at,
    updatedAt: at,
  };
  const row = createStorefrontFamilyPlan({ workspaceId: args.workspaceId, plan });
  return { row, plan, blockers: [] };
}
/**
 * Stage a NEW non-food family plan under an approved non-food rule (#372).
 * Same-SKU-local independence, real-member nomination, deterministic
 * unique Short Names from the rule's permitted axes, and preserved labels
 * as the food path — through real member selection only (no #371
 * membership assistance required). Refuses closed on every rule/type/
 * evidence violation; type/product-type drift stales via the shared
 * freshness check.
 */
export function stageNonFoodStorefrontFamilyPlan(args: StageNonFoodFamilyInput): FamilyPlanView {
  const parsed = args.input;
  const ruleVersion = parsed.ruleVersion;
  const permittedTypes = NON_FOOD_FAMILY_RULE_PRODUCT_TYPES[ruleVersion] ?? [];
  if (parsed.members.length < 2) {
    throw new Error('family_rule_too_few_members: a new family needs at least 2 distinct real member SKUs.');
  }
  const skuSet = new Set(parsed.members.map((m) => m.sku));
  if (skuSet.size !== parsed.members.length) {
    throw new Error('family_rule_duplicate_variant: duplicate member SKUs refuse staging.');
  }
  for (const m of parsed.members) {
    if (!m.purchasable) {
      throw new Error(`family_not_purchasable: SKU "${m.sku}" is not a real purchasable member SKU.`);
    }
    if (!permittedTypes.includes(m.reviewedProductTypeId)) {
      throw new Error(
        `family_rule_type_not_applicable: SKU "${m.sku}" type "${m.reviewedProductTypeId}" is not declared for rule "${ruleVersion}"; unknown/undeclared types never resolve a rule.`,
      );
    }
    const curation = args.curationBySku.get(m.sku);
    if (!curation) {
      throw new Error(`family_member_unresolved: SKU "${m.sku}" has no current eligible SKU-local evidence.`);
    }
    const support = classifySubproductsSupport(curation.draftBase);
    if (support.code !== 'supported_absent' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${m.sku}" keeps its existing native Subproducts structure preserved and unadopted (${support.code}: ${support.detail}); stage explicit native adoption first or exclude the member.`);
    }
  }
  const factors: Array<{ sku: string; factors: NonFoodFamilyVariantFactors; pack: { packCountDeclared: boolean; packCount: number | null } }> = parsed.members.map((m) => ({
    sku: m.sku,
    factors: {
      brand: m.brand,
      model: m.model,
      material: m.material,
      function: m.function,
      safetyDose: m.safetyDose,
      strength: m.strength,
      fit: m.fit,
      size: m.sizeRaw,
      color: m.colorRaw,
      count: m.countRaw != null ? { raw: m.countRaw, quantity: m.countQuantity ?? null } : null,
      retailUnit: m.retailUnit ?? null,
      reviewedTypeHash: m.reviewedTypeHash,
      reviewedProductTypeId: m.reviewedProductTypeId,
    } satisfies NonFoodFamilyVariantFactors,
    pack: { packCountDeclared: m.packCountDeclared, packCount: m.packCount ?? null },
  }));
  const verdict = evaluateNonFoodFamilyVariantRule(ruleVersion, factors);
  if (!verdict.ok) {
    throw new Error(`${verdict.code}: ${verdict.reason}`);
  }
  let mainSku: string;
  let mainOverridden = false;
  const comparableFor = (m: { sku: string; countQuantity: number | null; sizeRaw: string | null; ounces: number | null }): { sku: string; comparableQuantity: number | null } => {
    // Verified common-unit quantities only (#372): count-quantity and
    // ounce-equivalent evidence already share a verified unit path
    // (parseOunces/parseOuncesLocal); a bare first-number parse would rank
    // "10 in" below "20 cm", so incomparable size text yields no
    // comparable — nomination then requires explicit operator selection.
    if (m.countQuantity != null) return { sku: m.sku, comparableQuantity: m.countQuantity };
    if (m.ounces != null) return { sku: m.sku, comparableQuantity: m.ounces };
    if (m.sizeRaw != null && /\b(in|inch|inches|cm|centimeters?|mm|millimeters?|ft|feet|m)\b/i.test(m.sizeRaw)) return { sku: m.sku, comparableQuantity: null };
    return { sku: m.sku, comparableQuantity: null };
  };
  if (parsed.mainSku) {
    if (!skuSet.has(parsed.mainSku)) {
      throw new Error(`family_main_not_member: override "${parsed.mainSku}" is not a real member SKU.`);
    }
    mainSku = parsed.mainSku;
    const auto = nominateNonFoodFamilyMain(ruleVersion, parsed.members.map((m) => comparableFor({ sku: m.sku, countQuantity: m.countQuantity, ounces: m.ounces, sizeRaw: m.sizeRaw })));
    mainOverridden = auto.kind === 'nominated' ? auto.sku !== parsed.mainSku : true;
  } else {
    const nomination = nominateNonFoodFamilyMain(ruleVersion, parsed.members.map((m) => comparableFor({ sku: m.sku, countQuantity: m.countQuantity, ounces: m.ounces, sizeRaw: m.sizeRaw })));
    if (nomination.kind === 'selection_required') {
      throw new Error(`family_main_selection_required: ${nomination.reason}`);
    }
    mainSku = nomination.sku;
  }
  // Preserve existing nonempty PF7 labels by default (#372): seed the
  // proposal from the live base label when present; only members without a
  // label receive generated values. Exposed replacements arrive as explicit
  // reviewed diffs downstream (label drift stales via freshness).
  const liveLabelBySku = new Map<string, string>();
  for (const m of parsed.members) {
    const live = args.curationBySku.get(m.sku)?.base ?? null;
    const livePf7 = (live?.customFields['ProductField7'] ?? '').trim();
    if (livePf7.length > 0) liveLabelBySku.set(m.sku, livePf7);
  }
  const generated = deriveNonFoodPf7ShortNames(ruleVersion, parsed.members.map((m) => ({
    sku: m.sku,
    sizeRaw: m.sizeRaw,
    colorRaw: m.colorRaw,
    countRaw: m.countRaw,
    countQuantity: m.countQuantity,
  })));
  const pf7 = adjustProposalsForPreservedLabels(generated, liveLabelBySku);
  const drafts = parsed.members.map((m) => args.curationBySku.get(m.sku)!.draftBase);
  const bases = parsed.members.map((m) => args.curationBySku.get(m.sku)!.base).filter((b): b is Product => b !== null);
  const hashes = {
    ruleHash: nonFoodFamilyRuleHashFor(ruleVersion, factors),
    evidenceHash: familyEvidenceHashFor(parsed.members.map((m) => m.evidenceHash)),
    baseHash: familyBaseHashFor(bases),
    readHash: familyReadWriteHashFor(drafts).slice(0, 32),
    writeHash: familyReadWriteHashFor(drafts),
  };
  const at = nowIso();
  const plan: StorefrontFamilyPlan = {
    id: randomUUID(),
    workspaceId: args.workspaceId,
    ruleVersion,
    planVersion: 'storefront-family-plan-v1',
    status: 'proposed',
    revision: 0,
    memberSkus: [...skuSet].sort(),
    members: parsed.members.map((m) => ({
      sku: m.sku,
      comparableOunces: m.countQuantity,
      sizeRaw: m.sizeRaw,
      packCountDeclared: m.packCountDeclared,
      packCount: m.packCount ?? null,
      retailUnit: m.retailUnit ?? null,
      reviewedTypeHash: m.reviewedTypeHash,
      evidenceHash: m.evidenceHash,
      baseHash: args.curationBySku.get(m.sku)!.base ? comparisonHashForProduct(args.curationBySku.get(m.sku)!.base!) : null,
      productTypeId: m.reviewedProductTypeId,
      model: m.model,
      material: m.material,
      function: m.function,
      safetyDose: m.safetyDose,
      strength: m.strength,
      fit: m.fit,
      colorRaw: m.colorRaw,
      countRaw: m.countRaw,
      countQuantity: m.countQuantity,
      stagedLabel: liveLabelBySku.get(m.sku) ?? null,
    })),
    mainSku,
    mainOverridden,
    pf7Proposals: pf7,
    ruleHash: hashes.ruleHash,
    ruleConfigHash: familyRuleConfigHashFor(ruleVersion),
    evidenceHash: hashes.evidenceHash,
    baseHash: hashes.baseHash,
    readHash: hashes.readHash,
    writeHash: hashes.writeHash,
    linkedChangeSetId: null,
    decisions: [],
    createdAt: at,
    updatedAt: at,
  };
  const row = createStorefrontFamilyPlan({ workspaceId: args.workspaceId, plan });
  return { row, plan, blockers: [] };
}

/**
 * Record a human review decision. Accept/revise/reject/defer; defer leaves
 * the standalone listing releasable (no Cohort barrier). Revise bumps the
 * revision and re-proposes with an optional main override resolved against
 * real members only.
 */
export function decideStorefrontFamilyPlan(input: {
  planId: string;
  actor: string;
  action: 'accept' | 'revise' | 'reject' | 'defer';
  note?: string | null;
  mainOverrideSku?: string | null;
  /** Decide-time freshness recheck (#369): current live/type/evidence/rule/label state. Refuses accept on drift. */
  freshness?: {
    liveBySku?: Map<string, Product | null>;
    currentTypeHashBySku?: Map<string, string | null>;
    currentEvidenceHashBySku?: Map<string, string | null>;
    currentRuleVersionBySku?: Map<string, string | null>;
    currentProductTypeIdBySku?: Map<string, string | null>;
    currentLabelBySku?: Map<string, string | null>;
  } | null;
  /** Decide-time conflicting-draft recheck (#369): refuse accept when a competing draft exists. */
  conflictingDrafts?: Array<{ changeSetId: string; sku: string; status: string }>;
  /** Decide-time drift recheck (#369): refuse accept on open/reconciling drift. */
  driftSkus?: string[];
}): FamilyPlanView {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  // Decide-time recheck (#369): an accept on drifted/conflicting state
  // refuses closed — the operator re-reviews against current evidence first.
  if (input.action === 'accept') {
    for (const conflict of input.conflictingDrafts ?? []) {
      throw new Error(`family_plan_decision_conflict: SKU "${conflict.sku}" is also staged in change set ${conflict.changeSetId.slice(0, 8)} (status "${conflict.status}"); resolve the competing draft before accepting.`);
    }
    for (const sku of input.driftSkus ?? []) {
      throw new Error(`family_plan_decision_drift: SKU "${sku}" carries open/reconciling drift; resolve drift before accepting.`);
    }
    const f = input.freshness;
    // Approved configuration pin (#372): a plan staged under a superseded
    // rule configuration never accepts — even when per-member hashes still
    // match. Legacy plans (empty pin) accept only when the caller supplies
    // no fresher configuration context would change them; the freshness
    // path below marks those stale explicitly.
    const expectedConfigHash = familyRuleConfigHashFor(plan.ruleVersion);
    if ((plan.ruleConfigHash ?? '') !== '' && plan.ruleConfigHash !== expectedConfigHash) {
      throw new Error(`family_plan_decision_stale: approved rule configuration changed after staging (expected "${expectedConfigHash}"); re-stage before accepting.`);
    }
    if (f) {
      for (const member of plan.members) {
        const live = f.liveBySku?.get(member.sku) ?? null;
        const liveBaseHash = live ? comparisonHashForProduct(live) : null;
        if (f.liveBySku && liveBaseHash !== member.baseHash) {
          throw new Error(`family_plan_decision_stale: SKU "${member.sku}" base changed after staging; re-review before accepting.`);
        }
        if (f.currentTypeHashBySku && (f.currentTypeHashBySku.get(member.sku) ?? null) !== member.reviewedTypeHash) {
          throw new Error(`family_plan_decision_stale: SKU "${member.sku}" reviewed type authority changed after staging; re-review before accepting.`);
        }
        if (f.currentEvidenceHashBySku && (f.currentEvidenceHashBySku.get(member.sku) ?? null) !== member.evidenceHash) {
          throw new Error(`family_plan_decision_stale: SKU "${member.sku}" listing evidence changed after staging; re-review before accepting.`);
        }
        if (f.currentRuleVersionBySku) {
          const currentRule = f.currentRuleVersionBySku.get(member.sku) ?? null;
          if (currentRule !== null && currentRule !== plan.ruleVersion) {
            throw new Error(`family_plan_decision_stale: SKU "${member.sku}" rule changed after staging; re-review before accepting.`);
          }
        }
        if (f.currentProductTypeIdBySku && member.productTypeId != null) {
          const currentTypeId = f.currentProductTypeIdBySku.get(member.sku) ?? null;
          if (currentTypeId !== null && currentTypeId !== member.productTypeId) {
            throw new Error(`family_plan_decision_stale: SKU "${member.sku}" product type changed after staging; re-review before accepting.`);
          }
        }
        if (f.currentLabelBySku) {
          // Compare against the STAGED original (#372): an intentional
          // preserved-label replacement (proposal differs from the staged
          // original) is explicit reviewed content and must accept. Only a
          // post-staging live-label edit — current label differs from BOTH
          // the staged original AND the proposal — refuses as stale.
          const proposal = plan.pf7Proposals.find((pp) => pp.sku === member.sku)?.shortName ?? null;
          const stagedOriginal = member.stagedLabel ?? null;
          const currentLabel = f.currentLabelBySku.get(member.sku) ?? null;
          if (currentLabel !== null && proposal !== null && currentLabel !== stagedOriginal && currentLabel !== proposal) {
            throw new Error(`family_plan_decision_stale: SKU "${member.sku}" label changed after staging; re-review before accepting.`);
          }
        }
      }
    }
  }
  if (plan.status === 'applied') {
    throw new Error('family_plan_applied: an applied plan is immutable; stage a new plan to change the family.');
  }
  if (plan.status === 'stale') {
    throw new Error('family_plan_stale: re-stage the family against current evidence before deciding.');
  }
  if (input.mainOverrideSku) {
    if (!plan.memberSkus.includes(input.mainOverrideSku)) {
      throw new Error(`family_main_not_member: override "${input.mainOverrideSku}" is not a real member SKU.`);
    }
    // Adopted plans preserve the native main verbatim (#369): a silent
    // pre-acceptance override would reparent the store's native host without
    // an explicit reviewed change. Refuse — stage a new plan to change mains.
    if (plan.adoptionOrigin) {
      throw new Error(`family_main_preserved: adopted family "${plan.id.slice(0, 8)}" preserves native main "${plan.mainSku}"; main overrides are refused on adopted plans.`);
    }
  }
  const at = nowIso();
  const next: StorefrontFamilyPlan = {
    ...plan,
    mainSku: input.mainOverrideSku ?? plan.mainSku,
    mainOverridden: input.mainOverrideSku ? true : plan.mainOverridden,
    updatedAt: at,
    decisions: [
      ...plan.decisions,
      {
        actor: input.actor,
        action: input.action,
        at,
        note: input.note ?? null,
        mainOverrideSku: input.mainOverrideSku ?? null,
      },
    ],
  };
  let status: StorefrontFamilyPlan['status'];
  let revision = plan.revision;
  if (input.action === 'accept') {
    if (plan.status !== 'proposed' && plan.status !== 'revised') {
      throw new Error(`family_plan_decision_order: cannot accept a plan in status "${plan.status}".`);
    }
    status = 'accepted';
  } else if (input.action === 'revise') {
    revision += 1;
    status = 'revised';
  } else if (input.action === 'reject') {
    status = 'rejected';
  } else {
    status = 'deferred';
  }
  next.status = status;
  next.revision = revision;
  const updated = updateStorefrontFamilyPlan({ id: plan.id, plan: next, status, revision });
  return { row: updated, plan: next, blockers: [] };
}

/**
 * Detect drift: member/rule/evidence/base/draft changes since staging mark
 * the plan stale. Any live base whose comparison hash moved, any member
 * whose reviewed-type authority moved, or any member whose per-member
 * listing-evidence hash moved, stales the whole plan (whole-group
 * invalidation). Block-on-main-only rationale (documented here because
 * the emission question lives with this function): the main carries the
 * single managed block (full member set, main self-included exactly once),
 * so any single-member evidence drift changes the main's emitted block and
 * must invalidate the whole group — the single block is what makes
 * whole-group invalidation sound. The ticket text requires the new main to
 * appear as its own Subproduct (criterion 4) and treats the family as one
 * complete consistency group (criteria 9/11); other cycles refuse.
 */
export function checkStorefrontFamilyFreshness(input: {
  planId: string;
  workspacePath: string;
  liveBySku: Map<string, Product | null>;
  currentTypeHashBySku: Map<string, string | null>;
  currentEvidenceHashBySku: Map<string, string | null>;
  currentRuleVersionBySku?: Map<string, string | null>;
  currentProductTypeIdBySku?: Map<string, string | null>;
  currentLabelBySku?: Map<string, string | null>;
}): { fresh: boolean; reasons: string[] } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  const reasons: string[] = [];
  // Approved configuration pin (#372): a workspace rule-table change
  // invalidates plans staged under the superseded configuration, even when
  // per-member hashes still match. Legacy plans (empty pin) report stale
  // when the configured hash is present so they re-stage onto the pin.
  const expectedConfigHash = familyRuleConfigHashFor(plan.ruleVersion);
  if ((plan.ruleConfigHash ?? '') !== expectedConfigHash) {
    reasons.push(`Approved rule configuration changed after staging (expected "${expectedConfigHash}"); re-stage the family.`);
  }
  for (const member of plan.members) {
    const live = input.liveBySku.get(member.sku) ?? null;
    const liveBaseHash = live ? comparisonHashForProduct(live) : null;
    if (liveBaseHash !== member.baseHash) {
      reasons.push(`SKU "${member.sku}" base changed after staging (stale base).`);
    }
    const currentType = input.currentTypeHashBySku.get(member.sku) ?? null;
    if (currentType !== member.reviewedTypeHash) {
      reasons.push(`SKU "${member.sku}" reviewed type authority changed after staging.`);
    }
    // N6: per-member evidence drift stales the plan. The map is
    // required: a missing entry means the current authority is
    // unavailable, which stales closed (never an unverified fresh).
    {
      const currentEvidence = input.currentEvidenceHashBySku.get(member.sku) ?? null;
      if (currentEvidence !== member.evidenceHash) {
        reasons.push(`SKU "${member.sku}" listing evidence changed after staging (stale evidence).`);
      }
    }
    // #372: rule authority drift stales the plan. When the caller threads
    // current rule versions (route freshness does), a moved rule version —
    // e.g. a type reconfiguration after staging — invalidates the group.
    // Members also bind their canonical productTypeId at staging; a moved
    // type id stales even when the reviewed hash is unchanged.
    if (input.currentRuleVersionBySku) {
      const hasRule = input.currentRuleVersionBySku.has(member.sku);
      const currentRule = input.currentRuleVersionBySku.get(member.sku) ?? null;
      if (!hasRule || currentRule === null || currentRule !== plan.ruleVersion) {
        reasons.push(`SKU "${member.sku}" rule changed after staging (stale rule).`);
      }
    }
    if (input.currentProductTypeIdBySku && member.productTypeId != null) {
      const hasTypeId = input.currentProductTypeIdBySku.has(member.sku);
      const currentTypeId = input.currentProductTypeIdBySku.get(member.sku) ?? null;
      if (!hasTypeId || currentTypeId === null || currentTypeId !== member.productTypeId) {
        reasons.push(`SKU "${member.sku}" product type changed after staging (stale rule).`);
      }
    }
    // #372: label drift compares against the STAGED original, not the live
    // label alone. An intentional preserved-label replacement (proposal
    // differs from the staged original) is explicit reviewed content and
    // stays fresh; only a post-staging operator edit — current label
    // differs from BOTH the staged original and the proposal — stales.
    if (input.currentLabelBySku) {
      const proposal = plan.pf7Proposals.find((p) => p.sku === member.sku)?.shortName ?? null;
      const stagedOriginal = member.stagedLabel ?? null;
      const currentLabel = input.currentLabelBySku.get(member.sku) ?? null;
      if (currentLabel !== null && proposal !== null && currentLabel !== stagedOriginal && currentLabel !== proposal) {
        reasons.push(`SKU "${member.sku}" label changed after staging (stale label).`);
      }
    }
  }
  if (reasons.length > 0 && (plan.status === 'proposed' || plan.status === 'revised' || plan.status === 'accepted')) {
    const next: StorefrontFamilyPlan = { ...plan, status: 'stale', updatedAt: nowIso() };
    updateStorefrontFamilyPlan({ id: plan.id, plan: next, status: 'stale', revision: plan.revision });
  }
  return { fresh: reasons.length === 0, reasons };
}

/**
 * Materialize an ACCEPTED plan into managed native drafts through the
 * shared change-set path (one change set = the complete consistency
 * group). Each member keeps full SKU-local independence: only Subproducts
 * + PF7 change; names/SKU/prices/stock/images/facts/classifications/
 * filenames/enablement come from the staged draft bases untouched, and new
 * products stay disabled. Classifier PF7/native writes stay refused (the
 * classifier path is never consulted here — listing-owned only).
 */
export function applyStorefrontFamilyPlan(input: {
  planId: string;
  workspaceId: string;
  workspacePath: string;
  draftsBySku: Map<string, Product>;
  actor: string;
  /** Purchasable re-check (#368): current per-SKU purchasable evidence; refuse when a member stopped being purchasable. */
  purchasableBySku?: Map<string, boolean>;
}): { changeSetId: string; plan: StorefrontFamilyPlan } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  // N2: require accepted status for apply. A revise after an accept
  // re-proposes the plan — the revised content must be re-accepted before
  // it can materialize. Accept → revise → apply without re-accept is
  // refused closed here.
  if (plan.status !== 'accepted') {
    throw new Error(`family_plan_not_accepted: plan is "${plan.status}"; accept (or re-accept after revise) before applying.`);
  }
  // Approved configuration gate (#372): a plan staged under a superseded
  // rule configuration never materializes — re-stage onto the current
  // configuration first.
  if ((plan.ruleConfigHash ?? '') !== familyRuleConfigHashFor(plan.ruleVersion)) {
    throw new Error(`family_apply_stale: approved rule configuration changed after staging (expected "${familyRuleConfigHashFor(plan.ruleVersion)}"); re-stage before applying.`);
  }
  for (const sku of plan.memberSkus) {
    // Purchasability re-check (#368): every member must carry positive
    // current purchasable authority. An explicit-false entry refuses, and
    // a missing entry refuses when the caller threads the map (the route
    // always does — absent means the current authority is unbound, never
    // an unverified pass). An omitted map (direct service callers, e.g.
    // tests) skips the re-check; staged purchasability was already
    // enforced at stage time.
    if (input.purchasableBySku?.get(sku) === false) {
      throw new Error(`family_not_purchasable: SKU "${sku}" is not currently purchasable (or has no current purchasability authority); refusing apply.`);
    }
    if (input.purchasableBySku && !input.purchasableBySku.has(sku)) {
      throw new Error(`family_not_purchasable: SKU "${sku}" is not currently purchasable (or has no current purchasability authority); refusing apply.`);
    }
    if (!input.draftsBySku.has(sku)) {
      throw new Error(`family_member_missing_draft: SKU "${sku}" has no staged draft; accepting requires the complete validated set.`);
    }
    // B2 (apply path): refuse unsupported native structures closed per
    // member on the pre-mutation draft — the live evidence may have gained
    // an unsafe block after staging. Accessory hosts refuse here too: the
    // managed writer would replace their native accessory relationships.
    const support = classifySubproductsSupport(input.draftsBySku.get(sku)!);
    if (support.code !== 'supported_absent' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${sku}" keeps its existing native Subproducts structure preserved and unadopted (${support.code}: ${support.detail}); stage explicit native adoption first or exclude the member.`);
    }
    // Pre-materialization conflict check: a nominated main already carrying
    // managed-family markers for a DIFFERENT family must refuse here — the
    // writer below stamps this plan's markers and the later group check
    // would only see the replacement, silently overwriting the original
    // relationship. Same-family re-application passes (idempotent retry).
    const draft = input.draftsBySku.get(sku)!;
    const nativeRefs = extractSubproductSkus(draft).filter((r) => plan.memberSkus.includes(r));
    const managed = readManagedMembership(draft);
    if (managed && managed.familyId !== plan.id) {
      throw new Error(`family_conflicting_membership: SKU "${sku}" already belongs to managed family "${managed.familyId}"; transitive merges are refused — re-stage or dissolve the original family first.`);
    }
    if (!managed && sku !== plan.mainSku && nativeRefs.length > 0) {
      throw new Error(`family_conflicting_membership: SKU "${sku}" hosts family member refs (${nativeRefs.join(', ')}); only the main "${plan.mainSku}" emits the managed block — other cycles refuse.`);
    }
  }
  // Freshness-gated apply (#370): stale bases, competing drafts, and open
  // drift refuse before any write. Any check that cannot complete fails
  // closed (never an unverified apply).
  for (const sku of plan.memberSkus) {
    const staged = plan.members.find((mm) => mm.sku === sku);
    let liveBaseHash: string | null;
    try {
      const live = readProductFile(input.workspacePath, sku);
      liveBaseHash = live ? comparisonHashForProduct(live) : null;
    } catch (err) {
      throw new Error(`family_apply_stale: base for SKU "${sku}" unreadable after staging (${err instanceof Error ? err.message : String(err)}); re-stage before applying.`, { cause: err });
    }
    if (liveBaseHash !== (staged?.baseHash ?? null)) {
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
  // Per-SKU context (#369): materialization failures name the SKU so the
  // operator knows exactly which member blocked the whole group.
  const materializedMembers = plan.memberSkus.map((sku) => {
    try {
      return withManagedFamilyDraft(input.draftsBySku.get(sku)!, plan);
    } catch (err) {
      throw new Error(`family_member_materialize_failed: SKU "${sku}" could not materialize its managed draft (${err instanceof Error ? err.message : String(err)}).`, { cause: err });
    }
  });
  const applyBases = new Map<string, import('../shared/types').Product | null>();
  for (const sku of plan.memberSkus) {
    try {
      applyBases.set(sku, readProductFile(input.workspacePath, sku));
    } catch (err) {
      throw new Error(`family_member_base_unreadable: approved base for SKU "${sku}" unreadable at apply (${err instanceof Error ? err.message : String(err)}); re-stage before applying.`, { cause: err });
    }
  }
  const issues = validateStorefrontFamilyGroup({
    familyId: plan.id,
    members: materializedMembers,
    bases: applyBases,
  });
  const blockers = issues.filter((i) => i.severity === 'blocker');
  if (blockers.length > 0) {
    throw new Error(`family_group_blocked: ${blockers.map((b) => `[${b.code}] ${b.message}`).slice(0, 5).join('; ')}`);
  }
  const db = getDb();
  const familyKind = plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION ? 'food' : nonFoodFamilyKindLabel(plan.ruleVersion);
  const staged = db.transaction(() => {
    const changeSet = createChangeSet({
      workspaceId: input.workspaceId,
      title: `Storefront family ${plan.id.slice(0, 8)} (${plan.memberSkus.length} members)`,
      description: `Adopted ${familyKind} family under ${plan.ruleVersion}; main ${plan.mainSku}.`,
      baseCommit: readHeadCommit(input.workspacePath),
    });
    for (const sku of plan.memberSkus) {
      const base = readProductFile(input.workspacePath, sku);
      const managed = withManagedFamilyDraft(input.draftsBySku.get(sku)!, plan);
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

function nonFoodFamilyKindLabel(ruleVersion: FamilyVariantRuleVersion): string {
  if (ruleVersion === 'non-food-size-family-variant-rule-v1') return 'non-food size';
  if (ruleVersion === 'non-food-color-family-variant-rule-v1') return 'non-food color';
  if (ruleVersion === 'non-food-count-family-variant-rule-v1') return 'non-food count';
  return 'non-food size/color';
}

/**
 * Merge preserved live PF7 labels into generated proposals (#372): members
 * with an existing nonempty label keep it; collisions against generated or
 * other preserved labels disambiguate deterministically with ` · N`.
 * Pure helper — deterministic for identical inputs.
 */
export function adjustProposalsForPreservedLabels(
  generated: ReadonlyArray<{ sku: string; shortName: string }>,
  liveLabelBySku: ReadonlyMap<string, string>,
): Array<{ sku: string; shortName: string; replaced: boolean }> {
  // Reserve preserved labels first (#372): every member's existing label is
  // claimed before any alternative is generated, so an earlier generated
  // label can never claim a later member's existing label and force its
  // replacement. Members whose preserved label collides with another
  // preserved label keep the earliest-SKU claim; later collisions
  // disambiguate — and surface as replaced diffs (replaced: true) for
  // explicit review, never silent overwrites.
  const sorted = [...generated].sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const used: Record<string, true> = {};
  const reserved = new Map<string, string>();
  for (const proposal of sorted) {
    const preserved = liveLabelBySku.get(proposal.sku)?.trim();
    if (!preserved) continue;
    let candidate = preserved;
    let n = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = `${preserved} · ${n}`;
      n += 1;
    }
    used[candidate.toLowerCase()] = true;
    reserved.set(proposal.sku, candidate);
  }
  const out: Array<{ sku: string; shortName: string; replaced: boolean }> = [];
  for (const proposal of sorted) {
    const existing = reserved.get(proposal.sku);
    if (existing !== undefined) {
      out.push({ sku: proposal.sku, shortName: existing, replaced: existing !== (liveLabelBySku.get(proposal.sku)?.trim() ?? '') });
      continue;
    }
    let candidate = proposal.shortName;
    let n = 2;
    while (used[candidate.toLowerCase()]) {
      candidate = `${proposal.shortName} · ${n}`;
      n += 1;
    }
    used[candidate.toLowerCase()] = true;
    out.push({ sku: proposal.sku, shortName: candidate, replaced: false });
  }
  return out.sort((a, b) => (a.sku < b.sku ? -1 : 1));
}

function withManagedFamilyDraft(draft: Product, plan: StorefrontFamilyPlan): Product {
  const pf7 = plan.pf7Proposals.find((p) => p.sku === draft.sku)?.shortName;
  if (!pf7) throw new Error(`family_pf7_missing: no PF7 proposal for SKU "${draft.sku}".`);
  const staged = plan.members.find((m) => m.sku === draft.sku);
  const isNonFood = plan.ruleVersion !== FOOD_FAMILY_VARIANT_RULE_VERSION;
  // Preserve existing nonempty PF7 labels by default (#372): an accepted
  // plan already carries preserved labels in its proposals (staging copies
  // the live label when present), so the writer applies the proposal
  // verbatim — never synthesizes a replacement here.
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
          // N5: stamp the staged retail-unit evidence so group
          // re-validation can thread it (draft-first, base as fallback).
          ...(retailUnit ? { retailUnit } : {}),
          // N1: stamp pack declaration evidence so the group path can
          // enforce the undeclared-pack rule (never inferred downstream).
          ...(staged?.packCountDeclared ? { packCountDeclared: 'true' } : {}),
          ...(staged?.packCount != null ? { packCount: String(staged.packCount) } : {}),
          // #372: stamp non-food identity evidence so group re-validation
          // threads staged declarations (draft-first, base as fallback).
          ...(isNonFood && staged?.productTypeId ? { nonFoodProductTypeId: staged.productTypeId } : {}),
          ...(isNonFood && staged?.model ? { nonFoodModel: staged.model } : {}),
          ...(isNonFood && staged?.material ? { nonFoodMaterial: staged.material } : {}),
          ...(isNonFood && staged?.function ? { nonFoodFunction: staged.function } : {}),
          ...(isNonFood && staged?.safetyDose ? { nonFoodSafetyDose: staged.safetyDose } : {}),
          ...(isNonFood && staged?.strength ? { nonFoodStrength: staged.strength } : {}),
          ...(isNonFood && staged?.fit ? { nonFoodFit: staged.fit } : {}),
          ...(isNonFood && staged?.sizeRaw ? { nonFoodSizeRaw: staged.sizeRaw } : {}),
          ...(isNonFood && staged?.colorRaw ? { nonFoodColorRaw: staged.colorRaw } : {}),
          ...(isNonFood && staged?.countRaw ? { nonFoodCountRaw: staged.countRaw } : {}),
          ...(isNonFood && staged?.countQuantity != null ? { nonFoodCountQuantity: String(staged.countQuantity) } : {}),
        },
      },
    },
  };
  // Block-on-main-only emission: only the main carries the managed
  // Subproducts block (full member set, main self-included exactly once);
  // every other member keeps its native posture untouched (no mesh).
  if (draft.sku !== plan.mainSku) return withPf7;
  const memberNames = plan.memberSkus.map((sku) => ({
    sku,
    name: sku === draft.sku ? draft.core.name : sku,
  }));
  return setManagedSubproducts(withPf7, plan.id, memberNames);
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
