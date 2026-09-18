// T6 (#230) — investigation telemetry derived from persisted state
// (Vitest, pure).
//
// - Records lifecycle, provider/domain, mode, duration, sample counts, run
//   identity, usage/cost, recommended strategy, rendered-browser need, gap
//   counts, validation outcomes, and wrong-product / wrong-variant signals.
// - Missing usage is explicit unavailable (never zero, never fabricated);
//   billed cost stays distinct from estimates.
// - Never leaks keys, sensitive prompts, uncontrolled page content, or
//   workspace-private knownContext VALUES (key names only).

import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_RESULT_VERSION,
  resolveInvestigationBudget,
  type InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import {
  describeInvestigationTelemetry,
  withCompileGapCount,
} from '../../onboarding/browser-investigation/telemetry';
import type { ProposalValidation } from '../../onboarding/browser-investigation/validate';

const WS = 'ws-t6-telemetry';
const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';

function recordWith(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return {
    id: 'binv_telemetry_1',
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    status: 'completed',
    provider: 'local_browser_harness',
    runId: 'binvrun_telemetry_1',
    requestedModel: { provider: 'local', model: 'qwen2.5vl:latest' },
    actualModel: { provider: 'local', model: 'qwen2.5vl:latest' },
    inputSnapshot: {
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: [REP_A],
      budget: resolveInvestigationBudget(),
      modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
      knownContext: {
        operatorNote: 'recheck variant images',
        secretMaterial: 'sk-live-super-secret-12345',
      },
      requestedAt: '2026-09-18T00:00:00.000Z',
    },
    inputHash: 'input-hash-telemetry-1-input-hash-telemetry-1',
    budget: resolveInvestigationBudget(),
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:01.000Z',
    startedAt: '2026-09-18T00:00:00.000Z',
    completedAt: '2026-09-18T00:01:00.000Z',
    usage: {
      modelCalls: 3,
      pagesVisited: 2,
      readsPerformed: 5,
      durationMs: 60_000,
      costUsd: 0.42,
      costBasis: 'billed',
    },
    failureCode: null,
    failureDetail: null,
    result: {
      version: INVESTIGATION_RESULT_VERSION,
      summary: 'Telemetry fixture. Untrusted proposal evidence only.',
      observations: [
        { kind: 'shopify_json_observation', sourceUrl: REP_A, artifactHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', incomplete: false },
      ],
      evidenceRefs: ['artifact:alpha'],
      gaps: ['unresolved:availability has no supported source'],
      recommendedStrategy: 'fake-adapter-first',
      renderedBrowserRequired: true,
      renderedBrowserReason: 'variant options hydrate client-side',
      platform: 'shopify',
      incompatibleStructureIds: [],
      structures: [{ id: 'shopify-default', sampleUrls: [REP_A] }],
      fieldRecommendations: POLICY_FIELDS.map((field) => ({ field, sources: ['shopify_product_json'] as string[] })),
      identityRequirements: {
        productIdentity: ['gtin_exact'],
        variantIdentity: ['gtin_exact'],
        optionAxes: [],
      },
    },
    resultHash: 'result-hash-telemetry-1-result-hash-telemetry-1',
    discardedAt: null,
    discardActor: null,
    ...overrides,
  } as InvestigationRecord;
}

function validationWith(): ProposalValidation {
  return {
    validationId: 'vval_telemetry_1',
    investigationId: 'binv_telemetry_1',
    domain: DOMAIN,
    status: 'failed',
    proposalHash: 'p'.repeat(64),
    policyHash: 'a'.repeat(64),
    baselineVersionId: null,
    samples: [
      {
        url: REP_A,
        role: 'representative',
        status: 'pass',
        identityOutcome: 'match',
        selectedVariantKey: 'v1',
        parentProductId: 'p1',
        fieldResults: [],
        failureReasons: [],
        artifactHash: 'a1b2',
      },
      {
        url: 'https://shop.example.com/products/holdout-1',
        role: 'holdout',
        status: 'fail',
        identityOutcome: 'wrong_variant',
        selectedVariantKey: 'v2',
        parentProductId: 'p1',
        fieldResults: [],
        failureReasons: ['wrong_variant:expected v1 resolved v2'],
        artifactHash: 'c3d4',
      },
      {
        url: 'https://shop.example.com/products/holdout-2',
        role: 'holdout',
        status: 'fail',
        identityOutcome: 'wrong_product',
        selectedVariantKey: null,
        parentProductId: 'pX',
        fieldResults: [],
        failureReasons: ['wrong_product:expected product p1 extracted pX'],
        artifactHash: 'e5f6',
      },
    ],
    holdouts: { required: 1, passed: 0, sampleIds: ['https://shop.example.com/products/holdout-1', 'https://shop.example.com/products/holdout-2'] },
    blockers: ['holdout_failed:no blind holdout passed'],
    validatedAt: '2026-09-18T00:02:00.000Z',
    validationHash: 'validation-hash-telemetry-1-validation-hash',
  };
}

describe('investigation telemetry (T6)', () => {
  it('records lifecycle, provider/domain, mode, duration, samples, run identity, and strategy', () => {
    const telemetry = describeInvestigationTelemetry(recordWith(), null);
    expect(telemetry.investigationId).toBe('binv_telemetry_1');
    expect(telemetry.domain).toBe(DOMAIN);
    expect(telemetry.mode).toBe('domain_onboarding');
    expect(telemetry.status).toBe('completed');
    expect(telemetry.provider).toBe('local_browser_harness');
    expect(telemetry.runId).toBe('binvrun_telemetry_1');
    expect(telemetry.durationMs).toBe(60_000);
    expect(telemetry.sampleCounts).toEqual({ requested: 1, investigated: 1 });
    expect(telemetry.recommendedStrategy).toBe('fake-adapter-first');
    expect(telemetry.renderedBrowser).toEqual({ required: true, reason: 'variant options hydrate client-side' });
    expect(telemetry.gapCounts.resultGaps).toBe(1);
    expect(telemetry.requestedModel).toContain('local');
    expect(telemetry.actualModel).toContain('local');
  });

  it('distinguishes billed cost from estimates and reports unavailable honestly', () => {
    const billed = describeInvestigationTelemetry(recordWith(), null);
    expect(billed.usage.costBasis).toBe('billed');
    expect(billed.usage.costDisplay).toContain('(billed)');

    const estimated = describeInvestigationTelemetry(
      recordWith({ usage: { modelCalls: 1, costUsd: 0.1, costBasis: 'estimated' } }),
      null,
    );
    expect(estimated.usage.costBasis).toBe('estimated');
    expect(estimated.usage.costDisplay).toContain('(estimated)');

    const missing = describeInvestigationTelemetry(recordWith({ usage: null }), null);
    expect(missing.usage.costUsd).toBeNull();
    expect(missing.usage.costBasis).toBe('unavailable');
    expect(missing.usage.costDisplay).toBe('unavailable');
  });

  it('records validation outcomes and wrong-product / wrong-variant signals', () => {
    const telemetry = describeInvestigationTelemetry(recordWith(), validationWith());
    expect(telemetry.validation?.status).toBe('failed');
    expect(telemetry.validation?.representativeTotal).toBe(1);
    expect(telemetry.validation?.representativePassed).toBe(1);
    expect(telemetry.validation?.holdoutsPassed).toBe(0);
    expect(telemetry.identitySignals).toEqual({ wrongProduct: 1, wrongVariant: 1, ambiguous: 0, noMatch: 0, matched: 1 });
    expect(telemetry.validation?.blockers).toContain('holdout_failed:no blind holdout passed');
  });

  it('never leaks keys, knownContext values, or page content', () => {
    const telemetry = describeInvestigationTelemetry(recordWith(), validationWith());
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain('sk-live-super-secret-12345');
    expect(serialized).not.toContain('recheck variant images');
    expect(telemetry.knownContextKeys).toEqual(['operatorNote', 'secretMaterial']);
  });

  it('attaches compiler gap counts without re-deriving anything else', () => {
    const base = describeInvestigationTelemetry(recordWith(), null);
    const withGaps = withCompileGapCount(base, 2);
    expect(withGaps.gapCounts.compileGaps).toBe(2);
    expect(withGaps.investigationId).toBe(base.investigationId);
  });
});
