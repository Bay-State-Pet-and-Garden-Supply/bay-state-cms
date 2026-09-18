// T4 (#228) — representative validation of compiled drafts (Vitest, pure).
//
// A compilable proposal is executed through the production worker path on
// frozen representative samples plus reserved blind holdouts, with trusted
// expected identities and artifact references. Wrong-product and
// wrong-variant outcomes are recorded explicitly — never as missing
// titles. Validation creates no versions, activates nothing, releases
// nothing, attests no image review, and writes no trusted extraction
// output. The worker is an injected seam; these tests use a deterministic
// fake runner.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
import type { InvestigationResult } from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import { requestInvestigation } from '../../onboarding/browser-investigation/service';
import { createMemoryProposalStore } from '../../onboarding/browser-investigation/apply';
import {
  createMemoryValidationStore,
  validateProposal,
  type IdentityOutcome,
  type PolicyWorkerResult,
  type PolicyWorkerRunner,
  type ProposalValidation,
  type ProposalValidationStatus,
  type ValidationExpectedIdentity,
  type ValidationSampleInput,
  type ValidationSampleResult,
  type ValidationSampleStatus,
  type ValidateProposalOptions,
} from '../../onboarding/browser-investigation/validate';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const WS = 'ws-t4-validate';
const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';
const REP_B = 'https://shop.example.com/products/beta';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';

function shopifyResult(): InvestigationResult {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'T4 validation fixture. Untrusted proposal evidence only.',
    observations: [
      { kind: 'fake_dom_observation', sourceUrl: REP_A, artifactHash: 'a'.repeat(64), incomplete: false },
      { kind: 'fake_dom_observation', sourceUrl: REP_B, artifactHash: 'b'.repeat(64), incomplete: false },
    ],
    evidenceRefs: ['artifact:a'],
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
  } as InvestigationResult;
}

/** Completed investigation holding the Shopify result (memory store, no provider). */
function completedInvestigation(result: InvestigationResult = shopifyResult()) {
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

function sample(
  url: string,
  role: 'representative' | 'holdout',
  expected: Partial<ValidationExpectedIdentity> = {},
): ValidationSampleInput {
  return {
    url,
    role,
    expected: {
      name: 'BetterBone Beef',
      brandHint: 'BetterBone',
      gtin: '810001234501',
      variantKey: 'shopify:111:Small',
      productId: '999001',
      ...expected,
    },
  };
}

function passingRunner(): PolicyWorkerRunner & { calls: string[] } {
  const calls: string[] = [];
  const run: PolicyWorkerRunner['run'] = async ({ sampleUrl }) => {
    calls.push(sampleUrl);
    return matchingWorkerResult('shopify:111:Small', '999001');
  };
  return { run, calls };
}

function matchingWorkerResult(selectedVariantKey: string, parentProductId: string): PolicyWorkerResult {
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
    matrixDecision: { status: 'resolved', selectedVariantKey, matchedBy: 'gtin', reasonCodes: ['gtin_exact'] },
    parentProductId,
    sourceContentHash: 'c'.repeat(64),
  };
}

function mismatchedVariantRunner(): PolicyWorkerRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ sampleUrl }) => {
      calls.push(sampleUrl);
      return {
        ok: true,
        data: { title: 'BetterBone Beef', customFields: {} },
        matrixDecision: { status: 'resolved', selectedVariantKey: 'shopify:222:Large', matchedBy: 'options', reasonCodes: ['options_exact_tuple'] },
        parentProductId: '999001',
        sourceContentHash: 'c'.repeat(64),
      };
    },
  };
}

function wrongProductRunner(): PolicyWorkerRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async ({ sampleUrl }) => {
      calls.push(sampleUrl);
      return matchingWorkerResult('shopify:111:Small', '000000');
    },
  };
}

function ambiguousRunner(): PolicyWorkerRunner {
  return {
    run: async () => ({
      ok: false,
      error: 'variant_selection_required',
      failureCode: 'variant_selection_required',
      matrixDecision: { status: 'ambiguous', selectedVariantKey: null, matchedBy: 'none', reasonCodes: ['duplicate_identifier'] },
    }),
  };
}

interface ValidationCase {
  record: { id: string };
  runner: PolicyWorkerRunner & { calls?: string[] };
  validations: ReturnType<typeof createMemoryValidationStore>;
  validate: (samples: ValidationSampleInput[]) => Promise<ProposalValidation>;
}

/** Completed investigation with a caller-supplied store (unappliable-result tests). */
function setupCaseWithStore(
  store: ReturnType<typeof completedInvestigation>['store'],
  record: { id: string },
  runner: PolicyWorkerRunner & { calls?: string[] } = passingRunner(),
): ValidationCase & { validations: ReturnType<typeof createMemoryValidationStore> } {
  const validations = createMemoryValidationStore();
  return {
    record,
    runner,
    validations,
    validate: (samples: ValidationSampleInput[]) =>
      validateProposal(
        { investigations: store, proposals: createMemoryProposalStore(), validations, runner },
        { workspaceId: WS, investigationId: record.id, samples },
      ),
  };
}

/** One completed investigation plus runner and bound validate call (shared harness). */
function setupCase(runner: PolicyWorkerRunner & { calls?: string[] } = passingRunner()): ValidationCase & { store: ReturnType<typeof completedInvestigation>['store'] } {
  const { store, record } = completedInvestigation();
  const harnessed = setupCaseWithStore(store, record, runner);
  return { ...harnessed, store };
}

