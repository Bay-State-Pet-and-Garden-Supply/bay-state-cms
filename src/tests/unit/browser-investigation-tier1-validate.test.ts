// #237 Worker C — Tier-1 results still validate through the production
// path (Vitest, fakes).
//
// A Tier-1-flavored completed investigation (page_rendered observations
// merged over the Tier 0 base, truthful modelCalls: 1 with a stub acting
// model) must flow through the UNCHANGED compile → production-worker
// representative + blind-holdout validation → governed-draft path: the
// pilot passes with the holdout counted, and the report carries the real
// call count and model. A Tier-1 observation that leaks holdout material
// fails closed with holdout_exposed instead of validating.

import { describe, expect, it } from 'vitest';
import { FakeInvestigationProvider } from '../../onboarding/browser-investigation/fake-provider';
import {
  registerInvestigationProvider,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import { requestAndRunInvestigation } from '../../onboarding/browser-investigation/service';
import type { InvestigationRecord } from '../../shared/schemas/browser-investigation';
import type { PolicyWorkerRunner } from '../../onboarding/browser-investigation/validate';
import { runPilot } from '../../onboarding/browser-investigation/pilot';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const DOMAIN = 'shop.example.com';
const REP = 'https://shop.example.com/products/alpha';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';
const ISOLATION_OK = { available: true, reason: 'test isolation reachable' };

function expected(name: string) {
  return {
    name,
    sku: 'BB-ALPHA',
    gtin: '810001234501',
    variantKey: 'shopify:111:Small',
    productId: '999001',
  };
}

function passingRunner(): PolicyWorkerRunner {
  return {
    run: async ({ expected: exp }) => ({
      ok: true,
      data: {
        title: exp.name,
        brand: 'BetterBone',
        description: 'Tier-1 validation-path extraction.',
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
      sourceContentHash: 'tier1-contract-content-hash',
    }),
  };
}

function tier1Investigate(detail: string) {
  return async (input: { workspaceId: string; domain: string; representativeUrls: string[] }) => {
    const investigations = createMemoryInvestigationStore();
    const fake = new FakeInvestigationProvider();
    fake.setScenario('valid');
    registerInvestigationProvider(fake);
    resetInvestigationProviderCalls();
    const record = await requestAndRunInvestigation(investigations, {
      workspaceId: input.workspaceId,
      domain: input.domain,
      mode: 'domain_onboarding',
      sampleUrls: input.representativeUrls,
      provider: 'fake',
    });
    // Tier-1 flavor over the deterministic base: one rendered observation
    // merged in, one counted model call with the acting stub model.
    const result = record.result as unknown as {
      observations: Array<Record<string, unknown>>;
      gaps: string[];
    };
    const tier1: InvestigationRecord = {
      ...record,
      result: {
        ...(record.result as unknown as Record<string, unknown>),
        observations: [
          ...result.observations,
          {
            kind: 'page_rendered',
            sourceUrl: input.representativeUrls[0],
            artifactHash: 'ab'.repeat(32),
            detail,
            incomplete: false,
          },
        ],
        gaps: [...result.gaps, 'Tier 1 rendered read through the validating proxy; advisory stub reasoning'],
        recommendedStrategy: 'stub-advisory-strategy',
      } as unknown as InvestigationRecord['result'],
      usage: { ...record.usage!, modelCalls: 1 },
      actualModel: { provider: 'stub', model: 'stub-reasoner-v1' },
    };
    return tier1;
  };
}

function depsFor(detail: string) {
  let n = 0;
  return {
    domain: DOMAIN,
    representativeUrls: [REP],
    holdoutUrls: [HOLDOUT],
    expectedByUrl: { [REP]: expected('Alpha'), [HOLDOUT]: expected('Holdout') },
    env: { BAYSTATE_CMS_BROWSER_INVESTIGATION_PILOT: '1' },
    checkIsolation: async () => ISOLATION_OK,
    investigate: tier1Investigate(detail),
    runner: passingRunner(),
    createVersion: (input: Record<string, unknown>) => {
      n += 1;
      return { id: `ver_tier1_${n}`, domain: String((input as { domain?: unknown }).domain ?? DOMAIN), version: n };
    },
  };
}

describe('Tier-1 results validate through the production path (#237)', () => {
  it('a Tier-1-flavored result compiles, validates reps + blind holdout, and reports truthful usage', async () => {
    const outcome = await runPilot(depsFor('rendered title: Alpha; meta: present; json-ld blocks: 1; images: 2'));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.passed).toBe(true);
    expect(outcome.report?.stepsPerformed).toContain('validation_passed');
    expect(outcome.report?.stepsPerformed).toContain('draft_applied');
    expect(outcome.report?.validation?.holdoutsPassed).toBe(1);
    // Truthful Tier-1 usage: the counted call and the acting stub model.
    expect(outcome.report?.modelCalls).toBe(1);
    expect(outcome.report?.usage.modelCalls).toBe(1);
    expect(outcome.report?.actingModel).toEqual({ provider: 'stub', model: 'stub-reasoner-v1' });
    expect(outcome.report?.renderOptIn).toBe(false);
  });

  it('records renderOptIn when the Tier-1 render switch was opted in', async () => {
    const outcome = await runPilot({
      ...depsFor('rendered title: Alpha; meta: present; json-ld blocks: 1; images: 2'),
      renderOptIn: true,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.renderOptIn).toBe(true);
    expect(outcome.report?.notes.join('\n')).toMatch(/Tier-1 rendered investigation was opted in/);
  });

  it('fails closed when Tier-1 rendered detail leaks holdout material', async () => {
    const outcome = await runPilot(depsFor(`rendered follow-up, see also ${HOLDOUT} for comparison`));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.passed).toBe(false);
    expect(outcome.report?.failureCode ?? '').toMatch(/holdout_exposed/);
    expect(outcome.report?.draft).toBeNull();
  });
});
