/**
 * Family Variant Rule authority (issues #368 food, #372 non-food).
 *
 * Versioned, deterministic membership authority for NEW Storefront Product
 * Families: one underlying product under an explicit, approved rule.
 *
 * - Food rule (`food-family-variant-rule-v1`, #368): one recipe/flavor in
 *   multiple package sizes. Same brand + recipe/product-line + flavor +
 *   species + life-stage + form must hold; only package-size/retail-unit
 *   differences qualify (pack rules are explicit).
 * - Non-food rules (#372): one model/product in explicitly permitted
 *   size/color/count axes only. Material, function, safety/dose,
 *   strength/hardness, fit, and other identity distinctions stay invariant
 *   unless a rule explicitly declares an axis legitimate. The rule resolves
 *   through configured canonical Product Type identities — no configured
 *   rule means no family (standalone listing remains possible) — and binds
 *   members by reviewed Product Type authority at the rule's declared type.
 *
 * Every rule is versioned and pinned per family plan; the base
 * reviewed-type authority binds through the reviewed Product Type
 * value-hash of every member (same canonical type), so a later type
 * revision marks the plan stale.
 *
 * Pure module: no imports, no DB, no env, no network. Factors and results
 * are structured records so callers serialize them into the listing-owned
 * plan deterministically (Zod schema owns the wire shape).
 */

export const FOOD_FAMILY_VARIANT_RULE_VERSION = 'food-family-variant-rule-v1' as const;

/**
 * Non-food size rule (#372): approved size-only variants. The applicable
 * Product Type IDs are declared in listing configuration (see
 * NON_FOOD_FAMILY_RULE_PRODUCT_TYPES); members bind reviewed type
 * authority against one of those types.
 */
export const NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION = 'non-food-size-family-variant-rule-v1' as const;

/** Non-food color rule (#372): approved color-only variants. */
export const NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION = 'non-food-color-family-variant-rule-v1' as const;

/** Non-food count rule (#372): approved count-only variants (explicit pack declarations). */
export const NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION = 'non-food-count-family-variant-rule-v1' as const;

/** Non-food size+color rule (#372): approved size/color combination variants. */
export const NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION = 'non-food-size-color-family-variant-rule-v1' as const;

/** Non-food size+count rule (#372): approved size/count combination variants. */
export const NON_FOOD_SIZE_COUNT_FAMILY_VARIANT_RULE_VERSION = 'non-food-size-count-family-variant-rule-v1' as const;

/** Non-food color+count rule (#372): approved color/count combination variants. */
export const NON_FOOD_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION = 'non-food-color-count-family-variant-rule-v1' as const;

/** Non-food size+color+count rule (#372): approved triple-combination variants. */
export const NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION = 'non-food-size-color-count-family-variant-rule-v1' as const;

export const FAMILY_VARIANT_RULE_VERSIONS = [
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION,
] as const;
/** Union of all approved versioned Family Variant Rule identities. */
export type FamilyVariantRuleVersion = (typeof FAMILY_VARIANT_RULE_VERSIONS)[number];


/**
 * Approved versioned Family Variant Rule configuration (#372).
 *
 * Single authoritative table: each approved non-food rule version declares
 * the canonical Product Type identities it applies to, the permitted
 * variant axes, the axes explicitly NOT applicable under the rule (a
 * structural retail-unit/pack difference on a non-applicable axis refuses
 * rather than passing silently), and the Short-Name axis order. All derived
 * views below (product-type map, permitted axes, label order, invariant
 * axes) read from this table so the rule set cannot drift between
 * declarations. The per-view constants stay exported for existing import
 * sites. `familyRuleConfigHashFor` pins the approved configuration into
 * every staged plan so a workspace rule reconfiguration invalidates plans
 * staged under the old configuration.
 */
export const FAMILY_VARIANT_RULE_CONFIG = [
  { version: NON_FOOD_SIZE_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['collars-leashes', 'pet-beds', 'dog-crates-kennels'], permittedAxes: ['size'], nonApplicableAxes: ['retailUnit', 'packCount'], labelOrder: ['size'] },
  { version: NON_FOOD_COLOR_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['collars-leashes', 'pet-beds', 'dog-toys', 'cat-toys'], permittedAxes: ['color'], nonApplicableAxes: ['retailUnit', 'packCount'], labelOrder: ['color'] },
  { version: NON_FOOD_COUNT_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['dog-waste-bags', 'cat-litter'], permittedAxes: ['count'], nonApplicableAxes: ['retailUnit'], labelOrder: ['count'] },
  { version: NON_FOOD_SIZE_COLOR_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['collars-leashes', 'pet-beds'], permittedAxes: ['size', 'color'], nonApplicableAxes: ['retailUnit', 'packCount'], labelOrder: ['size', 'color'] },
  { version: NON_FOOD_SIZE_COUNT_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['dog-waste-bags'], permittedAxes: ['size', 'count'], nonApplicableAxes: ['retailUnit'], labelOrder: ['size', 'count'] },
  { version: NON_FOOD_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['dog-waste-bags'], permittedAxes: ['color', 'count'], nonApplicableAxes: ['retailUnit'], labelOrder: ['color', 'count'] },
  { version: NON_FOOD_SIZE_COLOR_COUNT_FAMILY_VARIANT_RULE_VERSION, productTypeIds: ['dog-waste-bags'], permittedAxes: ['size', 'color', 'count'], nonApplicableAxes: ['retailUnit'], labelOrder: ['size', 'color', 'count'] },
] as const;

