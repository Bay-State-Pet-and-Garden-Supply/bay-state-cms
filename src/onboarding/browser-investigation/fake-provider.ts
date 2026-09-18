// Deterministic fake investigation provider (T1; test-only since #235).
//
// Covers the eight provider behaviors the lifecycle must survive:
// valid, malformed, evidence-missing, timeout, error, cancellation,
// replayed-completion, and budget-exhaustion. No network, no timers, no
// randomness — scenario is explicit per invocation so tests are deterministic.
//
// Never registered in production routes: tests construct it explicitly via
// `new FakeInvestigationProvider()` (or the shared singleton) and register
// it in their own process. Production launches default to the real local
// harness and reject `fake` with `invalid_input` before any row is created.
//
// Stale/replayed completions are rejected by the SERVICE (runId + inputHash
// binding), not by this fake: the `replayed_completion` scenario exposes a
// `replay()` helper that re-delivers an already-accepted completion.

import { z } from 'zod';
import type {
  InvestigationProviderCompletion,
  InvestigationProviderRequest,
  InvestigationProvider,
} from './provider';
import { InvestigationProviderError } from './provider';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';

const FakeInvestigationScenarioSchema = z.enum([
  'valid',
  'malformed',
  'evidence_missing',
  'timeout',
  'error',
  'cancellation',
  'replayed_completion',
  'budget_exhaustion',
]);

// Scenario selector for the deterministic fake. Tests set it per invocation
// (explicit injection only — never via any operator launch contract since
// #235); T2+ suites reuse it for compiler/validation fixtures.
// fallow-ignore-next-line unused-type
export type FakeInvestigationScenario = z.infer<typeof FakeInvestigationScenarioSchema>;

export const FAKE_INVESTIGATION_SCENARIOS: readonly FakeInvestigationScenario[] =
  FakeInvestigationScenarioSchema.options;

