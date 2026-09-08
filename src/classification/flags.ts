/**
 * Cohort-centric Curation V2 runtime feature flags (issue #30, PR3 M1).
 *
 * Rollout: v0.3.0 default was OFF (shadow uses legacy per-item path).
 * After shadow validation (#30 PR12), new batches default to cohort-active
 * (issue #30 rollout commitment) — byte-identical legacy remains available
 * via flags OFF / kill-switch for rollback. Flags can be flipped at
 * runtime without a redeploy:
 * - environment variables are re-read on every `loadCohortCurationFlags()`
 *   call, so a process restart or env change applies without code changes;
 * - `overrideCohortCurationFlags()` swaps the effective values in memory
 *   (used by tests today, by a settings surface later).
 *
 * Flag semantics (implementation-plan section A):
 * - OFF: the legacy per-SKU Curation path runs unchanged; every new cohort
 *   read is gated per-call and inert.
 * - ON: Curation is cohort-claimed EXCLUSIVELY (M3) — `poll()` stops calling
 *   `claimItemsForProcessing('curation', ...)`; ownership flows
 *   refreshCandidateCohorts → reconcile → claimReadyCurationCohorts →
 *   processCohort. `cohortShadowOnly` observes without installing the claim
 *   barrier.
 *
 * PR5 note (issue #30): the effective-type path is active-mode-only BY
 * CONSTRUCTION, so no new flag is added. Only active runs
 * (`cohortCurationV2Enabled && !cohortShadowOnly`) freeze a cohort Execution
 * Product Type; the two attribute-applicability stages then fall back to it
 * behind the reviewed Primary Product Type (reviewed-first / execution
 * fallback), and the executor stamps type dependency rows with separate kinds
 * on `field_assignment` proposals only — `execution_product_type` for
 * execution-driven members, `reviewed_product_type` for reviewed-driven ones
 * (PR5 hardening, issue #30 P2). Flag OFF and shadow runs never carry a
 * cohort execution type, so stage gating, dependency rows, and
 * `curation_data_json` stay byte-identical to PR4/legacy.
 *
 * PR6 note (issue #30): the durable parent title op
 * (`ensureCohortTitlesCoordinated`) runs ONLY inside `processCohort`, which
 * is active-mode-only by construction — no new flag is added. Prepared
 * members consume the persisted `classification_cohort_outputs`
 * (`curated_title`) at the `preComputedTitle` seam and NEVER call the
 * coordinator; `cohortCache` remains the legacy/flag-OFF/shadow authority
 * (byte-identical there). Flag OFF and shadow runs never create cohort
 * output rows and never run the parent op.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/30
 */

export interface CohortCurationFlags {
  /** Master switch: when false, all cohort V2 Curation paths are disabled. */
  cohortCurationV2Enabled: boolean;
  /** Shadow mode: observe cohort claiming/readiness without installing the
   *  per-item claim barrier. Only meaningful while the master switch is ON. */
  cohortShadowOnly: boolean;
  /**
   * PR4 C5: cohort Execution Product Type confidence floor (0..1). A member's
   * resolved type contribution must clear this floor to count as a confident
   * cohort contribution (the per-member matcher's own
   * `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies first). Default 0.7 —
   * matches the per-SKU keyword floor. Env-overridable via
   * `BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR`; parsed per call, so
   * a restart/env change applies without a redeploy. The resolver invocation
   * sites (`src/onboarding/cohort-curator.ts` freeze + shadow observer) read
   * the effective value here instead of a hardcoded constant.
   */
  cohortProductTypeConfidenceFloor: number;
}

export const DEFAULT_COHORT_CURATION_FLAGS: CohortCurationFlags = {
  cohortCurationV2Enabled: true,
  cohortShadowOnly: false,
  cohortProductTypeConfidenceFloor: 0.7,
};

const COHORT_CURATION_FLAG_ENV: Record<keyof CohortCurationFlags, string> = {
  cohortCurationV2Enabled: 'BAYSTATE_CMS_COHORT_CURATION_V2',
  cohortShadowOnly: 'BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY',
  cohortProductTypeConfidenceFloor: 'BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR',
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  // Fail closed on unparseable values rather than guessing.
  return fallback;
}

/**
 * Parse the env-derived numeric flags (PR4 C5 `cohortProductTypeConfidenceFloor`).
 * Unparseable values fall back to the default (fail closed); parseable values
 * are clamped to [0,1] — a confidence floor outside the unit interval is
 * meaningless and would silently distort aggregation.
 */
function parseNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function loadCohortCurationFlags(
  env: Record<string, string | undefined> = process.env,
): CohortCurationFlags {
  return {
    cohortCurationV2Enabled: parseBooleanEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortCurationV2Enabled],
      DEFAULT_COHORT_CURATION_FLAGS.cohortCurationV2Enabled,
    ),
    cohortShadowOnly: parseBooleanEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortShadowOnly],
      DEFAULT_COHORT_CURATION_FLAGS.cohortShadowOnly,
    ),
    cohortProductTypeConfidenceFloor: parseNumberEnv(
      env[COHORT_CURATION_FLAG_ENV.cohortProductTypeConfidenceFloor],
      DEFAULT_COHORT_CURATION_FLAGS.cohortProductTypeConfidenceFloor,
    ),
  };
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<CohortCurationFlags> | null = null;

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideCohortCurationFlags(next: Partial<CohortCurationFlags>): CohortCurationFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getCohortCurationFlags();
}

/** Clear any in-memory override. */
export function resetCohortCurationFlagsOverride(): void {
  runtimeOverride = null;
}

/**
 * Effective flags: env-derived defaults merged with the in-memory override.
 * Read per call so a config change applies without a redeploy.
 */
export function getCohortCurationFlags(): CohortCurationFlags {
  const base = loadCohortCurationFlags();
  return runtimeOverride ? { ...base, ...runtimeOverride } : base;
}

// ---------------------------------------------------------------------------
// P3 value-production ladder flags (classification roadmap plan B.P3)
// ---------------------------------------------------------------------------

/**
 * P3 runtime feature flags (plan B.P3.1/B.P3.3). Both default OFF so the
 * legacy pipeline stays byte-identical until shadow validation completes
 * (mirrors the P4 gate discipline). Flags re-read env on every load call and
 * support an in-memory override for tests, exactly like the cohort flags
 * above.
 *
 * - `universalTierWideningEnabled` (BAYSTATE_CMS_UNIVERSAL_TIER_WIDENING):
 *   when ON, the widened universal tier (size/color/material/flavor) is
 *   PROPOSABLE from deterministic evidence without an accepted Primary
 *   Product Type. Profile enforcement is unchanged: once a type is accepted,
 *   requiredness/cardinality/applicability still evaluate under the
 *   effective type. Widened pre-type proposals carry NO product-type
 *   dependency rows (PR9 DECISION-B invariant — they are produced while no
 *   reviewed/execution type drives the member, so dependency stamping never
 *   fires for them).
 * - `valueGapLlmEnabled` (BAYSTATE_CMS_VALUE_GAP_LLM): when ON, the
 *   flag-gated `value_gap_abstain` stage joins the curation pipeline and
 *   resolves residual gap attributes with ONE id-constrained LLM call per
 *   attribute (out-of-constraint output is a deterministic
 *   `value_gap_abstained`, never invention).
 */
export interface UniversalTierFlags {
  /** Widen the universally-proposable tier to size/color/material/flavor. */
  universalTierWideningEnabled: boolean;
  /** Compose the value_gap_abstain residual-gap resolution stage. */
  valueGapLlmEnabled: boolean;
}

export const DEFAULT_UNIVERSAL_TIER_FLAGS: UniversalTierFlags = {
  universalTierWideningEnabled: false,
  valueGapLlmEnabled: false,
};

const UNIVERSAL_TIER_FLAG_ENV: Record<keyof UniversalTierFlags, string> = {
  universalTierWideningEnabled: 'BAYSTATE_CMS_UNIVERSAL_TIER_WIDENING',
  valueGapLlmEnabled: 'BAYSTATE_CMS_VALUE_GAP_LLM',
};

export function loadUniversalTierFlags(
  env: Record<string, string | undefined> = process.env,
): UniversalTierFlags {
  return {
    universalTierWideningEnabled: parseBooleanEnv(
      env[UNIVERSAL_TIER_FLAG_ENV.universalTierWideningEnabled],
      DEFAULT_UNIVERSAL_TIER_FLAGS.universalTierWideningEnabled,
    ),
    valueGapLlmEnabled: parseBooleanEnv(
      env[UNIVERSAL_TIER_FLAG_ENV.valueGapLlmEnabled],
      DEFAULT_UNIVERSAL_TIER_FLAGS.valueGapLlmEnabled,
    ),
  };
}

