import { randomUUID } from 'node:crypto';
import { GitClient } from '../git/git-client';
import { getDb } from '../db/connection';
import {
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  NON_FOOD_FAMILY_INVARIANT_AXES,
  NON_FOOD_FAMILY_PERMITTED_AXES,
  familyRuleConfigHashFor,
  normalizeFamilyFactor,
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
  validateNonFoodFamilyGroup,
  classifyClassifierFamilyWrite,
} from '../validation/storefront-family-validation';
import {
  createStorefrontFamilyPlan,
  findStorefrontFamilyPlanById,
  parseStorefrontFamilyPlan,
  updateStorefrontFamilyPlan,
  listStorefrontFamilyPlansForJoinCandidates,
  type StorefrontFamilyPlanRow,
} from '../db/repositories/storefront-family-plan-repo';
import {
  setManagedSubproducts,
  classifySubproductsSupport,
  nativeSkusInDocumentOrder,
  nativeStanzaMetadata,
} from '../shopsite/storefront-subproducts';
import { comparisonHashForProduct } from '../shopsite/catalog-comparison';
import { hashNativeReferences } from '../shopsite/product-codec';
import {
  createChangeSet,
  upsertChangeSetItem,
  listConflictingDraftChangeSets,
  findChangeSetById,
  listChangeSetItems,
} from '../db/repositories/change-set-repo';
import { listOutstandingDriftForSku } from '../db/repositories/drift-repo';
import { readProductFile } from '../git/workspace-files';
import { hashJson, deterministicStringify } from '../git/deterministic-json';
import { adjustProposalsForPreservedLabels } from './storefront-family-plan-service';
import { normalizeSkuMpn, tokenSet } from '../onboarding/variant-resolver';
import { normalizeGtin } from '../shared/gtin';
import { extractNameStem, normalizeBrand } from '../onboarding/product-line-grouper';
import { validateFamilyMemberOrigin } from './storefront-family-origin';
import type { FamilyMemberOrigin, StorefrontFamilyPlan, JoinOrigin } from '../shared/schemas/storefront-family';
import type { Product } from '../shared/types';

/**
 * Imported join discovery + staging + apply for reviewed existing families
 * (issue #370). Builds on #368 (new families) and #369 (adoption/edit):
 * an imported new size can join a reviewed existing family from an earlier
 * batch (or the approved catalog) without creating a competing family.
 *
 * Data-plane split: this module owns candidate discovery (deterministic,
 * high-recall, evidence-bound) plus join staging/review/apply. Semantic
 * assistance for ambiguous matches is the later TypeSafe ticket — here an
 * ambiguous match is an explicit operator resolution, never a judgment.
 *
 * Invariants (every one enforced closed):
 * - Same-SKU ambiguity goes to identity/duplicate resolution, never a
 *   duplicate product/file. Duplicate tuples refuse, never branch.
 * - Smaller imports never replace existing mains; missing rule/type
 *   authority stays unresolved rather than fabricated.
 * - Stale catalog/product/native/draft/conflict/drift blocks the whole
 *   plan; active drafts are never overwritten, competing families never
 *   silently reparented/merged.
 * - Review shows complete import+catalog membership, origins,
 *   invariants/axes, labels, native refs, read deps, and the exact write set.
 * - Accept/revise persists the full group transactionally (necessary writes
 *   only) and exports the exact approved group from an immutable commit.
 * - Reject/defer preserves relationships + standalone progress.
 */

// ─── Candidate discovery ────────────────────────────────────────────────────
// Searches the current import (onboarding rows/evidence) plus the approved
// catalog. Never a whole-catalog all-pairs model scan: every anchor is
// reached through a cheap equality key first (workspace/SKU identity,
// configured type/rule/brand blocking, legitimate source identifiers,
// high-recall name/model evidence). The existing stem grouper contributes
// candidates but never decides membership — and is never the only recall.
// Stem-only matches are ineligible as authority; they must corroborate with
// at least one other signal.

export type JoinCandidateSignal =
  | 'workspace_sku_identity'
  | 'source_identifier'
  | 'configured_block'
  | 'name_model_evidence'
  | 'stem_corroboration';

export interface JoinCandidate {
  sku: string;
  familyPlanId: string | null;
  familyMain: string | null;
  familyOrder: string[];
  familyRuleVersion: FamilyVariantRuleVersion | null;
  /** Why this anchor was considered: at least one non-stem signal required. */
  signals: JoinCandidateSignal[];
  /** Matched query terms (workspace SKU, source identifier, stem, tokens). */
  matchedOn: string[];
}

export interface ImportedJoinQuery {
  sku: string;
  /** Normalized workspace SKU (lowercased identity form). */
  normalizedSku: string;
  /** Legitimate source identifiers: gtin/upc/mpn/platform ids (normalized). */
  sourceIdentifiers: string[];
  brand: string | null;
  reviewedProductTypeId: string | null;
  ruleVersion: FamilyVariantRuleVersion | null;
  nameStem: string;
  nameTokens: string[];
  model: string | null;
}

export interface CatalogJoinAnchor {
  sku: string;
  familyPlanId: string | null;
  familyMain: string | null;
  familyOrder: string[];
  familyRuleVersion: FamilyVariantRuleVersion | null;
  normalizedSku: string;
  sourceIdentifiers: string[];
  blockingBrand: string;
  blockingTypeId: string;
  blockingRule: string;
  nameStem: string;
  nameTokens: string[];
  model: string | null;
  /** Same-SKU identity collision: same normalized SKU in import AND catalog. */
  sameSkuConflict: boolean;
  /** Duplicate variant tuple with an existing member (rule-evaluated). */
  duplicateTuple: boolean;
  /** Origin path of the catalog anchor: reviewed managed plan, live native ref, or catalog scan. */
  origin: 'managed_plan' | 'native_reference' | 'catalog_scan';
}

/** Workspace/SKU identity: NFKC trim + lowercase (same normalization as variant-resolver). */
export function normalizeWorkspaceSku(sku: string): string {
  return sku.normalize('NFKC').trim().toLowerCase();
}

function normalizeBrandKey(brand: string | null | undefined): string {
  if (!brand) return '';
  return normalizeBrand(brand).replace(/\s+/g, '');
}

function nameTokenSet(name: string | null | undefined): string[] {
  if (!name) return [];
  return [...tokenSet(name)].sort();
}

/** Build the import-side join query from eligible SKU-local evidence (never trusted blindly — caller binds reviewed authority). */
export function buildImportedJoinQuery(input: {
  sku: string;
  gtin?: string | null;
  upc?: string | null;
  mpn?: string | null;
  platformIds?: Array<string | null | undefined>;
  brand?: string | null;
  reviewedProductTypeId?: string | null;
  ruleVersion?: FamilyVariantRuleVersion | null;
  name?: string | null;
  model?: string | null;
}): ImportedJoinQuery {
  const identifiers: string[] = [];
  const gtin = normalizeGtin(input.gtin ?? input.upc ?? null);
  if (gtin) identifiers.push(`gtin:${gtin}`);
  const mpn = normalizeSkuMpn(input.mpn ?? null);
  if (mpn) identifiers.push(`mpn:${mpn}`);
  for (const platformId of input.platformIds ?? []) {
    const normalized = normalizeSkuMpn(platformId);
    if (normalized) identifiers.push(`platform:${normalized}`);
  }
  return {
    sku: input.sku,
    normalizedSku: normalizeWorkspaceSku(input.sku),
    sourceIdentifiers: identifiers.sort(),
    brand: input.brand?.trim() ? input.brand.trim() : null,
    reviewedProductTypeId: input.reviewedProductTypeId ?? null,
    ruleVersion: input.ruleVersion ?? null,
    nameStem: extractNameStem(input.name ?? null),
    nameTokens: nameTokenSet(input.name ?? null),
    model: input.model?.trim() ? input.model.trim() : null,
  };
}

/** Build a catalog-side anchor from an approved product + optional plan membership. */
export function buildCatalogJoinAnchor(input: {
  product: Product;
  familyPlanId?: string | null;
  familyMain?: string | null;
  familyOrder?: string[];
  familyRuleVersion?: FamilyVariantRuleVersion | null;
  gtin?: string | null;
  mpn?: string | null;
  reviewedProductTypeId?: string | null;
  model?: string | null;
  origin?: 'managed_plan' | 'native_reference' | 'catalog_scan';
}): CatalogJoinAnchor {
  const attrs = input.product.shopsite.preserved.rawAttributes ?? {};
  const identifiers: string[] = [];
  const rawGtin = typeof attrs['gtin'] === 'string' ? attrs['gtin'] : null;
  const gtin = normalizeGtin(rawGtin ?? input.gtin ?? null);
  if (gtin) identifiers.push(`gtin:${gtin}`);
  // MPN backfill (#370): the explicit mpn param wins; fall back to known
  // raw-attribute keys so older catalog rows without staged params still
  // block on legitimate source identifiers. MPN provenance stays distinct
  // from the model fallback: an MPN identical to the model is still a real
  // source identifier (MPN-only catalog records keep their recall signal),
  // while the absence of ANY mpn-sourced value yields no identifier — the
  // model string alone never mints one.
  const attrMpnRaw = ['mpn', 'MPN', 'manufacturerPartNumber', 'ManufacturerPartNumber']
    .map((k) => (typeof attrs[k] === 'string' ? (attrs[k] as string) : null))
    .find((v) => v != null && v.trim().length > 0) ?? null;
  const mpn = normalizeSkuMpn(input.mpn ?? attrMpnRaw);
  if (mpn) identifiers.push(`mpn:${mpn}`);
  return {
    sku: input.product.sku,
    familyPlanId: input.familyPlanId ?? null,
    familyMain: input.familyMain ?? null,
    familyOrder: input.familyOrder ? [...input.familyOrder] : [],
    familyRuleVersion: input.familyRuleVersion ?? null,
    normalizedSku: normalizeWorkspaceSku(input.product.sku),
    sourceIdentifiers: identifiers.sort(),
    blockingBrand: normalizeBrandKey(input.product.customFields['ProductField16'] ?? null),
    blockingTypeId: (input.reviewedProductTypeId ?? '').trim(),
    blockingRule: input.familyRuleVersion ?? '',
    nameStem: extractNameStem(input.product.core.name ?? null),
    nameTokens: nameTokenSet(input.product.core.name ?? null),
    model: input.model ?? (typeof attrs['nonFoodModel'] === 'string' ? attrs['nonFoodModel'] : null),
    sameSkuConflict: false,
    duplicateTuple: false,
    origin: input.origin ?? 'catalog_scan',
  };
}

