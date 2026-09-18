// #241 — trusted-identity parity: pilot gate and validation service agree.
//
// One shared rule (trusted-identity.ts): a sample proves identity only with
// a trusted parent product ID plus at least one trusted identifier (GTIN /
// trusted SKU / platform variant ID / expected variant key). A name alone
// never proves identity. This suite proves the pilot gate and the
// validation service consume the same definition, that rejected sample sets
// never reach the worker and never persist, that classification with
// nothing to compare is 'unevaluated' (never 'match'), and that the variant
// bar is satisfied only by an affirmative single-variant signal.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
import type { InvestigationResult } from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import { requestInvestigation } from '../../onboarding/browser-investigation/service';
import { createMemoryProposalStore } from '../../onboarding/browser-investigation/apply';
import {
  classifyIdentity,
  createMemoryValidationStore,
  validateProposal,
  type PolicyWorkerResult,
  type PolicyWorkerRunner,
  type ValidationExpectedIdentity,
  type ValidationSampleInput,
} from '../../onboarding/browser-investigation/validate';
import {
  evaluatePilotGates,
  PILOT_ENV_FLAG,
} from '../../onboarding/browser-investigation/pilot';
import {
  hasTrustedIdentifier,
  hasTrustedParentProductId,
  isTrustedExpectation,
  trustedExpectationProblemsFor,
} from '../../onboarding/browser-investigation/trusted-identity';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const WS = 'ws-t241-trusted';
const DOMAIN = 'shop.example.com';
const REP = 'https://shop.example.com/products/alpha';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';
const ISOLATION_OK = { available: true, reason: 'test isolation reachable' };

function shopifyResult(): InvestigationResult {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: '#241 parity fixture. Untrusted proposal evidence only.',
    observations: [
      { kind: 'fake_dom_observation', sourceUrl: REP, artifactHash: 'a'.repeat(64), incomplete: false },
    ],
    evidenceRefs: ['artifact:a'],
    gaps: [],
    incompatibleStructureIds: [],
    renderedBrowserRequired: false,
    platform: 'shopify',
    structures: [{ id: 'shopify-default', sampleUrls: [REP] }],
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
  } as InvestigationResult;
}

function completedCase() {
  const store = createMemoryInvestigationStore();
  const created = requestInvestigation(store, {
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    sampleUrls: [REP],
  });
  const result = shopifyResult();
  const record = store.update(WS, created.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    resultJson: JSON.stringify(result),
    resultHash: hashCanonicalJson(result),
    updatedAt: new Date().toISOString(),
  })!;
  return { store, record };
}

function trustedExpected(): ValidationExpectedIdentity {
  return {
    name: 'BetterBone Beef',
    brandHint: 'BetterBone',
    gtin: '810001234501',
    variantKey: 'shopify:111:Small',
    productId: '999001',
  };
}

function fullWorkerResult(): PolicyWorkerResult {
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
}

describe('shared trusted-identity rule (#241)', () => {
  it('requires a trusted parent product ID plus one trusted identifier', () => {
    expect(isTrustedExpectation(trustedExpected())).toBe(true);
    expect(hasTrustedIdentifier({ name: 'A' })).toBe(false);
    expect(hasTrustedParentProductId({ name: 'A', productId: 'P' })).toBe(true);
    expect(isTrustedExpectation({ name: 'A', sku: 'S' })).toBe(false);
    expect(isTrustedExpectation({ name: 'A', productId: 'P' })).toBe(false);
    expect(isTrustedExpectation({ name: 'A', sku: 'S', productId: 'P' })).toBe(true);
    expect(isTrustedExpectation({ name: 'A', gtin: '810001234501', productId: '999001' })).toBe(true);
    expect(isTrustedExpectation({ name: 'A', variantKey: 'k', productId: 'P' })).toBe(true);
    expect(isTrustedExpectation({ name: 'A', platformVariantId: 'v', productId: 'P' })).toBe(true);
  });

  it('reports name, identifier, and product-anchor problems', () => {
    expect(trustedExpectationProblemsFor(REP, undefined)).toHaveLength(1);
    expect(trustedExpectationProblemsFor(REP, { name: 'A', productId: 'P' })[0]).toMatch(/trusted identifier/);
    expect(trustedExpectationProblemsFor(REP, { name: 'A', sku: 'S' })[0]).toMatch(/parent productId/);
    expect(trustedExpectationProblemsFor(REP, trustedExpected())).toEqual([]);
  });
});

