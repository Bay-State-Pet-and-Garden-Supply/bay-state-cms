// @vitest-environment node
// story: e10s02/e10s03/e10s05 — client onboarding feature flags
// e10s05 restores the epic #46 sibling flag (batchWorkspaceEnabled)
// alongside reviewUiV2. Slice 7 removes pipelineDiagnosticsEnabled with the
// deleted PipelineBoard file: `?board=pipeline` always resolves to the
// shell with a retirement notice, gated by no flag.
import { afterEach, describe, expect, it } from 'vitest';
import {
  getOnboardingFeatureFlags,
  overrideOnboardingFeatureFlags,
  parseEnvFlag,
  resetOnboardingFeatureFlags,
} from '../../client/onboarding-feature-flags';

afterEach(() => {
  resetOnboardingFeatureFlags();
});

describe('onboarding feature flags // e10s02', () => {
  it('reviewUiV2 defaults to true (retirement: legacy drawer removed, post-default-on)', () => {
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
  });

  // e10s05: sibling epic #46 flags restored — defaults must match HEAD semantics.
  it('batchWorkspaceEnabled defaults to true', () => {
    expect(getOnboardingFeatureFlags().batchWorkspaceEnabled).toBe(true);
  });

  it('pipelineDiagnosticsEnabled is REMOVED in Slice 7 (board file deleted; ?board=pipeline needs no flag)', () => {
    expect('pipelineDiagnosticsEnabled' in getOnboardingFeatureFlags()).toBe(false);
  });

  it('override wins over env parsing', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: true });
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
    overrideOnboardingFeatureFlags({ reviewUiV2: false });
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(false);
  });

  // Slice 7: unknown/removed flag keys in an override patch are ignored —
  // overrides are typed, so a stale diagnostics key cannot resurrect a
  // gate. (Compile-time: `overrideOnboardingFeatureFlags({
  // pipelineDiagnosticsEnabled: true })` no longer typechecks.)

  it('override works per-flag without disturbing siblings // e10s05', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: true, batchWorkspaceEnabled: false });
    const flags = getOnboardingFeatureFlags();
    expect(flags.reviewUiV2).toBe(true);
    expect(flags.batchWorkspaceEnabled).toBe(false);
  });

  it('reset restores defaults', () => {
    overrideOnboardingFeatureFlags({ reviewUiV2: false });
    resetOnboardingFeatureFlags();
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
  });

  // Slice 6 controlled default-on (rollout order: shell first, then brand
  // gate + strip). UI-only; server behavior uses ONBOARDING_* flags in
  // src/onboarding/flags.ts, never VITE_*.
  it('shell/strip/brand flags default ON (Slice 6 controlled default-on)', () => {
    const flags = getOnboardingFeatureFlags();
    expect(flags.shellV2Enabled).toBe(true);
    expect(flags.brandGateV2Enabled).toBe(true);
    expect(flags.executionStripV2Enabled).toBe(true);
  });

  it('shellV2 overrides work per-flag without disturbing siblings', () => {
    overrideOnboardingFeatureFlags({ shellV2Enabled: false });
    const flags = getOnboardingFeatureFlags();
    expect(flags.shellV2Enabled).toBe(false);
    expect(flags.brandGateV2Enabled).toBe(true);
    expect(flags.executionStripV2Enabled).toBe(true);
    expect(flags.batchWorkspaceEnabled).toBe(true);
  });

  // Slice 6: REVIEW_UI_V2 is untouched by this rewrite — shell/brand/strip
  // overrides must never flip it, and vice versa (override isolation).
  it('REVIEW_UI_V2 is independent of the shell rollout flags', () => {
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
    overrideOnboardingFeatureFlags({
      shellV2Enabled: false,
      brandGateV2Enabled: false,
      executionStripV2Enabled: false,
    });
    expect(getOnboardingFeatureFlags().reviewUiV2).toBe(true);
    resetOnboardingFeatureFlags();
    overrideOnboardingFeatureFlags({ reviewUiV2: false });
    const flags = getOnboardingFeatureFlags();
    expect(flags.reviewUiV2).toBe(false);
    expect(flags.shellV2Enabled).toBe(true);
    expect(flags.brandGateV2Enabled).toBe(true);
    expect(flags.executionStripV2Enabled).toBe(true);
  });

  // Slice 7: UI/server separation — client flags carry exactly the five UI
  // keys (pipelineDiagnosticsEnabled removed with the board file); server
  // behavior never reads VITE_* (see src/onboarding/flags.ts).
  it('exposes exactly the UI-only flag keys', () => {
    expect(Object.keys(getOnboardingFeatureFlags()).sort()).toEqual(
      [
        'batchWorkspaceEnabled',
        'brandGateV2Enabled',
        'executionStripV2Enabled',
        'reviewUiV2',
        'shellV2Enabled',
      ].sort(),
    );
  });

  // Plan §tests: VITE_REVIEW_UI_V2 parsing incl. kill-switch values.
  describe('parseEnvFlag kill-switch truth table // plan line 197', () => {
    it.each([
      [undefined, false, false], // absent ⇒ default
      ['', false, false], // empty ⇒ default
      ['   ', false, false], // whitespace ⇒ default
      ['false', false, false],
      ['0', false, false],
      ['no', false, false],
      ['FALSE', false, false], // case-insensitive
      ['No', false, false],
      ['true', false, true],
      ['1', false, true],
      ['yes', false, true],
      ['garbage', false, true], // any other non-empty enables
      [undefined, true, true], // default=true honored
      ['', true, true],
    ])('raw=%p default=%p ⇒ %p', (raw, defaultValue, expected) => {
      expect(parseEnvFlag(raw as string | undefined, defaultValue)).toBe(expected);
    });
  });
});