function tokenRecall(query: string[], anchor: string[]): { overlap: number; union: number } {
  const anchorSet: Record<string, true> = {};
  for (const token of anchor) anchorSet[token] = true;
  let overlap = 0;
  for (const token of query) {
    if (anchorSet[token]) overlap += 1;
  }
  const unionSet: Record<string, true> = {};
  for (const token of query) unionSet[token] = true;
  for (const token of anchor) unionSet[token] = true;
  return { overlap, union: Object.keys(unionSet).length };
}

/**
 * Discover join candidates for one imported SKU against catalog anchors.
 * Cheap-key-first blocking: workspace/SKU identity, source identifiers,
 * configured type/rule/brand blocking, then high-recall name/model
 * evidence with the stem as corroboration only. Whole-catalog pairwise
 * model scans are structurally impossible here — every anchor is reached
 * through at least one equality key, and evidence collection is bounded.
 *
 * Returns candidates ordered deterministically (signal strength, then SKU).
 * Same-normalized-SKU import↔catalog collisions are flagged
 * `sameSkuConflict` (identity/duplicate resolution, never a merge).
 */
export function discoverJoinCandidates(
  query: ImportedJoinQuery,
  anchors: CatalogJoinAnchor[],
  options?: { maxCandidates?: number },
): JoinCandidate[] {
  const max = options?.maxCandidates ?? 16;
  const scored: Array<{ candidate: JoinCandidate; strength: number }> = [];
  for (const anchor of anchors) {
    const signals: JoinCandidateSignal[] = [];
    const matchedOn: string[] = [];
    // 1. Workspace/SKU identity (exact normalized match — strongest).
    if (anchor.normalizedSku === query.normalizedSku) {
      signals.push('workspace_sku_identity');
      matchedOn.push(`sku:${query.normalizedSku}`);
    }
    // 2. Legitimate source identifiers (gtin/mpn/platform).
    for (const identifier of query.sourceIdentifiers) {
      if (anchor.sourceIdentifiers.includes(identifier)) {
        if (!signals.includes('source_identifier')) signals.push('source_identifier');
        matchedOn.push(identifier);
      }
    }
    // 3. Configured type/rule/brand blocking (equality per axis).
    const queryBrand = normalizeBrandKey(query.brand);
    if (queryBrand && anchor.blockingBrand && queryBrand === anchor.blockingBrand) {
      signals.push('configured_block');
      matchedOn.push(`brand:${queryBrand}`);
    }
    if (query.reviewedProductTypeId && anchor.blockingTypeId && query.reviewedProductTypeId === anchor.blockingTypeId) {
      if (!signals.includes('configured_block')) signals.push('configured_block');
      matchedOn.push(`type:${query.reviewedProductTypeId}`);
    }
    if (query.ruleVersion && anchor.blockingRule && query.ruleVersion === anchor.blockingRule) {
      if (!signals.includes('configured_block')) signals.push('configured_block');
      matchedOn.push(`rule:${query.ruleVersion}`);
    }
    // 4. High-recall name/model evidence (token overlap + exact stem/model).
    let evidence = false;
    if (query.nameStem && anchor.nameStem && query.nameStem === anchor.nameStem) {
      evidence = true;
      matchedOn.push(`stem:${query.nameStem}`);
    }
    const recall = tokenRecall(query.nameTokens, anchor.nameTokens);
    // Token-gate tightening (#370): short names (union <= 4) need overlap 2+
    // (a single shared token like "acme" is not recall); longer names need
    // overlap 2+ with a bounded union (<= 10) so generic one-token overlap
    // never recalls. Single-token anchors never recall on tokens alone.
    const tightTokens = (recall.overlap >= 2 && recall.union <= 10)
      || (recall.overlap >= 3);
    if (tightTokens) {
      evidence = true;
      matchedOn.push(`tokens:${recall.overlap}/${recall.union}`);
    }
    if (query.model && anchor.model && normalizeFamilyFactor(query.model) === normalizeFamilyFactor(anchor.model)) {
      evidence = true;
      matchedOn.push(`model:${query.model.trim().toLowerCase()}`);
    }
    if (evidence) signals.push('name_model_evidence');
    // Stem-only matches are ineligible: the stem corroborates only alongside
    // a non-stem path — identity, source, configured block, or non-stem
    // token/model evidence. A stem-only anchor is dropped entirely (never the
    // only recall), so it can never reach proposal/Choice on stem alone.
    const stemOnly = matchedOn.length > 0 && matchedOn.every((m) => m.startsWith('stem:')) && signals.length === 1 && signals[0] === 'name_model_evidence';
    if (stemOnly) {
      continue;
    } else if (query.nameStem && anchor.nameStem && query.nameStem === anchor.nameStem && signals.length > 1) {
      signals.push('stem_corroboration');
    }
    // Catalog-scan bound (#370): a bare catalog_scan anchor (no reviewed
    // plan, no native refs) is the weakest recall — it must arrive through
    // an equality key (SKU identity, source identifier, or configured
    // type/rule/brand block). Name/model evidence alone never recalls a
    // catalog-scan row, so discovery stays equality-keyed, never an
    // unbounded name-similarity scan.
    if (anchor.origin === 'catalog_scan') {
      const hasKey = signals.includes('workspace_sku_identity')
        || signals.includes('source_identifier')
        || signals.includes('configured_block');
      if (!hasKey) continue;
    }
    if (signals.length === 0) continue;
    const strength =
      (signals.includes('workspace_sku_identity') ? 100 : 0) +
      (signals.includes('source_identifier') ? 50 : 0) +
      (signals.includes('configured_block') ? 20 : 0) +
      (signals.includes('name_model_evidence') ? 10 : 0) +
      (signals.includes('stem_corroboration') ? 1 : 0);
    scored.push({
      candidate: {
        sku: anchor.sku,
        familyPlanId: anchor.familyPlanId,
        familyMain: anchor.familyMain,
        familyOrder: [...anchor.familyOrder],
        familyRuleVersion: anchor.familyRuleVersion,
        signals: [...signals].sort(),
        matchedOn: [...matchedOn].sort(),
      },
      strength,
    });
  }
  scored.sort((a, b) => b.strength - a.strength || (a.candidate.sku < b.candidate.sku ? -1 : a.candidate.sku > b.candidate.sku ? 1 : 0));
  return scored.slice(0, Math.max(1, Math.min(64, max))).map((s) => s.candidate);
}

export interface ResolvedJoinCandidate extends JoinCandidate {
  /** Same-SKU collision: routes to identity/duplicate resolution, never a merge. */
  sameSku: boolean;
  /** Duplicate variant tuple with an existing member: refuse, never branch. */
  duplicateTuple: boolean;
  /** Candidate origin path: managed plan, live native ref, or catalog scan. */
  origin: 'managed_plan' | 'native_reference' | 'catalog_scan';
}

/**
 * Resolve discovered candidates to their disposition: same-SKU collisions
 * and duplicate tuples are flagged for explicit resolution (never merged),
 * competing families require explicit rejection, and only a single
 * unambiguous family target stages without operator choice.
 */
export function resolveJoinCandidates(input: {
  querySku: string;
  candidates: JoinCandidate[];
  anchorsBySku: Map<string, CatalogJoinAnchor>;
  rejectedFamilyIds?: string[];
  /**
   * Variant-tuple accessor (#370): when provided, anchors whose permitted-axis
   * tuple equals the query SKU's own tuple are flagged `duplicateTuple`
   * (refuse, never branch) — computed at resolution, never trusted from the
   * anchor's stored flag alone.
   */
  tupleOf?: (sku: string) => string | null;
}): { resolved: ResolvedJoinCandidate[]; ambiguous: boolean; reasons: string[] } {
  // Duplicate-tuple marking (#370): anchors whose permitted-axis tuple
  // collides (casefolded) with the query SKU's own tuple are flagged
  // duplicateTuple at resolution time (never merged, never branched) —
  // via the stored anchor flag OR a live tuple comparison when bound.
  const queryTuple = input.tupleOf?.(input.querySku) ?? null;
  const rejected: Record<string, true> = {};
  for (const id of input.rejectedFamilyIds ?? []) rejected[id] = true;
  const resolved: ResolvedJoinCandidate[] = input.candidates.map((candidate) => {
    const anchor = input.anchorsBySku.get(candidate.sku);
    return {
      ...candidate,
      sameSku: anchor?.sameSkuConflict || normalizeWorkspaceSku(candidate.sku) === normalizeWorkspaceSku(input.querySku),
      duplicateTuple: (anchor?.duplicateTuple ?? false) || (queryTuple !== null && (input.tupleOf?.(candidate.sku) ?? null) !== null && input.tupleOf!(candidate.sku) === queryTuple),
      origin: anchor?.origin ?? 'catalog_scan',
    };
  });
  const reasons: string[] = [];
  const viable = resolved.filter((c) => !c.sameSku && !c.duplicateTuple && !(c.familyPlanId && rejected[c.familyPlanId]));
  const families: Record<string, true> = {};
  for (const candidate of viable) {
    if (candidate.familyPlanId) families[candidate.familyPlanId] = true;
  }
  const ambiguous = Object.keys(families).length > 1;
  if (ambiguous) {
    reasons.push(`Imported SKU "${input.querySku}" matches ${Object.keys(families).length} competing families (${Object.keys(families).map((id) => `"${id.slice(0, 8)}"`).join(', ')}); reparenting/merging competing families requires explicit operator resolution — reject each competing family explicitly or resolve identity first.`);
  }
  const sameSku = resolved.filter((c) => c.sameSku);
  for (const collision of sameSku) {
    reasons.push(`SKU "${collision.sku}" collides with the approved catalog (same normalized SKU); same-SKU ambiguity routes to identity/duplicate resolution, never a duplicate product/file.`);
  }
  const dupes = resolved.filter((c) => c.duplicateTuple);
  for (const dupe of dupes) {
    reasons.push(`SKU "${dupe.sku}" duplicates an existing member variant tuple; duplicate tuples refuse acceptance, never branch.`);
  }
  return { resolved, ambiguous, reasons };
}

// ─── Join evidence + staging ─────────────────────────────────────────────────
// A join plan extends a reviewed existing family (earlier batch or catalog)
// with imported new size(s). The existing main/IDs/URL/members/order/labels
// are preserved verbatim unless an explicit reviewed diff authorizes the
// relevant change. Smaller imports never replace existing mains; missing
// invariant/rule/type authority stays unresolved (refuse, never fabricate).

export interface JoinMemberEvidence {
  sku: string;
  /** Approved-catalog base (null for genuinely new import SKUs). */
  base: Product | null;
  /** Staged draft base: the catalog base for existing members, a blank/evidence draft for imports. */
  draftBase: Product;
  purchasable: boolean;
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  sizeRaw: string;
  ounces: number | null;
  retailUnit: string | null;
  packCountDeclared: boolean;
  packCount: number | null;
  reviewedTypeHash: string;
  evidenceHash: string;
  /** Coarse review role; authority is exclusively the structured binding below. */
  origin: 'catalog' | 'import';
  sourceOrigin: FamilyMemberOrigin;
  productTypeId: string | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  colorRaw: string | null;
  countRaw: string | null;
  countQuantity: number | null;
}