/**
 * Pin the approved rule configuration into a versioned hash (#372): any
 * workspace rule-table change (added/removed product type, changed axes or
 * label order) changes every plan's expected config hash, invalidating
 * plans staged under the superseded configuration at decide/freshness/apply.
 * Pure and deterministic: identical configuration always yields the
 * identical hash. The food rule binds the constant food version (no
 * non-food configuration participates).
 */
export function familyRuleConfigHashFor(ruleVersion: FamilyVariantRuleVersion): string {
  if (ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION) return 'config:food-v1';
  const entry = FAMILY_VARIANT_RULE_CONFIG.find((rule) => rule.version === ruleVersion);
  if (!entry) return `config:unknown:${ruleVersion}`;
  const canonical = JSON.stringify({
    version: entry.version,
    types: [...entry.productTypeIds].sort(),
    permitted: [...entry.permittedAxes],
    nonApplicable: [...entry.nonApplicableAxes],
    order: [...entry.labelOrder],
    table: FAMILY_VARIANT_RULE_CONFIG.map((rule) => rule.version),
  });
  let hash = 0;
  for (let i = 0; i < canonical.length; i += 1) {
    hash = (Math.imul(hash, 31) + canonical.charCodeAt(i)) | 0;
  }
  return `config:${entry.version}:${(hash >>> 0).toString(16)}`;
}

/**
 * Configured canonical Product Type identities each non-food rule applies
 * to (#372: rules resolve through configured canonical Product Type
 * identities, not model-invented labels). Type-safe activation (#371)
 * may extend this table; unknown/undeclared types never resolve a rule.
 * Derived from FAMILY_VARIANT_RULE_CONFIG (the approved versioned
 * configuration); kept as a named constant for existing import sites.
 */
export const NON_FOOD_FAMILY_RULE_PRODUCT_TYPES: Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<string>> = Object.fromEntries(
  FAMILY_VARIANT_RULE_CONFIG.map((rule) => [rule.version, [...rule.productTypeIds]]),
) as unknown as Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<string>>;

/** Invariant axes: identical across every member of one family. */
export const FAMILY_INVARIANT_AXES = [
  'brand',
  'recipe',
  'flavor',
  'species',
  'lifeStage',
  'form',
] as const;
export type FamilyInvariantAxis = (typeof FAMILY_INVARIANT_AXES)[number];

/**
 * Non-food invariant axes (#372): material, function, safety/dose,
 * strength/hardness, fit, and model/product identity stay identical
 * unless a rule explicitly declares an axis legitimate.
 */
export const NON_FOOD_FAMILY_INVARIANT_AXES = [
  'brand',
  'model',
  'material',
  'function',
  'safetyDose',
  'strength',
  'fit',
] as const;
export type NonFoodFamilyInvariantAxis = (typeof NON_FOOD_FAMILY_INVARIANT_AXES)[number];

/** Approved qualifying axes: only package-size/retail-unit differences. */
export const FAMILY_QUALIFYING_AXES = ['packageSize', 'retailUnit'] as const;
export type FamilyQualifyingAxis = (typeof FAMILY_QUALIFYING_AXES)[number];

/**
 * Non-food permitted axes by rule version (#372): size, color, count, and
 * the size/color combination. Every other axis refuses as undeclared.
 * Derived from FAMILY_VARIANT_RULE_CONFIG (the approved versioned
 * configuration); kept as a named constant for existing import sites.
 */
export const NON_FOOD_FAMILY_PERMITTED_AXES: Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<'size' | 'color' | 'count'>> = Object.fromEntries(
  FAMILY_VARIANT_RULE_CONFIG.map((rule) => [rule.version, [...rule.permittedAxes]]),
) as unknown as Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<'size' | 'color' | 'count'>>;

