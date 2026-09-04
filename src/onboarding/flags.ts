/**
 * Onboarding pipeline runtime feature flags.
 *
 * Sourcing stage engine capability flags. Per ADR 0014 Amendment A
 * (Default-On Distributor Sourcing), the engine is DEFAULT-ON: an absent
 * `BAYSTATE_CMS_SOURCING_ENABLED` means enabled, and the default rollout
 * mode is `automatic`. An explicit `false|0|no`, an empty/whitespace value,
 * a malformed value, or an invalid mode disables the capability fail-closed.
 *
 * While the engine capability is disabled (effectiveEnabled=false):
 *
 * - new imports enter Discovery directly (never stranding in sourcing/pending);
 * - reset/retry on a Sourcing item performs the audited
 *   `fallback_to_discovery` transition instead of resetting in place;
 * - the UI hides "automatic sourcing decision", "Re-run Sourcing", and
 *   distributor-bundle selection.
 *
 * Flags follow the established Product Intelligence convention
 * (`src/product-intelligence/flags.ts`): environment variables are re-read on
 * every load, and an in-memory override exists for tests / a future settings
 * surface. The fail-closed parse rules apply to overrides too: an override
 * cannot manufacture a valid mode accidentally.
 */

export type SourcingMode = 'observe' | 'manual' | 'automatic';

/** Stable non-secret reason codes for the effective sourcing state. */
export type SourcingFlagReason =
  | 'default_on' // env key absent; defaults apply (enabled + automatic)
  | 'env_enabled' // explicit true|1|yes
  | 'env_disabled' // explicit false|0|no (global kill switch)
  | 'malformed_config' // enabled key present but empty/whitespace/unparseable
  | 'invalid_mode' // enabled true but mode key empty/whitespace/invalid
  | 'override'; // effective state comes from an in-memory override

export interface SourcingFlags {
  /** Parsed capability switch. True means the engine capability is declared available. */
  sourcingEngineEnabled: boolean;
  /**
   * Parsed rollout mode. `null` when the mode is invalid/unparseable or the
   * capability is disabled (no meaningful mode).
   */
  mode: SourcingMode | null;
  /** Fail-closed effective state — the value callers must gate on. */
  effectiveEnabled: boolean;
  /** Stable non-secret reason for the effective state. */
  reason: SourcingFlagReason;
}

export const SOURCING_MODES: readonly SourcingMode[] = ['observe', 'manual', 'automatic'];

/**
 * Defaults that apply when the relevant env keys are ABSENT. Per Amendment A,
 * missing flag means enabled with automatic mode.
 */
export const DEFAULT_SOURCING_FLAGS: SourcingFlags = {
  sourcingEngineEnabled: true,
  mode: 'automatic',
  effectiveEnabled: true,
  reason: 'default_on',
};

const SOURCING_FLAG_ENV = {
  sourcingEngineEnabled: 'BAYSTATE_CMS_SOURCING_ENABLED',
  mode: 'BAYSTATE_CMS_SOURCING_MODE',
} as const;

/**
 * Parse the enabled switch. Distinguishes absent (default: enabled) from
 * present-but-empty/whitespace/malformed (fail-closed: disabled).
 */
function parseEnabledEnv(raw: string | undefined): {
  enabled: boolean;
  reason: SourcingFlagReason;
} {
  if (raw === undefined) return { enabled: true, reason: 'default_on' };
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return { enabled: false, reason: 'malformed_config' };
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return { enabled: true, reason: 'env_enabled' };
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return { enabled: false, reason: 'env_disabled' };
  }
  return { enabled: false, reason: 'malformed_config' };
}

/**
 * Parse the rollout mode switch. Absent → `automatic` (the default mode).
 * Empty/whitespace/invalid → `null` (caller must fail closed).
 */
export function parseSourcingMode(raw: string | undefined): SourcingMode | null {
  if (raw === undefined) return 'automatic';
  const normalized = raw.trim().toLowerCase();
  for (const mode of SOURCING_MODES) {
    if (normalized === mode) return mode;
  }
  return null;
}

/** Assemble the fail-closed SourcingFlags from parsed inputs. */
function toFlags(config: {
  enabled: boolean;
  enabledReason: SourcingFlagReason;
  mode: SourcingMode | null;
}): SourcingFlags {
  if (!config.enabled) {
    return {
      sourcingEngineEnabled: false,
      mode: null,
      effectiveEnabled: false,
      reason: config.enabledReason,
    };
  }
  if (config.mode === null) {
    // Capability declared available but mode invalid → fail closed.
    return {
      sourcingEngineEnabled: true,
      mode: null,
      effectiveEnabled: false,
      reason: 'invalid_mode',
    };
  }
  return {
    sourcingEngineEnabled: true,
    mode: config.mode,
    effectiveEnabled: true,
    reason: config.enabledReason,
  };
}

export function loadSourcingFlags(
  env: Record<string, string | undefined> = process.env,
): SourcingFlags {
  const parsed = parseEnabledEnv(env[SOURCING_FLAG_ENV.sourcingEngineEnabled]);
  const mode = parseSourcingMode(env[SOURCING_FLAG_ENV.mode]);
  return toFlags({ enabled: parsed.enabled, enabledReason: parsed.reason, mode });
}

