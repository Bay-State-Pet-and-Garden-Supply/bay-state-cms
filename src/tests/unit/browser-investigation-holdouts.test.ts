// T5 (#229) — blind-holdout governance: full-surface exposure plus
// reserved-holdout no-drop enforcement (Vitest, pure + memory stores).
//
// - Blindness spans ALL model-visible inputs (sample URLs, captured
//   artifacts, failure context, reports, metadata), not just the sample
//   list. Exposed samples lose holdout status, become tuning evidence, and
//   must be replaced.
// - Every reserved holdout runs: a later validation that drops a previously
//   reserved failing holdout is rejected before any worker call.
// - Holdout preference (one per structure, two total where the corpus
//   permits) is selection guidance only — never an unconditional gate.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
import type { InvestigationResult } from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import { requestInvestigation } from '../../onboarding/browser-investigation/service';
import { createMemoryProposalStore } from '../../onboarding/browser-investigation/apply';
import {
  findExposedHoldouts,
  suggestHoldoutCoverage,
} from '../../onboarding/browser-investigation/holdouts';
import {
  createMemoryValidationStore,
  validateProposal,
  type PolicyWorkerRunner,
  type ValidationSampleInput,
} from '../../onboarding/browser-investigation/validate';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const WS = 'ws-t5-holdouts';
const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';
const REP_B = 'https://shop.example.com/products/beta';
const HOLDOUT_1 = 'https://shop.example.com/products/holdout-1';
const HOLDOUT_2 = 'https://shop.example.com/products/holdout-2';
const ARTIFACT_A = 'a'.repeat(64);

function shopifyResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'T5 holdout fixture. Untrusted proposal evidence only.',
    observations: [
      { kind: 'fake_dom_observation', sourceUrl: REP_A, artifactHash: ARTIFACT_A, incomplete: false },
      { kind: 'fake_dom_observation', sourceUrl: REP_B, artifactHash: 'b'.repeat(64), incomplete: false },
    ],
    evidenceRefs: ['artifact:alpha'],
    gaps: [],
    incompatibleStructureIds: [],
    renderedBrowserRequired: false,
    platform: 'shopify',
    structures: [{ id: 'shopify-default', sampleUrls: [REP_A, REP_B] }],
    fieldRecommendations: POLICY_FIELDS.map((field) => ({
      field,
      sources: ['shopify_product_json'],
      structureId: 'shopify-default',
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact'],
      variantIdentity: ['gtin_exact', 'sku_exact', 'platform_id_exact', 'options_exact_tuple', 'operator_selected'],
      optionAxes: ['size'],
    },
    ...overrides,
  } as InvestigationResult;
}

function completedStore(result: InvestigationResult = shopifyResult()) {
  const store = createMemoryInvestigationStore();
  const created = requestInvestigation(store, {
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    sampleUrls: [REP_A, REP_B],
  });
  const record = store.update(WS, created.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    resultJson: JSON.stringify(result),
    resultHash: hashCanonicalJson(result),
    updatedAt: new Date().toISOString(),
  })!;
  return { store, record };
}

function passingRunner(): PolicyWorkerRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ sampleUrl }) => {
      calls.push(sampleUrl);
      return {
        ok: true,
        data: {
          title: 'BetterBone Beef',
          brand: 'BetterBone',
          description: 'Grass-fed chew.',
          price: '19.99',
          primaryImage: 'https://shop.example.com/cdn/small.jpg',
          additionalImages: [],
          customFields: { sku: 'BB-SM-001', gtin: '810001234501', variants: 'Small', availability: 'in_stock' },
        },
        matrixDecision: { status: 'resolved', selectedVariantKey: 'shopify:111:Small', matchedBy: 'gtin', reasonCodes: ['gtin_exact'] },
        parentProductId: '999001',
        sourceContentHash: 'c'.repeat(64),
      };
    },
  };
}

function sample(url: string, role: 'representative' | 'holdout', extra: Partial<ValidationSampleInput> = {}): ValidationSampleInput {
  return {
    url,
    role,
    expected: {
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      gtin: '810001234501',
      variantKey: 'shopify:111:Small',
      productId: '999001',
    },
    ...extra,
  };
}

describe('holdout exposure: URL and artifact surfaces', () => {
  it('a clean holdout is blind', () => {
    const { record } = completedStore();
    expect(findExposedHoldouts(record, [{ url: HOLDOUT_1 }])).toEqual([]);
  });

  it('an investigated sample URL loses holdout status via sample_url', () => {
    const { record } = completedStore();
    const [exposure] = findExposedHoldouts(record, [{ url: REP_A }]);
    expect(exposure?.via).toBe('sample_url');
  });

  it('a supplied artifactRef matching a captured artifact exposes via artifact', () => {
    const { record } = completedStore();
    const [exposure] = findExposedHoldouts(record, [{ url: HOLDOUT_1, artifactRef: ARTIFACT_A }]);
    expect(exposure?.via).toBe('artifact');
  });
});