/**
 * Non-food Short Name axis order by rule version (#372: names render in
 * the rule's order, e.g. `Small / Red` for size/color).
 * Derived from FAMILY_VARIANT_RULE_CONFIG (the approved versioned
 * configuration); kept as a named constant for existing import sites.
 */
export const NON_FOOD_FAMILY_LABEL_ORDER: Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<'size' | 'color' | 'count'>> = Object.fromEntries(
  FAMILY_VARIANT_RULE_CONFIG.map((rule) => [rule.version, [...rule.labelOrder]]),
) as unknown as Record<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, ReadonlyArray<'size' | 'color' | 'count'>>;

export interface FamilyVariantFactors {
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  /** Verified purchasable package size (value + canonical ounce-equivalent). */
  packageSize: { raw: string; ounces: number | null } | null;
  /** Retail unit (each/case/pack) when explicitly evidenced; null when unknown. */
  retailUnit: string | null;
  /** Verified comparable size in ounces for main nomination; null when incomparable. */
  comparableOunces: number | null;
  /** Reviewed Product Type authority value-hash for this member. */
  reviewedTypeHash: string | null;
}

/**
 * Non-food member factors (#372). Identity axes (model, material,
 * function, safetyDose, strength, fit) are invariant unless the active
 * rule explicitly permits the axis; size/color/count carry the permitted
 * variant values in the rule's order.
 */
export interface NonFoodFamilyVariantFactors {
  brand: string | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  size: string | null;
  color: string | null;
  count: { raw: string; quantity: number | null } | null;
  /** Retail unit (each/case/pack-style) when explicitly evidenced; null when unknown (optional for existing call sites). */
  retailUnit?: string | null;
  reviewedTypeHash: string | null;
  /** Canonical Product Type id bound at review time; must be declared for the rule. */
  reviewedProductTypeId: string | null;
}

/** Pack-count rule: when pack counts are evidenced, they must be explicit, not inferred. */
export interface FamilyPackRule {
  packCountDeclared: boolean;
  packCount: number | null;
}

export type FamilyVariantRefusalCode =
  | 'family_rule_missing_invariant'
  | 'family_rule_invariant_conflict'
  | 'family_rule_duplicate_size'
  | 'family_rule_ambiguous_unit'
  | 'family_rule_undeclared_pack'
  | 'family_rule_type_authority_mismatch'
  | 'family_rule_type_authority_missing'
  | 'family_rule_unknown_rule'
  | 'family_rule_type_not_applicable'
  | 'family_rule_unsupported_axis'
  | 'family_rule_duplicate_variant'
  | 'family_rule_missing_variant'
  | 'family_rule_incomparable_order'
  | 'family_rule_too_few_members';

export interface FamilyVariantRuleDefinition {
  version: FamilyVariantRuleVersion;
  /** Canonical Product Type ids this rule applies to; food rule binds by reviewed hash only. */
  productTypeIds: ReadonlyArray<string>;
  requiredEvidence: ReadonlyArray<string>;
  normalization: string;
  labelOrder: ReadonlyArray<string>;
  displayOrder: ReadonlyArray<string>;
}

/**
 * Resolve the approved versioned Family Variant Rule for a canonical
 * Product Type identity (#372). Returns null when no configured rule
 * applies — callers must refuse family formation (standalone listing
 * remains possible), never invent a rule.
 */
export function resolveFamilyVariantRule(
  productTypeId: string | null | undefined,
  preferredVersion?: FamilyVariantRuleVersion | string | null,
): FamilyVariantRuleDefinition | null {
  if (typeof productTypeId !== 'string' || productTypeId.length === 0) return null;
  const applicable = (Object.keys(NON_FOOD_FAMILY_RULE_PRODUCT_TYPES) as Array<Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>>)
    .filter((version) => NON_FOOD_FAMILY_RULE_PRODUCT_TYPES[version].includes(productTypeId));
  if (applicable.length === 0) return null;
  // Preserve the selected applicable rule (#372): when the staged rule
  // version still applies to the member's type, keep it — a max-axes
  // preference would otherwise force freshness to reject valid count or
  // size/count plans for types that also declare the triple rule.
  const preferred = typeof preferredVersion === 'string' && (applicable as ReadonlyArray<string>).includes(preferredVersion)
    ? (preferredVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>)
    : null;
  // Otherwise resolve deterministically: the most specific combination
  // rule (size/color over size-only) so a type declaring both resolves
  // without invention.
  const version = preferred ?? [...applicable].sort((a, b) => NON_FOOD_FAMILY_PERMITTED_AXES[b].length - NON_FOOD_FAMILY_PERMITTED_AXES[a].length)[0]!;
  if (!version) return null;
  const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[version];
  return {
    version,
    productTypeIds: NON_FOOD_FAMILY_RULE_PRODUCT_TYPES[version],
    requiredEvidence: ['reviewed_product_type', 'sku_local_identity', 'permitted_axis_evidence'],
    normalization: 'trim-casefold-collapse',
    labelOrder: [...NON_FOOD_FAMILY_LABEL_ORDER[version]],
    displayOrder: [...permitted],
  };
}

