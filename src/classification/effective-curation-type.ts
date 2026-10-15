/**
 * Effective Curation Product Type Resolver (issue #351 SKU-local evidence).
 *
 * Each Product SKU is classified ONLY from its own supplied facts and
 * images. The effective Curation Product Type is the member's own reviewed
 * (accepted) canonical pair's Product Type — resolved by
 * `getReviewedClassification`, which honors an in-run accepted pair first
 * and then provenance-compatible reviewed facts carried in the frozen
 * runtime snapshot — or `none` when no reviewed pair exists.
 *
 * There is NO cohort/parent execution-type fallback as factual authority:
 * a sibling classification, flavor, image, species, or prior page
 * assignment cannot fill an unsupported SKU result. A member missing its
 * own reviewed pair resolves to `none` (unresolved), never to a
 * family-level guess. Batch scheduling, leases, frozen evidence, and
 * provider-call coordination remain supported without sharing factual
 * authority.
 *
 * Provenance rule: a reviewed pair is provenance-compatible BY CONSTRUCTION of
 * the runtime snapshot — `collectCompatibleReviewedFacts` drops every carried
 * fact whose config/source provenance drifted, so the stages need no further
 * checks. This module never re-reads live classification config, never queries
 * pending per-SKU proposals, and never consults `curation_data_json`
 * suggestions — resolution is a pure function of the frozen snapshot's
 * own-SKU facts.
 */
import type { StageContext, StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { AttributeProfileConfig } from '../shared/schemas/classification';
import { getProductTypeIdFromValue } from './assignment-projection';
import { getReviewedClassification, selectProvisionalClassification } from './proposal-selection';

/** Where the effective Curation Product Type came from. */
export type EffectiveTypeSource = 'reviewed' | 'provisional' | 'none';

export interface EffectiveCurationType {
  /** The Product Type id that gates attribute applicability, or null. */
  effectiveTypeId: string | null;
  /** Provenance: reviewed own-SKU fact, provisional same-pass pair, or none. */
  source: EffectiveTypeSource;
}

/**
 * Pure resolution: reviewed own-SKU type, else none (issue #351).
 * Empty-string ids are treated as absent (fail closed, never a lookup key).
 * The legacy second parameter is accepted but ignored — kept so existing
 * call sites need no flag-day rename; execution values are never factual
 * authority.
 */
export function resolveEffectiveCurationType(
  reviewedTypeId: string | null,
  _ignoredExecutionTypeId?: string | null,
): EffectiveCurationType {
  if (reviewedTypeId !== null && reviewedTypeId.length > 0) {
    return { effectiveTypeId: reviewedTypeId, source: 'reviewed' };
  }
  return { effectiveTypeId: null, source: 'none' };
}

/**
 * The one reviewed Product Type id from a frozen snapshot's
 * provenance-compatible reviewed facts, or null. Reimplements the reviewed-fact
 * loop of `getReviewedClassification` as a standalone additive helper
 * (snapshot-only; the in-run accepted branch is irrelevant mid-pipeline
 * because `runPipeline` seeds `acceptedProposals: []`). The first pair fact
 * (`product_classification`, then legacy `primary_product_type`) wins; the id
 * is extracted via `getProductTypeIdFromValue` (accepts `{ productTypeId }`
 * and string shapes).
 */
export function getReviewedTypeFromSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
): string | null {
  if (!snapshot?.reviewedFacts?.length) return null;
  for (const fact of snapshot.reviewedFacts) {
    if (fact.proposalType !== 'primary_product_type' && fact.proposalType !== 'product_classification') continue;
    const id = getProductTypeIdFromValue(fact.value);
    if (id && id.length > 0) return id;
  }
  return null;
}

/**
 * Effective Curation Product Type for a stage (issues #351 + #352): the
 * member's own reviewed pair's type when accepted, else the provisional
 * (pending, unreviewed) in-run pair from the SAME pass — never a parent,
 * sibling, or execution conclusion. The provisional pair is the pipeline's
 * own earlier-stage output for this SKU (deterministic order: the type
 * stage runs before attribute stages), so it carries no cross-SKU
 * authority. Reviewed facts are provenance-compatible by snapshot
 * construction, so no live-config re-validation happens here.
 */
export function getEffectiveCurationProductType(
  input: StageInput,
  context: StageContext,
): EffectiveCurationType {
  const reviewed = getReviewedClassification(input, context.snapshot).productTypeId;
  if (reviewed && reviewed.length > 0) return { effectiveTypeId: reviewed, source: 'reviewed' };
  const provisional = selectProvisionalClassification(input).productTypeId;
  if (provisional && provisional.length > 0) return { effectiveTypeId: provisional, source: 'provisional' };
  return { effectiveTypeId: null, source: 'none' };
}