function artifactHash(seed: string): string {
  let h = 0x811c9dc5;
  const s = `fake-artifact:${seed}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(4).slice(0, 32);
}

function validResult(request: InvestigationProviderRequest): Record<string, unknown> {
  // Adapter-first Shopify fixture: every field prefers the platform JSON
  // adapter with structured-data fallbacks, so the T2 compiler yields a
  // clean proposal with zero selector exceptions. Display-only
  // `recommendedStrategy` never influences compilation.
  const structureId = 'fake-shopify-default';
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: `Fake investigation of ${request.domain} (${request.mode}): deterministic fixture, untrusted.`,
    observations: request.sampleUrls.slice(0, 5).map((url, i) => ({
      kind: 'fake_dom_observation',
      sourceUrl: url,
      artifactHash: artifactHash(`${request.investigationId}:${i}:${url}`),
      detail: `Deterministic fake observation ${i + 1} for ${request.domain}. Untrusted proposal evidence only.`,
      incomplete: false,
    })),
    evidenceRefs: request.sampleUrls.slice(0, 5).map((_, i) => `fake-evidence:${request.investigationId}:${i}`),
    gaps: [],
    recommendedStrategy: 'fake-adapter-first',
    renderedBrowserRequired: false,
    platform: 'shopify',
    structures: [
      {
        id: structureId,
        sampleUrls: request.sampleUrls.slice(0, 5),
        description: 'Single Shopify product template (deterministic fake).',
        platformSource: 'shopify_product_json',
      },
    ],
    fieldRecommendations: POLICY_FIELDS.map((field) => ({
      field,
      sources: ['shopify_product_json', 'json_ld', 'meta'],
      structureId,
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact', 'sku_exact', 'platform_product_id'],
      variantIdentity: [
        'gtin_exact',
        'sku_exact',
        'platform_variant_id_exact',
        'options_exact_tuple',
        'operator_selection',
      ],
      optionAxes: [],
    },
  };
}

function throwIfFakeAborted(signal?: AbortSignal): void {
  // #244: an operator abort that lands before dispatch surfaces the stable
  // cancelled code, like the production harness boundary checks.
  if (signal?.aborted) {
    throw new InvestigationProviderError('cancelled', 'cancelled: fake investigation aborted by operator');
  }
}

function buildFakeBaseCompletion(request: InvestigationProviderRequest) {
  return {
    investigationId: request.investigationId,
    runId: request.runId,
    provider: 'fake' as const,
    inputHash: request.inputHash,
    usage: {
      modelCalls: 1,
      pagesVisited: Math.min(request.sampleUrls.length, request.budget.maxPages),
      readsPerformed: Math.min(request.sampleUrls.length, request.budget.maxReads),
      durationMs: 5,
      costUsd: null,
      costBasis: 'unavailable' as const,
    },
    actualModel: { provider: 'fake', model: 'fake-deterministic-v1' },
    durationMs: 5,
  } satisfies Partial<InvestigationProviderCompletion>;
}

type FakeBaseCompletion = ReturnType<typeof buildFakeBaseCompletion>;

/** Completion-carrying scenarios; null means the scenario throws instead. */
function fakeCompletionForScenario(
  scenario: FakeInvestigationScenario,
  request: InvestigationProviderRequest,
  base: FakeBaseCompletion,
): InvestigationProviderCompletion | null {
  switch (scenario) {
    case 'valid':
    case 'replayed_completion': {
      return { ...base, result: validResult(request) };
    }
    case 'malformed': {
      // Structurally invalid: wrong version type + missing observations.
      return {
        ...base,
        result: { version: 'not-a-version', summary: '', observations: 'oops' },
      };
    }
    case 'evidence_missing': {
      // Well-formed envelope but zero observations — must fail closed.
      return {
        ...base,
        result: {
          version: INVESTIGATION_RESULT_VERSION,
          summary: 'Fake evidence-missing fixture: no observations captured.',
          observations: [],
          evidenceRefs: [],
          gaps: ['no observations captured within budget'],
          renderedBrowserRequired: false,
        },
      };
    }
    default: {
      return null;
    }
  }
}

function throwFakeScenarioError(scenario: FakeInvestigationScenario): never {
  switch (scenario) {
    case 'timeout': {
      throw new InvestigationProviderError('timeout', 'timeout: fake investigation exceeded its budget');
    }
    case 'error': {
      throw new InvestigationProviderError('provider_error', 'provider_error: fake investigation failed');
    }
    case 'cancellation': {
      throw new InvestigationProviderError('cancelled', 'cancelled: fake investigation acknowledged cancellation');
    }
    case 'budget_exhaustion': {
      throw new InvestigationProviderError(
        'budget_exhausted',
        'budget_exhausted: fake investigation exceeded maxReads within budget',
      );
    }
    default: {
      throw new InvestigationProviderError('provider_error', `provider_error: unknown fake scenario ${String(scenario)}`);
    }
  }
}

export class FakeInvestigationProvider implements InvestigationProvider {
  readonly id = 'fake' as const;
  private scenario: FakeInvestigationScenario = 'valid';
  private lastCompletion: InvestigationProviderCompletion | null = null;

  setScenario(scenario: FakeInvestigationScenario): void {
    this.scenario = scenario;
    this.lastCompletion = null;
  }

  /** Re-deliver the last completion (replay-attack fixture). */
  replay(): InvestigationProviderCompletion {
    if (!this.lastCompletion) {
      throw new InvestigationProviderError('provider_error', 'provider_error: no completion available to replay');
    }
    return { ...this.lastCompletion };
  }

  async invoke(request: InvestigationProviderRequest): Promise<InvestigationProviderCompletion> {
    // NOTE: call accounting lives in invokeInvestigationProvider (provider.ts) —
    // recording here as well would double-count one run as two calls.
    throwIfFakeAborted(request.signal);
    const base = buildFakeBaseCompletion(request);
    const completion = fakeCompletionForScenario(this.scenario, request, base);
    if (completion) {
      this.lastCompletion = completion;
      return completion;
    }
    throwFakeScenarioError(this.scenario);
  }
}

export const fakeInvestigationProvider = new FakeInvestigationProvider();
