// #239 — pilot gates + thin-slice orchestration contract (Vitest, fakes).
//
// CONTRACT TEST ONLY — not the acceptance proof. The acceptance proof is the
// recorded opt-in run against a real Shopify domain
// (docs/plans/browser-investigation-pilot.md), which executes the real
// containerized harness through the production worker with a truly blind
// holdout. This suite pins the pilot's fail-closed gates, blindness,
// server-authoritative apply, and non-claims with deterministic doubles:
// explicit fake-provider injection for investigation, a stub worker for
// validation, and a capturing version creator (no DB, no network, no Docker).

import { describe, expect, it } from 'vitest';
import {
  FakeInvestigationProvider,
} from '../../onboarding/browser-investigation/fake-provider';
import {
  registerInvestigationProvider,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import {
  requestAndRunInvestigation,
} from '../../onboarding/browser-investigation/service';
import type { PolicyWorkerRunner } from '../../onboarding/browser-investigation/validate';
import {
  evaluatePilotGates,
  parseExpectedIdentities,
  parsePilotArgv,
  runPilot,
  PILOT_ENV_FLAG,
  type PilotDeps,
} from '../../onboarding/browser-investigation/pilot';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const DOMAIN = 'shop.example.com';
const REP = 'https://shop.example.com/products/alpha';
const REP2 = 'https://shop.example.com/products/beta';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';
const ISOLATION_OK = { available: true, reason: 'test isolation reachable' };
const ISOLATION_DOWN = { available: false, reason: 'test isolation unreachable' };

function expected(name: string) {
  return {
    name,
    sku: 'BB-ALPHA',
    gtin: '810001234501',
    variantKey: 'shopify:111:Small',
    productId: '999001',
  };
}

function gateOptions(overrides: Partial<{
  domain: string | null;
  representativeUrls: string[];
  holdoutUrls: string[];
  expectedByUrl: Record<string, ReturnType<typeof expected> | undefined>;
}> = {}) {
  return {
    domain: DOMAIN,
    representativeUrls: [REP],
    holdoutUrls: [HOLDOUT],
    expectedByUrl: { [REP]: expected('Alpha'), [HOLDOUT]: expected('Holdout') },
    ...overrides,
  };
}

function passingRunner(): PolicyWorkerRunner {
  return {
    run: async ({ expected: exp }) => ({
      ok: true,
      data: {
        title: exp.name,
        brand: 'BetterBone',
        description: 'Deterministic pilot contract extraction.',
        price: '$12.99',
        primaryImage: 'https://shop.example.com/images/alpha.jpg',
        additionalImages: [],
        customFields: {
          sku: exp.sku ?? 'BB-ALPHA',
          gtin: '810001234501',
          variants: 'Small',
          availability: 'in_stock',
        },
        fieldProvenance: {},
      },
      matrixDecision: { status: 'match', selectedVariantKey: 'shopify:111:Small' },
      selectedReceipt: { selectedVariantKey: 'shopify:111:Small' },
      parentProductId: '999001',
      sourceContentHash: 'pilot-contract-content-hash',
    }),
  };
}

/** Explicit fake-provider investigation (contract double only, never production). */
function fakeInvestigate(scenario: 'valid' = 'valid') {
  return async (input: { workspaceId: string; domain: string; representativeUrls: string[] }) => {
    const investigations = createMemoryInvestigationStore();
    const fake = new FakeInvestigationProvider();
    fake.setScenario(scenario);
    registerInvestigationProvider(fake);
    resetInvestigationProviderCalls();
    return requestAndRunInvestigation(investigations, {
      workspaceId: input.workspaceId,
      domain: input.domain,
      mode: 'domain_onboarding',
      sampleUrls: input.representativeUrls,
      provider: 'fake',
    });
  };
}

function pilotDeps(overrides: Partial<PilotDeps> = {}): PilotDeps {
  let n = 0;
  return {
    domain: DOMAIN,
    representativeUrls: [REP],
    holdoutUrls: [HOLDOUT],
    expectedByUrl: { [REP]: expected('Alpha'), [HOLDOUT]: expected('Holdout') },
    env: { [PILOT_ENV_FLAG]: '1' },
    checkIsolation: async () => ISOLATION_OK,
    investigate: fakeInvestigate(),
    runner: passingRunner(),
    createVersion: (input) => {
      n += 1;
      return { id: `ver_pilot_${n}`, domain: String((input as { domain?: unknown }).domain ?? DOMAIN), version: n };
    },
    ...overrides,
  };
}

describe('pilot gates (#239)', () => {
  it('refuses without the explicit opt-in flag', () => {
    expect(evaluatePilotGates({}, ISOLATION_OK, gateOptions()).ok).toBe(false);
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '0' }, ISOLATION_OK, gateOptions()).ok).toBe(false);
  });

  it('refuses under CI even with the flag set', () => {
    const gate = evaluatePilotGates({ [PILOT_ENV_FLAG]: '1', CI: '1' }, ISOLATION_OK, gateOptions());
    expect(gate.ok).toBe(false);
  });

  it('refuses without isolation, domain, or explicit in-domain URLs', () => {
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_DOWN, gateOptions()).ok).toBe(false);
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, gateOptions({ domain: null })).ok).toBe(false);
    expect(
      evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, gateOptions({ representativeUrls: [] })).ok,
    ).toBe(false);
    expect(
      evaluatePilotGates(
        { [PILOT_ENV_FLAG]: '1' },
        ISOLATION_OK,
        gateOptions({ holdoutUrls: ['https://evil.example.net/products/x'], expectedByUrl: { [REP]: expected('A'), ['https://evil.example.net/products/x']: expected('X') } }),
      ).ok,
    ).toBe(false);
  });

  it('refuses a holdout that is also a representative (blindness at the gate)', () => {
    const gate = evaluatePilotGates(
      { [PILOT_ENV_FLAG]: '1' },
      ISOLATION_OK,
      gateOptions({ holdoutUrls: [REP], expectedByUrl: { [REP]: expected('A') } }),
    );
    expect(gate.ok).toBe(false);
  });

  it('refuses a holdout that is a slash variant of a representative (canonical identity)', () => {
    const gate = evaluatePilotGates(
      { [PILOT_ENV_FLAG]: '1' },
      ISOLATION_OK,
      gateOptions({ holdoutUrls: [`${REP}/`], expectedByUrl: { [REP]: expected('A') } }),
    );
    expect(gate.ok).toBe(false);
  });

  it('requires trusted expected identities (name, identifier, and productId)', () => {
    const noName = gateOptions({ expectedByUrl: { [REP]: { name: '', sku: 'S', productId: 'P' } as never, [HOLDOUT]: expected('H') } });
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, noName).ok).toBe(false);
    const noId = gateOptions({ expectedByUrl: { [REP]: { name: 'A', productId: 'P' } as never, [HOLDOUT]: expected('H') } });
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, noId).ok).toBe(false);
    const noProduct = gateOptions({ expectedByUrl: { [REP]: { name: 'A', sku: 'S' } as never, [HOLDOUT]: expected('H') } });
    expect(evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, noProduct).ok).toBe(false);
  });
});

