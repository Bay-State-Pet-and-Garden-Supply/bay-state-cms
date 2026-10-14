/**
 * Effective Curation Product Type Resolver (issue #30 PR5; issue #350).
 *
 * The two Curation stages that gate attribute applicability
 * (`attribute_applicability` / `product_attribute_proposals`) read ONE pure
 * helper here instead of the reviewed-only `getReviewedClassification`
 * directly. Priority is:
 *
 *   1. `reviewed` — the member's own reviewed (accepted) canonical pair's
 *      Product Type, resolved by `getReviewedClassification`, which honors
 *      an in-run accepted pair first and then provenance-compatible
 *      reviewed facts carried in the frozen runtime snapshot.
 *   2. `execution` — the cohort Execution Product Type written once at freeze
 *      (PR4, `StageContext.cohortExecutionType`), used ONLY when no reviewed
 *      pair exists.
 *   3. `none` — neither a reviewed pair nor an execution type.
 *
 * Provenance rule: a reviewed pair is provenance-compatible BY CONSTRUCTION of
 * the runtime snapshot — `collectCompatibleReviewedFacts` drops every carried
 * fact whose config/source provenance drifted, so the stages need no further
 * checks. This module never re-reads live classification config, never queries
 * pending per-SKU proposals, and never consults `curation_data_json`
 * suggestions — the execution path is a pure function of the frozen snapshot's
 * facts and the frozen `cohortExecutionType`.
 *
 * Reviewed-override precedence: when both a reviewed pair and an execution
 * type exist (and even when they differ), the reviewed pair wins. Review and
 * Promotion authority stay on the member's own reviewed proposals; the
 * Execution Type only fills the gap for first-pass Curation applicability.
 */
import type { StageContext, StageInput } from './types';
import type { RuntimeClassificationSnapshot } from './runtime-snapshot';
import type { AttributeProfileConfig } from '../shared/schemas/classification';
import { getProductTypeIdFromValue } from './assignment-projection';
import { getReviewedClassification } from './proposal-selection';

/** Where the effective Curation Product Type came from. */
export type EffectiveTypeSource = 'reviewed' | 'execution' | 'none';

export interface EffectiveCurationType {
  /** The Product Type id that gates attribute applicability, or null. */
  effectiveTypeId: string | null;
  /** Provenance of the effective type: reviewed fact, execution type, or none. */
  source: EffectiveTypeSource;
}

/**
 * Pure resolution: reviewed first, then the cohort execution type, else none.
 * Empty-string ids are treated as absent (fail closed, never a lookup key).
 */
export function resolveEffectiveCurationType(
  reviewedTypeId: string | null,
  executionTypeId: string | null,
): EffectiveCurationType {
  if (reviewedTypeId !== null && reviewedTypeId.length > 0) {
    return { effectiveTypeId: reviewedTypeId, source: 'reviewed' };
  }
  if (executionTypeId !== null && executionTypeId.length > 0) {
    return { effectiveTypeId: executionTypeId, source: 'execution' };
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
 * Effective Curation Product Type for a stage: the reviewed pair's type
 * (`getReviewedClassification`) with the frozen cohort Execution Product
 * Type as fallback. Reviewed facts are provenance-compatible by snapshot
 * construction, so no live-config re-validation happens here.
 */
export function getEffectiveCurationProductType(
  input: StageInput,
  context: StageContext,
): EffectiveCurationType {
  // Issue #350: the reviewed pair's type (canonical pair first, legacy type
  // kind for historical runs) with the frozen cohort Execution Product Type
  // as fallback. Facts are provenance-compatible by snapshot construction.
  return resolveEffectiveCurationType(
    getReviewedClassification(input, context.snapshot).productTypeId,
    context.cohortExecutionType?.id ?? null,
  );
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
 * Resolves the reviewed type purely from `snapshot.reviewedFacts`, so it
 * agrees with `getEffectiveCurationProductType` by construction and the
 * executor's dependency stamping matches what the stages actually used.
 */
export function getEffectiveCurationTypeForSnapshot(
  snapshot: RuntimeClassificationSnapshot | undefined,
  executionTypeId: string | null,
): EffectiveCurationType {
  return resolveEffectiveCurationType(getReviewedTypeFromSnapshot(snapshot), executionTypeId);
}

/** Where the effective canonical classification came from. */
export interface EffectiveClassification {
  /** The effective Product Type id that gates attribute applicability, or null. */
  effectiveTypeId: string | null;
  /** The effective Category id, or null when unresolved. */
  effectiveCategoryId: string | null;
  /** Provenance of the effective classification: reviewed fact, execution type, or none. */
  source: EffectiveTypeSource;
}

/**
 * Effective canonical classification for a stage (issue #350): the reviewed
 * pair (accepted `product_classification`, then legacy
 * `primary_product_type` with its category resolved through the approved
 * mapping) with the frozen cohort Execution Product Type as fallback.
 * Category for an execution-fallback type resolves through the snapshot
 * mapping; an unmapped execution type yields a null category (explicit gap).
 * The execution chain itself is preserved for #351 to remove.
 */
export function getEffectiveClassification(
  input: StageInput,
  context: StageContext,
): EffectiveClassification {
  const reviewed = getReviewedClassification(input, context.snapshot);
  if (reviewed.productTypeId && reviewed.productTypeId.length > 0) {
    return { effectiveTypeId: reviewed.productTypeId, effectiveCategoryId: reviewed.categoryId, source: 'reviewed' };
  }
  const executionTypeId = context.cohortExecutionType?.id ?? null;
  if (executionTypeId && executionTypeId.length > 0) {
    const productTypes = context.snapshot?.productTypes ?? [];
    const type = productTypes.find(candidate => candidate.id === executionTypeId) as { categoryId?: unknown } | undefined;
    const rawCategoryId = type?.categoryId;
    const categoryId = typeof rawCategoryId === 'string' && rawCategoryId.length > 0 ? rawCategoryId : null;
    return { effectiveTypeId: executionTypeId, effectiveCategoryId: categoryId, source: 'execution' };
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