export type FamilyVariantEvaluation =
  | { ok: true; ruleVersion: FamilyVariantRuleVersion; memberCount: number }
  | { ok: false; code: FamilyVariantRefusalCode; reason: string; sku?: string };

/**
 * Normalize a free-text factor for comparison: trim + casefold + collapse
 * internal whitespace. Empty/blank normalizes to null (unknown).
 */
export function normalizeFamilyFactor(value: string | null | undefined): string | null {
  if (value == null) return null;
  const collapsed = String(value).trim().replace(/\s+/g, ' ').toLowerCase();
  return collapsed.length > 0 ? collapsed : null;
}

export interface JoinVariantTupleAxes {
  sizeRaw: string | null;
  ounces: number | null;
  retailUnit: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
}

/**
 * Canonical duplicate-tuple key for join discovery (#370). Unit-aware and
 * retail-unit inclusive: food identity is the converted ounce-equivalent +
 * normalized retail unit (so "5 lb" and "80 oz" collide, while equal
 * quantities with different declared retail units stay distinct). Raw size
 * spelling never participates. Non-food identity is the rule's permitted
 * axes only (size/color/count per the active rule version). Null means
 * unknown — unknown tuples are never equal, never flagged.
 */
export function canonicalJoinVariantTuple(
  ruleVersion: FamilyVariantRuleVersion,
  axes: JoinVariantTupleAxes,
): string | null {
  if (ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION) {
    if (axes.ounces == null || !Number.isFinite(axes.ounces)) return null;
    return `food|${axes.ounces}|${normalizeFamilyFactor(axes.retailUnit) ?? ''}`;
  }
  const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>];
  if (!permitted) return null;
  const parts: string[] = [];
  if (permitted.includes('size')) {
    const size = normalizeFamilyFactor(axes.sizeRaw);
    if (size === null) return null;
    parts.push(`size=${size}`);
  }
  if (permitted.includes('color')) {
    const color = normalizeFamilyFactor(axes.colorRaw);
    if (color === null) return null;
    parts.push(`color=${color}`);
  }
  if (permitted.includes('count')) {
    const quantity = axes.countQuantity ?? null;
    const count = quantity != null && Number.isFinite(quantity) ? String(quantity) : normalizeFamilyFactor(axes.countRaw);
    if (count === null) return null;
    parts.push(`count=${count}`);
  }
  return `nf|${ruleVersion}|${parts.join('|')}`;
}

/**
 * Evaluate one candidate family against the versioned food rule. Pure and
 * deterministic: identical factor inputs always yield the identical verdict.
 *
 * Refusals (fail closed):
 * - <2 members; missing invariants are UNKNOWN (refuse, never coerce);
 *   conflicting invariants across members refuse; duplicate identical
 *   verified size tuples refuse; undeclared pack differences refuse;
 *   unverified/incomparable package sizes refuse with
 *   `family_rule_ambiguous_unit` (acceptance needs verified quantities for
 *   every member; the nomination helper below additionally requires
 *   comparability for automatic main selection); missing/mismatched
 *   reviewed-type authority refuses.
 *
 * Deliberately no `family_rule_unsupported_axis` code: the only
 * non-invariant inputs are the approved qualifying axes (package size,
 * retail unit) plus the explicit pack rule, so there is no other axis to
 * refuse on. All other per-SKU attributes (name, price, stock, images,
 * facts, classifications, filenames, enablement) stay SKU-local and
 * independent by construction, never compared.
 */