describe('pilot gate and validation service agree (#241 parity)', () => {
  function pilotGateFor(expectedByUrl: Record<string, ValidationExpectedIdentity | undefined>) {
    return evaluatePilotGates({ [PILOT_ENV_FLAG]: '1' }, ISOLATION_OK, {
      domain: DOMAIN,
      representativeUrls: [REP],
      holdoutUrls: [HOLDOUT],
      expectedByUrl,
    });
  }

  it('both accept a trusted sample set', async () => {
    const trusted = trustedExpected();
    expect(pilotGateFor({ [REP]: trusted, [HOLDOUT]: trusted }).ok).toBe(true);
    const { store, record } = completedCase();
    const validations = createMemoryValidationStore();
    const calls: string[] = [];
    const runner: PolicyWorkerRunner = {
      run: async ({ sampleUrl }) => {
        calls.push(sampleUrl);
        return fullWorkerResult();
      },
    };
    const outcome = await validateProposal(
      { investigations: store, proposals: createMemoryProposalStore(), validations, runner },
      {
        workspaceId: WS,
        investigationId: record.id,
        samples: [
          { url: REP, role: 'representative', expected: trusted },
          { url: HOLDOUT, role: 'holdout', expected: trusted },
        ],
      },
    );
    expect(outcome.status).toBe('passed');
    expect(calls).toEqual([REP, HOLDOUT]);
  });

  it.each([
    ['name-only', { name: 'BetterBone Beef' }],
    ['identifier without productId', { name: 'BetterBone Beef', sku: 'BB-SM-001' }],
    ['productId without identifier', { name: 'BetterBone Beef', productId: '999001' }],
  ])('both reject %s: pilot refuses and validation fails closed with untrusted_expectation', async (_label, expected) => {
    const cast = expected as ValidationExpectedIdentity;
    const gate = pilotGateFor({ [REP]: cast, [HOLDOUT]: trustedExpected() });
    expect(gate.ok).toBe(false);

    const { store, record } = completedCase();
    const validations = createMemoryValidationStore();
    const calls: string[] = [];
    const runner: PolicyWorkerRunner = {
      run: async ({ sampleUrl }) => {
        calls.push(sampleUrl);
        return fullWorkerResult();
      },
    };
    const samples: ValidationSampleInput[] = [
      { url: REP, role: 'representative', expected: cast },
      { url: HOLDOUT, role: 'holdout', expected: trustedExpected() },
    ];
    await expect(
      validateProposal(
        { investigations: store, proposals: createMemoryProposalStore(), validations, runner },
        { workspaceId: WS, investigationId: record.id, samples },
      ),
    ).rejects.toThrow(/untrusted_expectation/);
    expect(calls).toEqual([]);
    expect(validations.getValidation(WS, record.id)).toBeNull();
  });
});

describe('classification never records match without a comparison (#241)', () => {
  it('returns unevaluated (never match, never wrong_*) with nothing to compare', () => {
    const nameOnly: ValidationSampleInput = {
      url: REP,
      role: 'representative',
      expected: { name: 'BetterBone Beef' },
    };
    const identity = classifyIdentity(nameOnly, fullWorkerResult());
    expect(identity.outcome).toBe('unevaluated');
    expect(identity.reasons.some((r) => r.includes('wrong_'))).toBe(false);
  });

  it('keeps genuine wrong-product / wrong-variant / ambiguous semantics', () => {
    const base: ValidationSampleInput = {
      url: REP,
      role: 'representative',
      expected: trustedExpected(),
    };
    const wrongVariant = classifyIdentity(base, {
      ...fullWorkerResult(),
      matrixDecision: { status: 'resolved', selectedVariantKey: 'shopify:222:Large', matchedBy: 'options', reasonCodes: ['options_exact_tuple'] },
    });
    expect(wrongVariant.outcome).toBe('wrong_variant');

    const wrongProduct = classifyIdentity(base, { ...fullWorkerResult(), parentProductId: '000000' });
    expect(wrongProduct.outcome).toBe('wrong_product');

    const ambiguous = classifyIdentity(base, {
      ok: false,
      error: 'variant_selection_required',
      failureCode: 'variant_selection_required',
      matrixDecision: { status: 'ambiguous', selectedVariantKey: null, matchedBy: 'none', reasonCodes: ['duplicate_identifier'] },
    });
    expect(ambiguous.outcome).toBe('ambiguous');
  });
});

describe('affirmative single-variant signal (#241)', () => {
  function trustedWithoutVariantKey(): ValidationExpectedIdentity {
    return { name: 'BetterBone Beef', gtin: '810001234501', productId: '999001' };
  }

  function singleVariantWorkerResult(): PolicyWorkerResult {
    // Affirmatively single-variant page: no resolved selected key, but the
    // worker matrix carries exactly one candidate plus the parent product.
    return {
      ...fullWorkerResult(),
      matrixDecision: null,
      selectedReceipt: null,
      variantMatrix: { candidates: [{ variantKey: 'shopify:111:Small' }] },
      candidates: [{ variantKey: 'shopify:111:Small' }],
    };
  }

  function noSignalWorkerResult(): PolicyWorkerResult {
    return { ...fullWorkerResult(), matrixDecision: null, selectedReceipt: null };
  }

  it('absence of variant data never satisfies the variant bar', () => {
    const sample: ValidationSampleInput = {
      url: REP,
      role: 'representative',
      expected: trustedWithoutVariantKey(),
    };
    const identity = classifyIdentity(sample, noSignalWorkerResult());
    expect(identity.outcome).toBe('ambiguous');
  });

  it('an affirmative single-variant signal satisfies the variant bar', () => {
    const sample: ValidationSampleInput = {
      url: REP,
      role: 'representative',
      expected: trustedWithoutVariantKey(),
    };
    const identity = classifyIdentity(sample, singleVariantWorkerResult());
    // Product identity still decides: parent matches and GTIN does not
    // contradict, so the variant bar passes through to a match.
    expect(identity.outcome).toBe('match');
  });

  it('a multi-candidate matrix is not an affirmative signal', () => {
    const sample: ValidationSampleInput = {
      url: REP,
      role: 'representative',
      expected: trustedWithoutVariantKey(),
    };
    const multi: PolicyWorkerResult = {
      ...fullWorkerResult(),
      matrixDecision: null,
      selectedReceipt: null,
      variantMatrix: { candidates: [{ variantKey: 'a' }, { variantKey: 'b' }] },
      candidates: [{ variantKey: 'a' }, { variantKey: 'b' }],
    };
    expect(classifyIdentity(sample, multi).outcome).toBe('ambiguous');
  });
});