export interface StageFamilyJoinInput {
  workspaceId: string;
  workspacePath: string;
  /** Target reviewed existing family plan (must be applied). */
  familyPlanId: string;
  /** Imported new sizes joining the family (≥1; the full group is still ≥2). */
  joinedSkus: string[];
  actor: string;
  /** Full-group evidence: existing members (catalog origin) + imports. */
  evidenceBySku: Map<string, JoinMemberEvidence>;
  /**
   * Competing families the operator explicitly reviewed and rejected.
   * Two different existing families matching the same import is a
   * conflicting-family proposal: the choice must be explicit, never a
   * merge/reparent. Each entry pins the exact rejected plan revision.
   */
  rejectedFamilies?: Array<{ planId: string; revision: number; ruleVersion: string; memberSkus: string[] }>;
  /** Explicit reviewed PF7 replacements (empty = preserve everything). */
  pf7Replacements?: Array<{ sku: string; shortName: string }>;
  /**
   * #371 accepted membership proposal this join was staged from. The
   * proposal disposes (which anchor the operator accepted); every hard
   * gate below still runs — the proposal never bypasses validation.
   */
  membershipProposal?: { proposalId: string; outcome: string; familyPlanId: string } | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function joinSubsetRefusalCode(code: string): string {
  if (code === 'family_rule_invariant_conflict' || code === 'family_rule_missing_invariant') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_duplicate_size' || code === 'family_rule_duplicate_variant') return 'FAMILY_DUPLICATE_VARIANT';
  if (code === 'family_rule_ambiguous_unit') return 'FAMILY_AMBIGUOUS_UNIT';
  if (code === 'family_rule_undeclared_pack') return 'FAMILY_UNDECLARED_PACK';
  if (code === 'family_rule_type_authority_mismatch' || code === 'family_rule_type_authority_missing') return 'FAMILY_TYPE_AUTHORITY_MISMATCH';
  if (code === 'family_rule_type_not_applicable') return 'FAMILY_RULE_NOT_APPLICABLE';
  if (code === 'family_rule_unknown_rule') return 'FAMILY_RULE_UNKNOWN';
  if (code === 'family_rule_missing_variant') return 'FAMILY_INVARIANT_CONFLICT';
  if (code === 'family_rule_unsupported_axis') return 'FAMILY_UNDECLARED_AXIS';
  if (code === 'family_rule_too_few_members') return 'FAMILY_TOO_FEW_MEMBERS';
  return 'FAMILY_RULE_REFUSED';
}

/** Refuse classifier-owned writes to join proposals (listing-owned, like #368 §7). */
export function classifyJoinFamilyWrite(targetId: string | null | undefined): { code: string; reason: string } | null {
  return classifyClassifierFamilyWrite(targetId);
}

/**
 * Stage a join plan: imported new size(s) join a reviewed existing family.
 * Fails closed on every rule/type/evidence/identity violation; creates no
 * display-only products, synthetic UPCs, or replacement identities.
 */
export function stageFamilyJoin(input: StageFamilyJoinInput): { row: StorefrontFamilyPlanRow; plan: StorefrontFamilyPlan } {
  const familyRow = findStorefrontFamilyPlanById(input.familyPlanId);
  if (!familyRow || familyRow.workspaceId !== input.workspaceId) {
    throw new Error(`family_join_no_target: no reviewed family plan "${input.familyPlanId}" in this workspace; joins extend an existing family, never invent one.`);
  }
  let family: StorefrontFamilyPlan;
  try {
    family = parseStorefrontFamilyPlan(familyRow.planJson);
  } catch {
    throw new Error(`family_join_target_unreadable: the target family plan "${input.familyPlanId}" is corrupt and unreadable; re-stage before joining.`);
  }
  if (familyRow.status !== 'applied' || family.status !== 'applied' || !family.appliedCommit) {
    throw new Error(`family_join_target_unapplied: joins extend a fully approved family with a finalized commit (target is "${familyRow.status}"); approve the family first.`);
  }
  if (family.membershipChange) {
    throw new Error('family_join_target_changed: the target family carries a reviewed membership revision; joins extend the current membership — re-resolve against it first.');
  }
  const existingSkus = [...family.memberSkus].sort();
  const joinedSorted = [...new Set(input.joinedSkus)].sort();
  if (joinedSorted.length === 0) {
    throw new Error('family_rule_too_few_members: a join needs at least 1 imported new size SKU.');
  }
  if (joinedSorted.length !== input.joinedSkus.length) {
    throw new Error('family_rule_duplicate_size: duplicate joined SKUs refuse staging.');
  }
  for (const sku of joinedSorted) {
    if (existingSkus.includes(sku)) {
      throw new Error(`family_join_same_sku: SKU "${sku}" is already a member of the target family; same-SKU ambiguity routes to identity/duplicate resolution, never a duplicate member.`);
    }
  }
  const groupSkus = [...existingSkus, ...joinedSorted].sort();
  for (const sku of groupSkus) {
    const evidence = input.evidenceBySku.get(sku);
    if (!evidence) throw new Error(`family_member_unresolved: SKU "${sku}" has no current eligible SKU-local evidence.`);
    if ((evidence.origin === 'catalog') !== (evidence.sourceOrigin.kind === 'catalog') ||
      (evidence.origin === 'import') !== (evidence.sourceOrigin.kind === 'onboarding')) {
      throw new Error(`family_origin_role_mismatch: SKU "${sku}" review role does not match its structured source origin.`);
    }
    if (joinedSorted.includes(sku) && evidence.origin === 'import' && evidence.base !== null) {
      throw new Error(`family_join_same_sku: joined SKU "${sku}" already has an approved catalog base; same-SKU ambiguity routes to identity/duplicate resolution, never a duplicate product/file.`);
    }
    if ((existingSkus.includes(sku) && (evidence.origin !== 'catalog' || !evidence.base)) ||
      (joinedSorted.includes(sku) && (evidence.origin !== 'import' || evidence.base !== null))) {
      throw new Error(`family_origin_role_mismatch: SKU "${sku}" has an origin/base inconsistent with its existing or incoming join role.`);
    }
    if (!evidence.purchasable) throw new Error(`family_not_purchasable: SKU "${sku}" is not a real purchasable size SKU.`);
    if (!evidence.reviewedTypeHash || !evidence.evidenceHash) {
      throw new Error(`family_member_unresolved: SKU "${sku}" lacks reviewed type/evidence authority.`);
    }
    const support = classifySubproductsSupport(evidence.draftBase);
    if (support.code !== 'supported_absent' && support.code !== 'supported_unmanaged_simple' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${sku}" keeps its unsafe native Subproducts structure preserved and unadopted (${support.code}: ${support.detail})`);
    }
  }
  // Origin discipline: joined SKUs are imports without an approved base;
  // existing members keep their approved base. A joined SKU WITH an
  // approved base is same-SKU ambiguity (update path), not a join-create.
  const ambiguous: string[] = [];
  for (const sku of joinedSorted) {
    if (input.evidenceBySku.get(sku)!.base) ambiguous.push(sku);
  }
  if (ambiguous.length > 0) {
    throw new Error(`family_join_same_sku: joined SKU(s) (${ambiguous.join(', ')}) already exist in the approved catalog; same-SKU ambiguity routes to identity/duplicate resolution, never a duplicate product/file.`);
  }
  // Competing families: any OTHER applied family touching a joined SKU
  // (by member URI or live native reference) requires explicit rejection.
  // Non-applied plans (proposed/revised/rejected/deferred/stale) never
  // compete: only an applied family owns managed membership. The target's
  // own join lineage never competes: an applied join whose
  // joinOrigin.familyPlanId is this target re-stages cleanly (same join,
  // same target — no reparenting/merge involved). Unreadable rows stay
  // competing (fail closed).
  const competing = listStorefrontFamilyPlansForJoinCandidates(input.workspaceId, joinedSorted)
    .filter((row) => {
      if (row.id === input.familyPlanId || row.status !== 'applied') return false;
      try {
        if (parseStorefrontFamilyPlan(row.planJson).joinOrigin?.familyPlanId === input.familyPlanId) return false;
      } catch {
        return true;
      }
      return true;
    });
  const rejectedIds = new Set((input.rejectedFamilies ?? []).map((r) => r.planId));
  const unresolved = competing.filter((row) => !rejectedIds.has(row.id));
  if (unresolved.length > 0) {
    const describe = unresolved.map((row) => {
      try {
        const peer = parseStorefrontFamilyPlan(row.planJson);
        return `"${row.id.slice(0, 8)}" (${peer.memberSkus.join(', ')})`;
      } catch {
        return `"${row.id.slice(0, 8)}" (unreadable)`;
      }
    });
    throw new Error(`family_join_competing_family: joined SKU(s) also belong to family/families ${describe.join('; ')}; reparenting/merging competing families requires explicit review — reject each competing family explicitly or resolve identity first.`);
  }
  // Pinned rejected-family revisions must still match (exact evidence/rule
  // revisions — reviewed negatives stay attached to their revisions).
  for (const rejected of input.rejectedFamilies ?? []) {
    const row = findStorefrontFamilyPlanById(rejected.planId);
    if (!row || row.workspaceId !== input.workspaceId) {
      throw new Error(`family_join_rejection_unresolvable: rejected family "${rejected.planId}" is unresolvable in this workspace.`);
    }
    let peer: StorefrontFamilyPlan;
    try {
      peer = parseStorefrontFamilyPlan(row.planJson);
    } catch {
      throw new Error(`family_join_rejection_unreadable: rejected family "${rejected.planId}" is unreadable; re-resolve before joining.`);
    }
    if (peer.revision !== rejected.revision || peer.ruleVersion !== rejected.ruleVersion || peer.memberSkus.join(',') !== [...rejected.memberSkus].sort().join(',')) {
      throw new Error(`family_join_rejection_stale: rejected family "${rejected.planId}" moved since review (revision/rule/members differ); re-review the competing family before joining.`);
    }
  }
  const ruleVersion = family.ruleVersion;
  const isFood = ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
  // Whole-group rule conformance under the family's approved rule: the full
  // group (existing + joined) must satisfy the rule — missing
  // invariant/rule/type authority stays unresolved (refuse), never
  // fabricated, and the whole catalog is never reclassified for a join.
  if (isFood) {
    const factors = groupSkus.map((sku) => {
      const evidence = input.evidenceBySku.get(sku)!;
      return {
        sku,
        factors: {
          brand: evidence.brand, recipe: evidence.recipe, flavor: evidence.flavor,
          species: evidence.species, lifeStage: evidence.lifeStage, form: evidence.form,
          packageSize: { raw: evidence.sizeRaw, ounces: evidence.ounces },
          retailUnit: evidence.retailUnit, comparableOunces: evidence.ounces,
          reviewedTypeHash: evidence.reviewedTypeHash,
        } satisfies FamilyVariantFactors,
        pack: { packCountDeclared: evidence.packCountDeclared, packCount: evidence.packCount },
      };
    });
    const verdict = evaluateFamilyVariantRule(factors);
    if (!verdict.ok) throw new Error(`${joinSubsetRefusalCode(verdict.code)}: ${verdict.reason}`);
  } else {
    const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>];
    if (!permitted) throw new Error(`family_join_rule_unknown: no approved Family Variant Rule "${String(ruleVersion)}"; undeclared rules never form families.`);
    const factors = groupSkus.map((sku) => {
      const evidence = input.evidenceBySku.get(sku)!;
      return {
        sku,
        factors: {
          brand: evidence.brand, model: evidence.model, material: evidence.material,
          function: evidence.function, safetyDose: evidence.safetyDose, strength: evidence.strength,
          fit: evidence.fit, size: evidence.sizeRaw, color: evidence.colorRaw,
          count: evidence.countRaw != null ? { raw: evidence.countRaw, quantity: evidence.countQuantity ?? null } : null,
          reviewedTypeHash: evidence.reviewedTypeHash,
          reviewedProductTypeId: evidence.productTypeId,
        } satisfies NonFoodFamilyVariantFactors,
        pack: { packCountDeclared: evidence.packCountDeclared, packCount: evidence.packCount ?? null },
      };
    });
    const verdict = evaluateNonFoodFamilyVariantRule(ruleVersion, factors);
    if (!verdict.ok) throw new Error(`${joinSubsetRefusalCode(verdict.code)}: ${verdict.reason}`);
  }
  // Main preservation: the existing main stands — a smaller/newer import
  // never replaces it. (No nomination, no override on joins.)
  const mainSku = family.mainSku;
  if (!groupSkus.includes(mainSku)) {
    throw new Error(`family_join_main_missing: existing main "${mainSku}" is not in the joined group; joins never drop or replace the main.`);
  }
  // PF7: preserve every existing nonempty catalog label verbatim; derive
  // only for members without one. Explicit reviewed replacements arrive as
  // diffs (nonempty, unique, member-scoped) — never silent overwrites.
  const liveLabelBySku = new Map<string, string>();
  for (const sku of groupSkus) {
    const evidence = input.evidenceBySku.get(sku)!;
    const live = (evidence.base?.customFields['ProductField7'] ?? '').trim() || (evidence.draftBase.customFields['ProductField7'] ?? '').trim();
    if (live.length > 0) liveLabelBySku.set(sku, live);
  }
  const generated = isFood
    ? derivePf7ShortNames(groupSkus.map((sku) => {
        const evidence = input.evidenceBySku.get(sku)!;
        return { sku, sizeRaw: evidence.sizeRaw, ounces: evidence.ounces };
      }))
    : deriveNonFoodPf7ShortNames(
        ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
        groupSkus.map((sku) => {
          const evidence = input.evidenceBySku.get(sku)!;
          return { sku, sizeRaw: evidence.sizeRaw, colorRaw: evidence.colorRaw, countRaw: evidence.countRaw, countQuantity: evidence.countQuantity };
        }),
      );
  const proposals = adjustProposalsForPreservedLabels(generated, liveLabelBySku);
  const replacements = new Map((input.pf7Replacements ?? []).map((r) => [r.sku, r.shortName] as const));
  for (const [sku, shortName] of replacements) {
    if (!groupSkus.includes(sku)) throw new Error(`family_pf7_replacement_not_member: replacement for "${sku}" is not a member of the joined group.`);
    if (!shortName || shortName.trim().length === 0) throw new Error(`family_pf7_replacement_empty: replacement for "${sku}" is empty; replacements are explicit nonempty reviewed diffs.`);
  }
  const seenLabels: Record<string, true> = {};
  const pf7Proposals = proposals.map((proposal) => {
    const replacement = replacements.get(proposal.sku);
    const shortName = replacement?.trim() ?? proposal.shortName;
    const key = shortName.toLowerCase();
    if (seenLabels[key]) throw new Error(`family_pf7_duplicate: Short Name "${shortName}" is shared (ShopSite tag ProductField7); names must be unique across the joined family.`);
    seenLabels[key] = true;
    return { sku: proposal.sku, shortName, replaced: replacement !== undefined };
  });
  pf7Proposals.sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const drafts = groupSkus.map((sku) => input.evidenceBySku.get(sku)!.draftBase);
  const bases = groupSkus.map((sku) => input.evidenceBySku.get(sku)!.base).filter((b): b is Product => b !== null);
  const evidenceHashes = groupSkus.map((sku) => input.evidenceBySku.get(sku)!.evidenceHash);
  const foodFactorsForHash = groupSkus.map((sku) => {
    const evidence = input.evidenceBySku.get(sku)!;
    return {
      sku,
      factors: {
        brand: evidence.brand, recipe: evidence.recipe, flavor: evidence.flavor,
        species: evidence.species, lifeStage: evidence.lifeStage, form: evidence.form,
        packageSize: { raw: evidence.sizeRaw, ounces: evidence.ounces },
        retailUnit: evidence.retailUnit, comparableOunces: evidence.ounces,
        reviewedTypeHash: evidence.reviewedTypeHash,
      } satisfies FamilyVariantFactors,
      pack: { packCountDeclared: evidence.packCountDeclared, packCount: evidence.packCount },
    };
  });
  const nonFoodFactorsForHash = groupSkus.map((sku) => {
    const evidence = input.evidenceBySku.get(sku)!;
    return {
      sku,
      factors: {
        brand: evidence.brand, model: evidence.model, material: evidence.material,
        function: evidence.function, safetyDose: evidence.safetyDose, strength: evidence.strength,
        fit: evidence.fit, size: evidence.sizeRaw, color: evidence.colorRaw,
        count: evidence.countRaw != null ? { raw: evidence.countRaw, quantity: evidence.countQuantity ?? null } : null,
        reviewedTypeHash: evidence.reviewedTypeHash,
        reviewedProductTypeId: evidence.productTypeId,
      } satisfies NonFoodFamilyVariantFactors,
      pack: { packCountDeclared: evidence.packCountDeclared, packCount: evidence.packCount ?? null },
    };
  });
  const at = nowIso();
  const familyOrder = [...familyOrderOf(family), ...joinedSorted.filter((sku) => !familyOrderOf(family).includes(sku))];
  const joinOrigin: JoinOrigin = {
    kind: 'join_family',
    familyPlanId: family.id,
    familyMain: family.mainSku,
    familyOrder,
    joinedSkus: joinedSorted,
    rejectedFamilies: (input.rejectedFamilies ?? []).map((r) => ({
      planId: r.planId,
      revision: r.revision,
      ruleVersion: r.ruleVersion,
      memberSkus: [...r.memberSkus].sort(),
    })),
    memberNativeIds: groupSkus.map((sku) => {
      const source = input.evidenceBySku.get(sku)!.base ?? input.evidenceBySku.get(sku)!.draftBase;
      return {
        sku,
        name: source.core.name,
        productId: source.shopsite.productId,
        productGuid: source.shopsite.productGuid,
      };
    }),
    // Staged invariant-factor snapshot: the reviewed record review binds
    // first, so production review never depends on live-only fallback.
    stagedFactors: groupSkus.map((sku) => {
      const evidence = input.evidenceBySku.get(sku)!;
      return {
        sku,
        brand: evidence.brand,
        recipe: evidence.recipe,
        flavor: evidence.flavor,
        species: evidence.species,
        lifeStage: evidence.lifeStage,
        form: evidence.form,
        model: evidence.model,
        material: evidence.material,
        function: evidence.function,
        safetyDose: evidence.safetyDose,
        strength: evidence.strength,
        fit: evidence.fit,
      };
    }),
    stagedCatalogCommit: readHeadCommit(input.workspacePath),
    membershipProposalId: input.membershipProposal ? input.membershipProposal.proposalId : null,
    membershipProposalOutcome: input.membershipProposal ? (input.membershipProposal.outcome as JoinOrigin['membershipProposalOutcome']) : null,
  };
  const plan: StorefrontFamilyPlan = {
    id: randomUUID(),
    appliedAt: null,
    workspaceId: input.workspaceId,
    ruleVersion,
    planVersion: 'storefront-family-plan-v1',
    status: 'proposed',
    revision: 0,
    memberSkus: groupSkus,
    members: groupSkus.map((sku) => {
      const evidence = input.evidenceBySku.get(sku)!;
      return {
        sku,
        comparableOunces: evidence.countQuantity ?? evidence.ounces,
        sizeRaw: evidence.sizeRaw,
        retailUnit: evidence.retailUnit,
        packCountDeclared: evidence.packCountDeclared,
        packCount: evidence.packCount,
        reviewedTypeHash: evidence.reviewedTypeHash,
        origin: evidence.sourceOrigin,
        evidenceHash: evidence.evidenceHash,
        baseHash: evidence.base ? comparisonHashForProduct(evidence.base) : null,
        stagedLabel: null,
        productTypeId: evidence.productTypeId,
        model: evidence.model,
        material: evidence.material,
        function: evidence.function,
        safetyDose: evidence.safetyDose,
        strength: evidence.strength,
        fit: evidence.fit,
        colorRaw: evidence.colorRaw,
        countRaw: evidence.countRaw,
        countQuantity: evidence.countQuantity,
      };
    }),
    mainSku,
    mainOverridden: false,
    pf7Proposals,
    ruleHash: isFood ? familyRuleHashFor(foodFactorsForHash) : nonFoodFamilyRuleHashFor(ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>, nonFoodFactorsForHash),
    ruleConfigHash: familyRuleConfigHashFor(ruleVersion),
    evidenceHash: familyEvidenceHashFor(evidenceHashes),
    baseHash: familyBaseHashFor(bases),
    readHash: familyReadWriteHashFor(drafts).slice(0, 32),
    writeHash: familyReadWriteHashFor(drafts),
    linkedChangeSetId: null,
    decisions: [],
    createdAt: at,
    updatedAt: at,
    joinOrigin,
  };
  const row = createStorefrontFamilyPlan({ workspaceId: input.workspaceId, plan });
  return { row, plan };
}