// ---------------------------------------------------------------------------
// In-memory runtime override (tests, future settings UI)
// ---------------------------------------------------------------------------

let runtimeOverride: Partial<SourcingFlags> | null = null;

/**
 * Merge an in-memory override over an env-derived base, applying the same
 * fail-closed validation. An override cannot manufacture a valid mode
 * accidentally: if the merged result has no valid mode while declared
 * enabled, the effective state is disabled with `invalid_mode`.
 */
export function applySourcingOverride(
  base: SourcingFlags,
  override: Partial<SourcingFlags>,
): SourcingFlags {
  const enabled = override.sourcingEngineEnabled ?? base.sourcingEngineEnabled;
  // Distinguish ABSENT from explicit null: `override.mode !== undefined ? override.mode : base.mode`
  // so an explicit `{ mode: null }` cannot resurrect a valid base mode.
  const mode = override.mode !== undefined ? override.mode : base.mode;
  if (!enabled) {
    return { sourcingEngineEnabled: false, mode: null, effectiveEnabled: false, reason: 'override' };
  }
  // Runtime validation: an untyped/runtime caller could pass an invalid mode
  // string; fail closed rather than manufacturing an enabled state.
  if (mode !== null && !(SOURCING_MODES as readonly string[]).includes(mode as string)) {
    return { sourcingEngineEnabled: true, mode: null, effectiveEnabled: false, reason: 'invalid_mode' };
  }
  if (mode === null) {
    return { sourcingEngineEnabled: true, mode: null, effectiveEnabled: false, reason: 'invalid_mode' };
  }
  return { sourcingEngineEnabled: true, mode, effectiveEnabled: true, reason: 'override' };
}

/** Apply an in-memory override of the effective flags. Returns the new flags. */
export function overrideSourcingFlags(next: Partial<SourcingFlags>): SourcingFlags {
  runtimeOverride = { ...runtimeOverride, ...next };
  return getSourcingFlags();
}

/** Clear any in-memory override. */
export function resetSourcingFlagsOverride(): void {
  runtimeOverride = null;
}

/**
 * Effective flags: env-derived defaults merged with the in-memory override.
 * Read per call so a config change applies without a redeploy.
 */
export function getSourcingFlags(): SourcingFlags {
  const base = loadSourcingFlags();
  return runtimeOverride ? applySourcingOverride(base, runtimeOverride) : base;
}

// ---------------------------------------------------------------------------
// Manual-evidence extraction route (parent #101, ticket #102 foundation).
// Fail-closed DEFAULT-OFF: absent, empty, whitespace, malformed, or explicit
// false values all mean disabled. Only an explicit true|1|yes (trimmed,
// case-insensitive) enables. Enabling alone changes no behavior until the
// later manual-evidence tickets land their API/evidence/gate/UI paths.
// ---------------------------------------------------------------------------

/** Env key for the manual-evidence extraction route. */
export const MANUAL_EVIDENCE_ENV_KEY = 'BAYSTATE_CMS_MANUAL_EVIDENCE_ENABLED';

/** Stable non-secret reason codes for the manual-evidence flag state. */
export type ManualEvidenceFlagReason =
  | 'disabled_default' // env key absent; default OFF
  | 'env_enabled' // explicit true|1|yes
  | 'env_disabled' // explicit false|0|no
  | 'malformed_config' // present but empty/whitespace/unparseable
  | 'override'; // effective state comes from an in-memory override

export interface ManualEvidenceFlags {
  /** Fail-closed effective state — the value callers must gate on. */
  enabled: boolean;
  /** Stable non-secret reason for the effective state. */
  reason: ManualEvidenceFlagReason;
}

/** Default flags: OFF. */
export const DEFAULT_MANUAL_EVIDENCE_FLAGS: ManualEvidenceFlags = {
  enabled: false,
  reason: 'disabled_default',
};

/** Parse the manual-evidence switch. Absent → disabled (default OFF). */
export function loadManualEvidenceFlags(
  env: Record<string, string | undefined> = process.env,
): ManualEvidenceFlags {
  const raw = env[MANUAL_EVIDENCE_ENV_KEY];
  if (raw === undefined) return { ...DEFAULT_MANUAL_EVIDENCE_FLAGS };
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return { enabled: true, reason: 'env_enabled' };
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return { enabled: false, reason: 'env_disabled' };
  }
  return { enabled: false, reason: 'malformed_config' };
}

let manualEvidenceOverride: boolean | null = null;

/** Apply an in-memory override of the manual-evidence flag. Returns the new flags. */
export function overrideManualEvidenceFlags(next: { enabled: boolean }): ManualEvidenceFlags {
  manualEvidenceOverride = next.enabled;
  return getManualEvidenceFlags();
}

/** Clear any in-memory manual-evidence override. */
export function resetManualEvidenceFlagsOverride(): void {
  manualEvidenceOverride = null;
}

/**
 * Effective manual-evidence flags: env-derived default merged with the
 * in-memory override. Read per call so a config change applies without a
 * redeploy.
 */
export function getManualEvidenceFlags(): ManualEvidenceFlags {
  const base = loadManualEvidenceFlags();
  if (manualEvidenceOverride === null) return base;
  return { enabled: manualEvidenceOverride, reason: 'override' };
}