describe('runPilot contract (fakes; NOT the acceptance proof)', () => {
  it('gate refusals never touch the harness', async () => {
    let touched = 0;
    const outcome = await runPilot(
      pilotDeps({
        env: {},
        investigate: async () => {
          touched += 1;
          throw new Error('should never run');
        },
      }),
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(touched).toBe(0);
  });

  it('delivers a governed draft with a passing blind holdout and explicit non-claims', async () => {
    const seen: Array<{ workspaceId: string; domain: string; representativeUrls: string[] }> = [];
    const outcome = await runPilot(
      pilotDeps({
        representativeUrls: [REP, REP2],
        holdoutUrls: [HOLDOUT],
        expectedByUrl: { [REP]: expected('Alpha'), [REP2]: expected('Beta'), [HOLDOUT]: expected('Holdout') },
        investigate: async (input) => {
          seen.push(input);
          return fakeInvestigate()(input);
        },
        now: () => '2026-09-18T00:00:00.000Z',
      }),
    );
    expect(outcome.exitCode).toBe(0);
    const report = outcome.report!;
    // Blindness: the investigator saw representatives only, never the holdout.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.representativeUrls).toEqual([REP, REP2]);
    expect(seen[0]!.representativeUrls).not.toContain(HOLDOUT);
    // Performed steps in order.
    expect(report.stepsPerformed).toEqual([
      'isolation_verified',
      'investigation_completed',
      'proposal_compiled',
      'validation_passed',
      'draft_applied',
    ]);
    expect(report.provider).toBe('fake');
    expect(report.validation?.status).toBe('passed');
    expect(report.validation?.holdoutsPassed).toBeGreaterThanOrEqual(1);
    expect(report.validation?.holdoutSampleIds).toContain(HOLDOUT);
    // Governed draft: inactive, no image grant, blockers preserved.
    expect(report.draft?.inactive).toBe(true);
    expect(report.draft?.imageRuleOk).toBe(false);
    // Explicit non-claims.
    expect(report.activationPerformed).toBe(false);
    expect(report.releasePerformed).toBe(false);
    expect(report.attestationPerformed).toBe(false);
    expect(report.passed).toBe(true);
    expect(report.failureCode).toBeNull();
  });

  it('fails closed when validation does not pass (no draft, no claims)', async () => {
    const failing: PolicyWorkerRunner = {
      run: async () => ({ ok: false, error: 'worker blew up', failureCode: 'worker_failed' }),
    };
    const outcome = await runPilot(pilotDeps({ runner: failing }));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.passed).toBe(false);
    expect(outcome.report?.draft).toBeNull();
    expect(outcome.report?.activationPerformed).toBe(false);
    expect(outcome.report?.releasePerformed).toBe(false);
    expect(outcome.report?.attestationPerformed).toBe(false);
  });
});