function familyOrderOf(family: StorefrontFamilyPlan): string[] {
  if (family.joinOrigin) return [...family.joinOrigin.familyOrder];
  if (family.adoptionOrigin) return [...family.adoptionOrigin.nativeOrder];
  return [...family.memberSkus].sort();
}

/** Review view: complete import+catalog membership, origins, invariants/axes, labels, native refs, read deps, exact write set. */
export interface FamilyJoinReview {
  plan: StorefrontFamilyPlan;
  targetFamily: StorefrontFamilyPlan;
  joinOrigin: JoinOrigin;
  membership: Array<{
    sku: string;
    origin: 'catalog' | 'import';
    baseHash: string | null;
    reviewedTypeHash: string;
    evidenceHash: string;
  }>;
  invariantEvidence: Array<{ axis: string; value: string | null; agreed: boolean }>;
  varyingAxes: Array<{ sku: string; sizeRaw: string; ounces: number | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null }>;
  pf7BeforeAfter: Array<{ sku: string; before: string; after: string; replaced: boolean }>;
  nativeDiffs: Array<{ sku: string; beforeRefs: string[]; afterRefs: string[]; operation: 'create' | 'update' }>;
  readDependencies: string[];
  writeSet: Array<{ sku: string; operation: 'create' | 'update' }>;
  blockers: string[];
  /**
   * #371 TypeSafe proposal section (optional): truthful per-anchor outcomes
   * (selected/negative/no-fit/insufficient/overflow/service/disabled/stale).
   * Review binds this when the staging route supplies the linked proposal.
   * Absent = explicit manual join (no proposal), never a hidden inference.
   */
  membershipProposal?: {
    proposalId: string;
    outcome: string;
    status: string;
    judgments: Array<{ anchorSku: string; familyPlanId: string | null; outcome: string; reason: string }>;
    modelCallIds: string[];
    stale: boolean;
    staleReasons: string[];
  } | null;
}