export function evaluateFamilyVariantRule(
  members: ReadonlyArray<{ sku: string; factors: FamilyVariantFactors; pack?: FamilyPackRule }>,
): FamilyVariantEvaluation {
  if (members.length < 2) {
    return {
      ok: false,
      code: 'family_rule_too_few_members',
      reason: `A new food family needs at least 2 distinct real size SKUs (got ${members.length}).`,
    };
  }
  const first = members[0]!.factors;
  for (const axis of FAMILY_INVARIANT_AXES) {
    const base = normalizeFamilyFactor(first[axis]);
    if (base === null) {
      return {
        ok: false,
        code: 'family_rule_missing_invariant',
        reason: `Invariant "${axis}" is unknown for SKU "${members[0]!.sku}"; missing invariants are unknown, never assumed.`,
        sku: members[0]!.sku,
      };
    }
  }
  for (const member of members) {
    for (const axis of FAMILY_INVARIANT_AXES) {
      const base = normalizeFamilyFactor(first[axis]);
      const mine = normalizeFamilyFactor(member.factors[axis]);
      if (mine === null) {
        return {
          ok: false,
          code: 'family_rule_missing_invariant',
          reason: `Invariant "${axis}" is unknown for SKU "${member.sku}"; missing invariants are unknown, never assumed.`,
          sku: member.sku,
        };
      }
      if (mine !== base) {
        return {
          ok: false,
          code: 'family_rule_invariant_conflict',
          reason: `Invariant "${axis}" conflicts across the family ("${first[axis]}" vs "${member.factors[axis]}" at SKU "${member.sku}"); different recipe/flavor/species/life-stage/form are separate families.`,
          sku: member.sku,
        };
      }
    }
    if (!member.factors.packageSize || member.factors.packageSize.ounces == null) {
      return {
        ok: false,
        code: 'family_rule_ambiguous_unit',
        reason: `SKU "${member.sku}" has no verified comparable package size; acceptance needs verified quantities for every member.`,
        sku: member.sku,
      };
    }
    const pack = member.pack;
    if (pack && pack.packCount != null && !pack.packCountDeclared) {
      return {
        ok: false,
        code: 'family_rule_undeclared_pack',
        reason: `SKU "${member.sku}" carries an undeclared pack difference; pack differences must be explicitly declared, never inferred.`,
        sku: member.sku,
      };
    }
    const typeHash = member.factors.reviewedTypeHash;
    if (typeHash === null || typeHash.length === 0) {
      return {
        ok: false,
        code: 'family_rule_type_authority_missing',
        reason: `SKU "${member.sku}" has no reviewed Product Type authority; families bind to current reviewed type authority.`,
        sku: member.sku,
      };
    }
  }
  const firstType = members[0]!.factors.reviewedTypeHash;
  for (const member of members.slice(1)) {
    if (member.factors.reviewedTypeHash !== firstType) {
      return {
        ok: false,
        code: 'family_rule_type_authority_mismatch',
        reason: `SKU "${member.sku}" binds a different reviewed Product Type authority; families share one reviewed type.`,
        sku: member.sku,
      };
    }
  }
  // Undeclared retailUnit refusal (#372): a known retail unit on one member
  // and an unknown unit on another is an ambiguous qualifying difference —
  // refuse closed rather than treat unknown as equal-or-different.
  const retailUnits = members.map((m) => normalizeFamilyFactor(m.factors.retailUnit));
  const hasKnown = retailUnits.some((u) => u !== null);
  const hasUnknown = retailUnits.some((u) => u === null);
  if (hasKnown && hasUnknown) {
    const bad = members.find((m) => normalizeFamilyFactor(m.factors.retailUnit) === null)!;
    return {
      ok: false,
      code: 'family_rule_ambiguous_unit',
      reason: `SKU "${bad.sku}" has no evidenced retail unit while other members declare one; undeclared retail units refuse acceptance.`,
      sku: bad.sku,
    };
  }
  // Canonical duplicate identity: converted ounce-equivalent plus the
  // rule's explicitly declared retail/pack tuple. Display wording (raw
  // spelling) never participates — "5 lb" and "80 oz" with identical
  // retail-unit and pack evidence collide and refuse as duplicates.
  const seenSizes = new Map<string, string>();
  for (const member of members) {
    const size = member.factors.packageSize!;
    const retail = normalizeFamilyFactor(member.factors.retailUnit) ?? '';
    const packDeclared = member.pack?.packCountDeclared === true ? 'declared' : 'none';
    const packCount = member.pack?.packCount ?? '';
    const key = `${size.ounces}|${retail}|${packDeclared}|${packCount}`;
    const prior = seenSizes.get(key);
    if (prior) {
      return {
        ok: false,
        code: 'family_rule_duplicate_size',
        reason: `SKUs "${prior}" and "${member.sku}" carry the same verified size tuple; duplicate tuples refuse acceptance.`,
        sku: member.sku,
      };
    }
    seenSizes.set(key, member.sku);
  }
  return { ok: true, ruleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION, memberCount: members.length };
}
/**
 * Evaluate one candidate family against an approved non-food rule (#372).
 * Pure and deterministic: identical factor inputs always yield the
 * identical verdict. Fails closed on unknown rules, undeclared types,
 * missing/conflicting invariants (brand/model/material/function/
 * safetyDose/strength/fit), undeclared-axis differences, missing or
 * duplicate variant tuples, ambiguous counts, and missing/mismatched
 * reviewed-type authority.
 */
