/**
 * Client feature flags for the onboarding operator + review surfaces.
 *
 * - `batchWorkspaceEnabled`: the Batch Workspace is the sole operator
 *   surface (Slice 6: the workspace-disabled branch is retired — a false
 *   value is deprecated and ignored, the shell always mounts).
 * - `reviewUiV2`: gates the full-field review form, readiness checklist, and
 *   confirmation step (e10s02/s03, epic #review-final-gate). Flag OFF ⇒ the
 *   review workspace renders exactly the pre-V2 component tree and sends the
 *   legacy update payload PLUS curatedWeight write-back (the V1 Weight editor
 *   must persist; convertToLbs is idempotent so rollback stays safe). Default
 *   OFF.
 *
 * Env values are computed once at module load so the SPA cannot flip
 * mid-session. Kill-switch values ('false' | '0' | 'no') disable; any other
 * non-empty value enables; empty/undefined ⇒ per-flag default.
 * Tests can force values with `overrideOnboardingFeatureFlags`.
 *
 * UI-only scope (council plan): NOTHING in `src/server/` reads `VITE_*` or
 * `getOnboardingFeatureFlags`. Stage-vocabulary compatibility is mandatory via
 * version-aware adapters + dual-read bridge (never an optional toggle), and
 * there is no durable execution tail/heartbeat — the strip is ephemeral-only
 * with server-count freshness. See the council plan; vocabulary pending owner
 * sign-off.
 */
export interface OnboardingFeatureFlags {
  /** Batch Workspace is the primary operator surface. */
  batchWorkspaceEnabled: boolean;
  /** Full-field review form + readiness gating + confirm step (e10s02/s03). */
  reviewUiV2: boolean;
  /** Linear v2 shell (Step 0 + six stage tabs). UI-only, default ON since Slice 6 (rollout order: shell first, then brand gate + strip). */
  shellV2Enabled: boolean;
  /** Step 0 brand gate view. UI-only, default ON since Slice 6; requires shellV2Enabled (ADR 0034 Slice 2). */
  brandGateV2Enabled: boolean;
  /** Execution strip (status + live feed). UI-only, default ON since Slice 6; requires shellV2Enabled (ADR 0034 Slice 3). */
  executionStripV2Enabled: boolean;
}

function readViteEnv(): Record<string, string | undefined> {
  // Guarded: unit tests may run outside Vite's import.meta.env injection.
  try {
    return ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
  } catch {
    return {};
  }
}

/**
 * Kill-switch parser. Exported for the plan-mandated truth-table test
 * (specs/review-ui-rebuild-plan.md §tests): 'false'|'0'|'no' disable,
 * any other non-empty value enables, empty/undefined ⇒ default.
 */
export function parseEnvFlag(raw: string | undefined | null, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null) return defaultValue;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === '') return defaultValue;
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
  return true;
}

const ENV = readViteEnv();

/** Env-derived defaults — computed once at module load (SPA cannot flip mid-session). */
const CACHED_ENV_FLAGS: OnboardingFeatureFlags = {
  // Slice 6: the workspace-disabled branch is retired; a false value is a
  // deprecated no-op (the sole shell always mounts). Default stays true.
  batchWorkspaceEnabled: parseEnvFlag(ENV.VITE_BATCH_WORKSPACE_ENABLED, true),
  // Slice 7: `pipelineDiagnosticsEnabled` (VITE_PIPELINE_DIAGNOSTICS_ENABLED)
  // is removed with the deleted PipelineBoard file. An explicit
  // `?board=pipeline` URL resolves to the current shell with a retirement
  // notice; no flag gates that notice. Classic rollback after Slice 7 uses
  // the archived matching bridge client, never a resurrected board.
  reviewUiV2: parseEnvFlag(ENV.VITE_REVIEW_UI_V2, true),
  // Council plan Slice 6 controlled default-on (rollout order: shell first,
  // then brand gate + strip). Kill-switches remain one release.
  shellV2Enabled: parseEnvFlag(ENV.VITE_ONBOARDING_SHELL_V2, true),
  brandGateV2Enabled: parseEnvFlag(ENV.VITE_BRAND_GATE_V2, true),
  executionStripV2Enabled: parseEnvFlag(ENV.VITE_EXECUTION_STRIP_V2, true),
};

let overrides: Partial<OnboardingFeatureFlags> = {};

/** Force flag values for tests / emergency in-session overrides. */
export function overrideOnboardingFeatureFlags(patch: Partial<OnboardingFeatureFlags>): void {
  overrides = { ...overrides, ...patch };
}

/** Clear any forced flag values (test cleanup). */
export function resetOnboardingFeatureFlags(): void {
  overrides = {};
}

export function getOnboardingFeatureFlags(): OnboardingFeatureFlags {
  return {
    batchWorkspaceEnabled: overrides.batchWorkspaceEnabled ?? CACHED_ENV_FLAGS.batchWorkspaceEnabled,
    reviewUiV2: overrides.reviewUiV2 ?? CACHED_ENV_FLAGS.reviewUiV2,
    shellV2Enabled: overrides.shellV2Enabled ?? CACHED_ENV_FLAGS.shellV2Enabled,
    brandGateV2Enabled: overrides.brandGateV2Enabled ?? CACHED_ENV_FLAGS.brandGateV2Enabled,
    executionStripV2Enabled:
      overrides.executionStripV2Enabled ?? CACHED_ENV_FLAGS.executionStripV2Enabled,
  };
}