export function reviewFamilyJoin(input: {
  planId: string;
  workspacePath: string;
  liveBySku: Map<string, Product | null>;
  /** Staged member evidence (preferred for invariant display; live fills gaps). */
  evidenceBySku?: Map<string, JoinMemberEvidence>;
  /** Current SKU-local evidence at review time (route binds readMemberRecord); live fills gaps. */
  currentEvidenceBySku?: Map<string, JoinMemberEvidence>;
  /** Competing-draft conflicts at review time (route binds listConflictingDraftChangeSets). */
  conflictingDrafts?: Array<{ changeSetId: string; sku: string; status: string }>;
  conflictingDraftError?: string | null;
  /** Open/reconciling drift at review time (route binds listOutstandingDriftForSku). */
  driftSkus?: string[];
  driftError?: string | null;
  /**
   * Competing families at review time (#370): OTHER applied plans touching a
   * joined SKU that were never explicitly rejected block the review (same
   * rule as staging — reparenting/merging competing families requires
   * explicit resolution). Route binds listStorefrontFamilyPlansForJoinCandidates.
   */
  competingFamilies?: Array<{ planId: string; memberSkus: string[] }>;
  competingFamiliesError?: string | null;
  /**
   * #371 linked membership proposal (route binds the proposal repo row).
   * Carries the truthful per-anchor outcomes + staleness computed by the
   * caller against current evidence/policy (this module stays storage-free).
   */
  membershipProposal?: FamilyJoinReview['membershipProposal'];
}): FamilyJoinReview {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  const joinOrigin = plan.joinOrigin;
  if (!joinOrigin) throw new Error(`family_join_not_join: plan "${input.planId}" carries no join origin.`);
  const targetRow = findStorefrontFamilyPlanById(joinOrigin.familyPlanId);
  if (!targetRow) throw new Error(`family_join_target_missing: target family "${joinOrigin.familyPlanId}" is unresolvable.`);
  const targetFamily = parseStorefrontFamilyPlan(targetRow.planJson);
  const blockers: string[] = [];
  const membership = plan.members.map((member) => {
    const joined = joinOrigin.joinedSkus.includes(member.sku);
    return {
      sku: member.sku,
      origin: (joined ? 'import' : 'catalog') as 'catalog' | 'import',
      baseHash: member.baseHash ?? null,
      reviewedTypeHash: member.reviewedTypeHash,
      evidenceHash: member.evidenceHash,
    };
  });
  const isFood = plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION;
  const invariantAxes: string[] = isFood
    ? ['brand', 'recipe', 'flavor', 'species', 'lifeStage', 'form']
    : [...NON_FOOD_FAMILY_INVARIANT_AXES];
  // Invariant/varying-axis evidence across the full group (existing + joined).
  // The staged snapshot stamped at stage time binds first (the reviewed
  // invariant record); current route-bound evidence fills next; live catalog
  // custom fields fill gaps (members without evidence). Null stays null —
  // never fabricated — and disagrees below.
  const snapshotBySku: Record<string, NonNullable<JoinOrigin['stagedFactors']>[number] | undefined> = {};
  for (const entry of joinOrigin.stagedFactors ?? []) snapshotBySku[entry.sku] = entry;
  const factorOf = (sku: string): Record<string, string | null> => {
    const snapshot = snapshotBySku[sku] ?? null;
    const staged = input.evidenceBySku?.get(sku) ?? null;
    const current = input.currentEvidenceBySku?.get(sku) ?? null;
    const live = input.liveBySku.get(sku) ?? null;
    const pick = (...candidates: Array<string | null>): string | null => {
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
      }
      return null;
    };
    if (isFood) {
      return {
        brand: pick(snapshot?.brand ?? null, staged?.brand ?? null, current?.brand ?? null, live?.customFields['ProductField16'] ?? null),
        recipe: pick(snapshot?.recipe ?? null, staged?.recipe ?? null, current?.recipe ?? null, live?.customFields['ProductField24'] ?? null),
        flavor: pick(snapshot?.flavor ?? null, staged?.flavor ?? null, current?.flavor ?? null, live?.customFields['ProductField23'] ?? null),
        species: pick(snapshot?.species ?? null, staged?.species ?? null, current?.species ?? null, live?.customFields['ProductField17'] ?? null),
        lifeStage: pick(snapshot?.lifeStage ?? null, staged?.lifeStage ?? null, current?.lifeStage ?? null, live?.customFields['ProductField18'] ?? null),
        form: pick(snapshot?.form ?? null, staged?.form ?? null, current?.form ?? null, live?.customFields['ProductField22'] ?? null),
      };
    }
    const stagedAttrs = staged?.draftBase.shopsite.preserved.rawAttributes ?? {};
    const currentAttrs = current?.draftBase.shopsite.preserved.rawAttributes ?? {};
    const stagedOf = (key: string): string | null => (typeof stagedAttrs[key] === 'string' ? (stagedAttrs[key] as string) : null);
    const currentOf = (key: string): string | null => (typeof currentAttrs[key] === 'string' ? (currentAttrs[key] as string) : null);
    return {
      brand: pick(snapshot?.brand ?? null, staged?.brand ?? null, current?.brand ?? null, live?.customFields['ProductField16'] ?? null),
      model: pick(snapshot?.model ?? null, staged?.model ?? stagedOf('nonFoodModel'), current?.model ?? currentOf('nonFoodModel'), null),
      material: pick(snapshot?.material ?? null, staged?.material ?? stagedOf('nonFoodMaterial'), current?.material ?? currentOf('nonFoodMaterial'), null),
      function: pick(snapshot?.function ?? null, staged?.function ?? stagedOf('nonFoodFunction'), current?.function ?? currentOf('nonFoodFunction'), null),
      safetyDose: pick(snapshot?.safetyDose ?? null, staged?.safetyDose ?? stagedOf('nonFoodSafetyDose'), current?.safetyDose ?? currentOf('nonFoodSafetyDose'), null),
      strength: pick(snapshot?.strength ?? null, staged?.strength ?? stagedOf('nonFoodStrength'), current?.strength ?? currentOf('nonFoodStrength'), null),
      fit: pick(snapshot?.fit ?? null, staged?.fit ?? stagedOf('nonFoodFit'), current?.fit ?? currentOf('nonFoodFit'), null),
    };
  };
  const invariantEvidence = invariantAxes.map((axis) => {
    const values = plan.memberSkus.map((sku) => {
      const value = factorOf(sku)[axis] ?? null;
      return value == null ? null : value.toLowerCase();
    });
    const first = values[0] ?? null;
    return { axis, value: first, agreed: first !== null && values.every((v) => v === first) };
  });
  // Varying-axis branches (#370 non-food): one row per permitted axis so
  // review shows exactly which axis varies (size vs color vs count) instead
  // of a joined string that hides the branch. Food keeps the single
  // size+ounces branch.
  const varyingAxes: Array<{ sku: string; sizeRaw: string; ounces: number | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null }> =
    plan.members.map((member) => {
      if (isFood) return { sku: member.sku, sizeRaw: member.sizeRaw ?? '', ounces: member.comparableOunces ?? null };
      const permitted = NON_FOOD_FAMILY_PERMITTED_AXES[plan.ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>] ?? [];
      const row: { sku: string; sizeRaw: string; ounces: number | null; colorRaw?: string | null; countRaw?: string | null; countQuantity?: number | null } =
        { sku: member.sku, sizeRaw: permitted.includes('size') ? (member.sizeRaw ?? '') : '', ounces: member.comparableOunces ?? null };
      if (permitted.includes('color')) row.colorRaw = member.colorRaw ?? null;
      if (permitted.includes('count')) {
        row.countRaw = member.countRaw ?? null;
        row.countQuantity = member.countQuantity ?? null;
      }
      return row;
    });
  const pf7BeforeAfter = plan.memberSkus.map((sku) => {
    const live = input.liveBySku.get(sku) ?? null;
    const before = (live?.customFields['ProductField7'] ?? '').trim();
    const after = plan.pf7Proposals.find((p) => p.sku === sku)?.shortName ?? '';
    return { sku, before, after, replaced: before.length > 0 && before !== after };
  });
  // Native diffs from materialized drafts (#370): the actual emitted
  // relationships — only the main emits the managed block; every other
  // member keeps its native posture. Operators review truthful diffs.
  const familyOrder = joinOrigin.familyOrder;
  const previewHostRaw = plan.memberSkus
    .map((sku) => input.liveBySku.get(sku) ?? null)
    .filter((p): p is Product => p !== null)
    .map((p) => rawOf(p))
    .find((raw) => raw.length > 0) ?? '';
  const previewNameBySku = new Map<string, string>();
  for (const sku of plan.memberSkus) {
    previewNameBySku.set(sku, input.liveBySku.get(sku)?.core.name ?? sku);
  }
  const materializedPreview = new Map<string, Product>();
  for (const sku of plan.memberSkus) {
    const source = input.evidenceBySku?.get(sku)?.draftBase ?? input.currentEvidenceBySku?.get(sku)?.draftBase ?? input.liveBySku.get(sku) ?? null;
    if (!source) continue;
    try {
      materializedPreview.set(sku, withJoinFamilyDraft(source, plan, [...familyOrder], previewHostRaw, previewNameBySku));
    } catch {
      continue;
    }
  }
  const nativeDiffs = plan.memberSkus.map((sku) => {
    const live = input.liveBySku.get(sku) ?? null;
    const beforeRefs = live ? nativeSkusInDocumentOrder(rawOf(live)) : [];
    const materialized = materializedPreview.get(sku) ?? null;
    const afterRefs = materialized ? nativeSkusInDocumentOrder(rawOf(materialized)) : (sku === plan.mainSku ? [...familyOrder] : [...beforeRefs]);
    return {
      sku,
      beforeRefs,
      afterRefs,
      operation: (live ? 'update' : 'create') as 'create' | 'update',
    };
  });
  // Read dependencies (#370): unchanged members flow through the linked
  // approval/export dependency contract (member refs carried on live blocks
  // that this plan does not rewrite, plus out-of-group refs). Write-set
  // members are excluded; see the materialized-compare write set below.
  const writeCandidates = new Map<string, 'create' | 'update'>();
  for (const sku of plan.memberSkus) {
    const live = input.liveBySku.get(sku) ?? null;
    const materialized = materializedPreview.get(sku) ?? null;
    if (!live) {
      writeCandidates.set(sku, 'create');
      continue;
    }
    if (!materialized || comparisonHashForProduct(materialized) !== comparisonHashForProduct(live)) {
      writeCandidates.set(sku, 'update');
    }
  }
  const memberSet: Record<string, true> = {};
  for (const sku of plan.memberSkus) memberSet[sku] = true;
  const readDependencies: string[] = [];
  for (const sku of plan.memberSkus) {
    if (writeCandidates.has(sku)) continue;
    readDependencies.push(sku);
    const live = input.liveBySku.get(sku) ?? null;
    if (!live) continue;
    for (const ref of nativeSkusInDocumentOrder(rawOf(live))) {
      if (!memberSet[ref] && !readDependencies.includes(ref)) readDependencies.push(ref);
    }
  }
  for (const [sku, live] of input.liveBySku) {
    if (!live || memberSet[sku]) continue;
    if (!readDependencies.includes(sku)) readDependencies.push(sku);
  }
  readDependencies.sort();
  const writeSet = [...writeCandidates.entries()]
    .map(([sku, operation]) => ({ sku, operation }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  // Blockers: invariant disagreement, missing invariant authority, label
  // collisions, missing proposals, native-before refs outside the group,
  // same-SKU ambiguity surfaced through the evidence seam, competing drafts,
  // and open drift — all fail closed at review instead of apply.
  for (const row of invariantEvidence) {
    if (!row.agreed) blockers.push(`Invariant "${row.axis}" disagrees across the joined group; resolve before accepting.`);
    else if (row.value == null) blockers.push(`Invariant "${row.axis}" is unknown for the joined group; missing authority stays unresolved.`);
  }
  const seenLabels: Record<string, string> = {};
  for (const proposal of plan.pf7Proposals) {
    if (!proposal.shortName || proposal.shortName.trim().length === 0) {
      blockers.push(`Short Name for SKU "${proposal.sku}" is empty (ShopSite tag ProductField7); replacements are explicit nonempty reviewed diffs.`);
      continue;
    }
    const key = proposal.shortName.trim().toLowerCase();
    if (seenLabels[key]) {
      blockers.push(`Short Name "${proposal.shortName}" is shared by "${seenLabels[key]}" and "${proposal.sku}" (ShopSite tag ProductField7); names must be unique across the joined family.`);
    } else {
      seenLabels[key] = proposal.sku;
    }
  }
  for (const sku of plan.memberSkus) {
    if (!plan.pf7Proposals.some((p) => p.sku === sku)) {
      blockers.push(`Short Name for SKU "${sku}" is missing (ShopSite tag ProductField7); every member needs a reviewed label.`);
    }
  }
  for (const diff of nativeDiffs) {
    for (const ref of diff.beforeRefs) {
      if (!memberSet[ref]) {
        blockers.push(`SKU "${diff.sku}" native references "${ref}" outside the joined group; unrelated relationships stay untouched.`);
      }
    }
  }
  for (const sku of plan.memberSkus) {
    const staged = input.evidenceBySku?.get(sku) ?? input.currentEvidenceBySku?.get(sku) ?? null;
    if (staged?.base && joinOrigin.joinedSkus.includes(sku)) {
      blockers.push(`Joined SKU "${sku}" carries an approved catalog base; same-SKU ambiguity routes to identity/duplicate resolution.`);
    }
  }
  // Complete review blockers (#370): base-hash movement, member name/ID
  // drift, rule/evidence edits, and competing families all block at review
  // (not just at apply/freshness) so the review contract is production-honest.
  for (const member of plan.members) {
    const live = input.liveBySku.get(member.sku) ?? null;
    const liveBaseHash = live ? comparisonHashForProduct(live) : null;
    if (liveBaseHash !== member.baseHash) {
      blockers.push(`SKU "${member.sku}" base changed after staging (stale base); re-resolve before accepting.`);
      continue;
    }
    const current = input.currentEvidenceBySku?.get(member.sku) ?? input.evidenceBySku?.get(member.sku) ?? null;
    if (!current) {
      blockers.push(`SKU "${member.sku}" has no current evidence at review time; missing current authority blocks review — re-resolve before accepting.`);
    } else {
      if ((current.reviewedTypeHash ?? null) !== member.reviewedTypeHash) {
        blockers.push(`SKU "${member.sku}" reviewed type authority moved after staging; re-resolve before accepting.`);
      }
      if ((current.evidenceHash ?? null) !== member.evidenceHash) {
        blockers.push(`SKU "${member.sku}" listing evidence moved after staging (stale evidence); re-resolve before accepting.`);
      }
      if (current.productTypeId != null && member.productTypeId != null && current.productTypeId !== member.productTypeId) {
        blockers.push(`SKU "${member.sku}" product type moved after staging (stale rule); re-resolve before accepting.`);
      }
    }
    const snapshot = joinOrigin.memberNativeIds.find((entry) => entry.sku === member.sku);
    if (snapshot && live) {
      if ((live.shopsite.productId ?? null) !== (snapshot.productId ?? null)
        || (live.shopsite.productGuid ?? null) !== (snapshot.productGuid ?? null)
        || live.core.name !== snapshot.name) {
        blockers.push(`SKU "${member.sku}" native name/ID moved after staging (stale identity); re-resolve before accepting.`);
      }
    }
  }

  for (const conflict of input.conflictingDrafts ?? []) {
    blockers.push(`SKU "${conflict.sku}" is also staged in change set ${conflict.changeSetId.slice(0, 8)} (status "${conflict.status}"); resolve the competing draft before joining.`);
  }
  if (input.conflictingDraftError) blockers.push(`Competing-draft check could not complete: ${input.conflictingDraftError}`);
  for (const sku of input.driftSkus ?? []) {
    blockers.push(`SKU "${sku}" carries open/reconciling drift; resolve drift before joining.`);
  }
  if (input.driftError) blockers.push(`Drift check could not complete: ${input.driftError}`);
  const rejectedAtReview: Record<string, true> = {};
  for (const r of joinOrigin.rejectedFamilies ?? []) rejectedAtReview[r.planId] = true;
  for (const peer of input.competingFamilies ?? []) {
    if (peer.planId === plan.id || peer.planId === joinOrigin.familyPlanId) continue;
    if (!rejectedAtReview[peer.planId]) {
      blockers.push(`Competing family "${peer.planId.slice(0, 8)}" touches the joined SKU(s) (${peer.memberSkus.join(', ')}) and was never explicitly rejected; resolve competing families before joining.`);
    }
  }
  if (input.competingFamiliesError) blockers.push(`Competing-family check could not complete: ${input.competingFamiliesError}`);
  return { plan, targetFamily, joinOrigin, membership, invariantEvidence, varyingAxes, pf7BeforeAfter, nativeDiffs, readDependencies, writeSet, blockers, membershipProposal: input.membershipProposal ?? null };
}

function rawOf(product: Product): string {
  const blocks = product.shopsite?.preserved?.advancedBlocks ?? {};
  for (const key of Object.keys(blocks)) {
    if (key.toLowerCase() === 'subproducts') return blocks[key];
  }
  return '';
}

// ─── Join freshness (whole-group staleness) ─────────────────────────────────
// Current catalog/product/native hashes, member names/IDs, competing active
// drafts, multiple possible families, rule/evidence edits, and
// open/reconciling drift stall or block the complete plan.

export interface JoinFreshness {
  fresh: boolean;
  reasons: string[];
}

export function checkFamilyJoinFreshness(input: {
  planId: string;
  workspacePath: string;
  workspaceId: string;
  liveBySku: Map<string, Product | null>;
  currentTypeHashBySku: Map<string, string | null>;
  currentEvidenceHashBySku?: Map<string, string | null>;
  currentRuleVersionBySku?: Map<string, string | null>;
  currentProductTypeIdBySku?: Map<string, string | null>;
  currentLabelBySku?: Map<string, string | null>;
}): JoinFreshness {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  const joinOrigin = plan.joinOrigin;
  if (!joinOrigin) throw new Error(`family_join_not_join: plan "${input.planId}" carries no join origin.`);
  const reasons: string[] = [];
  for (const member of plan.members) {
    const live = input.liveBySku.get(member.sku) ?? null;
    const liveBaseHash = live ? comparisonHashForProduct(live) : null;
    if (liveBaseHash !== member.baseHash) {
      reasons.push(`SKU "${member.sku}" base changed after staging (stale base).`);
    }
    const liveNativeHash = live ? hashNativeReferences(live) : null;
    if (!member.origin) {
      reasons.push(`SKU "${member.sku}" has no frozen source origin.`);
    } else {
      const validation = validateFamilyMemberOrigin({
        workspaceId: plan.workspaceId, workspacePath: input.workspacePath, sku: member.sku, origin: member.origin,
      });
      if (!validation.ok) reasons.push(`SKU "${member.sku}" source origin is invalid (${validation.code}): ${validation.reason}`);
    }
    if (live && liveNativeHash == null) {
      reasons.push(`SKU "${member.sku}" native references unreadable (stale native).`);
    }
    const currentType = input.currentTypeHashBySku.get(member.sku) ?? null;
    if (currentType !== member.reviewedTypeHash) {
      reasons.push(`SKU "${member.sku}" reviewed type authority changed after staging.`);
    }
    if (input.currentEvidenceHashBySku) {
      const currentEvidence = input.currentEvidenceHashBySku.get(member.sku) ?? null;
      if (currentEvidence !== member.evidenceHash) {
        reasons.push(`SKU "${member.sku}" listing evidence changed after staging (stale evidence).`);
      }
    }
    if (input.currentRuleVersionBySku) {
      const currentRule = input.currentRuleVersionBySku.get(member.sku) ?? null;
      if (currentRule !== null && currentRule !== plan.ruleVersion) {
        reasons.push(`SKU "${member.sku}" rule changed after staging (stale rule).`);
      }
    }
    if (input.currentProductTypeIdBySku && member.productTypeId != null) {
      const currentTypeId = input.currentProductTypeIdBySku.get(member.sku) ?? null;
      if (currentTypeId !== null && currentTypeId !== member.productTypeId) {
        reasons.push(`SKU "${member.sku}" product type changed after staging (stale rule).`);
      }
    }
    if (input.currentLabelBySku) {
      const proposal = plan.pf7Proposals.find((p) => p.sku === member.sku) ?? null;
      // Explicit reviewed replacements intentionally differ from the staged
      // label — the bound base hash (which covers ProductField7) already
      // stales genuine label drift above, so only preserved (non-replaced)
      // proposals compare against the current label here.
      if (proposal && !proposal.replaced) {
        const currentLabel = input.currentLabelBySku.get(member.sku) ?? null;
        if (currentLabel !== null && currentLabel !== proposal.shortName) {
          reasons.push(`SKU "${member.sku}" label changed after staging (stale label).`);
        }
      }
    }
    // Native ID/name drift: the join preserves main/IDs/URL/members/labels
    // — any moved native ID or name stales the whole plan.
    const snapshot = joinOrigin.memberNativeIds.find((entry) => entry.sku === member.sku);
    if (snapshot && live) {
      if ((live.shopsite.productId ?? null) !== (snapshot.productId ?? null)) {
        reasons.push(`SKU "${member.sku}" native product ID changed after staging (stale identity).`);
      }
      if ((live.shopsite.productGuid ?? null) !== (snapshot.productGuid ?? null)) {
        reasons.push(`SKU "${member.sku}" native product GUID changed after staging (stale identity).`);
      }
      if (live.core.name !== snapshot.name) {
        reasons.push(`SKU "${member.sku}" name changed after staging (stale identity).`);
      }
    }
  }
  // Catalog commit drift: the approved head moved since staging.
  const headCommit = readHeadCommit(input.workspacePath);
  if (headCommit !== joinOrigin.stagedCatalogCommit) {
    reasons.push('Approved catalog commit moved after staging (stale catalog).');
  }
  // Target family drift: the reviewed family this join extends moved.
  const targetRow = findStorefrontFamilyPlanById(joinOrigin.familyPlanId);
  if (!targetRow) {
    reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" is unresolvable; re-resolve before joining.`);
  } else {
    try {
      const target = parseStorefrontFamilyPlan(targetRow.planJson);
      if (!target.appliedCommit) {
        reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" has no finalized approved commit; accepted drafts are not join targets.`);
      }
      if (targetRow.status !== 'applied' || target.status !== 'applied') {
        reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" is no longer applied (status "${targetRow.status}"); re-resolve before joining.`);
      }
      // Target order is checked against the join's recorded existing order below.
      const targetOrder = target.joinOrigin ? target.joinOrigin.familyOrder : target.adoptionOrigin ? target.adoptionOrigin.nativeOrder : [...target.memberSkus].sort();
      const expectedExisting = joinOrigin.familyOrder.filter((sku) => !joinOrigin.joinedSkus.includes(sku));
      if (targetOrder.join(',') !== expectedExisting.join(',')) {
        reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" membership/order moved after staging; re-resolve before joining.`);
      }
      if (target.mainSku !== joinOrigin.familyMain) {
        reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" main moved after staging; joins never reparent — re-resolve before joining.`);
      }
    } catch {
      reasons.push(`Target family "${joinOrigin.familyPlanId.slice(0, 8)}" is unreadable; re-resolve before joining.`);
    }
  }
  // Competing active drafts over any group SKU block the whole plan —
  // another draft is never overwritten.
  try {
    const conflicts = listConflictingDraftChangeSets(input.workspaceId, plan.memberSkus, '');
    for (const conflict of conflicts) {
      reasons.push(`SKU "${conflict.sku}" is also staged in change set ${conflict.changeSetId.slice(0, 8)} (status "${conflict.status}"); resolve the competing draft before joining.`);
    }
  } catch (err) {
    reasons.push(`Conflicting-draft check could not complete: ${err instanceof Error ? err.message : String(err)}.`);
  }
  // Open/reconciling drift on any member blocks the whole plan.
  for (const sku of plan.memberSkus) {
    try {
      if (listOutstandingDriftForSku(input.workspaceId, sku).length > 0) {
        reasons.push(`SKU "${sku}" carries open/reconciling drift; resolve drift before joining.`);
      }
    } catch (err) {
      reasons.push(`Drift check for SKU "${sku}" could not complete: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  // Multiple possible families: a NEW competing family appeared since
  // staging (not explicitly rejected) — explicit resolution required.
  try {
    const peers = listStorefrontFamilyPlansForJoinCandidates(input.workspaceId, joinOrigin.joinedSkus)
      .filter((peer) => peer.id !== plan.id && peer.id !== joinOrigin.familyPlanId);
    const rejectedIds: Record<string, true> = {};
    for (const rejected of joinOrigin.rejectedFamilies) rejectedIds[rejected.planId] = true;
    for (const peer of peers) {
      if (!rejectedIds[peer.id]) {
        reasons.push(`Competing family "${peer.id.slice(0, 8)}" touches the joined SKU(s) and was never explicitly rejected; resolve competing families before joining.`);
      }
    }
  } catch (err) {
    reasons.push(`Competing-family check could not complete: ${err instanceof Error ? err.message : String(err)}.`);
  }
  // Rule/evidence edits: any joined SKU whose live evidence no longer
  // satisfies the family rule blocks (re-evaluated below at apply too).
  if (reasons.length > 0 && (plan.status === 'proposed' || plan.status === 'revised' || plan.status === 'accepted')) {
    const next: StorefrontFamilyPlan = { ...plan, status: 'stale', updatedAt: nowIso() };
    updateStorefrontFamilyPlan({ id: plan.id, plan: next, status: 'stale', revision: plan.revision });
  }
  return { fresh: reasons.length === 0, reasons };
}

// ─── Join decisions + apply ─────────────────────────────────────────────────
// Accept/revise persists the full group through existing transactional
// plans/change sets and creates only necessary writes. Reject/defer
// preserves existing relationships + standalone progress.

export function decideFamilyJoin(input: {
  planId: string;
  actor: string;
  action: 'accept' | 'revise' | 'reject' | 'defer';
  note?: string | null;
  /** Decide-time freshness recheck (#369, shared with new families): refuse accept on drift. */
  freshness?: {
    liveBySku?: Map<string, Product | null>;
    currentTypeHashBySku?: Map<string, string | null>;
    currentEvidenceHashBySku?: Map<string, string | null>;
    currentRuleVersionBySku?: Map<string, string | null>;
    currentProductTypeIdBySku?: Map<string, string | null>;
    currentLabelBySku?: Map<string, string | null>;
  } | null;
  /** Decide-time conflicting-draft recheck: refuse accept on competing drafts. */
  conflictingDrafts?: Array<{ changeSetId: string; sku: string; status: string }>;
  /** Decide-time drift recheck: refuse accept on open/reconciling drift. */
  driftSkus?: string[];
}): { row: StorefrontFamilyPlanRow; plan: StorefrontFamilyPlan } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  if (!plan.joinOrigin) throw new Error(`family_join_not_join: plan "${input.planId}" carries no join origin.`);
  if (plan.linkedChangeSetId) {
    throw new Error('family_plan_materialized: linked join decisions are immutable; discard the linked draft and re-stage before changing the decision.');
  }
  if (plan.status === 'applied') {
    throw new Error('family_plan_applied: an applied plan is immutable; stage a new plan to change the family.');
  }
  if (plan.status === 'stale') {
    throw new Error('family_plan_stale: re-stage the join against current evidence before deciding.');
  }
  if (input.action === 'accept' && plan.status !== 'proposed' && plan.status !== 'revised') {
    throw new Error(`family_plan_decision_order: cannot accept a plan in status "${plan.status}".`);
  }
  if (input.action === 'accept') {
    for (const conflict of input.conflictingDrafts ?? []) {
      throw new Error(`family_plan_decision_conflict: SKU "${conflict.sku}" is also staged in change set ${conflict.changeSetId.slice(0, 8)} (status "${conflict.status}"); resolve the competing draft before accepting.`);
    }
    for (const sku of input.driftSkus ?? []) {
      throw new Error(`family_plan_decision_drift: SKU "${sku}" carries open/reconciling drift; resolve drift before accepting.`);
    }
    const f = input.freshness;
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
          const proposal = plan.pf7Proposals.find((pp) => pp.sku === member.sku) ?? null;
          // Explicit reviewed replacements intentionally differ from the
          // staged label — the bound base hash already stales genuine drift,
          // so only preserved (non-replaced) proposals gate here.
          if (proposal && !proposal.replaced) {
            const currentLabel = f.currentLabelBySku.get(member.sku) ?? null;
            if (currentLabel !== null && currentLabel !== proposal.shortName) {
              throw new Error(`family_plan_decision_stale: SKU "${member.sku}" label changed after staging; re-review before accepting.`);
            }
          }
        }
      }
    }
  }
  const at = nowIso();
  const status = input.action === 'accept' ? 'accepted' : input.action === 'revise' ? 'revised' : input.action === 'reject' ? 'rejected' : 'deferred';
  const next: StorefrontFamilyPlan = {
    ...plan,
    status,
    revision: input.action === 'revise' ? plan.revision + 1 : plan.revision,
    updatedAt: at,
    decisions: [
      ...plan.decisions,
      { actor: input.actor, action: input.action, at, note: input.note ?? null, mainOverrideSku: null },
    ],
  };
  const updated = updateStorefrontFamilyPlan({ id: plan.id, plan: next, status, revision: next.revision });
  return { row: updated, plan: next };
}

function withJoinFamilyDraft(draft: Product, plan: StorefrontFamilyPlan, memberSkus: string[], hostRaw: string, nameBySku: Map<string, string>): Product {
  const pf7 = plan.pf7Proposals.find((p) => p.sku === draft.sku)?.shortName;
  if (!pf7) throw new Error(`family_pf7_missing: no PF7 proposal for SKU "${draft.sku}".`);
  const staged = plan.members.find((m) => m.sku === draft.sku);
  const retailUnit = readDraftRetailUnit(draft) ?? staged?.retailUnit ?? null;
  const isNonFood = plan.ruleVersion !== FOOD_FAMILY_VARIANT_RULE_VERSION;
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
  // Block-on-main-only emission: only the main emits the managed block;
  // every other member keeps its native posture (no mesh).
  if (draft.sku !== plan.mainSku) return withPf7;
  const memberNames = memberSkus.map((sku) => {
    const stanza = hostRaw ? nativeStanzaMetadata(hostRaw, sku) : null;
    return {
      sku,
      name: nameBySku.get(sku) ?? (sku === draft.sku ? draft.core.name : sku),
      price: stanza?.price ?? null,
      childName: stanza?.childName ?? null,
    };
  });
  return setManagedSubproducts(withPf7, plan.id, memberNames);
}

function readDraftRetailUnit(draft: Product): string | null {
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

/**
 * Materialize an ACCEPTED join plan into managed native drafts through the
 * shared change-set path (one change set = the complete consistency group).
 * Existing members are updates with their true base; joined imports are
 * creates. Only necessary writes land in the change set: unchanged
 * read-dependency members are recorded in the plan hashes, never rewritten.
 */
export function applyFamilyJoin(input: {
  planId: string;
  workspaceId: string;
  workspacePath: string;
  draftsBySku: Map<string, Product>;
  actor: string;
  /** Purchasable re-check (#368). */
  purchasableBySku?: Map<string, boolean>;
  /**
   * Current authority at apply time (#370): the route binds live SKU-local
   * evidence (type/evidence/rule/type-id/label per member) exactly as the
   * /freshness route does. Absent = fail closed (stale), never assumed
   * fresh — there is no freshness opt-out at apply.
   */
  currentTypeHashBySku?: Map<string, string | null>;
  currentEvidenceHashBySku?: Map<string, string | null>;
  currentRuleVersionBySku?: Map<string, string | null>;
  currentProductTypeIdBySku?: Map<string, string | null>;
  currentLabelBySku?: Map<string, string | null>;
}): { changeSetId: string; plan: StorefrontFamilyPlan } {
  const row = findStorefrontFamilyPlanById(input.planId);
  if (!row) throw new Error(`family_plan_missing: no plan "${input.planId}".`);
  const plan = parseStorefrontFamilyPlan(row.planJson);
  const joinOrigin = plan.joinOrigin;
  if (!joinOrigin) throw new Error(`family_join_not_join: plan "${input.planId}" carries no join origin.`);
  if (plan.status !== 'accepted') throw new Error(`family_plan_not_accepted: join plan "${input.planId}" is "${plan.status}", not accepted.`);
  if (plan.linkedChangeSetId) throw new Error('family_plan_materialized: this join already has a linked draft; replay is refused.');
  for (const sku of plan.memberSkus) {
    if (input.purchasableBySku?.has(sku) && input.purchasableBySku.get(sku) !== true) {
      throw new Error(`family_not_purchasable: SKU "${sku}" is not a real purchasable size SKU at apply time.`);
    }
    if (!input.draftsBySku.has(sku)) {
      throw new Error(`family_member_missing_draft: SKU "${sku}" has no staged draft; accepting requires the complete validated set.`);
    }
    const support = classifySubproductsSupport(input.draftsBySku.get(sku)!);
    if (support.code !== 'supported_absent' && support.code !== 'supported_unmanaged_simple' && support.code !== 'supported_managed') {
      throw new Error(`family_native_unsupported: SKU "${sku}" keeps its unsafe native Subproducts structure preserved and unadopted (${support.code}: ${support.detail})`);
    }
  }
  // Full freshness gate on apply (#370): the complete current-state check
  // (bases, native IDs, type/evidence/rule authority, labels, catalog
  // commit, target membership/status, competing drafts/drift/families)
  // runs here — apply never depends on the caller separately requesting
  // /freshness. Any check that cannot complete fails closed. There is no
  // opt-out: callers cannot skip freshness at apply. Freshness runs before
  // the same-SKU re-resolution below so an unbound-authority probe reports
  // family_apply_stale (not a same-SKU specific that masks the missing
  // authority): the missing maps mean the whole join blocks, never a
  // narrower verdict about one SKU.
  const freshLiveBySku = new Map<string, Product | null>();
  for (const sku of plan.memberSkus) {
    let live: Product | null;
    try {
      live = readProductFile(input.workspacePath, sku);
    } catch (err) {
      throw new Error(`family_apply_stale: base for SKU "${sku}" unreadable after staging (${err instanceof Error ? err.message : String(err)}); re-stage before applying.`, { cause: err });
    }
    freshLiveBySku.set(sku, live);
  }
  if (!input.currentTypeHashBySku || !input.currentEvidenceHashBySku || !input.currentRuleVersionBySku
    || !input.currentProductTypeIdBySku || !input.currentLabelBySku) {
    throw new Error('family_apply_stale: current type/evidence/rule authority is unbound at apply; the whole join blocks — re-stage before applying.');
  }
  // Re-resolve true bases at apply: existing SKU = update with real base,
  // absent SKU = create. A joined SKU that gained an approved base since
  // staging is same-SKU ambiguity — refuse, never duplicate.
  for (const sku of joinOrigin.joinedSkus) {
    const base = readProductFile(input.workspacePath, sku);
    if (base) {
      throw new Error(`family_join_same_sku: joined SKU "${sku}" gained an approved catalog entry after staging; same-SKU ambiguity routes to identity/duplicate resolution, never a duplicate product/file.`);
    }
  }
  const fresh = checkFamilyJoinFreshness({
    planId: plan.id,
    workspacePath: input.workspacePath,
    workspaceId: input.workspaceId,
    liveBySku: freshLiveBySku,
    currentTypeHashBySku: input.currentTypeHashBySku,
    currentEvidenceHashBySku: input.currentEvidenceHashBySku,
    currentRuleVersionBySku: input.currentRuleVersionBySku,
    currentProductTypeIdBySku: input.currentProductTypeIdBySku,
    currentLabelBySku: input.currentLabelBySku,
  });
  if (!fresh.fresh) {
    throw new Error(`family_apply_stale: join is stale at apply (${fresh.reasons.slice(0, 5).join('; ')}); re-stage before applying.`);
  }
  // Materialize first, then compare (#370): accepted PF7 proposals install
  // into drafts via withJoinFamilyDraft, and apply compares the MATERIALIZED
  // payload — blank-PF7 import drafts and explicit reviewed label
  // replacements both pass through the accepted proposal, never throw.
  const managedOrder = joinOrigin.familyOrder.filter((sku) => plan.memberSkus.includes(sku));
  const unmanagedTarget = plan.memberSkus.filter((sku) => !managedOrder.includes(sku));
  const orderedMembers = [...managedOrder, ...unmanagedTarget.sort()];
  const hostSku = joinOrigin.familyMain;
  const hostRaw = rawOf(input.draftsBySku.get(hostSku) ?? input.draftsBySku.get(orderedMembers[0]!)!);
  const nameBySku = new Map<string, string>();
  for (const sku of orderedMembers) {
    nameBySku.set(sku, input.draftsBySku.get(sku)?.core.name ?? sku);
  }
  const materializedBySku = new Map<string, Product>();
  for (const sku of orderedMembers) {
    materializedBySku.set(sku, withJoinFamilyDraft(input.draftsBySku.get(sku)!, plan, orderedMembers, hostRaw, nameBySku));
  }
  for (const sku of plan.memberSkus) {
    const proposal = plan.pf7Proposals.find((pp) => pp.sku === sku)?.shortName ?? null;
    const materializedPf7 = (materializedBySku.get(sku)?.customFields['ProductField7'] ?? '').trim();
    if (proposal !== null && materializedPf7 !== proposal) {
      throw new Error(`family_apply_pf7_mismatch: SKU "${sku}" materialized PF7 does not match the accepted proposal; unreviewed payload rewrites refuse apply.`);
    }
  }
  const materialized = orderedMembers.map((sku) => materializedBySku.get(sku)!);
  const bases = new Map(plan.memberSkus.map((sku) => [sku, readProductFile(input.workspacePath, sku)]));
  const issues = plan.ruleVersion === FOOD_FAMILY_VARIANT_RULE_VERSION
    ? validateStorefrontFamilyGroup({ familyId: plan.id, members: materialized, bases })
    : validateNonFoodFamilyGroup(plan.ruleVersion, plan.id, materialized, bases);
  const blockers = issues.filter((i) => i.severity === 'blocker');
  if (blockers.length > 0) {
    throw new Error(`family_group_blocked: ${blockers.map((b) => `[${b.code}] ${b.message}`).slice(0, 5).join('; ')}`);
  }
  // Minimal writes (#370): compare each materialized draft against its
  // approved base — write only changes. Unchanged existing members stay
  // read dependencies through the linked approval/export contract. A join
  // that changes nothing still needs the main's managed block when the
  // target family has no live block yet — the main always writes.
  const writeSkus: string[] = [];
  for (const sku of orderedMembers) {
    const base = readProductFile(input.workspacePath, sku);
    const managed = materializedBySku.get(sku)!;
    if (!base) {
      writeSkus.push(sku);
      continue;
    }
    if (comparisonHashForProduct(managed) !== comparisonHashForProduct(base)) {
      writeSkus.push(sku);
      continue;
    }
    if (sku === plan.mainSku && nativeSkusInDocumentOrder(rawOf(base)).length === 0) {
      writeSkus.push(sku);
    }
  }
  if (writeSkus.length === 0) {
    throw new Error('family_apply_noop: every materialized member is identical to its approved base; nothing to write — re-stage before applying.');
  }
  const db = getDb();
  const staged = getDb().transaction(() => {
    const changeSet = createChangeSet({
      workspaceId: input.workspaceId,
      title: `Join family ${plan.id.slice(0, 8)} (${joinOrigin.joinedSkus.join(', ')} joins ${joinOrigin.familyMain})`,
      description: `Imported join under ${plan.ruleVersion}; existing main ${plan.mainSku} preserved; ${joinOrigin.joinedSkus.length} new size(s).`,
      baseCommit: readHeadCommit(input.workspacePath),
    });
    for (const sku of writeSkus) {
      const base = readProductFile(input.workspacePath, sku);
      const managed = materializedBySku.get(sku)!;
      const source = plan.members.find((member) => member.sku === sku)?.origin;
      if (!source) throw new Error(`family_apply_origin_invalid: SKU "${sku}" has no frozen source origin.`);
      const validation = validateFamilyMemberOrigin({ workspaceId: input.workspaceId, workspacePath: input.workspacePath, sku, origin: source });
      if (!validation.ok) throw new Error(`family_apply_origin_invalid: SKU "${sku}" source origin is invalid (${validation.code}): ${validation.reason}`);
      upsertChangeSetItem({
        changeSetId: changeSet.id,
        sku,
        operation: base ? 'update' : 'create',
        draftJson: deterministicStringify(managed),
        baseJson: base ? deterministicStringify(base) : null,
        draftHash: hashJson(managed),
        classificationRunId: validation.classificationRunId,
      });
    }
    const next: StorefrontFamilyPlan = { ...plan, status: 'accepted', linkedChangeSetId: changeSet.id, updatedAt: nowIso() };
    updateStorefrontFamilyPlan({ id: plan.id, plan: next, status: 'accepted', revision: plan.revision, linkedChangeSetId: changeSet.id });
    return { changeSet, plan: next };
  })();
  return { changeSetId: staged.changeSet.id, plan: staged.plan };
}

export type { StorefrontFamilyPlan };
export type { JoinOrigin };