export function evaluateNonFoodFamilyVariantRule(
  ruleVersion: FamilyVariantRuleVersion,
  members: ReadonlyArray<{ sku: string; factors: NonFoodFamilyVariantFactors; pack?: FamilyPackRule }>,
): FamilyVariantEvaluation {
  if (ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION) {
    return {
      ok: false,
      code: 'family_rule_unknown_rule',
      reason: 'Food members must use the food rule evaluator; non-food evaluation requires a non-food rule version.',
    };
  }
  if (members.length < 2) {
    return {
      ok: false,
      code: 'family_rule_too_few_members',
      reason: `A new non-food family needs at least 2 distinct real member SKUs (got ${members.length}).`,
    };
  }
  const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[ruleVersion];
  if (!permitted) {
    return {
      ok: false,
      code: 'family_rule_unknown_rule',
      reason: `No approved Family Variant Rule "${String(ruleVersion)}"; undeclared rules never form families.`,
    };
  }
  const declaredTypes = NON_FOOD_FAMILY_RULE_PRODUCT_TYPES[ruleVersion];
  const first = members[0]!.factors;
  for (const member of members) {
    const typeId = member.factors.reviewedProductTypeId;
    if (typeId === null || typeId.length === 0) {
      return {
        ok: false,
        code: 'family_rule_type_authority_missing',
        reason: `SKU "${member.sku}" has no reviewed Product Type identity; non-food families bind to a configured canonical type.`,
        sku: member.sku,
      };
    }
    if (!declaredTypes.includes(typeId)) {
      return {
        ok: false,
        code: 'family_rule_type_not_applicable',
        reason: `SKU "${member.sku}" type "${typeId}" is not declared for rule "${ruleVersion}"; unknown/undeclared types never resolve a rule.`,
        sku: member.sku,
      };
    }
    const typeHash = member.factors.reviewedTypeHash;
    if (typeHash === null || typeHash.length === 0) {
      return {
        ok: false,
        code: 'family_rule_type_authority_missing',
        reason: `SKU "${member.sku}" has no reviewed Product Type authority; families bind to current reviewed type authority.`,
        sku: member.sku,
      };
    }
  }
  const firstType = members[0]!.factors.reviewedTypeHash;
  for (const member of members.slice(1)) {
    if (member.factors.reviewedTypeHash !== firstType) {
      return {
        ok: false,
        code: 'family_rule_type_authority_mismatch',
        reason: `SKU "${member.sku}" binds a different reviewed Product Type authority; families share one reviewed type.`,
        sku: member.sku,
      };
    }
  }
  for (const axis of NON_FOOD_FAMILY_INVARIANT_AXES) {
    const base = normalizeFamilyFactor(first[axis]);
    if (base === null) {
      return {
        ok: false,
        code: 'family_rule_missing_invariant',
        reason: `Invariant "${axis}" is unknown for SKU "${members[0]!.sku}"; missing invariants are unknown, never assumed.`,
        sku: members[0]!.sku,
      };
    }
  }
  for (const member of members) {
    for (const axis of NON_FOOD_FAMILY_INVARIANT_AXES) {
      const base = normalizeFamilyFactor(first[axis]);
      const mine = normalizeFamilyFactor(member.factors[axis]);
      if (mine === null) {
        return {
          ok: false,
          code: 'family_rule_missing_invariant',
          reason: `Invariant "${axis}" is unknown for SKU "${member.sku}"; missing invariants are unknown, never assumed.`,
          sku: member.sku,
        };
      }
      if (mine !== base) {
        return {
          ok: false,
          code: 'family_rule_invariant_conflict',
          reason: `Invariant "${axis}" conflicts across the family ("${first[axis]}" vs "${member.factors[axis]}" at SKU "${member.sku}"); material/function/safety-dose/strength/fit differences are separate products.`,
          sku: member.sku,
        };
      }
    }
    if (permitted.includes('size') && normalizeFamilyFactor(member.factors.size) === null) {
      return {
        ok: false,
        code: 'family_rule_missing_variant',
        reason: `SKU "${member.sku}" has no verified size value; the rule requires an explicit size per member.`,
        sku: member.sku,
      };
    }
    if (permitted.includes('color') && normalizeFamilyFactor(member.factors.color) === null) {
      return {
        ok: false,
        code: 'family_rule_missing_variant',
        reason: `SKU "${member.sku}" has no verified color value; the rule requires an explicit color per member.`,
        sku: member.sku,
      };
    }
    if (permitted.includes('count')) {
      const count = member.factors.count;
      if (!count || normalizeFamilyFactor(count.raw) === null) {
        return {
          ok: false,
          code: 'family_rule_missing_variant',
          reason: `SKU "${member.sku}" has no verified count value; the rule requires an explicit count per member.`,
          sku: member.sku,
        };
      }
      if (count.quantity == null) {
        return {
          ok: false,
          code: 'family_rule_ambiguous_unit',
          reason: `SKU "${member.sku}" count "${count.raw}" is ambiguous; acceptance needs verified quantities for every member.`,
          sku: member.sku,
        };
      }
      const pack = member.pack;
      if (!pack || pack.packCount == null || !pack.packCountDeclared) {
        return {
          ok: false,
          code: 'family_rule_undeclared_pack',
          reason: `SKU "${member.sku}" carries count without an explicit pack declaration; count differences must be explicitly declared, never inferred.`,
          sku: member.sku,
        };
      }
    } else {
      // Pack invariants hold under every rule (#372): a member that
      // evidences a pack declaration outside a count rule still needs an
      // explicit declaration — pack counts are never inferred — and a
      // declared pack count that differs across members is an undeclared
      // axis difference under a size/color-only rule.
      const pack = member.pack;
      if (pack && pack.packCount != null && !pack.packCountDeclared) {
        return {
          ok: false,
          code: 'family_rule_undeclared_pack',
          reason: `SKU "${member.sku}" carries an undeclared pack difference; pack differences must be explicitly declared, never inferred.`,
          sku: member.sku,
        };
      }
    }
  }
  // Retail-unit evidence threads under every non-food rule (#372): a
  // declared unit on one member and an unknown/undeclared unit on another
  // is an ambiguous qualifying difference — refuse closed rather than
  // treat unknown as equal-or-different. Retail unit is a non-applicable
  // axis under every approved non-food rule (declared in the rule
  // configuration): two DECLARED but differing units are an undeclared
  // structural variation — refuse as an unsupported axis, never pass.
  const retailUnits = members.map((m) => normalizeFamilyFactor(m.factors.retailUnit));
  if (retailUnits.some((u) => u !== null) && retailUnits.some((u) => u === null)) {
    const bad = members.find((m) => normalizeFamilyFactor(m.factors.retailUnit) === null)!;
    return {
      ok: false,
      code: 'family_rule_ambiguous_unit',
      reason: `SKU "${bad.sku}" has no evidenced retail unit while other members declare one; undeclared retail units refuse acceptance.`,
      sku: bad.sku,
    };
  }
  const declaredUnits = new Set(retailUnits.filter((u): u is string => u !== null));
  if (declaredUnits.size > 1) {
    const bad = members.find((m) => normalizeFamilyFactor(m.factors.retailUnit) !== [...declaredUnits][0])!;
    return {
      ok: false,
      code: 'family_rule_unsupported_axis',
      reason: `SKU "${bad.sku}" varies on non-applicable axis "retailUnit" ("${[...declaredUnits].join('" vs "')}"); rule "${ruleVersion}" declares retail-unit differences non-applicable — separate families.`,
      sku: bad.sku,
    };
  }
  // Declared pack counts that differ across members are an undeclared
  // axis difference under any rule that does not permit count (#372):
  // size/color families accept undeclared differing pack counts otherwise.
  if (!permitted.includes('count')) {
    const declaredPacks: Record<string, true> = {};
    for (const member of members) {
      const pack = member.pack;
      if (pack && pack.packCountDeclared && pack.packCount != null) declaredPacks[String(pack.packCount)] = true;
    }
    if (Object.keys(declaredPacks).length > 1) {
      const bad = members.find((m) => m.pack?.packCountDeclared && m.pack?.packCount != null)!;
      return {
        ok: false,
        code: 'family_rule_unsupported_axis',
        reason: `SKU "${bad.sku}" differs on undeclared axis "count" (declared pack ${bad.pack?.packCount}); rule "${ruleVersion}" permits only ${permitted.join('/')}.`,
        sku: bad.sku,
      };
    }
  }
  const seenTuples = new Map<string, string>();
  for (const member of members) {
    const parts: string[] = [];
    if (permitted.includes('size')) parts.push(`size=${normalizeFamilyFactor(member.factors.size) ?? ''}`);
    if (permitted.includes('color')) parts.push(`color=${normalizeFamilyFactor(member.factors.color) ?? ''}`);
    if (permitted.includes('count')) parts.push(`count=${member.factors.count?.quantity ?? ''}`);
    if (!permitted.includes('size') && normalizeFamilyFactor(member.factors.size) !== normalizeFamilyFactor(first.size)) {
      return {
        ok: false,
        code: 'family_rule_unsupported_axis',
        reason: `SKU "${member.sku}" differs on undeclared axis "size"; rule "${ruleVersion}" permits only ${permitted.join('/')}.`,
        sku: member.sku,
      };
    }
    if (!permitted.includes('color') && normalizeFamilyFactor(member.factors.color) !== normalizeFamilyFactor(first.color)) {
      return {
        ok: false,
        code: 'family_rule_unsupported_axis',
        reason: `SKU "${member.sku}" differs on undeclared axis "color"; rule "${ruleVersion}" permits only ${permitted.join('/')}.`,
        sku: member.sku,
      };
    }
    if (!permitted.includes('count')) {
      const mine = member.factors.count ? String(member.factors.count.quantity ?? normalizeFamilyFactor(member.factors.count.raw) ?? '') : '';
      const base = first.count ? String(first.count.quantity ?? normalizeFamilyFactor(first.count.raw) ?? '') : '';
      if (mine !== base) {
        return {
          ok: false,
          code: 'family_rule_unsupported_axis',
          reason: `SKU "${member.sku}" differs on undeclared axis "count"; rule "${ruleVersion}" permits only ${permitted.join('/')}.`,
          sku: member.sku,
        };
      }
    }
    const key = parts.join('|');
    const prior = seenTuples.get(key);
    if (prior) {
      return {
        ok: false,
        code: 'family_rule_duplicate_variant',
        reason: `SKUs "${prior}" and "${member.sku}" carry the same verified variant tuple (${key || 'empty'}); duplicate tuples refuse acceptance.`,
        sku: member.sku,
      };
    }
    seenTuples.set(key, member.sku);
  }
  if (seenTuples.size < 2 && members.length >= 2) {
    return {
      ok: false,
      code: 'family_rule_duplicate_variant',
      reason: 'Members carry identical variant tuples; a family needs at least two distinct permitted-axis values.',
      sku: members[1]!.sku,
    };
  }
  return { ok: true, ruleVersion, memberCount: members.length };
}