let universalTierRuntimeOverride: Partial<UniversalTierFlags> | null = null;

/** Apply an in-memory override of the effective P3 flags. Returns the new flags. */
export function overrideUniversalTierFlags(next: Partial<UniversalTierFlags>): UniversalTierFlags {
  universalTierRuntimeOverride = { ...universalTierRuntimeOverride, ...next };
  return getUniversalTierFlags();
}

/** Clear any P3 in-memory override. */
export function resetUniversalTierFlagsOverride(): void {
  universalTierRuntimeOverride = null;
}

/** Effective P3 flags: env-derived defaults merged with the in-memory override. */
export function getUniversalTierFlags(): UniversalTierFlags {
  const base = loadUniversalTierFlags();
  return universalTierRuntimeOverride ? { ...base, ...universalTierRuntimeOverride } : base;
}

// ---------------------------------------------------------------------------
// Type-first curation accuracy guardrail flags (P1/P2)
// ---------------------------------------------------------------------------

export interface TypeFirstCurationFlags {
  typeFirstReviewUiEnabled: boolean;
  typeChangeRefreshWorkerEnabled: boolean;
  typeDependentRecomputeEnabled: boolean;
  productTypeDeterministicVerifierMode: 'off' | 'shadow' | 'enforce';
  productTypeSecondModelShadowEnabled: boolean;
  productTypeShadowEnabled: boolean;
  productTypeVerifierEnabled: boolean;
}

export const DEFAULT_TYPE_FIRST_CURATION_FLAGS: TypeFirstCurationFlags = {
  typeFirstReviewUiEnabled: false,
  typeChangeRefreshWorkerEnabled: false,
  typeDependentRecomputeEnabled: false,
  productTypeDeterministicVerifierMode: 'off',
  productTypeSecondModelShadowEnabled: false,
  productTypeShadowEnabled: false,
  productTypeVerifierEnabled: false,
};

let typeFirstRuntimeOverride: Partial<TypeFirstCurationFlags> | null = null;

export function loadTypeFirstCurationFlags(
  env: Record<string, string | undefined> = process.env,
): TypeFirstCurationFlags {
  return {
    typeFirstReviewUiEnabled: parseBooleanEnv(env['BAYSTATE_CMS_TYPE_FIRST_REVIEW_UI'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.typeFirstReviewUiEnabled),
    typeChangeRefreshWorkerEnabled: parseBooleanEnv(env['BAYSTATE_CMS_TYPE_CHANGE_REFRESH_WORKER'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.typeChangeRefreshWorkerEnabled),
    typeDependentRecomputeEnabled: parseBooleanEnv(env['BAYSTATE_CMS_TYPE_DEPENDENT_RECOMPUTE'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.typeDependentRecomputeEnabled),
    productTypeDeterministicVerifierMode: (env['BAYSTATE_CMS_PRODUCT_TYPE_VERIFIER_MODE'] as any) ?? DEFAULT_TYPE_FIRST_CURATION_FLAGS.productTypeDeterministicVerifierMode,
    productTypeSecondModelShadowEnabled: parseBooleanEnv(env['BAYSTATE_CMS_PRODUCT_TYPE_SECOND_MODEL_SHADOW'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.productTypeSecondModelShadowEnabled),
    productTypeShadowEnabled: parseBooleanEnv(env['BAYSTATE_CMS_PRODUCT_TYPE_SHADOW'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.productTypeShadowEnabled),
    productTypeVerifierEnabled: parseBooleanEnv(env['BAYSTATE_CMS_PRODUCT_TYPE_VERIFIER'], DEFAULT_TYPE_FIRST_CURATION_FLAGS.productTypeVerifierEnabled),
  };
}

export function overrideTypeFirstCurationFlags(next: Partial<TypeFirstCurationFlags>): TypeFirstCurationFlags {
  typeFirstRuntimeOverride = { ...typeFirstRuntimeOverride, ...next };
  return getTypeFirstCurationFlags();
}

export function resetTypeFirstCurationFlagsOverride(): void {
  typeFirstRuntimeOverride = null;
}

export function getTypeFirstCurationFlags(): TypeFirstCurationFlags {
  const base = loadTypeFirstCurationFlags();
  return typeFirstRuntimeOverride ? { ...base, ...typeFirstRuntimeOverride } : base;
}