describe('pilot CLI + expected-identity parsing (#239)', () => {
  it('parses repeatable URL flags and named values', () => {
    const parsed = parsePilotArgv([
      '--domain', DOMAIN,
      '--rep-url', REP,
      '--representative-url', REP2,
      '--holdout-url', HOLDOUT,
      '--expected-json', '/tmp/expected.json',
      '--workspace', 'ws-explicit',
      '--actor', 'operator',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('argv must parse');
    expect(parsed.value).toMatchObject({
      domain: DOMAIN,
      representativeUrls: [REP, REP2],
      holdoutUrls: [HOLDOUT],
      expectedJsonPath: '/tmp/expected.json',
      workspaceId: 'ws-explicit',
      actor: 'operator',
    });
  });

  it('refuses unknown flags, missing values, and a missing expected-json', () => {
    expect(parsePilotArgv(['--nope', 'x'])).toMatchObject({ ok: false });
    expect(parsePilotArgv(['--domain', '--rep-url'])).toMatchObject({ ok: false });
    expect(parsePilotArgv(['--domain', DOMAIN])).toMatchObject({ ok: false });
  });

  it('parses the expected-identity map and canonicalizes URL keys', () => {
    const parsed = parseExpectedIdentities(
      JSON.stringify({ [`  ${REP} `]: { name: 'Alpha', sku: 'BB-ALPHA', productId: '999001' } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected identities must parse');
    expect(parsed.value[REP]?.sku).toBe('BB-ALPHA');
  });

  it('refuses malformed, empty, and non-object expected-identity payloads', () => {
    expect(parseExpectedIdentities('{')).toMatchObject({ ok: false });
    expect(parseExpectedIdentities('[]')).toMatchObject({ ok: false });
    expect(parseExpectedIdentities('{}')).toMatchObject({ ok: false });
    expect(parseExpectedIdentities(JSON.stringify({ [REP]: 'nope' }))).toMatchObject({ ok: false });
  });
});