/**
 * Nominate the main for a non-food family (#372): smallest verified
 * comparable member when the rule declares a size/count ordering with
 * verified quantities, else explicit operator selection. Color-only
 * families have no natural ordering — always selection_required.
 */
export function nominateNonFoodFamilyMain(
  ruleVersion: Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
  members: ReadonlyArray<{ sku: string; comparableQuantity: number | null }>,
): MainNomination {
  const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[ruleVersion] ?? [];
  const orderable = permitted.includes('size') || permitted.includes('count');
  if (!orderable) {
    return {
      kind: 'selection_required',
      reason: `Rule "${ruleVersion}" declares no comparable ordering; the operator must select the main explicitly.`,
    };
  }
  const comparable = members.filter(
    (m): m is { sku: string; comparableQuantity: number } =>
      m.comparableQuantity != null && Number.isFinite(m.comparableQuantity) && m.comparableQuantity > 0,
  );
  if (comparable.length === 0 || comparable.length < members.length) {
    return {
      kind: 'selection_required',
      reason: 'Incomparable member quantities require explicit operator main selection.',
    };
  }
  const sorted = [...comparable].sort((a, b) => a.comparableQuantity - b.comparableQuantity || (a.sku < b.sku ? -1 : 1));
  return { kind: 'nominated', sku: sorted[0]!.sku, ounces: sorted[0]!.comparableQuantity };
}