describe('holdout exposure: context, report, and metadata surfaces', () => {
  it('a holdout named in failure context exposes via failure_context', () => {
    const { store, record } = completedStore();
    const updated = store.update(WS, record.id, {
      failureCode: 'timeout',
      failureDetail: `capture timed out on ${HOLDOUT_1}; retry within budget`,
      updatedAt: new Date().toISOString(),
    })!;
    const [exposure] = findExposedHoldouts(updated, [{ url: HOLDOUT_1 }]);
    expect(exposure?.via).toBe('failure_context');
  });

  it('a holdout named in evidence refs exposes via report', () => {
    const { record } = completedStore(shopifyResult({ evidenceRefs: [`see ${HOLDOUT_1} for the variant matrix`] }));
    const [exposure] = findExposedHoldouts(record, [{ url: HOLDOUT_1 }]);
    expect(exposure?.via).toBe('report');
  });

  it('a holdout named in operator knownContext exposes via metadata', () => {
    const fresh = createMemoryInvestigationStore();
    const created = requestInvestigation(fresh, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: [REP_A, REP_B],
      knownContext: { debugUrl: HOLDOUT_1 },
    });
    const result = shopifyResult();
    const completed = fresh.update(WS, created.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultJson: JSON.stringify(result),
      resultHash: hashCanonicalJson(result),
      updatedAt: new Date().toISOString(),
    })!;
    const [exposure] = findExposedHoldouts(completed, [{ url: HOLDOUT_1 }]);
    expect(exposure?.via).toBe('metadata');
  });

  async function rejectsExposedHoldout(result: InvestigationResult, holdout: ValidationSampleInput, pattern: RegExp): Promise<PolicyWorkerRunner & { calls: string[] }> {
    const { store, record } = completedStore(result);
    const runner = passingRunner();
    await expect(
      validateProposal(
        { investigations: store, proposals: createMemoryProposalStore(), validations: createMemoryValidationStore(), runner },
        {
          workspaceId: WS,
          investigationId: record.id,
          samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), holdout],
        },
      ),
    ).rejects.toThrow(pattern);
    return runner;
  }

  it('validation rejects an artifact-exposed holdout before any worker call', async () => {
    const runner = await rejectsExposedHoldout(
      shopifyResult(),
      sample(HOLDOUT_1, 'holdout', { artifactRef: ARTIFACT_A }),
      /holdout_exposed.*artifact/,
    );
    expect(runner.calls).toEqual([]);
  });

  it('catches slash-variant leaks in failure context', async () => {
    const { store, record } = completedStore();
    store.update(WS, record.id, {
      failureCode: 'timeout',
      failureDetail: `capture timed out on ${HOLDOUT_1}; retry within budget`,
      updatedAt: new Date().toISOString(),
    });
    const [exposure] = findExposedHoldouts(store.find(WS, record.id)!, [{ url: `${HOLDOUT_1}/` }]);
    expect(exposure?.via).toBe('failure_context');
  });

  it('validation rejects a report-exposed holdout before any worker call', async () => {
    const runner = await rejectsExposedHoldout(
      shopifyResult({ gaps: [`unresolved variant images on ${HOLDOUT_1}`] }),
      sample(HOLDOUT_1, 'holdout'),
      /holdout_exposed.*report/,
    );
    expect(runner.calls).toEqual([]);
  });
});

function failingRunner(): PolicyWorkerRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ sampleUrl }) => {
      calls.push(sampleUrl);
      if (sampleUrl === HOLDOUT_1) {
        return {
          ok: false,
          error: 'variant_selection_required',
          failureCode: 'variant_selection_required',
          matrixDecision: { status: 'ambiguous', selectedVariantKey: null, matchedBy: 'none', reasonCodes: ['duplicate_identifier'] },
        };
      }
      return passingRunner().run({ profile: null as never, sampleUrl, expected: null as never });
    },
  };
}

/** Standard first validation reserving HOLDOUT_1 (passing worker throughout). */
async function reserveHoldout() {
  const { store, record } = completedStore();
  const validations = createMemoryValidationStore();
  const deps = { investigations: store, proposals: createMemoryProposalStore(), validations, runner: passingRunner() };
  await validateProposal(deps, {
    workspaceId: WS,
    investigationId: record.id,
    samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT_1, 'holdout')],
  });
  return { deps, record };
}