describe('representative validation of compiled drafts (T4)', () => {
  it('passes when representatives and a blind holdout resolve to expected identities', async () => {
    const { runner, validate } = setupCase();
    const outcome = await validate([sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT, 'holdout')]);
    const status: ProposalValidationStatus = outcome.status;
    expect(status).toBe('passed');
    expect(outcome.samples).toHaveLength(3);
    expect(outcome.holdouts.passed).toBe(1);
    expect(runner.calls).toEqual([REP_A, REP_B, HOLDOUT]);
    expect(outcome.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('records wrong_variant explicitly when the worker resolves a different variant', async () => {
    const { validate } = setupCase(mismatchedVariantRunner());
    const outcome = await validate([sample(REP_A, 'representative'), sample(HOLDOUT, 'holdout')]);
    expect(outcome.status).toBe('failed');
    const rep: ValidationSampleResult = outcome.samples.find((s) => s.url === REP_A)!;
    const identity: IdentityOutcome = rep.identityOutcome;
    expect(identity).toBe('wrong_variant');
    expect(rep.failureReasons.some((r) => r.includes('wrong_variant'))).toBe(true);
  });

  it('records wrong_product explicitly when the parent product contradicts expectations', async () => {
    const { validate } = setupCase(wrongProductRunner());
    const outcome = await validate([sample(REP_A, 'representative'), sample(HOLDOUT, 'holdout')]);
    expect(outcome.status).toBe('failed');
    const productRep: ValidationSampleResult = outcome.samples.find((s) => s.url === REP_A)!;
    expect(productRep.identityOutcome).toBe('wrong_product');
  });

  it('fails closed (not wrong_*) when identity is ambiguous', async () => {
    const { validate } = setupCase(ambiguousRunner());
    const outcome = await validate([sample(REP_A, 'representative'), sample(HOLDOUT, 'holdout')]);
    expect(outcome.status).toBe('failed');
    const ambiguousRep: ValidationSampleResult = outcome.samples.find((s) => s.url === REP_A)!;
    expect(ambiguousRep.identityOutcome).toBe('ambiguous');
    expect(ambiguousRep.failureReasons.some((r) => r.includes('wrong_'))).toBe(false);
  });

  it('marks incomplete when no blind holdout is reserved', async () => {
    const { record: incompleteRecord, validate } = setupCase();
    const options: ValidateProposalOptions = {
      workspaceId: WS,
      investigationId: incompleteRecord.id,
      samples: [sample(REP_A, 'representative'), sample(REP_B, 'representative')],
    };
    const outcome = await validate(options.samples);
    const sampleStatus: ValidationSampleStatus = outcome.samples[0].status;
    expect(outcome.status).toBe('incomplete');
    expect(sampleStatus).toBe('pass');
    expect(outcome.blockers.some((b) => b.includes('holdout'))).toBe(true);
  });

  it('rejects an exposed holdout without calling the worker', async () => {
    const { runner, validate } = setupCase();
    await expect(
      validate([sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(REP_A, 'holdout')]),
    ).rejects.toThrow(/holdout_exposed/);
    expect(runner.calls).toEqual([]);
  });

  it('fails when an investigation representative is missing from validation samples', async () => {
    const { store, record } = completedInvestigation();
    const outcome = await validateProposal(
      { investigations: store, proposals: createMemoryProposalStore(), validations: createMemoryValidationStore(), runner: passingRunner() },
      { workspaceId: WS, investigationId: record.id, samples: [sample(REP_A, 'representative'), sample(HOLDOUT, 'holdout')] },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.blockers.some((b) => b.includes('representative_missing'))).toBe(true);
  });

  it('never runs the worker for unappliable outcomes', async () => {
    const { store, record } = completedInvestigation();
    // Rewrite the stored result as a code-adapter need (evidence without a supported primitive).
    const adapted: InvestigationResult = {
      ...shopifyResult(),
      fieldRecommendations: [],
      codeAdapterNeeded: { capability: 'click-to-reveal-variants', reason: 'Variant selection requires interaction.' },
    };
    store.update(WS, record.id, {
      resultJson: JSON.stringify(adapted),
      resultHash: hashCanonicalJson(adapted),
      updatedAt: new Date().toISOString(),
    });
    const { runner, validate } = setupCaseWithStore(store, record);
    const outcome = await validate([sample(REP_A, 'representative'), sample(HOLDOUT, 'holdout')]);
    expect(outcome.status).toBe('unappliable');
    expect(runner.calls).toEqual([]);
  });

  it('freezes binding hashes so stale proposals cannot reuse validation', async () => {
    const { store, record } = completedInvestigation();
    const first = setupCaseWithStore(store, record);
    const samples = [sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT, 'holdout')];
    const outcome = await first.validate(samples);
    expect(outcome.status).toBe('passed');
    const stored = first.validations.getValidation(WS, record.id);
    expect(stored?.validationHash).toBe(outcome.validationHash);
    expect(stored?.policyHash).toBe(outcome.policyHash);
    // Same binding re-validates deterministically to the identical hash.
    const again = await first.validate(samples);
    expect(again.validationHash).toBe(outcome.validationHash);
  });

  it('creates no versions and touches no active pointer (validation is read-only)', async () => {
    const { validate } = setupCase();
    const outcome = await validate([sample(REP_A, 'representative'), sample(REP_B, 'representative'), sample(HOLDOUT, 'holdout')]);
    expect(outcome.status).toBe('passed');
    // Structural: the outcome carries no version, activation, release, or
    // attestation surface — validation cannot produce them by construction.
    expect(outcome).not.toHaveProperty('appliedVersionId');
    expect(outcome).not.toHaveProperty('activated');
    expect(outcome).not.toHaveProperty('released');
    expect(outcome).not.toHaveProperty('imageAttested');
  });
});