export type MainNomination =
  | { kind: 'nominated'; sku: string; ounces: number }
  | { kind: 'selection_required'; reason: string };

/**
 * Nominate the smallest verified comparable real member as the new Main
 * Product. Returns `selection_required` when sizes are incomparable (no
 * verified ounces) — the operator must select explicitly. Never invents a
 * display-only product, synthetic UPC, or replacement identity: the main
 * is always one of the real members.
 */
export function nominateFamilyMain(
  members: ReadonlyArray<{ sku: string; comparableOunces: number | null }>,
): MainNomination {
  const comparable = members.filter(
    (m): m is { sku: string; comparableOunces: number } =>
      m.comparableOunces != null && Number.isFinite(m.comparableOunces) && m.comparableOunces > 0,
  );
  if (comparable.length === 0) {
    return {
      kind: 'selection_required',
      reason: 'No member carries a verified comparable size; the operator must select the main explicitly.',
    };
  }
  if (comparable.length < members.length) {
    return {
      kind: 'selection_required',
      reason: `${members.length - comparable.length} member(s) lack a verified comparable size; the operator must select the main explicitly.`,
    };
  }
  const sorted = [...comparable].sort((a, b) => a.comparableOunces - b.comparableOunces || (a.sku < b.sku ? -1 : 1));
  return { kind: 'nominated', sku: sorted[0]!.sku, ounces: sorted[0]!.comparableOunces };
}