/**
 * Resolve the Attribute Profile that gates the effective Curation Product
 * Type (issue #30 PR5 P1-1; issue #350 invariant below).
 *
 * Issue #350 invariant: each Product Type declares exactly one approved
 * Category via `ProductTypeConfigV2.categoryId`, so the canonical pair is
 * fully determined by the Type. Keying the profile by Type IS keying by the
 * canonical classification — one classification selects exactly one profile
 * and there is no second profile authority. Category never selects profiles
 * independently; this is not leftover legacy type keying.
 *
 * - Legacy path (`effectivePath === false`, no cohort execution type):
 *   BYTE-IDENTICAL legacy semantics — the first profile whose `productTypeId`
 *   equals the effective type, or null when none exists (the pre-existing
 *   "no profile constraint" behavior is preserved for flag-OFF runs).
 * - Effective path (`effectivePath === true`, prepared-cohort mode): the
 *   AUTHORITATIVE direction — frozen Product Type -> `attributeProfileId` ->
 *   `attributeProfiles.id`. `attributeProfileId: null` is a legitimately
 *   EMPTY profile: universal attributes may proceed while EVERY non-universal
 *   type-gated attribute is `not_applicable` (never "all fields"). A declared
 *   profile missing from the frozen snapshot — or an effective type absent
 *   from the frozen product types — throws (frozen snapshot inconsistency;
 *   never a fallback to the live config cache).
 */
export function resolveEffectiveTypeProfile(
  effectiveTypeId: string | null,
  profiles: AttributeProfileConfig[],
  effectivePath: boolean,
  snapshot: RuntimeClassificationSnapshot | undefined,
): { attributes: AttributeProfileConfig['attributes'] } | null {
  if (effectiveTypeId === null) return null;
  if (!effectivePath) {
    const legacyProfile = profiles.find(profile => profile.productTypeId === effectiveTypeId);
    return legacyProfile ? { attributes: legacyProfile.attributes } : null;
  }
  const productType = snapshot?.productTypes.find(candidate => candidate.id === effectiveTypeId);
  if (!productType) {
    throw new Error(
      `Effective Product Type "${effectiveTypeId}" is missing from the frozen runtime snapshot; cannot resolve its Attribute Profile (failing closed).`,
    );
  }
  if (productType.attributeProfileId === null) {
    // Empty profile: universal attributes may proceed; every non-universal
    // type-gated attribute is not_applicable. Never pass null here — the
    // evaluator's null means "no profile constraint" (the unsafe all-fields
    // interpretation this fix eliminates on the effective path).
    return { attributes: [] };
  }
  const profile = profiles.find(candidate => candidate.id === productType.attributeProfileId);
  if (!profile) {
    throw new Error(
      `Effective Product Type "${effectiveTypeId}" declares Attribute Profile "${productType.attributeProfileId}" ` +
        'which is missing from the frozen runtime snapshot; failing closed (never falling back to the live config cache).',
    );
  }
  return { attributes: profile.attributes };
}

/**
 * Snapshot-only variant for the cohort executor (no `StageInput` in scope).
 * Resolves the reviewed type purely from `snapshot.reviewedFacts`, or
 * `none` (issue #351). The legacy execution parameter is accepted but
 * ignored — execution values are never factual authority.
 */
export function getEffectiveCurationTypeForSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
  _ignoredExecutionTypeId?: string | null,
): EffectiveCurationType {
  return resolveEffectiveCurationType(getReviewedTypeFromSnapshot(snapshot));
}

/** Where the effective canonical classification came from. */
export interface EffectiveClassification {
  /** The effective Product Type id that gates attribute applicability, or null. */
  effectiveTypeId: string | null;
  /** The effective Category id, or null when unresolved. */
  effectiveCategoryId: string | null;
  /** Provenance of the effective classification: reviewed own-SKU fact, or none. */
  source: EffectiveTypeSource;
}

/**
 * Effective canonical classification for a stage (issue #351): the member's
 * own reviewed pair (accepted `product_classification`, then legacy
 * `primary_product_type` with its category resolved through the approved
 * mapping) or `none`. No execution fallback — missing own-SKU evidence
 * produces an unresolved result, never a family-level guess.
 */
export function getEffectiveClassification(
  input: StageInput,
  context: StageContext,
): EffectiveClassification {
  const reviewed = getReviewedClassification(input, context.snapshot);
  if (reviewed.productTypeId && reviewed.productTypeId.length > 0) {
    return { effectiveTypeId: reviewed.productTypeId, effectiveCategoryId: reviewed.categoryId, source: 'reviewed' };
  }
  return { effectiveTypeId: null, effectiveCategoryId: null, source: 'none' };
}

/**
 * Snapshot-only reviewed canonical pair (issue #350). Reimplements the
 * reviewed-fact loop of `getReviewedClassification` without the in-run
 * accepted branch (irrelevant mid-pipeline). The first pair fact wins; a
 * legacy type-only fact resolves its category through the snapshot mapping.
 */
export function getReviewedClassificationPair(
  snapshot: RuntimeClassificationSnapshot | undefined,
): { categoryId: string | null; productTypeId: string | null } {
  if (!snapshot?.reviewedFacts?.length) return { categoryId: null, productTypeId: null };
  const productTypes = snapshot.productTypes ?? [];
  for (const fact of snapshot.reviewedFacts) {
    if (fact.proposalType !== 'product_classification' && fact.proposalType !== 'primary_product_type') continue;
    const typeId = getProductTypeIdFromValue(fact.value);
    const rawCategory = (fact.value as { categoryId?: unknown } | null)?.categoryId;
    const factCategory = typeof rawCategory === 'string' && rawCategory.length > 0 ? rawCategory : null;
    if (!typeId && !factCategory) continue;
    let categoryId = factCategory;
    if (typeId && !categoryId) {
      const type = productTypes.find(candidate => candidate.id === typeId) as { categoryId?: unknown } | undefined;
      categoryId = typeof type?.categoryId === 'string' ? type.categoryId : null;
    }
    return { categoryId, productTypeId: typeId };
  }
  return { categoryId: null, productTypeId: null };
}