describe('reserved holdout identity is canonical', () => {
  it('a slash-variant re-supply satisfies the no-drop rule without running extra workers', async () => {
    const { deps, record } = await reserveHoldout();
    const secondRunner = passingRunner();
    const second = await validateProposal({ ...deps, runner: secondRunner }, {
      workspaceId: WS,
      investigationId: record.id,
      samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(`${HOLDOUT_1}/`, 'holdout')],
    });
    expect(second.status).toBe('passed');
    expect(secondRunner.calls).toContain(`${HOLDOUT_1}/`);
  });

  it('holdouts declared by an unappliable run still reserve the next validation', async () => {
    const adapted = shopifyResult({
      fieldRecommendations: [],
      codeAdapterNeeded: { capability: 'click-to-reveal-variants', reason: 'Variant selection requires interaction.' },
    });
    const { store, record } = completedStore(adapted);
    const validations = createMemoryValidationStore();
    const deps = { investigations: store, proposals: createMemoryProposalStore(), validations, runner: passingRunner() };
    const first = await validateProposal(deps, {
      workspaceId: WS,
      investigationId: record.id,
      samples: [sample(REP_A, 'representative'), sample(HOLDOUT_1, 'holdout')],
    });
    expect(first.status).toBe('unappliable');
    expect(first.holdouts.sampleIds).toContain(HOLDOUT_1);
    const secondRunner = passingRunner();
    await expect(
      validateProposal({ ...deps, runner: secondRunner }, {
        workspaceId: WS,
        investigationId: record.id,
        samples: [sample(REP_A, 'representative'), sample(HOLDOUT_2, 'holdout')],
      }),
    ).rejects.toThrow(/reserved_holdout_dropped.*holdout-1/);
    expect(secondRunner.calls).toEqual([]);
  });
});

describe('reserved holdouts are never dropped to recover a pass', () => {
  it('a later validation that drops a failing reserved holdout is rejected without worker calls', async () => {
    const { store, record } = completedStore();
    const validations = createMemoryValidationStore();
    const deps = { investigations: store, proposals: createMemoryProposalStore(), validations, runner: failingRunner() };
    const first = await validateProposal(deps, {
      workspaceId: WS,
      investigationId: record.id,
      samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT_1, 'holdout')],
    });
    expect(first.status).toBe('failed');
    expect(first.holdouts.sampleIds).toContain(HOLDOUT_1);

    const secondRunner = failingRunner();
    await expect(
      validateProposal({ ...deps, runner: secondRunner }, {
        workspaceId: WS,
        investigationId: record.id,
        // HOLDOUT_1 dropped; only a fresh passing holdout supplied.
        samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT_2, 'holdout')],
      }),
    ).rejects.toThrow(/reserved_holdout_dropped.*holdout-1/);
    expect(secondRunner.calls).toEqual([]);
  });

  it('re-running every reserved holdout plus a replacement proceeds', async () => {
    const { deps, record } = await reserveHoldout();
    const secondRunner = passingRunner();
    const second = await validateProposal({ ...deps, runner: secondRunner }, {
      workspaceId: WS,
      investigationId: record.id,
      samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT_1, 'holdout'), sample(HOLDOUT_2, 'holdout')],
    });
    expect(second.status).toBe('passed');
    expect(secondRunner.calls).toContain(HOLDOUT_1);
    expect(secondRunner.calls).toContain(HOLDOUT_2);
  });
});

describe('holdout preference is guidance, never a gate', () => {
  const STRUCTURES = [
    { id: 'shopify-default', sampleUrls: [REP_A, REP_B] },
    { id: 'bundle-template', sampleUrls: ['https://shop.example.com/bundles/starter-kit'] },
  ];

  it('seeks one holdout per discovered structure and two total where the corpus permits', () => {
    const suggestion = suggestHoldoutCoverage({
      structures: STRUCTURES,
      corpusUrls: [REP_A, 'https://shop.example.com/products/gamma', 'https://shop.example.com/bundles/starter-kit-2'],
      investigatedUrls: [REP_A, REP_B],
      reservedUrls: [],
    });
    expect(suggestion.preferred).toHaveLength(2);
    expect(suggestion.perStructure['bundle-template']).toHaveLength(1);
    expect(suggestion.gaps).toEqual([]);
  });

  it('never suggests investigated or already-reserved URLs', () => {
    const suggestion = suggestHoldoutCoverage({
      structures: STRUCTURES,
      corpusUrls: [REP_A, HOLDOUT_1, HOLDOUT_2],
      investigatedUrls: [REP_A, REP_B],
      reservedUrls: [HOLDOUT_1],
    });
    expect(suggestion.preferred).toEqual([HOLDOUT_2]);
    expect(suggestion.gaps.some((g) => g.startsWith('single_holdout_only'))).toBe(true);
  });

  it('reports honest gaps when the corpus cannot cover a structure', () => {
    const suggestion = suggestHoldoutCoverage({
      structures: STRUCTURES,
      corpusUrls: [REP_A, REP_B],
      investigatedUrls: [REP_A, REP_B],
      reservedUrls: [],
    });
    expect(suggestion.preferred).toEqual([]);
    expect(suggestion.gaps.some((g) => g.startsWith('no_holdout_corpus'))).toBe(true);
    expect(suggestion.structuresCovered).toBe(0);
  });
});
