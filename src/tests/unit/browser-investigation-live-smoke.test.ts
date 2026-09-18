// T6 (#230) — opt-in live smoke stays out of deterministic CI (Vitest).
//
// - Gate refusals never touch the harness (no live calls in CI, without the
//   explicit flag, without isolation, or without explicit public URLs).
// - A completed smoke records ONLY what was actually performed plus explicit
//   non-performance of activation, release, and attestation — approvals are
//   never inferred.

import { describe, expect, it } from 'vitest';
import {
  evaluateLiveSmokeGates,
  runLiveSmoke,
  LIVE_SMOKE_ENV_FLAG,
} from '../../onboarding/browser-investigation/live-smoke';

const DOMAIN = 'shop.example.com';
const SAMPLES = ['https://shop.example.com/products/alpha'];
const MODEL = 'local:qwen2.5vl:latest';
const ISOLATION_OK = { available: true, reason: 'isolated Docker runtime reachable' };
const ISOLATION_DOWN = { available: false, reason: 'isolated Docker runtime unreachable' };

function gatedOptions(overrides: Partial<{ domain: string | null; sampleUrls: string[]; modelRef: string | null }> = {}) {
  return {
    domain: DOMAIN,
    sampleUrls: SAMPLES,
    modelRef: MODEL,
    ...overrides,
  };
}

describe('live smoke gates (T6)', () => {
  it('refuses without the explicit opt-in flag', () => {
    expect(evaluateLiveSmokeGates({}, ISOLATION_OK, gatedOptions()).ok).toBe(false);
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '0' }, ISOLATION_OK, gatedOptions()).ok).toBe(false);
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: 'yes' }, ISOLATION_OK, gatedOptions()).ok).toBe(false);
  });

  it('refuses under CI even with the flag set', () => {
    const env = { [LIVE_SMOKE_ENV_FLAG]: '1', CI: '1' };
    const gate = evaluateLiveSmokeGates(env, ISOLATION_OK, gatedOptions());
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain('CI');
  });

  it('refuses without isolation, credentials, or explicit public URLs', () => {
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_DOWN, gatedOptions()).ok).toBe(false);
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions({ modelRef: null })).ok).toBe(false);
    expect(
      evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions({ modelRef: 'api-key=sk-live-123' })).ok,
    ).toBe(false);
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions({ domain: null })).ok).toBe(false);
    expect(evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions({ sampleUrls: [] })).ok).toBe(false);
    expect(
      evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions({ sampleUrls: ['http://10.0.0.1/private'] })).ok,
    ).toBe(false);
  });

  it('accepts the explicit opt-in with isolation, credentials, and in-domain public URLs', () => {
    const gate = evaluateLiveSmokeGates({ [LIVE_SMOKE_ENV_FLAG]: '1' }, ISOLATION_OK, gatedOptions());
    expect(gate.ok).toBe(true);
  });

  it('rejects lookalike domains; accepts true subdomains (dot-boundary)', () => {
    const env = { [LIVE_SMOKE_ENV_FLAG]: '1' };
    const evil = evaluateLiveSmokeGates(env, ISOLATION_OK, gatedOptions({ sampleUrls: ['https://evil-shop.example.com/products/alpha'] }));
    expect(evil.ok).toBe(false);
    const sub = evaluateLiveSmokeGates(env, ISOLATION_OK, gatedOptions({ sampleUrls: ['https://store.shop.example.com/products/alpha'] }));
    expect(sub.ok).toBe(true);
  });
});

describe('runLiveSmoke (T6)', () => {
  it('gate refusals never touch the harness', async () => {
    let touched = 0;
    const outcome = await runLiveSmoke({
      domain: DOMAIN,
      sampleUrls: SAMPLES,
      modelRef: MODEL,
      env: {},
      checkIsolation: async () => ISOLATION_OK,
      performLiveInvestigation: async () => {
        touched += 1;
        return { steps: ['should never run'] };
      },
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(touched).toBe(0);
  });

  it('records only what was performed with explicit non-activation', async () => {
    const outcome = await runLiveSmoke({
      domain: DOMAIN,
      sampleUrls: SAMPLES,
      modelRef: MODEL,
      env: { [LIVE_SMOKE_ENV_FLAG]: '1' },
      checkIsolation: async () => ISOLATION_OK,
      performLiveInvestigation: async () => ({ steps: ['isolation_verified', 'bounded_live_read'], notes: ['public fixture page'] }),
      now: () => '2026-09-18T00:00:00.000Z',
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.stepsPerformed).toEqual(['isolation_verified', 'bounded_live_read']);
    expect(outcome.report?.activationPerformed).toBe(false);
    expect(outcome.report?.releasePerformed).toBe(false);
    expect(outcome.report?.attestationPerformed).toBe(false);
    expect(outcome.report?.passed).toBe(true);
  });

  it('harness failures surface as failed smoke without inferring approvals', async () => {
    const outcome = await runLiveSmoke({
      domain: DOMAIN,
      sampleUrls: SAMPLES,
      modelRef: MODEL,
      env: { [LIVE_SMOKE_ENV_FLAG]: '1' },
      checkIsolation: async () => ISOLATION_OK,
      performLiveInvestigation: async () => {
        throw new Error('isolation_unavailable: daemon unreachable');
      },
      now: () => '2026-09-18T00:00:00.000Z',
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.passed).toBe(false);
    expect(outcome.report?.activationPerformed).toBe(false);
    expect(outcome.report?.releasePerformed).toBe(false);
    expect(outcome.report?.attestationPerformed).toBe(false);
  });
});
